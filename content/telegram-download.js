const CHANNEL = "m3u8-catcher-telegram";
const activeDownloads = new Set();

const sendProgress = (payload) => {
  chrome.runtime.sendMessage({
    type: "telegramDownloadProgress",
    phase: "download-file",
    ...payload
  });
};

const sendResult = (payload) => {
  chrome.runtime.sendMessage({
    type: "telegramDownloadResult",
    ...payload
  });
};

const forwardPageMessage = (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.channel !== CHANNEL) return;
  if (data.type === "download-progress") {
    sendProgress({
      requestId: data.requestId,
      url: data.url,
      current: data.current,
      total: data.total,
      detail: data.detail
    });
    return;
  }
  if (data.type === "download-result") {
    activeDownloads.delete(data.requestId);
    sendResult({
      requestId: data.requestId,
      url: data.url,
      ok: !!data.ok,
      filename: data.filename,
      error: data.error
    });
  }
};

window.addEventListener("message", forwardPageMessage);

const postToPage = (payload) => {
  window.postMessage({ channel: CHANNEL, ...payload }, window.location.origin);
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "telegramDownload" && message.url) {
    const requestId =
      message.requestId ||
      `tg-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    if (activeDownloads.has(requestId)) {
      sendResponse({ ok: false, error: "Download already in progress." });
      return false;
    }
    activeDownloads.add(requestId);
    sendResponse({ ok: true });
    sendProgress({
      requestId,
      url: message.url,
      detail: "Preparing Telegram download..."
    });
    postToPage({
      type: "download-request",
      requestId,
      url: message.url,
      fileName: message.fileName,
      contentType: message.contentType,
      size: message.size
    });
    return false;
  }
  return false;
});
