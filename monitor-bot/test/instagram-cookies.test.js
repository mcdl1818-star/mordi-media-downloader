import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeInstagramCookies,
  instagramCookiesToNetscape,
  instagramCookiesFromNetscape,
  instagramCookiesFromExport,
  instagramCookieFingerprint
} from "../src/instagram-cookies.js";

const validCookies = [
  { domain: ".instagram.com", path: "/", name: "sessionid", value: "1234567890%3Avery-secret-session-value", secure: true, httpOnly: true, expires: 2_000_000_000 },
  { domain: "www.instagram.com", path: "/", name: "csrftoken", value: "csrf-value", secure: true },
  { domain: ".example.com", path: "/", name: "do_not_copy", value: "outside-domain" }
];

test("keeps only valid Instagram cookies and requires sessionid", () => {
  const cookies = normalizeInstagramCookies(validCookies);
  assert.equal(cookies.length, 2);
  assert.equal(cookies.some(cookie => cookie.name === "do_not_copy"), false);
  assert.throws(() => normalizeInstagramCookies(validCookies.filter(cookie => cookie.name !== "sessionid")));
  assert.throws(() => normalizeInstagramCookies([]));
});

test("round-trips a private Instagram Netscape cookie file", () => {
  const netscape = instagramCookiesToNetscape(validCookies);
  assert.match(netscape, /#HttpOnly_\.instagram\.com/);
  assert.doesNotMatch(netscape, /outside-domain/);
  const restored = instagramCookiesFromNetscape(netscape);
  assert.equal(restored.find(cookie => cookie.name === "sessionid").httpOnly, true);
  assert.equal(instagramCookieFingerprint(restored), instagramCookieFingerprint(netscape));
});

test("accepts Firefox JSON exports while discarding every non-Instagram cookie", () => {
  const cookies = instagramCookiesFromExport(JSON.stringify(validCookies));
  assert.equal(cookies.length, 2);
  assert.deepEqual(cookies.map(cookie => cookie.name).sort(), ["csrftoken", "sessionid"]);
});

test("accepts Firefox cookies.txt Netscape exports", () => {
  const netscape = instagramCookiesToNetscape(validCookies);
  assert.equal(instagramCookiesFromExport(Buffer.from(netscape)).some(cookie => cookie.name === "sessionid"), true);
});

test("rejects control characters and oversized session values", () => {
  assert.throws(() => normalizeInstagramCookies([{ ...validCookies[0], value: "bad\nvalue-with-enough-characters" }]));
  assert.throws(() => normalizeInstagramCookies([{ ...validCookies[0], value: "x".repeat(4097) }]));
});
