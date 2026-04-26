import {
  DIRECT_VIDEO_FOLDER,
  MAX_TELEGRAM_CHUNKS,
  MAX_VARIANT_RECURSION
} from "./background-constants.js";
import {
  buildTelegramFileName,
  detectFormatFromContentType,
  detectFormatFromUrl,
  mapMimeToExt,
  parseTelegramStreamInfo
} from "./background-utils.js";
import { recordMediaFetch, recordTelegramFetch } from "./diagnostics.js";

const parseISODurationSeconds = (value) => {
  if (!value || typeof value !== "string") return null;
  const match =
    value.match(
      /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/
    );
  if (!match) return null;
  const [
    ,
    years = 0,
    months = 0,
    weeks = 0,
    days = 0,
    hours = 0,
    minutes = 0,
    seconds = 0
  ] = match.map((v) => (v ? parseFloat(v) : 0));
  const totalDays = Number(years) * 365 + Number(months) * 30 + Number(weeks) * 7 + Number(days);
  return (
    totalDays * 86400 +
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds)
  );
};

const parseAttributeList = (line) => {
  const out = {};
  const trimmed = line.trim();
  if (!trimmed) return out;
  const parts = trimmed.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  parts.forEach((part) => {
    const splitIndex = part.indexOf("=");
    if (splitIndex <= 0) return;
    const rawKey = part.slice(0, splitIndex);
    const rawVal = part.slice(splitIndex + 1);
    if (!rawKey || rawVal === undefined) return;
    const key = rawKey.trim().toLowerCase();
    let val = rawVal.trim();
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  });
  return out;
};

const absoluteUrl = (input, base) => {
  try {
    return new URL(input, base).toString();
  } catch (err) {
    return input;
  }
};

const applyAuthQuery = (resolvedUrl, baseUrl) => {
  try {
    const resolved = new URL(resolvedUrl);
    if (!["http:", "https:"].includes(resolved.protocol)) return resolvedUrl;
    const base = new URL(baseUrl);
    if (!["http:", "https:"].includes(base.protocol)) return resolvedUrl;
    if (!base.search) return resolvedUrl;
    if (resolved.origin !== base.origin) return resolvedUrl;
    const authKeys = ["policy", "signature", "key-pair-id", "expires", "token"];
    const baseParams = new URLSearchParams(base.search);
    const baseMap = new Map();
    baseParams.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (!baseMap.has(lower)) {
        baseMap.set(lower, { key, value });
      }
    });
    const hasAuth = authKeys.some((key) => baseMap.has(key));
    if (!hasAuth) return resolvedUrl;
    const resolvedParams = new URLSearchParams(resolved.search);
    const resolvedKeys = new Set();
    resolvedParams.forEach((_, key) => {
      resolvedKeys.add(key.toLowerCase());
    });
    let updated = false;
    authKeys.forEach((key) => {
      if (resolvedKeys.has(key)) return;
      const baseEntry = baseMap.get(key);
      if (!baseEntry) return;
      resolvedParams.set(baseEntry.key, baseEntry.value);
      updated = true;
    });
    if (!updated) return resolvedUrl;
    const merged = resolvedParams.toString();
    if (!merged) return resolvedUrl;
    resolved.search = merged;
    return resolved.toString();
  } catch (err) {
    return resolvedUrl;
  }
};

const resolvePlaylistUrl = (input, baseUrl) => {
  const resolved = absoluteUrl(input, baseUrl);
  if (resolved.startsWith("data:")) return resolved;
  return applyAuthQuery(resolved, baseUrl);
};

const getBaseUrl = (node) => {
  if (!node) return null;
  const base = node.querySelector(":scope > BaseURL");
  if (base && base.textContent) {
    return base.textContent.trim();
  }
  return null;
};

const chainBaseUrl = (base, node) => {
  const candidate = getBaseUrl(node);
  return candidate ? absoluteUrl(candidate, base) : base;
};

const substituteTemplate = (template, { number, representationId, bandwidth }) => {
  return template
    .replace(/\$Number(?::?%0(\d+)d)?\$/g, (_, width) => {
      const num = String(number);
      if (width) {
        return num.padStart(parseInt(width, 10), "0");
      }
      return num;
    })
    .replace(/\$RepresentationID\$/g, representationId || "rep")
    .replace(/\$Bandwidth\$/g, String(bandwidth || 0));
};

const buildFetchOptions = (options = {}, headers = null) => {
  const fetchOptions = {
    cache: "no-store",
    credentials: "include"
  };
  if (headers) {
    fetchOptions.headers = headers;
  }
  if (options.referrer) {
    fetchOptions.referrer = options.referrer;
    fetchOptions.referrerPolicy = "strict-origin-when-cross-origin";
  }
  return fetchOptions;
};

export const fetchText = async (url, options = {}) => {
  const res = await fetch(url, buildFetchOptions(options));
  if (!res.ok) {
    const error = new Error(`Playlist request failed (${res.status})`);
    error.status = res.status;
    error.url = url;
    throw error;
  }
  const text = await res.text();
  return {
    text,
    url: res.url || url,
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") || "",
      "content-length": res.headers.get("content-length") || ""
    }
  };
};

const fetchBinary = async (url, options = {}) => {
  const res = await fetch(url, buildFetchOptions(options));
  if (!res.ok) {
    const label = options.context || "Segment";
    const error = new Error(`${label} request failed (${res.status})`);
    error.status = res.status;
    error.url = url;
    throw error;
  }
  return res.arrayBuffer();
};

const fetchBinaryRange = async (url, offset, length, options = {}) => {
  const end = offset + length - 1;
  const headers = { Range: `bytes=${offset}-${end}` };
  const res = await fetch(url, buildFetchOptions(options, headers));
  if (!res.ok && res.status !== 206) {
    const error = new Error(`Range request failed (${res.status})`);
    error.code = "range-failed";
    error.status = res.status;
    error.url = url;
    throw error;
  }
  return res.arrayBuffer();
};

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

const fetchBinaryRangeWithHeaders = async (url, offset, options = {}) => {
  const headers = { Range: `bytes=${offset}-` };
  const fetchOptions = {
    cache: "no-store",
    credentials: "include",
    headers
  };
  if (options.referrer) {
    fetchOptions.referrer = options.referrer;
    fetchOptions.referrerPolicy = "strict-origin-when-cross-origin";
  }
  const res = await fetch(url, fetchOptions);
  const contentRange = res.headers.get("content-range") || "";
  const contentType = res.headers.get("content-type") || "";
  const contentLength = res.headers.get("content-length") || "";
  if (!res.ok && res.status !== 206) {
    const error = new Error(`Range request failed (${res.status})`);
    error.code = "range-failed";
    error.status = res.status;
    error.contentRange = contentRange;
    error.contentType = contentType;
    error.contentLength = contentLength;
    throw error;
  }
  const buffer = await res.arrayBuffer();
  return {
    buffer,
    contentRange,
    contentType,
    contentLength,
    status: res.status
  };
};

const parseMasterPlaylist = (text, baseUrl) => {
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      const attrText = line.slice("#EXT-X-STREAM-INF:".length);
      const attrs = parseAttributeList(attrText);
      const next = lines[i + 1] || "";
      if (next && !next.startsWith("#")) {
        variants.push({
          uri: resolvePlaylistUrl(next.trim(), baseUrl),
          bandwidth:
            parseInt(attrs["average-bandwidth"] || attrs.bandwidth || "0", 10) ||
            0,
          resolution: attrs.resolution || null
        });
      }
    }
  }
  return variants;
};

