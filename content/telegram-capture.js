const STREAM_PATH_REGEX = /\/stream\/([^/?#]+)/i;
const VIDEO_NAME_REGEX = /\.(mp4|webm|mov|mkv|avi|flv|m4v|mpg|mpeg|3gp|3g2)$/i;
const seen = new Set();

const parseStreamInfo = (url) => {
  if (!url || !url.includes("/stream/")) return null;
  const match = url.match(STREAM_PATH_REGEX);
  if (!match || !match[1]) return null;
  try {
    return JSON.parse(decodeURIComponent(match[1]));
  } catch (err) {
    return null;
  }
};

const isVideoInfo = (info) => {
  if (!info || typeof info !== "object") return false;
  const mime = String(info.mimeType || "").toLowerCase();
  if (mime.startsWith("video/")) return true;
  const name = String(info.fileName || "").toLowerCase();
  return VIDEO_NAME_REGEX.test(name);
};

const sendCapture = (url, info) => {
  if (!url || seen.has(url)) return;
  seen.add(url);
  const sizeValue = Number.isFinite(info?.size) ? info.size : parseInt(info?.size, 10);
  chrome.runtime.sendMessage({
    type: "captureUrl",
    url,
    reason: "telegram-stream",
    contentType: info?.mimeType || null,
    fileName: info?.fileName || null,
    size: Number.isFinite(sizeValue) && sizeValue > 0 ? sizeValue : null,
    pageUrl: window.location.href
  });
};

const handleUrl = (url) => {
  const info = parseStreamInfo(url);
  if (!isVideoInfo(info)) return;
  sendCapture(url, info);
};

const scanResources = () => {
  const entries = performance.getEntriesByType("resource");
  entries.forEach((entry) => handleUrl(entry.name));
};

if (typeof PerformanceObserver !== "undefined") {
  const observer = new PerformanceObserver((list) => {
    list.getEntries().forEach((entry) => handleUrl(entry.name));
  });
  try {
    observer.observe({ type: "resource", buffered: true });
  } catch (err) {
    scanResources();
  }
} else {
  scanResources();
  setInterval(scanResources, 4000);
}
