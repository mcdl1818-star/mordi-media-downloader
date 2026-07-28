import fs from "node:fs";
import http from "node:http";
import { readConfig } from "./config.js";
import { Telegram } from "./telegram.js";
import crypto from "node:crypto";
import { extractSupportedMediaUrl, inspectUrl, download, downloadGallery, cleanupFile, assertFileSize, isYouTubeBlockedError } from "./downloader.js";
import { downloadSelection, formatKeyboard } from "./formats.js";
import { dispatchYouTubeWorker } from "./github-worker.js";

const config = readConfig();
const telegram = new Telegram(config.token);
const pending = new Map();
const downloadQueue = [];
let queueRunning = false;
let currentJob = null;
let lastYouTubeJobFinishedAt = 0;
let youtubeBlockedUntil = 0;
let offset = 0;

const TERMS = "לשימוש אישי ולימודי בלבד. יש להוריד רק תוכן שבבעלותך או שקיבלת הרשאה מפורשת לשמור.";

function keyboard(id) {
  return formatKeyboard(id);
}

function platformKeyboard(platform, id, url, mediaKind = "video") {
  if (mediaKind !== "video" || (platform === "Instagram" && !new URL(url).pathname.startsWith("/reel/"))) {
    return {
      inline_keyboard: [[
        { text: "🖼 הורד את כל המדיה", callback_data: `gallery:${id}` }
      ]]
    };
  }
  return keyboard(id);
}

function formatDuration(seconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function userFacingError(error) {
  const message = String(error?.message || "");
  if (isYouTubeBlockedError(error)) {
    return "YouTube חסם זמנית את כתובת השרת. עצרתי ניסיונות נוספים ל-30 דקות כדי לא להחמיר את החסימה; שאר האתרים ממשיכים לעבוד.";
  }
  if (/login|sign.?in|cookies|authentication/i.test(message)) {
    return "האתר דורש התחברות או חסם זמנית את ההורדה. נסה שוב מאוחר יותר או שלח קישור ציבורי אחר.";
  }
  if (/private|not available|unavailable|deleted|restricted/i.test(message)) {
    return "התוכן פרטי, הוסר או אינו זמין לצפייה ציבורית.";
  }
  if (/unsupported|no video formats|not a valid URL/i.test(message)) {
    return "לא נמצאה מדיה שניתן להוריד מהקישור הזה.";
  }
  if (/timed? out|ארכה יותר מדי/i.test(message)) {
    return "האתר לא הגיב בזמן. נסה שוב בעוד דקה.";
  }
  return message.length <= 220 ? message : "ההורדה נכשלה בגלל מגבלה זמנית של האתר. נסה שוב מאוחר יותר.";
}

function progressBar(percent) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round(value / 5);
  return `${"█".repeat(filled)}${"░".repeat(20 - filled)} ${value}%`;
}

function previewText(value, maxCharacters = 900) {
  const characters = Array.from(String(value || "").trim());
  if (characters.length <= maxCharacters) return characters.join("");
  return `${characters.slice(0, maxCharacters - 1).join("").trimEnd()}…`;
}

function queuePositionText(position) {
  return position === 1
    ? "ההורדה תתחיל מיד בסיום הסרטון הנוכחי."
    : `מיקום בתור: ${position}`;
}

async function editStatus(job, text) {
  if (!job.statusMessageId) return;
  try {
    await telegram.call("editMessageText", {
      chat_id: job.chatId,
      message_id: job.statusMessageId,
      text
    });
  } catch (error) {
    if (!/message is not modified/i.test(String(error?.message || ""))) {
      console.error("Status update:", error.message);
    }
  }
}

function replyExtra(messageId) {
  const value = Number(messageId);
  return Number.isInteger(value) && value > 0
    ? { reply_parameters: { message_id: value, allow_sending_without_reply: true } }
    : {};
}

