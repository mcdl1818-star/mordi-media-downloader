import test from "node:test";
import assert from "node:assert/strict";
import { validateCreatorUrl } from "../src/scanner.js";

test("accepts supported creator URLs", () => {
  assert.equal(validateCreatorUrl("https://www.youtube.com/@OpenAI").platform, "YouTube");
  assert.equal(validateCreatorUrl("https://www.instagram.com/openai/").platform, "Instagram");
  assert.equal(validateCreatorUrl("https://www.tiktok.com/@openai").platform, "TikTok");
  assert.equal(validateCreatorUrl("https://x.com/OpenAI").platform, "X");
});

test("rejects single publication URLs", () => {
  assert.throws(() => validateCreatorUrl("https://x.com/OpenAI/status/123"), /פרסום בודד/);
  assert.throws(() => validateCreatorUrl("https://www.instagram.com/reel/abc/"), /פרסום בודד/);
});
