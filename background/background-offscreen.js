/**
 * Offscreen document management helpers for streaming-to-disk downloads.
 */

const OFFSCREEN_URL = "offscreen/offscreen.html";

/**
 * Ensure the offscreen document is created. If it already exists, this is a no-op.
 * @returns {Promise<void>}
 */
export async function ensureOffscreenDocument() {
  // chrome.offscreen.hasDocument was added in Chrome 116+
  if (typeof chrome.offscreen?.hasDocument === "function") {
    const exists = await chrome.offscreen.hasDocument();
    if (exists) return;
  }

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["WORKERS"],
      justification: "Stream video segments directly to disk"
    });
  } catch (err) {
    // "Only a single offscreen document may be created" — already exists
    if (err?.message?.includes("single offscreen") || err?.message?.includes("already")) {
      return;
    }
    throw err;
  }
}

/**
 * Send a message to the offscreen document and wait for a response.
 * @param {object} message
 * @returns {Promise<object>}
 */
export function sendToOffscreen(message) {
  return chrome.runtime.sendMessage(message);
}

/**
 * Start a streaming download via the offscreen document.
 * Returns the response from the offscreen document (streamReady or streamFallback).
 * @param {string} downloadId
 * @param {string} fileName - suggested file name for the save dialog
 * @returns {Promise<object>}
 */
export async function startOffscreenStream(downloadId, fileName) {
  await ensureOffscreenDocument();
  return sendToOffscreen({
    type: "startStreamDownload",
    downloadId,
    fileName
  });
}

/**
 * Send a chunk of data to the offscreen document for writing.
 * @param {string} downloadId
 * @param {ArrayBuffer} chunk
 * @returns {Promise<object>}
 */
export function sendStreamChunk(downloadId, chunk) {
  return sendToOffscreen({
    type: "streamChunk",
    downloadId,
    chunk
  });
}

/**
 * Signal the end of a streaming download.
 * @param {string} downloadId
 * @returns {Promise<object>}
 */
export function endStream(downloadId) {
  return sendToOffscreen({
    type: "streamEnd",
    downloadId
  });
}

/**
 * Abort a streaming download and clean up.
 * @param {string} downloadId
 * @returns {Promise<object>}
 */
export function abortStream(downloadId) {
  return sendToOffscreen({
    type: "streamAbort",
    downloadId
  });
}
