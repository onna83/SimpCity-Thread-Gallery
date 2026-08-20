# Changelog

This file records only history supported by the available source snapshots and project notes. Earlier releases did not have complete per-version release notes, so they are not reconstructed from guesswork.

## 0.9.7 - Release candidate

Development release candidate on `feature/v0.9.7`; not yet merged, tagged, or published.

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
