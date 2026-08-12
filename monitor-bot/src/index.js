import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { readConfig } from "./config.js";
import { Telegram } from "./telegram.js";
import { Store } from "./store.js";
import { validateCreatorUrl, scanCreator, downloadVideo, cleanupVideo } from "./scanner.js";
import {
  createInstagramConnectToken,
  verifyInstagramConnectToken,
  instagramUsernameFromConnectToken,
  normalizeInstagramUsername,
  encryptInstagramSession,
  decryptInstagramSession,
  instagramConnectPage,
  runInstagramLogin
} from "./instagram-connect.js";

const config = readConfig();
const telegram = new Telegram(config.token);
const store = new Store(config.dataDir, telegram, config.allowedUserId);
await store.load();
config.platformCookies = {};
let offset = 0;
let scanRunning = false;
const usedInstagramTokens = new Set();
const instagramConnectAttempts = new Map();

const help = `שלח קישור לפרופיל או לערוץ כדי להתחיל לעקוב.

/list — רשימת המעקבים
/remove מספר — הסרת מעקב
/check — בדיקה מיידית
/pause — השהיית כל המעקבים
/resume — חידוש המעקבים
/auth — מצב ההתחברות לפלטפורמות
/instagram — חיבור Instagram פשוט מהטלפון

בעת הוספה נשמר המצב הנוכחי, ולכן לא יישלח תוכן ישן.`;

const AUTH_FILES = {
  "instagram-session.enc": "Instagram",
  "instagram-cookies.txt": "Instagram",
  "facebook-cookies.txt": "Facebook",
  "tiktok-cookies.txt": "TikTok",
  "x-cookies.txt": "X",
  "twitter-cookies.txt": "X"
};

async function hydrateAuth(platform) {
  const auth = store.state.auth?.[platform];
  if (!auth?.fileId) return false;
  if (platform === "InstagramBootstrap" && auth.kind === "instagrapi-bootstrap-v1") {
    const encrypted = path.join(config.dataDir, "instagram-bootstrap.enc");
    const destination = path.join(config.dataDir, "instagram-bootstrap.json");
    await telegram.downloadFile(auth.fileId, encrypted);
    const settings = decryptInstagramSession(await fs.promises.readFile(encrypted), config.webhookSecret);
    await fs.promises.writeFile(destination, JSON.stringify(settings), { mode: 0o600 });
    await fs.promises.rm(encrypted, { force: true });
    config.instagramBootstrapPath = destination;
    return true;
  }
  if (platform === "Instagram" && auth.kind === "instagrapi-v1") {
    const encrypted = path.join(config.dataDir, "instagram-session.enc");
    const destination = path.join(config.dataDir, "instagram-session.json");
    await telegram.downloadFile(auth.fileId, encrypted);
    const session = decryptInstagramSession(await fs.promises.readFile(encrypted), config.webhookSecret);
    await fs.promises.writeFile(destination, JSON.stringify(session), { mode: 0o600 });
    await fs.promises.rm(encrypted, { force: true });
    config.instagramSessionPath = destination;
    return true;
  }
  const destination = `${config.dataDir}/${platform.toLowerCase()}-cookies.txt`;
  await telegram.downloadFile(auth.fileId, destination);
  config.platformCookies[platform] = destination;
  return true;
}

for (const platform of Object.keys(store.state.auth || {})) {
  await hydrateAuth(platform).catch(error => console.warn(`Auth ${platform}:`, error.message));
}

