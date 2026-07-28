export const VIDEO_QUALITIES = Object.freeze([
  { callbackKind: "v360", height: 360, label: "360p" },
  { callbackKind: "v480", height: 480, label: "480p" },
  { callbackKind: "v720", height: 720, label: "720p" },
  { callbackKind: "v1080", height: 1080, label: "1080p" }
]);

export function downloadSelection(callbackKind) {
  if (callbackKind === "audio") {
    return { kind: "audio", height: null, label: "MP3" };
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
        { text: "🎵 MP3", callback_data: `audio:${id}` },
        { text: "🖼 כל המדיה", callback_data: `gallery:${id}` }
      ]
    ]
  };
}
