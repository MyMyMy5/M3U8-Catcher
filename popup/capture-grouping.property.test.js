import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { groupCaptures, getGroupKey } from "./capture-grouping.js";

// ── Generators ──────────────────────────────────────────────────────────

/** Generate a valid URL path segment. */
const arbPathSegment = () =>
  fc.stringMatching(/^[a-z][a-z0-9\-]{0,8}$/).filter((s) => s.length > 0);

/** Generate a valid source page URL. */
const arbSourcePage = () =>
  fc.tuple(
    fc.constantFrom("https://example.com", "https://video.site.org", "https://cdn.test.net"),
    arbPathSegment()
  ).map(([origin, page]) => `${origin}/${page}`);

/** Generate a capture object with a valid URL and sourcePage. */
const arbCapture = () =>
  fc.record({
    url: fc.tuple(
      fc.constantFrom(
        "https://cdn.example.com",
        "https://media.site.org",
        "https://stream.test.net"
      ),
      fc.array(arbPathSegment(), { minLength: 1, maxLength: 4 }),
      arbPathSegment()
    ).map(([origin, pathParts, lastSeg]) =>
      `${origin}/${pathParts.join("/")}/${lastSeg}.m3u8`
    ),
    sourcePage: arbSourcePage(),
    resolution: fc.option(
      fc.tuple(
        fc.constantFrom(1920, 1280, 854, 640, 426),
        fc.constantFrom(1080, 720, 480, 360, 240)
      ).map(([w, h]) => `${w}x${h}`),
      { nil: undefined }
    ),
    firstSeen: fc.integer({ min: 1700000000000, max: 1800000000000 }),
    format: fc.constantFrom("m3u8", "mpd", "mp4"),
  });

/** Generate a capture with an unparseable URL. */
const arbBadCapture = () =>
  fc.record({
    url: fc.constantFrom("not-a-url", "://broken", ""),
    sourcePage: arbSourcePage(),
    firstSeen: fc.integer({ min: 1700000000000, max: 1800000000000 }),
    format: fc.constant("m3u8"),
  });

// ── Property 7: Capture grouping correctness ────────────────────────────

describe("Property 7: Capture grouping correctness", () => {
  /**
   * **Validates: Requirements 6.1**
   *
   * For any list of captures, groupCaptures shall produce groups such that:
   * (a) every capture in a group shares the same sourcePage URL and the same
   *     URL path prefix (excluding the final path segment and query parameters)
   * (b) no two different groups contain captures that share both the same
   *     sourcePage and the same URL path prefix
   */
  it("(a) every capture in a group shares the same sourcePage and URL path prefix", () => {
    fc.assert(
      fc.property(
        fc.array(arbCapture(), { minLength: 1, maxLength: 30 }),
        (captures) => {
          const groups = groupCaptures(captures);

          for (const group of groups) {
            const allInGroup = [group.primary, ...group.related];
            if (allInGroup.length <= 1) continue;

            // All captures in the group must share the same group key
            const keys = allInGroup.map((c) => getGroupKey(c));
            const firstKey = keys[0];
            for (const key of keys) {
              expect(key).toBe(firstKey);
            }

            // Verify sourcePage is the same
            const sourcePages = new Set(allInGroup.map((c) => c.sourcePage || ""));
            expect(sourcePages.size).toBe(1);
          }
        }
      ),
      { numRuns: 20 }
    );
  });

  it("(b) no two different groups share captures with the same sourcePage and URL path prefix", () => {
    fc.assert(
      fc.property(
        fc.array(arbCapture(), { minLength: 1, maxLength: 30 }),
        (captures) => {
          const groups = groupCaptures(captures);

          // Collect all group keys across groups — each key should appear in at most one group
          const keyToGroupIndex = new Map();
          for (let gi = 0; gi < groups.length; gi++) {
            const allInGroup = [groups[gi].primary, ...groups[gi].related];
            for (const c of allInGroup) {
              const key = getGroupKey(c);
              if (key === null) continue; // unparseable URLs are isolated
              if (keyToGroupIndex.has(key)) {
                // The key must map to the same group index
                expect(keyToGroupIndex.get(key)).toBe(gi);
              } else {
                keyToGroupIndex.set(key, gi);
              }
            }
          }
        }
      ),
      { numRuns: 20 }
    );
  });

  it("all input captures appear exactly once in the output groups", () => {
    fc.assert(
      fc.property(
        fc.array(arbCapture(), { minLength: 0, maxLength: 30 }),
        (captures) => {
          const groups = groupCaptures(captures);

          // Flatten all captures from groups
          const allGrouped = groups.flatMap((g) => [g.primary, ...g.related]);
          expect(allGrouped.length).toBe(captures.length);

          // Every input capture must appear in the output
          for (const c of captures) {
            expect(allGrouped).toContain(c);
          }
        }
      ),
      { numRuns: 20 }
    );
  });

  it("captures with unparseable URLs get their own single-capture group", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.array(arbCapture(), { minLength: 0, maxLength: 10 }),
          fc.array(arbBadCapture(), { minLength: 1, maxLength: 5 })
        ),
        ([goodCaptures, badCaptures]) => {
          const allCaptures = [...goodCaptures, ...badCaptures];
          const groups = groupCaptures(allCaptures);

          // Each bad capture should be in its own group with no related
          for (const bad of badCaptures) {
            const group = groups.find(
              (g) => g.primary === bad || g.related.includes(bad)
            );
            expect(group).toBeDefined();
            expect(group.related).toHaveLength(0);
            expect(group.primary).toBe(bad);
          }
        }
      ),
      { numRuns: 20 }
    );
  });

  it("empty input produces empty output", () => {
    const groups = groupCaptures([]);
    expect(groups).toEqual([]);
  });
});
