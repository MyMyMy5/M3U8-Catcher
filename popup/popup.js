import { groupCaptures } from "./capture-grouping.js";

const listEl = document.getElementById("capture-list");
const emptyEl = document.getElementById("empty-state");
const countEl = document.getElementById("count");
const statusEl = document.getElementById("status-message");
const refreshBtn = document.getElementById("refresh");
const downloadAllBtn = document.getElementById("download-all");
const copyUrlsBtn = document.getElementById("copy-urls");
const diagnosticsBtn = document.getElementById("diagnostics");
const mediaDiagnosticsBtn = document.getElementById("media-diagnostics");
const clearBtn = document.getElementById("clear");
const searchInput = document.getElementById("search-input");
const showVariantsCheckbox = document.getElementById("show-variants");
const progressEl = document.getElementById("progress");
const progressLabelEl = document.getElementById("progress-label");
const progressValueEl = document.getElementById("progress-value");
const progressDetailEl = document.getElementById("progress-detail");
const progressFillEl = document.getElementById("progress-fill");
const qualityModal = document.getElementById("quality-modal");
const qualityModalList = document.getElementById("quality-modal-list");
const qualityModalClose = document.getElementById("quality-modal-close");
const batchQualityModal = document.getElementById("batch-quality-modal");
const batchQualityModalList = document.getElementById("batch-quality-modal-list");
const batchQualityModalClose = document.getElementById("batch-quality-modal-close");
const PLAYLIST_FORMATS = ["m3u8", "mpd", "f4m", "ism", "ismc", "pls"];
const VIDEO_EXTENSIONS = [
  "mp4",
  "webm",
  "mov",
  "mkv",
  "avi",
  "flv",
  "m4v",
  "mpg",
  "mpeg",
  "3gp",
  "3g2"
];
const AUDIO_EXTENSIONS = ["mp3", "m4a", "aac", "ogg", "opus", "wav", "flac"];

/* ── Thumbnail & duration generation ── */
const thumbCache = new Map();
const durationCache = new Map();
const resolutionCache = new Map();
let thumbStorageLoaded = false;

const formatDuration = (seconds) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
};

// Load persisted thumbnails, durations, and resolutions from storage on startup
const loadThumbCache = async () => {
  try {
    const result = await new Promise((resolve) => {
      chrome.storage.local.get(['m3u8_thumbs', 'm3u8_durations', 'm3u8_resolutions'], (r) => resolve(r));
    });
    const storedThumbs = result.m3u8_thumbs || {};
    for (const [url, dataUrl] of Object.entries(storedThumbs)) {
      thumbCache.set(url, dataUrl);
    }
    const storedDurations = result.m3u8_durations || {};
    for (const [url, dur] of Object.entries(storedDurations)) {
      durationCache.set(url, dur);
    }
    const storedResolutions = result.m3u8_resolutions || {};
    for (const [url, res] of Object.entries(storedResolutions)) {
      resolutionCache.set(url, res);
    }
  } catch (_) {}
  thumbStorageLoaded = true;
};

const persistThumbCache = () => {
  const thumbs = {};
  for (const [url, dataUrl] of thumbCache.entries()) {
    if (dataUrl) thumbs[url] = dataUrl;
  }
  const durations = {};
  for (const [url, dur] of durationCache.entries()) {
    if (dur) durations[url] = dur;
  }
  const resolutions = {};
  for (const [url, res] of resolutionCache.entries()) {
    if (res) resolutions[url] = res;
  }
  chrome.storage.local.set({ m3u8_thumbs: thumbs, m3u8_durations: durations, m3u8_resolutions: resolutions });
};

// Debounce storage writes so rapid thumbnail generation doesn't thrash
let thumbSaveTimer = null;
const scheduleThumbSave = () => {
  clearTimeout(thumbSaveTimer);
  thumbSaveTimer = setTimeout(persistThumbCache, 1000);
};

loadThumbCache().then(() => {
  // Re-render once cache is loaded so existing rows get their thumbnails
  if (lastCaptures.length) renderCaptures(lastCaptures);
});

const generateThumbnail = (capture, imgEl, durationEl, resolutionEl) => {
  const url = capture.url;

  // Apply cached duration immediately if available
  if (durationCache.has(url) && durationEl) {
    const dur = durationCache.get(url);
    if (dur) {
      durationEl.textContent = dur;
      durationEl.classList.remove('hidden');
    }
  }

  if (thumbCache.has(url)) {
    const cached = thumbCache.get(url);
    if (cached) imgEl.src = cached;
    return;
  }

  const format = (capture.format || '').toLowerCase();
  const contentType = (capture.contentType || '').toLowerCase();
  const isHls = format === 'm3u8' || contentType.includes('mpegurl');
  const isVideo = VIDEO_EXTENSIONS.includes(format) || contentType.startsWith('video/');

  if (!isHls && !isVideo) return;

  const grabFrame = (videoEl) => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 96;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
      thumbCache.set(url, dataUrl);
      imgEl.src = dataUrl;

      // Capture duration
      const dur = formatDuration(videoEl.duration);
      if (dur && durationEl) {
        durationCache.set(url, dur);
        durationEl.textContent = dur;
        durationEl.classList.remove('hidden');
      }

      // Capture resolution
      const vw = videoEl.videoWidth;
      const vh = videoEl.videoHeight;
      if (vh > 0) {
        const resLabel = `${vh}p`;
        resolutionCache.set(url, resLabel);
        if (resolutionEl) {
          resolutionEl.textContent = resLabel;
          resolutionEl.classList.remove('hidden');
        }
      }

      scheduleThumbSave();
    } catch (_) {
      thumbCache.set(url, null);
    }
  };

  if (isHls && typeof Hls !== 'undefined' && Hls.isSupported()) {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    video.style.display = 'none';
    document.body.appendChild(video);

    const hls = new Hls({ enableWorker: false, startLevel: 0, maxBufferLength: 5 });
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      hls.destroy();
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
    };

    const timeout = setTimeout(() => {
      thumbCache.set(url, null);
      cleanup();
    }, 8000);

    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.currentTime = 2;
    });
    video.addEventListener('seeked', () => {
      grabFrame(video);
      clearTimeout(timeout);
      cleanup();
    }, { once: true });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data.fatal) {
        thumbCache.set(url, null);
        clearTimeout(timeout);
        cleanup();
      }
    });
  } else if (isVideo) {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    video.preload = 'metadata';
    video.style.display = 'none';
    document.body.appendChild(video);

    const timeout = setTimeout(() => {
      thumbCache.set(url, null);
      video.remove();
    }, 8000);

    video.addEventListener('loadeddata', () => {
      video.currentTime = Math.min(2, video.duration || 0);
    }, { once: true });
    video.addEventListener('seeked', () => {
      grabFrame(video);
      clearTimeout(timeout);
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
    }, { once: true });
    video.addEventListener('error', () => {
      thumbCache.set(url, null);
      clearTimeout(timeout);
      video.remove();
    }, { once: true });
    video.src = url;
  }
};

