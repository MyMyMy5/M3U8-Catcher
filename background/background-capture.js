import { MAX_ENTRIES, PLAYLIST_REGEX, STORAGE_KEY } from "./background-constants.js";
import {
  buildTelegramFileName,
  detectFormatFromContentType,
  detectFormatFromUrl,
  extractMimeFromUrl,
  isExtensionUrl,
  isLikelySegmentUrl,
  isLikelyMediaMime,
  isLikelyPlaylistMime,
  isTelegramStreamUrl,
  isValidFrameId,
  isValidTabId,
  getVideoExtensionFromUrl,
  normalizeUrl,
  parseTelegramStreamInfo
} from "./background-utils.js";

const DEFAULT_STATE = {
  [STORAGE_KEY]: []
};

export const storageGet = (key) =>
  new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve(result);
    });
  });

export const storageSet = (value) =>
  new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve();
    });
  });

const pruneList = (items) => {
  if (items.length <= MAX_ENTRIES) return items;
  return items.slice(0, MAX_ENTRIES);
};

export const createKeepAlive = () => {
  const timer = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 20_000);
  return () => clearInterval(timer);
};

export const updateBadge = async (count) => {
  const text = count > 0 ? String(count) : "";
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: "#0b6cff" });
  } catch (err) {
    console.warn("Unable to update badge", err);
  }
};

export const bootstrapStorage = async () => {
  try {
    const existing = await storageGet(STORAGE_KEY);
    if (existing && Array.isArray(existing[STORAGE_KEY])) {
      await updateBadge(existing[STORAGE_KEY].length);
      return;
    }
  } catch (err) {
    console.warn("Storage bootstrap read failed", err);
  }
  await storageSet(DEFAULT_STATE);
  await updateBadge(0);
};

let captureWriteQueue = Promise.resolve();

const recordCapture = ({ url, details }) => {
  captureWriteQueue = captureWriteQueue
    .then(async () => {
      const normalizedUrl = normalizeUrl(url);
      const current = await storageGet(STORAGE_KEY);
      const captures = Array.isArray(current[STORAGE_KEY])
        ? current[STORAGE_KEY]
        : [];

      const now = Date.now();
      const existingIndex = captures.findIndex(
        (item) => item.url === normalizedUrl
      );
      const sizeValue = Number.isFinite(details.size)
        ? details.size
        : parseInt(details.size, 10);

      const normalizedTabId = isValidTabId(details.tabId) ? details.tabId : null;
      const normalizedFrameId = isValidFrameId(details.frameId) ? details.frameId : null;
      const sourceCandidates = [
        details.initiator,
        details.documentUrl,
        details.originUrl
      ].filter(Boolean);
      const sourcePage =
        sourceCandidates.find((candidate) => !isExtensionUrl(candidate)) ||
        sourceCandidates[0] ||
        null;
      const normalizedSourcePage = isExtensionUrl(sourcePage) ? null : sourcePage;

      const base = {
        url: normalizedUrl,
        format:
          details.format ||
          detectFormatFromUrl(normalizedUrl) ||
          detectFormatFromContentType(details.contentType || ""),
        firstSeen: now,
        lastSeen: now,
        reason: details.reason,
        method: details.method || "GET",
        type: details.type || "unknown",
        tabId: normalizedTabId,
        frameId: normalizedFrameId,
        sourcePage: normalizedSourcePage,
        contentType: details.contentType || null,
        fileName: details.fileName || null,
        title: details.title || null,
        size: Number.isFinite(sizeValue) && sizeValue > 0 ? sizeValue : null
      };

      if (existingIndex >= 0) {
        const existing = captures[existingIndex];
        // Skip storage write if nothing meaningful changed
        // (URL already captured — only lastSeen would update, which isn't worth the re-render cost)
        const titleChanged = base.title && base.title !== existing.title;
        const formatChanged = base.format && base.format !== existing.format;
        const sizeChanged = Number.isFinite(base.size) && base.size !== existing.size;
        const fileNameChanged = base.fileName && base.fileName !== existing.fileName;
        if (!titleChanged && !formatChanged && !sizeChanged && !fileNameChanged) {
          // Nothing meaningful changed — skip the write
          return;
        }
        captures[existingIndex] = {
          ...existing,
          ...base,
          tabId: normalizedTabId !== null ? normalizedTabId : existing.tabId ?? null,
          frameId:
            normalizedFrameId !== null ? normalizedFrameId : existing.frameId ?? null,
          sourcePage: existing.sourcePage || normalizedSourcePage || null,
          format: base.format || existing.format || null,
          contentType: base.contentType || existing.contentType || null,
          fileName: base.fileName || existing.fileName || null,
          title: base.title || existing.title || null,
          size: Number.isFinite(base.size) ? base.size : existing.size || null,
          firstSeen: existing.firstSeen || base.firstSeen
        };
      } else {
        captures.unshift(base);
      }

      const trimmed = pruneList(captures);
      await storageSet({ [STORAGE_KEY]: trimmed });
      await updateBadge(trimmed.length);
    })
    .catch((err) => {
      console.error("Failed to record m3u8 capture", err);
    });
  return captureWriteQueue;
};

export const handleCandidate = (details, reason, contentType = null, extra = {}) => {
  const telegramInfo = extra.telegramInfo || parseTelegramStreamInfo(details.url);
  const resolvedContentType = contentType || telegramInfo?.mimeType || null;
  const formatFromContent = detectFormatFromContentType(resolvedContentType || "") || undefined;
  const formatFromUrl = detectFormatFromUrl(details.url) || undefined;
  const fileName =
    extra.fileName ||
    buildTelegramFileName(telegramInfo) ||
    null;
  const coerceSize = (value) => {
    if (Number.isFinite(value)) return value;
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const sizeCandidates = [
    coerceSize(extra.size),
    coerceSize(telegramInfo?.size)
  ].filter((value) => Number.isFinite(value) && value > 0);
  const size = sizeCandidates.length ? sizeCandidates[0] : null;

  // Try to get the page title from the tab if no title was provided
  const doRecord = (title) => {
    recordCapture({
      url: details.url,
      details: {
        ...details,
        reason,
        contentType: resolvedContentType,
        format: formatFromContent || formatFromUrl,
        fileName,
        title: title || null,
        size
      }
    });
  };

  if (extra.title) {
    doRecord(extra.title);
  } else if (isValidTabId(details.tabId)) {
    try {
      chrome.tabs.get(details.tabId, (tab) => {
        if (chrome.runtime.lastError || !tab?.title) {
          doRecord(null);
        } else {
          doRecord(tab.title);
        }
      });
    } catch (_) {
      doRecord(null);
    }
  } else {
    doRecord(null);
  }
};

export const shouldCaptureByUrl = (url) => {
  if (PLAYLIST_REGEX.test(url)) return true;
  if (isTelegramStreamUrl(url)) return true;
  const mimeType = extractMimeFromUrl(url);
  if (mimeType) {
    if (isLikelyPlaylistMime(mimeType)) return true;
    if (!isLikelySegmentUrl(url) && isLikelyMediaMime(mimeType)) return true;
  }
  return !isLikelySegmentUrl(url) && !!getVideoExtensionFromUrl(url);
};
