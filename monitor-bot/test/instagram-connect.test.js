import test from "node:test";
import assert from "node:assert/strict";
import {
  createInstagramConnectToken,
  verifyInstagramConnectToken,
  instagramUsernameFromConnectToken,
  normalizeInstagramUsername,
  encryptInstagramSession,
  decryptInstagramSession,
  instagramConnectPage
} from "../src/instagram-connect.js";

test("Instagram username accepts a handle or profile URL", () => {
  assert.equal(normalizeInstagramUsername(" @Example.User "), "Example.User");
  assert.equal(normalizeInstagramUsername("https://www.instagram.com/example_user/?hl=he"), "example_user");
  assert.equal(normalizeInstagramUsername("instagram.com/example_user/"), "example_user");
  assert.equal(normalizeInstagramUsername("person@example.com"), "person@example.com");
});

test("creates a short-lived Instagram connection token for one Telegram user", () => {
  const token = createInstagramConnectToken("secret", "123", 1_000, 5_000);
  assert.equal(verifyInstagramConnectToken(token, "secret", "123", 5_999), true);
  assert.equal(verifyInstagramConnectToken(token, "secret", "123", 6_001), false);
  assert.equal(verifyInstagramConnectToken(token, "secret", "456", 2_000), false);
  assert.equal(verifyInstagramConnectToken(`${token}x`, "secret", "123", 2_000), false);
});

test("binds a preset Instagram username into the signed token", () => {
  const token = createInstagramConnectToken("secret", "123", 1_000, 5_000, "https://www.instagram.com/vogelnati/");
  assert.equal(instagramUsernameFromConnectToken(token, "secret", "123", 2_000), "vogelnati");
  assert.equal(instagramUsernameFromConnectToken(`${token}x`, "secret", "123", 2_000), "");
});

test("encrypts the saved Instagram session before uploading it to Telegram", () => {
  const session = { authorization_data: { sessionid: "very-secret" }, uuids: { uuid: "abc" } };
  const encrypted = encryptInstagramSession(session, "webhook-secret");
  assert.equal(encrypted.includes(Buffer.from("very-secret")), false);
  assert.deepEqual(decryptInstagramSession(encrypted, "webhook-secret"), session);
  assert.throws(() => decryptInstagramSession(encrypted, "wrong-secret"));
});

test("renders a no-cache one-time Instagram login form", () => {
  const page = instagramConnectPage({ token: "a&b", needsCode: true });
  assert.match(page, /name="password" type="password"/);
  assert.match(page, /name="code"/);
  assert.match(page, /value="a&amp;b"/);
  assert.doesNotMatch(page, /very-secret/);
});

test("renders a locked preset username so only the password is needed", () => {
  const page = instagramConnectPage({ token: "token", username: "vogelnati" });
  assert.match(page, /name="username"[^>]+value="vogelnati"[^>]+readonly/);
  assert.match(page, /החשבון נבדק ונקבע מראש: @vogelnati/);
  assert.match(page, /name="password"[^>]+autofocus/);
});