const parseMediaPlaylist = (text, baseUrl) => {
  const lines = text.split(/\r?\n/);
  const segments = [];
  let initSegment = null;
  let hasByteRange = false;
  let encryption = null;
  let currentKey = null;
  let mediaSequence = 0;
  let pendingByteRange = null;
  const lastOffsetByUrl = new Map();
  let totalDuration = 0;
  let pendingDuration = null;

  const parseByteRange = (value, urlKey) => {
    if (!value) return null;
    const [lenStr, offsetStr] = value.split("@");
    const length = parseInt(lenStr, 10);
    if (!Number.isFinite(length) || length <= 0) return null;
    let offset;
    if (offsetStr !== undefined) {
      offset = parseInt(offsetStr, 10);
      if (!Number.isFinite(offset) || offset < 0) offset = 0;
    } else {
      const last = lastOffsetByUrl.get(urlKey) || 0;
      offset = last;
    }
    lastOffsetByUrl.set(urlKey, offset + length);
    return { length, offset };
  };

  const parseDuration = (value) => {
    const num = parseFloat(value);
    if (!Number.isFinite(num) || num < 0) return null;
    return num;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#EXT-X-MEDIA-SEQUENCE")) {
      const value = trimmed.split(":", 2)[1];
      const seq = parseInt((value || "").trim(), 10);
      if (Number.isFinite(seq) && seq >= 0) {
        mediaSequence = seq;
      }
      continue;
    }
    if (trimmed.startsWith("#EXT-X-KEY")) {
      const attrs = parseAttributeList(trimmed.slice("#EXT-X-KEY:".length));
      const method = (attrs.method || "").toUpperCase();
      if (!method || method === "NONE") {
        currentKey = null;
        continue;
      }
      currentKey = {
        method,
        uri: attrs.uri ? resolvePlaylistUrl(attrs.uri, baseUrl) : null,
        iv: attrs.iv || null,
        keyFormat: attrs.keyformat || null,
        keyFormatVersions: attrs.keyformatversions || null
      };
      if (!encryption) {
        encryption = {
          method: currentKey.method,
          keyFormat: currentKey.keyFormat
        };
      }
      continue;
    }
    if (trimmed.startsWith("#EXT-X-BYTERANGE")) {
      hasByteRange = true;
      const rangeText = trimmed.slice("#EXT-X-BYTERANGE:".length).trim();
      pendingByteRange = rangeText;
      continue;
    }
    if (trimmed.startsWith("#EXTINF")) {
      const durText = trimmed.split(":", 2)[1];
      if (durText) {
        pendingDuration = parseDuration(durText.split(",")[0]);
      }
      continue;
    }
    if (trimmed.startsWith("#EXT-X-MAP")) {
      const attrs = parseAttributeList(trimmed.slice("#EXT-X-MAP:".length));
      if (attrs.uri) {
        const uri = resolvePlaylistUrl(attrs.uri, baseUrl);
        let range = null;
        if (attrs.byterange) {
          hasByteRange = true;
          range = parseByteRange(attrs.byterange, uri);
        }
        initSegment = { url: uri, range };
      }
      continue;
    }
    if (trimmed.startsWith("#")) continue;
    const url = resolvePlaylistUrl(trimmed, baseUrl);
    let range = null;
    if (pendingByteRange) {
      range = parseByteRange(pendingByteRange, url);
      pendingByteRange = null;
    }
    const sequence = mediaSequence + segments.length;
    segments.push({
      url,
      range,
      duration: pendingDuration,
      sequence,
      key: currentKey ? { ...currentKey } : null
    });
    if (pendingDuration) {
      totalDuration += pendingDuration;
      pendingDuration = null;
    }
  }
  const encrypted = segments.some(
    (segment) => segment.key && segment.key.method && segment.key.method !== "NONE"
  );
  return { segments, initSegment, encrypted, hasByteRange, totalDuration, encryption };
};

const decodeDataUri = (uri) => {
  if (!uri || typeof uri !== "string" || !uri.startsWith("data:")) return null;
  const commaIndex = uri.indexOf(",");
  if (commaIndex < 0) return null;
  const meta = uri.slice(5, commaIndex);
  const payload = uri.slice(commaIndex + 1);
  const isBase64 = /;base64/i.test(meta);
  try {
    if (isBase64) {
      const binary = atob(payload);
      const out = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        out[i] = binary.charCodeAt(i);
      }
      return out;
    }
    const decoded = decodeURIComponent(payload);
    return new TextEncoder().encode(decoded);
  } catch (err) {
    return null;
  }
};

const hexToBytes = (value) => {
  if (!value) return null;
  let hex = value.trim();
  if (hex.startsWith("0x") || hex.startsWith("0X")) {
    hex = hex.slice(2);
  }
  if (!hex) return null;
  if (hex.length % 2 === 1) {
    hex = `0${hex}`;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = hex.slice(i * 2, i * 2 + 2);
    const parsed = parseInt(byte, 16);
    if (!Number.isFinite(parsed)) return null;
    out[i] = parsed;
  }
  return out;
};

const buildIvBytes = (ivValue, sequence) => {
  const raw = ivValue ? hexToBytes(ivValue) : null;
  if (raw && raw.length) {
    const normalized = new Uint8Array(16);
    const slice = raw.length > 16 ? raw.slice(raw.length - 16) : raw;
    normalized.set(slice, 16 - slice.length);
    return normalized;
  }
  const iv = new Uint8Array(16);
  let counter = BigInt(Number.isFinite(sequence) ? sequence : 0);
  for (let i = 15; i >= 0; i -= 1) {
    iv[i] = Number(counter & 0xffn);
    counter >>= 8n;
  }
  return iv;
};

const stripPkcs7Padding = (buffer) => {
  const bytes = new Uint8Array(buffer);
  if (!bytes.length) return buffer;
  const pad = bytes[bytes.length - 1];
  if (pad < 1 || pad > 16) return buffer;
  for (let i = 1; i <= pad; i += 1) {
    if (bytes[bytes.length - i] !== pad) return buffer;
  }
  return bytes.slice(0, bytes.length - pad).buffer;
};

const importAes128Key = async (keyBytes) => {
  if (!self?.crypto?.subtle) {
    throw new Error("WebCrypto is not available for AES-128 decryption.");
  }
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, [
    "decrypt"
  ]);
};

const decryptAes128Segment = async (buffer, cryptoKey, ivBytes) => {
  if (buffer.byteLength % 16 !== 0) {
    throw new Error("Encrypted segment size is not a multiple of 16 bytes.");
  }
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: ivBytes },
    cryptoKey,
    buffer
  );
  return stripPkcs7Padding(decrypted);
};

const concatBuffers = (buffers) => {
  const total = buffers.reduce((sum, buf) => sum + buf.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  buffers.forEach((buf) => {
    out.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  });
  return out.buffer;
};

const clampUInt32 = (value) => {
  if (!Number.isFinite(value) || value < 0) return 0;
  const max = 0xffffffff;
  if (value > max) return max;
  return Math.floor(value);
};

const updateInitForDuration = (buffer, totalSeconds) => {
  if (!buffer || !totalSeconds || totalSeconds <= 0) return buffer;
  try {
    const view = new DataView(buffer);
    const length = buffer.byteLength;

    const readBox = (offset) => {
      if (offset + 8 > length) return null;
      let size = view.getUint32(offset);
      const type = String.fromCharCode(view.getUint8(offset + 4), view.getUint8(offset + 5), view.getUint8(offset + 6), view.getUint8(offset + 7));
      if (size === 1 && offset + 16 <= length) size = view.getUint32(offset + 12);
      if (size === 0) size = length - offset;
      return { size, type, start: offset, end: offset + size };
    };

    let globalMvhdTimescale = 1;

    let offset = 0;
    while (offset + 8 <= length) {
      const box = readBox(offset);
      if (!box || !box.size) break;
      if (box.type === "moov") {
        let inner = box.start + 8;
        while (inner + 8 <= box.end) {
          const child = readBox(inner);
          if (!child || !child.size || child.end > box.end) break;
          
          if (child.type === "mvhd") {
            const version = view.getUint8(child.start + 8);
            if (version === 0) {
              globalMvhdTimescale = view.getUint32(child.start + 20);
              const newDuration = Math.min(0xFFFFFFFF, Math.floor(totalSeconds * (globalMvhdTimescale || 1)));
              view.setUint32(child.start + 24, newDuration);
            }
          }
          
          if (child.type === "trak") {
            let trakInner = child.start + 8;
            while (trakInner + 8 <= child.end) {
              const trakChild = readBox(trakInner);
              if (!trakChild || !trakChild.size || trakChild.end > child.end) break;
              
              if (trakChild.type === "tkhd") {
                const version = view.getUint8(trakChild.start + 8);
                if (version === 0) {
                  const newDuration = Math.min(0xFFFFFFFF, Math.floor(totalSeconds * (globalMvhdTimescale || 1)));
                  view.setUint32(trakChild.start + 28, newDuration);
                }
              }
              
              if (trakChild.type === "mdia") {
                let mdiaInner = trakChild.start + 8;
                while (mdiaInner + 8 <= trakChild.end) {
                  const mdiaChild = readBox(mdiaInner);
                  if (!mdiaChild || !mdiaChild.size || mdiaChild.end > trakChild.end) break;
                  
                  if (mdiaChild.type === "mdhd") {
                    const version = view.getUint8(mdiaChild.start + 8);
                    if (version === 0) {
                      const localTimescale = view.getUint32(mdiaChild.start + 20);
                      const newDuration = Math.min(0xFFFFFFFF, Math.floor(totalSeconds * (localTimescale || 1)));
                      view.setUint32(mdiaChild.start + 24, newDuration);
                    }
                  }
                  mdiaInner += mdiaChild.size;
                }
              }
              trakInner += trakChild.size;
            }
          }
          inner += child.size;
        }
        break;
      }
      offset += box.size;
    }
  } catch (err) {
    console.warn("Failed to patch fixed valid duration", err);
  }
  return buffer;
};

const deriveFileName = (sourceUrl, ext, title = null) => {
  const safeTitle = title
    ? String(title)
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160)
    : null;
  if (safeTitle) {
    return `m3u8/${safeTitle}.${ext}`;
  }
  try {
    const url = new URL(sourceUrl);
    const base = url.pathname.split("/").filter(Boolean).pop() || "video";
    const cleanBase = base.replace(/\.m3u8$/i, "") || "video";
    return `m3u8/${cleanBase}.${ext}`;
  } catch (err) {
    return `m3u8/video.${ext}`;
  }
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
  return `${name}.${lowerExt}`;
};

const getFilenameFromUrl = (sourceUrl) => {
  try {
    const url = new URL(sourceUrl);
    const base = url.pathname.split("/").filter(Boolean).pop();
    if (!base) return null;
    const decoded = decodeURIComponent(base);
    if (decoded.startsWith("{") && decoded.endsWith("}")) return null;
    if (decoded.length > 200) return null;
    return decoded;
  } catch (err) {
    return null;
  }
};

