import crypto from "node:crypto";

const RULES = {
  YouTube: {
    domain: /(^|\.)youtube\.com$/i,
    required: ["LOGIN_INFO"],
    requiredAny: ["SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID"]
  },
  Facebook: { domain: /(^|\.)facebook\.com$/i, required: ["c_user", "xs"] },
  TikTok: { domain: /(^|\.)tiktok\.com$/i, requiredAny: ["sessionid", "sessionid_ss", "sid_tt"] },
  X: { domain: /(^|\.)(?:x|twitter)\.com$/i, required: ["auth_token", "ct0"] }
};

export function createSocialUploadToken(secret, platform, now = Date.now(), ttlMs = 20 * 60_000) {
  if (!secret || !RULES[platform]) throw new Error("Invalid social upload token request");
  const body = Buffer.from(JSON.stringify({
    v: 1,
    platform,
    exp: now + ttlMs,
    nonce: crypto.randomBytes(16).toString("hex")
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifySocialUploadToken(token, secret, platform, now = Date.now()) {
  try {
    const [body, supplied, extra] = String(token || "").split(".");
    if (!body || !supplied || extra || !secret || !RULES[platform]) return false;
    const expected = crypto.createHmac("sha256", secret).update(body).digest();
    const actual = Buffer.from(supplied, "base64url");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return payload.v === 1
      && payload.platform === platform
      && /^[a-f0-9]{32}$/.test(payload.nonce || "")
      && Number.isFinite(payload.exp)
      && payload.exp >= now;
  } catch {
    return false;
  }
}

export function socialUploadTokenFingerprint(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

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
  return `# Netscape HTTP Cookie File\n${kept.join("\n")}\n`;
}