function enqueueDownload(job) {
  const queued = Boolean(currentJob || queueRunning || downloadQueue.length);
  downloadQueue.push(job);
  const position = queued ? downloadQueue.length : 0;
  void processDownloadQueue();
  return { position, queued };
}

async function waitForYouTubePacing(job) {
  if (job.platform !== "YouTube" || !lastYouTubeJobFinishedAt) return;
  const remaining = 10_000 - (Date.now() - lastYouTubeJobFinishedAt);
  if (remaining <= 0) return;
  await editStatus(job, `🛡️ ממתין ${Math.ceil(remaining / 1000)} שניות בין בקשות YouTube כדי להגן על החשבון...`);
  await new Promise(resolve => setTimeout(resolve, remaining));
}

async function processDownloadJob(job) {
  let filePath;
  const startedAt = Date.now();
  let lastProgressAt = 0;
  let lastProgress = -1;
  let statusChain = Promise.resolve();
  const updateProgress = ({ percent, speed, eta }) => {
    const now = Date.now();
    if (percent < 100 && now - lastProgressAt < 3000 && percent - lastProgress < 2) return;
    lastProgressAt = now;
    lastProgress = percent;
    const elapsed = Math.max(1, Math.round((now - startedAt) / 1000));
    const details = [
      speed && speed !== "N/A" ? `מהירות: ${speed}` : "",
      eta && eta !== "N/A" ? `נותרו: ${eta}` : "",
      `זמן: ${elapsed} שנ׳`
    ].filter(Boolean).join(" • ");
    statusChain = statusChain.then(() => editStatus(
      job,
      `${job.kind === "audio" ? `🎵 מכין ${job.label || "MP3"}` : `🎬 מוריד וידאו ${job.label || "720p"}`}\n${progressBar(percent)}\n${details}`
    ));
  };

  try {
    await waitForYouTubePacing(job);
    if (job.kind === "gallery") {
      await editStatus(job, "🖼 מאתר ומוריד את כל המדיה מהקישור...");
      const files = await downloadGallery(job.url, config);
      for (let index = 0; index < files.length; index += 1) {
        filePath = files[index];
        await editStatus(job, `📤 שולח קובץ ${index + 1}/${files.length}\n${progressBar(((index + 1) / files.length) * 100)}`);
        await assertFileSize(filePath, config.maxBytes);
        await telegram.sendFile(
          "sendDocument",
          job.chatId,
          filePath,
          `${job.title} • ${index + 1}/${files.length}`,
          { replyToMessageId: job.sourceMessageId }
        );
      }
      await editStatus(job, `✅ הושלם: ${files.length} קובצי מדיה נשלחו.`);
      return;
    }

    await editStatus(job, `${job.kind === "audio" ? `🎵 מכין ${job.label || "MP3"}` : `🎬 מתחיל הורדת וידאו ${job.label || "720p"}`}\n${progressBar(0)}`);
    filePath = await download(job.url, job.kind, config, updateProgress, {
      maxHeight: job.height,
      audioFormat: job.audioFormat,
      audioBitrate: job.audioBitrate,
      mute: job.mute,
      subtitles: job.subtitles
    });
    await statusChain;
    await editStatus(job, `📤 ההורדה הסתיימה, שולח לטלגרם...\n${progressBar(100)}`);
    await assertFileSize(filePath, config.maxBytes);
    await telegram.sendFile(
      job.kind === "audio" ? "sendAudio" : "sendVideo",
      job.chatId,
      filePath,
      job.title,
      { replyToMessageId: job.sourceMessageId }
    );
    await editStatus(job, `✅ הושלם ונשלח\n${progressBar(100)}`);
  } catch (error) {
    // Render's YouTube failures are not always reported as an explicit bot/IP
    // block (format, cookie and player errors can be the same restriction).
    // The authenticated GitHub worker is the reliable final fallback for every
    // YouTube download failure.
    if (job.platform === "YouTube" && config.githubActionsToken) {
      try {
        await dispatchYouTubeWorker(job, config);
        await editStatus(job, "☁️ Render נחסם. העברתי את ההורדה לשרת YouTube חלופי של GitHub; הקובץ יישלח כאן אוטומטית בסיום.");
        return;
      } catch (workerError) {
        console.error("GitHub YouTube worker:", workerError.message);
      }
    }
    await editStatus(job, `❌ ${userFacingError(error)}`);
  } finally {
    if (job.platform === "YouTube") lastYouTubeJobFinishedAt = Date.now();
    if (filePath) await cleanupFile(filePath).catch(console.error);
  }
}