const deriveDirectFileName = (sourceUrl, { fileName, contentType, format } = {}) => {
  const telegramInfo = parseTelegramStreamInfo(sourceUrl);
  const ext =
    (typeof format === "string" && format.toLowerCase()) ||
    detectFormatFromContentType(contentType || "") ||
    detectFormatFromUrl(sourceUrl) ||
    (telegramInfo?.mimeType ? mapMimeToExt(telegramInfo.mimeType) : null) ||
    "mp4";

  let base =
    fileName ||
    buildTelegramFileName(telegramInfo) ||
    getFilenameFromUrl(sourceUrl) ||
    `video-${Date.now()}`;

  base = sanitizeFilename(base, "video");
  base = ensureExtension(base, ext);
  return `${DIRECT_VIDEO_FOLDER}/${base}`;
};

const makeObjectUrl = (blob) => {
  const factory =
    (typeof self !== "undefined" && self.URL && self.URL.createObjectURL && self.URL) ||
    (typeof URL !== "undefined" && URL.createObjectURL && URL) ||
    (typeof self !== "undefined" && self.webkitURL && self.webkitURL.createObjectURL && self.webkitURL);
  if (!factory) return null;
  try {
    return factory.createObjectURL(blob);
  } catch (err) {
    return null;
  }
};

const revokeObjectUrl = (url) => {
  const factory =
    (typeof self !== "undefined" && self.URL && self.URL.revokeObjectURL && self.URL) ||
    (typeof URL !== "undefined" && URL.revokeObjectURL && URL) ||
    (typeof self !== "undefined" &&
      self.webkitURL &&
      self.webkitURL.revokeObjectURL &&
      self.webkitURL);
  if (!factory) return;
  try {
    factory.revokeObjectURL(url);
  } catch (err) {
    // noop
  }
};

const MAX_DATA_URL_BYTES = 25 * 1024 * 1024;

const ensureDataUrlSafe = (buffer) => {
  const size = buffer?.byteLength || 0;
  if (!size || size <= MAX_DATA_URL_BYTES) return;
  const mb = (size / (1024 * 1024)).toFixed(1);
  throw new Error(
    `Video is ${mb} MB. Data URL download is too large; streaming to disk is required.`
  );
};

const arrayBufferToBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
};

const arrayBufferToDataUrl = (buffer, mime) => {
  ensureDataUrlSafe(buffer);
  return `data:${mime || "application/octet-stream"};base64,${arrayBufferToBase64(
    buffer
  )}`;
};

const downloadAssembled = (buffer, mime, sourceUrl, ext, progressCb, options = {}) =>
  new Promise((resolve) => {
    const filename = deriveFileName(sourceUrl, ext, options.title || null);
    progressCb?.({ phase: "saving", detail: "Preparing file for download", url: sourceUrl });

    const blob = new Blob([buffer], { type: mime });
    const objectUrl = makeObjectUrl(blob);

    const doDownload = (url) => {
      chrome.downloads.download(
        {
          url,
          filename,
          saveAs: true,
          conflictAction: "uniquify"
        },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve({ ok: true, downloadId, filename });
        }
      );
    };

    if (objectUrl) {
      doDownload(objectUrl);
      setTimeout(() => revokeObjectUrl(objectUrl), 60_000);
      return;
    }

    let dataUrl;
    try {
      dataUrl = arrayBufferToDataUrl(buffer, mime);
    } catch (err) {
      throw err;
    }
    doDownload(dataUrl);
  });

const downloadAssembledDirect = (
  buffer,
  mime,
  sourceUrl,
  ext,
  progressCb,
  options = {}
) =>
  new Promise((resolve) => {
    const filename = deriveDirectFileName(sourceUrl, {
      fileName: options.fileName,
      contentType: mime || options.contentType,
      format: ext || options.format
    });
    progressCb?.({ phase: "saving", detail: "Preparing file for download", url: sourceUrl });

    const blob = new Blob([buffer], { type: mime || "application/octet-stream" });
    const objectUrl = makeObjectUrl(blob);

    const doDownload = (url) => {
      chrome.downloads.download(
        {
          url,
          filename,
          saveAs: true,
          conflictAction: "uniquify"
        },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve({ ok: true, downloadId, filename });
        }
      );
    };

    if (objectUrl) {
      doDownload(objectUrl);
      setTimeout(() => revokeObjectUrl(objectUrl), 60_000);
      return;
    }

    let dataUrl;
    try {
      dataUrl = arrayBufferToDataUrl(buffer, mime);
    } catch (err) {
      throw err;
    }
    doDownload(dataUrl);
  });

export const downloadDirectVideo = (url, options = {}) =>
  new Promise((resolve) => {
    const filename = deriveDirectFileName(url, options);
    chrome.downloads.download(
      {
        url,
        filename,
        saveAs: true,
        conflictAction: "uniquify"
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve({ ok: true, downloadId, filename });
      }
    );
  });

export const downloadTelegramStream = async (url, progressCb = () => {}, options = {}) => {
  const buffers = [];
  let offset = 0;
  let total = Number.isFinite(options.size) ? options.size : null;
  let mimeType = options.contentType || null;
  let completed = false;
  progressCb({ phase: "download-file", url, detail: "Downloading Telegram video..." });

  for (let i = 0; i < MAX_TELEGRAM_CHUNKS; i++) {
    const rangeHeader = `bytes=${offset}-`;
    let response;
    try {
      response = await fetchBinaryRangeWithHeaders(url, offset, {
        referrer: options.referrer
      });
    } catch (err) {
      recordTelegramFetch({
        url,
        range: rangeHeader,
        status: err?.status,
        contentRange: err?.contentRange,
        contentType: err?.contentType,
        contentLength: err?.contentLength,
        referrer: options.referrer,
        error: err?.message || String(err),
        note: "range-request-failed"
      });
      throw err;
    }
    const { buffer, contentRange, contentType, contentLength, status } = response;
    if (i === 0) {
      recordTelegramFetch({
        url,
        range: rangeHeader,
        status,
        contentRange,
        contentType,
        contentLength,
        referrer: options.referrer,
        note: "first-chunk"
      });
    }
    if (contentType && !mimeType) {
      mimeType = contentType;
    }
    if (contentType && contentType.toLowerCase().includes("text/html")) {
      recordTelegramFetch({
        url,
        range: rangeHeader,
        status,
        contentRange,
        contentType,
        contentLength,
        referrer: options.referrer,
        error: "Telegram returned HTML instead of video data.",
        note: "html-response"
      });
      throw new Error("Telegram returned HTML instead of video data (check login/access).");
    }
    buffers.push(buffer);

    if (status === 200 && offset === 0) {
      total = buffer.byteLength;
      offset = total;
      completed = true;
      recordTelegramFetch({
        url,
        range: rangeHeader,
        status,
        contentRange,
        contentType,
        contentLength,
        referrer: options.referrer,
        note: "single-chunk"
      });
      break;
    }

    const range = parseContentRange(contentRange);
    if (range) {
      if (Number.isFinite(range.total)) {
        total = range.total;
      }
      const nextOffset = range.end + 1;
      if (nextOffset <= offset) {
        const error = new Error("Telegram range did not advance.");
        error.code = "range-stalled";
        throw error;
      }
      offset = nextOffset;
    } else {
      offset += buffer.byteLength;
    }

    if (i % 3 === 0 || (total && offset >= total)) {
      progressCb({
        phase: "download-file",
        url,
        current: offset,
        total,
        detail: total ? `${offset}/${total} bytes` : `Downloaded ${offset} bytes`
      });
    }

    if (total && offset >= total) {
      completed = true;
      recordTelegramFetch({
        url,
        range: rangeHeader,
        status,
        contentRange,
        contentType,
        contentLength,
        referrer: options.referrer,
        note: "final-chunk"
      });
      break;
    }

    if (buffer.byteLength === 0) {
      throw new Error("Telegram stream returned empty data.");
    }
  }

  if (!completed && total && offset >= total) {
    completed = true;
  }

  if (!completed) {
    throw new Error("Telegram download did not complete.");
  }

  if (total && offset < total) {
    throw new Error("Telegram download incomplete.");
  }

  const mime = mimeType || "video/mp4";
  const ext = mapMimeToExt(mime);
  const combined = concatBuffers(buffers);
  return downloadAssembledDirect(combined, mime, url, ext, progressCb, options);
};

