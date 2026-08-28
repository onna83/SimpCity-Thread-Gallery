# Changelog

This file records only history supported by the available source snapshots and project notes. Earlier releases did not have complete per-version release notes, so they are not reconstructed from guesswork.

## 0.13.0 (timeline fork — unreleased)

Performance pass. No interface changes. Figures are from `tests/bench.cjs` on a synthetic 5,000-item thread with 1,000 embeds — run it yourself with `node tests/bench.cjs`.

- **The scroll path was spending most of a frame budget re-parsing URLs.** Scrolling ran `updateSelectionUi`, which filtered every indexed item through `isDownloadableMedia`, which for an embed reached `hasDirectResolver` — roughly twenty-eight `new URL()` constructions per item, because `normalizeSourceUrl` is itself three. Measured at **14.3 ms per scroll frame** against a 16.7 ms budget for 60fps, before any mounting, layout or paint. Two changes: the selection scan is gone from the frame entirely (a mounted card already renders its own selected state, and scrolling cannot change the selection), and the work it did is now derived once per item at index time. The same scan, if something does run it, is **0.9 ms — 16× faster**.
- **Download-history keys are derived once instead of per card.** `downloadHistoryKey` called `threadBaseUrl` — another URL construction — and every card asked twice, via `wasDownloaded` and `hasLegacyDownload`, plus once more per card in `updateDownloadedIndicators`. **9.6 ms → 0.06 ms** across 5,000 items.
- **One collator instead of tens of thousands.** Three sorts passed an options object to `localeCompare`, which builds a fresh collator per comparison; sorting 5,000 items by author is around 60,000 comparisons. **154 ms → 2.3 ms, 68× faster.** This ran on every keystroke in the search box.
- **Most scroll frames now do nothing at all.** `updateFlowWindow` recomputed its keep-set, unmounted and remounted on every frame even when the visible range was identical, which it is for most frames. It returns early instead.
- **Image ratios settle together rather than re-packing per frame.** A late measurement re-packs the whole list, and during a first scroll they arrive continuously. Ratio-driven relayouts coalesce on a 150ms timer; a resize or density change — where the reader is waiting on the geometry — stays immediate.
- Smaller: `escapeHtml` allocated a fresh escape map for every matched character; icon markup is memoized on name and class rather than rebuilt for every card the window remounts; type counts are memoized on the dataset revision like the facet lists already were; download-history entries are only rebuilt when they are not already canonical, rather than 5,000 fresh objects on every write; the facet counts evaluate each item once instead of twice; the download queue makes one pass over its jobs instead of four; the assumed aspect ratio is hoisted out of a map over the filtered set.
- The uniform grid — the one live path that still mounts every matched card — now declares `content-visibility` with an exact intrinsic size, so the browser can skip layout and paint for off-screen cards. Deliberately not applied to masonry, whose cards sit in CSS multi-column and have to be seen to be balanced.
- Two items from the plan were measured and left alone: re-sorting the cell index is 1.06 ms per relayout, which coalescing already limits to once per 150ms, so a k-way merge was not worth changing a tested code path; and the playback-position and active-player maps are already cleared with the dataset.

## 0.12.1 (timeline fork — unreleased)

Defect pass over 0.12.0. No new capability.

- **Three strings still advertised layouts that had been deleted.** The "All" clamp toast, the Per view size warning and the Settings → Appearance copy each told the reader to use Flow or Timeline — layouts 0.12.0 removed. They now name Masonry, which is the one that actually renders only what is on screen. A test fails if a retired layout name ever reappears in anything the reader can see.
- **Fixed measured image ratios being silently dropped while scrolling.** `scheduleFlowLayout` and `scheduleFlowWindow` shared one animation-frame slot and each returned early if the slot was taken, so a scroll-queued window update swallowed a re-pack request landing in the same frame. Since a scroll and an arriving image ratio coincide constantly, the newly measured ratio never reached the layout and the card kept its estimated height. A pending layout is now sticky: a window request can never downgrade it.
- **Fixed a re-mounted card rendering an expired signed URL.** `embedPlayerMarkup` read the cached resolution directly, bypassing the expiry check that `resolveCandidate` applies, so scrolling back to a played Bunkr card after its token died mounted a dead `<video>` with no error handling. Playback liveness is now asked before re-mounting; a stale card shows its Play button again, and pressing it resolves a fresh URL.
- **Fixed download markers being lost to a failed write.** `persistDownloadHistory` emptied its pending set on the line before `storage.set`, inside a try whose catch swallows everything — so a quota failure dropped those records permanently, with no later write able to carry them. The pending set is now cleared only once the write has landed.
- **Fixed filename collisions within one reply.** `mediaIndex` restarted at zero for each of the four extraction passes, so a `<video>` element and a direct `.mp4` link in the same reply both produced `-vid01`. One counter now runs across all four. Download history keys are derived from the URL, not the filename, so existing history is unaffected.
- Removed `partitionSections`, `stackSections` and `stickyHeaderOffset` — dead since the Timeline layout went, and held up only by their own tests, which read as covered behaviour. Removed seven icons nothing draws, and corrected three comments still describing a two-renderer design.

