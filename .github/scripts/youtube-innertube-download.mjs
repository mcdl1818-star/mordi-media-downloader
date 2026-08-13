import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Innertube } from "youtubei.js";

const sourceUrl = process.env.SOURCE_URL || "";
const mediaKind = process.env.MEDIA_KIND === "audio" ? "audio" : "video";
const maxHeight = Math.max(144, Math.min(480, Number(process.env.MAX_HEIGHT) || 480));
const audioBitrate = Math.max(48, Math.min(192, Number(process.env.AUDIO_BITRATE) || 128));
const maxBytes = 48 * 1024 * 1024;
const downloadLimit = 256 * 1024 * 1024;
const outputDirectory = path.resolve("output");

function videoId(input) {
  const url = new URL(input);
  if (url.hostname === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] || "";
  if (/^\/(?:shorts|live)\//.test(url.pathname)) return url.pathname.split("/").filter(Boolean)[1] || "";
  return url.searchParams.get("v") || "";
}

function isMp4(format) {
  return String(format?.mime_type || "").includes("mp4");
}

function isH264(format) {
  return /avc1/i.test(String(format?.mime_type || ""));
}

function contentLength(format) {
  return Number(format?.content_length || 0);
}

function chooseProgressive(streamingData) {
  const candidates = [...(streamingData?.formats || [])]
    .filter(format => format.has_video && format.has_audio && Number(format.height) <= maxHeight)
    .sort((left, right) =>
      Number(isMp4(right)) - Number(isMp4(left))
      || Number(isH264(right)) - Number(isH264(left))
      || Number(right.height) - Number(left.height)
      || Number(right.bitrate) - Number(left.bitrate)
    );
  return candidates.find(format => !contentLength(format) || contentLength(format) <= maxBytes) || candidates.at(-1) || null;
}

function chooseAdaptive(streamingData) {
  const formats = [...(streamingData?.adaptive_formats || [])].filter(format => !format?.drm_families);
  const audioCandidates = formats
    .filter(format => format.has_audio && !format.has_video)
    .sort((left, right) =>
      Number(isMp4(right)) - Number(isMp4(left))
      || Number(left.bitrate) - Number(right.bitrate)
    );
  const audio = audioCandidates[0] || null;
  const videos = formats
    .filter(format => format.has_video && !format.has_audio && Number(format.height) <= maxHeight)
    .sort((left, right) =>
      Number(isMp4(right)) - Number(isMp4(left))
      || Number(isH264(right)) - Number(isH264(left))
      || Number(right.height) - Number(left.height)
      || Number(right.bitrate) - Number(left.bitrate)
    );
  const available = maxBytes - contentLength(audio) - 1024 * 1024;
  const video = videos.find(format => !contentLength(format) || contentLength(format) <= available) || videos.at(-1) || null;
  return { video, audio };
}

function chooseAudio(streamingData) {
  return [...(streamingData?.adaptive_formats || [])]
    .filter(format => format.has_audio && !format.has_video && !format?.drm_families)
    .sort((left, right) =>
      Number(isMp4(right)) - Number(isMp4(left))
      || Number(right.bitrate) - Number(left.bitrate)
    )
    .find(format => !contentLength(format) || contentLength(format) <= downloadLimit) || null;
}

async function saveStream(stream, destination, limit = downloadLimit) {
  let received = 0;
  const bounded = new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > limit) throw new Error("Innertube media exceeds the worker download limit");
      controller.enqueue(chunk);
    }
  });
  await pipeline(Readable.fromWeb(stream.pipeThrough(bounded)), fs.createWriteStream(destination, { mode: 0o600 }));
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`${command} failed (${code})`)));
  });
}

const id = videoId(sourceUrl);
if (!id) throw new Error("Invalid YouTube URL");
await fs.promises.mkdir(outputDirectory, { recursive: true });

// The Android player currently supplies usable progressive URLs without a
// browser cookie or account. VideoInfo.download adds the required cpn and
// byte-range parameters; fetching Format.url directly results in HTTP 403.
const client = await Innertube.create({ retrieve_player: true, generate_session_locally: true });
const info = await client.getBasicInfo(id, { client: "ANDROID" });
if (info?.playability_status?.status !== "OK") {
  throw new Error(`Innertube unavailable: ${info?.playability_status?.reason || "unknown"}`);
}

let output;
if (mediaKind === "audio") {
  const audio = chooseAudio(info.streaming_data);
  if (!audio) throw new Error("Innertube returned no usable audio stream");
  const source = path.join(outputDirectory, `${id}.audio-source`);
  await saveStream(await info.download({ itag: audio.itag, type: "audio", format: "any" }), source);
  output = path.join(outputDirectory, `${id}.mp3`);
  await run("ffmpeg", ["-y", "-i", source, "-vn", "-c:a", "libmp3lame", "-b:a", `${audioBitrate}k`, output]);
  await fs.promises.rm(source, { force: true });
} else {
  output = path.join(outputDirectory, `${id}.mp4`);
  const progressive = chooseProgressive(info.streaming_data);
  if (progressive && (!contentLength(progressive) || contentLength(progressive) <= maxBytes)) {
    await saveStream(
      await info.download({ itag: progressive.itag, type: "video+audio", format: "any" }),
      output,
      maxBytes
    );
  } else {
    const { video, audio } = chooseAdaptive(info.streaming_data);
    if (!video || !audio) throw new Error("Innertube returned no usable streams");
    const videoFile = path.join(outputDirectory, `${id}.video-source`);
    const audioFile = path.join(outputDirectory, `${id}.audio-source`);
    await Promise.all([
      saveStream(await info.download({ itag: video.itag, type: "video", format: "any" }), videoFile),
      saveStream(await info.download({ itag: audio.itag, type: "audio", format: "any" }), audioFile)
    ]);
    await run("ffmpeg", [
      "-y", "-i", videoFile, "-i", audioFile,
      "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac",
      "-movflags", "+faststart", output
    ]);
    await Promise.all([
      fs.promises.rm(videoFile, { force: true }),
      fs.promises.rm(audioFile, { force: true })
    ]);
  }
}

const size = (await fs.promises.stat(output)).size;
if (size > maxBytes) throw new Error("Innertube result exceeds Telegram limit");
await fs.promises.writeFile(path.join(os.tmpdir(), "final-path.txt"), `${output}\n`);
const channelId = info.basic_info?.channel_id;
if (channelId) await fs.promises.writeFile(path.join(os.tmpdir(), "creator-url.txt"), `https://www.youtube.com/channel/${channelId}\n`);
console.log(`Innertube fallback downloaded ${id} (${size} bytes)`);
