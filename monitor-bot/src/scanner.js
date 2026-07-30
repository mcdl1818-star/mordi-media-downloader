import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const PLATFORM_RULES = [
  ["YouTube", /(^|\.)youtube\.com$/],
  ["Instagram", /(^|\.)instagram\.com$/],
  ["Facebook", /(^|\.)facebook\.com$/],
  ["TikTok", /(^|\.)tiktok\.com$/],
  ["X", /(^|\.)x\.com$|(^|\.)twitter\.com$/]
];

export function validateCreatorUrl(input) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    throw new Error("יש לשלוח קישור מלא לפרופיל או לערוץ.");
  }
  const match = PLATFORM_RULES.find(([, rule]) => rule.test(url.hostname.toLowerCase()));
  if (url.protocol !== "https:" || !match) throw new Error("הקישור אינו מפלטפורמה נתמכת.");
  if (/\/(watch|reel|p|video|status)\b/i.test(url.pathname)) {
    throw new Error("זה נראה כמו קישור לפרסום בודד. יש לשלוח קישור לפרופיל/ערוץ.");
  }
  url.hash = "";
  return { url: url.toString(), platform: match[0] };
}

function run(command, args, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} לא סיים בזמן`));
    }, timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.once("error", reject);
    child.once("close", code => {
      clearTimeout(timer);
      code === 0 || stdout.trim() ? resolve(stdout) : reject(new Error(stderr.trim() || `${command} נכשל`));
    });
  });
}

function absoluteMediaUrl(item, platform) {
  const candidate = item.webpage_url || item.url || item.original_url;
  if (typeof candidate === "string" && /^https:\/\//.test(candidate)) return candidate;
  if (platform === "YouTube" && item.id) return `https://www.youtube.com/watch?v=${item.id}`;
  return "";
}

function normalizeItems(entries, platform) {
  const output = [];
  for (const item of entries || []) {
    if (!item || typeof item !== "object") continue;
    const url = absoluteMediaUrl(item, platform);
    const id = String(item.id || item.display_id || url || "");
    if (!id || !url) continue;
    output.push({
      id: `${platform}:${id}`,
      url,
      title: String(item.title || item.description || "פרסום חדש").slice(0, 300),
      timestamp: Number(item.timestamp || item.release_timestamp || 0)
    });
  }
  return [...new Map(output.map(item => [item.id, item])).values()];
}

async function scanYtDlp(creator, config) {
  const args = [
    "--flat-playlist", "--playlist-end", String(config.maxItems),
    "--dump-single-json", "--ignore-errors", "--no-warnings"
  ];
  if (config.cookiesPath && fs.existsSync(config.cookiesPath)) args.push("--cookies", config.cookiesPath);
  args.push("--", creator.url);
  const parsed = JSON.parse(await run(config.ytDlpPath, args));
  return normalizeItems(parsed.entries || [parsed], creator.platform);
}

function collectObjects(value, output = []) {
  if (!value || typeof value !== "object") return output;
  if (value.id || value.post_id || value.tweet_id || value.shortcode) {
    output.push({
      ...value,
      id: value.id || value.post_id || value.tweet_id || value.shortcode,
      webpage_url: value.post_url || value.url || value.webpage_url
    });
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") collectObjects(child, output);
  }
  return output;
}

async function scanGalleryDl(creator, config) {
  const args = ["--dump-json", "--range", `1-${config.maxItems}`];
  if (config.cookiesPath && fs.existsSync(config.cookiesPath)) args.push("--cookies", config.cookiesPath);
  args.push("--", creator.url);
  const raw = await run(config.galleryDlPath, args);
  const objects = raw.split(/\r?\n/).filter(Boolean).flatMap(line => {
    try { return collectObjects(JSON.parse(line)); } catch { return []; }
  });
  return normalizeItems(objects, creator.platform);
}

export async function scanCreator(creator, config) {
  let firstError;
  try {
    const items = await scanYtDlp(creator, config);
    if (items.length) return items;
  } catch (error) {
    firstError = error;
  }
  try {
    const items = await scanGalleryDl(creator, config);
    if (items.length) return items;
  } catch (error) {
    firstError ||= error;
  }
  throw firstError || new Error("לא נמצאו פרסומים ציבוריים בפרופיל.");
}

export async function downloadVideo(item, config) {
  await fs.promises.mkdir(config.tempDir, { recursive: true });
  const directory = path.join(config.tempDir, crypto.randomUUID());
  await fs.promises.mkdir(directory);
  const output = path.join(directory, "%(id)s.%(ext)s");
  const args = [
    "--no-playlist",
    "-f", "b[ext=mp4][height<=720]/b[height<=720]/b",
    "-o", output
  ];
  if (config.cookiesPath && fs.existsSync(config.cookiesPath)) args.push("--cookies", config.cookiesPath);
  args.push("--", item.url);
  await run(config.ytDlpPath, args, 10 * 60_000);
  const files = (await fs.promises.readdir(directory))
    .filter(name => !/\.(part|ytdl)$/.test(name))
    .map(name => path.join(directory, name));
  if (!files.length) throw new Error("הקובץ לא הורד");
  return files[0];
}

export async function cleanupVideo(file) {
  await fs.promises.rm(path.dirname(file), { recursive: true, force: true });
}
