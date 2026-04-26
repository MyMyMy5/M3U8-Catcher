# Requirements Document

## Introduction

This document specifies six enhancements to the M3U8 Catcher Chrome extension (Manifest V3). The features improve the download workflow with quality selection, download notifications, batch quality choice, duplicate grouping, smarter video title extraction, resolution badges on thumbnails, and streaming-to-disk downloads. Together they give users more control over what they download and a cleaner, more informative popup experience.

## Glossary

- **Extension**: The M3U8 Catcher Chrome extension running under Manifest V3.
- **Popup**: The browser-action popup UI rendered by `popup/popup.html` and `popup/popup.js`.
- **Service_Worker**: The background service worker at `background/background.js` that handles network interception, downloads, and message passing.
- **Quality_Selector**: A UI component (dropdown or modal) that presents available stream variants with resolution and bitrate before a download begins.
- **Variant**: A specific rendition of an HLS master playlist or DASH adaptation set, identified by resolution and/or bitrate.
- **Master_Playlist**: An HLS `.m3u8` file that contains `#EXT-X-STREAM-INF` entries pointing to variant sub-playlists.
- **MPD_Manifest**: A DASH Media Presentation Description XML document containing one or more Adaptation Sets with Representations at different qualities.
- **Capture**: A recorded network request for a playlist or media URL, stored in `chrome.storage.local` under the `m3u8Captures` key.
- **Capture_Group**: A set of Captures that share the same source page and are related by URL origin or content (e.g., same stream at different qualities, or duplicate detections).
- **Content_Script**: A script injected into web pages (e.g., `content/page-capture.js`) that observes network activity and DOM elements.
- **Title_Extractor**: Logic within the Content_Script that reads the page DOM to find the actual video title.
- **Resolution_Badge**: A small overlay label on a Capture thumbnail showing the video resolution (e.g., "1080p").
- **Download_Notification**: A Chrome notification shown via the `chrome.notifications` API when a background download completes or fails.
- **Batch_Download**: The "Download All" action that downloads multiple Captures in sequence.
- **Offscreen_Document**: A hidden HTML page created via the `chrome.offscreen` API that has full DOM access (including `showSaveFilePicker` and `WritableStream`) and persists independently of the popup.
- **Streaming_Download**: A download approach where media segments are written directly to disk as they are fetched, rather than buffered entirely in RAM before saving.

---

## Requirements

### Requirement 1: Parse HLS Master Playlist Variants

**User Story:** As a user, I want the extension to parse HLS master playlists and extract all available quality variants, so that I can see what resolutions and bitrates are available before downloading.

#### Acceptance Criteria

1. WHEN the user initiates a download of a Capture whose format is `m3u8`, THE Service_Worker SHALL fetch the master playlist and parse all `#EXT-X-STREAM-INF` entries to extract each Variant's URI, resolution, and bandwidth.
2. IF the fetched `.m3u8` file contains no `#EXT-X-STREAM-INF` entries (i.e., it is a media playlist, not a master playlist), THEN THE Service_Worker SHALL treat the file as a single-variant stream and proceed to download without showing the Quality_Selector.
3. THE Service_Worker SHALL return the parsed Variant list to the Popup in a message response containing an array of objects, each with `uri`, `resolution` (string, e.g., "1920x1080"), and `bandwidth` (integer, bits per second).

### Requirement 2: Parse DASH MPD Manifest Variants

**User Story:** As a user, I want the extension to parse DASH MPD manifests and extract available quality representations, so that I can choose a quality for DASH streams as well.

#### Acceptance Criteria

1. WHEN the user initiates a download of a Capture whose format is `mpd`, THE Service_Worker SHALL fetch the MPD manifest and parse all `<Representation>` elements within video `<AdaptationSet>` nodes to extract each Variant's resolution (`@width`, `@height`) and bandwidth (`@bandwidth`).
2. IF the MPD manifest contains only one video Representation, THEN THE Service_Worker SHALL proceed to download without showing the Quality_Selector.
3. THE Service_Worker SHALL return the parsed Variant list to the Popup in the same array format used for HLS variants: objects with `uri` (or representation ID), `resolution`, and `bandwidth`.

