# 🎬 M3U8 Catcher

> A Chrome extension that captures playlist and media URLs from network requests, lets you preview HLS streams inline, and download assembled video files — with quality selection, batch downloads, and smart capture grouping.

---

## ✨ Features

### Core
- **Automatic Detection** — Captures `.m3u8`, `.mpd`, `.f4m`, `.ism/.ismc`, `.pls`, and direct media URLs from any page via `chrome.webRequest`
- **Inline HLS Preview** — Click the play button to stream M3U8 playlists directly in the popup using [HLS.js](https://github.com/video-dev/hls.js/)
- **Video Assembly & Download** — Fetches all segments from HLS/DASH playlists, stitches them together, and downloads a single `.mp4` file
- **Telegram Support** — Dedicated content scripts for capturing media from Telegram Web
- **MIME-Type Detection** — Captures requests by URL extension *and* response content-type headers
- **Live Updates** — Popup auto-refreshes via `chrome.storage.onChanged` when new requests are detected

### Quality Selection
- **HLS Variant Parsing** — Parses master playlists to extract all available quality variants (resolution, bitrate)
- **DASH MPD Parsing** — Parses DASH manifests to extract video representations at different qualities
- **Quality Selector Modal** — When multiple qualities are available, a modal lets you pick your preferred resolution before downloading
- **"Highest Quality" Option** — One-click option to always grab the best available variant

### Batch Downloads
- **Download All with Quality Choice** — The "Download All" button lets you pick a quality tier (Highest, Lowest, or a specific resolution like 1080p, 720p) applied to all multi-variant streams at once
- **Smart Variant Matching** — For each stream, picks the variant closest to your chosen resolution

### Capture Grouping
- **Duplicate Detection** — Related captures from the same page are automatically grouped together
- **Collapsed Groups** — Groups show as a single row with a "+N related" badge to keep the list clean
- **Expandable** — Click the badge to reveal all captures in a group

### Smart Title Extraction
- **Page DOM Scanning** — Extracts the actual video title from the page instead of using the generic tab title
- **Priority Order** — Checks `og:title` meta tag → first `<h1>` → common video player title selectors
- **Filename Safe** — Sanitizes titles by removing invalid characters and truncating to 200 chars

### Resolution Badges
- **Thumbnail Overlays** — Each capture thumbnail shows a resolution badge (e.g., "1080p", "720p") at the top-left corner
- **Auto-Detection** — Resolution is captured during thumbnail generation from the video element
- **Persistent** — Resolution data survives popup reopens via `chrome.storage.local`

### Download Notifications
- **Chrome Notifications** — Get notified when a download completes or fails, even with the popup closed
- **Auto-Clear** — Notifications disappear after 8 seconds

---

## 📦 Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/YOUR_USERNAME/m3u8-catcher.git
   ```
2. Open **`chrome://extensions`** in Chrome
3. Enable **Developer mode** (toggle in the top right)
4. Click **Load unpacked** and select the cloned folder
5. Pin the extension for easy access

---

## 🚀 Usage

1. **Navigate** to any page with video playback
2. **Start playing** the video — the extension automatically captures playlist requests in the background
3. **Open the popup** by clicking the extension icon in the toolbar
4. For each captured URL, you can:

| Action | Description |
|---|---|
| ▶ **Play** | Preview HLS streams inline with video controls |
| **Open** | Open the URL in a new tab |
| **Copy** | Copy the URL to clipboard |
| **Manifest** | Download just the playlist/manifest file |
| **Download** | Assemble & download the full video (with quality selection for multi-variant streams) |
| **Remove** | Remove the entry from the list |

5. Use **Download All** to batch-download all captures with a consistent quality tier
6. Use **Refresh** to pull the latest captures, or **Clear** to reset

### Quality Selection Flow

When you click **Download** on an HLS/DASH capture that has multiple quality variants:
1. The extension fetches the manifest and parses available qualities
2. A modal appears listing all variants sorted by resolution (highest first)
3. Pick a quality or choose "Highest quality" for the best available
4. The selected variant is downloaded and assembled into an MP4

For single-quality streams, the download starts immediately without the modal.

---

## 🏗️ Architecture

```
m3u8-catcher/
├── manifest.json                  # Chrome extension manifest (MV3)
├── background/
│   ├── background.js              # Service worker entry point & message routing
│   ├── background-capture.js      # webRequest listener & URL matching
│   ├── background-downloads.js    # Video assembly (HLS/DASH → .mp4)
│   ├── background-variants.js     # HLS/DASH variant parsing
│   ├── background-notifications.js# Download completion notifications
│   ├── background-offscreen.js    # Offscreen document management
│   ├── background-telegram.js     # Telegram-specific capture logic
│   ├── background-utils.js        # Shared utilities
│   ├── background-constants.js    # Configuration constants
│   └── diagnostics.js             # Debug & diagnostic helpers
├── content/
│   ├── page-capture.js            # Generic page content script + title extraction
│   ├── title-extractor.js         # Title extraction module (testable ES module)
│   ├── telegram-capture.js        # Telegram media interception
│   ├── telegram-download.js       # Telegram download handling
│   └── telegram-page.js           # Telegram page integration
├── offscreen/
│   ├── offscreen.html             # Offscreen document for streaming downloads
│   └── offscreen.js               # WritableStream management
├── popup/
│   ├── popup.html                 # Extension popup UI (with quality & batch modals)
│   ├── popup.css                  # Dark theme styles
│   ├── popup.js                   # Popup logic, quality selector, grouping, badges
│   ├── capture-grouping.js        # Capture grouping logic (pure function)
│   └── hls.min.js                 # HLS.js library
└── tests/
    ├── background-variants.test.js          # Unit tests for variant parser
    ├── background-variants.property.test.js # Property-based tests (fast-check)
    ├── background-notifications.test.js     # Notification module tests
    ├── capture-grouping.property.test.js    # Grouping property tests
    └── title-extractor.property.test.js     # Title extraction property tests
```

---

## 📋 Supported Formats

### Playlist / Manifest
| Format | Extension | Download Support |
|---|---|---|
| HLS | `.m3u8` | ✅ Full (variant selection, AES-128, byte-range) |
| DASH | `.mpd` | ✅ SegmentTemplate / SegmentList |
| HDS | `.f4m` | ❌ Capture only |
| Smooth Streaming | `.ism` / `.ismc` | ❌ Capture only |
| PLS | `.pls` | ❌ Capture only |

### Direct Media
`.mp4`, `.webm`, `.mov`, `.mkv`, `.avi`, `.flv`, `.m4v`, `.mpg`, `.mpeg`, `.3gp`, `.3g2`, `.mp3`, `.m4a`, `.aac`, `.ogg`, `.opus`, `.wav`, `.flac`

---

## 🧪 Testing

The project uses [Vitest](https://vitest.dev/) with [fast-check](https://github.com/dubzzz/fast-check) for property-based testing.

```bash
npm install
npm test
```

### Test Coverage
- **Variant Parser** — Unit tests + property tests for HLS/DASH parsing, sorting, selection
- **Notifications** — Mock-based tests for Chrome notification API
- **Capture Grouping** — Property tests verifying grouping invariants
- **Title Extraction** — Property tests for priority order and sanitization

---

## ⚠️ Limitations

- **DRM** — Widevine, PlayReady, and FairPlay protected streams will fail
- **DASH** — No live MPD, no `SegmentTimeline`, no byte-range segments
- **AES-128** — Only `KEYFORMAT=identity` is supported
- **Memory** — Segment assembly happens in RAM; very large videos may be slow
- **Preview** — HLS preview works for most unencrypted streams; DRM or auth-gated streams will show an error
- **Quality Selector** — Only appears for master playlists with 2+ variants; single-quality streams download directly

---

## 🛠️ Permissions

| Permission | Purpose |
|---|---|
| `webRequest` | Network request interception |
| `storage` | Persisting captures, thumbnails, resolution cache |
| `downloads` | Triggering Chrome downloads with save dialog |
| `scripting` | Content script injection |
| `tabs` | Reading tab titles for fallback naming |
| `notifications` | Download completion/failure alerts |
| `offscreen` | Offscreen document for streaming downloads |
| `<all_urls>` | Universal request access |

---

## 📄 License

This project is provided as-is for personal and educational use.