export const downloadVideoFromPlaylist = async (
  playlistUrl,
  depth = 0,
  progressCb = () => {},
  options = {}
) => {
  if (depth > MAX_VARIANT_RECURSION) {
    throw new Error("Too many variant indirections.");
  }
  const requestOptions = options.referrer
    ? options
    : { ...options, referrer: playlistUrl };
  const fallbackReferrer = playlistUrl;
  progressCb({ phase: "fetch-playlist", url: playlistUrl });
  const playlistResponse = await fetchText(playlistUrl, requestOptions);
  const playlistText = playlistResponse.text;
  const keyLines = playlistText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("#EXT-X-KEY"));
  if (keyLines.length) {
    recordMediaFetch({
      url: playlistResponse.url || playlistUrl,
      status: playlistResponse.status,
      contentType: playlistResponse.headers["content-type"],
      contentLength: playlistResponse.headers["content-length"],
      referrer: requestOptions.referrer,
      note: "playlist-keys",
      detail: keyLines.join("\n")
    });
  }
  if (playlistText.includes("#EXT-X-STREAM-INF")) {
    progressCb({ phase: "parse-master", url: playlistUrl });
    const variants = parseMasterPlaylist(playlistText, playlistUrl);
    if (!variants.length) throw new Error("No playable variants found.");
    const ordered = variants
      .slice()
      .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));

    const passes = [true, false]; // prefer init (fMP4) first, then any
    let lastErr = null;

    for (const preferInitOnly of passes) {
      for (let i = 0; i < ordered.length; i++) {
        const variant = ordered[i];
        const phase = i === 0 && preferInitOnly ? "pick-variant" : "fallback";
        const detail =
          i === 0 && preferInitOnly
            ? `Chose variant ${variant.resolution || ""} (${variant.bandwidth || 0} bps)${
                preferInitOnly ? " (preferring fMP4)" : ""
              }`
            : `Retrying with variant ${i + 1}/${ordered.length}${
                preferInitOnly ? " (preferring fMP4)" : ""
              }`;
        progressCb({ phase, url: variant.uri, detail });
        try {
          return await downloadVideoFromPlaylist(variant.uri, depth + 1, progressCb, {
            ...requestOptions,
            preferInitOnly
          });
        } catch (err) {
          lastErr = err;
          const retryable =
            err?.code === "range-failed" ||
            err?.hasByteRange ||
            err?.code === "no-init" ||
            /range/i.test(err?.message || "");
          if (!retryable) throw err;
          continue;
        }
      }
      // reset lastErr between passes to allow second pass errors to surface
      if (lastErr && lastErr.code !== "no-init") break;
    }
    if (lastErr) throw lastErr;
    throw new Error("All variants failed.");
  }

  progressCb({ phase: "parse-media", url: playlistUrl });
  const { segments, initSegment, encrypted, hasByteRange, totalDuration } =
    parseMediaPlaylist(playlistText, playlistUrl);
  const getMethod = (keyInfo) => String(keyInfo?.method || "").toUpperCase();
  const getKeyFormat = (keyInfo) =>
    keyInfo?.keyFormat ? String(keyInfo.keyFormat).toLowerCase() : null;

  if (encrypted) {
    const unsupportedMethod = segments.find(
      (segment) => segment.key && getMethod(segment.key) !== "AES-128"
    );
    if (unsupportedMethod) {
      const method = getMethod(unsupportedMethod.key) || "UNKNOWN";
      const format = unsupportedMethod.key?.keyFormat || null;
      throw new Error(
        `Unsupported HLS encryption method ${method}${
          format ? ` (keyformat ${format})` : ""
        }.`
      );
    }
    const unsupportedFormat = segments.find((segment) => {
      if (!segment.key) return false;
      const keyFormat = getKeyFormat(segment.key);
      return keyFormat && keyFormat !== "identity";
    });
    if (unsupportedFormat) {
      const keyFormat = unsupportedFormat.key?.keyFormat || "unknown";
      throw new Error(
        `Encrypted playlist uses key format ${keyFormat}. DRM encryption is not supported.`
      );
    }
    const missingKey = segments.find(
      (segment) => segment.key && getMethod(segment.key) === "AES-128" && !segment.key.uri
    );
    if (missingKey) {
      throw new Error("Encrypted playlist is missing the AES-128 key URI.");
    }
  }
  if (options.preferInitOnly && !initSegment) {
    const err = new Error("No init segment present in playlist.");
    err.code = "no-init";
    throw err;
  }
  if (!segments.length) {
    throw new Error("No media segments found in playlist.");
  }

  const keyCache = new Map();
  const cryptoKeyCache = new Map();
  const fetchBinaryWithFallback = async (url, opts, context) => {
    try {
      return await fetchBinary(url, { ...opts, context });
    } catch (err) {
      if (err?.status === 403 && opts?.referrer !== fallbackReferrer) {
        return fetchBinary(url, {
          ...opts,
          referrer: fallbackReferrer,
          context
        });
      }
      throw err;
    }
  };

  const fetchBinaryRangeWithFallback = async (url, offset, length, opts) => {
    try {
      return await fetchBinaryRange(url, offset, length, opts);
    } catch (err) {
      if (err?.status === 403 && opts?.referrer !== fallbackReferrer) {
        return fetchBinaryRange(url, offset, length, {
          ...opts,
          referrer: fallbackReferrer
        });
      }
      throw err;
    }
  };

  const getKeyBytes = async (keyInfo) => {
    if (!keyInfo) return null;
    const uri = keyInfo.uri;
    if (!uri) {
      throw new Error("Encrypted playlist is missing the AES-128 key URI.");
    }
    const cached = keyCache.get(uri);
    if (cached) return await cached;
    const promise = (async () => {
      try {
        const dataBytes = decodeDataUri(uri);
        const bytes =
          dataBytes ||
          new Uint8Array(
            await fetchBinaryWithFallback(uri, requestOptions, "Key")
          );
        if (bytes.length !== 16) {
          throw new Error(`Invalid AES-128 key length (${bytes.length} bytes).`);
        }
        return bytes;
      } catch (err) {
        recordMediaFetch({
          url: uri,
          status: err?.status,
          contentType: err?.contentType,
          contentLength: err?.contentLength,
          referrer: requestOptions.referrer,
          error: err?.message || String(err),
          note: "key-fetch-failed"
        });
        throw err;
      }
    })();
    keyCache.set(uri, promise);
    const result = await promise;
    keyCache.set(uri, result);
    return result;
  };

  const getCryptoKey = async (keyInfo) => {
    if (!keyInfo) return null;
    const uri = keyInfo.uri || `inline-${keyInfo.iv || "default"}`;
    const cached = cryptoKeyCache.get(uri);
    if (cached) return await cached;
    const promise = (async () => {
      const keyBytes = await getKeyBytes(keyInfo);
      return importAes128Key(keyBytes);
    })();
    cryptoKeyCache.set(uri, promise);
    const result = await promise;
    cryptoKeyCache.set(uri, result);
    return result;
  };

  const decryptIfNeeded = async (buffer, segment) => {
    if (!segment?.key || getMethod(segment.key) !== "AES-128") return buffer;
    const cryptoKey = await getCryptoKey(segment.key);
    const ivBytes = buildIvBytes(segment.key.iv, segment.sequence);
    return decryptAes128Segment(buffer, cryptoKey, ivBytes);
  };

  const buffers = [];
  let initBuffer = null;
  let initWritten = false;
  if (initSegment) {
    progressCb({ phase: "download-init", url: playlistUrl });
    try {
      if (initSegment.range) {
        initBuffer = await fetchBinaryRangeWithFallback(
          initSegment.url,
          initSegment.range.offset,
          initSegment.range.length,
          requestOptions
        );
      } else {
        initBuffer = await fetchBinaryWithFallback(
          initSegment.url,
          requestOptions,
          "Segment"
        );
      }
    } catch (err) {
      err.hasByteRange = hasByteRange;
      throw err;
    }
    if (options.stream && options.onData) {
      const patchedInit = updateInitForDuration(initBuffer, totalDuration);
      options.onData(patchedInit);
      initWritten = true;
    }
  }
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    try {
      let segmentBuffer;
      if (seg.range) {
        segmentBuffer = await fetchBinaryRangeWithFallback(
          seg.url,
          seg.range.offset,
          seg.range.length,
          requestOptions
        );
      } else {
        segmentBuffer = await fetchBinaryWithFallback(
          seg.url,
          requestOptions,
          "Segment"
        );
      }
      const decrypted = await decryptIfNeeded(segmentBuffer, seg);
      if (options.stream && options.onData) {
        options.onData(decrypted);
      } else {
        buffers.push(decrypted);
      }
    } catch (err) {
      err.hasByteRange = hasByteRange;
      throw err;
    }
    if (i === segments.length - 1 || i % 3 === 0) {
      progressCb({
        phase: "download-segments",
        current: i + 1,
        total: segments.length,
        url: playlistUrl
      });
    }
  }

  let mime = initSegment ? "video/mp4" : "video/mp2t";
  let ext = initSegment ? "mp4" : "ts";

  if (options.stream && options.onData) {
    if (initBuffer && !initWritten) {
      options.onData(updateInitForDuration(initBuffer, totalDuration));
    }
    return { ok: true, streamed: true, mime, ext, totalDuration };
  }

  progressCb({ phase: "assemble", url: playlistUrl });
  const parts = [];
  if (initBuffer) {
    const patchedInit = updateInitForDuration(initBuffer, totalDuration);
    parts.push(patchedInit);
  }
  parts.push(...buffers);
  const combined = concatBuffers(parts);
  return downloadAssembled(combined, mime, playlistUrl, ext, progressCb, options);
};

/* ── Lightweight XML-to-object parser (service-worker safe, no DOMParser) ── */

