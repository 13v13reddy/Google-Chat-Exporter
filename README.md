# <a href="https://github.com/vishwas-r/Google-Chat-Exporter/"><img src="images/icon.svg" width="32" height="32" alt="Icon"></a> Google Chat Exporter

[![Version](https://img.shields.io/badge/version-2.2.0-green.svg)](https://github.com/vishwas-r/Google-Chat-Exporter)
[![License: GPL v3](https://img.shields.io/badge/License-GPL%20v3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0.en.html)
[![Maintenance](https://img.shields.io/badge/Maintained%3F-yes-green.svg)](https://github.com/vishwas-r/google-chat-exporter/graphs/commit-activity)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/vishwas-r/google-chat-exporter/pulls)
[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Extension-Available-blue.svg)](https://chromewebstore.google.com/detail/google-chat-exporter/epemodmmmilflmhgojgonhfcjfjnflgc)
[![Firefox Add-on](https://img.shields.io/badge/Firefox%20Add--on-Available-orange.svg)](https://addons.mozilla.org/en-US/firefox/addon/google-chat-exporter/)

The ultimate, privacy-first browser extension for exporting Google Chat conversations to **Plain Text (TXT)**, **Markdown (MD)**, or **rich HTML with full media attachments (packaged in a ZIP)**.

Works across **Google Chrome, Mozilla Firefox, Brave, Microsoft Edge**, standalone PWA windows, and Gmail-embedded Chat.

---

## ✨ Features

- **Three Export Formats**:
  - **Plain Text (`.txt`)**: Clean, formatted chronological transcript with senders, timestamps, and multi-line formatting preserved.
  - **Markdown (`.md`)**: Agent-friendly transcript with date and sender headings, ISO 8601 UTC timestamps when available, literal message text, and descriptive attachment links. No media downloads or ZIP extraction needed.
  - **Structured HTML (`.html + .zip`)**: Complete conversational archive with sender avatars, speech bubbles, embedded images, GIFs, audio notes, video chips, documents, and Google Meet call links.
- **Full Media Extraction**: Automatically downloads photos, GIFs, file attachments, and video previews into a neat `media/` folder inside the ZIP.
- **Adaptive History Loading**: Loads history batch-by-batch and continues as soon as Google Chat adds the next batch.
- **Thread Replies**: Opens discovered threads, expands collapsed replies, and groups replies with their parent in every export format. Deleted messages remain explicit placeholders. Thread loading uses the Chat UI and restores your previous thread and scroll position when available.
- **Optional Date Filter**: Export messages and replies since a selected date, with older parents retained as labeled context when needed. History loading still checks older threads for newer replies.
- **New Since Last Export**: Optional per-conversation checkpoints for TXT, Markdown, HTML, and HTML with attachments. Each run saves a separate file; the first run establishes a baseline. Checkpoints advance after a completed download. Turn the option off for a full re-export.
- **Auto-Export on Open**: Turn it on in the popup, then open each channel you want; every channel is exported once with your current settings as soon as it loads. Switching away mid-export cancels that export so it retries on your next visit. The mode turns off after 10 minutes without a channel switch and whenever the browser restarts; an `AUTO` badge shows while it is on.
- **Concurrent Media Downloads**: Downloads up to four attachments at a time.
- **Bot & Card Message Support**: Extracts card notifications, webhooks, and bot messages (e.g., alert cards) seamlessly.
- **Universal Compatibility**:
  - Standalone Google Chat (`chat.google.com`)
  - Gmail-integrated Google Chat (`mail.google.com`)
  - Company-proxied Google Chat and Gmail (`chat.google.com.mcas.ms`, `mail.google.com.mcas.ms`)
  - Progressive Web App (PWA) / standalone window mode (fully tested and working in Brave & Chrome)
- **Two Easy Export Methods**:
  - **Popup UI**: Modern toolbar popup with live conversation detection, format selection, and progress monitoring.
  - **Context Menu**: Right-click anywhere inside a conversation to export as TXT, Markdown, or HTML with media.
- **Live Animated HUD**: Real-time progress indicator showing message count, scroll progress, and media download status.
- **Open After Export**: A persistent result card appears in Chat and in the popup after packaging. **Open** becomes available when the download completes and opens that file with its associated application. Use **×** to dismiss the card without removing the file. HTML exports open as ZIP archives.
- **100% Private & Client-Side**: All parsing and ZIP generation happen inside your browser. No external servers, no tracking, zero telemetry.

---

## 📸 Screenshots

| Feature Overview & Popup | Exported HTML Chat View |
| :---: | :---: |
| ![Features & Popup](images/screenshot-1-features.jpg) | ![HTML Export](images/screenshot-2-html-export.jpg) |

---

## 📥 Installation

### Official Web Stores
Install directly from your browser's official store:

- 🌐 **Google Chrome, Brave, Microsoft Edge**:  
  👉 **[Google Chat Exporter on Chrome Web Store](https://chromewebstore.google.com/detail/google-chat-exporter/epemodmmmilflmhgojgonhfcjfjnflgc)**
- 🦊 **Mozilla Firefox (Desktop & Android)**:  
  👉 **[Google Chat Exporter on Firefox Add-ons (AMO)](https://addons.mozilla.org/en-US/firefox/addon/google-chat-exporter/)**

### Manual Installation (Developer Mode)

#### For Google Chrome, Brave, and Microsoft Edge:
1. Open your browser and go to `chrome://extensions/` (or `brave://extensions/`, `edge://extensions/`).
2. Toggle **Developer mode** on in the top right.
3. Click **Load unpacked** and select the [`chrome/`](chrome) folder.

#### For Mozilla Firefox:
1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**.
3. Select the `manifest.json` file inside the [`firefox/`](firefox) folder.

---

## 🛠️ Development & Building

Chrome and Firefox share source files and assets; only their manifests differ. Keep shared files identical in both folders. `npm run check:sources` checks this, and every package build runs the same check before creating archives. Popup and saved-result styles live in `ui.css`.

- **Run Tests:** `npm test`
- **Coverage and Manual Checks:** [Testing guide](TESTING.md). Automated tests use synthetic DOM/browser APIs; passing them does not replace installed-extension checks on each supported browser and layout.
- **Run Benchmarks:** `npm run benchmark`
- **Build Extension Packages:**
  - `npm run build` (builds both Chrome and Firefox ZIP archives in `dist/`)
  - `npm run build:chrome`
  - `npm run build:firefox`

## 🚀 How to Use

1. Navigate to [Google Chat](https://chat.google.com) or Gmail Chat.
2. Click into any direct message or space.
3. Choose either method:
   - **Toolbar Popup**: Click the extension icon in your browser toolbar, select **Plain Text**, **Markdown (.md)**, or **HTML + Media**, and click **Export Current Conversation**.
   - **Right-Click**: Right-click anywhere within the chat message area and select **"📄 Export Chat as TXT"**, **"📝 Export Chat as Markdown"**, or **"🌐 Export Chat as HTML (with media)"**.
4. The animated status HUD will appear in the bottom-right corner as it scrolls history, extracts messages, and bundles media.
5. Your export file (`.txt`, `.md`, or `.zip`) will download automatically to your Downloads folder.

### Switching tabs during an export

Closing the toolbar popup does not cancel the export. Reopen the extension from any tab to see its latest status, return to the source Chat tab, or cancel while messages or media are being collected. The toolbar badge shows `RUN`, `WAIT`, `SAVE`, `DONE`, or `ERR`. Results and errors remain until dismissed with ×; a saved file keeps its **Open** button.

History and thread loading depend on Google Chat rendering its page. Switching away pauses that stage safely and returning resumes it; time spent hidden does not count toward a loading timeout. Media fetching can continue while the Chat tab is hidden. Once the captured data has reached background packaging, saving continues even if that tab is closed. Success is reported only after the browser confirms the download completed.

Keep the Chat tab open until collection finishes. Reloading, closing, or discarding it during collection interrupts the export and leaves a persistent error. Browser restarts do not resume unfinished collection or packaging; the next status check reports the interruption. Native downloads are reconciled with the browser after restart. Switching conversations inside the same Chat tab also stops collection to prevent mixing conversations.

Status metadata for up to 20 recent finished exports is kept locally, along with all active jobs. It includes the conversation name, progress, result filename, and browser tab/download IDs, without message bodies or attachments.

### Export options

- **Messages → All messages and replies** loads history and the replies in each discovered thread.
- **Since a date** reveals a date input and filters messages and replies after loading history. Older parents can have new replies, so their threads are still checked. A parent needed to explain an exported reply is labeled as context.
- **New since last export** saves a per-conversation checkpoint and exports only newer messages on subsequent runs. The first run establishes a baseline; TXT, Markdown, HTML, and HTML-with-media modes use separate checkpoints.
- **Loaded messages only** exports the rendered timeline without opening threads. **Loaded since a date** also filters that rendered timeline by date.
- **Download attachments** is available for HTML. Text and Markdown retain attachment links.
- **Options** contains auto-export and dark mode. Dark mode applies to the popup and export notifications, remembers the choice locally, and follows the system appearance until a choice is saved.

Each incremental run creates a new file. Keep earlier files to retain the complete archive. Checkpoints are local to the browser profile and advance only after Chrome reports a completed download.

After updating the extension, refresh existing Chat tabs. Startup checks the content-script protocol and reports an explicit refresh error when a tab still has older code.

For an unpacked development installation, reload the extension before refreshing Chat. Newly opened popup pages can otherwise load changed files while the background worker is still running older code. The popup checks the worker protocol and startup job ID and reports the required extension reload instead of waiting for incompatible progress updates.

Thread loading depends on Google Chat's current DOM and reply counts. If a thread cannot be opened, collapsed replies remain, or fewer replies are captured than expected, the export carries an incomplete-history warning and its checkpoint does not advance. Deleted placeholders have no invented timestamp or recovered content.

Reply counts must be readable before a thread can be verified as complete. Unrecognized labels or number formats produce an incomplete-history warning and leave the checkpoint unchanged. If an incomplete scan finds no exportable messages, it reports an error instead of claiming there are no new messages.

An incomplete export includes **Thread loading issues** with each affected thread's ID, failure reason, and captured/expected reply counts. This distinguishes an unreadable count, a thread that did not open, collapsed replies that did not expand, and a reply-count mismatch. The result card says **Export saved with warnings**: the file exists, while its completeness remains unverified.

Thread-aware exports establish a new incremental baseline: checkpoints made before thread support cannot prove that hidden replies were captured. Later incremental exports rescan older threads, retain parent context for new replies, and remember already exported deletion placeholders.

### Markdown for agents

Markdown provides explicit message boundaries without HTML styling. Replies are grouped under their thread, with message IDs and reply-to IDs. Each message has a sender and timestamp heading; its body is preserved in a fenced `text` block, including code snippets, line breaks, and literal Markdown or HTML. Absolute timestamps use UTC; messages without them keep the displayed Chat time. Date headings retain Chat's displayed date labels.

Attachments appear as named links, so agents can identify files without loading binary content. These links may require a Google login or expire. Use HTML with media when you need an archive containing downloaded attachments.

## ⚡ Performance benchmark

Run `npm run benchmark` to compare repeated message extraction with upstream v2 commit `005a22f`. The synthetic workload uses 250 rendered message groups, 160 overlapping collections, alternates execution order, and reports the median of seven rounds.

| Workload | Upstream v2 | v2.2.0 | Speedup | Group parses (old/new) |
|---|---:|---:|---:|---:|
| Stable overlapping viewport | 16.1 ms | 6.4 ms | **2.50×** | 40,000 / 250 |
| 10% of groups changed each pass | 16.0 ms | 8.0 ms | **1.99×** | 40,000 / 4,225 |

Results are representative rather than universal and vary by machine. This benchmark isolates local DOM extraction; Google history-fetch/render latency and attachment downloads are excluded.

---

## 🔒 Privacy & Permissions

- **Zero Data Collection**: No user messages, media, or analytics are collected or sent over the internet.
- **Local Packaging**: HTML and ZIP archives are generated client-side using an offline bundling engine (`jszip`).
- **Minimal Permissions**:
  - `activeTab` & `scripting`: To read the chat DOM when initiated by you.
  - `contextMenus`: For convenient right-click options.
  - `downloads`: To save the exported file to your computer.
  - `downloads.open`: To open an exported file only when you click **Open**.
  - `storage`: To keep preferences, incremental checkpoints, and export status locally.

---

## 📄 License

This project is licensed under the GNU General Public License v3.0 - see the [LICENSE](LICENSE) file for details.
