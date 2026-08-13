import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeSocialCookieFile,
  createSocialUploadToken,
  verifySocialUploadToken,
  socialUploadTokenFingerprint
} from "../src/social-cookies.js";

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

test("keeps only an authenticated YouTube session", () => {
  const value = sanitizeSocialCookieFile([
    line(".youtube.com", 0, "LOGIN_INFO", "login-secret"),
    line(".youtube.com", 0, "__Secure-3PAPISID", "sapisid-secret"),
    line(".youtube.com", 0, "VISITOR_INFO1_LIVE", "visitor"),
    line(".google.com", 0, "SID", "unrelated-google-cookie"),
    line(".example.com", 0, "sessionid", "unrelated")
  ].join("\n"), "YouTube", 100);
  assert.match(value, /^# Netscape HTTP Cookie File\n/);
  assert.match(value, /\tLOGIN_INFO\tlogin-secret/);
  assert.match(value, /\t__Secure-3PAPISID\tsapisid-secret/);
  assert.doesNotMatch(value, /unrelated-google-cookie|unrelated$/m);
});

test("rejects logged-out, incomplete and expired YouTube cookies", () => {
  assert.throws(() => sanitizeSocialCookieFile(
    line(".youtube.com", 0, "__Secure-3PAPISID", "secret"), "YouTube", 100
  ), /Missing/);
  assert.throws(() => sanitizeSocialCookieFile(
    line(".youtube.com", 0, "LOGIN_INFO", "secret"), "YouTube", 100
  ), /Missing/);
  assert.throws(() => sanitizeSocialCookieFile([
    line(".youtube.com", 99, "LOGIN_INFO", "secret"),
    line(".youtube.com", 99, "SAPISID", "secret")
  ].join("\n"), "YouTube", 100), /valid|Missing/);
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

test("creates a platform-bound short-lived social session upload token", () => {
  const token = createSocialUploadToken("bot-secret", "YouTube", 1_000, 5_000);
  assert.equal(verifySocialUploadToken(token, "bot-secret", "YouTube", 5_999), true);
  assert.equal(verifySocialUploadToken(token, "bot-secret", "Facebook", 2_000), false);
  assert.equal(verifySocialUploadToken(token, "wrong", "YouTube", 2_000), false);
  assert.equal(verifySocialUploadToken(token, "bot-secret", "YouTube", 6_001), false);
  assert.match(socialUploadTokenFingerprint(token), /^[a-f0-9]{64}$/);
  assert.doesNotMatch(socialUploadTokenFingerprint(token), new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
