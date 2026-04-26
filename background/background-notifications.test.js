import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { notifyDownloadComplete, notifyDownloadFailed } from "./background-notifications.js";

// ── Chrome API mocks ────────────────────────────────────────────────────

beforeEach(() => {
  globalThis.chrome = {
    notifications: {
      create: vi.fn(),
      clear: vi.fn(),
    },
  };
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete globalThis.chrome;
});

// ── notifyDownloadComplete ──────────────────────────────────────────────

describe("notifyDownloadComplete", () => {
  it("creates a notification with correct title and message", () => {
    notifyDownloadComplete("my-video.mp4");

    expect(chrome.notifications.create).toHaveBeenCalledOnce();
    const [id, opts] = chrome.notifications.create.mock.calls[0];
    expect(typeof id).toBe("string");
    expect(opts).toMatchObject({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Download Complete",
      message: "my-video.mp4",
    });
  });

  it("clears the notification after 8 seconds", () => {
    notifyDownloadComplete("file.ts");

    const id = chrome.notifications.create.mock.calls[0][0];
    expect(chrome.notifications.clear).not.toHaveBeenCalled();

    vi.advanceTimersByTime(8000);

    expect(chrome.notifications.clear).toHaveBeenCalledOnce();
    expect(chrome.notifications.clear).toHaveBeenCalledWith(id);
  });

  it("uses fallback message when filename is empty", () => {
    notifyDownloadComplete("");

    const [, opts] = chrome.notifications.create.mock.calls[0];
    expect(opts.message).toBe("Download finished");
  });
});

// ── notifyDownloadFailed ────────────────────────────────────────────────

describe("notifyDownloadFailed", () => {
  it("creates a notification with correct title and error message", () => {
    notifyDownloadFailed("Network timeout");

    expect(chrome.notifications.create).toHaveBeenCalledOnce();
    const [id, opts] = chrome.notifications.create.mock.calls[0];
    expect(typeof id).toBe("string");
    expect(opts).toMatchObject({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Download Failed",
      message: "Network timeout",
    });
  });

  it("clears the notification after 8 seconds", () => {
    notifyDownloadFailed("Something went wrong");

    const id = chrome.notifications.create.mock.calls[0][0];
    expect(chrome.notifications.clear).not.toHaveBeenCalled();

    vi.advanceTimersByTime(8000);

    expect(chrome.notifications.clear).toHaveBeenCalledOnce();
    expect(chrome.notifications.clear).toHaveBeenCalledWith(id);
  });

  it("uses fallback message when error is empty", () => {
    notifyDownloadFailed("");

    const [, opts] = chrome.notifications.create.mock.calls[0];
    expect(opts.message).toBe("An unknown error occurred");
  });
});