### Requirement 3: Quality Selector UI

**User Story:** As a user, I want to see a dropdown or modal listing available qualities with resolution and bitrate before a download starts, so that I can pick the quality I prefer.

#### Acceptance Criteria

1. WHEN the Service_Worker returns a Variant list containing two or more entries, THE Popup SHALL display the Quality_Selector showing each Variant's resolution label (e.g., "1080p", "720p") and formatted bitrate (e.g., "4.5 Mbps").
2. THE Quality_Selector SHALL sort Variants from highest resolution to lowest resolution.
3. WHEN the user selects a Variant from the Quality_Selector, THE Popup SHALL send a download message to the Service_Worker specifying the selected Variant's URI.
4. THE Quality_Selector SHALL include a "Highest quality" option at the top that selects the Variant with the largest bandwidth.
5. IF the user dismisses the Quality_Selector without selecting a Variant, THEN THE Popup SHALL cancel the download and return to the capture list.

### Requirement 4: Download Progress Notification

**User Story:** As a user, I want to receive a Chrome notification when a background download completes or fails, so that I know the result even when the popup is closed.

#### Acceptance Criteria

1. WHEN a download initiated by the Service_Worker completes, THE Service_Worker SHALL display a Chrome notification with the title "Download Complete" and a body containing the downloaded file name.
2. WHEN a download initiated by the Service_Worker fails, THE Service_Worker SHALL display a Chrome notification with the title "Download Failed" and a body containing the error description.
3. THE Extension SHALL declare the `"notifications"` permission in `manifest.json`.
4. THE Service_Worker SHALL use the `chrome.notifications.create` API with `type: "basic"` to create each Download_Notification.
5. THE Service_Worker SHALL clear each Download_Notification after 8 seconds using `chrome.notifications.clear`.

### Requirement 5: Batch Download with Quality Choice

**User Story:** As a user, I want the "Download All" button to let me pick a quality tier for all videos at once, so that I can batch-download everything at a consistent quality without choosing individually.

#### Acceptance Criteria

1. WHEN the user clicks the "Download All" button and at least one Capture in the current filtered list is a multi-variant stream, THE Popup SHALL display a batch quality prompt offering the options: "Highest", "Lowest", and each common resolution tier present across the streams (e.g., "1080p", "720p", "480p").
2. WHEN the user selects a quality tier from the batch quality prompt, THE Popup SHALL initiate downloads for all visible Captures, selecting the Variant closest to the chosen resolution for each multi-variant stream.
3. FOR Captures that are single-variant streams or direct video files, THE Popup SHALL download them at their only available quality regardless of the selected tier.
4. IF the user dismisses the batch quality prompt without selecting a tier, THEN THE Popup SHALL cancel the batch download operation.

### Requirement 6: Duplicate and Related Capture Grouping

**User Story:** As a user, I want related or duplicate captures grouped together in the popup list, so that the list stays clean and I can easily find distinct streams.

#### Acceptance Criteria

1. THE Popup SHALL group Captures into Capture_Groups based on matching source page URL and a shared URL path prefix (excluding the final path segment and query parameters).
2. WHEN a Capture_Group contains two or more Captures, THE Popup SHALL display the group as a single collapsed row showing the primary Capture (the one with the highest resolution or most recent timestamp) with a badge indicating the number of related Captures (e.g., "+2 related").
3. WHEN the user clicks the group badge or expands a collapsed group row, THE Popup SHALL expand the row to reveal all Captures within the Capture_Group.
4. WHEN a Capture_Group contains only one Capture, THE Popup SHALL display the Capture as a regular ungrouped row.
5. THE Popup SHALL recalculate Capture_Groups each time the capture list is re-rendered (on refresh, storage change, or search filter change).

