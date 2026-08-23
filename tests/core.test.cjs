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

test('canonical metadata preserves the installed script identity', () => {
  assert.equal(metadataValue('name'), 'SimpCity Thread Gallery Timeline');
  assert.equal(metadataValue('namespace'), 'local.simpcity.gallery.timeline');
  assert.equal(metadataValue('version'), '0.10.0');
  assert.match(source, /const APP_VERSION = '0\.10\.0'/);
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
  assert.match(source, /Object\.freeze\(\['masonry', 'flow', 'grid', 'feed'\]\)/);
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
    'function normalizedQuery',
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
    'function normalizedQuery',
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
    'function normalizedQuery',
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
    { state, invalidateVisibleItems: () => {} },
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

test('active filters are visible and individually reversible', () => {
  const { activeFacetChips, facetClearPatch } = evaluateSlice(
    'function activeFacetChips',
    'function facetOptions',
    ['activeFacetChips', 'facetClearPatch'],
  );
  const labels = { image: 'Images' };

  assert.deepEqual(plain(activeFacetChips({ filter: 'all', query: '   ', authorFilter: 'all', hostFilter: 'all' }, labels)), []);

  const chips = plain(activeFacetChips({
    filter: 'image', query: '  beach ', authorFilter: 'anon', hostFilter: 'bunkr.cr', selectedOnly: true,
  }, labels));
  assert.deepEqual(chips.map(chip => chip.facet), ['filter', 'query', 'author', 'host', 'selected']);
  assert.equal(chips[0].value, 'Images');
  assert.equal(chips[1].value, 'beach');

  // Sort and grouping rearrange what is already there rather than withholding
  // anything, so they do not belong in a bar about what is being hidden.
  assert.deepEqual(plain(activeFacetChips({ sort: 'author', groupBy: 'reply' }, labels)), []);

  assert.deepEqual(plain(facetClearPatch('host')), { hostFilter: 'all' });
  assert.deepEqual(plain(facetClearPatch('all')), {
    filter: 'all', query: '', authorFilter: 'all', hostFilter: 'all', selectedOnly: false,
  });
  assert.equal(facetClearPatch('nonsense'), null);
});

test('facet counts answer what each value would give, and the summary states the whole', () => {
  // A facet counted against itself reports 0 for every value you did not pick.
  assert.match(source, /function matchesActiveFilters\(item, q = normalizedQuery\(\), skip = ''\)/);
  assert.match(source, /const authorMatch = skip === 'author' \|\|/);
  assert.match(source, /const hostMatch = skip === 'host' \|\|/);
  assert.match(source, /matchesActiveFilters\(item, q, 'author'\)/);
  assert.match(source, /matchesActiveFilters\(item, q, 'host'\)/);
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

test('per-view pagination supports larger galleries through 500 items', () => {
  assert.match(source, /VIEW_PAGE_SIZES = Object\.freeze\(\[40, 60, 100, 200, 300, 500\]\)/);
  assert.match(source, /VIEW_PAGE_SIZES\.includes\(Number\(savedSettings\.perPage\)\)/);
  assert.match(source, /VIEW_PAGE_SIZES\.includes\(Number\(input\.perPage\)\)/);
  assert.match(source, /VIEW_PAGE_SIZES\.map\(size => `<option value="\$\{size\}">\$\{size\}<\/option>`\)\.join\(''\)/);
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
  assert.match(source, /if \(dataset \|\| \(selection && state\.selectedOnly\)\) state\.replyIndex = null/);
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
      LAYOUT_MODES: ['masonry', 'grid', 'feed'],
      LEGACY_THEME_ACCENTS: { midnight: 'indigo', graphite: 'amber' },
      VIEW_PAGE_SIZES: [40, 60, 100, 200, 300, 500],
      DEFAULT_SETTINGS: { filter: 'all', sort: 'thread-asc', groupBy: 'none', perPage: 60, theme: 'dark', accent: 'blue', layoutMode: 'masonry', cardScale: 100, downloadConcurrency: 2, zipPartSizeMb: 300, zipPartMaxFiles: 24, archiveLayout: 'page-author' },
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
});

function loadLayoutEngine() {
  return evaluateSlice(
    'function partitionSections',
    'const IMAGE_EXT',
    ['partitionSections', 'packColumns', 'justifyRows', 'stackSections', 'visibleRowRange', 'stickyHeaderOffset'],
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

test('sections chunk ungrouped items and follow reply boundaries when grouped', () => {
  const { partitionSections } = loadLayoutEngine();

  const chunked = partitionSections(entriesOf(450, 1), { chunkSize: 200 });
  assert.equal(chunked.map(section => section.entries.length).join(','), '200,200,50');
  // Empty input still yields one section so callers never special-case it.
  assert.equal(partitionSections([], {}).length, 1);
  assert.equal(partitionSections([], {})[0].entries.length, 0);

  const grouped = partitionSections([
    { key: 'a', ratio: 1, sectionId: 'r1', sectionLabel: 'Reply #1' },
    { key: 'b', ratio: 1, sectionId: 'r2', sectionLabel: 'Reply #2' },
    { key: 'c', ratio: 1, sectionId: 'r1', sectionLabel: 'Reply #1' },
  ], { groupBy: 'reply' });
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].label, 'Reply #1');
  // Order of first appearance is preserved, and a group gathers its members.
  assert.equal(grouped[0].entries.map(entry => entry.key).join(','), 'a,c');
  assert.equal(grouped[1].entries.map(entry => entry.key).join(','), 'b');
});

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

test('justified rows fill the width exactly and never stretch a short last row', () => {
  const { justifyRows } = loadLayoutEngine();
  const options = { containerWidth: 1000, gap: 10, targetHeight: 200, chromeHeight: 0, assumedRatio: 1 };

  const rows = justifyRows(entriesOf(9, 1), options);
  const byRow = new Map();
  rows.cells.forEach(cell => {
    if (!byRow.has(cell.y)) byRow.set(cell.y, []);
    byRow.get(cell.y).push(cell);
  });
  // Every full row spans the container exactly -- this is the property that
  // removes sub-pixel seams at the right edge.
  const ys = [...byRow.keys()].sort((a, b) => a - b);
  ys.slice(0, -1).forEach(y => {
    const row = byRow.get(y);
    const right = row[row.length - 1];
    assert.equal(right.x + right.width, 1000);
  });
  // Cells within a row share a height.
  ys.forEach(y => {
    const row = byRow.get(y);
    row.forEach(cell => assert.equal(cell.height, row[0].height));
  });

  // One wide item alone on the last row must not be blown up to fill it.
  // ratio 5 clamps to 4, so the natural height is 1000/4 = 250. The cap has to
  // sit below that for the non-stretch branch to be the one under test.
  const trailing = justifyRows([{ key: 'a', ratio: 5 }], { ...options, maxRowHeight: 220 });
  assert.equal(trailing.cells.length, 1);
  assert.equal(trailing.cells[0].height, 200);
  assert.ok(trailing.cells[0].x + trailing.cells[0].width < 1000, 'short last row keeps natural width');

  // Unknown ratios fall back rather than producing NaN geometry.
  const unknown = justifyRows([{ key: 'a' }, { key: 'b', ratio: 0 }], options);
  unknown.cells.forEach(cell => {
    assert.ok(Number.isFinite(cell.width) && cell.width > 0);
    assert.ok(Number.isFinite(cell.height) && cell.height > 0);
  });

  assert.equal(justifyRows([], options).height, 0);
});

test('sections stack with headers and report a total height', () => {
  const { stackSections } = loadLayoutEngine();
  const stacked = stackSections(
    [{ id: 'a', label: 'A', height: 100 }, { id: 'b', label: 'B', height: 50 }],
    { gap: 10, headerHeight: 20, startTop: 0 },
  );
  assert.equal(stacked.sections[0].top, 0);
  assert.equal(stacked.sections[0].height, 120);
  assert.equal(stacked.sections[1].top, 130);
  // Trailing gap is not counted, so the spacer matches the content.
  assert.equal(stacked.totalHeight, 200);
  assert.equal(stackSections([], { gap: 10 }).totalHeight, 0);
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

test('sticky headers pin within their own section and hand over at the boundary', () => {
  const { stickyHeaderOffset } = loadLayoutEngine();
  const section = { top: 1000, height: 500 };

  // Above the section: parked at the top.
  assert.equal(stickyHeaderOffset(section, 0, 40), 1000);
  // Inside: follows the scroll.
  assert.equal(stickyHeaderOffset(section, 1200, 40), 1200);
  // Near the end: stops so the next section pushes it off rather than overlapping.
  assert.equal(stickyHeaderOffset(section, 1490, 40), 1460);
  assert.equal(stickyHeaderOffset(section, 99999, 40), 1460);
  // A section shorter than its own header must not invert.
  assert.equal(stickyHeaderOffset({ top: 10, height: 20 }, 500, 40), 10);
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
  assert.match(source, /const expanded = state\.expandedKeys\.has\(item\.selectionKey\)/);

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

test('flow is a windowed layout that positions cards itself', () => {
  // CSS multi-column cannot be windowed, so flow does its own placement.
  assert.match(source, /const VIRTUALIZED_LAYOUTS = Object\.freeze\(\['flow'\]\)/);
  assert.match(source, /packColumns\(entries, flowLayoutOptions\(containerWidth\)\)/);
  assert.match(source, /\.scg-grid\.flowing\{[\s\S]*?position:relative/);
  assert.match(source, /\.scg-flow-cell\{[\s\S]*?position:absolute/);

  // The window index must be sorted by y: packColumns emits in item order.
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

test('flow leaves the other layouts and reply grouping on the old path', () => {
  // Reply grouping needs sectioned markup, which the flat window cannot express
  // yet, so it stays on the innerHTML path.
  assert.match(source, /VIRTUALIZED_LAYOUTS\.includes\(state\.layoutMode\) && !state\.scanning && state\.groupBy !== 'reply'/);
  // The non-virtualized branch is unchanged.
  assert.match(source, /grid\.innerHTML = state\.scanning[\s\S]*?skeletonMarkup/);
  assert.match(source, /observeFullImages\(state\.renderedItems\)/);
  // CSS-column masonry is untouched and still the default.
  assert.match(source, /\[data-layout="masonry"\] \.scg-grid:not\(\.grouped\)\{display:block;columns:5/);
  assert.match(source, /layoutMode: 'masonry',/);
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
