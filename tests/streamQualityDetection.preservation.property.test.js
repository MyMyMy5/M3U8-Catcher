import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseHlsVariants, parseDashVariants } from "../background/background-variants.js";
import { groupCaptures, getGroupKey } from "../popup/capture-grouping.js";

// ── Helpers ─────────────────────────────────────────────────────────────

const extractHeight = (resolution) => {
  if (!resolution) return 0;
  const parts = resolution.split("x");
  const h = parseInt(parts[1] || parts[0], 10);
  return Number.isFinite(h) ? h : 0;
};

// ── Arbitraries ─────────────────────────────────────────────────────────

/**
 * Generate a valid HLS master playlist string with N #EXT-X-STREAM-INF entries.
 * Each entry has a resolution (WIDTHxHEIGHT), bandwidth, and a relative URI.
 */
const hlsStreamInfoArb = () =>
  fc.record({
    width: fc.integer({ min: 320, max: 3840 }),
    height: fc.integer({ min: 180, max: 2160 }),
    bandwidth: fc.integer({ min: 100000, max: 20000000 }),
    uriSegment: fc.stringMatching(/^[a-z][a-z0-9_]{2,12}$/).map((s) => `${s}.m3u8`),
  });

const hlsMasterPlaylistArb = fc
  .array(hlsStreamInfoArb(), { minLength: 2, maxLength: 8 })
  .map((entries) => {
    const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
    for (const e of entries) {
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${e.bandwidth},RESOLUTION=${e.width}x${e.height}`
      );
      lines.push(e.uriSegment);
    }
    return lines.join("\n");
  });

const baseUrlArb = fc.constantFrom(
  "https://cdn.example.com/hls/master.m3u8",
  "https://video.cdn.net/live/playlist.m3u8",
  "https://stream.provider.io/vod/index.m3u8"
);

/**
 * Generate a valid DASH MPD XML with N <Representation> elements inside a
 * video <AdaptationSet>.
 */
const dashRepArb = () =>
  fc.record({
    id: fc.stringMatching(/^[a-z0-9]{1,6}$/),
    width: fc.integer({ min: 320, max: 3840 }),
    height: fc.integer({ min: 180, max: 2160 }),
    bandwidth: fc.integer({ min: 100000, max: 20000000 }),
  });

const dashMpdArb = fc
  .array(dashRepArb(), { minLength: 2, maxLength: 8 })
  .map((reps) => {
    const repXml = reps
      .map(
        (r) =>
          `<Representation id="${r.id}" width="${r.width}" height="${r.height}" bandwidth="${r.bandwidth}" />`
      )
      .join("\n      ");
    return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      ${repXml}
    </AdaptationSet>
  </Period>
</MPD>`;
  });


/**
 * Generate random capture objects with varying sourcePage, url, resolution, lastSeen.
 */
const captureArb = () =>
  fc.record({
    sourcePage: fc.constantFrom(
      "https://example.com/watch?v=1",
      "https://site.com/video/2",
      "https://other.org/page"
    ),
    url: fc.tuple(
      fc.constantFrom(
        "https://cdn.example.com/hls",
        "https://video.cdn.net/live",
        "https://stream.io/vod"
      ),
      fc.constantFrom("720p", "1080p", "480p", "360p", "segment"),
      fc.stringMatching(/^[a-z][a-z0-9]{2,8}$/).map((s) => `${s}.m3u8`)
    ).map(([base, dir, file]) => `${base}/${dir}/${file}`),
    resolution: fc.oneof(
      fc.constant(""),
      fc.tuple(
        fc.integer({ min: 320, max: 3840 }),
        fc.integer({ min: 180, max: 2160 })
      ).map(([w, h]) => `${w}x${h}`)
    ),
    lastSeen: fc.integer({ min: 1700000000000, max: 1800000000000 }),
  });

const captureArrayArb = fc.array(captureArb(), { minLength: 1, maxLength: 15 });

// ── Test 1 — Master playlist parsing preservation ───────────────────────

describe("Preservation: Master playlist parsing (parseHlsVariants)", () => {
  /**
   * **Validates: Requirements 3.1**
   *
   * For any valid HLS master playlist containing #EXT-X-STREAM-INF entries,
   * parseHlsVariants SHALL return a non-empty array of variants, sorted
   * descending by resolution height then bandwidth, where each variant has
   * uri, resolution, bandwidth, and label fields.
   */

  it("returns non-empty array with correct fields, sorted descending", () => {
    fc.assert(
      fc.property(hlsMasterPlaylistArb, baseUrlArb, (playlist, baseUrl) => {
        const variants = parseHlsVariants(playlist, baseUrl);

        // Non-empty
        expect(variants.length).toBeGreaterThan(0);

        // Each variant has required fields
        for (const v of variants) {
          expect(v).toHaveProperty("uri");
          expect(v).toHaveProperty("resolution");
          expect(v).toHaveProperty("bandwidth");
          expect(v).toHaveProperty("label");
          expect(typeof v.uri).toBe("string");
          expect(typeof v.resolution).toBe("string");
          expect(typeof v.bandwidth).toBe("number");
          expect(typeof v.label).toBe("string");
        }

        // Sorted descending by resolution height, then bandwidth
        for (let i = 1; i < variants.length; i++) {
          const prevH = extractHeight(variants[i - 1].resolution);
          const currH = extractHeight(variants[i].resolution);
          if (prevH !== currH) {
            expect(prevH).toBeGreaterThanOrEqual(currH);
          } else {
            expect(variants[i - 1].bandwidth).toBeGreaterThanOrEqual(
              variants[i].bandwidth
            );
          }
        }
      }),
      { numRuns: 100 }
    );
  });

  it("variant count matches number of #EXT-X-STREAM-INF entries", () => {
    fc.assert(
      fc.property(hlsMasterPlaylistArb, baseUrlArb, (playlist, baseUrl) => {
        const variants = parseHlsVariants(playlist, baseUrl);
        const streamInfCount = (playlist.match(/#EXT-X-STREAM-INF/g) || []).length;
        expect(variants.length).toBe(streamInfCount);
      }),
      { numRuns: 100 }
    );
  });
});

// ── Test 2 — DASH MPD parsing preservation ──────────────────────────────

describe("Preservation: DASH MPD parsing (parseDashVariants)", () => {
  /**
   * **Validates: Requirements 3.6**
   *
   * For any valid MPD XML with ≥2 <Representation> elements in a video
   * <AdaptationSet>, parseDashVariants SHALL return a non-empty array,
   * sorted descending by resolution height then bandwidth, where each
   * variant has uri, resolution, bandwidth, and label fields.
   */

  it("returns non-empty array with correct fields, sorted descending", () => {
    fc.assert(
      fc.property(dashMpdArb, baseUrlArb, (mpd, baseUrl) => {
        const variants = parseDashVariants(mpd, baseUrl);

        // Non-empty for ≥2 representations
        expect(variants.length).toBeGreaterThan(0);

        // Each variant has required fields
        for (const v of variants) {
          expect(v).toHaveProperty("uri");
          expect(v).toHaveProperty("resolution");
          expect(v).toHaveProperty("bandwidth");
          expect(v).toHaveProperty("label");
          expect(typeof v.uri).toBe("string");
          expect(typeof v.resolution).toBe("string");
          expect(typeof v.bandwidth).toBe("number");
          expect(typeof v.label).toBe("string");
        }

        // Sorted descending by resolution height, then bandwidth
        for (let i = 1; i < variants.length; i++) {
          const prevH = extractHeight(variants[i - 1].resolution);
          const currH = extractHeight(variants[i].resolution);
          if (prevH !== currH) {
            expect(prevH).toBeGreaterThanOrEqual(currH);
          } else {
            expect(variants[i - 1].bandwidth).toBeGreaterThanOrEqual(
              variants[i].bandwidth
            );
          }
        }
      }),
      { numRuns: 100 }
    );
  });
});


// ── Test 3 — Capture grouping preservation ──────────────────────────────

describe("Preservation: Capture grouping (groupCaptures)", () => {
  /**
   * **Validates: Requirements 3.5**
   *
   * For any array of capture objects, groupCaptures SHALL:
   * - Include every input capture exactly once across all groups
   * - Select the primary as the capture with highest resolution in its group
   * - Merge captures with the same sourcePage|pathPrefix key into one group
   */

  it("every input capture appears exactly once across all groups", () => {
    fc.assert(
      fc.property(captureArrayArb, (captures) => {
        const groups = groupCaptures(captures);

        // Collect all captures from groups
        const allFromGroups = [];
        for (const g of groups) {
          allFromGroups.push(g.primary);
          allFromGroups.push(...g.related);
        }

        // Every input capture appears exactly once
        expect(allFromGroups.length).toBe(captures.length);

        // Each input capture is present
        for (const c of captures) {
          const found = allFromGroups.filter(
            (gc) => gc.url === c.url && gc.sourcePage === c.sourcePage && gc.lastSeen === c.lastSeen
          );
          expect(found.length).toBeGreaterThanOrEqual(1);
        }
      }),
      { numRuns: 100 }
    );
  });

  it("primary has highest resolution in its group", () => {
    fc.assert(
      fc.property(captureArrayArb, (captures) => {
        const groups = groupCaptures(captures);

        for (const g of groups) {
          const allMembers = [g.primary, ...g.related];
          const primaryHeight = extractHeight(g.primary.resolution);

          for (const member of allMembers) {
            const memberHeight = extractHeight(member.resolution);
            expect(primaryHeight).toBeGreaterThanOrEqual(memberHeight);
          }
        }
      }),
      { numRuns: 100 }
    );
  });

  it("captures with same sourcePage|pathPrefix key are merged into one group", () => {
    fc.assert(
      fc.property(captureArrayArb, (captures) => {
        const groups = groupCaptures(captures);

        // For each group, all members should share the same group key
        for (const g of groups) {
          const allMembers = [g.primary, ...g.related];
          const keys = allMembers.map(getGroupKey).filter((k) => k !== null);
          if (keys.length > 1) {
            const uniqueKeys = new Set(keys);
            expect(uniqueKeys.size).toBe(1);
          }
        }

        // No two groups should share the same key
        const groupKeys = groups
          .map((g) => getGroupKey(g.primary))
          .filter((k) => k !== null);
        const uniqueGroupKeys = new Set(groupKeys);
        expect(uniqueGroupKeys.size).toBe(groupKeys.length);
      }),
      { numRuns: 100 }
    );
  });
});

// ── Test 4 — Direct video files bypass ──────────────────────────────────

describe("Preservation: Direct video files bypass playlist detection", () => {
  /**
   * **Validates: Requirements 3.3**
   *
   * URLs ending in .mp4 or .webm are not affected by any playlist detection
   * logic. parseHlsVariants and parseDashVariants return [] for non-playlist
   * content.
   */

  const videoExtArb = fc.constantFrom(".mp4", ".webm");

  const videoUrlArb = fc
    .tuple(
      fc.constantFrom(
        "https://cdn.example.com/videos",
        "https://media.site.com/content",
        "https://stream.io/files"
      ),
      fc.stringMatching(/^[a-z][a-z0-9_]{2,12}$/),
      videoExtArb
    )
    .map(([base, name, ext]) => `${base}/${name}${ext}`);

  // Non-playlist content that a direct video file URL might "return"
  const nonPlaylistContentArb = fc.oneof(
    fc.constant(""),
    fc.constant("not a playlist"),
    fc.stringMatching(/^[a-zA-Z0-9 .,;:!?]{0,200}$/),
    // Binary-like gibberish
    fc.uint8Array({ minLength: 10, maxLength: 100 }).map((arr) =>
      Array.from(arr)
        .map((b) => String.fromCharCode(b))
        .join("")
    )
  );

  it("parseHlsVariants returns [] for non-playlist content", () => {
    fc.assert(
      fc.property(nonPlaylistContentArb, videoUrlArb, (content, url) => {
        const result = parseHlsVariants(content, url);
        expect(result).toEqual([]);
      }),
      { numRuns: 100 }
    );
  });

  it("parseDashVariants returns [] for non-playlist content", () => {
    fc.assert(
      fc.property(nonPlaylistContentArb, videoUrlArb, (content, url) => {
        const result = parseDashVariants(content, url);
        expect(result).toEqual([]);
      }),
      { numRuns: 100 }
    );
  });
});
