import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validateCreatorUrl,
  parseYouTubeFeed,
  normalizeItems,
  instagramSessionCookieExpired,
  isLikelyAuthenticationFailure,
  shouldDeferInstagramScan
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
  assert.equal(isLikelyAuthenticationFailure(new Error("HTTP 403")), true);
  assert.equal(isLikelyAuthenticationFailure(new Error("request timed out")), false);
});

test("defers only very recent Instagram scans to avoid account throttling", () => {
  const now = Date.parse("2026-08-13T07:00:00Z");
  const recent = { platform: "Instagram", lastCheckedAt: "2026-08-13T06:55:00Z" };
  const old = { platform: "Instagram", lastCheckedAt: "2026-08-13T06:50:00Z" };
  assert.equal(shouldDeferInstagramScan(recent, 10 * 60_000, now), true);
  assert.equal(shouldDeferInstagramScan(old, 10 * 60_000, now), false);
  assert.equal(shouldDeferInstagramScan({ ...recent, platform: "YouTube" }, 10 * 60_000, now), false);
  assert.equal(shouldDeferInstagramScan({ ...old, lastError: "DEFERRED:Instagram:RATE_LIMIT" }, 10 * 60_000, now), true);
  assert.equal(shouldDeferInstagramScan({ ...old, lastCheckedAt: "2026-08-13T06:29:00Z", lastError: "DEFERRED:Instagram:RATE_LIMIT" }, 10 * 60_000, now), false);
});

test("recognizes temporary Instagram deferrals as non-authentication failures", () => {
  assert.equal(isLikelyAuthenticationFailure(new Error("DEFERRED:Instagram:RATE_LIMIT")), false);
});

test("rejects single publication URLs", () => {
  assert.throws(() => validateCreatorUrl("https://x.com/OpenAI/status/123"), /פרסום בודד/);
  assert.throws(() => validateCreatorUrl("https://www.instagram.com/reel/abc/"), /פרסום בודד/);
});
