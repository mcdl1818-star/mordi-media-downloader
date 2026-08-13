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
  const antiAbuseSignal = reason === "RATE_LIMIT" || reason === "CHALLENGE";
  const base = antiAbuseSignal
    ? config.instagramRateLimitCooldownMs
    : config.instagramNetworkCooldownMs;
  const maximum = antiAbuseSignal ? 24 * 60 * 60_000 : 2 * 60 * 60_000;
  const delay = Math.min(maximum, base * (2 ** (failures - 1)));
  return {
    reason,
    failures,
    since: new Date(now).toISOString(),
    until: new Date(now + delay).toISOString()
  };
}

export function instagramAuthSummary({ privateAuth, privateAvailable, webAuth, webAvailable, guard }, username) {
  const activeGuard = activeInstagramGuardState(guard);
  if (activeGuard?.reason === "AUTH_REQUIRED") {
    return "⚠️ Instagram — החיבור נעצר ודורש חידוש חד-פעמי";
  }
  if (activeGuard) {
    const until = new Date(activeGuard.until).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" });
    return `⏸️ Instagram — החיבור שמור; הסריקות בהשהיית הגנה עד ${until}`;
  }
  if (privateAvailable && privateAuth?.status !== "EXPIRED") {
    return `✅ Instagram — הסשן הקבוע מהמחשב פעיל עבור @${privateAuth?.username || username}`;
  }
  if (webAvailable && webAuth?.status !== "EXPIRED") {
    return `✅ Instagram — חיבור הדפדפן פעיל עבור @${webAuth?.username || username}`;
  }
  return "⬜ Instagram — אין חיבור פעיל";
}