async function processDownloadQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (downloadQueue.length) {
      currentJob = downloadQueue.shift();
      await processDownloadJob(currentJob);
      currentJob = null;
      for (let index = 0; index < downloadQueue.length; index += 1) {
        await editStatus(
          downloadQueue[index],
          `⏳ סרטון אחר נמצא באמצע הורדה.\n${queuePositionText(index + 1)}`
        );
      }
    }
  } finally {
    currentJob = null;
    queueRunning = false;
  }
}

function removeExpiredSelections() {
  const now = Date.now();
  for (const [id, item] of pending) {
    if (now - item.createdAt > config.tempTtlMs) pending.delete(id);
  }
}

async function handleMessage(message) {
  const userId = String(message.from?.id || "");
  if (userId !== config.allowedUserId) {
    console.warn(`ניסיון גישה נדחה עבור Telegram user ${userId || "unknown"}`);
    return;
  }
  const chatId = message.chat.id;
  const text = message.text?.trim() || "";
  let inspectionStatus;
  removeExpiredSelections();
  if (text === "/deletecookies") {
    await fs.promises.rm(config.youtubeCookiesPath, { force: true });
    await telegram.sendMessage(chatId, "✅ קובץ ה-Cookies של YouTube נמחק מהשרת.");
    return;
  }
  if (message.document) {
    if (message.document.file_name?.toLowerCase() !== "cookies.txt") {
      await telegram.sendMessage(chatId, "❌ יש לשלוח קובץ בשם cookies.txt בלבד.");
      return;
    }
    try {
      await telegram.downloadFile(message.document.file_id, config.youtubeCookiesPath);
      console.log(`YouTube cookies installed from Telegram file ${message.document.file_id}`);
      await telegram.sendMessage(chatId, "✅ חשבון YouTube חובר. שלח עכשיו קישור YouTube לבדיקה.\nלמחיקה: /deletecookies");
    } catch (error) {
      await telegram.sendMessage(chatId, `❌ ${userFacingError(error)}`);
    }
    return;
  }
  if (text === "/start" || text === "/help") {
    await telegram.sendMessage(chatId,
      `שלום! שלח לי קישור HTTPS ציבורי מכל אתר. הבוט יחפש וידאו, אודיו ותמונות באמצעות כמה מנועי חילוץ, ויציג את אפשרויות ההורדה שמצא.\n\n${TERMS}`);
    return;
  }
  try {
    const { url, platform } = extractSupportedMediaUrl(text);
    if (platform === "YouTube" && Date.now() < youtubeBlockedUntil && !config.githubActionsToken) {
      const minutes = Math.max(1, Math.ceil((youtubeBlockedUntil - Date.now()) / 60_000));
      await telegram.sendMessage(
        chatId,
        `🛡️ YouTube נמצא בהשהיית הגנה לעוד כ-${minutes} דקות בגלל חסימת anti-bot של כתובת השרת. שאר האתרים זמינים כרגיל.`,
        replyExtra(message.message_id)
      );
      return;
    }
    inspectionStatus = await telegram.sendMessage(
      chatId,
      "🔎 בודק את הקישור...",
      replyExtra(message.message_id)
    );
    let info;
    try {
      info = await inspectUrl(url, config);
    } catch (error) {
      if (platform === "YouTube" && isYouTubeBlockedError(error)) {
        youtubeBlockedUntil = Date.now() + 30 * 60_000;
        if (config.githubActionsToken) {
          info = {
            title: "YouTube — הורדה דרך שרת חלופי",
            channel: "YouTube",
            duration: 0,
            webpageUrl: url,
            mediaKind: "video",
            mediaCount: 1
          };
        }
      }
      if (!info) {
        if (platform !== "Instagram") throw error;
        info = {
          title: "פוסט Instagram",
          channel: "Instagram",
          duration: 0,
          webpageUrl: url
        };
      }
    }
    const selectionId = crypto.randomBytes(8).toString("hex");
    pending.set(selectionId, {
      url: info.webpageUrl,
      title: info.title,
      platform,
      mediaKind: info.mediaKind || "video",
      sourceMessageId: message.message_id,
      createdAt: Date.now()
    });
    await telegram.call("editMessageText", {
      chat_id: chatId,
      message_id: inspectionStatus.message_id,
      text: `🌐 ${platform}\n🎞 ${previewText(info.title)}\n👤 ${previewText(info.channel, 180)}\n${info.mediaCount > 1 ? `🗂 נמצאו עד ${info.mediaCount} פריטי מדיה\n` : ""}⏱ ${formatDuration(info.duration)}\n\nבחר פורמט:`,
      reply_markup: platformKeyboard(platform, selectionId, url, info.mediaKind)
    });
  } catch (error) {
    console.error("Link inspection failed:", String(error?.message || error).slice(0, 1200));
    const errorText = `❌ ${userFacingError(error)}`;
    if (inspectionStatus?.message_id) {
      await telegram.call("editMessageText", {
        chat_id: chatId,
        message_id: inspectionStatus.message_id,
        text: errorText
      });
    } else {
      await telegram.sendMessage(chatId, errorText, replyExtra(message.message_id));
    }
  }
}