/* ── Variant sub-playlist detection ── */
const VARIANT_HINTS_RE = /(?:\/(?:720|480|360|1080|1440|2160|144|240)p?\/)|\_(?:720|480|360|1080)p|chunklist|index\d*\.m3u8|\bvariant\b/i;

const isVariantUrl = (url) => {
  if (!url) return false;
  try {
    const u = new URL(url);
    const lastSeg = u.pathname.split("/").filter(Boolean).pop() || "";
    // If the filename is NOT master/playlist and looks like a variant
    if (/^master/i.test(lastSeg)) return false;
    if (/^playlist/i.test(lastSeg) && !/playlist\d/i.test(lastSeg)) return false;
    if (VARIANT_HINTS_RE.test(url)) return true;
    // HLS sub-playlists often have numeric-only basenames like "1.m3u8"
    if (/^\d+\.m3u8$/i.test(lastSeg)) return true;
    return false;
  } catch (_) {
    return VARIANT_HINTS_RE.test(url);
  }
};

let expandedCaptureUrl = null;
let expandedRow = null;
let currentHls = null;
let lastCaptures = [];
let batchCancel = null;

const guessFormatFromUrl = (url) => {
  const match = url.match(
    /\.(m3u8|mpd|f4m|ism|ismc|pls|mp4|webm|mov|mkv|avi|flv|m4v|mpg|mpeg|3gp|3g2|mp3|m4a|aac|ogg|opus|wav|flac)(\b|[?#])/i
  );
  return match ? match[1].toLowerCase() : null;
};

const sendMessage = (message) =>
  new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));

const formatTime = (timestamp) => {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
};

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 100 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
};

const truncate = (text, max = 120) => {
  const value = String(text || "");
  return value.length > max ? `${value.slice(0, max)}...` : value;
};

const setStatus = (message, tone = "muted") => {
  statusEl.textContent = message || "";
  statusEl.style.color = tone === "danger" ? "#ff9a9a" : "#9fb4d5";
};

const isArrayBufferLike = (value) => {
  const tag = Object.prototype.toString.call(value);
  return tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]";
};

const isBlobLike = (value) =>
  Object.prototype.toString.call(value) === "[object Blob]" ||
  (value && typeof value.arrayBuffer === "function" && typeof value.size === "number");

const normalizeWriteChunk = async (chunk) => {
  if (!chunk) return null;
  if (isBlobLike(chunk)) {
    const buffer = await chunk.arrayBuffer();
    return new Uint8Array(buffer);
  }
  if (isArrayBufferLike(chunk) || chunk instanceof ArrayBuffer) {
    return new Uint8Array(chunk);
  }
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  if (chunk?.buffer && isArrayBufferLike(chunk.buffer)) {
    const offset = Number.isFinite(chunk.byteOffset) ? chunk.byteOffset : 0;
    const length = Number.isFinite(chunk.byteLength)
      ? chunk.byteLength
      : chunk.buffer.byteLength - offset;
    try {
      return new Uint8Array(chunk.buffer, offset, length);
    } catch (err) {
      return null;
    }
  }
  if (chunk?.type === "Buffer" && Array.isArray(chunk.data)) {
    return new Uint8Array(chunk.data);
  }
  if (chunk?.data && isArrayBufferLike(chunk.data)) {
    return new Uint8Array(chunk.data);
  }
  if (Array.isArray(chunk?.data)) {
    return new Uint8Array(chunk.data);
  }
  if (Array.isArray(chunk)) {
    return new Uint8Array(chunk);
  }
  if (typeof chunk === "object") {
    const keys = Object.keys(chunk).filter((key) => /^\d+$/.test(key));
    if (keys.length) {
      keys.sort((a, b) => Number(a) - Number(b));
      const maxIndex = Number(keys[keys.length - 1]);
      if (Number.isFinite(maxIndex)) {
        const out = new Uint8Array(maxIndex + 1);
        keys.forEach((key) => {
          const value = Number(chunk[key]);
          out[Number(key)] = Number.isFinite(value) ? value : 0;
        });
        return out;
      }
    }
  }
  return null;
};

const setProgress = ({ phase, detail, current, total }) => {
  if (!phase) {
    progressEl.classList.add("hidden");
    return;
  }
  const phaseLabels = {
    "fetch-manifest": "Fetching manifest",
    "parse-manifest": "Parsing manifest",
    "pick-representation": "Choosing representation",
    "fetch-playlist": "Fetching playlist",
    "parse-master": "Parsing master playlist",
    "pick-variant": "Choosing variant",
    fallback: "Retrying variant",
    "parse-media": "Parsing media playlist",
    "download-init": "Downloading init segment",
    "download-segments": "Downloading segments",
    "download-file": "Downloading file",
    assemble: "Assembling video",
    saving: "Saving file"
  };

  const base = phaseLabels[phase] || "Working";
  progressLabelEl.textContent = base;
  progressDetailEl.textContent = detail || "";

  let percent = 12;
  if (phase === "download-segments" && total) {
    percent = Math.min(90, Math.round(30 + ((current || 0) / total) * 60));
  } else if (phase === "download-file" && total) {
    percent = Math.min(92, Math.round(10 + ((current || 0) / total) * 80));
  } else if (phase === "assemble") {
    percent = 95;
  } else if (phase === "saving") {
    percent = 98;
  } else if (phase === "fallback") {
    percent = 20;
  }

  if (!Number.isFinite(percent)) percent = 15;
  progressValueEl.textContent = `${percent}%`;
  progressFillEl.style.width = `${percent}%`;
  progressEl.classList.remove("hidden");
};

const completeProgress = (ok, message) => {
  if (ok) {
    progressLabelEl.textContent = "Done";
    progressValueEl.textContent = "100%";
    progressFillEl.style.width = "100%";
    progressDetailEl.textContent = message || "Download started in Chrome.";
    setTimeout(() => progressEl.classList.add("hidden"), 2500);
  } else {
    progressLabelEl.textContent = "Failed";
    progressValueEl.textContent = "0%";
    progressFillEl.style.width = "0%";
    progressDetailEl.textContent = message || "Download failed.";
  }
};

const deriveSuggestedName = (url, fallback = "video.mp4") => {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() || fallback;
    return last.endsWith(".mp4") ? last : `${last}.mp4`;
  } catch (err) {
    return fallback;
  }
};

const buildActionButton = (label, className, handler) => {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `btn ${className}`;
  btn.textContent = label;
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    handler(event);
  });
  return btn;
};

const collapseExpandedRow = () => {
  if (!expandedRow) {
    expandedCaptureUrl = null;
    return;
  }
  const { rowEl, previewEl, videoEl, audioEl, playBtn } = expandedRow;
  rowEl.classList.remove("expanded");
  if (playBtn) playBtn.classList.remove("active");
  if (previewEl) previewEl.classList.remove("open");
  // Destroy active HLS instance before detaching the video
  if (currentHls) {
    currentHls.destroy();
    currentHls = null;
  }
  videoEl.pause();
  audioEl.pause();
  videoEl.removeAttribute("src");
  audioEl.removeAttribute("src");
  videoEl.load();
  audioEl.load();
  videoEl.classList.add("hidden");
  audioEl.classList.add("hidden");
  expandedRow = null;
  expandedCaptureUrl = null;

  // Flush any storage updates that arrived while the preview was active
  if (pendingStorageCaptures) {
    const captures = pendingStorageCaptures;
    pendingStorageCaptures = null;
    renderCaptures(captures);
  }
};

