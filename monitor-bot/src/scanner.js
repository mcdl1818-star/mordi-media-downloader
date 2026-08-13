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

const EXTRACTOR_ARGS = [
  "--js-runtimes", "node",
  "--extractor-args", "twitter:api=syndication"
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
    if (item.type === "story" || item.expires) {
      const username = item.username || item.user?.username || item.owner?.username;
      const mediaId = item.media_id || item.id || item.post_id;
      if (username && mediaId) return `https://www.instagram.com/stories/${username}/${mediaId}/`;
    }
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

function itemTimestamp(item) {
  const value = item.timestamp || item.release_timestamp || item.post_date || item.date || 0;
  if (typeof value === "number") return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

export function normalizeItems(entries, platform) {
  const output = [];
  for (const item of entries || []) {
    if (!item || typeof item !== "object") continue;
    const url = absoluteMediaUrl(item, platform);
    const id = String(item.media_id || item.id || item.display_id || item.post_id || item.shortcode || url || "");
    if (!id || !url) continue;
    const directMediaUrl = item.video_url || item.display_url;
    output.push({
      id: `${platform}:${id}`,
      url,
      title: String(item.title || item.description || (item.type === "story" || item.expires ? "סטורי חדש" : "פרסום חדש")).slice(0, 300),
      timestamp: itemTimestamp(item),
      platform,
      ...(typeof directMediaUrl === "string" && /^https:\/\//.test(directMediaUrl) ? {
        directMediaUrl,
        mediaKind: item.video_url ? "video" : "photo"
      } : {})
    });
  }
  return [...new Map(output.map(item => [item.id, item])).values()];
}

function decodeXml(value = "") {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

export function parseYouTubeFeed(xml, maxItems = 15) {
  const items = [];
  for (const entry of String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const body = entry[1];
    const id = body.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1]?.trim();
    if (!id) continue;
    const title = decodeXml(body.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() || "פרסום חדש");
    const published = body.match(/<published>([^<]+)<\/published>/)?.[1];
    items.push({
      id: `YouTube:${id}`,
      url: `https://www.youtube.com/watch?v=${id}`,
      title: title.slice(0, 300),
      timestamp: published ? Math.floor(Date.parse(published) / 1000) : 0,
      platform: "YouTube"
    });
  }
  return items.slice(0, maxItems);
}

async function youtubeChannelId(url) {
  const parsed = new URL(url);
  const direct = parsed.pathname.match(/^\/channel\/(UC[\w-]{20,})/i)?.[1];
  if (direct) return direct;
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
    headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36" }
  });
  if (!response.ok) throw new Error(`YouTube channel HTTP ${response.status}`);
  const html = await response.text();
  return html.match(/"(?:externalId|channelId)":"(UC[\w-]{20,})"/)?.[1]
    || html.match(/youtube\.com\/channel\/(UC[\w-]{20,})/)?.[1]
    || "";
}

async function scanYouTubeFeed(creator, config) {
  const channelId = await youtubeChannelId(creator.url);
  if (!channelId) throw new Error("לא ניתן לזהות את מזהה ערוץ YouTube");
  const response = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, {
    signal: AbortSignal.timeout(15_000),
    headers: { "user-agent": "Mozilla/5.0" }
  });
  if (!response.ok) throw new Error(`YouTube feed HTTP ${response.status}`);
  return parseYouTubeFeed(await response.text(), config.maxItems);
}

function cookiesPathFor(platform, config) {
  const platformPath = config.platformCookies?.[platform];
  if (platformPath && fs.existsSync(platformPath)) return platformPath;
  if (config.cookiesPath && fs.existsSync(config.cookiesPath)) return config.cookiesPath;
  return "";
}

export function instagramSessionCookieExpired(file, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!file || !fs.existsSync(file)) return true;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!rawLine || (rawLine.startsWith("#") && !rawLine.startsWith("#HttpOnly_"))) continue;
    const parts = rawLine.split("\t");
    if (parts.length < 7 || parts[5] !== "sessionid") continue;
    const expires = Number(parts[4]) || 0;
    return !parts[6] || (expires > 0 && expires <= nowSeconds);
  }
  return true;
}

export function isLikelyAuthenticationFailure(error) {
  return /(?:auth(?:entication)?[_ -]?required|login[_ -]?required|not logged in|session (?:has )?expired|invalid (?:cookie|session)|cookie.+expired|HTTP (?:401|403)|challenge_required)/i
    .test(String(error?.message || error || ""));
}