async function handleCallback(query) {
  const userId = String(query.from?.id || "");
  if (userId !== config.allowedUserId) return;
  const [kind, id] = (query.data || "").split(":");
  const selection = downloadSelection(kind);
  const item = pending.get(id);
  if (!selection || !item || Date.now() - item.createdAt > config.tempTtlMs) {
    await telegram.answerCallbackQuery(query.id, "הבחירה פגה. שלח את הקישור מחדש.");
    return;
  }
  pending.delete(id);
  const status = await telegram.sendMessage(
    query.message.chat.id,
    queueRunning || downloadQueue.length
      ? "⏳ סרטון אחר נמצא באמצע הורדה. הבקשה נשמרת בתור..."
      : "⏳ מכין את ההורדה...",
    replyExtra(item.sourceMessageId)
  );
  const queued = enqueueDownload({
    ...item,
    ...selection,
    chatId: query.message.chat.id,
    statusMessageId: status.message_id
  });
  await telegram.answerCallbackQuery(
    query.id,
    queued.queued ? `נשמר בתור — מיקום ${queued.position}` : "ההורדה התחילה"
  );
  if (queued.queued) {
    await editStatus(
      { chatId: query.message.chat.id, statusMessageId: status.message_id },
      `⏳ סרטון אחר נמצא באמצע הורדה.\n${queuePositionText(queued.position)}`
    );
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
      response.end(`Mordi Media Downloader is running\nversion=${process.env.RENDER_GIT_COMMIT || "development"}`);
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
if (config.youtubeCookieFileId && !fs.existsSync(config.youtubeCookiesPath)) {
  try {
    await telegram.downloadFile(config.youtubeCookieFileId, config.youtubeCookiesPath);
    console.log("YouTube cookies restored from Telegram storage");
  } catch (error) {
    console.error("YouTube cookie restore:", error.message);
  }
}
if (config.webhookUrl) {
  await startWebhook();
} else {
  await telegram.call("deleteWebhook", { drop_pending_updates: false });
  poll();
}
