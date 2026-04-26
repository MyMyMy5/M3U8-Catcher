/**
 * Panopto-specific content script.
 *
 * Intercepts Panopto's internal delivery API (XHR / fetch) responses to
 * extract the HLS master-playlist URLs *before* the built-in hls.js player
 * starts requesting them.  This lets the extension capture them with a
 * meaningful title (the session name) instead of an opaque CloudFront URL.
 *
 * It also hooks the native XMLHttpRequest and fetch so that when the Panopto
 * player resolves the delivery info for a video, we immediately forward the
 * m3u8 URLs to the background via chrome.runtime.sendMessage.
 */
(() => {
  if (window.__panoptoCatcherInjected) return;
  window.__panoptoCatcherInjected = true;

  /* ── Helpers ─────────────────────────────────────────────────── */

  const DELIVERY_PATH_RE = /\/Panopto\/Pages\/Viewer\/DeliveryInfo\.aspx/i;
  const SESSIONS_API_RE = /\/Panopto\/api\/v1\/sessions\//i;

  const sent = new Set();

  const sendCapture = (url, meta = {}) => {
    if (!url || typeof url !== "string") return;
    if (sent.has(url)) return;
    sent.add(url);
    try {
      chrome.runtime.sendMessage({
        type: "captureUrl",
        url,
        reason: meta.reason || "panopto-delivery",
        contentType: meta.contentType || "application/vnd.apple.mpegurl",
        fileName: meta.fileName || null,
        pageUrl: window.location.href,
        title: meta.title || null
      });
    } catch (_) {
      // Extension context may be invalidated; ignore.
    }
  };

  /**
   * Given a Panopto delivery-info JSON blob, extract all stream URLs
   * and forward them to the extension.
   */
  const extractFromDelivery = (data, title) => {
    if (!data || typeof data !== "object") return;

    // The delivery response contains a Delivery object with Streams array.
    const delivery = data.Delivery || data;
    const sessionName =
      title ||
      delivery.SessionName ||
      delivery.SessionGroupLongName ||
      data.SessionName ||
      document.title ||
      "Panopto Video";

    const streams = delivery.Streams || [];
    streams.forEach((stream, idx) => {
      const hlsUrl =
        stream.StreamHttpUrl ||
        stream.StreamUrl ||
        stream.StreamSSLUrl ||
        null;
      if (hlsUrl && /\.m3u8/i.test(hlsUrl)) {
        const label = streams.length > 1
          ? `${sessionName} (Stream ${idx + 1})`
          : sessionName;
        sendCapture(hlsUrl, {
          reason: "panopto-delivery",
          contentType: "application/vnd.apple.mpegurl",
          fileName: `${sanitize(label)}.mp4`
        });
      }
    });

    // Also check for a PodcastUrl (direct MP4 download if available)
    const podcastUrl = delivery.PodcastUrl || data.PodcastUrl;
    if (podcastUrl) {
      sendCapture(podcastUrl, {
        reason: "panopto-podcast",
        contentType: "video/mp4",
        fileName: `${sanitize(sessionName)}.mp4`
      });
    }
  };

  const sanitize = (name) =>
    String(name || "video")
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160) || "video";

  /* ── XHR interception ────────────────────────────────────────── */

  const origXhrOpen = XMLHttpRequest.prototype.open;
  const origXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__panoptoUrl = typeof url === "string" ? url : String(url);
    return origXhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const url = this.__panoptoUrl || "";
    if (DELIVERY_PATH_RE.test(url)) {
      this.addEventListener("load", function () {
        try {
          const data = JSON.parse(this.responseText);
          extractFromDelivery(data);
        } catch (_) {
          // Not JSON or parse failure – ignore.
        }
      });
    }
    return origXhrSend.apply(this, args);
  };

  /* ── Fetch interception ──────────────────────────────────────── */

  const origFetch = window.fetch;

  window.fetch = function (input, init) {
    const url =
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : String(input);
    const promise = origFetch.apply(this, arguments);

    if (DELIVERY_PATH_RE.test(url) || SESSIONS_API_RE.test(url)) {
      promise
        .then((response) => response.clone().text())
        .then((text) => {
          try {
            const data = JSON.parse(text);
            extractFromDelivery(data);
          } catch (_) {
            // ignore
          }
        })
        .catch(() => {});
    }
    return promise;
  };

  /* ── Periodic scan for video sources ─────────────────────────── */

  /**
   * Panopto's player assigns video sources dynamically.  Scan the DOM
   * periodically for <video> elements whose currentSrc points at an m3u8
   * or CloudFront URL we haven't seen yet.
   */
  const seen = new Set();

  const scanVideoElements = () => {
    const videos = document.querySelectorAll("video");
    videos.forEach((v) => {
      const src = v.currentSrc || v.src || "";
      if (!src || src.startsWith("blob:") || src.startsWith("data:")) return;
      if (seen.has(src)) return;
      seen.add(src);
      if (/\.m3u8/i.test(src)) {
        sendCapture(src, {
          reason: "panopto-video-element",
          contentType: "application/vnd.apple.mpegurl",
          fileName: `${sanitize(document.title)}.mp4`
        });
      }
    });
  };

  // Scan every 8 seconds (reduced from 3s to avoid performance overhead)
  setInterval(scanVideoElements, 8000);
  // Also scan on DOMContentLoaded / load
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scanVideoElements);
  } else {
    scanVideoElements();
  }
  window.addEventListener("load", scanVideoElements);

  /* ── Scan Panopto's own API calls via performance entries ───── */

  const scanPerformanceEntries = () => {
    if (!window.performance || !performance.getEntriesByType) return;
    const entries = performance.getEntriesByType("resource") || [];
    entries.forEach((entry) => {
      if (!entry?.name) return;
      const url = entry.name;
      if (seen.has(url)) return;
      // Look for master.m3u8 or similar HLS URLs
      if (/\.m3u8/i.test(url) && !seen.has(url)) {
        seen.add(url);
        sendCapture(url, {
          reason: "panopto-performance",
          contentType: "application/vnd.apple.mpegurl",
          fileName: `${sanitize(document.title)}.mp4`
        });
      }
    });
  };

  // Use PerformanceObserver for real-time detection
  if (typeof PerformanceObserver !== "undefined") {
    try {
      const observer = new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => {
          if (!entry?.name) return;
          const url = entry.name;
          if (seen.has(url)) return;
          if (/\.m3u8/i.test(url)) {
            seen.add(url);
            sendCapture(url, {
              reason: "panopto-performance",
              contentType: "application/vnd.apple.mpegurl",
              fileName: `${sanitize(document.title)}.mp4`
            });
          }
        });
      });
      observer.observe({ type: "resource", buffered: true });
    } catch (_) {
      // Fallback to polling (10s interval)
      setInterval(scanPerformanceEntries, 10000);
    }
  } else {
    setInterval(scanPerformanceEntries, 10000);
  }

  // Initial scan
  scanPerformanceEntries();

  console.log("[M3U8 Catcher] Panopto capture script loaded.");
})();
