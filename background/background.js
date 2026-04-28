import {
  recordMediaRequest,
  recordMediaResponse,
  recordTelegramRequest,
  recordTelegramResponse,
  getMediaDiagnosticsText,
  getTelegramDiagnosticsText,
  clearMediaDiagnostics,
  clearTelegramDiagnostics
} from "./diagnostics.js";
import { STORAGE_KEY, SUPPORTED_FORMATS } from "./background-constants.js";
import {
  detectFormatFromContentType,
  detectFormatFromUrl,
  extractContentDispositionFilename,
  extractContentLength,
  extractContentType,
  isLikelySegmentUrl,
  isTelegramStreamUrl,
  isValidTabId,
  normalizeTelegramReferrer,
  normalizeUrl,
  parseTelegramStreamInfo
} from "./background-utils.js";
import {
  downloadDashVideo,
  downloadDirectVideo,
  downloadVideoFromPlaylist,
  fetchText,
  isLikelyPlaylistContentType,
  isLikelyVideoContentType
} from "./background-downloads.js";
import {
  parseHlsVariants,
  parseDashVariants,
  isMasterPlaylist,
  isMediaPlaylist,
  discoverMasterPlaylist
} from "./background-variants.js";
import {
  notifyDownloadComplete,
  notifyDownloadFailed
} from "./background-notifications.js";
import {
  bootstrapStorage,
  createKeepAlive,
  handleCandidate,
  shouldCaptureByUrl,
  storageGet,
  storageSet,
  updateBadge
} from "./background-capture.js";
import { sendTelegramDownloadToTab } from "./background-telegram.js";

chrome.runtime.onInstalled.addListener(() => {
  bootstrapStorage();
});

