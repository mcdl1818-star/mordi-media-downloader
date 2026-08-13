#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { sanitizeSocialCookieFile } from "../src/social-cookies.js";

const DEFAULT_CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PLATFORMS = {
  Facebook: { url: "https://www.facebook.com/login/", filename: "facebook-cookies.txt", domain: /(^|\.)facebook\.com$/i },
  TikTok: { url: "https://www.tiktok.com/login", filename: "tiktok-cookies.txt", domain: /(^|\.)tiktok\.com$/i },
  X: { url: "https://x.com/i/flow/login", filename: "x-cookies.txt", domain: /(^|\.)(?:x|twitter)\.com$/i }
};

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function loadEnv(file) {
  const values = {};
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const separator = raw.indexOf("=");
    if (separator < 1 || raw.trimStart().startsWith("#")) continue;
    values[raw.slice(0, separator).trim()] = raw.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return fs.promises.readFile(file, "utf8");
    await wait(250);
  }
  throw new Error("Chrome debugging port did not start");
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
  }
  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("Could not connect to Chrome")), { once: true });
    });
    this.socket.addEventListener("message", event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error("Chrome rejected the request")) : pending.resolve(message.result);
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.socket.close(); }
}

function toNetscape(cookies) {
  return `${cookies.map(cookie => {
    const domain = String(cookie.domain || "");
    return `${cookie.httpOnly ? "#HttpOnly_" : ""}${domain}\t${domain.startsWith(".") ? "TRUE" : "FALSE"}\t${cookie.path || "/"}\t${cookie.secure ? "TRUE" : "FALSE"}\t${Math.max(0, Math.floor(cookie.expires || 0))}\t${cookie.name}\t${cookie.value}`;
  }).join("\n")}\n`;
}

async function main() {
  const platform = process.argv[2];
  const rule = PLATFORMS[platform];
  if (!rule) throw new Error("Usage: node tools/connect-social-with-local-chrome.mjs Facebook|TikTok|X");
  const env = loadEnv(path.resolve(".env"));
  if (!env.TELEGRAM_BOT_TOKEN || !env.ALLOWED_TELEGRAM_USER_ID) throw new Error("Missing monitor-bot Telegram settings");
  if (!fs.existsSync(DEFAULT_CHROME)) throw new Error("Google Chrome is not installed");
  const profile = await fs.promises.mkdtemp(path.join(os.tmpdir(), `mordi-${platform.toLowerCase()}-login-`));
  const processHandle = spawn(DEFAULT_CHROME, [
    "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-sync",
    "--disable-background-mode", "--new-window", rule.url
  ], { windowsHide: false, stdio: "ignore" });
  let client;
  try {
    const [portText] = (await waitForFile(path.join(profile, "DevToolsActivePort"), 20_000)).split(/\r?\n/);
    const version = await (await fetch(`http://127.0.0.1:${portText}/json/version`)).json();
    client = new CdpClient(version.webSocketDebuggerUrl);
    await client.connect();
    const deadline = Date.now() + 12 * 60_000;
    let netscape = "";
    while (Date.now() < deadline) {
      const result = await client.send("Storage.getCookies").catch(() => ({ cookies: [] }));
      const selected = (result.cookies || []).filter(cookie => rule.domain.test(String(cookie.domain || "").replace(/^\./, "")));
      try {
        netscape = sanitizeSocialCookieFile(toNetscape(selected), platform);
        break;
      } catch {}
      await wait(1_500);
    }
    if (!netscape) throw new Error(`${platform} login was not completed in time`);
    const form = new FormData();
    form.set("chat_id", env.ALLOWED_TELEGRAM_USER_ID);
    form.set("document", new Blob([netscape], { type: "text/plain" }), rule.filename);
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: "POST", body: form });
    const result = await response.json();
    if (!result.ok) throw new Error(`Telegram rejected the encrypted-import handoff: ${result.description}`);
    process.stdout.write(JSON.stringify({ ok: true, platform }));
  } finally {
    if (client) {
      await client.send("Browser.close").catch(() => {});
      client.close();
    } else processHandle.kill();
    await wait(1_000);
    if (processHandle.exitCode === null) processHandle.kill();
    await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {});
  }
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
