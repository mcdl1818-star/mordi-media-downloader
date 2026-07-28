export async function dispatchYouTubeWorker(job, config) {
  if (!config.githubActionsToken) return false;
  const endpoint = `https://api.github.com/repos/${config.githubActionsRepo}/actions/workflows/${config.githubActionsWorkflow}/dispatches`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${config.githubActionsToken}`,
      "content-type": "application/json",
      "user-agent": "mordi-media-downloader",
      "x-github-api-version": "2022-11-28"
    },
    body: JSON.stringify({
      ref: "main",
      inputs: {
        url: job.url,
        kind: job.kind,
        height: String(job.height || 720),
        audio_bitrate: String(job.audioBitrate || 128),
        mute: String(Boolean(job.mute)),
        subtitles: String(Boolean(job.subtitles)),
        chat_id: String(job.chatId),
        reply_to: String(job.sourceMessageId || ""),
        status_message_id: String(job.statusMessageId || "")
      }
    }),
    signal: AbortSignal.timeout(20_000)
  });
  if (response.status === 204) return true;
  const message = (await response.text()).slice(0, 500);
  throw new Error(`GitHub worker dispatch failed (${response.status}): ${message}`);
}
