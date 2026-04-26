/**
 * Capture Grouping Logic
 *
 * Groups captures by matching sourcePage URL AND shared URL path prefix
 * (excluding the final path segment and query parameters).
 *
 * @module capture-grouping
 */

/**
 * Compute the grouping key for a capture.
 * Key = sourcePage + "|" + URL path prefix (all path segments except the last).
 * Returns null if the URL cannot be parsed.
 *
 * @param {object} capture
 * @returns {string|null}
 */
export const getGroupKey = (capture) => {
  try {
    const sourcePage = capture.sourcePage || "";
    const u = new URL(capture.url);
    const segments = u.pathname.split("/").filter(Boolean);
    // Remove the final path segment to get the prefix
    if (segments.length > 0) segments.pop();
    const prefix = u.origin + "/" + segments.join("/");
    return sourcePage + "|" + prefix;
  } catch (_) {
    return null;
  }
};

/**
 * Extract vertical resolution from a capture's resolution-like fields or URL hints.
 * Returns a number (e.g. 1080) or 0 if unknown.
 *
 * @param {object} capture
 * @returns {number}
 */
const getResolutionHeight = (capture) => {
  // Check resolution field if present (e.g. "1920x1080")
  if (capture.resolution) {
    const match = capture.resolution.match(/(\d+)x(\d+)/);
    if (match) return parseInt(match[2], 10);
  }
  return 0;
};

/**
 * Group captures into CaptureGroup objects.
 *
 * Groups by: same sourcePage URL AND shared URL path prefix
 * (everything except the final path segment and query params).
 *
 * Primary is the capture with highest resolution, or most recent timestamp if tied.
 * Captures with unparseable URLs get their own single-capture group.
 *
 * @param {object[]} captures
 * @returns {{ primary: object, related: object[] }[]}
 */
export const groupCaptures = (captures) => {
  if (!captures || captures.length === 0) return [];

  const groups = new Map(); // key -> capture[]
  const ungroupable = []; // captures with unparseable URLs

  for (const capture of captures) {
    const key = getGroupKey(capture);
    if (key === null) {
      ungroupable.push(capture);
    } else {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(capture);
    }
  }

  const result = [];

  for (const members of groups.values()) {
    // Pick primary: highest resolution, then most recent timestamp
    const sorted = members.slice().sort((a, b) => {
      const resA = getResolutionHeight(a);
      const resB = getResolutionHeight(b);
      if (resB !== resA) return resB - resA;
      const timeA = a.lastSeen || a.firstSeen || 0;
      const timeB = b.lastSeen || b.firstSeen || 0;
      return timeB - timeA;
    });
    const primary = sorted[0];
    const related = sorted.slice(1);
    result.push({ primary, related });
  }

  // Each ungroupable capture gets its own single-capture group
  for (const capture of ungroupable) {
    result.push({ primary: capture, related: [] });
  }

  return result;
};
