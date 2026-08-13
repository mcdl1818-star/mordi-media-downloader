import fs from "node:fs";
import path from "node:path";

function loadEnv(file = path.resolve(".env")) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
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
  loadEnv();
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const allowedUserId = process.env.ALLOWED_TELEGRAM_USER_ID?.trim();
  if (!token) throw new Error("חסר TELEGRAM_BOT_TOKEN");
  if (!/^\d+$/.test(allowedUserId || "")) throw new Error("חסר ALLOWED_TELEGRAM_USER_ID תקין");
  const intervalMinutes = Math.max(2, Number(process.env.CHECK_INTERVAL_MINUTES) || 10);
  const instagramIntervalMinutes = Math.max(15, Number(process.env.INSTAGRAM_CHECK_INTERVAL_MINUTES) || 20);
  const instagramJitterMinutes = Math.max(0, Math.min(30, Number(process.env.INSTAGRAM_CHECK_JITTER_MINUTES) || 10));
  return {
    token,
    allowedUserId,
    intervalMs: intervalMinutes * 60_000,
    instagramIntervalMs: instagramIntervalMinutes * 60_000,
    instagramJitterMs: instagramJitterMinutes * 60_000,
    instagramRateLimitCooldownMs: Math.max(60, Number(process.env.INSTAGRAM_RATE_LIMIT_COOLDOWN_MINUTES) || 120) * 60_000,
    instagramNetworkCooldownMs: Math.max(10, Number(process.env.INSTAGRAM_NETWORK_COOLDOWN_MINUTES) || 30) * 60_000,
    instagramMaxProfilesPerPass: Math.max(1, Math.min(20, Number(process.env.INSTAGRAM_MAX_PROFILES_PER_PASS) || 6)),
    maxItems: Math.max(3, Math.min(50, Number(process.env.MAX_ITEMS_PER_SCAN) || 15)),
    ytDlpPath: process.env.YT_DLP_PATH?.trim() || "yt-dlp",
    galleryDlPath: process.env.GALLERY_DL_PATH?.trim() || "gallery-dl",
    pythonPath: process.env.PYTHON_PATH?.trim() || "python3",
    instagramBridgePath: path.resolve("src", "instagram_bridge.py"),
    instagramSessionPath: "",
    instagramBootstrapPath: "",
    instagramLoginUsername: process.env.INSTAGRAM_LOGIN_USERNAME?.trim().replace(/^@/, "") || "vogelnati",
    ffmpegPath: process.env.FFMPEG_PATH?.trim() || (process.platform === "win32" ? "ffmpeg" : "/usr/bin/ffmpeg"),
    githubActionsToken: process.env.GITHUB_ACTIONS_TOKEN?.trim() || "",
    githubActionsRepo: process.env.GITHUB_ACTIONS_REPO?.trim() || "mcdl1818-star/mordi-media-downloader",
    githubActionsWorkflow: process.env.GITHUB_ACTIONS_WORKFLOW?.trim() || "youtube-worker.yml",
    sendMode: process.env.SEND_MODE?.trim().toLowerCase() === "link" ? "link" : "video",
    maxBytes: (Number(process.env.MAX_FILE_SIZE_MB) || 49) * 1024 * 1024,
    dataDir: path.resolve(process.env.DATA_DIR?.trim() || "data"),
    tempDir: path.resolve(process.env.TEMP_DIR?.trim() || "temp"),
    cookiesPath: process.env.COOKIES_PATH?.trim() ? path.resolve(process.env.COOKIES_PATH.trim()) : "",
    port: Number(process.env.PORT) || 10000,
    webhookUrl: process.env.WEBHOOK_URL?.trim().replace(/\/$/, "") || "",
    webhookSecret: process.env.WEBHOOK_SECRET?.trim() || "",
    historyCount: Math.max(1, Math.min(5, Number(process.env.HISTORY_COUNT) || 3))
  };
}
