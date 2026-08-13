import test from "node:test";
import assert from "node:assert/strict";
import { activeInstagramGuardState, nextInstagramGuard } from "../src/instagram-guard.js";

const config = {
  instagramRateLimitCooldownMs: 2 * 60 * 60_000,
  instagramNetworkCooldownMs: 30 * 60_000
};

test("stops all Instagram work indefinitely after authentication expires", () => {
  const now = Date.parse("2026-08-13T07:00:00Z");
  const guard = nextInstagramGuard(null, "AUTH_REQUIRED", config, now);
  assert.equal(activeInstagramGuardState(guard, now + 30 * 24 * 60 * 60_000), guard);
});

test("backs off rate limits exponentially and caps them at 24 hours", () => {
  const now = Date.parse("2026-08-13T07:00:00Z");
  const first = nextInstagramGuard(null, "RATE_LIMIT", config, now);
  const second = nextInstagramGuard(first, "RATE_LIMIT", config, now);
  const eighth = Array.from({ length: 6 }).reduce(
    guard => nextInstagramGuard(guard, "RATE_LIMIT", config, now),
    second
  );
  assert.equal(Date.parse(first.until) - now, 2 * 60 * 60_000);
  assert.equal(Date.parse(second.until) - now, 4 * 60 * 60_000);
  assert.equal(Date.parse(eighth.until) - now, 24 * 60 * 60_000);
});

test("allows scanning again after a temporary guard expires", () => {
  const now = Date.parse("2026-08-13T07:00:00Z");
  const guard = nextInstagramGuard(null, "NETWORK_ERROR", config, now);
  assert.equal(activeInstagramGuardState(guard, now + 29 * 60_000), guard);
  assert.equal(activeInstagramGuardState(guard, now + 31 * 60_000), null);
});
