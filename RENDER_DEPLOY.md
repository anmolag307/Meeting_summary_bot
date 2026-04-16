# Render Backend Deployment (Multi-user + Auto Cleanup)

This backend is configured for Render using Docker and persistent disk storage.

## What is implemented
- Per-meeting access token for user isolation.
- Per-meeting browser profile directory for concurrent bot sessions.
- Protected file download routes (audio/transcript/summary) tied to meeting token.
- Cleanup endpoint that stops bot process, deletes files, and removes DB row.
- Frontend sends cleanup beacon on tab close.

## Deploy on Render
1. Push this project to GitHub.
2. In Render, create a new Blueprint from repo (or a Web Service using Dockerfile).
3. Keep disk mount at `/opt/render/project/.render-data`.
4. Set env var `GROQ_API_KEY` in Render dashboard.
5. Deploy.

## Verify health
Use:
`GET /health`

Expected:
`{"ok":true}`

## Data lifecycle
- During meeting: files are stored on Render disk.
- On client close: browser sends `POST /meetings/:id/cleanup?token=...`.
- Backend stops process, deletes audio/transcript/summary, and deletes meeting row.

## Important note
`beforeunload`/`sendBeacon` is best-effort in browsers. If a user force-kills internet/app, cleanup request may not arrive. For strict cleanup guarantees, add a server-side TTL job to delete stale meetings.
