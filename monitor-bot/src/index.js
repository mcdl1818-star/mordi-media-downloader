import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { readConfig } from "./config.js";
import { Telegram } from "./telegram.js";
import { Store } from "./store.js";
import {
  validateCreatorUrl,
  classifySupportedUrl,
  extractSupportedUrls,
  resolveCreatorFromMediaUrl,
  mediaItemFromUrl,
  scanCreator,
  downloadVideo,
  cleanupVideo,
  shouldDeferInstagramScan
} from "./scanner.js";
import {
  createInstagramConnectToken,
  verifyInstagramConnectToken,
  instagramConnectTokenFingerprint,
  createCreatorMonitorScanPath,
  instagramUsernameFromConnectToken,
  normalizeInstagramUsername,
  encryptInstagramSession,
  decryptInstagramSession,
  instagramConnectPage,
  runInstagramLogin,
  runInstagramSessionImport
} from "./instagram-connect.js";
import {
  normalizeInstagramCookies,
  instagramCookiesToNetscape,
  instagramCookiesFromNetscape,
  instagramCookiesFromExport,
  instagramCookieFingerprint
} from "./instagram-cookies.js";
import {
  createYoutubeWorkerToken,
  verifyYoutubeWorkerToken,
  dispatchYoutubeWorker,
  claimNextYoutubeJob,
  buildYoutubeWorkerClaim
} from "./youtube-worker.js";
import { activeInstagramGuardState, instagramAuthSummary, nextInstagramGuard } from "./instagram-guard.js";
import {
  sanitizeSocialCookieFile,
  verifySocialUploadToken,
  socialUploadTokenFingerprint
} from "./social-cookies.js";

const config = readConfig();
const telegram = new Telegram(config.token);
const store = new Store(config.dataDir, telegram, config.allowedUserId);
await store.load();
store.state.youtubeJobs ||= {};
config.platformCookies = {};
let offset = 0;
let scanRunning = false;
const usedInstagramTokens = new Set();
const instagramConnectAttempts = new Map();
let instagramWebCookieFingerprint = "";
let instagramPrivateSessionFingerprint = "";
let instagramAuthGeneration = 0;
const pendingActions = new Map();
const busyUsers = new Set();
const ACTION_TTL_MS = 30 * 60_000;
let lastDownloadDiagnostic = null;
const YOUTUBE_JOB_TTL_MS = 6 * 60 * 60_000;
const YOUTUBE_JOB_LEASE_MS = 20 * 60_000;
let youtubeClaimLock = false;

async function atomicPrivateWrite(destination, contents) {
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(temporary, contents, { mode: 0o600 });
  await fs.promises.rename(temporary, destination);
}

async function applyInstagramScanSource(items) {
  if (items.instagramSource === "private") {
    if (store.state.auth?.Instagram) store.state.auth.Instagram.status = "ACTIVE";
    if (store.state.auth?.InstagramWeb && store.state.auth.InstagramWeb.status !== "EXPIRED") {
      store.state.auth.InstagramWeb.status = "STANDBY";
    }
    return;
  }
  if (items.instagramSource !== "web") return;
  if (store.state.auth?.InstagramWeb) store.state.auth.InstagramWeb.status = "ACTIVE";
  if (!items.instagramPrivateAuthFailed || !store.state.auth?.Instagram) return;
  store.state.auth.Instagram.status = "EXPIRED";
  store.state.auth.Instagram.updatedAt = new Date().toISOString();
  config.instagramSessionPath = "";
  await fs.promises.rm(path.join(config.dataDir, "instagram-session.json"), { force: true });
}

async function expireInstagramSources(sources) {
  const selected = new Set(Array.isArray(sources) && sources.length
    ? sources
    : [config.instagramSessionPath ? "private" : "web"]);
  const now = new Date().toISOString();
  if (selected.has("private") && store.state.auth?.Instagram) {
    store.state.auth.Instagram.status = "EXPIRED";
    store.state.auth.Instagram.updatedAt = now;
    config.instagramSessionPath = "";
    await fs.promises.rm(path.join(config.dataDir, "instagram-session.json"), { force: true });
  }
  if (selected.has("web") && store.state.auth?.InstagramWeb) {
    store.state.auth.InstagramWeb.status = "EXPIRED";
    store.state.auth.InstagramWeb.updatedAt = now;
    delete config.platformCookies.Instagram;
    await fs.promises.rm(path.join(config.dataDir, "instagram-web-cookies.txt"), { force: true });
  }
}

async function scanCreatorForManualAction(creator) {
  if (creator.platform !== "Instagram") return scanCreator(creator, config);
  if (activeInstagramGuard()) throw new Error("DEFERRED:Instagram:PROTECTED");
  const generation = instagramAuthGeneration;
  try {
    const items = await scanCreator(creator, config);
    if (generation !== instagramAuthGeneration) {
      throw new Error("Instagram connection changed during the scan; retry once");
    }
    await applyInstagramScanSource(items);
    await store.save();
    return items;
  } catch (error) {
    if (generation !== instagramAuthGeneration) {
      throw new Error("Instagram connection changed during the scan; retry once");
    }
    if (error.instagramSourcesExpired) {
      await expireInstagramSources(error.instagramSourcesExpired);
      await store.save();
    }
    if (String(error.message).startsWith("DEFERRED:Instagram:")) {
      const reason = String(error.message).split(":").at(-1);
      if (reason !== "PROTECTED") imposeInstagramGuard(reason);
      await store.save();
    } else if (String(error.message) === "AUTH_REQUIRED:Instagram") {
      imposeInstagramGuard("AUTH_REQUIRED");
      await expireInstagramSources(error.instagramSources);
      await store.save();
    }
    throw error;
  }
}

function resetInstagramProtectionAfterConnection() {
  delete store.state.instagramGuard;
  for (const subscription of store.state.subscriptions) {
    if (subscription.platform !== "Instagram") continue;
    if (/^(?:AUTH_REQUIRED|DEFERRED):Instagram/.test(String(subscription.lastError || ""))) {
      subscription.lastError = "";
    }
    subscription.nextInstagramCheckAt = "";
  }
}

function scheduleNextInstagramScan(subscription, now = Date.now()) {
  if (subscription?.platform !== "Instagram") return;
  const jitter = config.instagramJitterMs > 0
    ? crypto.randomInt(0, Math.floor(config.instagramJitterMs) + 1)
    : 0;
  subscription.nextInstagramCheckAt = new Date(now + config.instagramIntervalMs + jitter).toISOString();
}

function activeInstagramGuard(now = Date.now()) {
  return activeInstagramGuardState(store.state.instagramGuard, now);
}

function imposeInstagramGuard(reason, now = Date.now()) {
  store.state.instagramGuard = nextInstagramGuard(store.state.instagramGuard, reason, config, now);
  return store.state.instagramGuard;
}

function pruneYoutubeJobs(now = Date.now()) {
  store.state.youtubeJobs ||= {};
  let changed = false;
  for (const [jobId, job] of Object.entries(store.state.youtubeJobs)) {
    if (!Number.isFinite(job.createdAt) || now - job.createdAt > YOUTUBE_JOB_TTL_MS) {
      delete store.state.youtubeJobs[jobId];
      changed = true;
    }
  }
  return changed;
}

