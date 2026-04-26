import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  parseHlsVariants,
  parseDashVariants,
  selectHighestQuality,
  selectClosestVariant,
} from "./background-variants.js";

// ── Generators ──────────────────────────────────────────────────────────

/** Generate a random resolution pair (width x height). */
const arbResolution = () =>
  fc.record({
    width: fc.integer({ min: 320, max: 7680 }),
    height: fc.integer({ min: 240, max: 4320 }),
  });

/** Generate a random bandwidth value in bps. */
const arbBandwidth = () => fc.integer({ min: 100_000, max: 50_000_000 });

/**
 * Generate a random HLS #EXT-X-STREAM-INF entry.
 * Returns { width, height, bandwidth, uriSegment }.
 */
const arbHlsStreamInf = () =>
  fc.record({
    width: fc.integer({ min: 320, max: 7680 }),
    height: fc.integer({ min: 240, max: 4320 }),
    bandwidth: fc.integer({ min: 100_000, max: 50_000_000 }),
    uriSegment: fc.stringMatching(/^[a-z][a-z0-9]{1,10}$/),
  });

/**
 * Build a valid HLS master playlist string from an array of stream entries.
 */
const buildHlsMaster = (entries) => {
  const lines = ["#EXTM3U"];
  for (const e of entries) {
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${e.bandwidth},RESOLUTION=${e.width}x${e.height}`
    );
    lines.push(`${e.uriSegment}/index.m3u8`);
  }
  return lines.join("\n");
};

/**
 * Build a valid HLS media playlist (no #EXT-X-STREAM-INF).
 */
const buildHlsMedia = (segmentCount) => {
  const lines = ["#EXTM3U", "#EXT-X-TARGETDURATION:10"];
  for (let i = 0; i < segmentCount; i++) {
    lines.push(`#EXTINF:9.009,`);
    lines.push(`segment${i}.ts`);
  }
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n");
};

/**
 * Build a valid DASH MPD XML from an array of representation entries.
 */
const buildMpd = (reps) => {
  const repXml = reps
    .map(
      (r, i) =>
        `<Representation id="v${i}" width="${r.width}" height="${r.height}" bandwidth="${r.bandwidth}"/>`
    )
    .join("\n      ");
  return `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      ${repXml}
    </AdaptationSet>
  </Period>
</MPD>`;
};

const BASE_URL = "https://cdn.example.com/stream/master.m3u8";

/** Helper: extract height from "WxH" resolution string. */
const heightOf = (resolution) => {
  if (!resolution) return 0;
  const parts = resolution.split("x");
  return parseInt(parts[1] || parts[0], 10) || 0;
};

// ── Property 1: HLS master playlist parsing extracts all variants ───────

describe("Property 1: HLS master playlist parsing extracts all variants", () => {
  /**
   * **Validates: Requirements 1.1, 1.3**
   *
   * For any valid HLS master playlist with N #EXT-X-STREAM-INF entries,
   * parseHlsVariants returns exactly N variants with matching bandwidth
   * and resolution.
   */
  it("returns exactly N variants matching source bandwidth and resolution", () => {
    fc.assert(
      fc.property(
        fc.array(arbHlsStreamInf(), { minLength: 1, maxLength: 20 }),
        (entries) => {
          const playlist = buildHlsMaster(entries);
          const variants = parseHlsVariants(playlist, BASE_URL);

          // Count must match
          expect(variants).toHaveLength(entries.length);

          // Every entry's bandwidth and resolution must appear in the result
          const resultSet = new Set(
            variants.map((v) => `${v.bandwidth}|${v.resolution}`)
          );
          for (const e of entries) {
            const key = `${e.bandwidth}|${e.width}x${e.height}`;
            expect(resultSet.has(key)).toBe(true);
          }
        }
      ),
      { numRuns: 20 }
    );
  });
});

// ── Property 2: Media playlists produce empty variant list ──────────────

describe("Property 2: Media playlists produce empty variant list", () => {
  /**
   * **Validates: Requirements 1.2**
   *
   * For any valid HLS media playlist (with #EXTINF but no #EXT-X-STREAM-INF),
   * parseHlsVariants returns an empty array.
   */
  it("returns empty array for media playlists", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        (segmentCount) => {
          const playlist = buildHlsMedia(segmentCount);
          const variants = parseHlsVariants(playlist, BASE_URL);
          expect(variants).toEqual([]);
        }
      ),
      { numRuns: 20 }
    );
  });
});

// ── Property 3: DASH MPD parsing extracts all video representations ─────

