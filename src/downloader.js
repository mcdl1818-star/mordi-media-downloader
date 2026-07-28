import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { once } from "node:events";
import dns from "node:dns/promises";
import net from "node:net";

const PLATFORM_RULES = [
  ["YouTube", /(^|\.)youtube\.com$|^youtu\.be$/],
  ["Instagram", /(^|\.)instagram\.com$/],
  ["Facebook", /(^|\.)facebook\.com$|^fb\.watch$/],
  ["X/Twitter", /(^|\.)twitter\.com$|(^|\.)x\.com$/],
  ["TikTok", /(^|\.)tiktok\.com$/],
  ["Vimeo", /(^|\.)vimeo\.com$/]
];

const EXTRACTOR_ARGS = [
  "--js-runtimes", "node",
  "--extractor-args", "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416",
  "--extractor-args", "twitter:api=syndication"
];

// Try the recommended mweb + PO-token path first. Public guest-only fallbacks use
// HLS/embedded clients without cookies, so a blocked cloud IP does not burn the
// authenticated account session.
const YOUTUBE_CLIENTS = ["mweb", "web_safari", "web_embedded"];

function extractorArgs(url, youtubeClient, config, useYouTubeCookies = true) {
  const args = [...EXTRACTOR_ARGS];
  const hostname = new URL(url).hostname;
  if (/(^|\.)youtube\.com$|^youtu\.be$/i.test(hostname) && youtubeClient) {
    args.push("--extractor-args", `youtube:player_client=${youtubeClient}`);
    args.push("--sleep-requests", "1", "--retry-sleep", "http:exp=1:10");
    if (config.youtubeProxyUrl) args.push("--proxy", config.youtubeProxyUrl);
    if (useYouTubeCookies && config.youtubeCookiesPath && fs.existsSync(config.youtubeCookiesPath)) {
      args.push("--cookies", config.youtubeCookiesPath);
    }
  }
  if (/(^|\.)facebook\.com$|^fb\.watch$/i.test(hostname)) {
    args.push("--impersonate", "chrome");
  }
  return args;
}

export function requiresYouTubeAuthentication(error) {
  const message = String(error?.message || "");
  if (isYouTubeBlockedError(error)) return false;
  return /sign.?in|login|age.?restrict|members.?only|private video|authentication/i.test(message);
}

export function isYouTubeBlockedError(error) {
  return /confirm you.?re not a bot|unusual traffic|temporarily blocked/i
    .test(String(error?.message || ""));
}

export function validateMediaUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("הקישור אינו כתובת URL תקינה.");
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) {
    throw new Error("יש לשלוח קישור HTTPS ציבורי ותקין.");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || isPrivateAddress(hostname)) {
    throw new Error("מטעמי אבטחה לא ניתן לגשת לכתובת מקומית או פרטית.");
  }
  const platform = PLATFORM_RULES.find(([, rule]) => rule.test(hostname));
  return { url: url.toString(), platform: platform?.[0] || "אתר כללי" };
}

export function extractSupportedMediaUrl(input) {
  const candidates = String(input || "").match(/https:\/\/[^\s<>"']+/gi) || [];
  for (const candidate of candidates) {
    const cleaned = candidate.replace(/[)\],.!?]+$/, "");
    try {
      return validateMediaUrl(cleaned);
    } catch {
      // Continue to the next URL when a message contains an unrelated link first.
    }
  }
  return validateMediaUrl(String(input || "").trim());
}

export const validateYouTubeUrl = input => validateMediaUrl(input).url;

function isPrivateAddress(address) {
  if (!net.isIP(address)) return false;
  if (address === "::" || address === "::1" || address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe8") || address.startsWith("fe9") || address.startsWith("fea") || address.startsWith("feb")) return true;
  if (address.startsWith("::ffff:")) return isPrivateAddress(address.slice(7));
  const octets = address.split(".").map(Number);
  if (octets.length !== 4) return false;
  return octets[0] === 0
    || octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
    || octets[0] >= 224;
}

async function assertPublicUrl(input) {
  const { url } = validateMediaUrl(input);
  const parsed = new URL(url);
  const addresses = await dns.lookup(parsed.hostname, { all: true });
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) {
    throw new Error("מטעמי אבטחה הכתובת מפנה לרשת מקומית או פרטית.");
  }
  return parsed;
}

