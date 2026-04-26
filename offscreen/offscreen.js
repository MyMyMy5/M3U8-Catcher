/**
 * Offscreen document for streaming video segments directly to disk.
 * Uses showSaveFilePicker + WritableStream to avoid RAM accumulation.
 */

/** @type {Map<string, FileSystemWritableFileStream>} */
const activeStreams = new Map();

/**
 * Derive a suggested file extension from a MIME type.
 */
const extFromMime = (mime) => {
  if (!mime) return "mp4";
  const lower = mime.toLowerCase();
  if (lower.includes("mp2t") || lower.includes("mpeg-ts")) return "ts";
  if (lower.includes("webm")) return "webm";
  if (lower.includes("mp4")) return "mp4";
  if (lower.includes("audio")) return "mp4";
  return "mp4";
};

/**
 * Build file picker options from a suggested file name.
 */
const buildPickerOptions = (suggestedName) => {
  const opts = {};
  if (suggestedName) {
    opts.suggestedName = suggestedName;
  }
  return opts;
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return false;

  const { type, downloadId } = message;

  if (type === "startStreamDownload") {
    handleStartStream(message)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ type: "streamFallback", downloadId, error: err?.message || String(err) }));
    return true; // async response
  }

  if (type === "streamChunk") {
    handleStreamChunk(message)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        // Abort the stream on write failure
        cleanupStream(downloadId);
        sendResponse({ ok: false, error: err?.message || String(err) });
      });
    return true;
  }

  if (type === "streamEnd") {
    handleStreamEnd(message)
      .then((result) => sendResponse(result))
      .catch((err) => {
        cleanupStream(downloadId);
        sendResponse({ ok: false, error: err?.message || String(err) });
      });
    return true;
  }

  if (type === "streamAbort") {
    handleStreamAbort(message)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: true })); // best-effort cleanup
    return true;
  }

  return false;
});

async function handleStartStream(message) {
  const { downloadId, fileName } = message;

  if (typeof self.showSaveFilePicker !== "function") {
    return { type: "streamFallback", downloadId, error: "showSaveFilePicker not available" };
  }

  let fileHandle;
  try {
    fileHandle = await self.showSaveFilePicker(buildPickerOptions(fileName));
  } catch (err) {
    // User cancelled or API error
    return { type: "streamFallback", downloadId, error: err?.message || "File picker cancelled" };
  }

  let writable;
  try {
    writable = await fileHandle.createWritable();
  } catch (err) {
    return { type: "streamFallback", downloadId, error: err?.message || "Failed to create writable stream" };
  }

  activeStreams.set(downloadId, writable);
  return { type: "streamReady", downloadId };
}

async function handleStreamChunk(message) {
  const { downloadId, chunk } = message;
  const writable = activeStreams.get(downloadId);
  if (!writable) {
    throw new Error(`No active stream for downloadId: ${downloadId}`);
  }
  await writable.write(chunk);
}

async function handleStreamEnd(message) {
  const { downloadId } = message;
  const writable = activeStreams.get(downloadId);
  if (!writable) {
    throw new Error(`No active stream for downloadId: ${downloadId}`);
  }
  await writable.close();
  activeStreams.delete(downloadId);
  return { type: "streamResult", downloadId, ok: true };
}

async function handleStreamAbort(message) {
  const { downloadId } = message;
  await cleanupStream(downloadId);
}

async function cleanupStream(downloadId) {
  const writable = activeStreams.get(downloadId);
  if (!writable) return;
  activeStreams.delete(downloadId);
  try {
    await writable.abort();
  } catch (_) {
    // best-effort
  }
}
