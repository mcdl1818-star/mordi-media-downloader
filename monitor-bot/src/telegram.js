import fs from "node:fs";

export class Telegram {
  constructor(token) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async call(method, body = {}) {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!result.ok) throw new Error(`Telegram ${method}: ${result.description}`);
    return result.result;
  }

  sendMessage(chatId, text, extra = {}) {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: false,
      ...extra
    });
  }

  async sendVideo(chatId, filePath, caption) {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("caption", caption.slice(0, 1024));
    form.set("supports_streaming", "true");
    form.set("video", new Blob([await fs.promises.readFile(filePath)]), filePath.split(/[\\/]/).at(-1));
    const response = await fetch(`${this.baseUrl}/sendVideo`, { method: "POST", body: form });
    const result = await response.json();
    if (!result.ok) throw new Error(`Telegram sendVideo: ${result.description}`);
    return result.result;
  }

  async sendPhoto(chatId, filePath, caption) {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("caption", caption.slice(0, 1024));
    form.set("photo", new Blob([await fs.promises.readFile(filePath)]), filePath.split(/[\\/]/).at(-1));
    const response = await fetch(`${this.baseUrl}/sendPhoto`, { method: "POST", body: form });
    const result = await response.json();
    if (!result.ok) throw new Error(`Telegram sendPhoto: ${result.description}`);
    return result.result;
  }

  async sendDocument(chatId, filePath, caption) {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("caption", caption);
    form.set("disable_notification", "true");
    form.set("document", new Blob([await fs.promises.readFile(filePath)]), "monitor-state.json");
    const response = await fetch(`${this.baseUrl}/sendDocument`, { method: "POST", body: form });
    const result = await response.json();
    if (!result.ok) throw new Error(`Telegram sendDocument: ${result.description}`);
    return result.result;
  }

  async downloadFile(fileId, destination) {
    const file = await this.call("getFile", { file_id: fileId });
    const response = await fetch(`${this.baseUrl.replace("/bot", "/file/bot")}/${file.file_path}`);
    if (!response.ok) throw new Error("Telegram state download failed");
    await fs.promises.writeFile(destination, Buffer.from(await response.arrayBuffer()));
    return destination;
  }
}