function authRequiredMessage(platform) {
  if (platform === "Instagram") {
    return "🔐 כדי לעקוב באופן קבוע אחרי פוסטים, Reels וסטוריז, יש לחבר חשבון Instagram פעם אחת. לחץ על הכפתור למטה; הסיסמה אינה נשמרת.";
  }
  const filename = platform === "X" ? "x-cookies.txt" : `${platform.toLowerCase()}-cookies.txt`;
  return `🔐 ${platform} דורש session כדי לקרוא פרופילים משרת ענן.\nשלח לבוט קובץ cookies בפורמט Netscape בשם ${filename}, ולאחר האישור שלח שוב את קישור הפרופיל. הקובץ נשמר באופן פרטי ב-Telegram ולא ב-GitHub.`;
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

async function saveInstagramBootstrap(settings, username) {
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

async function saveInstagramSession(session, username) {
  await fs.promises.mkdir(config.dataDir, { recursive: true });
  const destination = path.join(config.dataDir, "instagram-session.json");
  const encrypted = path.join(config.tempDir, `instagram-session-${crypto.randomUUID()}.enc`);
  await fs.promises.mkdir(config.tempDir, { recursive: true });
  await fs.promises.writeFile(destination, JSON.stringify(session), { mode: 0o600 });
  await fs.promises.writeFile(encrypted, encryptInstagramSession(session, config.webhookSecret), { mode: 0o600 });
  try {
    const sent = await telegram.sendDocument(
      config.allowedUserId,
      encrypted,
      "🔐 גיבוי מוצפן של חיבור Instagram — אין למחוק",
      { filename: "instagram-session.enc", disableNotification: true }
    );
    store.state.auth ||= {};
    store.state.auth.Instagram = {
      fileId: sent.document.file_id,
      filename: "instagram-session.enc",
      kind: "instagrapi-v1",
      username,
      updatedAt: new Date().toISOString()
    };
    const bootstrapMessageId = store.state.auth.InstagramBootstrap?.messageId;
    delete store.state.auth.InstagramBootstrap;
    config.instagramSessionPath = destination;
    config.instagramBootstrapPath = "";
    await fs.promises.rm(path.join(config.dataDir, "instagram-bootstrap.json"), { force: true });
    await store.save();
    if (bootstrapMessageId) {
      await telegram.call("deleteMessage", { chat_id: config.allowedUserId, message_id: bootstrapMessageId }).catch(() => {});
    }
  } finally {
    await fs.promises.rm(encrypted, { force: true });
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
    } finally {
      if (file) await cleanupVideo(file).catch(console.error);
    }
  }
  await telegram.sendMessage(config.allowedUserId, caption);
}

async function scanAll({ report = false } = {}) {
  if (scanRunning) return report ? "כבר מתבצעת בדיקה." : undefined;
  if (store.state.paused) return report ? "המעקב מושהה." : undefined;
  scanRunning = true;
  let newCount = 0;
  let errorCount = 0;
  try {
    for (const subscription of store.state.subscriptions) {
      try {
        const items = await scanCreator(subscription, config);
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
        errorCount += 1;
        const previousError = subscription.lastError;
        subscription.lastError = String(error.message).slice(0, 300);
        if (subscription.lastError === "AUTH_REQUIRED:Instagram" && previousError !== subscription.lastError) {
          await telegram.sendMessage(config.allowedUserId,
            "⚠️ חיבור Instagram פג תוקף. לחץ כדי להתחבר מחדש; רשימת המעקב נשמרה.",
            { reply_markup: instagramConnectMarkup() }
          ).catch(console.error);
        }
        console.error(`Scan ${subscription.url}:`, error.message);
      }
      await store.save();
    }
  } finally {
    scanRunning = false;
  }
  return report ? `הבדיקה הסתיימה: ${newCount} פרסומים חדשים, ${errorCount} שגיאות.` : undefined;
}

async function addSubscription(chatId, text) {
  const creator = validateCreatorUrl(text);
  if (store.state.subscriptions.some(item => item.url === creator.url)) {
    await telegram.sendMessage(chatId, "הכתובת כבר נמצאת במעקב.");
    return;
  }
  const status = await telegram.sendMessage(chatId, "🔎 בודק את הכתובת ושומר נקודת התחלה...");
  try {
    const items = await scanCreator(creator, config);
    const subscription = {
      ...creator,
      label: new URL(creator.url).pathname.replace(/^\/|\/$/g, "") || new URL(creator.url).hostname,
      addedAt: new Date().toISOString(),
      lastCheckedAt: new Date().toISOString(),
      lastError: "",
      seenIds: items.map(item => item.id).slice(-500)
    };
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
  if (message.document) {
    const filename = message.document.file_name?.toLowerCase() || "";
    const platform = AUTH_FILES[filename];
    if (!platform) {
      return telegram.sendMessage(chatId, `שם הקובץ אינו מוכר. שמות נתמכים:\n${[...new Set(Object.keys(AUTH_FILES))].join("\n")}`);
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
  const instagramCommand = text.match(/^\/(?:instagram|connect_instagram)(?:@\w+)?(?:\s+(.+))?$/i);
  if (instagramCommand) return sendInstagramConnect(chatId, instagramCommand[1] || "");
  if (text === "/auth") {
    const lines = ["Instagram", "Facebook", "TikTok", "X"].map(platform =>
      `${(platform === "Instagram" ? (config.instagramSessionPath || config.platformCookies[platform]) : config.platformCookies[platform]) ? "✅" : "⬜"} ${platform}`
    );
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
  return addSubscription(chatId, text);
}

async function dispatchUpdate(update) {
  if (update.message) await handleMessage(update.message);
}

function configureBotCommands() {
  return telegram.call("setMyCommands", {
    commands: [
      { command: "instagram", description: "חיבור Instagram מהטלפון" },
      { command: "list", description: "רשימת המעקבים" },
      { command: "check", description: "בדיקה מיידית" },
      { command: "auth", description: "מצב החיבורים" },
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

async function handleInstagramConnect(request, response, requestUrl) {
  if (request.method === "GET") {
    const token = requestUrl.searchParams.get("token") || "";
    if (!verifyInstagramConnectToken(token, config.webhookSecret, config.allowedUserId) || usedInstagramTokens.has(token)) {
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
  if (!verifyInstagramConnectToken(token, config.webhookSecret, config.allowedUserId) || usedInstagramTokens.has(token)) {
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
    await saveInstagramBootstrap(result.settings, username).catch(error => console.error("Instagram bootstrap save:", error.message));
  }
  if (result.status !== "OK") {
    console.warn("Instagram login result:", result.status, result.reason || "unspecified");
  }
  if (result.status === "TWO_FACTOR") {
    sendConnectPage(response, instagramConnectPage({ token, username: lockedUsername, needsCode: true, error: "נדרש קוד אימות. הזן שוב את הסיסמה ואת הקוד העדכני." }));
    return;
  }
  if (result.status === "CHALLENGE") {
    sendConnectPage(response, instagramConnectPage({ token, username: lockedUsername, error: "Instagram מבקשת אישור כניסה. אשר את הכניסה באפליקציה הרשמית ואז שלח את הטופס שוב." }));
    return;
  }
  if (result.status === "BAD_CREDENTIALS") {
    sendConnectPage(response, instagramConnectPage({ token, username: lockedUsername, error: "שם המשתמש או הסיסמה לא התקבלו. בדוק ונסה שוב." }), 401);
    return;
  }
  if (result.status === "RATE_LIMIT") {
    sendConnectPage(response, instagramConnectPage({ token, username, error: "Instagram הגבילה זמנית ניסיונות כניסה. אל תנסה שוב עכשיו; המתן 15 דקות ובקש מהבוט קישור חדש." }), 429);
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
  await saveInstagramSession(result.session, result.username || username);
  usedInstagramTokens.add(token);
  instagramConnectAttempts.delete(token);
  await telegram.sendMessage(config.allowedUserId, "✅ Instagram חובר בהצלחה. אפשר לשלוח עכשיו קישור לפרופיל למעקב.").catch(console.error);
  sendConnectPage(response, instagramConnectPage({ success: true }));
}

async function startWebhook() {
  if (!config.webhookSecret) throw new Error("חסר WEBHOOK_SECRET במצב ענן");
  const safeSecret = crypto.createHash("sha256").update(config.webhookSecret).digest("hex");
  const webhookPath = `/telegram/${safeSecret}`;
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url, config.webhookUrl);
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
      response.end(JSON.stringify({ ok: true, service: "Mordi Creator Monitor" }));
      return;
    }
    if (request.method === "GET" && request.url === "/scan") {
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
    allowed_updates: ["message"],
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
        allowed_updates: ["message"]
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

if (config.webhookUrl) await startWebhook();
else await poll();
