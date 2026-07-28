import test from "node:test";
import assert from "node:assert/strict";
import { extractYouTubeId, selectInnertubeStreams } from "../src/youtube-innertube.js";

test("extracts YouTube video, short and share IDs", () => {
  assert.equal(extractYouTubeId("https://www.youtube.com/watch?v=jNQXAC9IVRw"), "jNQXAC9IVRw");
  assert.equal(extractYouTubeId("https://youtube.com/shorts/jNQXAC9IVRw"), "jNQXAC9IVRw");
  assert.equal(extractYouTubeId("https://youtu.be/jNQXAC9IVRw?t=2"), "jNQXAC9IVRw");
});

test("selects bounded H264 video and M4A audio streams", () => {
  const result = selectInnertubeStreams({
    adaptive_formats: [
      { url: "vp9-1080", has_video: true, height: 1080, bitrate: 10, mime_type: "video/webm; codecs=vp9" },
      { url: "h264-720", has_video: true, height: 720, bitrate: 8, mime_type: "video/mp4; codecs=avc1" },
      { url: "vp9-720", has_video: true, height: 720, bitrate: 12, mime_type: "video/webm; codecs=vp9" },
      { url: "opus", has_audio: true, has_video: false, bitrate: 20, mime_type: "audio/webm; codecs=opus" },
      { url: "m4a", has_audio: true, has_video: false, bitrate: 10, mime_type: "audio/mp4; codecs=mp4a" }
    ]
  }, 720);
  assert.equal(result.video.url, "h264-720");
  assert.equal(result.audio.url, "m4a");
});
