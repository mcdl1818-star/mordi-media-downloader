import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { once } from "node:events";

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
  "--extractor-args", "youtubepot-bgutilscript:server_home=/opt/bgutil/server",
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
  if (/confirm you.?re not a bot|unusual traffic|temporarily blocked/i.test(message)) return false;
  return /sign.?in|login|age.?restrict|members.?only|private video|authentication/i.test(message);
}

export function validateMediaUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("הקישור אינו כתובת URL תקינה.");
  }
  const platform = PLATFORM_RULES.find(([, rule]) => rule.test(url.hostname.toLowerCase()));
  if (url.protocol !== "https:" || !platform) {
    throw new Error("הקישור אינו מפלטפורמה נתמכת.");
  }
  return { url: url.toString(), platform: platform[0] };
}

export function extractSupportedMediaUrl(input) {
  const candidates = String(input || "").match(/https:\/\/[^\s<>"']+/g) || [];
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

async function writeResponseToFile(response, destination, onProgress) {
  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body) {
    await fs.promises.writeFile(destination, Buffer.from(await response.arrayBuffer()));
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

export async function inspectUrl(url, config) {
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
    if (!/(^|\.)vimeo\.com$/i.test(new URL(url).hostname)) throw error;
    const vimeo = await getVimeoConfig(url);
    info = {
      id: String(vimeo.video?.id || ""),
      extractor_key: "Vimeo",
      title: vimeo.video?.title,
      uploader: vimeo.video?.owner?.name,
      duration: vimeo.video?.duration,
      webpage_url: url
    };
  }
  return {
    id: info.id,
    extractor: info.extractor_key || info.extractor || "Generic",
    title: info.title || "ללא כותרת",
    channel: info.channel || info.uploader || "לא ידוע",
    duration: Number(info.duration) || 0,
    webpageUrl: info.webpage_url || url
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
  await fs.promises.mkdir(config.tempDir, { recursive: true });
  const jobDir = path.join(config.tempDir, crypto.randomUUID());
  await fs.promises.mkdir(jobDir);
  const outputTemplate = path.join(jobDir, "%(title).80B [%(id)s].%(ext)s");
  const common = [
    "--no-playlist", "--windows-filenames", "--trim-filenames", "120",
    "--concurrent-fragments", "4",
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

export async function downloadGallery(url, config) {
  await fs.promises.mkdir(config.tempDir, { recursive: true });
  const jobDir = path.join(config.tempDir, crypto.randomUUID());
  await fs.promises.mkdir(jobDir);
  try {
    await run(config.galleryDlPath, [
      "--destination", jobDir,
      "--no-part",
      "--no-mtime",
      "--", url
    ]);
    const files = await listFilesRecursively(jobDir);
    if (!files.length) throw new Error("לא נמצאו תמונות או סרטונים בפוסט.");
    return files;
  } catch (error) {
    if (/instagram\.com$/i.test(new URL(url).hostname)) {
      try {
        return await downloadInstagramEmbed(url, jobDir);
      } catch (fallbackError) {
        await fs.promises.rm(jobDir, { recursive: true, force: true });
        throw fallbackError;
      }
    }
    await fs.promises.rm(jobDir, { recursive: true, force: true });
    throw error;
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
