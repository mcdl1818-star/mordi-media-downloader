import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { downloadCobaltVideo } from "./cobalt.js";

const PLATFORM_RULES = [
  ["YouTube", /(^|\.)youtube\.com$|^youtu\.be$/],
  ["Instagram", /(^|\.)instagram\.com$/],
  ["Facebook", /(^|\.)facebook\.com$|^fb\.watch$/],
  ["TikTok", /(^|\.)tiktok\.com$/],
  ["X", /(^|\.)x\.com$|(^|\.)twitter\.com$/]
];

const EXTRACTOR_ARGS = [
  "--js-runtimes", "node",
  "--remote-components", "ejs:github",
  "--extractor-args", "youtubepot-bgutilscript:server_home=/opt/bgutil/server",
  "--extractor-args", "twitter:api=syndication"
];

const YOUTUBE_CLIENTS = ["mweb", "web_embedded", "android_vr"];

function extractorArgs(url, youtubeClient = "") {
  const args = [...EXTRACTOR_ARGS];
  const isYouTube = /(^|\.)youtube\.com$|^youtu\.be$/i.test(new URL(url).hostname);
  if (isYouTube && youtubeClient) args.push("--extractor-args", `youtube:player_client=${youtubeClient}`);
  return args;
}

function supportedUrl(input) {
  let url;
  try {
    const candidates = String(input || "").match(/https:\/\/[^\s<>"']+/g) || [];
    const value = (candidates[0] || String(input || "").trim()).replace(/[)\],.!?]+$/, "");
    url = new URL(value);
  } catch {
    throw new Error("יש לשלוח קישור מלא לפרופיל או לערוץ.");
  }
  const match = PLATFORM_RULES.find(([, rule]) => rule.test(url.hostname.toLowerCase()));
  if (url.protocol !== "https:" || !match) throw new Error("הקישור אינו מפלטפורמה נתמכת.");
  url.hash = "";
  return { url, platform: match[0] };
}

function isSingleMediaUrl(url, platform) {
  if (platform === "Instagram") return /^\/(?:reel|p|tv)\//i.test(url.pathname);
  if (platform === "Facebook") return url.hostname === "fb.watch"
    || /\/(?:reel|watch)(?:\/|$)/i.test(url.pathname)
    || /\/videos?\//i.test(url.pathname)
    || /\/(?:posts?|share\/(?:p|r|v))\//i.test(url.pathname)
    || url.searchParams.has("v");
  if (platform === "TikTok") return /\/@[^/]+\/video\/\d+/i.test(url.pathname)
    || /\/@[^/]+\/photo\/\d+/i.test(url.pathname)
    || /^(?:vm|vt)\.tiktok\.com$/i.test(url.hostname);
  if (platform === "X") return /\/[^/]+\/status\/\d+/i.test(url.pathname);
  if (platform === "YouTube") return url.hostname === "youtu.be"
    || /\/(?:watch|shorts|live)(?:\/|$)/i.test(url.pathname)
    || url.searchParams.has("v");
  return false;
}

export function classifySupportedUrl(input) {
  const { url, platform } = supportedUrl(input);
  return { url: url.toString(), platform, kind: isSingleMediaUrl(url, platform) ? "media" : "profile" };
}

