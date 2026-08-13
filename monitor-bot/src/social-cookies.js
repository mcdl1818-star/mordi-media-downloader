const RULES = {
  Facebook: { domain: /(^|\.)facebook\.com$/i, required: ["c_user", "xs"] },
  TikTok: { domain: /(^|\.)tiktok\.com$/i, requiredAny: ["sessionid", "sessionid_ss", "sid_tt"] },
  X: { domain: /(^|\.)(?:x|twitter)\.com$/i, required: ["auth_token", "ct0"] }
};

export function sanitizeSocialCookieFile(input, platform, nowSeconds = Math.floor(Date.now() / 1000)) {
  const rule = RULES[platform];
  if (!rule) throw new Error("Unsupported social cookie platform");
  const text = Buffer.isBuffer(input) ? input.toString("utf8") : String(input || "");
  if (!text || Buffer.byteLength(text) > 512_000 || /\0/.test(text)) throw new Error("Invalid social cookie file");
  const kept = [];
  const names = new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine || (rawLine.startsWith("#") && !rawLine.startsWith("#HttpOnly_"))) continue;
    const line = rawLine.replace(/^#HttpOnly_/, "");
    const parts = line.split("\t");
    if (parts.length < 7) continue;
    const domain = parts[0].replace(/^\./, "");
    const expires = Number(parts[4]) || 0;
    if (!rule.domain.test(domain) || !parts[5] || !parts[6] || (expires > 0 && expires <= nowSeconds)) continue;
    if (/[\r\n\t\0]/.test(parts[5]) || /[\r\n\t\0]/.test(parts[6])) continue;
    names.add(parts[5]);
    kept.push(`${rawLine.startsWith("#HttpOnly_") ? "#HttpOnly_" : ""}${parts.slice(0, 7).join("\t")}`);
  }
  if (!kept.length) throw new Error("No valid platform cookies");
  if (rule.required && !rule.required.every(name => names.has(name))) throw new Error("Missing required platform cookies");
  if (rule.requiredAny && !rule.requiredAny.some(name => names.has(name))) throw new Error("Missing required platform session cookie");
  return `${kept.join("\n")}\n`;
}
