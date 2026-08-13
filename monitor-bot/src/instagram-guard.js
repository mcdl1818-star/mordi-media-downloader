export function activeInstagramGuardState(guard, now = Date.now()) {
  if (!guard?.reason) return null;
  if (guard.reason === "AUTH_REQUIRED") return guard;
  const until = Date.parse(guard.until || "");
  return Number.isFinite(until) && until > now ? guard : null;
}

export function nextInstagramGuard(previous, reason, config, now = Date.now()) {
  const failures = previous?.reason === reason
    ? Math.min(8, Number(previous.failures || 0) + 1)
    : 1;
  if (reason === "AUTH_REQUIRED") {
    return { reason, failures, since: new Date(now).toISOString(), until: "" };
  }
  const base = reason === "RATE_LIMIT"
    ? config.instagramRateLimitCooldownMs
    : config.instagramNetworkCooldownMs;
  const maximum = reason === "RATE_LIMIT" ? 24 * 60 * 60_000 : 2 * 60 * 60_000;
  const delay = Math.min(maximum, base * (2 ** (failures - 1)));
  return {
    reason,
    failures,
    since: new Date(now).toISOString(),
    until: new Date(now + delay).toISOString()
  };
}