function privateSessionFingerprint(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function instagramTokenWasUsed(token) {
  const fingerprint = instagramConnectTokenFingerprint(token);
  return usedInstagramTokens.has(fingerprint)
    || (store.state.usedInstagramConnectTokens || []).includes(fingerprint);
}

function consumeInstagramToken(token) {
  const fingerprint = instagramConnectTokenFingerprint(token);
  usedInstagramTokens.add(fingerprint);
  store.state.usedInstagramConnectTokens = [
    fingerprint,
    ...(store.state.usedInstagramConnectTokens || []).filter(value => value !== fingerprint)
  ].slice(0, 50);
}

const help = `שלח קישור לפרסום/סרטון בודד כדי להוריד אותו מיד, או קישור לפרופיל/ערוץ כדי לבחור מעקב קבוע.

אחרי הורדה יופיע כפתור להוספת היוצר למעקב.

/list — רשימת המעקבים
/remove מספר — הסרת מעקב
/check — בדיקה מיידית
/pause — השהיית כל המעקבים
/resume — חידוש המעקבים
/auth — מצב ההתחברות לפלטפורמות
/instagram — חיבור Instagram פשוט מהטלפון

בעת הוספה נשמר המצב הנוכחי, ולכן לא יישלח תוכן ישן.`;

const AUTH_FILES = {
  "youtube-cookies.txt": "YouTube",
  "instagram-session.enc": "Instagram",
  "instagram-cookies.txt": "Instagram",
  "cookies.txt": "Instagram",
  "facebook-cookies.txt": "Facebook",
  "tiktok-cookies.txt": "TikTok",
  "x-cookies.txt": "X",
  "twitter-cookies.txt": "X"
};

function isInstagramCookieExport(filename) {
  return filename === "cookies.txt"
    || filename === "instagram-cookies.txt"
    || (/instagram/i.test(filename) && /\.(?:txt|json)$/i.test(filename));
}

async function hydrateAuth(platform) {
  const auth = store.state.auth?.[platform];
  if (!auth?.fileId) return false;
  if (["EXPIRED", "STANDBY"].includes(auth.status)) return false;
  if (platform === "InstagramWeb" && auth.kind === "instagram-web-cookies-v1") {
    const encrypted = path.join(config.dataDir, "instagram-web-cookies.enc");
    const destination = path.join(config.dataDir, "instagram-web-cookies.txt");
    await telegram.downloadFile(auth.fileId, encrypted);
    try {
      const payload = decryptInstagramSession(await fs.promises.readFile(encrypted), config.webhookSecret);
      const netscape = instagramCookiesToNetscape(payload.cookies);
      await fs.promises.writeFile(destination, netscape, { mode: 0o600 });
      instagramWebCookieFingerprint = instagramCookieFingerprint(netscape);
      config.platformCookies.Instagram = destination;
      return true;
    } finally {
      await fs.promises.rm(encrypted, { force: true });
    }
  }
  if (platform === "InstagramBootstrap" && auth.kind === "instagrapi-bootstrap-v1") {
    const encrypted = path.join(config.dataDir, "instagram-bootstrap.enc");
    const destination = path.join(config.dataDir, "instagram-bootstrap.json");
    await telegram.downloadFile(auth.fileId, encrypted);
    try {
      const settings = decryptInstagramSession(await fs.promises.readFile(encrypted), config.webhookSecret);
      await fs.promises.writeFile(destination, JSON.stringify(settings), { mode: 0o600 });
      config.instagramBootstrapPath = destination;
      return true;
    } finally {
      await fs.promises.rm(encrypted, { force: true });
    }
  }
  if (platform === "Instagram" && auth.kind === "instagrapi-v1") {
    const encrypted = path.join(config.dataDir, "instagram-session.enc");
    const destination = path.join(config.dataDir, "instagram-session.json");
    await telegram.downloadFile(auth.fileId, encrypted);
    try {
      const session = decryptInstagramSession(await fs.promises.readFile(encrypted), config.webhookSecret);
      const serialized = JSON.stringify(session);
      await fs.promises.writeFile(destination, serialized, { mode: 0o600 });
      instagramPrivateSessionFingerprint = privateSessionFingerprint(serialized);
      config.instagramSessionPath = destination;
      return true;
    } finally {
      await fs.promises.rm(encrypted, { force: true });
    }
  }
  if (["YouTube", "Facebook", "TikTok", "X"].includes(platform) && auth.kind === "social-cookies-v1") {
    const encrypted = path.join(config.dataDir, `${platform.toLowerCase()}-cookies.enc`);
    const destination = path.join(config.dataDir, `${platform.toLowerCase()}-cookies.txt`);
    await telegram.downloadFile(auth.fileId, encrypted);
    try {
      const payload = decryptInstagramSession(await fs.promises.readFile(encrypted), config.webhookSecret);
      const netscape = sanitizeSocialCookieFile(payload.netscape, platform);
      await fs.promises.writeFile(destination, netscape, { mode: 0o600 });
      config.platformCookies[platform] = destination;
      return true;
    } finally {
      await fs.promises.rm(encrypted, { force: true });
    }
  }
  const destination = `${config.dataDir}/${platform.toLowerCase()}-cookies.txt`;
  await telegram.downloadFile(auth.fileId, destination);
  config.platformCookies[platform] = destination;
  return true;
}

for (const platform of Object.keys(store.state.auth || {})) {
  await hydrateAuth(platform).catch(error => console.warn(`Auth ${platform}:`, error.message));
}
if (config.instagramSessionPath || config.platformCookies.Instagram) instagramAuthGeneration = 1;

function authRequiredMessage(platform) {
  if (platform === "Instagram") {
    return "🔐 כדי לעקוב באופן קבוע אחרי פוסטים, Reels וסטוריז, יש לחבר חשבון Instagram פעם אחת. לחץ על הכפתור למטה; הסיסמה אינה נשמרת.";
  }
  const filename = platform === "X" ? "x-cookies.txt" : `${platform.toLowerCase()}-cookies.txt`;
  return `🔐 ${platform} דורש session כדי לקרוא פרופילים משרת ענן.\nשלח לבוט קובץ cookies בפורמט Netscape בשם ${filename}. הבוט יסנן רק את האתר הנכון, יצפין את הגיבוי וימחק את הקובץ הגלוי מהשיחה.`;
}

async function persistSocialCookies(input, platform) {
  await fs.promises.mkdir(config.tempDir, { recursive: true });
  await fs.promises.mkdir(config.dataDir, { recursive: true });
  const encrypted = path.join(config.tempDir, `social-cookies-${crypto.randomUUID()}.enc`);
  const destination = path.join(config.dataDir, `${platform.toLowerCase()}-cookies.txt`);
  try {
    const netscape = sanitizeSocialCookieFile(input, platform);
    await fs.promises.writeFile(destination, netscape, { mode: 0o600 });
    await fs.promises.writeFile(encrypted, encryptInstagramSession({ platform, netscape }, config.webhookSecret), { mode: 0o600 });
    const sent = await telegram.sendDocument(config.allowedUserId, encrypted,
      `🔐 גיבוי מוצפן של חיבור ${platform} — אין למחוק`,
      { filename: `${platform.toLowerCase()}-cookies.enc`, disableNotification: true });
    const previousMessageId = store.state.auth?.[platform]?.messageId;
    store.state.auth ||= {};
    store.state.auth[platform] = {
      fileId: sent.document.file_id,
      messageId: sent.message_id,
      filename: `${platform.toLowerCase()}-cookies.enc`,
      kind: "social-cookies-v1",
      status: "ACTIVE",
      updatedAt: new Date().toISOString()
    };
    config.platformCookies[platform] = destination;
    await store.save();
    if (previousMessageId && previousMessageId !== sent.message_id) {
      await telegram.call("deleteMessage", { chat_id: config.allowedUserId, message_id: previousMessageId }).catch(() => {});
    }
  } finally {
    await fs.promises.rm(encrypted, { force: true });
  }
}

async function saveSocialCookies(message, platform) {
  if (Number(message.document.file_size || 0) > 512_000) throw new Error("Cookie file too large");
  await fs.promises.mkdir(config.tempDir, { recursive: true });
  const uploaded = path.join(config.tempDir, `social-cookies-${crypto.randomUUID()}.txt`);
  try {
    await telegram.downloadFile(message.document.file_id, uploaded);
    await persistSocialCookies(await fs.promises.readFile(uploaded), platform);
  } finally {
    await fs.promises.rm(uploaded, { force: true });
    await telegram.call("deleteMessage", { chat_id: message.chat.id, message_id: message.message_id }).catch(() => {});
  }
}

async function youtubeCookiesForWorker() {
  const destination = config.platformCookies.YouTube;
  const auth = store.state.auth?.YouTube;
  if (!destination || auth?.status === "EXPIRED" || !fs.existsSync(destination)) return "";
  try {
    return sanitizeSocialCookieFile(await fs.promises.readFile(destination), "YouTube");
  } catch {
    if (auth) {
      auth.status = "EXPIRED";
      auth.updatedAt = new Date().toISOString();
      await store.save().catch(() => {});
    }
    delete config.platformCookies.YouTube;
    await fs.promises.rm(destination, { force: true }).catch(() => {});
    return "";
  }
}

function instagramConnectUrl(username = "") {
  if (!config.webhookUrl || !config.webhookSecret) return "";
  const token = createInstagramConnectToken(config.webhookSecret, config.allowedUserId, Date.now(), 20 * 60_000, username);
  return `${config.webhookUrl}/connect/instagram?token=${encodeURIComponent(token)}`;
}

function instagramConnectMarkup(username = "") {
  const url = instagramConnectUrl(username);
  return url ? { inline_keyboard: [[{ text: "📸 חבר Instagram", url }]] } : undefined;
}

async function sendInstagramConnect(chatId, username = "") {
  const guard = activeInstagramGuard();
  if (guard && guard.reason !== "AUTH_REQUIRED") {
    const until = new Date(guard.until).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" });
    return telegram.sendMessage(chatId,
      `⏸️ חיבור Instagram עדיין קיים. זוהתה הגבלה זמנית ולכן עצרתי את הסריקות עד ${until}; אין להתחבר שוב ואין להקליד סיסמה בזמן ההשהיה.`
    );
  }
  const normalizedUsername = normalizeInstagramUsername(username || config.instagramLoginUsername);
  const replyMarkup = instagramConnectMarkup(normalizedUsername);
  if (!replyMarkup) return telegram.sendMessage(chatId, "חיבור Instagram זמין רק בשירות הענן.");
  const account = /^[A-Za-z0-9._]{1,30}$/.test(normalizedUsername) ? `\nהחשבון שנקבע: @${normalizedUsername}` : "";
  return telegram.sendMessage(chatId,
    `📸 לחץ על הכפתור, התחבר פעם אחת ל-Instagram, והבוט ימשיך לעבוד בשרת גם כשהטלפון והמחשב כבויים.${account}`,
    { reply_markup: replyMarkup }
  );
}

function instagramDeviceSeed(username) {
  return crypto.createHmac("sha256", config.webhookSecret)
    .update(`instagram-device:${String(username).toLowerCase()}`)
    .digest("hex");
}

async function loadInstagramBootstrap(username) {
  const auth = store.state.auth?.InstagramBootstrap;
  if (!config.instagramBootstrapPath || auth?.username !== username) return undefined;
  try {
    return JSON.parse(await fs.promises.readFile(config.instagramBootstrapPath, "utf8"));
  } catch {
    return undefined;
  }
}

async function saveInstagramBootstrap(settings, username, status = "LOGIN_REJECTED", reason = "unknown") {
  if (!settings || typeof settings !== "object") return;
  await fs.promises.mkdir(config.dataDir, { recursive: true });
  await fs.promises.mkdir(config.tempDir, { recursive: true });
  const destination = path.join(config.dataDir, "instagram-bootstrap.json");
  const encrypted = path.join(config.tempDir, `instagram-bootstrap-${crypto.randomUUID()}.enc`);
  await fs.promises.writeFile(destination, JSON.stringify(settings), { mode: 0o600 });
  await fs.promises.writeFile(encrypted, encryptInstagramSession(settings, config.webhookSecret), { mode: 0o600 });
  try {
    const sent = await telegram.sendDocument(
      config.allowedUserId,
      encrypted,
      "🔐 מצב מוצפן להמשך חיבור Instagram — אין למחוק",
      { filename: "instagram-bootstrap.enc", disableNotification: true }
    );
    const previousMessageId = store.state.auth?.InstagramBootstrap?.messageId;
    store.state.auth ||= {};
    store.state.auth.InstagramBootstrap = {
      fileId: sent.document.file_id,
      messageId: sent.message_id,
      filename: "instagram-bootstrap.enc",
      kind: "instagrapi-bootstrap-v1",
      username,
      status: String(status).replace(/[^A-Z0-9_]/g, "").slice(0, 40),
      reason: String(reason).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60),
      updatedAt: new Date().toISOString()
    };
    config.instagramBootstrapPath = destination;
    await store.save();
    if (previousMessageId && previousMessageId !== sent.message_id) {
      await telegram.call("deleteMessage", { chat_id: config.allowedUserId, message_id: previousMessageId }).catch(() => {});
    }
  } finally {
    await fs.promises.rm(encrypted, { force: true });
  }
}

