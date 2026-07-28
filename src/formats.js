export const VIDEO_QUALITIES = Object.freeze([
  { callbackKind: "v360", height: 360, label: "360p" },
  { callbackKind: "v480", height: 480, label: "480p" },
  { callbackKind: "v720", height: 720, label: "720p" },
  { callbackKind: "v1080", height: 1080, label: "1080p" }
]);

export function downloadSelection(callbackKind) {
  if (callbackKind === "a128" || callbackKind === "audio") {
    return { kind: "audio", height: null, label: "MP3 128k", audioFormat: "mp3", audioBitrate: 128 };
  }
  if (callbackKind === "a320") {
    return { kind: "audio", height: null, label: "MP3 320k", audioFormat: "mp3", audioBitrate: 320 };
  }
  if (callbackKind === "mute720") {
    return { kind: "video", height: 720, label: "720p ללא קול", mute: true };
  }
  if (callbackKind === "sub720") {
    return { kind: "video", height: 720, label: "720p + כתוביות", subtitles: true };
  }
  if (callbackKind === "gallery") {
    return { kind: "gallery", height: null, label: "גלריה" };
  }
  const quality = VIDEO_QUALITIES.find(item => item.callbackKind === callbackKind);
  if (!quality) return null;
  return { kind: "video", height: quality.height, label: quality.label };
}

export function formatKeyboard(id) {
  return {
    inline_keyboard: [
      VIDEO_QUALITIES.slice(0, 2).map(item => ({
        text: `🎬 ${item.label}`,
        callback_data: `${item.callbackKind}:${id}`
      })),
      VIDEO_QUALITIES.slice(2).map(item => ({
        text: `🎬 ${item.label}`,
        callback_data: `${item.callbackKind}:${id}`
      })),
      [
        { text: "🎵 MP3 128k", callback_data: `a128:${id}` },
        { text: "🎧 MP3 320k", callback_data: `a320:${id}` }
      ],
      [
        { text: "🔇 720p ללא קול", callback_data: `mute720:${id}` },
        { text: "📝 720p + כתוביות", callback_data: `sub720:${id}` }
      ],
      [
        { text: "🖼 כל המדיה", callback_data: `gallery:${id}` }
      ]
    ]
  };
}
