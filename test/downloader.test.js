import test from "node:test";
import assert from "node:assert/strict";
import {
  extractSupportedMediaUrl,
  requiresYouTubeAuthentication,
  validateMediaUrl,
  videoFormatForHeight
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

test("builds bounded video format selectors with a safe fallback", () => {
  assert.match(videoFormatForHeight(480), /height<=480/);
  assert.match(videoFormatForHeight(1080), /height<=1080/);
  assert.match(videoFormatForHeight(999), /height<=720/);
  assert.ok(videoFormatForHeight(480).endsWith("/worst[height<=480]"));
});

test("uses account cookies only for content that actually requires authentication", () => {
  assert.equal(requiresYouTubeAuthentication(new Error("This is members-only content. Sign in")), true);
  assert.equal(requiresYouTubeAuthentication(new Error("Sign in to confirm you're not a bot")), false);
  assert.equal(requiresYouTubeAuthentication(new Error("HTTP Error 403: Forbidden")), false);
});
