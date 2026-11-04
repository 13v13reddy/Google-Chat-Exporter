# Testing Google Chat Exporter

## Automated verification

Run `npm test` and `npm run build` before committing export changes.

The Node test suite loads both browser sources with synthetic DOM and browser APIs. It covers history traversal, overlapping viewports, collapsed replies, deletion placeholders, parent/reply relationships, date filters, incremental baselines and context, cancellation, incomplete scans, and conversation changes behind fixed PWA addresses.

Packaging tests load the shipped JSZip library, generate and reopen real archives, and verify HTML, CSS, attachment bytes, UTF-8 text, and thread metadata. TXT and Markdown downloads are also decoded. Firefox's blob-URL download path is exercised with Node's Blob implementation. A synthetic 10,000-message Markdown export checks that message IDs and Unicode text survive packaging.

Result-card tests cover completed/pending/interrupted downloads, unavailable or foreign files, opening errors, stale status responses, persistent notifications, popup relay deduplication, and dismiss/resize message validation. The native Open API is mocked; these tests verify that the call occurs directly in the extension page's click handler, not that an operating-system application opens.

These tests mock `chrome.*` APIs. They do not prove that an installed extension has the required permissions, selects the right iframe, remains active through browser worker suspension, or successfully fetches authenticated Google attachments.

## Live verification performed

Read-only extraction was exercised in Vivaldi against a 5-reply thread and a 46-reply thread. The latter contained 45 normal replies and one existing deleted-message placeholder. All reply entries were captured with their parent relationship; the prior thread state and exact main scroll position were restored. No chat messages were sent, edited, or deleted.

That check ran the content extraction functions with stubbed extension APIs. It did not install the updated extension or run a real popup-to-background-to-download cycle. The later edge-case fixes have automated coverage but have not been rechecked against the live UI.

## Known boundaries

- Main history loading uses repeated idle checks to infer that it has reached the start. There is no authoritative total-message count. Very slow history responses and background-tab throttling still require live verification; reply-count checks verify discovered threads, not that every parent in the space was discovered.
- Incremental mode selects newly timestamped messages and previously unseen untimestamped entries. It does not detect an edit to an older message when that message retains its original timestamp. Use a full re-export when updates to old messages must be reflected.
- The exporter writes separate archive files. It does not synchronize changes back into earlier downloads.

## Manual release checks still required

| Area | Check |
| --- | --- |
| Installed desktop extension | Reload the extension and Chat. Export TXT, Markdown, and HTML from both the popup and right-click menu. Reopen the downloaded files. |
| Result card | Apply the added `downloads.open` permission. Confirm Open waits for completion, opens the exact downloaded file, and × dismisses the card without deleting the file. Check native Open in Chromium and Firefox, including the embedded extension frame. |
| Browser coverage | Run installed-extension checks in Chromium and Firefox desktop. Test Firefox Android separately because its thread layout can differ. |
| Chat layouts | Check standalone Chat, Gmail's embedded Chat frame, installed PWA windows, and the supported MCAS proxy hosts. |
| Authenticated attachments | Verify images, files, audio, and video from actual Google-hosted URLs. Confirm failed attachments warn and prevent checkpoint advancement. |
| Incremental updates | Export a baseline, then use an existing older thread that receives a new reply. Confirm the next export contains the reply and labeled parent context. |
| Cancellation and navigation | Cancel during history and media loading. Change conversations during export, including a PWA whose outer URL stays fixed. Confirm no mixed-conversation file is saved. |
| Downloads and worker lifecycle | Interrupt a download, restart the browser worker, and confirm its checkpoint remains unchanged. A completed download must advance it. |
| Scale and timing | Check a long real conversation, slow history loading, background tabs, and large media archives while watching responsiveness and memory. The synthetic Markdown check does not establish a safe limit for media archives. |
| Language and number formats | Check the Chat UI language in use. Unrecognized reply-count labels must leave the export unverified and its checkpoint unchanged. |

Use a test space for cases requiring new messages, edits, or deletions. Do not modify a work conversation merely to manufacture a test case.
