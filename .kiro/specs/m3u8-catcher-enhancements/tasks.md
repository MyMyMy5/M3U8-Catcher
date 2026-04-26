# Implementation Plan: M3U8 Catcher Enhancements

## Overview

Implement six enhancements to the M3U8 Catcher Chrome extension: HLS/DASH variant parsing, quality selector UI, download notifications, batch download with quality choice, duplicate/related capture grouping, smarter video title extraction, and resolution badges on thumbnails. Tasks are ordered so each builds on the previous, ending with integration wiring.

## Tasks

- [x] 1. Create variant parser module (`background/background-variants.js`)
  - [x] 1.1 Implement `parseHlsVariants(playlistText, baseUrl)` function
    - Reuse `parseAttributeList` logic from `background-downloads.js` to parse `#EXT-X-STREAM-INF` entries
    - Extract `uri` (resolved to absolute URL), `resolution` (from RESOLUTION attribute), and `bandwidth` (from BANDWIDTH or AVERAGE-BANDWIDTH attribute)
    - Generate `label` field as `"{height}p · {bitrate} Mbps"` (e.g., "1080p · 4.5 Mbps")
    - Return empty array for media playlists (no `#EXT-X-STREAM-INF` entries)
    - Sort variants from highest vertical resolution to lowest
    - _Requirements: 1.1, 1.2, 1.3_

  - [x] 1.2 Implement `parseDashVariants(mpdText, baseUrl)` function
    - Parse MPD XML using DOMParser
    - Iterate `<AdaptationSet>` nodes with `mimeType` starting with `video/` or `contentType="video"`
    - Extract `<Representation>` children's `@width`, `@height`, `@bandwidth`, and `@id`
    - Build variant objects with `uri` (representation ID), `resolution` (`widthxheight`), `bandwidth`, and `label`
    - Return empty array for single-representation MPDs
    - Sort variants from highest vertical resolution to lowest
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 1.3 Implement `selectHighestQuality(variants)` helper
    - Return the variant with the maximum `bandwidth` value
    - _Requirements: 3.4_

  - [x] 1.4 Implement `selectClosestVariant(variants, targetHeight)` helper
    - Find the variant whose vertical resolution is closest to `targetHeight`
    - If two variants are equidistant, prefer the one with higher bandwidth
    - _Requirements: 5.2_

  - [x] 1.5 Write property test for HLS master playlist parsing
    - **Property 1: HLS master playlist parsing extracts all variants**
    - **Validates: Requirements 1.1, 1.3**

  - [x] 1.6 Write property test for media playlists producing empty variant list
    - **Property 2: Media playlists produce empty variant list**
    - **Validates: Requirements 1.2**

  - [x] 1.7 Write property test for DASH MPD parsing
    - **Property 3: DASH MPD parsing extracts all video representations**
    - **Validates: Requirements 2.1, 2.3**

  - [x] 1.8 Write property test for variant list sorting
    - **Property 4: Variant list is sorted by resolution descending**
    - **Validates: Requirements 3.2**

  - [x] 1.9 Write property test for highest quality selection
    - **Property 5: Highest quality selects maximum bandwidth**
    - **Validates: Requirements 3.4**

  - [x] 1.10 Write property test for closest variant selection
    - **Property 6: Closest variant selection picks nearest resolution**
    - **Validates: Requirements 5.2**

- [x] 2. Add `getVariants` message handler in `background/background.js`
  - [x] 2.1 Implement `getVariants` message handler
    - Listen for `{ type: "getVariants", url, format? }` messages
    - Fetch the playlist/manifest text using existing `fetchText` pattern
    - Detect format (HLS vs DASH) from URL or `format` field
    - Call `parseHlsVariants` or `parseDashVariants` accordingly
    - Return `{ ok: true, variants: [...] }` or `{ ok: false, error: "..." }`
    - Return empty variants array for single-variant streams
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3_

  - [x] 2.2 Modify `downloadVideo` handler to accept optional `variantUri`
    - When `variantUri` is present, download that specific variant URI instead of auto-selecting
    - Preserve existing behavior when `variantUri` is absent
    - _Requirements: 3.3_

- [x] 3. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Create download notification module (`background/background-notifications.js`)
  - [x] 4.1 Implement `notifyDownloadComplete(filename)` and `notifyDownloadFailed(errorMessage)`
    - Use `chrome.notifications.create` with `type: "basic"` and `iconUrl: "icons/icon128.png"`
    - Set title to "Download Complete" or "Download Failed" respectively
    - Set message body to filename or error description
    - Clear notification after 8 seconds using `setTimeout` + `chrome.notifications.clear`
    - _Requirements: 4.1, 4.2, 4.4, 4.5_

  - [x] 4.2 Add `"notifications"` permission to `manifest.json`
    - _Requirements: 4.3_

  - [x] 4.3 Wire notifications into existing download result flow in `background.js`
    - Call `notifyDownloadComplete` on successful `downloadResult`
    - Call `notifyDownloadFailed` on failed `downloadResult`
    - _Requirements: 4.1, 4.2_

  - [x] 4.4 Write unit tests for notification module
    - Mock `chrome.notifications.create` and `chrome.notifications.clear`
    - Verify correct title/message for success and failure
    - Verify clear is called after 8 seconds
    - _Requirements: 4.1, 4.2, 4.4, 4.5_