export function extractSupportedUrls(input) {
  const candidates = String(input || "").match(/https:\/\/[^\s<>"']+/g) || [];
  const output = [];
  for (const candidate of candidates) {
    try {
      const classified = classifySupportedUrl(candidate);
      if (!output.some(item => item.url === classified.url)) output.push(classified);
    } catch {
      // Ignore unrelated links when the same message contains supported profiles.
    }
  }
  return output;
}

export function creatorUrlFromMediaUrl(input) {
  const media = classifySupportedUrl(input);
  if (media.kind !== "media") return media;
  const url = new URL(media.url);
  const parts = url.pathname.split("/").filter(Boolean);
  let creatorUrl = "";
  if (media.platform === "TikTok" && parts[0]?.startsWith("@")) {
    creatorUrl = `https://www.tiktok.com/${parts[0]}/`;
  } else if (media.platform === "X" && parts[0] && parts[1]?.toLowerCase() === "status") {
    creatorUrl = `https://x.com/${parts[0]}/`;
  } else if (media.platform === "Facebook") {
    const videosIndex = parts.findIndex(part => /^videos?$/i.test(part));
    if (videosIndex > 0) creatorUrl = `https://www.facebook.com/${parts.slice(0, videosIndex).join("/")}/`;
  }
  return creatorUrl ? validateCreatorUrl(creatorUrl) : null;
}

export function validateCreatorUrl(input) {
  const classified = classifySupportedUrl(input);
  if (classified.kind === "media") {
    throw new Error("זה נראה כמו קישור לפרסום בודד. יש לשלוח קישור לפרופיל/ערוץ.");
  }
  return { url: classified.url, platform: classified.platform };
}

function run(command, args, timeoutMs = 90_000, allowPartialOutput = false) {
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
      code === 0 || (allowPartialOutput && stdout.trim())
        ? resolve(stdout)
        : reject(new Error(stderr.trim() || `${command} נכשל בקוד ${code ?? "unknown"}`));
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

function creatorCandidate(platform, value) {
  const clean = String(value || "").trim().replace(/^@/, "");
  if (!clean) return "";
  if (/^https:\/\//i.test(clean)) return clean;
  if (platform === "Instagram" && /^[A-Za-z0-9._]{1,30}$/.test(clean)) return `https://www.instagram.com/${clean}/`;
  if (platform === "TikTok" && /^[A-Za-z0-9._-]{1,40}$/.test(clean)) return `https://www.tiktok.com/@${clean}/`;
  if (platform === "X" && /^[A-Za-z0-9_]{1,30}$/.test(clean)) return `https://x.com/${clean}/`;
  if (platform === "Facebook" && /^[A-Za-z0-9._-]{1,100}$/.test(clean)) return `https://www.facebook.com/${clean}/`;
  if (platform === "YouTube" && /^UC[A-Za-z0-9_-]{20,}$/.test(clean)) return `https://www.youtube.com/channel/${clean}`;
  if (platform === "YouTube" && /^[A-Za-z0-9._-]{1,100}$/.test(clean)) return `https://www.youtube.com/@${clean.replace(/^@/, "")}`;
  return "";
}

export async function youtubeCreatorFromOembed(input, fetchImpl = fetch) {
  const media = classifySupportedUrl(input);
  if (media.platform !== "YouTube" || media.kind !== "media") return null;
  const endpoint = new URL("https://www.youtube.com/oembed");
  endpoint.searchParams.set("url", media.url);
  endpoint.searchParams.set("format", "json");
  const response = await fetchImpl(endpoint, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) return null;
  const authorUrl = String((await response.json())?.author_url || "");
  if (!authorUrl) return null;
  try {
    const creator = validateCreatorUrl(authorUrl);
    return creator.platform === "YouTube" ? creator : null;
  } catch {
    return null;
  }
}

export async function resolveCreatorFromMediaUrl(input, config) {
  const direct = creatorUrlFromMediaUrl(input);
  if (direct) return direct;
  const media = classifySupportedUrl(input);
  if (media.kind !== "media") return validateCreatorUrl(media.url);

  if (media.platform === "YouTube") {
    try {
      const creator = await youtubeCreatorFromOembed(media.url);
      if (creator) return creator;
    } catch {
      // Fall through to extractor metadata for unusual or private videos.
    }
  }

  if (media.platform === "Instagram") {
    try {
      const parsed = new URL(media.url);
      const match = parsed.pathname.match(/^\/(?:p|reel|tv)\/([^/]+)/i);
      if (match) {
        const response = await fetch(`https://www.instagram.com/p/${match[1]}/embed/captioned/`, {
          signal: AbortSignal.timeout(20_000),
          headers: { "user-agent": "Mozilla/5.0" }
        });
        if (response.ok) {
          const usernames = extractInstagramValues(await response.text(), "username");
          for (const username of usernames) {
            try { return validateCreatorUrl(`https://www.instagram.com/${username}/`); } catch {}
          }
        }
      }
    } catch {
      // Continue to yt-dlp metadata, which also handles authenticated posts.
    }
  }

  try {
    const clients = media.platform === "YouTube" ? YOUTUBE_CLIENTS : [""];
    let info;
    let lastError;
    for (const client of clients) {
      try {
        const args = ["--dump-single-json", "--skip-download", "--no-warnings", ...extractorArgs(media.url, client)];
        const cookiesPath = cookiesPathFor(media.platform, config);
        if (cookiesPath) args.push("--cookies", cookiesPath);
        args.push("--", media.url);
        info = JSON.parse(await run(config.ytDlpPath, args, 60_000));
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!info) throw lastError;
    const candidates = [
      info.channel_url,
      info.uploader_url,
      creatorCandidate(media.platform, info.uploader_id),
      creatorCandidate(media.platform, info.channel_id),
      creatorCandidate(media.platform, info.uploader),
      creatorCandidate(media.platform, info.channel)
    ].filter(Boolean);
    for (const candidate of candidates) {
      try {
        const creator = validateCreatorUrl(candidate);
        if (creator.platform === media.platform) return creator;
      } catch {}
    }
  } catch {
    // The download can still succeed even when creator metadata is unavailable.
  }
  return null;
}

export function mediaItemFromUrl(input) {
  const media = classifySupportedUrl(input);
  if (media.kind !== "media") throw new Error("הקישור אינו פרסום או סרטון בודד.");
  return {
    id: `${media.platform}:manual:${crypto.createHash("sha256").update(media.url).digest("hex").slice(0, 20)}`,
    url: media.url,
    title: "המדיה שביקשת",
    timestamp: 0,
    platform: media.platform
  };
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
  return /(?:auth(?:entication)?[_ -]?required|login[_ -]?required|not logged in|session (?:has )?expired|invalid (?:cookie|session)|cookie.+expired|HTTP 401|challenge_required)/i
    .test(String(error?.message || error || ""));
}

export function shouldDeferInstagramScan(subscription, intervalMs, now = Date.now()) {
  if (subscription?.platform !== "Instagram") return false;
  const scheduled = Date.parse(subscription.nextInstagramCheckAt || "");
  if (Number.isFinite(scheduled)) return now < scheduled;
  const lastChecked = Date.parse(subscription.lastCheckedAt || "");
  if (!Number.isFinite(lastChecked)) return false;
  const throttled = String(subscription.lastError || "").includes("RATE_LIMIT");
  const cooldownMs = throttled
    ? Math.max(2 * 60 * 60_000, Number(intervalMs || 0))
    : Math.max(15 * 60_000, Number(intervalMs || 0));
  const elapsed = now - lastChecked;
  return elapsed >= 0 && elapsed < cooldownMs;
}

async function scanYtDlp(creator, config) {
  const clients = creator.platform === "YouTube" ? YOUTUBE_CLIENTS : [""];
  let parsed;
  let lastError;
  for (const client of clients) {
    try {
      const args = [
        "--flat-playlist", "--playlist-end", String(config.maxItems),
        "--dump-single-json", "--ignore-errors", "--no-warnings",
        ...extractorArgs(creator.url, client)
      ];
      const cookiesPath = cookiesPathFor(creator.platform, config);
      if (cookiesPath) args.push("--cookies", cookiesPath);
      args.push("--", creator.url);
      parsed = JSON.parse(await run(config.ytDlpPath, args, 90_000, true));
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!parsed) throw lastError;
  if (!parsed) return [];
  return normalizeItems(parsed.entries || [parsed], creator.platform);
}

async function scanInstagramSession(creator, config) {
  if (creator.platform !== "Instagram" || !config.instagramSessionPath || !fs.existsSync(config.instagramSessionPath)) return [];
  const username = new URL(creator.url).pathname.split("/").filter(Boolean)[0];
  if (!username) throw new Error("לא ניתן לזהות את שם המשתמש ב-Instagram");
  const raw = await new Promise((resolve, reject) => {
    const args = [config.instagramBridgePath, "scan", "--session", config.instagramSessionPath, username];
    if (/^\d+$/.test(String(creator.instagramUserId || ""))) args.push(String(creator.instagramUserId));
    const child = spawn(config.pythonPath, args, {
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
  if (/^\d+$/.test(String(result.userId || ""))) creator.instagramUserId = String(result.userId);
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

async function scanGalleryUrl(url, creator, config, visited = new Set(), deadline = Date.now() + 60_000) {
  if (visited.has(url) || visited.size >= 4 || Date.now() >= deadline) return [];
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
  const remainingMs = Math.max(5_000, Math.min(30_000, deadline - Date.now()));
  const raw = await run(config.galleryDlPath, args, remainingMs, true);
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
      results.push(...await scanGalleryUrl(redirect, creator, config, visited, deadline));
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

export async function scanCreator(creator, config, dependencies = {}) {
  const scanPrivate = dependencies.scanInstagramSession || scanInstagramSession;
  const scanYt = dependencies.scanYtDlp || scanYtDlp;
  const scanGallery = dependencies.scanGalleryDl || scanGalleryDl;
  const scanHtml = dependencies.scanProfileHtml || scanProfileHtml;
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
  // The private mobile session is the primary Instagram identity. A stale web
  // cookie must never prevent a valid private session from being tried.
  if (creator.platform === "Instagram" && !config.instagramSessionPath && platformCookiePath && instagramSessionCookieExpired(platformCookiePath)) {
    throw new Error("AUTH_REQUIRED:Instagram");
  }
  let firstError;
  if (creator.platform === "Instagram" && config.instagramSessionPath) {
    try {
      const items = await scanPrivate(creator, config);
      // An empty authenticated result is still a successful scan. Falling
      // through would repeat the same profile through several web extractors.
      return items;
    } catch (error) {
      // A rate limit is a signal to stop all Instagram traffic, not to retry the
      // same profile immediately through the web-cookie fallback.
      if (String(error.message).startsWith("DEFERRED:Instagram:")) throw error;
      if (!platformCookiePath) throw error;
      firstError = error;
    }
  }
  if (creator.platform === "Facebook") {
    try {
      const items = await scanHtml(creator, config);
      if (items.length) return items;
    } catch (error) {
      firstError = error;
    }
    // gallery-dl's Facebook profile extractor enumerates photos/albums. Those
    // are not Reel notifications and often contain short-lived CDN URLs, so
    // never treat them as creator video updates.
    if (!platformCookiePath) throw new Error("AUTH_REQUIRED:Facebook");
    throw firstError || new Error("לא נמצאו Reels בפרופיל Facebook המחובר.");
  }
  try {
    const items = await scanYt(creator, config);
    if (items.length) return items;
  } catch (error) {
    firstError = error;
  }
  try {
    const items = await scanGallery(creator, config);
    if (items.length) return items;
  } catch (error) {
    firstError ||= error;
  }
  try {
    const items = await scanHtml(creator, config);
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
  if (["YouTube", "TikTok", "Facebook", "X"].includes(item.platform)) {
    try {
      return await downloadCobaltVideo(item, config);
    } catch (error) {
      // On the hosted monitor, the dedicated worker has a longer lease and an
      // optional encrypted browser session. Do not hammer YouTube nine more
      // times from the already-blocked Render IP before handing it off.
      if (item.platform === "YouTube" && config.webhookUrl) throw error;
      // Keep the local extractors as an independent fallback when the public
      // tunnel is unavailable or rate limited.
    }
  }
  const clients = item.platform === "YouTube" ? YOUTUBE_CLIENTS : [""];
  const formats = item.platform === "YouTube"
    ? [
        "b[ext=mp4][height<=480]/bv*[height<=480]+ba/b[height<=480]/b",
        "b[ext=mp4][height<=360]/bv*[height<=360]+ba/b[height<=360]/b",
        "b[ext=mp4][height<=240]/bv*[height<=240]+ba/b[height<=240]/b"
      ]
    : ["bv*[height<=720]+ba/b[height<=720]/b"];
  let lastError;
  for (const client of clients) {
    for (const format of formats) {
      try {
        for (const name of await fs.promises.readdir(directory)) {
          await fs.promises.rm(path.join(directory, name), { recursive: true, force: true });
        }
        const ffmpegLocationArgs = config.ffmpegPath && /[\\/]/.test(config.ffmpegPath)
          ? ["--ffmpeg-location", config.ffmpegPath]
          : [];
        const args = [
          "--no-playlist",
          ...extractorArgs(item.url, client),
          ...ffmpegLocationArgs,
          "-f", format,
          "--merge-output-format", "mp4",
          "-o", output
        ];
        // yt-dlp already discovers a PATH-installed ffmpeg. Passing the bare
        // word "ffmpeg" to --ffmpeg-location is interpreted as a directory
        // and produces a misleading warning on Render.
        const cookiesPath = cookiesPathFor(item.platform, config);
        if (cookiesPath) args.push("--cookies", cookiesPath);
        args.push("--", item.url);
        await run(config.ytDlpPath, args, 10 * 60_000);
        const files = (await fs.promises.readdir(directory))
          .filter(name => !/\.(part|ytdl)$/.test(name))
          .map(name => path.join(directory, name));
        if (!files.length) throw new Error("yt-dlp הסתיים ללא קובץ מדיה");
        const sized = await Promise.all(files.map(async file => ({ file, size: (await fs.promises.stat(file)).size })));
        sized.sort((left, right) => right.size - left.size);
        if (sized[0].size > config.maxBytes) {
          throw new Error(`הקובץ גדול ממגבלת Telegram גם באיכות ${format.match(/height<=([0-9]+)/)?.[1] || "נמוכה"}p`);
        }
        return sized[0].file;
      } catch (error) {
        lastError = error;
      }
    }
  }
  if (item.platform === "Instagram") {
    await downloadInstagramEmbed(item.url, directory);
    const fallback = (await fs.promises.readdir(directory))
      .filter(name => !/\.(part|ytdl)$/.test(name))
      .map(name => path.join(directory, name));
    if (fallback.length) return fallback[0];
  }
  throw lastError || new Error("הקובץ לא הורד");
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