export function shouldDeferInstagramScan(subscription, intervalMs, now = Date.now()) {
  if (subscription?.platform !== "Instagram") return false;
  const lastChecked = Date.parse(subscription.lastCheckedAt || "");
  if (!Number.isFinite(lastChecked)) return false;
  const cooldownMs = Math.min(8 * 60_000, Math.max(2 * 60_000, Number(intervalMs || 0) * 0.75));
  const elapsed = now - lastChecked;
  return elapsed >= 0 && elapsed < cooldownMs;
}

async function scanYtDlp(creator, config) {
  const args = [
    "--flat-playlist", "--playlist-end", String(config.maxItems),
    "--dump-single-json", "--ignore-errors", "--no-warnings",
    ...EXTRACTOR_ARGS
  ];
  const cookiesPath = cookiesPathFor(creator.platform, config);
  if (cookiesPath) args.push("--cookies", cookiesPath);
  args.push("--", creator.url);
  const parsed = JSON.parse(await run(config.ytDlpPath, args));
  if (!parsed) return [];
  return normalizeItems(parsed.entries || [parsed], creator.platform);
}

async function scanInstagramSession(creator, config) {
  if (creator.platform !== "Instagram" || !config.instagramSessionPath || !fs.existsSync(config.instagramSessionPath)) return [];
  const username = new URL(creator.url).pathname.split("/").filter(Boolean)[0];
  if (!username) throw new Error("לא ניתן לזהות את שם המשתמש ב-Instagram");
  const raw = await new Promise((resolve, reject) => {
    const child = spawn(config.pythonPath, [config.instagramBridgePath, "scan", "--session", config.instagramSessionPath, username], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Instagram לא סיים את הסריקה בזמן"));
    }, 90_000);
    child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-5_000_000); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.once("error", reject);
    child.once("close", code => {
      clearTimeout(timer);
      if (code === 0 || stdout.trim()) resolve(stdout);
      else reject(new Error(stderr.trim() || "Instagram scan failed"));
    });
    child.stdin.end(String(config.maxItems));
  });
  const result = JSON.parse(raw);
  if (result.status === "SESSION_EXPIRED") throw new Error("AUTH_REQUIRED:Instagram");
  if (result.status === "RATE_LIMIT" || result.status === "NETWORK_ERROR") {
    throw new Error(`DEFERRED:Instagram:${result.status}`);
  }
  if (result.status !== "OK") throw new Error(result.message || "Instagram scan failed");
  if (result.settings && typeof result.settings === "object") {
    const temporary = `${config.instagramSessionPath}.${crypto.randomUUID()}.tmp`;
    await fs.promises.writeFile(temporary, JSON.stringify(result.settings), { mode: 0o600 });
    await fs.promises.rename(temporary, config.instagramSessionPath);
  }
  return normalizeItems(result.items, "Instagram");
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
  if (creator.platform === "Instagram") {
    args.push(
      "-o", "extractor.instagram.include=posts,reels,stories",
      "-o", "extractor.instagram.stories.split=true",
      "-o", "extractor.instagram.order-posts=desc",
      "-o", `extractor.instagram.max-posts=${config.maxItems}`,
      "-o", "extractor.sleep-request=2.0-4.0"
    );
  }
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
    try {
      results.push(...await scanGalleryUrl(redirect, creator, config, visited));
    } catch {
      // A profile can expose posts while stories are unavailable, or vice versa.
    }
  }
  return [...new Map(results.map(item => [item.id, item])).values()];
}

async function scanGalleryDl(creator, config) {
  return scanGalleryUrl(creator.url, creator, config);
}

