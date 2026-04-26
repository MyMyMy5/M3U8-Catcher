import { describe, it, expect } from "vitest";
import fc from "fast-check";

// ── Inlined from popup/popup.js (not exported, heavy DOM deps) ──────────

const deriveSuggestedName = (url, title, fallback = "video.mp4") => {
  if (title) {
    const safe = title.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim().slice(0, 160);
    return safe ? `${safe}.mp4` : fallback;
  }
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() || fallback;
    return last.endsWith(".mp4") ? last : `${last}.mp4`;
  } catch (err) {
    return fallback;
  }
};

// ── Unsafe character regex for assertions ───────────────────────────────

const UNSAFE_CHARS = /[<>:"/\\|?*\x00-\x1F]/;

// ── Property 2: deriveSuggestedName with title produces safe filename ───

describe("Feature: streaming-to-disk-downloads, Property 2: deriveSuggestedName with title produces safe filename", () => {
  /**
   * **Validates: Requirements 9.1**
   *
   * For any non-empty title string, deriveSuggestedName(url, title) SHALL
   * return a string that:
   * - ends with `.mp4`
   * - contains no filesystem-unsafe characters
   * - has total length ≤ 164 characters (160 char title + `.mp4`)
   */

  it("produces safe filename from random unicode strings", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 300 }),
        (title) => {
          const result = deriveSuggestedName("https://example.com/video", title);
          expect(result).toMatch(/\.mp4$/);
          expect(UNSAFE_CHARS.test(result)).toBe(false);
          expect(result.length).toBeLessThanOrEqual(164);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("produces safe filename from strings with special filesystem chars", () => {
    const specialCharArb = fc
      .array(
        fc.constantFrom(
          "<", ">", ":", '"', "/", "\\", "|", "?", "*",
          "\x00", "\x01", "\x1F", "a", "B", " ", ".", "-"
        ),
        { minLength: 1, maxLength: 300 }
      )
      .map((chars) => chars.join(""));

    fc.assert(
      fc.property(specialCharArb, (title) => {
        const result = deriveSuggestedName("https://example.com/video", title);
        expect(result).toMatch(/\.mp4$/);
        expect(UNSAFE_CHARS.test(result)).toBe(false);
        expect(result.length).toBeLessThanOrEqual(164);
      }),
      { numRuns: 100 }
    );
  });
});

// ── Property 3: deriveSuggestedName from URL extracts last path segment ─

describe("Feature: streaming-to-disk-downloads, Property 3: deriveSuggestedName from URL extracts last path segment", () => {
  /**
   * **Validates: Requirements 9.2**
   *
   * For any valid URL with at least one path segment,
   * deriveSuggestedName(url, null) SHALL return a string ending with `.mp4`.
   */

  const arbPathSegment = () =>
    fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,20}$/).filter((s) => s.length > 0);

  it("result ends with .mp4 for random valid URLs", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.constantFrom("https://example.com", "https://cdn.video.org", "https://media.test.net"),
          fc.array(arbPathSegment(), { minLength: 1, maxLength: 4 })
        ).map(([origin, segments]) => `${origin}/${segments.join("/")}`),
        (url) => {
          const result = deriveSuggestedName(url, null);
          expect(result).toMatch(/\.mp4$/);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ── Edge case tests: unparseable URL with no title ──────────────────────

describe("deriveSuggestedName edge cases: unparseable URL with no title returns fallback", () => {
  /**
   * **Validates: Requirements 9.3**
   */

  it('returns "video.mp4" for "not-a-url"', () => {
    expect(deriveSuggestedName("not-a-url", null)).toBe("video.mp4");
  });

  it('returns "video.mp4" for "://broken"', () => {
    expect(deriveSuggestedName("://broken", null)).toBe("video.mp4");
  });

  it('returns "video.mp4" for empty string', () => {
    expect(deriveSuggestedName("", null)).toBe("video.mp4");
  });
});
