# SimpCity Thread Gallery

SimpCity Thread Gallery is a self-contained Tampermonkey userscript that turns a long SimpCity thread into a compact media browser. It indexes images, videos, embeds, links, text, and reply details without sending your browsing activity anywhere.

The target is `https://simpcity.cr/threads/*`. The forum and the material shown by the gallery may be adults-only.

## What it does

- Scans the current page, a chosen page, or an entire thread.
- Keeps author, page, reply, post, caption, source, and host provenance.
- Shows masonry, uniform-grid, and feed layouts with search and filters.
- Collapses individual reply groups or all groups in the current filtered results.
- Opens images and supported videos in a keyboard-friendly lightbox.
- Resolves original images and direct video files where a host exposes them.
- Selects downloadable media for validated, cancellable ZIP downloads.
- Selects all downloadable media in a reply with checked and indeterminate group state.
- Splits large archives, records CRC32 values, merges byte-identical files, and can add `manifest.csv`.
- Stores preferences and verified download history locally.
- Supports desktop browsers and phone layouts.

## Install with Tampermonkey

1. Install Tampermonkey in your browser.
2. Open `SimpCity-Thread-Gallery.user.js` from a trusted checkout or a future GitHub Release.
3. Copy its contents into a new Tampermonkey script and save it.
4. Visit a SimpCity thread and use **Open Gallery** at the bottom-left.

Do not install renamed copies side by side. The canonical filename is [SimpCity-Thread-Gallery.user.js](SimpCity-Thread-Gallery.user.js), and its existing `@name` and `@namespace` are kept for update compatibility.

## Install from GreasyFork

Because the script targets an adult-content forum, the GreasyFork network serves its listing through SleazyFork:

[Install the stable SimpCity Thread Gallery release](https://sleazyfork.org/en/scripts/591943-simpcity-thread-gallery-hybrid-ui-fork)

Choose **Install this script** and approve it in Tampermonkey. The public listing tracks the published stable release; release-candidate work stays on a feature branch until it is reviewed and approved.

## Media support

The gallery understands direct images and videos, XenForo attachments, and selected host-specific pages or embeds. Current host handling includes Goonbox, Pixhost, Imgbox, SimpCity image CDNs, Turbo, YouTube, Vimeo, Streamable, Redgifs, Dood-style hosts, and a small registry of generic video hosts.

A preview may use a thumbnail or heuristic URL. Downloads have a stricter rule: the response bytes must match a supported image or video signature before the item is recorded as saved. When a video host does not expose a direct file, the gallery may open the host page for manual viewing instead.

## Full-thread scans and RAM

Scanning fetches thread HTML without intentionally preloading media bytes. Even so, a very large thread can use substantial RAM because its reply metadata and extracted items remain in memory. By default, threads with 50 or more detected pages show a custom warning before the scan begins. You can disable that warning in the dialog and enable it again in Settings. Start with **This page** on older phones or memory-constrained machines, and cancel a full scan if the browser becomes sluggish.

## Privacy

There is no telemetry, analytics, webhook, remote database, or external media storage. Settings and download history stay in userscript storage unless you explicitly export them. The script only requests thread pages, media URLs found in those replies, and known resolver endpoints needed for display or download.

When filing a bug, remove thread titles, usernames, post URLs, media URLs, and adult-content thumbnails from screenshots or logs.

## Phone support

The controls, gallery layouts, selection dock, settings, and viewer have responsive phone styles and coarse-pointer targets. Full-thread scanning and large ZIP queues are still more demanding on a phone, so smaller page scans and ZIP parts are safer.

## Reporting issues

Use the GitHub bug or feature template once the public repository is connected. For bugs, include the userscript version, browser, userscript-manager version, operating system, device type, scan type, approximate thread size, and sanitized console errors. Never attach real adult media or private links.

## Development and releases

- `main` contains the v0.9.6 Darkroom baseline.
- `develop` is available for ongoing development from that baseline.
- `feature/v0.9.7` contains the unmerged v0.9.7 release candidate.
- Stable snapshots use annotated Git tags such as `v0.9.5`.
- GitHub Releases will provide downloadable historical versions; version-numbered JS/TXT copies are not active source files.

The project has no bundler, framework, runtime dependency, external font, or runtime image asset. Run checks with:

```powershell
node --check SimpCity-Thread-Gallery.user.js
node --test tests/core.test.cjs
```

## Screenshots

Screenshot placeholders for the public repository:

- Darkroom gallery on desktop
- Media viewer and details rail
- Selection and ZIP progress dock
- Phone layout

Screenshots must use synthetic or fully sanitized content.

## License

MIT. See [LICENSE](LICENSE).
