import test from "node:test";
import assert from "node:assert/strict";
import { downloadSelection, formatKeyboard } from "../src/formats.js";

test("maps every video quality callback to a bounded height", () => {
  assert.deepEqual(downloadSelection("v360"), { kind: "video", height: 360, label: "360p" });
  assert.deepEqual(downloadSelection("v480"), { kind: "video", height: 480, label: "480p" });
  assert.deepEqual(downloadSelection("v720"), { kind: "video", height: 720, label: "720p" });
  assert.deepEqual(downloadSelection("v1080"), { kind: "video", height: 1080, label: "1080p" });
});

test("builds compact Telegram buttons for qualities, MP3 and all media", () => {
  const keyboard = formatKeyboard("abc123");
  const buttons = keyboard.inline_keyboard.flat();

  assert.deepEqual(buttons.map(button => button.text), [
    "🎬 360p", "🎬 480p", "🎬 720p", "🎬 1080p",
    "🎵 MP3 128k", "🎧 MP3 320k",
    "🔇 720p ללא קול", "📝 720p + כתוביות",
    "🖼 כל המדיה"
  ]);
  assert.ok(buttons.every(button => button.callback_data.length <= 64));
});

test("rejects unknown callback kinds", () => {
  assert.equal(downloadSelection("video"), null);
  assert.equal(downloadSelection("v999"), null);
});

test("maps the all-media action", () => {
  assert.deepEqual(downloadSelection("gallery"), { kind: "gallery", height: null, label: "גלריה" });
});

test("maps Seal and Cobalt inspired advanced actions", () => {
  assert.deepEqual(downloadSelection("a128"), {
    kind: "audio", height: null, label: "MP3 128k", audioFormat: "mp3", audioBitrate: 128
  });
  assert.deepEqual(downloadSelection("a320"), {
    kind: "audio", height: null, label: "MP3 320k", audioFormat: "mp3", audioBitrate: 320
  });
  assert.deepEqual(downloadSelection("mute720"), {
    kind: "video", height: 720, label: "720p ללא קול", mute: true
  });
  assert.deepEqual(downloadSelection("sub720"), {
    kind: "video", height: 720, label: "720p + כתוביות", subtitles: true
  });
});
