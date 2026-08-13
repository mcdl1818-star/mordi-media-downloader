import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeSocialCookieFile } from "../src/social-cookies.js";

function line(domain, expires, name, value = "value") {
  return `${domain}\tTRUE\t/\tTRUE\t${expires}\t${name}\t${value}`;
}

test("keeps only valid Facebook cookies and requires the authenticated pair", () => {
  const value = sanitizeSocialCookieFile([
    line(".facebook.com", 0, "c_user", "123"),
    line(".facebook.com", 0, "xs", "secret"),
    line(".example.com", 0, "unrelated")
  ].join("\n"), "Facebook", 100);
  assert.match(value, /c_user/);
  assert.match(value, /\txs\t/);
  assert.doesNotMatch(value, /unrelated/);
});

test("rejects incomplete X and TikTok sessions", () => {
  assert.throws(() => sanitizeSocialCookieFile(line(".x.com", 0, "auth_token"), "X"), /Missing/);
  assert.throws(() => sanitizeSocialCookieFile(line(".tiktok.com", 0, "tt_chain_token"), "TikTok"), /Missing/);
});

test("accepts complete X and TikTok sessions", () => {
  assert.match(sanitizeSocialCookieFile([
    line(".x.com", 0, "auth_token"),
    line(".x.com", 0, "ct0")
  ].join("\n"), "X"), /auth_token/);
  assert.match(sanitizeSocialCookieFile(line(".tiktok.com", 0, "sessionid"), "TikTok"), /sessionid/);
});
