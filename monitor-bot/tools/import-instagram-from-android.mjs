#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInstagramConnectToken } from "../src/instagram-connect.js";
import { normalizeInstagramCookies } from "../src/instagram-cookies.js";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(toolDirectory, "..");
const workspaceDirectory = path.resolve(projectDirectory, "..");
const defaultAdb = path.join(workspaceDirectory, ".tools", "android-platform-tools", "platform-tools", "adb.exe");

function loadEnv(file) {
  const result = {};
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    result[key] = value;
  }
  return result;
}

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key.startsWith("--")) throw new Error("Unknown argument");
    const value = values[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

function validateAddress(value, label) {
  const match = String(value || "").match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})$/);
  if (!match || match[1].split(".").some(part => Number(part) > 255) || Number(match[2]) > 65535) {
    throw new Error(`${label} must be an IPv4 address and port from the Pixel`);
  }
  return value;
}

function runAdb(adbPath, args, { input, allowFailure = false, timeout = 20_000 } = {}) {
  const result = spawnSync(adbPath, args, {
    encoding: "utf8",
    input,
    timeout,
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(`ADB command failed: ${args[0]}`);
  }
  return String(result.stdout || "").trim();
}

async function cdpRequest(webSocketUrl, method) {
  if (typeof WebSocket !== "function") throw new Error("This tool requires Node.js 22 or newer");
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Chrome did not answer in time"));
    }, 15_000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method })));
    socket.addEventListener("message", event => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.error) reject(new Error("Chrome refused the cookie request"));
      else resolve(message.result);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Could not connect to Chrome on the Pixel"));
    });
  });
}

async function readInstagramCookies(port) {
  const listResponse = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) });
  if (!listResponse.ok) throw new Error("Chrome debugging endpoint is unavailable");
  const targets = await listResponse.json();
  const instagramTarget = targets.find(target => {
    try {
      return /(^|\.)instagram\.com$/i.test(new URL(target.url).hostname);
    } catch {
      return false;
    }
  });
  if (!instagramTarget?.webSocketDebuggerUrl) {
    throw new Error("Open instagram.com in Chrome on the Pixel and sign in first");
  }
  let result;
  try {
    result = await cdpRequest(instagramTarget.webSocketDebuggerUrl, "Network.getAllCookies");
  } catch {
    const versionResponse = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(10_000) });
    const version = await versionResponse.json();
    if (!version.webSocketDebuggerUrl) throw new Error("Chrome browser target is unavailable");
    result = await cdpRequest(version.webSocketDebuggerUrl, "Storage.getCookies");
  }
  return normalizeInstagramCookies(result?.cookies);
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const adbPath = path.resolve(args.adb || defaultAdb);
  const envPath = path.resolve(args.env || path.join(projectDirectory, ".env"));
  if (!fs.existsSync(adbPath)) throw new Error("Android Platform Tools are not installed");
  if (!fs.existsSync(envPath)) throw new Error("The monitor .env file is missing");
  const env = loadEnv(envPath);
  const webhookUrl = String(env.WEBHOOK_URL || "").replace(/\/$/, "");
  const webhookSecret = String(env.WEBHOOK_SECRET || "");
  const allowedUserId = String(env.ALLOWED_TELEGRAM_USER_ID || "");
  const username = String(args.username || env.INSTAGRAM_LOGIN_USERNAME || "vogelnati").replace(/^@/, "");
  if (!/^[A-Za-z0-9._]{1,30}$/.test(username)) throw new Error("The Instagram username is invalid");
  let sessionEndpoint;
  let signedToken;
  if (args.url) {
    const connectUrl = new URL(args.url);
    if (connectUrl.protocol !== "https:" || connectUrl.pathname !== "/connect/instagram") {
      throw new Error("The one-time Instagram connection URL is invalid");
    }
    signedToken = connectUrl.searchParams.get("token") || "";
    sessionEndpoint = `${connectUrl.origin}/connect/instagram/session`;
  } else {
    if (!/^https:\/\//.test(webhookUrl) || !webhookSecret || !/^\d+$/.test(allowedUserId)) {
      throw new Error("Use --url with the fresh /instagram button from Telegram");
    }
    signedToken = createInstagramConnectToken(webhookSecret, allowedUserId, Date.now(), 20 * 60_000, username);
    sessionEndpoint = `${webhookUrl}/connect/instagram/session`;
  }

  if (args.pair || args.code) {
    const pairAddress = validateAddress(args.pair, "Pairing address");
    if (!/^\d{6}$/.test(String(args.code || ""))) throw new Error("The Pixel pairing code must contain six digits");
    runAdb(adbPath, ["pair", pairAddress], { input: `${args.code}\n`, timeout: 30_000 });
  }
  if (args.connect) runAdb(adbPath, ["connect", validateAddress(args.connect, "Connection address")]);

  const devices = runAdb(adbPath, ["devices"])
    .split(/\r?\n/)
    .map(line => line.match(/^(\S+)\s+device$/)?.[1])
    .filter(Boolean);
  const serial = args.serial || devices[0];
  if (!serial || devices.length > 1 && !args.serial) throw new Error("No single authorized Pixel was found");

  let localPort = "";
  let imported = false;
  let cookies;
  try {
    localPort = runAdb(adbPath, ["-s", serial, "forward", "tcp:0", "localabstract:chrome_devtools_remote"]);
    if (!/^\d+$/.test(localPort)) throw new Error("Could not open the private Chrome debugging tunnel");
    cookies = await readInstagramCookies(localPort);
    const response = await fetch(sessionEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: signedToken, username, cookies }),
      signal: AbortSignal.timeout(120_000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(`The server rejected the session (${result.error || response.status})`);
    imported = true;
    process.stdout.write(JSON.stringify({ ok: true, mode: result.mode, cookieCount: cookies.length }));
  } finally {
    cookies = undefined;
    if (localPort) runAdb(adbPath, ["forward", "--remove", `tcp:${localPort}`], { allowFailure: true });
    if (imported) runAdb(adbPath, ["-s", serial, "shell", "settings", "put", "global", "adb_wifi_enabled", "0"], { allowFailure: true });
    runAdb(adbPath, ["disconnect", serial], { allowFailure: true });
  }
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
