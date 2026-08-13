import crypto from "node:crypto";
import { sanitizeSocialCookieFile } from "./social-cookies.js";

const TOKEN_VERSION = 1;

function signature(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

export function createYoutubeWorkerToken(secret, jobId, now = Date.now(), ttlMs = 45 * 60_000) {
  if (!secret) throw new Error("Missing worker signing secret");
  if (!/^[a-f0-9]{32}$/.test(String(jobId || ""))) throw new Error("Invalid YouTube worker job id");
  const body = Buffer.from(JSON.stringify({
    v: TOKEN_VERSION,
    jobId,
    exp: now + ttlMs
  })).toString("base64url");
  return `${body}.${signature(body, secret)}`;
}

export function verifyYoutubeWorkerToken(token, secret, now = Date.now()) {
  const [body, suppliedSignature, extra] = String(token || "").split(".");
  if (!body || !suppliedSignature || extra || !secret) throw new Error("Invalid YouTube worker token");
  const expected = signature(body, secret);
  const suppliedBuffer = Buffer.from(suppliedSignature);
  const expectedBuffer = Buffer.from(expected);
  if (suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    throw new Error("Invalid YouTube worker token");
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid YouTube worker token");
  }
  if (payload.v !== TOKEN_VERSION || !/^[a-f0-9]{32}$/.test(payload.jobId || "")) {
    throw new Error("Invalid YouTube worker token");
  }
  if (!Number.isFinite(payload.exp) || payload.exp < now) throw new Error("Expired YouTube worker token");
  return payload;
}

export function claimNextYoutubeJob(jobs, chatId, now = Date.now(), leaseMs = 20 * 60_000) {
  const next = Object.entries(jobs || {})
    .filter(([, job]) => !job.processing
      && job.chatId === String(chatId)
      && (!Number.isFinite(job.leaseUntil) || job.leaseUntil <= now))
    .sort((left, right) => left[1].createdAt - right[1].createdAt)[0];
  if (!next) return null;
  const [jobId, job] = next;
  job.leaseUntil = now + leaseMs;
  job.claimedAt = now;
  return { jobId, job };
}

export function buildYoutubeWorkerClaim(job, callbackToken, youtubeCookies = "") {
  const sanitized = youtubeCookies
    ? sanitizeSocialCookieFile(youtubeCookies, "YouTube")
    : "";
  return {
    token: callbackToken,
    url: job.item.url,
    kind: "video",
    height: 480,
    audioBitrate: 128,
    mute: false,
    subtitles: false,
    youtubeCookiesB64: sanitized ? Buffer.from(sanitized, "utf8").toString("base64") : ""
  };
}

export async function dispatchYoutubeWorker(callbackToken, config) {
  if (!config.githubActionsToken) return false;
  const endpoint = `https://api.github.com/repos/${config.githubActionsRepo}/actions/workflows/${config.githubActionsWorkflow}/dispatches`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${config.githubActionsToken}`,
      "content-type": "application/json",
      "user-agent": "mordi-creator-monitor",
      "x-github-api-version": "2026-03-10"
    },
    body: JSON.stringify({
      ref: "main",
      inputs: {
        mode: "creator_monitor",
        callback_token: callbackToken
      }
    }),
    signal: AbortSignal.timeout(20_000)
  });
  if (response.status === 200 || response.status === 204) return true;
  const detail = (await response.text()).slice(0, 400);
  throw new Error(`GitHub YouTube worker dispatch failed (${response.status}): ${detail}`);
}