async function saveInstagramWebCookies(cookies, username, { activate = true } = {}) {
  if (activate) instagramAuthGeneration += 1;
  const normalizedCookies = normalizeInstagramCookies(cookies);
  const netscape = instagramCookiesToNetscape(normalizedCookies);
  await fs.promises.mkdir(config.dataDir, { recursive: true });
  await fs.promises.mkdir(config.tempDir, { recursive: true });
  const destination = path.join(config.dataDir, "instagram-web-cookies.txt");
  const encrypted = path.join(config.tempDir, `instagram-web-cookies-${crypto.randomUUID()}.enc`);
  await atomicPrivateWrite(destination, netscape);
  await fs.promises.writeFile(encrypted, encryptInstagramSession({ cookies: normalizedCookies }, config.webhookSecret), { mode: 0o600 });
  try {
    const sent = await telegram.sendDocument(
      config.allowedUserId,
      encrypted,
      "🔐 גיבוי מוצפן של חיבור Instagram מהטלפון — אין למחוק",
      { filename: "instagram-web-cookies.enc", disableNotification: true }
    );
    const previousMessageId = store.state.auth?.InstagramWeb?.messageId;
    const bootstrapMessageId = store.state.auth?.InstagramBootstrap?.messageId;
    store.state.auth ||= {};
    store.state.auth.InstagramWeb = {
      fileId: sent.document.file_id,
      messageId: sent.message_id,
      filename: "instagram-web-cookies.enc",
      kind: "instagram-web-cookies-v1",
      username,
      status: "ACTIVE",
      updatedAt: new Date().toISOString()
    };
    if (activate) resetInstagramProtectionAfterConnection();
    delete store.state.auth.InstagramBootstrap;
    config.platformCookies.Instagram = destination;
    config.instagramBootstrapPath = "";
    instagramWebCookieFingerprint = instagramCookieFingerprint(normalizedCookies);
    await fs.promises.rm(path.join(config.dataDir, "instagram-bootstrap.json"), { force: true });
    await store.save();
    if (previousMessageId && previousMessageId !== sent.message_id) {
      await telegram.call("deleteMessage", { chat_id: config.allowedUserId, message_id: previousMessageId }).catch(() => {});
    }
    if (bootstrapMessageId) {
      await telegram.call("deleteMessage", { chat_id: config.allowedUserId, message_id: bootstrapMessageId }).catch(() => {});
    }
  } finally {
    await fs.promises.rm(encrypted, { force: true });
  }
}

async function refreshInstagramWebBackupIfChanged() {
  const cookieFile = config.platformCookies.Instagram;
  if (!cookieFile || !fs.existsSync(cookieFile)) return;
  const netscape = await fs.promises.readFile(cookieFile, "utf8");
  const fingerprint = instagramCookieFingerprint(netscape);
  if (fingerprint === instagramWebCookieFingerprint) return;
  const username = store.state.auth?.InstagramWeb?.username || config.instagramLoginUsername;
  await saveInstagramWebCookies(instagramCookiesFromNetscape(netscape), username, { activate: false });
}

async function importInstagramCookieDocument(message) {
  const filename = message.document.file_name?.toLowerCase() || "";
  if (!isInstagramCookieExport(filename)) throw new Error("Unsupported Instagram cookie filename");
  if (Number(message.document.file_size || 0) > 512_000) throw new Error("Instagram cookie file is too large");
  await fs.promises.mkdir(config.tempDir, { recursive: true });
  const temporary = path.join(config.tempDir, `instagram-cookie-upload-${crypto.randomUUID()}`);
  try {
    await telegram.downloadFile(message.document.file_id, temporary);
    const contents = await fs.promises.readFile(temporary);
    if (contents.length > 512_000) throw new Error("Instagram cookie file is too large");
    const cookies = instagramCookiesFromExport(contents);
    const username = config.instagramLoginUsername;
    const bootstrapSettings = await loadInstagramBootstrap(username);
    await saveInstagramWebCookies(cookies, username);
    try {
      const result = await runInstagramSessionImport(config, {
        username,
        sessionid: cookies.find(cookie => cookie.name === "sessionid").value,
        deviceSeed: instagramDeviceSeed(username),
        settings: bootstrapSettings
      });
      if (result.status === "OK" && result.session) {
        await saveInstagramSession(result.session, result.username || username);
      }
    } catch (error) {
      console.warn("Instagram private session import unavailable; web session remains active:", error.message);
    }
  } finally {
    await fs.promises.rm(temporary, { force: true });
    await telegram.call("deleteMessage", {
      chat_id: message.chat.id,
      message_id: message.message_id
    }).catch(() => {});
  }
}

function sendInstagramFileInstructions(chatId) {
  return telegram.sendMessage(chatId,
    "📱 חיבור Instagram ללא כבל וללא אפשרויות מפתחים:\n\n" +
    "1. התקן Firefox מה‑Play Store.\n" +
    "2. מתוך Firefox התקן את התוסף cookies.txt הרשמי של Mozilla:\n" +
    "https://addons.mozilla.org/android/addon/cookies-txt/\n" +
    "3. ב‑Firefox פתח instagram.com והתחבר ל‑@vogelnati.\n" +
    "4. פתח את התוסף ושמור את cookies.txt.\n" +
    "5. שלח את הקובץ כאן לבוט.\n\n" +
    "הבוט ישמור רק cookies של instagram.com, יצפין אותם וימחק מיד את הקובץ הגלוי מהשיחה."
  );
}

async function saveInstagramSession(session, username, { activate = true } = {}) {
  if (activate) instagramAuthGeneration += 1;
  await fs.promises.mkdir(config.dataDir, { recursive: true });
  const destination = path.join(config.dataDir, "instagram-session.json");
  const encrypted = path.join(config.tempDir, `instagram-session-${crypto.randomUUID()}.enc`);
  await fs.promises.mkdir(config.tempDir, { recursive: true });
  const serialized = JSON.stringify(session);
  await atomicPrivateWrite(destination, serialized);
  await fs.promises.writeFile(encrypted, encryptInstagramSession(session, config.webhookSecret), { mode: 0o600 });
  try {
    const previousMessageId = store.state.auth?.Instagram?.messageId;
    const sent = await telegram.sendDocument(
      config.allowedUserId,
      encrypted,
      "🔐 גיבוי מוצפן של חיבור Instagram — אין למחוק",
      { filename: "instagram-session.enc", disableNotification: true }
    );
    store.state.auth ||= {};
    store.state.auth.Instagram = {
      fileId: sent.document.file_id,
      messageId: sent.message_id,
      filename: "instagram-session.enc",
      kind: "instagrapi-v1",
      username,
      status: "ACTIVE",
      updatedAt: new Date().toISOString()
    };
    if (store.state.auth.InstagramWeb) {
      store.state.auth.InstagramWeb.status = "STANDBY";
      store.state.auth.InstagramWeb.updatedAt = new Date().toISOString();
      delete config.platformCookies.Instagram;
      await fs.promises.rm(path.join(config.dataDir, "instagram-web-cookies.txt"), { force: true });
    }
    if (activate) resetInstagramProtectionAfterConnection();
    const bootstrapMessageId = store.state.auth.InstagramBootstrap?.messageId;
    delete store.state.auth.InstagramBootstrap;
    config.instagramSessionPath = destination;
    instagramPrivateSessionFingerprint = privateSessionFingerprint(serialized);
    config.instagramBootstrapPath = "";
    await fs.promises.rm(path.join(config.dataDir, "instagram-bootstrap.json"), { force: true });
    await store.save();
    if (bootstrapMessageId) {
      await telegram.call("deleteMessage", { chat_id: config.allowedUserId, message_id: bootstrapMessageId }).catch(() => {});
    }
    if (previousMessageId && previousMessageId !== sent.message_id) {
      await telegram.call("deleteMessage", { chat_id: config.allowedUserId, message_id: previousMessageId }).catch(() => {});
    }
  } finally {
    await fs.promises.rm(encrypted, { force: true });
  }
}

async function refreshInstagramPrivateBackupIfChanged() {
  const sessionFile = config.instagramSessionPath;
  if (!sessionFile || !fs.existsSync(sessionFile)) return;
  const serialized = await fs.promises.readFile(sessionFile, "utf8");
  const fingerprint = privateSessionFingerprint(serialized);
  if (fingerprint === instagramPrivateSessionFingerprint) return;
  const username = store.state.auth?.Instagram?.username || config.instagramLoginUsername;
  await saveInstagramSession(JSON.parse(serialized), username, { activate: false });
}