// Clear all captures and thumbnails when the browser starts a new session
chrome.runtime.onStartup.addListener(async () => {
  await storageSet({ [STORAGE_KEY]: [] });
  await chrome.storage.local.remove(['m3u8_thumbs', 'm3u8_durations', 'm3u8_resolutions']);
  await updateBadge(0);
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (shouldCaptureByUrl(details.url)) {
      const telegramInfo = parseTelegramStreamInfo(details.url);
      const reason = telegramInfo ? "telegram-stream" : "url-match";
      handleCandidate(details, reason, null, { telegramInfo });
    }
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (isTelegramStreamUrl(details.url)) {
      recordTelegramRequest(details);
      return;
    }
    if (shouldCaptureByUrl(details.url)) {
      recordMediaRequest(details, { note: "url-match" });
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (isTelegramStreamUrl(details.url)) {
      recordTelegramResponse(details);
    }
    const contentType = extractContentType(details.responseHeaders);
    const contentLength = extractContentLength(details.responseHeaders);
    const fileName = extractContentDispositionFilename(details.responseHeaders);
    const telegramInfo = parseTelegramStreamInfo(details.url);
    const resolvedContentType = contentType || telegramInfo?.mimeType || null;
    const isPlaylistType = isLikelyPlaylistContentType(resolvedContentType);
    const isVideoType = isLikelyVideoContentType(resolvedContentType);
    const urlMatched = shouldCaptureByUrl(details.url);
    const isSegment = isLikelySegmentUrl(details.url);

    if (isSegment && !telegramInfo) return;
    if (!isPlaylistType && !isVideoType && !urlMatched && !telegramInfo) return;

    let reason = "url-match";
    if (telegramInfo) {
      reason = "telegram-stream";
    } else if (isPlaylistType && !urlMatched) {
      reason = "content-type";
    } else if (isVideoType && !urlMatched) {
      reason = "video-content-type";
    }

    if (!telegramInfo) {
      recordMediaResponse(details, { note: reason });
    }

    handleCandidate(details, reason, resolvedContentType, {
      fileName,
      size: contentLength,
      telegramInfo
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"]
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const respond = (payload) => {
    try {
      sendResponse(payload);
    } catch (err) {
      console.warn("sendResponse failed (caller likely gone)", err);
    }
  };

  const notify = (payload) => {
    try {
      chrome.runtime.sendMessage(payload);
    } catch (err) {
      console.warn("notify message failed", err);
    }
  };

  if (message?.type === "getTelegramDiagnostics") {
    getTelegramDiagnosticsText()
      .then((text) => respond({ ok: true, text }))
      .catch((err) =>
        respond({ ok: false, error: err?.message || "Unable to read diagnostics." })
      );
    return true;
  }

  if (message?.type === "getMediaDiagnostics") {
    getMediaDiagnosticsText()
      .then((text) => respond({ ok: true, text }))
      .catch((err) =>
        respond({ ok: false, error: err?.message || "Unable to read diagnostics." })
      );
    return true;
  }

  if (message?.type === "clearTelegramDiagnostics") {
    clearTelegramDiagnostics()
      .then(() => respond({ ok: true }))
      .catch((err) =>
        respond({ ok: false, error: err?.message || "Unable to clear diagnostics." })
      );
    return true;
  }

  if (message?.type === "clearMediaDiagnostics") {
    clearMediaDiagnostics()
      .then(() => respond({ ok: true }))
      .catch((err) =>
        respond({ ok: false, error: err?.message || "Unable to clear diagnostics." })
      );
    return true;
  }

  if (message?.type === "telegramDownloadProgress" && message.url) {
    notify({
      type: "downloadProgress",
      url: message.url,
      phase: message.phase || "download-file",
      current: message.current,
      total: message.total,
      detail: message.detail
    });
    respond({ ok: true });
    return false;
  }

  if (message?.type === "telegramDownloadResult" && message.url) {
    notify({
      type: "downloadResult",
      ok: !!message.ok,
      url: message.url,
      filename: message.filename,
      error: message.error
    });
    if (message.ok) {
      notifyDownloadComplete(message.filename || message.url);
    } else {
      notifyDownloadFailed(message.error || "Telegram download failed");
    }
    respond({ ok: true });
    return false;
  }

  if (message?.type === "captureUrl" && message.url) {
    const targetUrl = normalizeUrl(message.url);
    const pageUrl = message.pageUrl || sender?.url || null;
    handleCandidate(
      {
        url: targetUrl,
        method: message.method || "GET",
        type: "content-script",
        tabId: typeof sender?.tab?.id === "number" ? sender.tab.id : null,
        frameId: typeof sender?.frameId === "number" ? sender.frameId : null,
        initiator: pageUrl,
        documentUrl: pageUrl,
        originUrl: pageUrl
      },
      message.reason || "content-script",
      message.contentType || null,
      {
        fileName: message.fileName || null,
        size: message.size || null,
        title: message.title || null
      }
    );
    respond({ ok: true });
    return false;
  }

  if (message?.type === "getCaptures") {
    storageGet(STORAGE_KEY)
      .then((data) => {
        respond({ captures: data[STORAGE_KEY] || [] });
      })
      .catch((err) => {
        console.error("Failed to read captures", err);
        respond({ captures: [] });
      });
    return true;
  }

  if (message?.type === "clearCaptures") {
    storageSet({ [STORAGE_KEY]: [] })
      .then(() => updateBadge(0))
      .then(() => respond({ ok: true }))
      .catch((err) => {
        console.error("Failed to clear captures", err);
        respond({ ok: false, error: err.message });
      });
    return true;
  }

  if (message?.type === "removeCapture" && message.url) {
    storageGet(STORAGE_KEY)
      .then((data) => {
        const captures = Array.isArray(data[STORAGE_KEY])
          ? data[STORAGE_KEY]
          : [];
        const filtered = captures.filter((item) => item.url !== message.url);
        return storageSet({ [STORAGE_KEY]: filtered }).then(() =>
          updateBadge(filtered.length).then(() => filtered)
        );
      })
      .then((filtered) => respond({ ok: true, captures: filtered }))
      .catch((err) => {
        console.error("Failed to remove capture", err);
        respond({ ok: false, error: err.message });
      });
    return true;
  }

  if (message?.type === "downloadUrl" && message.url) {
    const requestUrl = normalizeUrl(message.url);
    const fileName = (() => {
      try {
        const url = new URL(requestUrl);
        const base = url.pathname.split("/").filter(Boolean).pop() || "playlist.m3u8";
        return `m3u8/${base.endsWith(".m3u8") ? base : `${base}.m3u8`}`;
      } catch (err) {
        return "m3u8/playlist.m3u8";
      }
    })();

    chrome.downloads.download(
      {
        url: requestUrl,
        filename: fileName,
        saveAs: true,
        conflictAction: "uniquify"
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          respond({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        respond({ ok: true, downloadId });
      }
    );
    return true;
  }

  if (message?.type === "getVariants" && message.url) {
    const targetUrl = normalizeUrl(message.url);
    const formatHint =
      typeof message.format === "string" ? message.format.toLowerCase() : null;
    const format =
      formatHint || detectFormatFromUrl(targetUrl) || null;

    (async () => {
      try {
        const response = await fetchText(targetUrl);
        const text = response.text;
        const resolvedUrl = response.url || targetUrl;

        const detectedFormat = format ||
          (text.includes("#EXTM3U") ? "m3u8" : null) ||
          (text.includes("<MPD") ? "mpd" : null);

        let variants = [];
        let masterUrl = null;
        if (detectedFormat === "m3u8") {
          variants = parseHlsVariants(text, resolvedUrl);

          if (variants.length === 0 && isMediaPlaylist(text)) {
            const master = await discoverMasterPlaylist(
              resolvedUrl,
              async (url) => { const r = await fetchText(url); return r.text; }
            );
            if (master) {
              variants = parseHlsVariants(master.text, master.masterUrl);
              masterUrl = master.masterUrl;
            }
          }
        } else if (detectedFormat === "mpd") {
          variants = parseDashVariants(text, resolvedUrl);
        }

        respond({ ok: true, variants, ...(masterUrl && { masterUrl }) });
      } catch (err) {
        respond({ ok: false, error: err?.message || "Failed to fetch variants." });
      }
    })();
    return true;
  }

  if (message?.type === "classifyContent" && message.url) {
    (async () => {
      try {
        const response = await fetchText(normalizeUrl(message.url));
        const text = response.text;

        if (isMasterPlaylist(text)) {
          const resolvedUrl = response.url || normalizeUrl(message.url);
          const variants = parseHlsVariants(text, resolvedUrl);
          respond({ type: "master", variants });
        } else if (isMediaPlaylist(text)) {
          respond({ type: "media", variants: [] });
        } else {
          respond({ type: "unknown", variants: [] });
        }
      } catch (err) {
        respond({ type: "unknown", variants: [], error: err?.message });
      }
    })();
    return true;
  }

  if (message?.type === "downloadVideo" && message.url) {
    const targetUrl = normalizeUrl(message.url);
    const telegramInfo = parseTelegramStreamInfo(targetUrl);
    const formatHint =
      typeof message.format === "string" ? message.format.toLowerCase() : null;
    const contentTypeHint =
      typeof message.contentType === "string"
        ? message.contentType
        : telegramInfo?.mimeType || null;
    const sizeHintValue = Number.isFinite(message.size)
      ? message.size
      : parseInt(message.size, 10);
    const sizeHint = Number.isFinite(sizeHintValue)
      ? sizeHintValue
      : Number.isFinite(telegramInfo?.size)
        ? telegramInfo.size
        : parseInt(telegramInfo?.size || "", 10);
    const fileNameHint = message.fileName || telegramInfo?.fileName || null;
    const titleHint = message.title || null;
    const referrerHint = normalizeTelegramReferrer(message.sourcePage);
    const playlistReferrer =
      typeof message.sourcePage === "string" && /^https?:/i.test(message.sourcePage)
        ? message.sourcePage
        : null;
    const format =
      formatHint ||
      detectFormatFromUrl(targetUrl) ||
      detectFormatFromContentType(contentTypeHint || "");
    const isPlaylist = SUPPORTED_FORMATS.includes(format);
    const canAssemble = format === "m3u8" || format === "mpd";
    const isTelegramStream = isTelegramStreamUrl(targetUrl);
    if (isPlaylist && !canAssemble) {
      respond({
        ok: false,
        error: "Video assembly supported for HLS (.m3u8) and simple DASH (.mpd) only."
      });
      return false;
    }
    // Respond immediately to avoid popup timeout; notify later when complete.
    respond({ ok: true, started: true });
    if (!canAssemble) {
      if (isTelegramStream) {
        const requestId = `tg-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        const tabId = isValidTabId(message.tabId) ? message.tabId : null;
        notify({
          type: "downloadProgress",
          url: targetUrl,
          phase: "download-file",
          detail: "Starting Telegram download..."
        });
        sendTelegramDownloadToTab(tabId, {
          type: "telegramDownload",
          requestId,
          url: targetUrl,
          fileName: fileNameHint,
          contentType: contentTypeHint,
          size: Number.isFinite(sizeHint) ? sizeHint : null,
          sourcePage: message.sourcePage || null
        }).catch((err) => {
          const error = err?.message ||
              "Unable to start Telegram download. Keep the Telegram tab open and refresh it.";
          notify({
            type: "downloadResult",
            ok: false,
            url: targetUrl,
            error
          });
          notifyDownloadFailed(error);
        });
        return false;
      }
      notify({
        type: "downloadProgress",
        url: targetUrl,
        phase: "saving",
        detail: "Starting direct download..."
      });
      downloadDirectVideo(targetUrl, {
        fileName: fileNameHint,
        contentType: contentTypeHint,
        format
      })
        .then((result) => {
          notify({ type: "downloadResult", ok: result.ok, url: targetUrl, ...result });
          if (result.ok) {
            notifyDownloadComplete(result.filename || fileNameHint || targetUrl);
          } else {
            notifyDownloadFailed(result.error || "Direct download failed");
          }
        })
        .catch((err) => {
          const error = err?.message || String(err);
          notify({
            type: "downloadResult",
            ok: false,
            url: targetUrl,
            error
          });
          notifyDownloadFailed(error);
        });
      return false;
    }

    const stopKeepAlive = createKeepAlive();
    const progressCb = (payload) =>
      notify({ type: "downloadProgress", url: targetUrl, ...payload });

    // When variantUri is provided, download that specific variant instead of auto-selecting
    const downloadUrl = message.variantUri
      ? normalizeUrl(message.variantUri)
      : targetUrl;

    const runWithStreamingFallback = async () => {
      // RAM-buffered download (streaming-to-disk requires showSaveFilePicker
      // which is not available in offscreen documents, so we go straight to
      // the reliable chrome.downloads.download path with saveAs: true)
      const runner =
        format === "mpd"
          ? () => downloadDashVideo(targetUrl, progressCb, { referrer: playlistReferrer, title: titleHint, variantUri: message.variantUri || null })
          : () =>
              downloadVideoFromPlaylist(downloadUrl, 0, progressCb, {
                referrer: playlistReferrer,
                title: titleHint
              });
      return runner();
    };

    runWithStreamingFallback()
      .then((result) => {
        notify({ type: "downloadResult", ok: true, url: targetUrl, ...result });
        notifyDownloadComplete(result.filename || titleHint || targetUrl);
      })
      .catch((err) => {
        const error = err?.message || String(err);
        notify({
          type: "downloadResult",
          ok: false,
          url: targetUrl,
          error
        });
        notifyDownloadFailed(error);
      })
      .finally(() => stopKeepAlive());
    return false;
  }

  if (message?.type === "streamDownload" && message.url && message.streamId) {
    const targetUrl = normalizeUrl(message.url);
    const format = detectFormatFromUrl(targetUrl);
    if (format && format !== "m3u8") {
      respond({
        ok: false,
        error: "Streaming download is supported for HLS (.m3u8) only."
      });
      return false;
    }
    respond({ ok: true, started: true });
    const stopKeepAlive = createKeepAlive();
    const streamId = message.streamId;
    const playlistReferrer =
      typeof message.sourcePage === "string" && /^https?:/i.test(message.sourcePage)
        ? message.sourcePage
        : null;

    const progressCb = (payload) =>
      notify({ type: "downloadProgress", url: targetUrl, streamId, ...payload });

    const onData = (chunk) => notify({ type: "streamChunk", streamId, chunk });

    downloadVideoFromPlaylist(targetUrl, 0, progressCb, {
      stream: true,
      onData,
      referrer: playlistReferrer
    })
      .then((result) =>
        notify({ type: "streamDone", ok: true, streamId, mime: result.mime, ext: result.ext })
      )
      .catch((err) =>
        notify({
          type: "streamDone",
          ok: false,
          streamId,
          error: err?.message || String(err)
        })
      )
      .finally(() => stopKeepAlive());
    return false;
  }

  return false;
});
