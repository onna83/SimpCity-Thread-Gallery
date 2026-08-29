# SimpCity Thread Gallery Timeline

> **This branch is a fork.** It carries the timeline redesign and has its own script
> identity, so it installs alongside the stable script rather than replacing it.
> The stable release lives on `main` at v0.9.7.1 and does not receive this work.

SimpCity Thread Gallery Timeline is a self-contained Tampermonkey userscript that turns a long SimpCity thread into a compact media browser. It indexes images, videos, embeds, links, text, and reply details without sending your browsing activity anywhere.

The target is `https://simpcity.cr/threads/*`. The forum and the material shown by the gallery may be adults-only.

## What it does

- Scans the current page, a chosen page, a page range, an entire thread, or only pages added since the last successful scan.
- Keeps author, date, page, reply, post, caption, source, and host provenance.
- Shows masonry and uniform-grid layouts with search, download-state and resolution filtering, plus date and resolution sorting. Masonry renders only what is on screen.
- Collapses individual reply groups or all groups in the current filtered results.
- Opens images and supported videos in a keyboard-friendly lightbox.
- Resolves original images and direct video files where a host exposes them, including Bunkr's signed CDN URLs and Pixeldrain single-file links.
- Recognizes Bunkr albums, Pixeldrain lists, and Gofile folders as folder cards. Their contents are fetched only when you press **Expand**; an unopened folder is never treated as selected media.
- Optionally fetches embed posters lazily through the bounded media scheduler.
- Selects downloadable media for validated, cancellable ZIP downloads.
- Retries failed and verification-needed queue items without rebuilding the selection.
- Selects all downloadable media in a reply or everything matching the active filters, supports drag marquee selection, and remembers selections per thread.
- Splits large archives, records CRC32 values, merges byte-identical files, and can add `manifest.csv`.
- Exports the current view's media URLs as `.txt` or `.json`, plus stable extractor/id pairs for yt-dlp `--download-archive`.
- Offers an instant blur/safe-mode toggle and optional completion notifications for scans and ZIP queues.
- Ignores media whose URL matches a fragment you list, before it is ever indexed.
- Rebinds the gallery-wide keyboard shortcuts.
- Stores preferences, scan progress, per-thread selections, verified download history, and a bounded per-thread item index locally.
- Supports desktop browsers and phone layouts.

## Install with Tampermonkey

1. Install Tampermonkey in your browser.
2. Open `SimpCity-Thread-Gallery-Timeline.user.js` from a trusted checkout or a future GitHub Release.
3. Copy its contents into a new Tampermonkey script and save it.
4. Visit a SimpCity thread and use **Open Gallery** at the bottom-left.

The fork's filename is [SimpCity-Thread-Gallery-Timeline.user.js](SimpCity-Thread-Gallery-Timeline.user.js), distinct from the stable script's `SimpCity-Thread-Gallery.user.js` on `main`.

This fork uses a **separate script identity** throughout, which is what lets both versions be installed in Tampermonkey at once:

| | Stable (`main`) | Timeline (this branch) |
|---|---|---|
| `@name` | `SimpCity Thread Gallery` | `SimpCity Thread Gallery Timeline` |
| `@namespace` | `local.simpcity.gallery.hybrid` | `local.simpcity.gallery.timeline` |
| Version line | 0.9.7.x | 1.0.x |
| Settings + history | `sc-thread-gallery-*` | `sc-thread-gallery-timeline-*` |

Storage is deliberately **not** shared. The fork starts with an empty download history, so items you already downloaded show as un-downloaded here until it builds its own record.

> **Do not leave both scripts enabled on the same thread.** Separate identities let both be *installed* at once; they do not let both *run* on one page. Each registers its own launcher button, its own document-level keyboard handler, and its own body-scroll lock, so together you get two launchers, chords firing in both galleries, and a scroll lock that only half releases. There is no runtime coordination between them and none is planned for this concept. Keep one enabled at a time in Tampermonkey, or scope them to different `@match` domains.

## Install from GreasyFork

Because the script targets an adult-content forum, the GreasyFork network serves its listing through SleazyFork:

