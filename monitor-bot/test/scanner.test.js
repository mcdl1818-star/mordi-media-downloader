import test from "node:test";
import assert from "node:assert/strict";
import { validateCreatorUrl, parseYouTubeFeed } from "../src/scanner.js";

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

test("rejects single publication URLs", () => {
  assert.throws(() => validateCreatorUrl("https://x.com/OpenAI/status/123"), /פרסום בודד/);
  assert.throws(() => validateCreatorUrl("https://www.instagram.com/reel/abc/"), /פרסום בודד/);
});