- [x] 5. Implement Quality Selector UI in popup
  - [x] 5.1 Add quality selector modal HTML to `popup/popup.html`
    - Add modal overlay container with variant list, "Highest quality" option, and close/cancel button
    - _Requirements: 3.1, 3.4, 3.5_

  - [x] 5.2 Add quality selector modal CSS to `popup/popup.css`
    - Style modal overlay, variant rows, and hover/active states consistent with existing dark theme
    - _Requirements: 3.1_

  - [x] 5.3 Implement quality selector logic in `popup/popup.js`
    - On download button click, send `getVariants` message to service worker
    - If 2+ variants returned, show quality selector modal with sorted variants
    - Include "Highest quality" option at top (selects max bandwidth variant)
    - Each row shows resolution label (e.g., "1080p") and formatted bitrate (e.g., "4.5 Mbps")
    - On variant selection, send `downloadVideo` with selected `variantUri`
    - On dismiss (click outside or Escape), cancel download and return to capture list
    - If 0-1 variants, proceed directly to download without showing modal
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 6. Implement Batch Download with Quality Choice
  - [x] 6.1 Add batch quality prompt UI to `popup/popup.html` and `popup/popup.css`
    - Add prompt overlay with options: "Highest", "Lowest", and common resolution tiers
    - _Requirements: 5.1_

  - [x] 6.2 Implement batch quality logic in `popup/popup.js`
    - On "Download All" click, send `getVariants` for each playlist-format capture in filtered list
    - Collect all unique resolution tiers across streams
    - Display batch quality prompt with "Highest", "Lowest", and common resolution tiers
    - On selection, iterate captures and pick closest variant to chosen resolution for multi-variant streams
    - Single-variant and direct-video captures download as-is
    - On dismiss, cancel batch operation
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

- [x] 7. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Implement Capture Grouping Logic
  - [x] 8.1 Implement `groupCaptures(captures)` function in `popup/popup.js`
    - Group captures by matching `sourcePage` URL AND shared URL path prefix (excluding final path segment and query params)
    - Return array of `{ primary, related }` objects
    - Primary is the capture with highest resolution or most recent timestamp
    - Wrap URL parsing in try/catch; captures with unparseable URLs get their own single-capture group
    - _Requirements: 6.1, 6.4, 6.5_

  - [x] 8.2 Update `renderCaptures` to use grouped rendering
    - Groups with 1 capture render as normal rows
    - Groups with 2+ captures render as collapsed row with "+N related" badge
    - Clicking badge expands to reveal all captures in the group
    - Recalculate groups on every render
    - _Requirements: 6.2, 6.3, 6.4, 6.5_

  - [x] 8.3 Write property test for capture grouping correctness
    - **Property 7: Capture grouping correctness**
    - **Validates: Requirements 6.1**

- [x] 9. Implement Title Extractor in content script
  - [x] 9.1 Add `extractVideoTitle()` function to `content/page-capture.js`
    - Check DOM sources in priority order: (a) `<meta property="og:title">`, (b) first `<h1>`, (c) `[class*="video-title"], [class*="player-title"], [data-video-title]`
    - Trim whitespace, truncate to 200 characters
    - Sanitize by removing `< > : " / \ | ? *` and control characters (U+0000–U+001F)
    - Return null if no title found from any source
    - Wrap all DOM access in try/catch
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x] 9.2 Integrate `extractVideoTitle` into `sendCapture` function
    - Call `extractVideoTitle()` and include result as `title` field in `captureUrl` message
    - _Requirements: 7.2, 7.3_

  - [x] 9.3 Write property test for title extraction priority order
    - **Property 8: Title extraction follows priority order**
    - **Validates: Requirements 7.1**

  - [x] 9.4 Write property test for title sanitization
    - **Property 9: Title sanitization preserves valid characters and enforces length**
    - **Validates: Requirements 7.4, 7.5**

