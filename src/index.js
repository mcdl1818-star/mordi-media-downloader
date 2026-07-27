import fs from "node:fs";
import http from "node:http";
import { readConfig } from "./config.js";
import { Telegram } from "./telegram.js";
import crypto from "node:crypto";
import { validateMediaUrl, inspectUrl, download, downloadGallery, cleanupFile, assertFileSize } from "./downloader.js";

const config = readConfig();
const telegram = new Telegram(config.token);
const pending = new Map();
const busyUsers = new Set();
let offset = 0;

const TERMS = "לשימוש אישי ולימודי בלבד. יש להוריד רק תוכן שבבעלותך או שקיבלת הרשאה מפורשת לשמור.";

function keyboard(id) {
  return {
    inline_keyboard: [[
      { text: "🎬 וידאו 720p", callback_data: `video:${id}` },
      { text: "🎵 MP3", callback_data: `audio:${id}` }
    ]]
  };
}

function platformKeyboard(platform, id) {
  if (platform === "Instagram") {
    return {
      inline_keyboard: [[
        { text: "🖼 הורד את כל המדיה", callback_data: `gallery:${id}` }
      ]]
    };
  }
  return keyboard(id);
}

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

async function handleMessage(message) {
  const userId = String(message.from?.id || "");
  if (userId !== config.allowedUserId) {
    console.warn(`ניסיון גישה נדחה עבור Telegram user ${userId || "unknown"}`);
    return;
  }
  const chatId = message.chat.id;
  const text = message.text?.trim() || "";
  if (text === "/start" || text === "/help") {
    await telegram.sendMessage(chatId,
      `שלום! שלח לי קישור מ־YouTube, Instagram, Facebook, X/Twitter, TikTok או Vimeo ואציג אפשרויות הורדה.\n\n${TERMS}`);
    return;
  }
  try {
    const { url, platform } = validateMediaUrl(text);
    const status = await telegram.sendMessage(chatId, "🔎 בודק את הקישור...");
    let info;
    try {
      info = await inspectUrl(url, config);
    } catch (error) {
      if (platform !== "Instagram") throw error;
      info = {
        title: "פוסט Instagram",
        channel: "Instagram",
        duration: 0,
        webpageUrl: url
      };
    }
    const selectionId = crypto.randomBytes(8).toString("hex");
    pending.set(selectionId, { url: info.webpageUrl, title: info.title, platform, createdAt: Date.now() });
    await telegram.call("editMessageText", {
      chat_id: chatId,
      message_id: status.message_id,
      text: `🌐 ${platform}\n🎞 ${info.title}\n👤 ${info.channel}\n⏱ ${formatDuration(info.duration)}\n\nבחר פורמט:`,
      reply_markup: platformKeyboard(platform, selectionId)
    });
  } catch (error) {
    await telegram.sendMessage(chatId, `❌ ${error.message}`);
  }
}

async function handleCallback(query) {
  const userId = String(query.from?.id || "");
  if (userId !== config.allowedUserId) return;
  const [kind, id] = (query.data || "").split(":");
  const item = pending.get(id);
  if (!item || Date.now() - item.createdAt > config.tempTtlMs) {
    await telegram.answerCallbackQuery(query.id, "הבחירה פגה. שלח את הקישור מחדש.");
    return;
  }
  if (busyUsers.has(userId)) {
    await telegram.answerCallbackQuery(query.id, "כבר מתבצעת הורדה. המתן לסיומה.");
    return;
  }
  await telegram.answerCallbackQuery(query.id, "ההורדה התחילה");
  busyUsers.add(userId);
  let filePath;
  try {
    if (kind === "gallery") {
      await telegram.sendMessage(query.message.chat.id, "🖼 מוריד את כל התמונות והסרטונים מהפוסט...");
      const files = await downloadGallery(item.url, config);
      for (let index = 0; index < files.length; index += 1) {
        filePath = files[index];
        await assertFileSize(filePath, config.maxBytes);
        await telegram.sendFile("sendDocument", query.message.chat.id, filePath, `${item.title} • ${index + 1}/${files.length}`);
      }
      return;
    }
    await telegram.sendMessage(query.message.chat.id, kind === "audio" ? "🎵 מכין MP3..." : "🎬 מוריד וממזג וידאו...");
    filePath = await download(item.url, kind, config);
    await assertFileSize(filePath, config.maxBytes);
    await telegram.sendFile(kind === "audio" ? "sendAudio" : "sendVideo", query.message.chat.id, filePath, item.title);
  } catch (error) {
    await telegram.sendMessage(query.message.chat.id, `❌ ${error.message}`);
  } finally {
    busyUsers.delete(userId);
    if (filePath) await cleanupFile(filePath).catch(console.error);
  }
}

async function poll() {
  console.log("הבוט פעיל וממתין להודעות...");
  while (true) {
    try {
      const updates = await telegram.call("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"]
      });
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) await handleMessage(update.message);
        if (update.callback_query) await handleCallback(update.callback_query);
      }
    } catch (error) {
      console.error(new Date().toISOString(), error.message);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

async function dispatchUpdate(update) {
  if (update.message) await handleMessage(update.message);
  if (update.callback_query) await handleCallback(update.callback_query);
}

async function startWebhook() {
  if (!config.webhookSecret) throw new Error("במצב webhook חסר WEBHOOK_SECRET");
  const safeSecret = crypto
    .createHash("sha256")
    .update(config.webhookSecret)
    .digest("hex");
  const webhookPath = `/telegram/${safeSecret}`;
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("Mordi Media Downloader is running");
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
        const update = JSON.parse(raw);
        void dispatchUpdate(update).catch(error => console.error("Webhook update:", error));
      } catch (error) {
        console.error("Webhook JSON:", error.message);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "0.0.0.0", resolve);
  });
  const target = `${config.webhookUrl.replace(/\/$/, "")}${webhookPath}`;
  await telegram.call("setWebhook", {
    url: target,
    secret_token: safeSecret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false
  });
  console.log(`Webhook פעיל על פורט ${config.port}`);
}

await fs.promises.mkdir(config.tempDir, { recursive: true });
if (config.webhookUrl) {
  await startWebhook();
} else {
  await telegram.call("deleteWebhook", { drop_pending_updates: false });
  poll();
}