const parseXmlToNodes = (xml) => {
  const nodes = [];
  let pos = 0;

  const skipWhitespace = () => {
    while (pos < xml.length && /\s/.test(xml[pos])) pos++;
  };

  const decodeXmlEntities = (text) =>
    text
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"');

  const parseAttributes = () => {
    const attrs = {};
    while (pos < xml.length) {
      skipWhitespace();
      if (xml[pos] === ">" || xml[pos] === "/" || pos >= xml.length) break;
      // Read attribute name
      let name = "";
      while (pos < xml.length && xml[pos] !== "=" && xml[pos] !== ">" && xml[pos] !== "/" && !/\s/.test(xml[pos])) {
        name += xml[pos++];
      }
      if (!name) { pos++; continue; }
      skipWhitespace();
      if (xml[pos] !== "=") { attrs[name] = ""; continue; }
      pos++; // skip '='
      skipWhitespace();
      let value = "";
      const quote = xml[pos];
      if (quote === '"' || quote === "'") {
        pos++; // skip opening quote
        while (pos < xml.length && xml[pos] !== quote) {
          value += xml[pos++];
        }
        pos++; // skip closing quote
      } else {
        while (pos < xml.length && !/[\s>\/]/.test(xml[pos])) {
          value += xml[pos++];
        }
      }
      attrs[name] = decodeXmlEntities(value);
    }
    return attrs;
  };

  const parseNode = () => {
    skipWhitespace();
    // Skip comments, CDATA, processing instructions, and declarations
    if (xml.startsWith("<!--", pos)) {
      const end = xml.indexOf("-->", pos);
      pos = end < 0 ? xml.length : end + 3;
      return null;
    }
    if (xml.startsWith("<![CDATA[", pos)) {
      const end = xml.indexOf("]]>", pos);
      const text = xml.slice(pos + 9, end < 0 ? xml.length : end);
      pos = end < 0 ? xml.length : end + 3;
      return { type: "text", textContent: text };
    }
    if (xml.startsWith("<?", pos)) {
      const end = xml.indexOf("?>", pos);
      pos = end < 0 ? xml.length : end + 2;
      return null;
    }
    if (xml.startsWith("<!", pos)) {
      const end = xml.indexOf(">", pos);
      pos = end < 0 ? xml.length : end + 1;
      return null;
    }
    if (xml[pos] !== "<") {
      // Text content
      let text = "";
      while (pos < xml.length && xml[pos] !== "<") {
        text += xml[pos++];
      }
      const trimmed = text.trim();
      return trimmed ? { type: "text", textContent: trimmed } : null;
    }
    // Skip closing tags (handled by parent)
    if (xml[pos + 1] === "/") return null;

    pos++; // skip '<'
    let tagName = "";
    while (pos < xml.length && !/[\s>\/]/.test(xml[pos])) {
      tagName += xml[pos++];
    }
    if (!tagName) return null;

    const attrs = parseAttributes();
    skipWhitespace();

    // Self-closing tag
    if (xml[pos] === "/") {
      pos++; // skip '/'
      if (xml[pos] === ">") pos++; // skip '>'
      return makeElement(tagName, attrs, []);
    }
    pos++; // skip '>'

    // Parse children until closing tag
    const children = [];
    const closingTag = `</${tagName}`;
    while (pos < xml.length) {
      skipWhitespace();
      if (xml.startsWith(closingTag, pos)) {
        pos = xml.indexOf(">", pos + closingTag.length);
        if (pos >= 0) pos++; else pos = xml.length;
        break;
      }
      if (xml[pos + 1] === "/" && !xml.startsWith(closingTag, pos)) {
        // Mismatched closing tag – skip it
        const end = xml.indexOf(">", pos);
        pos = end < 0 ? xml.length : end + 1;
        continue;
      }
      const child = parseNode();
      if (child) children.push(child);
      if (pos >= xml.length) break;
    }
    return makeElement(tagName, attrs, children);
  };

  const makeElement = (tagName, attrs, children) => {
    const el = {
      type: "element",
      tagName,
      _attrs: attrs,
      children,
      getAttribute(name) {
        return this._attrs[name] !== undefined ? this._attrs[name] : null;
      },
      get textContent() {
        return this.children
          .map((c) => {
            if (c.type === "text") return c.textContent;
            if (c.type === "element") return c.textContent;
            return "";
          })
          .join("");
      },
      querySelectorAll(selector) {
        return querySelectorAll(this, selector);
      },
      querySelector(selector) {
        const results = querySelectorAll(this, selector);
        return results.length ? results[0] : null;
      },
      getElementsByTagName(name) {
        return querySelectorAll(this, name);
      }
    };
    return el;
  };

  const querySelectorAll = (root, selector) => {
    // Support: "TagName", ":scope > TagName", "Parent TagName" (descendant)
    const trimmed = selector.trim();
    const scopeDirectMatch = trimmed.match(/^:scope\s*>\s*(.+)$/);
    if (scopeDirectMatch) {
      const childTag = scopeDirectMatch[1].trim();
      return root.children.filter(
        (c) => c.type === "element" && c.tagName === childTag
      );
    }
    // Simple descendant
    const parts = trimmed.split(/\s+/);
    if (parts.length === 1) {
      // Recursive search by tag name
      const results = [];
      const walk = (node) => {
        if (node.type !== "element") return;
        if (node.tagName === parts[0]) results.push(node);
        node.children.forEach(walk);
      };
      root.children.forEach(walk);
      return results;
    }
    // Multi-level descendant (e.g., "Parent Child")
    let candidates = [root];
    for (const part of parts) {
      const next = [];
      for (const candidate of candidates) {
        const walk = (node) => {
          if (node.type !== "element") return;
          if (node.tagName === part) next.push(node);
          node.children.forEach(walk);
        };
        if (candidate.children) candidate.children.forEach(walk);
      }
      candidates = next;
    }
    return candidates;
  };

  // Parse top-level nodes
  while (pos < xml.length) {
    skipWhitespace();
    if (pos >= xml.length) break;
    const node = parseNode();
    if (node && node.type === "element") nodes.push(node);
  }

  // Create a document-like root wrapper
  const docRoot = makeElement("#document", {}, nodes);
  return docRoot;
};

const parseDashManifest = (xmlText) => {
  const doc = parseXmlToNodes(xmlText);
  const mpd = doc.querySelector("MPD");
  if (!mpd) throw new Error("Invalid MPD: missing MPD root.");
  const type = (mpd.getAttribute("type") || "static").toLowerCase();
  if (type !== "static") {
    throw new Error("Only static MPD is supported (no live).");
  }
  return { doc, mpd };
};

const pickDashTracks = (doc, mpdUrl) => {
  const period = doc.querySelector("Period");
  if (!period) throw new Error("Invalid MPD: missing Period.");

  const adaptations = Array.from(period.querySelectorAll("AdaptationSet"));
  if (!adaptations.length) throw new Error("Invalid MPD: missing AdaptationSet.");

  const baseAtMpd = chainBaseUrl(mpdUrl, doc.querySelector("MPD"));
  const baseAtPeriod = chainBaseUrl(baseAtMpd, period);

  const classifyType = (mime, contentType) => {
    const type = (contentType || mime || "").toLowerCase();
    if (type.includes("video")) return "video";
    if (type.includes("audio")) return "audio";
    return "other";
  };

  let bestVideo = null;
  let bestAudio = null;

  adaptations.forEach((adapt) => {
    const adaptMime = adapt.getAttribute("mimeType") || "";
    const adaptContent = adapt.getAttribute("contentType") || "";
    const baseAtAdapt = chainBaseUrl(baseAtPeriod, adapt);
    const reps = Array.from(adapt.querySelectorAll(":scope > Representation"));
    reps.forEach((rep) => {
      const mime = rep.getAttribute("mimeType") || adaptMime;
      const contentType = rep.getAttribute("contentType") || adaptContent;
      const bandwidth = parseInt(rep.getAttribute("bandwidth") || "0", 10) || 0;
      const trackType = classifyType(mime, contentType);
      const baseAtRep = chainBaseUrl(baseAtAdapt, rep);
      const repId = rep.getAttribute("id") || "rep";
      const candidate = {
        rep,
        adapt,
        mime,
        bandwidth,
        trackType,
        baseUrl: baseAtRep,
        representationId: repId
      };
      if (trackType === "video") {
        if (!bestVideo || candidate.bandwidth > bestVideo.bandwidth) {
          bestVideo = candidate;
        }
      } else if (trackType === "audio") {
        if (!bestAudio || candidate.bandwidth > bestAudio.bandwidth) {
          bestAudio = candidate;
        }
      }
    });
  });

  if (!bestVideo && !bestAudio) throw new Error("No representations found in MPD.");
  return { video: bestVideo, audio: bestAudio };
};

