import fs from "node:fs";

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

  async sendFile(method, chatId, filePath, caption) {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("caption", caption);
    const bytes = await fs.promises.readFile(filePath);
    const fields = {
      sendAudio: "audio",
      sendVideo: "video",
      sendPhoto: "photo",
      sendDocument: "document"
    };
    const field = fields[method];
    if (!field) throw new Error(`שיטת שליחת קובץ לא נתמכת: ${method}`);
    form.set(field, new Blob([bytes]), filePath.split(/[\\/]/).at(-1));
    const response = await fetch(`${this.baseUrl}/${method}`, { method: "POST", body: form });
    const result = await response.json();
    if (!result.ok) throw new Error(`Telegram ${method}: ${result.description}`);
    return result.result;
  }
}