describe("Property 3: DASH MPD parsing extracts all video representations", () => {
  /**
   * **Validates: Requirements 2.1, 2.3**
   *
   * For any valid DASH MPD with M >= 2 video Representations,
   * parseDashVariants returns exactly M variants with matching bandwidth
   * and resolution.
   */
  it("returns exactly M variants matching source bandwidth and resolution", () => {
    fc.assert(
      fc.property(
        fc.array(arbResolution().chain((res) =>
          arbBandwidth().map((bw) => ({ ...res, bandwidth: bw }))
        ), { minLength: 2, maxLength: 20 }),
        (reps) => {
          const mpd = buildMpd(reps);
          const variants = parseDashVariants(mpd, BASE_URL);

          expect(variants).toHaveLength(reps.length);

          const resultSet = new Set(
            variants.map((v) => `${v.bandwidth}|${v.resolution}`)
          );
          for (const r of reps) {
            const key = `${r.bandwidth}|${r.width}x${r.height}`;
            expect(resultSet.has(key)).toBe(true);
          }
        }
      ),
      { numRuns: 20 }
    );
  });
});

// ── Property 4: Variant list is sorted by resolution descending ─────────

describe("Property 4: Variant list is sorted by resolution descending", () => {
  /**
   * **Validates: Requirements 3.2**
   *
   * For any variant list produced by parseHlsVariants or parseDashVariants,
   * variants are ordered with each vertical resolution >= the next.
   */
  it("HLS variants are sorted by height descending", () => {
    fc.assert(
      fc.property(
        fc.array(arbHlsStreamInf(), { minLength: 2, maxLength: 20 }),
        (entries) => {
          const playlist = buildHlsMaster(entries);
          const variants = parseHlsVariants(playlist, BASE_URL);

          for (let i = 0; i < variants.length - 1; i++) {
            const hCurr = heightOf(variants[i].resolution);
            const hNext = heightOf(variants[i + 1].resolution);
            expect(hCurr).toBeGreaterThanOrEqual(hNext);
          }
        }
      ),
      { numRuns: 20 }
    );
  });

  it("DASH variants are sorted by height descending", () => {
    fc.assert(
      fc.property(
        fc.array(arbResolution().chain((res) =>
          arbBandwidth().map((bw) => ({ ...res, bandwidth: bw }))
        ), { minLength: 2, maxLength: 20 }),
        (reps) => {
          const mpd = buildMpd(reps);
          const variants = parseDashVariants(mpd, BASE_URL);

          for (let i = 0; i < variants.length - 1; i++) {
            const hCurr = heightOf(variants[i].resolution);
            const hNext = heightOf(variants[i + 1].resolution);
            expect(hCurr).toBeGreaterThanOrEqual(hNext);
          }
        }
      ),
      { numRuns: 20 }
    );
  });
});

// ── Property 5: Highest quality selects maximum bandwidth ───────────────

describe("Property 5: Highest quality selects maximum bandwidth", () => {
  /**
   * **Validates: Requirements 3.4**
   *
   * For any non-empty variant list, selectHighestQuality returns the
   * variant whose bandwidth is >= all others.
   */
  it("returns the variant with maximum bandwidth", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            uri: fc.stringMatching(/^[a-z]{1,5}$/),
            bandwidth: fc.integer({ min: 100_000, max: 50_000_000 }),
            resolution: fc.constantFrom("1920x1080", "1280x720", "854x480", "640x360"),
          }),
          { minLength: 1, maxLength: 30 }
        ),
        (variants) => {
          const result = selectHighestQuality(variants);
          const maxBw = Math.max(...variants.map((v) => v.bandwidth));
          expect(result).not.toBeNull();
          expect(result.bandwidth).toBe(maxBw);
        }
      ),
      { numRuns: 20 }
    );
  });
});

// ── Property 6: Closest variant selection picks nearest resolution ──────

describe("Property 6: Closest variant selection picks nearest resolution", () => {
  /**
   * **Validates: Requirements 5.2**
   *
   * For any non-empty variant list and target height, selectClosestVariant
   * returns the variant whose height is closest to the target. If equidistant,
   * the one with higher bandwidth is preferred.
   */
  it("picks the variant nearest to the target height", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            uri: fc.stringMatching(/^[a-z]{1,5}$/),
            bandwidth: fc.integer({ min: 100_000, max: 50_000_000 }),
            resolution: fc.integer({ min: 240, max: 4320 }).map((h) => `${Math.round(h * 16 / 9)}x${h}`),
          }),
          { minLength: 1, maxLength: 30 }
        ),
        fc.integer({ min: 240, max: 4320 }),
        (variants, targetHeight) => {
          const result = selectClosestVariant(variants, targetHeight);
          expect(result).not.toBeNull();

          const resultHeight = heightOf(result.resolution);
          const resultDiff = Math.abs(resultHeight - targetHeight);

          // No other variant should be strictly closer
          for (const v of variants) {
            const vHeight = heightOf(v.resolution);
            const vDiff = Math.abs(vHeight - targetHeight);
            if (vDiff < resultDiff) {
              // This should never happen
              expect(vDiff).toBeGreaterThanOrEqual(resultDiff);
            }
            // If equidistant, result should have >= bandwidth
            if (vDiff === resultDiff) {
              expect(result.bandwidth).toBeGreaterThanOrEqual(v.bandwidth);
            }
          }
        }
      ),
      { numRuns: 20 }
    );
  });
});