const buildDashSegments = (mpdUrl, mpd, selection) => {
  const { rep, adapt, baseUrl, representationId, mime } = selection;
  const mpdDuration = parseISODurationSeconds(mpd.getAttribute("mediaPresentationDuration"));

  const list =
    rep.querySelector(":scope > SegmentList") || adapt.querySelector(":scope > SegmentList");
  const template =
    rep.querySelector(":scope > SegmentTemplate") ||
    adapt.querySelector(":scope > SegmentTemplate");

  let initSegment = null;
  const segments = [];

  if (list) {
    const initEl = list.querySelector(":scope > Initialization");
    if (initEl && initEl.getAttribute("sourceURL")) {
      initSegment = absoluteUrl(initEl.getAttribute("sourceURL"), baseUrl);
    }
    const segmentUrls = Array.from(list.querySelectorAll(":scope > SegmentURL"));
    if (!segmentUrls.length) throw new Error("SegmentList has no SegmentURL entries.");
    segmentUrls.forEach((seg) => {
      if (seg.getAttribute("mediaRange")) {
        throw new Error("Byte-range SegmentURL is not supported.");
      }
      const media = seg.getAttribute("media");
      if (!media) throw new Error("SegmentURL missing media attribute.");
      segments.push({ url: absoluteUrl(media, baseUrl) });
    });
    return { initSegment, segments, mime, duration: mpdDuration };
  }

  if (template) {
    if (template.querySelector(":scope > SegmentTimeline")) {
      throw new Error("SegmentTimeline is not supported.");
    }
    const media = template.getAttribute("media");
    const init = template.getAttribute("initialization");
    const startNumber = parseInt(template.getAttribute("startNumber") || "1", 10) || 1;
    const timescale = parseInt(template.getAttribute("timescale") || "1", 10) || 1;
    const duration = parseInt(template.getAttribute("duration") || "0", 10) || 0;

    if (init) {
      const initPath = substituteTemplate(init, { number: startNumber, representationId, bandwidth: selection.bandwidth });
      initSegment = absoluteUrl(initPath, baseUrl);
    }
    if (!media) throw new Error("SegmentTemplate missing media attribute.");
    if (!duration || !mpdDuration) {
      throw new Error("SegmentTemplate missing duration or MPD duration.");
    }
    const segmentCount = Math.ceil((mpdDuration * timescale) / duration);
    if (segmentCount <= 0 || segmentCount > 20_000) {
      throw new Error("Invalid segment count derived from MPD.");
    }
    for (let i = 0; i < segmentCount; i++) {
      const number = startNumber + i;
      const mediaPath = substituteTemplate(media, { number, representationId, bandwidth: selection.bandwidth });
      segments.push({ url: absoluteUrl(mediaPath, baseUrl) });
    }
    return { initSegment, segments, mime, duration: mpdDuration };
  }

  throw new Error("Unsupported MPD: no SegmentList or SegmentTemplate.");
};

/* ── fMP4 track combiner: merges separate video + audio fMP4 streams ── */

const readBoxHeader = (view, offset, length) => {
  if (offset + 8 > length) return null;
  let size = view.getUint32(offset);
  const type =
    String.fromCharCode(view.getUint8(offset + 4)) +
    String.fromCharCode(view.getUint8(offset + 5)) +
    String.fromCharCode(view.getUint8(offset + 6)) +
    String.fromCharCode(view.getUint8(offset + 7));
  let headerSize = 8;
  if (size === 1 && offset + 16 <= length) {
    // 64-bit extended size — read as two 32-bit values
    const hi = view.getUint32(offset + 8);
    const lo = view.getUint32(offset + 12);
    size = hi * 0x100000000 + lo;
    headerSize = 16;
  }
  if (size === 0) size = length - offset; // box extends to EOF
  return { size, type, headerSize, start: offset, end: offset + size };
};

const findBox = (view, start, end, type) => {
  let offset = start;
  while (offset + 8 <= end) {
    const box = readBoxHeader(view, offset, end);
    if (!box || box.size < 8) break;
    if (box.type === type) return box;
    offset += box.size;
  }
  return null;
};

const findAllBoxes = (view, start, end, type) => {
  const results = [];
  let offset = start;
  while (offset + 8 <= end) {
    const box = readBoxHeader(view, offset, end);
    if (!box || box.size < 8) break;
    if (box.type === type) results.push(box);
    offset += box.size;
  }
  return results;
};

const remapTrackIdInMoov = (buffer, oldTrackId, newTrackId) => {
  // Scan through moov > trak > tkhd and moov > trak > mdia > mdhd
  // and update track_id fields. Also fix mvhd next_track_ID if present.
  const view = new DataView(buffer);
  const length = buffer.byteLength;
  const moov = findBox(view, 0, length, "moov");
  if (!moov) return;

  const traks = findAllBoxes(view, moov.start + 8, moov.end, "trak");
  for (const trak of traks) {
    const tkhd = findBox(view, trak.start + 8, trak.end, "tkhd");
    if (tkhd) {
      const version = view.getUint8(tkhd.start + 8);
      const trackIdOffset = version === 1
        ? tkhd.start + 8 + 4 + 8 + 8   // version(1) + flags(3) + creation(8) + mod(8)
        : tkhd.start + 8 + 4 + 4 + 4;   // version(1) + flags(3) + creation(4) + mod(4)
      const currentId = view.getUint32(trackIdOffset);
      if (currentId === oldTrackId) {
        view.setUint32(trackIdOffset, newTrackId);
      }
    }
  }

  // Update mvhd next_track_ID
  const mvhd = findBox(view, moov.start + 8, moov.end, "mvhd");
  if (mvhd) {
    const version = view.getUint8(mvhd.start + 8);
    // next_track_ID is the last 4 bytes of mvhd
    const nextTrackOffset = mvhd.start + mvhd.size - 4;
    const current = view.getUint32(nextTrackOffset);
    if (newTrackId >= current) {
      view.setUint32(nextTrackOffset, newTrackId + 1);
    }
  }
};

const getTrackIdFromMoov = (buffer) => {
  const view = new DataView(buffer);
  const length = buffer.byteLength;
  const moov = findBox(view, 0, length, "moov");
  if (!moov) return 1;
  const trak = findBox(view, moov.start + 8, moov.end, "trak");
  if (!trak) return 1;
  const tkhd = findBox(view, trak.start + 8, trak.end, "tkhd");
  if (!tkhd) return 1;
  const version = view.getUint8(tkhd.start + 8);
  const trackIdOffset = version === 1
    ? tkhd.start + 8 + 4 + 8 + 8
    : tkhd.start + 8 + 4 + 4 + 4;
  return view.getUint32(trackIdOffset);
};

const remapTrackIdInFragments = (buffer, oldTrackId, newTrackId) => {
  // In fMP4 fragments, track_id is in moof > traf > tfhd
  const view = new DataView(buffer);
  const length = buffer.byteLength;
  let offset = 0;
  while (offset + 8 <= length) {
    const box = readBoxHeader(view, offset, length);
    if (!box || box.size < 8) break;
    if (box.type === "moof") {
      const trafs = findAllBoxes(view, box.start + 8, box.end, "traf");
      for (const traf of trafs) {
        const tfhd = findBox(view, traf.start + 8, traf.end, "tfhd");
        if (tfhd) {
          // tfhd: version(1) + flags(3) + track_ID(4)
          const trackIdOffset = tfhd.start + 8 + 4;
          const currentId = view.getUint32(trackIdOffset);
          if (currentId === oldTrackId) {
            view.setUint32(trackIdOffset, newTrackId);
          }
        }
      }
    }
    offset += box.size;
  }
};

const extractMoovContents = (buffer) => {
  // Returns: { ftyp: ArrayBuffer|null, moov: ArrayBuffer, traks: ArrayBuffer[] }
  const view = new DataView(buffer);
  const length = buffer.byteLength;
  let ftyp = null;
  let moov = null;
  let offset = 0;
  while (offset + 8 <= length) {
    const box = readBoxHeader(view, offset, length);
    if (!box || box.size < 8) break;
    if (box.type === "ftyp") {
      ftyp = buffer.slice(box.start, box.end);
    }
    if (box.type === "moov") {
      moov = { start: box.start, end: box.end, size: box.size };
    }
    offset += box.size;
  }
  if (!moov) return { ftyp, traks: [], mvhdData: null, otherBoxes: [] };

  const traks = [];
  const otherBoxes = [];
  let mvhdData = null;
  let inner = moov.start + 8;
  while (inner + 8 <= moov.end) {
    const child = readBoxHeader(view, inner, moov.end);
    if (!child || child.size < 8) break;
    if (child.type === "trak") {
      traks.push(buffer.slice(child.start, child.end));
    } else if (child.type === "mvhd") {
      mvhdData = buffer.slice(child.start, child.end);
    } else {
      otherBoxes.push(buffer.slice(child.start, child.end));
    }
    inner += child.size;
  }
  return { ftyp, traks, mvhdData, otherBoxes };
};

const buildMoovBox = (mvhdData, traks, otherBoxes) => {
  // Calculate total size
  let contentSize = 0;
  if (mvhdData) contentSize += mvhdData.byteLength;
  for (const trak of traks) contentSize += trak.byteLength;
  for (const box of otherBoxes) contentSize += box.byteLength;
  const totalSize = 8 + contentSize; // moov header (8) + contents

  const output = new Uint8Array(totalSize);
  const headerView = new DataView(output.buffer);
  headerView.setUint32(0, totalSize);
  output[4] = 0x6D; // m
  output[5] = 0x6F; // o
  output[6] = 0x6F; // o
  output[7] = 0x76; // v

  let pos = 8;
  if (mvhdData) {
    output.set(new Uint8Array(mvhdData), pos);
    pos += mvhdData.byteLength;
  }
  for (const trak of traks) {
    output.set(new Uint8Array(trak), pos);
    pos += trak.byteLength;
  }
  for (const box of otherBoxes) {
    output.set(new Uint8Array(box), pos);
    pos += box.byteLength;
  }
  return output.buffer;
};