function netscapeCookieHeader(file) {
  if (!file || !fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf8").split(/\r?\n/)
    .filter(line => line && (!line.startsWith("#") || line.startsWith("#HttpOnly_")))
    .map(line => line.replace(/^#HttpOnly_/, ""))
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
  if (creator.platform === "YouTube") {
    try {
      const items = await scanYouTubeFeed(creator, config);
      if (items.length) return items;
    } catch {
      // Continue to yt-dlp, which also covers playlists and unusual channel URLs.
    }
  }
  const needsSession = ["Instagram", "Facebook", "X"].includes(creator.platform);
  const platformCookiePath = cookiesPathFor(creator.platform, config);
  if (creator.platform === "Instagram" && platformCookiePath && instagramSessionCookieExpired(platformCookiePath)) {
    throw new Error("AUTH_REQUIRED:Instagram");
  }
  let firstError;
  if (creator.platform === "Instagram" && config.instagramSessionPath) {
    try {
      const items = await scanInstagramSession(creator, config);
      if (items.length) return items;
    } catch (error) {
      if (String(error.message).startsWith("DEFERRED:Instagram:")) throw error;
      if (!platformCookiePath) throw error;
      firstError = error;
    }
  }
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
  if (needsSession && (!platformCookiePath || isLikelyAuthenticationFailure(firstError))) {
    throw new Error(`AUTH_REQUIRED:${creator.platform}`);
  }
  throw firstError || new Error("לא נמצאו פרסומים ציבוריים בפרופיל.");
}

export async function downloadVideo(item, config) {
  await fs.promises.mkdir(config.tempDir, { recursive: true });
  const directory = path.join(config.tempDir, crypto.randomUUID());
  await fs.promises.mkdir(directory);
  const output = path.join(directory, "%(id)s.%(ext)s");
  if (item.platform === "Instagram" && item.directMediaUrl) {
    const response = await fetch(item.directMediaUrl, {
      signal: AbortSignal.timeout(60_000),
      headers: { "user-agent": "Mozilla/5.0", referer: "https://www.instagram.com/" }
    });
    if (!response.ok) throw new Error(`Instagram media HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    const extension = contentType.includes("video") || item.mediaKind === "video" ? "mp4" : "jpg";
    const destination = path.join(directory, `${item.id.replace(/[^A-Za-z0-9_-]/g, "_")}.${extension}`);
    await fs.promises.writeFile(destination, Buffer.from(await response.arrayBuffer()));
    return destination;
  }
  const args = [
    "--no-playlist",
    ...EXTRACTOR_ARGS,
    "-f", "b[ext=mp4][height<=720]/b[height<=720]/b",
    "-o", output
  ];
  const cookiesPath = cookiesPathFor(item.platform, config);
  if (cookiesPath) args.push("--cookies", cookiesPath);
  args.push("--", item.url);
  try {
    await run(config.ytDlpPath, args, 10 * 60_000);
  } catch (error) {
    if (item.platform !== "Instagram") throw error;
    await downloadInstagramEmbed(item.url, directory);
  }
  const files = (await fs.promises.readdir(directory))
    .filter(name => !/\.(part|ytdl)$/.test(name))
    .map(name => path.join(directory, name));
  if (!files.length) throw new Error("הקובץ לא הורד");
  return files[0];
}

function decodeInstagramJsonString(value) {
  return JSON.parse(`"${value}"`).replace(/\\\//g, "/").replace(/\\u0025/g, "%");
}

function extractInstagramValues(html, field) {
  const values = [];
  const marker = `\\\"${field}\\\":\\\"`;
  let cursor = 0;
  while ((cursor = html.indexOf(marker, cursor)) !== -1) {
    const start = cursor + marker.length;
    const end = html.indexOf("\\\"", start);
    if (end === -1) break;
    const value = decodeInstagramJsonString(html.slice(start, end));
    if (!values.includes(value)) values.push(value);
    cursor = end + 2;
  }
  return values;
}

async function downloadInstagramEmbed(url, directory) {
  const match = new URL(url).pathname.match(/^\/(p|reel)\/([^/]+)/);
  if (!match) throw new Error("לא ניתן לזהות את פוסט Instagram");
  const response = await fetch(`https://www.instagram.com/${match[1]}/${match[2]}/embed/captioned/`, {
    signal: AbortSignal.timeout(20_000),
    headers: { "user-agent": "Mozilla/5.0" }
  });
  if (!response.ok) throw new Error(`Instagram embed HTTP ${response.status}`);
  const html = await response.text();
  const videoUrls = extractInstagramValues(html, "video_url");
  if (!videoUrls.length) throw new Error("לא נמצא סרטון ציבורי ב-Instagram");
  const media = await fetch(videoUrls[0], {
    signal: AbortSignal.timeout(60_000),
    headers: { "user-agent": "Mozilla/5.0", referer: "https://www.instagram.com/" }
  });
  if (!media.ok) throw new Error(`Instagram media HTTP ${media.status}`);
  await fs.promises.writeFile(path.join(directory, `${match[2]}.mp4`), Buffer.from(await media.arrayBuffer()));
}

export async function cleanupVideo(file) {
  await fs.promises.rm(path.dirname(file), { recursive: true, force: true });
}
