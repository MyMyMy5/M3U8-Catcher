import { describe, it, expect } from "vitest";
import {
  parseHlsVariants,
  parseDashVariants,
  selectHighestQuality,
  selectClosestVariant,
  deriveCandidateMasterUrls,
  discoverMasterPlaylist,
} from "./background-variants.js";

// ── parseHlsVariants ────────────────────────────────────────────────────

describe("parseHlsVariants", () => {
  const BASE = "https://cdn.example.com/stream/master.m3u8";

  it("extracts all variants from a master playlist", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080",
      "1080p/index.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720",
      "720p/index.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480",
      "480p/index.m3u8",
    ].join("\n");

    const variants = parseHlsVariants(text, BASE);
    expect(variants).toHaveLength(3);
    expect(variants[0].resolution).toBe("1920x1080");
    expect(variants[0].bandwidth).toBe(4500000);
    expect(variants[0].uri).toBe("https://cdn.example.com/stream/1080p/index.m3u8");
  });

  it("returns empty array for media playlists", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:10",
      "#EXTINF:9.009,",
      "segment0.ts",
      "#EXTINF:9.009,",
      "segment1.ts",
      "#EXT-X-ENDLIST",
    ].join("\n");

    expect(parseHlsVariants(text, BASE)).toEqual([]);
  });

  it("sorts variants from highest to lowest resolution", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480",
      "480p.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080",
      "1080p.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720",
      "720p.m3u8",
    ].join("\n");

    const variants = parseHlsVariants(text, BASE);
    expect(variants[0].resolution).toBe("1920x1080");
    expect(variants[1].resolution).toBe("1280x720");
    expect(variants[2].resolution).toBe("854x480");
  });

  it("prefers AVERAGE-BANDWIDTH over BANDWIDTH", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=5000000,AVERAGE-BANDWIDTH=4500000,RESOLUTION=1920x1080",
      "1080p.m3u8",
    ].join("\n");

    const variants = parseHlsVariants(text, BASE);
    expect(variants[0].bandwidth).toBe(4500000);
  });

  it("generates correct label", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080",
      "1080p.m3u8",
    ].join("\n");

    const variants = parseHlsVariants(text, BASE);
    expect(variants[0].label).toBe("1080p · 4.5 Mbps");
  });

  it("resolves relative URIs to absolute URLs", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720",
      "../other/720p.m3u8",
    ].join("\n");

    const variants = parseHlsVariants(text, BASE);
    expect(variants[0].uri).toBe("https://cdn.example.com/other/720p.m3u8");
  });

  it("returns empty for null/undefined input", () => {
    expect(parseHlsVariants(null, BASE)).toEqual([]);
    expect(parseHlsVariants(undefined, BASE)).toEqual([]);
    expect(parseHlsVariants("", BASE)).toEqual([]);
  });
});

// ── parseDashVariants ───────────────────────────────────────────────────

