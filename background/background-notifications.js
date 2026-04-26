/**
 * Download notification helpers.
 *
 * Uses chrome.notifications API to show basic notifications
 * when a download completes or fails. Each notification is
 * automatically cleared after 8 seconds.
 */

/**
 * Show a "Download Complete" notification.
 * @param {string} filename - The downloaded file name shown in the message body.
 */
export function notifyDownloadComplete(filename) {
  const id = `dl-ok-${Date.now()}`;
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Download Complete",
    message: filename || "Download finished",
  });
  setTimeout(() => chrome.notifications.clear(id), 8000);
}

/**
 * Show a "Download Failed" notification.
 * @param {string} errorMessage - Error description shown in the message body.
 */
export function notifyDownloadFailed(errorMessage) {
  const id = `dl-fail-${Date.now()}`;
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Download Failed",
    message: errorMessage || "An unknown error occurred",
  });
  setTimeout(() => chrome.notifications.clear(id), 8000);
}
