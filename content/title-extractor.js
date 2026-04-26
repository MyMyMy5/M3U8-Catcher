/**
 * Title extraction and sanitization utilities for video page captures.
 *
 * Exported as ES module functions for testing.
 * The same logic is inlined in page-capture.js (content script, non-module).
 */

// Characters invalid in file names: < > : " / \ | ? *
// Plus control characters U+0000–U+001F
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

const MAX_TITLE_LENGTH = 200;

/**
 * Sanitize a title string by removing invalid filename characters,
 * trimming whitespace, and truncating to MAX_TITLE_LENGTH.
 *
 * @param {string} raw - The raw title string
 * @returns {string} The sanitized title
 */
export function sanitizeTitle(raw) {
  if (!raw || typeof raw !== "string") return "";
  let result = raw.replace(INVALID_FILENAME_CHARS, "");
  result = result.trim();
  if (result.length > MAX_TITLE_LENGTH) {
    result = result.slice(0, MAX_TITLE_LENGTH);
  }
  return result;
}

/**
 * Extract the video title from the current page DOM.
 *
 * Priority order:
 *   1. <meta property="og:title"> content attribute
 *   2. First <h1> element's textContent
 *   3. Elements matching [class*="video-title"], [class*="player-title"], [data-video-title]
 *
 * All DOM access is wrapped in try/catch.
 * Returns null if no non-empty title is found.
 *
 * @returns {string|null}
 */
export function extractVideoTitle() {
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
}