async function queueYoutubeWorkerDelivery({
  chatId,
  item,
  statusMessageId,
  caption,
  offerTracking = false
}) {
  if (item.platform !== "YouTube" || !config.webhookUrl) return false;
  pruneYoutubeJobs();
  const jobId = crypto.randomBytes(16).toString("hex");
  store.state.youtubeJobs[jobId] = {
    createdAt: Date.now(),
    chatId: String(chatId),
    statusMessageId: Number(statusMessageId) || 0,
    item: {
      id: String(item.id || "").slice(0, 200),
      url: item.url,
      title: String(item.title || "").slice(0, 300),
      platform: "YouTube"
    },
    caption: String(caption || "").slice(0, 1000),
    offerTracking: Boolean(offerTracking)
  };
  const callbackToken = createYoutubeWorkerToken(config.webhookSecret, jobId, Date.now(), YOUTUBE_JOB_TTL_MS);
  await store.save();
  try {
    const dispatched = await dispatchYoutubeWorker(callbackToken, config);
    await telegram.call("editMessageText", {
      chat_id: chatId,
      message_id: statusMessageId,
      text: dispatched
        ? "☁️ YouTube הועבר לשרת ההורדה החלופי. הקובץ יישלח לכאן אוטומטית."
        : "☁️ YouTube נוסף לתור המאובטח. שרת ההורדה החלופי יאסוף אותו אוטומטית בתוך עד 5 דקות."
    }).catch(() => {});
    return true;
  } catch (error) {
    delete store.state.youtubeJobs[jobId];
    await store.save().catch(console.error);
    throw error;
  }
}

async function deliver(item, subscription, { historical = false } = {}) {
  const caption = historical
    ? `👋 סרטון קודם לזיהוי אצל ${subscription.label}\n${item.title}\n${item.url}`
    : `🎬 פרסום חדש אצל ${subscription.label}\n${item.title}\n${item.url}`;
  if (config.sendMode === "video") {
    let file;
    try {
      file = await downloadVideo(item, config);
      if ((await fs.promises.stat(file)).size > config.maxBytes) throw new Error("הקובץ גדול ממגבלת Telegram");
      if (item.mediaKind === "photo" || /\.(?:jpe?g|png|webp)$/i.test(file)) {
        await telegram.sendPhoto(config.allowedUserId, file, caption);
      } else {
        await telegram.sendVideo(config.allowedUserId, file, caption);
      }
      return;
    } catch (error) {
      console.warn(`Video delivery fallback for ${item.url}: ${error.message}`);
      if (item.platform === "YouTube" && config.webhookUrl) {
        const status = await telegram.sendMessage(config.allowedUserId, "☁️ מנסה את עובד YouTube החלופי...");
        try {
          if (await queueYoutubeWorkerDelivery({
            chatId: config.allowedUserId,
            item,
            statusMessageId: status.message_id,
            caption
          })) return;
        } catch (workerError) {
          console.warn(`YouTube worker fallback for ${item.url}: ${workerError.message}`);
        }
      }
    } finally {
      if (file) await cleanupVideo(file).catch(console.error);
    }
  }
  await telegram.sendMessage(config.allowedUserId, caption);
}

function removeExpiredActions() {
  const now = Date.now();
  for (const [id, action] of pendingActions) {
    if (now - action.createdAt > ACTION_TTL_MS) pendingActions.delete(id);
  }
}

function rememberAction(value) {
  removeExpiredActions();
  const id = crypto.randomBytes(8).toString("hex");
  pendingActions.set(id, { ...value, createdAt: Date.now() });
  return id;
}

function profileLabel(creator) {
  return new URL(creator.url).pathname.replace(/^\/|\/$/g, "") || new URL(creator.url).hostname;
}

function trackingButton(id) {
  return { inline_keyboard: [[{ text: "➕ הוסף למעקב קבוע", callback_data: `track:${id}` }]] };
}

async function sendProfileChoice(chatId, creator) {
  const id = rememberAction({ creator });
  return telegram.sendMessage(chatId,
    `👤 זוהה פרופיל ${creator.platform}: ${profileLabel(creator)}\nמה לעשות?`,
    { reply_markup: { inline_keyboard: [[
      { text: "🔔 מעקב קבוע", callback_data: `track:${id}` },
      { text: "⬇️ הורד את האחרון", callback_data: `latest:${id}` }
    ]] } }
  );
}

async function sendBulkProfileChoice(chatId, creators) {
  const id = rememberAction({ creators });
  return telegram.sendMessage(chatId,
    `📋 זוהו ${creators.length} פרופילים. אפשר להוסיף את כולם לרשימת המעקב; הבוט יקבע לכל אחד נקודת התחלה בהדרגה בלי להציף את הרשתות.`,
    { reply_markup: { inline_keyboard: [[
      { text: `🔔 הוסף את כל ${creators.length} הפרופילים`, callback_data: `track_all:${id}` }
    ]] } }
  );
}

async function queueSubscriptions(chatId, creators) {
  let added = 0;
  let existing = 0;
  for (const creator of creators) {
    if (store.state.subscriptions.some(item => item.url === creator.url)) {
      existing += 1;
      continue;
    }
    store.state.subscriptions.push({
      ...creator,
      label: profileLabel(creator),
      addedAt: new Date().toISOString(),
      lastCheckedAt: "",
      lastError: "",
      pendingBaseline: true,
      seenIds: []
    });
    added += 1;
  }
  if (added) await store.save();
  return telegram.sendMessage(chatId,
    `✅ נוספו ${added} פרופילים לתור המעקב.${existing ? ` ${existing} כבר היו ברשימה.` : ""}\nהבוט יסרוק אותם אוטומטית, ישמור נקודת התחלה וישלח שלושה תכנים אחרונים מכל פרופיל כשהוא מופעל.`
  );
}

async function sendTrackingChoice(chatId, mediaUrl, creator) {
  const id = rememberAction({ mediaUrl, creator });
  const detail = creator
    ? `זיהיתי את היוצר ${profileLabel(creator)}.`
    : "לא הצלחתי לזהות את כתובת היוצר מהפרסום; אפשר ללחוץ ואנסה שוב.";
  return telegram.sendMessage(chatId, `✅ ההורדה הסתיימה. ${detail}`, { reply_markup: trackingButton(id) });
}

function friendlyDownloadError(error) {
  const message = String(error?.message || "");
  if (/auth|login|cookie|HTTP (?:401|403)/i.test(message)) return "האתר דורש חיבור פעיל או חסם זמנית את ההורדה.";
  if (/private|unavailable|deleted|restricted/i.test(message)) return "התוכן פרטי, הוסר או אינו זמין.";
  if (/no video|no media|no formats|does not contain|not a video/i.test(message)) return "לא נמצא סרטון בקישור הזה. ייתכן שזה פוסט טקסט, תמונה או קישור ללא מדיה.";
  if (/timed? out|לא סיים בזמן/i.test(message)) return "האתר לא הגיב בזמן. נסה שוב מאוחר יותר.";
  return message.slice(0, 220) || "ההורדה נכשלה זמנית.";
}

async function downloadRequestedMedia(chatId, mediaUrl) {
  const item = mediaItemFromUrl(mediaUrl);
  if (item.platform === "Instagram" && activeInstagramGuard()) {
    await telegram.sendMessage(chatId,
      "⏸️ Instagram נמצא כרגע בהשהיית הגנה. לא אשתמש בסשן המעקב להורדה ידנית בזמן הזה, כדי לא להאריך את ההגבלה."
    );
    return;
  }
  const status = await telegram.sendMessage(chatId, `⬇️ מוריד עכשיו מ-${item.platform}...`);
  let file;
  try {
    file = await downloadVideo(item, config);
    const size = (await fs.promises.stat(file)).size;
    if (size > config.maxBytes) throw new Error("הקובץ גדול ממגבלת Telegram");
    const caption = `✅ הורד מ-${item.platform}\n${item.url}`;
    if (/\.(?:jpe?g|png|webp)$/i.test(file)) await telegram.sendPhoto(chatId, file, caption);
    else await telegram.sendVideo(chatId, file, caption);
    await telegram.call("editMessageText", {
      chat_id: chatId,
      message_id: status.message_id,
      text: "✅ ההורדה הושלמה ונשלחה."
    }).catch(() => {});
    const creator = await resolveCreatorFromMediaUrl(mediaUrl, config);
    await sendTrackingChoice(chatId, mediaUrl, creator);
  } catch (error) {
    if (item.platform === "YouTube" && config.webhookUrl) {
      try {
        await queueYoutubeWorkerDelivery({
          chatId,
          item,
          statusMessageId: status.message_id,
          caption: `✅ הורד מ-YouTube\n${item.url}`,
          offerTracking: true
        });
        return;
      } catch (workerError) {
        console.warn(`YouTube worker fallback for ${item.url}: ${workerError.message}`);
      }
    }
    lastDownloadDiagnostic = {
      at: new Date().toISOString(),
      platform: item.platform,
      message: String(error?.message || error).slice(-1600)
    };
    console.error(`Direct download ${item.platform}:`, error.message);
    await telegram.call("editMessageText", {
      chat_id: chatId,
      message_id: status.message_id,
      text: `❌ ${friendlyDownloadError(error)}`
    }).catch(() => {});
  } finally {
    if (file) await cleanupVideo(file).catch(console.error);
  }
}

