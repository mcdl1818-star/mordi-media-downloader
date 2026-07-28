import { Innertube } from "youtubei.js";

let clientPromise;

export function extractYouTubeId(input) {
  const url = new URL(input);
  if (url.hostname === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] || "";
  if (url.pathname.startsWith("/shorts/") || url.pathname.startsWith("/live/")) {
    return url.pathname.split("/").filter(Boolean)[1] || "";
  }
  return url.searchParams.get("v") || "";
}

async function getClient() {
  clientPromise ||= Innertube.create({
    retrieve_player: false,
    generate_session_locally: true
  });
  return clientPromise;
}

function failForPlayability(info) {
  const playability = info?.playability_status;
  if (playability?.status === "OK") return;
  const reason = playability?.reason || playability?.error_screen?.reason?.text || "YouTube Innertube unavailable";
  if (/bot|sign.?in/i.test(reason)) throw new Error(`Innertube: Sign in to confirm you're not a bot (${reason})`);
  throw new Error(`Innertube: ${reason}`);
}

export async function inspectYouTubeInnertube(input) {
  const id = extractYouTubeId(input);
  if (!id) throw new Error("לא ניתן לזהות את מזהה סרטון YouTube.");
  const client = await getClient();
  const info = await client.getBasicInfo(id, { client: "IOS" });
  failForPlayability(info);
  const basic = info.basic_info || {};
  return {
    id,
    title: basic.title || "YouTube video",
    channel: basic.author || "YouTube",
    duration: Number(basic.duration) || 0,
    description: basic.short_description || "",
    thumbnail: basic.thumbnail?.at(-1)?.url || "",
    streamingData: info.streaming_data
  };
}

function hasCodec(format, codec) {
  return String(format?.mime_type || "").toLowerCase().includes(codec);
}

export function selectInnertubeStreams(streamingData, maxHeight = 720) {
  const formats = [...(streamingData?.adaptive_formats || [])]
    .filter(format => format?.url && !format?.drm_families);
  const height = Number(maxHeight) || 720;
  const videoCandidates = formats
    .filter(format => format.has_video && Number(format.height) <= height)
    .sort((a, b) =>
      Number(hasCodec(b, "avc1")) - Number(hasCodec(a, "avc1"))
      || Number(b.height) - Number(a.height)
      || Number(b.bitrate) - Number(a.bitrate)
    );
  const audioCandidates = formats
    .filter(format => format.has_audio && !format.has_video)
    .sort((a, b) =>
      Number(hasCodec(b, "mp4a")) - Number(hasCodec(a, "mp4a"))
      || Number(b.bitrate) - Number(a.bitrate)
    );
  return {
    video: videoCandidates[0] || null,
    audio: audioCandidates[0] || null
  };
}
