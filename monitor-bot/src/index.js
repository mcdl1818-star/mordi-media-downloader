import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import { readConfig } from "./config.js";
import { Telegram } from "./telegram.js";
import { Store } from "./store.js";
import { validateCreatorUrl, scanCreator, downloadVideo, cleanupVideo } from "./scanner.js";

const config = readConfig();
const telegram = new Telegram(config.token);
const store = new Store(config.dataDir, telegram, config.allowedUserId);
await store.load();
let offset = 0;
let scanRunning = false;

const help = `שלח קישור לפרופיל או לערוץ כדי להתחיל לעקוב.

/list — רשימת המעקבים
/remove מספר — הסרת מעקב
/check — בדיקה מיידית
/pause — השהיית כל המעקבים
/resume — חידוש המעקבים

בעת הוספה נשמר המצב הנוכחי, ולכן לא יישלח תוכן ישן.`;

async function deliver(item, subscription, { historical = false } = {}) {
  const caption = historical
    ? `👋 סרטון קודם לזיהוי אצל ${subscription.label}\n${item.title}\n${item.url}`
    : `🎬 פרסום חדש אצל ${subscription.label}\n${item.title}\n${item.url}`;
  if (config.sendMode === "video") {
    let file;
    try {
      file = await downloadVideo(item, config);
      if ((await fs.promises.stat(file)).size > config.maxBytes) throw new Error("הקובץ גדול ממגבלת Telegram");
      await telegram.sendVideo(config.allowedUserId, file, caption);
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
        subscription.lastError = String(error.message).slice(0, 300);
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
    await telegram.call("editMessageText", {
      chat_id: chatId,
      message_id: status.message_id,
      text: `❌ לא הצלחתי לקרוא את הפרופיל: ${String(error.message).slice(0, 250)}`
    });
  }
}

async function handleMessage(message) {
  if (String(message.from?.id || "") !== config.allowedUserId) return;
  const chatId = message.chat.id;
  const text = message.text?.trim() || "";
  if (text === "/start" || text === "/help") return telegram.sendMessage(chatId, help);
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

async function startWebhook() {
  if (!config.webhookSecret) throw new Error("חסר WEBHOOK_SECRET במצב ענן");
  const safeSecret = crypto.createHash("sha256").update(config.webhookSecret).digest("hex");
  const webhookPath = `/telegram/${safeSecret}`;
  const server = http.createServer((request, response) => {
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
  console.log(`Creator monitor webhook active on port ${config.port}`);
}

async function poll() {
  await telegram.call("deleteWebhook", { drop_pending_updates: false });
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
