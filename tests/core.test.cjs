'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const userscriptPath = path.join(root, 'SimpCity-Thread-Gallery-Timeline.user.js');
const source = fs.readFileSync(userscriptPath, 'utf8');
const ACCENTS = ['blue', 'indigo', 'amber', 'green', 'rose', 'neutral'];

function metadataValue(key) {
  return source.match(new RegExp(`^// @${key}\\s+(.+)$`, 'm'))?.[1].trim() || '';
}

// vm sandboxes have their own Object.prototype, so deepStrictEqual rejects
// anything that crosses back out. A JSON round-trip re-homes it.
const plain = value => JSON.parse(JSON.stringify(value));

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

test('page loading refreshes cached media totals and facets after the loading render', async () => {
  const state = {
    items: [{ type: 'image', author: 'Previous', sourceHost: 'old.test' }],
    selected: new Set(), collapsedReplies: new Set(), expandedKeys: new Set(),
    activePlayers: new Set(), playbackPositions: new Map(), threadPageCount: 4,
  };
  const currentPage = [{ type: 'video', author: 'Current', sourceHost: 'current.test' }];
  let fetchedPage = [
    { type: 'image', author: 'New', sourceHost: 'new.test' },
    { type: 'image', author: 'New', sourceHost: 'new.test' },
    { type: 'video', author: 'New', sourceHost: 'new.test' },
    { type: 'embed', author: 'New', sourceHost: 'new.test' },
  ];
  let failRequest = false;
  let api;
  const renders = [];
  const slice = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  const sandbox = {
    state, URL, Set, document: currentPage,
    location: new URL('https://simpcity.cr/threads/example.1/page-2'),
    threadPageUrl: page => `https://simpcity.cr/threads/example.1/page-${page}`,
    pageNumberFromUrl: () => 2,
    fetch: async () => {
      if (failRequest) throw new Error('offline');
      return { ok: true, text: async () => '<page>' };
    },
    DOMParser: class { parseFromString() { return fetchedPage; } },
    extractFromDocument: doc => doc,
    dedupe: items => [...items],
    itemSourceHost: item => item.sourceHost,
    compareText: (a, b) => a.localeCompare(b),
    blankDownloadProgress: () => ({}),
    updateThreadPageInfo() {}, rememberScannedPage() {}, persistItemIndex() {},
    notify() {}, recordDiagnostic() {}, console: { error() {} },
    // The loading render must populate the real caches, just like the UI.
    render: () => renders.push({ counts: plain(api.counts()), authors: [...api.facetOptions().authors] }),
  };
  vm.runInNewContext([
    slice('let datasetRevision =', '// Aspect ratios drive layout'),
    slice('function replyKey(', 'function setReplyCollapsed'),
    slice('let countsCache =', '// Indexed items carry this'),
    slice('function facetOptions()', '// Counts move with every other facet'),
    slice('function resetDatasetState()', 'function updateScanStatus()'),
    slice('function scanCurrentPage()', "const style = document.createElement('style')"),
    'globalThis.__tested = { counts, facetOptions, scanCurrentPage, scanSpecificPage };',
  ].join('\n'), sandbox);
  api = sandbox.__tested;

  assert.equal(api.counts().image, 1);
  await api.scanSpecificPage(3);
  assert.deepEqual(renders[0], { counts: { all: 0, image: 0, video: 0, link: 0, text: 0, post: 0 }, authors: [] });
  assert.deepEqual(renders.at(-1), { counts: { all: 4, image: 2, video: 2, link: 0, text: 0, post: 1 }, authors: ['New'] });
  assert.deepEqual([...api.facetOptions().hosts], ['new.test']);

  // A second load can use the current DOM rather than fetching another page.
  await api.scanSpecificPage(2);
  assert.deepEqual(renders.at(-1), { counts: { all: 1, image: 0, video: 1, link: 0, text: 0, post: 1 }, authors: ['Current'] });

  failRequest = true;
  await api.scanSpecificPage(3);
  assert.equal(api.counts().video, 1, 'a failed request retains the previous page');
  assert.deepEqual([...api.facetOptions().authors], ['Current']);

  failRequest = false;
  fetchedPage = [];
  await api.scanSpecificPage(4);
  assert.equal(api.counts().all, 0, 'a genuinely empty page still reports zero');
  assert.deepEqual([...api.facetOptions().authors], []);

  api.scanCurrentPage();
  assert.equal(api.counts().video, 1, 'rescanning the current page refreshes the totals');
});

test('the stylesheet literal carries no stray template delimiters', () => {
  const opener = 'style.textContent = `';
  const start = source.indexOf(opener);
  assert.notEqual(start, -1);
  const end = source.indexOf('document.head.appendChild(style)', start);
  const body = source.slice(start + opener.length, source.lastIndexOf('`;', end));

  // A backtick anywhere in here silently ends the template and turns whatever
  // follows into a tagged-template call. That is valid syntax, so node --check
  // passes and the whole script dies on load with no launcher and no clue.
  assert.equal(body.includes('`'), false, 'a backtick inside the CSS literal ends it early');
  // And the one interpolation that has to survive still does.
  assert.ok(body.includes('#${APP_ID}'));
});

test('canonical metadata preserves the installed script identity', () => {
  assert.equal(metadataValue('name'), 'SimpCity Thread Gallery Timeline');
  assert.equal(metadataValue('namespace'), 'local.simpcity.gallery.timeline');
  assert.equal(metadataValue('version'), '1.1.0');
  assert.match(source, /const APP_VERSION = '1\.1\.0'/);
  assert.equal(metadataValue('license'), 'MIT');
  assert.equal(metadataValue('match'), 'https://simpcity.cr/threads/*');
  assert.equal(metadataValue('run-at'), 'document-idle');

  for (const grant of ['GM_xmlhttpRequest', 'GM_getValue', 'GM_setValue', 'GM_deleteValue']) {
    assert.match(source, new RegExp(`^// @grant\\s+${grant}$`, 'm'));
  }
});

