# Vercel Deployment Guide

This project should be deployed in two parts:
- Frontend (Vercel)
- Backend bot/API (Render/Railway/VM or any Node host with Chrome support)

## Why split deployment
Your backend uses Puppeteer and long-running meeting jobs. Vercel Serverless Functions are not a good fit for this workload.

## 1) Deploy backend first
Deploy the backend (`server.js`, `bot.js`, `summarizer.js`, Prisma DB) on a host that supports:
- Node.js long-running processes
- Chrome/Puppeteer execution
- Persistent filesystem for recordings (or move files to object storage)

After deploy, note backend URL, for example:
`https://meet-bot-api.onrender.com`

## 2) Configure Vercel rewrite
In [vercel.json](vercel.json), replace:
`https://YOUR_BACKEND_DOMAIN`
with your real backend domain.

Example:
`"destination": "https://meet-bot-api.onrender.com/$1"`

## 3) Deploy frontend to Vercel
- Push this repo to GitHub.
- In Vercel: Add New Project.
- Framework preset: Other.
- Build Command: leave empty.
- Output Directory: `public`.
- Deploy.

## 4) Verify
- Open your Vercel site.
- Submit a Meet URL.
- Confirm status updates (JOINING -> RECORDING -> SUMMARIZING -> COMPLETED).
- Confirm both downloads work.

## Notes
- If downloads fail in production, ensure your backend host exposes `/files/*` and stores recordings persistently.
- For production reliability, move recording files to S3/R2 and return signed URLs.
