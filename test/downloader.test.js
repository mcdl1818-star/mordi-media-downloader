import test from "node:test";
import assert from "node:assert/strict";
import {
  extractSupportedMediaUrl,
  extractMediaUrlsFromHtml,
  isYouTubeBlockedError,
  isLikelyDirectMediaUrl,
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

test("accepts arbitrary public HTTPS sites and rejects insecure/private URLs", () => {
  assert.equal(validateMediaUrl("https://example.com/article").platform, "אתר כללי");
  assert.throws(() => validateMediaUrl("http://youtube.com/watch?v=1"));
  assert.throws(() => validateMediaUrl("https://localhost/video"));
  assert.throws(() => validateMediaUrl("https://127.0.0.1/video"));
  assert.throws(() => validateMediaUrl("https://192.168.1.5/photo.jpg"));
});

test("extracts and deduplicates common media references from HTML", () => {
  const html = `
    <meta property="og:image" content="/cover.jpg">
    <meta content="https://cdn.example.com/movie.mp4" property="og:video">
    <img data-src="/cover.jpg">
    <video><source src="/clip.webm"></video>
    <img src="data:image/png;base64,ignored">
  `;
  assert.deepEqual(extractMediaUrlsFromHtml(html, "https://example.com/post", 10), [
    "https://example.com/cover.jpg",
    "https://cdn.example.com/movie.mp4",
    "https://example.com/clip.webm"
  ]);
});

test("recognizes direct media links for the fast inspection path", () => {
  assert.equal(isLikelyDirectMediaUrl("https://cdn.example.com/photo.JPG?size=large"), true);
  assert.equal(isLikelyDirectMediaUrl("https://cdn.example.com/video.mp4"), true);
  assert.equal(isLikelyDirectMediaUrl("https://example.com/article/123"), false);
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

test("detects YouTube anti-bot blocks for the cooldown circuit breaker", () => {
  assert.equal(isYouTubeBlockedError(new Error("Sign in to confirm you’re not a bot")), true);
  assert.equal(isYouTubeBlockedError(new Error("HTTP Error 403: Forbidden")), false);
});
