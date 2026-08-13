import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { downloadCobaltVideo, downloadVxTwitterVideo } from "../src/cobalt.js";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

test("downloads only a same-origin Cobalt tunnel and enforces the byte limit", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-cobalt-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const file = await downloadCobaltVideo({
    platform: "TikTok",
    url: "https://www.tiktok.com/@creator/video/123"
  }, {
    tempDir: directory,
    maxBytes: 10,
    cobaltApiUrls: ["https://cobalt.example/"]
  }, {
    fetchImpl: async (url, options) => {
      calls.push(String(url));
      if (options?.method === "POST") return jsonResponse({
        status: "tunnel",
        filename: "video.mp4",
        url: "https://cobalt.example/tunnel?id=1"
      });
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "video/mp4" } });
    }
  });
  assert.deepEqual([...fs.readFileSync(file)], [1, 2, 3]);
  assert.equal(calls.length, 2);
});

test("rejects a Cobalt response that points at another host", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-cobalt-host-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(() => downloadCobaltVideo({
    platform: "YouTube",
    url: "https://youtu.be/example"
  }, {
    tempDir: directory,
    maxBytes: 10,
    cobaltApiUrls: ["https://cobalt.example/"]
  }, {
    fetchImpl: async () => jsonResponse({ status: "tunnel", url: "https://attacker.example/file.mp4" })
  }), /untrusted media URL/);
});

test("removes a partial file when the Cobalt stream exceeds Telegram limit", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-cobalt-limit-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(() => downloadCobaltVideo({
    platform: "X",
    url: "https://x.com/creator/status/123"
  }, {
    tempDir: directory,
    maxBytes: 2,
    cobaltApiUrls: ["https://cobalt.example/"]
  }, {
    fetchImpl: async (_url, options) => options?.method === "POST"
      ? jsonResponse({ status: "tunnel", filename: "video.mp4", url: "https://cobalt.example/tunnel?id=1" })
      : new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "video/mp4" } })
  }), /exceeds Telegram limit/);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test("downloads an X video only from VxTwitter metadata and the trusted Twitter CDN", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-vxtwitter-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const file = await downloadVxTwitterVideo({
    platform: "X",
    url: "https://x.com/example/status/123"
  }, { tempDir: directory, maxBytes: 10 }, {
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (new URL(url).hostname === "api.vxtwitter.com") return jsonResponse({
        media_extended: [{ type: "video", url: "https://video.twimg.com/ext_tw_video/123/video.mp4", size: { width: 720 } }]
      });
      return new Response(new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70]), { headers: { "content-type": "video/mp4" } });
    }
  });
  assert.equal((await fs.promises.stat(file)).size, 8);
  assert.equal(calls.length, 2);
});

test("rejects an untrusted X media host", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-vxtwitter-host-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(() => downloadVxTwitterVideo({
    platform: "X",
    url: "https://x.com/example/status/123"
  }, { tempDir: directory, maxBytes: 10 }, {
    fetchImpl: async () => jsonResponse({ mediaURLs: ["https://attacker.example/video.mp4"] })
  }), /No trusted X video/);
});