const getPreviewKind = (capture) => {
  const format = (capture.format || guessFormatFromUrl(capture.url) || "").toLowerCase();
  const contentType = (capture.contentType || "").toLowerCase();

  // HLS playlists: previewable if HLS.js or native HLS is available
  if (format === "m3u8" || contentType.includes("mpegurl")) {
    if (typeof Hls !== "undefined" && Hls.isSupported()) return "video";
    const probe = document.createElement("video");
    if (probe.canPlayType("application/vnd.apple.mpegurl")) return "video";
    return null;
  }

  // Other playlist formats still cannot be previewed
  if (PLAYLIST_FORMATS.includes(format)) return null;
  if (contentType.includes("dash+xml")) return null;

  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("video/")) return "video";
  if (AUDIO_EXTENSIONS.includes(format)) return "audio";
  if (VIDEO_EXTENSIONS.includes(format)) return "video";
  return null;
};

const showPreview = async (
  capture,
  rowEl,
  previewEl,
  videoEl,
  audioEl,
  placeholderEl,
  playBtn,
  options = {}
) => {
  const { autoPlay = true } = options;
  expandedCaptureUrl = capture.url;
  expandedRow = { rowEl, previewEl, videoEl, audioEl, playBtn };
  rowEl.classList.add("expanded");
  if (previewEl) {
    previewEl.classList.add("open");
    previewEl.classList.remove("hidden");
  }
  if (playBtn) playBtn.classList.add("active");

  const format = (capture.format || guessFormatFromUrl(capture.url) || "").toLowerCase();
  const contentType = (capture.contentType || "").toLowerCase();
  const previewKind = getPreviewKind(capture);

  if (placeholderEl) placeholderEl.classList.add("hidden");
  if (videoEl) {
    videoEl.classList.add("hidden");
    videoEl.pause();
    videoEl.removeAttribute("src");
    videoEl.load();
  }
  if (audioEl) {
    audioEl.classList.add("hidden");
    audioEl.pause();
    audioEl.removeAttribute("src");
    audioEl.load();
  }

  if (!previewKind) {
    let message = "Preview is not available for this format.";
    if (PLAYLIST_FORMATS.includes(format) || contentType.includes("mpegurl") || contentType.includes("dash+xml")) {
      message = "Preview is not available for playlists. Use Open to view.";
    }
    if (placeholderEl) {
      placeholderEl.textContent = message;
      placeholderEl.classList.remove("hidden");
    }
    return;
  }

  if (previewKind === "audio") {
    if (audioEl) {
      audioEl.classList.remove("hidden");
      audioEl.crossOrigin = "anonymous";
      audioEl.src = capture.url;
    }
    if (autoPlay) {
      try {
        await audioEl?.play();
      } catch (err) {
        // Retry without crossOrigin for sources that don't support CORS
        if (audioEl) {
          audioEl.removeAttribute("crossorigin");
          audioEl.src = capture.url;
          try { await audioEl.play(); } catch (_) { /* ignore */ }
        }
      }
    }
    return;
  }

  if (videoEl) {
    videoEl.classList.remove("hidden");

    // Destroy any previous HLS instance
    if (currentHls) {
      currentHls.destroy();
      currentHls = null;
    }

    // Show loading indicator
    if (placeholderEl) {
      placeholderEl.textContent = "Loading preview…";
      placeholderEl.classList.remove("hidden");
    }

    const isHls = format === "m3u8" || contentType.includes("mpegurl");

    // Helper: show a user-friendly error in the placeholder
    const showPreviewError = (msg) => {
      if (placeholderEl) {
        placeholderEl.textContent = msg || "Preview failed to load.";
        placeholderEl.classList.remove("hidden");
      }
      videoEl.classList.add("hidden");
    };

    // Video element error handler for non-HLS sources
    const onVideoError = () => {
      const err = videoEl.error;
      let msg = "Preview failed — ";
      if (err) {
        switch (err.code) {
          case MediaError.MEDIA_ERR_ABORTED:
            msg += "playback was aborted.";
            break;
          case MediaError.MEDIA_ERR_NETWORK:
            msg += "a network error occurred. The URL may require authentication.";
            break;
          case MediaError.MEDIA_ERR_DECODE:
            msg += "the video could not be decoded.";
            break;
          case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
            msg += "the format is not supported or the URL is inaccessible.";
            break;
          default:
            msg += "an unknown error occurred.";
        }
      } else {
        msg += "the stream may require authentication or is unavailable.";
      }
      showPreviewError(msg);
    };

    // Clean up any previous error listener
    videoEl.removeEventListener("error", onVideoError);
    videoEl.addEventListener("error", onVideoError, { once: true });

    // Hide loading placeholder once video actually starts playing
    const onPlaying = () => {
      if (placeholderEl) placeholderEl.classList.add("hidden");
    };
    videoEl.removeEventListener("playing", onPlaying);
    videoEl.addEventListener("playing", onPlaying, { once: true });

    if (isHls && typeof Hls !== "undefined" && Hls.isSupported()) {
      // Use HLS.js to parse the manifest and feed the video element
      const hls = new Hls({
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        // Disable web worker in extension popup (can be unreliable)
        enableWorker: false,
        // Send cookies/credentials with XHR requests only for same-origin
        // Extension popup XHR bypasses CORS via host permissions, but
        // withCredentials triggers preflight which CDNs may reject
        xhrSetup: (xhr, url) => {
          try {
            const reqOrigin = new URL(url).origin;
            const pageOrigin = new URL(capture.sourcePage || capture.url).origin;
            if (reqOrigin === pageOrigin) {
              xhr.withCredentials = true;
            }
          } catch (_) {
            // ignore URL parse errors
          }
        },
        // Retry settings for flaky CDNs / authenticated streams
        manifestLoadingMaxRetry: 4,
        manifestLoadingRetryDelay: 1000,
        manifestLoadingMaxRetryTimeout: 15000,
        levelLoadingMaxRetry: 4,
        levelLoadingRetryDelay: 1000,
        levelLoadingMaxRetryTimeout: 15000,
        fragLoadingMaxRetry: 4,
        fragLoadingRetryDelay: 1000,
        fragLoadingMaxRetryTimeout: 15000,
        // Start at lowest quality for faster initial load
        startLevel: -1
      });
      hls.loadSource(capture.url);
      hls.attachMedia(videoEl);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (placeholderEl) placeholderEl.classList.add("hidden");
        if (autoPlay) videoEl.play().catch(() => { });
      });

      // Single consolidated error handler with retry tracking
      let networkRetries = 0;
      let mediaRetries = 0;
      const MAX_RETRIES = 2;

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;

        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            networkRetries++;
            if (networkRetries <= MAX_RETRIES) {
              // Try to recover from network errors
              hls.startLoad();
            } else {
              showPreviewError(
                "Preview failed — too many network errors. The stream may require authentication."
              );
              hls.destroy();
              currentHls = null;
            }
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            mediaRetries++;
            if (mediaRetries <= MAX_RETRIES) {
              // Try to recover from media errors
              hls.recoverMediaError();
            } else {
              showPreviewError(
                "Preview failed — media decoding error. The format may not be compatible."
              );
              hls.destroy();
              currentHls = null;
            }
            break;
          default:
            // Unrecoverable — show error
            showPreviewError(
              "Preview failed to load — the stream may require authentication or is unavailable."
            );
            hls.destroy();
            currentHls = null;
            break;
        }
      });

      currentHls = hls;
    } else {
      // Direct URL or native HLS support (Safari)
      // Try with crossOrigin first, fall back without it
      videoEl.crossOrigin = "anonymous";
      videoEl.src = capture.url;
      if (autoPlay) {
        try {
          await videoEl.play();
          if (placeholderEl) placeholderEl.classList.add("hidden");
        } catch (err) {
          // Retry without crossOrigin (some servers don't support CORS)
          videoEl.removeAttribute("crossorigin");
          videoEl.src = capture.url;
          try {
            await videoEl.play();
            if (placeholderEl) placeholderEl.classList.add("hidden");
          } catch (_) {
            // The onVideoError handler will fire and show the error
          }
        }
      }
    }
  }
};