const mergeMvexBoxes = (videoOther, audioOther, audioTrackId, newAudioTrackId) => {
  let vIndex = -1;
  let aIndex = -1;
  
  for (let i = 0; i < videoOther.length; i++) {
    const v = new DataView(videoOther[i]);
    if (v.byteLength >= 8) {
      if (String.fromCharCode(v.getUint8(4), v.getUint8(5), v.getUint8(6), v.getUint8(7)) === "mvex") vIndex = i;
    }
  }
  for (let i = 0; i < audioOther.length; i++) {
    const v = new DataView(audioOther[i]);
    if (v.byteLength >= 8) {
      if (String.fromCharCode(v.getUint8(4), v.getUint8(5), v.getUint8(6), v.getUint8(7)) === "mvex") aIndex = i;
    }
  }

  if (vIndex !== -1 && aIndex !== -1) {
    const vMvex = videoOther[vIndex];
    const aMvex = audioOther[aIndex];
    
    // Extract specifically trex boxes
    const aTrex = [];
    const aView = new DataView(aMvex);
    let offset = 8;
    while (offset + 8 <= aMvex.byteLength) {
      const box = readBoxHeader(aView, offset, aMvex.byteLength);
      if (!box || box.size < 8) break;
      if (box.type === "trex") {
        const trexCopy = aMvex.slice(box.start, box.end);
        const tView = new DataView(trexCopy);
        const currentId = tView.getUint32(12);
        if (currentId === audioTrackId) {
          tView.setUint32(12, newAudioTrackId);
        }
        aTrex.push(trexCopy);
      }
      offset += box.size;
    }

    if (aTrex.length > 0) {
      const extraSize = aTrex.reduce((sum, b) => sum + b.byteLength, 0);
      const newMvex = new Uint8Array(vMvex.byteLength + extraSize);
      newMvex.set(new Uint8Array(vMvex), 0);
      let outOffset = vMvex.byteLength;
      for (const t of aTrex) {
        newMvex.set(new Uint8Array(t), outOffset);
        outOffset += t.byteLength;
      }
      
      const newView = new DataView(newMvex.buffer);
      newView.setUint32(0, newMvex.byteLength);
      videoOther[vIndex] = newMvex.buffer;
    }
  }
};

const buildCombinedInit = (videoInit, audioInit) => {
  // 1. Extract moov contents from both inits
  const videoParsed = extractMoovContents(videoInit);
  const audioParsed = extractMoovContents(audioInit);

  // 2. Determine track IDs and remap if needed
  const videoTrackId = videoInit ? getTrackIdFromMoov(videoInit) : 1;
  let audioTrackId = audioInit ? getTrackIdFromMoov(audioInit) : 2;

  let audioNeedsRemap = false;
  let newAudioTrackId = audioTrackId;
  if (audioTrackId === videoTrackId) {
    newAudioTrackId = videoTrackId + 1;
    audioNeedsRemap = true;
  }

  // 3. Remap audio track IDs in init
  if (audioNeedsRemap) {
    for (let i = 0; i < audioParsed.traks.length; i++) {
      const trakCopy = audioParsed.traks[i].slice(0);
      remapTrackIdInMoov(trakCopy, audioTrackId, newAudioTrackId);
      audioParsed.traks[i] = trakCopy;
    }
  }

  // 4. Update mvhd next_track_ID
  let mvhdData = videoParsed.mvhdData;
  if (mvhdData) {
    mvhdData = mvhdData.slice(0); // copy
    const mvView = new DataView(mvhdData);
    const nextTrackOffset = mvhdData.byteLength - 4;
    const maxId = Math.max(videoTrackId, newAudioTrackId);
    mvView.setUint32(nextTrackOffset, maxId + 1);
  }

  // 5. Merge mvex metadata securely
  const otherBoxes = [...videoParsed.otherBoxes];
  mergeMvexBoxes(otherBoxes, audioParsed.otherBoxes, audioTrackId, newAudioTrackId);

  // 6. Build combined moov
  const allTraks = [...videoParsed.traks, ...audioParsed.traks];
  const combinedMoov = buildMoovBox(mvhdData, allTraks, otherBoxes);

  // 7. Assemble header output: ftyp + moov
  const parts = [];
  if (videoParsed.ftyp) parts.push(videoParsed.ftyp);
  else if (audioParsed.ftyp) parts.push(audioParsed.ftyp);
  parts.push(combinedMoov);

  return {
    combinedInit: concatBuffers(parts),
    audioTrackId,
    newAudioTrackId,
    audioNeedsRemap
  };
};