## 0.12.0 (timeline fork — unreleased)

- **Cut the layout picker from five to two: Masonry and Grid.** Flow was Masonry computed rather than CSS-balanced — the same picture at the same column width, differing only in that it was virtualized, which is an implementation detail that never belonged in a picker. Masonry *is* that renderer now, so the default layout windows itself and a several-thousand-item thread no longer mounts every card. Timeline (justified rows) and Feed (one per row) are gone; a stored layout that no longer exists falls back to Masonry.
- Computed packing fills the available width, which would have made the default denser than it has always been. The column caps the CSS carried (5/4/3/2 comfortable, 7/6/4/2 compact, by the same breakpoints) are now honoured by the packer, so folding the two together did not change how Masonry looks.
- Masonry's CSS columns had to be told when *not* to apply: `[data-layout="masonry"]` out-specifies `.flowing` and would have re-imposed columns and an aspect-ratio height on absolutely positioned cards. What survives of them serves the two paths the window does not own — the skeletons during a scan, and reply groups.
- The card-size slider is no longer disabled by layout (that was Feed only), and the container queries that shrink card chrome now follow the cell rather than a retired layout — compact density at the smallest card size is what makes a cell narrow now.

## 0.11.5 (timeline fork — unreleased)

- **Bunkr videos now play on the card instead of only linking out.** A card decided whether it could play something by asking whether the host registry had an iframe URL for it. Bunkr has none, because it refuses to be framed — so it rendered as a bare "Open video host" link even though the viewer had been playing its signed file natively since the resolver landed in 0.11.0. Framing and resolving are separate questions and are now asked separately: a card plays in place when either a host player can be framed or the resolver can produce a file, so Bunkr gets a Play button that streams the signed CDN URL. Its placeholder says "Stream from bunkr.cr" rather than "Load bunkr.cr player", since no third-party player is involved.
- A host that cannot be framed and whose file will not play inline now shows a short panel with a link to the host, rather than an iframe that would only render blank.

## 0.11.4 (timeline fork — unreleased)

- **Fixed an embedded video restarting when opened in the viewer.** 0.11.3 stopped the card's player but could not carry its position, because both the card and the viewer mounted the host's own cross-origin iframe and an iframe's position cannot be read, set, or handed anywhere. Where the resolver produces a confirmed video file — Turbo and Bunkr, today — both ends now play that file natively instead, so the position handoff applies: the viewer picks up where the card was, and closing returns it. The host's player remains the fallback for anything that does not resolve, does not resolve to a video, or refuses to play inline, and a file that fails once is not retried on later renders.
- Scrolling a playing card out of a windowed layout and back no longer rewinds it.

## 0.11.3 (timeline fork — unreleased)

- **Fixed a card's video continuing to play behind the viewer.** Opening the viewer never touched the grid, so pressing View on a playing video left two copies running — the card underneath and a fresh viewer player starting from zero. The viewer now stops the grid on the way in and inherits the position, so it picks up where the card was. Closing hands the position back, so returning to the card and pressing play resumes rather than restarting. Embedded third-party players were affected too and could not simply be paused: they expose neither a position nor a pause control, so they are returned to their "Play video" placeholder instead.

## 0.11.2 (timeline fork — unreleased)

Second review pass on the 0.11.x fixes.

- **Fixed the Bunkr resolver claiming album links.** 0.11.1 routed every Bunkr URL into the single-file resolver, so an album link wrapped around a thumbnail returned "album page rather than a single file" instead of falling through to the ordinary image-page and thumbnail paths it used before Bunkr support existed. Both resolver branches now require a valid `/f/` id.
- **Moved the "All" size notice ahead of the render it warns about.** It fired after `commitState` had already mounted every card, which is precisely when a phone stalls, and it counted the previous page's rows rather than what was about to mount. It now counts the matched set, warns first, and is disjoint from the 1,200 clamp so the two notices never both fire. Both thresholds are named constants.

## 0.11.1 (timeline fork — unreleased)

Review fixes on 0.11.0. No interface redesign and no new features.

