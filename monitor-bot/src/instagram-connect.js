import { spawn } from "node:child_process";
import crypto from "node:crypto";

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

export function createInstagramConnectToken(secret, userId, now = Date.now(), ttlMs = 20 * 60_000, username = "") {
  const normalizedUsername = normalizeInstagramUsername(username);
  const details = { userId: String(userId), expiresAt: now + ttlMs, nonce: crypto.randomBytes(12).toString("hex") };
  if (/^[A-Za-z0-9._]{1,30}$/.test(normalizedUsername)) details.username = normalizedUsername;
  const payload = base64url(JSON.stringify(details));
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function readInstagramConnectToken(token, secret, userId, now = Date.now()) {
  try {
    const [payload, signature, extra] = String(token || "").split(".");
    if (!payload || !signature || extra) return null;
    const expected = crypto.createHmac("sha256", secret).update(payload).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return parsed.userId === String(userId) && Number(parsed.expiresAt) >= now ? parsed : null;
  } catch {
    return null;
  }
}

export function verifyInstagramConnectToken(token, secret, userId, now = Date.now()) {
  return Boolean(readInstagramConnectToken(token, secret, userId, now));
}

export function instagramUsernameFromConnectToken(token, secret, userId, now = Date.now()) {
  const username = normalizeInstagramUsername(readInstagramConnectToken(token, secret, userId, now)?.username);
  return /^[A-Za-z0-9._]{1,30}$/.test(username) ? username : "";
}

export function normalizeInstagramUsername(input) {
  let value = String(input || "").trim();
  if (!value) return "";
  try {
    const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    const url = new URL(candidate);
    if (/(^|\.)instagram\.com$/i.test(url.hostname)) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length === 1 && !["accounts", "direct", "explore", "p", "reel", "reels", "stories"].includes(parts[0].toLowerCase())) {
        value = parts[0];
      }
    }
  } catch {
    // A plain username is expected to fail URL parsing and is handled below.
  }
  return value.trim().replace(/^@/, "").replace(/\/+$/, "");
}

function sessionKey(secret) {
  return crypto.createHash("sha256").update(`instagram-session:${secret}`).digest();
}

export function encryptInstagramSession(session, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", sessionKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(session), "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("IGS1"), iv, cipher.getAuthTag(), encrypted]);
}

export function decryptInstagramSession(value, secret) {
  const input = Buffer.from(value);
  if (input.subarray(0, 4).toString() !== "IGS1" || input.length < 33) throw new Error("Invalid Instagram session file");
  const decipher = crypto.createDecipheriv("aes-256-gcm", sessionKey(secret), input.subarray(4, 16));
  decipher.setAuthTag(input.subarray(16, 32));
  return JSON.parse(Buffer.concat([decipher.update(input.subarray(32)), decipher.final()]).toString("utf8"));
}

export function instagramConnectPage({ token = "", username = "", error = "", needsCode = false, success = false } = {}) {
  const message = error ? `<div class="error">${escapeHtml(error)}</div>` : "";
  const code = needsCode ? `<label>קוד אימות דו־שלבי<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,8}" required></label>` : "";
  const normalizedUsername = normalizeInstagramUsername(username);
  const lockedUsername = /^[A-Za-z0-9._]{1,30}$/.test(normalizedUsername);
  const usernameInput = lockedUsername
    ? `<label>חשבון Instagram<input name="username" dir="ltr" value="${escapeHtml(normalizedUsername)}" readonly required></label><small>החשבון נבדק ונקבע מראש: @${escapeHtml(normalizedUsername)}</small>`
    : `<label>שם המשתמש של הפרופיל<input name="username" dir="ltr" placeholder="username או קישור לפרופיל" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required></label><small>לא אימייל ולא מספר טלפון. אפשר להדביק @username או קישור מלא לפרופיל.</small>`;
  const content = success
    ? `<div class="success"><h1>Instagram חובר בהצלחה ✅</h1><p>אפשר לסגור את הדף ולחזור לבוט. המעקב ימשיך בשרת גם כשהטלפון והמחשב כבויים.</p></div>`
    : `<h1>חיבור Instagram לבוט</h1><p>ההתחברות מתבצעת פעם אחת. הסיסמה נשלחת ישירות לתהליך ההתחברות ואינה נשמרת.</p>${message}<form method="post" action="/connect/instagram"><input type="hidden" name="token" value="${escapeHtml(token)}">${usernameInput}<label>סיסמת Instagram<input name="password" type="password" dir="ltr" autocomplete="current-password" minlength="6" maxlength="200" required autofocus></label>${code}<button type="submit">חבר את Instagram</button></form><small>מומלץ להשתמש בחשבון משני. אם Instagram תבקש אישור באפליקציה, אשר וחזור לכאן.</small>`;
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>חיבור Instagram</title><style>body{margin:0;background:#f5f5f7;color:#171717;font-family:Arial,sans-serif}.card{max-width:440px;margin:7vh auto;padding:28px;background:#fff;border-radius:20px;box-shadow:0 10px 35px #0002}h1{font-size:25px;margin-top:0}p,small{line-height:1.55}label{display:block;font-weight:700;margin:18px 0 7px}input{box-sizing:border-box;width:100%;font-size:18px;padding:13px;border:1px solid #bbb;border-radius:11px;margin-top:7px}button{width:100%;border:0;border-radius:12px;padding:14px;margin:22px 0 14px;background:linear-gradient(90deg,#833ab4,#fd1d1d,#fcb045);color:#fff;font-size:18px;font-weight:700}.error{background:#ffe7e7;color:#8b0000;border-radius:10px;padding:12px}.success{padding:20px 0;text-align:center}</style></head><body><main class="card">${content}</main></body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

export function runInstagramLogin(config, credentials) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.pythonPath, [config.instagramBridgePath, "login"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Instagram לא השלים את ההתחברות בזמן"));
    }, 90_000);
    child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-2_000_000); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.once("error", reject);
    child.once("close", code => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(stdout);
        if (result.status) resolve(result);
        else reject(new Error(result.message || "ההתחברות ל-Instagram נכשלה"));
      } catch {
        reject(new Error(`ההתחברות ל-Instagram נכשלה (bridge ${code ?? "unknown"})`));
      }
    });
    child.stdin.end(JSON.stringify(credentials));
  });
}
