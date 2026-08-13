import test from "node:test";
import assert from "node:assert/strict";
import { shouldKeepCloudServiceAwake, startCloudKeepAlive } from "../src/cloud-keepalive.js";

test("cloud keepalive is limited to Render URLs", () => {
  assert.equal(shouldKeepCloudServiceAwake({ webhookUrl: "https://mordi-creator-monitor.onrender.com" }), true);
  assert.equal(shouldKeepCloudServiceAwake({ webhookUrl: "https://example.com" }), false);
  assert.equal(shouldKeepCloudServiceAwake({ webhookUrl: "invalid" }), false);
});

test("cloud keepalive pings only the public health endpoint without secrets", async () => {
  let callback;
  const requests = [];
  const timer = { unrefCalled: false, unref() { this.unrefCalled = true; } };
  const keepAlive = startCloudKeepAlive({
    webhookUrl: "https://mordi-creator-monitor.onrender.com/",
    intervalMs: 10 * 60_000,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200 };
    },
    setIntervalImpl: fn => {
      callback = fn;
      return timer;
    }
  });

  assert.equal(keepAlive.intervalMs, 10 * 60_000);
  assert.equal(timer.unrefCalled, true);
  callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests.map(request => request.url), ["https://mordi-creator-monitor.onrender.com/"]);
  assert.equal(requests[0].options.method, "GET");
});

test("cloud keepalive can be disabled", () => {
  const result = startCloudKeepAlive({
    webhookUrl: "https://mordi-creator-monitor.onrender.com",
    enabled: false,
    setIntervalImpl: () => assert.fail("timer should not be created")
  });
  assert.equal(result, null);
});
