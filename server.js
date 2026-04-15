// server.js
const express = require('express');
const cors = require('cors');
const path = require('path');
const { fork } = require('child_process');
const { PrismaClient } = require('@prisma/client');
const { runGroqSummarizer } = require('./summarizer'); // Import your summarizer

const app = express();
const prisma = new PrismaClient();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// 1. STATIC SERVER: Expose the 'recordings' directory
app.use('/files', express.static(path.join(__dirname, 'recordings')));

// 2. THE CONTROLLER: Start the meeting
app.post('/meetings/start', async (req, res) => {
    const { meetUrl } = req.body;

    if (!meetUrl) {
        return res.status(400).json({ error: "meetUrl is required" });
    }

    try {
        // Create the DB record tracking the state
        const meeting = await prisma.meeting.create({
            data: {
                meetUrl: meetUrl,
                status: "JOINING"
            }
        });

        // Spawn the bot in the background so we don't block the Express event loop
        const botProcess = fork(path.join(__dirname, 'bot.js'), [meetUrl, meeting.id]);

        // Listen for messages from the bot process
        botProcess.on('message', async (message) => {
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
                    const summaryData = await runGroqSummarizer(message.audioPath);
                    
                    await prisma.meeting.update({
                        where: { id: meeting.id },
                        data: { 
                            status: 'COMPLETED',
                            summaryPath: message.audioPath.replace('.webm', '_summary.json'),
                            summaryData: JSON.stringify(summaryData)
                        }
                    });
                } catch (error) {
                    await prisma.meeting.update({
                        where: { id: meeting.id },
                        data: { status: 'FAILED' }
                    });
                }
            }
        });

        // Return an immediate response to the client
        res.status(202).json({ 
            message: "Bot is launching in the background.", 
            meetingId: meeting.id 
        });

    } catch (error) {
        res.status(500).json({ error: "Failed to start meeting process." });
    }
});

// Helper endpoint to check status
app.get('/meetings/:id', async (req, res) => {
    const meeting = await prisma.meeting.findUnique({
        where: { id: req.params.id }
    });
    if (!meeting) return res.status(404).json({ error: "Not found" });
    res.json(meeting);
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});