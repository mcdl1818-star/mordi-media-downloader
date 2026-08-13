import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_INSTANCES = ["https://dog.kittycat.boo/", "https://co.otomir23.me/"];
const SUPPORTED = new Set(["YouTube", "TikTok", "Facebook", "X"]);
const DIRECTORY_URL = "https://cobalt.directory/api/working?type=api";
const DIRECTORY_SERVICE = { YouTube: "youtube", TikTok: "tiktok", Facebook: "facebook", X: "twitter" };
let directoryCache = { expiresAt: 0, data: {} };

function checkedInstance(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

async function directoryInstances(platform, fetchImpl) {
  const now = Date.now();
  if (directoryCache.expiresAt > now) return directoryCache.data[DIRECTORY_SERVICE[platform]] || [];
  try {
    const response = await fetchImpl(DIRECTORY_URL, {
      headers: { "user-agent": "mordi-creator-monitor/1.0 (+https://github.com/mcdl1818-star/mordi-media-downloader)" },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`directory HTTP ${response.status}`);
    const payload = await response.json();
    directoryCache = {
      expiresAt: now + 10 * 60_000,
      data: payload && typeof payload.data === "object" ? payload.data : {}
    };
  } catch {
    directoryCache.expiresAt = now + 60_000;
  }
  return directoryCache.data[DIRECTORY_SERVICE[platform]] || [];
}

async function configuredInstances(platform, config, fetchImpl) {
  const supplied = Array.isArray(config.cobaltApiUrls) ? config.cobaltApiUrls : [];
  const discovered = supplied.length ? [] : await directoryInstances(platform, fetchImpl);
  const values = supplied.length ? supplied : [...DEFAULT_INSTANCES, ...discovered];
  const unique = new Map();
  for (const value of values) {
    const url = checkedInstance(value);
    if (url) unique.set(url.origin, url);
  }
  return [...unique.values()].slice(0, 8);
}

function safeTunnelUrl(raw, instance) {
  const url = new URL(String(raw || ""));
  if (url.protocol !== "https:" || url.origin !== instance.origin || !url.pathname.startsWith("/tunnel")) {
    throw new Error("Cobalt returned an untrusted media URL");
  }
  return url;
}

function extensionFor(filename, contentType) {
  const match = String(filename || "").toLowerCase().match(/\.([a-z0-9]{2,5})$/);
  if (match && ["mp4", "webm", "mkv", "mov"].includes(match[1])) return match[1];
  return String(contentType || "").includes("webm") ? "webm" : "mp4";
}

async function saveResponse(response, destination, maxBytes) {
  if (!response.ok || !response.body) throw new Error(`Cobalt media HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  const disposition = response.headers.get("content-disposition") || "";
  const declaredVideo = contentType.toLowerCase().startsWith("video/")
    || /filename\*?=.*\.(?:mp4|webm|mkv|mov)/i.test(disposition);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error("Cobalt media exceeds Telegram limit");
  const handle = await fs.promises.open(destination, "wx", 0o600);
  let bytes = 0;
  let checkedSignature = false;
  try {
    for await (const chunk of response.body) {
      if (!checkedSignature) {
        const head = Buffer.from(chunk).subarray(0, 32);
        const signatureVideo = head.subarray(4, 8).toString("ascii") === "ftyp"
          || (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3);
        if (!declaredVideo && !signatureVideo) throw new Error("Cobalt did not return video media");
        checkedSignature = true;
      }
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new Error("Cobalt media exceeds Telegram limit");
      await handle.write(chunk);
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.promises.rm(destination, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();
  if (!bytes) {
    await fs.promises.rm(destination, { force: true });
    throw new Error("Cobalt returned an empty video");
  }
  return destination;
}

export async function downloadCobaltVideo(item, config, dependencies = {}) {
  if (!SUPPORTED.has(item.platform)) throw new Error(`Cobalt does not support ${item.platform}`);
  const fetchImpl = dependencies.fetchImpl || fetch;
  const qualities = item.platform === "YouTube" ? ["360", "240"] : ["720", "480"];
  let lastError;
  for (const instance of await configuredInstances(item.platform, config, fetchImpl)) {
    for (const videoQuality of qualities) {
      let directory = "";
      try {
        const resolution = await fetchImpl(instance, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ url: item.url, videoQuality, filenameStyle: "basic" }),
          signal: AbortSignal.timeout(25_000)
        });
        if (!resolution.ok) throw new Error(`Cobalt API HTTP ${resolution.status}`);
        const data = await resolution.json();
        if (data.status !== "tunnel") throw new Error(`Cobalt unavailable: ${data.error?.code || data.status || "unknown"}`);
        const tunnel = safeTunnelUrl(data.url, instance);
        const media = await fetchImpl(tunnel, {
          redirect: "error",
          signal: AbortSignal.timeout(120_000)
        });
        const extension = extensionFor(data.filename, media.headers.get("content-type"));
        directory = path.join(config.tempDir, crypto.randomUUID());
        await fs.promises.mkdir(directory, { recursive: true });
        const destination = path.join(directory, `video.${extension}`);
        return await saveResponse(media, destination, config.maxBytes);
      } catch (error) {
        if (directory) await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
        lastError = error;
      }
    }
  }
  throw lastError || new Error("Cobalt video fallback is unavailable");
}

export async function downloadVxTwitterVideo(item, config, dependencies = {}) {
  const parsed = new URL(item.url);
  const match = parsed.pathname.match(/^\/([^/]+)\/status\/(\d+)/i);
  if (item.platform !== "X" || !match) throw new Error("Invalid X video URL");
  const fetchImpl = dependencies.fetchImpl || fetch;
  const endpoint = new URL(`https://api.vxtwitter.com/${encodeURIComponent(match[1])}/status/${match[2]}`);
  const metadata = await fetchImpl(endpoint, {
    headers: { accept: "application/json", "user-agent": "mordi-creator-monitor/1.0" },
    signal: AbortSignal.timeout(20_000)
  });
  if (!metadata.ok) throw new Error(`VxTwitter API HTTP ${metadata.status}`);
  const payload = await metadata.json();
  const candidates = (Array.isArray(payload.media_extended) ? payload.media_extended : [])
    .filter(value => value?.type === "video" && typeof value.url === "string")
    .sort((left, right) => (right.size?.width || 0) - (left.size?.width || 0));
  const mediaUrl = candidates[0]?.url || (Array.isArray(payload.mediaURLs) ? payload.mediaURLs.find(value => /\.mp4(?:\?|$)/i.test(value)) : "");
  let media;
  try { media = new URL(String(mediaUrl || "")); } catch {}
  if (!media || media.protocol !== "https:" || media.hostname !== "video.twimg.com" || !/\.mp4$/i.test(media.pathname)) {
    throw new Error("No trusted X video was found");
  }
  const directory = path.join(config.tempDir, crypto.randomUUID());
  await fs.promises.mkdir(directory, { recursive: true });
  try {
    const response = await fetchImpl(media, { redirect: "error", signal: AbortSignal.timeout(120_000) });
    return await saveResponse(response, path.join(directory, "video.mp4"), config.maxBytes);
  } catch (error) {
    await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
