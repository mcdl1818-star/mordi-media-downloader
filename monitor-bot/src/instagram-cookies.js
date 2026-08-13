import crypto from "node:crypto";

const INSTAGRAM_COOKIE_DOMAIN = /(^|\.)instagram\.com$/i;
const COOKIE_NAME = /^[A-Za-z0-9_]+$/;

function cleanDomain(value) {
  return String(value || "").trim().toLowerCase().replace(/^#httponly_/i, "");
}

function isInstagramDomain(value) {
  return INSTAGRAM_COOKIE_DOMAIN.test(cleanDomain(value).replace(/^\./, ""));
}

export function normalizeInstagramCookies(input, { maxCookies = 100 } = {}) {
  if (!Array.isArray(input) || input.length < 1 || input.length > maxCookies) {
    throw new Error("Invalid Instagram cookie collection");
  }
  const cookies = [];
  for (const value of input) {
    if (!value || typeof value !== "object" || !isInstagramDomain(value.domain)) continue;
    const name = String(value.name || "").trim();
    const cookieValue = String(value.value || "");
    if (!COOKIE_NAME.test(name) || !cookieValue || cookieValue.length > 4096 || /[\r\n\t]/.test(cookieValue)) continue;
    const domain = cleanDomain(value.domain);
    const cookiePath = String(value.path || "/").replace(/[\r\n\t]/g, "").slice(0, 1024) || "/";
    const rawExpires = Number(value.expires ?? value.expirationDate ?? 0);
    cookies.push({
      domain: domain.startsWith(".") ? domain : `.${domain}`,
      path: cookiePath.startsWith("/") ? cookiePath : "/",
      secure: Boolean(value.secure),
      httpOnly: Boolean(value.httpOnly),
      expires: Number.isFinite(rawExpires) && rawExpires > 0 ? Math.floor(rawExpires) : 0,
      name,
      value: cookieValue
    });
  }
  const unique = [...new Map(cookies.map(cookie => [`${cookie.domain}\t${cookie.path}\t${cookie.name}`, cookie])).values()];
  const session = unique.find(cookie => cookie.name === "sessionid");
  if (!session || session.value.length < 20) throw new Error("Instagram sessionid cookie is missing");
  return unique;
}

export function instagramCookiesToNetscape(input) {
  const cookies = normalizeInstagramCookies(input);
  const lines = ["# Netscape HTTP Cookie File", "# Generated privately for Mordi Creator Monitor"];
  for (const cookie of cookies) {
    const domain = `${cookie.httpOnly ? "#HttpOnly_" : ""}${cookie.domain}`;
    lines.push([
      domain,
      "TRUE",
      cookie.path,
      cookie.secure ? "TRUE" : "FALSE",
      cookie.expires,
      cookie.name,
      cookie.value
    ].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

export function instagramCookiesFromNetscape(value) {
  const cookies = [];
  for (const rawLine of String(value || "").split(/\r?\n/)) {
    if (!rawLine || (rawLine.startsWith("#") && !rawLine.startsWith("#HttpOnly_"))) continue;
    const parts = rawLine.split("\t");
    if (parts.length < 7) continue;
    const httpOnly = parts[0].startsWith("#HttpOnly_");
    cookies.push({
      domain: parts[0].replace(/^#HttpOnly_/, ""),
      path: parts[2],
      secure: parts[3] === "TRUE",
      expires: Number(parts[4]) || 0,
      name: parts[5],
      value: parts.slice(6).join("\t"),
      httpOnly
    });
  }
  return normalizeInstagramCookies(cookies);
}

export function instagramCookiesFromExport(value) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value || "");
  try {
    const parsed = JSON.parse(text);
    const cookies = Array.isArray(parsed) ? parsed : parsed?.cookies;
    if (Array.isArray(cookies)) return normalizeInstagramCookies(cookies);
  } catch {
    // Netscape exports are plain text and are parsed below.
  }
  return instagramCookiesFromNetscape(text);
}

export function instagramCookieFingerprint(value) {
  const cookies = typeof value === "string" ? instagramCookiesFromNetscape(value) : normalizeInstagramCookies(value);
  const stable = cookies
    .map(cookie => [cookie.domain, cookie.path, cookie.name, cookie.value, cookie.expires])
    .sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
