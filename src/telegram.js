import fs from "node:fs";

const TELEGRAM_CAPTION_LIMIT = 1024;

export function fitTelegramCaption(caption, limit = TELEGRAM_CAPTION_LIMIT) {
  const text = String(caption || "").trim();
  const characters = Array.from(text);
  if (characters.length <= limit) return text;
  return `${characters.slice(0, Math.max(0, limit - 1)).join("").trimEnd()}…`;
}

export class Telegram {
  constructor(token) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async call(method, body = {}, signal) {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal
    });
    const result = await response.json();
    if (!result.ok) throw new Error(`Telegram ${method}: ${result.description}`);
    return result.result;
  }

  sendMessage(chatId, text, extra = {}) {
    return this.call("sendMessage", { chat_id: chatId, text, ...extra });
  }

  answerCallbackQuery(id, text) {
    return this.call("answerCallbackQuery", { callback_query_id: id, text });
  }

  async downloadFile(fileId, destination) {
    const file = await this.call("getFile", { file_id: fileId });
    const response = await fetch(`${this.baseUrl.replace("/bot", "/file/bot")}/${file.file_path}`);
    if (!response.ok) throw new Error("Telegram לא הצליח להוריד את קובץ ה-Cookies.");
    await fs.promises.writeFile(destination, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
    await fs.promises.chmod(destination, 0o600);
    return destination;
  }

  async sendFile(method, chatId, filePath, caption) {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("caption", fitTelegramCaption(caption));
    const fields = {
      sendAudio: "audio",
      sendVideo: "video",
      sendPhoto: "photo",
      sendDocument: "document"
    };
    const field = fields[method];
    if (!field) throw new Error(`שיטת שליחת קובץ לא נתמכת: ${method}`);
    const file = await fs.openAsBlob(filePath);
    form.set(field, file, filePath.split(/[\\/]/).at(-1));
    const response = await fetch(`${this.baseUrl}/${method}`, { method: "POST", body: form });
    const result = await response.json();
    if (!result.ok) throw new Error(`Telegram ${method}: ${result.description}`);
    return result.result;
  }
}
