(() => {
  if (window.__m3u8CatcherPageCapture) return;
  window.__m3u8CatcherPageCapture = true;

  if (!/^https?:$/.test(window.location.protocol)) return;

  const PLAYLIST_REGEX = /\.(m3u8|mpd|f4m|ism|ismc|pls)(\b|[?#])/i;
  const VIDEO_EXTENSIONS = new Set([
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
  ]);
  const SEGMENT_EXT_REGEX = /\.(ts|m4s|cmfa|cmfv)$/i;
  const SEGMENT_TOKEN_REGEX =
    /(?:^|[._-])(seg(?:ment)?|chunk|frag(?:ment)?|part)\d+(?:[._-]|$)/i;
  const INIT_TOKEN_REGEX = /(?:^|[._-])init(?:[._-]|$)/i;
  const MIME_PARAM_KEYS = ["mime", "type", "content_type", "contentType"];

  // Characters invalid in file names: < > : " / \ | ? *
  // Plus control characters U+0000–U+001F
  const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;
  const MAX_TITLE_LENGTH = 200;

  const sanitizeTitle = (raw) => {
    if (!raw || typeof raw !== "string") return "";
    let result = raw.replace(INVALID_FILENAME_CHARS, "");
    result = result.trim();
    if (result.length > MAX_TITLE_LENGTH) {
      result = result.slice(0, MAX_TITLE_LENGTH);
    }
    return result;
  };

  const extractVideoTitle = () => {
    // Source (a): og:title meta tag
    try {
      const ogMeta = document.querySelector('meta[property="og:title"]');
      if (ogMeta) {
        const content = ogMeta.getAttribute("content");
        if (content) {
          const sanitized = sanitizeTitle(content);
          if (sanitized.length > 0) return sanitized;
        }
      }
    } catch (err) {
      // ignore
    }

    // Source (b): first <h1>
    try {
      const h1 = document.querySelector("h1");
      if (h1) {
        const text = h1.textContent;
        if (text) {
          const sanitized = sanitizeTitle(text);
          if (sanitized.length > 0) return sanitized;
        }
      }
    } catch (err) {
      // ignore
    }

    // Source (c): common video player title selectors
    try {
      const el = document.querySelector(
        '[class*="video-title"], [class*="player-title"], [data-video-title]'
      );
      if (el) {
        const text = el.textContent;
        if (text) {
          const sanitized = sanitizeTitle(text);
          if (sanitized.length > 0) return sanitized;
        }
      }
    } catch (err) {
      // ignore
    }

    return null;
  };

  const seen = new Map();

  const normalizeUrl = (url) => {
    try {
      return new URL(url, window.location.href).toString();
    } catch (err) {
      return url;
    }
  };

  const getLastPathSegment = (url) => {
    try {
      const parsed = new URL(url, window.location.href);
      const parts = parsed.pathname.split("/").filter(Boolean);
      return parts.length ? parts[parts.length - 1] : "";
    } catch (err) {
      const stripped = String(url || "").split("?")[0].split("#")[0];
      const parts = stripped.split("/").filter(Boolean);
      return parts.length ? parts[parts.length - 1] : "";
    }
  };

  const extractMimeFromUrl = (url) => {
    try {
      const parsed = new URL(url, window.location.href);
      for (const key of MIME_PARAM_KEYS) {
        const value = parsed.searchParams.get(key);
        if (value && value.trim()) return value.trim();
      }
    } catch (err) {
      return null;
    }
    return null;
  };

  const isLikelyPlaylistMime = (mime) => {
    if (!mime) return false;
    const lowered = mime.toLowerCase();
    return (
      lowered.includes("mpegurl") ||
      lowered.includes("dash+xml") ||
      lowered.includes("f4m") ||
      lowered.includes("smoothstream") ||
      lowered.includes("vnd.ms-sstr+xml") ||
      lowered.includes("pls")
    );
  };

  const isLikelyMediaMime = (mime) => {
    if (!mime) return false;
    const lowered = mime.toLowerCase();
    return lowered.startsWith("video/") || lowered.startsWith("audio/");
  };


  const isLikelySegmentUrl = (url) => {
    const lastSegment = getLastPathSegment(url);
    if (!lastSegment) return false;
    if (SEGMENT_EXT_REGEX.test(lastSegment)) return true;
    if (SEGMENT_TOKEN_REGEX.test(lastSegment)) return true;
    if (INIT_TOKEN_REGEX.test(lastSegment)) return true;
    return false;
  };

  const getVideoExtensionFromUrl = (url) => {
    const lastSegment = getLastPathSegment(url);
    if (!lastSegment) return null;
    const match = lastSegment.match(/\.([a-z0-9]{2,5})$/i);
    if (!match) return null;
    const ext = match[1].toLowerCase();
    if (!VIDEO_EXTENSIONS.has(ext)) return null;
    if (isLikelySegmentUrl(url)) return null;
    return ext;
  };

  const isPlaylistContentType = (contentType) => {
    if (!contentType) return false;
    const lowered = contentType.toLowerCase();
    return (
      lowered.includes("mpegurl") ||
      lowered.includes("dash+xml") ||
      lowered.includes("f4m") ||
      lowered.includes("smoothstream") ||
      lowered.includes("vnd.ms-sstr+xml") ||
      lowered.includes("pls")
    );
  };

  const isVideoContentType = (contentType) => {
    if (!contentType) return false;
    const lowered = contentType.toLowerCase();
    if (lowered.startsWith("video/")) {
      if (lowered.includes("mp2t")) return false;
      return true;
    }
    if (lowered.startsWith("audio/")) return true;
    return false;
  };

  const shouldCaptureByUrl = (url) => {
    if (PLAYLIST_REGEX.test(url)) return true;
    const mimeType = extractMimeFromUrl(url);
    if (mimeType) {
      if (isLikelyPlaylistMime(mimeType)) return true;
      if (!isLikelySegmentUrl(url) && isLikelyMediaMime(mimeType)) return true;
    }
    return !isLikelySegmentUrl(url) && !!getVideoExtensionFromUrl(url);
  };

  const shouldCaptureByContentType = (contentType) =>
    isPlaylistContentType(contentType) || isVideoContentType(contentType);

  const markSeen = (url, hasMeta) => {
    const existing = seen.get(url);
    if (existing) {
      if (!hasMeta || existing.hasMeta) return false;
      seen.set(url, { hasMeta: true });
      return true;
    }
    seen.set(url, { hasMeta: !!hasMeta });
    return true;
  };

  const sendCapture = (url, meta = {}) => {
    if (!url || typeof url !== "string") return;
    if (url.startsWith("blob:") || url.startsWith("data:")) return;
    const normalized = normalizeUrl(url);
    const hasMeta = !!meta.contentType;
    if (!markSeen(normalized, hasMeta)) return;
    const title = extractVideoTitle();
    try {
      chrome.runtime.sendMessage({
        type: "captureUrl",
        url: normalized,
        reason: meta.reason || "page-observer",
        contentType: meta.contentType || null,
        pageUrl: window.location.href,
        title: title || undefined
      });
    } catch (err) {
      // ignore
    }
  };

  const handleUrl = (url, meta = {}) => {
    if (!url || typeof url !== "string") return;
    const normalized = normalizeUrl(url);
    const inferredContentType = meta.contentType || extractMimeFromUrl(normalized) || null;
    const byUrl = shouldCaptureByUrl(normalized);
    const byType = inferredContentType
      ? shouldCaptureByContentType(inferredContentType)
      : false;
    if (!byUrl && !byType) return;
    const reason = meta.reason || (byType && !byUrl ? "page-content-type" : "page-observer");
    sendCapture(normalized, { ...meta, contentType: inferredContentType, reason });
  };

  const observePerformance = () => {
    if (typeof PerformanceObserver === "undefined") return false;
    const observer = new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => {
        if (!entry?.name) return;
        handleUrl(entry.name, { reason: "page-performance" });
      });
    });
    try {
      observer.observe({ type: "resource", buffered: true });
      return true;
    } catch (err) {
      return false;
    }
  };

  const scanResources = () => {
    if (!window.performance || !performance.getEntriesByType) return;
    const entries = performance.getEntriesByType("resource") || [];
    entries.forEach((entry) => {
      if (!entry?.name) return;
      handleUrl(entry.name, { reason: "page-performance" });
    });
  };

  const startFallbackScan = () => {
    scanResources();
    setInterval(scanResources, 4000);
  };

  const hasObserver = observePerformance();
  if (!hasObserver) {
    startFallbackScan();
  } else {
    scanResources();
  }
})();