/* ── Quality Selector Modal ── */
const formatBitrate = (bps) => {
  if (!Number.isFinite(bps) || bps <= 0) return "";
  const mbps = bps / 1_000_000;
  if (mbps >= 1) return `${mbps.toFixed(1)} Mbps`;
  const kbps = bps / 1000;
  return `${kbps.toFixed(0)} kbps`;
};

const getResolutionLabel = (resolution) => {
  if (!resolution) return "Unknown";
  const match = resolution.match(/(\d+)x(\d+)/);
  if (match) return `${match[2]}p`;
  return resolution;
};

let qualityResolve = null;

const showQualityModal = (variants) => {
  return new Promise((resolve) => {
    qualityResolve = resolve;
    qualityModalList.innerHTML = "";

    // "Highest quality" option at top
    const bestVariant = variants.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a), variants[0]);
    const bestRow = document.createElement("div");
    bestRow.className = "quality-variant-row quality-variant-row--best";
    bestRow.setAttribute("role", "option");
    bestRow.innerHTML = `<span class="quality-variant__label">★ Highest quality</span><span class="quality-variant__bitrate">${getResolutionLabel(bestVariant.resolution)} · ${formatBitrate(bestVariant.bandwidth)}</span>`;
    bestRow.addEventListener("click", () => {
      qualityResolve = null;
      hideQualityModal();
      resolve(bestVariant);
    });
    qualityModalList.appendChild(bestRow);

    // Individual variant rows (already sorted highest to lowest from service worker)
    for (const variant of variants) {
      const row = document.createElement("div");
      row.className = "quality-variant-row";
      row.setAttribute("role", "option");
      row.innerHTML = `<span class="quality-variant__label">${getResolutionLabel(variant.resolution)}</span><span class="quality-variant__bitrate">${formatBitrate(variant.bandwidth)}</span>`;
      row.addEventListener("click", () => {
        qualityResolve = null;
        hideQualityModal();
        resolve(variant);
      });
      qualityModalList.appendChild(row);
    }

    qualityModal.classList.remove("hidden");
  });
};

const hideQualityModal = () => {
  qualityModal.classList.add("hidden");
  qualityModalList.innerHTML = "";
  if (qualityResolve) {
    const r = qualityResolve;
    qualityResolve = null;
    r(null);
  }
};

// Dismiss on backdrop click
qualityModal.querySelector(".quality-modal__backdrop").addEventListener("click", () => {
  hideQualityModal();
});

// Dismiss on close button
qualityModalClose.addEventListener("click", () => {
  hideQualityModal();
});

// Dismiss on Escape key
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !qualityModal.classList.contains("hidden")) {
    hideQualityModal();
  }
  if (e.key === "Escape" && !batchQualityModal.classList.contains("hidden")) {
    hideBatchQualityModal();
  }
});

/* ── Batch Quality Prompt Modal ── */
let batchQualityResolve = null;

const showBatchQualityModal = (resolutionTiers) => {
  return new Promise((resolve) => {
    batchQualityResolve = resolve;
    batchQualityModalList.innerHTML = "";

    // "Highest" option
    const highestRow = document.createElement("div");
    highestRow.className = "quality-variant-row quality-variant-row--special";
    highestRow.setAttribute("role", "option");
    highestRow.innerHTML = `<span class="quality-variant__label">★ Highest</span><span class="quality-variant__bitrate">Best available per stream</span>`;
    highestRow.addEventListener("click", () => {
      batchQualityResolve = null;
      hideBatchQualityModal();
      resolve({ choice: "highest" });
    });
    batchQualityModalList.appendChild(highestRow);

    // "Lowest" option
    const lowestRow = document.createElement("div");
    lowestRow.className = "quality-variant-row quality-variant-row--special";
    lowestRow.setAttribute("role", "option");
    lowestRow.innerHTML = `<span class="quality-variant__label">⬇ Lowest</span><span class="quality-variant__bitrate">Smallest file size</span>`;
    lowestRow.addEventListener("click", () => {
      batchQualityResolve = null;
      hideBatchQualityModal();
      resolve({ choice: "lowest" });
    });
    batchQualityModalList.appendChild(lowestRow);

    // Common resolution tiers (sorted highest to lowest)
    for (const tier of resolutionTiers) {
      const row = document.createElement("div");
      row.className = "quality-variant-row";
      row.setAttribute("role", "option");
      row.innerHTML = `<span class="quality-variant__label">${tier}p</span><span class="quality-variant__bitrate">Closest match per stream</span>`;
      row.addEventListener("click", () => {
        batchQualityResolve = null;
        hideBatchQualityModal();
        resolve({ choice: "resolution", height: tier });
      });
      batchQualityModalList.appendChild(row);
    }

    batchQualityModal.classList.remove("hidden");
  });
};

const hideBatchQualityModal = () => {
  batchQualityModal.classList.add("hidden");
  batchQualityModalList.innerHTML = "";
  if (batchQualityResolve) {
    const r = batchQualityResolve;
    batchQualityResolve = null;
    r(null);
  }
};

// Dismiss batch modal on backdrop click
batchQualityModal.querySelector(".quality-modal__backdrop").addEventListener("click", () => {
  hideBatchQualityModal();
});

// Dismiss batch modal on close button
batchQualityModalClose.addEventListener("click", () => {
  hideBatchQualityModal();
});