- **Fixed Group by Reply silently bypassing virtualization.** `isWindowedLayout()` answered on the layout alone while the renderer applied stricter conditions, so Flow or Timeline plus Group by Reply plus Per view: All mounted every matched card with the size warning suppressed. One predicate, `usesWindowedRenderer()`, now accounts for layout, reply grouping and scanning, and is the single source for rendering, the All warning, pager visibility, Per view state, status text and the settings copy. When nothing is bounding the DOM, All is paged at the default size for that render only — the stored preference is never rewritten, so returning to an ungrouped windowed layout restores it — and the fallback announces itself once.
- **Fixed Bunkr files being downloadable individually but never selectable.** `isDownloadableMedia()` only admitted unresolved Turbo embeds, so a Bunkr `/f/` item had a working resolver and a Download button but no checkbox and no way into the ZIP queue. Single-file Bunkr links now count as downloadable before resolution; album `/a/` pages stay excluded, and a resolution that already failed stays failed.
- **Fixed a cleared history being resurrected by another tab.** 0.11.0 merged the tab's entire in-memory map into storage on every write, so a tab that missed a Clear History could restore everything it still held on its next download. Storage is now the record and a tab contributes only the entries it has created since its last write.
- **Fixed history replacement truncating in other tabs.** The replace broadcast carried the newest 250 entries and receiving tabs replaced their whole history with it, so importing a larger backup made older download indicators disappear elsewhere. All three cases now broadcast one payload-free invalidation and receivers reload the full record from storage.
- **Fixed Per view being live but inert in Flow and Timeline.** It is disabled while virtualization is genuinely active, the view summary reads `… matched · virtualized`, and the stored size is preserved for the paged layouts.
- Documented that the stable script and this concept must not be enabled on the same thread: both register a launcher, a document-level keyboard handler and a scroll lock, and no runtime coordination exists between them.
- Updated a stale comment that still described the file as v0.9.7, and corrected the Appearance copy that claimed Flow and Timeline always render only what is visible.

## 0.11.0 (timeline fork — unreleased)

Ideas ported from the FreeInternet-Media downloader, adapted to this script's resolver grading and byte validation.

- **Fixed download history being erased by a second tab.** Each tab held the whole history map in memory and wrote it back whole, so a tab opened before another tab's downloads would silently overwrite them on its next write. Every write now merges what is already on disk first, resolving per file: a verified record outranks a legacy marker, and otherwise the newer write wins. A `BroadcastChannel` keeps the other tab's SAVED badges and history counts current between writes, and clearing history in one tab clears it everywhere instead of being restored by the next write elsewhere. Importing a backup still replaces rather than merges. The aspect-ratio cache gets the same merge-before-write treatment, re-read on a 15-second timer since a lost ratio only costs one layout guess.
- **Added a confirmation before leaving the page mid-download.** Download jobs live only in this page's memory, so a reload discarded partial files and any ZIP not yet written, with no warning.
- **Added a Bunkr resolver.** Bunkr links are common in these threads and were being swallowed by the generic video-host entry, which has no resolver, so they could only ever open the host page. The chain is file page → numeric id → `dl.bunkr.cr/api/_001_v2` → `glb-apisign.cdn.cr/sign` → signed CDN URL, adapted from Bunkr Album Downloader by pinkman (MIT). Because Bunkr serves images and videos behind one link shape, its resolutions are exempt from the media-type check that would otherwise reject a JPEG arriving where the thread markup implied a video, and the saved filename now follows the verified bytes rather than the guess. Album (`/a/`) links still fall back to opening the host page.
- **Added media URL export.** More → Export media list copies the URLs, or saves them as `.txt` (with `#` comments both gallery-dl and yt-dlp accept) or `.json` with per-item host, author, page, reply and download state. Exports the selection when there is one, otherwise everything matching the current filters. Confirmed resolutions export the actual file; anything else exports the host page, which is what an external downloader wants.
- **Added rebindable keyboard shortcuts.** Settings → Keyboard shortcuts records a chord for opening the gallery, focusing search, cycling layout and selecting the view. The gallery-wide chord must carry a modifier. Conflicts are refused at recording time, and a stored binding that takes another action's default leaves that action unbound rather than double-bound. The viewer's own single-key controls remain fixed.
- **Added an ignore list.** Settings → Ignore list drops media whose URL contains any listed fragment before it is indexed, so signature images and avatar CDNs cost no card, no ratio-cache entry and no memory. Editing the list also drops anything already indexed that matches.
- **Added a settings search.** The settings sheet filters its cards as you type.

## 0.10.0 (timeline fork — unreleased)

Forked from 0.9.7.1. Separate script identity so both can be installed at once:
new `@name`, `@namespace`, `APP_ID`, all three storage keys, and all eight global element
ids prefixed `scg-tl-`. Download history starts empty and is never shared with the
stable script.

## 0.9.7.1

Patch release on `main` following the 0.9.7 promotion.