async function safeFetch(input, options = {}, redirects = 0) {
  if (redirects > 5) throw new Error("האתר ביצע יותר מדי הפניות.");
  await assertPublicUrl(input);
  const response = await fetch(input, {
    ...options,
    redirect: "manual",
    signal: options.signal || AbortSignal.timeout(30_000)
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    if (!location) return response;
    const next = new URL(location, input).toString();
    return safeFetch(next, options, redirects + 1);
  }
  return response;
}

function parseProgressLine(line, onProgress) {
  const marker = "__PROGRESS__";
  const start = line.indexOf(marker);
  if (start === -1 || !onProgress) return;
  const [percentText = "", speed = "", eta = ""] = line.slice(start + marker.length).trim().split("|");
  const percent = Number.parseFloat(percentText.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(percent)) return;
  Promise.resolve(onProgress({
    percent: Math.max(0, Math.min(100, percent)),
    speed: speed.trim(),
    eta: eta.trim()
  })).catch(() => {});
}

function run(command, args, { timeoutMs = 10 * 60_000, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stdoutLineBuffer = "";
    let stderrLineBuffer = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("הפעולה ארכה יותר מדי זמן ונעצרה."));
    }, timeoutMs);
    child.stdout.on("data", chunk => {
      const text = String(chunk);
      stdout += text;
      if (!onProgress) return;
      stdoutLineBuffer += text;
      const lines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = lines.pop() || "";
      for (const line of lines) parseProgressLine(line, onProgress);
    });
    child.stderr.on("data", chunk => {
      const text = String(chunk);
      stderr = (stderr + text).slice(-5000);
      stderrLineBuffer += text;
      const lines = stderrLineBuffer.split(/\r?\n/);
      stderrLineBuffer = lines.pop() || "";
      for (const line of lines) parseProgressLine(line, onProgress);
    });
    child.on("error", error => {
      clearTimeout(timer);
      reject(new Error(`לא ניתן להפעיל ${command}: ${error.message}`));
    });
    child.on("close", code => {
      clearTimeout(timer);
      parseProgressLine(stdoutLineBuffer, onProgress);
      parseProgressLine(stderrLineBuffer, onProgress);
      code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `${command} הסתיים בקוד ${code}`));
    });
  });
}

async function getVimeoConfig(url) {
  const parsed = new URL(url);
  const id = parsed.pathname.match(/(?:video\/)?(\d+)/)?.[1];
  if (!id) throw new Error("לא ניתן לזהות את סרטון Vimeo.");
  const response = await fetch(`https://player.vimeo.com/video/${id}/config`, {
    headers: { "user-agent": "Mozilla/5.0", referer: url }
  });
  if (!response.ok) throw new Error("Vimeo חסם זמנית את הגישה לסרטון.");
  return response.json();
}

function formatTransferSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "";
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MiB/s`;
  return `${Math.round(bytesPerSecond / 1024)} KiB/s`;
}

async function writeResponseToFile(response, destination, onProgress, maxBytes = Infinity) {
  const total = Number(response.headers.get("content-length")) || 0;
  if (total > maxBytes) throw new Error(`הקובץ גדול מדי לשליחה ב-Telegram (${(total / 1024 / 1024).toFixed(1)}MB).`);
  if (!response.body) {
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > maxBytes) throw new Error("הקובץ גדול מדי לשליחה ב-Telegram.");
    await fs.promises.writeFile(destination, body);
    return;
  }
  const reader = response.body.getReader();
  const output = fs.createWriteStream(destination);
  const startedAt = Date.now();
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      if (received + chunk.length > maxBytes) {
        throw new Error("הקובץ גדול מדי לשליחה ב-Telegram.");
      }
      if (!output.write(chunk)) await once(output, "drain");
      received += chunk.length;
      if (total && onProgress) {
        const elapsedSeconds = Math.max(0.1, (Date.now() - startedAt) / 1000);
        const speedBytes = received / elapsedSeconds;
        const remainingSeconds = speedBytes > 0 ? Math.max(0, Math.round((total - received) / speedBytes)) : 0;
        await onProgress({
          percent: (received / total) * 100,
          speed: formatTransferSpeed(speedBytes),
          eta: remainingSeconds ? `${remainingSeconds}s` : ""
        });
      }
    }
    output.end();
    await once(output, "finish");
  } catch (error) {
    output.destroy();
    await fs.promises.rm(destination, { force: true });
    throw error;
  }
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function mediaExtension(contentType, sourceUrl) {
  const type = String(contentType || "").split(";")[0].trim().toLowerCase();
  const byType = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
    "image/gif": ".gif", "image/avif": ".avif", "image/svg+xml": ".svg",
    "video/mp4": ".mp4", "video/webm": ".webm", "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a", "audio/ogg": ".ogg"
  };
  if (byType[type]) return byType[type];
  const extension = path.extname(new URL(sourceUrl).pathname).toLowerCase();
  return /^\.(jpe?g|png|webp|gif|avif|svg|mp4|webm|mov|m4v|mp3|m4a|ogg|wav)$/.test(extension)
    ? extension.replace(".jpeg", ".jpg")
    : "";
}

function addMediaCandidate(results, candidate, pageUrl) {
  if (!candidate || /^(data|blob|javascript):/i.test(candidate)) return;
  try {
    const normalized = new URL(decodeHtml(candidate), pageUrl).toString();
    if (normalized.startsWith("https://") && !results.includes(normalized)) results.push(normalized);
  } catch {
    // Ignore malformed media references.
  }
}

export function extractMediaUrlsFromHtml(html, pageUrl, maxItems = 15) {
  const results = [];
  const source = String(html || "");
  const metaPattern = /<meta\b[^>]*>/gi;
  for (const tag of source.match(metaPattern) || []) {
    const key = tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1] || "";
    if (!/^(?:og:(?:image|video|audio)(?::secure_url)?|twitter:(?:image|player:stream))$/i.test(key)) continue;
    const content = tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i)?.[1];
    addMediaCandidate(results, content, pageUrl);
  }
  const elementPattern = /<(?:img|video|audio|source)\b[^>]*>/gi;
  for (const tag of source.match(elementPattern) || []) {
    const candidate = tag.match(/\b(?:src|data-src|data-original)\s*=\s*["']([^"']+)["']/i)?.[1];
    addMediaCandidate(results, candidate, pageUrl);
  }
  return results.slice(0, maxItems);
}

async function inspectPageMedia(url, config) {
  const response = await safeFetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
      accept: "text/html,application/xhtml+xml,image/avif,image/webp,image/*,video/*;q=0.8"
    }
  });
  if (!response.ok) throw new Error(`האתר החזיר שגיאה ${response.status}.`);
  const contentType = response.headers.get("content-type") || "";
  if (/^(image|video|audio)\//i.test(contentType)) {
    return {
      title: path.basename(new URL(url).pathname) || "קובץ מדיה",
      channel: new URL(url).hostname,
      duration: 0,
      webpageUrl: url,
      mediaKind: contentType.split("/")[0],
      mediaCount: 1
    };
  }
  if (!/html|xhtml/i.test(contentType)) throw new Error("לא נמצאה מדיה בקישור.");
  const declaredLength = Number(response.headers.get("content-length")) || 0;
  if (declaredLength > 5 * 1024 * 1024) throw new Error("דף האינטרנט גדול מדי לבדיקה בטוחה.");
  const html = (await response.text()).slice(0, 5 * 1024 * 1024);
  const mediaUrls = extractMediaUrlsFromHtml(html, url, config.maxMediaItems);
  if (!mediaUrls.length) throw new Error("לא נמצאו תמונות, וידאו או אודיו ציבוריים בדף.");
  const title = decodeHtml(
    html.match(/<meta\b[^>]*(?:property|name)=["']og:title["'][^>]*content=["']([^"']+)/i)?.[1]
    || html.match(/<title[^>]*>([^<]*)/i)?.[1]
    || "מדיה מהאתר"
  ).trim();
  return {
    title,
    channel: new URL(url).hostname,
    duration: 0,
    webpageUrl: url,
    mediaKind: "gallery",
    mediaCount: mediaUrls.length
  };
}

export function isLikelyDirectMediaUrl(input) {
  try {
    return /\.(?:jpe?g|png|webp|gif|avif|svg|mp4|webm|mov|m4v|mp3|m4a|ogg|wav)(?:$|[?#])/i
      .test(new URL(input).pathname);
  } catch {
    return false;
  }
}

export async function inspectUrl(url, config) {
  await assertPublicUrl(url);
  if (isLikelyDirectMediaUrl(url)) return inspectPageMedia(url, config);
  let info;
  try {
    const isYouTube = /(^|\.)youtube\.com$|^youtu\.be$/i.test(new URL(url).hostname);
    const clients = isYouTube ? YOUTUBE_CLIENTS : [null];
    let lastError;
    for (const client of clients) {
      const authenticationModes = isYouTube
        && client === "mweb"
        && config.youtubeCookiesPath
        && fs.existsSync(config.youtubeCookiesPath)
        ? [false, true]
        : [false];
      for (const useCookies of authenticationModes) {
        try {
          const output = await run(config.ytDlpPath, [
            "--no-playlist", "--dump-single-json", "--no-warnings",
            ...extractorArgs(url, client, config, useCookies),
            "-f", "b/bv*+ba",
            "--", url
          ], { timeoutMs: 60_000 });
          info = JSON.parse(output);
          break;
        } catch (error) {
          lastError = error;
          if (!useCookies && !requiresYouTubeAuthentication(error)) break;
        }
      }
      if (info) break;
    }
    if (!info) throw lastError;
  } catch (error) {
    if (/(^|\.)vimeo\.com$/i.test(new URL(url).hostname)) {
      const vimeo = await getVimeoConfig(url);
      info = {
        id: String(vimeo.video?.id || ""),
        extractor_key: "Vimeo",
        title: vimeo.video?.title,
        uploader: vimeo.video?.owner?.name,
        duration: vimeo.video?.duration,
        webpage_url: url
      };
    } else {
      return inspectPageMedia(url, config);
    }
  }
  return {
    id: info.id,
    extractor: info.extractor_key || info.extractor || "Generic",
    title: info.title || "ללא כותרת",
    channel: info.channel || info.uploader || "לא ידוע",
    duration: Number(info.duration) || 0,
    webpageUrl: info.webpage_url || url,
    mediaKind: "video",
    mediaCount: 1
  };
}

export function videoFormatForHeight(maxHeight = 720) {
  const height = [360, 480, 720, 1080].includes(Number(maxHeight)) ? Number(maxHeight) : 720;
  return [
    `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]`,
    `bv*[height<=${height}]+ba`,
    `b[height<=${height}][ext=mp4]`,
    `b[height<=${height}]`,
    `worst[height<=${height}]`
  ].join("/");
}

export async function download(url, kind, config, onProgress, { maxHeight = 720 } = {}) {
  await assertPublicUrl(url);
  await fs.promises.mkdir(config.tempDir, { recursive: true });
  const jobDir = path.join(config.tempDir, crypto.randomUUID());
  await fs.promises.mkdir(jobDir);
  const outputTemplate = path.join(jobDir, "%(title).80B [%(id)s].%(ext)s");
  const common = [
    "--no-playlist", "--windows-filenames", "--trim-filenames", "120",
    "--concurrent-fragments", "8",
    "--socket-timeout", "25",
    "--retries", "5",
    "--fragment-retries", "8",
    "--file-access-retries", "3",
    "--retry-sleep", "http:exp=1:10",
    "--retry-sleep", "fragment:exp=1:8",
    "--newline",
    "--progress",
    "--progress-delta", "1",
    "--progress-template", "download:__PROGRESS__%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
    "--ffmpeg-location", config.ffmpegPath,
    "-o", outputTemplate
  ];
  const mediaArgs = kind === "audio"
    ? [
        "-f",
        "18/22/b[height<=360][ext=mp4]/ba/b",
        "-x",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "5"
      ]
    : [
        "-f",
        videoFormatForHeight(maxHeight),
        "--remux-video",
        "mp4",
        "--merge-output-format",
        "mp4"
      ];
  try {
    const isYouTube = /(^|\.)youtube\.com$|^youtu\.be$/i.test(new URL(url).hostname);
    const clients = isYouTube ? YOUTUBE_CLIENTS : [null];
    let completed = false;
    let lastError;
    for (const client of clients) {
      const authenticationModes = isYouTube
        && client === "mweb"
        && config.youtubeCookiesPath
        && fs.existsSync(config.youtubeCookiesPath)
        ? [false, true]
        : [false];
      for (const useCookies of authenticationModes) {
        try {
          await run(
            config.ytDlpPath,
            [...common, ...extractorArgs(url, client, config, useCookies), ...mediaArgs, "--", url],
            { onProgress }
          );
          completed = true;
          break;
        } catch (error) {
          lastError = error;
          if (!useCookies && !requiresYouTubeAuthentication(error)) break;
        }
      }
      if (completed) break;
    }
    if (!completed) throw lastError;
  } catch (error) {
    if (!/(^|\.)vimeo\.com$/i.test(new URL(url).hostname)) throw error;
    const vimeo = await getVimeoConfig(url);
    const progressive = [...(vimeo.request?.files?.progressive || [])]
      .filter(item => item.url)
      .sort((a, b) => (b.height || 0) - (a.height || 0));
    const selected = progressive.find(item => (item.height || 0) <= maxHeight) || progressive.at(-1);
    if (!selected) throw error;
    const mediaResponse = await fetch(selected.url, { headers: { "user-agent": "Mozilla/5.0", referer: url } });
    if (!mediaResponse.ok) throw new Error("Vimeo חסם זמנית את הורדת הסרטון.");
    const sourcePath = path.join(jobDir, "vimeo-source.mp4");
    await writeResponseToFile(mediaResponse, sourcePath, onProgress);
    if (kind === "audio") {
      const audioPath = path.join(jobDir, "vimeo-audio.mp3");
      await run(config.ffmpegPath, ["-i", sourcePath, "-vn", "-c:a", "libmp3lame", "-q:a", "5", audioPath]);
      await fs.promises.rm(sourcePath, { force: true });
    }
  }
  const files = (await fs.promises.readdir(jobDir))
    .filter(name => !name.endsWith(".part") && !name.endsWith(".ytdl"))
    .map(name => path.join(jobDir, name));
  const preferredExtension = kind === "audio" ? ".mp3" : ".mp4";
  const preferred = files.filter(file => path.extname(file).toLowerCase() === preferredExtension);
  const candidates = preferred.length ? preferred : files;
  if (!candidates.length) throw new Error("לא נמצא קובץ מדיה לאחר ההורדה.");
  const sizes = await Promise.all(candidates.map(async file => ({
    file,
    size: (await fs.promises.stat(file)).size
  })));
  sizes.sort((a, b) => b.size - a.size);
  return sizes[0].file;
}

async function listFilesRecursively(directory) {
  const entries = await fs.promises.readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter(entry => entry.isFile())
    .map(entry => path.join(entry.parentPath || entry.path, entry.name))
    .filter(file => !file.endsWith(".part"));
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

async function downloadInstagramEmbed(url, jobDir) {
  const source = new URL(url);
  const match = source.pathname.match(/^\/(p|reel)\/([^/]+)/);
  if (!match) throw new Error("לא ניתן לזהות את כתובת הפוסט באינסטגרם.");

  const response = await fetch(`https://www.instagram.com/${match[1]}/${match[2]}/embed/captioned/`, {
    headers: {
      "user-agent": "Mozilla/5.0"
    }
  });
  if (!response.ok) throw new Error("אינסטגרם חסם זמנית את הגישה לפוסט.");

  const html = await response.text();
  const displayUrls = extractInstagramValues(html, "display_url");
  const videoUrls = extractInstagramValues(html, "video_url");
  const mediaUrls = match[1] === "reel" && videoUrls.length
    ? videoUrls
    : [...displayUrls, ...videoUrls.filter(item => !displayUrls.includes(item))];
  if (!mediaUrls.length) throw new Error("לא נמצאה מדיה ציבורית בפוסט.");

  const files = [];
  for (let index = 0; index < mediaUrls.length; index += 1) {
    const mediaResponse = await fetch(mediaUrls[index], {
      headers: { "user-agent": "Mozilla/5.0", referer: "https://www.instagram.com/" }
    });
    if (!mediaResponse.ok) continue;
    const contentType = mediaResponse.headers.get("content-type") || "";
    const extension = contentType.includes("video") ? ".mp4"
      : contentType.includes("png") ? ".png"
        : contentType.includes("webp") ? ".webp" : ".jpg";
    const filePath = path.join(jobDir, `${String(index + 1).padStart(2, "0")}${extension}`);
    await fs.promises.writeFile(filePath, Buffer.from(await mediaResponse.arrayBuffer()));
    files.push(filePath);
  }
  if (!files.length) throw new Error("אינסטגרם חסם זמנית את הורדת קובצי המדיה.");
  return files;
}

