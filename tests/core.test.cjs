'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const userscriptPath = path.join(root, 'SimpCity-Thread-Gallery.user.js');
const source = fs.readFileSync(userscriptPath, 'utf8');

function metadataValue(key) {
  return source.match(new RegExp(`^// @${key}\\s+(.+)$`, 'm'))?.[1].trim() || '';
}

function evaluateSlice(startMarker, endMarker, names, context = {}) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  const code = `${source.slice(start, end)}\n;globalThis.__tested = { ${names.join(', ')} };`;
  const sandbox = { URL, ...context };
  vm.runInNewContext(code, sandbox);
  return sandbox.__tested;
}

test('canonical metadata preserves the installed script identity', () => {
  assert.equal(metadataValue('name'), 'SimpCity Thread Gallery — Hybrid UI Fork');
  assert.equal(metadataValue('namespace'), 'local.simpcity.gallery.hybrid');
  assert.equal(metadataValue('version'), '0.9.7');
  assert.match(source, /const APP_VERSION = '0\.9\.7'/);
  assert.equal(metadataValue('license'), 'MIT');
  assert.equal(metadataValue('match'), 'https://simpcity.cr/threads/*');
  assert.equal(metadataValue('run-at'), 'document-idle');

  for (const grant of ['GM_xmlhttpRequest', 'GM_getValue', 'GM_setValue', 'GM_deleteValue']) {
    assert.match(source, new RegExp(`^// @grant\\s+${grant}$`, 'm'));
  }
});

test('storage keys remain compatible with installed versions', () => {
  assert.match(source, /sc-thread-gallery-settings-v1/);
  assert.match(source, /sc-thread-gallery-download-history-v1/);
  assert.match(source, /sc-thread-gallery-storage-migrated-v072/);
  assert.match(source, /const APP_ID = 'sc-thread-gallery'/);
});

test('URL normalization accepts only HTTP and HTTPS', () => {
  const { absoluteUrl } = evaluateSlice(
    'const absoluteUrl =',
    'const threadBaseUrl =',
    ['absoluteUrl'],
    { location: { href: 'https://simpcity.cr/threads/example.1' } },
  );

  assert.equal(absoluteUrl('/attachments/example.jpg'), 'https://simpcity.cr/attachments/example.jpg');
  assert.equal(absoluteUrl('http://example.test/video.mp4'), 'http://example.test/video.mp4');
  assert.equal(absoluteUrl('javascript:alert(1)'), '');
  assert.equal(absoluteUrl('data:text/plain,nope'), '');
  assert.equal(absoluteUrl('ftp://example.test/file'), '');
});

test('media signature sniffer recognizes supported image and video bytes', () => {
  const { sniffMediaSignature } = evaluateSlice(
    'function bytesMatch',
    'async function validateMediaBlob',
    ['sniffMediaSignature'],
  );

  assert.equal(sniffMediaSignature(Uint8Array.from([0xff, 0xd8, 0xff])).extension, 'jpg');
  assert.equal(sniffMediaSignature(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).extension, 'png');
  assert.equal(sniffMediaSignature(Uint8Array.from(Buffer.from('GIF89a'))).extension, 'gif');
  assert.equal(sniffMediaSignature(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3])).extension, 'webm');
  assert.equal(sniffMediaSignature(Uint8Array.from([0, 0, 0, 0, ...Buffer.from('ftypisom')])).extension, 'mp4');
  assert.equal(sniffMediaSignature(Uint8Array.from(Buffer.from('<html>'))), null);
});

test('CRC32 matches the standard check value', () => {
  const { crc32Bytes } = evaluateSlice(
    'const CRC32_TABLE =',
    'async function crc32Blob',
    ['crc32Bytes'],
  );
  const result = crc32Bytes(Uint8Array.from(Buffer.from('123456789')));
  assert.equal(result.toString(16).padStart(8, '0'), 'cbf43926');
});

test('source retains provenance, memory, download, and ZIP safeguards', () => {
  assert.match(source, /\.bbCodeBlock--quote, blockquote\.bbCodeBlock, \[data-quote\]/);
  assert.match(source, /preload="none"/);
  assert.match(source, /releaseRenderedMedia/);
  assert.match(source, /response contains \$\{signature\.mediaType\}/);
  assert.match(source, /if \(!validation\?\.verified\) return false/);
  assert.match(source, /0x04034b50/);
  assert.match(source, /0x02014b50/);
  assert.match(source, /0x06054b50/);
  assert.match(source, /ZIP creation canceled/);
});