const renderCaptures = (captures) => {
  lastCaptures = captures;
  listEl.innerHTML = "";

  // Apply search filter
  const query = (searchInput?.value || "").trim().toLowerCase();
  let filtered = captures;
  if (query) {
    filtered = captures.filter((c) => {
      const hay = [
        c.title, c.fileName, c.url, c.sourcePage, c.format, c.reason
      ].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(query);
    });
  }

  // Apply domain filter — only show captures from the active tab's domain
  if (activeDomain) {
    filtered = filtered.filter((c) => domainMatches(c, activeDomain, activeTabId));
  }

  // Apply variant filter
  const showVariants = showVariantsCheckbox?.checked || false;
  if (!showVariants) {
    filtered = filtered.filter((c) => {
      const fmt = (c.format || guessFormatFromUrl(c.url) || "").toLowerCase();
      if (fmt !== "m3u8") return true;
      return !isVariantUrl(c.url);
    });
  }

  const hasCaptures = filtered.length > 0;
  emptyEl.classList.toggle("hidden", hasCaptures);
  const totalLabel = query ? `${filtered.length}/${captures.length}` : `${captures.length}`;
  countEl.textContent = `${totalLabel} capture${captures.length === 1 ? "" : "s"}`;
  const previousExpandedUrl = expandedCaptureUrl;
  if (expandedRow) {
    collapseExpandedRow();
    expandedCaptureUrl = previousExpandedUrl;
  }

  if (!hasCaptures) {
    collapseExpandedRow();
    return;
  }

  if (expandedCaptureUrl) {
    const stillPresent = filtered.some((capture) => capture.url === expandedCaptureUrl);
    if (!stillPresent) {
      expandedCaptureUrl = null;
      expandedRow = null;
    }
  }

  const sorted = filtered.slice().sort((a, b) => {
    const fmtA = (a.format || guessFormatFromUrl(a.url) || "").toLowerCase();
    const fmtB = (b.format || guessFormatFromUrl(b.url) || "").toLowerCase();
    const isPlaylistA = PLAYLIST_FORMATS.includes(fmtA);
    const isPlaylistB = PLAYLIST_FORMATS.includes(fmtB);
    if (isPlaylistA !== isPlaylistB) return isPlaylistA ? -1 : 1;
    const timeA = a.lastSeen || a.firstSeen || 0;
    const timeB = b.lastSeen || b.firstSeen || 0;
    return timeB - timeA;
  });

  // ── Group captures for display ──
  const groups = groupCaptures(sorted);

  const PAGE_SIZE = 50;
  let renderCount = Math.min(groups.length, PAGE_SIZE);

  const renderRows = (startIdx, endIdx) => {
    for (let gi = startIdx; gi < endIdx; gi++) {
      const group = groups[gi];
      if (group.related.length === 0) {
        // Single-capture group: render as normal row
        renderSingleRow(group.primary);
      } else {
        // Multi-capture group: render collapsed row with badge
        renderGroupRow(group);
      }
    }
  };

  const renderGroupRow = (group) => {
    const container = document.createElement("div");
    container.className = "capture-group";

    // Render the primary capture row
    const primaryRowBefore = listEl.children.length;
    renderSingleRow(group.primary);
    const primaryRow = listEl.lastElementChild;

    // Move the primary row into the group container
    listEl.removeChild(primaryRow);
    container.appendChild(primaryRow);

    // Add the group badge to the primary row's main section
    const mainEl = primaryRow.querySelector(".row-tags");
    if (mainEl) {
      const badge = document.createElement("button");
      badge.type = "button";
      badge.className = "chip group-badge";
      badge.textContent = `+${group.related.length} related`;
      badge.title = "Click to expand related captures";
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        const relatedContainer = container.querySelector(".group-related");
        if (relatedContainer) {
          const isExpanded = !relatedContainer.classList.contains("hidden");
          relatedContainer.classList.toggle("hidden");
          badge.classList.toggle("group-badge--expanded", !isExpanded);
          badge.textContent = isExpanded
            ? `+${group.related.length} related`
            : `−${group.related.length} related`;
        }
      });
      mainEl.appendChild(badge);
    }

    // Create hidden container for related captures
    const relatedContainer = document.createElement("div");
    relatedContainer.className = "group-related hidden";

    // We need to render related captures into the relatedContainer
    // Temporarily swap listEl target
    for (const relCapture of group.related) {
      const prevLength = listEl.children.length;
      renderSingleRow(relCapture);
      const relRow = listEl.lastElementChild;
      listEl.removeChild(relRow);
      relRow.classList.add("capture-row--related");
      relatedContainer.appendChild(relRow);
    }

    container.appendChild(relatedContainer);
    listEl.appendChild(container);
  };

  const renderSingleRow = (capture) => {
    const fmt = (capture.format || guessFormatFromUrl(capture.url) || "").toLowerCase();
    const isPlaylist = PLAYLIST_FORMATS.includes(fmt);
    const isHls = fmt === "m3u8";
    const displayFormat = capture.format || fmt;
    const row = document.createElement("div");
    row.className = "capture-row";

    const previewEl = document.createElement("div");
    previewEl.className = "row-preview";

    const previewBody = document.createElement("div");
    previewBody.className = "row-preview-body";

    const videoEl = document.createElement("video");
    videoEl.className = "preview-media hidden";
    videoEl.controls = true;
    videoEl.playsInline = true;

    const audioEl = document.createElement("audio");
    audioEl.className = "preview-media hidden";
    audioEl.controls = true;

    const placeholderEl = document.createElement("div");
    placeholderEl.className = "preview-placeholder";
    placeholderEl.textContent = "Preview is not available.";

    previewBody.append(videoEl, audioEl, placeholderEl);
    previewEl.appendChild(previewBody);

    const main = document.createElement("div");
    main.className = "row-main";

    const playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.className = "icon-btn play";
    playBtn.title = "Preview";
    playBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (expandedCaptureUrl === capture.url) {
        collapseExpandedRow();
        return;
      }
      collapseExpandedRow();
      showPreview(capture, row, previewEl, videoEl, audioEl, placeholderEl, playBtn, {
        autoPlay: true
      });
    });

    const textWrap = document.createElement("div");
    textWrap.className = "row-text";

    const titleEl = document.createElement("div");
    titleEl.className = "row-title";
    const titleValue = (() => {
      // Prefer explicit title or fileName
      if (capture.title) return capture.title;
      if (capture.fileName) return capture.fileName;
      // Derive a readable name from the URL
      try {
        const u = new URL(capture.url);
        const segments = u.pathname.split("/").filter(Boolean);
        // Remove generic filenames like "index.m3u8", "master.m3u8", "playlist.m3u8"
        const last = segments[segments.length - 1] || "";
        if (/^(index|master|playlist|chunklist)\d*\.\w+$/i.test(last)) {
          segments.pop();
        }
        if (segments.length > 0) {
          // Use last meaningful path segments, decoded
          const meaningful = segments.slice(-2).map(s => decodeURIComponent(s)).join(" / ");
          return meaningful;
        }
        return u.hostname;
      } catch (_) {
        return capture.url;
      }
    })();
    titleEl.textContent = truncate(titleValue, 120);

    const meta = document.createElement("div");
    meta.className = "row-meta";
    const source = capture.sourcePage ? truncate(capture.sourcePage, 80) : "unknown";
    const formatLabel = displayFormat ? displayFormat.toUpperCase() : "Unknown";
    meta.appendChild(
      document.createTextNode(
        `Seen: ${formatTime(capture.firstSeen)} | Source: ${source} | Format: ${formatLabel}`
      )
    );
    if (capture.contentType) {
      meta.appendChild(document.createTextNode(` | ${capture.contentType}`));
    }

    textWrap.append(titleEl, meta);

    const tags = document.createElement("div");
    tags.className = "row-tags";

    const reasonChip = document.createElement("span");
    reasonChip.className = "chip";
    reasonChip.textContent = capture.reason || "detected";

    const formatChip = document.createElement("span");
    formatChip.className = "chip";
    formatChip.textContent = formatLabel;

    tags.append(reasonChip, formatChip);

    const sizeLabel = formatBytes(capture.size);
    if (sizeLabel) {
      const sizeChip = document.createElement("span");
      sizeChip.className = "chip";
      sizeChip.textContent = sizeLabel;
      tags.appendChild(sizeChip);
    }

    const actions = document.createElement("div");
    actions.className = "row-actions";

    const openBtn = buildActionButton("Open", "ghost small", () => {
      chrome.tabs.create({ url: capture.url });
    });

    const copyBtn = buildActionButton("Copy", "ghost small", async () => {
      try {
        await navigator.clipboard.writeText(capture.url);
        setStatus("URL copied to clipboard.");
      } catch (err) {
        setStatus("Copy failed. You can still select the text.", "danger");
      }
    });

    const downloadVideoBtn = buildActionButton("Download", "primary small", async () => {
      if (isPlaylist && !["m3u8", "mpd"].includes(fmt)) {
        setStatus("Video assembly works for HLS (.m3u8) and simple DASH (.mpd) only.", "danger");
        return;
      }
      const isDirect = !isPlaylist;

      // For playlist formats, check for multiple quality variants
      if (isPlaylist && (fmt === "m3u8" || fmt === "mpd")) {
        setStatus("Checking available qualities...");
        try {
          const variantResponse = await sendMessage({
            type: "getVariants",
            url: capture.url,
            format: fmt
          });
          if (variantResponse?.ok && variantResponse.variants && variantResponse.variants.length >= 2) {
            // Store resolution from the highest variant for the badge
            const bestVariant = variantResponse.variants[0]; // already sorted highest-first
            if (bestVariant?.resolution) {
              const match = bestVariant.resolution.match(/(\d+)x(\d+)/);
              if (match) {
                resolutionCache.set(capture.url, `${match[2]}p`);
                scheduleThumbSave();
              }
            }
            // Show quality selector modal
            const selected = await showQualityModal(variantResponse.variants);
            if (!selected) {
              // User dismissed the modal
              setStatus("");
              return;
            }
            // Download the selected variant
            setStatus("Assembling video from manifest, please wait...");
            setProgress({ phase: "fetch-manifest", detail: "Starting request..." });
            try {
              const response = await sendMessage({
                type: "downloadVideo",
                url: capture.url,
                variantUri: selected.uri,
                format: fmt,
                contentType: capture.contentType,
                fileName: capture.fileName,
                title: capture.title,
                size: capture.size,
                sourcePage: capture.sourcePage,
                tabId: capture.tabId
              });
              if (!response?.ok) {
                setStatus(response?.error || "Download failed", "danger");
                return;
              }
              setStatus("Download in progress. You can close this popup — it will continue in the background.");
            } catch (err) {
              setStatus("Download failed to start.", "danger");
            }
            return;
          }
          // 0-1 variants: fall through to normal download
          // Store resolution from single variant if available
          if (variantResponse?.ok && variantResponse.variants && variantResponse.variants.length === 1) {
            const singleVariant = variantResponse.variants[0];
            if (singleVariant?.resolution) {
              const match = singleVariant.resolution.match(/(\d+)x(\d+)/);
              if (match) {
                resolutionCache.set(capture.url, `${match[2]}p`);
                scheduleThumbSave();
              }
            }
          }
        } catch (_) {
          // getVariants failed, fall through to normal download
        }
      }

      // Normal download path (direct files or single-variant playlists)
      setStatus(
        isDirect
          ? "Starting direct download..."
          : "Assembling video from manifest, please wait..."
      );
      setProgress({
        phase: isDirect ? "saving" : "fetch-manifest",
        detail: isDirect ? "Handing off to Chrome..." : "Starting request..."
      });
      try {
        const response = await sendMessage({
          type: "downloadVideo",
          url: capture.url,
          format: fmt,
          contentType: capture.contentType,
          fileName: capture.fileName,
          title: capture.title,
          size: capture.size,
          sourcePage: capture.sourcePage,
          tabId: capture.tabId
        });
        if (!response?.ok) {
          setStatus(response?.error || "Download failed", "danger");
          return;
        }
        setStatus(
          isDirect
            ? "Download in progress; check Chrome downloads."
            : "Download in progress. You can close this popup — it will continue in the background."
        );
      } catch (err) {
        setStatus("Download failed to start.", "danger");
      }
    });

    const savePlaylistBtn = buildActionButton("Manifest", "ghost small", async () => {
      const response = await sendMessage({ type: "downloadUrl", url: capture.url });
      if (!response?.ok) {
        setStatus(response?.error || "Download failed", "danger");
        return;
      }
      setStatus("Manifest download started in Chrome.");
    });

    const removeBtn = buildActionButton("Remove", "danger small", async () => {
      const response = await sendMessage({
        type: "removeCapture",
        url: capture.url
      });
      if (response?.ok) {
        renderCaptures(response.captures || []);
        setStatus("Removed entry.");
      }
    });

    actions.append(openBtn, copyBtn);
    if (isPlaylist) {
      actions.append(savePlaylistBtn);
    }
    actions.append(downloadVideoBtn, removeBtn);

    // Thumbnail
    const thumbWrap = document.createElement("div");
    thumbWrap.className = "row-thumb";
    const thumbImg = document.createElement("img");
    thumbImg.alt = "";
    thumbImg.style.display = "none";
    const thumbPlaceholder = document.createElement("span");
    thumbPlaceholder.className = "thumb-placeholder";
    thumbPlaceholder.textContent = "▶";
    const thumbDuration = document.createElement("span");
    thumbDuration.className = "thumb-duration hidden";
    thumbWrap.append(thumbImg, thumbPlaceholder, thumbDuration);

    // Resolution badge — always create the element so generateThumbnail can populate it
    const thumbResolution = document.createElement("span");
    thumbResolution.className = "thumb-resolution hidden";
    const cachedRes = resolutionCache.get(capture.url);
    if (cachedRes) {
      thumbResolution.textContent = cachedRes;
      thumbResolution.classList.remove("hidden");
    }
    thumbWrap.appendChild(thumbResolution);

    thumbImg.addEventListener("load", () => {
      thumbImg.style.display = "";
      thumbPlaceholder.style.display = "none";
    });

    main.append(playBtn, thumbWrap, textWrap, tags, actions);
    row.appendChild(main);
    row.appendChild(previewEl);

    // Kick off thumbnail generation (async, non-blocking)
    generateThumbnail(capture, thumbImg, thumbDuration, thumbResolution);

    listEl.appendChild(row);

    if (capture.url === expandedCaptureUrl) {
      // Skip auto-restore for HLS streams during re-render to avoid
      // infinite loops (HLS.js fetches are captured as new m3u8 URLs
      // → storage change → re-render → re-fetch manifest → loop).
      const _fmt = (capture.format || guessFormatFromUrl(capture.url) || "").toLowerCase();
      const _ct = (capture.contentType || "").toLowerCase();
      const isHlsStream = _fmt === "m3u8" || _ct.includes("mpegurl");
      if (!isHlsStream) {
        showPreview(capture, row, previewEl, videoEl, audioEl, placeholderEl, playBtn, {
          autoPlay: false
        });
      }
    }
  };

  // Render initial page
  renderRows(0, renderCount);

  // Add "Show more" button if there are more items
  if (groups.length > renderCount) {
    const showMoreBtn = document.createElement("button");
    showMoreBtn.type = "button";
    showMoreBtn.className = "btn ghost";
    showMoreBtn.style.width = "100%";
    showMoreBtn.style.marginTop = "4px";
    showMoreBtn.textContent = `Show more (${groups.length - renderCount} remaining)`;
    showMoreBtn.addEventListener("click", () => {
      const prevCount = renderCount;
      renderCount = Math.min(groups.length, renderCount + PAGE_SIZE);
      showMoreBtn.remove();
      renderRows(prevCount, renderCount);
      if (groups.length > renderCount) {
        showMoreBtn.textContent = `Show more (${groups.length - renderCount} remaining)`;
        listEl.appendChild(showMoreBtn);
      }
    });
    listEl.appendChild(showMoreBtn);
  }
};

