/**
 * Variant parser module for HLS master playlists and DASH MPD manifests.
 * Extracts quality variants so the popup can present a quality selector.
 */

// ── Shared helpers (same logic as background-downloads.js) ──────────────

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
  } catch {
    return input;
  }
};

// ── Label formatting ────────────────────────────────────────────────────

const extractHeight = (resolution) => {
  if (!resolution) return 0;
  const parts = resolution.split("x");
  const h = parseInt(parts[1] || parts[0], 10);
  return Number.isFinite(h) ? h : 0;
};

const formatBitrate = (bps) => {
  const mbps = bps / 1_000_000;
  return mbps >= 1 ? `${mbps.toFixed(1)} Mbps` : `${(bps / 1000).toFixed(0)} kbps`;
};

const buildLabel = (resolution, bandwidth) => {
  const height = extractHeight(resolution);
  const heightStr = height > 0 ? `${height}p` : "?p";
  return `${heightStr} · ${formatBitrate(bandwidth)}`;
};

// ── Sort helper ─────────────────────────────────────────────────────────

const sortVariantsDesc = (variants) => {
  return variants.sort((a, b) => {
    const hA = extractHeight(a.resolution);
    const hB = extractHeight(b.resolution);
    if (hB !== hA) return hB - hA;
    return b.bandwidth - a.bandwidth;
  });
};

// ── HLS variant parsing ─────────────────────────────────────────────────

/**
 * Parse an HLS master playlist and return all quality variants.
 * Returns an empty array for media playlists (no #EXT-X-STREAM-INF).
 *
 * @param {string} playlistText - Raw text of the .m3u8 file
 * @param {string} baseUrl      - Base URL for resolving relative URIs
 * @returns {Array<{uri: string, resolution: string, bandwidth: number, label: string}>}
 */
export const parseHlsVariants = (playlistText, baseUrl) => {
  if (!playlistText || typeof playlistText !== "string") return [];

  const lines = playlistText.split(/\r?\n/);
  const variants = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;

    const attrText = line.slice("#EXT-X-STREAM-INF:".length);
    const attrs = parseAttributeList(attrText);

    // The URI is on the next non-empty, non-comment line
    let uriLine = "";
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j].trim();
      if (!candidate) continue;
      if (candidate.startsWith("#")) continue;
      uriLine = candidate;
      break;
    }
    if (!uriLine) continue;

    const uri = absoluteUrl(uriLine, baseUrl);
    const bandwidth =
      parseInt(attrs["average-bandwidth"] || attrs.bandwidth || "0", 10) || 0;
    const resolution = attrs.resolution || "";
    const label = buildLabel(resolution, bandwidth);

    variants.push({ uri, resolution, bandwidth, label });
  }

  return sortVariantsDesc(variants);
};

// ── DASH variant parsing ────────────────────────────────────────────────

/**
 * Parse a DASH MPD manifest and return all video quality variants.
 * Returns an empty array for single-representation MPDs.
 *
 * @param {string} mpdText - Raw XML text of the MPD manifest
 * @param {string} baseUrl - Base URL for resolving relative URIs
 * @returns {Array<{uri: string, resolution: string, bandwidth: number, label: string}>}
 */
export const parseDashVariants = (mpdText, baseUrl) => {
  if (!mpdText || typeof mpdText !== "string") return [];

  let doc;
  try {
    const parser = new DOMParser();
    doc = parser.parseFromString(mpdText, "application/xml");
    // Check for parse errors
    if (doc.querySelector("parsererror")) return [];
  } catch {
    return [];
  }

  const variants = [];
  const adaptationSets = doc.querySelectorAll("AdaptationSet");

  for (const as of adaptationSets) {
    const mimeType = as.getAttribute("mimeType") || "";
    const contentType = as.getAttribute("contentType") || "";
    const isVideo =
      mimeType.startsWith("video/") || contentType.toLowerCase() === "video";
    if (!isVideo) continue;

    const representations = as.querySelectorAll("Representation");
    for (const rep of representations) {
      const width = parseInt(rep.getAttribute("width") || as.getAttribute("width") || "0", 10) || 0;
      const height = parseInt(rep.getAttribute("height") || as.getAttribute("height") || "0", 10) || 0;
      const bandwidth = parseInt(rep.getAttribute("bandwidth") || "0", 10) || 0;
      const id = rep.getAttribute("id") || "";

      const resolution = width && height ? `${width}x${height}` : "";
      const label = buildLabel(resolution, bandwidth);

      variants.push({
        uri: id,
        resolution,
        bandwidth,
        label,
      });
    }
  }

  // Return empty for single-representation MPDs
  if (variants.length <= 1) return [];

  return sortVariantsDesc(variants);
};

// ── Selection helpers ───────────────────────────────────────────────────

/**
 * Return the variant with the maximum bandwidth value.
 *
 * @param {Array<{bandwidth: number}>} variants
 * @returns {object|null}
 */
export const selectHighestQuality = (variants) => {
  if (!Array.isArray(variants) || variants.length === 0) return null;

  let best = variants[0];
  for (let i = 1; i < variants.length; i++) {
    if (variants[i].bandwidth > best.bandwidth) {
      best = variants[i];
    }
  }
  return best;
};

/**
 * Find the variant whose vertical resolution is closest to targetHeight.
 * If two variants are equidistant, prefer the one with higher bandwidth.
 *
 * @param {Array<{resolution: string, bandwidth: number}>} variants
 * @param {number} targetHeight - Target vertical resolution (e.g. 1080)
 * @returns {object|null}
 */
export const selectClosestVariant = (variants, targetHeight) => {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  if (!Number.isFinite(targetHeight)) return variants[0];

  let best = null;
  let bestDiff = Infinity;

  for (const v of variants) {
    const h = extractHeight(v.resolution);
    const diff = Math.abs(h - targetHeight);

    if (
      diff < bestDiff ||
      (diff === bestDiff && best && v.bandwidth > best.bandwidth)
    ) {
      best = v;
      bestDiff = diff;
    }
  }

  return best;
};
