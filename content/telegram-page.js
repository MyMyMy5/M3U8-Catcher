(() => {
  if (window.__m3u8CatcherTelegramPage) return;
  window.__m3u8CatcherTelegramPage = true;

  const CHANNEL = "m3u8-catcher-telegram";
  const MAX_TELEGRAM_CHUNKS = 20000;
  const PROGRESS_EVERY = 3;
  const STREAM_PATH_REGEX = /\/stream\/([^/?#]+)/i;

  const activeDownloads = new Set();

  const parseContentRange = (value) => {
    if (!value) return null;
    const match = value.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
    if (!match) return null;
    const start = parseInt(match[1], 10);
    const end = parseInt(match[2], 10);
    const totalValue = match[3] === "*" ? null : parseInt(match[3], 10);
    const total = Number.isFinite(totalValue) ? totalValue : null;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
    return { start, end, total };
  };

  const parseTelegramInfo = (url) => {
    if (!url || !url.includes("/stream/")) return null;
    const match = url.match(STREAM_PATH_REGEX);
    if (!match || !match[1]) return null;
    try {
      return JSON.parse(decodeURIComponent(match[1]));
    } catch (err) {
      return null;
    }
  };

  const findFreshTelegramUrl = (sourceUrl) => {
    const info = parseTelegramInfo(sourceUrl);
    if (!info) return null;
    const targetId = info.location?.id || info.id;
    if (!targetId) return null;
    const entries = performance.getEntriesByType("resource");
    let best = null;
    entries.forEach((entry) => {
      const entryInfo = parseTelegramInfo(entry.name);
      if (!entryInfo) return;
      const entryId = entryInfo.location?.id || entryInfo.id;
      if (entryId !== targetId) return;
      if (!best || entry.startTime > best.startTime) {
        best = { url: entry.name, info: entryInfo };
      }
    });
    return best;
  };

  const mapMimeToExt = (mime) => {
    const lower = String(mime || "").toLowerCase();
    if (lower.includes("webm")) return "webm";
    if (lower.includes("x-matroska") || lower.includes("matroska")) return "mkv";
    if (lower.includes("quicktime")) return "mov";
    if (lower.includes("ogg")) return "ogv";
    if (lower.includes("3gpp2")) return "3g2";
    if (lower.includes("3gpp")) return "3gp";
    if (lower.includes("x-msvideo") || lower.includes("avi")) return "avi";
    if (lower.includes("flv")) return "flv";
    if (lower.includes("mpeg")) return "mpeg";
    if (lower.includes("mp4")) return "mp4";
    return "mp4";
  };

  const sanitizeFilename = (name, fallback = "video") => {
    const cleaned = String(name || "")
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return fallback;
    return cleaned.length > 160 ? cleaned.slice(0, 160) : cleaned;
  };

  const ensureExtension = (name, ext) => {
    if (!ext) return name;
    const lowerName = name.toLowerCase();
    const lowerExt = ext.toLowerCase();
    if (lowerName.endsWith(`.${lowerExt}`)) return name;
    if (/\.[a-z0-9]{2,5}$/i.test(name)) return name;
    return `${name}.${ext}`;
  };

  const pickFileName = (url, fileName, mimeType) => {
    const ext = mapMimeToExt(mimeType);
    let base = fileName;
    if (!base) {
      try {
        const parsed = new URL(url);
        const last = parsed.pathname.split("/").filter(Boolean).pop();
        if (last && last.length < 120 && !last.startsWith("{")) {
          base = decodeURIComponent(last);
        }
      } catch (err) {
        // ignore
      }
    }
    base = sanitizeFilename(base || `telegram-video-${Date.now()}`, "telegram-video");
    return ensureExtension(base, ext);
  };

  const postMessage = (payload) => {
    window.postMessage({ channel: CHANNEL, ...payload }, window.location.origin);
  };

  const sendProgress = (payload) => {
    postMessage({ type: "download-progress", ...payload });
  };

  const sendResult = (payload) => {
    postMessage({ type: "download-result", ...payload });
  };

  const fetchRange = async (url, offset) => {
    const res = await fetch(url, {
      method: "GET",
      headers: { Range: `bytes=${offset}-` },
      credentials: "include",
      cache: "no-store"
    });
    if (!res.ok && res.status !== 206) {
      const error = new Error(`Range request failed (${res.status})`);
      error.status = res.status;
      throw error;
    }
    return {
      buffer: await res.arrayBuffer(),
      status: res.status,
      contentRange: res.headers.get("content-range") || "",
      contentType: res.headers.get("content-type") || ""
    };
  };

  const downloadTelegramVideo = async (payload) => {
    const fresh = findFreshTelegramUrl(payload.url);
    const targetUrl = fresh?.url || payload.url;
    const payloadInfo = parseTelegramInfo(targetUrl);
    const fileNameHint = payload.fileName || payloadInfo?.fileName || null;
    const contentTypeHint = payload.contentType || payloadInfo?.mimeType || "";
    const sizeHint =
      Number.isFinite(payload.size)
        ? payload.size
        : Number.isFinite(payloadInfo?.size)
          ? payloadInfo.size
          : null;

    if (fresh?.url && fresh.url !== payload.url) {
      sendProgress({
        requestId: payload.requestId,
        url: payload.url,
        detail: "Using fresh Telegram stream URL."
      });
    }

    const buffers = [];
    let offset = 0;
    let total = Number.isFinite(sizeHint) ? sizeHint : null;
    let mimeType = contentTypeHint || "";

    for (let i = 0; i < MAX_TELEGRAM_CHUNKS; i++) {
      const { buffer, status, contentRange, contentType } = await fetchRange(
        targetUrl,
        offset
      );
      if (contentType && !mimeType) {
        mimeType = contentType;
      }
      if (contentType && contentType.toLowerCase().includes("text/html")) {
        throw new Error("Telegram returned HTML instead of video data.");
      }
      buffers.push(buffer);

      if (status === 200 && offset === 0) {
        total = buffer.byteLength;
        offset = total;
        break;
      }

      const range = parseContentRange(contentRange);
      if (range) {
        if (Number.isFinite(range.total)) {
          total = range.total;
        }
        const nextOffset = range.end + 1;
        if (nextOffset <= offset) {
          throw new Error("Telegram range did not advance.");
        }
        offset = nextOffset;
      } else {
        offset += buffer.byteLength;
      }

      if (i % PROGRESS_EVERY === 0 || (total && offset >= total)) {
        sendProgress({
          requestId: payload.requestId,
          url: payload.url,
          current: offset,
          total,
          detail: total ? `${offset}/${total} bytes` : `Downloaded ${offset} bytes`
        });
      }

      if (total && offset >= total) {
        break;
      }

      if (buffer.byteLength === 0) {
        throw new Error("Telegram stream returned empty data.");
      }
    }

    if (total && offset < total) {
      throw new Error("Telegram download incomplete.");
    }

    const filename = pickFileName(targetUrl, fileNameHint, mimeType || "video/mp4");
    const blob = new Blob(buffers, { type: mimeType || "video/mp4" });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    link.rel = "noopener";
    link.style.display = "none";
    (document.body || document.documentElement).appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    return { filename };
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.type !== "download-request") return;
    const requestId =
      data.requestId || `tg-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    if (activeDownloads.has(requestId)) {
      sendResult({
        requestId,
        url: data.url,
        ok: false,
        error: "Download already in progress."
      });
      return;
    }
    activeDownloads.add(requestId);
    sendProgress({
      requestId,
      url: data.url,
      detail: "Starting Telegram download..."
    });
    downloadTelegramVideo({ ...data, requestId })
      .then((result) =>
        sendResult({
          requestId,
          url: data.url,
          ok: true,
          filename: result.filename
        })
      )
      .catch((err) =>
        sendResult({
          requestId,
          url: data.url,
          ok: false,
          error: err?.message || String(err)
        })
      )
      .finally(() => activeDownloads.delete(requestId));
  });
})();
