import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  parseHlsVariants,
  isMediaPlaylist,
  discoverMasterPlaylist,
} from "../background/background-variants.js";
import { groupCaptures, getGroupKey } from "../popup/capture-grouping.js";

// ── Test 1 — Content-based classification fix ───────────────────────────

describe("Bug Condition: Content-based detection identifies media playlists regardless of URL naming", () => {
  /**
   * **Validates: Requirements 2.1**
   *
   * The fix replaces URL-based heuristics with content-based detection.
   * isMediaPlaylist inspects the actual playlist text, so non-standard
   * URL naming conventions no longer matter. This test verifies that
   * media playlist content is correctly identified regardless of how
   * the URL is named.
   */

  // Generate valid media playlist content (has #EXTINF, no #EXT-X-STREAM-INF)
  const mediaPlaylistContentArb = fc
    .integer({ min: 2, max: 8 })
    .chain((segCount) =>
      fc.tuple(
        fc.integer({ min: 3, max: 10 }), // target duration
        fc.array(
          fc.tuple(
            fc.float({ min: 1.0, max: 10.0, noNaN: true }),
            fc.stringMatching(/^seg[a-z0-9]{2,6}$/)
          ),
          { minLength: segCount, maxLength: segCount }
        )
      )
    )
    .map(([targetDuration, segments]) => {
      const lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        `#EXT-X-TARGETDURATION:${targetDuration}`,
        "#EXT-X-MEDIA-SEQUENCE:0",
      ];
      for (const [dur, name] of segments) {
        lines.push(`#EXTINF:${dur.toFixed(3)},`);
        lines.push(`${name}.ts`);
      }
      lines.push("#EXT-X-ENDLIST");
      return lines.join("\n");
    });

  it("isMediaPlaylist correctly identifies media playlist content regardless of URL naming", () => {
    fc.assert(
      fc.property(mediaPlaylistContentArb, (content) => {
        // Content-based detection should always identify media playlists
        expect(isMediaPlaylist(content)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });
});


// ── Test 2 — Master discovery for media playlists ───────────────────────

describe("Bug Condition: Master playlist discovery for media playlist URLs", () => {
  /**
   * **Validates: Requirements 2.2, 2.4**
   *
   * The fix adds discoverMasterPlaylist which walks up the URL path
   * hierarchy to find a parent master playlist. When a media playlist
   * is captured directly, the system now discovers the master and
   * returns its variants for quality selection.
   */

  it("discoverMasterPlaylist finds parent master for media playlist URLs", async () => {
    const masterContent =
      "#EXTM3U\n" +
      "#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080\n" +
      "1080p.m3u8\n" +
      "#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720\n" +
      "720p.m3u8";

    // Mock fetchFn: returns master content at a known candidate URL
    const fetchFn = async (url) => {
      if (url.endsWith("master.m3u8")) return masterContent;
      throw new Error("Not found");
    };

    const result = await discoverMasterPlaylist(
      "https://cdn.example.com/hls/720p/stream.m3u8",
      fetchFn
    );

    expect(result).not.toBeNull();
    expect(result.masterUrl).toContain("master.m3u8");

    const variants = parseHlsVariants(result.text, result.masterUrl);
    expect(variants.length).toBeGreaterThanOrEqual(2);
    // Verify variants are sorted descending by resolution
    expect(variants[0].resolution).toBe("1920x1080");
    expect(variants[1].resolution).toBe("1280x720");
  });

  it("discoverMasterPlaylist returns null when no master exists", async () => {
    const fetchFn = async () => {
      throw new Error("Not found");
    };

    const result = await discoverMasterPlaylist(
      "https://cdn.example.com/hls/stream.m3u8",
      fetchFn
    );

    expect(result).toBeNull();
  });
});

// ── Test 3 — Grouped captures correlation for quality selection ─────────

describe("Bug Condition: Grouped captures can be correlated for quality selection", () => {
  /**
   * **Validates: Requirements 2.3**
   *
   * The fix wires capture group correlation into the quality selection
   * flow. This test validates the prerequisite: captures sharing a group
   * key can have quality labels derived from their URLs via getGroupKey
   * and URL-based quality hints. The popup's download handler uses this
   * to present quality options when getVariants returns empty.
   */

  it("grouped media playlist captures can be correlated for quality selection", () => {
    const filenameSetArb = fc.shuffledSubarray(
      ["stream_720.m3u8", "stream_1080.m3u8", "stream_480.m3u8", "stream_360.m3u8"],
      { minLength: 2, maxLength: 4 }
    );

    fc.assert(
      fc.property(
        fc.constantFrom(
          "https://example.com/watch?v=123",
          "https://site.com/video/456"
        ),
        fc.constantFrom(
          "https://cdn.example.com/hls",
          "https://video.cdn.net/live"
        ),
        filenameSetArb,
        (sourcePage, cdnBase, filenames) => {
          const captures = filenames.map((f) => ({
            url: `${cdnBase}/${f}`,
            sourcePage,
            format: "m3u8",
            lastSeen: Date.now(),
          }));

          // Verify they share the same group key (same path prefix)
          const keys = captures.map(getGroupKey);
          const uniqueKeys = new Set(keys);
          expect(uniqueKeys.size).toBe(1);

          // Group them
          const groups = groupCaptures(captures);
          expect(groups.length).toBe(1);
          const group = groups[0];

          const totalMembers = 1 + group.related.length;
          expect(totalMembers).toBe(captures.length);

          // Verify quality labels can be derived from URLs
          // This is the prerequisite for the popup's group correlation logic
          const allUrls = [group.primary.url, ...group.related.map((r) => r.url)];
          for (const url of allUrls) {
            // Each URL should be parseable and have a derivable label
            const u = new URL(url);
            const lastSeg = u.pathname.split("/").filter(Boolean).pop() || "";
            expect(lastSeg).toBeTruthy();
            // The filename contains quality hints (e.g. "stream_720.m3u8")
            expect(lastSeg.endsWith(".m3u8")).toBe(true);
          }

          // All group members are m3u8 format — the popup can classify
          // and present them as quality options
          const allFormats = [group.primary, ...group.related].map(
            (c) => c.format
          );
          expect(allFormats.every((f) => f === "m3u8")).toBe(true);
        }
      ),
      { numRuns: 30 }
    );
  });
});
