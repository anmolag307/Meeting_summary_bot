const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { fork } = require('child_process');
const path = require('path');

const app = express();
const prisma = new PrismaClient();
app.use(express.json());

// 🔴 NEW: This makes the "files" folder accessible via web links!
app.use('/files', express.static(path.join(__dirname, 'files')));

// ENDPOINT 1: Start the Bot
app.post('/meetings/start', async (req, res) => {
    const { meetUrl } = req.body;

    if (!meetUrl || !meetUrl.includes('meet.google.com')) {
        return res.status(400).json({ error: "Invalid Google Meet URL" });
    }

    try {
        const meeting = await prisma.meeting.create({
            data: { meetUrl: meetUrl, status: "JOINING" }
        });

        const botPath = path.join(__dirname, 'bot.js');
        const botProcess = fork(botPath, [meetUrl, meeting.id]);

        botProcess.on('error', (err) => {
            console.error(`Failed to start bot for ${meeting.id}:`, err);
        });

        return res.status(202).json({
            message: "Bot is joining the meeting...",
            meetingId: meeting.id,
            statusUrl: `${process.env.BASE_URL}/meetings/${meeting.id}/status`
        });

    } catch (error) {
        res.status(500).json({ error: "Database error" });
    }
});

// ENDPOINT 2: Check Status
app.get('/meetings/:id/status', async (req, res) => {
    try {
        const meeting = await prisma.meeting.findUnique({
            where: { id: req.params.id }
        });

        if (!meeting) return res.status(404).json({ error: "Meeting not found" });

        res.json({
            id: meeting.id,
            status: meeting.status,
            audioUrl: meeting.audioUrl,
            transcriptUrl: meeting.transcriptUrl,
            summary: meeting.summary ? JSON.parse(meeting.summary) : null
        });
    } catch (error) {
        res.status(500).json({ error: "Database error" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 API Server running on ${process.env.BASE_URL}`);
});