describe("parseDashVariants", () => {
  const BASE = "https://cdn.example.com/dash/manifest.mpd";

  const buildMpd = (representations) => `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      ${representations}
    </AdaptationSet>
  </Period>
</MPD>`;

  it("extracts all video representations", () => {
    const mpd = buildMpd(`
      <Representation id="v1" width="1920" height="1080" bandwidth="4500000"/>
      <Representation id="v2" width="1280" height="720" bandwidth="2500000"/>
      <Representation id="v3" width="854" height="480" bandwidth="1000000"/>
    `);

    const variants = parseDashVariants(mpd, BASE);
    expect(variants).toHaveLength(3);
    expect(variants[0].resolution).toBe("1920x1080");
    expect(variants[0].bandwidth).toBe(4500000);
    expect(variants[0].uri).toBe("v1");
  });

  it("returns empty for single-representation MPDs", () => {
    const mpd = buildMpd(`
      <Representation id="v1" width="1920" height="1080" bandwidth="4500000"/>
    `);

    expect(parseDashVariants(mpd, BASE)).toEqual([]);
  });

  it("sorts variants from highest to lowest resolution", () => {
    const mpd = buildMpd(`
      <Representation id="v1" width="854" height="480" bandwidth="1000000"/>
      <Representation id="v2" width="1920" height="1080" bandwidth="4500000"/>
      <Representation id="v3" width="1280" height="720" bandwidth="2500000"/>
    `);

    const variants = parseDashVariants(mpd, BASE);
    expect(variants[0].resolution).toBe("1920x1080");
    expect(variants[1].resolution).toBe("1280x720");
    expect(variants[2].resolution).toBe("854x480");
  });

  it("handles contentType='video' attribute", () => {
    const mpd = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
  <Period>
    <AdaptationSet contentType="video">
      <Representation id="v1" width="1920" height="1080" bandwidth="4500000"/>
      <Representation id="v2" width="1280" height="720" bandwidth="2500000"/>
    </AdaptationSet>
  </Period>
</MPD>`;

    const variants = parseDashVariants(mpd, BASE);
    expect(variants).toHaveLength(2);
  });

  it("ignores audio adaptation sets", () => {
    const mpd = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
  <Period>
    <AdaptationSet mimeType="audio/mp4">
      <Representation id="a1" bandwidth="128000"/>
    </AdaptationSet>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="v1" width="1920" height="1080" bandwidth="4500000"/>
      <Representation id="v2" width="1280" height="720" bandwidth="2500000"/>
    </AdaptationSet>
  </Period>
</MPD>`;

    const variants = parseDashVariants(mpd, BASE);
    expect(variants).toHaveLength(2);
    expect(variants.every((v) => v.uri.startsWith("v"))).toBe(true);
  });

  it("returns empty for invalid XML", () => {
    expect(parseDashVariants("not xml at all", BASE)).toEqual([]);
  });

  it("returns empty for null/undefined input", () => {
    expect(parseDashVariants(null, BASE)).toEqual([]);
    expect(parseDashVariants(undefined, BASE)).toEqual([]);
  });

  it("generates correct label", () => {
    const mpd = buildMpd(`
      <Representation id="v1" width="1920" height="1080" bandwidth="4500000"/>
      <Representation id="v2" width="1280" height="720" bandwidth="2500000"/>
    `);

    const variants = parseDashVariants(mpd, BASE);
    expect(variants[0].label).toBe("1080p · 4.5 Mbps");
    expect(variants[1].label).toBe("720p · 2.5 Mbps");
  });
});

// ── selectHighestQuality ────────────────────────────────────────────────

describe("selectHighestQuality", () => {
  it("returns the variant with maximum bandwidth", () => {
    const variants = [
      { uri: "a", bandwidth: 1000000, resolution: "854x480" },
      { uri: "b", bandwidth: 4500000, resolution: "1920x1080" },
      { uri: "c", bandwidth: 2500000, resolution: "1280x720" },
    ];
    expect(selectHighestQuality(variants)).toBe(variants[1]);
  });

  it("returns null for empty array", () => {
    expect(selectHighestQuality([])).toBeNull();
  });

  it("returns null for non-array input", () => {
    expect(selectHighestQuality(null)).toBeNull();
    expect(selectHighestQuality(undefined)).toBeNull();
  });

  it("returns the single variant when only one exists", () => {
    const variants = [{ uri: "a", bandwidth: 3000000, resolution: "1280x720" }];
    expect(selectHighestQuality(variants)).toBe(variants[0]);
  });
});

// ── selectClosestVariant ────────────────────────────────────────────────

