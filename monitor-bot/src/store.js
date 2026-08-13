import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const STATE_CAPTION = "🔒 קובץ מצב פנימי של בוט המעקב — אין למחוק או להסיר הצמדה";

export class Store {
  constructor(directory, telegram, chatId) {
    this.directory = directory;
    this.telegram = telegram;
    this.chatId = chatId;
    this.localFile = path.join(directory, "subscriptions.json");
    this.state = { version: 3, paused: false, subscriptions: [], auth: {} };
    this.pinnedMessageId = null;
    this.saveQueue = Promise.resolve();
  }

  async load() {
    await fs.promises.mkdir(this.directory, { recursive: true });
    try {
      const chat = await this.telegram.call("getChat", { chat_id: this.chatId });
      const pinned = chat.pinned_message;
      if (pinned?.caption === STATE_CAPTION && pinned.document?.file_id) {
        await this.telegram.downloadFile(pinned.document.file_id, this.localFile);
        this.state = JSON.parse(await fs.promises.readFile(this.localFile, "utf8"));
        this.state.auth ||= {};
        this.pinnedMessageId = pinned.message_id;
        return;
      }
    } catch (error) {
      console.warn("Cloud state load:", error.message);
    }
    try {
      this.state = JSON.parse(await fs.promises.readFile(this.localFile, "utf8"));
      this.state.auth ||= {};
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async save() {
    const snapshot = JSON.stringify(this.state, null, 2);
    const operation = this.saveQueue.then(async () => {
      const temporary = `${this.localFile}.${crypto.randomUUID()}.tmp`;
      await fs.promises.writeFile(temporary, snapshot, "utf8");
      await fs.promises.rename(temporary, this.localFile);
      const sent = await this.telegram.sendDocument(this.chatId, this.localFile, STATE_CAPTION);
      await this.telegram.call("pinChatMessage", {
        chat_id: this.chatId,
        message_id: sent.message_id,
        disable_notification: true
      });
      if (this.pinnedMessageId && this.pinnedMessageId !== sent.message_id) {
        await this.telegram.call("deleteMessage", {
          chat_id: this.chatId,
          message_id: this.pinnedMessageId
        }).catch(() => {});
      }
      this.pinnedMessageId = sent.message_id;
    });
    this.saveQueue = operation.catch(() => {});
    return operation;
  }
}