/* ── Active tab domain filtering ── */
let activeDomain = null;
let activeTabId = null;

const getActiveTabInfo = () =>
  new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs?.[0]) {
        let domain = null;
        try {
          domain = new URL(tabs[0].url).hostname;
        } catch (_) {}
        resolve({ domain, tabId: tabs[0].id });
        return;
      }
      resolve({ domain: null, tabId: null });
    });
  });

const domainMatches = (capture, domain, tabId) => {
  if (!domain) return true;

  // If the capture came from the active tab, always show it
  if (tabId != null && capture.tabId === tabId) return true;

  // Check sourcePage against the active domain
  if (capture.sourcePage) {
    try {
      const sourceHost = new URL(capture.sourcePage).hostname;
      if (sourceHost === domain || sourceHost.endsWith('.' + domain)) return true;
    } catch (_) {}
  }

  // If no sourcePage, don't hide it — we can't be sure it's unrelated
  if (!capture.sourcePage) return true;

  return false;
};

const refreshCaptures = async (options = {}) => {
  if (options.clearMediaDiagnostics) {
    try {
      await sendMessage({ type: "clearMediaDiagnostics" });
    } catch (err) {
      // ignore diagnostics reset errors
    }
  }
  const tabInfo = await getActiveTabInfo();
  activeDomain = tabInfo.domain;
  activeTabId = tabInfo.tabId;
  const response = await sendMessage({ type: "getCaptures" });
  renderCaptures(response?.captures || []);
  setStatus("Latest captures loaded.");
};