async function handleCallback(query) {
  const userId = String(query.from?.id || "");
  if (userId !== config.allowedUserId) return;
  removeExpiredActions();
  const separator = String(query.data || "").indexOf(":");
  const kind = separator > 0 ? query.data.slice(0, separator) : "";
  const id = separator > 0 ? query.data.slice(separator + 1) : "";
  const action = pendingActions.get(id);
  if (!action) {
    await telegram.answerCallbackQuery(query.id, "הכפתור פג. שלח את הקישור מחדש.");
    return;
  }
  if (busyUsers.has(userId)) {
    await telegram.answerCallbackQuery(query.id, "כבר מתבצעת פעולה. המתן לסיומה.");
    return;
  }
  await telegram.answerCallbackQuery(query.id, kind.startsWith("track") ? "מוסיף למעקב..." : "מוריד את התוכן האחרון...");
  busyUsers.add(userId);
  try {
    if (kind === "track_all") {
      await queueSubscriptions(query.message.chat.id, action.creators || []);
      return;
    }
    let creator = action.creator;
    if (!creator && action.mediaUrl) creator = await resolveCreatorFromMediaUrl(action.mediaUrl, config);
    if (!creator) {
      await telegram.sendMessage(query.message.chat.id, "לא הצלחתי לזהות את היוצר אוטומטית. שלח קישור לפרופיל עצמו ואציג כפתור מעקב.");
      return;
    }
    if (kind === "track") {
      if (creator.platform === "Instagram" && activeInstagramGuard()) {
        await telegram.sendMessage(query.message.chat.id, "⏸️ Instagram בהשהיית הגנה. שמרתי את החיבור ולא אבצע כעת בקשה ידנית שעלולה להאריך את ההגבלה.");
        return;
      }
      await addSubscription(query.message.chat.id, creator.url);
      return;
    }
    if (kind === "latest") {
      if (creator.platform === "Instagram" && activeInstagramGuard()) {
        await telegram.sendMessage(query.message.chat.id, "⏸️ Instagram בהשהיית הגנה. ההורדה האחרונה תתאפשר לאחר שההשהיה תסתיים.");
        return;
      }
      const items = await scanCreatorForManualAction(creator);
      if (!items.length) throw new Error("לא נמצא תוכן אחרון בפרופיל");
      const subscription = { ...creator, label: profileLabel(creator) };
      await deliver(items[0], subscription, { historical: true });
      const nextId = rememberAction({ creator });
      await telegram.sendMessage(query.message.chat.id, "רוצה לקבל מעכשיו כל תוכן חדש?", { reply_markup: trackingButton(nextId) });
      return;
    }
    await telegram.sendMessage(query.message.chat.id, "הפעולה אינה מוכרת. שלח את הקישור מחדש.");
  } catch (error) {
    await telegram.sendMessage(query.message.chat.id, `❌ ${friendlyDownloadError(error)}`);
  } finally {
    busyUsers.delete(userId);
  }
}

async function scanAll({ report = false } = {}) {
  if (scanRunning) return report ? "כבר מתבצעת בדיקה." : undefined;
  if (store.state.paused) return report ? "המעקב מושהה." : undefined;
  scanRunning = true;
  let newCount = 0;
  let errorCount = 0;
  let deferredCount = 0;
  let instagramAttempts = 0;
  try {
    for (const subscription of store.state.subscriptions) {
      if (subscription.platform === "Instagram") {
        if (activeInstagramGuard()) {
          deferredCount += 1;
          continue;
        }
        if (shouldDeferInstagramScan(subscription, config.instagramIntervalMs)) {
          deferredCount += 1;
          continue;
        }
        if (instagramAttempts >= config.instagramMaxProfilesPerPass) {
          deferredCount += 1;
          continue;
        }
        instagramAttempts += 1;
      }
      const instagramGenerationAtStart = subscription.platform === "Instagram"
        ? instagramAuthGeneration
        : -1;
      try {
        const items = await scanCreator(subscription, config);
        if (subscription.platform === "Instagram") {
          if (instagramGenerationAtStart !== instagramAuthGeneration) {
            deferredCount += 1;
            subscription.nextInstagramCheckAt = "";
            await store.save();
            continue;
          }
          await applyInstagramScanSource(items);
          delete store.state.instagramGuard;
          scheduleNextInstagramScan(subscription);
        }
        if (subscription.platform === "Instagram" && config.instagramSessionPath) {
          await refreshInstagramPrivateBackupIfChanged().catch(error => console.warn("Instagram private backup refresh:", error.message));
        }
        if (subscription.platform === "Instagram" && config.platformCookies.Instagram) {
          if (store.state.auth?.InstagramWeb) store.state.auth.InstagramWeb.status = "ACTIVE";
          await refreshInstagramWebBackupIfChanged().catch(error => console.warn("Instagram cookie backup refresh:", error.message));
        }
        if (subscription.pendingBaseline) {
          subscription.seenIds = items.map(item => item.id).slice(-500);
          subscription.pendingBaseline = false;
          subscription.lastCheckedAt = new Date().toISOString();
          subscription.lastError = "";
          await store.save();
          const history = items.slice(0, config.historyCount).reverse();
          await telegram.sendMessage(config.allowedUserId,
            `✅ המעקב הופעל: ${subscription.label}\nנשמרו ${items.length} פרסומים קיימים. הנה ${history.length} אחרונים לזיהוי.`
          );
          for (const item of history) await deliver(item, subscription, { historical: true });
          continue;
        }
        const known = new Set(subscription.seenIds);
        const fresh = items.filter(item => !known.has(item.id)).reverse();
        for (const item of fresh) {
          await deliver(item, subscription);
          subscription.seenIds.push(item.id);
          subscription.seenIds = subscription.seenIds.slice(-500);
          await store.save();
          newCount += 1;
        }
        subscription.lastCheckedAt = new Date().toISOString();
        subscription.lastError = "";
      } catch (error) {
        if (subscription.platform === "Instagram" && instagramGenerationAtStart !== instagramAuthGeneration) {
          deferredCount += 1;
          subscription.nextInstagramCheckAt = "";
          await store.save();
          continue;
        }
        if (subscription.platform === "Instagram" && error.instagramSourcesExpired) {
          await expireInstagramSources(error.instagramSourcesExpired);
        }
        if (String(error.message).startsWith("DEFERRED:Instagram:")) {
          deferredCount += 1;
          subscription.lastCheckedAt = new Date().toISOString();
          subscription.lastError = String(error.message).slice(0, 300);
          subscription.nextInstagramCheckAt = "";
          imposeInstagramGuard(String(error.message).split(":").at(-1));
          await store.save();
          continue;
        }
        errorCount += 1;
        const previousError = subscription.lastError;
        subscription.lastError = String(error.message).slice(0, 300);
        if (subscription.lastError === "AUTH_REQUIRED:Instagram") {
          const alreadyStopped = activeInstagramGuard()?.reason === "AUTH_REQUIRED";
          subscription.lastCheckedAt = new Date().toISOString();
          subscription.nextInstagramCheckAt = "";
          imposeInstagramGuard("AUTH_REQUIRED");
          await expireInstagramSources(error.instagramSources);
          if (!alreadyStopped && previousError !== subscription.lastError) {
            await telegram.sendMessage(config.allowedUserId,
              "⚠️ חיבור Instagram פג תוקף. עצרתי את כל סריקות Instagram כדי לא לסכן את החשבון. רשימת המעקב נשמרה; לחץ לחיבור חד-פעמי מחדש.",
              { reply_markup: instagramConnectMarkup() }
            ).catch(console.error);
          }
        }
        console.error(`Scan ${subscription.url}:`, error.message);
      }
      await store.save();
    }
  } finally {
    scanRunning = false;
  }
  const deferredNote = deferredCount ? ` ${deferredCount} חשבונות Instagram נבדקו לאחרונה ולא נסרקו שוב כדי למנוע חסימה.` : "";
  return report ? `הבדיקה הסתיימה: ${newCount} פרסומים חדשים, ${errorCount} שגיאות.${deferredNote}` : undefined;
}

async function addSubscription(chatId, text) {
  const creator = validateCreatorUrl(text);
  if (store.state.subscriptions.some(item => item.url === creator.url)) {
    await telegram.sendMessage(chatId, "הכתובת כבר נמצאת במעקב.");
    return;
  }
  if (creator.platform === "Instagram" && activeInstagramGuard()) {
    await telegram.sendMessage(chatId,
      "⏸️ Instagram בהשהיית הגנה. לא אבדוק כעת את הפרופיל כדי לא להאריך את ההגבלה; נסה שוב לאחר סיום ההשהיה."
    );
    return;
  }
  if (creator.platform === "Instagram" && !config.instagramSessionPath && !config.platformCookies.Instagram) {
    const pending = store.state.auth?.InstagramBootstrap;
    const detail = pending
      ? `\nמצב החיבור נשמר עבור @${pending.username || config.instagramLoginUsername}; הוא עדיין ממתין לאישור Instagram.`
      : "";
    await telegram.sendMessage(chatId,
      `⏳ אין עדיין חיבור Instagram מלא, ולכן לא התחלתי בדיקה איטית של הפרופיל.${detail}\nלחץ על הכפתור, השלם את החיבור ורק אז שלח שוב את קישור הפרופיל.`,
      { reply_markup: instagramConnectMarkup(pending?.username || config.instagramLoginUsername) }
    );
    return;
  }
  const status = await telegram.sendMessage(chatId, "🔎 בודק את הכתובת ושומר נקודת התחלה...");
  try {
    const items = await scanCreatorForManualAction(creator);
    const subscription = {
      ...creator,
      label: new URL(creator.url).pathname.replace(/^\/|\/$/g, "") || new URL(creator.url).hostname,
      addedAt: new Date().toISOString(),
      lastCheckedAt: new Date().toISOString(),
      lastError: "",
      seenIds: items.map(item => item.id).slice(-500)
    };
    scheduleNextInstagramScan(subscription);
    store.state.subscriptions.push(subscription);
    await store.save();
    await telegram.call("editMessageText", {
      chat_id: chatId,
      message_id: status.message_id,
      text: `✅ המעקב נוסף: ${subscription.label}\nנשמרו ${items.length} פרסומים קיימים כנקודת התחלה. מעכשיו יישלחו רק חדשים.`
    });
    const history = items.slice(0, config.historyCount).reverse();
    await telegram.sendMessage(chatId, `📚 הנה ${history.length} סרטונים אחרונים כדי שתדע במי מדובר. הם מסומנים כתוכן קודם ולא ייחשבו להתראה חדשה.`);
    for (const item of history) {
      await deliver(item, subscription, { historical: true });
    }
  } catch (error) {
    const errorText = String(error.message);
    if (errorText.startsWith("DEFERRED:Instagram:")) {
      const subscription = {
        ...creator,
        label: new URL(creator.url).pathname.replace(/^\/|\/$/g, "") || new URL(creator.url).hostname,
        addedAt: new Date().toISOString(),
        lastCheckedAt: new Date().toISOString(),
        lastError: errorText.slice(0, 300),
        pendingBaseline: true,
        seenIds: []
      };
      imposeInstagramGuard(errorText.split(":").at(-1));
      store.state.subscriptions.push(subscription);
      await store.save();
      await telegram.call("editMessageText", {
        chat_id: chatId,
        message_id: status.message_id,
        text: `✅ ${subscription.label} נוסף לרשימה וממתין לסריקה בטוחה. Instagram הגבילה זמנית את הקצב; הבוט יקבע נקודת התחלה אוטומטית במחזור הבא שיצליח ולא ישלח תוכן ישן כהתראה חדשה.`
      });
      return;
    }
    if (errorText.startsWith("AUTH_REQUIRED:")) {
      const platform = errorText.split(":")[1];
      await telegram.call("editMessageText", {
        chat_id: chatId,
        message_id: status.message_id,
        text: authRequiredMessage(platform),
        ...(platform === "Instagram" ? { reply_markup: instagramConnectMarkup() } : {})
      });
      return;
    }
    await telegram.call("editMessageText", {
      chat_id: chatId,
      message_id: status.message_id,
      text: `❌ לא הצלחתי לקרוא את הפרופיל: ${errorText.slice(0, 250)}`
    });
  }
}