export const downloadDashVideo = async (mpdUrl, progressCb = () => {}, options = {}) => {
  const requestOptions = options.referrer ? options : { ...options, referrer: mpdUrl };
  progressCb({ phase: "fetch-manifest", url: mpdUrl });
  const mpdResponse = await fetchText(mpdUrl, requestOptions);
  const mpdText = mpdResponse.text;
  progressCb({ phase: "parse-manifest", url: mpdUrl });
  const { doc, mpd } = parseDashManifest(mpdText);

  const tracks = pickDashTracks(doc, mpdUrl);
  const hasVideo = !!tracks.video;
  const hasAudio = !!tracks.audio;

  if (hasVideo) {
    progressCb({
      phase: "pick-representation",
      url: mpdUrl,
      detail: `Video: ${tracks.video.mime || "video/mp4"} at ${tracks.video.bandwidth || 0} bps`
    });
  }
  if (hasAudio) {
    progressCb({
      phase: "pick-representation",
      url: mpdUrl,
      detail: `Audio: ${tracks.audio.mime || "audio/mp4"} at ${tracks.audio.bandwidth || 0} bps`
    });
  }

  // Build segment lists for each track
  let videoSegmentInfo = null;
  let audioSegmentInfo = null;
  if (hasVideo) {
    videoSegmentInfo = buildDashSegments(mpdUrl, mpd, tracks.video);
  }
  if (hasAudio) {
    audioSegmentInfo = buildDashSegments(mpdUrl, mpd, tracks.audio);
  }

  const totalSegments =
    (videoSegmentInfo?.segments.length || 0) +
    (audioSegmentInfo?.segments.length || 0);
  let downloadedCount = 0;

  const mimeType = hasVideo ? "video/mp4" : "audio/mp4";
  const ext = "mp4";

  let videoInitBuffer = null;
  let audioInitBuffer = null;
  
  // Download inits
  if (hasVideo && videoSegmentInfo?.initSegment) {
    progressCb({ phase: "download-init", url: mpdUrl, detail: "Downloading video init segment" });
    videoInitBuffer = await fetchBinary(videoSegmentInfo.initSegment, requestOptions);
  }
  if (hasAudio && audioSegmentInfo?.initSegment) {
    progressCb({ phase: "download-init", url: mpdUrl, detail: "Downloading audio init segment" });
    audioInitBuffer = await fetchBinary(audioSegmentInfo.initSegment, requestOptions);
  }

  let audioTrackId = 2;
  let newAudioTrackId = 2;
  let audioNeedsRemap = false;
  const videoFragments = [];
  const audioFragments = [];
  let combinedInitBuffer = null;

  if (hasVideo && hasAudio && videoInitBuffer && audioInitBuffer) {
    const merged = buildCombinedInit(videoInitBuffer, audioInitBuffer);
    audioTrackId = merged.audioTrackId;
    newAudioTrackId = merged.newAudioTrackId;
    audioNeedsRemap = merged.audioNeedsRemap;
    combinedInitBuffer = merged.combinedInit;
  } else if (hasVideo && videoInitBuffer) {
    combinedInitBuffer = videoInitBuffer;
  } else if (hasAudio && audioInitBuffer) {
    combinedInitBuffer = audioInitBuffer;
  }

  // 8. Patch duration so Windows natively understands this is a finite VOD rather than endless Live Stream.
  if (videoSegmentInfo?.duration || audioSegmentInfo?.duration) {
    const totalDuration = videoSegmentInfo?.duration || audioSegmentInfo?.duration;
    combinedInitBuffer = updateInitForDuration(combinedInitBuffer, totalDuration);
  }

  if (options.stream && options.onData) {
    if (combinedInitBuffer) options.onData(combinedInitBuffer);
  }

  // Helper for parallel interleaved downloading
  const downloadInterleavedSegments = async (videoInfo, audioInfo) => {
    const concurrency = 5;
    let currentDownloaded = 0;
    let head = 0;
    let tail = 0;

    const vSegs = videoInfo ? videoInfo.segments : [];
    const aSegs = audioInfo ? audioInfo.segments : [];
    const maxLen = Math.max(vSegs.length, aSegs.length);

    const vInFlight = new Array(vSegs.length);
    const aInFlight = new Array(aSegs.length);

    let baseVideoTfdt = null;
    let baseAudioTfdt = null;

    const normalizeTfdtOffset = (buffer, type) => {
      try {
        const view = new DataView(buffer);
        const length = buffer.byteLength;
        let offset = 0;
        while (offset + 8 <= length) {
          let size = view.getUint32(offset);
          if (size === 1) size = view.getUint32(offset + 12);
          if (!size || size < 8) break;
          const boxType = String.fromCharCode(view.getUint8(offset + 4), view.getUint8(offset + 5), view.getUint8(offset + 6), view.getUint8(offset + 7));
          if (boxType === "moof") {
            let childOffset = offset + 8;
            const endChild = offset + size;
            while (childOffset + 8 <= endChild) {
              let cSize = view.getUint32(childOffset);
              if (cSize === 1) cSize = view.getUint32(childOffset + 12);
              if (!cSize || cSize < 8) break;
              const cType = String.fromCharCode(view.getUint8(childOffset + 4), view.getUint8(childOffset + 5), view.getUint8(childOffset + 6), view.getUint8(childOffset + 7));
              if (cType === "traf") {
                let tOffset = childOffset + 8;
                const tEnd = childOffset + cSize;
                while (tOffset + 8 <= tEnd) {
                  let tSize = view.getUint32(tOffset);
                  if (!tSize || tSize < 8) break;
                  const tType = String.fromCharCode(view.getUint8(tOffset + 4), view.getUint8(tOffset + 5), view.getUint8(tOffset + 6), view.getUint8(tOffset + 7));
                  if (tType === "tfdt") {
                    const version = view.getUint8(tOffset + 8);
                    if (version === 1) { // 64-bit
                      const hi = view.getUint32(tOffset + 12);
                      const lo = view.getUint32(tOffset + 16);
                      const decodeTime = BigInt(hi) * 0x100000000n + BigInt(lo);
                      if (type === "video") {
                        if (baseVideoTfdt === null) baseVideoTfdt = decodeTime;
                        const diff = decodeTime - baseVideoTfdt;
                        const val = diff < 0n ? 0n : diff;
                        view.setUint32(tOffset + 12, Number(val >> 32n));
                        view.setUint32(tOffset + 16, Number(val & 0xFFFFFFFFn));
                      } else {
                        if (baseAudioTfdt === null) baseAudioTfdt = decodeTime;
                        const diff = decodeTime - baseAudioTfdt;
                        const val = diff < 0n ? 0n : diff;
                        view.setUint32(tOffset + 12, Number(val >> 32n));
                        view.setUint32(tOffset + 16, Number(val & 0xFFFFFFFFn));
                      }
                    } else { // 32-bit
                      const decodeTime = view.getUint32(tOffset + 12);
                      if (type === "video") {
                        if (baseVideoTfdt === null) baseVideoTfdt = decodeTime;
                        const diff = decodeTime - baseVideoTfdt;
                        view.setUint32(tOffset + 12, diff < 0 ? 0 : diff);
                      } else {
                        if (baseAudioTfdt === null) baseAudioTfdt = decodeTime;
                        const diff = decodeTime - baseAudioTfdt;
                        view.setUint32(tOffset + 12, diff < 0 ? 0 : diff);
                      }
                    }
                  }
                  tOffset += tSize;
                }
              }
              childOffset += cSize;
            }
          }
          offset += size;
        }
      } catch (err) { }
    };

    // Initial fill
    while (tail < Math.min(concurrency, maxLen)) {
      if (tail < vSegs.length) vInFlight[tail] = fetchBinary(vSegs[tail].url, requestOptions);
      if (tail < aSegs.length) aInFlight[tail] = fetchBinary(aSegs[tail].url, requestOptions);
      tail++;
    }

    while (head < maxLen) {
      // 1. Resolve and yield video if present
      if (head < vSegs.length) {
        const segBuffer = await vInFlight[head];
        const finalBuffer = segBuffer.slice(0);
        normalizeTfdtOffset(finalBuffer, "video");

        if (options.stream && options.onData) {
          const p = options.onData(finalBuffer);
          if (p && p.then) await p;
        } else {
          videoFragments.push(finalBuffer);
        }
        currentDownloaded++;
      }

      // 2. Resolve and yield aligned audio if present
      if (head < aSegs.length) {
        const segBuffer = await aInFlight[head];
        const finalBuffer = segBuffer.slice(0);
        
        if (audioNeedsRemap) {
          remapTrackIdInFragments(finalBuffer, audioTrackId, newAudioTrackId);
        }
        normalizeTfdtOffset(finalBuffer, "audio");

        if (options.stream && options.onData) {
          const p = options.onData(finalBuffer);
          if (p && p.then) await p;
        } else {
          audioFragments.push(finalBuffer);
        }
        currentDownloaded++;
      }

      if (head === maxLen - 1 || head % 2 === 0) {
        progressCb({
          phase: "download-segments",
          current: currentDownloaded,
          total: totalSegments,
          url: mpdUrl,
          detail: `Muxing interleaved segments ${head + 1} / ${maxLen}`
        });
      }

      head++;

      // sliding window: queue the next aligned pieces
      if (tail < maxLen) {
        if (tail < vSegs.length) vInFlight[tail] = fetchBinary(vSegs[tail].url, requestOptions);
        if (tail < aSegs.length) aInFlight[tail] = fetchBinary(aSegs[tail].url, requestOptions);
        tail++;
      }
    }
  };

  // Download tracks perfectly chronologically interwoven
  await downloadInterleavedSegments(videoSegmentInfo, audioSegmentInfo);

  if (options.stream && options.onData) {
    return { ok: true, streamed: true, mime: mimeType, ext };
  }

  progressCb({ phase: "assemble", url: mpdUrl, detail: "Assembling tracks..." });

  const finalParts = [];
  if (combinedInitBuffer) finalParts.push(combinedInitBuffer);
  finalParts.push(...videoFragments);
  finalParts.push(...audioFragments);
  
  const combined = concatBuffers(finalParts);
  return downloadAssembled(combined, mimeType, mpdUrl, ext, progressCb, options);
};

export const isLikelyPlaylistContentType = (contentType) => {
  if (!contentType) return false;
  const lowered = contentType.toLowerCase();
  return (
    lowered.includes("mpegurl") ||
    lowered.includes("vnd.apple.mpegurl") ||
    lowered.includes("application/x-mpegurl") ||
    lowered.includes("application/mpegurl") ||
    lowered.includes("dash+xml") ||
    lowered.includes("f4m") ||
    lowered.includes("smoothstream") ||
    lowered.includes("vnd.ms-sstr+xml") ||
    lowered.includes("pls")
  );
};

export const isLikelyVideoContentType = (contentType) => {
  if (!contentType) return false;
  const lowered = contentType.toLowerCase();
  if (lowered.startsWith("video/")) {
    if (lowered.includes("mp2t")) return false;
    return true;
  }
  if (lowered.startsWith("audio/")) return true;
  return false;
};

/* ── Streaming-to-disk wrappers ── */

/**
 * Attempt to download an HLS playlist using streaming-to-disk via the offscreen document.
 * Returns the result on success, or null if streaming is not available (caller should fall back).
 */
export const streamHlsToDisk = async (
  playlistUrl,
  progressCb = () => {},
  options = {},
  offscreenApi
) => {
  const downloadId = `hls-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const ext = "mp4"; // will be refined after parsing
  const title = options.title || null;
  const suggestedName = deriveFileName(playlistUrl, ext, title).replace(/^m3u8\//, "");

  let streamReady = false;
  try {
    const response = await offscreenApi.startOffscreenStream(downloadId, suggestedName);
    if (!response || response.type === "streamFallback") {
      return null; // fall back to RAM-buffered
    }
    if (response.type === "streamReady") {
      streamReady = true;
    } else {
      return null;
    }
  } catch (err) {
    return null; // fall back
  }

  try {
    const onData = async (chunk) => {
      await offscreenApi.sendStreamChunk(downloadId, chunk);
    };

    const result = await downloadVideoFromPlaylist(playlistUrl, 0, progressCb, {
      ...options,
      stream: true,
      onData
    });

    await offscreenApi.endStream(downloadId);
    return { ok: true, filename: suggestedName, streamed: true, mime: result.mime, ext: result.ext };
  } catch (err) {
    if (streamReady) {
      try { await offscreenApi.abortStream(downloadId); } catch (_) {}
    }
    throw err;
  }
};

/**
 * Attempt to download a DASH video using streaming-to-disk via the offscreen document.
 * Returns the result on success, or null if streaming is not available (caller should fall back).
 */
export const streamDashToDisk = async (
  mpdUrl,
  progressCb = () => {},
  options = {},
  offscreenApi
) => {
  const downloadId = `dash-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const title = options.title || null;
  const suggestedName = deriveFileName(mpdUrl, "mp4", title).replace(/^m3u8\//, "");

  let streamReady = false;
  try {
    const response = await offscreenApi.startOffscreenStream(downloadId, suggestedName);
    if (!response || response.type === "streamFallback") {
      return null;
    }
    if (response.type === "streamReady") {
      streamReady = true;
    } else {
      return null;
    }
  } catch (err) {
    return null;
  }

  try {
    const onData = async (chunk) => {
      await offscreenApi.sendStreamChunk(downloadId, chunk);
    };

    const result = await downloadDashVideo(mpdUrl, progressCb, {
      ...options,
      stream: true,
      onData
    });

    await offscreenApi.endStream(downloadId);
    return { ok: true, filename: suggestedName, streamed: true, mime: result.mime, ext: result.ext };
  } catch (err) {
    if (streamReady) {
      try { await offscreenApi.abortStream(downloadId); } catch (_) {}
    }
    throw err;
  }
};
