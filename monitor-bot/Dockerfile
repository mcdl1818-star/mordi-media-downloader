FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip \
  && python3 -m pip install --break-system-packages --no-cache-dir "yt-dlp[default,curl-cffi]" gallery-dl "instagrapi==2.18.14" \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY src ./src
RUN useradd --create-home --uid 10001 bot \
  && mkdir -p /app/data /app/temp \
  && chown -R bot:bot /app
USER bot
ENV NODE_ENV=production
EXPOSE 10000
CMD ["node", "src/index.js"]