test('storage keys remain compatible with installed versions', () => {
  assert.match(source, /sc-thread-gallery-timeline-settings-v1/);
  assert.match(source, /sc-thread-gallery-timeline-download-history-v1/);
  assert.match(source, /sc-thread-gallery-timeline-storage-migrated-v1/);
  assert.match(source, /const APP_ID = 'sc-thread-gallery-tl'/);
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

test('gallery UI and media-size controls remain available', () => {
  assert.match(source, /data-ui', 'gallery'/);
  assert.match(source, /Object\.freeze\(\['masonry', 'grid'\]\)/);
  assert.match(source, /const THEME_MODES = Object\.freeze\(\['dark', 'light'\]\)/);
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
  assert.match(source, /let visibleItemsCache = null/);
  assert.match(source, /cache\.dataset === datasetRevision/);
  assert.match(source, /cache\.selection === selectionRevision/);
  assert.match(source, /invalidateVisibleItems\(\{ dataset: true, selection: true \}\)/);
  // Pagination must not key the cache: visibleItems() returns the unpaginated set.
  assert.doesNotMatch(source, /cache\.perPage/);
  assert.doesNotMatch(source, /cache\.viewPage/);
  // Scanning mutates state.items in place and must invalidate as it goes.
  assert.match(source, /appendUniqueItems\(state\.items[\s\S]*?invalidateVisibleItems\(\{ dataset: true \}\)/);
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
  const start = source.indexOf('async function scanThread(requested = {})');
  const end = source.indexOf('function scanCurrentPage()', start);
  const scanSource = source.slice(start, end);

  assert.match(source, /const LARGE_THREAD_WARNING_PAGES = 50/);
  assert.match(source, /function confirmLargeThreadScan/);
  assert.match(source, /data-confirm-preference/);
  assert.match(scanSource, /pagesToScan >= LARGE_THREAD_WARNING_PAGES/);
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
  assert.match(groupsSource, /const content = collapsed \? '' : postView/);
  assert.match(groupsSource, /iconWell\('chevron'\)/);
  assert.match(resetSource, /state\.collapsedReplies\.clear\(\)/);
  assert.doesNotMatch(source.slice(source.indexOf('function persistSettings'), source.indexOf('function refreshThreadHeader')), /collapsedReplies/);
});

test('reply-level selection derives checked and indeterminate state from the data model', () => {
  let invalidations = 0;
  const state = {
    downloadState: 'all',
    items: [
      { reply: 'one', selectionKey: 'image-1', downloadable: true },
      { reply: 'one', selectionKey: 'video-1', downloadable: true },
      { reply: 'one', selectionKey: 'text-1', downloadable: false },
      { reply: 'two', selectionKey: 'image-2', downloadable: true },
    ],
    selected: new Set(),
  };
  const { replySelectionState, setReplySelected } = evaluateSlice(
    'function normalizedQuery',
    'function buildViewPages',
    ['replySelectionState', 'setReplySelected'],
    {
      state,
      replyKey: item => item.reply,
      isDownloadableMedia: item => item.downloadable,
      invalidateVisibleItems: () => { invalidations++; },
      persistThreadSelection: () => {},
      isMediaItem: item => ['image', 'video', 'embed'].includes(item.type),
      wasDownloaded: item => Boolean(item.downloaded),
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
    downloadState: 'all',
    items: [
      { reply: 'one', selectionKey: 'image-1', type: 'image', downloadable: true },
      { reply: 'one', selectionKey: 'video-1', type: 'video', downloadable: true },
      { reply: 'one', selectionKey: 'embed-1', type: 'embed', downloadable: true },
      { reply: 'one', selectionKey: 'link-1', type: 'link', downloadable: false },
    ],
    selected: new Set(),
  };
  const { setReplySelected, replySelectionState } = evaluateSlice(
    'function normalizedQuery',
    'function buildViewPages',
    ['setReplySelected', 'replySelectionState'],
    {
      state,
      replyKey: item => item.reply,
      isDownloadableMedia: item => item.downloadable,
      invalidateVisibleItems: () => {},
      persistThreadSelection: () => {},
      isMediaItem: item => ['image', 'video', 'embed'].includes(item.type),
      wasDownloaded: item => Boolean(item.downloaded),
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
    downloadState: 'all',
    items: Array.from({ length: 75 }, (_, index) => ({
      reply: 'large-reply',
      selectionKey: `media-${index}`,
      downloadable: true,
    })),
    selected: new Set(),
    collapsedReplies: new Set(['large-reply']),
  };
  const { setReplySelected, replySelectionState } = evaluateSlice(
    'function normalizedQuery',
    'function buildViewPages',
    ['setReplySelected', 'replySelectionState'],
    {
      state,
      replyKey: item => item.reply,
      isDownloadableMedia: item => item.downloadable,
      invalidateVisibleItems: () => {},
      persistThreadSelection: () => {},
      isMediaItem: item => ['image', 'video', 'embed'].includes(item.type),
      wasDownloaded: item => Boolean(item.downloaded),
    },
  );

  setReplySelected('large-reply', true);
  assert.equal(state.selected.size, 75);
  assert.equal(replySelectionState('large-reply').checked, true);
  assert.equal(state.collapsedReplies.has('large-reply'), true);
});

test('selection gestures toggle, extend and add without a mode', () => {
  const { selectionRangeKeys, resolveSelectionGesture } = evaluateSlice(
    'function selectionRangeKeys',
    'function selectableKeysInView',
    ['selectionRangeKeys', 'resolveSelectionGesture'],
  );
  const keys = ['a', 'b', 'c', 'd', 'e'];

  // A range is inclusive and reads the same in either direction.
  assert.deepEqual(plain(selectionRangeKeys(keys, 'b', 'd')), ['b', 'c', 'd']);
  assert.deepEqual(plain(selectionRangeKeys(keys, 'd', 'b')), ['b', 'c', 'd']);
  // No anchor yet, or an anchor that a filter change has taken out of the view:
  // the shift-click degrades to selecting just the card that was clicked.
  assert.deepEqual(plain(selectionRangeKeys(keys, null, 'c')), ['c']);
  assert.deepEqual(plain(selectionRangeKeys(keys, 'gone', 'c')), ['c']);
  assert.deepEqual(plain(selectionRangeKeys(keys, 'b', 'gone')), []);

  // A plain click toggles, and moves the anchor to where it landed.
  assert.deepEqual(
    plain(resolveSelectionGesture({ orderedKeys: keys, anchorKey: 'a', targetKey: 'c', selected: new Set() })),
    { add: ['c'], remove: [], anchorKey: 'c' },
  );
  assert.deepEqual(
    plain(resolveSelectionGesture({ orderedKeys: keys, anchorKey: 'a', targetKey: 'c', selected: new Set(['c']) })),
    { add: [], remove: ['c'], anchorKey: 'c' },
  );

  // Ctrl/cmd toggles but leaves the anchor, so a shift-click afterwards still
  // spans from the start of the run rather than from the last stray click.
  assert.equal(resolveSelectionGesture({
    orderedKeys: keys, anchorKey: 'a', targetKey: 'c', selected: new Set(), additive: true,
  }).anchorKey, 'a');

  // Shift only ever selects: sweeping back across ground it already covered
  // must not punch holes in the range.
  assert.deepEqual(
    plain(resolveSelectionGesture({
      orderedKeys: keys, anchorKey: 'b', targetKey: 'd', selected: new Set(['b', 'c', 'd']), range: true,
    })),
    { add: ['b', 'c', 'd'], remove: [], anchorKey: 'b' },
  );
});

test('clearing the selection drops the anchor and its filter, not an active download', () => {
  const state = {
    selectedOnly: true,
    selected: new Set(['a', 'b', 'c']),
    selectionAnchor: 'b',
    downloading: true,
    cancelDownload: false,
  };
  const { clearSelection } = evaluateSlice(
    'function clearSelection',
    'function clearSelectionAndRefresh',
    ['clearSelection'],
    { state, invalidateVisibleItems: () => {}, persistThreadSelection: () => {} },
  );

  assert.equal(clearSelection(), true);
  assert.equal(state.selected.size, 0);
  assert.equal(state.selectionAnchor, null);
  // Otherwise the grid empties with nothing on screen explaining why.
  assert.equal(state.selectedOnly, false);
  assert.equal(clearSelection(), false);
  assert.equal(state.downloading, true);
  assert.equal(state.cancelDownload, false);
});

test('a card checkbox routes through the gesture rather than its own checked state', () => {
  assert.doesNotMatch(source, /selectionMode|exitSelectionMode|setSelected\(/);
  assert.match(source, /applySelectionGesture\(itemForNode\(selection, 'select'\), event\)/);
  assert.match(source, /range: Boolean\(event && event\.shiftKey\)/);
  assert.match(source, /additive: Boolean\(event && \(event\.ctrlKey \|\| event\.metaKey\)\)/);
  // The checkbox is mounted on every downloadable card and merely revealed.
  assert.match(source, /\.scg-card:hover \.scg-select/);
  assert.match(source, /\.scg-card\.selected \.scg-select\{opacity:1\}/);
  assert.doesNotMatch(source, /\.selecting \.scg-select/);
});

test('clearing download history removes persisted markers and completed queue rows', () => {
  const state = {
    downloading: false,
    downloadHistory: { saved: { verified: true } },
    downloadJobs: [{ id: 1, status: 'saved' }],
    downloadProgress: { total: 1 },
  };
  const removed = [];
  const broadcasts = [];
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
      tabSync: { post: type => broadcasts.push(type) },
      invalidateVisibleItems: () => {},
      pendingHistoryWrites: { stale: { verified: true, time: 1 } },
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
  // Other tabs hold their own copy; without this their next write restores it.
  assert.deepEqual(broadcasts, ['download-history-changed']);
  // The dirty delta has to go too, or this tab's next write re-contributes
  // records the user just cleared.
  assert.match(source, /pendingHistoryWrites = \{\};[\s\S]*?storage\.remove\(DOWNLOAD_HISTORY_KEY\)/);
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
  assert.match(source, /selected: !state\.selectedOnly \|\| \(isDownloadableMedia\(item\) && state\.selected\.has\(item\.selectionKey\)\)/);
});

test('active filters are visible and individually reversible', () => {
  const { activeFacetChips, facetClearPatch } = evaluateSlice(
    'function activeFacetChips',
    'function facetOptions',
    ['activeFacetChips', 'facetClearPatch'],
    {
      DOWNLOAD_STATE_LABELS: { 'not-downloaded': 'Not downloaded', downloaded: 'Downloaded' },
      RESOLUTION_LABELS: { hd: '720p+' },
    },
  );
  const labels = { image: 'Images' };

  assert.deepEqual(plain(activeFacetChips({ filter: 'all', query: '   ', authorFilter: 'all', hostFilter: 'all' }, labels)), []);

  const chips = plain(activeFacetChips({
    filter: 'image', query: '  beach ', authorFilter: 'anon', hostFilter: 'bunkr.cr',
    downloadState: 'not-downloaded', resolutionFilter: 'hd', selectedOnly: true,
  }, labels));
  assert.deepEqual(chips.map(chip => chip.facet), ['filter', 'query', 'author', 'host', 'download', 'resolution', 'selected']);
  assert.equal(chips[0].value, 'Images');
  assert.equal(chips[1].value, 'beach');
  assert.equal(chips[4].value, 'Not downloaded');

  // Sort and grouping rearrange what is already there rather than withholding
  // anything, so they do not belong in a bar about what is being hidden.
  assert.deepEqual(plain(activeFacetChips({ sort: 'author', groupBy: 'reply' }, labels)), []);

  assert.deepEqual(plain(facetClearPatch('host')), { hostFilter: 'all' });
  assert.deepEqual(plain(facetClearPatch('all')), {
    filter: 'all', query: '', authorFilter: 'all', hostFilter: 'all', selectedOnly: false, downloadState: 'all', resolutionFilter: 'all',
  });
  assert.equal(facetClearPatch('nonsense'), null);
});

test('the download facet isolates saved and outstanding media', () => {
  const state = {
    filter: 'all', query: '', authorFilter: 'all', hostFilter: 'all', selectedOnly: false,
    downloadState: 'not-downloaded', selected: new Set(),
  };
  const { matchesActiveFilters } = evaluateSlice(
    'function filterParts',
    'function replyDownloadableItems',
    ['matchesActiveFilters'],
    {
      state,
      normalizedQuery: () => '',
      itemSourceHost: item => item.host || '',
      isDownloadableMedia: item => item.downloadable !== false,
      isMediaItem: item => ['image', 'video', 'embed'].includes(item.type),
      wasDownloaded: item => Boolean(item.downloaded),
    },
  );
  const outstanding = { type: 'image', downloaded: false };
  const saved = { type: 'video', downloaded: true };
  const legacy = { type: 'image', downloaded: false, legacy: true };
  const text = { type: 'text', downloaded: false };

  assert.equal(matchesActiveFilters(outstanding), true);
  assert.equal(matchesActiveFilters(legacy), true, 'an unverified legacy marker remains outstanding');
  assert.equal(matchesActiveFilters(saved), false);
  assert.equal(matchesActiveFilters(text), false, 'non-media is not something left to download');
  assert.equal(matchesActiveFilters(saved, '', 'download'), true, 'a facet can count without filtering against itself');

  state.downloadState = 'downloaded';
  assert.equal(matchesActiveFilters(outstanding), false);
  assert.equal(matchesActiveFilters(saved), true);
  assert.equal(matchesActiveFilters(text), false);

  state.downloadState = 'all';
  assert.equal(matchesActiveFilters(text), true);
  assert.match(source, /cache\.history === historyRevision/);
  assert.match(source, /invalidateVisibleItems\(\{ history: true \}\)/);
  const historyReload = source.slice(source.indexOf('function reloadDownloadHistory'), source.indexOf('function rememberDownloaded'));
  const historyClear = source.slice(source.indexOf('function clearDownloadHistory'), source.indexOf('function clearDiagnostics'));
  assert.match(historyReload, /state\.downloadState && state\.downloadState !== 'all'\) render\(\)/,
    'a cross-tab history change must refresh an active download-state view');
  assert.match(historyClear, /state\.downloadState && state\.downloadState !== 'all'\) render\(\)/,
    'clearing history must refresh an active download-state view');
  assert.match(source, /if \(state\.downloadState !== 'all'\) render\(\);\s*\r?\n\s*else updateDownloadUi\(\);\s*\r?\n\s*notify\(p\.label/,
    'a finished ZIP queue must add or remove cards immediately');
});

test('retry failed keeps only unique failed jobs and clears resolver cooldowns', () => {
  const failed = {
    selectionKey: 'failed',
    resolution: { attempted: true, failedAt: 123, candidate: { status: 'failed', error: 'expired' } },
  };
  const verify = { selectionKey: 'verify' };
  const ignored = { selectionKey: 'saved' };
  const state = {
    downloadJobs: [
      { status: 'failed', item: failed },
      { status: 'verification', item: failed },
      { status: 'verification', item: verify },
      { status: 'saved', item: ignored },
      { status: 'failed', item: null },
    ],
  };
  const { retryableDownloadItems, clearResolutionFailure } = evaluateSlice(
    'function retryableDownloadItems',
    'async function bulkDownload',
    ['retryableDownloadItems', 'clearResolutionFailure'],
    { state },
  );

  assert.deepEqual(plain(retryableDownloadItems().map(item => item.selectionKey)), ['failed', 'verify']);
  clearResolutionFailure(failed);
  assert.equal(failed.resolution.attempted, false);
  assert.equal(failed.resolution.candidate, null);
  assert.equal('failedAt' in failed.resolution, false);

  assert.match(source, /async function bulkDownload\(requestedItems = selectedMediaItems\(\)\)/);
  assert.match(source, /\[data-action="download-selected"\]'\)\.onclick = \(\) => controllers\.downloads\.bulk\(\)/);
  assert.match(source, /job\.status === 'failed' \|\| job\.status === 'verification'/);
  assert.match(source, /data-action="retry-failed"/);
});

test('post dates are parsed, sorted, and carried into exports', () => {
  const { postTimestamp } = evaluateSlice(
    'function postTimestamp',
    'function itemIsBlocked',
    ['postTimestamp'],
  );
  const node = values => ({ getAttribute: key => values[key] ?? null });
  const root = values => ({ querySelector: () => values ? node(values) : null });
  assert.equal(postTimestamp(root({ 'data-time': '1710000000' })), 1710000000000);
  assert.equal(postTimestamp(root({ datetime: '2024-03-10T12:30:00.000Z' })), Date.parse('2024-03-10T12:30:00.000Z'));
  assert.equal(postTimestamp(root({ datetime: 'not-a-date' })), 0);
  assert.equal(postTimestamp(root(null)), 0);

  const items = [
    { id: 'newer', postedAt: 300, pageNumber: 1, postIndex: 2, mediaIndex: 0, type: 'image' },
    { id: 'unknown', postedAt: 0, pageNumber: 1, postIndex: 0, mediaIndex: 0, type: 'image' },
    { id: 'older', postedAt: 100, pageNumber: 1, postIndex: 1, mediaIndex: 0, type: 'image' },
  ];
  const state = {
    items, sort: 'date-asc', downloadState: 'all', filter: 'all', query: '', groupBy: 'none',
    authorFilter: 'all', hostFilter: 'all', selectedOnly: false,
  };
  const { visibleItems } = evaluateSlice(
    'function compareThreadOrder',
    'function buildViewPages',
    ['visibleItems'],
    {
      state, visibleItemsCache: null, datasetRevision: 1, selectionRevision: 0, historyRevision: 0,
      normalizedQuery: () => '', matchesActiveFilters: () => true, compareText: () => 0,
      itemSourceHost: () => '', TYPE_ORDER: { image: 0 },
    },
  );
  assert.deepEqual(plain(visibleItems().map(item => item.id)), ['unknown', 'older', 'newer']);
  state.sort = 'date-desc';
  assert.deepEqual(plain(visibleItems().map(item => item.id)), ['newer', 'older', 'unknown']);

  const { buildMediaExportRows } = evaluateSlice(
    'function buildMediaExportRows',
    'function exportMediaUrls',
    ['buildMediaExportRows'],
    {
      mediaExportUrl: item => item.url,
      itemSourceHost: () => 'cdn.test',
      wasDownloaded: () => false,
    },
  );
  const exported = plain(buildMediaExportRows([{ type: 'image', url: 'https://cdn.test/a.jpg', postedAt: 1710000000000 }]));
  assert.equal(exported[0].postedAt, '2024-03-09T16:00:00.000Z');

  const { buildManifestCsv } = evaluateSlice(
    'function csvCell',
    'function timestampForFilename',
    ['buildManifestCsv'],
    { normalizeSourceUrl: String, hostOf: () => 'cdn.test' },
  );
  const manifest = buildManifestCsv([{
    item: { type: 'image', url: 'https://cdn.test/a.jpg', postedAt: 1710000000000 },
    archivePath: 'a.jpg', validation: { size: 3, mime: 'image/jpeg' }, crc: 1,
  }], 'part.zip');
  assert.match(manifest, /^\uFEFFarchive_path,[^\r\n]*posted_at,/);
  assert.match(manifest, /2024-03-09T16:00:00\.000Z/);
  assert.match(source, /<dt>Posted<\/dt>/);
  assert.match(source, /const \{ body, author, postUrl, postId, postNumber, postedAt \} = postParts\(root\)/);
});

test('facet counts answer what each value would give, and the summary states the whole', () => {
  // A facet counted against itself reports 0 for every value you did not pick.
  assert.match(source, /function matchesActiveFilters\(item, q = normalizedQuery\(\), skip = ''\)/);
  assert.match(source, /const authorMatch = skip === 'author' \|\|/);
  assert.match(source, /const hostMatch = skip === 'host' \|\|/);
  // One evaluation per item feeds both lists: the shared facets decide whether
  // it counts at all, then each list ignores only its own.
  assert.match(source, /const parts = filterParts\(item, q\);/);
  assert.match(source, /if \(!parts\.type \|\| !parts\.selected \|\| !parts\.download \|\| !parts\.resolution \|\| !parts\.query\) return;/);
  assert.match(source, /if \(item\.author && parts\.host\)/);
  assert.match(source, /if \(parts\.author\) \{/);
  // Counts move with every other facet, so this cache cannot key on the dataset.
  assert.match(source, /facetCountCache && facetCountCache\.signature === signature/);
  assert.match(source, /withCount\(author, counts\.authors\)/);
  assert.match(source, /withCount\(host, counts\.hosts\)/);
  // The summary is always a fraction of the indexed total.
  assert.match(source, /of \$\{count\(indexed\)\} shown/);
  // The bar sits outside the collapsible panel: a filter you cannot see is a
  // filter you cannot undo.
  assert.match(source, /<\/section>\s*<div class="scg-active-facets"/);
  assert.match(source, /\.scg-active-facets\[hidden\]\{display:none\}/);
});

test('reply headers pin as the spine of the scroll instead of boxing the media', () => {
  // The bordered box is gone, which is what lets the header stick at all:
  // overflow:hidden on an ancestor disables position:sticky outright.
  assert.match(source, /\.scg-reply-group\{margin:0 0 var\(--scg-s-5\)\}/);
  assert.doesNotMatch(source, /\.scg-reply-group\{[^}]*overflow:hidden/);
  assert.match(source, /\.scg-reply-group>header\{\s*position:sticky;top:0;z-index:12;/);
  // A group with nothing selected reports nothing, rather than a row of zeroes.
  assert.match(source, /replySelection\.selected \? `\$\{replySelection\.selected\} of \$\{replySelection\.total\} selected` : ''/);
  assert.match(source, /\.scg-reply-identity>span:empty\{display:none\}/);
  // And the grid stops insetting itself away from a box that no longer exists.
  assert.doesNotMatch(source, /\.scg-group-grid\{[^}]*padding:12px/);
});

test('dock mounts its three regions from what is true, not from a mode', () => {
  // Selection region: present exactly while something is selected.
  assert.match(source, /classList\.toggle\('has-selection', count > 0\)/);
  assert.match(source, /\.has-selection \.scg-selection-region,/);
  // Transfer region: present exactly while a transfer exists.
  assert.match(source, /\.scg-progress\{position:relative;display:none/);
  assert.match(source, /\.has-downloads \.scg-progress,/);
  assert.match(source, /\.has-selection\.has-downloads \.scg-progress,/);
  assert.match(source, /\.has-selection\.downloading \.scg-progress/);
  // An active queue keeps its cancel affordance even with nothing selected.
  assert.match(source, /\.downloading \.scg-selection-region\{display:flex\}/);
  assert.match(source, /classList\.toggle\('cancel-download', state\.downloading\)/);
  assert.match(source, /state\.downloading \? 'Cancel ZIP queue'/);
});

test('plate and dock share one glass recipe, tuned per surface, with no dock collapse mode', () => {
  assert.doesNotMatch(source, /activityCollapsed|activity-collapsed|activity-toggle|setting-activity-collapsed/);

  // Both surfaces opt into the shared recipe in markup.
  assert.match(source, /class="scg-plate scg-glass"/);
  assert.match(source, /class="scg-bulkbar scg-activitybar scg-glass"/);

  // The recipe is declared exactly once. Re-duplicating it across surfaces is
  // the regression this guards against; asserting literal blur values instead
  // just forces a paired test edit on every restyle.
  assert.equal((source.match(/\.scg-glass\{/g) || []).length, 1);
  assert.match(source, /\.scg-glass\{[\s\S]*?--scg-glass-top,60%/);
  assert.match(source, /\.scg-glass:before\{/);
  assert.match(source, /\.scg-glass>\*\{position:relative;z-index:1\}/);

  // The dock is the heavier surface, expressed purely as variable overrides.
  assert.match(source, /\.scg-activitybar\{[\s\S]*?--scg-glass-blur:34px/);
  assert.match(source, /\.scg-activitybar\{[\s\S]*?--scg-glass-sat:180%/);
  assert.match(source, /\.scg-activitybar\{[\s\S]*?min-height:64px/);
  assert.match(source, /\.scg-activitybar\{[\s\S]*?border-radius:18px/);

  // Highlight and shade come from the theme, not from hardcoded black/white.
  const glass = source.slice(source.indexOf('.scg-glass{'), source.indexOf('.scg-glass>*'));
  assert.doesNotMatch(glass, /#ffffff|#000000/);
  assert.match(glass, /var\(--scg-hi\)/);
  assert.match(glass, /var\(--scg-lo\)/);

  assert.match(source, /min-height:68px;bottom:8px;gap:8px;padding:9px 10px;border-radius:16px/);
});

test('download queue uses restrained translucent glass without reducing readability', () => {
  assert.match(source, /\.scg-download-popover\{[\s\S]*?var\(--scg-surface\) 94%,transparent[\s\S]*?var\(--scg-surface-2\) 90%,transparent[\s\S]*?backdrop-filter:blur\(20px\) saturate\(145%\)/);
  assert.match(source, /\.scg-download-popover>header\{[\s\S]*?var\(--scg-surface-2\) 92%,transparent/);
  assert.match(source, /\.scg-download-popover>header button\{[\s\S]*?var\(--scg-surface\) 94%,transparent/);
});

test('interface polish retains responsive, native, and launcher safeguards', () => {
  assert.match(source, /#\$\{APP_ID\} select option\{background:var\(--scg-surface\);color:var\(--scg-text\)\}/);
  assert.match(source, /\.scg-filters button:hover:not\(:disabled\):not\(\.active\)\{background:var\(--scg-surface-3\);color:var\(--scg-text\)\}/);
  assert.match(source, /@media\(max-height:620px\)/);
  assert.match(source, /\.scg-download-jobs\{max-height:30vh\}/);
  assert.match(source, /#scg-tl-launch\{[\s\S]*?min-height:66px/);
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

test('per-view pagination reaches All, and stops being a permanent control', () => {
  // 0 rides along in the same list so every existing perPage validation still
  // holds without a second code path.
  assert.match(source, /VIEW_PAGE_SIZES = Object\.freeze\(\[40, 60, 100, 200, 300, 500, 0\]\)/);
  assert.match(source, /VIEW_PAGE_SIZES\.includes\(Number\(savedSettings\.perPage\)\)/);
  assert.match(source, /VIEW_PAGE_SIZES\.includes\(Number\(input\.perPage\)\)/);
  assert.match(source, /viewPageSizeLabel = size => \(Number\(size\) > 0 \? String\(size\) : 'All'\)/);
  assert.match(source, /function buildViewPages\(items, perPage = state\.perPage\)/);
  assert.match(source, /const limit = Number\(perPage\) > 0 \? Number\(perPage\) : items\.length;/);

  // Paging is a consequence of the page size, not a way to browse.
  assert.match(source, /\.scg-view-pagination'\)\.hidden = state\.viewPages <= 1;/);
  assert.match(source, /\.scg-view-pagination\[hidden\]\{display:none\}/);
  // And the size control moves in with the other rarely-touched facets.
  assert.match(source, /<label>Per view <select data-page-size>[\s\S]{0,200}<\/label>\s*<button data-selected-only/);
});

test('buildViewPages treats All as one view without a separate code path', () => {
  const { buildViewPages } = evaluateSlice(
    'function buildViewPages',
    'function mediaItems',
    ['buildViewPages'],
    { state: { perPage: 0, groupBy: 'none' }, replyKey: item => String(item.reply) },
  );
  const items = Array.from({ length: 7 }, (_, index) => ({ id: index, reply: index % 3 }));

  const all = plain(buildViewPages(items));
  assert.equal(all.length, 1);
  assert.equal(all[0].length, 7);
  // An empty set is still one empty view, not zero views.
  assert.deepEqual(plain(buildViewPages([])), [[]]);
});

test('Posts includes every item type, orders each reply, and keeps replies on one result page', () => {
  const state = { filter: 'post', groupBy: 'reply', downloadState: 'all', perPage: 3 };
  const { replyKey, orderPostItems, filterParts, buildViewPages } = evaluateSlice(
    'function replyKey(', 'function mediaItems',
    ['replyKey', 'orderPostItems', 'filterParts', 'buildViewPages'], { state },
  );
  const item = (type, postId, mediaIndex = 0) => ({ type, postId, mediaIndex, pageNumber: 1 });
  const items = [item('video', 'b', 3), item('image', 'a', 2), item('text', 'b'),
    item('link', 'b', 1), item('embed', 'b', 4), item('image', 'b', 2), item('text', 'a')];
  items.forEach(entry => assert.equal(filterParts(entry).type, true));
  const ordered = orderPostItems(items);
  assert.deepEqual(plain(ordered.map(entry => `${replyKey(entry)}:${entry.type}`)),
    ['1|b:text', '1|b:link', '1|b:image', '1|b:video', '1|b:embed', '1|a:text', '1|a:image']);
  assert.equal(items[0].type, 'video', 'ordering leaves the indexed array untouched');
  assert.deepEqual(plain(buildViewPages(ordered)).map(page => page.length), [5, 2]);
  assert.deepEqual(plain(buildViewPages(ordered, 0)).map(page => page.length), [7]);
  state.groupBy = 'none';
  assert.equal(filterParts(items[0]).type, false, 'Posts is not available without reply grouping');
  state.filter = 'image';
  assert.equal(filterParts(items[0]).type, false);
  assert.equal(filterParts(items[1]).type, true, 'the other type tabs retain their behavior');
});

test('Posts renders ordered nonempty sections and honors reply collapse', () => {
  const state = { filter: 'post', collapsedReplies: new Set() };
  const { postContentMarkup, replyGroupsMarkup } = evaluateSlice(
    'function postContentMarkup(', 'let allClampAnnounced', ['postContentMarkup', 'replyGroupsMarkup'],
    {
      state, FILTER_LABELS: { text: 'Text', link: 'Links', image: 'Images', video: 'Videos' },
      replyKey: item => item.postId, escapeHtml: value => String(value),
      card: item => `<article data-test-id="${item.id}"></article>`,
      icon: () => '', iconWell: () => '', replySelectionState: () => ({ total: 0 }), replySelectionSummary: () => '',
    },
  );
  const items = [{ type: 'embed', id: 'embed' }, { type: 'image', id: 'later', mediaIndex: 2 },
    { type: 'text', id: 'text' }, { type: 'link', id: 'link' }, { type: 'image', id: 'earlier', mediaIndex: 1 }]
    .map(item => ({ postId: 'one', ...item }));
  const html = postContentMarkup(items);
  assert.deepEqual([...html.matchAll(/data-post-type="([^"]+)"/g)].map(match => match[1]), ['text', 'link', 'image', 'video']);
  assert.deepEqual([...html.matchAll(/data-test-id="([^"]+)"/g)].map(match => match[1]), ['text', 'link', 'earlier', 'later', 'embed']);
  assert.equal(postContentMarkup([]), '');
  assert.doesNotMatch(postContentMarkup([items[0]]), /data-post-type="image"/);
  assert.match(replyGroupsMarkup(items), /scg-post-content/);
  state.collapsedReplies.add('one');
  assert.doesNotMatch(replyGroupsMarkup(items), /data-post-type|data-test-id/);
  state.collapsedReplies.clear();
  state.filter = 'all';
  assert.doesNotMatch(replyGroupsMarkup(items), /scg-post-content|data-post-type/);
});

test('turning reply grouping off exits Posts before saving preferences', () => {
  const state = { filter: 'post', groupBy: 'reply', viewPage: 3 };
  let saved;
  const { commitState } = evaluateSlice('function commitState(', 'const cleanText =', ['commitState'], {
    state, persistSettings: () => { saved = { ...state }; }, render() {},
  });
  commitState({ groupBy: 'none' }, { persist: true });
  assert.equal(saved.filter, 'all');
  assert.equal(saved.viewPage, 1);
  commitState({ groupBy: 'reply' });
  assert.equal(state.filter, 'all', 're-enabling grouping does not unexpectedly switch views');
  commitState({ filter: 'post' }, { persist: true });
  assert.equal(saved.filter, 'post');
});

test('icon geometry stays larger than the stroke that draws it', () => {
  // Icons render at 17px with a 1.6 stroke, so a feature under ~1.5 units in a
  // 24-unit box is thinner than its own outline and reads as a smudge. The gear
  // was twelve such curves; it is now a real toothed outline.
  assert.match(source, /settings: '<path d="M9\.74 6\.12/);
  assert.doesNotMatch(source, /settings: '<circle/);
  assert.match(source, /stroke-width="1\.6"/);
});

test('display labels are free of known mojibake sequences', () => {
  assert.doesNotMatch(source, /Ã|Â|â|�/);
  assert.match(source, /Media browser · v\$\{APP_VERSION\}/);
  assert.match(source, /normalized\.width\.toLocaleString\(\)\} × /);
  assert.match(source, /scg-scan-thread-danger\{[\s\S]*?background:#8f2034/);
});

test('long tooltips wrap above adjacent controls and the download queue Close action can dismiss the popover', () => {
  assert.match(source, /white-space:normal;overflow-wrap:anywhere;pointer-events:none/);
  assert.match(source, /scg-scan-thread-danger scg-tip-end/);
  assert.match(source, /\.scg-header\{\s*z-index:2; \/\* Keep header tooltips above the later-painted filter row\. \*\//);
  assert.doesNotMatch(source, /\.scg-progress:focus-within \.scg-download-popover/);
  assert.match(source, /\[data-action="download-details"\]\'\)\?\.focus\(\{ preventScroll: true \}\)/);
});

test('reply-level selection respects the active search, author and host filters', () => {
  const state = {
    filter: 'all',
    downloadState: 'all',
    query: 'holiday',
    authorFilter: 'ana',
    hostFilter: 'all',
    selectedOnly: false,
    items: [
      { reply: 'one', selectionKey: 'match', type: 'image', author: 'ana', host: 'bunkr', searchText: 'holiday beach', downloadable: true },
      { reply: 'one', selectionKey: 'other-author', type: 'image', author: 'bea', host: 'bunkr', searchText: 'holiday beach', downloadable: true },
      { reply: 'one', selectionKey: 'off-query', type: 'image', author: 'ana', host: 'pixhost', searchText: 'winter cabin', downloadable: true },
    ],
    selected: new Set(),
  };
  const { setReplySelected, replySelectionState } = evaluateSlice(
    'function normalizedQuery',
    'function buildViewPages',
    ['setReplySelected', 'replySelectionState'],
    {
      state,
      replyKey: item => item.reply,
      isDownloadableMedia: item => item.downloadable,
      itemSourceHost: item => item.host,
      invalidateVisibleItems: () => {},
      persistThreadSelection: () => {},
      isMediaItem: item => ['image', 'video', 'embed'].includes(item.type),
      wasDownloaded: item => Boolean(item.downloaded),
    },
  );

  assert.equal(replySelectionState('one').total, 1);
  setReplySelected('one', true);
  assert.deepEqual([...state.selected], ['match']);

  state.selected.clear();
  state.query = '';
  state.authorFilter = 'all';
  state.hostFilter = 'pixhost';
  assert.equal(replySelectionState('one').total, 1);
  setReplySelected('one', true);
  assert.deepEqual([...state.selected], ['off-query']);

  state.selected.clear();
  state.hostFilter = 'all';
  setReplySelected('one', true);
  assert.equal(state.selected.size, 3);
});

test('reset everything refuses to clear history while a download is active', () => {
  const removed = [];
  const notices = [];
  let historyCleared = 0;
  let applied = 0;
  let allowClear = false;
  const { resetPreferences } = evaluateSlice(
    'function resetPreferences',
    'function clearDownloadHistory',
    ['resetPreferences'],
    {
      SETTINGS_KEY: 'settings-key',
      DEFAULT_SETTINGS: {},
      storage: { remove: key => removed.push(key) },
      applyPreferences: () => { applied++; },
      notify: message => notices.push(message),
      clearDownloadHistory: () => {
        if (!allowClear) return false;
        historyCleared++;
        return true;
      },
    },
  );

  assert.equal(resetPreferences(true), false);
  assert.equal(historyCleared, 0);
  assert.deepEqual(removed, []);
  assert.equal(applied, 0);
  assert.match(notices[0], /active download/);

  allowClear = true;
  assert.equal(resetPreferences(true), true);
  assert.equal(historyCleared, 1);
  assert.deepEqual(removed, ['settings-key']);
  assert.equal(applied, 1);

  assert.equal(resetPreferences(false), true);
  assert.equal(historyCleared, 1);
  assert.deepEqual(removed, ['settings-key', 'settings-key']);
});

test('reply selection reads the prebuilt index instead of rescanning every item', () => {
  let itemScans = 0;
  const state = {
    // Any fallback path has to touch state.items; the getter proves it doesn't.
    get items() { itemScans++; return []; },
    selected: new Set(['a']),
    downloadState: 'all',
    replyIndex: new Map([['one', [
      { reply: 'one', selectionKey: 'a', downloadable: true },
      { reply: 'one', selectionKey: 'b', downloadable: true },
    ]]]),
  };
  const { replySelectionState } = evaluateSlice(
    'function normalizedQuery',
    'function buildViewPages',
    ['replySelectionState'],
    {
      state,
      replyKey: item => item.reply,
      isDownloadableMedia: item => item.downloadable,
      invalidateVisibleItems: () => {},
      isMediaItem: item => ['image', 'video', 'embed'].includes(item.type),
      wasDownloaded: item => Boolean(item.downloaded),
    },
  );

  const group = replySelectionState('one');
  assert.equal(group.total, 2);
  assert.equal(group.selected, 1);
  assert.equal(group.indeterminate, true);
  assert.equal(itemScans, 0);
  assert.equal(replySelectionState('absent').total, 0);
});

test('reply selection still works without an index', () => {
  const state = {
    replyIndex: null,
    downloadState: 'all',
    items: [
      { reply: 'one', selectionKey: 'a', type: 'image', downloadable: true },
      { reply: 'two', selectionKey: 'b', type: 'image', downloadable: true },
    ],
    selected: new Set(),
  };
  const { replySelectionState } = evaluateSlice(
    'function normalizedQuery',
    'function buildViewPages',
    ['replySelectionState'],
    {
      state,
      replyKey: item => item.reply,
      isDownloadableMedia: item => item.downloadable,
      invalidateVisibleItems: () => {},
      isMediaItem: item => ['image', 'video', 'embed'].includes(item.type),
      wasDownloaded: item => Boolean(item.downloaded),
    },
  );

  assert.equal(replySelectionState('one').total, 1);
  assert.equal(replySelectionState('two').total, 1);
});

test('derived facet lists are memoized on the dataset revision', () => {
  assert.match(source, /facetCache && facetCache\.revision === datasetRevision/);
  assert.match(source, /facetCache = \{ revision: datasetRevision, authors, hosts \}/);
  assert.match(source, /const \{ authors, hosts \} = facetOptions\(\)/);
  // The old per-render derivation must be gone from refreshFilterControls.
  const controlsStart = source.indexOf('function refreshFilterControls');
  const controls = source.slice(controlsStart, source.indexOf('function replyGroupsMarkup', controlsStart));
  assert.doesNotMatch(controls, /new Set\(state\.items\.map/);
});

test('the reply index is rebuilt per render and dropped only when eligibility can change', () => {
  assert.match(source, /state\.replyIndex = !state\.scanning && state\.groupBy === 'reply' \? buildReplyIndex\(matched\) : null/);
  assert.match(source, /if \(dataset \|\| \(selection && state\.selectedOnly\) \|\| \(history && state\.downloadState !== 'all'\)\) state\.replyIndex = null/);
});

test('aspect ratios are clamped, hinted, averaged and evicted', () => {
  // The slice runs in a vm sandbox, so its objects carry a different
  // Object.prototype and deepStrictEqual rejects them. Compare plain data.
  const { clampRatio, parseDimensionHints, geometricMeanRatio, mergeRatioCache } = evaluateSlice(
    'function clampRatio',
    'const RATIO_SOURCE_RANK',
    ['clampRatio', 'parseDimensionHints', 'geometricMeanRatio', 'mergeRatioCache'],
  );

  // clamping keeps pathological media from blowing up a row or column
  assert.equal(clampRatio(1.5), 1.5);
  assert.equal(clampRatio(9), 4);
  assert.equal(clampRatio(0.01), 0.32);
  assert.equal(clampRatio(0), 0);
  assert.equal(clampRatio('nonsense'), 0);
  // Degenerate input (zero height) reads as unknown, not as the clamped max,
  // so callers fall back to the assumed ratio rather than laying out a 4:1 box.
  assert.equal(clampRatio(Infinity), 0);

  // attributes first, inline style as a fallback, null when either is missing
  assert.deepEqual(plain(parseDimensionHints({ width: '800', height: '600' })), { width: 800, height: 600 });
  assert.deepEqual(plain(parseDimensionHints({ style: 'width: 400px; height:200px' })), { width: 400, height: 200 });
  assert.deepEqual(plain(parseDimensionHints({ width: '800px', height: '600px' })), { width: 800, height: 600 });
  assert.equal(parseDimensionHints({ width: '800' }), null);
  assert.equal(parseDimensionHints({}), null);
  assert.equal(parseDimensionHints(null), null);

  // geometric, not arithmetic: 2 and 1/2 must average to 1
  assert.equal(geometricMeanRatio(0, 0, 0.72), 0.72);
  assert.equal(Math.round(geometricMeanRatio(Math.log(2) + Math.log(0.5), 2, 0.72) * 1000) / 1000, 1);
  assert.equal(Math.round(geometricMeanRatio(Math.log(0.5) * 4, 4, 0.72) * 1000) / 1000, 0.5);

  // merge rounds, keeps newest on eviction, and rejects junk
  assert.deepEqual(plain(mergeRatioCache({ a: [1.5, 10] }, { b: [0.66666, 20] }, 10)), { a: [1.5, 10], b: [0.667, 20] });
  assert.deepEqual(plain(mergeRatioCache({}, { bad: 'x', worse: [0, 1], nope: [-1, 1] }, 10)), {});
  const evicted = plain(mergeRatioCache({ old: [1, 1], mid: [1, 2] }, { fresh: [1, 3] }, 2));
  assert.deepEqual(Object.keys(evicted).sort(), ['fresh', 'mid']);
  // an existing entry is overwritten, not duplicated
  assert.deepEqual(plain(mergeRatioCache({ a: [1, 1] }, { a: [2, 5] }, 10)), { a: [2, 5] });
});

test('ratio capture is wired into scanning, rendering and the viewer', () => {
  assert.match(source, /dimHint: parseDimensionHints\(\{/);
  assert.match(source, /seedRatioFromCache\(item\);/);
  assert.match(source, /style="--scg-ratio:\$\{itemRatio\(item\)\}"/);
  assert.match(source, /addEventListener\('load', event => \{[\s\S]*?applyMeasuredRatio/);
  assert.match(source, /aspect-ratio:var\(--scg-ratio,0\.72\)/);
  // a better source must not be overwritten by a worse one
  assert.match(source, /RATIO_SOURCE_RANK\[current\.source\] > RATIO_SOURCE_RANK\[source\]/);
});

test('themes collapse to two complete sets plus a derived accent', () => {
  assert.match(source, /const ACCENT_MODES = Object\.freeze\(\['blue', 'indigo', 'amber', 'green', 'rose', 'neutral'\]\)/);
  // The two hue-only themes are gone from both the model and the stylesheet.
  assert.doesNotMatch(source, /data-theme="midnight"|data-theme="graphite"/);
  // Scope this to the declaration itself: a lazy match over the whole source
  // also hits the word in the comment explaining the migration.
  assert.doesNotMatch(source.match(/const THEME_LABELS = .*/)[0], /Graphite|Indigo/);

  // Accent is one base hue plus its ink; everything else derives, so adding an
  // accent stays a two-line change.
  assert.match(source, /--scg-accent:var\(--scg-accent-base\)/);
  assert.match(source, /--scg-accent-soft:color-mix\(in srgb,var\(--scg-accent-base\) 15%,var\(--scg-surface-3\)\)/);
  assert.match(source, /--scg-focus:color-mix\(in srgb,var\(--scg-accent-base\) 62%,var\(--scg-text\)\)/);
  ACCENTS.forEach(accent => {
    assert.match(source, new RegExp(`\[data-accent="${accent}"\]`));
  });

  // Accent must be persisted and reflected onto the shell, launcher and toast.
  assert.match(source, /accent: state\.accent,/);
  assert.match(source, /app\.dataset\.accent = state\.accent;/);
  assert.match(source, /toast\.dataset\.accent = state\.accent/);
  assert.match(source, /launch\.dataset\.accent = state\.accent/);
});

test('stored midnight and graphite settings migrate to dark plus an accent', () => {
  const { normalizedPreferences } = evaluateSlice(
    'function normalizedPreferences',
    'function currentPreferences',
    ['normalizedPreferences'],
    {
      THEME_MODES: ['dark', 'light'],
      ACCENT_MODES: ACCENTS,
      DOWNLOAD_STATES: ['all', 'not-downloaded', 'downloaded'],
      RESOLUTION_FILTERS: ['all', 'unknown', 'sd', 'hd', 'fhd', 'uhd'],
      SORT_MODES: ['thread-asc', 'thread-desc', 'author', 'host', 'type', 'date-asc', 'date-desc', 'resolution-asc', 'resolution-desc'],
      LAYOUT_MODES: ['masonry', 'grid'],
      LEGACY_THEME_ACCENTS: { midnight: 'indigo', graphite: 'amber' },
      VIEW_PAGE_SIZES: [40, 60, 100, 200, 300, 500],
      normalizedShortcuts: () => ({}),
      DEFAULT_SETTINGS: { filter: 'all', downloadState: 'all', resolutionFilter: 'all', sort: 'thread-asc', groupBy: 'none', perPage: 60, theme: 'dark', accent: 'blue', layoutMode: 'masonry', cardScale: 100, downloadConcurrency: 2, zipPartSizeMb: 300, zipPartMaxFiles: 24, archiveLayout: 'page-author', blockPatterns: '' },
    },
  );

  const midnight = normalizedPreferences({ theme: 'midnight' });
  assert.equal(midnight.theme, 'dark');
  assert.equal(midnight.accent, 'indigo');

  const graphite = normalizedPreferences({ theme: 'graphite' });
  assert.equal(graphite.theme, 'dark');
  assert.equal(graphite.accent, 'amber');

  // An explicit accent always wins over the legacy mapping.
  assert.equal(normalizedPreferences({ theme: 'graphite', accent: 'rose' }).accent, 'rose');
  // Unknown values fall back rather than passing through.
  assert.equal(normalizedPreferences({ theme: 'nonsense', accent: 'nonsense' }).theme, 'dark');
  assert.equal(normalizedPreferences({ theme: 'nonsense', accent: 'nonsense' }).accent, 'blue');
  // A real theme is untouched.
  assert.equal(normalizedPreferences({ theme: 'light' }).theme, 'light');
  assert.equal(normalizedPreferences({ filter: 'post', groupBy: 'reply' }).filter, 'post');
  assert.equal(normalizedPreferences({ filter: 'post', groupBy: 'none' }).filter, 'all');
});

function loadLayoutEngine() {
  return evaluateSlice(
    'function entryRatio',
    'const IMAGE_EXT',
    ['packColumns', 'visibleRowRange'],
    {
      clampRatio: value => {
        const ratio = Number(value);
        if (!Number.isFinite(ratio) || ratio <= 0) return 0;
        return Math.min(4, Math.max(0.32, ratio));
      },
    },
  );
}

const entriesOf = (count, ratio) =>
  Array.from({ length: count }, (_, index) => ({ key: 'k' + index, ratio }));

test('masonry packs into the shortest column and never overflows the container', () => {
  const { packColumns } = loadLayoutEngine();
  const options = { containerWidth: 1000, columnWidth: 240, gap: 10, chromeHeight: 0, assumedRatio: 1 };

  const square = packColumns(entriesOf(4, 1), options);
  assert.equal(square.columns, 4);
  // Columns tile the width exactly: last right edge lands on the container.
  const last = square.cells[3];
  assert.ok(last.x + last.width <= 1000, 'grid must not overflow');
  assert.equal(square.cells[0].y, 0);
  assert.equal(square.cells[3].y, 0);

  // A tall first item pushes the fifth into the shortest column, not the first.
  const uneven = packColumns(
    [{ key: 'tall', ratio: 0.4 }, ...entriesOf(4, 2).map((e, i) => ({ ...e, key: 'w' + i }))],
    options,
  );
  const tall = uneven.cells[0];
  const fifth = uneven.cells[4];
  assert.ok(tall.height > fifth.height, 'the 0.4 ratio card should be the tallest');
  assert.notEqual(fifth.x, tall.x, 'the shortest column must win, not the first');

  assert.equal(packColumns([], options).height, 0);
  // A container narrower than one column still yields a usable single column.
  assert.equal(packColumns(entriesOf(2, 1), { ...options, containerWidth: 100 }).columns, 1);
});

test('computed masonry keeps the column caps its CSS columns had', () => {
  const { packColumns } = loadLayoutEngine();
  const options = { containerWidth: 1900, columnWidth: 280, gap: 14, chromeHeight: 0, assumedRatio: 1 };

  // 1900px fits six 280px columns. The CSS this replaced preferred five larger
  // ones, and folding the windowed renderer into masonry must not change that.
  assert.equal(packColumns(entriesOf(12, 1), options).columns, 6, 'uncapped, it fills the width');
  assert.equal(packColumns(entriesOf(12, 1), { ...options, maxColumns: 5 }).columns, 5);

  // A cap only ever removes columns; it never invents room that is not there.
  assert.equal(packColumns(entriesOf(4, 1), { ...options, containerWidth: 600, maxColumns: 5 }).columns, 2);
  assert.equal(packColumns(entriesOf(4, 1), { ...options, maxColumns: 0 }).columns, 6, 'absent cap is not a cap of zero');
  assert.equal(packColumns(entriesOf(4, 1), { ...options, maxColumns: 99 }).columns, 6);
  // One column is still the floor, whatever the cap says.
  assert.equal(packColumns(entriesOf(2, 1), { ...options, containerWidth: 100, maxColumns: 5 }).columns, 1);

  // Capping widens the cards rather than leaving a gap at the right edge.
  const capped = packColumns(entriesOf(5, 1), { ...options, maxColumns: 5 });
  const last = capped.cells.reduce((widest, cell) => (cell.x > widest.x ? cell : widest), capped.cells[0]);
  assert.ok(last.x + last.width <= options.containerWidth, 'a capped pack must not overflow');
  assert.ok(capped.columnWidth > 280, 'the spare width goes to the columns');
});

test('the column cap follows the same breakpoints the stylesheet uses', () => {
  const { masonryColumnCap } = evaluateSlice(
    'const MASONRY_COLUMN_CAPS',
    'function flowLayoutOptions',
    ['masonryColumnCap'],
  );

  [[500, 2, 2], [720, 2, 2], [900, 3, 4], [1024, 3, 4], [1200, 4, 6], [1340, 4, 6], [1920, 5, 7]]
    .forEach(([width, comfortable, compact]) => {
      assert.equal(masonryColumnCap(width, false), comfortable, `comfortable at ${width}px`);
      assert.equal(masonryColumnCap(width, true), compact, `compact at ${width}px`);
    });

  // An unknown width must not pin a desktop to the narrowest cap.
  [0, -1, undefined, null, NaN, 'wide'].forEach(value => {
    assert.equal(masonryColumnCap(value, false), 5, String(value));
  });

  // And the stylesheet still states the same counts for the paths the window
  // does not own, so the two cannot drift apart unnoticed.
  [[':not(.flowing){display:block;columns:5', false], ['{columns:4 ', false], ['{columns:3 ', false]]
    .forEach(([fragment]) => assert.ok(source.includes(fragment), 'missing CSS column rule: ' + fragment));
});

test('the render window finds every intersecting cell, including tall stragglers', () => {
  const { visibleRowRange } = loadLayoutEngine();
  const cells = [
    { key: 'tall', y: 0, height: 900 },
    { key: 'a', y: 100, height: 100 },
    { key: 'b', y: 500, height: 100 },
    { key: 'c', y: 1000, height: 100 },
    { key: 'd', y: 2000, height: 100 },
  ];

  const window = visibleRowRange(cells, 600, 300, 0, 900);
  // 'tall' starts far above but still overlaps: the backward walk must catch it.
  assert.equal(window.start, 0);
  // c starts at y=1000, below the window bottom at 900, so b is the last one in.
  assert.equal(cells[window.end].key, 'b');

  const overscanned = visibleRowRange(cells, 600, 300, 1200, 900);
  assert.equal(cells[overscanned.end].key, 'd');

  // Scrolled past everything.
  assert.equal(visibleRowRange(cells, 9000, 300, 0, 900).end, -1);
  assert.equal(visibleRowRange([], 0, 300, 0, 900).end, -1);
  // Without a known tallest cell the range must widen, never drop a cell.
  assert.equal(visibleRowRange(cells, 600, 300, 0).start, 0);
});

test('cards address their item by key, not by position', () => {
  // Position-based addressing cannot survive a windowed renderer, where the
  // mounted set is a moving slice rather than the whole page.
  assert.doesNotMatch(source, /data-index=/);
  assert.doesNotMatch(source, /renderedItems\[Number\(/);
  assert.doesNotMatch(source, /dataset\.resolveIndex/);

  assert.match(source, /data-key="\$\{key\}"/);
  assert.match(source, /data-resolve-key="\$\{key\}"/);
  assert.match(source, /function itemsByKey\(\)/);
  assert.match(source, /itemIndexCache\.revision === datasetRevision/);

  // Every consumer resolves through the map. Exact call sites, so a
  // half-finished migration cannot pass by matching some other lookup.
  [
    "itemForNode(selection, 'select')",
    "itemForNode(player, 'loadPlayer')",
    "itemForNode(expand, 'expand')",
    "itemForNode(download, 'download')",
    "itemForNode(button, 'open')",
    "itemForNode(cardNode, 'key')",
    "itemForNode(img, 'resolveKey')",
  ].forEach(call => assert.ok(source.includes(call), 'missing lookup: ' + call));
  assert.match(source, /app\.querySelectorAll\('\.scg-card\[data-key\]'\)/);
});

test('DOM-only UI state is lifted so unmounting cannot lose it', () => {
  // Both of these lived purely as classes/innerHTML on the card. The first time
  // a card unmounts they would silently reset.
  assert.match(source, /expandedKeys: new Set\(\)/);
  assert.match(source, /activePlayers: new Set\(\)/);

  // card() must render from that state, not just react to clicks.
  assert.match(source, /state\.activePlayers\.has\(item\.selectionKey\)/);
  assert.match(source, /const expanded = state\.filter === 'post' \|\| state\.expandedKeys\.has\(item\.selectionKey\)/);

  // Clicks record it.
  assert.match(source, /state\.activePlayers\.add\(item\.selectionKey\)/);
  assert.match(source, /state\.expandedKeys\.add\(item\.selectionKey\)/);
  assert.match(source, /state\.expandedKeys\.delete\(item\.selectionKey\)/);

  // Replacing the dataset clears it, since the keys no longer refer to anything.
  assert.match(source, /state\.expandedKeys\.clear\(\);\s*\r?\n\s*state\.activePlayers\.clear\(\);/);
});

test('the accent tints the background from one corner, at a tunable strength', () => {
  // Strength is a token, so it can be tuned per theme and zeroed in one place
  // if a "reduce transparency" setting is added later.
  assert.match(source, /--scg-tint:9%/);
  assert.match(source, /--scg-tint:7%/);

  // Shell and canvas share the same origin corner so it reads as one wash.
  const washes = source.match(/radial-gradient\([^)]*at 0% 0%,\s*\r?\n?\s*color-mix\(in srgb,var\(--scg-accent-base\) var\(--scg-tint/g) || [];
  assert.equal(washes.length, 2);

  // Derived from the accent base, so switching accent moves the tint with it.
  assert.doesNotMatch(source.slice(source.indexOf('.scg-scroll{'), source.indexOf('.scg-top{')), /#[0-9a-f]{6}/i);
});

test('masonry is the windowed layout and places its own cards', () => {
  // CSS multi-column cannot be windowed: the browser has to see every box to
  // balance the columns. So the default layout does its own placement.
  assert.match(source, /const VIRTUALIZED_LAYOUTS = Object\.freeze\(\['masonry'\]\)/);
  assert.match(source, /const packed = packColumns\(entries, options\);/);
  assert.match(source, /\.scg-grid\.flowing\{[\s\S]*?position:relative/);
  assert.match(source, /\.scg-flow-cell\{[\s\S]*?position:absolute/);

  // The window index must be sorted by y; packColumns emits in item order.
  assert.match(source, /const ordered = packed\.cells\.slice\(\)\.sort\(\(a, b\) => a\.y - b\.y/);
  // And the range needs the tallest cell, or a tall card scrolling in from
  // above would never mount.
  assert.match(source, /visibleRowRange\(model\.cells, scrollArea\.scrollTop, scrollArea\.clientHeight, FLOW_OVERSCAN, model\.maxCellHeight\)/);

  // Scroll and relayout are both coalesced onto one frame.
  assert.match(source, /scrollArea\.addEventListener\('scroll'[\s\S]*?scheduleFlowWindow\(\)[\s\S]*?\{ passive: true \}/);
  assert.match(source, /flow\.frame = requestAnimationFrame/);

  // A late ratio re-packs, and the scroll position is anchored so content
  // above the fold does not jump under the reader.
  assert.match(source, /scheduleFlowLayout\(\);/);
  assert.match(source, /scrollArea\.scrollTop \+= anchorAfter - anchorBefore/);

  // Unmounting has to release media, or scrolling leaks players.
  assert.match(source, /function releaseFlowNode\(node\)/);
  assert.match(source, /teardownFlow\(\);/);
});

test('the picker offers two layouts, and the retired three leave nothing behind', () => {
  // Flow was masonry computed rather than CSS-balanced — the same picture, and
  // an implementation detail that never belonged in a picker. Timeline and Feed
  // were a third geometry and a one-per-row reader.
  assert.match(source, /const LAYOUT_MODES = Object\.freeze\(\['masonry', 'grid'\]\)/);
  assert.match(source, /const LAYOUT_LABELS = Object\.freeze\(\{ masonry: 'Masonry', grid: 'Uniform grid' \}\)/);
  ['flow', 'timeline', 'feed'].forEach(mode => {
    assert.doesNotMatch(source, new RegExp(`\\[data-layout="${mode}"\\]`), `${mode} CSS survives`);
    assert.doesNotMatch(source, new RegExp(`layoutMode === '${mode}'`), `${mode} is still branched on`);
  });
  assert.doesNotMatch(source, /justifyRows/, 'the justified-row geometry went with Timeline');
  // A stored layout that no longer exists falls back rather than sticking.
  assert.match(source, /LAYOUT_MODES\.includes\(savedSettings\.layoutMode\) \? savedSettings\.layoutMode : 'masonry'/);

  // Both pickers are still built from the one list.
  assert.match(source, /const layoutOptionsMarkup = \(\) => LAYOUT_MODES/);
  assert.doesNotMatch(source, /data-layout-mode/);
});

test('masonry CSS stands aside for the renderer that now owns its grid', () => {
  // The hazard in making the default layout windowed: [data-layout="masonry"]
  // out-specifies .flowing, so without saying when it does not apply it would
  // re-impose CSS columns and an aspect-ratio height on absolutely positioned
  // cards. What is left of it serves the two paths the window does not own.
  const columnRules = source.match(/\[data-layout="masonry"\][^\n]*\.scg-grid:not\(\.grouped\)[^\n]*/g) || [];
  assert.ok(columnRules.length >= 6, 'expected the base and responsive column rules');
  columnRules.forEach(rule => {
    assert.match(rule, /:not\(\.grouped\):not\(\.flowing\)/, 'a column rule still reaches the flowing grid: ' + rule.trim());
  });
  assert.match(source, /\[data-layout="masonry"\] \.scg-grid:not\(\.flowing\) \.scg-card \.scg-preview img\{/);

  // Reply groups keep their own CSS columns, which the window never touches.
  assert.match(source, /\[data-layout="masonry"\] \.scg-group-grid\{columns:5/);

  // The windowed rules key off the class, not the layout name.
  assert.match(source, /#\$\{APP_ID\} \.scg-grid\.flowing\{/);
  assert.match(source, /#\$\{APP_ID\} \.scg-grid\.flowing>\.scg-flow-cell\{\s*position:absolute/);
  // Compact at the smallest card size is now what makes a cell narrow, so the
  // container queries follow the cell rather than a retired layout.
  assert.match(source, /#\$\{APP_ID\} \.scg-flow-cell\{container-type:inline-size\}/);
  assert.match(source, /@container \(max-width:240px\)/);
});

test('reply grouping and scanning stay on the paged path', () => {
  assert.match(source, /const virtualized = usesWindowedRenderer\(\);/);
  assert.match(source, /VIRTUALIZED_LAYOUTS\.includes\(layoutMode\) && groupBy !== 'reply' && !scanning/);
  // The non-virtualized branch is unchanged.
  assert.match(source, /grid\.innerHTML = state\.scanning[\s\S]*?skeletonMarkup/);
  assert.match(source, /observeFullImages\(state\.renderedItems\)/);
  assert.match(source, /layoutMode: 'masonry',/);
});

test('changing layout rebuilds the grid rather than restyling the shell', () => {
  // Grid is laid out by CSS; masonry is laid out by us and positions its cards
  // absolutely. A shell-only commit changes the data-layout attribute without
  // touching the DOM, which leaves whatever the previous layout built still on
  // screen at its old coordinates.
  assert.match(source, /function setLayoutMode\(next, announce = false\) \{[\s\S]*?commitState\(\{ layoutMode: next \}, \{ persist: true \}\);/);
  assert.doesNotMatch(source, /layoutMode[^\n]*\{ persist: true, shellOnly: true \}/);
  // The plate and the settings sheet share one picker, so they share a handler.
  assert.match(source, /app\.querySelectorAll\('\[data-setting-layout\]'\)\.forEach\(select => \{/);
  assert.match(source, /setLayoutMode\(LAYOUT_MODES\.includes\(event\.target\.value\)/);
  assert.match(source, /layoutSelects\.forEach\(select => \{ select\.value = state\.layoutMode; \}\)/);

  // Density and card size stay shell-only, so a live windowed layout re-packs
  // itself instead of keeping geometry it computed at another size.
  assert.match(source, /if \(flow\.model\) scheduleFlowLayout\(\);/);
});

test('image work is capped, prioritized and cancellable', () => {
  assert.match(source, /const RESOLVE_CONCURRENCY = 3/);
  assert.match(source, /const DECODE_CONCURRENCY = 6/);
  // Both queues are drained by one pump, so neither can starve the other.
  assert.match(source, /while \(mediaScheduler\.resolving < RESOLVE_CONCURRENCY\)/);
  assert.match(source, /while \(mediaScheduler\.decoding < DECODE_CONCURRENCY\)/);

  // Priority is computed at pick time, so the order follows the scroll without
  // anything re-sorting a queue on every frame.
  assert.match(source, /function mediaRevealPriority\(key\)/);
  assert.match(source, /const centre = scrollArea\.scrollTop \+ \(scrollArea\.clientHeight \/ 2\)/);
  assert.match(source, /const priority = mediaRevealPriority\(entry\.key\)/);

  // Decode before swap: the card must not flash a half-painted image, and a
  // failed decode must leave the thumbnail alone rather than break it.
  assert.match(source, /probe\.decode\(\)\.then\(reveal, done\)/);
  assert.match(source, /entry\.img\.isConnected && entry\.img\.src !== entry\.url/);

  // Scrolling away cancels the swap.
  assert.match(source, /cancelMediaReveal\(key\);/);
  assert.match(source, /cancelAllMediaReveals\(\);/);

  // Both render paths go through the scheduler; neither resolves inline.
  ["scheduleMediaReveal(item, entry.target);", "if (img) scheduleMediaReveal(item, img);"]
    .forEach(call => assert.ok(source.includes(call), 'missing: ' + call));
  const observer = source.slice(source.indexOf('function observeFullImages'), source.indexOf('function releaseRenderedMedia'));
  assert.doesNotMatch(observer, /resolveForDisplay/);
});

test('download history writes merge instead of clobbering another tab', () => {
  const { mergeDownloadHistory } = evaluateSlice(
    'function mergeDownloadHistory',
    'const tabSync',
    ['mergeDownloadHistory'],
  );

  // The failure this exists to stop: two tabs each hold the whole map and write
  // it back, so the second writer's snapshot erases the first writer's work.
  const onDisk = { a: { verified: true, time: 30 }, b: { verified: true, time: 10 } };
  const inMemory = { b: { verified: true, time: 40 }, c: { verified: true, time: 50 } };
  const merged = plain(mergeDownloadHistory(onDisk, inMemory));
  assert.deepEqual(Object.keys(merged).sort(), ['a', 'b', 'c']);
  assert.equal(merged.b.time, 40, 'the newer of two records for one file wins');
  assert.equal(plain(mergeDownloadHistory(inMemory, { c: { verified: true, time: 1 } })).c.time, 50,
    'a stale write cannot roll a newer record back');

  // Verified is a stronger claim about the same file than a legacy marker, so
  // it outranks one in both directions regardless of the clock.
  assert.equal(plain(mergeDownloadHistory({ d: { verified: true, time: 1 } }, { d: { verified: false, time: 99 } })).d.verified, true);
  assert.equal(plain(mergeDownloadHistory({ d: { verified: false, time: 99 } }, { d: { verified: true, time: 1 } })).d.verified, true);

  assert.deepEqual(plain(mergeDownloadHistory({}, { e: null, f: 'text', g: [] })), {}, 'junk cannot enter the map');
  assert.deepEqual(plain(mergeDownloadHistory(null, null)), {});
});

const SHORTCUT_FIXTURE = [
  { id: 'toggle', label: 'Open or close the gallery', fallback: 'Shift+G', requiresModifier: true },
  { id: 'search', label: 'Focus the search box', fallback: '/' },
  { id: 'layout', label: 'Cycle the gallery layout', fallback: 'L' },
  { id: 'selectAll', label: 'Select everything in this view', fallback: 'A' },
];

function loadShortcuts() {
  return evaluateSlice(
    'const MODIFIER_KEYS',
    '/* ---- Block patterns',
    ['shortcutCombo', 'shortcutHasModifier', 'normalizedShortcuts', 'shortcutConflict'],
    { SHORTCUT_ACTIONS: SHORTCUT_FIXTURE },
  );
}

test('a key event normalizes to one canonical chord string', () => {
  const { shortcutCombo, shortcutHasModifier } = loadShortcuts();

  assert.equal(shortcutCombo({ key: 'g', shiftKey: true }), 'Shift+G');
  assert.equal(shortcutCombo({ key: '/' }), '/');
  assert.equal(shortcutCombo({ key: 'ArrowLeft', ctrlKey: true }), 'Ctrl+ArrowLeft');
  // Modifier order is fixed by the writer, not by the order they were pressed,
  // so the recorder and the dispatcher always produce the same string.
  assert.equal(shortcutCombo({ key: 'k', metaKey: true, ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+Meta+K');
  // Holding a modifier alone is not yet a chord.
  ['Shift', 'Control', 'Alt', 'Meta', 'Dead'].forEach(key => assert.equal(shortcutCombo({ key, shiftKey: true }), ''));
  assert.equal(shortcutCombo(null), '');
  assert.equal(shortcutCombo({}), '');

  assert.equal(shortcutHasModifier('Shift+G'), true);
  assert.equal(shortcutHasModifier('G'), false);
});

test('stored shortcuts are placed before defaults so a swap survives a reload', () => {
  const { normalizedShortcuts, shortcutConflict } = loadShortcuts();

  assert.deepEqual(plain(normalizedShortcuts({})), { toggle: 'Shift+G', search: '/', layout: 'L', selectAll: 'A' });
  assert.deepEqual(plain(normalizedShortcuts(null)), plain(normalizedShortcuts({})));

  // A page-wide chord without a modifier would fire while reading the thread.
  assert.equal(normalizedShortcuts({ toggle: 'G' }).toggle, 'Shift+G');
  assert.equal(normalizedShortcuts({ toggle: 'Ctrl+Alt+G' }).toggle, 'Ctrl+Alt+G');

  // Swapping two bindings has to survive: both stored values are placed before
  // any default is handed out, so neither is rejected as a collision.
  const swapped = plain(normalizedShortcuts({ search: 'L', layout: '/' }));
  assert.equal(swapped.search, 'L');
  assert.equal(swapped.layout, '/');

  // Taking another action's default leaves that action unbound rather than
  // silently shadowed by a chord two actions would answer to.
  const stolen = plain(normalizedShortcuts({ search: 'L' }));
  assert.equal(stolen.search, 'L');
  assert.equal(stolen.layout, '');
  const bound = Object.values(stolen).filter(Boolean);
  assert.equal(new Set(bound).size, bound.length);

  assert.equal(normalizedShortcuts({ search: 'x'.repeat(41) }).search, '/', 'an absurd stored value falls back');
  assert.equal(normalizedShortcuts({ search: 42 }).search, '/');

  const current = { toggle: 'Shift+G', search: '/', layout: 'L', selectAll: 'A' };
  assert.equal(shortcutConflict(current, 'search', 'L'), true);
  assert.equal(shortcutConflict(current, 'search', '/'), false, 'an action never conflicts with itself');
  assert.equal(shortcutConflict(current, 'search', 'Q'), false);
});

test('the ignore list drops media before it is ever indexed', () => {
  const { blockPatternList, matchesBlockPattern } = evaluateSlice(
    'function blockPatternList',
    'function migrateLegacyStorage',
    ['blockPatternList', 'matchesBlockPattern'],
  );

  assert.deepEqual(plain(blockPatternList('Foo, BAR\n baz ,, foo,a')), ['foo', 'bar', 'baz'],
    'lowercased, de-duplicated, and one-character fragments dropped as too broad');
  assert.deepEqual(plain(blockPatternList('')), []);
  assert.deepEqual(plain(blockPatternList(null)), []);
  assert.equal(blockPatternList(Array.from({ length: 200 }, (value, index) => 'p' + index).join(',')).length, 60);

  const patterns = plain(blockPatternList('signature.example.com, /avatars/'));
  assert.equal(matchesBlockPattern(['https://Signature.Example.com/a.jpg'], patterns), true, 'matching is case-insensitive');
  assert.equal(matchesBlockPattern(['https://cdn.test/avatars/1.png'], patterns), true);
  assert.equal(matchesBlockPattern([null, '', 'https://cdn.test/photo.jpg'], patterns), false);
  assert.equal(matchesBlockPattern('https://cdn.test/avatars/1.png', patterns), true, 'a bare string is accepted');
  assert.equal(matchesBlockPattern(['https://signature.example.com/a.jpg'], []), false, 'an empty list blocks nothing');
});

test('the Bunkr file id is found wherever the page build moves it', () => {
  const { findBunkrFileRecord, bunkrFileRecordFromHtml } = evaluateSlice(
    'function findBunkrFileRecord',
    'function bunkrFilePage',
    ['findBunkrFileRecord', 'bunkrFileRecordFromHtml'],
  );

  // A numeric id sitting next to a filename is the file record, at any depth.
  assert.deepEqual(plain(findBunkrFileRecord({ props: { pageProps: { file: { id: 123456, name: 'clip.mp4' } } } })),
    { id: '123456', name: 'clip.mp4' });
  assert.deepEqual(plain(findBunkrFileRecord({ a: [{ b: { id: '987654', filename: 'shot.jpg' } }] })),
    { id: '987654', name: 'shot.jpg' });
  // A short id is a page or album number, not a file.
  assert.equal(findBunkrFileRecord({ id: 12, name: 'clip.mp4' }), null);
  assert.equal(findBunkrFileRecord({ id: 123456 }), null, 'an id with no filename beside it is not a file record');
  assert.equal(findBunkrFileRecord(null), null);
  // Deep recursion is bounded rather than allowed to blow the stack.
  let deep = { id: 123456, name: 'deep.mp4' };
  for (let level = 0; level < 40; level++) deep = { nested: deep };
  assert.equal(findBunkrFileRecord(deep), null);

  const nextData = '<script id="__NEXT_DATA__" type="application/json">' +
    JSON.stringify({ props: { pageProps: { file: { id: 4455667, name: 'a.mp4' } } } }) + '</script>';
  assert.deepEqual(plain(bunkrFileRecordFromHtml(nextData)), { id: '4455667', name: 'a.mp4' });

  // Two fallbacks for when the page ships no usable build payload.
  assert.deepEqual(plain(bunkrFileRecordFromHtml('<a href="https://dl.bunkr.cr/file/778899">get</a>')), { id: '778899', name: '' });
  assert.deepEqual(plain(bunkrFileRecordFromHtml('{"id": 111, "x":1} {"id": 2233445}')), { id: '2233445', name: '' });
  assert.equal(bunkrFileRecordFromHtml('<html><body>nothing</body></html>'), null);
  assert.equal(bunkrFileRecordFromHtml(''), null);
  // Malformed build JSON must not throw; the flat probes still get a chance.
  assert.deepEqual(plain(bunkrFileRecordFromHtml('<script id="__NEXT_DATA__">{not json</script>{"id":5566778}')), { id: '5566778', name: '' });
});

test('Bunkr is resolved before the generic host catch-all claims it', () => {
  const registry = source.slice(source.indexOf('const HOST_REGISTRY'), source.indexOf('function hostDefinition'));
  assert.ok(registry.includes("id: 'bunkr'"), 'Bunkr has its own registry entry');
  assert.ok(registry.indexOf("id: 'bunkr'") < registry.indexOf("id: 'generic-video-host'"),
    'the generic entry would otherwise match first and the resolver would never run');
  // The chain is three hops and each one has to be reachable.
  assert.match(source, /dl\.bunkr\.cr/);
  assert.match(source, /api\/_001_v2/);
  assert.match(source, /glb-apisign\.cdn\.cr/);
});

test('the saved name follows the verified bytes, not the thread markup', () => {
  const { safeFilename } = evaluateSlice(
    'function safeFilename',
    'function formatBytes',
    ['safeFilename'],
    {
      IMAGE_EXT_BARE: /^(?:jpe?g|png|gif|webp|avif|bmp)$/i,
      threadFilePrefix: () => 'thread',
      pageNumberFromUrl: () => 1,
    },
  );

  const item = { type: 'embed', pageNumber: 2, postNumber: '41', mediaIndex: 0 };
  // A Bunkr link the thread showed as a video embed can turn out to be a JPEG;
  // the name must not keep insisting it is a video.
  assert.equal(safeFilename(item, 'https://cdn.test/x', 'jpg'), 'thread-p2-r41-img01.jpg');
  assert.equal(safeFilename(item, 'https://cdn.test/x', 'mp4'), 'thread-p2-r41-vid01.mp4');
  // With nothing verified yet the item's own type is still the best guess.
  assert.equal(safeFilename(item, 'https://cdn.test/x'), 'thread-p2-r41-vid01.mp4');
  assert.equal(safeFilename({ ...item, type: 'image' }, 'https://cdn.test/x'), 'thread-p2-r41-img01.jpg');
  assert.equal(safeFilename(item, 'https://cdn.test/x', 'jpeg'), 'thread-p2-r41-img01.jpg', 'jpeg is normalized to jpg');
});

test('leaving the page mid-download asks first', () => {
  // Download jobs live only in memory, so a reload silently discards partial
  // files and any ZIP that has not been written yet.
  const guard = source.slice(source.indexOf("window.addEventListener('beforeunload'"));
  assert.ok(guard, 'no unload guard is registered');
  assert.match(guard, /state\.downloading/);
  ['queued', 'preparing', 'downloading', 'packing'].forEach(status => {
    assert.ok(guard.includes("'" + status + "'"), 'unload guard ignores ' + status + ' jobs');
  });
  assert.match(guard, /event\.preventDefault\(\)/);
});

test('the media URL export prefers a confirmed file over the host page', () => {
  const { mediaExportUrl } = evaluateSlice(
    'function mediaExportUrl',
    'function mediaExportScope',
    ['mediaExportUrl'],
    { normalizeSourceUrl: value => String(value || '') },
  );

  assert.equal(mediaExportUrl({ resolution: { candidate: { status: 'confirmed', url: 'https://cdn.test/a.mp4' } }, url: 'https://host.test/f/a' }),
    'https://cdn.test/a.mp4');
  // Anything short of confirmed exports the page instead, which is what an
  // external downloader wants to be handed anyway.
  assert.equal(mediaExportUrl({ resolution: { candidate: { status: 'heuristic', url: 'https://cdn.test/thumb.jpg' } }, originalLink: 'https://host.test/img/a' }),
    'https://host.test/img/a');
  assert.equal(mediaExportUrl({ url: 'https://host.test/f/a' }), 'https://host.test/f/a');
  assert.equal(mediaExportUrl({ thumb: 'https://host.test/t.jpg' }), 'https://host.test/t.jpg');
  assert.equal(mediaExportUrl({}), '');
  assert.equal(mediaExportUrl(null), '');
});

test('a signed CDN URL is dropped from the cache before it dies', () => {
  const { signedUrlExpiry } = evaluateSlice(
    'function signedUrlExpiry',
    'const BUNKR_API_ORIGIN',
    ['signedUrlExpiry'],
  );

  const now = 1_700_000_000_000;
  // Bunkr's `ex` is unix seconds; some signing endpoints hand back milliseconds.
  assert.equal(signedUrlExpiry(1_700_003_600, now), 1_700_003_600_000);
  assert.equal(signedUrlExpiry(1_700_003_600_000, now), 1_700_003_600_000);
  // An unusable value leaves the resolution cached exactly as it was before,
  // rather than expiring a URL that still works.
  assert.equal(signedUrlExpiry(1_699_999_000, now), 0, 'already past');
  assert.equal(signedUrlExpiry(1_800_000_000, now), 0, 'implausibly far out');
  [0, -1, null, undefined, 'soon', NaN, {}].forEach(value => assert.equal(signedUrlExpiry(value, now), 0));

  // And the cache honours it: an expiring candidate is not simply returned.
  const resolver = source.slice(source.indexOf('async function resolveCandidate(item)'), source.indexOf('async function resolveCandidateUncached'));
  assert.match(resolver, /expiresAt/);
  assert.match(resolver, /attempted = false/);
  assert.ok(resolver.indexOf('expiresAt') < resolver.indexOf('if (item.resolution.attempted && item.resolution.candidate) return'),
    'the expiry check has to run before the cached candidate is handed back');
});

function loadWindowing(state) {
  return evaluateSlice(
    'function usesWindowedRenderer',
    'function flowGrid',
    ['usesWindowedRenderer', 'effectivePerPage', 'UNWINDOWED_ALL_LIMIT'],
    { state, VIRTUALIZED_LAYOUTS: ['flow', 'timeline'], DEFAULT_SETTINGS: { perPage: 60 } },
  );
}

test('virtualization has one answer, and reply grouping is not it', () => {
  const state = { layoutMode: 'masonry', groupBy: 'none', scanning: false, perPage: 60 };
  const { usesWindowedRenderer } = loadWindowing(state);

  // Masonry -> Timeline -> Masonry.
  assert.equal(usesWindowedRenderer(), false);
  state.layoutMode = 'timeline';
  assert.equal(usesWindowedRenderer(), true);
  state.layoutMode = 'masonry';
  assert.equal(usesWindowedRenderer(), false);

  // Timeline -> group by reply. Grouping needs the sectioned markup path, so
  // the windowed renderer is genuinely not in use however the layout reads.
  state.layoutMode = 'timeline';
  state.groupBy = 'reply';
  assert.equal(usesWindowedRenderer(), false);
  // Grouped -> ungrouped Timeline.
  state.groupBy = 'none';
  assert.equal(usesWindowedRenderer(), true);

  // A scan renders skeletons, not cards.
  state.scanning = true;
  assert.equal(usesWindowedRenderer(), false);
  state.scanning = false;

  // Flow behaves identically; masonry, grid and feed never window.
  ['flow', 'timeline'].forEach(layoutMode => assert.equal(usesWindowedRenderer({ layoutMode }), true));
  ['masonry', 'grid', 'feed'].forEach(layoutMode => assert.equal(usesWindowedRenderer({ layoutMode }), false));
  assert.equal(usesWindowedRenderer({ layoutMode: 'timeline', groupBy: 'reply' }), false);
  assert.equal(usesWindowedRenderer({ layoutMode: 'timeline', scanning: true }), false);
});

test('All is paged when nothing is bounding the DOM, and the setting survives', () => {
  const state = { layoutMode: 'timeline', groupBy: 'none', scanning: false, perPage: 0 };
  const { usesWindowedRenderer, effectivePerPage, UNWINDOWED_ALL_LIMIT } = loadWindowing(state);
  const huge = UNWINDOWED_ALL_LIMIT + 1;

  // Windowed: All costs nothing, however many matched.
  assert.equal(effectivePerPage(huge), 0);
  assert.equal(effectivePerPage(50_000), 0);

  // Turning on reply grouping is the trap: the same "All" now means every card
  // in the DOM, and it used to render with no warning at all.
  state.groupBy = 'reply';
  assert.equal(usesWindowedRenderer(), false);
  assert.equal(effectivePerPage(huge), 60, 'falls back to the default finite page size');
  assert.equal(effectivePerPage(UNWINDOWED_ALL_LIMIT), 0, 'a set small enough to mount is left alone');

  // The stored preference is never rewritten, so returning to a windowed
  // layout restores All rather than leaving the user on 60 forever.
  assert.equal(state.perPage, 0);
  state.groupBy = 'none';
  assert.equal(effectivePerPage(huge), 0);

  // A finite size is passed through untouched everywhere.
  state.perPage = 100;
  assert.equal(effectivePerPage(huge), 100);
  state.groupBy = 'reply';
  assert.equal(effectivePerPage(huge), 100);
});

test('the pager and the size warning ask the renderer, not the layout name', () => {
  // Every consumer has to share the one predicate, or they drift apart again.
  assert.match(source, /const virtualized = usesWindowedRenderer\(\);/);
  assert.match(source, /pageSize\.disabled = state\.scanning \|\| virtualized;/);
  assert.match(source, /perPage === 0 && !usesWindowedRenderer\(\) &&/);
  assert.doesNotMatch(source, /isWindowedLayout/, 'the weaker predicate is gone entirely');

  // Status wording tells the truth in both modes.
  assert.match(source, /matched · virtualized/);
  assert.match(source, /All paged at \$\{state\.appliedPerPage\}/);
  // And the settings copy no longer claims windowing unconditionally.
  assert.match(source, /use the paged renderer instead, so Per view applies again\./);
});

test('per-item URL work happens once, at index time', () => {
  // hostDefinition costs four URL constructions and hasDirectResolver reaches
  // roughly twenty-eight, and all of it used to run inside loops over the whole
  // indexed set -- once per scroll frame, once per keystroke.
  const indexBody = source.slice(
    source.indexOf('function appendUniqueItems'),
    source.indexOf('function dedupe'),
  );
  assert.match(indexBody, /item\.sourceHost = /);
  assert.match(indexBody, /item\.historyKey = /);
  assert.match(indexBody, /item\.directResolver = hasDirectResolver\(item\)/);

  // And the readers prefer the derived value, falling back for items that never
  // went through appendUniqueItems.
  assert.match(source, /if \(item\.sourceHost !== undefined\) return item\.sourceHost;/);
  assert.match(source, /if \(item && item\.historyKey\) return item\.historyKey;/);

  // One collator, not one per comparison.
  assert.match(source, /const textCollator = new Intl\.Collator\(undefined, \{ sensitivity: 'base' \}\)/);
  assert.doesNotMatch(source, /localeCompare\([^)]*\{ sensitivity: 'base' \}\)/);
});

test('a scroll frame that changes nothing does nothing', () => {
  const body = source.slice(
    source.indexOf('function updateFlowWindow'),
    source.indexOf('function relayoutFlow'),
  );
  // The range guard, and the scan that used to run behind it.
  assert.match(body, /if \(range\.start === flow\.range\.start && range\.end === flow\.range\.end && flow\.mounted\.size\) return;/);
  // Comments are stripped first: the code below says in words that the call
  // is deliberately absent, and that sentence must not satisfy the assertion.
  const code = body.split(String.fromCharCode(10)).filter(line => !line.trim().startsWith('//')).join(' ');
  assert.doesNotMatch(code, /updateSelectionUi\(\)/, 'the per-frame selection scan is gone');

  // The dock count is O(1) rather than a walk of every indexed item.
  assert.match(source, /const count = state\.selected\.size;/);
});

test('ratios settle together instead of re-packing per frame', () => {
  // A late ratio re-packs the entire list and they arrive continuously during
  // the first scroll; a resize is different and stays immediate.
  assert.match(source, /const RATIO_RELAYOUT_DELAY = 150;/);
  assert.match(source, /function scheduleFlowRatioLayout\(\)/);
  // The image load handler is the one that coalesces.
  assert.match(source, /scg-ratio', String\(item\.ratio\.value\)\);\s*\r?\n\s*scheduleFlowRatioLayout\(\);/);
  // The resize observer and shell state still ask for an immediate re-pack.
  assert.match(source, /if \(grid\.clientWidth === flow\.width\) return;\s*\r?\n\s*scheduleFlowLayout\(\);/);
  // And the timer is cleared with the rest of the renderer.
  assert.match(source, /if \(ratioLayoutTimer\) clearTimeout\(ratioLayoutTimer\);/);
});

test('repeated string building is cached or hoisted, not rebuilt per card', () => {
  // escapeHtml allocated a fresh map for every matched character.
  assert.match(source, /const HTML_ESCAPES = Object\.freeze\(/);
  assert.match(source, /replace\(\/\[&<>'"\]\/g, character => HTML_ESCAPES\[character\]\)/);
  // Icons are pure in name and class, and a card mounts several.
  assert.match(source, /const iconCache = new Map\(\);/);
  assert.match(source, /const iconWellCache = new Map\(\);/);
  // Counts move only with the dataset.
  assert.match(source, /if \(countsCache && countsCache\.revision === datasetRevision\) return countsCache\.value;/);
  // History entries this script wrote are already in shape.
  assert.match(source, /if \(Object\.values\(history\)\.every\(isNormalizedEntry\)\) return history;/);
});

test('the uniform grid can skip off-screen cards, masonry cannot', () => {
  // The grid mounts every matched card and its cards have a fixed height, so
  // the browser can be told what to reserve. Masonry sits in CSS multi-column,
  // which has to see every box to balance the columns.
  assert.match(source, /\[data-layout="grid"\] \.scg-grid:not\(\.flowing\) \.scg-card\{\s*\r?\n\s*content-visibility:auto;/);
  const masonryRules = source.match(/\[data-layout="masonry"\][^\n]*content-visibility/g);
  assert.equal(masonryRules, null, 'multi-column balancing must not be given content-visibility');
});

test('nothing the reader can see names a layout that was deleted', () => {
  // 0.12.0 removed Flow, Timeline and Feed but left three strings advertising
  // them: the All clamp toast, the Per view warning and the Appearance copy.
  // Each one sent the reader hunting through a picker that has two entries.
  assert.doesNotMatch(source, /Flow (?:or|and) Timeline/);
  assert.doesNotMatch(source, /data-layout="(?:flow|timeline|feed)"/);
  // The advice that replaced them has to name a layout that exists.
  assert.match(source, /Masonry without reply grouping renders only what is on screen/);

  // Icons those layouts drew went with them, along with two that predate the
  // accent system.
  for (const name of ['sun', 'moon', 'masonry', 'grid', 'timeline', 'feed', 'resolution']) {
    assert.doesNotMatch(source, new RegExp(`^\\\\s+${name}: '<`, 'm'), `${name} icon is drawn by nothing`);
  }
});

test('a queued window update cannot swallow a re-pack', () => {
  const flow = { frame: 0, pendingLayout: false };
  const ran = [];
  let queued = null;
  const { scheduleFlowLayout, scheduleFlowWindow } = evaluateSlice(
    'function scheduleFlowFrame',
    'function teardownFlow',
    ['scheduleFlowLayout', 'scheduleFlowWindow'],
    {
      flow,
      usesWindowedRenderer: () => true,
      relayoutFlow: () => ran.push('layout'),
      updateFlowWindow: () => ran.push('window'),
      requestAnimationFrame: callback => { queued = callback; return 7; },
    },
  );

  // A scroll takes the slot, then an image ratio arrives in the same frame.
  // The old shared boolean dropped the re-pack and the measurement was lost.
  scheduleFlowWindow();
  scheduleFlowLayout();
  queued();
  assert.deepEqual(plain(ran), ['layout'], 'the layout request outranks the window request');

  // The flag does not persist into the next frame.
  ran.length = 0;
  scheduleFlowWindow();
  queued();
  assert.deepEqual(plain(ran), ['window']);

  // And a layout request alone still relayouts.
  ran.length = 0;
  scheduleFlowLayout();
  queued();
  assert.deepEqual(plain(ran), ['layout']);
});

test('an expired signed URL sends the card back to its Play button', () => {
  const { resolutionIsLive, embedPlaybackIsLive } = evaluateSlice(
    'function resolutionIsLive',
    'async function startEmbeddedPlayer',
    ['resolutionIsLive', 'embedPlaybackIsLive'],
    { VIDEO_EXT: /\.(?:mp4|webm|mov|m4v)(?:$|[?#./])/i, escapeHtml: String, embedFallbackMarkup: () => '' },
  );

  // A resolution with no expiry is a plain URL and never goes stale.
  assert.equal(resolutionIsLive({ url: 'https://host/a.mp4' }), true);
  assert.equal(resolutionIsLive(null), false);
  // Signed URLs are dropped a minute early, the same margin resolveCandidate uses.
  assert.equal(resolutionIsLive({ expiresAt: Date.now() + 600000 }), true);
  assert.equal(resolutionIsLive({ expiresAt: Date.now() + 30000 }), false);
  assert.equal(resolutionIsLive({ expiresAt: Date.now() - 1 }), false);

  const live = { resolution: { candidate: { status: 'confirmed', url: 'https://cdn/a.mp4', expiresAt: Date.now() + 600000 } } };
  const stale = { resolution: { candidate: { status: 'confirmed', url: 'https://cdn/a.mp4', expiresAt: Date.now() - 1 } } };
  assert.equal(embedPlaybackIsLive(live), true);
  assert.equal(embedPlaybackIsLive(stale), false, 'a re-mounted card must not render a dead URL');
  // A file that already refused to play inline is not retried either.
  assert.equal(embedPlaybackIsLive({ ...live, embedPlaybackFailed: true }), false);

  // The card asks before re-mounting a player rather than trusting activePlayers alone.
  assert.match(source, /state\.activePlayers\.has\(item\.selectionKey\) && embedPlaybackIsLive\(item\)/);
});

test('the pending history set is only cleared once the write lands', () => {
  const body = source.slice(
    source.indexOf('function persistDownloadHistory'),
    source.indexOf('function reloadDownloadHistory'),
  );
  // Clearing first meant a swallowed quota failure dropped those markers for
  // good: no later write would ever carry them to storage.
  assert.ok(
    body.indexOf('storage.set(DOWNLOAD_HISTORY_KEY') < body.indexOf('pendingHistoryWrites = {}'),
    'the write must happen before the pending set is emptied',
  );
});

test('one media counter per reply, not one per extraction pass', () => {
  const body = source.slice(
    source.indexOf('function extractFromDocument'),
    source.indexOf('function purgeBlockedItems'),
  );
  // Four passes each restarting at zero gave a <video> and direct .mp4 link
  // in one reply the same -vid01 filename.
  assert.doesNotMatch(body, /forEach\(\((?:img|video|frame|anchor), mediaIndex\)/);
  assert.match(body, /let mediaIndex = 0;/);
  // Images capture the number first because mediaKey also uses it.
  assert.match(body, /const order = mediaIndex\+\+;/);
  assert.equal((body.match(/mediaIndex: mediaIndex\+\+/g) || []).length, 4);
});

test('folder expansion and its token flow are absent', () => {
  for (const marker of [
    'data-expand-container',
    'requestGofileContents',
    'bunkrContainerChildren',
    'pixeldrainContainerChildren',
    'containerExpansions',
    'gofileToken',
  ]) assert.doesNotMatch(source, new RegExp(marker));
  assert.doesNotMatch(source, /type: 'container'/);
  assert.doesNotMatch(source, /data-filter="container"/);
  assert.match(source, /const isMediaItem = item => item\?\.type === 'image' \|\| item\?\.type === 'video' \|\| item\?\.type === 'embed'/);
  assert.equal((source.match(/\['all', 'image', 'video', 'link', 'text', 'post'\]/g) || []).length, 2);
});

test('direct host-file identities retain pre-1.0 selections and history', () => {
  const { downloadHistoryEntry } = evaluateSlice(
    'function downloadHistoryEntry',
    'function wasDownloaded',
    ['downloadHistoryEntry'],
    {
      state: { downloadHistory: { 'thread|videoish|https://pixeldrain.com/u/old': { verified: true } } },
      downloadHistoryKey: item => item.historyKey,
    },
  );
  const item = {
    historyKey: 'thread|pixeldrain|old',
    historyAliases: ['thread|videoish|https://pixeldrain.com/u/old'],
  };

  assert.equal(downloadHistoryEntry(item).verified, true);
  assert.match(source, /aliases\.some\(alias => persistedSelectionKeys\.has\(alias\)\)/);
  assert.match(source, /if \(mediaId && \(definition\?\.id === 'bunkr' \|\| definition\?\.id === 'pixeldrain'\)\)/);
});

test('the per-thread item index is schema-bound, ignore-bound, and budgeted', () => {
  assert.match(source, /const ITEM_INDEX_SCHEMA = 2/);
  assert.match(source, /const ITEM_INDEX_EXTRACTION_VERSION = 'items-v2'/);
  assert.match(source, /const ITEM_INDEX_MAX_BYTES = 420000/);
  assert.match(source, /const ITEM_INDEX_THREAD_LIMIT = 6/);
  assert.match(source, /entry\.schema === ITEM_INDEX_SCHEMA/);
  assert.match(source, /entry\.extractionVersion === ITEM_INDEX_EXTRACTION_VERSION/);
  assert.match(source, /entry\.ignoreSignature === itemIndexIgnoreSignature\(\)/);
  assert.match(source, /const candidates = items\.map\(\(item, order\) => \(\{ item, order \}\)\)/);
  assert.match(source, /registry\.slice\(ITEM_INDEX_THREAD_LIMIT\)\.forEach\(row => storage\.remove\(row\.key\)\)/);
  assert.match(source, /restoreItemIndex\(\);/);
});

test('the item index stays within its byte budget and prioritizes media', () => {
  const { boundedItemIndexEntry } = evaluateSlice(
    'const INDEX_ITEM_FIELDS',
    'function persistItemIndex()',
    ['boundedItemIndexEntry'],
    {
      TextEncoder,
      ITEM_INDEX_SCHEMA: 2,
      ITEM_INDEX_EXTRACTION_VERSION: 'items-v2',
      ITEM_INDEX_MAX_BYTES: 1200,
      itemIndexIgnoreSignature: () => 'ignore-signature',
      isMediaItem: item => ['image', 'video', 'embed'].includes(item?.type),
    },
  );
  const result = boundedItemIndexEntry(
    [
      { type: 'text', text: 'x'.repeat(900), postId: 'text' },
      { type: 'image', url: `https://example.test/${'a'.repeat(900)}.jpg` },
      { type: 'image', url: 'https://example.test/kept.jpg' },
    ],
    { threadPageCount: 1 },
  );

  assert.equal(result.truncated, true);
  assert.ok(result.items.some(item => item.url === 'https://example.test/kept.jpg'));
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 1200);
});

test('an unresolved Bunkr file can be selected, but an album cannot', () => {
  const { isDownloadableMedia } = evaluateSlice(
    'const isMediaItem =',
    'function downloadHistoryKey',
    ['isDownloadableMedia', 'isBunkrFileUrl'],
    {
      VIDEO_EXT: /\.(?:mp4|webm|mov|m4v)(?:$|[?#./])/i,
      hostDefinition: url => (/bunkr/i.test(String(url)) ? { id: 'bunkr' } : (/turbo/i.test(String(url)) ? { id: 'turbo' } : null)),
      hostMediaId: url => String(url).match(/\/f\/([^/?#]+)/)?.[1] || '',
    },
  );

  // The bug: Bunkr had a working resolver and an individual Download button,
  // but no checkbox, so it could never enter the bulk ZIP queue.
  const file = { type: 'embed', url: 'https://bunkr.cr/f/abc123' };
  assert.equal(isDownloadableMedia(file), true);
  // Reached through a thumbnail link rather than a bare link.
  assert.equal(isDownloadableMedia({ type: 'embed', url: 'https://example.test/x', originalLink: 'https://bunkr.cr/f/abc123' }), true);

  // An album page has no single file behind it and must stay out of the queue.
  assert.equal(isDownloadableMedia({ type: 'embed', url: 'https://bunkr.cr/a/album1' }), false);

  // A resolution that already failed stays failed; eligibility must not
  // resurrect a dead link on the next pass.
  assert.equal(isDownloadableMedia({ ...file, resolution: { attempted: true, candidate: { status: 'failed' } } }), false);
  assert.equal(isDownloadableMedia({ ...file, resolution: { attempted: true, candidate: {} } }), false);
  // A confirmed resolution is downloadable whatever the host.
  assert.equal(isDownloadableMedia({ type: 'embed', url: 'https://other.test/v/1', resolution: { candidate: { status: 'confirmed', url: 'https://cdn.test/a.mp4' } } }), true);
  // An unknown host with nothing resolved is still not selectable.
  assert.equal(isDownloadableMedia({ type: 'embed', url: 'https://other.test/v/1' }), false);
});

function loadHistoryPersistence(store, state) {
  const broadcasts = [];
  const api = evaluateSlice(
    'let pendingHistoryWrites',
    'function persistSettings',
    ['persistDownloadHistory', 'reloadDownloadHistory', 'readStoredDownloadHistory', 'rememberDownloaded'],
    {
      state,
      DOWNLOAD_HISTORY_KEY: 'history',
      APP_ID: 'app',
      Date: { now: () => 99 },
      storage: {
        get: (key, fallback) => (key in store ? JSON.parse(JSON.stringify(store[key])) : fallback),
        set: (key, value) => { store[key] = JSON.parse(JSON.stringify(value)); },
      },
      tabSync: { post: type => broadcasts.push(type) },
      normalizeDownloadHistory: history => history,
      mergeDownloadHistory: (base, additions) => {
        const merged = { ...(base || {}) };
        Object.entries(additions || {}).forEach(([key, entry]) => { if (entry) merged[key] = entry; });
        return merged;
      },
      downloadHistoryKey: item => item.key,
      invalidateVisibleItems: () => {},
      updateDownloadedIndicators: () => {},
      refreshSettingsPanel: () => {},
      document: { querySelector: () => null },
    },
  );
  return { ...api, broadcasts };
}

test('a stale tab cannot resurrect a history cleared somewhere else', () => {
  // Two tabs open on the same thread, both holding the same history.
  const seeded = { old1: { verified: true, time: 10 }, old2: { verified: true, time: 20 } };
  const store = { history: { ...seeded } };
  const tabB = { downloadHistory: { ...seeded } };
  const b = loadHistoryPersistence(store, tabB);

  // Tab A clears history. Tab B is suspended and misses the broadcast, so it
  // still holds both cleared records in memory.
  delete store.history;

  // Tab B saves one new file through the ordinary path. Writing its whole
  // in-memory map back is what used to restore everything just cleared.
  b.rememberDownloaded({ key: 'fresh' }, 'fresh.jpg', { verified: true, size: 12 });

  assert.deepEqual(Object.keys(store.history), ['fresh'], 'only the newly saved record reaches storage');
  assert.equal(store.history.fresh.filename, 'fresh.jpg');
  assert.deepEqual(Object.keys(tabB.downloadHistory), ['fresh'], 'and the stale tab converges on the record');
  assert.deepEqual(b.broadcasts, ['download-history-changed']);

  // A deferred batch still contributes when it is finally written, so an
  // in-flight ZIP does not lose its markers to this.
  b.rememberDownloaded({ key: 'part1' }, 'a.jpg', { verified: true, size: 1 }, true);
  b.rememberDownloaded({ key: 'part2' }, 'b.jpg', { verified: true, size: 1 }, true);
  assert.deepEqual(Object.keys(store.history), ['fresh'], 'nothing is written until the batch persists');
  b.persistDownloadHistory();
  assert.deepEqual(Object.keys(store.history).sort(), ['fresh', 'part1', 'part2']);

  // An unverified result is not a record at all.
  assert.equal(b.rememberDownloaded({ key: 'nope' }, 'c.jpg', { verified: false }), false);
  assert.equal('nope' in store.history, false);
});

test('an invalidation reloads the record rather than trusting memory', () => {
  const store = { history: { old1: { verified: true, time: 10 } } };
  const tab = { downloadHistory: { old1: { verified: true, time: 10 }, old2: { verified: true, time: 20 } } };
  const api = loadHistoryPersistence(store, tab);

  delete store.history;
  api.reloadDownloadHistory();
  assert.deepEqual(Object.keys(tab.downloadHistory), [], 'cleared elsewhere means cleared here');

  // Records this tab created but has not written yet survive the reload.
  store.history = { fromOtherTab: { verified: true, time: 5 } };
  api.rememberDownloaded({ key: 'mine' }, 'mine.jpg', { verified: true, size: 1 }, true);
  api.reloadDownloadHistory();
  assert.deepEqual(Object.keys(tab.downloadHistory).sort(), ['fromOtherTab', 'mine']);
});

test('restoring a large backup reaches other tabs in full', () => {
  const store = {};
  const imported = {};
  for (let index = 0; index < 400; index++) imported['key' + index] = { verified: true, time: index };
  const tabA = { downloadHistory: imported };
  const a = loadHistoryPersistence(store, tabA);

  a.persistDownloadHistory({ replace: true });
  assert.equal(Object.keys(store.history).length, 400, 'the whole import is written');

  // The broadcast carries no payload, so nothing can be truncated in transit.
  assert.deepEqual(a.broadcasts, ['download-history-changed']);
  assert.doesNotMatch(source, /entries: Object\.fromEntries\(entries\.slice/,
    'a bounded payload would silently truncate a large import in every other tab');

  // The receiving tab reloads the full record from storage.
  const tabB = { downloadHistory: {} };
  const b = loadHistoryPersistence(store, tabB);
  b.reloadDownloadHistory();
  assert.equal(Object.keys(tabB.downloadHistory).length, 400);
});

test('byte validation rejects error bodies and lets ambiguous hosts be decided by the bytes', async () => {
  const { validateMediaBlob } = evaluateSlice(
    'function bytesMatch',
    'async function fetchValidatedMedia',
    ['validateMediaBlob'],
    { Blob, TextDecoder, Uint8Array },
  );
  const blobOf = (bytes, type = '') => new Blob([Uint8Array.from(bytes)], { type });
  const jpeg = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10];
  const mp4 = [0, 0, 0, 0x20, ...Buffer.from('ftypisom')];
  const rejects = (promise, pattern) => assert.rejects(promise, pattern);

  // A host that is rate-limiting or has expired a signed URL answers with a
  // page or a JSON error, not media. Saving that as a .mp4 is the worst case.
  await rejects(validateMediaBlob(new Blob([Buffer.from('<!doctype html><html>no')]), 'video'), /HTML, text, or JSON/);
  await rejects(validateMediaBlob(new Blob([Buffer.from('{"error":"expired"}')]), 'video'), /HTML, text, or JSON/);
  await rejects(validateMediaBlob(new Blob([Buffer.from('[1,2]')]), 'image'), /HTML, text, or JSON/);
  await rejects(validateMediaBlob(new Blob([Buffer.from('anything')], { type: 'text/html; charset=utf-8' }), 'video'), /HTML, text, or JSON/);
  await rejects(validateMediaBlob(new Blob([Buffer.from('anything')], { type: 'application/json' }), 'video'), /HTML, text, or JSON/);
  await rejects(validateMediaBlob(new Blob([]), 'video'), /empty file/);
  await rejects(validateMediaBlob(blobOf([1, 2, 3, 4, 5, 6, 7, 8]), 'video'), /do not match a supported/);

  // A stated expectation is still enforced.
  await rejects(validateMediaBlob(blobOf(jpeg), 'video'), /Expected video, but the response contains image/);
  await rejects(validateMediaBlob(blobOf(mp4), 'image'), /Expected image, but the response contains video/);

  // Bunkr serves images and videos behind one link shape, so its resolver
  // states no expectation and the signature decides. The bytes still have to
  // be real media: only the guess is waived, never the check.
  const asImage = await validateMediaBlob(blobOf(jpeg), '');
  assert.equal(asImage.verified, true);
  assert.equal(asImage.extension, 'jpg');
  assert.equal(asImage.method, 'byte-signature:jpeg');
  const asVideo = await validateMediaBlob(blobOf(mp4), '');
  assert.equal(asVideo.extension, 'mp4');
  await rejects(validateMediaBlob(new Blob([Buffer.from('<html>')]), ''), /HTML, text, or JSON/);

  // And the expectation itself comes from the resolver, not the item type.
  assert.match(source, /resolution\.mediaTypeUnknown \? '' : \(item\.type === 'image' \? 'image' : 'video'\)/);
  assert.match(source, /if \(expectedMediaType && signature\.mediaType !== expectedMediaType\)/);
  // The ZIP path names the file from the verified extension, so an image that
  // arrived where an embed was expected is not saved as vidNN.mp4.
  assert.match(source, /job\.filename = safeFilename\(item, resolution\.url, validation\.extension\);/);
});

test('only a single Bunkr file link enters the Bunkr resolver', () => {
  // An album link routed into the file resolver hard-failed with "album page
  // rather than a single file", skipping the ordinary image-page and thumbnail
  // paths that used to handle it. Both branches gate on the /f/ id now.
  assert.match(source, /if \(isBunkrFileUrl\(item\.originalLink\)\) return resolveBunkrFile\(item\);/);
  assert.match(source, /if \(isBunkrFileUrl\(item\.url\) \|\| isBunkrFileUrl\(item\.originalLink\)\) return resolveBunkrFile\(item\);/);
  // The weaker host-only test must not survive anywhere a resolver is chosen.
  const resolver = source.slice(source.indexOf('async function resolveCandidateUncached'), source.indexOf('async function resolveForDisplay'));
  assert.doesNotMatch(resolver, /id === 'bunkr'/);

  const { isBunkrFileUrl } = evaluateSlice(
    'const isMediaItem =',
    'function downloadHistoryKey',
    ['isBunkrFileUrl'],
    {
      VIDEO_EXT: /\.(?:mp4|webm|mov|m4v)(?:$|[?#./])/i,
      hostDefinition: url => (/bunkr/i.test(String(url)) ? { id: 'bunkr' } : null),
      hostMediaId: url => String(url).match(/\/f\/([^/?#]+)/)?.[1] || '',
    },
  );
  assert.equal(isBunkrFileUrl('https://bunkr.cr/f/abc123'), true);
  assert.equal(isBunkrFileUrl('https://bunkr.cr/a/album1'), false);
  assert.equal(isBunkrFileUrl('https://bunkr.cr/'), false);
  assert.equal(isBunkrFileUrl('https://example.test/f/abc'), false);
  assert.equal(isBunkrFileUrl(''), false);
  assert.equal(isBunkrFileUrl(null), false);
});

test('the All warning arrives before the cards do, and never doubles up', () => {
  const handlerStart = source.indexOf("app.querySelector('[data-page-size]').onchange");
  // applyShellState queries the same slider earlier, so the end marker has to
  // be searched from the handler, not from the top of the file.
  const handler = source.slice(handlerStart, source.indexOf("app.querySelectorAll('[data-card-scale]')", handlerStart));
  assert.ok(handler.length > 100 && handler.length < 2000);
  // Warning after commitState meant warning after the mount had already
  // happened, which is exactly the moment a phone stalls.
  assert.ok(handler.indexOf('notify(') < handler.indexOf('commitState('),
    'the notice has to precede the render it is warning about');
  // The old check read the previous page's row count, not what is about to mount.
  assert.match(handler, /const matched = visibleItems\(\)\.length;/);
  assert.doesNotMatch(handler, /state\.renderedItems\.length/);
  // Disjoint from the clamp, so a large set gets the fallback notice instead of
  // both firing at once.
  assert.match(handler, /matched > UNWINDOWED_ALL_NOTICE && matched <= UNWINDOWED_ALL_LIMIT/);
  assert.match(source, /const UNWINDOWED_ALL_NOTICE = 800;/);
});

test('the viewer takes over playback instead of running a second copy', () => {
  // Opening the viewer on a video already playing in a card left the card
  // playing behind it and started the viewer from zero.
  const opener = source.slice(source.indexOf('function openLightbox'), source.indexOf('function goToViewerIndex'));
  assert.match(opener, /suspendGridPlayback\(\);/);
  assert.ok(opener.indexOf('suspendGridPlayback()') < opener.indexOf('renderLightbox()'),
    'the grid has to be stopped before the viewer mounts its own player');

  const suspend = source.slice(source.indexOf('function suspendGridPlayback'), source.indexOf('function embedPlaceholderMarkup'));
  assert.match(suspend, /rememberPlaybackPosition\(key, video\)/);
  assert.match(suspend, /video\.pause\(\)/);
  // A cross-origin embed cannot be paused or read, so it is returned to its
  // placeholder rather than left running behind the viewer.
  assert.match(suspend, /state\.activePlayers\.delete\(key\)/);
  assert.match(suspend, /embed\.innerHTML = embedPlaceholderMarkup\(item\)/);

  // Every viewer branch that mounts a video picks the position up, and closing
  // hands it back.
  const viewer = source.slice(source.indexOf('async function renderLightbox'), source.indexOf('function openLightbox'));
  assert.equal(viewer.split('resumePlaybackPosition(video, item);').length - 1, 3,
    'direct video, resolved video and resolved embed all resume');
  // The card side too, or there is no position to hand over in the first place.
  assert.match(source, /function startEmbeddedPlayer[\s\S]*?resumePlaybackPosition\(video, item\)/);
  // And a windowed remount must not rewind what it re-mounts.
  assert.match(source, /rememberPlaybackPosition\(node\.dataset\.key, video\)/);
  const closer = source.slice(source.indexOf('function closeLightbox'), source.indexOf('async function renderLightbox'));
  assert.match(closer, /const watched = currentViewerItem\(\);/);
  assert.ok(closer.indexOf('rememberPlaybackPosition') < closer.indexOf('box.innerHTML'),
    'the position has to be read before the element is thrown away');
  assert.match(closer, /resumePlaybackPosition\(video, watched\)/);

  // One definition of the placeholder, so a torn-down player and an unplayed
  // card cannot drift apart.
  assert.equal(source.split('data-load-player="${key}"').length - 1, 1);
});

test('a resumed position is applied only when it is usable', () => {
  const positions = new Map();
  const { resumePlaybackPosition, rememberPlaybackPosition } = evaluateSlice(
    'function rememberPlaybackPosition',
    '// Opening the viewer must not leave',
    ['rememberPlaybackPosition', 'resumePlaybackPosition'],
    { state: { playbackPositions: positions } },
  );

  const makeVideo = (readyState, duration) => {
    const listeners = [];
    return {
      readyState, duration, currentTime: 0,
      addEventListener: (type, handler) => listeners.push({ type, handler }),
      fire: type => listeners.filter(entry => entry.type === type).forEach(entry => entry.handler()),
    };
  };

  positions.clear();
  rememberPlaybackPosition('a', { currentTime: 42 });
  assert.equal(positions.get('a'), 42);
  // Nothing worth remembering about an untouched player.
  rememberPlaybackPosition('b', { currentTime: 0 });
  assert.equal(positions.has('b'), false);
  rememberPlaybackPosition('', { currentTime: 5 });
  rememberPlaybackPosition('c', null);
  assert.deepEqual([...positions.keys()], ['a']);

  // Metadata already parsed: seek immediately.
  const ready = makeVideo(2, 300);
  resumePlaybackPosition(ready, { selectionKey: 'a' });
  assert.equal(ready.currentTime, 42);

  // A card is preload="none", so the seek waits for the play the reader has to
  // press anyway rather than being silently dropped.
  const cold = makeVideo(0, 300);
  resumePlaybackPosition(cold, { selectionKey: 'a' });
  assert.equal(cold.currentTime, 0);
  cold.fire('loadedmetadata');
  assert.equal(cold.currentTime, 42);

  // A live stream has no usable duration, and resuming at the very end would
  // just show a finished video.
  const live = makeVideo(2, Infinity);
  resumePlaybackPosition(live, { selectionKey: 'a' });
  assert.equal(live.currentTime, 0);
  const nearlyOver = makeVideo(2, 42.2);
  resumePlaybackPosition(nearlyOver, { selectionKey: 'a' });
  assert.equal(nearlyOver.currentTime, 0);

  // Nothing recorded, nothing to do.
  const fresh = makeVideo(2, 300);
  resumePlaybackPosition(fresh, { selectionKey: 'unknown' });
  assert.equal(fresh.currentTime, 0);
  resumePlaybackPosition(null, { selectionKey: 'a' });
  resumePlaybackPosition(fresh, null);
  assert.equal(fresh.currentTime, 0);
});

function loadEmbedPlayers() {
  return evaluateSlice(
    'function embedIsFramable',
    'async function startEmbeddedPlayer',
    ['embedIsFramable', 'playsInPlace', 'embedFallbackMarkup', 'embedPlayerMarkup'],
    {
      VIDEO_EXT: /\.(?:mp4|webm|mov|m4v)(?:$|[?#./])/i,
      escapeHtml: value => String(value === undefined || value === null ? '' : value),
      iframeHtml: () => '<iframe src="host"></iframe>',
      // Only a host the registry rewrites is framable.
      embedUrl: url => (/framable/.test(String(url)) ? 'https://player.test/x' : String(url)),
      unwrapSimpcityRedirect: url => String(url),
      normalizeSourceUrl: value => String(value === undefined ? '' : value),
      hasDirectResolver: item => Boolean(item && item.directResolver),
      hostOf: () => 'host.test',
      icon: () => '',
    },
  );
}

test('a card plays in place whenever anything can play it, not only an iframe', () => {
  const { embedIsFramable, playsInPlace } = loadEmbedPlayers();

  // Framing and resolving are different questions. Bunkr refuses to be framed,
  // so asking only the first rendered it as a bare link out even though the
  // viewer had been playing its signed file natively all along.
  assert.equal(embedIsFramable({ url: 'https://framable.test/v/1' }), true);
  assert.equal(embedIsFramable({ url: 'https://bunkr.test/f/a', directResolver: true }), false);
  assert.equal(embedIsFramable({ url: 'https://other.test/v/1', wasFrame: true }), true, 'it was already an iframe in the post');
  assert.equal(embedIsFramable(null), false);

  assert.equal(playsInPlace({ url: 'https://framable.test/v/1' }), true);
  assert.equal(playsInPlace({ url: 'https://bunkr.test/f/a', directResolver: true }), true, 'resolvable is playable');
  assert.equal(playsInPlace({ url: 'https://other.test/page' }), false, 'neither framable nor resolvable stays a link card');

  // And the card asks that one question rather than re-deriving it.
  assert.match(source, /if \(playsInPlace\(item\)\) \{/);
  assert.doesNotMatch(source, /const transformed = embedUrl\(item\.url\);/);
  // One definition of "there is a resolver for this", shared with the queue.
  assert.match(source, /function hasDirectResolver\(item\)/);
  assert.match(source, /return item\.directResolver === undefined \? hasDirectResolver\(item\) : item\.directResolver;/);
});

test('an embed plays its resolved file where one exists, and falls back honestly where it does not', () => {
  const { embedPlayerMarkup, embedFallbackMarkup } = loadEmbedPlayers();
  const confirmed = (url, extra = {}) => ({ url: 'https://framable.test/v/1', resolution: { candidate: { status: 'confirmed', url } }, ...extra });

  // A signed CDN file is seekable, so the card can hand its position to the
  // viewer. A cross-origin iframe never can, which is the whole point.
  assert.match(embedPlayerMarkup(confirmed('https://cdn.test/a.mp4?token=x')), /^<video controls/);
  assert.match(embedPlayerMarkup(confirmed('https://cdn.test/a.mp4?token=x')), /src="https:\/\/cdn\.test\/a\.mp4\?token=x"/);
  assert.match(embedPlayerMarkup(confirmed('https://cdn.test/a.mp4', { poster: 'p.jpg' })), /poster="p\.jpg"/);

  // Everything short of a confirmed video file falls back.
  assert.match(embedPlayerMarkup({ url: 'https://framable.test/v/1' }), /^<iframe/);
  assert.match(embedPlayerMarkup({ url: 'https://framable.test/v/1', resolution: { candidate: { status: 'heuristic', url: 'https://cdn.test/a.mp4' } } }), /^<iframe/);
  assert.match(embedPlayerMarkup(confirmed('https://cdn.test/page')), /^<iframe/, 'not a video file');
  assert.match(embedPlayerMarkup(confirmed('https://cdn.test/a.jpg')), /^<iframe/, 'a Bunkr link can resolve to an image');
  // Once the file has refused to play inline, a re-render must not retry it.
  assert.match(embedPlayerMarkup(confirmed('https://cdn.test/a.mp4', { embedPlaybackFailed: true })), /^<iframe/);

  // A host that cannot be framed has nowhere to fall back to but its own page,
  // and an iframe it would only render blank is worse than saying so.
  const unframable = { url: 'https://bunkr.test/f/a', directResolver: true };
  assert.match(embedFallbackMarkup(unframable), /scg-embed-unavailable/);
  assert.match(embedFallbackMarkup(unframable), /Open on host\.test/);
  assert.doesNotMatch(embedFallbackMarkup(unframable), /<iframe/);
  assert.match(embedFallbackMarkup({ url: 'https://framable.test/v/1' }), /^<iframe/);
  assert.match(embedPlayerMarkup({ ...unframable, resolution: { candidate: { status: 'failed' } } }), /scg-embed-unavailable/);
});

test('the fallback is reached from both ends', () => {
  // Card: a video that errors hands the container back, and remembers.
  const starter = source.slice(source.indexOf('async function startEmbeddedPlayer'), source.indexOf('// Shared with card()'));
  assert.match(starter, /item\.embedPlaybackFailed = true;/);
  assert.match(starter, /container\.innerHTML = embedFallbackMarkup\(item\);/);
  // Resolving is awaited before anything is mounted, and a resolver failure is
  // not fatal: the fallback covers it.
  assert.match(starter, /try \{ direct = await resolveForDisplay\(item\); \}/);
  assert.match(starter, /if \(!container\.isConnected\) return;/);

  // Viewer: routed through the lifecycle binder so it wins over the generic
  // error panel rather than being overwritten by it.
  assert.match(source, /function bindViewerVideoLifecycle\(video, stage, onError\)/);
  assert.match(source, /if \(onError\) return onError\(\);/);
  const viewer = source.slice(source.indexOf('const mountHostPlayer'), source.indexOf('function openLightbox'));
  assert.match(viewer, /bindViewerVideoLifecycle\(video, stage, \(\) => \{[\s\S]*?mountHostPlayer\(\);/);
  assert.match(viewer, /!VIDEO_EXT\.test\(direct\.url\)/, 'the same guard as the card');
});

test('Pixeldrain single-file links resolve through the stable file API', async () => {
  const { resolvePixeldrainFile } = evaluateSlice(
    'function resolvePixeldrainFile',
    'async function resolveCandidate',
    ['resolvePixeldrainFile'],
    {
      normalizeSourceUrl: value => value || '',
      isPixeldrainFileUrl: url => /^https:\/\/pixeldrain\.com\/u\/[^/]+/.test(url),
      hostMediaId: url => new URL(url).pathname.split('/').filter(Boolean)[1] || '',
      failedResolution: (reason, mediaType, extras) => ({ status: 'failed', reason, mediaType, ...extras }),
      resolutionResult: (status, url, method, mediaType, extras) => ({ status, url, method, mediaType, ...extras }),
    },
  );
  const resolved = await resolvePixeldrainFile({ type: 'video', url: 'https://pixeldrain.com/u/abc-123' });
  assert.equal(resolved.status, 'confirmed');
  assert.equal(resolved.url, 'https://pixeldrain.com/api/file/abc-123');
  assert.equal(resolved.mediaTypeUnknown, true);
  assert.match(source, /id: 'pixeldrain'[\s\S]*?mediaId: url => url\.pathname\.match\(\/\^\\\/u\\\//);
});

test('thread scans support bounded ranges and resume after the highest successful page', () => {
  const scanStart = source.indexOf('async function scanThread(requested = {})');
  const scanEnd = source.indexOf('function scanCurrentPage()', scanStart);
  const scanSource = source.slice(scanStart, scanEnd);
  assert.match(scanSource, /const endPage = Math\.min\(requestedEnd, startPage \+ 249\)/);
  assert.match(scanSource, /new Set\(state\.items\.map\(itemDedupeKey\)\)/);
  assert.match(scanSource, /rememberScannedPage\(page, pageUrl\)/);
  assert.match(scanSource, /scanThread\(\{ start, end: detected, append: true/);
  assert.match(scanSource, /const first = Math\.min\(from, to\)/);
  assert.match(scanSource, /scanThread\(\{ start: first, end: last, append: false/);
  assert.match(source, /data-action="scan-new"/);
  assert.match(source, /data-action="scan-range"/);
  assert.match(source, /const SCAN_PROGRESS_KEY = 'sc-thread-gallery-timeline-scan-progress-v1'/);
});

test('resolution bands use the media short edge and keep unknown dimensions explicit', () => {
  const { resolutionPixels, resolutionBand } = evaluateSlice(
    'function resolutionPixels',
    'function visibleItems',
    ['resolutionPixels', 'resolutionBand'],
  );
  assert.equal(resolutionBand({ mediaDimensions: { width: 1280, height: 720 } }), 'hd');
  assert.equal(resolutionBand({ mediaDimensions: { width: 1080, height: 1920 } }), 'fhd');
  assert.equal(resolutionBand({ mediaDimensions: { width: 3840, height: 2160 } }), 'uhd');
  assert.equal(resolutionBand({}), 'unknown');
  assert.equal(resolutionPixels({ mediaDimensions: { width: 1920, height: 1080 } }), 2073600);
  assert.match(source, /'resolution-asc': 'Resolution low to high'/);
  assert.match(source, /data-resolution-filter/);
});

test('grid keyboard navigation and marquee geometry are deterministic', () => {
  const { gridNavigationTarget, rectanglesIntersect } = evaluateSlice(
    'function gridNavigationTarget',
    'function setSelectOptions',
    ['gridNavigationTarget', 'rectanglesIntersect'],
  );
  const keys = ['a', 'b', 'c', 'd', 'e', 'f'];
  assert.equal(gridNavigationTarget(keys, '', 'right', 3), 'a');
  assert.equal(gridNavigationTarget(keys, 'b', 'right', 3), 'c');
  assert.equal(gridNavigationTarget(keys, 'e', 'up', 3), 'b');
  assert.equal(gridNavigationTarget(keys, 'e', 'down', 3), 'f');
  assert.equal(rectanglesIntersect({ left: 0, right: 10, top: 0, bottom: 10 }, { left: 9, right: 20, top: 9, bottom: 20 }), true);
  assert.equal(rectanglesIntersect({ left: 0, right: 10, top: 0, bottom: 10 }, { left: 11, right: 20, top: 0, bottom: 10 }), false);
  assert.match(source, /tabindex="-1" data-key=/);
  assert.match(source, /scroll\.scrollTop = Math\.max\(0, cell\.y - 80\);\s*\r?\n\s*updateFlowWindow\(\)/);
});

test('selection persistence, matching selection and marquee selection are wired to stable keys', () => {
  assert.match(source, /const SELECTIONS_KEY = 'sc-thread-gallery-timeline-selections-v1'/);
  assert.match(source, /new Set\(Array\.isArray\(selectionStore\[storedSelectionKey\]\)/);
  assert.match(source, /if \(persistedSelectionKeys\.has\(key\) \|\| aliases\.some\(alias => persistedSelectionKeys\.has\(alias\)\)\) state\.selected\.add\(key\)/);
  assert.match(source, /persistedSelectionKeys = new Set\(\[\.\.\.state\.selected\]\.slice\(0, 5000\)\)/);
  assert.match(source, /data-action="select-matching"/);
  assert.match(source, /selectItems\(visibleItems\(\)\.filter\(isMediaItem\)\)/);
  assert.match(source, /marquee\.className = 'scg-marquee'/);
  assert.match(source, /app\.appendChild\(marquee\)/);
  assert.match(source, /addEventListener\('pointercancel', cancel\)/);
  assert.match(source, /rectanglesIntersect\(selectionRect, node\.getBoundingClientRect\(\)\)/);
});

test('optional posters, safe mode and completion notifications remain explicitly gated', () => {
  assert.match(source, /if \(!state\.embedPosters[\s\S]*?return;/);
  assert.match(source, /kind: 'poster'/);
  assert.match(source, /mediaFromHtml\(await requestText\(page[\s\S]*?page, 'image'\)/);
  assert.match(source, /\.safe-mode \.scg-card img/);
  assert.match(source, /data-setting-safe-mode/);
  assert.match(source, /if \(!state\.completionNotifications \|\| typeof Notification !== 'function' \|\| Notification\.permission !== 'granted'\) return false/);
  assert.match(source, /sendCompletionNotification\('Gallery scan finished'/);
  assert.match(source, /sendCompletionNotification\('Gallery download finished'/);
});

test('yt-dlp archive export emits only stable extractor and media id pairs', () => {
  const { ytDlpArchiveEntry } = evaluateSlice(
    'function ytDlpArchiveEntry',
    'function exportYtDlpArchive',
    ['ytDlpArchiveEntry'],
    {
      normalizeSourceUrl: value => value || '',
      hostDefinition: url => ({ id: new URL(url).hostname.includes('youtu') ? 'youtube' : 'generic-video-host' }),
      hostMediaId: url => new URL(url).searchParams.get('v') || '',
    },
  );
  assert.equal(ytDlpArchiveEntry({ url: 'https://youtube.com/watch?v=video123' }), 'youtube video123');
  assert.equal(ytDlpArchiveEntry({ url: 'https://example.test/watch?v=video123' }), '');
  assert.match(source, /data-action="export-yt-dlp-archive"/);
  assert.match(source, /new Set\(scope\.items\.map\(ytDlpArchiveEntry\)\.filter\(Boolean\)\)/);
});
