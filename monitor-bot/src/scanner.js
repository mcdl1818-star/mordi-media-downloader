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
  if (platform === "YouTube" && item.id) return `https://www.youtube.com/watch?v=${item.id}`;
  const instagramCode = item.post_shortcode || item.shortcode;
  if (platform === "Instagram" && instagramCode) {
    return item.post_url || `https://www.instagram.com/${item.is_video || item.video_url ? "reel" : "p"}/${instagramCode}/`;
  }
  if (platform === "X" && (item.tweet_id || item.id)) {
    return `https://x.com/i/web/status/${item.tweet_id || item.id}`;
  }
  if (platform === "TikTok" && item.id && item.author?.unique_id) {
    return `https://www.tiktok.com/@${item.author.unique_id}/video/${item.id}`;
  }
  const candidate = item.post_url || item.webpage_url || item.url || item.original_url;
  if (typeof candidate === "string" && /^https:\/\//.test(candidate)) return candidate;
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
      timestamp: Number(item.timestamp || item.release_timestamp || item.date || 0),
      platform
    });
  }
  return [...new Map(output.map(item => [item.id, item])).values()];
}

function cookiesPathFor(platform, config) {
  const platformPath = config.platformCookies?.[platform];
  if (platformPath && fs.existsSync(platformPath)) return platformPath;
  if (config.cookiesPath && fs.existsSync(config.cookiesPath)) return config.cookiesPath;
  return "";
}

async function scanYtDlp(creator, config) {
  const args = [
    "--flat-playlist", "--playlist-end", String(config.maxItems),
    "--dump-single-json", "--ignore-errors", "--no-warnings"
  ];
  const cookiesPath = cookiesPathFor(creator.platform, config);
  if (cookiesPath) args.push("--cookies", cookiesPath);
  args.push("--", creator.url);
  const parsed = JSON.parse(await run(config.ytDlpPath, args));
  if (!parsed) return [];
  return normalizeItems(parsed.entries || [parsed], creator.platform);
}

function collectObjects(value, output = []) {
  if (!value || typeof value !== "object") return output;
  if (value.id || value.post_id || value.tweet_id || value.shortcode || value.post_shortcode) {
    output.push({
      ...value,
      id: value.id || value.post_id || value.tweet_id || value.shortcode || value.post_shortcode,
      webpage_url: value.post_url || value.url || value.webpage_url
    });
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") collectObjects(child, output);
  }
  return output;
}

function collectRedirectUrls(value, output = []) {
  if (!Array.isArray(value)) return output;
  if (value[0] === 6 && typeof value[1] === "string") output.push(value[1]);
  for (const child of value) {
    if (Array.isArray(child)) collectRedirectUrls(child, output);
  }
  return output;
}

async function scanGalleryUrl(url, creator, config, visited = new Set()) {
  if (visited.has(url) || visited.size >= 8) return [];
  visited.add(url);
  const args = ["--dump-json", "--range", `1-${config.maxItems}`];
  const cookiesPath = cookiesPathFor(creator.platform, config);
  if (cookiesPath) args.push("--cookies", cookiesPath);
  args.push("--", url);
  const raw = await run(config.galleryDlPath, args);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw.split(/\r?\n/).filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  }
  const direct = normalizeItems(collectObjects(parsed), creator.platform);
  if (direct.length) return direct;
  const results = [];
  for (const redirect of [...new Set(collectRedirectUrls(parsed))]) {
    results.push(...await scanGalleryUrl(redirect, creator, config, visited));
  }
  return [...new Map(results.map(item => [item.id, item])).values()];
}

async function scanGalleryDl(creator, config) {
  return scanGalleryUrl(creator.url, creator, config);
}

function netscapeCookieHeader(file) {
  if (!file || !fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf8").split(/\r?\n/)
    .filter(line => line && !line.startsWith("#"))
    .map(line => line.split("\t"))
    .filter(parts => parts.length >= 7)
    .map(parts => `${parts[5]}=${parts[6]}`)
    .join("; ");
}

function htmlCandidates(html, creator, maxItems) {
  const patterns = {
    Instagram: /(?:https?:\\?\/\\?\/(?:www\.)?instagram\.com)?\\?\/(reel|p)\\?\/([A-Za-z0-9_-]+)/g,
    Facebook: /(?:https?:\\?\/\\?\/(?:www\.)?facebook\.com)?\\?\/(?:reel|watch\/?\?v=|[^"'\\]+\/videos\/)(\d+)/g,
    TikTok: /(?:https?:\\?\/\\?\/(?:www\.)?tiktok\.com)?\\?\/@([^/"'\\]+)\\?\/video\\?\/(\d+)/g,
    X: /(?:https?:\\?\/\\?\/(?:www\.)?(?:x|twitter)\.com)?\\?\/([^/"'\\]+)\\?\/status\\?\/(\d+)/g
  };
  const regex = patterns[creator.platform];
  if (!regex) return [];
  const items = [];
  for (const match of html.matchAll(regex)) {
    let id;
    let url;
    if (creator.platform === "Instagram") {
      id = match[2];
      url = `https://www.instagram.com/${match[1]}/${id}/`;
    } else if (creator.platform === "Facebook") {
      id = match[1];
      url = `https://www.facebook.com/reel/${id}`;
    } else if (creator.platform === "TikTok") {
      id = match[2];
      url = `https://www.tiktok.com/@${match[1]}/video/${id}`;
    } else {
      id = match[2];
      url = `https://x.com/${match[1]}/status/${id}`;
    }
    items.push({ id: `${creator.platform}:${id}`, url, title: "פרסום חדש", timestamp: 0, platform: creator.platform });
  }
  return [...new Map(items.map(item => [item.id, item])).values()].slice(0, maxItems);
}

async function scanProfileHtml(creator, config) {
  const cookiesPath = cookiesPathFor(creator.platform, config);
  const base = creator.url.replace(/\/$/, "");
  const target = creator.platform === "Facebook" ? `${base}/reels/`
    : creator.platform === "X" ? `${base}/media`
      : creator.url;
  const response = await fetch(target, {
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
      "accept-language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
      cookie: netscapeCookieHeader(cookiesPath)
    }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return htmlCandidates(await response.text(), creator, config.maxItems);
}

export async function scanCreator(creator, config) {
  const needsSession = ["Instagram", "Facebook", "X"].includes(creator.platform);
  if (needsSession && !cookiesPathFor(creator.platform, config)) {
    try {
      const publicItems = await scanProfileHtml(creator, config);
      if (publicItems.length) return publicItems;
    } catch {
      // Authenticated extractors below are intentionally skipped without a session file.
    }
    throw new Error(`AUTH_REQUIRED:${creator.platform}`);
  }
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
  try {
    const items = await scanProfileHtml(creator, config);
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
  const cookiesPath = cookiesPathFor(item.platform, config);
  if (cookiesPath) args.push("--cookies", cookiesPath);
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
