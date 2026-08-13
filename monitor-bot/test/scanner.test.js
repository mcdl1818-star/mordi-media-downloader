import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validateCreatorUrl,
  classifySupportedUrl,
  extractSupportedUrls,
  creatorUrlFromMediaUrl,
  mediaItemFromUrl,
  parseYouTubeFeed,
  normalizeItems,
  instagramSessionCookieExpired,
  isLikelyAuthenticationFailure,
  shouldDeferInstagramScan,
  scanCreator,
  youtubeCreatorFromOembed
} from "../src/scanner.js";

test("accepts supported creator URLs", () => {
  assert.equal(validateCreatorUrl("https://www.youtube.com/@OpenAI").platform, "YouTube");
  assert.equal(validateCreatorUrl("https://www.instagram.com/openai/").platform, "Instagram");
  assert.equal(validateCreatorUrl("https://www.tiktok.com/@openai").platform, "TikTok");
  assert.equal(validateCreatorUrl("https://x.com/OpenAI").platform, "X");
});

test("parses the official YouTube channel feed without an API token", () => {
  const xml = `<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><entry><yt:videoId>abc123</yt:videoId><title>A &amp; B</title><published>2026-08-10T10:00:00+00:00</published></entry></feed>`;
  assert.deepEqual(parseYouTubeFeed(xml, 5), [{
    id: "YouTube:abc123",
    url: "https://www.youtube.com/watch?v=abc123",
    title: "A & B",
    timestamp: 1786356000,
    platform: "YouTube"
  }]);
});

test("normalizes each Instagram story with its stable ID and direct media", () => {
  assert.deepEqual(normalizeItems([{
    media_id: "123456789",
    shortcode: "ABC",
    type: "story",
    expires: "2026-08-11T11:00:00Z",
    username: "creator",
    date: "2026-08-10T11:00:00Z",
    video_url: "https://cdn.example/story.mp4"
  }], "Instagram"), [{
    id: "Instagram:123456789",
    url: "https://www.instagram.com/stories/creator/123456789/",
    title: "סטורי חדש",
    timestamp: 1786359600,
    platform: "Instagram",
    directMediaUrl: "https://cdn.example/story.mp4",
    mediaKind: "video"
  }]);
});

test("classifies profile links separately from individual media", () => {
  assert.equal(classifySupportedUrl("https://www.instagram.com/openai/").kind, "profile");
  assert.equal(classifySupportedUrl("https://www.instagram.com/reel/ABC/").kind, "media");
  assert.equal(classifySupportedUrl("https://www.facebook.com/reel/123").kind, "media");
  assert.equal(classifySupportedUrl("https://www.tiktok.com/@creator/video/123").kind, "media");
  assert.equal(classifySupportedUrl("https://x.com/creator/status/123").kind, "media");
});

test("classifies Facebook posts and TikTok photo posts as individual media", () => {
  assert.equal(classifySupportedUrl("https://www.facebook.com/example/posts/123").kind, "media");
  assert.equal(classifySupportedUrl("https://www.tiktok.com/@example/photo/123456789").kind, "media");
});

test("extracts obvious creator profiles from individual media URLs", () => {
  assert.deepEqual(creatorUrlFromMediaUrl("https://www.tiktok.com/@creator/video/123"), {
    url: "https://www.tiktok.com/@creator/",
    platform: "TikTok"
  });
  assert.deepEqual(creatorUrlFromMediaUrl("https://x.com/creator/status/123"), {
    url: "https://x.com/creator/",
    platform: "X"
  });
  assert.equal(creatorUrlFromMediaUrl("https://www.instagram.com/reel/ABC/"), null);
});

test("resolves a YouTube creator through the public oEmbed endpoint", async () => {
  const creator = await youtubeCreatorFromOembed("https://youtu.be/K3w6dsQnXXU", async url => {
    assert.equal(new URL(url).hostname, "www.youtube.com");
    return new Response(JSON.stringify({ author_url: "https://www.youtube.com/@dj_Avi_Kay" }), {
      headers: { "content-type": "application/json" }
    });
  });
  assert.deepEqual(creator, { url: "https://www.youtube.com/@dj_Avi_Kay", platform: "YouTube" });
});

test("creates a downloadable item from a supported media link", () => {
  const item = mediaItemFromUrl("קישור: https://x.com/creator/status/123");
  assert.equal(item.platform, "X");
  assert.equal(item.url, "https://x.com/creator/status/123");
  assert.match(item.id, /^X:manual:/);
});

test("extracts a batch of supported profile links from one message", () => {
  const links = extractSupportedUrls(`
    https://www.instagram.com/openai/
    unrelated https://example.com/nope
    https://www.tiktok.com/@openai
  `);
  assert.deepEqual(links.map(item => [item.platform, item.kind]), [
    ["Instagram", "profile"],
    ["TikTok", "profile"]
  ]);
});

