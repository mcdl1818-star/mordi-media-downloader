FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
    && python3 -m pip install --no-cache-dir --break-system-packages yt-dlp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY src ./src

RUN useradd --create-home --uid 10001 bot \
    && mkdir -p /app/temp \
    && chown -R bot:bot /app

USER bot

ENV NODE_ENV=production \
    YT_DLP_PATH=yt-dlp \
    FFMPEG_PATH=ffmpeg

EXPOSE 10000

CMD ["node", "src/index.js"]