test('Darkroom UI and media-size controls remain available', () => {
  assert.match(source, /data-ui', 'darkroom'/);
  assert.match(source, /Object\.freeze\(\['masonry', 'grid', 'feed'\]\)/);
  assert.match(source, /const THEME_MODES = Object\.freeze\(\['dark', 'light', 'midnight', 'graphite'\]\)/);
  assert.match(source, /min="70" max="160" step="5"/);
});

test('download progress stays isolated from full gallery rendering', () => {
  const scheduleStart = source.indexOf('function scheduleDownloadUi()');
  const scheduleEnd = source.indexOf('function updateDownloadedIndicators', scheduleStart);
  const updateStart = source.indexOf('function downloadJobDetail');
  const updateEnd = source.indexOf('function fetchMediaBlob', updateStart);
  assert.notEqual(scheduleStart, -1);
  assert.notEqual(scheduleEnd, -1);
  assert.notEqual(updateStart, -1);
  assert.notEqual(updateEnd, -1);
  const progressSource = source.slice(scheduleStart, scheduleEnd) + source.slice(updateStart, updateEnd);

  assert.match(progressSource, /}, 250\);/);
  assert.match(progressSource, /updateDownloadJobRow/);
  assert.match(progressSource, /data-job-id/);
  assert.doesNotMatch(progressSource, /\bvisibleItems\s*\(/);
  assert.doesNotMatch(progressSource, /\brender\s*\(/);
  assert.doesNotMatch(progressSource, /\.innerHTML\s*=\s*jobs/);
});

test('visible results use an invalidated cache', () => {
  assert.match(source, /let visibleItemsCache = \{ signature: '', items: \[\] \}/);
  assert.match(source, /if \(visibleItemsCache\.signature === signature\) return visibleItemsCache\.items/);
  assert.match(source, /invalidateVisibleItems\(\{ dataset: true, selection: true \}\)/);
});

test('large-thread warning preference is persisted through existing settings storage', () => {
  let stored;
  const { persistSettings } = evaluateSlice(
    'function persistSettings()',
    'function refreshThreadHeader',
    ['persistSettings'],
    {
      state: { warnLargeThreadScan: false },
      storage: { set: (key, value) => { stored = { key, value }; } },
      SETTINGS_KEY: 'settings-key',
    },
  );

  persistSettings();
  assert.equal(stored.key, 'settings-key');
  assert.equal(stored.value.warnLargeThreadScan, false);
  assert.match(source, /warnLargeThreadScan: savedSettings\.warnLargeThreadScan !== false/);
  assert.match(source, /data-setting-warn-large-scan/);
});

test('full-thread scanning uses a custom warning and cancellable HTML-only requests', () => {
  const start = source.indexOf('async function scanThread()');
  const end = source.indexOf('function scanCurrentPage()', start);
  const scanSource = source.slice(start, end);

  assert.match(source, /const LARGE_THREAD_WARNING_PAGES = 50/);
  assert.match(source, /function confirmLargeThreadScan/);
  assert.match(source, /data-confirm-preference/);
  assert.match(scanSource, /detectedPages >= LARGE_THREAD_WARNING_PAGES/);
  assert.match(scanSource, /signal: controller\.signal/);
  assert.match(scanSource, /response\.text\(\)/);
  assert.match(scanSource, /new DOMParser\(\)\.parseFromString\(html, 'text\/html'\)/);
  assert.match(scanSource, /state\.scanFailedPages\+\+/);
  assert.match(scanSource, /state\.scanController\?\.abort\(\)/);
  assert.doesNotMatch(scanSource, /resolveForDisplay|fetchMediaBlob|iframeHtml/);
});

test('collapsed reply state toggles by stable reply key', () => {
  const state = { collapsedReplies: new Set() };
  const { replyKey, setReplyCollapsed } = evaluateSlice(
    'function replyKey',
    'function buildViewPages',
    ['replyKey', 'setReplyCollapsed'],
    { state },
  );
  const item = { pageNumber: 3, postId: 'post-42', postIndex: 9 };
  const key = replyKey(item);

  assert.equal(key, '3|post-42');
  assert.equal(setReplyCollapsed(key, true), true);
  assert.equal(state.collapsedReplies.has(key), true);
  assert.equal(setReplyCollapsed(key, true), false);
  assert.equal(setReplyCollapsed(key, false), true);
  assert.equal(state.collapsedReplies.has(key), false);
});

test('Collapse All and Expand All affect every reply in the filtered result set', () => {
  const state = { collapsedReplies: new Set() };
  const { setReplyGroupsCollapsed } = evaluateSlice(
    'function replyKey',
    'function buildViewPages',
    ['setReplyGroupsCollapsed'],
    { state },
  );
  const items = [
    { pageNumber: 1, postId: 'a' },
    { pageNumber: 1, postId: 'a' },
    { pageNumber: 2, postId: 'b' },
  ];

  assert.equal(setReplyGroupsCollapsed(items, true), true);
  assert.deepEqual([...state.collapsedReplies].sort(), ['1|a', '2|b']);
  assert.equal(setReplyGroupsCollapsed(items, false), true);
  assert.deepEqual([...state.collapsedReplies], []);
});

test('collapsed groups omit cards, expose aria-expanded, and reset with the dataset', () => {
  const groupsStart = source.indexOf('function replyGroupsMarkup');
  const groupsEnd = source.indexOf('function updateViewPager', groupsStart);
  const groupsSource = source.slice(groupsStart, groupsEnd);
  const resetStart = source.indexOf('function resetDatasetState');
  const resetEnd = source.indexOf('function updateScanStatus', resetStart);
  const resetSource = source.slice(resetStart, resetEnd);

  assert.match(groupsSource, /aria-expanded="\$\{String\(!collapsed\)\}"/);
  assert.match(groupsSource, /collapsed \? '' : group\.entries\.map/);
  assert.match(groupsSource, /iconWell\('chevron'\)/);
  assert.match(resetSource, /state\.collapsedReplies\.clear\(\)/);
  assert.doesNotMatch(source.slice(source.indexOf('function persistSettings'), source.indexOf('function refreshThreadHeader')), /collapsedReplies/);
});

test('reply-level selection derives checked and indeterminate state from the data model', () => {
  let invalidations = 0;
  const state = {
    items: [
      { reply: 'one', selectionKey: 'image-1', downloadable: true },
      { reply: 'one', selectionKey: 'video-1', downloadable: true },
      { reply: 'one', selectionKey: 'text-1', downloadable: false },
      { reply: 'two', selectionKey: 'image-2', downloadable: true },
    ],
    selected: new Set(),
  };
  const { replySelectionState, setReplySelected } = evaluateSlice(
    'function matchesActiveSelectionType',
    'function buildViewPages',
    ['replySelectionState', 'setReplySelected'],
    {
      state,
      replyKey: item => item.reply,
      isDownloadableMedia: item => item.downloadable,
      invalidateVisibleItems: () => { invalidations++; },
    },
  );

  assert.deepEqual(
    JSON.parse(JSON.stringify(replySelectionState('one'), (key, value) => key === 'eligible' ? undefined : value)),
    { total: 2, selected: 0, checked: false, indeterminate: false },
  );
  assert.equal(setReplySelected('one', true), true);
  assert.deepEqual([...state.selected].sort(), ['image-1', 'video-1']);
  assert.equal(replySelectionState('one').checked, true);

  state.selected.delete('video-1');
  const partial = replySelectionState('one');
  assert.equal(partial.checked, false);
  assert.equal(partial.indeterminate, true);
  assert.equal(partial.selected, 1);

  assert.equal(setReplySelected('one', false), true);
  assert.equal(replySelectionState('one').selected, 0);
  assert.equal(invalidations, 2);
});

test('reply-level selection respects the active media type view', () => {
  const state = {
    filter: 'image',
    items: [
      { reply: 'one', selectionKey: 'image-1', type: 'image', downloadable: true },
      { reply: 'one', selectionKey: 'video-1', type: 'video', downloadable: true },
      { reply: 'one', selectionKey: 'embed-1', type: 'embed', downloadable: true },
      { reply: 'one', selectionKey: 'link-1', type: 'link', downloadable: false },
    ],
    selected: new Set(),
  };
  const { setReplySelected, replySelectionState } = evaluateSlice(
    'function matchesActiveSelectionType',
    'function buildViewPages',
    ['setReplySelected', 'replySelectionState'],
    {
      state,
      replyKey: item => item.reply,
      isDownloadableMedia: item => item.downloadable,
      invalidateVisibleItems: () => {},
    },
  );

  setReplySelected('one', true);
  assert.deepEqual([...state.selected], ['image-1']);
  assert.equal(replySelectionState('one').total, 1);

  state.selected.clear();
  state.filter = 'video';
  setReplySelected('one', true);
  assert.deepEqual([...state.selected].sort(), ['embed-1', 'video-1']);
  assert.equal(replySelectionState('one').total, 2);

  state.selected.clear();
  state.filter = 'all';
  setReplySelected('one', true);
  assert.deepEqual([...state.selected].sort(), ['embed-1', 'image-1', 'video-1']);
  assert.equal(replySelectionState('one').total, 3);
});

test('reply selection works while collapsed and spans all indexed reply items', () => {
  const state = {
    items: Array.from({ length: 75 }, (_, index) => ({
      reply: 'large-reply',
      selectionKey: `media-${index}`,
      downloadable: true,
    })),
    selected: new Set(),
    collapsedReplies: new Set(['large-reply']),
  };
  const { setReplySelected, replySelectionState } = evaluateSlice(
    'function matchesActiveSelectionType',
    'function buildViewPages',
    ['setReplySelected', 'replySelectionState'],
    {
      state,
      replyKey: item => item.reply,
      isDownloadableMedia: item => item.downloadable,
      invalidateVisibleItems: () => {},
    },
  );

  setReplySelected('large-reply', true);
  assert.equal(state.selected.size, 75);
  assert.equal(replySelectionState('large-reply').checked, true);
  assert.equal(state.collapsedReplies.has('large-reply'), true);
});

test('exit selection clears every selection without canceling an active download', () => {
  const state = {
    selectionMode: true,
    selectedOnly: true,
    selected: new Set(['a', 'b', 'c']),
    downloading: true,
    cancelDownload: false,
  };
  const { exitSelectionMode } = evaluateSlice(
    'function clearSelection',
    'function toggleSelected',
    ['exitSelectionMode'],
    { state, invalidateVisibleItems: () => {} },
  );

  exitSelectionMode();
  assert.equal(state.selectionMode, false);
  assert.equal(state.selectedOnly, false);
  assert.equal(state.selected.size, 0);
  assert.equal(state.downloading, true);
  assert.equal(state.cancelDownload, false);
});

test('clearing download history removes persisted markers and completed queue rows', () => {
  const state = {
    downloading: false,
    downloadHistory: { saved: { verified: true } },
    downloadJobs: [{ id: 1, status: 'saved' }],
    downloadProgress: { total: 1 },
  };
  const removed = [];
  const dirtyJobs = new Set([1]);
  let indicatorUpdates = 0;
  let queueUpdates = 0;
  let settingsUpdates = 0;
  const { clearDownloadHistory } = evaluateSlice(
    'function clearDownloadHistory',
    'function clearDiagnostics',
    ['clearDownloadHistory'],
    {
      state,
      DOWNLOAD_HISTORY_KEY: 'history-key',
      storage: { remove: key => removed.push(key) },
      blankDownloadProgress: () => ({ total: 0 }),
      scheduleDownloadUi: { dirtyJobs },
      updateDownloadedIndicators: () => { indicatorUpdates++; },
      updateDownloadUi: () => { queueUpdates++; },
      refreshSettingsPanel: () => { settingsUpdates++; },
    },
  );

  assert.equal(clearDownloadHistory(), true);
  assert.equal(Object.keys(state.downloadHistory).length, 0);
  assert.equal(state.downloadJobs.length, 0);
  assert.equal(state.downloadProgress.total, 0);
  assert.deepEqual(removed, ['history-key']);
  assert.equal(dirtyJobs.size, 0);
  assert.equal(indicatorUpdates, 1);
  assert.equal(queueUpdates, 1);
  assert.equal(settingsUpdates, 1);

  state.downloading = true;
  state.downloadHistory = { active: { verified: true } };
  state.downloadJobs = [{ id: 2, status: 'downloading' }];
  assert.equal(clearDownloadHistory(), false);
  assert.equal(Object.keys(state.downloadHistory).length, 1);
  assert.equal(state.downloadJobs.length, 1);
  assert.deepEqual(removed, ['history-key']);
});

test('reply checkbox exposes native indeterminate state after rendering', () => {
  assert.match(source, /input\.indeterminate = replySelection\.indeterminate/);
  assert.match(source, /aria-checked.*'mixed'/);
  assert.match(source, /data-reply-select/);
  assert.match(source, /data-reply-selection-count/);
  assert.match(source, /iconWell\('select'\)/);
  assert.match(source, /selectedMatch = !state\.selectedOnly \|\| \(isDownloadableMedia\(item\) && state\.selected\.has\(item\.selectionKey\)\)/);
});

test('dock preserves active queue status and cancellation across selection states', () => {
  assert.match(source, /\.selecting\.has-downloads \.scg-progress/);
  assert.match(source, /\.selecting\.downloading \.scg-progress/);
  assert.match(source, /\.downloading \.scg-bulk-actions\{display:flex\}/);
  assert.match(source, /classList\.toggle\('cancel-download', state\.downloading\)/);
  assert.match(source, /state\.downloading \? 'Cancel ZIP queue'/);
});

test('plate and dock are persistent translucent glass surfaces without a dock collapse mode', () => {
  assert.doesNotMatch(source, /activityCollapsed|activity-collapsed|activity-toggle|setting-activity-collapsed/);
  assert.match(source, /\.scg-plate\{[\s\S]*?color-mix\(in srgb,var\(--scg-surface\) 60%,transparent\)/);
  assert.match(source, /backdrop-filter:blur\(26px\) saturate\(160%\)/);
  assert.match(source, /\.scg-plate:before\{/);
  assert.match(source, /\.scg-activitybar\{[\s\S]*?min-height:64px/);
  assert.match(source, /color-mix\(in srgb,var\(--scg-surface\) 52%,transparent\)/);
  assert.match(source, /backdrop-filter:blur\(34px\) saturate\(180%\)/);
  assert.match(source, /-webkit-backdrop-filter:blur\(34px\) saturate\(180%\)/);
  assert.match(source, /\.scg-activitybar:before\{/);
  assert.match(source, /\.scg-activitybar\{[\s\S]*?border-radius:18px/);
  assert.match(source, /min-height:68px;bottom:8px;gap:8px;padding:9px 10px;border-radius:16px/);
});

test('interface polish retains responsive, native, and launcher safeguards', () => {
  assert.match(source, /#\$\{APP_ID\} select option\{background:var\(--scg-surface\);color:var\(--scg-text\)\}/);
  assert.match(source, /@media\(max-height:620px\)/);
  assert.match(source, /\.scg-download-jobs\{max-height:30vh\}/);
  assert.match(source, /#scg-launch\{[\s\S]*?min-height:66px/);
  assert.match(source, /\.scg-lightbox \[data-tooltip\]:after\{max-width:170px\}/);
});

test('viewer loader and translucent chrome have resilient motion states', () => {
  assert.match(source, /\.scg-viewer-loading i\{[\s\S]*?display:block;[\s\S]*?animation:scg-viewer-spin/);
  assert.match(source, /scg-viewer-loading i,[\s\S]*?viewer-buffering:before\{[\s\S]*?animation:none !important;border-color:var\(--scg-accent\)/);
  assert.match(source, /\.scg-viewer-topbar\{[\s\S]*?var\(--scg-surface\) 62%,transparent/);
  assert.match(source, /\.scg-viewer-footer\{[\s\S]*?var\(--scg-surface\) 62%,transparent/);
  assert.match(source, /\.scg-lightbox\.viewer-idle \.scg-viewer-topbar/);
  assert.match(source, /\.scg-lightbox\.viewer-idle \.scg-viewer-footer/);
  assert.doesNotMatch(source, /viewer-idle\.details-hidden \.scg-viewer-(?:topbar|footer)/);
  assert.match(source, /viewerChromeEngaged\(box\)/);
  assert.match(source, /active\.matches\(':focus-visible'\)/);
  assert.match(source, /box\.onfocusin = wakeViewerChrome/);
  assert.match(source, /class="scg-lightbox"[^>]*tabindex="-1"/);
  assert.match(source, /if \(!wasOpen\) box\.focus\(\{ preventScroll: true \}\)/);
});

test('per-view pagination supports larger galleries through 500 items', () => {
  assert.match(source, /VIEW_PAGE_SIZES = Object\.freeze\(\[40, 60, 100, 200, 300, 500\]\)/);
  assert.match(source, /VIEW_PAGE_SIZES\.includes\(Number\(savedSettings\.perPage\)\)/);
  assert.match(source, /VIEW_PAGE_SIZES\.includes\(Number\(input\.perPage\)\)/);
  assert.match(source, /VIEW_PAGE_SIZES\.map\(size => `<option value="\$\{size\}">\$\{size\}<\/option>`\)\.join\(''\)/);
});

test('display labels are free of known mojibake sequences', () => {
  assert.doesNotMatch(source, /Ã|Â|â|�/);
  assert.match(source, /Darkroom · v\$\{APP_VERSION\}/);
  assert.match(source, /normalized\.width\.toLocaleString\(\)\} × /);
  assert.match(source, /scg-scan-thread-danger\{[\s\S]*?background:#8f2034/);
});

test('long tooltips wrap and the download queue Close action can dismiss the popover', () => {
  assert.match(source, /white-space:normal;overflow-wrap:anywhere;pointer-events:none/);
  assert.match(source, /scg-scan-thread-danger scg-tip-end/);
  assert.doesNotMatch(source, /\.scg-progress:focus-within \.scg-download-popover/);
  assert.match(source, /\[data-action="download-details"\]\'\)\?\.focus\(\{ preventScroll: true \}\)/);
});