[Install the stable SimpCity Thread Gallery release](https://sleazyfork.org/en/scripts/591943)

That listing serves the **stable** script from `main`. The timeline fork is not published — install it by pasting this branch's [SimpCity-Thread-Gallery-Timeline.user.js](SimpCity-Thread-Gallery-Timeline.user.js) into Tampermonkey directly.

## Media support

The gallery understands direct images and videos, XenForo attachments, selected host-specific pages or embeds, and on-demand containers. Current host handling includes Goonbox, Pixhost, Imgbox, SimpCity image CDNs, Turbo, Bunkr files and albums, Pixeldrain files and lists, Gofile folders, YouTube, Vimeo, Streamable, Redgifs, Dood-style hosts, and a small registry of generic video hosts.

Expanded children use the file's own stable identity for deduplication, selections, and download history. The parent folder URL is retained as provenance and appears in `manifest.csv`. Unsupported file types remain ordinary link cards rather than entering the image/video ZIP queue.

Gofile's current API requires a bearer token. Expansion first tries a public read; if Gofile rejects it, the gallery asks for an account token. That token remains only in the current tab's memory and is never written to settings, the item index, exports, or download history.

A preview may use a thumbnail or heuristic URL. Downloads have a stricter rule: the response bytes must match a supported image or video signature before the item is recorded as saved. When a video host does not expose a direct file, the gallery may open the host page for manual viewing instead.

## Full-thread scans and RAM

Scanning fetches thread HTML without intentionally preloading media bytes. Even so, a very large thread can use substantial RAM because its reply metadata and extracted items remain in memory. By default, scans of 50 or more pages show a custom warning before they begin. You can disable that warning in the dialog and enable it again in Settings. Start with **This page** or a small range on older phones or memory-constrained machines, and cancel a full scan if the browser becomes sluggish. The **New pages** action remembers the highest successfully scanned page for that thread and appends only later pages.

The item index restores a recent thread without fetching every page again. Each thread is capped at about 420 KB and only the six most recent thread indexes are retained. Folder expansion results are prioritized; if the budget is reached, newer media is kept ahead of ordinary links and text. A changed extraction schema or ignore list invalidates the cache. Thread growth keeps the valid cached view and advertises the new pages so **New pages** can append them. A failed replacement scan restores the previous cached view instead of overwriting it with an empty result.

## Privacy

There is no telemetry, analytics, webhook, remote database, or external media storage. Settings, download history, selections, and item indexes stay in userscript storage unless you explicitly export settings or media lists. The script only requests thread pages, media URLs found in those replies, and known resolver or folder endpoints needed for display, expansion, or download.

When filing a bug, remove thread titles, usernames, post URLs, media URLs, and adult-content thumbnails from screenshots or logs.

## Phone support

The controls, gallery layouts, selection dock, settings, and viewer have responsive phone styles and coarse-pointer targets. Full-thread scanning and large ZIP queues are still more demanding on a phone, so smaller page scans and ZIP parts are safer.

## Reporting issues

Use the GitHub bug or feature template once the public repository is connected. For bugs, include the userscript version, browser, userscript-manager version, operating system, device type, scan type, approximate thread size, and sanitized console errors. Never attach real adult media or private links.

## Development and releases

- `main` contains the stable v0.9.7.1 release and is frozen with respect to this fork.
- `fork` (this branch) carries the UI/UX overhaul on its own version line.
- `develop` is the integration branch for ongoing development.
- Release work is completed on feature branches and promoted to `main` after checks pass.
- Stable snapshots use annotated Git tags such as `v0.9.5`.
- GitHub Releases will provide downloadable historical versions; version-numbered JS/TXT copies are not active source files.

The project has no bundler, framework, runtime dependency, external font, or runtime image asset. Run checks with:

```powershell
node --check SimpCity-Thread-Gallery-Timeline.user.js
node --test tests/core.test.cjs tests/boot.test.cjs
node tests/bench.cjs
```

## Screenshots

Screenshot placeholders for the public repository:

- Gallery on desktop
- Media viewer and details rail
- Selection and ZIP progress dock
- Phone layout

Screenshots must use synthetic or fully sanitized content.

## License

MIT. See [LICENSE](LICENSE).