refreshBtn.addEventListener("click", () => {
  // Collapse any active preview first so the re-render is clean
  collapseExpandedRow();
  refreshCaptures({ clearMediaDiagnostics: true });
});

/* ── Search input (debounced) ── */
let searchTimer = null;
if (searchInput) {
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderCaptures(lastCaptures), 180);
  });
}

/* ── Show-all variants toggle ── */
if (showVariantsCheckbox) {
  showVariantsCheckbox.addEventListener("change", () => {
    renderCaptures(lastCaptures);
  });
}

/* ── Copy All URLs ── */
if (copyUrlsBtn) {
  copyUrlsBtn.addEventListener("click", async () => {
    const playlistUrls = lastCaptures
      .filter((c) => {
        const fmt = (c.format || guessFormatFromUrl(c.url) || "").toLowerCase();
        return fmt === "m3u8" || fmt === "mpd";
      })
      .filter((c) => !isVariantUrl(c.url))
      .map((c) => c.url);
    if (!playlistUrls.length) {
      setStatus("No downloadable playlist URLs to copy.", "danger");
      return;
    }
    try {
      await navigator.clipboard.writeText(playlistUrls.join("\n"));
      setStatus(`${playlistUrls.length} playlist URL${playlistUrls.length > 1 ? "s" : ""} copied.`);
    } catch (_) {
      setStatus("Copy failed.", "danger");
    }
  });
}

