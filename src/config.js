import fs from "node:fs";
import path from "node:path";

export function loadDotEnv(file = path.resolve(".env")) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function readConfig() {
  loadDotEnv();
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const allowedUserId = process.env.ALLOWED_TELEGRAM_USER_ID?.trim();
  if (!token) throw new Error("חסר TELEGRAM_BOT_TOKEN בקובץ .env");
  if (!allowedUserId || !/^\d+$/.test(allowedUserId)) {
    throw new Error("חסר ALLOWED_TELEGRAM_USER_ID תקין. מטעמי בטיחות הבוט מיועד למשתמש יחיד.");
  }
  return {
    token,
    allowedUserId,
    ytDlpPath: process.env.YT_DLP_PATH?.trim() || "yt-dlp",
    galleryDlPath: process.env.GALLERY_DL_PATH?.trim() || "gallery-dl",
    aria2cPath: process.env.ARIA2C_PATH?.trim() || "aria2c",
    ffmpegPath: process.env.FFMPEG_PATH?.trim() || "ffmpeg",
    maxBytes: (Number(process.env.MAX_FILE_SIZE_MB) || 49) * 1024 * 1024,
    maxMediaItems: Math.max(1, Math.min(30, Number(process.env.MAX_MEDIA_ITEMS) || 15)),
    mediaConcurrency: Math.max(1, Math.min(6, Number(process.env.MEDIA_CONCURRENCY) || 3)),
    tempTtlMs: (Number(process.env.TEMP_TTL_MINUTES) || 30) * 60_000,
    tempDir: path.resolve("temp"),
    youtubeCookiesPath: path.resolve("temp", "youtube-cookies.txt"),
    youtubeCookieFileId: process.env.YOUTUBE_COOKIE_FILE_ID?.trim() || "",
    youtubeProxyUrl: process.env.YOUTUBE_PROXY_URL?.trim() || "",
    port: Number(process.env.PORT) || 10000,
    webhookUrl: process.env.WEBHOOK_URL?.trim() || "",
    webhookSecret: process.env.WEBHOOK_SECRET?.trim() || ""
  };
}
