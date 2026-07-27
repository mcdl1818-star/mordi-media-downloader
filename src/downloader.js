import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const PLATFORM_RULES = [
  ["YouTube", /(^|\.)youtube\.com$|^youtu\.be$/],
  ["Instagram", /(^|\.)instagram\.com$/],
  ["Facebook", /(^|\.)facebook\.com$|^fb\.watch$/],
  ["X/Twitter", /(^|\.)twitter\.com$|(^|\.)x\.com$/],
  ["TikTok", /(^|\.)tiktok\.com$/],
  ["Vimeo", /(^|\.)vimeo\.com$/]
];

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

export const validateYouTubeUrl = input => validateMediaUrl(input).url;

function run(command, args, { timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("הפעולה ארכה יותר מדי זמן ונעצרה."));
    }, timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-5000); });
    child.on("error", error => {
      clearTimeout(timer);
      reject(new Error(`לא ניתן להפעיל ${command}: ${error.message}`));
    });
    child.on("close", code => {
      clearTimeout(timer);
      code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `${command} הסתיים בקוד ${code}`));
    });
  });
}

export async function inspectUrl(url, config) {
  const output = await run(config.ytDlpPath, [
    "--no-playlist", "--dump-single-json", "--no-warnings", "--", url
  ], { timeoutMs: 60_000 });
  const info = JSON.parse(output);
  return {
    id: info.id,
    extractor: info.extractor_key || info.extractor || "Generic",
    title: info.title || "ללא כותרת",
    channel: info.channel || info.uploader || "לא ידוע",
    duration: Number(info.duration) || 0,
    webpageUrl: info.webpage_url || url
  };
}

export async function download(url, kind, config) {
  await fs.promises.mkdir(config.tempDir, { recursive: true });
  const jobDir = path.join(config.tempDir, crypto.randomUUID());
  await fs.promises.mkdir(jobDir);
  const outputTemplate = path.join(jobDir, "%(title).80B [%(id)s].%(ext)s");
  const common = [
    "--no-playlist", "--windows-filenames", "--trim-filenames", "120",
    "--ffmpeg-location", config.ffmpegPath,
    "-o", outputTemplate
  ];
  const mediaArgs = kind === "audio"
    ? ["-x", "--audio-format", "mp3", "--audio-quality", "5"]
    : ["-f", "bv*[height<=720]+ba/b[height<=720]/b", "--merge-output-format", "mp4"];
  await run(config.ytDlpPath, [...common, ...mediaArgs, "--", url]);
  const files = (await fs.promises.readdir(jobDir))
    .filter(name => !name.endsWith(".part") && !name.endsWith(".ytdl"))
    .map(name => path.join(jobDir, name));
  if (files.length !== 1) throw new Error("לא נמצא קובץ פלט יחיד לאחר ההורדה.");
  return files[0];
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

async function downloadInstagramEmbed(url, jobDir) {
  const source = new URL(url);
  const match = source.pathname.match(/^\/(?:p|reel)\/([^/]+)/);
  if (!match) throw new Error("לא ניתן לזהות את כתובת הפוסט באינסטגרם.");

  const response = await fetch(`https://www.instagram.com/p/${match[1]}/embed/captioned/`, {
    headers: {
      "user-agent": "Mozilla/5.0"
    }
  });
  if (!response.ok) throw new Error("אינסטגרם חסם זמנית את הגישה לפוסט.");

  const html = await response.text();
  const mediaUrls = [];
  const displayMarker = "\\\"display_url\\\":\\\"";
  let cursor = 0;
  while ((cursor = html.indexOf(displayMarker, cursor)) !== -1) {
    const start = cursor + displayMarker.length;
    const end = html.indexOf("\\\"", start);
    if (end === -1) break;
    const mediaUrl = decodeInstagramJsonString(html.slice(start, end));
    if (!mediaUrls.includes(mediaUrl)) mediaUrls.push(mediaUrl);
    cursor = end + 2;
  }
  if (!mediaUrls.length) throw new Error("לא נמצאה מדיה ציבורית בפוסט.");

  const files = [];
  for (let index = 0; index < mediaUrls.length; index += 1) {
    const mediaResponse = await fetch(mediaUrls[index], {
      headers: { "user-agent": "Mozilla/5.0", referer: "https://www.instagram.com/" }
    });
    if (!mediaResponse.ok) continue;
    const contentType = mediaResponse.headers.get("content-type") || "";
    const extension = contentType.includes("png") ? ".png" : contentType.includes("webp") ? ".webp" : ".jpg";
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