describe("selectClosestVariant", () => {
  const variants = [
    { uri: "a", bandwidth: 4500000, resolution: "1920x1080" },
    { uri: "b", bandwidth: 2500000, resolution: "1280x720" },
    { uri: "c", bandwidth: 1000000, resolution: "854x480" },
  ];

  it("selects exact match", () => {
    expect(selectClosestVariant(variants, 720)).toBe(variants[1]);
  });

  it("selects closest when no exact match", () => {
    expect(selectClosestVariant(variants, 700)).toBe(variants[1]);
  });

  it("prefers higher bandwidth when equidistant", () => {
    const tied = [
      { uri: "a", bandwidth: 2000000, resolution: "1280x600" },
      { uri: "b", bandwidth: 3000000, resolution: "1280x800" },
    ];
    // Target 700: diff from 600 = 100, diff from 800 = 100 → pick higher bandwidth
    expect(selectClosestVariant(tied, 700)).toBe(tied[1]);
  });

  it("returns null for empty array", () => {
    expect(selectClosestVariant([], 1080)).toBeNull();
  });

  it("returns null for non-array input", () => {
    expect(selectClosestVariant(null, 1080)).toBeNull();
  });
});


// ── deriveCandidateMasterUrls ───────────────────────────────────────────

describe("deriveCandidateMasterUrls", () => {
  it("generates candidates walking up the path hierarchy", () => {
    const candidates = deriveCandidateMasterUrls(
      "https://cdn.example.com/hls/720p/stream.m3u8"
    );

    expect(candidates).toEqual([
      "https://cdn.example.com/hls/720p/master.m3u8",
      "https://cdn.example.com/hls/720p/playlist.m3u8",
      "https://cdn.example.com/hls/720p/index.m3u8",
      "https://cdn.example.com/hls/master.m3u8",
      "https://cdn.example.com/hls/playlist.m3u8",
      "https://cdn.example.com/hls/index.m3u8",
      "https://cdn.example.com/master.m3u8",
      "https://cdn.example.com/playlist.m3u8",
      "https://cdn.example.com/index.m3u8",
    ]);
  });

  it("does not include the original URL in candidates", () => {
    const url = "https://cdn.example.com/hls/720p/index.m3u8";
    const candidates = deriveCandidateMasterUrls(url);
    expect(candidates).not.toContain(url);
  });

  it("returns empty array for invalid URLs", () => {
    expect(deriveCandidateMasterUrls("not-a-url")).toEqual([]);
    expect(deriveCandidateMasterUrls("")).toEqual([]);
  });

  it("handles URL at root level with single path segment", () => {
    const candidates = deriveCandidateMasterUrls(
      "https://cdn.example.com/stream.m3u8"
    );

    expect(candidates).toEqual([
      "https://cdn.example.com/master.m3u8",
      "https://cdn.example.com/playlist.m3u8",
      "https://cdn.example.com/index.m3u8",
    ]);
  });

  it("handles deeply nested paths", () => {
    const candidates = deriveCandidateMasterUrls(
      "https://cdn.example.com/a/b/c/d/variant.m3u8"
    );

    expect(candidates).toHaveLength(15); // 5 levels × 3 filenames
    expect(candidates[0]).toBe("https://cdn.example.com/a/b/c/d/master.m3u8");
    expect(candidates[3]).toBe("https://cdn.example.com/a/b/c/master.m3u8");
    expect(candidates[6]).toBe("https://cdn.example.com/a/b/master.m3u8");
    expect(candidates[9]).toBe("https://cdn.example.com/a/master.m3u8");
    expect(candidates[12]).toBe("https://cdn.example.com/master.m3u8");
  });

  it("preserves the origin (protocol + host + port)", () => {
    const candidates = deriveCandidateMasterUrls(
      "https://cdn.example.com:8443/hls/stream.m3u8"
    );

    expect(candidates.every((c) => c.startsWith("https://cdn.example.com:8443/"))).toBe(true);
  });
});


// ── discoverMasterPlaylist ──────────────────────────────────────────────

