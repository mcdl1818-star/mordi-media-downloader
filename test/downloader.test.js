import test from "node:test";
import assert from "node:assert/strict";
import { validateMediaUrl } from "../src/downloader.js";

test("accepts supported media URLs and identifies their platform", () => {
  assert.equal(validateMediaUrl("https://youtu.be/abc123").platform, "YouTube");
  assert.equal(validateMediaUrl("https://www.instagram.com/reel/abc").platform, "Instagram");
  assert.equal(validateMediaUrl("https://facebook.com/watch/?v=1").platform, "Facebook");
  assert.equal(validateMediaUrl("https://x.com/user/status/1").platform, "X/Twitter");
  assert.equal(validateMediaUrl("https://www.tiktok.com/@user/video/1").platform, "TikTok");
  assert.equal(validateMediaUrl("https://vimeo.com/123").platform, "Vimeo");
});

test("rejects unsupported and non-HTTPS URLs", () => {
  assert.throws(() => validateMediaUrl("https://example.com/video"), /נתמכת/);
  assert.throws(() => validateMediaUrl("http://youtube.com/watch?v=x"), /נתמכת/);
  assert.throws(() => validateMediaUrl("not a url"), /URL/);
});