- [x] 10. Implement Resolution Badge on Thumbnails
  - [x] 10.1 Add resolution cache and storage persistence in `popup/popup.js`
    - Create `resolutionCache` Map alongside existing `thumbCache` and `durationCache`
    - Load from `chrome.storage.local` key `m3u8_resolutions` on startup
    - Persist on updates using existing debounced save pattern
    - _Requirements: 8.4_

  - [x] 10.2 Capture resolution during thumbnail generation
    - After HLS.js seeks to first frame, read `videoEl.videoWidth` and `videoEl.videoHeight`
    - Store vertical resolution as `"{height}p"` in `resolutionCache`
    - Also capture for direct video sources
    - _Requirements: 8.1_

  - [x] 10.3 Add resolution badge CSS to `popup/popup.css`
    - Style `.thumb-resolution` badge at top-left of `.row-thumb` container
    - Semi-transparent dark background with white text, matching `.thumb-duration` style
    - _Requirements: 8.2, 8.5_

  - [x] 10.4 Render resolution badge in capture row
    - In `renderSingleRow`, check `resolutionCache` for the capture URL
    - If resolution is known, add a `.thumb-resolution` element to the thumbnail container
    - If resolution is unknown, do not display a badge
    - _Requirements: 8.1, 8.2, 8.3_

- [x] 11. Implement Streaming-to-Disk Downloads
  - [x] 11.1 Create offscreen document files (`offscreen/offscreen.html` + `offscreen/offscreen.js`)
    - Create `offscreen/offscreen.html` — minimal HTML page that loads `offscreen.js`
    - Create `offscreen/offscreen.js` — message listener that manages `WritableStream` instances
    - Handle message types: `startStreamDownload`, `streamChunk`, `streamEnd`, `streamAbort`
    - Use `showSaveFilePicker` to get a file handle, create `WritableStream`
    - Store active streams in a `Map` keyed by `downloadId`
    - On `streamChunk`, write the received `ArrayBuffer` chunk to the stream immediately
    - On `streamEnd`, close the stream and reply with success
    - On `streamAbort`, abort the stream and clean up
    - If `showSaveFilePicker` is not available or user cancels, reply with `streamFallback`
    - _Requirements: 9.1, 9.2, 9.3, 9.7_

  - [x] 11.2 Add `"offscreen"` permission to `manifest.json`
    - _Requirements: 9.6_

  - [x] 11.3 Add offscreen document management helpers in service worker
    - Create helper function `ensureOffscreenDocument()` that calls `chrome.offscreen.createDocument` if not already created
    - Use `reasons: ["WORKERS"]` and `justification: "Stream video segments directly to disk"`
    - Handle the case where the document already exists (check via `chrome.offscreen.hasDocument` or catch error)
    - _Requirements: 9.2, 9.6_

  - [x] 11.4 Modify `downloadVideoFromPlaylist` to support streaming-to-disk mode
    - Before starting segment downloads, create offscreen document and send `startStreamDownload`
    - Wait for `streamReady` response before proceeding
    - If `streamFallback` received, fall back to existing RAM-buffered approach
    - For each fetched segment, send `streamChunk` with the `ArrayBuffer` to the offscreen document
    - After all segments, send `streamEnd` and wait for completion
    - On error, send `streamAbort` to clean up the file handle
    - _Requirements: 9.1, 9.3, 9.4, 9.5, 9.8_

  - [x] 11.5 Modify `downloadDashVideo` to support streaming-to-disk mode
    - Same streaming approach as HLS: offscreen document → `showSaveFilePicker` → stream chunks
    - Fall back to RAM-buffered if offscreen streaming not available
    - _Requirements: 9.1, 9.3, 9.5_

  - [x] 11.6 Wire download initiation to prefer streaming-to-disk
    - In the `downloadVideo` message handler, attempt streaming-to-disk first
    - If streaming setup fails (offscreen creation fails, picker cancelled), fall back to RAM-buffered
    - _Requirements: 9.5_

- [x] 12. Final integration and wiring
  - [x] 12.1 Verify all new modules are properly imported in `background.js`
    - Import `parseHlsVariants`, `parseDashVariants` from `background-variants.js`
    - Import `notifyDownloadComplete`, `notifyDownloadFailed` from `background-notifications.js`
    - _Requirements: 1.1, 2.1, 4.1_

  - [x] 12.2 Verify manifest.json has all required permissions
    - Confirm `"notifications"` and `"offscreen"` permissions are present
    - _Requirements: 4.3, 9.6_

  - [x] 12.3 End-to-end verification of quality selection flow
    - Ensure popup → getVariants → quality selector → downloadVideo with variantUri works for both HLS and DASH
    - _Requirements: 1.1, 2.1, 3.1, 3.3_

  - [x] 12.4 End-to-end verification of streaming-to-disk download
    - Ensure download triggers offscreen document, streams segments to disk, and completes without RAM accumulation
    - Verify fallback to RAM-buffered download when `showSaveFilePicker` is unavailable
    - _Requirements: 9.1, 9.5, 9.8_

- [x] 13. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- The extension uses JavaScript (ES modules) throughout — no build step required
- All new modules follow the existing pattern of separate files in `background/` and `popup/` directories
