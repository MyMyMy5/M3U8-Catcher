import {
  PLAYLIST_REGEX,
  TELEGRAM_HOST_REGEX,
  TELEGRAM_STREAM_PATH_REGEX,
  SUPPORTED_FORMATS
} from "./background-constants.js";

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
const SEGMENT_TOKEN_REGEX = /(?:^|[._-])(seg(?:ment)?|chunk|frag(?:ment)?|part)\d+(?:[._-]|$)/i;
const INIT_TOKEN_REGEX = /(?:^|[._-])init(?:[._-]|$)/i;
const MIME_PARAM_KEYS = ["mime", "type", "content_type", "contentType"];

export const normalizeUrl = (url) => {
  try {
    return new URL(url).toString();
  } catch (err) {
    return url;
  }
};

export const isValidTabId = (value) => Number.isFinite(value) && value >= 0;

export const isValidFrameId = (value) => Number.isFinite(value) && value >= 0;

export const isExtensionUrl = (value) =>
  typeof value === "string" && value.startsWith("chrome-extension://");

export const extractContentType = (headers = []) => {
  const header = headers.find(
    (item) => item.name && item.name.toLowerCase() === "content-type"
  );
  return header ? header.value || "" : "";
};

export const extractContentDispositionFilename = (headers = []) => {
  const header = headers.find(
    (item) => item.name && item.name.toLowerCase() === "content-disposition"
  );
  if (!header || !header.value) return null;
  const value = header.value;
  const starMatch = value.match(/filename\*\s*=\s*[^']*''([^;]+)/i);
  if (starMatch && starMatch[1]) {
    try {
      return decodeURIComponent(starMatch[1].trim());
    } catch (err) {
      return starMatch[1].trim();
    }
  }
  const match = value.match(/filename\s*=\s*"?([^\";]+)"?/i);
  return match && match[1] ? match[1].trim() : null;
};

export const extractContentLength = (headers = []) => {
  const header = headers.find(
    (item) => item.name && item.name.toLowerCase() === "content-length"
  );
  if (!header || !header.value) return null;
  const length = parseInt(header.value, 10);
  return Number.isFinite(length) && length > 0 ? length : null;
};

const normalizeMimeValue = (value) => {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed;
};

export const extractMimeFromUrl = (url) => {
  try {
    const parsed = new URL(url);
    for (const key of MIME_PARAM_KEYS) {
      const value = parsed.searchParams.get(key);
      const normalized = normalizeMimeValue(value);
      if (normalized) return normalized;
    }
  } catch (err) {
    return null;
  }
  return null;
};

export const isLikelyPlaylistMime = (mime) => {
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

export const isLikelyMediaMime = (mime) => {
  if (!mime) return false;
  const lowered = mime.toLowerCase();
  return lowered.startsWith("video/") || lowered.startsWith("audio/");
};

export const detectFormatFromContentType = (contentType = "") => {
  const lowered = contentType.toLowerCase();
  if (lowered.includes("mpegurl")) return "m3u8";
  if (lowered.includes("dash+xml")) return "mpd";
  if (lowered.includes("f4m")) return "f4m";
  if (lowered.includes("smoothstream")) return "ism";
  if (lowered.includes("pls")) return "pls";
  if (lowered.startsWith("video/") || lowered.startsWith("audio/")) {
    if (lowered.includes("mp2t")) return null;
    return mapMimeToExt(lowered);
  }
  return null;
};

export const detectFormatFromUrl = (url) => {
  const playlistMatch = url.match(PLAYLIST_REGEX);
  if (playlistMatch) {
    const ext = playlistMatch[1].toLowerCase();
    return SUPPORTED_FORMATS.includes(ext) ? ext : null;
  }
  const videoExt = getVideoExtensionFromUrl(url);
  if (videoExt) return videoExt;
  const mimeFromUrl = extractMimeFromUrl(url);
  if (mimeFromUrl) {
    const formatFromMime = detectFormatFromContentType(mimeFromUrl);
    if (formatFromMime) return formatFromMime;
  }
  const telegramInfo = parseTelegramStreamInfo(url);
  if (telegramInfo?.mimeType) return mapMimeToExt(telegramInfo.mimeType);
  return null;
};

export const mapMimeToExt = (mime) => {
  if (!mime) return "mp4";
  const lower = mime.toLowerCase();
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
  if (lower.includes("mp2t")) return "ts";
  if (lower.includes("aac")) return "aac";
  return "mp4";
};

export const getLastPathSegment = (url) => {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  } catch (err) {
    const stripped = String(url || "").split("?")[0].split("#")[0];
    const parts = stripped.split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  }
};

export const getVideoExtensionFromUrl = (url) => {
  const lastSegment = getLastPathSegment(url);
  if (!lastSegment) return null;
  const match = lastSegment.match(/\.([a-z0-9]{2,5})$/i);
  if (!match) return null;
  const ext = match[1].toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) return null;
  if (isLikelySegmentUrl(url)) return null;
  return ext;
};

export const isLikelySegmentUrl = (url) => {
  const lastSegment = getLastPathSegment(url);
  if (!lastSegment) return false;
  if (SEGMENT_EXT_REGEX.test(lastSegment)) return true;
  if (SEGMENT_TOKEN_REGEX.test(lastSegment)) return true;
  if (INIT_TOKEN_REGEX.test(lastSegment)) return true;
  // Detect DASH segment URLs that use query parameters (e.g. FreeTV/livx)
  // Segments have ?type=video&ft=1&...&idx=... or ?type=audio&ft=0&...&startTime=...
  // Manifests have ?indexMode&relativePaths&... and are NOT segments
  try {
    const parsed = new URL(url);
    const params = parsed.searchParams;
    if (params.has("indexMode")) return false; // this is the manifest itself
    const ft = params.get("ft");
    const type = params.get("type");
    if (type && (type === "video" || type === "audio") && ft !== null) {
      return true; // individual DASH segment or init request
    }
  } catch (_) { /* not a valid URL, skip */ }
  return false;
};

export const isTelegramStreamUrl = (url) => {
  try {
    const parsed = new URL(url);
    if (!TELEGRAM_HOST_REGEX.test(parsed.hostname)) return false;
    return TELEGRAM_STREAM_PATH_REGEX.test(parsed.pathname);
  } catch (err) {
    return false;
  }
};

export const parseTelegramStreamInfo = (url) => {
  try {
    if (!isTelegramStreamUrl(url)) return null;
    const parsed = new URL(url);
    const match = parsed.pathname.match(TELEGRAM_STREAM_PATH_REGEX);
    if (!match || !match[1]) return null;
    const decoded = decodeURIComponent(match[1]);
    const data = JSON.parse(decoded);
    if (!data || typeof data !== "object") return null;
    return data;
  } catch (err) {
    return null;
  }
};

export const buildTelegramFileName = (info) => {
  if (!info || typeof info !== "object") return null;
  if (info.fileName) return info.fileName;
  const ext = mapMimeToExt(info.mimeType || "");
  const id = info.location?.id || info.id;
  if (!id) return null;
  return `telegram-${id}.${ext}`;
};

export const normalizeTelegramReferrer = (value) => {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!TELEGRAM_HOST_REGEX.test(url.hostname)) return null;
    return `${url.origin}${url.pathname}`;
  } catch (err) {
    return null;
  }
};
