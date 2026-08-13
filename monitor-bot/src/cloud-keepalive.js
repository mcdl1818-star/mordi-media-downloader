function isRenderUrl(value) {
  try {
    return new URL(String(value || "")).hostname.toLowerCase().endsWith(".onrender.com");
  } catch {
    return false;
  }
}

export function shouldKeepCloudServiceAwake({ webhookUrl, explicitlyDisabled = false } = {}) {
  return !explicitlyDisabled && isRenderUrl(webhookUrl);
}

export function startCloudKeepAlive({
  webhookUrl,
  enabled = true,
  intervalMs = 10 * 60_000,
  fetchImpl = globalThis.fetch,
  setIntervalImpl = globalThis.setInterval,
  onError = () => {}
} = {}) {
  if (!enabled || !shouldKeepCloudServiceAwake({ webhookUrl }) || typeof fetchImpl !== "function") return null;
  const safeIntervalMs = Math.max(5 * 60_000, Math.min(12 * 60_000, Number(intervalMs) || 10 * 60_000));
  const ping = async () => {
    try {
      const response = await fetchImpl(`${String(webhookUrl).replace(/\/$/, "")}/`, {
        method: "GET",
        headers: { "user-agent": "mordi-creator-monitor-keepalive/1.0" },
        signal: AbortSignal.timeout(60_000)
      });
      if (!response.ok) throw new Error(`keepalive HTTP ${response.status}`);
    } catch (error) {
      onError(error);
    }
  };
  const timer = setIntervalImpl(() => void ping(), safeIntervalMs);
  timer?.unref?.();
  return { timer, ping, intervalMs: safeIntervalMs };
}
