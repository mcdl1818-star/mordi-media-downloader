import test from "node:test";
import assert from "node:assert/strict";
import { fitTelegramCaption } from "../src/telegram.js";

test("keeps captions that fit Telegram's limit", () => {
  assert.equal(fitTelegramCaption("כותרת קצרה"), "כותרת קצרה");
});

test("shortens long captions to Telegram's 1024-character limit", () => {
  const caption = `סרטון ארוך ${"א".repeat(1500)}`;
  const result = fitTelegramCaption(caption);

  assert.equal(Array.from(result).length, 1024);
  assert.ok(result.endsWith("…"));
});

test("does not split Unicode characters", () => {
  const result = fitTelegramCaption("🎬".repeat(1100));

  assert.equal(Array.from(result).length, 1024);
  assert.ok(result.endsWith("…"));
});