async function handleMessage(message) {
  if (String(message.from?.id || "") !== config.allowedUserId) return;
  const chatId = message.chat.id;
  const text = message.text?.trim() || "";
  removeExpiredActions();
  if (message.document) {
    const filename = message.document.file_name?.toLowerCase() || "";
    const platform = AUTH_FILES[filename];
    if (!platform) {
      return telegram.sendMessage(chatId, `שם הקובץ אינו מוכר. שמות נתמכים:\n${[...new Set(Object.keys(AUTH_FILES))].join("\n")}`);
    }
    if (platform === "Instagram" && isInstagramCookieExport(filename)) {
      try {
        await importInstagramCookieDocument(message);
        return telegram.sendMessage(chatId, "✅ חיבור Instagram נשמר והוצפן. הקובץ הגלוי נמחק; אפשר לשלוח עכשיו קישור לפרופיל למעקב.");
      } catch (error) {
        console.warn("Instagram cookie import:", error.message);
        return telegram.sendMessage(chatId, "❌ הקובץ לא הכיל סשן Instagram פעיל. פתח instagram.com ב‑Firefox, ודא שאתה מחובר, וייצא שוב cookies.txt מהלשונית של Instagram.");
      }
    }
    if (["YouTube", "Facebook", "TikTok", "X"].includes(platform)) {
      try {
        await saveSocialCookies(message, platform);
        return telegram.sendMessage(chatId, `✅ חיבור ${platform} נבדק, הוצפן ונשמר. הקובץ הגלוי נמחק.`);
      } catch (error) {
        console.warn(`${platform} cookie import:`, error.message);
        return telegram.sendMessage(chatId, `❌ הקובץ אינו מכיל חיבור ${platform} תקין. התחבר בדפדפן וייצא cookies חדשים מהאתר הנכון.`);
      }
    }
    store.state.auth ||= {};
    store.state.auth[platform] = {
      fileId: message.document.file_id,
      filename,
      kind: filename === "instagram-session.enc" ? "instagrapi-v1" : "cookies",
      updatedAt: new Date().toISOString()
    };
    await hydrateAuth(platform);
    await store.save();
    return telegram.sendMessage(chatId, `✅ ההתחברות ל-${platform} נשמרה בענן. אפשר לשלוח עכשיו את קישור הפרופיל.`);
  }
  if (text === "/start" || text === "/help") return telegram.sendMessage(chatId, help);
  if (text === "/diagnostics") {
    const value = lastDownloadDiagnostic;
    const worker = config.webhookUrl
      ? `✅ עובד YouTube חלופי אוטומטי פעיל; ${Object.keys(store.state.youtubeJobs || {}).length} משימות ממתינות.${config.githubActionsToken ? " הפעלה מיידית מחוברת." : " איסוף עד 5 דקות."}`
      : "❌ עובד YouTube חלופי זמין רק בפריסת הענן.";
    return telegram.sendMessage(chatId, value
      ? `${worker}\n\nאבחון הורדה אחרון (${value.platform}, ${value.at}):\n${value.message}`
      : `${worker}\nאין עדיין אבחון הורדה במופע השרת הנוכחי.`);
  }
  if (/^\/instagram_file(?:@\w+)?$/i.test(text)) return sendInstagramFileInstructions(chatId);
  const instagramCommand = text.match(/^\/(?:instagram|connect_instagram)(?:@\w+)?(?:\s+(.+))?$/i);
  if (instagramCommand) return sendInstagramConnect(chatId, instagramCommand[1] || "");
  if (text === "/auth") {
    const lines = ["YouTube", "Instagram", "Facebook", "TikTok", "X"].map(platform => {
      if (platform === "Instagram") return `${(config.instagramSessionPath || config.platformCookies[platform]) ? "✅" : "⬜"} ${platform}`;
      const active = Boolean(config.platformCookies[platform]) && store.state.auth?.[platform]?.status !== "EXPIRED";
      return `${active ? "✅" : "⬜"} ${platform}${active ? " — חיבור מוצפן פעיל" : ""}`;
    });
    const instagramPrivate = store.state.auth?.Instagram;
    const instagramWeb = store.state.auth?.InstagramWeb;
    lines[1] = instagramAuthSummary({
      privateAuth: instagramPrivate,
      privateAvailable: Boolean(config.instagramSessionPath),
      webAuth: instagramWeb,
      webAvailable: Boolean(config.platformCookies.Instagram),
      guard: store.state.instagramGuard
    }, config.instagramLoginUsername);
    const pending = store.state.auth?.InstagramBootstrap;
    if (pending && !config.instagramSessionPath && !config.platformCookies.Instagram) {
      lines[1] = `⏳ Instagram — החיבור החלקי נשמר עבור @${pending.username || config.instagramLoginUsername}; סיבה: ${pending.reason || pending.status || "ממתין לאישור"}`;
    }
    return telegram.sendMessage(chatId, `מצב התחברות:\n${lines.join("\n")}`);
  }
  if (text === "/list") {
    const lines = store.state.subscriptions.map((item, index) =>
      `${index + 1}. ${item.platform} — ${item.label}${item.lastError ? " ⚠️" : ""}`
    );
    return telegram.sendMessage(chatId, lines.length ? lines.join("\n") : "אין עדיין כתובות במעקב.");
  }
  if (/^\/remove(?:@\w+)?\s+\d+$/.test(text)) {
    const index = Number(text.match(/\d+$/)[0]) - 1;
    const [removed] = store.state.subscriptions.splice(index, 1);
    if (!removed) return telegram.sendMessage(chatId, "מספר מעקב לא קיים.");
    await store.save();
    return telegram.sendMessage(chatId, `🗑️ המעקב הוסר: ${removed.label}`);
  }
  if (text === "/pause" || text === "/resume") {
    store.state.paused = text === "/pause";
    await store.save();
    return telegram.sendMessage(chatId, store.state.paused ? "⏸️ כל המעקבים הושהו." : "▶️ המעקבים חודשו.");
  }
  if (text === "/check") return telegram.sendMessage(chatId, await scanAll({ report: true }));
  try {
    const links = extractSupportedUrls(text);
    if (links.length > 1) {
      if (links.some(item => item.kind !== "profile")) {
        return telegram.sendMessage(chatId, "אפשר לשלוח רשימה של קישורי פרופילים יחד. קישורים לסרטונים בודדים יש לשלוח אחד בכל הודעה כדי שאוריד אותם מיד.");
      }
      return sendBulkProfileChoice(chatId, links.map(item => validateCreatorUrl(item.url)));
    }
    const classified = classifySupportedUrl(text);
    if (classified.kind === "profile") return sendProfileChoice(chatId, validateCreatorUrl(classified.url));
    const userId = String(message.from.id);
    if (busyUsers.has(userId)) return telegram.sendMessage(chatId, "כבר מתבצעת הורדה. המתן לסיומה.");
    busyUsers.add(userId);
    try {
      return await downloadRequestedMedia(chatId, classified.url);
    } finally {
      busyUsers.delete(userId);
    }
  } catch (error) {
    return telegram.sendMessage(chatId, `❌ ${friendlyDownloadError(error)}`);
  }
}

async function dispatchUpdate(update) {
  if (update.message) await handleMessage(update.message);
  if (update.callback_query) await handleCallback(update.callback_query);
}

function configureBotCommands() {
  return telegram.call("setMyCommands", {
    commands: [
      { command: "instagram", description: "חיבור Instagram מהטלפון" },
      { command: "instagram_file", description: "חיבור Instagram ללא כבל" },
      { command: "list", description: "רשימת המעקבים" },
      { command: "check", description: "בדיקה מיידית" },
      { command: "auth", description: "מצב החיבורים" },
      { command: "diagnostics", description: "בדיקת תקינות הורדות" },
      { command: "pause", description: "השהיית המעקב" },
      { command: "resume", description: "חידוש המעקב" }
    ]
  });
}

function sendConnectPage(response, page, status = 200) {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store, max-age=0",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  });
  response.end(page);
}

function readFormBody(request, limit = 20_000) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", chunk => {
      raw += chunk;
      if (raw.length > limit) reject(new Error("הטופס גדול מדי"));
    });
    request.on("end", () => resolve(new URLSearchParams(raw)));
    request.on("error", reject);
  });
}