### Requirement 7: Auto-Detect Page Video Title

**User Story:** As a user, I want the extension to extract the actual video title from the page DOM instead of using the browser tab title, so that downloaded files have more accurate names.

#### Acceptance Criteria

1. WHEN the Content_Script detects a Capture on a page, THE Title_Extractor SHALL attempt to extract the video title by checking the following DOM sources in order: (a) `<meta property="og:title">` content attribute, (b) the first `<h1>` element's text content, (c) common video player title selectors (elements matching `[class*="video-title"], [class*="player-title"], [data-video-title]`).
2. IF the Title_Extractor finds a non-empty title from any source in the priority order, THEN THE Content_Script SHALL include the extracted title in the `captureUrl` message sent to the Service_Worker.
3. IF the Title_Extractor finds no title from any DOM source, THEN THE Content_Script SHALL omit the title field, and the Service_Worker SHALL fall back to the tab title as it does today.
4. THE Title_Extractor SHALL trim whitespace and truncate the extracted title to a maximum of 200 characters.
5. THE Title_Extractor SHALL sanitize the extracted title by removing characters that are invalid in file names (`< > : " / \ | ? *` and control characters).

### Requirement 8: Resolution Badge on Thumbnail

**User Story:** As a user, I want to see the video resolution as a badge on the capture thumbnail, so that I can quickly identify the quality of each capture at a glance.

#### Acceptance Criteria

1. WHEN a Capture has a known resolution (from parsed variant data or HLS.js manifest parsing during thumbnail generation), THE Popup SHALL display a Resolution_Badge overlay on the thumbnail showing the vertical resolution followed by "p" (e.g., "1080p", "720p").
2. THE Resolution_Badge SHALL be positioned at the top-left corner of the thumbnail, visually distinct from the existing duration badge at the bottom-right.
3. WHEN a Capture does not have a known resolution, THE Popup SHALL not display a Resolution_Badge for that Capture.
4. THE Popup SHALL persist detected resolution data in `chrome.storage.local` alongside the existing thumbnail and duration caches, so that Resolution_Badges survive popup reopens.
5. THE Resolution_Badge SHALL use a semi-transparent dark background with white text, consistent with the styling of the existing duration badge.

### Requirement 9: Streaming-to-Disk Downloads

**User Story:** As a user, I want video downloads to stream directly to disk as segments are fetched, so that large videos don't consume gigabytes of RAM and downloads work reliably for long content.

#### Acceptance Criteria

1. WHEN the Service_Worker begins assembling an HLS or DASH video, THE Extension SHALL write each downloaded segment directly to a file on disk as it is fetched, rather than accumulating all segments in memory before saving.
2. THE Extension SHALL use an Offscreen_Document (via `chrome.offscreen.createDocument`) to host the `showSaveFilePicker` / `WritableStream` APIs, since these are not available in the Service_Worker context.
3. THE Offscreen_Document SHALL receive segment data from the Service_Worker via message passing and write each chunk to the `WritableStream` immediately upon receipt.
4. THE Offscreen_Document SHALL persist independently of the Popup, so that closing the Popup does not interrupt an active Streaming_Download.
5. IF the `showSaveFilePicker` API is not available (e.g., the browser does not support it), THE Extension SHALL fall back to the existing RAM-buffered download approach using `chrome.downloads.download`.
6. THE Extension SHALL declare the `"offscreen"` permission in `manifest.json` and include the `reasons: ["WORKERS"]` justification when creating the offscreen document.
7. WHEN a Streaming_Download completes, THE Offscreen_Document SHALL close the `WritableStream` and notify the Service_Worker of success. WHEN a Streaming_Download fails, THE Offscreen_Document SHALL abort the `WritableStream` and notify the Service_Worker of the error.
8. Peak memory usage during a Streaming_Download SHALL not exceed the size of a single segment plus overhead, regardless of the total video size.
