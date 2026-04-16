// server.js
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { fork } = require('child_process');
const { PrismaClient } = require('@prisma/client');
const { runGroqSummarizer } = require('./summarizer'); // Import your summarizer

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const recordingsDir = process.env.RECORDINGS_DIR || path.join(__dirname, 'recordings');
const publicDir = path.join(__dirname, 'public');
const botProcesses = new Map();

if (!fs.existsSync(recordingsDir)) {
    fs.mkdirSync(recordingsDir, { recursive: true });
}

app.use(express.static(publicDir));

function isValidGoogleMeetUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && parsed.hostname.includes('meet.google.com');
    } catch {
        return false;
    }
}

function toDownloadUrl(filePath) {
    if (!filePath) return null;
    return filePath;
}

function toMeetingResponse(meeting, token) {
    return {
        id: meeting.id,
        meetUrl: meeting.meetUrl,
        status: meeting.status,
        createdAt: meeting.createdAt,
        updatedAt: meeting.updatedAt,
        downloads: {
            audio: meeting.audioPath ? `/meetings/${meeting.id}/files/audio?token=${encodeURIComponent(token)}` : null,
            transcript: meeting.transcriptPath ? `/meetings/${meeting.id}/files/transcript?token=${encodeURIComponent(token)}` : null,
            summary: meeting.summaryPath ? `/meetings/${meeting.id}/files/summary?token=${encodeURIComponent(token)}` : null,
        }
    };
}

function generateClientToken() {
    return crypto.randomBytes(24).toString('hex');
}

function getClientToken(req) {
    return req.get('x-meeting-token') || req.query.token || req.body?.token || '';
}

async function getAuthorizedMeeting(req, res) {
    const meeting = await prisma.meeting.findUnique({ where: { id: req.params.id } });
    if (!meeting) {
        res.status(404).json({ error: 'Meeting not found' });
        return null;
    }

    if (!meeting.clientToken) {
        res.status(410).json({ error: 'Meeting is from an old session and can no longer be accessed securely.' });
        return null;
    }

    const token = getClientToken(req);
    if (!token || token !== meeting.clientToken) {
        res.status(403).json({ error: 'Invalid meeting token' });
        return null;
    }

    return meeting;
}

async function deleteMeetingFiles(meeting) {
    const targets = [meeting.audioPath, meeting.transcriptPath, meeting.summaryPath].filter(Boolean);

    await Promise.all(targets.map(async (filePath) => {
        try {
            await fsp.unlink(filePath);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error(`Failed deleting file ${filePath}:`, error.message);
            }
        }
    }));
}

async function stopBotProcess(meetingId) {
    const botProcess = botProcesses.get(meetingId);
    if (!botProcess) return;

    await new Promise((resolve) => {
        let settled = false;

        const finalize = () => {
            if (settled) return;
            settled = true;
            botProcesses.delete(meetingId);
            resolve();
        };

        botProcess.once('exit', finalize);

        try {
            botProcess.kill('SIGINT');
        } catch {
            finalize();
            return;
        }

        setTimeout(() => {
            if (!settled) {
                try { botProcess.kill('SIGKILL'); } catch { }
                finalize();
            }
        }, 10000);
    });
}

app.get('/health', (_req, res) => {
    res.json({ ok: true });
});

