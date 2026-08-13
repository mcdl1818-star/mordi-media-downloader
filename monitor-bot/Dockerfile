FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates git \
  && python3 -m pip install --break-system-packages --no-cache-dir "yt-dlp[default,curl-cffi]" gallery-dl "instagrapi==2.18.14" bgutil-ytdlp-pot-provider \
  && git clone --depth 1 --branch 1.3.1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil \
  && cd /opt/bgutil/server \
  && npm ci \
  && npx tsc \
  && rm -rf /opt/bgutil/.git \
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
