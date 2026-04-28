import { describe, it, expect } from "vitest";
import { isMediaPlaylist, isMasterPlaylist } from "../background/background-variants.js";

describe("isMediaPlaylist", () => {
  it("returns true for media playlist content (has #EXTINF, no #EXT-X-STREAM-INF)", () => {
    const media = "#EXTM3U\n#EXTINF:10,\nsegment0.ts\n#EXTINF:10,\nsegment1.ts";
    expect(isMediaPlaylist(media)).toBe(true);
  });

  it("returns false for master playlist content", () => {
    const master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow.m3u8";
    expect(isMediaPlaylist(master)).toBe(false);
  });

  it("returns false for content with both tags (master wins)", () => {
    const both = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow.m3u8\n#EXTINF:10,\nseg.ts";
    expect(isMediaPlaylist(both)).toBe(false);
  });

  it("returns false for null/undefined/non-string input", () => {
    expect(isMediaPlaylist(null)).toBe(false);
    expect(isMediaPlaylist(undefined)).toBe(false);
    expect(isMediaPlaylist(123)).toBe(false);
    expect(isMediaPlaylist("")).toBe(false);
  });

  it("returns false for unrelated text", () => {
    expect(isMediaPlaylist("hello world")).toBe(false);
  });
});

describe("isMasterPlaylist", () => {
  it("returns true for master playlist content", () => {
    const master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow.m3u8";
    expect(isMasterPlaylist(master)).toBe(true);
  });

  it("returns false for media playlist content", () => {
    const media = "#EXTM3U\n#EXTINF:10,\nsegment0.ts\n#EXTINF:10,\nsegment1.ts";
    expect(isMasterPlaylist(media)).toBe(false);
  });

  it("returns true when both tags present (master tag is the signal)", () => {
    const both = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow.m3u8\n#EXTINF:10,\nseg.ts";
    expect(isMasterPlaylist(both)).toBe(true);
  });

  it("returns false for null/undefined/non-string input", () => {
    expect(isMasterPlaylist(null)).toBe(false);
    expect(isMasterPlaylist(undefined)).toBe(false);
    expect(isMasterPlaylist(123)).toBe(false);
    expect(isMasterPlaylist("")).toBe(false);
  });

  it("returns false for unrelated text", () => {
    expect(isMasterPlaylist("hello world")).toBe(false);
  });
});
