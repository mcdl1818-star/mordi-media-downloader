#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { normalizeInstagramCookies } from "../src/instagram-cookies.js";

const DEFAULT_CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) throw new Error("Invalid arguments");
    result[name.slice(2)] = value;
    index += 1;
  }
  return result;
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
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
      this.socket.addEventListener("error", () => reject(new Error("Could not connect to local Chrome")), { once: true });
    });
    this.socket.addEventListener("message", event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error("Chrome rejected the browser request"));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}, sessionId = "") {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function connectBrowser(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error("Chrome debugging endpoint is unavailable");
  const version = await response.json();
  const client = new CdpClient(version.webSocketDebuggerUrl);
  await client.connect();
  return client;
}

async function openInstagramLoginWithUsername(client, username) {
  const targets = await client.send("Target.getTargets");
  const page = (targets.targetInfos || []).find(target => target.type === "page");
  if (!page) throw new Error("Chrome did not create a login tab");
  const attached = await client.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  const pageSession = attached.sessionId;
  await client.send("Page.enable", {}, pageSession);
  const source = `(() => {
    const username = ${JSON.stringify(username)};
    const fill = () => {
      const input = document.querySelector('input[name="username"], input[autocomplete="username"]');
      if (!input) return;
      if (input.value !== username) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, username);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const password = document.querySelector('input[name="password"], input[type="password"]');
      if (password && document.activeElement !== password) password.focus();
    };
    new MutationObserver(fill).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(fill, 250);
    fill();
  })();`;
  await client.send("Page.addScriptToEvaluateOnNewDocument", { source }, pageSession);
  await client.send("Page.navigate", { url: "https://www.instagram.com/accounts/login/" }, pageSession);
}

async function waitForInstagramSession(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await client.send("Storage.getCookies");
      const instagramCookies = (result.cookies || []).filter(cookie => /(^|\.)instagram\.com$/i.test(String(cookie.domain || "").replace(/^\./, "")));
      if (instagramCookies.some(cookie => cookie.name === "sessionid" && String(cookie.value || "").length >= 20)) {
        return normalizeInstagramCookies(instagramCookies);
      }
    } catch {
      // Chrome may briefly replace its target during login or verification.
    }
    await wait(1_500);
  }
  throw new Error("Instagram login was not completed in time");
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args["status-file"]) {
    await fs.promises.rm(path.resolve(args["status-file"]), { force: true });
  }
  let connectUrlValue = args.url || "";
  if (args["url-file"]) {
    const urlFile = path.resolve(args["url-file"]);
    connectUrlValue = (await fs.promises.readFile(urlFile, "utf8")).trim();
    await fs.promises.rm(urlFile, { force: true });
  }
  const connectUrl = new URL(connectUrlValue);
  if (connectUrl.protocol !== "https:" || connectUrl.pathname !== "/connect/instagram") {
    throw new Error("A fresh one-time Instagram connection URL is required");
  }
  const signedToken = connectUrl.searchParams.get("token") || "";
  if (!signedToken) throw new Error("The Instagram connection URL has no token");
  const sessionEndpoint = `${connectUrl.origin}/connect/instagram/session`;
  const chrome = path.resolve(args.chrome || DEFAULT_CHROME);
  if (!fs.existsSync(chrome)) throw new Error("Google Chrome is not installed");

  const profile = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mordi-instagram-login-"));
  const processHandle = spawn(chrome, [
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-mode",
    "--new-window",
    "about:blank"
  ], { windowsHide: false, stdio: "ignore" });

  let client;
  try {
    const portFile = path.join(profile, "DevToolsActivePort");
    const [portText] = (await waitForFile(portFile, 20_000)).split(/\r?\n/);
    if (!/^\d+$/.test(portText)) throw new Error("Chrome returned an invalid debugging port");
    client = await connectBrowser(portText);
    await openInstagramLoginWithUsername(client, "vogelnati").catch(async () => {
      await client.send("Target.createTarget", { url: "https://www.instagram.com/accounts/login/" });
    });
    const cookies = await waitForInstagramSession(client, 12 * 60_000);
    const response = await fetch(sessionEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: signedToken, username: "vogelnati", cookies }),
      signal: AbortSignal.timeout(120_000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(`The cloud service rejected the session (${result.error || response.status})`);
    const status = { ok: true, mode: result.mode };
    if (args["status-file"]) {
      await fs.promises.writeFile(path.resolve(args["status-file"]), JSON.stringify(status), { mode: 0o600 });
    }
    process.stdout.write(JSON.stringify(status));
  } finally {
    if (client) {
      await client.send("Browser.close").catch(() => {});
      client.close();
    } else {
      processHandle.kill();
    }
    if (processHandle.exitCode === null) {
      await Promise.race([
        new Promise(resolve => processHandle.once("exit", resolve)),
        wait(5_000)
      ]).catch(() => {});
    }
    if (processHandle.exitCode === null) processHandle.kill();
    await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {});
  }
}

main().catch(error => {
  let statusFile = "";
  try { statusFile = parseArguments(process.argv.slice(2))["status-file"] || ""; } catch {}
  if (statusFile) {
    fs.writeFileSync(path.resolve(statusFile), JSON.stringify({ ok: false, error: error.message }), { mode: 0o600 });
  }
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
