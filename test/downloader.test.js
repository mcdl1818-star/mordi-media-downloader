import test from "node:test";
import assert from "node:assert/strict";
import {
  extractSupportedMediaUrl,
  validateMediaUrl
} from "../src/downloader.js";

test("recognizes all supported social platforms", () => {
  const cases = [
    ["https://youtu.be/jNQXAC9IVRw", "YouTube"],
    ["https://www.instagram.com/reel/example/", "Instagram"],
    ["https://www.facebook.com/watch/?v=123", "Facebook"],
    ["https://x.com/example/status/123", "X/Twitter"],
    ["https://www.tiktok.com/@example/video/123", "TikTok"],
    ["https://vimeo.com/123", "Vimeo"]
  ];
  for (const [url, platform] of cases) {
    assert.equal(validateMediaUrl(url).platform, platform);
  }
});

test("extracts a supported URL from surrounding Telegram text", () => {
  const result = extractSupportedMediaUrl("הנה הסרטון: https://youtu.be/jNQXAC9IVRw תודה");
  assert.equal(result.platform, "YouTube");
  assert.equal(result.url, "https://youtu.be/jNQXAC9IVRw");
});

test("rejects unsupported and insecure URLs", () => {
  assert.throws(() => validateMediaUrl("http://youtube.com/watch?v=1"));
  assert.throws(() => validateMediaUrl("https://example.com/video"));
});