async function downloadPageMedia(url, jobDir, config) {
  const pageResponse = await safeFetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
      accept: "text/html,application/xhtml+xml,image/avif,image/webp,image/*,video/*;q=0.8"
    }
  });
  if (!pageResponse.ok) throw new Error(`האתר החזיר שגיאה ${pageResponse.status}.`);
  const pageType = pageResponse.headers.get("content-type") || "";
  let mediaUrls;
  if (/^(image|video|audio)\//i.test(pageType)) {
    mediaUrls = [url];
  } else {
    if (!/html|xhtml/i.test(pageType)) throw new Error("הקישור אינו דף או קובץ מדיה נתמך.");
    const declaredLength = Number(pageResponse.headers.get("content-length")) || 0;
    if (declaredLength > 5 * 1024 * 1024) throw new Error("דף האינטרנט גדול מדי לבדיקה בטוחה.");
    const html = (await pageResponse.text()).slice(0, 5 * 1024 * 1024);
    mediaUrls = extractMediaUrlsFromHtml(html, url, config.maxMediaItems);
  }
  if (!mediaUrls.length) throw new Error("לא נמצאה מדיה ציבורית שניתן להוריד מהדף.");

  const files = new Array(mediaUrls.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < mediaUrls.length) {
      const index = cursor++;
      const mediaUrl = mediaUrls[index];
      try {
        const response = mediaUrl === url && /^(image|video|audio)\//i.test(pageType)
          ? pageResponse
          : await safeFetch(mediaUrl, {
              headers: {
                "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
                referer: url,
                accept: "image/avif,image/webp,image/*,video/*,audio/*;q=0.9,*/*;q=0.5"
              }
            });
        if (!response.ok) continue;
        const type = response.headers.get("content-type") || "";
        const extension = mediaExtension(type, mediaUrl);
        if (!extension || !/^(image|video|audio)\//i.test(type)) continue;
        const filePath = path.join(jobDir, `${String(index + 1).padStart(2, "0")}${extension}`);
        await writeResponseToFile(response, filePath, null, config.maxBytes);
        files[index] = filePath;
      } catch (error) {
        console.warn(`Media item ${index + 1} skipped: ${String(error?.message || error).slice(0, 180)}`);
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(config.mediaConcurrency, mediaUrls.length) },
    () => worker()
  ));
  const completed = files.filter(Boolean);
  if (!completed.length) throw new Error("קישורי המדיה נמצאו, אך האתר חסם את הורדת הקבצים.");
  return completed;
}

