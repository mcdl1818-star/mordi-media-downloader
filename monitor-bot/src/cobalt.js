import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_INSTANCES = ["https://co.otomir23.me/"];
const SUPPORTED = new Set(["YouTube", "TikTok", "Facebook", "X"]);

function configuredInstances(config) {
  const supplied = Array.isArray(config.cobaltApiUrls) ? config.cobaltApiUrls : [];
  const values = supplied.length ? supplied : DEFAULT_INSTANCES;
  return [...new Set(values.map(value => String(value || "").trim()).filter(Boolean))]
    .map(value => new URL(value))
    .filter(url => url.protocol === "https:" && !url.username && !url.password);
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
  for (const instance of configuredInstances(config)) {
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
