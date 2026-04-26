import { describe, it, expect, beforeEach } from "vitest";
import fc from "fast-check";
import { extractVideoTitle, sanitizeTitle } from "./title-extractor.js";

// ── Helpers ─────────────────────────────────────────────────────────────

const INVALID_CHARS = /[<>:"/\\|?*\x00-\x1f]/;
const MAX_TITLE_LENGTH = 200;

/** Clear the DOM body and head of any test elements. */
const resetDOM = () => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
};

/** Generate a non-empty string suitable for a title (printable, no invalid chars). */
const arbValidTitle = () =>
  fc.stringMatching(/^[A-Za-z0-9 _\-.,!@#$%^&()+=\[\]{}~`';]{1,60}$/)
    .filter((s) => s.trim().length > 0);

/** Generate a string that may contain invalid filename characters and control chars. */
const arbRawTitle = () =>
  fc.string({ minLength: 1, maxLength: 300 });

// ── Property 8: Title extraction follows priority order ─────────────────

describe("Property 8: Title extraction follows priority order", () => {
  /**
   * **Validates: Requirements 7.1**
   *
   * For any DOM state containing a combination of og:title, h1, and
   * video-title selectors, extractVideoTitle returns the value from the
   * highest-priority non-empty source, or null if all are empty.
   */

  beforeEach(() => {
    resetDOM();
  });

  it("og:title takes priority over h1 and video-title selectors", () => {
    fc.assert(
      fc.property(
        arbValidTitle(),
        arbValidTitle(),
        arbValidTitle(),
        (ogTitle, h1Title, videoTitle) => {
          resetDOM();
          // Set up all three sources
          const meta = document.createElement("meta");
          meta.setAttribute("property", "og:title");
          meta.setAttribute("content", ogTitle);
          document.head.appendChild(meta);

          const h1 = document.createElement("h1");
          h1.textContent = h1Title;
          document.body.appendChild(h1);

          const div = document.createElement("div");
          div.className = "video-title";
          div.textContent = videoTitle;
          document.body.appendChild(div);

          const result = extractVideoTitle();
          expect(result).toBe(sanitizeTitle(ogTitle));
        }
      ),
      { numRuns: 20 }
    );
  });

  it("h1 takes priority over video-title selectors when og:title is absent", () => {
    fc.assert(
      fc.property(
        arbValidTitle(),
        arbValidTitle(),
        (h1Title, videoTitle) => {
          resetDOM();
          const h1 = document.createElement("h1");
          h1.textContent = h1Title;
          document.body.appendChild(h1);

          const div = document.createElement("div");
          div.className = "player-title";
          div.textContent = videoTitle;
          document.body.appendChild(div);

          const result = extractVideoTitle();
          expect(result).toBe(sanitizeTitle(h1Title));
        }
      ),
      { numRuns: 20 }
    );
  });

  it("video-title selector is used when og:title and h1 are absent", () => {
    fc.assert(
      fc.property(arbValidTitle(), (videoTitle) => {
        resetDOM();
        const div = document.createElement("div");
        div.setAttribute("data-video-title", "true");
        div.textContent = videoTitle;
        document.body.appendChild(div);

        const result = extractVideoTitle();
        expect(result).toBe(sanitizeTitle(videoTitle));
      }),
      { numRuns: 20 }
    );
  });

  it("returns null when no DOM sources are present", () => {
    resetDOM();
    const result = extractVideoTitle();
    expect(result).toBeNull();
  });

  it("skips empty og:title and falls back to h1", () => {
    fc.assert(
      fc.property(arbValidTitle(), (h1Title) => {
        resetDOM();
        const meta = document.createElement("meta");
        meta.setAttribute("property", "og:title");
        meta.setAttribute("content", "");
        document.head.appendChild(meta);

        const h1 = document.createElement("h1");
        h1.textContent = h1Title;
        document.body.appendChild(h1);

        const result = extractVideoTitle();
        expect(result).toBe(sanitizeTitle(h1Title));
      }),
      { numRuns: 20 }
    );
  });
});

// ── Property 9: Title sanitization preserves valid characters and enforces length ──

describe("Property 9: Title sanitization preserves valid characters and enforces length", () => {
  /**
   * **Validates: Requirements 7.4, 7.5**
   *
   * For any input string, sanitizeTitle shall:
   * (a) produce output containing no invalid filename characters or control chars
   * (b) produce output with length at most 200 characters
   * (c) produce output with no leading or trailing whitespace
   */

  it("(a) output contains no invalid filename characters or control characters", () => {
    fc.assert(
      fc.property(arbRawTitle(), (raw) => {
        const result = sanitizeTitle(raw);
        expect(INVALID_CHARS.test(result)).toBe(false);
      }),
      { numRuns: 20 }
    );
  });

  it("(b) output length is at most 200 characters", () => {
    fc.assert(
      fc.property(arbRawTitle(), (raw) => {
        const result = sanitizeTitle(raw);
        expect(result.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
      }),
      { numRuns: 20 }
    );
  });

  it("(c) output has no leading or trailing whitespace", () => {
    fc.assert(
      fc.property(arbRawTitle(), (raw) => {
        const result = sanitizeTitle(raw);
        expect(result).toBe(result.trim());
      }),
      { numRuns: 20 }
    );
  });

  it("preserves valid characters that are not in the invalid set", () => {
    fc.assert(
      fc.property(arbValidTitle(), (validTitle) => {
        const result = sanitizeTitle(validTitle);
        // All characters in the input that are valid should be preserved
        const expected = validTitle.trim().slice(0, MAX_TITLE_LENGTH);
        expect(result).toBe(expected);
      }),
      { numRuns: 20 }
    );
  });
});