export async function downloadGallery(url, config) {
  await assertPublicUrl(url);
  await fs.promises.mkdir(config.tempDir, { recursive: true });
  const jobDir = path.join(config.tempDir, crypto.randomUUID());
  await fs.promises.mkdir(jobDir);
  try {
    await run(config.galleryDlPath, [
      "--destination", jobDir,
      "--range", `1-${config.maxMediaItems}`,
      "--filesize-max", String(config.maxBytes),
      "--retries", "4",
      "--timeout", "25",
      "--no-part",
      "--no-mtime",
      "--no-input",
      "--", url
    ], { timeoutMs: 5 * 60_000 });
    const files = await listFilesRecursively(jobDir);
    if (!files.length) throw new Error("לא נמצאו תמונות או סרטונים בפוסט.");
    return files.slice(0, config.maxMediaItems);
  } catch (error) {
    await fs.promises.rm(jobDir, { recursive: true, force: true });
    await fs.promises.mkdir(jobDir, { recursive: true });
    if (/instagram\.com$/i.test(new URL(url).hostname)) {
      try {
        return await downloadInstagramEmbed(url, jobDir);
      } catch (fallbackError) {
        console.warn(`Instagram fallback failed: ${String(fallbackError?.message || fallbackError).slice(0, 180)}`);
      }
    }
    try {
      return await downloadPageMedia(url, jobDir, config);
    } catch (fallbackError) {
      await fs.promises.rm(jobDir, { recursive: true, force: true });
      throw fallbackError;
    }
  }
}

export async function cleanupFile(filePath) {
  await fs.promises.rm(path.dirname(filePath), { recursive: true, force: true });
}

export async function assertFileSize(filePath, maxBytes) {
  const stat = await fs.promises.stat(filePath);
  if (stat.size > maxBytes) {
    throw new Error(`הקובץ גדול מדי לשליחה ב-Telegram (${(stat.size / 1024 / 1024).toFixed(1)}MB).`);
  }
}