test("detects a missing or expired Instagram session cookie", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-cookie-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "cookies.txt");
  fs.writeFileSync(file, ".instagram.com\tTRUE\t/\tTRUE\t100\tsessionid\t12345678901234567890\n");
  assert.equal(instagramSessionCookieExpired(file, 101), true);
  assert.equal(instagramSessionCookieExpired(file, 99), false);
  fs.writeFileSync(file, ".instagram.com\tTRUE\t/\tTRUE\t0\tcsrftoken\tvalue\n");
  assert.equal(instagramSessionCookieExpired(file, 99), true);
});

test("recognizes authentication failures without classifying timeouts as expired sessions", () => {
  assert.equal(isLikelyAuthenticationFailure(new Error("login_required")), true);
  assert.equal(isLikelyAuthenticationFailure(new Error("HTTP 401")), true);
  assert.equal(isLikelyAuthenticationFailure(new Error("HTTP 403")), false);
  assert.equal(isLikelyAuthenticationFailure(new Error("request timed out")), false);
});

test("defers Instagram scans for the full safe interval or an explicit next-check time", () => {
  const now = Date.parse("2026-08-13T07:00:00Z");
  const recent = { platform: "Instagram", lastCheckedAt: "2026-08-13T06:45:00Z" };
  const old = { platform: "Instagram", lastCheckedAt: "2026-08-13T06:39:00Z" };
  assert.equal(shouldDeferInstagramScan(recent, 20 * 60_000, now), true);
  assert.equal(shouldDeferInstagramScan(old, 20 * 60_000, now), false);
  assert.equal(shouldDeferInstagramScan({ ...recent, platform: "YouTube" }, 20 * 60_000, now), false);
  assert.equal(shouldDeferInstagramScan({ ...old, lastError: "DEFERRED:Instagram:RATE_LIMIT" }, 20 * 60_000, now), true);
  assert.equal(shouldDeferInstagramScan({ ...old, lastCheckedAt: "2026-08-13T04:59:00Z", lastError: "DEFERRED:Instagram:RATE_LIMIT" }, 20 * 60_000, now), false);
  assert.equal(shouldDeferInstagramScan({ platform: "Instagram", nextInstagramCheckAt: "2026-08-13T07:01:00Z" }, 20 * 60_000, now), true);
  assert.equal(shouldDeferInstagramScan({ platform: "Instagram", nextInstagramCheckAt: "2026-08-13T06:59:00Z" }, 20 * 60_000, now), false);
});

test("recognizes temporary Instagram deferrals as non-authentication failures", () => {
  assert.equal(isLikelyAuthenticationFailure(new Error("DEFERRED:Instagram:RATE_LIMIT")), false);
});

test("uses a valid private Instagram session before considering an expired web cookie", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-private-priority-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const expiredCookie = path.join(directory, "instagram.txt");
  fs.writeFileSync(expiredCookie, ".instagram.com\tTRUE\t/\tTRUE\t1\tsessionid\t12345678901234567890\n");
  const creator = { platform: "Instagram", url: "https://www.instagram.com/example/" };
  let privateCalls = 0;
  const items = await scanCreator(creator, {
    instagramSessionPath: path.join(directory, "private.json"),
    platformCookies: { Instagram: expiredCookie },
    cookiesPath: "",
    maxItems: 3
  }, {
    scanInstagramSession: async () => {
      privateCalls += 1;
      return [{ id: "private:1", platform: "Instagram", url: "https://www.instagram.com/reel/one/" }];
    },
    scanYtDlp: async () => assert.fail("web yt-dlp fallback should not run"),
    scanGalleryDl: async () => assert.fail("web gallery fallback should not run"),
    scanProfileHtml: async () => assert.fail("web HTML fallback should not run")
  });
  assert.equal(privateCalls, 1);
  assert.equal(items[0].id, "private:1");
});

test("Facebook monitoring never accepts gallery photo results as Reel updates", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-facebook-video-only-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cookie = path.join(directory, "facebook.txt");
  fs.writeFileSync(cookie, ".facebook.com\tTRUE\t/\tTRUE\t0\tc_user\t123\n");
  let galleryCalls = 0;
  await assert.rejects(() => scanCreator({ platform: "Facebook", url: "https://www.facebook.com/example/" }, {
    platformCookies: { Facebook: cookie }, cookiesPath: "", maxItems: 3
  }, {
    scanProfileHtml: async () => [],
    scanGalleryDl: async () => {
      galleryCalls += 1;
      return [{ id: "photo", platform: "Facebook", url: "https://cdn.example/photo.jpg" }];
    }
  }), /לא נמצאו Reels/);
  assert.equal(galleryCalls, 0);
});

test("rejects single publication URLs", () => {
  assert.throws(() => validateCreatorUrl("https://x.com/OpenAI/status/123"), /פרסום בודד/);
  assert.throws(() => validateCreatorUrl("https://www.instagram.com/reel/abc/"), /פרסום בודד/);
});