function readJsonBody(request, limit = 256_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.on("data", chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail(new Error("Request body is too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    request.on("error", fail);
  });
}

function readBufferBody(request, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers["content-length"] || 0);
    if (declared > limit) {
      reject(new Error("Request body is too large"));
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.on("data", chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail(new Error("Request body is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    request.on("error", fail);
  });
}

async function readFormDataBody(request, limit) {
  const contentType = String(request.headers["content-type"] || "");
  if (!/^(?:multipart\/form-data|application\/x-www-form-urlencoded)(?:;|$)/i.test(contentType)) {
    throw new Error("Invalid form content type");
  }
  const raw = await readBufferBody(request, limit);
  return new Response(raw, { headers: { "content-type": contentType } }).formData();
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

function youtubeWorkerFailureText(code, url) {
  const reason = code === "FILE_TOO_LARGE"
    ? "הסרטון גדול מדי גם באיכות הנמוכה שמתאימה ל-Telegram."
    : code === "YOUTUBE_AUTH"
      ? "YouTube חסמה גם את שרת הגיבוי הפעם."
      : "שרת הגיבוי לא הצליח להשלים את ההורדה.";
  return `❌ ${reason}\nהקישור לא אבד:\n${url}`;
}

async function handleYoutubeWorkerCallback(request, response) {
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "POST" });
    response.end();
    return;
  }
  let form;
  try {
    form = await readFormDataBody(request, config.maxBytes + 2 * 1024 * 1024);
  } catch (error) {
    sendJson(response, error.message.includes("large") ? 413 : 400, { ok: false, error: "INVALID_REQUEST" });
    return;
  }
  const state = String(form.get("state") || "");
  if (state === "import_social_session") {
    const platform = String(form.get("platform") || "");
    const token = String(form.get("upload_token") || "");
    const fingerprint = socialUploadTokenFingerprint(token);
    const used = store.state.usedSocialUploadTokens || [];
    const uploaded = form.get("cookies");
    if (!["YouTube", "Facebook", "TikTok", "X"].includes(platform)
      || !verifySocialUploadToken(token, config.token, platform)
      || used.includes(fingerprint)) {
      sendJson(response, 403, { ok: false, error: "INVALID_OR_EXPIRED_UPLOAD_TOKEN" });
      return;
    }
    if (!(uploaded instanceof Blob) || uploaded.size < 1 || uploaded.size > 512_000) {
      sendJson(response, 400, { ok: false, error: "INVALID_COOKIE_FILE" });
      return;
    }
    store.state.usedSocialUploadTokens = [fingerprint, ...used.filter(value => value !== fingerprint)].slice(0, 50);
    try {
      await persistSocialCookies(Buffer.from(await uploaded.arrayBuffer()), platform);
      sendJson(response, 200, { ok: true, platform });
    } catch (error) {
      store.state.usedSocialUploadTokens = used;
      await store.save().catch(() => {});
      sendJson(response, 400, { ok: false, error: "INVALID_COOKIE_FILE" });
    }
    return;
  }
  if (state === "claim_next") {
    if (youtubeClaimLock) {
      sendJson(response, 409, { ok: false, error: "QUEUE_BUSY" });
      return;
    }
    youtubeClaimLock = true;
    try {
      pruneYoutubeJobs();
      const claimed = claimNextYoutubeJob(store.state.youtubeJobs, config.allowedUserId, Date.now(), YOUTUBE_JOB_LEASE_MS);
      if (!claimed) {
        sendJson(response, 200, { ok: true, job: null });
        return;
      }
      await store.save();
      const callbackToken = createYoutubeWorkerToken(config.webhookSecret, claimed.jobId, Date.now(), YOUTUBE_JOB_TTL_MS);
      const youtubeCookies = await youtubeCookiesForWorker();
      sendJson(response, 200, {
        ok: true,
        job: buildYoutubeWorkerClaim(claimed.job, callbackToken, youtubeCookies)
      });
    } finally {
      youtubeClaimLock = false;
    }
    return;
  }
  let payload;
  try {
    payload = verifyYoutubeWorkerToken(String(form.get("token") || ""), config.webhookSecret);
  } catch {
    sendJson(response, 403, { ok: false, error: "INVALID_OR_EXPIRED_TOKEN" });
    return;
  }
  pruneYoutubeJobs();
  const job = store.state.youtubeJobs?.[payload.jobId];
  if (!job || job.processing || job.chatId !== String(config.allowedUserId)) {
    sendJson(response, 404, { ok: false, error: "JOB_NOT_FOUND" });
    return;
  }
  if (state === "claim") {
    job.leaseUntil = Date.now() + YOUTUBE_JOB_LEASE_MS;
    job.claimedAt = Date.now();
    await store.save();
    const youtubeCookies = await youtubeCookiesForWorker();
    sendJson(response, 200, {
      ok: true,
      ...buildYoutubeWorkerClaim(job, String(form.get("token") || ""), youtubeCookies)
    });
    return;
  }
  if (state === "started") {
    job.leaseUntil = Date.now() + YOUTUBE_JOB_LEASE_MS;
    await store.save();
    await telegram.call("editMessageText", {
      chat_id: job.chatId,
      message_id: job.statusMessageId,
      text: "☁️ שרת YouTube החלופי התחיל להוריד את הסרטון..."
    }).catch(() => {});
    sendJson(response, 200, { ok: true });
    return;
  }
  if (state === "failure") {
    delete store.state.youtubeJobs[payload.jobId];
    await store.save().catch(console.error);
    await telegram.call("editMessageText", {
      chat_id: job.chatId,
      message_id: job.statusMessageId,
      text: youtubeWorkerFailureText(String(form.get("code") || "DOWNLOAD_FAILED"), job.item.url)
    }).catch(() => {});
    sendJson(response, 200, { ok: true });
    return;
  }
  if (state !== "success") {
    sendJson(response, 400, { ok: false, error: "INVALID_STATE" });
    return;
  }
  const uploaded = form.get("file");
  if (!(uploaded instanceof Blob) || uploaded.size < 1 || uploaded.size > config.maxBytes) {
    sendJson(response, 400, { ok: false, error: "INVALID_MEDIA" });
    return;
  }
  job.processing = true;
  await fs.promises.mkdir(config.tempDir, { recursive: true });
  const directory = path.join(config.tempDir, `youtube-worker-${payload.jobId}`);
  const destination = path.join(directory, "youtube.mp4");
  try {
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(destination, Buffer.from(await uploaded.arrayBuffer()), { mode: 0o600 });
    await telegram.sendVideo(job.chatId, destination, job.caption || `✅ הורד מ-YouTube\n${job.item.url}`);
    await telegram.call("editMessageText", {
      chat_id: job.chatId,
      message_id: job.statusMessageId,
      text: "✅ הורדת YouTube הושלמה ונשלחה דרך השרת החלופי."
    }).catch(() => {});
    if (job.offerTracking) {
      let creator = null;
      const creatorUrl = String(form.get("creator_url") || "");
      try {
        creator = validateCreatorUrl(creatorUrl);
        if (creator.platform !== "YouTube") creator = null;
      } catch {
        creator = null;
      }
      await sendTrackingChoice(job.chatId, job.item.url, creator);
    }
    delete store.state.youtubeJobs[payload.jobId];
    await store.save();
    sendJson(response, 200, { ok: true });
  } catch (error) {
    job.processing = false;
    console.error("YouTube worker delivery:", error.message);
    sendJson(response, 502, { ok: false, error: "DELIVERY_FAILED" });
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function handleInstagramSessionConnect(request, response) {
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "POST" });
    response.end();
    return;
  }
  let payload;
  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, error.message.includes("large") ? 413 : 400, { ok: false, error: "INVALID_REQUEST" });
    return;
  }
  const token = typeof payload?.token === "string" ? payload.token : "";
  if (!verifyInstagramConnectToken(token, config.webhookSecret, config.allowedUserId) || instagramTokenWasUsed(token)) {
    sendJson(response, 403, { ok: false, error: "INVALID_OR_EXPIRED_TOKEN" });
    return;
  }
  const username = instagramUsernameFromConnectToken(token, config.webhookSecret, config.allowedUserId)
    || normalizeInstagramUsername(payload?.username);
  if (!/^[A-Za-z0-9._]{1,30}$/.test(username)) {
    sendJson(response, 400, { ok: false, error: "INVALID_USERNAME" });
    return;
  }
  let cookies;
  try {
    cookies = normalizeInstagramCookies(payload?.cookies);
  } catch {
    sendJson(response, 400, { ok: false, error: "INVALID_INSTAGRAM_SESSION" });
    return;
  }

  consumeInstagramToken(token);
  instagramConnectAttempts.delete(token);
  const bootstrapSettings = await loadInstagramBootstrap(username);
  await saveInstagramWebCookies(cookies, username);

  const sessionId = cookies.find(cookie => cookie.name === "sessionid").value;
  let result = { status: "WEB_SESSION_ONLY" };
  try {
    result = await runInstagramSessionImport(config, {
      username,
      sessionid: sessionId,
      deviceSeed: instagramDeviceSeed(username),
      settings: bootstrapSettings
    });
  } catch (error) {
    console.warn("Instagram private session import unavailable:", error.message);
  }
  let mode = result.status === "OK" && result.session ? "private" : "web";
  if (mode === "private") {
    try {
      await saveInstagramSession(result.session, result.username || username);
    } catch (error) {
      mode = "web";
      console.warn("Instagram private session backup unavailable; web session remains active:", error.message);
    }
  }
  await telegram.sendMessage(
    config.allowedUserId,
    mode === "private"
      ? "✅ חיבור Instagram מהטלפון נשמר והומר לסשן קבוע. אפשר לשלוח עכשיו קישור לפרופיל למעקב."
      : "✅ חיבור Instagram מהטלפון נשמר ומוצפן. פוסטים, Reels ו‑Stories ייבדקו דרך סשן הדפדפן גם כשהטלפון והמחשב כבויים."
  ).catch(console.error);
  sendJson(response, 200, { ok: true, mode });
}