describe("discoverMasterPlaylist", () => {
  const MASTER_TEXT = [
    "#EXTM3U",
    "#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080",
    "1080p/index.m3u8",
    "#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720",
    "720p/index.m3u8",
  ].join("\n");

  const MEDIA_TEXT = [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:10",
    "#EXTINF:9.009,",
    "segment0.ts",
    "#EXT-X-ENDLIST",
  ].join("\n");

  it("returns the first candidate that is a master playlist", async () => {
    const fetchFn = async (url) => {
      if (url === "https://cdn.example.com/hls/master.m3u8") return MASTER_TEXT;
      throw new Error("Not found");
    };

    const result = await discoverMasterPlaylist(
      "https://cdn.example.com/hls/720p/stream.m3u8",
      fetchFn
    );

    expect(result).not.toBeNull();
    expect(result.masterUrl).toBe("https://cdn.example.com/hls/master.m3u8");
    expect(result.text).toBe(MASTER_TEXT);
  });

  it("returns null when no candidate is a master playlist", async () => {
    const fetchFn = async () => {
      throw new Error("Not found");
    };

    const result = await discoverMasterPlaylist(
      "https://cdn.example.com/hls/720p/stream.m3u8",
      fetchFn
    );

    expect(result).toBeNull();
  });

  it("skips candidates that return media playlist content", async () => {
    let fetchCount = 0;
    const fetchFn = async (url) => {
      fetchCount++;
      if (url === "https://cdn.example.com/hls/master.m3u8") return MASTER_TEXT;
      return MEDIA_TEXT; // Not a master — should be skipped
    };

    const result = await discoverMasterPlaylist(
      "https://cdn.example.com/hls/720p/stream.m3u8",
      fetchFn
    );

    expect(result).not.toBeNull();
    expect(result.masterUrl).toBe("https://cdn.example.com/hls/master.m3u8");
    expect(fetchCount).toBeGreaterThan(1); // Had to try multiple candidates
  });

  it("handles fetch errors gracefully and continues to next candidate", async () => {
    let callIndex = 0;
    const fetchFn = async (url) => {
      callIndex++;
      if (callIndex <= 2) throw new Error("Network error");
      if (callIndex === 3) return MEDIA_TEXT; // Not a master
      if (url.endsWith("master.m3u8")) return MASTER_TEXT;
      throw new Error("Not found");
    };

    const result = await discoverMasterPlaylist(
      "https://cdn.example.com/hls/720p/stream.m3u8",
      fetchFn
    );

    // Should eventually find a master despite early errors
    // (or return null if none matched — depends on candidate order)
    // The key assertion: no unhandled errors thrown
    expect(callIndex).toBeGreaterThan(2);
  });

  it("tries candidates sequentially (not in parallel)", async () => {
    const callOrder = [];
    const fetchFn = async (url) => {
      callOrder.push(url);
      if (url === "https://cdn.example.com/hls/720p/master.m3u8") return MASTER_TEXT;
      throw new Error("Not found");
    };

    await discoverMasterPlaylist(
      "https://cdn.example.com/hls/720p/stream.m3u8",
      fetchFn
    );

    // First candidate should be at the same directory level
    expect(callOrder[0]).toBe("https://cdn.example.com/hls/720p/master.m3u8");
    // Should stop after finding the master (not fetch remaining candidates)
    expect(callOrder).toHaveLength(1);
  });

  it("returns null for invalid variant URL", async () => {
    const fetchFn = async () => MASTER_TEXT;

    const result = await discoverMasterPlaylist("not-a-url", fetchFn);
    expect(result).toBeNull();
  });

  it("stops fetching after finding the first master", async () => {
    let fetchCount = 0;
    const fetchFn = async () => {
      fetchCount++;
      return MASTER_TEXT;
    };

    const result = await discoverMasterPlaylist(
      "https://cdn.example.com/hls/720p/stream.m3u8",
      fetchFn
    );

    expect(result).not.toBeNull();
    expect(fetchCount).toBe(1); // Should stop after first match
  });
});