/* ── Download All (batch sequential queue with quality choice) ── */
if (downloadAllBtn) {
  downloadAllBtn.addEventListener("click", async () => {
    // Gather downloadable captures — playlists (non-variant) + direct video files
    let downloadable = lastCaptures.filter((c) => {
      const fmt = (c.format || guessFormatFromUrl(c.url) || "").toLowerCase();
      const isPlaylist = (fmt === "m3u8" || fmt === "mpd") && !isVariantUrl(c.url);
      const isDirectVideo = VIDEO_EXTENSIONS.includes(fmt);
      return isPlaylist || isDirectVideo;
    });

    // Apply domain filter if active
    if (activeDomain) {
      downloadable = downloadable.filter((c) => domainMatches(c, activeDomain, activeTabId));
    }

    // Apply search filter if active
    const query = (searchInput?.value || "").trim().toLowerCase();
    if (query) {
      downloadable = downloadable.filter((c) => {
        const hay = [c.title, c.fileName, c.url, c.sourcePage, c.format, c.reason]
          .filter(Boolean).join(" ").toLowerCase();
        return hay.includes(query);
      });
    }

    if (!downloadable.length) {
      setStatus("No downloadable captures found.", "danger");
      return;
    }

    // Identify playlist-format captures that may have multiple variants
    const playlistCaptures = downloadable.filter((c) => {
      const fmt = (c.format || guessFormatFromUrl(c.url) || "").toLowerCase();
      return fmt === "m3u8" || fmt === "mpd";
    });

    // Fetch variants for all playlist captures in parallel
    setStatus("Checking available qualities…");
    const variantMap = new Map(); // url -> variants[]
    if (playlistCaptures.length > 0) {
      const variantResults = await Promise.all(
        playlistCaptures.map(async (c) => {
          const fmt = (c.format || guessFormatFromUrl(c.url) || "").toLowerCase();
          try {
            const resp = await sendMessage({ type: "getVariants", url: c.url, format: fmt });
            return { url: c.url, variants: (resp?.ok && resp.variants) ? resp.variants : [] };
          } catch (_) {
            return { url: c.url, variants: [] };
          }
        })
      );
      for (const { url, variants } of variantResults) {
        variantMap.set(url, variants);
      }
    }

    // Check if any capture has multiple variants
    const hasMultiVariant = [...variantMap.values()].some((v) => v.length >= 2);

    let batchSelection = null;
    if (hasMultiVariant) {
      // Collect all unique resolution heights across all multi-variant streams
      const heightSet = new Set();
      for (const variants of variantMap.values()) {
        if (variants.length < 2) continue;
        for (const v of variants) {
          const match = (v.resolution || "").match(/(\d+)x(\d+)/);
          if (match) heightSet.add(Number(match[2]));
        }
      }
      // Sort heights descending
      const resolutionTiers = [...heightSet].sort((a, b) => b - a);

      // Show batch quality prompt
      batchSelection = await showBatchQualityModal(resolutionTiers);
      if (!batchSelection) {
        // User dismissed — cancel batch
        setStatus("");
        return;
      }
    }

    let cancelled = false;
    batchCancel = () => { cancelled = true; };
    downloadAllBtn.disabled = true;
    downloadAllBtn.textContent = "Downloading…";

    // Insert batch progress bar below the toolbar
    const batchEl = document.createElement("div");
    batchEl.className = "batch-progress";
    batchEl.innerHTML = `<span class="batch-progress__text">Starting batch…</span><button class="btn danger" type="button">Cancel</button>`;
    const cancelBtn = batchEl.querySelector("button");
    cancelBtn.addEventListener("click", () => {
      cancelled = true;
      batchEl.querySelector(".batch-progress__text").textContent = "Cancelling…";
    });
    progressEl.parentElement.insertBefore(batchEl, progressEl);

    let completed = 0;
    let failed = 0;
    for (let i = 0; i < downloadable.length; i++) {
      if (cancelled) break;
      const capture = downloadable[i];
      const label = capture.title || capture.fileName || `Video ${i + 1}`;
      batchEl.querySelector(".batch-progress__text").textContent =
        `Downloading ${i + 1}/${downloadable.length}: ${label.slice(0, 60)}`;

      try {
        const fmt = (capture.format || guessFormatFromUrl(capture.url) || "").toLowerCase();
        const isPlaylist = fmt === "m3u8" || fmt === "mpd";
        const variants = variantMap.get(capture.url) || [];
        let variantUri = undefined;

        // Pick variant based on batch selection for multi-variant streams
        if (isPlaylist && variants.length >= 2 && batchSelection) {
          if (batchSelection.choice === "highest") {
            // Pick highest bandwidth variant
            const best = variants.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a), variants[0]);
            variantUri = best.uri;
          } else if (batchSelection.choice === "lowest") {
            // Pick lowest bandwidth variant
            const worst = variants.reduce((a, b) => (b.bandwidth < a.bandwidth ? b : a), variants[0]);
            variantUri = worst.uri;
          } else if (batchSelection.choice === "resolution") {
            // Pick closest variant to the chosen resolution height
            const targetHeight = batchSelection.height;
            let bestMatch = variants[0];
            let bestDiff = Infinity;
            for (const v of variants) {
              const match = (v.resolution || "").match(/(\d+)x(\d+)/);
              const h = match ? Number(match[2]) : 0;
              const diff = Math.abs(h - targetHeight);
              if (diff < bestDiff || (diff === bestDiff && v.bandwidth > bestMatch.bandwidth)) {
                bestMatch = v;
                bestDiff = diff;
              }
            }
            variantUri = bestMatch.uri;
          }
        }

        await sendMessage({
          type: "downloadVideo",
          url: capture.url,
          ...(variantUri ? { variantUri } : {}),
          format: fmt,
          contentType: capture.contentType,
          fileName: capture.fileName,
          title: capture.title,
          size: capture.size,
          sourcePage: capture.sourcePage,
          tabId: capture.tabId
        });
        // Wait for the downloadResult message before proceeding
        await new Promise((resolve) => {
          const handler = (msg) => {
            if (msg?.type === "downloadResult") {
              chrome.runtime.onMessage.removeListener(handler);
              if (!msg.ok) failed++;
              else completed++;
              resolve();
            }
          };
          chrome.runtime.onMessage.addListener(handler);
        });
      } catch (_) {
        failed++;
      }
    }

    batchEl.remove();
    batchCancel = null;
    downloadAllBtn.disabled = false;
    downloadAllBtn.textContent = "Download All";
    if (cancelled) {
      setStatus(`Batch cancelled. ${completed} downloaded, ${failed} failed.`);
    } else {
      setStatus(`Batch complete! ${completed} downloaded${failed ? `, ${failed} failed` : ""}.`);
    }
  });
}

const runDiagnostics = async (messageType, label) => {
  setStatus(`Preparing ${label} diagnostics...`);
  try {
    const response = await sendMessage({ type: messageType });
    if (!response?.ok) {
      setStatus(response?.error || "Unable to read diagnostics.", "danger");
      return;
    }
    const text = response.text || "";
    if (!text.trim()) {
      setStatus(`No ${label.toLowerCase()} diagnostics captured yet.`, "danger");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setStatus(`${label} diagnostics copied to clipboard.`);
    } catch (err) {
      setStatus("Copy failed. You can paste manually if needed.", "danger");
    }
  } catch (err) {
    setStatus("Unable to read diagnostics.", "danger");
  }
};

diagnosticsBtn.addEventListener("click", () => {
  runDiagnostics("getTelegramDiagnostics", "Telegram");
});

if (mediaDiagnosticsBtn) {
  mediaDiagnosticsBtn.addEventListener("click", () => {
    runDiagnostics("getMediaDiagnostics", "Media");
  });
}

clearBtn.addEventListener("click", async () => {
  const confirmed = confirm("Clear all saved captures?");
  if (!confirmed) return;
  const response = await sendMessage({ type: "clearCaptures" });
  if (response?.ok) {
    thumbCache.clear();
    durationCache.clear();
    chrome.storage.local.remove(['m3u8_thumbs', 'm3u8_durations']);
    renderCaptures([]);
    setStatus("Capture list cleared.");
  } else {
    setStatus(response?.error || "Unable to clear list", "danger");
  }
});

// Debounce storage change re-renders to avoid thrashing when many
// captures arrive rapidly (e.g. Panopto firing dozens of sub-m3u8 requests)
let storageDebounce = null;
let pendingStorageCaptures = null;
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.m3u8Captures) return;
  const newCaptures = changes.m3u8Captures.newValue || [];
  clearTimeout(storageDebounce);

  // If a preview is active, stash the update and only refresh the count badge.
  // Re-rendering would destroy the playing video/audio element.
  if (expandedCaptureUrl) {
    pendingStorageCaptures = newCaptures;
    const totalLabel = `${newCaptures.length} capture${newCaptures.length === 1 ? "" : "s"}`;
    countEl.textContent = totalLabel;
    return;
  }

  storageDebounce = setTimeout(() => renderCaptures(newCaptures), 600);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "downloadProgress") {
    setProgress({
      phase: message.phase,
      detail: message.detail,
      current: message.current,
      total: message.total
    });
    return;
  }

  if (message?.type === "downloadResult") {
    if (message.ok) {
      const name = message.filename || "video";
      setStatus(`Download ready (${name}). Check Chrome downloads.`);
      completeProgress(true, `Saved as ${name}`);
    } else {
      setStatus(message.error || "Download failed.", "danger");
      completeProgress(false, message.error);
    }
    return;
  }

});

collapseExpandedRow();
refreshCaptures();