async function handleInstagramConnect(request, response, requestUrl) {
  if (request.method === "GET") {
    const token = requestUrl.searchParams.get("token") || "";
    if (!verifyInstagramConnectToken(token, config.webhookSecret, config.allowedUserId) || instagramTokenWasUsed(token)) {
      sendConnectPage(response, instagramConnectPage({ error: "הקישור פג תוקף. חזור לבוט ובקש קישור חדש עם /instagram." }), 403);
      return;
    }
    const username = instagramUsernameFromConnectToken(token, config.webhookSecret, config.allowedUserId);
    sendConnectPage(response, instagramConnectPage({ token, username }));
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "GET, POST" });
    response.end();
    return;
  }
  const form = await readFormBody(request);
  const token = form.get("token") || "";
  if (!verifyInstagramConnectToken(token, config.webhookSecret, config.allowedUserId) || instagramTokenWasUsed(token)) {
    sendConnectPage(response, instagramConnectPage({ error: "הקישור פג תוקף. חזור לבוט ובקש קישור חדש עם /instagram." }), 403);
    return;
  }
  const attempts = instagramConnectAttempts.get(token) || 0;
  if (attempts >= 5) {
    sendConnectPage(response, instagramConnectPage({ error: "בוצעו יותר מדי ניסיונות. חזור לבוט ובקש קישור חדש עם /instagram." }), 429);
    return;
  }
  instagramConnectAttempts.set(token, attempts + 1);
  const lockedUsername = instagramUsernameFromConnectToken(token, config.webhookSecret, config.allowedUserId);
  const username = lockedUsername || normalizeInstagramUsername(form.get("username"));
  const password = form.get("password") || "";
  const code = (form.get("code") || "").trim();
  if (!/^[A-Za-z0-9._]{1,30}$/.test(username)) {
    sendConnectPage(response, instagramConnectPage({ token, username: lockedUsername, error: "הזן את שם המשתמש שמופיע בפרופיל Instagram — לא אימייל או מספר טלפון. אפשר גם להדביק קישור מלא לפרופיל." }), 400);
    return;
  }
  if (password.length < 6 || password.length > 200) {
    sendConnectPage(response, instagramConnectPage({ token, username: lockedUsername, error: "שדה הסיסמה לא נקלט במלואו. הקלד שוב את סיסמת Instagram ולחץ על חיבור." }), 400);
    return;
  }
  const guard = activeInstagramGuard();
  if (guard && guard.reason !== "AUTH_REQUIRED") {
    const until = new Date(guard.until).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" });
    sendConnectPage(response, instagramConnectPage({ token, username: lockedUsername, error: `החיבור נשמר, אך Instagram הגבילה זמנית בקשות. כדי להגן על החשבון לא יבוצע ניסיון כניסה נוסף עד ${until}.` }), 429);
    return;
  }
  let result;
  try {
    result = await runInstagramLogin(config, {
      username,
      password,
      code,
      deviceSeed: instagramDeviceSeed(username),
      settings: await loadInstagramBootstrap(username)
    });
  } catch (error) {
    console.error("Instagram login bridge:", error.message);
    sendConnectPage(response, instagramConnectPage({ token, username, error: "תהליך החיבור בשרת לא הושלם. החשבון נשמר בטופס; המתן דקה ונסה שוב עם אותה סיסמה." }), 502);
    return;
  }
  if (result.status !== "OK" && result.settings) {
    await saveInstagramBootstrap(result.settings, username, result.status, result.reason).catch(error => console.error("Instagram bootstrap save:", error.message));
  }
  if (result.status !== "OK") {
    console.warn("Instagram login result:", result.status, result.reason || "unspecified");
  }
  if (result.status === "TWO_FACTOR") {
    sendConnectPage(response, instagramConnectPage({ token, username: lockedUsername, needsCode: true, error: "נדרש קוד אימות. הזן שוב את הסיסמה ואת הקוד העדכני." }));
    return;
  }
  if (result.status === "CHALLENGE") {
    sendConnectPage(response, instagramConnectPage({ token, username: lockedUsername, needsCode: true, error: "Instagram מבקשת אימות. פתח את האפליקציה ואשר שזה אתה. אם נשלח קוד ב-SMS או באימייל, הזן אותו כאן יחד עם הסיסמה." }));
    return;
  }
  if (result.status === "BAD_CREDENTIALS") {
    sendConnectPage(response, instagramConnectPage({ token, username: lockedUsername, error: "שם המשתמש או הסיסמה לא התקבלו. בדוק ונסה שוב." }), 401);
    return;
  }
  if (result.status === "RATE_LIMIT") {
    imposeInstagramGuard("RATE_LIMIT");
    await store.save();
    sendConnectPage(response, instagramConnectPage({ token, username, error: "Instagram הגבילה זמנית ניסיונות כניסה. עצרתי ניסיונות נוספים כדי להגן על החשבון. המתן שעתיים ובקש מהבוט קישור חדש." }), 429);
    return;
  }
  if (result.status === "LOGIN_BLOCKED") {
    sendConnectPage(response, instagramConnectPage({ token, username, error: "Instagram חסמה את הכניסה החדשה. פתח עכשיו את אפליקציית Instagram, אשר שזה אתה, ואז חזור ושלח את הטופס שוב." }), 403);
    return;
  }
  if (result.status === "NETWORK_ERROR") {
    sendConnectPage(response, instagramConnectPage({ token, username, error: "Instagram לא השיבה לשרת. החשבון נשמר; המתן דקה ונסה שוב." }), 503);
    return;
  }
  if (result.status !== "OK" || !result.session) {
    const reason = String(result.reason || "unknown").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
    sendConnectPage(response, instagramConnectPage({ token, username, error: `Instagram דחתה את ההתחברות. מצב המכשיר נשמר ולא יתחיל מחדש. קוד אבחון: ${reason}` }), 502);
    return;
  }
  consumeInstagramToken(token);
  await saveInstagramSession(result.session, result.username || username);
  instagramConnectAttempts.delete(token);
  await telegram.sendMessage(config.allowedUserId, "✅ Instagram חובר בהצלחה. אפשר לשלוח עכשיו קישור לפרופיל למעקב.").catch(console.error);
  sendConnectPage(response, instagramConnectPage({ success: true }));
}

async function startWebhook() {
  if (!config.webhookSecret) throw new Error("חסר WEBHOOK_SECRET במצב ענן");
  const safeSecret = crypto.createHash("sha256").update(config.webhookSecret).digest("hex");
  const webhookPath = `/telegram/${safeSecret}`;
  const scanPath = createCreatorMonitorScanPath(config.token);
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url, config.webhookUrl);
    if (requestUrl.pathname === scanPath && request.method === "POST") {
      void handleYoutubeWorkerCallback(request, response).catch(error => {
        console.error("YouTube worker callback:", error.message);
        if (!response.headersSent) sendJson(response, 500, { ok: false, error: "WORKER_CALLBACK_FAILED" });
        else response.end();
      });
      return;
    }
    if (requestUrl.pathname === "/connect/instagram/session") {
      void handleInstagramSessionConnect(request, response).catch(error => {
        console.error("Instagram session connect:", error.message);
        if (!response.headersSent) sendJson(response, 500, { ok: false, error: "SESSION_IMPORT_FAILED" });
        else response.end();
      });
      return;
    }
    if (requestUrl.pathname === "/connect/instagram") {
      void handleInstagramConnect(request, response, requestUrl).catch(error => {
        console.error("Instagram connect:", error.message);
        if (!response.headersSent) sendConnectPage(response, instagramConnectPage({ error: "החיבור נכשל זמנית. חזור לבוט ונסה שוב." }), 500);
        else response.end();
      });
      return;
    }
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        ok: true,
        service: "Mordi Creator Monitor",
        version: process.env.RENDER_GIT_COMMIT?.slice(0, 7) || "local"
      }));
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === scanPath) {
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ accepted: true }));
      void scanAll().catch(error => console.error("Scheduled scan:", error));
      return;
    }
    if (request.method !== "POST" || request.url !== webhookPath) {
      response.writeHead(404);
      response.end();
      return;
    }
    let raw = "";
    request.on("data", chunk => {
      raw += chunk;
      if (raw.length > 1_000_000) request.destroy();
    });
    request.on("end", () => {
      response.writeHead(200);
      response.end("ok");
      try {
        void dispatchUpdate(JSON.parse(raw)).catch(error => console.error("Webhook:", error));
      } catch (error) {
        console.error("Webhook JSON:", error.message);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "0.0.0.0", resolve);
  });
  await telegram.call("setWebhook", {
    url: `${config.webhookUrl}${webhookPath}`,
    secret_token: safeSecret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false
  });
  await configureBotCommands();
  console.log(`Creator monitor webhook active on port ${config.port}`);
}

async function poll() {
  await telegram.call("deleteWebhook", { drop_pending_updates: false });
  await configureBotCommands();
  setInterval(() => void scanAll().catch(console.error), config.intervalMs).unref();
  void scanAll().catch(console.error);
  console.log(`Creator monitor polling active; interval ${config.intervalMs / 60_000} minutes`);
  while (true) {
    try {
      const updates = await telegram.call("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"]
      });
      for (const update of updates) {
        offset = update.update_id + 1;
        await dispatchUpdate(update);
      }
    } catch (error) {
      console.error(new Date().toISOString(), error.message);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

if (config.webhookUrl) {
  await startWebhook();
  setInterval(() => void scanAll().catch(console.error), config.intervalMs).unref();
  void scanAll().catch(console.error);
  console.log(`Creator monitor cloud scan active; interval ${config.intervalMs / 60_000} minutes`);
} else {
  await poll();
}
