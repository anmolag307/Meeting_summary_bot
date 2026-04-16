FROM node:20-bookworm

ENV NODE_ENV=production
ENV PORT=10000
ENV PUPPETEER_HEADLESS=true
ENV CHROME_EXECUTABLE_PATH=/usr/bin/chromium
ENV RECORDINGS_DIR=/opt/render/project/.render-data/recordings
ENV BOT_PROFILES_DIR=/opt/render/project/.render-data/profiles
ENV PUPPETEER_SKIP_DOWNLOAD=true

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci
RUN npx prisma generate

COPY . .

RUN mkdir -p /opt/render/project/.render-data/recordings /opt/render/project/.render-data/profiles

EXPOSE 10000

CMD ["sh", "-c", "npx prisma db push && node server.js"]
