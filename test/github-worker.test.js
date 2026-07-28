import test from "node:test";
import assert from "node:assert/strict";
import { dispatchYouTubeWorker } from "../src/github-worker.js";

test("does not dispatch without a configured GitHub token", async () => {
  assert.equal(await dispatchYouTubeWorker({}, { githubActionsToken: "" }), false);
});

test("dispatches a bounded workflow payload", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(null, { status: 204 });
  };
  try {
    const result = await dispatchYouTubeWorker({
      url: "https://youtu.be/jNQXAC9IVRw",
      kind: "video",
      height: 360,
      chatId: 123,
      sourceMessageId: 456,
      statusMessageId: 789
    }, {
      githubActionsToken: "secret",
      githubActionsRepo: "owner/repo",
      githubActionsWorkflow: "youtube-worker.yml"
    });
    assert.equal(result, true);
    assert.equal(request.url, "https://api.github.com/repos/owner/repo/actions/workflows/youtube-worker.yml/dispatches");
    const payload = JSON.parse(request.options.body);
    assert.equal(payload.ref, "main");
    assert.equal(payload.inputs.height, "360");
    assert.equal(payload.inputs.reply_to, "456");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
