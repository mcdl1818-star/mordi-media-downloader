import test from "node:test";
import assert from "node:assert/strict";
import {
  createYoutubeWorkerToken,
  verifyYoutubeWorkerToken,
  dispatchYoutubeWorker
} from "../src/youtube-worker.js";

test("creates a short-lived signed YouTube worker token", () => {
  const token = createYoutubeWorkerToken("secret", "a".repeat(32), 1000, 5000);
  assert.deepEqual(verifyYoutubeWorkerToken(token, "secret", 5999), {
    v: 1,
    jobId: "a".repeat(32),
    exp: 6000
  });
  assert.throws(() => verifyYoutubeWorkerToken(token, "wrong", 2000), /Invalid/);
  assert.throws(() => verifyYoutubeWorkerToken(token, "secret", 6001), /Expired/);
});

test("dispatches only the opaque callback token to the GitHub worker", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ workflow_run_id: 123 }), { status: 200 });
  };
  try {
    assert.equal(await dispatchYoutubeWorker("opaque-token", {
      githubActionsToken: "github-secret",
      githubActionsRepo: "owner/repo",
      githubActionsWorkflow: "youtube-worker.yml"
    }), true);
    assert.equal(request.url, "https://api.github.com/repos/owner/repo/actions/workflows/youtube-worker.yml/dispatches");
    const payload = JSON.parse(request.options.body);
    assert.deepEqual(payload.inputs, { mode: "creator_monitor", callback_token: "opaque-token" });
    assert.equal(request.options.headers.authorization, "Bearer github-secret");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not dispatch without a configured GitHub token", async () => {
  assert.equal(await dispatchYoutubeWorker("opaque-token", { githubActionsToken: "" }), false);
});