// 2. THE CONTROLLER: Start the meeting
app.post('/meetings/start', async (req, res) => {
    const { meetUrl } = req.body;

    if (!meetUrl) {
        return res.status(400).json({ error: "meetUrl is required" });
    }

    if (!isValidGoogleMeetUrl(meetUrl)) {
        return res.status(400).json({ error: "Please provide a valid Google Meet URL." });
    }

    try {
        const clientToken = generateClientToken();

        // Create the DB record tracking the state
        const meeting = await prisma.meeting.create({
            data: {
                meetUrl: meetUrl,
                clientToken,
                status: "JOINING"
            }
        });

        // Spawn the bot in the background so we don't block the Express event loop
        const botProcess = fork(path.join(__dirname, 'bot.js'), [meetUrl, meeting.id]);
        botProcesses.set(meeting.id, botProcess);

        // Listen for messages from the bot process
        botProcess.on('message', async (message) => {
            const existing = await prisma.meeting.findUnique({ where: { id: meeting.id } });
            if (!existing) {
                return;
            }

            if (message.status === 'RECORDING') {
                await prisma.meeting.update({
                    where: { id: meeting.id },
                    data: { status: 'RECORDING' }
                });
            } else if (message.status === 'FINISHED_AUDIO') {
                await prisma.meeting.update({
                    where: { id: meeting.id },
                    data: { status: 'SUMMARIZING', audioPath: message.audioPath }
                });

                // Trigger the summarizer now that audio is done
                try {
                    const summaryResult = await runGroqSummarizer(message.audioPath);
                    const summaryPath = summaryResult.summaryPath || message.audioPath.replace('.webm', '_summary.json');
                    const transcriptPath = summaryResult.transcriptPath || message.audioPath.replace('.webm', '_transcript.txt');
                    const summaryData = summaryResult.summary || null;
                    
                    await prisma.meeting.update({
                        where: { id: meeting.id },
                        data: { 
                            status: 'COMPLETED',
                            summaryPath,
                            transcriptPath,
                            summaryData: summaryData ? JSON.stringify(summaryData) : null
                        }
                    });
                } catch (error) {
                    console.error('Summarization failed:', error.message);
                    await prisma.meeting.update({
                        where: { id: meeting.id },
                        data: { status: 'FAILED' }
                    });
                }
            } else if (message.status === 'ERROR') {
                await prisma.meeting.update({
                    where: { id: meeting.id },
                    data: { status: 'FAILED' }
                });
            }
        });

        botProcess.on('exit', async (code) => {
            botProcesses.delete(meeting.id);
            if (code === 0) return;

            const existing = await prisma.meeting.findUnique({ where: { id: meeting.id } });
            if (!existing || ['COMPLETED', 'FAILED'].includes(existing.status)) return;

            await prisma.meeting.update({
                where: { id: meeting.id },
                data: { status: 'FAILED' }
            });
        });

        botProcess.on('error', async (error) => {
            botProcesses.delete(meeting.id);
            console.error('Bot process error:', error.message);
            await prisma.meeting.update({
                where: { id: meeting.id },
                data: { status: 'FAILED' }
            });
        });

        // Return an immediate response to the client
        res.status(202).json({ 
            message: "Bot is launching in the background.", 
            meetingId: meeting.id,
            token: clientToken
        });

    } catch (error) {
        res.status(500).json({ error: "Failed to start meeting process." });
    }
});

// Helper endpoint to check status
app.get('/meetings/:id', async (req, res) => {
    const meeting = await getAuthorizedMeeting(req, res);
    if (!meeting) return;
    res.json(toMeetingResponse(meeting, getClientToken(req)));
});

app.get('/meetings/:id/downloads', async (req, res) => {
    const meeting = await getAuthorizedMeeting(req, res);
    if (!meeting) return;
    const token = getClientToken(req);

    const summaryReady = Boolean(meeting.summaryPath && fs.existsSync(meeting.summaryPath));
    const transcriptReady = Boolean(meeting.transcriptPath && fs.existsSync(meeting.transcriptPath));

    res.json({
        meetingId: meeting.id,
        status: meeting.status,
        available: {
            summary: summaryReady,
            transcript: transcriptReady,
        },
        downloads: {
            summary: summaryReady ? `/meetings/${meeting.id}/files/summary?token=${encodeURIComponent(token)}` : null,
            transcript: transcriptReady ? `/meetings/${meeting.id}/files/transcript?token=${encodeURIComponent(token)}` : null,
        }
    });
});

app.get('/meetings/:id/files/:kind', async (req, res) => {
    const meeting = await getAuthorizedMeeting(req, res);
    if (!meeting) return;

    const fileMap = {
        audio: meeting.audioPath,
        transcript: meeting.transcriptPath,
        summary: meeting.summaryPath,
    };

    const targetPath = fileMap[req.params.kind];
    if (!targetPath || !fs.existsSync(targetPath)) {
        return res.status(404).json({ error: 'File not available' });
    }

    res.download(targetPath, path.basename(targetPath));
});

app.post('/meetings/:id/cleanup', async (req, res) => {
    const meeting = await getAuthorizedMeeting(req, res);
    if (!meeting) return;

    await stopBotProcess(meeting.id);
    await deleteMeetingFiles(meeting);
    await prisma.meeting.delete({ where: { id: meeting.id } });

    res.json({ ok: true, deleted: true });
});

app.use((_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});