- Fixed reply-level selection ignoring the active search, author, and host filters: selecting a reply now covers exactly the items those filters leave on screen, so the "downloadable selected" counter matches the visible cards. Media-type (All/Images/Videos) behaviour is unchanged.
- Gave "Reset everything" the same active-download guard as "Clear history": it now refuses while a download is running instead of wiping history mid-transfer, and it clears queue rows and progress through the same path rather than leaving stale entries behind.
- Consolidated the view-filter rule into a single shared predicate used by both the gallery view and reply selection, so the two can no longer drift apart.

## 0.9.7

Completed on `feature/v0.9.7` and promoted to `main`.

- Reduced repeated gallery compositing work by removing blur from repeated badges and selection controls, simplifying card shadows, and adding safe paint/style containment.
- Cached filtered and sorted results, kept the card-size slider CSS-variable based, and isolated download progress from full gallery rendering.
- Throttled visible download progress to about 250 ms and updates keyed queue rows without rebuilding the entire queue.
- Added a 50-page full-thread warning threshold, a persisted opt-out and re-enable setting, a custom RAM warning dialog, detailed scan status, failed-page accounting, and abortable HTML-only requests.
- Added session-only reply collapse controls with Collapse All and Expand All.
- Added reply-level downloadable-media selection with checked, unchecked, and native indeterminate states across collapsed groups and result-page chunks.
- Made reply-level selection respect the active All, Images, or Videos view, so selecting a reply from Images no longer includes its videos.
- Kept selection and active-download dock states usable together, including cancellation after selection mode is closed.
- Removed the dock's fragile compact/collapse state and replaced it with a taller, more translucent glass dock plus a matching frosted instrument plate and control wells, with tighter dock corners.
- Repaired the viewer loading indicator, added an intentional static reduced-motion state, and made the translucent top controls and filmstrip reliably auto-hide after inactivity without hiding focused controls.
- Expanded the Per view selector with 200, 300, and 500-item options and made the larger values persist through settings import and storage.
- Gave the download queue a restrained frosted-glass surface with a strong tint, kept more opaque than the dock for filename and progress readability.
- Repaired corrupted separators, dimensions, ellipses, and keyboard-help glyphs, and strengthened the full-thread action's red danger treatment.
- Fixed long scan-warning tooltip wrapping and made the download-queue Close action dismiss reliably while returning focus to its trigger.
- Made Clear history remove persisted SAVED/LEGACY markers and completed queue rows, while guarding against active-download races.
- Restricted every selection path to resolvable media, so Select All and reply selection skip items whose media failed to resolve rather than queueing downloads that cannot succeed.
- Capped the download queue display at the most recent 40 jobs to keep the popover responsive during large batches; older completed rows drop off the list.
- Shortened the userscript `@name` from `SimpCity Thread Gallery — Hybrid UI Fork` to `SimpCity Thread Gallery`. `@namespace` is unchanged, but Tampermonkey may offer 0.9.7 as a separate script to anyone running 0.9.6 or earlier; remove the old entry after updating.
- Added automated regression coverage for the new performance, scan-warning, collapse, selection, and dock behavior.

## 0.9.6 - Gallery Preview

Development baseline on `develop`; not a stable release and not tagged.

- Redesigned the interface around the gallery media canvas, floating control plate, and adaptive bottom dock.
- Added Darkroom, Daylight, Indigo, and Graphite themes.
- Added masonry, uniform-grid, and feed layouts plus a 70–160% media-size control for masonry and grid.
- Preserved the v0.9.5 scanning, resolver, validation, ZIP, storage, history, and diagnostic systems.
- Preserved desktop and phone layouts and keyboard accessibility.

Known preview concern: the visual redesign can feel slower than v0.9.5. Blur, transparency, shadows, broad transitions, full rerenders, and frequent download-queue rebuilding are candidates for later profiling.

## 0.9.5 - Stable GreasyFork baseline

- Stable public baseline for desktop and phone.
- Includes page and full-thread scanning, media resolution, byte-signature download validation, lightbox browsing, filters, reply grouping, selection, multipart ZIP creation, CRC32, content deduplication, verified history, local settings, diagnostics, and responsive themes.
- Fixes accumulated before this baseline include quoted-media attribution, unsafe URL handling, false successful downloads, duplicate archive filenames, ZIP cancellation, selection clearing, progress visibility, lightbox behavior, and phone support.

## Earlier recorded versions

The available project notes record these releases, but do not provide enough reliable per-release detail for separate feature claims:

- 0.9.4
- 0.9.3
- 0.9.2
- 0.8.3
- 0.8.2
- 0.8.1
- 0.8.0
- 0.7.3
- 0.7.2
- 0.7.1
- 0.6.0
