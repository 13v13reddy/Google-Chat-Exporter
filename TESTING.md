# Testing Google Chat Exporter

## Automated verification

Run `npm test` and `npm run build` before committing export changes.

The Node test suite loads both browser sources with synthetic DOM and browser APIs. It covers history traversal, overlapping viewports, collapsed replies, deletion placeholders, parent/reply relationships, date filters, incremental baselines and context, cancellation, incomplete scans, and conversation changes behind fixed PWA addresses.

Packaging tests load the shipped JSZip library, generate and reopen real archives, and verify HTML, CSS, attachment bytes, UTF-8 text, and thread metadata. TXT and Markdown downloads are also decoded. Firefox's blob-URL download path is exercised with Node's Blob implementation. A synthetic 10,000-message Markdown export checks that message IDs and Unicode text survive packaging.

Result-card tests cover completed/pending/interrupted downloads, unavailable or foreign files, opening errors, stale status responses, persistent notifications, popup relay deduplication, and dismiss/resize message validation. The native Open API is mocked; these tests verify that the call occurs directly in the extension page's click handler, not that an operating-system application opens.

Background-status regression tests cover hidden history waits, hiding and returning before a throttled timer fires, pausing/resuming a thread without losing replies, and cancelling a hidden export without saving a partial file. Worker/API fixtures verify popup reopening, status recovery in a new worker, source-tab reload/closure, packaging after Chat closes, native download completion/interruption/resumption, unchanged checkpoints on interrupted saves, and dismissal across popup instances. Popup fixtures also reject stale status snapshots and prevent an older job's completion from unlocking a newer running export.

Theme tests cover system defaults, saved light/dark choices, updates across popup/notification/result contexts, stale preference reads, failed storage writes, and notification listener cleanup. Progress-notification tests run the actual content UI renderer against a synthetic DOM. Thread diagnostic tests retain incomplete-export checkpoint safeguards and verify that TXT, Markdown, and HTML include failure reasons and reply coverage, with safe text escaping.

These tests mock `chrome.*` APIs. They do not prove that an installed extension has the required permissions, selects the right iframe, remains active through browser worker suspension, or successfully fetches authenticated Google attachments.

Frame-startup regressions execute the real content files in separate VM worlds for Gmail and its Chat iframe. The fixture supplies background senders without a frame ID, records frame-targeted starts, and runs injected functions in each world. It covers missing-helper repair, concurrent startup without script redeclaration, explicit rejection, isolated-world fallback, and stale-protocol errors. Content regressions also cover a detached progress host and a notification-rendering failure after a successful save. Popup cases cover delayed hydration during startup, failed starts without a second broadcast, unrelated frame relays, all existing range-setting combinations, and failed settings saves before auto-export is enabled. These remain simulated browser contexts, not an installed-browser end-to-end run.

## Live verification performed

Read-only extraction was exercised in Vivaldi against a 5-reply thread and a 46-reply thread. The latter contained 45 normal replies and one existing deleted-message placeholder. All reply entries were captured with their parent relationship; the prior thread state and exact main scroll position were restored. No chat messages were sent, edited, or deleted.

That check ran the content extraction functions with stubbed extension APIs. It did not install the updated extension or run a real popup-to-background-to-download cycle. The later edge-case fixes have automated coverage but have not been rechecked against the live UI.

After a user reported an eight-thread warning, a read-only check of all eight live threads verified 51 expected replies with zero incomplete threads. All 51 reply IDs matched the user's saved Markdown file in both directions. The original thread state and main scroll position were restored. The older file contains only the aggregate warning, so the exact reason its earlier run failed verification cannot be reconstructed; the new per-thread diagnostics record that evidence for future runs. This check does not certify undiscovered main-history messages or change the saved file or checkpoint.

Light/dark switching was checked in the installed Chromium extension page in Vivaldi: clicking the actual checkbox updated and persisted the popup appearance and changed the visible result card. A notification fixture used the content script's actual CSS and markup with the shared theme binding. Both light and dark surface colors matched across all three surfaces, and sampled text/action color pairs passed 4.5:1 contrast. The preference present at the start of that check was restored and the task-owned tab closed. The result card was in an unavailable-download state; the native Open action was not exercised. Firefox theme behavior has automated coverage but has not been checked in an installed Firefox instance.

## Known boundaries

- Main history loading uses repeated idle checks to infer that it has reached the start. There is no authoritative total-message count. Very slow history responses still require live verification; reply-count checks verify discovered threads, not that every parent in the space was discovered.
- Hidden tabs pause DOM-dependent history/thread collection and resume on return. Media fetching and background packaging do not require the popup to stay open. These changes have automated coverage, but the installed-extension tab-switching and worker lifecycle checks below have not yet been performed. An unfinished extraction or packaging job cannot resume after a browser restart; its retained status becomes interrupted.
- Packaging uses temporary extension API activity to avoid Chrome's idle worker shutdown. Browser shutdown, crashes, and enforced lifetime or memory limits can still interrupt it; progress metadata survives, while an unfinished archive does not. See [Chrome's worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).
- Incremental mode selects newly timestamped messages and previously unseen untimestamped entries. It does not detect an edit to an older message when that message retains its original timestamp. Use a full re-export when updates to old messages must be reflected.
- The exporter writes separate archive files. It does not synchronize changes back into earlier downloads.

## Manual release checks still required

| Area | Check |
| --- | --- |
| Installed desktop extension | Reload the extension and Chat. Export TXT, Markdown, and HTML from both the popup and right-click menu. Reopen the downloaded files. |
| Result card | Apply the added `downloads.open` permission. Confirm Open waits for completion, opens the exact downloaded file, and × dismisses the card without deleting the file. Check native Open in Chromium and Firefox, including the embedded extension frame. |
| Appearance | Toggle Dark mode while a progress or result notification is visible; verify immediate updates and persistence after reopening. Check native controls, focus rings, disabled actions, and errors in Chromium and Firefox. |
| Browser coverage | Run installed-extension checks in Chromium and Firefox desktop. Test Firefox Android separately because its thread layout can differ. |
| Chat layouts | Check standalone Chat, Gmail's embedded Chat frame, installed PWA windows, and the supported MCAS proxy hosts. |
| Authenticated attachments | Verify images, files, audio, and video from actual Google-hosted URLs. Confirm failed attachments warn and prevent checkpoint advancement. |
| Incremental updates | Export a baseline, then use an existing older thread that receives a new reply. Confirm the next export contains the reply and labeled parent context. |
| Cancellation and navigation | Cancel during history and media loading. Change conversations during export, including a PWA whose outer URL stays fixed. Confirm no mixed-conversation file is saved. |
| Downloads and worker lifecycle | Interrupt a download, restart the browser worker, and confirm its checkpoint remains unchanged. A completed download must advance it. |
| Background status | Start a long export, close the popup, switch to another tab, and reopen the extension there. Confirm WAIT and Return to Chat during history loading, automatic resume on return, and cancellation while hidden. Repeat during media loading and packaging; completed saves must retain Open and ×. Reload/close Chat during collection and verify a persistent interruption error. Restart the worker with both pending and completed downloads. |
| Scale and timing | Check a long real conversation, slow history loading, background tabs, and large media archives while watching responsiveness and memory. The synthetic Markdown check does not establish a safe limit for media archives. |
| Language and number formats | Check the Chat UI language in use. Unrecognized reply-count labels must leave the export unverified and its checkpoint unchanged. |

Use a test space for cases requiring new messages, edits, or deletions. Do not modify a work conversation merely to manufacture a test case.
