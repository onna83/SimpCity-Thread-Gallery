// ==UserScript==
// @name         SimpCity Thread Gallery Timeline
// @namespace    local.simpcity.gallery.timeline
// @version      1.0.2
// @description  Timeline fork of SimpCity Thread Gallery: cached thread indexes, virtualized browsing and verified downloads.
// @license      MIT
// @match        https://simpcity.cr/threads/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  // DESIGN DIRECTION: the media canvas is the page; a single
  // floating instrument plate carries every frequent control; the dock at the
  // foot of the canvas changes identity between browse, select and download.
  // The architecture is unchanged from the stable line; this fork reduces
  // rendering work and adds safer scanning, reply-level grouping and selection.

  const APP_VERSION = '1.0.2';
  const APP_ID = 'sc-thread-gallery-tl';
  const SETTINGS_KEY = 'sc-thread-gallery-timeline-settings-v1';
  const DOWNLOAD_HISTORY_KEY = 'sc-thread-gallery-timeline-download-history-v1';
  const STORAGE_MIGRATION_KEY = 'sc-thread-gallery-timeline-storage-migrated-v1';
  const LARGE_THREAD_WARNING_PAGES = 50;
  const RATIO_CACHE_KEY = 'sc-thread-gallery-timeline-ratio-cache-v1';
  const SCAN_PROGRESS_KEY = 'sc-thread-gallery-timeline-scan-progress-v1';
  const SELECTIONS_KEY = 'sc-thread-gallery-timeline-selections-v1';
  const ITEM_INDEX_KEY_PREFIX = 'sc-thread-gallery-timeline-item-index-v1:';
  const ITEM_INDEX_REGISTRY_KEY = 'sc-thread-gallery-timeline-item-index-registry-v1';
  const ITEM_INDEX_SCHEMA = 2;
  const ITEM_INDEX_EXTRACTION_VERSION = 'items-v2';
  const ITEM_INDEX_MAX_BYTES = 420000;
  const ITEM_INDEX_THREAD_LIMIT = 6;
  const TAB_SYNC_CHANNEL = 'sc-thread-gallery-timeline-sync-v1';
  const RATIO_CACHE_LIMIT = 4000;
  const DEFAULT_RATIO = 0.72;
  const SCAN_WARNING_TEXT = 'Scanning a very large thread can use substantial RAM and may temporarily slow or freeze the browser. Media files remain unloaded until viewed.';
  if (document.getElementById(APP_ID)) return;

  const DEFAULT_SETTINGS = Object.freeze({
    filter: 'all',
    downloadState: 'all',
    resolutionFilter: 'all',
    compact: false,
    sort: 'thread-asc',
    groupBy: 'none',
    perPage: 60,
    theme: 'dark',
    filtersCollapsed: false,
    layoutMode: 'masonry',
    cardScale: 100,
    downloadConcurrency: 2,
    zipPartSizeMb: 300,
    zipPartMaxFiles: 24,
    archiveLayout: 'page-author',
    includeManifest: true,
    dedupeContent: true,
    warnLargeThreadScan: true,
    embedPosters: false,
    completionNotifications: false,
    safeMode: false,
    accent: 'blue',
    blockPatterns: '',
  });

  // Only chords that fire outside a text field are rebindable. The viewer's
  // single-key controls stay fixed: they are modal, documented on the viewer
  // itself, and rebinding them would need its own conflict model.
  const SHORTCUT_ACTIONS = Object.freeze([
    Object.freeze({ id: 'toggle', label: 'Open or close the gallery', fallback: 'Shift+G', requiresModifier: true }),
    Object.freeze({ id: 'search', label: 'Focus the search box', fallback: '/' }),
    Object.freeze({ id: 'layout', label: 'Cycle the gallery layout', fallback: 'L' }),
    Object.freeze({ id: 'selectAll', label: 'Select everything in this view', fallback: 'A' }),
  ]);
  const DEFAULT_SHORTCUTS = Object.freeze(Object.fromEntries(SHORTCUT_ACTIONS.map(action => [action.id, action.fallback])));
  const THEME_MODES = Object.freeze(['dark', 'light']);
  const THEME_LABELS = Object.freeze({ dark: 'Darkroom', light: 'Daylight' });
  const ACCENT_MODES = Object.freeze(['blue', 'indigo', 'amber', 'green', 'rose', 'neutral']);
  const ACCENT_LABELS = Object.freeze({
    blue: 'Blue', indigo: 'Indigo', amber: 'Amber', green: 'Green', rose: 'Rose', neutral: 'Neutral',
  });
  // Indigo and Graphite were whole themes that only differed from Darkroom by
  // hue. They survive as accents on the dark theme.
  const LEGACY_THEME_ACCENTS = Object.freeze({ midnight: 'indigo', graphite: 'amber' });
  // 0 is "All": one view, no paging. Kept in the same list so every existing
  // validation of a stored perPage keeps working unchanged.
  // Two layouts, because two is what the content needs: ragged columns that
  // keep every aspect ratio, or uniform cells for scanning. Flow was masonry
  // computed rather than CSS-balanced, which is an implementation detail and
  // never belonged in a picker; masonry is that renderer now. Timeline and
  // Feed were a third geometry and a one-per-row reader, and neither earned
  // its place beside the viewer.
  const LAYOUT_MODES = Object.freeze(['masonry', 'grid']);
  const LAYOUT_LABELS = Object.freeze({ masonry: 'Masonry', grid: 'Uniform grid' });
  // CSS multi-column cannot be windowed: the browser has to see every box to
  // balance the columns. Masonry therefore places its own cards and mounts only
  // what is near the viewport, which is what makes a several-thousand-item
  // thread survivable in the default layout.
  const VIRTUALIZED_LAYOUTS = Object.freeze(['masonry']);
  // Both layout pickers are built from the same list, so adding a layout is
  // one entry rather than two hand-maintained option lists.
  const layoutOptionsMarkup = () => LAYOUT_MODES
    .map(mode => `<option value="${mode}">${escapeHtml(LAYOUT_LABELS[mode])}</option>`)
    .join('');
  const VIEW_PAGE_SIZES = Object.freeze([40, 60, 100, 200, 300, 500, 0]);
  const viewPageSizeLabel = size => (Number(size) > 0 ? String(size) : 'All');
  const FILTER_LABELS = Object.freeze({ all: 'All', image: 'Images', video: 'Videos', link: 'Links', text: 'Text' });
  // The gallery already knows what has been downloaded and paints a badge for
  // it. On a second visit to a long thread that badge is the wrong shape of
  // answer: what you want is the set that still needs doing.
  const DOWNLOAD_STATES = Object.freeze(['all', 'not-downloaded', 'downloaded']);
  const DOWNLOAD_STATE_LABELS = Object.freeze({
    all: 'Any download state',
    'not-downloaded': 'Not downloaded yet',
    downloaded: 'Already downloaded',
  });
  const RESOLUTION_FILTERS = Object.freeze(['all', 'unknown', 'sd', 'hd', 'fhd', 'uhd']);
  const RESOLUTION_LABELS = Object.freeze({ all: 'Any resolution', unknown: 'Unknown', sd: 'SD (<720p)', hd: 'HD (720–1079p)', fhd: 'Full HD (1080–2159p)', uhd: 'UHD (2160p+)' });
  // One collator for the whole script. Passing an options object to
  // localeCompare builds a fresh one per call, and sorting a large thread by
  // author is tens of thousands of comparisons -- measured at 135ms for 5,000
  // items, against 2ms for this.
  const textCollator = new Intl.Collator(undefined, { sensitivity: 'base' });
  const compareText = (left, right) => textCollator.compare(String(left || ''), String(right || ''));
  const SORT_LABELS = Object.freeze({
    'thread-asc': 'Oldest replies first',
    'thread-desc': 'Newest replies first',
    author: 'Author A-Z',
    host: 'Host A-Z',
    type: 'Media type',
    'date-asc': 'Posted oldest first',
    'date-desc': 'Posted newest first',
    'resolution-asc': 'Resolution low to high',
    'resolution-desc': 'Resolution high to low',
  });
  const SORT_MODES = Object.freeze(Object.keys(SORT_LABELS));

  const storage = {
    mode: typeof GM_getValue === 'function' && typeof GM_setValue === 'function' ? 'Tampermonkey isolated storage' : 'page localStorage fallback',
    get(key, fallback) {
      try {
        const raw = typeof GM_getValue === 'function' ? GM_getValue(key, undefined) : localStorage.getItem(key);
        if (raw === undefined || raw === null) return fallback;
        if (typeof raw === 'string') return JSON.parse(raw);
        return raw;
      } catch { return fallback; }
    },
    set(key, value) {
      const encoded = JSON.stringify(value);
      if (typeof GM_setValue === 'function') GM_setValue(key, encoded);
      else localStorage.setItem(key, encoded);
    },
    remove(key) {
      try {
        if (typeof GM_deleteValue === 'function') GM_deleteValue(key);
        else localStorage.removeItem(key);
      } catch { /* Reset should continue even if storage is restricted. */ }
    },
  };

  /* ---- Cross-tab state -----------------------------------------------------
     Every tab holds its own copy of the download history and ratio cache and
     writes the whole map back. Two tabs on one thread therefore erase each
     other: the second writer's snapshot predates the first writer's downloads.
     The fix is in two halves. Merging what is on disk back in before every
     write makes the data safe on its own; the channel below only keeps the
     other tab's UI honest between writes.
     ------------------------------------------------------------------------ */

  // Verified always outranks legacy, because a legacy marker is a weaker claim
  // about the same file. Between two records of equal standing, newer wins.
  function mergeDownloadHistory(base, additions) {
    const merged = Object.assign({}, base && typeof base === 'object' && !Array.isArray(base) ? base : {});
    Object.entries(additions && typeof additions === 'object' && !Array.isArray(additions) ? additions : {}).forEach(([key, entry]) => {
      if (!key || !entry || typeof entry !== 'object' || Array.isArray(entry)) return;
      const existing = merged[key];
      if (!existing) { merged[key] = entry; return; }
      if (existing.verified !== entry.verified) merged[key] = entry.verified ? entry : existing;
      else merged[key] = Number(entry.time || 0) >= Number(existing.time || 0) ? entry : existing;
    });
    return merged;
  }

  const tabSync = {
    channel: null,
    handlers: new Map(),
    start() {
      if (tabSync.channel || typeof BroadcastChannel !== 'function') return false;
      try {
        tabSync.channel = new BroadcastChannel(TAB_SYNC_CHANNEL);
        tabSync.channel.onmessage = event => {
          const message = event && event.data;
          if (!message || typeof message !== 'object') return;
          const handler = tabSync.handlers.get(message.type);
          if (handler) handler(message);
        };
        return true;
      } catch { tabSync.channel = null; return false; }
    },
    on(type, handler) { tabSync.handlers.set(type, handler); },
    post(type, payload = {}) {
      if (!tabSync.channel) return false;
      try { tabSync.channel.postMessage(Object.assign({ type }, payload)); return true; }
      catch { return false; }
    },
  };

  /* ---- Rebindable chords ---------------------------------------------------
     A chord is stored and compared as its normalized string, so the recorder,
     the settings display and the dispatcher all agree by construction.
     ------------------------------------------------------------------------ */

  const MODIFIER_KEYS = Object.freeze(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'Dead']);

  function shortcutCombo(event) {
    const key = event && typeof event.key === 'string' ? event.key : '';
    if (!key || MODIFIER_KEYS.includes(key)) return '';
    const parts = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Meta');
    parts.push(key.length === 1 ? key.toUpperCase() : key);
    return parts.join('+');
  }

  const shortcutHasModifier = combo => /^(?:Ctrl|Alt|Shift|Meta)\+/.test(String(combo || ''));

  // Two passes, so a deliberate swap survives a reload: every stored binding is
  // placed before any default is handed out. An action whose default has been
  // taken by someone else ends up unbound rather than shadowed, because a
  // binding two actions answer to is worse than one that does nothing.
  function normalizedShortcuts(input) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const claimed = new Set();
    const result = {};
    SHORTCUT_ACTIONS.forEach(action => {
      const stored = typeof source[action.id] === 'string' ? source[action.id].trim() : '';
      if (!stored || stored.length > 40) return;
      if (action.requiresModifier && !shortcutHasModifier(stored)) return;
      if (claimed.has(stored)) return;
      claimed.add(stored);
      result[action.id] = stored;
    });
    SHORTCUT_ACTIONS.forEach(action => {
      if (result[action.id]) return;
      result[action.id] = claimed.has(action.fallback) ? '' : action.fallback;
      if (result[action.id]) claimed.add(result[action.id]);
    });
    return result;
  }

  function shortcutConflict(shortcuts, actionId, combo) {
    return SHORTCUT_ACTIONS.some(action => action.id !== actionId && shortcuts[action.id] === combo);
  }

  /* ---- Block patterns ------------------------------------------------------
     Filters hide; this never ingests. A blocked URL costs no card, no ratio
     cache entry and no memory, which is the point on a several-thousand-item
     thread full of signature images.
     ------------------------------------------------------------------------ */

  function blockPatternList(raw) {
    return [...new Set(String(raw == null ? '' : raw)
      .split(/[,\n\r]+/)
      .map(pattern => pattern.trim().toLowerCase())
      .filter(pattern => pattern.length >= 2))].slice(0, 60);
  }

  function matchesBlockPattern(urls, patterns) {
    if (!patterns || !patterns.length) return false;
    return (Array.isArray(urls) ? urls : [urls]).some(candidate => {
      const value = String(candidate == null ? '' : candidate).toLowerCase();
      return Boolean(value) && patterns.some(pattern => value.includes(pattern));
    });
  }

  function migrateLegacyStorage() {
    if (typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function') return false;
    try {
      if (GM_getValue(STORAGE_MIGRATION_KEY, false)) return false;
      let migrated = false;
      [SETTINGS_KEY, DOWNLOAD_HISTORY_KEY].forEach(key => {
        const isolatedValue = GM_getValue(key, undefined);
        const legacyValue = localStorage.getItem(key);
        if (isolatedValue === undefined && legacyValue !== null) {
          GM_setValue(key, legacyValue);
          migrated = true;
        }
        if (legacyValue !== null) localStorage.removeItem(key);
      });
      GM_setValue(STORAGE_MIGRATION_KEY, true);
      return migrated;
    } catch { return false; }
  }

  const migratedLegacyStorage = migrateLegacyStorage();
  const storedRatioCache = storage.get(RATIO_CACHE_KEY, {});
  const storedSettings = storage.get(SETTINGS_KEY, {});
  const storedDownloadHistory = storage.get(DOWNLOAD_HISTORY_KEY, {});
  const savedSettings = storedSettings && typeof storedSettings === 'object' && !Array.isArray(storedSettings) ? storedSettings : {};
  const savedDownloadHistory = storedDownloadHistory && typeof storedDownloadHistory === 'object' && !Array.isArray(storedDownloadHistory) ? storedDownloadHistory : {};

  // Entries this script wrote are already in shape; only pre-v0.7.3 records
  // need rebuilding. Checking is far cheaper than allocating 5,000 fresh
  // objects on every history write, which is what the unconditional rebuild
  // cost -- and persistDownloadHistory reads storage on every write.
  const isNormalizedEntry = entry => Boolean(entry)
    && typeof entry === 'object'
    && !Array.isArray(entry)
    && typeof entry.verified === 'boolean'
    && typeof entry.method === 'string'
    && typeof entry.filename === 'string';

  function normalizeDownloadHistory(history) {
    if (Object.values(history).every(isNormalizedEntry)) return history;
    return Object.fromEntries(Object.entries(history).map(([key, rawEntry]) => {
      const entry = rawEntry && typeof rawEntry === 'object' && !Array.isArray(rawEntry) ? rawEntry : {};
      return [key, {
        filename: String(entry.filename || ''),
        size: Math.max(0, Number(entry.size || 0)),
        time: Math.max(0, Number(entry.time || 0)),
        verified: entry.verified === true,
        legacy: entry.verified !== true,
        mime: String(entry.mime || ''),
        method: String(entry.method || (entry.verified === true ? 'validated-media' : 'pre-v0.7.3')),
        container: String(entry.container || ''),
      }];
    }));
  }

  const state = {
    items: [],
    filter: ['all', 'image', 'video', 'link', 'text'].includes(savedSettings.filter) ? savedSettings.filter : 'all',
    downloadState: DOWNLOAD_STATES.includes(savedSettings.downloadState) ? savedSettings.downloadState : 'all',
    resolutionFilter: RESOLUTION_FILTERS.includes(savedSettings.resolutionFilter) ? savedSettings.resolutionFilter : 'all',
    query: '',
    compact: Boolean(savedSettings.compact),
    sort: SORT_MODES.includes(savedSettings.sort) ? savedSettings.sort : 'thread-asc',
    groupBy: savedSettings.groupBy === 'reply' ? 'reply' : 'none',
    perPage: VIEW_PAGE_SIZES.includes(Number(savedSettings.perPage)) ? Number(savedSettings.perPage) : DEFAULT_SETTINGS.perPage,
    theme: THEME_MODES.includes(savedSettings.theme)
      ? savedSettings.theme
      : (LEGACY_THEME_ACCENTS[savedSettings.theme] ? 'dark' : DEFAULT_SETTINGS.theme),
    accent: ACCENT_MODES.includes(savedSettings.accent)
      ? savedSettings.accent
      : (LEGACY_THEME_ACCENTS[savedSettings.theme] || DEFAULT_SETTINGS.accent),
    filtersCollapsed: Boolean(savedSettings.filtersCollapsed),
    layoutMode: LAYOUT_MODES.includes(savedSettings.layoutMode) ? savedSettings.layoutMode : 'masonry',
    cardScale: Number.isFinite(Number(savedSettings.cardScale)) ? Math.min(160, Math.max(70, Math.round(Number(savedSettings.cardScale) / 5) * 5)) : 100,
    downloadConcurrency: [1, 2, 3, 4].includes(Number(savedSettings.downloadConcurrency)) ? Number(savedSettings.downloadConcurrency) : 2,
    zipPartSizeMb: [100, 300, 600, 1000].includes(Number(savedSettings.zipPartSizeMb)) ? Number(savedSettings.zipPartSizeMb) : 300,
    zipPartMaxFiles: [24, 50, 100].includes(Number(savedSettings.zipPartMaxFiles)) ? Number(savedSettings.zipPartMaxFiles) : 24,
    archiveLayout: ['flat', 'page', 'page-author', 'reply'].includes(savedSettings.archiveLayout) ? savedSettings.archiveLayout : 'page-author',
    includeManifest: savedSettings.includeManifest !== false,
    dedupeContent: savedSettings.dedupeContent !== false,
    warnLargeThreadScan: savedSettings.warnLargeThreadScan !== false,
    embedPosters: Boolean(savedSettings.embedPosters),
    completionNotifications: Boolean(savedSettings.completionNotifications),
    safeMode: Boolean(savedSettings.safeMode),
    blockPatterns: typeof savedSettings.blockPatterns === 'string' ? savedSettings.blockPatterns : DEFAULT_SETTINGS.blockPatterns,
    shortcuts: normalizedShortcuts(savedSettings.shortcuts),
    authorFilter: 'all',
    hostFilter: 'all',
    selectedOnly: false,
    viewPage: 1,
    viewPages: 1,
    appliedPerPage: 0,
    renderedItems: [],
    replyIndex: null,
    expandedKeys: new Set(),
    activePlayers: new Set(),
    playbackPositions: new Map(),
    threadPageCount: 1,
    sourcePage: 1,
    selected: new Set(),
    selectionAnchor: null,
    gridFocusKey: '',
    collapsedReplies: new Set(),
    scanning: false,
    cancelScan: false,
    scannedPages: 0,
    scanCurrentPage: 0,
    scanTotalPages: 0,
    scanFailedPages: 0,
    scanCanceling: false,
    scanController: null,
    itemIndexRestored: false,
    itemIndexTruncated: false,
    sourceLabel: 'Current page',
    lightboxIndex: 0,
    viewerItems: [],
    viewerZoom: 1,
    viewerPanX: 0,
    viewerPanY: 0,
    viewerInfoOpen: true,
    viewerRenderToken: 0,
    viewerReturnFocus: null,
    downloading: false,
    cancelDownload: false,
    downloadProgress: { current: 0, total: 0, ok: 0, failed: 0, verification: 0, skipped: 0, duplicates: 0, zipPercent: 0, label: '' },
    downloadJobs: [],
    activeDownloadRequests: new Set(),
    downloadDetailsOpen: false,
    downloadHistory: normalizeDownloadHistory(savedDownloadHistory),
    diagnostics: {
      startedAt: Date.now(),
      migratedLegacyStorage,
      resolverFailures: [],
      downloadFailures: [],
      scanFailures: [],
      events: [],
    },
  };

  let datasetRevision = 0;
  let selectionRevision = 0;
  // The download-state facet reads the history rather than the dataset, so the
  // filtered view has to be invalidated when a download lands or history is
  // cleared -- otherwise filtering to "not downloaded yet" and then downloading
  // leaves the finished items sitting in the view.
  let historyRevision = 0;
  let visibleItemsCache = null;
  let facetCache = null;
  let facetCountCache = null;
  let itemIndexCache = null;

  function invalidateVisibleItems({ dataset = false, selection = false, history = false } = {}) {
    if (dataset) datasetRevision++;
    if (selection) selectionRevision++;
    if (history) historyRevision++;
    if (dataset || (selection && state.selectedOnly) || (history && state.downloadState !== 'all')) state.replyIndex = null;
  }

  // Aspect ratios drive layout before an image has loaded. These four are pure
  // so they can be exercised directly by the test harness.
  function clampRatio(value, min = 0.32, max = 4) {
    const ratio = Number(value);
    if (!Number.isFinite(ratio) || ratio <= 0) return 0;
    return Math.min(max, Math.max(min, ratio));
  }

  function parseDimensionHints(attrs) {
    const numeric = raw => {
      const value = Number(String(raw === undefined || raw === null ? '' : raw).replace(/px$/i, '').trim());
      return Number.isFinite(value) && value > 0 ? value : 0;
    };
    const style = String((attrs && attrs.style) || '');
    const fromStyle = property => {
      for (const declaration of style.split(';')) {
        const colon = declaration.indexOf(':');
        if (colon < 0) continue;
        if (declaration.slice(0, colon).trim().toLowerCase() !== property) continue;
        return numeric(declaration.slice(colon + 1));
      }
      return 0;
    };
    const width = numeric(attrs && attrs.width) || fromStyle('width');
    const height = numeric(attrs && attrs.height) || fromStyle('height');
    return width && height ? { width, height } : null;
  }

  // A thread's own ratios predict it better than a fixed guess. Geometric mean,
  // because ratios are multiplicative: the mean of 2 and 1/2 should be 1.
  function geometricMeanRatio(logSum, count, fallback) {
    if (!count) return fallback;
    return clampRatio(Math.exp(logSum / count)) || fallback;
  }

  function mergeRatioCache(existing, additions, limit) {
    const merged = Object.assign({}, existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {});
    Object.entries(additions && typeof additions === 'object' ? additions : {}).forEach(([key, entry]) => {
      if (!key || !Array.isArray(entry)) return;
      const ratio = Number(entry[0]);
      if (!Number.isFinite(ratio) || ratio <= 0) return;
      const time = Number(entry[1]);
      merged[key] = [Math.round(ratio * 1000) / 1000, Number.isFinite(time) ? time : 0];
    });
    const keys = Object.keys(merged);
    if (keys.length <= limit) return merged;
    keys.sort((a, b) => Number(merged[b][1] || 0) - Number(merged[a][1] || 0));
    return Object.fromEntries(keys.slice(0, limit).map(key => [key, merged[key]]));
  }

  const RATIO_SOURCE_RANK = { assumed: 0, attr: 1, thumb: 2, measured: 3 };
  const ratioStats = { logSum: 0, count: 0 };
  let ratioCache = storedRatioCache && typeof storedRatioCache === 'object' && !Array.isArray(storedRatioCache) ? storedRatioCache : {};
  let pendingRatios = {};
  let ratioFlushTimer = 0;
  let ratioCacheReadAt = Date.now();

  function assumedRatio() {
    return geometricMeanRatio(ratioStats.logSum, ratioStats.count, DEFAULT_RATIO);
  }

  function itemRatio(item) {
    return (item && item.ratio && item.ratio.value) || assumedRatio();
  }

  function queueRatioFlush() {
    if (ratioFlushTimer) return;
    ratioFlushTimer = setTimeout(() => {
      ratioFlushTimer = 0;
      const additions = pendingRatios;
      pendingRatios = {};
      if (!Object.keys(additions).length) return;
      // Losing a cached ratio only costs one first-paint layout guess, so this
      // re-reads on a timer rather than on every flush during a fast scroll.
      if (Date.now() - ratioCacheReadAt > 15000) {
        ratioCacheReadAt = Date.now();
        try {
          const stored = storage.get(RATIO_CACHE_KEY, null);
          if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
            ratioCache = mergeRatioCache(stored, ratioCache, RATIO_CACHE_LIMIT);
          }
        } catch { /* Fall back to this tab's copy. */ }
      }
      ratioCache = mergeRatioCache(ratioCache, additions, RATIO_CACHE_LIMIT);
      try { storage.set(RATIO_CACHE_KEY, ratioCache); }
      catch { /* Layout must not depend on storage being writable. */ }
    }, 2000);
  }

  // Later, better-sourced measurements win; equal-source jitter under 2% is
  // ignored so a re-render cannot nudge the layout.
  function applyMeasuredRatio(item, width, height, source) {
    const ratio = clampRatio(Number(width) / Number(height));
    if (!item || !ratio) return false;
    const current = item.ratio;
    if (current) {
      if (RATIO_SOURCE_RANK[current.source] > RATIO_SOURCE_RANK[source]) return false;
      if (Math.abs(ratio - current.value) / current.value < 0.02) return false;
    }
    item.ratio = { value: ratio, source, width: Number(width), height: Number(height) };
    ratioStats.logSum += Math.log(ratio);
    ratioStats.count++;
    if (item.selectionKey) {
      pendingRatios[item.selectionKey] = [ratio, Math.round(Date.now() / 1000)];
      queueRatioFlush();
    }
    return true;
  }

  function seedRatioFromCache(item) {
    if (!item || item.ratio || !item.selectionKey) return;
    const cached = ratioCache[item.selectionKey];
    const ratio = Array.isArray(cached) ? clampRatio(cached[0]) : 0;
    if (ratio) {
      item.ratio = { value: ratio, source: 'thumb', width: 0, height: 0 };
      return;
    }
    const hint = item.dimHint ? clampRatio(item.dimHint.width / item.dimHint.height) : 0;
    if (hint) item.ratio = { value: hint, source: 'attr', width: item.dimHint.width, height: item.dimHint.height };
  }

  /* ---- Layout engine -------------------------------------------------------
     Pure geometry: no state, no DOM. Produces absolutely-positioned cells that
     a windowed renderer can mount a slice of. Everything between here and
     IMAGE_EXT is directly exercisable by the test harness.
     ------------------------------------------------------------------------ */

  function entryRatio(entry, fallback) {
    const ratio = clampRatio(entry && entry.ratio);
    return ratio || fallback;
  }

  // Masonry, computed rather than CSS multi-column: shortest column wins. CSS
  // columns cannot be virtualized because the browser must see every box to
  // balance them.
  function packColumns(entries, options) {
    const gap = options.gap;
    const chromeHeight = options.chromeHeight || 0;
    const fallback = options.assumedRatio || 0.72;
    // Without a cap this fills the width, which is denser than the CSS columns
    // it replaced: those preferred fewer, larger cards. maxColumns carries that
    // preference over, so folding the windowed renderer into masonry did not
    // silently change how the default layout looks.
    const fits = Math.max(1, Math.floor((options.containerWidth + gap) / (options.columnWidth + gap)));
    const columns = Number(options.maxColumns) > 0 ? Math.min(fits, Number(options.maxColumns)) : fits;
    const width = Math.floor((options.containerWidth - (gap * (columns - 1))) / columns);
    const bottoms = new Array(columns).fill(0);
    const cells = entries.map(entry => {
      let shortest = 0;
      for (let column = 1; column < columns; column++) {
        if (bottoms[column] < bottoms[shortest]) shortest = column;
      }
      const height = Math.round(width / entryRatio(entry, fallback)) + chromeHeight;
      const cell = {
        key: entry.key,
        x: shortest * (width + gap),
        y: bottoms[shortest],
        width,
        height,
      };
      bottoms[shortest] += height + gap;
      return cell;
    });
    const tallest = bottoms.reduce((max, value) => (value > max ? value : max), 0);
    return { cells, columns, columnWidth: width, height: Math.max(0, tallest - gap) };
  }

  // Cells must be ordered by y. Tops are monotonic; bottoms are not, because a
  // tall cell can start far above and still intersect. Walking backwards from
  // the lower bound is not enough -- it stops at the first non-overlapping
  // cell and misses anything taller behind it -- so the search starts a full
  // maxCellHeight early instead. Callers know that value from the model; when
  // it is unknown the range degrades to correct-but-wide rather than wrong.
  function visibleRowRange(cells, scrollTop, viewportHeight, overscanPx, maxCellHeight) {
    if (!cells.length) return { start: 0, end: -1 };
    const overscan = overscanPx || 0;
    const min = scrollTop - overscan;
    const max = scrollTop + viewportHeight + overscan;
    const reach = Number.isFinite(maxCellHeight) ? Math.max(0, maxCellHeight) : Infinity;
    const lowerBound = reach === Infinity ? -Infinity : min - reach;

    let lo = 0;
    let hi = cells.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cells[mid].y >= lowerBound) hi = mid;
      else lo = mid + 1;
    }
    let start = lo;

    lo = 0;
    hi = cells.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cells[mid].y <= max) lo = mid + 1;
      else hi = mid;
    }
    const end = lo - 1;
    if (start > end) return { start: 0, end: -1 };
    // Trim leading cells that the widened lower bound swept in but which do not
    // actually reach the window.
    while (start <= end && cells[start].y + cells[start].height < min) start += 1;
    return start > end ? { start: 0, end: -1 } : { start, end };
  }

  const IMAGE_EXT = /\.(?:jpe?g|png|gif|webp|avif|bmp)(?:$|[?#./])/i;
  const IMAGE_EXT_BARE = /^(?:jpe?g|png|gif|webp|avif|bmp)$/i;
  const VIDEO_EXT = /\.(?:mp4|webm|mov|m4v)(?:$|[?#./])/i;
  const IGNORE_IMG = /(?:avatar|smilie|emoji|reaction|sprite|logo)/i;
  const TYPE_ORDER = { image: 0, video: 1, embed: 1, link: 2, text: 3 };
  const ICON_PATHS = {
    gallery: '<rect x="3.25" y="6.75" width="14" height="12.5" rx="2.5"/><path d="M7.25 6.75V5.5a2.25 2.25 0 0 1 2.25-2.25h8A2.25 2.25 0 0 1 19.75 5.5v8.25a2.25 2.25 0 0 1-1.5 2.12"/><circle cx="7.9" cy="11" r="1.15"/><path d="m3.6 17.9 3.9-3.6a1.4 1.4 0 0 1 1.9 0l2 1.9 2.2-2a1.4 1.4 0 0 1 1.9 0l1.75 1.6"/>',
    settings: '<path d="M9.74 6.12 10.24 2.97 13.76 2.97 14.26 6.12 15.96 7.1 18.94 5.96 20.7 9 18.22 11.01 18.22 12.99 20.7 15 18.94 18.04 15.96 16.9 14.26 17.88 13.76 21.03 10.24 21.03 9.74 17.88 8.04 16.9 5.06 18.04 3.3 15 5.78 12.99 5.78 11.01 3.3 9 5.06 5.96 8.04 7.1Z"/><circle cx="12" cy="12" r="2.8"/>',
    layout: '<rect x="3.25" y="4.25" width="7.25" height="7.25" rx="1.6"/><rect x="13.5" y="4.25" width="7.25" height="4.5" rx="1.6"/><rect x="3.25" y="14.5" width="7.25" height="5.25" rx="1.6"/><rect x="13.5" y="11.75" width="7.25" height="8" rx="1.6"/>',
    keyboard: '<rect x="2.75" y="6" width="18.5" height="12" rx="2.5"/><path d="M6.5 9.75h.01M10 9.75h.01M13.5 9.75h.01M17 9.75h.01M6.5 13.9h.01M17 13.9h.01M9.5 13.9h5" stroke-width="2.4"/>',
    close: '<path d="m6.75 6.75 10.5 10.5M17.25 6.75 6.75 17.25"/>',
    download: '<path d="M12 3.75v10.5m0 0 3.75-3.75M12 14.25 8.25 10.5"/><path d="M4.25 16.25v2a2 2 0 0 0 2 2h11.5a2 2 0 0 0 2-2v-2"/>',
    select: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="m8 12.2 2.7 2.7L16.2 9.4"/>',
    image: '<rect x="3" y="4.25" width="18" height="15.5" rx="2.5"/><circle cx="8.4" cy="9.4" r="1.5"/><path d="m3.4 17.6 4.4-4.1a1.5 1.5 0 0 1 2.05 0l2.15 2 2.4-2.2a1.5 1.5 0 0 1 2.05 0l4.15 3.8"/>',
    video: '<rect x="2.75" y="5" width="18.5" height="14" rx="2.75"/><path d="M10.4 9.35a.4.4 0 0 1 .61-.34l3.9 2.65a.4.4 0 0 1 0 .68l-3.9 2.65a.4.4 0 0 1-.61-.34Z"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
    reset: '<path d="M20.25 12a8.25 8.25 0 1 1-2.42-5.83"/><path d="M20.25 4.5V10h-5.5"/>',
    upload: '<path d="M12 15V4.5m0 0L8.25 8.25M12 4.5l3.75 3.75"/><path d="M4.25 16.25v2a2 2 0 0 0 2 2h11.5a2 2 0 0 0 2-2v-2"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11.25v5"/><path d="M12 7.9h.01" stroke-width="2.4"/>',
    filter: '<path d="M4 5.25h16l-6.15 7v5.35l-3.7 1.65V12.25Z"/>',
    sliders: '<path d="M4.5 7.5h9M17.5 7.5h2M4.5 16.5h2M10.5 16.5h9"/><circle cx="15.5" cy="7.5" r="2.25"/><circle cx="8.5" cy="16.5" r="2.25"/>',
    palette: '<path d="M12 3.25a8.75 8.75 0 0 0 0 17.5h1.15a1.9 1.9 0 0 0 1.35-3.25l-.3-.3a1.35 1.35 0 0 1 .95-2.3h1.6a4.5 4.5 0 0 0 4.5-4.5c0-3.95-4.15-7.15-9.25-7.15Z"/><circle cx="7.9" cy="10.4" r="1.05"/><circle cx="10.4" cy="7.1" r="1.05"/><circle cx="14" cy="7.1" r="1.05"/><circle cx="16.6" cy="10.4" r="1.05"/>',
    chevron: '<path d="m6.75 9.75 5.25 5 5.25-5"/>',
    more: '<path d="M6 12h.01M12 12h.01M18 12h.01" stroke-width="2.4"/>',
    scan: '<path d="M3.75 8V5.75a2 2 0 0 1 2-2H8M16 3.75h2.25a2 2 0 0 1 2 2V8M20.25 16v2.25a2 2 0 0 1-2 2H16M8 20.25H5.75a2 2 0 0 1-2-2V16"/><path d="M7.5 12h9"/>',
    zoomIn: '<circle cx="10.75" cy="10.75" r="6.5"/><path d="m15.6 15.6 4.65 4.65M10.75 7.9v5.7M7.9 10.75h5.7"/>',
    zoomOut: '<circle cx="10.75" cy="10.75" r="6.5"/><path d="m15.6 15.6 4.65 4.65M7.9 10.75h5.7"/>',
    fit: '<path d="M9.75 4.25H4.25V9.75M14.25 4.25h5.5V9.75M9.75 19.75H4.25V14.25M14.25 19.75h5.5V14.25"/><rect x="8.75" y="8.75" width="6.5" height="6.5" rx="1.4"/>',
    fullscreen: '<path d="M9 3.75H5.75a2 2 0 0 0-2 2V9M15 3.75h3.25a2 2 0 0 1 2 2V9M9 20.25H5.75a2 2 0 0 1-2-2V15M15 20.25h3.25a2 2 0 0 0 2-2V15"/>',
    external: '<path d="M14.25 3.75h6v6M20.25 3.75 12 12"/><path d="M18.5 13.5v4.75a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2h4.75"/>',
    play: '<circle cx="12" cy="12" r="8.5"/><path d="M10.4 9.15a.4.4 0 0 1 .61-.34l4.35 2.85a.4.4 0 0 1 0 .68l-4.35 2.85a.4.4 0 0 1-.61-.34Z"/>',
    search: '<circle cx="10.75" cy="10.75" r="6.75"/><path d="m15.75 15.75 4.5 4.5"/>',
    link: '<path d="M10.1 13.4a4.6 4.6 0 0 0 6.85.5l2.05-2.05a4.6 4.6 0 0 0-6.5-6.5l-1.2 1.2"/><path d="M13.9 10.6a4.6 4.6 0 0 0-6.85-.5L5 12.15a4.6 4.6 0 0 0 6.5 6.5l1.2-1.2"/>',
    text: '<path d="M4.75 6.25V4.75h14.5v1.5M12 4.75v14.5M9 19.25h6"/>',
    page: '<path d="M6 3.75h7.5l4.5 4.5v12a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V5.25A1.5 1.5 0 0 1 6 3.75Z"/><path d="M13.5 3.75v4.5H18M8.25 13h7.5M8.25 16.5h5.25"/>',
    archive: '<rect x="3.25" y="7.75" width="17.5" height="12.5" rx="2.25"/><path d="M3.25 11.5h17.5"/><path d="M5.75 7.75V5.5a1.5 1.5 0 0 1 1.5-1.5h9.5a1.5 1.5 0 0 1 1.5 1.5v2.25"/><path d="M10 15.25h4"/>',
    history: '<path d="M3.75 12a8.25 8.25 0 1 0 2.42-5.83L3.75 8.5"/><path d="M3.75 3.75V8.5h4.75"/><path d="M12 7.75V12l2.9 1.75"/>',
    clear: '<rect x="3.75" y="3.75" width="16.5" height="16.5" rx="4" stroke-dasharray="3.2 2.4"/><path d="m9.25 9.25 5.5 5.5m0-5.5-5.5 5.5"/>',
    check: '<circle cx="12" cy="12" r="8.5"/><path d="m8.25 12.2 2.7 2.7 4.8-5.8"/>',
    trash: '<path d="M4.25 6.75h15.5"/><path d="M9.25 6.75V4.9a1.15 1.15 0 0 1 1.15-1.15h3.2A1.15 1.15 0 0 1 14.75 4.9v1.85"/><path d="M6.75 6.75 7.7 19.1a1.5 1.5 0 0 0 1.5 1.4h5.6a1.5 1.5 0 0 0 1.5-1.4l.95-12.35"/><path d="M10.5 10.5v6M13.5 10.5v6"/>',
    previous: '<path d="m14.5 5.75-6.25 6.25 6.25 6.25"/>',
    next: '<path d="m9.5 5.75 6.25 6.25-6.25 6.25"/>',
    up: '<path d="m6.75 11 5.25-5.25L17.25 11"/><path d="M12 6v12.25"/>',
  };

  // An icon is a pure function of its name and class, and a card mounts several.
  // The windowed renderer remounts constantly, so this stops rebuilding
  // identical SVG strings for the life of the page.
  const iconCache = new Map();

  function icon(name, className = '') {
    const cacheKey = `${name}\u0000${className}`;
    let markup = iconCache.get(cacheKey);
    if (markup !== undefined) return markup;
    const paths = ICON_PATHS[name] || ICON_PATHS.info;
    markup = `<svg class="scg-icon ${escapeHtml(className)}" data-scg-icon="${escapeHtml(name)}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
    iconCache.set(cacheKey, markup);
    return markup;
  }

  const iconWellCache = new Map();

  function iconWell(name, className = '') {
    const cacheKey = `${name}\u0000${className}`;
    let markup = iconWellCache.get(cacheKey);
    if (markup !== undefined) return markup;
    markup = `<i class="scg-icon-well ${escapeHtml(className)}" aria-hidden="true">${icon(name)}</i>`;
    iconWellCache.set(cacheKey, markup);
    return markup;
  }

  function setIconButton(button, iconName, label) {
    if (!button) return;
    const wellClass = ['download', 'archive'].includes(iconName) ? 'scg-icon-well-primary' : (iconName === 'close' ? 'scg-icon-well-danger' : '');
    button.innerHTML = `${iconWell(iconName, wellClass)}<span>${escapeHtml(label)}</span>`;
    button.setAttribute('aria-label', label);
  }

  function setIconOnlyButton(button, iconName, label, wellClass = '') {
    if (!button) return;
    button.innerHTML = iconWell(iconName, wellClass);
    button.setAttribute('aria-label', label);
    if (button.hasAttribute('data-tooltip')) button.dataset.tooltip = label;
  }

  function recordDiagnostic(category, stage, error, item = null) {
    const bucket = state.diagnostics[category];
    if (!Array.isArray(bucket)) return;
    const entry = {
      time: new Date().toISOString(),
      stage,
      message: String(error?.message || error || 'Unknown error').slice(0, 300),
      host: item ? hostOf(item.originalLink || item.url || '') : '',
      type: item?.type || '',
      page: Number(item?.pageNumber || 0),
    };
    bucket.push(entry);
    if (bucket.length > 100) bucket.splice(0, bucket.length - 100);
    if (document.querySelector(`#${APP_ID} .scg-settings-panel.open`)) refreshSettingsPanel();
  }

  const absoluteUrl = (value, base = location.href) => {
    if (!value) return '';
    try {
      const url = new URL(value, base);
      return /^(?:https?):$/.test(url.protocol) ? url.href : '';
    } catch { return ''; }
  };

  const threadBaseUrl = (rawUrl = location.href) => {
    try {
      const url = new URL(rawUrl, location.href);
      url.pathname = url.pathname.replace(/\/page-\d+\/?$/i, '').replace(/\/$/, '');
      url.search = '';
      url.hash = '';
      return url.href.replace(/\/$/, '');
    } catch { return String(rawUrl).replace(/\/page-\d+(?:[/?#].*)?$/i, '').replace(/[?#].*$/, '').replace(/\/$/, ''); }
  };

  const pageNumberFromUrl = (rawUrl = location.href) => {
    try { return Number(new URL(rawUrl, location.href).pathname.match(/\/page-(\d+)\/?$/i)?.[1] || 1); }
    catch { return Number(String(rawUrl).match(/\/page-(\d+)/i)?.[1] || 1); }
  };

  const threadPageUrl = page => page > 1 ? `${threadBaseUrl()}/page-${page}` : threadBaseUrl();

  function slugify(value, maxLength = 44) {
    return String(value || '')
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '')
      .replace(/-+/g, '-').slice(0, maxLength).replace(/-+$/g, '')
      .toLowerCase();
  }

  function threadIdentity(rawUrl = location.href) {
    try {
      const url = new URL(rawUrl, location.href);
      const segment = decodeURIComponent(url.pathname.match(/\/threads\/([^/]+)/i)?.[1] || 'thread');
      const match = segment.match(/^(.*?)(?:\.(\d+))?$/);
      return { slug: slugify(match?.[1] || segment) || 'thread', id: match?.[2] || '' };
    } catch { return { slug: 'thread', id: '' }; }
  }

  let scanProgress = (() => {
    const saved = storage.get(SCAN_PROGRESS_KEY, {});
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  })();

  function scanProgressKey(rawUrl = location.href) {
    const identity = threadIdentity(rawUrl);
    return identity.id || threadBaseUrl(rawUrl);
  }

  function highestScannedPage(rawUrl = location.href) {
    return Math.max(0, Number(scanProgress[scanProgressKey(rawUrl)] || 0));
  }

  function rememberScannedPage(page, rawUrl = location.href) {
    const key = scanProgressKey(rawUrl);
    const stored = storage.get(SCAN_PROGRESS_KEY, {});
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) scanProgress = { ...scanProgress, ...stored };
    const next = Math.max(highestScannedPage(rawUrl), Math.max(0, Number(stored?.[key]) || 0), Math.max(0, Number(page) || 0));
    if (!next || scanProgress[key] === next) return next;
    scanProgress[key] = next;
    const entries = Object.entries(scanProgress);
    if (entries.length > 200) scanProgress = Object.fromEntries(entries.slice(-200));
    try { storage.set(SCAN_PROGRESS_KEY, scanProgress); }
    catch { /* Scan progress is a convenience; storage failure must not fail the scan. */ }
    return next;
  }

  let selectionStore = (() => {
    const saved = storage.get(SELECTIONS_KEY, {});
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  })();
  const storedSelectionKey = scanProgressKey();
  let persistedSelectionKeys = new Set(Array.isArray(selectionStore[storedSelectionKey]) ? selectionStore[storedSelectionKey].slice(0, 5000) : []);

  function persistThreadSelection() {
    persistedSelectionKeys = new Set([...state.selected].slice(0, 5000));
    const stored = storage.get(SELECTIONS_KEY, {});
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) selectionStore = { ...selectionStore, ...stored };
    if (persistedSelectionKeys.size) selectionStore[storedSelectionKey] = [...persistedSelectionKeys];
    else delete selectionStore[storedSelectionKey];
    const entries = Object.entries(selectionStore);
    if (entries.length > 40) selectionStore = Object.fromEntries(entries.slice(-40));
    try { storage.set(SELECTIONS_KEY, selectionStore); }
    catch { /* Selection remains valid in memory if userscript storage is full. */ }
  }

  function threadTitle() {
    const heading = document.querySelector('h1.p-title-value, .p-title-value, h1');
    if (heading) {
      const clone = heading.cloneNode(true);
      clone.querySelectorAll('.label, .prefix, .js-prefixTitle, script, style').forEach(node => node.remove());
      const title = (clone.textContent || '').replace(/\s+/g, ' ').trim();
      if (title) return title;
    }
    const identity = threadIdentity();
    return identity.slug.split('-').filter(Boolean).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') || 'Thread gallery';
  }

  function threadFilePrefix(rawUrl = location.href) {
    const thread = threadIdentity(rawUrl);
    return [thread.slug, thread.id].filter(Boolean).join('-').slice(0, 58) || 'simpcity-thread';
  }

  function detectThreadPageCount(doc, pageUrl = location.href) {
    const values = [pageNumberFromUrl(pageUrl)];
    doc.querySelectorAll('.pageNav-page a, .pageNav-main a, .pageNavSimple a, a.pageNav-jump').forEach(anchor => {
      const textNumber = Number((anchor.textContent || '').trim());
      const hrefNumber = Number(anchor.getAttribute('href')?.match(/\/page-(\d+)/i)?.[1] || 0);
      if (Number.isFinite(textNumber) && textNumber > 0) values.push(textNumber);
      if (hrefNumber > 0) values.push(hrefNumber);
    });
    const lastText = doc.querySelector('.pageNavSimple-el--last, .pageNav-page--last')?.textContent || '';
    const lastNumber = Number(lastText.match(/\d+/g)?.pop() || 0);
    if (lastNumber > 0) values.push(lastNumber);
    return Math.max(1, ...values);
  }

  function updateThreadPageInfo(doc = document, pageUrl = location.href) {
    state.threadPageCount = Math.max(state.threadPageCount, detectThreadPageCount(doc, pageUrl));
  }

  const bestImageUrl = (img, base) => {
    const srcset = img.getAttribute('srcset');
    const largestSrcset = srcset?.split(',').map(part => {
      const match = part.trim().match(/^(.*?)\s+(\d+)(?:w|x)$/);
      return match ? { url: match[1], size: Number(match[2]) } : null;
    }).filter(Boolean).sort((a, b) => b.size - a.size)[0]?.url;
    const raw = img.getAttribute('data-full-url') || img.getAttribute('data-original') ||
      img.getAttribute('data-url') || largestSrcset || img.getAttribute('data-src') ||
      img.getAttribute('data-lazy-src') ||
      img.currentSrc || img.getAttribute('src') || '';
    return absoluteUrl(raw, base);
  };

  const unwrapSimpcityRedirect = (rawUrl) => {
    try {
      const url = new URL(rawUrl, location.href);
      if (url.origin === location.origin && url.pathname === '/redirect/') {
        const target = url.searchParams.get('to');
        if (target) return absoluteUrl(atob(target), location.href);
      }
      return absoluteUrl(url.href);
    } catch { return ''; }
  };

  const normalizeSourceUrl = (rawUrl, base = location.href) => unwrapSimpcityRedirect(absoluteUrl(rawUrl, base));

  const HOST_REGISTRY = Object.freeze([
    Object.freeze({
      id: 'goonbox', media: 'image', imagePage: true,
      matches: host => /(?:^|\.)goonbox\.cr$/i.test(host),
      imageId: url => url.pathname.match(/^\/(?:img|image|view)\/([\w-]+)/i)?.[1] || '',
      thumbnailToCandidate: thumb => thumb.replace(/\.md(?=\.[a-z0-9]+(?:$|[?#]))/i, ''),
    }),
    Object.freeze({
      id: 'pixhost', media: 'image', imagePage: true,
      matches: host => /^(?:t\d+|img\d+|www)\.pixhost\.to$|^pixhost\.to$/i.test(host),
      thumbnailToCandidate: thumb => thumb
        .replace(/:\/\/t(\d+)\.pixhost\.to\/thumbs\//i, '://img$1.pixhost.to/images/')
        .replace(/\/thumbs\/(\d+)\//i, '/images/$1/'),
    }),
    Object.freeze({
      id: 'imgbox', media: 'image', imagePage: true,
      matches: host => /(?:^|\.)imgbox\.com$/i.test(host),
    }),
    Object.freeze({
      id: 'simp-image-cdn', media: 'image',
      matches: host => /^(?:jpg6\.su|jpg7\.cr|simp[46]\.selti-delivery\.ru)$/i.test(host),
      thumbnailToCandidate: thumb => thumb.replace(/\.md(?=\.[a-z0-9]+(?:$|[?#]))/i, ''),
    }),
    Object.freeze({
      id: 'turbo', media: 'video',
      matches: host => /(?:^|\.)(?:turbo\.cr|turbovid\.cr)$/i.test(host),
      mediaId: url => url.pathname.match(/^\/(?:v|embed|d)\/([^/?]+)/i)?.[1] || '',
      embed: url => {
        const id = url.pathname.match(/^\/(?:v|embed|d)\/([^/?]+)/i)?.[1];
        return id ? `https://turbo.cr/embed/${encodeURIComponent(id)}` : url.href;
      },
    }),
    Object.freeze({
      id: 'youtube', media: 'video',
      matches: host => /(?:^|\.)(?:youtube\.com|youtu\.be)$/i.test(host),
      mediaId: url => url.hostname.replace(/^www\./, '') === 'youtu.be'
        ? url.pathname.split('/').filter(Boolean)[0] || ''
        : url.searchParams.get('v') || url.pathname.match(/\/(?:shorts|embed)\/([^/?]+)/)?.[1] || '',
      embed: url => {
        const id = url.hostname.replace(/^www\./, '') === 'youtu.be'
          ? url.pathname.split('/').filter(Boolean)[0]
          : url.searchParams.get('v') || url.pathname.match(/\/(?:shorts|embed)\/([^/?]+)/)?.[1];
        return id ? `https://www.youtube.com/embed/${encodeURIComponent(id)}` : url.href;
      },
    }),
    Object.freeze({
      id: 'vimeo', media: 'video',
      matches: host => /(?:^|\.)vimeo\.com$/i.test(host),
      mediaId: url => url.pathname.match(/\/(\d+)/)?.[1] || '',
      embed: url => {
        const id = url.pathname.match(/\/(\d+)/)?.[1];
        return id ? `https://player.vimeo.com/video/${id}` : url.href;
      },
    }),
    Object.freeze({
      id: 'streamable', media: 'video',
      matches: host => /(?:^|\.)streamable\.com$/i.test(host),
      mediaId: url => url.pathname.split('/').filter(Boolean).pop() || '',
      embed: url => {
        const id = url.pathname.split('/').filter(Boolean).pop();
        return id ? `https://streamable.com/e/${encodeURIComponent(id)}` : url.href;
      },
    }),
    Object.freeze({
      id: 'redgifs', media: 'video',
      matches: host => /(?:^|\.)redgifs\.com$/i.test(host),
      mediaId: url => url.pathname.split('/').filter(Boolean).pop() || '',
      embed: url => {
        const id = url.pathname.split('/').filter(Boolean).pop();
        return id ? `https://www.redgifs.com/ifr/${encodeURIComponent(id)}` : url.href;
      },
    }),
    Object.freeze({
      id: 'dood', media: 'video',
      matches: host => /(?:^|\.)dood[^.]*\./i.test(host),
      embed: url => { url.pathname = url.pathname.replace(/^\/d\//, '/e/'); return url.href; },
    }),
    Object.freeze({
      // Bunkr serves images and videos behind one link shape, so `media` only
      // says which facet the thread markup lands it in; the byte signature
      // decides what the file actually is at download time.
      id: 'bunkr', media: 'video',
      matches: host => /(?:^|\.)bunkr+\.[a-z]{2,6}$/i.test(host),
      mediaId: url => url.pathname.match(/^\/f\/([^/?#]+)/i)?.[1] || '',
    }),
    Object.freeze({
      // A /u/ URL is one stable file. /l/ list URLs remain ordinary host cards.
      id: 'pixeldrain', media: 'video',
      matches: host => /(?:^|\.)pixeldrain\.com$/i.test(host),
      mediaId: url => url.pathname.match(/^\/u\/([^/?#]+)/i)?.[1] || '',
    }),
    Object.freeze({
      id: 'generic-video-host', media: 'video',
      matches: host => /(?:^|\.)(?:voe\.|gofile\.io$|cyberfile\.|pixeldrain\.com$|bunkr\.|saint2\.|saint\.to$|imgur\.com$|mega\.nz$)/i.test(host),
    }),
  ]);

  function hostDefinition(rawUrl) {
    try {
      const url = new URL(normalizeSourceUrl(rawUrl));
      return HOST_REGISTRY.find(definition => definition.matches(url.hostname.replace(/^www\./, ''))) || null;
    } catch { return null; }
  }

  function hostMediaId(rawUrl) {
    try {
      const normalized = normalizeSourceUrl(rawUrl);
      const url = new URL(normalized);
      return hostDefinition(normalized)?.mediaId?.(url) || '';
    } catch { return ''; }
  }

  function isKnownVideoHost(rawUrl) {
    return hostDefinition(rawUrl)?.media === 'video';
  }

  function isImagePageHost(rawUrl) {
    return hostDefinition(rawUrl)?.imagePage === true;
  }

  function imagePreviewCandidate(thumb, originalLink = '') {
    if (!thumb) return { status: 'failed', url: '', method: 'missing-thumbnail' };
    const definition = hostDefinition(originalLink) || hostDefinition(thumb);
    const transformed = definition?.thumbnailToCandidate?.(thumb) || thumb.replace(/([/_-])thumb(?:nail)?([/_-])/i, '$1$2');
    if (transformed && transformed !== thumb) return { status: 'heuristic', url: transformed, method: `${definition?.id || 'generic'}-thumbnail-rewrite` };
    return { status: 'heuristic', url: thumb, method: 'thumbnail' };
  }

  const isMediaItem = item => item?.type === 'image' || item?.type === 'video' || item?.type === 'embed';

  // A single Bunkr file has a resolver that runs at queue time, so it counts as
  // downloadable before anything has been resolved. An album page has no file
  // behind it and must stay out of the ZIP queue.
  const isBunkrFileUrl = rawUrl => hostDefinition(rawUrl)?.id === 'bunkr' && Boolean(hostMediaId(rawUrl));

  const isPixeldrainFileUrl = rawUrl => hostDefinition(rawUrl)?.id === 'pixeldrain' && Boolean(hostMediaId(rawUrl));

  function hasDirectResolver(item) {
    if (!item) return false;
    return hostDefinition(item.url)?.id === 'turbo' || isBunkrFileUrl(item.url) || isBunkrFileUrl(item.originalLink) ||
      isPixeldrainFileUrl(item.url) || isPixeldrainFileUrl(item.originalLink);
  }

  function isDownloadableMedia(item) {
    if (!isMediaItem(item)) return false;
    const candidate = item.resolution?.candidate;
    if (candidate?.status === 'failed' || (item.resolution?.attempted && !candidate?.url)) return false;
    if (item.type === 'image') return Boolean(candidate?.url || item.url || item.thumb);
    if (item.type === 'video') return Boolean((candidate?.url && VIDEO_EXT.test(candidate.url)) || VIDEO_EXT.test(item.url || ''));
    if (candidate?.status === 'confirmed' && candidate.url) return true;
    // Hosts with a resolver that runs at queue time. A failed attempt has
    // already returned above, so a dead link cannot come back through here.
    // The verdict is derived at index time; the fallback is for items that have
    // not been through appendUniqueItems.
    return item.directResolver === undefined ? hasDirectResolver(item) : item.directResolver;
  }

  function downloadHistoryKey(item) {
    if (item && item.historyKey) return item.historyKey;
    const base = threadBaseUrl(item?.pageUrl || item?.postUrl || location.href);
    return `${base}|${item?.selectionKey || itemDedupeKey(item)}`;
  }

  function downloadHistoryEntry(item) {
    if (!item) return null;
    const primary = state.downloadHistory[downloadHistoryKey(item)];
    if (primary) return primary;
    for (const alias of item.historyAliases || []) {
      if (state.downloadHistory[alias]) return state.downloadHistory[alias];
    }
    return null;
  }

  function wasDownloaded(item) {
    return downloadHistoryEntry(item)?.verified === true;
  }

  function hasLegacyDownload(item) {
    const entry = downloadHistoryEntry(item);
    return Boolean(entry && entry.verified !== true);
  }

  function downloadHistoryCounts() {
    return Object.values(state.downloadHistory).reduce((counts, entry) => {
      if (entry?.verified === true) counts.verified++;
      else counts.legacy++;
      return counts;
    }, { verified: 0, legacy: 0 });
  }

  // Records this tab has created but not yet written. Kept apart from
  // state.downloadHistory, which is a view of the record plus these.
  let pendingHistoryWrites = {};

  function readStoredDownloadHistory() {
    const stored = storage.get(DOWNLOAD_HISTORY_KEY, {});
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? normalizeDownloadHistory(stored) : {};
  }

  // Storage is the record; this tab only ever contributes what it created since
  // its last write. Writing the whole in-memory map back would let a tab that
  // missed a Clear History elsewhere resurrect every record it still held.
  // `replace` is for restoring a backup, where the file is meant to be the record.
  function persistDownloadHistory({ replace = false } = {}) {
    try {
      const next = replace ? state.downloadHistory : mergeDownloadHistory(readStoredDownloadHistory(), pendingHistoryWrites);
      const entries = Object.entries(next)
        .sort((a, b) => Number(b[1]?.time || 0) - Number(a[1]?.time || 0))
        .slice(0, 5000);
      state.downloadHistory = Object.fromEntries(entries);
      storage.set(DOWNLOAD_HISTORY_KEY, state.downloadHistory);
      // Only once the write has actually landed. Clearing first meant a quota
      // failure -- swallowed by the catch below -- dropped those markers from
      // the pending set for good, so no later write would ever carry them.
      pendingHistoryWrites = {};
      // An invalidation, never a payload: a payload would be a second source of
      // truth, and one bounded small enough to broadcast would silently truncate
      // a large import in every other tab.
      tabSync.post('download-history-changed');
    } catch { /* Downloading must still work if local storage is unavailable. */ }
  }

  // Re-reads the record and re-applies whatever this tab has not written yet, so
  // an invalidation never discards an in-flight ZIP batch's markers.
  function reloadDownloadHistory() {
    state.downloadHistory = mergeDownloadHistory(readStoredDownloadHistory(), pendingHistoryWrites);
    invalidateVisibleItems({ history: true });
    if (state.downloadState && state.downloadState !== 'all') render();
    else updateDownloadedIndicators();
    if (document.querySelector(`#${APP_ID} .scg-settings-panel.open`)) refreshSettingsPanel();
  }

  function rememberDownloaded(item, filename, validation, deferPersist = false, container = '') {
    if (!validation?.verified) return false;
    const historyKey = downloadHistoryKey(item);
    const entry = {
      filename,
      size: Math.max(0, Number(validation.size || validation.blob?.size || 0)),
      time: Date.now(),
      verified: true,
      legacy: false,
      mime: String(validation.mime || ''),
      method: String(validation.method || 'validated-media'),
      container: String(container || ''),
    };
    state.downloadHistory[historyKey] = entry;
    // Tracked separately so the next write contributes only this, not the whole
    // map this tab happens to be holding.
    pendingHistoryWrites[historyKey] = entry;
    invalidateVisibleItems({ history: true });
    if (!deferPersist) {
      persistDownloadHistory();
      if (state.downloadState && state.downloadState !== 'all') render();
      else updateDownloadedIndicators();
    }
    return true;
  }

  function persistSettings() {
    try {
      storage.set(SETTINGS_KEY, {
        filter: state.filter,
        downloadState: state.downloadState,
        resolutionFilter: state.resolutionFilter,
        compact: state.compact,
        sort: state.sort,
        groupBy: state.groupBy,
        perPage: state.perPage,
        theme: state.theme,
        accent: state.accent,
        filtersCollapsed: state.filtersCollapsed,
        layoutMode: state.layoutMode,
        cardScale: state.cardScale,
        downloadConcurrency: state.downloadConcurrency,
        zipPartSizeMb: state.zipPartSizeMb,
        zipPartMaxFiles: state.zipPartMaxFiles,
        archiveLayout: state.archiveLayout,
        includeManifest: state.includeManifest,
        dedupeContent: state.dedupeContent,
        warnLargeThreadScan: state.warnLargeThreadScan,
        embedPosters: state.embedPosters,
        completionNotifications: state.completionNotifications,
        safeMode: state.safeMode,
        blockPatterns: state.blockPatterns,
        shortcuts: state.shortcuts,
      });
    }
    catch { /* Private browsing or storage restrictions should not break the gallery. */ }
  }

  function refreshThreadHeader() {
    const app = document.getElementById(APP_ID);
    if (!app) return;
    const title = app.querySelector('[data-thread-title]');
    const meta = app.querySelector('[data-thread-meta]');
    const source = app.querySelector('[data-source-summary]');
    if (title) {
      title.textContent = threadTitle();
      title.title = threadTitle();
    }
    if (meta) {
      const threadWide = /thread scan|entire thread/i.test(state.sourceLabel);
      meta.textContent = threadWide
        ? `${state.scanning ? 'Scanning' : 'Indexed'} ${state.scannedPages || 0} of ${state.threadPageCount} pages`
        : `Page ${state.sourcePage || pageNumberFromUrl()} of ${state.threadPageCount}`;
    }
    if (source) source.textContent = `${state.sourceLabel} · ${state.items.length} indexed`;
  }

  function applyShellState() {
    const app = document.getElementById(APP_ID);
    if (!app) return;
    app.dataset.theme = state.theme;
    app.dataset.accent = state.accent;
    app.dataset.layout = state.layoutMode;
    const cardScale = Math.min(160, Math.max(70, Number(state.cardScale) || 100));
    const scale = cardScale / 100;
    app.style.setProperty('--scg-masonry-width', `${Math.round(280 * scale)}px`);
    app.style.setProperty('--scg-masonry-compact-width', `${Math.round(195 * scale)}px`);
    app.style.setProperty('--scg-group-width', `${Math.round(250 * scale)}px`);
    app.style.setProperty('--scg-group-compact-width', `${Math.round(180 * scale)}px`);
    app.style.setProperty('--scg-grid-min', `${Math.round(250 * scale)}px`);
    app.style.setProperty('--scg-grid-compact-min', `${Math.round(180 * scale)}px`);
    app.style.setProperty('--scg-grid-height', `${Math.round(386 * scale)}px`);
    app.style.setProperty('--scg-grid-compact-height', `${Math.round(312 * scale)}px`);
    app.classList.toggle('compact', state.compact);
    app.classList.toggle('filters-collapsed', state.filtersCollapsed);
    app.classList.toggle('safe-mode', state.safeMode);
    const toast = document.getElementById('scg-tl-toast');
    if (toast) { toast.dataset.theme = state.theme; toast.dataset.accent = state.accent; }
    const launch = document.getElementById('scg-tl-launch');
    if (launch) { launch.dataset.theme = state.theme; launch.dataset.accent = state.accent; }
    const filterToggle = app.querySelector('[data-action="filters-toggle"]');
    if (filterToggle) {
      setIconOnlyButton(filterToggle, 'chevron', state.filtersCollapsed ? 'Show filters and view options' : 'Hide filters and view options');
      filterToggle.setAttribute('aria-expanded', String(!state.filtersCollapsed));
      filterToggle.classList.toggle('active', !state.filtersCollapsed);
    }
    setIconButton(app.querySelector('[data-action="density"]'), 'layout', state.compact ? 'Comfortable cards' : 'Compact cards');
    setIconButton(app.querySelector('[data-action="safe-mode"]'), 'image', state.safeMode ? 'Show media' : 'Blur media');
    const themeIndex = Math.max(0, THEME_MODES.indexOf(state.theme));
    const nextTheme = THEME_MODES[(themeIndex + 1) % THEME_MODES.length];
    const themeButton = app.querySelector('[data-action="theme"]');
    setIconButton(themeButton, 'palette', `Theme: ${THEME_LABELS[state.theme]}`);
    if (themeButton) themeButton.title = `Current theme: ${THEME_LABELS[state.theme]}. Activate for ${THEME_LABELS[nextTheme]}.`;
    refreshRefineTrigger();
    const themeSelect = app.querySelector('[data-setting-theme]');
    const accentSelect = app.querySelector('[data-setting-accent]');
    const densitySelect = app.querySelector('[data-setting-density]');
    const filterCheck = app.querySelector('[data-setting-filters-collapsed]');
    const layoutSelects = app.querySelectorAll('[data-setting-layout]');
    const sizeSliders = app.querySelectorAll('[data-card-scale]');
    const sizeLabels = app.querySelectorAll('[data-card-scale-value]');
    if (themeSelect) themeSelect.value = state.theme;
    if (accentSelect) accentSelect.value = state.accent;
    if (densitySelect) densitySelect.value = state.compact ? 'compact' : 'comfortable';
    sizeSliders.forEach(slider => {
      slider.value = String(cardScale);
      slider.disabled = state.scanning;
      slider.setAttribute('aria-valuetext', `${cardScale}%`);
    });
    sizeLabels.forEach(label => { label.textContent = `${cardScale}%`; });
    if (filterCheck) filterCheck.checked = state.filtersCollapsed;
    layoutSelects.forEach(select => { select.value = state.layoutMode; });
    refreshThreadHeader();
    // Density and card size feed the packing geometry, and both commit
    // shell-only. A live windowed layout has to re-pack itself; when one is not
    // live the upcoming render sets it up anyway.
    if (flow.model) scheduleFlowLayout();
  }

  // Progressive disclosure: the Refine popover advertises how much it is hiding.
  function activeRefinements() {
    return [
      state.sort !== DEFAULT_SETTINGS.sort,
      state.authorFilter && state.authorFilter !== 'all',
      state.hostFilter && state.hostFilter !== 'all',
      state.groupBy !== DEFAULT_SETTINGS.groupBy,
      state.downloadState !== DEFAULT_SETTINGS.downloadState,
      state.resolutionFilter !== DEFAULT_SETTINGS.resolutionFilter,
      Boolean(state.selectedOnly),
    ].filter(Boolean).length;
  }

  function refreshRefineTrigger() {
    const app = document.getElementById(APP_ID);
    const trigger = app?.querySelector('[data-action="refine-toggle"]');
    if (!trigger) return;
    const count = activeRefinements();
    const badge = trigger.querySelector('[data-refine-count]');
    trigger.classList.toggle('active', count > 0);
    trigger.setAttribute('aria-label', count ? `Refine results, ${count} active` : 'Refine results');
    if (badge) {
      badge.textContent = String(count);
      badge.toggleAttribute('hidden', count === 0);
    }
  }

  function closeDisclosures() {
    const app = document.getElementById(APP_ID);
    if (!app) return;
    app.querySelectorAll('.scg-menu.open, .scg-refine-popover.open').forEach(panel => panel.classList.remove('open'));
    app.querySelectorAll('[data-action="overflow"], [data-action="refine-toggle"], [data-action="select-menu"]').forEach(button => {
      button.setAttribute('aria-expanded', 'false');
    });
  }

  function toggleDisclosure(trigger, panel) {
    if (!trigger || !panel) return;
    const shouldOpen = !panel.classList.contains('open');
    closeDisclosures();
    if (!shouldOpen) return;
    panel.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    panel.querySelector('select:not(:disabled), button:not(:disabled), input:not(:disabled)')?.focus({ preventScroll: true });
  }

  function focusableWithin(container) {
    return [...container.querySelectorAll('button:not(:disabled),a[href],select:not(:disabled),input:not(:disabled),textarea:not(:disabled),video[controls],[tabindex]:not([tabindex="-1"])')]
      .filter(node => node.offsetParent !== null);
  }

  // Boundary-only containment: native tabbing is left intact inside the dialog.
  function containFocus(container, event) {
    const focusable = focusableWithin(container);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const inside = container.contains(document.activeElement);
    if (event.shiftKey && (!inside || document.activeElement === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (!inside || document.activeElement === last)) {
      event.preventDefault();
      first.focus();
    }
  }

  const prefersReducedMotion = () => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch { return false; }
  };

  // Switching layout rebuilds the grid. It cannot be a shell-only repaint: the
  // uniform grid is laid out by CSS and masonry is placed by us, and its cards
  // are absolutely positioned. Only re-styling the shell leaves whatever the
  // previous layout built still sitting there with its old geometry.
  function setLayoutMode(next, announce = false) {
    if (!LAYOUT_MODES.includes(next) || next === state.layoutMode) return;
    commitState({ layoutMode: next }, { persist: true });
    if (announce) notify(`${LAYOUT_LABELS[next]} layout`);
  }

  function cycleLayoutMode(direction = 1, announce = true) {
    const current = Math.max(0, LAYOUT_MODES.indexOf(state.layoutMode));
    setLayoutMode(LAYOUT_MODES[(current + direction + LAYOUT_MODES.length) % LAYOUT_MODES.length], announce);
  }

  function commitState(patch, options = {}) {
    const changes = typeof patch === 'function' ? patch(state) : patch;
    if (changes && typeof changes === 'object') Object.assign(state, changes);
    if (options.persist) persistSettings();
    if (options.shellOnly) {
      applyShellState();
      if (document.querySelector(`#${APP_ID} .scg-settings-panel.open`)) refreshSettingsPanel();
    } else if (options.render !== false) render();
    else {
      updateSelectionUi();
      updateDownloadUi();
    }
  }

  const cleanText = (body) => {
    const clone = body.cloneNode(true);
    clone.querySelectorAll('img, video, audio, iframe, svg, script, style, .fa, [class*="fa-"], .bbCodeBlock--quote, .message-signature, .js-unfurl-fauxBlockLink').forEach(el => el.remove());
    return (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
  };

  const postParts = (root) => {
    const article = root.matches?.('article.message, .message') ? root : root.closest?.('article.message, .message');
    const body = root.querySelector?.('.message-body .bbWrapper, .message-content .bbWrapper, .bbWrapper');
    const author = (root.querySelector?.('.message-name, [itemprop="name"], .username')?.textContent || 'Unknown').trim();
    const postAnchor = root.querySelector?.('.message-attribution-main a[href*="/post-"], a[href*="#post-"], a.message-attribution-main');
    const postUrl = absoluteUrl(postAnchor?.getAttribute('href') || location.href);
    const postId = article?.getAttribute('data-content') || article?.id || postUrl.split('#').pop() || '';
    const numberAnchor = root.querySelector?.('.message-attribution-opposite a, a[href*="#post-"]');
    const postNumber = (numberAnchor?.textContent || '').match(/#(\d+)/)?.[1] || '';
    return { article, body, author, postUrl, postId, postNumber, postedAt: postTimestamp(root) };
  };

  // XenForo puts the reply time in the attribution header, either as an ISO
  // datetime attribute or a unix seconds data-time. Absent or unreadable is
  // normal for an odd template, and sorts with the oldest rather than throwing.
  function postTimestamp(root) {
    const node = root.querySelector?.('time[datetime], time[data-time], .message-attribution-main time');
    if (!node) return 0;
    const unix = Number(node.getAttribute('data-time'));
    if (Number.isFinite(unix) && unix > 0) return Math.round(unix * 1000);
    const parsed = Date.parse(node.getAttribute('datetime') || '');
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function itemIsBlocked(item, patterns) {
    if (!item || !patterns || !patterns.length) return false;
    if (item.type === 'text') return false;
    return matchesBlockPattern([item.url, item.thumb, item.originalLink], patterns);
  }

  function extractFromDocument(doc, pageUrl, blockPatterns = blockPatternList(state.blockPatterns)) {
    const results = [];
    const posts = [...doc.querySelectorAll('article.message, .message--post')];
    const roots = posts.length ? posts : [...doc.querySelectorAll('.message')];

    roots.forEach((root, postIndex) => {
      const { body, author, postUrl, postId, postNumber, postedAt } = postParts(root);
      if (!body) return;
      const content = body.cloneNode(true);
      content.querySelectorAll('.bbCodeBlock--quote, blockquote.bbCodeBlock, [data-quote], .message-signature').forEach(node => node.remove());
      const base = pageUrl || doc.baseURI;
      const common = {
        author,
        postUrl: absoluteUrl(postUrl, base),
        postId,
        postNumber,
        postedAt,
        pageUrl: base,
        pageNumber: pageNumberFromUrl(base),
        postIndex,
      };
      // One counter across all four passes below. Each pass used to restart at
      // zero, so a <video> and a direct .mp4 link in the same reply both named
      // themselves -vid01 and collided in the download folder. Skipped elements
      // do not consume a number, so the sequence stays dense.
      let mediaIndex = 0;

      content.querySelectorAll('img').forEach(img => {
        const linked = img.closest('a[href]');
        const classes = `${img.className || ''} ${linked?.className || ''}`;
        if (IGNORE_IMG.test(classes)) return;
        const thumb = bestImageUrl(img, base);
        const originalLink = normalizeSourceUrl(linked?.getAttribute('href'), base);
        const lightboxHint = /(?:js-lbImage|lbContainer|attachment)/i.test(classes) ||
          /lightbox/i.test(linked?.getAttribute('data-xf-init') || '');
        const linkedDirect = Boolean(originalLink && !isImagePageHost(originalLink) &&
          (IMAGE_EXT.test(originalLink) || /\/attachments\//i.test(originalLink)));
        const preview = imagePreviewCandidate(thumb, originalLink);
        const seed = linkedDirect
          ? { status: 'confirmed', url: originalLink, method: 'direct-image-link', mediaType: 'image' }
          : { ...preview, mediaType: 'image' };
        const src = seed.url;
        if (!src || /(?:avatar|smilies|emoji|reactions)\//i.test(src)) return;
        const order = mediaIndex++;
        results.push({
          type: 'image', url: src, thumb, originalLink, lightboxHint,
          mediaKey: `${String(postId).replace(/[^a-z0-9_-]/gi, '')}-${postIndex}-${order}`,
          resolution: { candidate: seed },
          dimHint: parseDimensionHints({
            width: img.getAttribute('width'),
            height: img.getAttribute('height'),
            style: img.getAttribute('style'),
          }),
          caption: img.getAttribute('alt') || img.getAttribute('title') || '', mediaIndex: order, ...common,
        });
      });

      content.querySelectorAll('video').forEach(video => {
        const source = video.querySelector('source');
        const src = absoluteUrl(video.currentSrc || video.getAttribute('data-src') || video.getAttribute('src') ||
          source?.getAttribute('data-src') || source?.getAttribute('src'), base);
        if (!src) return;
        results.push({
          type: 'video', url: src, poster: absoluteUrl(video.getAttribute('data-poster') || video.getAttribute('poster'), base),
          resolution: { candidate: { status: 'confirmed', url: src, method: 'video-element', mediaType: 'video' } },
          mediaIndex: mediaIndex++, ...common,
        });
      });

      content.querySelectorAll('iframe[src], iframe[data-src]').forEach(frame => {
        const src = normalizeSourceUrl(frame.getAttribute('data-src') || frame.getAttribute('src'), base);
        if (!src) return;
        results.push({
          type: 'embed', url: src, title: frame.getAttribute('title') || 'Embedded video',
          wasFrame: true, mediaIndex: mediaIndex++, ...common,
        });
      });

      content.querySelectorAll('a[href]').forEach(anchor => {
        const href = normalizeSourceUrl(anchor.getAttribute('href'), base);
        if (!href || anchor.querySelector('img')) return;
        if (/\/threads\/|\/posts\/|#post-|\/members\//i.test(href)) return;
        const label = (anchor.textContent || href).replace(/\s+/g, ' ').trim();
        if (VIDEO_EXT.test(href) || isKnownVideoHost(href)) {
          const directVideo = VIDEO_EXT.test(href);
          results.push({
            type: directVideo ? 'video' : 'embed', url: href, title: label,
            resolution: directVideo ? { candidate: { status: 'confirmed', url: href, method: 'direct-video-link', mediaType: 'video' } } : {},
            mediaIndex: mediaIndex++, ...common,
          });
        } else {
          results.push({ type: 'link', url: href, title: label, mediaIndex: mediaIndex++, ...common });
        }
      });

      const text = cleanText(content);
      if (text) results.push({ type: 'text', text, ...common });
    });
    return blockPatterns.length ? results.filter(item => !itemIsBlocked(item, blockPatterns)) : results;
  }

  // Editing the pattern list has to act on what is already indexed, or the
  // setting reads as broken until the next full scan.
  function purgeBlockedItems() {
    const patterns = blockPatternList(state.blockPatterns);
    if (!patterns.length) return 0;
    const kept = state.items.filter(item => !itemIsBlocked(item, patterns));
    const removed = state.items.length - kept.length;
    if (!removed) return 0;
    const survivors = new Set(kept.map(item => item.selectionKey));
    state.selected.forEach(key => { if (!survivors.has(key)) state.selected.delete(key); });
    state.items = kept;
    invalidateVisibleItems({ dataset: true, selection: true });
    return removed;
  }

  const normalizedDedupeUrl = rawUrl => rawUrl
    ? rawUrl.replace(/([?&])width=\d+|([?&])height=\d+/g, '$1').replace(/[?&]$/, '')
    : '';

  function legacyItemDedupeKey(item) {
    const rawUrl = item.type === 'embed' ? embedUrl(item.url) : item.url;
    const normalizedUrl = normalizedDedupeUrl(rawUrl);
    return item.type === 'text'
      ? `text|${item.postId}|${item.text.slice(0, 300)}`
      : `${item.type === 'embed' ? 'videoish' : item.type}|${normalizedUrl}`;
  }

  function itemDedupeAliases(item, primaryKey) {
    const aliases = new Set([legacyItemDedupeKey(item)]);
    const identityUrl = item.originalLink || item.url;
    if (/^(?:bunkr|pixeldrain)\|/.test(primaryKey)) {
      aliases.add(`videoish|${normalizedDedupeUrl(embedUrl(identityUrl))}`);
    }
    aliases.delete(primaryKey);
    return [...aliases].filter(Boolean);
  }

  function itemDedupeKey(item) {
    const identityUrl = item.originalLink || item.url;
    const definition = hostDefinition(identityUrl);
    const mediaId = hostMediaId(identityUrl);
    if (mediaId && (definition?.id === 'bunkr' || definition?.id === 'pixeldrain')) return `${definition.id}|${mediaId}`;
    const rawUrl = item.type === 'embed' ? embedUrl(item.url) : item.url;
    const normalizedUrl = normalizedDedupeUrl(rawUrl);
    return item.type === 'text'
      ? `text|${item.postId}|${item.text.slice(0, 300)}`
      : `${item.type === 'embed' ? 'videoish' : item.type}|${normalizedUrl}`;
  }

  function appendUniqueItems(target, additions, seen = new Set(target.map(itemDedupeKey))) {
    additions.forEach(item => {
      const key = itemDedupeKey(item);
      if (seen.has(key)) return;
      seen.add(key);
      item.selectionKey = key;
      const aliases = itemDedupeAliases(item, key);
      if (persistedSelectionKeys.has(key) || aliases.some(alias => persistedSelectionKeys.has(alias))) state.selected.add(key);
      item.searchText = `${item.author || ''} ${item.title || ''} ${item.caption || ''} ${item.text || ''} ${item.url || ''} ${item.originalLink || ''} ${item.postNumber || ''} ${item.pageNumber || ''}`.toLowerCase();
      // Derived once, here, because each of these parses a URL and every one of
      // them used to be recomputed inside a per-frame or per-keystroke loop over
      // the whole indexed set. hostDefinition alone costs four URL
      // constructions, and hasDirectResolver reaches roughly twenty-eight.
      // None of the three can change afterwards: they read only the item's own
      // URLs, never its resolution state.
      item.sourceHost = item.type === 'text' ? '' : hostOf(item.originalLink || item.url || item.postUrl);
      const historyBase = threadBaseUrl(item.pageUrl || item.postUrl || location.href);
      item.historyKey = `${historyBase}|${key}`;
      item.historyAliases = aliases.map(alias => `${historyBase}|${alias}`);
      item.directResolver = hasDirectResolver(item);
      seedRatioFromCache(item);
      target.push(item);
    });
    return target;
  }

  function dedupe(items) {
    return appendUniqueItems([], items, new Set());
  }

  function stableTextHash(value) {
    let hash = 2166136261;
    for (const character of String(value || '')) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function itemIndexIgnoreSignature(rawPatterns = state.blockPatterns) {
    return stableTextHash(blockPatternList(rawPatterns).sort().join('\n'));
  }

  function itemIndexStorageKey(rawUrl = location.href) {
    const identity = threadIdentity(rawUrl);
    return `${ITEM_INDEX_KEY_PREFIX}${identity.id || stableTextHash(threadBaseUrl(rawUrl))}`;
  }

  const INDEX_ITEM_FIELDS = Object.freeze([
    'type', 'url', 'thumb', 'originalLink', 'poster', 'title', 'caption', 'text', 'wasFrame', 'lightboxHint',
    'mediaKey', 'dimHint', 'mediaDimensions', 'author', 'postUrl', 'postId', 'postNumber', 'postedAt', 'pageUrl', 'pageNumber',
    'postIndex', 'mediaIndex',
  ]);

  function indexableResolution(item) {
    const candidate = item?.resolution?.candidate;
    if (!candidate || candidate.expiresAt) return {};
    const kept = {};
    ['status', 'url', 'method', 'mediaType', 'reason', 'fallbackUrl', 'mediaTypeUnknown'].forEach(key => {
      if (candidate[key] !== undefined) kept[key] = candidate[key];
    });
    return Object.keys(kept).length ? { candidate: kept } : {};
  }

  function indexableItem(item) {
    const kept = {};
    INDEX_ITEM_FIELDS.forEach(key => {
      const value = item?.[key];
      if (value !== undefined && value !== '' && value !== false && value !== 0) kept[key] = value;
    });
    const resolution = indexableResolution(item);
    if (Object.keys(resolution).length) kept.resolution = resolution;
    return kept;
  }

  const jsonBytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;

  function boundedItemIndexEntry(items, metadata = {}) {
    const entry = {
      schema: ITEM_INDEX_SCHEMA,
      extractionVersion: ITEM_INDEX_EXTRACTION_VERSION,
      ignoreSignature: itemIndexIgnoreSignature(),
      savedAt: Date.now(),
      threadPageCount: Math.max(1, Number(metadata.threadPageCount || 1)),
      highestScannedPage: Math.max(0, Number(metadata.highestScannedPage || 0)),
      sourceLabel: String(metadata.sourceLabel || 'Cached index').slice(0, 120),
      truncated: false,
      items: [],
    };
    let used = jsonBytes(entry);
    const candidates = items.map((item, order) => ({ item, order }));
    const rank = item => isMediaItem(item) ? 0 : (item.type === 'link' ? 1 : 2);
    candidates.sort((a, b) => rank(a.item) - rank(b.item) || b.order - a.order);
    for (const candidate of candidates) {
      const saved = indexableItem(candidate.item);
      const cost = jsonBytes(saved) + 1;
      if (used + cost > ITEM_INDEX_MAX_BYTES) { entry.truncated = true; continue; }
      entry.items.push(saved);
      used += cost;
    }
    return entry;
  }

  function persistItemIndex() {
    try {
      const key = itemIndexStorageKey();
      const entry = boundedItemIndexEntry(state.items, {
        threadPageCount: state.threadPageCount,
        highestScannedPage: highestScannedPage(),
        sourceLabel: state.sourceLabel,
      });
      storage.set(key, entry);
      state.itemIndexTruncated = entry.truncated;
      const stored = storage.get(ITEM_INDEX_REGISTRY_KEY, []);
      const registry = (Array.isArray(stored) ? stored : [])
        .filter(row => row && row.key !== key)
        .concat({ key, savedAt: entry.savedAt })
        .sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0));
      registry.slice(ITEM_INDEX_THREAD_LIMIT).forEach(row => storage.remove(row.key));
      storage.set(ITEM_INDEX_REGISTRY_KEY, registry.slice(0, ITEM_INDEX_THREAD_LIMIT));
      return true;
    } catch { return false; }
  }

  function validItemIndexEntry(entry) {
    return Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)
      && entry.schema === ITEM_INDEX_SCHEMA
      && entry.extractionVersion === ITEM_INDEX_EXTRACTION_VERSION
      && entry.ignoreSignature === itemIndexIgnoreSignature()
      && Array.isArray(entry.items));
  }

  function restoreItemIndex() {
    const entry = storage.get(itemIndexStorageKey(), null);
    if (!validItemIndexEntry(entry)) {
      if (entry) storage.remove(itemIndexStorageKey());
      return false;
    }
    state.items = appendUniqueItems([], entry.items, new Set());
    state.itemIndexRestored = state.items.length > 0;
    state.itemIndexTruncated = entry.truncated === true;
    state.threadPageCount = Math.max(state.threadPageCount, Number(entry.threadPageCount || 1));
    state.scannedPages = Math.max(0, Number(entry.highestScannedPage || 0));
    const currentPages = detectThreadPageCount(document, location.href);
    state.threadPageCount = Math.max(state.threadPageCount, currentPages);
    state.sourceLabel = currentPages > Number(entry.threadPageCount || 1)
      ? `Cached index · ${currentPages - Number(entry.threadPageCount || 1)} new page${currentPages - Number(entry.threadPageCount || 1) === 1 ? '' : 's'} available`
      : 'Cached thread index';
    invalidateVisibleItems({ dataset: true, selection: true });
    return state.itemIndexRestored;
  }

  const HTML_ESCAPES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' });

  function escapeHtml(value = '') {
    return String(value).replace(/[&<>'"]/g, character => HTML_ESCAPES[character]);
  }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'link'; }
  }

  function requestText(url, options = {}) {
    const headers = options.headers || {};
    const timeout = options.timeout || 18000;
    const method = String(options.method || 'GET').toUpperCase();
    const body = options.data;
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        const sameOrigin = (() => { try { return new URL(url).origin === location.origin; } catch { return false; } })();
        fetch(url, {
          method,
          body: method === 'GET' || method === 'HEAD' ? undefined : body,
          credentials: sameOrigin ? 'include' : 'omit',
          headers,
          referrer: headers.Referer || headers.referer || undefined,
        })
          .then(response => response.ok ? response.text() : Promise.reject(new Error(`HTTP ${response.status}`)))
          .then(resolve, reject);
        return;
      }
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        data: method === 'GET' || method === 'HEAD' ? undefined : body,
        timeout,
        onload: response => response.status >= 200 && response.status < 400
          ? resolve(response.responseText)
          : reject(new Error(`HTTP ${response.status}`)),
        onerror: () => reject(new Error('Media host request failed')),
        ontimeout: () => reject(new Error('Media host request timed out')),
      });
    });
  }

  function embedUrl(rawUrl) {
    try {
      const normalized = normalizeSourceUrl(rawUrl);
      const url = new URL(normalized);
      const embedded = hostDefinition(normalized)?.embed?.(url) || url.href;
      return absoluteUrl(embedded);
    } catch { return ''; }
  }

  function iframeHtml(item) {
    const src = embedUrl(item.url);
    if (!src) return '<div class="scg-loading">This embedded media URL was blocked because it was not HTTP(S).</div>';
    return `<iframe loading="lazy" src="${escapeHtml(src)}" title="${escapeHtml(item.title || 'Embedded video')}" allow="autoplay; fullscreen; picture-in-picture" sandbox="allow-scripts allow-same-origin allow-forms allow-presentation allow-popups" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe>`;
  }

  function mediaFromHtml(html, base, kind) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const selectors = kind === 'image'
      ? ['#image[src]', '#img[src]', "meta[property='og:image']", "meta[name='twitter:image']", "link[rel='image_src']"]
      : ["meta[property='og:video:secure_url']", "meta[property='og:video:url']", "meta[property='og:video']", 'video[src]', 'video source[src]'];
    for (const selector of selectors) {
      const node = doc.querySelector(selector);
      const value = node?.getAttribute('content') || node?.getAttribute('href') || node?.getAttribute('src');
      if (value) return absoluteUrl(value.replace(/&amp;/g, '&'), base);
    }
    if (kind === 'video') {
      const scriptText = [...doc.scripts].map(script => script.textContent || '').join('\n');
      const matches = scriptText.match(/https?:\\?\/\\?\/[^"'<>\s]+/gi) || [];
      for (const match of matches) {
        const candidate = absoluteUrl(match.replace(/\\\//g, '/').replace(/\\u0026/gi, '&'), base);
        if (VIDEO_EXT.test(candidate)) return candidate;
      }
    }
    return '';
  }

  function directUrlFromResponse(rawText, base) {
    const candidates = [];
    const collect = (value, key = '') => {
      if (typeof value === 'string') {
        const cleaned = value.replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/gi, '&').trim();
        if (/^(?:https?:)?\/\//i.test(cleaned) || (/^\//.test(cleaned) && /(?:url|file|src|source|video|media|download)/i.test(key))) {
          candidates.push({ url: absoluteUrl(cleaned, base), key });
        }
        return;
      }
      if (Array.isArray(value)) return value.forEach(entry => collect(entry, key));
      if (value && typeof value === 'object') Object.entries(value).forEach(([childKey, child]) => collect(child, childKey));
    };
    try { collect(JSON.parse(rawText)); }
    catch { collect(rawText); }
    const rawMatches = String(rawText).match(/https?:\\?\/\\?\/[^"'<>\s]+/gi) || [];
    rawMatches.forEach(url => candidates.push({ url: absoluteUrl(url.replace(/\\\//g, '/').replace(/\\u0026/gi, '&'), base), key: '' }));
    const priority = /^(?:url|file|src|source|video|media|download|download_url|direct_url|signed_url)$/i;
    return candidates
      .filter(candidate => {
        try {
          const url = new URL(candidate.url);
          const isTurboPage = hostDefinition(candidate.url)?.id === 'turbo' && /^\/(?:embed|v|d)\//i.test(url.pathname);
          return !isTurboPage && !/\/api\/sign/i.test(url.pathname);
        } catch { return false; }
      })
      .sort((a, b) => Number(priority.test(b.key)) - Number(priority.test(a.key)) || Number(VIDEO_EXT.test(b.url)) - Number(VIDEO_EXT.test(a.url)))[0]?.url || '';
  }

  function resolutionResult(status, url = '', method = '', mediaType = '', extras = {}) {
    const normalizedUrl = url ? absoluteUrl(url) : '';
    if (status !== 'failed' && !normalizedUrl) return { status: 'failed', url: '', method: method || 'invalid-url', mediaType, reason: 'Resolver returned a non-HTTP(S) URL', ...extras };
    return { status, url: normalizedUrl, method, mediaType, ...extras };
  }

  const failedResolution = (reason, mediaType, extras = {}) => ({
    status: 'failed', url: '', method: extras.method || 'resolver', mediaType, reason: String(reason || 'No downloadable media found'), ...extras,
  });

  async function resolveTurboVideo(item) {
    const id = hostMediaId(item.url);
    if (!id) return failedResolution('Turbo video ID was not found', 'video', { method: 'turbo' });
    const embed = `https://turbo.cr/embed/${id}`;
    const api = `https://turbo.cr/api/sign?v=${encodeURIComponent(id)}`;
    const headers = { Accept: '*/*', Referer: embed };
    const fallbackUrl = `https://turbo.cr/d/${id}`;

    const trySignedUrl = async () => {
      const direct = directUrlFromResponse(await requestText(api, { headers }), api);
      return direct ? resolutionResult('confirmed', direct, 'turbo-signed-api', 'video', { headers, fallbackUrl }) : null;
    };

    try {
      const result = await trySignedUrl();
      if (result) return result;
    } catch (error) {
      console.debug('[SimpCity Gallery] Turbo signed URL request failed', error);
      recordDiagnostic('resolverFailures', 'Turbo signed URL', error, item);
    }

    try {
      const html = await requestText(embed, { headers: { Accept: 'text/html,*/*', Referer: item.postUrl || location.href } });
      const embeddedRaw = mediaFromHtml(html, embed, 'video');
      const embedded = embeddedRaw ? directUrlFromResponse(JSON.stringify({ url: embeddedRaw }), embed) : '';
      if (embedded) return resolutionResult('confirmed', embedded, 'turbo-embed-page', 'video', { headers, fallbackUrl });
      const result = await trySignedUrl();
      if (result) return result;
    } catch (error) {
      console.debug('[SimpCity Gallery] Turbo embed resolution failed', error);
      recordDiagnostic('resolverFailures', 'Turbo embed', error, item);
    }
    return failedResolution('Turbo did not expose a direct video file', 'video', { method: 'turbo', fallbackUrl });
  }

  /* ---- Bunkr ---------------------------------------------------------------
     Bunkr hands out short-lived signed CDN URLs rather than stable file paths,
     so nothing in the thread markup is downloadable on its own. Three hops get
     there: the file page carries a numeric id, one API call turns that into a
     CDN base plus path, and a second signs the path. The resolver chain
     follows Bunkr Album Downloader by pinkman (MIT); the grading, diagnostics
     and byte validation around it are this gallery's.
     ------------------------------------------------------------------------ */

  function signedUrlExpiry(value, now = Date.now()) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return 0;
    const milliseconds = numeric > 1e12 ? numeric : numeric * 1000;
    // Anything already past, or more than a week out, is not an expiry we can
    // act on; treating it as absent leaves the resolution cached as before.
    if (milliseconds <= now || milliseconds > now + 7 * 24 * 3600 * 1000) return 0;
    return Math.round(milliseconds);
  }

  const BUNKR_API_ORIGIN = 'https://dl.bunkr.cr';
  const BUNKR_SIGN_ORIGIN = 'https://glb-apisign.cdn.cr';

  // The page is a Next.js build whose props shape moves around, so this looks
  // for the record rather than a fixed path: a numeric id sitting next to a
  // filename is the file object wherever it happens to live this week.
  function findBunkrFileRecord(value, depth = 0) {
    if (depth > 12 || !value || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
      for (const child of value) {
        const found = findBunkrFileRecord(child, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const name = value.name || value.filename || value.original || '';
    if (name && /^\d{5,12}$/.test(String(value.id == null ? '' : value.id))) {
      return { id: String(value.id), name: String(name) };
    }
    for (const child of Object.values(value)) {
      const found = findBunkrFileRecord(child, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function bunkrFileRecordFromHtml(html) {
    const source = String(html || '');
    const nextData = source.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (nextData) {
      try {
        const found = findBunkrFileRecord(JSON.parse(nextData[1]));
        if (found) return found;
      } catch { /* Fall through to the flatter probes below. */ }
    }
    const direct = source.match(/dl\.bunkr+\.[a-z]{2,6}\/file\/(\d+)/i);
    if (direct) return { id: direct[1], name: '' };
    const ids = [...source.matchAll(/"id"\s*:\s*(\d{5,12})/g)];
    return ids.length ? { id: ids[ids.length - 1][1], name: '' } : null;
  }

  function bunkrFilePage(item) {
    return [item && item.originalLink, item && item.url]
      .map(candidate => normalizeSourceUrl(candidate))
      .find(candidate => candidate && hostDefinition(candidate)?.id === 'bunkr') || '';
  }

  async function resolveBunkrFile(item) {
    const filePage = bunkrFilePage(item);
    const mediaType = item.type === 'image' ? 'image' : 'video';
    const fail = (reason, extras = {}) => failedResolution(reason, mediaType, { method: 'bunkr', fallbackUrl: filePage || undefined, ...extras });
    if (!filePage) return fail('No Bunkr file link was found on this item');
    // Album links list files; they are not a file themselves.
    if (!hostMediaId(filePage)) return fail('This Bunkr link is an album page rather than a single file');
    const apiHeaders = { Accept: 'application/json', Origin: BUNKR_API_ORIGIN, Referer: `${BUNKR_API_ORIGIN}/` };

    let record = null;
    try {
      record = bunkrFileRecordFromHtml(await requestText(filePage, {
        headers: { Accept: 'text/html,*/*', Referer: item.postUrl || location.href },
      }));
    } catch (error) {
      console.debug('[SimpCity Gallery] Bunkr file page request failed', error);
      recordDiagnostic('resolverFailures', 'Bunkr file page', error, item);
      return fail(error.message || 'The Bunkr file page could not be read');
    }
    if (!record) return fail('The Bunkr file page did not expose a numeric file id');

    let metadata = null;
    try {
      metadata = JSON.parse(await requestText(`${BUNKR_API_ORIGIN}/api/_001_v2`, {
        method: 'POST',
        data: JSON.stringify({ id: record.id }),
        headers: { ...apiHeaders, 'Content-Type': 'application/json' },
      }));
    } catch (error) {
      console.debug('[SimpCity Gallery] Bunkr metadata request failed', error);
      recordDiagnostic('resolverFailures', 'Bunkr metadata', error, item);
      return fail(error.message || 'The Bunkr metadata request failed');
    }
    if (!metadata || !metadata.mediafiles || !metadata.path) return fail('The Bunkr metadata response was incomplete');

    let signature = null;
    try {
      signature = JSON.parse(await requestText(`${BUNKR_SIGN_ORIGIN}/sign?path=${encodeURIComponent(metadata.path)}`, { headers: apiHeaders }));
    } catch (error) {
      console.debug('[SimpCity Gallery] Bunkr signing request failed', error);
      recordDiagnostic('resolverFailures', 'Bunkr signing', error, item);
      return fail(error.message || 'The Bunkr signing request failed');
    }
    if (!signature || !signature.token || !signature.ex) return fail('Bunkr did not return a signing token');

    const name = String(metadata.original || record.name || hostMediaId(filePage));
    const url = `${String(metadata.mediafiles).replace(/\/+$/, '')}${metadata.path}` +
      `?n=${encodeURIComponent(name)}&token=${encodeURIComponent(signature.token)}&ex=${encodeURIComponent(signature.ex)}`;
    return resolutionResult('confirmed', url, 'bunkr-signed-cdn', mediaType, {
      headers: { Referer: `${BUNKR_API_ORIGIN}/` },
      fallbackUrl: filePage,
      expiresAt: signedUrlExpiry(signature.ex),
      // Bunkr will happily return a JPEG for a link the thread presented as a
      // video embed, so the signature check must not hold it to a guess.
      mediaTypeUnknown: true,
    });
  }

  function resolvePixeldrainFile(item) {
    const filePage = [item?.originalLink, item?.url]
      .map(candidate => normalizeSourceUrl(candidate))
      .find(isPixeldrainFileUrl) || '';
    const id = hostMediaId(filePage);
    if (!id) {
      return failedResolution('This Pixeldrain link is not a single /u/ file', item?.type === 'image' ? 'image' : 'video', {
        method: 'pixeldrain', fallbackUrl: filePage || undefined,
      });
    }
    return resolutionResult('confirmed', `https://pixeldrain.com/api/file/${encodeURIComponent(id)}`, 'pixeldrain-file-api',
      item?.type === 'image' ? 'image' : 'video', {
        fallbackUrl: filePage,
        // Pixeldrain IDs do not encode the content type; byte validation owns
        // the final image/video verdict, exactly as it does for Bunkr.
        mediaTypeUnknown: true,
      });
  }

  async function resolveCandidate(item) {
    if (!item) return failedResolution('Media item is missing', '');
    item.resolution ||= {};
    // A signed CDN URL stops working. Resolving a card for display and
    // downloading it an hour later would otherwise reuse a dead URL and read as
    // a broken host, so an expiring candidate is dropped shortly before it dies.
    const cached = item.resolution.candidate;
    if (cached && cached.expiresAt && Date.now() >= Number(cached.expiresAt) - 60000) {
      item.resolution.candidate = null;
      item.resolution.attempted = false;
      delete item.resolution.failedAt;
    }
    if (item.resolution.attempted && item.resolution.candidate) return item.resolution.candidate;
    if (item.resolution.promise) return item.resolution.promise;
    if (item.resolution.failedAt && Date.now() - item.resolution.failedAt < 60000) {
      return item.resolution.candidate || failedResolution('Resolver is cooling down after a failure', item.type === 'image' ? 'image' : 'video');
    }
    item.resolution.promise = resolveCandidateUncached(item);
    try {
      const result = await item.resolution.promise;
      item.resolution.candidate = result;
      item.resolution.attempted = true;
      if (result.status === 'failed') item.resolution.failedAt = Date.now();
      return result;
    } finally {
      delete item.resolution.promise;
    }
  }

  async function resolveCandidateUncached(item) {
    const mediaType = item.type === 'image' ? 'image' : 'video';
    const seed = item.resolution?.candidate;
    if (seed?.status === 'confirmed') return seed;
    if (mediaType === 'image') {
      const sourceDefinition = hostDefinition(item.originalLink);
      let sourceUrl;
      try { sourceUrl = new URL(normalizeSourceUrl(item.originalLink)); } catch { sourceUrl = null; }
      const imageId = sourceUrl ? sourceDefinition?.imageId?.(sourceUrl) : '';
      if (isBunkrFileUrl(item.originalLink)) return resolveBunkrFile(item);
      if (isPixeldrainFileUrl(item.originalLink) || isPixeldrainFileUrl(item.url)) return resolvePixeldrainFile(item);
      if (sourceDefinition?.id === 'goonbox' && imageId) {
        try {
          const payload = JSON.parse(await requestText(`https://goonbox.cr/api/images/${imageId}`));
          const original = payload?.image?.original_url;
          if (original) return resolutionResult('confirmed', absoluteUrl(original, 'https://goonbox.cr/'), 'goonbox-api', 'image');
        } catch (error) {
          console.debug('[SimpCity Gallery] Goonbox API resolution failed', error);
          recordDiagnostic('resolverFailures', 'Goonbox original image', error, item);
        }
      }
      if (item.originalLink && item.originalLink !== seed?.url && (sourceDefinition?.imagePage || item.lightboxHint)) {
        try {
          const found = mediaFromHtml(await requestText(item.originalLink), item.originalLink, 'image');
          if (found) return resolutionResult('confirmed', found, `${sourceDefinition?.id || 'generic'}-image-page`, 'image');
        } catch (error) {
          console.debug('[SimpCity Gallery] Image resolution failed', error);
          recordDiagnostic('resolverFailures', 'Image page resolution', error, item);
        }
      }
      if (seed?.url) return resolutionResult('heuristic', seed.url, seed.method || 'image-preview', 'image');
      const preview = imagePreviewCandidate(item.thumb, item.originalLink);
      return preview.url ? resolutionResult('heuristic', preview.url, preview.method, 'image') : failedResolution('No image candidate was found', 'image');
    }
    if (seed?.url && VIDEO_EXT.test(seed.url)) return resolutionResult('confirmed', seed.url, seed.method || 'direct-video', 'video');
    if (hostDefinition(item.url)?.id === 'turbo') return resolveTurboVideo(item);
    if (isBunkrFileUrl(item.url) || isBunkrFileUrl(item.originalLink)) return resolveBunkrFile(item);
    if (isPixeldrainFileUrl(item.url) || isPixeldrainFileUrl(item.originalLink)) return resolvePixeldrainFile(item);
    try {
      const found = mediaFromHtml(await requestText(item.url), item.url, 'video');
      if (found && VIDEO_EXT.test(found)) return resolutionResult('confirmed', found, `${hostDefinition(item.url)?.id || 'generic'}-video-page`, 'video');
    } catch (error) {
      console.debug('[SimpCity Gallery] Video resolution failed', error);
      recordDiagnostic('resolverFailures', 'Generic video resolution', error, item);
    }
    return failedResolution('The video host did not expose a direct media file', 'video', { fallbackUrl: normalizeSourceUrl(item.url) });
  }

  async function resolveForDisplay(item) {
    const result = await resolveCandidate(item);
    if (result.status !== 'failed') return result;
    if (item?.type === 'image' && item.thumb) return resolutionResult('heuristic', item.thumb, 'thumbnail-fallback', 'image', { reason: result.reason });
    return result;
  }

  function qualifyDownloadResolution(item, result) {
    if (!result || result.status === 'failed' || !result.url) return result || failedResolution('No media resolution was returned', item?.type === 'image' ? 'image' : 'video');
    if (result.status === 'heuristic' && /^(?:thumbnail|thumbnail-fallback)$/.test(result.method)) {
      return failedResolution('Only a forum thumbnail was available; it was not treated as the original file', result.mediaType, {
        method: result.method,
        fallbackUrl: item.originalLink && item.originalLink !== result.url ? item.originalLink : '',
      });
    }
    return { ...result, requiresByteValidation: true };
  }

  async function resolveForDownload(item) {
    const result = await resolveCandidate(item);
    return qualifyDownloadResolution(item, result);
  }

  function safeFilename(item, url, verifiedExtension = '') {
    let ext = verifiedExtension || url?.match(/\.(jpe?g|png|gif|webp|avif|bmp|mp4|webm|mov|m4v)(?:$|[?#./])/i)?.[1] || (item.type === 'image' ? 'jpg' : 'mp4');
    if (ext.toLowerCase() === 'jpeg') ext = 'jpg';
    const page = Math.max(1, Number(item.pageNumber || pageNumberFromUrl(item.pageUrl || item.postUrl)) || 1);
    const postDigits = String(item.postNumber || item.postId || '').match(/\d+/g)?.pop();
    const reply = postDigits || String(Number(item.postIndex || 0) + 1);
    const type = (verifiedExtension ? IMAGE_EXT_BARE.test(verifiedExtension) : item.type === 'image') ? 'img' : 'vid';
    const order = String(Number(item.mediaIndex || 0) + 1).padStart(2, '0');
    const base = `${threadFilePrefix(item.pageUrl || item.postUrl)}-p${page}-r${reply}-${type}${order}`;
    return `${base}.${ext.toLowerCase()}`;
  }

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (!value) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
    const amount = value / (1024 ** index);
    return `${amount >= 100 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
  }

  function blankDownloadProgress() {
    return { current: 0, total: 0, ok: 0, failed: 0, verification: 0, skipped: 0, duplicates: 0, zipPercent: 0, label: '' };
  }

  let downloadJobSequence = 0;
  function createDownloadJob(item, status = 'queued') {
    const job = {
      id: ++downloadJobSequence,
      item,
      filename: safeFilename(item, item.resolution?.candidate?.url || item.url || item.thumb),
      status,
      loaded: 0,
      total: 0,
      packProgress: 0,
      error: '',
    };
    state.downloadJobs.push(job);
    scheduleDownloadUi.dirtyJobs.add(job.id);
    return job;
  }

  function setDownloadJob(job, changes) {
    if (!job) return;
    Object.assign(job, changes);
    scheduleDownloadUi.dirtyJobs.add(job.id);
    scheduleDownloadUi();
  }

  function scheduleDownloadUi() {
    if (scheduleDownloadUi.timer) return;
    scheduleDownloadUi.timer = setTimeout(() => {
      scheduleDownloadUi.timer = 0;
      updateDownloadUi();
    }, 250);
  }
  scheduleDownloadUi.dirtyJobs = new Set();

  function updateDownloadedIndicators() {
    const app = document.getElementById(APP_ID);
    if (!app) return;
    app.querySelectorAll('.scg-card[data-key]').forEach(cardNode => {
      const item = itemForNode(cardNode, 'key');
      const saved = wasDownloaded(item);
      const legacy = hasLegacyDownload(item);
      cardNode.classList.toggle('downloaded', saved);
      cardNode.classList.toggle('download-legacy', legacy);
      const marker = cardNode.querySelector('.scg-saved-status');
      if (marker) {
        marker.classList.toggle('visible', saved || legacy);
        marker.classList.toggle('legacy', legacy);
        marker.textContent = saved ? 'VERIFIED' : (legacy ? 'LEGACY' : '');
        marker.title = saved ? 'Validated media recorded in download history' : (legacy ? 'Older unverified history entry; this item will not be skipped' : '');
      }
      const button = cardNode.querySelector('[data-download]');
      setIconButton(button, 'download', saved ? 'Download again' : (legacy ? 'Download verified copy' : 'Download'));
    });
    const lightbox = app.querySelector('.scg-lightbox.open');
    const lightboxButton = lightbox?.querySelector('[data-download-current]');
    const lightboxItem = currentViewerItem();
    if (lightboxButton && lightboxItem) setIconOnlyButton(lightboxButton, 'download', wasDownloaded(lightboxItem) ? 'Download again (D)' : (hasLegacyDownload(lightboxItem) ? 'Download verified copy (D)' : 'Download (D)'), 'scg-icon-well-primary');
  }

  function notify(message, duration = 3500) {
    const toast = document.getElementById('scg-tl-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => toast.classList.remove('show'), duration);
  }

  function sendCompletionNotification(title, body) {
    if (!state.completionNotifications || typeof Notification !== 'function' || Notification.permission !== 'granted') return false;
    try {
      new Notification(title, { body, tag: `${APP_ID}-completion` });
      return true;
    } catch { return false; }
  }

  async function setCompletionNotifications(enabled) {
    if (!enabled) {
      commitState({ completionNotifications: false }, { persist: true, shellOnly: true });
      return false;
    }
    if (typeof Notification !== 'function') {
      notify('Desktop notifications are not available in this browser.', 5200);
      return false;
    }
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    const granted = permission === 'granted';
    commitState({ completionNotifications: granted }, { persist: true, shellOnly: true });
    if (!granted) notify('Notification permission was not granted.', 5200);
    return granted;
  }

  function confirmAction({ title = 'Confirm action', message, confirmLabel = 'Continue', danger = false, preferenceLabel = '' } = {}) {
    const panel = document.querySelector(`#${APP_ID} .scg-confirm-panel`);
    if (!panel) return Promise.resolve(false);
    const previousFocus = document.activeElement;
    panel.querySelector('[data-confirm-title]').textContent = title;
    panel.querySelector('[data-confirm-message]').textContent = message || '';
    const accept = panel.querySelector('[data-confirm-accept]');
    setIconButton(accept, danger ? 'trash' : 'check', confirmLabel);
    accept.classList.toggle('danger', danger);
    const preference = panel.querySelector('[data-confirm-preference]');
    const preferenceInput = preference?.querySelector('input');
    if (preference) preference.hidden = !preferenceLabel;
    if (preferenceInput) {
      preferenceInput.checked = false;
      preference.querySelector('span').textContent = preferenceLabel;
    }
    panel.classList.add('open');
    accept.focus();
    return new Promise(resolve => {
      const finish = value => {
        panel.classList.remove('open');
        accept.onclick = null;
        panel.querySelector('[data-confirm-cancel]').onclick = null;
        panel.onclick = null;
        previousFocus?.focus?.();
        resolve(preferenceLabel ? { confirmed: value, preferenceChecked: Boolean(preferenceInput?.checked) } : value);
      };
      accept.onclick = () => finish(true);
      panel.querySelector('[data-confirm-cancel]').onclick = () => finish(false);
      panel.onclick = event => { if (event.target === panel) finish(false); };
    });
  }

  async function saveValidatedDownload(item, resolution, job) {
    const validation = await fetchValidatedMedia(item, resolution, (loaded, total) => setDownloadJob(job, {
      status: 'downloading', loaded, total,
    }));
    const filename = safeFilename(item, resolution.url, validation.extension);
    saveBlob(validation.blob, filename);
    setDownloadJob(job, { status: 'saved', loaded: validation.size, total: validation.size, filename });
    return { filename, validation };
  }

  async function downloadMedia(item, options = {}) {
    const quiet = Boolean(options.quiet);
    const allowFallback = options.allowFallback !== false;
    if (state.downloading && !options.queueOwned) {
      if (!quiet) notify('Wait for the ZIP queue to finish or cancel it first.');
      return { ok: false, busy: true };
    }
    if (wasDownloaded(item) && !options.force && !quiet) {
      const confirmed = await confirmAction({
        title: 'Download this file again?',
        message: 'The gallery already has a verified download record for this media.',
        confirmLabel: 'Download again',
      });
      if (!confirmed) return { ok: false, skipped: true };
    }
    if (!state.downloading) {
      const activeJobs = state.downloadJobs.filter(job => ['queued', 'preparing', 'downloading', 'packing'].includes(job.status));
      state.downloadJobs = activeJobs.length ? state.downloadJobs.slice(-20) : [];
      state.downloadProgress = blankDownloadProgress();
      state.downloadProgress.total = 1;
      if (!activeJobs.length) state.downloadDetailsOpen = false;
    }
    const job = options.job || createDownloadJob(item, 'preparing');
    state.downloadProgress.label = `Preparing ${job.filename}`;
    updateDownloadUi();
    if (!quiet) notify('Preparing original file...');
    let resolution = failedResolution('Download resolution did not run', item.type === 'image' ? 'image' : 'video');
    try { resolution = await resolveForDownload(item); }
    catch (error) {
      console.debug('[SimpCity Gallery] Download resolution failed', error);
      recordDiagnostic('resolverFailures', 'Download preparation', error, item);
      resolution = failedResolution(error.message || 'Download resolution failed', item.type === 'image' ? 'image' : 'video');
    }

    if (resolution.status === 'failed' || !resolution.url) {
      if (allowFallback && resolution.fallbackUrl) {
        window.open(resolution.fallbackUrl, '_blank', 'noopener');
        if (!quiet) notify('No direct file was exposed. The host page was opened for manual verification.', 5200);
      } else if (!quiet) {
        notify('No direct file was exposed by this video host.', 4500);
      }
      const verification = Boolean(resolution.fallbackUrl);
      setDownloadJob(job, { status: verification ? 'verification' : 'failed', error: resolution.reason || 'No direct file available' });
      state.downloadProgress[verification ? 'verification' : 'failed']++;
      state.downloadProgress.current = 1;
      state.downloadProgress.label = verification ? 'Media host verification required' : 'Download unavailable';
      updateDownloadUi();
      return { ok: false, verification };
    }

    try {
      setDownloadJob(job, { status: 'downloading', filename: safeFilename(item, resolution.url) });
      const saved = await saveValidatedDownload(item, resolution, job);
      rememberDownloaded(item, saved.filename, saved.validation);
      state.downloadProgress.ok = 1;
      state.downloadProgress.current = 1;
      state.downloadProgress.label = `Validated and saved ${saved.filename}`;
      updateDownloadUi();
      if (!quiet) notify('Media validated and sent to Downloads.');
      return { ok: true };
    } catch (error) {
      console.debug('[SimpCity Gallery] Browser download failed', error);
      recordDiagnostic('downloadFailures', 'Individual download', error, item);
      setDownloadJob(job, { status: error?.name === 'AbortError' ? 'canceled' : 'failed', error: error.message || 'Download failed' });
      state.downloadProgress.failed = error?.name === 'AbortError' ? 0 : 1;
      state.downloadProgress.current = 1;
      state.downloadProgress.label = error?.name === 'AbortError' ? 'Download canceled' : 'Download failed';
      updateDownloadUi();
      if (!quiet) {
        notify(`Download rejected: ${error.message || 'the response was not valid media'}`, 6000);
      }
      return { ok: false, verification: false };
    }
  }

  function selectedMediaItems() {
    return state.items.filter(item => isDownloadableMedia(item) && state.selected.has(item.selectionKey));
  }

  /* ---- Selection gestures --------------------------------------------------
     Selection is no longer a mode you enter. A click toggles one card, a
     shift-click extends from the anchor, a ctrl/cmd-click toggles without
     moving it. The arithmetic is pure so the harness can drive it.
     ------------------------------------------------------------------------ */

  function selectionRangeKeys(orderedKeys, anchorKey, targetKey) {
    const to = orderedKeys.indexOf(targetKey);
    if (to < 0) return [];
    const from = orderedKeys.indexOf(anchorKey);
    if (from < 0) return [targetKey];
    return orderedKeys.slice(Math.min(from, to), Math.max(from, to) + 1);
  }

  function resolveSelectionGesture(options) {
    const orderedKeys = options.orderedKeys || [];
    const targetKey = options.targetKey;
    const anchorKey = options.anchorKey;
    const selected = options.selected;
    // Duck-typed rather than `instanceof Set`: the harness hands this a Set from
    // another realm, where instanceof is false.
    const has = key => (selected && typeof selected.has === 'function' ? selected.has(key) : (selected || []).indexOf(key) >= 0);
    if (options.range) {
      // Extending always selects rather than toggling, so sweeping a range back
      // and forth cannot punch holes in what it already covered.
      return { add: selectionRangeKeys(orderedKeys, anchorKey, targetKey), remove: [], anchorKey: anchorKey || targetKey };
    }
    const turningOn = !has(targetKey);
    return {
      add: turningOn ? [targetKey] : [],
      remove: turningOn ? [] : [targetKey],
      // ctrl/cmd keeps the anchor where it was, so a shift-click afterwards
      // still extends from the start of the run.
      anchorKey: options.additive ? (anchorKey || targetKey) : targetKey,
    };
  }

  function selectableKeysInView() {
    return state.renderedItems.filter(isDownloadableMedia).map(item => item.selectionKey);
  }

  function applySelectionGesture(item, event) {
    if (!isDownloadableMedia(item)) return false;
    const result = resolveSelectionGesture({
      orderedKeys: selectableKeysInView(),
      anchorKey: state.selectionAnchor,
      targetKey: item.selectionKey,
      selected: state.selected,
      range: Boolean(event && event.shiftKey),
      additive: Boolean(event && (event.ctrlKey || event.metaKey)),
    });
    let changed = false;
    result.add.forEach(key => { if (!state.selected.has(key)) { state.selected.add(key); changed = true; } });
    result.remove.forEach(key => { if (state.selected.delete(key)) changed = true; });
    state.selectionAnchor = result.anchorKey;
    if (changed) {
      invalidateVisibleItems({ selection: true });
      persistThreadSelection();
    }
    return changed;
  }

  function clearSelection() {
    state.selectionAnchor = null;
    state.gridFocusKey = '';
    if (!state.selected.size) return false;
    state.selected.clear();
    // "Selected only" with nothing selected is an empty grid with no visible
    // cause, so the filter that depended on the selection goes with it.
    state.selectedOnly = false;
    invalidateVisibleItems({ selection: true });
    persistThreadSelection();
    return true;
  }

  function clearSelectionAndRefresh() {
    const wasFiltered = state.selectedOnly;
    const changed = clearSelection();
    if (wasFiltered) render();
    else if (changed) updateSelectionUi();
    return changed;
  }

  // The viewer's S key is a plain toggle, but it still moves the anchor so a
  // shift-click back in the grid extends from whatever was last touched.
  function toggleSelected(item) {
    applySelectionGesture(item, null);
    updateSelectionUi();
    return state.selected.has(item.selectionKey);
  }

  async function copyText(value, successMessage = 'Link copied.') {
    try {
      await navigator.clipboard.writeText(value);
      notify(successMessage);
    } catch {
      const input = document.createElement('textarea');
      input.value = value;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
      notify(successMessage);
    }
  }

  function normalizedPreferences(input = {}) {
    return {
      filter: ['all', 'image', 'video', 'link', 'text'].includes(input.filter) ? input.filter : DEFAULT_SETTINGS.filter,
      downloadState: DOWNLOAD_STATES.includes(input.downloadState) ? input.downloadState : DEFAULT_SETTINGS.downloadState,
      resolutionFilter: RESOLUTION_FILTERS.includes(input.resolutionFilter) ? input.resolutionFilter : DEFAULT_SETTINGS.resolutionFilter,
      compact: Boolean(input.compact),
      sort: SORT_MODES.includes(input.sort) ? input.sort : DEFAULT_SETTINGS.sort,
      groupBy: input.groupBy === 'reply' ? 'reply' : DEFAULT_SETTINGS.groupBy,
      perPage: VIEW_PAGE_SIZES.includes(Number(input.perPage)) ? Number(input.perPage) : DEFAULT_SETTINGS.perPage,
      theme: THEME_MODES.includes(input.theme)
        ? input.theme
        : (LEGACY_THEME_ACCENTS[input.theme] ? 'dark' : DEFAULT_SETTINGS.theme),
      accent: ACCENT_MODES.includes(input.accent)
        ? input.accent
        : (LEGACY_THEME_ACCENTS[input.theme] || DEFAULT_SETTINGS.accent),
      filtersCollapsed: Boolean(input.filtersCollapsed),
      layoutMode: LAYOUT_MODES.includes(input.layoutMode) ? input.layoutMode : DEFAULT_SETTINGS.layoutMode,
      cardScale: Number.isFinite(Number(input.cardScale)) ? Math.min(160, Math.max(70, Math.round(Number(input.cardScale) / 5) * 5)) : DEFAULT_SETTINGS.cardScale,
      downloadConcurrency: [1, 2, 3, 4].includes(Number(input.downloadConcurrency)) ? Number(input.downloadConcurrency) : DEFAULT_SETTINGS.downloadConcurrency,
      zipPartSizeMb: [100, 300, 600, 1000].includes(Number(input.zipPartSizeMb)) ? Number(input.zipPartSizeMb) : DEFAULT_SETTINGS.zipPartSizeMb,
      zipPartMaxFiles: [24, 50, 100].includes(Number(input.zipPartMaxFiles)) ? Number(input.zipPartMaxFiles) : DEFAULT_SETTINGS.zipPartMaxFiles,
      archiveLayout: ['flat', 'page', 'page-author', 'reply'].includes(input.archiveLayout) ? input.archiveLayout : DEFAULT_SETTINGS.archiveLayout,
      includeManifest: input.includeManifest !== false,
      dedupeContent: input.dedupeContent !== false,
      warnLargeThreadScan: input.warnLargeThreadScan !== false,
      embedPosters: Boolean(input.embedPosters),
      completionNotifications: Boolean(input.completionNotifications),
      safeMode: Boolean(input.safeMode),
      blockPatterns: typeof input.blockPatterns === 'string' ? input.blockPatterns.slice(0, 2000) : DEFAULT_SETTINGS.blockPatterns,
      shortcuts: normalizedShortcuts(input.shortcuts),
    };
  }

  function currentPreferences() {
    return normalizedPreferences({
      filter: state.filter,
      downloadState: state.downloadState,
      resolutionFilter: state.resolutionFilter,
      compact: state.compact,
      sort: state.sort,
      groupBy: state.groupBy,
      perPage: state.perPage,
      theme: state.theme,
      accent: state.accent,
      filtersCollapsed: state.filtersCollapsed,
      layoutMode: state.layoutMode,
      cardScale: state.cardScale,
      downloadConcurrency: state.downloadConcurrency,
      zipPartSizeMb: state.zipPartSizeMb,
      zipPartMaxFiles: state.zipPartMaxFiles,
      archiveLayout: state.archiveLayout,
      includeManifest: state.includeManifest,
      dedupeContent: state.dedupeContent,
      warnLargeThreadScan: state.warnLargeThreadScan,
      embedPosters: state.embedPosters,
      completionNotifications: state.completionNotifications,
      safeMode: state.safeMode,
      blockPatterns: state.blockPatterns,
      shortcuts: state.shortcuts,
    });
  }

  function applyPreferences(input, shouldPersist = true) {
    const preferences = normalizedPreferences(input);
    Object.assign(state, preferences, {
      query: '',
      authorFilter: 'all',
      hostFilter: 'all',
      selectedOnly: false,
      viewPage: 1,
    });
    invalidateVisibleItems({ history: true });
    const app = document.getElementById(APP_ID);
    const search = app?.querySelector('[data-search]');
    if (search) search.value = '';
    if (shouldPersist) persistSettings();
    render();
    refreshSettingsPanel();
  }

  function buildDebugReport() {
    const count = counts();
    const thread = threadIdentity();
    const history = downloadHistoryCounts();
    const jobStates = state.downloadJobs.reduce((summary, job) => {
      summary[job.status] = (summary[job.status] || 0) + 1;
      return summary;
    }, {});
    return {
      app: 'SimpCity Thread Gallery Timeline',
      version: APP_VERSION,
      generatedAt: new Date().toISOString(),
      storage: storage.mode,
      legacyStorageMigrated: state.diagnostics.migratedLegacyStorage,
      thread: { id: thread.id || 'unknown', page: pageNumberFromUrl(), knownPages: state.threadPageCount },
      scan: { source: state.sourceLabel, scannedPages: state.scannedPages, scanning: state.scanning },
      itemIndex: { restored: state.itemIndexRestored, truncated: state.itemIndexTruncated },
      items: count,
      view: { ...currentPreferences(), matchedPage: state.viewPage, viewPages: state.viewPages },
      downloads: { active: state.downloading, states: jobStates, history, archive: archiveDownloadOptions(), validation: 'supported media byte signatures' },
      failures: {
        resolver: state.diagnostics.resolverFailures,
        download: state.diagnostics.downloadFailures,
        scan: state.diagnostics.scanFailures,
      },
    };
  }

  function refreshSettingsPanel() {
    const panel = document.querySelector(`#${APP_ID} .scg-settings-panel`);
    if (!panel) return;
    const count = counts();
    const history = downloadHistoryCounts();
    const set = (selector, value) => {
      panel.querySelectorAll(selector).forEach(node => { node.textContent = String(value); });
    };
    set('[data-diag-version]', APP_VERSION);
    set('[data-diag-storage]', storage.mode);
    set('[data-diag-pages]', `${state.scannedPages} scanned / ${state.threadPageCount} known`);
    set('[data-diag-items]', `${count.all} total (${count.image} images, ${count.video} videos)`);
    set('[data-diag-resolvers]', state.diagnostics.resolverFailures.length);
    set('[data-diag-downloads]', state.diagnostics.downloadFailures.length);
    set('[data-diag-scans]', state.diagnostics.scanFailures.length);
    set('[data-diag-history]', `${history.verified} verified / ${history.legacy} legacy`);
    const migration = panel.querySelector('[data-diag-migration]');
    if (migration) migration.textContent = state.diagnostics.migratedLegacyStorage ? 'Previous settings migrated successfully' : 'No legacy migration was required';
    const themeSelect = panel.querySelector('[data-setting-theme]');
    const accentSelect = panel.querySelector('[data-setting-accent]');
    const densitySelect = panel.querySelector('[data-setting-density]');
    const filtersCollapsed = panel.querySelector('[data-setting-filters-collapsed]');
    const layoutSelect = panel.querySelector('[data-setting-layout]');
    const cardScale = panel.querySelector('[data-card-scale]');
    const archiveLayout = panel.querySelector('[data-setting-archive-layout]');
    const concurrency = panel.querySelector('[data-setting-download-concurrency]');
    const partSize = panel.querySelector('[data-setting-zip-part-size]');
    const partFiles = panel.querySelector('[data-setting-zip-part-files]');
    const manifest = panel.querySelector('[data-setting-include-manifest]');
    const dedupeContent = panel.querySelector('[data-setting-dedupe-content]');
    const warnLargeScan = panel.querySelector('[data-setting-warn-large-scan]');
    const embedPosters = panel.querySelector('[data-setting-embed-posters]');
    const completionNotifications = panel.querySelector('[data-setting-completion-notifications]');
    const safeMode = panel.querySelector('[data-setting-safe-mode]');
    if (themeSelect) themeSelect.value = state.theme;
    if (accentSelect) accentSelect.value = state.accent;
    if (densitySelect) densitySelect.value = state.compact ? 'compact' : 'comfortable';
    if (filtersCollapsed) filtersCollapsed.checked = state.filtersCollapsed;
    if (layoutSelect) layoutSelect.value = state.layoutMode;
    if (cardScale) cardScale.value = String(state.cardScale);
    if (archiveLayout) archiveLayout.value = state.archiveLayout;
    if (concurrency) concurrency.value = String(state.downloadConcurrency);
    if (partSize) partSize.value = String(state.zipPartSizeMb);
    if (partFiles) partFiles.value = String(state.zipPartMaxFiles);
    if (manifest) manifest.checked = state.includeManifest;
    if (dedupeContent) dedupeContent.checked = state.dedupeContent;
    if (warnLargeScan) warnLargeScan.checked = state.warnLargeThreadScan;
    if (embedPosters) embedPosters.checked = state.embedPosters;
    if (completionNotifications) completionNotifications.checked = state.completionNotifications;
    if (safeMode) safeMode.checked = state.safeMode;
    const blockPatterns = panel.querySelector('[data-setting-block-patterns]');
    // Never stomp a half-typed pattern list from an unrelated refresh.
    if (blockPatterns && document.activeElement !== blockPatterns) blockPatterns.value = state.blockPatterns;
    const blockSummary = panel.querySelector('[data-block-summary]');
    if (blockSummary) {
      const patterns = blockPatternList(state.blockPatterns);
      blockSummary.textContent = patterns.length
        ? `${patterns.length} ${patterns.length === 1 ? 'fragment' : 'fragments'} active. Fragments under two characters are ignored.`
        : 'No fragments. Everything found in a reply is indexed.';
    }
    panel.querySelectorAll('[data-shortcut]').forEach(button => {
      if (button.hasAttribute('data-recording')) return;
      button.textContent = state.shortcuts[button.dataset.shortcut] || 'Not set';
    });
  }

  // Cards are self-describing, so their own text is the index to search.
  function applySettingsSearch(rawQuery) {
    const panel = document.querySelector(`#${APP_ID} .scg-settings-panel`);
    if (!panel) return;
    const query = String(rawQuery || '').trim().toLowerCase();
    const wrap = panel.querySelector('.scg-settings-search');
    if (wrap) wrap.toggleAttribute('data-filled', Boolean(query));
    let matches = 0;
    panel.querySelectorAll('.scg-settings-card').forEach(card => {
      const hit = !query || String(card.textContent || '').toLowerCase().includes(query);
      card.hidden = !hit;
      if (hit) matches++;
    });
    const empty = panel.querySelector('[data-settings-empty]');
    if (empty) empty.hidden = Boolean(matches) || !query;
  }

  function shortcutHelpText() {
    const keys = state.shortcuts;
    const keyLabel = value => value || 'unbound';
    return `Gallery: ${keyLabel(keys.search)} search · ${keyLabel(keys.layout)} cycles layout · ${keyLabel(keys.selectAll)} selects this view · ` +
      'click a checkbox to select, shift-click to extend, ctrl-click to add · ' +
      `${keyLabel(keys.toggle)} opens or closes · Esc clears the selection, then closes. ` +
      'Viewer: ← → navigate · wheel or + − zoom · 0 fit · I details · F fullscreen · Space play or pause · D download · S select.';
  }

  function recordShortcut(button) {
    const actionId = button.dataset.shortcut;
    const action = SHORTCUT_ACTIONS.find(entry => entry.id === actionId);
    if (!action || button.hasAttribute('data-recording')) return;
    button.setAttribute('data-recording', '');
    button.textContent = 'Press keys';
    const stop = () => {
      button.removeAttribute('data-recording');
      document.removeEventListener('keydown', onKey, true);
      button.textContent = state.shortcuts[actionId] || 'Not set';
    };
    // Capture, so the recording swallows the chord before anything acts on it.
    const onKey = event => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') { stop(); return; }
      const combo = shortcutCombo(event);
      if (!combo) return;
      if (action.requiresModifier && !shortcutHasModifier(combo)) {
        notify('A gallery-wide shortcut needs Ctrl, Alt, Shift or Cmd so it cannot fire while you read the thread.', 5200);
        return;
      }
      if (shortcutConflict(state.shortcuts, actionId, combo)) {
        notify(`${combo} is already bound to another gallery shortcut.`, 4500);
        return;
      }
      state.shortcuts = { ...state.shortcuts, [actionId]: combo };
      persistSettings();
      stop();
      notify(`${action.label}: ${combo}`);
    };
    document.addEventListener('keydown', onKey, true);
    button.addEventListener('blur', stop, { once: true });
  }

  function openSettingsPanel() {
    const panel = document.querySelector(`#${APP_ID} .scg-settings-panel`);
    if (!panel) return;
    refreshSettingsPanel();
    const search = panel.querySelector('[data-settings-search]');
    if (search) search.value = '';
    applySettingsSearch('');
    panel.classList.add('open');
    panel.querySelector('.scg-settings-dialog')?.focus();
  }

  function closeSettingsPanel() {
    document.querySelector(`#${APP_ID} .scg-settings-panel`)?.classList.remove('open');
  }

  /* ---- Media URL export ----------------------------------------------------
     The gallery already knows which replies, hosts and authors survived the
     filters. Handing that list to gallery-dl or yt-dlp is often faster than
     downloading in the browser, and it is the only way to get at a host this
     script has no resolver for.
     ------------------------------------------------------------------------ */

  // A confirmed resolution is the actual file. Anything else exports the host
  // page instead, which is what an external downloader wants to be given.
  function mediaExportUrl(item) {
    const candidate = item && item.resolution && item.resolution.candidate;
    if (candidate && candidate.status === 'confirmed' && candidate.url) return candidate.url;
    return normalizeSourceUrl((item && (item.originalLink || item.url || item.thumb)) || '');
  }

  function mediaExportScope() {
    const selected = selectedMediaItems();
    if (selected.length) return { items: selected, label: 'selected' };
    return { items: visibleItems().filter(isMediaItem), label: 'matched' };
  }

  function buildMediaExportRows(items) {
    const seen = new Set();
    return items.map(item => ({
      url: mediaExportUrl(item),
      type: item.type === 'image' ? 'image' : 'video',
      host: itemSourceHost(item),
      author: item.author || '',
      postedAt: item.postedAt ? new Date(Number(item.postedAt)).toISOString() : '',
      page: Number(item.pageNumber || 0) || 0,
      reply: String(item.postNumber || ''),
      postUrl: item.postUrl || '',
      resolved: item.resolution?.candidate?.status === 'confirmed',
      downloaded: wasDownloaded(item),
    })).filter(row => {
      if (!row.url || seen.has(row.url)) return false;
      seen.add(row.url);
      return true;
    });
  }

  function exportMediaUrls(format = 'txt') {
    const scope = mediaExportScope();
    const rows = buildMediaExportRows(scope.items);
    if (!rows.length) return notify('There are no images or videos in the current view to export.', 4500);
    const stamp = timestampForFilename();
    const name = `${threadFilePrefix()}-${scope.label}-urls-${stamp}`;
    if (format === 'json') {
      const payload = {
        app: 'SimpCity Thread Gallery Timeline',
        version: APP_VERSION,
        exportedAt: new Date().toISOString(),
        thread: { ...threadIdentity(), url: threadBaseUrl(), title: threadTitle() },
        scope: scope.label,
        count: rows.length,
        media: rows,
      };
      saveBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `${name}.json`);
    } else {
      // `#` comments are ignored by both gallery-dl and yt-dlp batch files.
      const header = [
        `# ${threadTitle()}`,
        `# ${threadBaseUrl()}`,
        `# ${rows.length} ${scope.label} items exported ${new Date().toISOString()}`,
        '',
      ];
      saveBlob(new Blob([header.concat(rows.map(row => row.url)).join('\n') + '\n'], { type: 'text/plain;charset=utf-8' }), `${name}.txt`);
    }
    notify(`Exported ${rows.length} ${scope.label} media ${rows.length === 1 ? 'URL' : 'URLs'}.`);
  }

  // yt-dlp archives contain extractor/id pairs, not URLs. Only hosts whose
  // archive identity is stable are included; a guessed generic extractor name
  // would make a syntactically valid archive that silently fails to match.
  function ytDlpArchiveEntry(item) {
    for (const source of [item?.originalLink, item?.url].map(candidate => normalizeSourceUrl(candidate)).filter(Boolean)) {
      const definition = hostDefinition(source);
      const extractor = {
        youtube: 'youtube',
        vimeo: 'vimeo',
        streamable: 'streamable',
        redgifs: 'redgifs',
      }[definition?.id];
      const id = hostMediaId(source);
      if (extractor && id) return `${extractor} ${id}`;
    }
    return '';
  }

  function exportYtDlpArchive() {
    const scope = mediaExportScope();
    const entries = [...new Set(scope.items.map(ytDlpArchiveEntry).filter(Boolean))];
    if (!entries.length) return notify('No matching items have a stable yt-dlp archive identity.', 5000);
    const skipped = scope.items.length - entries.length;
    const name = `${threadFilePrefix()}-${scope.label}-yt-dlp-archive-${timestampForFilename()}.txt`;
    saveBlob(new Blob([`${entries.join('\n')}\n`], { type: 'text/plain;charset=utf-8' }), name);
    notify(`Exported ${entries.length} yt-dlp archive ${entries.length === 1 ? 'entry' : 'entries'}${skipped > 0 ? `; skipped ${skipped} unsupported ${skipped === 1 ? 'item' : 'items'}` : ''}.`);
  }

  function copyMediaUrls() {
    const scope = mediaExportScope();
    const rows = buildMediaExportRows(scope.items);
    if (!rows.length) return notify('There are no images or videos in the current view to copy.', 4500);
    return copyText(rows.map(row => row.url).join('\n'), `Copied ${rows.length} ${scope.label} media ${rows.length === 1 ? 'URL' : 'URLs'}.`);
  }

  function exportSettings(includeHistory = false) {
    const payload = {
      app: 'SimpCity Thread Gallery Timeline',
      schema: 2,
      historySchema: 2,
      version: APP_VERSION,
      exportedAt: new Date().toISOString(),
      settings: currentPreferences(),
    };
    if (includeHistory) payload.downloadHistory = state.downloadHistory;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    saveBlob(blob, `simpcity-gallery-settings-${timestampForFilename()}.json`);
    notify(includeHistory ? 'Settings and download history exported.' : 'Settings exported.');
  }

  async function importSettings(file) {
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      if (!payload || typeof payload !== 'object' || !payload.settings || typeof payload.settings !== 'object') throw new Error('This is not a valid gallery settings file');
      if (payload.downloadHistory && typeof payload.downloadHistory === 'object' && !Array.isArray(payload.downloadHistory)) {
        state.downloadHistory = normalizeDownloadHistory(payload.downloadHistory);
        invalidateVisibleItems({ history: true });
        persistDownloadHistory({ replace: true });
      }
      applyPreferences(payload.settings, true);
      updateDownloadedIndicators();
      notify('Settings imported successfully.');
    } catch (error) {
      notify(`Import failed: ${error.message}`, 6000);
    }
  }

  function resetPreferences(clearHistory = false) {
    if (clearHistory && !clearDownloadHistory()) {
      notify('Finish or cancel the active download before resetting history.', 5000);
      return false;
    }
    storage.remove(SETTINGS_KEY);
    applyPreferences(DEFAULT_SETTINGS, true);
    notify(clearHistory ? 'Preferences and download history reset.' : 'Preferences reset.');
    return true;
  }

  function clearDownloadHistory() {
    if (state.downloading) return false;
    state.downloadHistory = {};
    pendingHistoryWrites = {};
    invalidateVisibleItems({ history: true });
    storage.remove(DOWNLOAD_HISTORY_KEY);
    tabSync.post('download-history-changed');
    state.downloadJobs = [];
    state.downloadProgress = blankDownloadProgress();
    scheduleDownloadUi.dirtyJobs.clear();
    if (state.downloadState && state.downloadState !== 'all') render();
    else updateDownloadedIndicators();
    updateDownloadUi();
    refreshSettingsPanel();
    return true;
  }

  function clearDiagnostics() {
    state.diagnostics.resolverFailures = [];
    state.diagnostics.downloadFailures = [];
    state.diagnostics.scanFailures = [];
    state.diagnostics.events = [];
    refreshSettingsPanel();
    notify('Diagnostic history cleared.');
  }

  function selectItems(items, replace = false) {
    let changed = false;
    if (replace && state.selected.size) {
      state.selected.clear();
      changed = true;
    }
    items.filter(isDownloadableMedia).forEach(item => {
      if (!state.selected.has(item.selectionKey)) changed = true;
      state.selected.add(item.selectionKey);
      state.selectionAnchor = item.selectionKey;
    });
    if (changed) {
      invalidateVisibleItems({ selection: true });
      persistThreadSelection();
    }
    updateSelectionUi();
  }

  // The dock's selection region is driven by the count, not by a mode flag:
  // it exists exactly while something is selected.
  function updateSelectionUi() {
    const app = document.getElementById(APP_ID);
    if (!app) return;
    // Every key that enters state.selected passed isDownloadableMedia on the way
    // in, so the size is the count. Re-deriving it walked every indexed item,
    // which the windowed renderer was doing on every scroll frame. An item whose
    // resolution fails after selection stays counted until the next render; the
    // ZIP queue re-filters, so nothing downstream trusts this number.
    const count = state.selected.size;
    app.classList.toggle('has-selection', count > 0);
    const countNode = app.querySelector('.scg-selected-count');
    const downloadButton = app.querySelector('[data-action="download-selected"]');
    if (countNode) countNode.textContent = `${count} selected`;
    if (downloadButton) {
      setIconButton(downloadButton, state.downloading ? 'close' : 'archive', state.downloading ? 'Cancel ZIP queue' : `Download ZIP (${count})`);
      downloadButton.disabled = !count && !state.downloading;
      downloadButton.classList.toggle('cancel-download', state.downloading);
    }
    app.querySelectorAll('[data-action="clear-selection"]').forEach(button => { button.disabled = !count; });
    app.querySelectorAll('.scg-card[data-key]').forEach(cardNode => {
      const item = itemForNode(cardNode, 'key');
      const checked = Boolean(item && isDownloadableMedia(item) && state.selected.has(item.selectionKey));
      cardNode.classList.toggle('selected', checked);
      const input = cardNode.querySelector('[data-select]');
      if (input) input.checked = checked;
    });
    updateReplySelectionUi();
  }

  function updateReplySelectionUi() {
    const app = document.getElementById(APP_ID);
    if (!app) return;
    app.querySelectorAll('.scg-reply-group[data-reply-key]').forEach(group => {
      const replySelection = replySelectionState(group.dataset.replyKey);
      const input = group.querySelector('[data-reply-select]');
      if (input) {
        input.checked = replySelection.checked;
        input.indeterminate = replySelection.indeterminate;
        input.setAttribute('aria-checked', replySelection.indeterminate ? 'mixed' : String(replySelection.checked));
      }
      const count = group.querySelector('[data-reply-selection-count]');
      if (count) count.textContent = replySelectionSummary(replySelection);
    });
  }

  function downloadJobDetail(job, terminal) {
    const indeterminate = job.status === 'downloading' && !job.total;
    const jobPercent = job.total ? Math.min(100, Math.round((job.loaded / job.total) * 100)) : (terminal.has(job.status) ? 100 : (indeterminate ? 34 : 0));
    const detail = job.status === 'downloading'
      ? `${formatBytes(job.loaded)}${job.total ? ` / ${formatBytes(job.total)}` : ''}`
      : job.status === 'skipped' ? 'Already downloaded - skipped'
        : job.status === 'duplicate' ? (job.error || 'Duplicate content - merged')
          : job.status === 'verification' ? 'Host verification required'
            : job.status === 'failed' ? (job.error || 'Failed')
              : job.status === 'packing' ? `Preparing ZIP - ${Math.round(job.packProgress || 0)}%`
                : job.status === 'saved' ? 'Saved in ZIP or Downloads'
                  : job.status.charAt(0).toUpperCase() + job.status.slice(1);
    return { indeterminate, jobPercent, detail };
  }

  function updateDownloadJobRow(list, job, terminal) {
    let row = list.querySelector(`[data-job-id="${job.id}"]`);
    if (!row) {
      row = document.createElement('div');
      row.dataset.jobId = String(job.id);
      row.innerHTML = '<div><b></b><span></span></div><div class="scg-job-track"><i></i></div>';
      list.appendChild(row);
    }
    const { indeterminate, jobPercent, detail } = downloadJobDetail(job, terminal);
    row.className = `scg-download-job scg-job-${job.status}`;
    const filename = row.querySelector('b');
    filename.textContent = job.filename;
    filename.title = job.filename;
    row.querySelector('span').textContent = detail;
    const fill = row.querySelector('i');
    fill.classList.toggle('indeterminate', indeterminate);
    fill.style.width = `${jobPercent}%`;
  }

  function updateDownloadUi() {
    const app = document.getElementById(APP_ID);
    if (!app) return;
    const progress = app.querySelector('.scg-progress');
    if (!progress) return;
    const p = state.downloadProgress;
    const jobs = state.downloadJobs;
    const terminal = new Set(['saved', 'duplicate', 'failed', 'verification', 'skipped', 'canceled']);
    // One walk. This used to be four separate passes plus a filter, and a large
    // queue runs it every 250ms.
    let finished = 0;
    let progressSum = 0;
    let loaded = 0;
    let total = 0;
    let totalsKnown = true;
    for (const job of jobs) {
      loaded += Number(job.loaded || 0);
      total += Number(job.total || 0);
      if (terminal.has(job.status)) {
        finished += 1;
        progressSum += 1;
        continue;
      }
      if (job.status === 'packing') progressSum += .92 + (.07 * Number(job.packProgress || 0) / 100);
      else progressSum += job.total ? Math.min(.92, job.loaded / job.total) : 0;
      if (!(job.total > 0 || job.status === 'queued' || job.status === 'preparing')) totalsKnown = false;
    }
    const average = jobs.length ? progressSum / jobs.length : 0;
    const percent = p.zipPercent > 0 ? Math.round(p.zipPercent) : Math.round(average * 100);
    app.classList.toggle('has-downloads', jobs.length > 0);
    app.classList.toggle('downloading', state.downloading);
    progress.classList.add('visible');
    progress.classList.toggle('expanded', state.downloadDetailsOpen);
    progress.querySelector('[data-action="download-details"]')?.setAttribute('aria-expanded', String(state.downloadDetailsOpen));
    progress.querySelector('.scg-progress-fill').style.width = `${percent}%`;
    progress.querySelector('.scg-progress-text').textContent = p.label || (jobs.length ? `${finished} / ${jobs.length}` : 'Downloads idle');
    const retry = progress.querySelector('[data-action="retry-failed"]');
    if (retry) {
      const retryable = state.downloadJobs.filter(job => job.status === 'failed' || job.status === 'verification').length;
      retry.toggleAttribute('hidden', retryable === 0 || state.downloading);
      const label = `Retry failed (${retryable})`;
      retry.querySelector('span').textContent = label;
      retry.setAttribute('aria-label', label);
    }
    const overall = progress.querySelector('.scg-download-overall');
    if (overall) overall.textContent = jobs.length ? `${finished} of ${jobs.length} complete${loaded ? ` - ${formatBytes(loaded)}${total && totalsKnown ? ` / ${formatBytes(total)}` : ''}` : ''}` : 'No downloads yet.';
    const list = progress.querySelector('.scg-download-jobs');
    if (list) {
      const recentJobs = jobs.slice(-40);
      const recentIds = new Set(recentJobs.map(job => String(job.id)));
      list.querySelectorAll('[data-job-id]').forEach(row => {
        if (!recentIds.has(row.dataset.jobId)) row.remove();
      });
      list.querySelector('.scg-download-empty')?.remove();
      recentJobs.forEach(job => {
        if (scheduleDownloadUi.dirtyJobs.has(job.id) || !list.querySelector(`[data-job-id="${job.id}"]`)) {
          updateDownloadJobRow(list, job, terminal);
        }
      });
      if (!recentJobs.length && !list.querySelector('.scg-download-empty')) {
        const empty = document.createElement('div');
        empty.className = 'scg-download-empty';
        empty.textContent = 'No downloads yet.';
        list.appendChild(empty);
      }
      scheduleDownloadUi.dirtyJobs.clear();
    }
    app.querySelectorAll('[data-action="page"], [data-action="load-source-page"], [data-source-page]').forEach(control => {
      control.disabled = state.downloading || state.scanning;
    });
    const threadScanButton = app.querySelector('[data-action="thread"]');
    if (threadScanButton) threadScanButton.disabled = state.downloading;
    updateSelectionUi();
  }

  function fetchMediaBlob(url, headers, onProgress) {
    onProgress ||= () => {};
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        const sameOrigin = (() => { try { return new URL(url).origin === location.origin; } catch { return false; } })();
        fetch(url, { credentials: sameOrigin ? 'include' : 'omit', headers }).then(async response => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const total = Number(response.headers.get('content-length') || 0);
          if (!response.body?.getReader) {
            const blob = await response.blob();
            onProgress(blob.size, total || blob.size);
            return blob;
          }
          const reader = response.body.getReader();
          const chunks = [];
          let loaded = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.byteLength;
            onProgress(loaded, total);
          }
          return new Blob(chunks, { type: response.headers.get('content-type') || '' });
        }).then(resolve, reject);
        return;
      }

      let control;
      const cleanup = () => { if (control) state.activeDownloadRequests.delete(control); };
      control = GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: headers || undefined,
        responseType: 'blob',
        timeout: 600000,
        onprogress: event => onProgress(Number(event?.loaded || 0), Number(event?.total || 0)),
        onload: response => {
          cleanup();
          if (response.status < 200 || response.status >= 400) return reject(new Error(`HTTP ${response.status}`));
          const contentType = response.responseHeaders?.match(/^content-type:\s*([^;\r\n]+)/im)?.[1] || '';
          const blob = response.response instanceof Blob ? response.response : new Blob([response.response], { type: contentType });
          if (!blob.size) return reject(new Error('The media host returned an empty file'));
          onProgress(blob.size, blob.size);
          resolve(blob);
        },
        onerror: () => { cleanup(); reject(new Error('Media download failed')); },
        ontimeout: () => { cleanup(); reject(new Error('Media download timed out')); },
        onabort: () => { cleanup(); reject(new DOMException('Download canceled', 'AbortError')); },
      });
      if (control?.abort) state.activeDownloadRequests.add(control);
    });
  }

  function bytesMatch(bytes, signature, offset = 0) {
    return signature.every((value, index) => bytes[offset + index] === value);
  }

  function asciiBytes(bytes, offset, length) {
    return String.fromCharCode(...bytes.slice(offset, offset + length));
  }

  function sniffMediaSignature(bytes) {
    if (bytesMatch(bytes, [0xff, 0xd8, 0xff])) return { mediaType: 'image', extension: 'jpg', mime: 'image/jpeg', format: 'jpeg' };
    if (bytesMatch(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mediaType: 'image', extension: 'png', mime: 'image/png', format: 'png' };
    if (asciiBytes(bytes, 0, 6) === 'GIF87a' || asciiBytes(bytes, 0, 6) === 'GIF89a') return { mediaType: 'image', extension: 'gif', mime: 'image/gif', format: 'gif' };
    if (asciiBytes(bytes, 0, 4) === 'RIFF' && asciiBytes(bytes, 8, 4) === 'WEBP') return { mediaType: 'image', extension: 'webp', mime: 'image/webp', format: 'webp' };
    if (asciiBytes(bytes, 0, 2) === 'BM') return { mediaType: 'image', extension: 'bmp', mime: 'image/bmp', format: 'bmp' };
    if (bytesMatch(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return { mediaType: 'video', extension: 'webm', mime: 'video/webm', format: 'webm' };
    if (asciiBytes(bytes, 4, 4) === 'ftyp') {
      const brand = asciiBytes(bytes, 8, 4).toLowerCase();
      const compatible = asciiBytes(bytes, 8, Math.min(32, Math.max(0, bytes.length - 8))).toLowerCase();
      if (/(?:avif|avis)/.test(brand) || /(?:avif|avis)/.test(compatible)) return { mediaType: 'image', extension: 'avif', mime: 'image/avif', format: 'avif' };
      if (/^qt\s*$/.test(brand)) return { mediaType: 'video', extension: 'mov', mime: 'video/quicktime', format: 'quicktime' };
      return { mediaType: 'video', extension: 'mp4', mime: 'video/mp4', format: 'mp4' };
    }
    return null;
  }

  async function validateMediaBlob(blob, expectedMediaType) {
    if (!(blob instanceof Blob) || !blob.size) throw new Error('The media host returned an empty file');
    const bytes = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
    const prefix = new TextDecoder('utf-8', { fatal: false }).decode(bytes).trimStart().toLowerCase();
    const declaredMime = String(blob.type || '').split(';')[0].trim().toLowerCase();
    if (/^(?:<!doctype\s+html|<html|<head|<body|<\?xml|\{|\[)/.test(prefix) || /^(?:text\/|application\/(?:json|xml|xhtml\+xml))/.test(declaredMime)) {
      throw new Error('The host returned an HTML, text, or JSON response instead of media');
    }
    const signature = sniffMediaSignature(bytes);
    if (!signature) throw new Error('The downloaded bytes do not match a supported image or video format');
    // An empty expectation means the resolver could not know: the bytes still
    // have to be real media, they just are not held to the thread's guess.
    if (expectedMediaType && signature.mediaType !== expectedMediaType) throw new Error(`Expected ${expectedMediaType}, but the response contains ${signature.mediaType}`);
    return {
      verified: true,
      blob,
      size: blob.size,
      mime: signature.mime,
      extension: signature.extension,
      format: signature.format,
      method: `byte-signature:${signature.format}`,
    };
  }

  async function fetchValidatedMedia(item, resolution, onProgress) {
    if (!resolution?.url) throw new Error('No media URL is available for validation');
    const expectedMediaType = resolution.mediaTypeUnknown ? '' : (item.type === 'image' ? 'image' : 'video');
    const blob = await fetchMediaBlob(resolution.url, resolution.headers, onProgress);
    const validation = await validateMediaBlob(blob, expectedMediaType);
    return {
      ...validation,
      method: `${resolution.method || resolution.status}+${validation.method}`,
      resolutionStatus: resolution.status,
      resolutionMethod: resolution.method,
    };
  }

  async function fetchZipEntry(item, job) {
    try {
      setDownloadJob(job, { status: 'preparing' });
      const resolution = await resolveForDownload(item);
      if (resolution.status === 'failed' || !resolution.url) {
        const verification = Boolean(resolution.fallbackUrl);
        setDownloadJob(job, { status: verification ? 'verification' : 'failed', error: resolution.reason || 'No direct file available' });
        return { item, job, verification, failed: !verification };
      }
      job.filename = safeFilename(item, resolution.url);
      setDownloadJob(job, { status: 'downloading', filename: job.filename });
      const validation = await fetchValidatedMedia(item, resolution, (loaded, total) => {
        setDownloadJob(job, { status: 'downloading', loaded, total });
      });
      job.filename = safeFilename(item, resolution.url, validation.extension);
      setDownloadJob(job, { status: 'packing', loaded: validation.size, total: validation.size, filename: job.filename });
      return { item, job, blob: validation.blob, validation, resolution };
    } catch (error) {
      const canceled = error?.name === 'AbortError' || state.cancelDownload;
      setDownloadJob(job, { status: canceled ? 'canceled' : 'failed', error: error.message || 'Download failed' });
      if (!canceled) recordDiagnostic('downloadFailures', 'ZIP media fetch', error, item);
      return { item, job, canceled, failed: !canceled };
    }
  }

  function archiveDownloadOptions() {
    return {
      concurrency: Math.min(4, Math.max(1, Number(state.downloadConcurrency) || DEFAULT_SETTINGS.downloadConcurrency)),
      partSizeBytes: Math.min(1000, Math.max(100, Number(state.zipPartSizeMb) || DEFAULT_SETTINGS.zipPartSizeMb)) * 1024 * 1024,
      partMaxFiles: [24, 50, 100].includes(Number(state.zipPartMaxFiles)) ? Number(state.zipPartMaxFiles) : DEFAULT_SETTINGS.zipPartMaxFiles,
      archiveLayout: ['flat', 'page', 'page-author', 'reply'].includes(state.archiveLayout) ? state.archiveLayout : DEFAULT_SETTINGS.archiveLayout,
      includeManifest: state.includeManifest !== false,
      dedupeContent: state.dedupeContent !== false,
    };
  }

  function sanitizeArchiveSegment(value, fallback = 'unknown') {
    return slugify(value, 52) || fallback;
  }

  function archivePathForEntry(entry, layout = 'page-author') {
    const item = entry?.item || {};
    const filename = String(entry?.job?.filename || 'media.bin').split('/').pop();
    if (layout === 'flat') return filename;
    const page = `page-${String(Math.max(1, Number(item.pageNumber || 1))).padStart(3, '0')}`;
    if (layout === 'page') return `${page}/${filename}`;
    if (layout === 'reply') {
      const replyDigits = String(item.postNumber || item.postId || '').match(/\d+/g)?.pop() || String(Number(item.postIndex || 0) + 1);
      return `${page}/reply-${String(replyDigits).padStart(3, '0')}/${filename}`;
    }
    return `${page}/${sanitizeArchiveSegment(item.author, 'unknown-author')}/${filename}`;
  }

  function csvCell(value) {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function buildManifestCsv(entries, archiveName) {
    const columns = ['archive_path', 'stored', 'duplicate_of', 'duplicate_archive', 'media_type', 'page', 'reply', 'author', 'posted_at', 'host', 'source_url', 'post_url', 'bytes', 'mime', 'resolution_method', 'crc32', 'archive'];
    const rows = entries.map(entry => {
      const item = entry.item || {};
      const sourceUrl = normalizeSourceUrl(item.originalLink || item.url || '');
      const values = [
        entry.archivePath || entry.duplicateOf || '',
        entry.archivePath ? 'yes' : 'no',
        entry.duplicateOf || '',
        entry.duplicateContainer || '',
        item.type === 'embed' ? 'video' : item.type,
        Number(item.pageNumber || 1),
        String(item.postNumber || item.postId || Number(item.postIndex || 0) + 1),
        item.author || 'Unknown',
        item.postedAt ? new Date(Number(item.postedAt)).toISOString() : '',
        hostOf(sourceUrl),
        sourceUrl,
        normalizeSourceUrl(item.postUrl || ''),
        Number(entry.validation?.size || entry.blob?.size || 0),
        entry.validation?.mime || '',
        entry.validation?.method || entry.resolution?.method || '',
        Number(entry.crc >>> 0).toString(16).padStart(8, '0'),
        archiveName,
      ];
      return values.map(csvCell).join(',');
    });
    return `\uFEFF${[columns.join(','), ...rows].join('\r\n')}\r\n`;
  }

  function timestampForFilename() {
    const date = new Date();
    const two = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}`;
  }

  const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index++) {
      let value = index;
      for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      table[index] = value >>> 0;
    }
    return table;
  })();

  function zipCanceledError() {
    return new DOMException('ZIP creation canceled', 'AbortError');
  }

  function updateCrc32(crc, bytes) {
    let value = crc >>> 0;
    for (let index = 0; index < bytes.length; index++) value = CRC32_TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
    return value >>> 0;
  }

  function crc32Bytes(bytes) {
    return (updateCrc32(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
  }

  async function crc32Blob(blob, job, completedBytes, archiveBytes) {
    let crc = 0xffffffff;
    const chunkSize = 4 * 1024 * 1024;
    for (let offset = 0; offset < blob.size; offset += chunkSize) {
      if (state.cancelDownload) throw zipCanceledError();
      const bytes = new Uint8Array(await blob.slice(offset, Math.min(blob.size, offset + chunkSize)).arrayBuffer());
      crc = updateCrc32(crc, bytes);
      const processed = Math.min(blob.size, offset + bytes.length);
      const packProgress = blob.size ? (processed / blob.size) * 100 : 100;
      setDownloadJob(job, { status: 'packing', packProgress });
      state.downloadProgress.zipPercent = archiveBytes ? ((completedBytes + processed) / archiveBytes) * 100 : packProgress;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (state.cancelDownload) throw zipCanceledError();
    return (crc ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    return {
      time: ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((Math.floor(date.getSeconds() / 2)) & 31),
      date: (((year - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31),
    };
  }

  function localZipHeader(filenameBytes, crc, size, modified) {
    const bytes = new Uint8Array(30);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, modified.time, true);
    view.setUint16(12, modified.date, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, size, true);
    view.setUint32(22, size, true);
    view.setUint16(26, filenameBytes.length, true);
    view.setUint16(28, 0, true);
    return bytes;
  }

  function centralZipHeader(filenameBytes, crc, size, offset, modified) {
    const bytes = new Uint8Array(46);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0x0800, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, modified.time, true);
    view.setUint16(14, modified.date, true);
    view.setUint32(16, crc, true);
    view.setUint32(20, size, true);
    view.setUint32(24, size, true);
    view.setUint16(28, filenameBytes.length, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, offset, true);
    return bytes;
  }

  function endOfCentralDirectory(entryCount, centralSize, centralOffset) {
    const bytes = new Uint8Array(22);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(4, 0, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, entryCount, true);
    view.setUint16(10, entryCount, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, centralOffset, true);
    view.setUint16(20, 0, true);
    return bytes;
  }

  async function buildStoredZip(entries, partNumber, archiveName, options = archiveDownloadOptions(), session = { fingerprints: new Map() }) {
    const encoder = new TextEncoder();
    const archiveBytes = entries.reduce((sum, entry) => sum + entry.blob.size, 0);
    if (entries.some(entry => entry.blob.size > 0xffffffff) || archiveBytes > 0xffffffff) {
      throw new Error('A ZIP part would exceed the 4 GB browser limit');
    }
    const localParts = [];
    const centralParts = [];
    const includedEntries = [];
    const duplicateEntries = [];
    const persistedFingerprints = session.fingerprints instanceof Map ? session.fingerprints : new Map();
    const pendingFingerprints = new Map();
    let localOffset = 0;
    let completedBytes = 0;
    let centralSize = 0;
    let storedEntryCount = 0;
    const usedNames = new Set();

    const uniqueArchiveName = rawName => {
      const normalized = String(rawName || 'media.bin').replace(/\\/g, '/').split('/').filter(segment => segment && segment !== '.' && segment !== '..').join('/') || 'media.bin';
      const slash = normalized.lastIndexOf('/');
      const directory = slash >= 0 ? normalized.slice(0, slash + 1) : '';
      const basename = slash >= 0 ? normalized.slice(slash + 1) : normalized;
      const match = basename.match(/^(.*?)(\.[^.]+)?$/);
      const stem = match?.[1] || 'media';
      const extension = match?.[2] || '';
      let candidate = `${directory}${stem}${extension}`;
      let suffix = 2;
      while (usedNames.has(candidate.toLowerCase())) candidate = `${directory}${stem}-${suffix++}${extension}`;
      usedNames.add(candidate.toLowerCase());
      return candidate;
    };

    const appendStoredFile = (archivePath, blob, crc) => {
      const filenameBytes = encoder.encode(archivePath);
      const size = blob.size;
      if (size > 0xffffffff || localOffset > 0xffffffff) throw new Error('A ZIP part exceeded the 4 GB browser limit');
      const modified = dosDateTime();
      const localHeader = localZipHeader(filenameBytes, crc, size, modified);
      const centralHeader = centralZipHeader(filenameBytes, crc, size, localOffset, modified);
      localParts.push(localHeader, filenameBytes, blob);
      centralParts.push(centralHeader, filenameBytes);
      localOffset += localHeader.byteLength + filenameBytes.byteLength + size;
      centralSize += centralHeader.byteLength + filenameBytes.byteLength;
      storedEntryCount++;
    };

    for (const entry of entries) {
      if (state.cancelDownload) throw zipCanceledError();
      const size = entry.blob.size;
      const crc = await crc32Blob(entry.blob, entry.job, completedBytes, archiveBytes);
      const fingerprint = `${size}:${crc.toString(16).padStart(8, '0')}`;
      const existing = options.dedupeContent ? (pendingFingerprints.get(fingerprint) || persistedFingerprints.get(fingerprint)) : null;
      entry.crc = crc;
      entry.fingerprint = fingerprint;
      completedBytes += size;
      if (existing) {
        entry.duplicateOf = existing.archivePath;
        entry.duplicateContainer = existing.archiveName;
        duplicateEntries.push(entry);
        setDownloadJob(entry.job, { status: 'packing', packProgress: 100 });
        continue;
      }
      entry.archivePath = uniqueArchiveName(archivePathForEntry(entry, options.archiveLayout));
      entry.job.filename = entry.archivePath;
      appendStoredFile(entry.archivePath, entry.blob, crc);
      includedEntries.push(entry);
      if (options.dedupeContent) pendingFingerprints.set(fingerprint, { archivePath: entry.archivePath, archiveName });
      setDownloadJob(entry.job, { status: 'packing', packProgress: 100 });
      state.downloadProgress.label = `Preparing ZIP part ${partNumber} - ${Math.round((completedBytes / Math.max(1, archiveBytes)) * 100)}%`;
      scheduleDownloadUi();
    }

    if (state.cancelDownload) throw zipCanceledError();
    let manifestAdded = false;
    if (options.includeManifest) {
      const manifestBytes = encoder.encode(buildManifestCsv([...includedEntries, ...duplicateEntries], archiveName));
      const manifestBlob = new Blob([manifestBytes], { type: 'text/csv;charset=utf-8' });
      appendStoredFile(uniqueArchiveName('manifest.csv'), manifestBlob, crc32Bytes(manifestBytes));
      manifestAdded = true;
    }
    if (!storedEntryCount) return { blob: null, includedEntries, duplicateEntries, manifestAdded: false };
    if (localOffset > 0xffffffff || centralSize > 0xffffffff) throw new Error('A ZIP part exceeded the 4 GB browser limit');
    const blob = new Blob([...localParts, ...centralParts, endOfCentralDirectory(storedEntryCount, centralSize, localOffset)], { type: 'application/zip' });
    pendingFingerprints.forEach((value, key) => persistedFingerprints.set(key, value));
    session.fingerprints = persistedFingerprints;
    return { blob, includedEntries, duplicateEntries, manifestAdded };
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function saveZipPart(entries, partNumber, stamp, options, session) {
    if (!entries.length) return { ok: true, archiveSaved: false };
    const archiveName = `${threadFilePrefix()}-selected-${stamp}-part${String(partNumber).padStart(2, '0')}.zip`;
    state.downloadProgress.label = `Preparing ${archiveName}`;
    state.downloadProgress.zipPercent = 0;
    updateDownloadUi();
    try {
      const result = await buildStoredZip(entries, partNumber, archiveName, options, session);
      if (state.cancelDownload) throw zipCanceledError();
      if (result.blob) saveBlob(result.blob, archiveName);
      result.includedEntries.forEach(entry => {
        setDownloadJob(entry.job, { status: 'saved' });
        rememberDownloaded(entry.item, entry.archivePath, entry.validation, true, archiveName);
        state.downloadProgress.ok++;
      });
      result.duplicateEntries.forEach(entry => {
        setDownloadJob(entry.job, { status: 'duplicate', packProgress: 100, error: `Same bytes as ${entry.duplicateOf}` });
        rememberDownloaded(entry.item, entry.duplicateOf, entry.validation, true, entry.duplicateContainer || archiveName);
        state.downloadProgress.duplicates++;
      });
      persistDownloadHistory();
      updateDownloadedIndicators();
      state.downloadProgress.zipPercent = 0;
      return { ok: true, archiveSaved: Boolean(result.blob), included: result.includedEntries.length, duplicates: result.duplicateEntries.length };
    } catch (error) {
      const canceled = error?.name === 'AbortError' || state.cancelDownload;
      entries.forEach(entry => setDownloadJob(entry.job, { status: canceled ? 'canceled' : 'failed', error: canceled ? 'Canceled before ZIP was saved' : 'ZIP creation failed' }));
      if (!canceled) state.downloadProgress.failed += entries.length;
      state.downloadProgress.zipPercent = 0;
      if (!canceled) console.error('[SimpCity Gallery] ZIP creation failed', error);
      if (!canceled) recordDiagnostic('downloadFailures', 'ZIP creation', error);
      return { ok: false, archiveSaved: false, included: 0, duplicates: 0 };
    }
  }

  // The jobs that ended without a file. Verification means the host wanted a
  // visit rather than that the link is dead, so both are worth another go.
  function retryableDownloadItems() {
    const seen = new Set();
    return state.downloadJobs
      .filter(job => job.status === 'failed' || job.status === 'verification')
      .map(job => job.item)
      .filter(item => {
        if (!item || !item.selectionKey || seen.has(item.selectionKey)) return false;
        seen.add(item.selectionKey);
        return true;
      });
  }

  // A resolver that just failed is inside a sixty-second cooldown and would
  // hand back the same failure without touching the network, which would make
  // Retry look broken. Retrying is an explicit instruction to try again now.
  function clearResolutionFailure(item) {
    if (!item || !item.resolution) return;
    if (item.resolution.candidate?.status === 'failed') item.resolution.candidate = null;
    item.resolution.attempted = false;
    delete item.resolution.failedAt;
  }

  async function bulkDownload(requestedItems = selectedMediaItems()) {
    if (state.downloading) {
      state.cancelDownload = true;
      state.downloadProgress.label = 'Canceling active downloads...';
      [...state.activeDownloadRequests].forEach(request => {
        try { request.abort(); } catch { /* The request may have just completed. */ }
      });
      updateDownloadUi();
      return;
    }
    const selected = Array.isArray(requestedItems)
      ? requestedItems.filter(isDownloadableMedia)
      : selectedMediaItems();
    if (!selected.length) return notify('Select images or videos first.');

    state.downloadJobs = [];
    state.downloadProgress = blankDownloadProgress();
    state.downloadProgress.total = selected.length;
    const queue = [];
    selected.forEach(item => {
      const alreadySaved = wasDownloaded(item);
      const job = createDownloadJob(item, alreadySaved ? 'skipped' : 'queued');
      if (alreadySaved) state.downloadProgress.skipped++;
      else queue.push({ item, job });
    });
    state.downloadDetailsOpen = true;
    if (!queue.length) {
      state.downloadProgress.current = selected.length;
      state.downloadProgress.label = `All ${selected.length} selected files were already downloaded`;
      updateDownloadUi();
      return notify('Everything selected is already in the gallery download history.', 5200);
    }

    state.downloading = true;
    state.cancelDownload = false;
    const options = archiveDownloadOptions();
    const archiveSession = { fingerprints: new Map() };
    state.downloadProgress.label = `Starting ${queue.length} files with ${options.concurrency} simultaneous downloads`;
    updateDownloadUi();

    let partEntries = [];
    let partBytes = 0;
    let partNumber = 1;
    const stamp = timestampForFilename();
    const flushPart = async () => {
      if (!partEntries.length) return;
      const entries = partEntries;
      partEntries = [];
      partBytes = 0;
      const result = await saveZipPart(entries, partNumber, stamp, options, archiveSession);
      if (result.archiveSaved) partNumber++;
      entries.forEach(entry => { entry.blob = null; });
    };

    const processResult = async result => {
      if (result.verification) state.downloadProgress.verification++;
      else if (result.failed) state.downloadProgress.failed++;
      if (result.blob) {
        if (state.cancelDownload) {
          setDownloadJob(result.job, { status: 'canceled', error: 'Canceled before ZIP was saved' });
          result.blob = null;
        } else {
          if (partEntries.length && (partEntries.length >= options.partMaxFiles || partBytes + result.blob.size > options.partSizeBytes)) await flushPart();
          if (state.cancelDownload) {
            setDownloadJob(result.job, { status: 'canceled', error: 'Canceled before ZIP was saved' });
            result.blob = null;
          } else {
            partEntries.push(result);
            partBytes += result.blob.size;
            if (partEntries.length >= options.partMaxFiles || partBytes >= options.partSizeBytes) await flushPart();
          }
        }
      }
      state.downloadProgress.current = state.downloadJobs.filter(job => ['saved', 'duplicate', 'failed', 'verification', 'skipped', 'canceled'].includes(job.status)).length;
      updateDownloadUi();
    };

    let cursor = 0;
    let processing = Promise.resolve();
    const enqueueResult = result => {
      const next = processing.then(() => processResult(result));
      processing = next.catch(() => {});
      return next;
    };
    const worker = async () => {
      while (!state.cancelDownload) {
        const index = cursor++;
        if (index >= queue.length) return;
        const entry = queue[index];
        const result = await fetchZipEntry(entry.item, entry.job);
        await enqueueResult(result);
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.concurrency, queue.length) }, () => worker()));
    await processing;
    if (!state.cancelDownload) await flushPart();
    else {
      partEntries.forEach(entry => {
        setDownloadJob(entry.job, { status: 'canceled', error: 'Canceled before ZIP was saved' });
        entry.blob = null;
      });
      partEntries = [];
      partBytes = 0;
    }

    const p = state.downloadProgress;
    const stopped = state.cancelDownload;
    if (stopped) {
      state.downloadJobs.forEach(job => {
        if (['queued', 'preparing', 'downloading', 'packing'].includes(job.status)) setDownloadJob(job, { status: 'canceled' });
      });
    }
    state.downloading = false;
    state.cancelDownload = false;
    state.activeDownloadRequests.clear();
    p.current = state.downloadJobs.filter(job => ['saved', 'duplicate', 'failed', 'verification', 'skipped', 'canceled'].includes(job.status)).length;
    p.label = stopped
      ? `Canceled - unfinished ZIP discarded${p.ok ? `, ${p.ok} files were already saved in earlier parts` : ''}`
      : `Finished - ${p.ok} zipped${p.duplicates ? `, ${p.duplicates} duplicates merged` : ''}${p.skipped ? `, ${p.skipped} already downloaded` : ''}${p.verification ? `, ${p.verification} need verification` : ''}${p.failed ? `, ${p.failed} failed` : ''}`;
    if (state.downloadState !== 'all') render();
    else updateDownloadUi();
    notify(p.label, 6000);
    sendCompletionNotification('Gallery download finished', p.label);
  }

  let countsCache = null;

  function counts() {
    // Only the dataset moves these, so they are memoized like the facet lists
    // rather than re-walked on every render.
    if (countsCache && countsCache.revision === datasetRevision) return countsCache.value;
    const c = { all: state.items.length, image: 0, video: 0, link: 0, text: 0 };
    state.items.forEach(i => {
      if (i.type === 'image') c.image++;
      else if (i.type === 'video' || i.type === 'embed') c.video++;
      else if (i.type === 'link') c.link++;
      else if (i.type === 'text') c.text++;
    });
    countsCache = { revision: datasetRevision, value: c };
    return c;
  }

  // Indexed items carry this; anything else (a test fixture, an item mid-build)
  // falls back to computing it.
  function itemSourceHost(item) {
    if (item.sourceHost !== undefined) return item.sourceHost;
    if (item.type === 'text') return '';
    return hostOf(item.originalLink || item.url || item.postUrl);
  }

  function compareThreadOrder(a, b) {
    return (Number(a.pageNumber || 1) - Number(b.pageNumber || 1)) ||
      (Number(a.postIndex || 0) - Number(b.postIndex || 0)) ||
      (Number(a.mediaIndex || 0) - Number(b.mediaIndex || 0)) ||
      (Number(TYPE_ORDER[a.type] ?? 9) - Number(TYPE_ORDER[b.type] ?? 9));
  }

  function resolutionPixels(item) {
    const width = Math.max(0, Number(item?.mediaDimensions?.width || 0));
    const height = Math.max(0, Number(item?.mediaDimensions?.height || 0));
    return width && height ? width * height : 0;
  }

  function resolutionBand(item) {
    const width = Math.max(0, Number(item?.mediaDimensions?.width || 0));
    const height = Math.max(0, Number(item?.mediaDimensions?.height || 0));
    if (!width || !height) return 'unknown';
    const shortEdge = Math.min(width, height);
    if (shortEdge >= 2160) return 'uhd';
    if (shortEdge >= 1080) return 'fhd';
    if (shortEdge >= 720) return 'hd';
    return 'sd';
  }

  function visibleItems() {
    const cache = visibleItemsCache;
    if (cache
      && cache.dataset === datasetRevision
      && cache.selection === selectionRevision
      && cache.history === historyRevision
      && cache.downloadState === state.downloadState
      && cache.resolutionFilter === state.resolutionFilter
      && cache.filter === state.filter
      && cache.query === state.query
      && cache.sort === state.sort
      && cache.groupBy === state.groupBy
      && cache.authorFilter === state.authorFilter
      && cache.hostFilter === state.hostFilter
      && cache.selectedOnly === state.selectedOnly) return cache.items;
    const q = normalizedQuery();
    const filtered = state.items.filter(item => matchesActiveFilters(item, q));

    const thread = (a, b) => compareThreadOrder(a, b);
    const alpha = compareText;
    if (state.sort === 'thread-desc') filtered.sort((a, b) => thread(b, a));
    else if (state.sort === 'author') filtered.sort((a, b) => alpha(a.author, b.author) || thread(a, b));
    else if (state.sort === 'host') filtered.sort((a, b) => alpha(itemSourceHost(a), itemSourceHost(b)) || thread(a, b));
    else if (state.sort === 'type') filtered.sort((a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) || thread(a, b));
    // A reply with no readable timestamp sorts with the oldest rather than
    // vanishing to one end, and thread order breaks every tie.
    else if (state.sort === 'date-asc') filtered.sort((a, b) => (Number(a.postedAt || 0) - Number(b.postedAt || 0)) || thread(a, b));
    else if (state.sort === 'date-desc') filtered.sort((a, b) => (Number(b.postedAt || 0) - Number(a.postedAt || 0)) || thread(a, b));
    else if (state.sort === 'resolution-asc') filtered.sort((a, b) => resolutionPixels(a) - resolutionPixels(b) || thread(a, b));
    else if (state.sort === 'resolution-desc') filtered.sort((a, b) => resolutionPixels(b) - resolutionPixels(a) || thread(a, b));
    else filtered.sort(thread);
    visibleItemsCache = {
      dataset: datasetRevision,
      selection: selectionRevision,
      history: historyRevision,
      downloadState: state.downloadState,
      resolutionFilter: state.resolutionFilter,
      filter: state.filter,
      query: state.query,
      sort: state.sort,
      groupBy: state.groupBy,
      authorFilter: state.authorFilter,
      hostFilter: state.hostFilter,
      selectedOnly: state.selectedOnly,
      items: filtered,
    };
    return filtered;
  }

  function replyKey(item) {
    return `${item.pageNumber || 1}|${item.postId || item.postUrl || item.postIndex || 0}`;
  }

  function setReplyCollapsed(key, collapsed) {
    const normalizedKey = String(key || '');
    if (!normalizedKey) return false;
    const changed = collapsed ? !state.collapsedReplies.has(normalizedKey) : state.collapsedReplies.has(normalizedKey);
    if (collapsed) state.collapsedReplies.add(normalizedKey);
    else state.collapsedReplies.delete(normalizedKey);
    return changed;
  }

  function setReplyGroupsCollapsed(items, collapsed) {
    const keys = new Set(items.map(replyKey));
    let changed = false;
    keys.forEach(key => { if (setReplyCollapsed(key, collapsed)) changed = true; });
    return changed;
  }

  function normalizedQuery() {
    return String(state.query || '').trim().toLowerCase();
  }

  // `skip` excludes one facet from the test. Counting a facet's own values
  // against itself would report 0 for everything you did not pick, which is
  // useless; skipping it answers "how many if I picked this instead".
  // The individual verdicts. A caller that needs the same item judged with one
  // facet excluded can then reuse the rest rather than running the whole
  // predicate a second time, which is what the facet counts used to do.
  function filterParts(item, q = normalizedQuery()) {
    return {
      type: !state.filter || state.filter === 'all' || item.type === state.filter ||
        (state.filter === 'video' && item.type === 'embed'),
      author: !state.authorFilter || state.authorFilter === 'all' || item.author === state.authorFilter,
      host: !state.hostFilter || state.hostFilter === 'all' || itemSourceHost(item) === state.hostFilter,
      selected: !state.selectedOnly || (isDownloadableMedia(item) && state.selected.has(item.selectionKey)),
      // A legacy marker is not a verified download, so it counts as outstanding:
      // the whole point of the filter is to find what still needs doing.
      download: state.downloadState === 'all'
        || (isMediaItem(item) && (state.downloadState === 'downloaded' ? wasDownloaded(item) : !wasDownloaded(item))),
      resolution: !state.resolutionFilter || state.resolutionFilter === 'all'
        || (isMediaItem(item) && resolutionBand(item) === state.resolutionFilter),
      query: !q || item.searchText.includes(q),
    };
  }

  function matchesActiveFilters(item, q = normalizedQuery(), skip = '') {
    const parts = filterParts(item, q);
    const authorMatch = skip === 'author' || parts.author;
    const hostMatch = skip === 'host' || parts.host;
    const downloadMatch = skip === 'download' || parts.download;
    const resolutionMatch = skip === 'resolution' || parts.resolution;
    return parts.type && authorMatch && hostMatch && parts.selected && downloadMatch && resolutionMatch && parts.query;
  }

  function replyDownloadableItems(key) {
    const index = state.replyIndex;
    if (index) return index.get(key) || [];
    const q = normalizedQuery();
    return state.items.filter(item => replyKey(item) === key && isDownloadableMedia(item) && matchesActiveFilters(item, q));
  }

  function replySelectionSummary(replySelection) {
    return replySelection.selected ? `${replySelection.selected} of ${replySelection.total} selected` : '';
  }

  function replySelectionState(key) {
    const eligible = replyDownloadableItems(key);
    const selected = eligible.reduce((total, item) => total + (state.selected.has(item.selectionKey) ? 1 : 0), 0);
    return {
      eligible,
      total: eligible.length,
      selected,
      checked: eligible.length > 0 && selected === eligible.length,
      indeterminate: selected > 0 && selected < eligible.length,
    };
  }

  function setReplySelected(key, selected) {
    const { eligible } = replySelectionState(key);
    let changed = false;
    eligible.forEach(item => {
      const hasItem = state.selected.has(item.selectionKey);
      if (selected && !hasItem) {
        state.selected.add(item.selectionKey);
        changed = true;
      } else if (!selected && hasItem) {
        state.selected.delete(item.selectionKey);
        changed = true;
      }
    });
    if (changed) {
      invalidateVisibleItems({ selection: true });
      persistThreadSelection();
    }
    return changed;
  }

  function buildViewPages(items, perPage = state.perPage) {
    if (!items.length) return [[]];
    const limit = Number(perPage) > 0 ? Number(perPage) : items.length;
    if (state.groupBy !== 'reply') {
      const pages = [];
      for (let index = 0; index < items.length; index += limit) pages.push(items.slice(index, index + limit));
      return pages;
    }

    const grouped = new Map();
    items.forEach(item => {
      const key = replyKey(item);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(item);
    });
    const units = [];
    grouped.forEach(groupItems => {
      for (let index = 0; index < groupItems.length; index += limit) units.push(groupItems.slice(index, index + limit));
    });
    const pages = [];
    let current = [];
    units.forEach(unit => {
      if (current.length && current.length + unit.length > limit) {
        pages.push(current);
        current = [];
      }
      current.push(...unit);
    });
    if (current.length) pages.push(current);
    return pages.length ? pages : [[]];
  }

  function mediaItems() {
    return state.renderedItems.filter(isMediaItem);
  }

  function viewerMediaItems() {
    return state.viewerItems.length ? state.viewerItems : mediaItems();
  }

  function currentViewerItem() {
    return viewerMediaItems()[state.lightboxIndex] || null;
  }

  function observeFullImages(items) {
    state.imageObserver?.disconnect();
    const app = document.getElementById(APP_ID);
    if (!app || typeof IntersectionObserver !== 'function') return;
    state.imageObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        state.imageObserver.unobserve(entry.target);
        const key = entry.target.dataset.resolveKey || entry.target.dataset.posterKey;
        const item = itemsByKey().get(key);
        // Same caps for the non-virtualized layouts: the observer decides what
        // is near, the scheduler decides how much runs at once.
        if (entry.target.dataset.posterKey) scheduleEmbedPoster(item, entry.target);
        else scheduleMediaReveal(item, entry.target);
      });
    }, { root: app.querySelector('.scg-scroll'), rootMargin: '700px 0px', threshold: 0.01 });
    app.querySelectorAll('img[data-resolve-key],img[data-poster-key]').forEach(img => state.imageObserver.observe(img));
  }

  function releaseRenderedMedia() {
    cancelAllMediaReveals();
    teardownFlow();
    state.imageObserver?.disconnect();
    const grid = document.querySelector(`#${APP_ID} .scg-grid`);
    if (!grid) return;
    grid.querySelectorAll('video').forEach(video => {
      try { video.pause(); } catch { /* Ignore detached media errors. */ }
      video.removeAttribute('src');
      video.querySelectorAll('source').forEach(source => source.removeAttribute('src'));
      try { video.load(); } catch { /* Ignore detached media errors. */ }
    });
    grid.querySelectorAll('iframe').forEach(frame => frame.setAttribute('src', 'about:blank'));
    grid.querySelectorAll('img').forEach(img => img.removeAttribute('src'));
    grid.replaceChildren();
  }

  /* ---- Playback handoff ----------------------------------------------------
     A card and the viewer can hold the same video. Opening one while the other
     played left both running, and the viewer always started from zero. Position
     is keyed by selectionKey rather than held on an element, so the handoff
     survives the windowed renderer unmounting the card while the viewer is open.
     ------------------------------------------------------------------------ */

  function rememberPlaybackPosition(key, video) {
    if (!key || !video) return;
    const at = Number(video.currentTime || 0);
    if (at > 0) state.playbackPositions.set(key, at);
  }

  function resumePlaybackPosition(video, item) {
    const start = Number(state.playbackPositions.get(item && item.selectionKey) || 0);
    if (!video || !(start > 0)) return;
    const seek = () => {
      // A live stream reports no usable duration, and resuming within half a
      // second of the end would just show a finished video.
      if (!Number.isFinite(video.duration) || start >= video.duration - 0.5) return;
      try { video.currentTime = start; } catch { /* Seeking is best effort. */ }
    };
    // A card is preload="none", so this waits for the play the reader has to
    // press anyway; the viewer autoplays and is usually ready already.
    if (video.readyState >= 1) seek();
    else video.addEventListener('loadedmetadata', seek, { once: true });
  }

  // Opening the viewer must not leave a second copy of the same media playing
  // behind it. A third-party embed exposes neither its position nor a pause
  // control, so it goes back to its placeholder rather than being left running.
  function suspendGridPlayback() {
    const grid = document.querySelector(`#${APP_ID} .scg-grid`);
    if (!grid) return;
    grid.querySelectorAll('.scg-card[data-key]').forEach(cardNode => {
      const key = cardNode.dataset.key;
      const video = cardNode.querySelector('video');
      if (video) {
        rememberPlaybackPosition(key, video);
        try { video.pause(); } catch { /* Detached player. */ }
      }
      const embed = cardNode.querySelector('.scg-embed:not(.scg-embed-placeholder)');
      const item = itemForNode(cardNode, 'key');
      if (!embed || !item || !embed.querySelector('iframe')) return;
      state.activePlayers.delete(key);
      embed.classList.add('scg-embed-placeholder');
      embed.innerHTML = embedPlaceholderMarkup(item);
    });
  }

  /* ---- Embedded players ----------------------------------------------------
     A third-party iframe is a black box: its position cannot be read, set or
     handed anywhere, so a card and the viewer holding the same embed could only
     ever restart each other. Where the resolver has a confirmed file, both play
     that natively instead and the handoff above applies; the host's own player
     stays as the fallback for anything that will not resolve or will not play.
     ------------------------------------------------------------------------ */

  // Two independent ways to play something without leaving the page, and they
  // are not the same question. An iframe needs the host to allow framing; a
  // resolved file needs only that the resolver found one. Bunkr refuses to be
  // framed and so used to render as a bare link out, even though the viewer had
  // been playing its signed file natively since the resolver landed.
  function embedIsFramable(item) {
    if (!item) return false;
    return Boolean(item.wasFrame) || embedUrl(item.url) !== unwrapSimpcityRedirect(item.url);
  }

  const playsInPlace = item => embedIsFramable(item) || hasDirectResolver(item);

  function embedFallbackMarkup(item) {
    if (embedIsFramable(item)) return iframeHtml(item);
    // Nothing to fall back to but the host's own page.
    return `<div class="scg-embed-unavailable"><b>This file would not play here</b><a href="${escapeHtml(normalizeSourceUrl(item.url))}" target="_blank" rel="noopener">${icon('external')}<span>Open on ${escapeHtml(hostOf(item.url))}</span></a></div>`;
  }

  // A signed CDN URL dies. resolveCandidate drops one that is close to death,
  // but a card re-mounted by the window renderer reads the cached candidate
  // directly and never goes through it, so the same question is asked here.
  function resolutionIsLive(resolution) {
    if (!resolution) return false;
    if (!resolution.expiresAt) return true;
    return Date.now() < Number(resolution.expiresAt) - 60000;
  }

  // Whether the card can be re-mounted straight into a player, or has to go
  // back to its Play button and resolve again.
  function embedPlaybackIsLive(item) {
    return Boolean(item) && !item.embedPlaybackFailed && resolutionIsLive(item.resolution?.candidate);
  }

  function embedPlayerMarkup(item, resolution) {
    const direct = resolution || item.resolution?.candidate;
    if (!item.embedPlaybackFailed && resolutionIsLive(direct) && direct?.status === 'confirmed' && direct.url && VIDEO_EXT.test(direct.url)) {
      return `<video controls preload="metadata" poster="${escapeHtml(item.poster || '')}" src="${escapeHtml(direct.url)}"></video>`;
    }
    return embedFallbackMarkup(item);
  }

  async function startEmbeddedPlayer(item, container) {
    if (!item || !container) return;
    state.activePlayers.add(item.selectionKey);
    container.classList.remove('scg-embed-placeholder');
    container.innerHTML = '<div class="scg-embed-loading"><i></i><span>Resolving player…</span></div>';
    let direct = null;
    try { direct = await resolveForDisplay(item); }
    catch { /* The host's own player is the fallback for every failure here. */ }
    if (!container.isConnected) return;
    container.innerHTML = embedPlayerMarkup(item, direct);
    const video = container.querySelector('video');
    if (!video) return;
    resumePlaybackPosition(video, item);
    video.addEventListener('error', () => {
      // The signed file would not play inline. Remember that, so a re-render
      // does not keep retrying it, and hand the card back to the host player.
      item.embedPlaybackFailed = true;
      if (container.isConnected) container.innerHTML = embedFallbackMarkup(item);
    }, { once: true });
    video.play?.().catch(() => { /* Autoplay may be refused; the controls remain. */ });
  }

  // Shared with card(), so tearing a player down produces exactly the markup an
  // unplayed embed would have rendered.
  function embedPlaceholderMarkup(item) {
    const key = escapeHtml(item.selectionKey || '');
    const sourceHost = escapeHtml(hostOf(item.originalLink || item.url || item.postUrl));
    // The two routes cost the reader different things, so they are named apart:
    // one loads a stranger's player, the other streams the file itself.
    const detail = embedIsFramable(item) ? `Load ${sourceHost} player` : `Stream from ${sourceHost}`;
    const poster = state.embedPosters
      ? `<img class="scg-embed-poster" data-poster-key="${key}" alt="" ${item.poster ? `src="${escapeHtml(item.poster)}"` : 'hidden'}>`
      : '';
    return `${poster}<button data-load-player="${key}">${iconWell('play', 'scg-icon-well-primary')}<b>Play video</b><span>${detail}</span></button>`;
  }

  function card(item) {
    const key = escapeHtml(item.selectionKey || '');
    const sourceHost = hostOf(item.originalLink || item.url || item.postUrl);
    const meta = `<div class="scg-meta"><span>${escapeHtml(item.author)}</span><a href="${escapeHtml(item.postUrl)}" target="_blank" rel="noopener">${icon('external')}<span>View post</span></a></div>`;
    const isSelected = state.selected.has(item.selectionKey);
    const downloaded = isMediaItem(item) && wasDownloaded(item);
    const legacyDownload = isMediaItem(item) && hasLegacyDownload(item);
    const historyClass = downloaded ? 'downloaded' : (legacyDownload ? 'download-legacy' : '');
    const selection = isDownloadableMedia(item)
      ? `<label class="scg-select" title="Select for bulk download. Shift-click extends the range, Ctrl-click adds one."><input type="checkbox" data-select="${key}" ${state.selected.has(item.selectionKey) ? 'checked' : ''}><span></span></label>`
      : '';
    const typeLabel = item.type === 'image' ? 'IMAGE' : (item.type === 'video' || item.type === 'embed' ? 'VIDEO' : item.type.toUpperCase());
    const historyLabel = downloaded ? 'VERIFIED' : (legacyDownload ? 'LEGACY' : '');
    const historyTitle = downloaded ? 'Validated media recorded in download history' : (legacyDownload ? 'Older unverified history entry; this item will not be skipped' : '');
    const badge = `<div class="scg-badge"><b>${typeLabel}</b><span>${escapeHtml(sourceHost)}</span><em class="scg-saved-status ${historyLabel ? 'visible' : ''} ${legacyDownload ? 'legacy' : ''}" title="${escapeHtml(historyTitle)}">${historyLabel}</em></div>`;
    const actions = `<div class="scg-actions"><button data-open="${key}">${iconWell('info')}<span>View</span></button><button data-download="${key}" class="scg-download-action">${iconWell('download', 'scg-icon-well-primary')}<span>${downloaded ? 'Download again' : (legacyDownload ? 'Download verified copy' : 'Download')}</span></button></div>`;
    if (item.type === 'image') {
      const displayUrl = item.resolution?.candidate?.url || item.url || item.thumb;
      return `<article class="scg-card scg-media ${isSelected ? 'selected' : ''} ${historyClass}" tabindex="-1" style="--scg-ratio:${itemRatio(item)}" data-key="${key}">${selection}${badge}<button class="scg-preview" data-open="${key}" title="View original image"><img loading="lazy" data-resolve-key="${key}" src="${escapeHtml(displayUrl)}" alt="${escapeHtml(item.caption)}"></button>${actions}${meta}</article>`;
    }
    if (item.type === 'video' && VIDEO_EXT.test(item.url)) {
      return `<article class="scg-card scg-media ${isSelected ? 'selected' : ''} ${historyClass}" tabindex="-1" data-key="${key}">${selection}${badge}<video controls preload="none" poster="${escapeHtml(item.poster || '')}" src="${escapeHtml(item.url)}"></video>${actions}${meta}</article>`;
    }
    if (item.type === 'video' || item.type === 'embed') {
      if (playsInPlace(item)) {
        // A player that has been played once re-mounts as a player -- unless its
        // resolution has expired since, in which case the Play button is the
        // honest thing to show: pressing it resolves a fresh URL.
        const player = state.activePlayers.has(item.selectionKey) && embedPlaybackIsLive(item)
          ? `<div class="scg-embed">${embedPlayerMarkup(item)}</div>`
          : `<div class="scg-embed scg-embed-placeholder">${embedPlaceholderMarkup(item)}</div>`;
        return `<article class="scg-card scg-media ${isSelected ? 'selected' : ''} ${historyClass}" tabindex="-1" data-key="${key}">${selection}${badge}${player}${actions}${meta}</article>`;
      }
      return `<article class="scg-card scg-linkcard ${isSelected ? 'selected' : ''} ${historyClass}" tabindex="-1" data-key="${key}">${selection}${badge}<a class="scg-host" href="${escapeHtml(item.url)}" target="_blank" rel="noopener"><strong>${escapeHtml(item.title || 'Open video host')}</strong><small>${escapeHtml(hostOf(item.url))}</small></a>${actions}${meta}</article>`;
    }
    if (item.type === 'link') {
      return `<article class="scg-card scg-linkcard" tabindex="-1" data-key="${key}">${badge}<a class="scg-host" href="${escapeHtml(item.url)}" target="_blank" rel="noopener"><strong>${escapeHtml(item.title || item.url)}</strong><small>${escapeHtml(hostOf(item.url))}</small></a>${meta}</article>`;
    }
    const expanded = state.expandedKeys.has(item.selectionKey);
    const expand = item.text.length > 360
      ? `<button class="scg-expand ${expanded ? 'expanded' : ''}" data-expand="${key}">${iconWell('chevron')}<span>${expanded ? 'Show less' : 'Show more'}</span></button>`
      : '';
    return `<article class="scg-card scg-textcard" tabindex="-1" data-key="${key}">${badge}<p class="${expanded ? 'expanded' : ''}">${escapeHtml(item.text)}</p>${expand}${meta}</article>`;
  }

  function gridNavigationTarget(keys, currentKey, direction, columns = 1) {
    if (!keys.length) return '';
    const found = keys.indexOf(currentKey);
    if (found < 0) return keys[0];
    const current = found;
    const stride = Math.max(1, Number(columns) || 1);
    const delta = direction === 'left' ? -1 : direction === 'right' ? 1 : direction === 'up' ? -stride : stride;
    return keys[Math.min(keys.length - 1, Math.max(0, current + delta))] || keys[0];
  }

  function gridColumnCount() {
    if (flow.model?.columns) return flow.model.columns;
    const grid = document.querySelector(`#${APP_ID} .scg-grid`);
    const first = grid?.querySelector('.scg-card[data-key]');
    return first?.offsetWidth ? Math.max(1, Math.round(grid.clientWidth / first.offsetWidth)) : 1;
  }

  function focusGridItem(key) {
    if (!key) return false;
    state.gridFocusKey = key;
    const grid = document.querySelector(`#${APP_ID} .scg-grid`);
    const findNode = () => [...(grid?.querySelectorAll('.scg-card[data-key]') || [])].find(node => node.dataset.key === key);
    let node = findNode();
    if (node) {
      node.focus({ preventScroll: true });
      node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return true;
    }
    const cell = flow.model?.byKey.get(key);
    const scroll = flowScrollArea();
    if (!cell || !scroll) return false;
    scroll.scrollTop = Math.max(0, cell.y - 80);
    updateFlowWindow();
    requestAnimationFrame(() => {
      node = findNode();
      node?.focus({ preventScroll: true });
    });
    return true;
  }

  function rectanglesIntersect(a, b) {
    return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
  }

  function setSelectOptions(select, options, selectedValue) {
    if (!select) return selectedValue;
    const signature = JSON.stringify(options);
    if (select.dataset.signature !== signature) {
      select.replaceChildren(...options.map(option => {
        const node = document.createElement('option');
        node.value = option.value;
        node.textContent = option.label;
        return node;
      }));
      select.dataset.signature = signature;
    }
    const valid = options.some(option => option.value === String(selectedValue));
    select.value = valid ? String(selectedValue) : options[0]?.value || '';
    return select.value;
  }

  // Cards address their item by selectionKey rather than by position in
  // renderedItems, so a windowed renderer can mount any slice in any order.
  function itemsByKey() {
    if (itemIndexCache && itemIndexCache.revision === datasetRevision) return itemIndexCache.map;
    const map = new Map();
    state.items.forEach(item => map.set(item.selectionKey, item));
    itemIndexCache = { revision: datasetRevision, map };
    return map;
  }

  function itemForNode(node, attribute) {
    return node ? itemsByKey().get(node.dataset[attribute]) : undefined;
  }

  function buildReplyIndex(items) {
    const index = new Map();
    items.forEach(item => {
      if (!isDownloadableMedia(item)) return;
      const key = replyKey(item);
      const bucket = index.get(key);
      if (bucket) bucket.push(item);
      else index.set(key, [item]);
    });
    return index;
  }

  // Author and host lists only change when the dataset does, so memoize them
  // on datasetRevision instead of re-deriving on every render.
  /* ---- Active filters ------------------------------------------------------
     Filtering used to be legible only as a number on the Refine button. These
     two are pure so the harness can pin down what counts as active and what
     undoing one facet leaves behind.
     ------------------------------------------------------------------------ */

  // Only facets that hide things belong here. Sort and grouping rearrange what
  // is already on screen; they cost nobody a result, so putting them in a bar
  // about what is being withheld would misreport them.
  function activeFacetChips(view, filterLabels) {
    const labels = filterLabels || {};
    const chips = [];
    const query = String(view.query || '').trim();
    if (view.filter && view.filter !== 'all') chips.push({ facet: 'filter', label: 'Type', value: labels[view.filter] || view.filter });
    if (query) chips.push({ facet: 'query', label: 'Search', value: query });
    if (view.authorFilter && view.authorFilter !== 'all') chips.push({ facet: 'author', label: 'Author', value: view.authorFilter });
    if (view.hostFilter && view.hostFilter !== 'all') chips.push({ facet: 'host', label: 'Host', value: view.hostFilter });
    if (view.downloadState && view.downloadState !== 'all') {
      chips.push({ facet: 'download', label: 'Downloads', value: DOWNLOAD_STATE_LABELS[view.downloadState] || view.downloadState });
    }
    if (view.resolutionFilter && view.resolutionFilter !== 'all') {
      chips.push({ facet: 'resolution', label: 'Resolution', value: RESOLUTION_LABELS[view.resolutionFilter] || view.resolutionFilter });
    }
    if (view.selectedOnly) chips.push({ facet: 'selected', label: 'Showing', value: 'Selected only' });
    return chips;
  }

  function facetClearPatch(facet) {
    if (facet === 'filter') return { filter: 'all' };
    if (facet === 'query') return { query: '' };
    if (facet === 'author') return { authorFilter: 'all' };
    if (facet === 'host') return { hostFilter: 'all' };
    if (facet === 'selected') return { selectedOnly: false };
    if (facet === 'download') return { downloadState: 'all' };
    if (facet === 'resolution') return { resolutionFilter: 'all' };
    if (facet === 'all') return { filter: 'all', query: '', authorFilter: 'all', hostFilter: 'all', selectedOnly: false, downloadState: 'all', resolutionFilter: 'all' };
    return null;
  }

  function facetOptions() {
    if (facetCache && facetCache.revision === datasetRevision) return facetCache;
    const authors = [...new Set(state.items.map(item => item.author).filter(Boolean))].sort(compareText);
    const hosts = [...new Set(state.items.map(itemSourceHost).filter(Boolean))].sort(compareText);
    facetCache = { revision: datasetRevision, authors, hosts };
    return facetCache;
  }

  // Counts move with every other facet, so this is memoized on the filters
  // rather than on the dataset alone.
  function facetCounts() {
    const signature = [
      datasetRevision, selectionRevision, historyRevision, state.filter, state.query,
      state.authorFilter, state.hostFilter, state.selectedOnly, state.downloadState, state.resolutionFilter,
    ].join('\u0000');
    if (facetCountCache && facetCountCache.signature === signature) return facetCountCache;
    const q = normalizedQuery();
    const authors = new Map();
    const hosts = new Map();
    state.items.forEach(item => {
      // One evaluation, both answers: the shared facets decide whether the item
      // counts at all, then each list ignores only its own.
      const parts = filterParts(item, q);
      if (!parts.type || !parts.selected || !parts.download || !parts.resolution || !parts.query) return;
      if (item.author && parts.host) authors.set(item.author, (authors.get(item.author) || 0) + 1);
      if (parts.author) {
        const host = itemSourceHost(item);
        if (host) hosts.set(host, (hosts.get(host) || 0) + 1);
      }
    });
    facetCountCache = { signature, authors, hosts };
    return facetCountCache;
  }

  function renderActiveFacets() {
    const app = document.getElementById(APP_ID);
    const bar = app && app.querySelector('[data-active-facets]');
    if (!bar) return;
    const chips = activeFacetChips(state, FILTER_LABELS);
    bar.hidden = chips.length === 0;
    if (!chips.length) {
      bar.replaceChildren();
      return;
    }
    const chipMarkup = chips.map(chip => `<button class="scg-facet-chip" data-clear-facet="${escapeHtml(chip.facet)}" aria-label="Clear ${escapeHtml(chip.label.toLowerCase())} filter ${escapeHtml(chip.value)}"><b>${escapeHtml(chip.label)}</b><span title="${escapeHtml(chip.value)}">${escapeHtml(chip.value)}</span>${icon('close')}</button>`).join('');
    const clearAll = chips.length > 1
      ? `<button class="scg-facet-clear" data-clear-facet="all">${icon('reset')}<span>Clear all</span></button>`
      : '';
    bar.innerHTML = chipMarkup + clearAll;
  }

  function refreshFilterControls() {
    const app = document.getElementById(APP_ID);
    if (!app) return;
    const { authors, hosts } = facetOptions();
    const counts = facetCounts();
    const withCount = (value, tally) => `${value} (${(tally.get(value) || 0).toLocaleString()})`;
    state.authorFilter = setSelectOptions(app.querySelector('[data-author-filter]'), [
      { value: 'all', label: `All authors (${authors.length})` },
      ...authors.map(author => ({ value: author, label: withCount(author, counts.authors) })),
    ], state.authorFilter);
    state.hostFilter = setSelectOptions(app.querySelector('[data-host-filter]'), [
      { value: 'all', label: `All hosts (${hosts.length})` },
      ...hosts.map(host => ({ value: host, label: withCount(host, counts.hosts) })),
    ], state.hostFilter);
    renderActiveFacets();

    const pageOptions = Array.from({ length: state.threadPageCount }, (_, index) => ({
      value: String(index + 1),
      label: `Page ${index + 1}`,
    }));
    state.sourcePage = Number(setSelectOptions(app.querySelector('[data-source-page]'), pageOptions, state.sourcePage) || 1);
    const sourceSelect = app.querySelector('[data-source-page]');
    if (sourceSelect) sourceSelect.disabled = state.scanning;
    app.querySelectorAll('[data-scan-range]').forEach((input, index) => {
      input.max = String(state.threadPageCount);
      if (!input.value) input.value = index ? String(state.threadPageCount) : '1';
      input.disabled = state.scanning;
    });
  }

  function replyGroupsMarkup(items) {
    const groups = new Map();
    items.forEach((item, index) => {
      const key = replyKey(item);
      if (!groups.has(key)) groups.set(key, { first: item, entries: [] });
      groups.get(key).entries.push({ item, index });
    });
    return [...groups.entries()].map(([key, group]) => {
      const first = group.first;
      const replyLabel = first.postNumber ? `Reply #${first.postNumber}` : `Reply ${Number(first.postIndex || 0) + 1}`;
      const collapsed = state.collapsedReplies.has(key);
      const toggleLabel = collapsed ? `Expand ${replyLabel}` : `Collapse ${replyLabel}`;
      const replySelection = replySelectionState(key);
      const replySelect = replySelection.total
        ? `<label class="scg-reply-select">${iconWell('select')}<input type="checkbox" data-reply-select="${escapeHtml(key)}" ${replySelection.checked ? 'checked' : ''} aria-label="Select all downloadable media in ${escapeHtml(replyLabel)}"><span>Select reply</span></label>`
        : '';
      const itemCount = `${group.entries.length} item${group.entries.length === 1 ? '' : 's'}`;
      return `<section class="scg-reply-group ${collapsed ? 'collapsed' : ''}" data-reply-key="${escapeHtml(key)}"><header><button class="scg-reply-toggle" data-reply-toggle="${escapeHtml(key)}" aria-expanded="${String(!collapsed)}" aria-label="${escapeHtml(toggleLabel)}">${iconWell('chevron')}</button>${replySelect}<div class="scg-reply-identity"><b>${escapeHtml(replyLabel)}</b><span>Page ${Number(first.pageNumber || 1)}</span><span>${escapeHtml(first.author || 'Unknown')}</span><span>${itemCount}</span><span data-reply-selection-count>${replySelectionSummary(replySelection)}</span><em class="scg-collapsed-status">${collapsed ? 'Collapsed' : ''}</em></div><a href="${escapeHtml(first.postUrl)}" target="_blank" rel="noopener">${icon('external')}<span>Reply</span></a></header><div class="scg-group-grid">${collapsed ? '' : group.entries.map(entry => card(entry.item)).join('')}</div></section>`;
    }).join('');
  }

  let allClampAnnounced = false;
  function noteClampedAll(matchedCount, clamped) {
    if (clamped === allClampAnnounced) return;
    allClampAnnounced = clamped;
    if (!clamped) return;
    const reason = state.groupBy === 'reply' ? 'Reply grouping' : LAYOUT_LABELS[state.layoutMode];
    notify(`${reason} mounts every card, so Per view: All is paged at ${DEFAULT_SETTINGS.perPage} for these ` +
      `${Number(matchedCount).toLocaleString()} matches. Masonry without reply grouping renders only what is on screen and can show them all at once. ` +
      'Your Per view setting is unchanged.', 8000);
  }

  function updateViewPager(matchedCount) {
    const app = document.getElementById(APP_ID);
    if (!app) return;
    const pageSelect = app.querySelector('[data-view-page]');
    const options = Array.from({ length: state.viewPages }, (_, index) => ({ value: String(index + 1), label: `View ${index + 1}` }));
    setSelectOptions(pageSelect, options, state.viewPage);
    // Paging is a consequence of the page size, not a thing to browse with. It
    // shows up only when there is somewhere else to go.
    app.querySelector('.scg-view-pagination').hidden = state.viewPages <= 1;
    app.querySelector('[data-action="view-prev"]').disabled = state.scanning || state.viewPage <= 1;
    app.querySelector('[data-action="view-next"]').disabled = state.scanning || state.viewPage >= state.viewPages;
    pageSelect.disabled = state.scanning;
    // A windowed renderer lays out the whole filtered collection, so Per view
    // changes nothing. Disabled rather than hidden: the stored preference stays
    // visible, and it is the value that comes back in a paged layout.
    const virtualized = usesWindowedRenderer();
    const pageSize = app.querySelector('[data-page-size]');
    pageSize.disabled = state.scanning || virtualized;
    pageSize.value = String(state.perPage);
    const pageSizeLabel = pageSize.closest('label');
    if (pageSizeLabel) {
      pageSizeLabel.toggleAttribute('data-inert', virtualized);
      pageSizeLabel.title = virtualized
        ? `${LAYOUT_LABELS[state.layoutMode]} renders only what is on screen, so every match is laid out at once.`
        : '';
    }
    const indexed = state.items.length;
    const rendered = state.renderedItems.length;
    const count = value => Number(value).toLocaleString();
    const clamped = !virtualized && state.perPage === 0 && state.appliedPerPage !== 0;
    // Always a fraction of the whole, so filtering never reads as data loss.
    const summary = virtualized
      ? (matchedCount === indexed ? `${count(indexed)} matched · virtualized` : `${count(matchedCount)} of ${count(indexed)} matched · virtualized`)
      : (matchedCount === indexed ? `${count(rendered)} of ${count(indexed)} shown` : `${count(rendered)} shown · ${count(matchedCount)} of ${count(indexed)} match`);
    app.querySelector('.scg-view-summary').textContent = clamped ? `${summary} · All paged at ${state.appliedPerPage}` : summary;
  }

  function emptyStateMarkup() {
    const indexed = state.items.length;
    const heading = indexed ? 'No media matches these filters' : 'Nothing indexed yet';
    const hint = indexed
      ? 'Try clearing the search box, switching the type filter back to All, or opening Refine and resetting the author, host and grouping facets.'
      : 'Use "This page" to index the reply page you are on, or "Scan thread" to walk every page. Media stays unloaded until you scroll it into view.';
    return `<div class="scg-empty" role="status"><span class="scg-empty-art">${icon(indexed ? 'search' : 'scan')}</span><b>${escapeHtml(heading)}</b><span>${escapeHtml(hint)}</span></div>`;
  }

  function skeletonMarkup(count = 12) {
    return Array.from({ length: count }, (_, index) => `<div class="scg-skeleton" aria-hidden="true"><div class="scg-skeleton-media" style="--scg-skeleton-height:${160 + ((index % 4) * 36)}px"></div><div class="scg-skeleton-line"></div><div class="scg-skeleton-line short"></div></div>`).join('');
  }

  /* ---- Media scheduler -----------------------------------------------------
     Mounting a screenful of cards used to fire a resolution per card at once.
     This caps the work, orders it by distance from the middle of the viewport,
     and drops anything that scrolls away before its turn.
     ------------------------------------------------------------------------ */

  const RESOLVE_CONCURRENCY = 3;
  const DECODE_CONCURRENCY = 6;

  const mediaScheduler = { queue: new Map(), resolving: 0, decoding: 0 };

  // Distance from the middle of the viewport. Computed at pick time rather
  // than stored, so the order follows the scroll without re-sorting a queue.
  function mediaRevealPriority(key) {
    const model = flow.model;
    const scrollArea = flowScrollArea();
    if (!model || !scrollArea) return 0;
    const cell = model.byKey.get(String(key).replace(/^poster:/, ''));
    if (!cell) return Number.MAX_SAFE_INTEGER;
    const centre = scrollArea.scrollTop + (scrollArea.clientHeight / 2);
    return Math.abs((cell.y + (cell.height / 2)) - centre);
  }

  function nextScheduledEntry(phase) {
    let best = null;
    let bestPriority = Infinity;
    mediaScheduler.queue.forEach(entry => {
      if (entry.phase !== phase || entry.cancelled) return;
      const priority = mediaRevealPriority(entry.key);
      if (priority < bestPriority) {
        best = entry;
        bestPriority = priority;
      }
    });
    return best;
  }

  function finishScheduled(entry) {
    mediaScheduler.queue.delete(entry.key);
    pumpMediaScheduler();
  }

  function startResolve(entry) {
    entry.phase = 'resolving';
    mediaScheduler.resolving += 1;
    // resolveForDisplay memoizes on the item, so a resolve that lands after the
    // card scrolled away is banked rather than wasted. No failure bookkeeping
    // is added here: resolution.failedAt drives a cooldown that the download
    // path also reads, and a display failure must not poison a download.
    const work = entry.kind === 'poster' ? resolveEmbedPoster(entry.item) : resolveForDisplay(entry.item);
    work.then(result => {
      mediaScheduler.resolving -= 1;
      if (entry.cancelled || !result || !result.url) return finishScheduled(entry);
      entry.url = result.url;
      entry.phase = 'ready';
      pumpMediaScheduler();
    }, () => {
      mediaScheduler.resolving -= 1;
      finishScheduled(entry);
    });
  }

  function startDecode(entry) {
    entry.phase = 'decoding';
    mediaScheduler.decoding += 1;
    const probe = new Image();
    probe.decoding = 'async';
    try { probe.fetchPriority = mediaRevealPriority(entry.key) < 400 ? 'high' : 'low'; }
    catch { /* Not every engine exposes fetchPriority. */ }

    const done = () => {
      mediaScheduler.decoding -= 1;
      finishScheduled(entry);
    };
    // Swap only once the bytes are decoded, so the card never flashes a
    // half-painted image. On failure the thumbnail is left in place rather
    // than replaced by a broken one.
    const reveal = () => {
      if (!entry.cancelled && entry.img.isConnected && entry.img.src !== entry.url) {
        entry.img.src = entry.url;
        entry.img.hidden = false;
        if (entry.kind === 'poster') entry.item.poster = entry.url;
      }
      done();
    };
    probe.src = entry.url;
    if (typeof probe.decode === 'function') probe.decode().then(reveal, done);
    else {
      probe.onload = reveal;
      probe.onerror = done;
    }
  }

  function pumpMediaScheduler() {
    while (mediaScheduler.resolving < RESOLVE_CONCURRENCY) {
      const entry = nextScheduledEntry('pending');
      if (!entry) break;
      startResolve(entry);
    }
    while (mediaScheduler.decoding < DECODE_CONCURRENCY) {
      const entry = nextScheduledEntry('ready');
      if (!entry) break;
      startDecode(entry);
    }
  }

  function scheduleMediaReveal(item, img) {
    if (!item || !img || item.type !== 'image' || !item.selectionKey) return;
    const existing = mediaScheduler.queue.get(item.selectionKey);
    if (existing) {
      // Remounted before its turn came round: keep the queue slot, point it at
      // the new node.
      existing.img = img;
      existing.cancelled = false;
      return;
    }
    mediaScheduler.queue.set(item.selectionKey, {
      key: item.selectionKey, item, img, phase: 'pending', cancelled: false, url: '',
    });
    pumpMediaScheduler();
  }

  async function resolveEmbedPoster(item) {
    if (item?.poster) return { url: item.poster };
    const page = normalizeSourceUrl(item?.originalLink || item?.url || '');
    if (!page) return { url: '' };
    try {
      const poster = mediaFromHtml(await requestText(page, { headers: { Accept: 'text/html,*/*', Referer: item.postUrl || location.href } }), page, 'image');
      return { url: poster || '' };
    } catch (error) {
      recordDiagnostic('resolverFailures', 'Embed poster', error, item);
      return { url: '' };
    }
  }

  function scheduleEmbedPoster(item, img) {
    if (!state.embedPosters || !item || !img || !['video', 'embed'].includes(item.type) || !item.selectionKey) return;
    const key = `poster:${item.selectionKey}`;
    const existing = mediaScheduler.queue.get(key);
    if (existing) {
      existing.img = img;
      existing.cancelled = false;
      return;
    }
    mediaScheduler.queue.set(key, { key, kind: 'poster', item, img, phase: 'pending', cancelled: false, url: '' });
    pumpMediaScheduler();
  }

  function cancelMediaReveal(key) {
    [key, `poster:${key}`].forEach(queueKey => {
      const entry = mediaScheduler.queue.get(queueKey);
      if (!entry) return;
      entry.cancelled = true;
      // In-flight work is left to settle; only the DOM swap is suppressed.
      if (entry.phase === 'pending') mediaScheduler.queue.delete(queueKey);
    });
  }

  function cancelAllMediaReveals() {
    mediaScheduler.queue.forEach(entry => { entry.cancelled = true; });
    mediaScheduler.queue.forEach((entry, key) => {
      if (entry.phase === 'pending') mediaScheduler.queue.delete(key);
    });
  }

  /* ---- The windowed renderer -----------------------------------------------
     CSS multi-column cannot be virtualized -- the browser must see every box to
     balance the columns -- so masonry positions its cards itself and mounts
     only the ones near the viewport. Pagination is bypassed here: the whole
     filtered set is laid out and the window does the limiting.
     ------------------------------------------------------------------------ */

  const FLOW_OVERSCAN = 900;
  const FLOW_CHROME = 86;

  const flow = {
    model: null,
    mounted: new Map(),
    range: { start: 0, end: -1 },
    frame: 0,
    pendingLayout: false,
    resizeObserver: null,
    width: 0,
  };

  // Masonry owns the grid only when it is a flat list of cards. Reply grouping
  // needs the sectioned markup path and a scan renders skeletons, so in both
  // cases the windowed renderer is not what is on screen. Everything that
  // reasons about virtualization asks this, never the layout alone: the two
  // answers drifting apart is what let a grouped "All" mount every card while
  // the size warning stayed silent.
  function usesWindowedRenderer(overrides = {}) {
    const layoutMode = overrides.layoutMode === undefined ? state.layoutMode : overrides.layoutMode;
    const groupBy = overrides.groupBy === undefined ? state.groupBy : overrides.groupBy;
    const scanning = overrides.scanning === undefined ? state.scanning : overrides.scanning;
    return VIRTUALIZED_LAYOUTS.includes(layoutMode) && groupBy !== 'reply' && !scanning;
  }

  // "All" only means something when a renderer bounds the DOM. Windowed layouts
  // mount a slice whatever the number is, so All is free there. Every other
  // path mounts each matched card, which a large thread does not survive, so
  // All is paged for that render only. The stored preference is deliberately
  // left untouched, so returning to a windowed layout restores it.
  const UNWINDOWED_ALL_LIMIT = 1200;
  const UNWINDOWED_ALL_NOTICE = 800;

  function effectivePerPage(matchedCount, perPage = state.perPage) {
    const size = Number(perPage) || 0;
    if (size !== 0 || usesWindowedRenderer()) return size;
    return Number(matchedCount) > UNWINDOWED_ALL_LIMIT ? DEFAULT_SETTINGS.perPage : 0;
  }

  function flowGrid() {
    const app = document.getElementById(APP_ID);
    return app && usesWindowedRenderer() ? app.querySelector('.scg-grid') : null;
  }

  function flowScrollArea() {
    const app = document.getElementById(APP_ID);
    return app ? app.querySelector('.scg-scroll') : null;
  }

  // The same breakpoints and counts the CSS columns used, which still apply to
  // the paths the window does not own.
  const MASONRY_COLUMN_CAPS = Object.freeze([
    Object.freeze({ upTo: 720, columns: 2, compact: 2 }),
    Object.freeze({ upTo: 1024, columns: 3, compact: 4 }),
    Object.freeze({ upTo: 1340, columns: 4, compact: 6 }),
    Object.freeze({ upTo: Infinity, columns: 5, compact: 7 }),
  ]);

  function masonryColumnCap(windowWidth, compact) {
    // An unknown width means the widest cap, never the narrowest: guessing
    // narrow would pin a desktop to two columns.
    const width = Number(windowWidth) > 0 ? Number(windowWidth) : Infinity;
    const step = MASONRY_COLUMN_CAPS.find(entry => width <= entry.upTo) || MASONRY_COLUMN_CAPS[MASONRY_COLUMN_CAPS.length - 1];
    return compact ? step.compact : step.columns;
  }

  function flowLayoutOptions(containerWidth) {
    const scale = Math.min(160, Math.max(70, Number(state.cardScale) || 100)) / 100;
    const gap = state.compact ? 10 : 14;
    return {
      containerWidth,
      columnWidth: Math.round((state.compact ? 195 : 280) * scale),
      maxColumns: masonryColumnCap(typeof window === 'undefined' ? 0 : window.innerWidth, state.compact),
      gap,
      chromeHeight: FLOW_CHROME,
      assumedRatio: assumedRatio(),
    };
  }

  function buildFlowModel(containerWidth) {
    // Hoisted: itemRatio falls back to assumedRatio(), which recomputes a
    // geometric mean per call, and this maps the entire filtered set.
    const fallbackRatio = assumedRatio();
    const entries = state.renderedItems.map(item => ({
      key: item.selectionKey,
      ratio: (item.ratio && item.ratio.value) || fallbackRatio,
    }));
    const options = flowLayoutOptions(containerWidth);
    const packed = packColumns(entries, options);
    const byKey = new Map();
    let maxCellHeight = 0;
    packed.cells.forEach(cell => {
      byKey.set(cell.key, cell);
      if (cell.height > maxCellHeight) maxCellHeight = cell.height;
    });
    // visibleRowRange binary-searches on y, so the index it walks must be
    // sorted by y. packColumns emits in item order, which is not.
    const ordered = packed.cells.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    return {
      cells: ordered,
      byKey,
      height: packed.height,
      columns: packed.columns || 0,
      maxCellHeight,
      width: containerWidth,
    };
  }

  function positionFlowCard(node, cell) {
    node.style.left = cell.x + 'px';
    node.style.top = cell.y + 'px';
    node.style.width = cell.width + 'px';
    node.style.height = cell.height + 'px';
  }

  const flowTemplate = document.createElement('template');

  function mountFlowCard(grid, cell) {
    const item = itemsByKey().get(cell.key);
    if (!item) return;
    flowTemplate.innerHTML = card(item);
    const node = flowTemplate.content.firstElementChild;
    if (!node) return;
    node.classList.add('scg-flow-cell');
    positionFlowCard(node, cell);
    grid.appendChild(node);
    flow.mounted.set(cell.key, node);
    // No IntersectionObserver here: anything mounted is already inside the
    // overscan band. The scheduler decides when it actually gets fetched.
    if (item.type === 'image') {
      const img = node.querySelector('img[data-resolve-key]');
      if (img) scheduleMediaReveal(item, img);
    }
    const poster = node.querySelector('img[data-poster-key]');
    if (poster) scheduleEmbedPoster(item, poster);
    // Scrolling a playing card out of the window and back should not rewind it.
    resumePlaybackPosition(node.querySelector('video'), item);
  }

  function releaseFlowNode(node) {
    node.querySelectorAll('video').forEach(video => {
      rememberPlaybackPosition(node.dataset.key, video);
      try { video.pause(); } catch { /* Detached player. */ }
      video.removeAttribute('src');
      try { video.load(); } catch { /* Detached player. */ }
    });
    node.querySelectorAll('iframe').forEach(frame => frame.setAttribute('src', 'about:blank'));
    node.remove();
  }

  function unmountFlowCards(keep) {
    flow.mounted.forEach((node, key) => {
      if (keep.has(key)) return;
      cancelMediaReveal(key);
      releaseFlowNode(node);
      flow.mounted.delete(key);
    });
  }

  function updateFlowWindow() {
    const grid = flowGrid();
    const scrollArea = flowScrollArea();
    const model = flow.model;
    if (!grid || !scrollArea || !model) return;
    const range = visibleRowRange(model.cells, scrollArea.scrollTop, scrollArea.clientHeight, FLOW_OVERSCAN, model.maxCellHeight);
    // Most scroll frames do not change which cards are mounted, and everything
    // below is wasted work when they do not.
    if (range.start === flow.range.start && range.end === flow.range.end && flow.mounted.size) return;
    flow.range = range;
    const keep = new Set();
    for (let index = range.start; index <= range.end; index++) keep.add(model.cells[index].key);
    unmountFlowCards(keep);
    for (let index = range.start; index <= range.end; index++) {
      const cell = model.cells[index];
      if (!flow.mounted.has(cell.key)) mountFlowCard(grid, cell);
    }
    // No updateSelectionUi() here. A mounted card renders its own selected state
    // from card(), and nothing about scrolling changes the selection -- so this
    // was walking every indexed item, once per frame, to learn nothing.
  }

  // Re-packing moves everything below a changed card. Anchoring on the first
  // mounted cell and correcting scrollTop by its delta keeps what the reader is
  // looking at where it was.
  function relayoutFlow() {
    const grid = flowGrid();
    const scrollArea = flowScrollArea();
    if (!grid || !scrollArea) return;
    const width = grid.clientWidth;
    if (width <= 0) return;
    const anchorKey = flow.model && flow.range.end >= flow.range.start
      ? flow.model.cells[flow.range.start].key
      : null;
    const anchorBefore = anchorKey ? flow.model.byKey.get(anchorKey)?.y : null;

    flow.width = width;
    flow.model = buildFlowModel(width);
    grid.style.height = flow.model.height + 'px';

    if (anchorKey != null && anchorBefore != null) {
      const anchorAfter = flow.model.byKey.get(anchorKey)?.y;
      if (anchorAfter != null && anchorAfter !== anchorBefore) {
        scrollArea.scrollTop += anchorAfter - anchorBefore;
      }
    }

    flow.mounted.forEach((node, key) => {
      const cell = flow.model.byKey.get(key);
      if (cell) positionFlowCard(node, cell);
    });
    updateFlowWindow();
  }

  // One frame slot, but the two requests are not equal. A scroll and an
  // arriving image ratio land in the same frame constantly, and a shared
  // boolean let the cheaper one win: the queued window update ran, the re-pack
  // was dropped, and the measured ratio never reached the layout. A pending
  // layout is therefore sticky -- a window request can never downgrade it.
  function scheduleFlowFrame(wantsLayout) {
    if (!usesWindowedRenderer()) return;
    if (wantsLayout) flow.pendingLayout = true;
    if (flow.frame) return;
    flow.frame = requestAnimationFrame(() => {
      flow.frame = 0;
      const relayout = flow.pendingLayout;
      flow.pendingLayout = false;
      if (relayout) relayoutFlow();
      else updateFlowWindow();
    });
  }

  function scheduleFlowLayout() {
    scheduleFlowFrame(true);
  }

  function scheduleFlowWindow() {
    scheduleFlowFrame(false);
  }

  // A late ratio re-packs the whole list, and during the first scroll through a
  // thread they arrive continuously. A resize or a density change is different:
  // the reader is waiting on that geometry, so those stay immediate. These only
  // refine it, so they settle together.
  const RATIO_RELAYOUT_DELAY = 150;
  let ratioLayoutTimer = 0;

  function scheduleFlowRatioLayout() {
    if (ratioLayoutTimer || !usesWindowedRenderer()) return;
    ratioLayoutTimer = setTimeout(() => {
      ratioLayoutTimer = 0;
      scheduleFlowLayout();
    }, RATIO_RELAYOUT_DELAY);
  }

  function teardownFlow() {
    if (flow.frame) cancelAnimationFrame(flow.frame);
    if (ratioLayoutTimer) clearTimeout(ratioLayoutTimer);
    ratioLayoutTimer = 0;
    flow.frame = 0;
    flow.pendingLayout = false;
    flow.mounted.forEach(node => releaseFlowNode(node));
    flow.mounted.clear();
    flow.model = null;
    flow.range = { start: 0, end: -1 };
    flow.width = 0;
    const app = document.getElementById(APP_ID);
    const grid = app && app.querySelector('.scg-grid');
    if (grid) grid.style.removeProperty('height');
  }

  function ensureFlowResizeObserver() {
    if (flow.resizeObserver || typeof ResizeObserver !== 'function') return;
    const app = document.getElementById(APP_ID);
    const grid = app && app.querySelector('.scg-grid');
    if (!grid) return;
    flow.resizeObserver = new ResizeObserver(() => {
      if (!usesWindowedRenderer()) return;
      // Height changes come from our own re-packing; only width matters.
      if (grid.clientWidth === flow.width) return;
      scheduleFlowLayout();
    });
    flow.resizeObserver.observe(grid);
  }

  function renderFlow() {
    const grid = flowGrid();
    if (!grid) return;
    grid.replaceChildren();
    flow.mounted.clear();
    flow.model = null;
    ensureFlowResizeObserver();
    relayoutFlow();
  }

  function render() {
    const app = document.getElementById(APP_ID);
    if (!app) return;
    refreshLaunchButton();
    if (!app.classList.contains('open')) {
      releaseRenderedMedia();
      state.renderedItems = [];
      return;
    }
    const c = counts();
    app.classList.toggle('scanning', state.scanning);
    app.classList.toggle('grouped-replies', state.groupBy === 'reply');
    applyShellState();
    app.querySelectorAll('[data-filter], [data-search], [data-card-scale], .scg-refinebar button, .scg-refinebar select, .scg-viewbar button, .scg-viewbar select, [data-action="selection-mode"], [data-action="page"], [data-action="load-source-page"], [data-action="scan-new"], [data-action="scan-range"], [data-scan-range]').forEach(control => {
      control.disabled = state.scanning;
    });
    app.querySelectorAll('[data-filter]').forEach(btn => {
      const active = btn.dataset.filter === state.filter;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
      const key = btn.dataset.filter;
      const total = c[key] ?? 0;
      btn.querySelector('span').textContent = total;
      const name = btn.querySelector('b')?.textContent || key;
      btn.setAttribute('aria-label', `${name}, ${total} item${total === 1 ? '' : 's'}`);
    });
    refreshFilterControls();
    const matched = state.scanning ? [] : visibleItems();
    state.replyIndex = !state.scanning && state.groupBy === 'reply' ? buildReplyIndex(matched) : null;
    const virtualized = usesWindowedRenderer();
    if (virtualized) {
      state.viewPages = 1;
      state.viewPage = 1;
      state.appliedPerPage = 0;
      state.renderedItems = matched;
    } else {
      state.appliedPerPage = effectivePerPage(matched.length);
      const pages = buildViewPages(matched, state.appliedPerPage);
      state.viewPages = pages.length;
      state.viewPage = Math.min(Math.max(1, state.viewPage), state.viewPages);
      state.renderedItems = pages[state.viewPage - 1] || [];
    }
    noteClampedAll(matched.length, !virtualized && state.perPage === 0 && state.appliedPerPage !== 0);
    const grid = app.querySelector('.scg-grid');
    releaseRenderedMedia();
    grid.classList.toggle('grouped', state.groupBy === 'reply');
    grid.classList.toggle('flowing', virtualized);
    if (virtualized) {
      if (state.renderedItems.length) renderFlow();
      else grid.innerHTML = emptyStateMarkup();
    } else {
      grid.innerHTML = state.scanning
        ? skeletonMarkup(state.compact ? 16 : 12)
        : state.renderedItems.length
          ? (state.groupBy === 'reply' ? replyGroupsMarkup(state.renderedItems) : state.renderedItems.map(item => card(item)).join(''))
          : emptyStateMarkup();
      if (!state.scanning) observeFullImages(state.renderedItems);
    }
    app.querySelector('.scg-status').textContent = state.scanning
      ? `Scanning ${state.scannedPages || 1} of ${state.threadPageCount}`
      : state.sourceLabel;
    const activityDetail = app.querySelector('[data-activity-detail]');
    if (activityDetail) activityDetail.textContent = state.scanning
      ? `${state.items.length} items indexed · media stays unloaded`
      : `${LAYOUT_LABELS[state.layoutMode]} · ${matched.length} matched · ${state.items.length} indexed · ` +
        (virtualized ? 'virtualized' : `view ${state.viewPage} of ${state.viewPages}`);
    setIconButton(app.querySelector('[data-action="thread"]'), state.scanning ? 'close' : 'scan', state.scanning ? 'Cancel scan' : 'Scan entire thread');
    const selectedOnly = app.querySelector('[data-selected-only]');
    selectedOnly.classList.toggle('active', state.selectedOnly);
    selectedOnly.setAttribute('aria-pressed', String(Boolean(state.selectedOnly)));
    refreshRefineTrigger();
    app.querySelector('[data-sort]').value = state.sort;
    app.querySelector('[data-group-by]').value = state.groupBy;
    app.querySelector('[data-download-state]').value = state.downloadState;
    app.querySelector('[data-resolution-filter]').value = state.resolutionFilter;
    updateViewPager(matched.length);
    updateSelectionUi();
    updateDownloadUi();
    refreshThreadHeader();
    if (app.querySelector('.scg-settings-panel.open')) refreshSettingsPanel();
  }

  function normalizeMediaDimensions(width, height) {
    const normalizedWidth = Math.max(0, Math.round(Number(width) || 0));
    const normalizedHeight = Math.max(0, Math.round(Number(height) || 0));
    return normalizedWidth && normalizedHeight ? { width: normalizedWidth, height: normalizedHeight } : null;
  }

  function mediaResolutionText(dimensions, qualifier = '') {
    const normalized = normalizeMediaDimensions(dimensions?.width, dimensions?.height);
    if (!normalized) return 'Unavailable';
    const value = `${normalized.width.toLocaleString()} × ${normalized.height.toLocaleString()}`;
    return qualifier ? `${qualifier} · ${value}` : value;
  }

  function cachedMediaResolution(item) {
    const dimensions = normalizeMediaDimensions(item?.mediaDimensions?.width, item?.mediaDimensions?.height);
    if (!dimensions) return 'Detecting…';
    return mediaResolutionText(dimensions, item.mediaDimensions.qualifier || '');
  }

  function updateViewerResolution(box, item, width, height, qualifier = '', mediaUrl = '') {
    const dimensions = normalizeMediaDimensions(width, height);
    if (!box || !item || !dimensions) return false;
    item.mediaDimensions = { ...dimensions, qualifier, mediaUrl: absoluteUrl(mediaUrl), detectedAt: Date.now() };
    visibleItemsCache = null;
    facetCountCache = null;
    applyMeasuredRatio(item, dimensions.width, dimensions.height, qualifier ? 'thumb' : 'measured');
    const value = mediaResolutionText(dimensions, qualifier);
    box.querySelectorAll('[data-viewer-resolution]').forEach(node => {
      node.textContent = value;
      node.setAttribute('title', `${dimensions.width} by ${dimensions.height} pixels`);
    });
    return true;
  }

  function setViewerResolutionStatus(box, value) {
    if (!box) return;
    box.querySelectorAll('[data-viewer-resolution]').forEach(node => {
      node.textContent = value;
      node.removeAttribute('title');
    });
  }

  function bindViewerVideoResolution(video, box, item, stillCurrent) {
    if (!video) {
      if (stillCurrent()) setViewerResolutionStatus(box, 'Unavailable');
      return;
    }
    const update = () => {
      if (!stillCurrent()) return;
      if (!updateViewerResolution(box, item, video.videoWidth, video.videoHeight, '', video.currentSrc || video.src)) {
        setViewerResolutionStatus(box, 'Unavailable');
      }
    };
    video.addEventListener('loadedmetadata', update);
    video.addEventListener('error', () => {
      if (stillCurrent()) setViewerResolutionStatus(box, 'Unavailable');
    }, { once: true });
    if (video.readyState >= 1) update();
  }

  function probeVideoDimensions(url, timeoutMs = 12000) {
    const mediaUrl = absoluteUrl(url);
    if (!mediaUrl) return Promise.resolve(null);
    return new Promise(resolve => {
      const video = document.createElement('video');
      let settled = false;
      const finish = dimensions => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        video.onloadedmetadata = null;
        video.onerror = null;
        video.removeAttribute('src');
        try { video.load(); } catch { /* Detached metadata probe. */ }
        resolve(dimensions);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      video.onloadedmetadata = () => finish(normalizeMediaDimensions(video.videoWidth, video.videoHeight));
      video.onerror = () => finish(null);
      video.src = mediaUrl;
    });
  }

  function viewerItemTitle(item) {
    return String(item.caption || item.title || (item.type === 'image' ? 'Image' : 'Video')).replace(/\s+/g, ' ').trim();
  }

  function viewerReplyLabel(item) {
    return item.postNumber ? `Reply #${item.postNumber}` : `Reply ${Number(item.postIndex || 0) + 1}`;
  }

  function viewerStripMarkup(items, activeIndex) {
    const radius = 7;
    const start = Math.max(0, Math.min(activeIndex - radius, Math.max(0, items.length - ((radius * 2) + 1))));
    const end = Math.min(items.length, start + ((radius * 2) + 1));
    return items.slice(start, end).map((item, offset) => {
      const index = start + offset;
      const preview = absoluteUrl(item.type === 'image' ? item.thumb : item.poster);
      const label = `${index + 1}. ${viewerItemTitle(item)}`;
      return `<button class="scg-viewer-thumb ${index === activeIndex ? 'active' : ''}" data-viewer-index="${index}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" aria-current="${index === activeIndex ? 'true' : 'false'}">${preview ? `<img loading="lazy" src="${escapeHtml(preview)}" alt="">` : `<span>${icon(item.type === 'image' ? 'image' : 'play')}</span>`}<em>${index + 1}</em></button>`;
    }).join('');
  }

  function resetViewerTransform(update = true) {
    state.viewerZoom = 1;
    state.viewerPanX = 0;
    state.viewerPanY = 0;
    if (update) updateViewerTransform();
  }

  function updateViewerTransform() {
    const box = document.querySelector(`#${APP_ID} .scg-lightbox.open`);
    const image = box?.querySelector('.scg-viewer-image');
    if (!box || !image) return;
    const transform = `translate3d(${state.viewerPanX}px,${state.viewerPanY}px,0) scale(${state.viewerZoom})`;
    image.style.setProperty('--scg-viewer-transform', transform);
    image.style.setProperty('transform', transform, 'important');
    box.classList.toggle('viewer-zoomed', state.viewerZoom > 1.01);
    const value = box.querySelector('[data-viewer-zoom-value]');
    if (value) value.textContent = `${Math.round(state.viewerZoom * 100)}%`;
    box.querySelector('[data-viewer-zoom-out]')?.toggleAttribute('disabled', state.viewerZoom <= 1);
  }

  function setViewerZoom(value) {
    const next = Math.min(6, Math.max(1, Number(value) || 1));
    state.viewerZoom = Math.round(next * 100) / 100;
    if (state.viewerZoom === 1) {
      state.viewerPanX = 0;
      state.viewerPanY = 0;
    }
    updateViewerTransform();
    requestAnimationFrame(updateViewerTransform);
  }

  function toggleViewerInfo(force) {
    const box = document.querySelector(`#${APP_ID} .scg-lightbox.open`);
    if (!box) return;
    state.viewerInfoOpen = typeof force === 'boolean' ? force : !state.viewerInfoOpen;
    box.classList.toggle('details-hidden', !state.viewerInfoOpen);
    const button = box.querySelector('[data-viewer-info]');
    if (button) button.setAttribute('aria-pressed', String(state.viewerInfoOpen));
    wakeViewerChrome();
  }

  async function toggleViewerFullscreen() {
    const box = document.querySelector(`#${APP_ID} .scg-lightbox.open`);
    if (!box) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await box.requestFullscreen();
    } catch (error) {
      notify(`Fullscreen is unavailable: ${error.message}`);
    }
  }

  function bindViewerImageInteractions(image, stage) {
    image.draggable = false;
    image.ondblclick = event => {
      event.preventDefault();
      setViewerZoom(state.viewerZoom > 1 ? 1 : 2);
    };
    stage.addEventListener('wheel', event => {
      if (!image.isConnected) return;
      event.preventDefault();
      setViewerZoom(state.viewerZoom + (event.deltaY < 0 ? .25 : -.25));
    }, { passive: false });
    let gesture = null;
    stage.onpointerdown = event => {
      if (event.button !== 0) return;
      gesture = { x: event.clientX, y: event.clientY, panX: state.viewerPanX, panY: state.viewerPanY, pointerType: event.pointerType };
      stage.setPointerCapture?.(event.pointerId);
      if (state.viewerZoom > 1) image.classList.add('dragging');
    };
    stage.onpointermove = event => {
      if (!gesture || state.viewerZoom <= 1) return;
      state.viewerPanX = gesture.panX + event.clientX - gesture.x;
      state.viewerPanY = gesture.panY + event.clientY - gesture.y;
      updateViewerTransform();
    };
    const finish = event => {
      if (!gesture) return;
      const deltaX = event.clientX - gesture.x;
      const deltaY = event.clientY - gesture.y;
      const swipe = state.viewerZoom <= 1 && gesture.pointerType === 'touch' && Math.abs(deltaX) > 65 && Math.abs(deltaX) > Math.abs(deltaY) * 1.25;
      gesture = null;
      image.classList.remove('dragging');
      if (swipe) navigateLightbox(deltaX > 0 ? -1 : 1);
    };
    stage.onpointerup = finish;
    stage.onpointercancel = finish;
  }

  function bindViewerVideoLifecycle(video, stage, onError) {
    if (!video) return;
    const stopBuffering = () => stage.classList.remove('viewer-buffering');
    video.addEventListener('loadstart', () => stage.classList.add('viewer-buffering'));
    video.addEventListener('waiting', () => stage.classList.add('viewer-buffering'));
    video.addEventListener('canplay', stopBuffering);
    video.addEventListener('playing', stopBuffering);
    video.addEventListener('error', () => {
      stopBuffering();
      if (onError) return onError();
      stage.innerHTML = '<div class="scg-viewer-error">This video could not be played here. Use Open source to watch it on the host.</div>';
    }, { once: true });
  }

  let viewerChromeTimer = 0;

  function viewerChromeEngaged(box) {
    const active = document.activeElement;
    const keyboardFocused = active instanceof Element && active.matches(':focus-visible');
    return [...box.querySelectorAll('.scg-viewer-topbar, .scg-viewer-footer')].some(panel =>
      panel.matches(':hover') || (keyboardFocused && panel.contains(active)));
  }

  function armViewerChromeIdle(box, delay = 2600) {
    clearTimeout(viewerChromeTimer);
    viewerChromeTimer = window.setTimeout(() => {
      if (!box.classList.contains('open')) return;
      if (viewerChromeEngaged(box)) {
        armViewerChromeIdle(box, 800);
        return;
      }
      box.classList.add('viewer-idle');
    }, delay);
  }

  function wakeViewerChrome() {
    const box = document.querySelector(`#${APP_ID} .scg-lightbox.open`);
    if (!box) return;
    box.classList.remove('viewer-idle');
    armViewerChromeIdle(box);
  }

  function closeLightbox() {
    const box = document.querySelector(`#${APP_ID} .scg-lightbox`);
    if (!box) return;
    clearTimeout(viewerChromeTimer);
    const watched = currentViewerItem();
    rememberPlaybackPosition(watched && watched.selectionKey, box.querySelector('video'));
    state.viewerRenderToken++;
    box.querySelectorAll('video').forEach(video => { try { video.pause(); } catch { /* Detached player. */ } });
    box.querySelectorAll('iframe').forEach(frame => frame.setAttribute('src', 'about:blank'));
    if (document.fullscreenElement === box) document.exitFullscreen?.().catch?.(() => {});
    box.classList.remove('open', 'viewer-zoomed', 'details-hidden', 'viewer-idle');
    box.innerHTML = '';
    state.viewerItems = [];
    resetViewerTransform(false);
    const returnFocus = state.viewerReturnFocus;
    state.viewerReturnFocus = null;
    returnFocus?.focus?.({ preventScroll: true });
    // The card behind the viewer is still mounted holding its own stale
    // position. Line it up with what was actually watched.
    if (watched?.selectionKey) {
      document.querySelectorAll(`#${APP_ID} .scg-card[data-key] video`).forEach(video => {
        if (video.closest('.scg-card')?.dataset.key === watched.selectionKey) resumePlaybackPosition(video, watched);
      });
    }
    // Resolution is learned in the viewer. If it participates in the current
    // view, close is the first safe point to re-filter/re-sort the grid.
    if ((state.resolutionFilter && state.resolutionFilter !== 'all') || state.sort.startsWith('resolution-')) render();
  }

  async function renderLightbox() {
    const items = viewerMediaItems();
    if (!items.length) return closeLightbox();
    state.lightboxIndex = (state.lightboxIndex + items.length) % items.length;
    const item = items[state.lightboxIndex];
    const box = document.querySelector(`#${APP_ID} .scg-lightbox`);
    const sourceUrl = item.originalLink || item.url;
    const sourceHost = hostOf(sourceUrl);
    const title = viewerItemTitle(item);
    const typeLabel = item.type === 'image' ? 'Image' : 'Video';
    const savedLabel = wasDownloaded(item) ? 'Verified download saved' : (hasLegacyDownload(item) ? 'Legacy download marker' : 'Not downloaded');
    const resolutionLabel = cachedMediaResolution(item);
    const token = ++state.viewerRenderToken;
    const wasOpen = box.classList.contains('open');
    resetViewerTransform(false);
    box.innerHTML = `
      <div class="scg-viewer-shell">
        <header class="scg-viewer-topbar">
          <div class="scg-viewer-identity"><b>${state.lightboxIndex + 1}<span>/ ${items.length}</span></b><div><div class="scg-viewer-titleline"><strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong><span class="scg-viewer-resolution" data-viewer-resolution>${escapeHtml(resolutionLabel)}</span></div><small>${escapeHtml(item.author || 'Unknown')} · ${escapeHtml(viewerReplyLabel(item))} · Page ${Number(item.pageNumber || 1)} · ${escapeHtml(sourceHost)}</small></div></div>
          <div class="scg-viewer-tools" role="toolbar" aria-label="Viewer tools">
            <div class="scg-viewer-zoom ${item.type === 'image' ? '' : 'unavailable'}" role="group" aria-label="Zoom"><button data-viewer-zoom-out data-tooltip="Zoom out" aria-label="Zoom out">${iconWell('zoomOut')}</button><button data-viewer-fit data-tooltip="Fit image" aria-label="Fit image">${iconWell('fit')}<span data-viewer-zoom-value>100%</span></button><button data-viewer-zoom-in data-tooltip="Zoom in" aria-label="Zoom in">${iconWell('zoomIn')}</button></div>
            <button class="scg-viewer-download" data-download-current data-tooltip="${wasDownloaded(item) ? 'Download again (D)' : 'Download (D)'}" aria-label="${wasDownloaded(item) ? 'Download again' : 'Download media'}">${iconWell('download', 'scg-icon-well-primary')}</button>
            <button data-viewer-info data-tooltip="Toggle details (I)" aria-label="Toggle details" aria-pressed="${state.viewerInfoOpen}">${iconWell('info')}</button>
            <button data-viewer-fullscreen data-tooltip="Fullscreen (F)" aria-label="Toggle fullscreen">${iconWell('fullscreen')}</button>
            <button class="scg-lightbox-close scg-tip-end" data-viewer-close data-tooltip="Close viewer (Esc)" aria-label="Close viewer">${iconWell('close', 'scg-icon-well-danger')}</button>
          </div>
        </header>
        <div class="scg-viewer-body">
          <button class="scg-nav scg-prev" data-viewer-prev aria-label="Previous media">${icon('previous')}</button>
          <section class="scg-lightbox-stage" data-viewer-stage aria-live="polite"><div class="scg-viewer-loading"><i></i><span>Resolving original media…</span></div></section>
          <aside class="scg-viewer-details">
            <div class="scg-viewer-details-head"><span>${icon(item.type === 'image' ? 'image' : 'video')}</span><div><b>${escapeHtml(typeLabel)}</b><small>${escapeHtml(sourceHost)}</small></div></div>
            ${item.caption ? `<p class="scg-viewer-caption">${escapeHtml(item.caption)}</p>` : ''}
            <dl><div><dt>Resolution</dt><dd data-viewer-resolution>${escapeHtml(resolutionLabel)}</dd></div><div><dt>Posted by</dt><dd>${escapeHtml(item.author || 'Unknown')}</dd></div><div><dt>Location</dt><dd>${escapeHtml(viewerReplyLabel(item))}, page ${Number(item.pageNumber || 1)}</dd></div>${item.postedAt ? `<div><dt>Posted</dt><dd>${escapeHtml(new Date(Number(item.postedAt)).toLocaleString())}</dd></div>` : ''}<div><dt>Download</dt><dd>${escapeHtml(savedLabel)}</dd></div><div><dt>Collection</dt><dd>${items.length} filtered media items</dd></div></dl>
            <div class="scg-viewer-details-links"><a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener">${icon('external')}<span>Open source</span></a><a href="${escapeHtml(item.postUrl)}" target="_blank" rel="noopener">${icon('external')}<span>View reply</span></a></div>
            <p class="scg-viewer-shortcuts"><b>Keys</b><br>← → previous / next · wheel or + − zoom · 0 fit<br>I details · F fullscreen · Space play or pause<br>D download · S select · Esc close</p>
          </aside>
          <button class="scg-nav scg-next" data-viewer-next aria-label="Next media">${icon('next')}</button>
        </div>
        <footer class="scg-viewer-footer">
          <div class="scg-viewer-strip" role="group" aria-label="Nearby media">${viewerStripMarkup(items, state.lightboxIndex)}</div>
          <div class="scg-lightbox-actions"><button class="scg-tip-up scg-tip-end" data-select-current data-tooltip="Add or remove this item from the selection">${iconWell('select')}<span>${state.selected.has(item.selectionKey) ? 'Unselect' : 'Select'} (S)</span></button><button class="scg-tip-up scg-tip-end" data-copy-current data-tooltip="Copy the source link">${iconWell('copy')}<span>Copy link</span></button></div>
        </footer>
      </div>`;
    box.classList.add('open');
    box.classList.toggle('details-hidden', !state.viewerInfoOpen);
    box.setAttribute('aria-label', `${typeLabel} ${state.lightboxIndex + 1} of ${items.length}: ${title}`);
    box.querySelector('[data-viewer-close]').onclick = closeLightbox;
    box.querySelector('[data-viewer-prev]').onclick = () => navigateLightbox(-1);
    box.querySelector('[data-viewer-next]').onclick = () => navigateLightbox(1);
    box.querySelectorAll('[data-viewer-index]').forEach(button => { button.onclick = () => goToViewerIndex(Number(button.dataset.viewerIndex)); });
    box.querySelector('[data-download-current]').onclick = () => downloadMedia(item);
    box.querySelector('[data-select-current]').onclick = event => {
      setIconButton(event.currentTarget, 'select', `${toggleSelected(item) ? 'Unselect' : 'Select'} (S)`);
    };
    box.querySelector('[data-copy-current]').onclick = () => copyText(sourceUrl);
    box.querySelector('[data-viewer-info]').onclick = () => toggleViewerInfo();
    box.querySelector('[data-viewer-fullscreen]').onclick = toggleViewerFullscreen;
    box.querySelector('[data-viewer-zoom-in]').onclick = () => setViewerZoom(state.viewerZoom + .25);
    box.querySelector('[data-viewer-zoom-out]').onclick = () => setViewerZoom(state.viewerZoom - .25);
    box.querySelector('[data-viewer-fit]').onclick = () => setViewerZoom(1);
    const viewerTools = box.querySelector('.scg-viewer-tools');
    viewerTools.onpointerdown = event => event.stopPropagation();
    viewerTools.onclick = event => event.stopPropagation();
    box.onpointermove = wakeViewerChrome;
    box.onpointerdown = wakeViewerChrome;
    box.onfocusin = wakeViewerChrome;
    box.onpointerleave = () => armViewerChromeIdle(box, 700);
    wakeViewerChrome();
    box.querySelector('.scg-viewer-thumb.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
    if (!wasOpen) box.focus({ preventScroll: true });

    const stage = box.querySelector('[data-viewer-stage]');
    const stillCurrent = () => box.classList.contains('open') && token === state.viewerRenderToken && currentViewerItem() === item;
    if (item.type === 'image') {
      const display = await resolveForDisplay(item);
      if (!stillCurrent()) return;
      const imageUrl = display.url || item.thumb;
      stage.innerHTML = `<img class="scg-viewer-image" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(item.caption || title)}">`;
      const image = stage.querySelector('img');
      bindViewerImageInteractions(image, stage);
      let resolutionQualifier = display.status === 'confirmed' ? '' : 'Preview';
      const captureImageResolution = () => {
        if (!stillCurrent()) return;
        if (!updateViewerResolution(box, item, image.naturalWidth, image.naturalHeight, resolutionQualifier, image.currentSrc || image.src)) {
          setViewerResolutionStatus(box, 'Unavailable');
        }
      };
      image.onload = captureImageResolution;
      image.onerror = () => {
        const fallback = absoluteUrl(item.thumb);
        if (fallback && image.src !== fallback) {
          resolutionQualifier = 'Preview';
          image.src = fallback;
          notify('The host blocked the original image; showing its thumbnail.');
        } else {
          setViewerResolutionStatus(box, 'Unavailable');
          stage.innerHTML = '<div class="scg-viewer-error">This image could not be displayed. Use Open source to view it on the host.</div>';
        }
      };
      if (image.complete && image.naturalWidth) requestAnimationFrame(captureImageResolution);
      updateViewerTransform();
      const next = items[(state.lightboxIndex + 1) % items.length];
      if (next?.type === 'image') resolveForDisplay(next).catch(() => {});
    } else if (item.type === 'video' && VIDEO_EXT.test(item.url)) {
      if (!stillCurrent()) return;
      stage.innerHTML = `<video controls autoplay playsinline preload="metadata" poster="${escapeHtml(item.poster || '')}" src="${escapeHtml(item.url)}"></video>`;
      const video = stage.querySelector('video');
      bindViewerVideoLifecycle(video, stage);
      resumePlaybackPosition(video, item);
      bindViewerVideoResolution(video, box, item, stillCurrent);
    } else if (item.wasFrame || embedUrl(item.url) !== unwrapSimpcityRedirect(item.url)) {
      if (!stillCurrent()) return;
      // Handing the card's position over needs something seekable at both ends,
      // which a host iframe never is. The resolved file is preferred for exactly
      // that reason; the embed below still covers everything it cannot play.
      const mountHostPlayer = () => {
        if (!stillCurrent()) return;
        stage.innerHTML = iframeHtml(item) || '<div class="scg-viewer-error">This host does not expose an embeddable player. Use Open source to watch it on the host.</div>';
        if (!stage.querySelector('iframe')) {
          setViewerResolutionStatus(box, 'Unavailable');
          return;
        }
        setViewerResolutionStatus(box, 'Detecting…');
        resolveForDisplay(item).then(async resolved => {
          if (!stillCurrent()) return;
          const dimensions = resolved?.url ? await probeVideoDimensions(resolved.url) : null;
          if (!stillCurrent()) return;
          if (dimensions) updateViewerResolution(box, item, dimensions.width, dimensions.height, '', resolved.url);
          else setViewerResolutionStatus(box, 'Host-controlled embed');
        }).catch(() => {
          if (stillCurrent()) setViewerResolutionStatus(box, 'Host-controlled embed');
        });
      };
      let direct = null;
      try { direct = await resolveForDisplay(item); }
      catch { /* The host player below is the fallback for every failure here. */ }
      if (!stillCurrent()) return;
      if (item.embedPlaybackFailed || !direct || direct.status !== 'confirmed' || !direct.url || !VIDEO_EXT.test(direct.url)) {
        mountHostPlayer();
      } else {
        stage.innerHTML = `<video controls autoplay playsinline preload="metadata" poster="${escapeHtml(item.poster || '')}" src="${escapeHtml(direct.url)}"></video>`;
        const video = stage.querySelector('video');
        bindViewerVideoLifecycle(video, stage, () => {
          item.embedPlaybackFailed = true;
          mountHostPlayer();
        });
        resumePlaybackPosition(video, item);
        bindViewerVideoResolution(video, box, item, stillCurrent);
      }
    } else {
      const direct = await resolveForDisplay(item);
      if (!stillCurrent()) return;
      stage.innerHTML = direct.url
        ? `<video controls autoplay playsinline preload="metadata" poster="${escapeHtml(item.poster || '')}" src="${escapeHtml(direct.url)}"></video>`
        : '<div class="scg-viewer-error">This host does not expose an embeddable player. Use Open source to watch it on the host.</div>';
      const video = stage.querySelector('video');
      bindViewerVideoLifecycle(video, stage);
      resumePlaybackPosition(video, item);
      bindViewerVideoResolution(video, box, item, stillCurrent);
    }
  }

  function openLightbox(item) {
    const filteredMedia = visibleItems().filter(isMediaItem);
    const items = filteredMedia.includes(item) ? filteredMedia : mediaItems();
    const index = items.indexOf(item);
    if (index < 0) return;
    suspendGridPlayback();
    state.viewerItems = items;
    state.viewerReturnFocus = document.activeElement;
    state.lightboxIndex = index;
    state.viewerInfoOpen = false;
    renderLightbox();
  }

  function goToViewerIndex(index) {
    const items = viewerMediaItems();
    if (!items.length) return;
    state.lightboxIndex = Math.min(Math.max(0, Number(index) || 0), items.length - 1);
    resetViewerTransform(false);
    renderLightbox();
  }

  function navigateLightbox(direction) {
    state.lightboxIndex += Number(direction) || 0;
    resetViewerTransform(false);
    renderLightbox();
  }

  function resetDatasetState() {
    invalidateVisibleItems({ dataset: true, selection: true });
    state.selected.clear();
    state.collapsedReplies.clear();
    state.expandedKeys.clear();
    state.activePlayers.clear();
    state.playbackPositions.clear();
    state.selectionAnchor = null;
    state.selectedOnly = false;
    state.authorFilter = 'all';
    state.hostFilter = 'all';
    state.viewPage = 1;
    state.viewPages = 1;
    state.renderedItems = [];
    if (!state.downloading) {
      state.downloadProgress = blankDownloadProgress();
      state.downloadJobs = [];
      state.downloadDetailsOpen = false;
    }
  }

  function updateScanStatus() {
    const app = document.getElementById(APP_ID);
    if (!app) return;
    const status = state.scanCanceling
      ? `Canceling scan after ${state.scannedPages} completed page${state.scannedPages === 1 ? '' : 's'}`
      : `Page ${state.scanCurrentPage} - ${state.scannedPages} of ${state.scanTotalPages} completed`;
    app.querySelector('.scg-status').textContent = status;
    const detail = app.querySelector('[data-activity-detail]');
    refreshThreadHeader();
    if (detail) detail.textContent = `${state.items.length} items found - ${state.scanFailedPages} failed page${state.scanFailedPages === 1 ? '' : 's'} - media stays unloaded`;
    setIconButton(app.querySelector('[data-action="thread"]'), 'close', state.scanCanceling ? 'Canceling scan' : 'Cancel scan');
  }

  async function confirmLargeThreadScan(pageCount) {
    const result = await confirmAction({
      title: 'Scan this large thread?',
      message: `This thread has ${pageCount} detected pages. ${SCAN_WARNING_TEXT}`,
      confirmLabel: 'Continue',
      danger: true,
      preferenceLabel: "Don't warn me again",
    });
    if (result?.confirmed && result.preferenceChecked) {
      state.warnLargeThreadScan = false;
      persistSettings();
      if (document.querySelector(`#${APP_ID} .scg-settings-panel.open`)) refreshSettingsPanel();
    }
    return Boolean(result?.confirmed);
  }

  async function scanThread(requested = {}) {
    if (state.downloading) return notify('Finish or cancel the ZIP queue before scanning another page.');
    if (state.scanning) {
      state.cancelScan = true;
      state.scanCanceling = true;
      state.scanController?.abort();
      updateScanStatus();
      return;
    }
    const options = requested && typeof requested === 'object' && !('currentTarget' in requested) ? requested : {};
    updateThreadPageInfo(document, location.href);
    const detectedPages = Math.max(1, state.threadPageCount);
    const startPage = Math.min(detectedPages, Math.max(1, Number(options.start) || 1));
    const requestedEnd = Math.min(detectedPages, Math.max(startPage, Number(options.end) || detectedPages));
    const endPage = Math.min(requestedEnd, startPage + 249);
    const pagesToScan = endPage - startPage + 1;
    if (state.warnLargeThreadScan && pagesToScan >= LARGE_THREAD_WARNING_PAGES) {
      if (!await confirmLargeThreadScan(pagesToScan)) return;
    }
    const previousItems = options.append ? null : state.items;
    const previousSelected = options.append ? null : new Set(state.selected);
    state.scanning = true;
    state.cancelScan = false;
    state.scanCanceling = false;
    state.scannedPages = 0;
    state.scanCurrentPage = 0;
    state.scanFailedPages = 0;
    state.scanTotalPages = pagesToScan;
    if (!options.append) {
      state.items = [];
      resetDatasetState();
    }
    state.sourceLabel = options.label || (startPage === 1 && endPage === detectedPages
      ? 'Entire thread'
      : `Thread pages ${startPage}-${endPage}`);
    render();

    const seenItems = new Set(state.items.map(itemDedupeKey));
    const controller = new AbortController();
    state.scanController = controller;
    try {
      for (let page = startPage; page <= endPage && !state.cancelScan; page++) {
        state.scanCurrentPage = page;
        updateScanStatus();
        const pageUrl = threadPageUrl(page);
        let doc;
        try {
          if (new URL(pageUrl).pathname === location.pathname) {
            doc = document;
          } else {
            const response = await fetch(pageUrl, { credentials: 'include', signal: controller.signal });
            if (!response.ok) throw new Error(`Page request failed (${response.status})`);
            const html = await response.text();
            if (state.cancelScan || controller.signal.aborted) break;
            doc = new DOMParser().parseFromString(html, 'text/html');
          }
          if (state.cancelScan || controller.signal.aborted) break;
          updateThreadPageInfo(doc, pageUrl);
          appendUniqueItems(state.items, extractFromDocument(doc, pageUrl), seenItems);
          invalidateVisibleItems({ dataset: true });
          state.scannedPages++;
          rememberScannedPage(page, pageUrl);
        } catch (error) {
          if (error?.name === 'AbortError' || state.cancelScan) break;
          state.scanFailedPages++;
          recordDiagnostic('scanFailures', `Whole-thread page ${page}`, error);
        } finally {
          doc = null;
        }
        updateScanStatus();
        if (page < endPage && !state.cancelScan) await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (requestedEnd > endPage && !state.cancelScan) {
        state.sourceLabel = `Partial thread scan (${startPage}-${endPage}, 250-page safety limit)`;
        notify('Stopped at the 250-page safety limit. Use the page picker for later pages.', 6500);
      } else if (state.scanFailedPages) {
        state.sourceLabel = `Thread scan (${state.scanFailedPages} failed page${state.scanFailedPages === 1 ? '' : 's'})`;
      }
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.error('[SimpCity Gallery]', error);
        recordDiagnostic('scanFailures', 'Whole-thread scan', error);
        notify(`Gallery scan stopped: ${error.message}`, 6500);
      }
    } finally {
      if (state.cancelScan && state.scannedPages) state.sourceLabel = `Partial thread scan (${state.scannedPages} pages)`;
      else if (state.cancelScan) state.sourceLabel = 'Thread scan canceled';
      if (!options.append && !state.scannedPages && !state.items.length && previousItems?.length) {
        state.items = previousItems;
        state.selected = previousSelected;
        state.sourceLabel = 'Cached index retained after failed scan';
        invalidateVisibleItems({ dataset: true, selection: true });
      }
      state.scanController = null;
      state.scanning = false;
      state.scanCanceling = false;
      state.cancelScan = false;
      if (state.items.length) persistItemIndex();
      render();
      if (pagesToScan > 1) sendCompletionNotification('Gallery scan finished', `${state.sourceLabel}: ${state.items.length} items indexed.`);
    }
  }

  async function scanNewPages() {
    updateThreadPageInfo(document, location.href);
    const last = highestScannedPage();
    const detected = Math.max(1, state.threadPageCount);
    if (last >= detected) return notify(`No pages newer than page ${last || 1} were detected.`, 4500);
    const start = Math.max(1, last + 1);
    return scanThread({ start, end: detected, append: true, label: `New pages ${start}-${detected}` });
  }

  async function scanPageRange(start, end) {
    const from = Math.max(1, Number(start) || 1);
    const to = Math.max(1, Number(end) || from);
    const first = Math.min(from, to);
    const last = Math.max(from, to);
    return scanThread({ start: first, end: last, append: false, label: `Thread pages ${first}-${last}` });
  }

  function scanCurrentPage() {
    if (state.downloading) return notify('Finish or cancel the ZIP queue before scanning another page.');
    updateThreadPageInfo(document, location.href);
    resetDatasetState();
    state.items = dedupe(extractFromDocument(document, location.href));
    state.sourcePage = pageNumberFromUrl(location.href);
    state.sourceLabel = `Thread page ${state.sourcePage}`;
    state.scannedPages = 1;
    rememberScannedPage(state.sourcePage, location.href);
    persistItemIndex();
    render();
  }

  async function scanSpecificPage(page) {
    if (state.downloading) return notify('Finish or cancel the ZIP queue before scanning another page.');
    if (state.scanning) return;
    const targetPage = Math.min(Math.max(1, Number(page) || 1), state.threadPageCount);
    const previousItems = state.items;
    const previousSelected = new Set(state.selected);
    state.scanning = true;
    state.cancelScan = false;
    state.items = [];
    resetDatasetState();
    state.sourcePage = targetPage;
    state.sourceLabel = `Thread page ${targetPage}`;
    render();
    try {
      let doc;
      const targetUrl = threadPageUrl(targetPage);
      if (new URL(targetUrl).pathname === location.pathname) doc = document;
      else {
        const response = await fetch(targetUrl, { credentials: 'include' });
        if (!response.ok) throw new Error(`Page request failed (${response.status})`);
        doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      }
      updateThreadPageInfo(doc, targetUrl);
      state.items = dedupe(extractFromDocument(doc, targetUrl));
      // The loading render cached the empty dataset; refresh totals and facets.
      invalidateVisibleItems({ dataset: true });
      state.scannedPages = 1;
      rememberScannedPage(targetPage, targetUrl);
    } catch (error) {
      console.error('[SimpCity Gallery]', error);
      recordDiagnostic('scanFailures', `Page ${targetPage} scan`, error);
      notify(`Could not load page ${targetPage}: ${error.message}`, 5500);
      if (!state.items.length && previousItems.length) {
        state.items = previousItems;
        state.selected = previousSelected;
        state.sourceLabel = 'Cached index retained after failed page load';
        invalidateVisibleItems({ dataset: true, selection: true });
      }
    } finally {
      state.scanning = false;
      if (state.items.length) persistItemIndex();
      render();
    }
  }

  const style = document.createElement('style');
  style.textContent = `

    /* ============================================================
       GALLERY UI  -  design system for SimpCity Thread Gallery Timeline
       Direction: full-bleed media canvas, floating instrument plate,
       mode-morphing dock. One restrained signal colour per theme.
       ============================================================ */

    /* ---- 1. Design tokens ------------------------------------- */
    #${APP_ID},
    #scg-tl-launch,
    #scg-tl-toast{
      --scg-bg:#08090b;
      --scg-canvas:#0a0b0e;
      --scg-surface:#101216;
      --scg-surface-2:#15181d;
      --scg-surface-3:#1c2027;
      --scg-well:#050506;
      --scg-line:#252a32;
      --scg-line-strong:#333a45;
      --scg-text:#eef1f5;
      --scg-text-soft:#c6ccd4;
      --scg-muted:#98a1ad;
      --scg-accent-base:#4fb3ff;
      --scg-accent-ink:#04121e;
      --scg-accent:var(--scg-accent-base);
      --scg-accent-soft:color-mix(in srgb,var(--scg-accent-base) 15%,var(--scg-surface-3));
      --scg-accent-line:color-mix(in srgb,var(--scg-accent-base) 42%,var(--scg-surface));
      --scg-success:#4ad4a0;
      --scg-success-soft:#0d2a22;
      --scg-warn:#e0b062;
      --scg-warn-soft:#2a2114;
      --scg-danger:#f06b78;
      --scg-danger-soft:#321316;
      --scg-shadow:0 18px 48px #00000094;
      --scg-shadow-sm:0 6px 18px #0000006b;
      --scg-focus:color-mix(in srgb,var(--scg-accent-base) 62%,var(--scg-text));
      --scg-hi:#ffffff;
      --scg-lo:#000000;
      --scg-tint:9%;
      --scg-select-arrow:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238e97a3' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9.5 6 6 6-6'/%3E%3C/svg%3E");
      --scg-r-xs:5px;
      --scg-r-sm:8px;
      --scg-r-md:11px;
      --scg-r-lg:16px;
      --scg-r-xl:22px;
      --scg-r-pill:99px;
      --scg-fs-2xs:10px;
      --scg-fs-xs:11px;
      --scg-fs-sm:12px;
      --scg-fs-md:13px;
      --scg-fs-base:14px;
      --scg-fs-lg:16px;
      --scg-fs-xl:18px;
      --scg-fs-2xl:20px;
      --scg-lh-tight:1.2;
      --scg-lh-normal:1.45;
      --scg-lh-relaxed:1.6;
      --scg-s-1:4px;
      --scg-s-2:8px;
      --scg-s-3:12px;
      --scg-s-4:16px;
      --scg-s-5:20px;
      --scg-s-6:24px;
      --scg-s-8:32px;
      --scg-s-12:48px;
      --scg-dur-fast:120ms;
      --scg-dur-base:180ms;
      --scg-dur-slow:280ms;
      --scg-ease:cubic-bezier(.2,.7,.3,1);
      --scg-ease-exit:cubic-bezier(.4,0,1,1);
      color-scheme:dark;
    }

    #${APP_ID}[data-theme="light"],
    #scg-tl-launch[data-theme="light"],
    #scg-tl-toast[data-theme="light"]{
      --scg-bg:#e9ecf0;
      --scg-canvas:#eef1f5;
      --scg-surface:#ffffff;
      --scg-surface-2:#f5f7fa;
      --scg-surface-3:#e6eaf0;
      --scg-well:#dde2e9;
      --scg-line:#d0d6de;
      --scg-line-strong:#b0b9c5;
      --scg-text:#0f1319;
      --scg-text-soft:#333c48;
      --scg-muted:#4f5a68;
      --scg-accent-base:#0a5fc4;
      --scg-accent-ink:#ffffff;
      --scg-success:#0d6b4b;
      --scg-success-soft:#dff2e9;
      --scg-warn:#8a5a08;
      --scg-warn-soft:#fbeed5;
      --scg-danger:#af1f3d;
      --scg-danger-soft:#fce1e7;
      --scg-shadow:0 16px 40px #2c3c5226;
      --scg-shadow-sm:0 5px 14px #2c3c5220;
      --scg-hi:#ffffff;
      --scg-lo:#2c3c52;
      --scg-tint:7%;
      --scg-select-arrow:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%234f5a68' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9.5 6 6 6-6'/%3E%3C/svg%3E");
      color-scheme:light;
    }

    /* Accent presets. Only the base hue and its ink are stated; everything
       else derives from them, so a new accent is two lines. */
    #${APP_ID}[data-accent="indigo"],#scg-tl-launch[data-accent="indigo"],#scg-tl-toast[data-accent="indigo"]{--scg-accent-base:#8f9dff;--scg-accent-ink:#080b1c}
    #${APP_ID}[data-accent="amber"],#scg-tl-launch[data-accent="amber"],#scg-tl-toast[data-accent="amber"]{--scg-accent-base:#d8b158;--scg-accent-ink:#1a1405}
    #${APP_ID}[data-accent="green"],#scg-tl-launch[data-accent="green"],#scg-tl-toast[data-accent="green"]{--scg-accent-base:#4ad4a0;--scg-accent-ink:#04140e}
    #${APP_ID}[data-accent="rose"],#scg-tl-launch[data-accent="rose"],#scg-tl-toast[data-accent="rose"]{--scg-accent-base:#ff86a6;--scg-accent-ink:#2e0f18}
    #${APP_ID}[data-accent="neutral"],#scg-tl-launch[data-accent="neutral"],#scg-tl-toast[data-accent="neutral"]{--scg-accent-base:#9aa6b4;--scg-accent-ink:#0f1319}

    #${APP_ID}[data-theme="light"][data-accent="blue"],#scg-tl-launch[data-theme="light"][data-accent="blue"]{--scg-accent-base:#0a5fc4;--scg-accent-ink:#ffffff}
    #${APP_ID}[data-theme="light"][data-accent="indigo"],#scg-tl-launch[data-theme="light"][data-accent="indigo"]{--scg-accent-base:#4048b8;--scg-accent-ink:#ffffff}
    #${APP_ID}[data-theme="light"][data-accent="amber"],#scg-tl-launch[data-theme="light"][data-accent="amber"]{--scg-accent-base:#8a5a08;--scg-accent-ink:#ffffff}
    #${APP_ID}[data-theme="light"][data-accent="green"],#scg-tl-launch[data-theme="light"][data-accent="green"]{--scg-accent-base:#0d6b4b;--scg-accent-ink:#ffffff}
    #${APP_ID}[data-theme="light"][data-accent="rose"],#scg-tl-launch[data-theme="light"][data-accent="rose"]{--scg-accent-base:#af1f3d;--scg-accent-ink:#ffffff}
    #${APP_ID}[data-theme="light"][data-accent="neutral"],#scg-tl-launch[data-theme="light"][data-accent="neutral"]{--scg-accent-base:#4f5a68;--scg-accent-ink:#ffffff}

    /* ---- 2. Primitives ---------------------------------------- */
    #${APP_ID},#${APP_ID} *,#${APP_ID} *:before,#${APP_ID} *:after,
    #scg-tl-launch,#scg-tl-launch *,#scg-tl-toast,#scg-tl-toast *{
      box-sizing:border-box;
      font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
      letter-spacing:normal;
      text-transform:none;
    }
    #${APP_ID} button,#${APP_ID} input,#${APP_ID} select,#${APP_ID} textarea{font:inherit;margin:0}
    #${APP_ID} b,#${APP_ID} strong{font-weight:650}

    #${APP_ID} .scg-icon{
      display:block;width:17px;height:17px;flex:none;
      fill:none;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;
    }
    #${APP_ID} .scg-icon-well{
      display:inline-grid;place-items:center;width:17px;height:17px;flex:none;
      color:inherit;font-style:normal;
    }
    #${APP_ID} .scg-icon-well-primary{color:currentColor}
    #${APP_ID} .scg-icon-well-danger{color:var(--scg-danger)}
    #${APP_ID} .scg-close .scg-icon,#${APP_ID} .scg-settings-close .scg-icon{width:18px;height:18px}

    /* Focus: a two-layer ring so it survives on both light and dark. */
    #${APP_ID} :focus-visible,
    #scg-tl-launch:focus-visible{
      outline:2px solid var(--scg-focus);
      outline-offset:2px;
      border-radius:var(--scg-r-sm);
    }
    #${APP_ID} button:focus-visible,#${APP_ID} a:focus-visible,
    #${APP_ID} select:focus-visible,#${APP_ID} input:focus-visible{
      box-shadow:0 0 0 5px color-mix(in srgb,var(--scg-focus) 26%,transparent);
    }
    #${APP_ID} button:disabled,#${APP_ID} select:disabled,#${APP_ID} input:disabled{
      opacity:.4;cursor:not-allowed;box-shadow:none;
    }
    #${APP_ID} button:disabled:hover{background:inherit}

    /* Native dropdowns, restyled but still native. */
    #${APP_ID} select{
      appearance:none;-webkit-appearance:none;
      min-height:34px;padding:6px 30px 6px 10px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-md);
      background-color:var(--scg-surface-2);color:var(--scg-text);
      background-image:var(--scg-select-arrow);
      background-repeat:no-repeat;background-position:right 9px center;background-size:14px;
      font-size:var(--scg-fs-sm);cursor:pointer;
    }
    #${APP_ID} select:hover:not(:disabled){border-color:var(--scg-line-strong);background-color:var(--scg-surface-3)}
    #${APP_ID} select option{background:var(--scg-surface);color:var(--scg-text)}
    #${APP_ID} select option:checked{background:var(--scg-accent);color:var(--scg-accent-ink)}
    #${APP_ID} input[type="search"]{appearance:none;-webkit-appearance:none}
    #${APP_ID} input[type="search"]::-webkit-search-cancel-button{filter:grayscale(1) opacity(.6)}
    #${APP_ID} input[type="checkbox"]{accent-color:var(--scg-accent);width:15px;height:15px;cursor:pointer}

    /* Tooltips: hover AND keyboard focus, never on coarse pointers. */
    #${APP_ID} [data-tooltip]{position:relative}
    #${APP_ID} [data-tooltip]:hover:after,
    #${APP_ID} [data-tooltip]:focus-visible:after{
      content:attr(data-tooltip);
      position:absolute;z-index:400;top:calc(100% + 8px);left:50%;
      width:max-content;max-width:230px;transform:translateX(-50%);
      padding:6px 9px;border:1px solid var(--scg-line-strong);border-radius:var(--scg-r-sm);
      background:var(--scg-surface-3);color:var(--scg-text);
      box-shadow:var(--scg-shadow-sm);
      font-size:var(--scg-fs-xs);font-weight:550;line-height:1.3;white-space:normal;overflow-wrap:anywhere;pointer-events:none;
    }
    #${APP_ID} .scg-tip-end[data-tooltip]:hover:after,
    #${APP_ID} .scg-tip-end[data-tooltip]:focus-visible:after{left:auto;right:0;transform:none}
    #${APP_ID} .scg-tip-up[data-tooltip]:hover:after,
    #${APP_ID} .scg-tip-up[data-tooltip]:focus-visible:after{top:auto;bottom:calc(100% + 8px)}
    #${APP_ID} .scg-lightbox [data-tooltip]:after{max-width:170px}

    /* Scrollbars */
    #${APP_ID} *{scrollbar-width:thin;scrollbar-color:var(--scg-line-strong) transparent}
    #${APP_ID} ::-webkit-scrollbar{width:11px;height:11px}
    #${APP_ID} ::-webkit-scrollbar-thumb{
      border:3px solid transparent;border-radius:99px;
      background:var(--scg-line-strong);background-clip:content-box;
    }
    #${APP_ID} ::-webkit-scrollbar-track{background:transparent}

    /* ---- 3. Launcher ------------------------------------------ */
    #scg-tl-launch{
      position:fixed;z-index:2147483645;left:20px;bottom:20px;
      display:inline-flex;align-items:center;gap:12px;
      min-height:66px;padding:0 22px 0 12px;
      border:1px solid var(--scg-line-strong);border-radius:var(--scg-r-xl);
      background:var(--scg-surface);color:var(--scg-text);
      box-shadow:var(--scg-shadow);
      cursor:pointer;
      transition:transform .18s cubic-bezier(.2,.7,.3,1),border-color .18s,box-shadow .18s,background .18s;
    }
    #scg-tl-launch:before{
      content:'';position:absolute;inset:-1px;border-radius:inherit;pointer-events:none;
      background:linear-gradient(150deg,color-mix(in srgb,var(--scg-accent) 26%,transparent),transparent 46%);
      opacity:.5;
    }
    #scg-tl-launch:hover{
      transform:translateY(-2px);
      border-color:color-mix(in srgb,var(--scg-accent) 55%,var(--scg-line-strong));
      box-shadow:var(--scg-shadow),0 0 0 5px color-mix(in srgb,var(--scg-accent) 14%,transparent);
    }
    #scg-tl-launch:active{transform:translateY(0)}
    #scg-tl-launch .scg-launch-icon{
      position:relative;z-index:1;
      display:inline-grid;place-items:center;width:44px;height:44px;flex:none;
      border:1px solid color-mix(in srgb,var(--scg-accent) 45%,transparent);
      border-radius:13px;
      background:color-mix(in srgb,var(--scg-accent) 16%,var(--scg-surface-3));
      color:var(--scg-accent);font-style:normal;
    }
    #scg-tl-launch .scg-launch-icon .scg-icon{width:23px;height:23px;fill:none;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round}
    #scg-tl-launch .scg-launch-copy{position:relative;z-index:1;display:flex;flex-direction:column;gap:3px;text-align:left;min-width:0}
    #scg-tl-launch .scg-launch-copy strong{font-size:var(--scg-fs-base);font-weight:650;line-height:1.1;letter-spacing:-.005em}
    #scg-tl-launch .scg-launch-copy small{
      color:var(--scg-muted);font-size:var(--scg-fs-xs);line-height:1.1;
      font-variant-numeric:tabular-nums;
    }

    /* ---- 4. Toast --------------------------------------------- */
    #scg-tl-toast{
      position:fixed;z-index:2147483647;left:50%;bottom:26px;
      max-width:min(640px,calc(100vw - 32px));
      padding:12px 18px;
      border:1px solid var(--scg-line-strong);border-radius:var(--scg-r-lg);
      background:var(--scg-surface);color:var(--scg-text);
      box-shadow:var(--scg-shadow);
      font-size:var(--scg-fs-md);line-height:1.45;text-align:center;
      opacity:0;visibility:hidden;
      transform:translate(-50%,14px);
      transition:opacity .2s,transform .2s,visibility .2s;
    }
    #scg-tl-toast.show{opacity:1;visibility:visible;transform:translate(-50%,0)}

    /* ---- 5. Application shell --------------------------------- */
    #${APP_ID}{
      position:fixed;inset:0;z-index:2147483646;
      display:none;overflow:hidden;
      background:
        radial-gradient(150% 120% at 0% 0%,
          color-mix(in srgb,var(--scg-accent-base) var(--scg-tint,9%),transparent),
          transparent 58%),
        var(--scg-bg);
      color:var(--scg-text);
      font:400 13px/1.45 ui-sans-serif,system-ui,sans-serif;
    }
    #${APP_ID}.open{display:grid;grid-template-rows:auto minmax(0,1fr)}

    /* ---- Glass: one recipe, tuned per surface ------------------ */
    #${APP_ID} .scg-glass{
      position:relative;
      border:1px solid color-mix(in srgb,var(--scg-hi) var(--scg-glass-edge,16%),var(--scg-line));
      background:linear-gradient(135deg,
        color-mix(in srgb,var(--scg-surface) var(--scg-glass-top,60%),transparent),
        color-mix(in srgb,var(--scg-surface-2) var(--scg-glass-bottom,42%),transparent));
      box-shadow:var(--scg-glass-cast,0 14px 38px color-mix(in srgb,var(--scg-lo) 32%,transparent)),
        inset 0 1px 0 color-mix(in srgb,var(--scg-hi) var(--scg-glass-sheen,13%),transparent),
        inset 0 -1px 0 color-mix(in srgb,var(--scg-lo) var(--scg-glass-base,14%),transparent);
      backdrop-filter:blur(var(--scg-glass-blur,26px)) saturate(var(--scg-glass-sat,160%));
      -webkit-backdrop-filter:blur(var(--scg-glass-blur,26px)) saturate(var(--scg-glass-sat,160%));
      isolation:isolate;
    }
    #${APP_ID} .scg-glass:before{
      content:'';position:absolute;z-index:0;inset:1px;border-radius:inherit;pointer-events:none;
      background:linear-gradient(112deg,color-mix(in srgb,var(--scg-hi) 9%,transparent),transparent 34%,color-mix(in srgb,var(--scg-accent) 5%,transparent));
    }
    #${APP_ID} .scg-glass>*{position:relative;z-index:1}

    /* The instrument plate: one floating unit instead of four glued bars. */
    #${APP_ID} .scg-plate{
      z-index:40;
      margin:12px 12px 0;
      border-radius:var(--scg-r-lg);
    }

    #${APP_ID} .scg-header{
      z-index:2; /* Keep header tooltips above the later-painted filter row. */
      display:grid;
      grid-template-columns:auto minmax(120px,1.1fr) minmax(180px,1.5fr) auto auto;
      align-items:center;gap:14px;
      padding:10px 12px;
    }
    #${APP_ID} .scg-brand{display:flex;align-items:center;gap:10px;min-width:0}
    #${APP_ID} .scg-brand-mark{
      display:grid;place-items:center;width:36px;height:36px;flex:none;
      border:1px solid color-mix(in srgb,var(--scg-accent) 42%,transparent);
      border-radius:12px;
      background:color-mix(in srgb,var(--scg-accent) 15%,var(--scg-surface-3));
      color:var(--scg-accent);
    }
    #${APP_ID} .scg-brand-mark .scg-icon{width:19px;height:19px}
    #${APP_ID} .scg-brand>div:last-child{display:flex;flex-direction:column;gap:3px;min-width:0}
    #${APP_ID} .scg-brand b{font-size:var(--scg-fs-md);font-weight:650;letter-spacing:-.01em;line-height:1}
    #${APP_ID} .scg-brand small{
      color:var(--scg-muted);font-size:var(--scg-fs-xs);line-height:1;
      text-transform:uppercase;letter-spacing:.08em;font-weight:600;
    }

    #${APP_ID} .scg-thread-context{min-width:0;border-left:1px solid var(--scg-line);padding-left:14px}
    #${APP_ID} .scg-thread-context h1{
      margin:0;font-size:var(--scg-fs-base);font-weight:600;line-height:1.25;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    }
    #${APP_ID} .scg-thread-context>div{
      display:flex;align-items:center;gap:8px;margin-top:4px;min-width:0;
      color:var(--scg-muted);font-size:var(--scg-fs-xs);font-variant-numeric:tabular-nums;
    }
    #${APP_ID} .scg-thread-context>div span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #${APP_ID} .scg-thread-context [data-thread-meta]{
      flex:none;padding:2px 7px;border-radius:99px;
      background:var(--scg-accent-soft);color:var(--scg-accent);
      font-weight:600;font-size:var(--scg-fs-xs);
    }


    /* ---- 6. Search + scan ------------------------------------- */
    #${APP_ID} .scg-controls{position:relative;display:flex;align-items:center;gap:10px;min-width:0}
    #${APP_ID} .scg-search{position:relative;display:block;flex:1;min-width:0}
    #${APP_ID} .scg-search>.scg-icon-well{
      position:absolute;z-index:2;top:50%;left:11px;transform:translateY(-50%);
      color:var(--scg-muted);pointer-events:none;
    }
    #${APP_ID} .scg-search input{
      width:100%;height:38px;
      padding:0 12px 0 36px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-md);
      background:var(--scg-surface-2);color:var(--scg-text);
      font-size:var(--scg-fs-md);
    }
    #${APP_ID} .scg-search input::placeholder{color:var(--scg-muted)}
    #${APP_ID} .scg-search input:hover:not(:disabled){border-color:var(--scg-line-strong)}
    #${APP_ID} .scg-search input:focus{border-color:var(--scg-accent);background:var(--scg-surface)}

    #${APP_ID} .scg-scan-actions{
      display:flex;align-items:center;gap:4px;flex:none;
      padding:3px;border:1px solid var(--scg-line);border-radius:13px;
      background:var(--scg-surface-2);
    }
    #${APP_ID} .scg-scan-actions button{
      display:inline-flex;align-items:center;justify-content:center;gap:7px;
      min-height:32px;padding:6px 11px;
      border:1px solid transparent;border-radius:var(--scg-r-sm);
      background:transparent;color:var(--scg-text-soft);
      font-size:var(--scg-fs-sm);font-weight:550;cursor:pointer;white-space:nowrap;
      transition:background .14s,color .14s,border-color .14s;
    }
    #${APP_ID} .scg-scan-actions button:hover:not(:disabled){background:var(--scg-surface-3);color:var(--scg-text)}
    #${APP_ID} .scg-scan-actions button .scg-icon{color:var(--scg-muted)}
    #${APP_ID} .scg-scan-actions button:hover:not(:disabled) .scg-icon{color:var(--scg-text)}
    #${APP_ID} .scg-scan-actions .scg-scan-thread-danger{
      border-color:#c43a50;background:#8f2034;color:#ffffff;
    }
    #${APP_ID} .scg-scan-actions .scg-scan-thread-danger .scg-icon{color:#ffd7de}
    #${APP_ID} .scg-scan-actions .scg-scan-thread-danger:hover:not(:disabled),
    #${APP_ID} .scg-scan-actions .scg-scan-thread-danger:focus-visible{
      border-color:#ff637b;background:#c92f49;color:#ffffff;
    }
    #${APP_ID} .scg-scan-warning{
      position:absolute;width:1px;height:1px;padding:0;margin:-1px;
      overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;
    }
    #${APP_ID} .scg-scan-actions [data-action="thread"]{
      border-color:color-mix(in srgb,var(--scg-accent) 40%,transparent);
      background:var(--scg-accent-soft);color:var(--scg-accent);
    }
    #${APP_ID} .scg-scan-actions [data-action="thread"] .scg-icon{color:var(--scg-accent)}
    #${APP_ID} .scg-scan-actions [data-action="thread"]:hover:not(:disabled){
      background:color-mix(in srgb,var(--scg-accent) 22%,var(--scg-surface-3));color:var(--scg-accent);
    }
    #${APP_ID} .scg-source-page{display:flex;align-items:center;gap:4px;padding:0 2px;border-left:1px solid var(--scg-line);border-right:1px solid var(--scg-line)}
    #${APP_ID} .scg-source-page select{min-height:32px;min-width:96px;border-color:transparent;background-color:transparent}
    #${APP_ID} .scg-source-page select:hover:not(:disabled){background-color:var(--scg-surface-3)}
    #${APP_ID} .scg-source-range{display:flex;align-items:center;gap:3px;padding-left:2px;border-left:1px solid var(--scg-line)}
    #${APP_ID} .scg-source-range input{width:44px;min-height:30px;padding:3px 5px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--scg-text);text-align:center;font:inherit}
    #${APP_ID} .scg-source-range input:hover:not(:disabled),#${APP_ID} .scg-source-range input:focus{border-color:var(--scg-line-strong);background:var(--scg-surface-3)}
    #${APP_ID} .scg-source-range>span{color:var(--scg-muted)}

    /* ---- 7. Header utilities + overflow menu ------------------- */
    #${APP_ID} .scg-header-actions{display:flex;align-items:center;gap:3px;flex:none}
    #${APP_ID} .scg-header-actions button{
      position:relative;
      display:inline-grid;grid-auto-flow:column;place-items:center;gap:7px;
      min-width:36px;min-height:36px;padding:8px;
      border:1px solid transparent;border-radius:var(--scg-r-md);
      background:transparent;color:var(--scg-muted);
      font-size:var(--scg-fs-sm);cursor:pointer;
      transition:background .14s,color .14s,border-color .14s;
    }
    #${APP_ID} .scg-header-actions button:hover{background:var(--scg-surface-3);color:var(--scg-text)}
    #${APP_ID} .scg-header-actions button.active,
    #${APP_ID} .scg-header-actions button[aria-expanded="true"]{
      border-color:var(--scg-line);background:var(--scg-surface-3);color:var(--scg-text);
    }
    #${APP_ID} .scg-header-actions button>span{display:none}
    #${APP_ID} .scg-header-actions .scg-close{color:var(--scg-text-soft)}
    #${APP_ID} .scg-header-actions .scg-close:hover{
      border-color:color-mix(in srgb,var(--scg-danger) 45%,transparent);
      background:var(--scg-danger-soft);color:var(--scg-danger);
    }
    #${APP_ID} .scg-header-rule{width:1px;height:22px;flex:none;margin:0 4px;background:var(--scg-line)}
    #${APP_ID} [data-action="filters-toggle"] .scg-icon{transition:transform .18s ease}
    #${APP_ID}.filters-collapsed [data-action="filters-toggle"] .scg-icon{transform:rotate(-90deg)}

    #${APP_ID} .scg-menu-wrap{position:relative;display:inline-flex}
    #${APP_ID} .scg-menu{
      position:absolute;z-index:300;top:calc(100% + 8px);right:0;
      display:none;flex-direction:column;gap:2px;
      width:246px;padding:6px;
      border:1px solid var(--scg-line-strong);border-radius:var(--scg-r-lg);
      background:var(--scg-surface);box-shadow:var(--scg-shadow);
    }
    #${APP_ID} .scg-menu.open{display:flex}
    #${APP_ID} .scg-menu-up{top:auto;bottom:calc(100% + 8px);left:0;right:auto}
    #${APP_ID} .scg-menu-label{
      padding:7px 9px 5px;color:var(--scg-muted);
      font-size:var(--scg-fs-2xs);font-weight:700;text-transform:uppercase;letter-spacing:.1em;
    }
    #${APP_ID} .scg-menu button{
      display:grid !important;grid-template-columns:18px minmax(0,1fr);align-items:center;gap:10px;
      width:100%;min-height:38px;padding:8px 9px;
      border:1px solid transparent;border-radius:var(--scg-r-sm);
      background:transparent;color:var(--scg-text);
      font-size:var(--scg-fs-md);text-align:left;cursor:pointer;
    }
    #${APP_ID} .scg-menu button:hover{background:var(--scg-surface-3)}
    #${APP_ID} .scg-menu button>span{display:block !important;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #${APP_ID} .scg-menu button .scg-icon{color:var(--scg-muted)}
    #${APP_ID} .scg-menu button:hover .scg-icon{color:var(--scg-accent)}
    #${APP_ID} .scg-menu-sep{height:1px;margin:5px 4px;background:var(--scg-line)}

    /* ---- 8. Filter + view row --------------------------------- */
    #${APP_ID} .scg-filter-panel{
      display:flex;align-items:center;gap:10px;flex-wrap:wrap;
      padding:0 12px 10px;
    }
    #${APP_ID}.filters-collapsed .scg-filter-panel{display:none}

    /* Active filters stay visible even when the panel that set them is
       collapsed -- a filter you cannot see is a filter you cannot undo. */
    #${APP_ID} .scg-active-facets{
      display:flex;align-items:center;gap:var(--scg-s-1);flex-wrap:wrap;
      padding:0 var(--scg-s-3) var(--scg-s-2);
    }
    #${APP_ID} .scg-active-facets[hidden]{display:none}
    #${APP_ID} .scg-facet-chip,#${APP_ID} .scg-facet-clear{
      display:inline-flex;align-items:center;gap:var(--scg-s-2);max-width:100%;
      min-height:28px;padding:4px 8px;
      border:1px solid var(--scg-accent-line);border-radius:var(--scg-r-pill);
      background:var(--scg-accent-soft);color:var(--scg-accent);
      font-size:var(--scg-fs-xs);cursor:pointer;
    }
    #${APP_ID} .scg-facet-chip b{
      flex:none;font-size:var(--scg-fs-2xs);font-weight:700;
      text-transform:uppercase;letter-spacing:.08em;opacity:.72;
    }
    #${APP_ID} .scg-facet-chip span{
      min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
      color:var(--scg-text);font-weight:600;
    }
    #${APP_ID} .scg-facet-chip .scg-icon{width:13px;height:13px;flex:none;stroke-width:2.4;opacity:.7}
    #${APP_ID} .scg-facet-chip:hover,#${APP_ID} .scg-facet-clear:hover{
      border-color:var(--scg-accent);
      background:color-mix(in srgb,var(--scg-accent) 22%,var(--scg-surface-3));
    }
    #${APP_ID} .scg-facet-chip:hover .scg-icon{opacity:1}
    #${APP_ID} .scg-facet-clear{
      border-color:var(--scg-line);background:var(--scg-surface-2);color:var(--scg-text-soft);
    }
    #${APP_ID} .scg-facet-clear .scg-icon{width:13px;height:13px;color:var(--scg-muted)}

    #${APP_ID} .scg-filters{
      display:flex;align-items:center;gap:2px;flex:none;max-width:100%;overflow-x:auto;
      padding:3px;border:1px solid var(--scg-line);border-radius:13px;
      background:var(--scg-surface-2);
    }
    #${APP_ID} .scg-filters button{
      display:inline-flex;align-items:center;gap:7px;flex:none;
      min-height:32px;padding:6px 11px;
      border:1px solid transparent;border-radius:var(--scg-r-sm);
      background:transparent;color:var(--scg-muted);
      font-size:var(--scg-fs-sm);cursor:pointer;white-space:nowrap;
      transition:background .14s,color .14s;
    }
    #${APP_ID} .scg-filters button .scg-icon{width:15px;height:15px}
    #${APP_ID} .scg-filters button b{font-weight:550;font-size:var(--scg-fs-sm)}
    #${APP_ID} .scg-filters button>span{
      min-width:20px;padding:2px 6px;border-radius:99px;
      background:var(--scg-surface-3);color:var(--scg-muted);
      font-size:var(--scg-fs-xs);font-weight:650;text-align:center;
      font-variant-numeric:tabular-nums;
    }
    #${APP_ID} .scg-filters button:hover:not(:disabled):not(.active){background:var(--scg-surface-3);color:var(--scg-text)}
    #${APP_ID} .scg-filters button.active{
      background:var(--scg-accent);color:var(--scg-accent-ink);
      box-shadow:var(--scg-shadow-sm);
    }
    #${APP_ID} .scg-filters button.active>span{background:color-mix(in srgb,var(--scg-accent-ink) 18%,transparent);color:var(--scg-accent-ink)}
    #${APP_ID} .scg-filters button.active .scg-icon{color:var(--scg-accent-ink)}

    #${APP_ID} .scg-layout-select{flex:none}
    #${APP_ID} .scg-layout-select select{min-width:126px}

    #${APP_ID} .scg-viewbar{display:flex;align-items:center;gap:10px;flex:1;min-width:0;justify-content:flex-end}
    #${APP_ID} .scg-view-summary{
      margin-right:auto;padding-left:2px;
      color:var(--scg-muted);font-size:var(--scg-fs-sm);font-variant-numeric:tabular-nums;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    }
    #${APP_ID} .scg-reply-group-actions{display:none;align-items:center;gap:4px}
    #${APP_ID}.grouped-replies .scg-reply-group-actions{display:inline-flex}
    #${APP_ID} .scg-reply-group-actions button{
      display:inline-flex;align-items:center;gap:6px;min-height:30px;padding:5px 8px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-sm);
      background:var(--scg-surface-2);color:var(--scg-text-soft);font-size:var(--scg-fs-xs);cursor:pointer;
    }
    #${APP_ID} .scg-reply-group-actions button:hover{border-color:var(--scg-line-strong);background:var(--scg-surface-3)}
    #${APP_ID} .scg-reply-group-actions [data-action="expand-all"] .scg-icon{transform:rotate(180deg)}
    #${APP_ID} .scg-viewbar label{
      display:inline-flex;align-items:center;gap:7px;flex:none;
      color:var(--scg-muted);font-size:var(--scg-fs-xs);font-weight:650;
      text-transform:uppercase;letter-spacing:.08em;
    }
    #${APP_ID} .scg-view-pagination{
      display:inline-flex;align-items:center;gap:3px;flex:none;
      padding:3px;border:1px solid var(--scg-line);border-radius:13px;background:var(--scg-surface-2);
    }
    #${APP_ID} .scg-view-pagination[hidden]{display:none}
    #${APP_ID} .scg-view-pagination button{
      display:inline-grid;place-items:center;
      min-width:32px;min-height:32px;padding:6px;
      border:1px solid transparent;border-radius:var(--scg-r-sm);
      background:transparent;color:var(--scg-muted);cursor:pointer;
    }
    #${APP_ID} .scg-view-pagination button:hover:not(:disabled){background:var(--scg-surface-3);color:var(--scg-text)}
    #${APP_ID} .scg-view-pagination button>span{display:none}
    #${APP_ID} .scg-view-pagination select{min-height:32px;min-width:92px;border-color:transparent;background-color:transparent}
    #${APP_ID} .scg-size-control{gap:8px;min-width:178px}
    #${APP_ID} .scg-size-control>span{white-space:nowrap}
    #${APP_ID} [data-card-scale]{
      width:88px;height:20px;padding:0;border:0;background:transparent;accent-color:var(--scg-accent);cursor:pointer;
    }
    #${APP_ID} [data-card-scale]::-webkit-slider-runnable-track{height:4px;border-radius:99px;background:var(--scg-line-strong)}
    #${APP_ID} [data-card-scale]::-webkit-slider-thumb{width:16px;height:16px;margin-top:-6px;border:2px solid var(--scg-surface);border-radius:50%;background:var(--scg-accent);box-shadow:0 1px 5px #0008;-webkit-appearance:none}
    #${APP_ID} [data-card-scale]::-moz-range-track{height:4px;border-radius:99px;background:var(--scg-line-strong)}
    #${APP_ID} [data-card-scale]::-moz-range-thumb{width:14px;height:14px;border:2px solid var(--scg-surface);border-radius:50%;background:var(--scg-accent);box-shadow:0 1px 5px #0008}
    #${APP_ID} [data-card-scale-value]{min-width:38px;color:var(--scg-text-soft);font-size:var(--scg-fs-xs);font-weight:700;text-align:right;font-variant-numeric:tabular-nums}
    #${APP_ID} [data-card-scale]:disabled{opacity:.38;cursor:not-allowed}

    /* Refine: progressive disclosure for the low-frequency facets. */
    #${APP_ID} .scg-refine-wrap{position:relative;display:inline-flex;flex:none}
    #${APP_ID} .scg-refine-trigger{
      display:inline-flex;align-items:center;gap:7px;
      min-height:38px;padding:8px 12px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-md);
      background:var(--scg-surface-2);color:var(--scg-text-soft);
      font-size:var(--scg-fs-sm);font-weight:550;cursor:pointer;white-space:nowrap;
    }
    #${APP_ID} .scg-refine-trigger:hover:not(:disabled){background:var(--scg-surface-3);color:var(--scg-text)}
    #${APP_ID} .scg-refine-trigger .scg-icon{color:var(--scg-muted)}
    #${APP_ID} .scg-refine-trigger[aria-expanded="true"],
    #${APP_ID} .scg-refine-trigger.active{
      border-color:color-mix(in srgb,var(--scg-accent) 45%,transparent);
      background:var(--scg-accent-soft);color:var(--scg-accent);
    }
    #${APP_ID} .scg-refine-trigger[aria-expanded="true"] .scg-icon,
    #${APP_ID} .scg-refine-trigger.active .scg-icon{color:var(--scg-accent)}
    #${APP_ID} .scg-refine-trigger em{
      min-width:18px;padding:1px 6px;border-radius:99px;
      background:var(--scg-accent);color:var(--scg-accent-ink);
      font-style:normal;font-size:var(--scg-fs-2xs);font-weight:700;
    }
    #${APP_ID} .scg-refine-popover{
      position:absolute;z-index:300;top:calc(100% + 8px);right:0;
      display:none;
      width:min(430px,calc(100vw - 32px));
      border:1px solid var(--scg-line-strong);border-radius:var(--scg-r-lg);
      background:var(--scg-surface);box-shadow:var(--scg-shadow);
    }
    #${APP_ID} .scg-refine-popover.open{display:block}
    #${APP_ID} .scg-refine-popover>h2{
      margin:0;padding:12px 14px 0;
      color:var(--scg-muted);font-size:var(--scg-fs-2xs);font-weight:700;
      text-transform:uppercase;letter-spacing:.1em;
    }
    #${APP_ID} .scg-refinebar{
      display:grid;grid-template-columns:1fr 1fr;gap:10px;
      padding:12px 14px 14px;
    }
    #${APP_ID} .scg-refinebar label{
      display:flex;flex-direction:column;gap:6px;min-width:0;
      color:var(--scg-muted);font-size:var(--scg-fs-2xs);font-weight:700;
      text-transform:uppercase;letter-spacing:.08em;
    }
    #${APP_ID} .scg-refinebar select{width:100%;min-height:36px;font-size:var(--scg-fs-md)}
    #${APP_ID} .scg-refinebar button{
      display:inline-flex;align-items:center;justify-content:center;gap:7px;
      min-height:36px;padding:8px 10px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-md);
      background:var(--scg-surface-2);color:var(--scg-text-soft);
      font-size:var(--scg-fs-sm);cursor:pointer;
    }
    #${APP_ID} .scg-refinebar button:hover:not(:disabled){background:var(--scg-surface-3);color:var(--scg-text)}
    #${APP_ID} .scg-refinebar button .scg-icon{color:var(--scg-muted)}
    #${APP_ID} .scg-refinebar button.active{
      border-color:color-mix(in srgb,var(--scg-accent) 45%,transparent);
      background:var(--scg-accent-soft);color:var(--scg-accent);
    }
    #${APP_ID} .scg-refinebar button.active .scg-icon{color:var(--scg-accent)}
    #${APP_ID} .scg-refine-spacer{display:none}

    /* Frost the plate's larger control wells without fading their content. */
    #${APP_ID} .scg-plate .scg-search input,
    #${APP_ID} .scg-plate .scg-scan-actions,
    #${APP_ID} .scg-plate .scg-filters,
    #${APP_ID} .scg-plate .scg-view-pagination,
    #${APP_ID} .scg-plate .scg-refine-trigger:not(.active):not([aria-expanded="true"]){
      background:color-mix(in srgb,var(--scg-surface-2) 50%,transparent);
    }
    #${APP_ID} .scg-plate select{background-color:color-mix(in srgb,var(--scg-surface-2) 46%,transparent)}
    #${APP_ID} .scg-plate select:hover:not(:disabled){background-color:color-mix(in srgb,var(--scg-surface-3) 58%,transparent)}
    #${APP_ID} .scg-plate .scg-search input:focus{background:color-mix(in srgb,var(--scg-surface) 68%,transparent)}


    /* ---- 9. Canvas -------------------------------------------- */
    #${APP_ID} .scg-stage{position:relative;min-width:0;min-height:0}
    #${APP_ID} .scg-scroll{
      position:absolute;inset:12px 12px 0;
      overflow-x:hidden;overflow-y:auto;
      padding:16px 16px 110px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-lg) var(--scg-r-lg) 0 0;
      border-bottom:0;
      background:
        radial-gradient(130% 100% at 0% 0%,
          color-mix(in srgb,var(--scg-accent-base) var(--scg-tint,9%),transparent),
          transparent 55%),
        var(--scg-canvas);
      box-shadow:inset 0 1px 0 color-mix(in srgb,var(--scg-hi) 4%,transparent);
      scroll-behavior:smooth;
    }
    #${APP_ID} .scg-top{
      position:absolute;z-index:26;right:26px;bottom:96px;
      display:none;align-items:center;gap:8px;
      min-height:38px;padding:9px 14px;
      border:1px solid var(--scg-line-strong);border-radius:99px;
      background:var(--scg-surface);color:var(--scg-text);
      box-shadow:var(--scg-shadow);
      font-size:var(--scg-fs-sm);font-weight:550;cursor:pointer;
    }
    #${APP_ID} .scg-top.visible{display:inline-flex}
    #${APP_ID} .scg-top:hover{border-color:color-mix(in srgb,var(--scg-accent) 50%,var(--scg-line-strong))}
    #${APP_ID} .scg-top .scg-icon{color:var(--scg-accent)}

    /* Layout: masonry. The flat grid is placed by the windowed renderer below,
       so these CSS columns are left for the two paths it does not own: the
       skeletons during a scan, and reply groups. They have to say so, because
       [data-layout] out-specifies .flowing and would otherwise re-apply columns
       to absolutely positioned cards. */
    #${APP_ID}[data-layout="masonry"] .scg-grid:not(.grouped):not(.flowing){display:block;columns:5 var(--scg-masonry-width,280px);column-gap:14px}
    #${APP_ID}[data-layout="masonry"].compact .scg-grid:not(.grouped):not(.flowing){columns:7 var(--scg-masonry-compact-width,195px);column-gap:10px}
    #${APP_ID}[data-layout="masonry"] .scg-group-grid{columns:5 var(--scg-group-width,250px);column-gap:12px;padding:0}
    #${APP_ID}[data-layout="masonry"].compact .scg-group-grid{columns:7 var(--scg-group-compact-width,180px);column-gap:9px}
    #${APP_ID}[data-layout="masonry"] .scg-card,
    #${APP_ID}[data-layout="masonry"] .scg-skeleton{break-inside:avoid;margin:0 0 14px}
    #${APP_ID}[data-layout="masonry"].compact .scg-card,
    #${APP_ID}[data-layout="masonry"].compact .scg-skeleton{margin-bottom:10px}

    /* The windowed masonry grid. It becomes a spacer of known height and every
       card is placed absolutely, so only what is near the viewport is ever in
       the DOM. Keyed off the flowing class rather than the layout name, because
       what matters is which renderer owns the grid, not what it is called. */
    #${APP_ID} .scg-grid.flowing{
      position:relative;display:block;columns:auto;
    }
    /* Scoped to the flowing grid, not to the class alone: a card left over
       from a windowed layout must not stay absolutely positioned once another
       layout owns the grid. */
    #${APP_ID} .scg-grid.flowing>.scg-flow-cell{
      position:absolute;margin:0;
      display:flex;flex-direction:column;
      contain:layout paint style;
    }
    /* The media area absorbs the difference between the estimated chrome height
       and the real one, so a slightly wrong estimate shows a little more or less
       image rather than clipping the controls. */
    #${APP_ID} .scg-flow-cell .scg-preview,
    #${APP_ID} .scg-flow-cell>video,
    #${APP_ID} .scg-flow-cell .scg-embed,
    #${APP_ID} .scg-flow-cell .scg-host{
      flex:1;min-height:0;
    }
    #${APP_ID} .scg-flow-cell .scg-preview img,
    #${APP_ID} .scg-flow-cell>video{
      width:100%;height:100%;max-height:none;aspect-ratio:auto;object-fit:cover;
    }
    #${APP_ID} .scg-flow-cell .scg-embed{aspect-ratio:auto}
    #${APP_ID} .scg-flow-cell .scg-textcard p,
    #${APP_ID} .scg-flow-cell>p{min-height:0;flex:1}
    #${APP_ID} .scg-flow-cell .scg-actions,
    #${APP_ID} .scg-flow-cell .scg-meta{flex:none}
    /* Absolute positioning already isolates each card; lifting on hover would
       fight the measured geometry. */
    #${APP_ID} .scg-flow-cell:hover{transform:none}
    /* Compact density at the smallest card size leaves a cell near 140px, and
       its chrome does not shrink with it. These queries measure the card, not
       the window, because the two are no longer proportional. */
    #${APP_ID} .scg-flow-cell{container-type:inline-size}
    #${APP_ID} .scg-flow-cell .scg-actions button>span{
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    }
    @container (max-width:240px){
      #${APP_ID} .scg-flow-cell .scg-actions button>span{display:none}
      #${APP_ID} .scg-flow-cell .scg-meta>span{display:none}
      #${APP_ID} .scg-flow-cell .scg-badge span{display:none}
    }
    @container (max-width:150px){
      #${APP_ID} .scg-flow-cell .scg-meta a>span{display:none}
      #${APP_ID} .scg-flow-cell .scg-badge b{display:none}
    }

    /* Layout: uniform grid */
    #${APP_ID}[data-layout="grid"] .scg-grid:not(.grouped),
    #${APP_ID}[data-layout="grid"] .scg-group-grid{
      display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,var(--scg-grid-min,250px)),1fr));gap:14px;columns:auto;
    }
    #${APP_ID}[data-layout="grid"].compact .scg-grid:not(.grouped),
    #${APP_ID}[data-layout="grid"].compact .scg-group-grid{grid-template-columns:repeat(auto-fill,minmax(min(100%,var(--scg-grid-compact-min,180px)),1fr));gap:10px}
    #${APP_ID}[data-layout="grid"] .scg-group-grid{padding:0}
    #${APP_ID}[data-layout="grid"] .scg-card{display:flex;height:var(--scg-grid-height,386px);min-width:0;flex-direction:column;margin:0;break-inside:auto}
    #${APP_ID}[data-layout="grid"].compact .scg-card{height:var(--scg-grid-compact-height,312px)}
    #${APP_ID}[data-layout="grid"] .scg-preview,
    #${APP_ID}[data-layout="grid"] .scg-card>video,
    #${APP_ID}[data-layout="grid"] .scg-embed,
    #${APP_ID}[data-layout="grid"] .scg-host{min-height:0;flex:1}
    #${APP_ID}[data-layout="grid"] .scg-preview{overflow:hidden}
    #${APP_ID}[data-layout="grid"] .scg-preview img,
    #${APP_ID}[data-layout="grid"] .scg-card>video{width:100%;height:100%;max-height:none;object-fit:cover}
    #${APP_ID}[data-layout="grid"] .scg-card>video{min-height:190px}
    #${APP_ID}[data-layout="grid"] .scg-embed{aspect-ratio:auto;min-height:190px}
    #${APP_ID}[data-layout="grid"] .scg-host{min-height:180px}
    #${APP_ID}[data-layout="grid"] .scg-actions,
    #${APP_ID}[data-layout="grid"] .scg-meta{flex:none}
    #${APP_ID}[data-layout="grid"] .scg-textcard p{min-height:0;flex:1;-webkit-line-clamp:12}
    #${APP_ID}[data-layout="grid"].compact .scg-textcard p{-webkit-line-clamp:9}
    #${APP_ID}[data-layout="grid"] .scg-skeleton{display:flex;flex-direction:column;height:var(--scg-grid-height,386px);margin:0}
    #${APP_ID}[data-layout="grid"].compact .scg-skeleton{height:var(--scg-grid-compact-height,312px)}
    #${APP_ID}[data-layout="grid"] .scg-skeleton-media{height:auto;min-height:0;flex:1}

    /* The uniform grid is the one live path the window renderer does not own:
       it mounts every matched card, and so does reply grouping inside it. Cards
       here already have a fixed height, so the browser can be told to skip
       layout and paint for the ones off screen and be given the exact size to
       reserve. Deliberately not applied under masonry: those cards sit in CSS
       multi-column, which needs to see every box to balance the columns. */
    #${APP_ID}[data-layout="grid"] .scg-grid:not(.flowing) .scg-card{
      content-visibility:auto;
      contain-intrinsic-size:auto var(--scg-grid-height,386px);
    }
    #${APP_ID}[data-layout="grid"].compact .scg-grid:not(.flowing) .scg-card{
      contain-intrinsic-size:auto var(--scg-grid-compact-height,312px);
    }

    #${APP_ID}[data-layout="grid"] .scg-grid.grouped{display:block;columns:auto}

    /* ---- 10. Cards -------------------------------------------- */
    #${APP_ID} .scg-card{
      position:relative;overflow:hidden;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-lg);
      background:var(--scg-surface);
      box-shadow:0 3px 12px #00000052;
      contain:paint style;
      transition:transform .18s cubic-bezier(.2,.7,.3,1),border-color .18s,box-shadow .18s;
    }
    #${APP_ID}.compact .scg-card{border-radius:var(--scg-r-md)}
    #${APP_ID} .scg-card:hover{
      transform:translateY(-2px);
      border-color:var(--scg-line-strong);
      box-shadow:0 7px 20px #00000066;
    }
    #${APP_ID} .scg-card:focus-within{border-color:color-mix(in srgb,var(--scg-accent) 55%,var(--scg-line))}
    #${APP_ID} .scg-card.selected{
      border-color:var(--scg-accent);
      box-shadow:0 0 0 2px color-mix(in srgb,var(--scg-accent) 35%,transparent),var(--scg-shadow);
    }
    #${APP_ID} .scg-card.downloaded{border-color:color-mix(in srgb,var(--scg-success) 42%,var(--scg-line))}
    #${APP_ID} .scg-card.download-legacy{border-color:color-mix(in srgb,var(--scg-warn) 42%,var(--scg-line))}

    #${APP_ID} .scg-preview{
      display:block;width:100%;padding:0;border:0;
      background:var(--scg-well);cursor:zoom-in;
    }
    #${APP_ID} .scg-card img,#${APP_ID} .scg-card video{
      display:block;width:100%;max-height:660px;object-fit:contain;background:var(--scg-well);
    }
    #${APP_ID}.compact .scg-card img,#${APP_ID}.compact .scg-card video{max-height:430px}
    /* A known ratio reserves the box before the image arrives, so loading one
       image no longer re-balances every masonry column. Scoped away from the
       windowed grid, where the cell already has a measured height to fill. */
    #${APP_ID}[data-layout="masonry"] .scg-grid:not(.flowing) .scg-card .scg-preview img{
      aspect-ratio:var(--scg-ratio,0.72);height:auto;max-height:none;object-fit:cover;
    }

    #${APP_ID} .scg-badge{
      position:absolute;z-index:7;top:9px;right:9px;
      display:flex;align-items:center;gap:6px;max-width:calc(100% - 60px);
      padding:4px 8px;
      border:1px solid color-mix(in srgb,#ffffff 14%,transparent);
      border-radius:99px;
      background:#0b0d10f2;color:#dfe4ea;
      font-size:var(--scg-fs-2xs);font-weight:600;
      box-shadow:0 2px 7px #00000052;
    }
    #${APP_ID} .scg-badge b{
      color:#ffffff;font-size:var(--scg-fs-2xs);font-weight:700;
      text-transform:uppercase;letter-spacing:.09em;
    }
    #${APP_ID} .scg-badge span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.82}
    #${APP_ID} .scg-saved-status{
      display:none;padding:2px 6px;border-radius:99px;
      background:var(--scg-success);color:#04140e;
      font-size:var(--scg-fs-2xs);font-style:normal;font-weight:800;letter-spacing:.05em;
    }
    #${APP_ID} .scg-saved-status.visible{display:inline-block}
    #${APP_ID} .scg-saved-status.legacy{background:var(--scg-warn);color:#1c1405}

    /* The checkbox is always in the DOM; it fades in when the pointer is near
       the card, when the card holds focus, and whenever it is already selected.
       Coarse pointers have no hover, so there it simply stays visible. */
    #${APP_ID} .scg-select{
      position:absolute;z-index:8;top:9px;left:9px;display:block;width:30px;height:30px;
      opacity:0;cursor:pointer;transition:opacity var(--scg-dur-fast) var(--scg-ease);
    }
    #${APP_ID} .scg-card:hover .scg-select,
    #${APP_ID} .scg-card:focus-within .scg-select,
    #${APP_ID} .scg-card.selected .scg-select{opacity:1}
    #${APP_ID} .scg-select input{position:absolute;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}
    #${APP_ID} .scg-select span{
      display:grid;place-items:center;width:30px;height:30px;
      border:1.5px solid #ffffffb8;border-radius:10px;
      background:#0b0d10f2;
      box-shadow:0 2px 8px #00000066;
      transition:background .14s,border-color .14s;
    }
    #${APP_ID} .scg-select input:checked+span{background:var(--scg-accent);border-color:var(--scg-accent)}
    #${APP_ID} .scg-select input:checked+span:after{
      content:'';width:11px;height:6px;margin-top:-3px;
      border-left:2.5px solid var(--scg-accent-ink);border-bottom:2.5px solid var(--scg-accent-ink);
      transform:rotate(-45deg);
    }
    #${APP_ID} .scg-select input:focus-visible+span{outline:2px solid var(--scg-focus);outline-offset:2px}

    #${APP_ID} .scg-actions{
      display:flex;gap:6px;padding:8px;
      border-top:1px solid var(--scg-line);background:var(--scg-surface-2);
    }
    #${APP_ID} .scg-actions button{
      display:inline-flex;align-items:center;justify-content:center;gap:7px;flex:1;
      min-height:34px;padding:7px 9px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-sm);
      background:var(--scg-surface);color:var(--scg-text-soft);
      font-size:var(--scg-fs-sm);font-weight:550;cursor:pointer;
      transition:background .14s,border-color .14s,color .14s;
    }
    #${APP_ID} .scg-actions button .scg-icon{color:var(--scg-muted)}
    #${APP_ID} .scg-actions button:hover{background:var(--scg-surface-3);color:var(--scg-text);border-color:var(--scg-line-strong)}
    #${APP_ID} .scg-actions button:hover .scg-icon{color:var(--scg-text)}
    #${APP_ID} .scg-actions .scg-download-action{
      border-color:color-mix(in srgb,var(--scg-accent) 38%,transparent);
      background:var(--scg-accent-soft);color:var(--scg-accent);
    }
    #${APP_ID} .scg-actions .scg-download-action .scg-icon{color:var(--scg-accent)}
    #${APP_ID} .scg-actions .scg-download-action:hover{
      background:color-mix(in srgb,var(--scg-accent) 24%,var(--scg-surface-3));color:var(--scg-accent);
    }
    #${APP_ID} .scg-card.downloaded .scg-download-action{
      border-color:color-mix(in srgb,var(--scg-success) 40%,transparent);
      background:var(--scg-success-soft);color:var(--scg-success);
    }
    #${APP_ID} .scg-card.downloaded .scg-download-action .scg-icon{color:var(--scg-success)}
    #${APP_ID} .scg-card.download-legacy .scg-download-action{
      border-color:color-mix(in srgb,var(--scg-warn) 40%,transparent);
      background:var(--scg-warn-soft);color:var(--scg-warn);
    }
    #${APP_ID} .scg-card.download-legacy .scg-download-action .scg-icon{color:var(--scg-warn)}

    #${APP_ID} .scg-meta{
      display:flex;align-items:center;justify-content:space-between;gap:10px;
      padding:9px 11px;
      color:var(--scg-muted);font-size:var(--scg-fs-sm);
    }
    #${APP_ID} .scg-meta>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #${APP_ID} .scg-meta a{
      display:inline-flex;align-items:center;gap:6px;flex:none;
      padding:3px 4px;border-radius:6px;
      color:var(--scg-accent);text-decoration:none;font-weight:550;
    }
    #${APP_ID} .scg-meta a:hover{background:var(--scg-accent-soft);text-decoration:underline}
    #${APP_ID} .scg-meta a .scg-icon{width:14px;height:14px}

    #${APP_ID} .scg-host{
      display:flex;flex-direction:column;justify-content:center;gap:6px;
      min-height:140px;padding:44px 18px 18px;
      color:var(--scg-text);text-decoration:none;
      background:linear-gradient(150deg,var(--scg-surface-3),var(--scg-surface-2));
    }
    #${APP_ID} .scg-host strong{font-size:var(--scg-fs-base);word-break:break-word}
    #${APP_ID} .scg-host small{color:var(--scg-muted);font-size:var(--scg-fs-xs)}
    #${APP_ID} .scg-host:hover{background:linear-gradient(150deg,var(--scg-accent-soft),var(--scg-surface-2))}

    #${APP_ID} .scg-textcard p{
      display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:8;
      overflow:hidden;margin:0;padding:44px 14px 12px;
      color:var(--scg-text-soft);font-size:var(--scg-fs-md);line-height:1.55;white-space:pre-wrap;
    }
    #${APP_ID} .scg-textcard p.expanded{display:block;-webkit-line-clamp:unset}
    #${APP_ID} .scg-expand{
      display:flex;align-items:center;justify-content:center;gap:7px;
      width:calc(100% - 20px);min-height:32px;margin:0 10px 8px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-sm);
      background:transparent;color:var(--scg-accent);
      font-size:var(--scg-fs-sm);font-weight:600;cursor:pointer;
    }
    #${APP_ID} .scg-expand:hover{background:var(--scg-accent-soft)}
    #${APP_ID} .scg-expand .scg-icon{transition:transform .18s ease}
    #${APP_ID} .scg-expand.expanded .scg-icon{transform:rotate(180deg)}

    #${APP_ID} .scg-embed{position:relative;width:100%;aspect-ratio:16/9;background:var(--scg-well)}
    #${APP_ID} .scg-embed iframe{display:block;width:100%;height:100%;border:0}
    #${APP_ID}.safe-mode .scg-card img,
    #${APP_ID}.safe-mode .scg-card video,
    #${APP_ID}.safe-mode .scg-card iframe{filter:blur(24px);transform:scale(1.06)}
    #${APP_ID}.safe-mode .scg-card{overflow:hidden}
    #${APP_ID} .scg-marquee{position:fixed;z-index:90;pointer-events:none;border:1px solid var(--scg-accent);border-radius:6px;background:color-mix(in srgb,var(--scg-accent) 16%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--scg-accent) 20%,transparent)}
    #${APP_ID} .scg-embed-unavailable{
      display:grid;place-items:center;gap:9px;width:100%;height:100%;min-height:160px;
      padding:18px;text-align:center;
      color:var(--scg-muted);font-size:var(--scg-fs-sm);
    }
    #${APP_ID} .scg-embed-unavailable b{color:var(--scg-text);font-size:var(--scg-fs-md)}
    #${APP_ID} .scg-embed-unavailable a{
      display:inline-flex;align-items:center;gap:7px;
      min-height:34px;padding:7px 12px;
      border:1px solid var(--scg-accent-line);border-radius:var(--scg-r-md);
      background:var(--scg-accent-soft);color:var(--scg-accent);
      text-decoration:none;font-weight:550;
    }
    #${APP_ID} .scg-embed-unavailable a:hover{border-color:var(--scg-accent)}
    #${APP_ID} .scg-embed-loading{
      display:grid;place-items:center;gap:9px;width:100%;height:100%;min-height:160px;
      grid-auto-flow:column;
      color:var(--scg-muted);font-size:var(--scg-fs-sm);
    }
    #${APP_ID} .scg-embed-loading i{
      display:block;width:17px;height:17px;
      border:2px solid color-mix(in srgb,var(--scg-text) 20%,transparent);
      border-top-color:var(--scg-accent);border-radius:99px;
      animation:scg-viewer-spin .75s linear infinite;
    }
    #${APP_ID} .scg-embed-placeholder{
      display:grid;place-items:center;min-height:160px;
      background:radial-gradient(circle at 50% 6%,var(--scg-surface-3),var(--scg-well) 72%);
    }
    #${APP_ID} .scg-embed-poster{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.52}
    #${APP_ID} .scg-embed-poster[hidden]{display:none}
    #${APP_ID} .scg-embed-placeholder button{
      position:relative;z-index:1;
      display:flex;flex-direction:column;align-items:center;gap:7px;
      padding:15px 22px;
      border:1px solid var(--scg-line-strong);border-radius:var(--scg-r-lg);
      background:var(--scg-surface);color:var(--scg-text);
      box-shadow:var(--scg-shadow-sm);cursor:pointer;
      transition:transform .16s,border-color .16s;
    }
    #${APP_ID} .scg-embed-placeholder button:hover{transform:translateY(-1px);border-color:var(--scg-accent)}
    #${APP_ID} .scg-embed-placeholder button .scg-icon-well{
      display:grid;place-items:center;width:38px;height:38px;
      border:1px solid color-mix(in srgb,var(--scg-accent) 40%,transparent);
      border-radius:13px;background:var(--scg-accent-soft);color:var(--scg-accent);
    }
    #${APP_ID} .scg-embed-placeholder button .scg-icon{width:19px;height:19px}
    #${APP_ID} .scg-embed-placeholder button b{font-size:var(--scg-fs-md)}
    #${APP_ID} .scg-embed-placeholder button span{color:var(--scg-muted);font-size:var(--scg-fs-xs)}

    /* ---- 11. Empty + skeleton --------------------------------- */
    #${APP_ID} .scg-empty{
      display:flex;flex-direction:column;align-items:center;gap:10px;
      padding:88px 24px;text-align:center;
      color:var(--scg-muted);font-size:var(--scg-fs-base);
      column-span:all;grid-column:1/-1;
    }
    #${APP_ID} .scg-empty .scg-empty-art{
      display:grid;place-items:center;width:64px;height:64px;
      border:1px solid var(--scg-line);border-radius:20px;
      background:var(--scg-surface);color:var(--scg-muted);
    }
    #${APP_ID} .scg-empty .scg-empty-art .scg-icon{width:28px;height:28px}
    #${APP_ID} .scg-empty b{color:var(--scg-text);font-size:var(--scg-fs-lg);font-weight:600}
    #${APP_ID} .scg-empty span{max-width:420px;font-size:var(--scg-fs-md);line-height:1.55}

    #${APP_ID} .scg-skeleton{
      overflow:hidden;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-lg);
      background:var(--scg-surface);
    }
    #${APP_ID} .scg-skeleton-media,#${APP_ID} .scg-skeleton-line{position:relative;overflow:hidden;background:var(--scg-surface-3)}
    #${APP_ID} .scg-skeleton-media{height:var(--scg-skeleton-height,210px)}
    #${APP_ID} .scg-skeleton-line{height:9px;margin:13px;border-radius:99px}
    #${APP_ID} .scg-skeleton-line.short{width:48%;margin-top:0}
    #${APP_ID} .scg-skeleton-media:after,#${APP_ID} .scg-skeleton-line:after{
      content:'';position:absolute;inset:0;transform:translateX(-110%);
      background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--scg-text) 11%,transparent),transparent);
      animation:scg-shimmer 1.4s infinite;
    }
    @keyframes scg-shimmer{to{transform:translateX(110%)}}

    /* ---- 12. Reply groups ------------------------------------- */
    #${APP_ID} .scg-grid.grouped{display:block;columns:auto}
    /* Groups are no longer boxes drawn around the media. The header is the
       spine of the scroll: it pins while its own run of cards passes and hands
       over to the next one. No backdrop-filter here -- a page can hold twenty
       of these, and twenty blurred surfaces is not worth the seam it saves. */
    #${APP_ID} .scg-reply-group{margin:0 0 var(--scg-s-5)}
    #${APP_ID} .scg-reply-group>header{
      position:sticky;top:0;z-index:12;
      display:flex;align-items:center;gap:var(--scg-s-2);
      margin:0 0 var(--scg-s-3);padding:var(--scg-s-2) var(--scg-s-3);
      border:1px solid var(--scg-line);border-radius:var(--scg-r-md);
      background:var(--scg-surface);box-shadow:var(--scg-shadow-sm);
    }
    #${APP_ID} .scg-reply-identity{
      display:flex;align-items:baseline;gap:var(--scg-s-2);flex:1;min-width:0;overflow:hidden;
      white-space:nowrap;
    }
    #${APP_ID} .scg-reply-identity>*{flex:none}
    #${APP_ID} .scg-reply-identity>span:nth-of-type(2){
      flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;
    }
    /* Separators live in CSS so the markup stays readable text. */
    #${APP_ID} .scg-reply-identity>span:before{content:'·';margin-right:var(--scg-s-2);opacity:.55}
    #${APP_ID} .scg-reply-identity>span:empty{display:none}
    #${APP_ID} .scg-reply-group>header b{font-size:var(--scg-fs-md);color:var(--scg-text)}
    #${APP_ID} .scg-reply-group>header span{color:var(--scg-muted);font-size:var(--scg-fs-sm)}
    #${APP_ID} .scg-reply-identity [data-reply-selection-count]{color:var(--scg-accent);font-weight:600}
    #${APP_ID} .scg-reply-group>header a{
      display:inline-flex;align-items:center;gap:6px;flex:none;
      min-height:30px;padding:5px 9px;border:1px solid var(--scg-line);border-radius:var(--scg-r-sm);
      color:var(--scg-accent);text-decoration:none;font-size:var(--scg-fs-xs);font-weight:550;white-space:nowrap;
    }
    #${APP_ID} .scg-reply-group>header a:hover{background:var(--scg-accent-soft)}
    #${APP_ID} .scg-reply-group>header a .scg-icon{width:14px;height:14px}


    /* ---- 13. The dock (status / selection / downloads) --------- */
    #${APP_ID} .scg-activitybar{
      position:absolute;z-index:30;left:50%;bottom:18px;transform:translateX(-50%);
      display:flex;align-items:center;gap:12px;flex-wrap:nowrap;
      width:min(1240px,calc(100% - 36px));min-height:64px;
      padding:11px 14px;
      --scg-glass-edge:22%;
      --scg-glass-top:52%;
      --scg-glass-bottom:34%;
      --scg-glass-sheen:20%;
      --scg-glass-base:18%;
      --scg-glass-blur:34px;
      --scg-glass-sat:180%;
      --scg-glass-cast:0 20px 54px color-mix(in srgb,var(--scg-lo) 44%,transparent);
      border-color:color-mix(in srgb,var(--scg-hi) 22%,var(--scg-line-strong));
      border-radius:18px;
    }

    #${APP_ID} .scg-activity-state{display:flex;align-items:center;gap:10px;min-width:0;flex:0 1 260px;padding-left:4px}
    #${APP_ID} .scg-activity-state>i{
      width:8px;height:8px;flex:none;border-radius:99px;
      background:var(--scg-success);
      box-shadow:0 0 0 4px color-mix(in srgb,var(--scg-success) 18%,transparent);
    }
    #${APP_ID}.scanning .scg-activity-state>i,
    #${APP_ID}.downloading .scg-activity-state>i{
      background:var(--scg-accent);
      box-shadow:0 0 0 4px color-mix(in srgb,var(--scg-accent) 20%,transparent);
      animation:scg-pulse 1.25s ease-in-out infinite;
    }
    @keyframes scg-pulse{50%{opacity:.35}}
    #${APP_ID} .scg-activity-state>div{display:flex;flex-direction:column;gap:3px;min-width:0}
    #${APP_ID} .scg-activity-state .scg-status{
      display:block;margin:0;overflow:hidden;
      color:var(--scg-text);font-size:var(--scg-fs-sm);font-weight:600;
      text-overflow:ellipsis;white-space:nowrap;
    }
    #${APP_ID} .scg-activity-state span{
      overflow:hidden;color:var(--scg-muted);font-size:var(--scg-fs-xs);
      text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums;
    }
    #${APP_ID} .scg-activitybar button{
      display:inline-flex;align-items:center;justify-content:center;gap:7px;
      min-height:40px;padding:9px 12px;
      border:1px solid color-mix(in srgb,#ffffff 10%,var(--scg-line));border-radius:13px;
      background:color-mix(in srgb,var(--scg-surface-2) 50%,transparent);color:var(--scg-text-soft);
      font-size:var(--scg-fs-sm);font-weight:550;cursor:pointer;white-space:nowrap;
      transition:background .14s,border-color .14s,color .14s;
    }
    #${APP_ID} .scg-activitybar button .scg-icon{color:var(--scg-muted)}
    #${APP_ID} .scg-activitybar button:hover:not(:disabled){background:var(--scg-surface-3);color:var(--scg-text);border-color:var(--scg-line-strong)}
    #${APP_ID} .scg-activitybar button:hover:not(:disabled) .scg-icon{color:var(--scg-text)}
    #${APP_ID} .scg-activitybar .scg-primary{
      border-color:color-mix(in srgb,var(--scg-accent) 60%,transparent);
      background:var(--scg-accent);color:var(--scg-accent-ink);font-weight:650;
    }
    #${APP_ID} .scg-activitybar .scg-primary .scg-icon{color:var(--scg-accent-ink)}
    #${APP_ID} .scg-activitybar .scg-primary:hover:not(:disabled){
      background:color-mix(in srgb,var(--scg-accent) 86%,#ffffff);color:var(--scg-accent-ink);
    }
    #${APP_ID} .scg-activitybar .scg-primary:hover:not(:disabled) .scg-icon{color:var(--scg-accent-ink)}

    /* Three independent dock regions. Status is permanent; the other two are
       mounted by what is true, not by a mode the reader has to enter or leave. */
    #${APP_ID} .scg-select-wrap{flex:none}
    #${APP_ID} .scg-selection-toggle{flex:none}
    #${APP_ID} .scg-selection-toggle[aria-expanded="true"],
    #${APP_ID}.has-selection .scg-selection-toggle{
      border-color:color-mix(in srgb,var(--scg-accent) 50%,transparent);
      background:var(--scg-accent-soft);color:var(--scg-accent);
    }
    #${APP_ID} .scg-selection-toggle[aria-expanded="true"] .scg-icon,
    #${APP_ID}.has-selection .scg-selection-toggle .scg-icon{color:var(--scg-accent)}

    #${APP_ID} .scg-selection-region{display:none;align-items:center;gap:6px;min-width:0;flex:1}
    #${APP_ID}.has-selection .scg-selection-region,
    #${APP_ID}.downloading .scg-selection-region{display:flex}
    #${APP_ID}.downloading:not(.has-selection) .scg-selection-region{flex:0 0 auto}
    #${APP_ID}.downloading:not(.has-selection) .scg-selection-region>*:not([data-action="download-selected"]){display:none}
    #${APP_ID} .scg-activitybar .cancel-download{
      border-color:color-mix(in srgb,var(--scg-danger) 65%,transparent);
      background:var(--scg-danger-soft);color:var(--scg-danger);
    }
    #${APP_ID} .scg-activitybar .cancel-download .scg-icon{color:var(--scg-danger)}
    #${APP_ID} .scg-activitybar .cancel-download:hover:not(:disabled){
      border-color:var(--scg-danger);background:color-mix(in srgb,var(--scg-danger-soft) 72%,var(--scg-danger));color:#ffffff;
    }
    #${APP_ID} .scg-activitybar .cancel-download:hover:not(:disabled) .scg-icon{color:#ffffff}
    #${APP_ID} .scg-selected-count{
      flex:none;margin-right:auto;padding:0 4px;
      color:var(--scg-text);font-size:var(--scg-fs-sm);font-weight:600;font-variant-numeric:tabular-nums;
    }
    #${APP_ID}.has-selection .scg-activity-state{flex:0 0 auto}
    #${APP_ID}.has-selection .scg-activity-state>div{display:none}

    /* The transfer region exists only while there is a transfer. An idle
       progress bar was reporting nothing at the cost of a permanent third of
       the dock. */
    #${APP_ID} .scg-progress{position:relative;display:none;min-width:220px;max-width:440px;flex:1 1 300px}
    #${APP_ID}.has-downloads .scg-progress,
    #${APP_ID}.downloading .scg-progress{display:flex}
    #${APP_ID}.has-selection.has-downloads .scg-progress,
    #${APP_ID}.has-selection.downloading .scg-progress{min-width:150px;max-width:320px;flex:1 1 220px}
    #${APP_ID} .scg-progress-summary{
      display:flex !important;align-items:center;gap:10px;width:100%;min-width:0;
      min-height:40px;padding:8px 12px !important;
      border:1px solid color-mix(in srgb,#ffffff 10%,var(--scg-line));border-radius:13px;
      background:color-mix(in srgb,var(--scg-surface-2) 50%,transparent);color:var(--scg-text-soft);cursor:pointer;
    }
    #${APP_ID} .scg-progress-track{
      position:relative;display:block;height:6px;flex:1;min-width:70px;overflow:hidden;
      border-radius:99px;background:var(--scg-surface-3);
    }
    #${APP_ID} .scg-progress-fill{
      display:block;height:100%;width:0;border-radius:inherit;
      background:linear-gradient(90deg,var(--scg-accent),color-mix(in srgb,var(--scg-accent) 45%,var(--scg-success)));
      transition:width .2s ease;
    }
    #${APP_ID} .scg-progress-text{
      flex:none;max-width:220px;overflow:hidden;
      color:var(--scg-muted);font-size:var(--scg-fs-sm);text-align:right;
      text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums;
    }
    /* Download queue popover */
    #${APP_ID} .scg-download-popover{
      display:none;position:absolute;z-index:320;right:0;bottom:calc(100% + 10px);
      width:min(520px,calc(100vw - 32px));max-height:min(540px,66vh);
      overflow:hidden;
      border:1px solid color-mix(in srgb,#ffffff 14%,var(--scg-line-strong));border-radius:var(--scg-r-lg);
      background:linear-gradient(145deg,
        color-mix(in srgb,var(--scg-surface) 94%,transparent),
        color-mix(in srgb,var(--scg-surface-2) 90%,transparent));
      color:var(--scg-text);
      box-shadow:0 18px 48px #00000080,
        inset 0 1px 0 color-mix(in srgb,#ffffff 8%,transparent);
      backdrop-filter:blur(20px) saturate(145%);
      -webkit-backdrop-filter:blur(20px) saturate(145%);
      isolation:isolate;
    }
    #${APP_ID} .scg-progress.expanded .scg-download-popover{display:block}
    #${APP_ID} .scg-download-popover>header{
      display:flex;align-items:center;justify-content:space-between;gap:12px;
      padding:11px 13px;
      border-bottom:1px solid var(--scg-line);background:color-mix(in srgb,var(--scg-surface-2) 92%,transparent);
    }
    #${APP_ID} .scg-download-popover>header b{font-size:var(--scg-fs-md)}
    #${APP_ID} .scg-download-popover>header>div{display:flex;align-items:center;gap:5px}
    #${APP_ID} .scg-download-popover>header button{
      display:inline-flex;align-items:center;gap:6px;
      min-height:30px;padding:5px 9px !important;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-sm);
      background:color-mix(in srgb,var(--scg-surface) 94%,transparent);color:var(--scg-text-soft);
      font-size:var(--scg-fs-xs);cursor:pointer;
    }
    #${APP_ID} .scg-download-popover>header button:hover{background:var(--scg-surface-3);color:var(--scg-text)}
    #${APP_ID} .scg-download-overall{
      padding:10px 13px;border-bottom:1px solid var(--scg-line);
      color:var(--scg-muted);font-size:var(--scg-fs-sm);font-variant-numeric:tabular-nums;
    }
    #${APP_ID} .scg-download-jobs{max-height:min(420px,48vh);overflow:auto;padding:8px}
    #${APP_ID} .scg-download-job{padding:9px 10px;border-radius:var(--scg-r-md);contain:content}
    #${APP_ID} .scg-download-job+.scg-download-job{border-top:1px solid var(--scg-line)}
    #${APP_ID} .scg-download-job>div:first-child{display:flex;align-items:center;justify-content:space-between;gap:12px}
    #${APP_ID} .scg-download-job b{
      min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
      color:var(--scg-text);font-size:var(--scg-fs-sm);font-weight:550;
    }
    #${APP_ID} .scg-download-job span{flex:none;color:var(--scg-muted);font-size:var(--scg-fs-xs);font-variant-numeric:tabular-nums}
    #${APP_ID} .scg-job-track{height:4px;margin-top:7px;overflow:hidden;border-radius:99px;background:var(--scg-surface-3)}
    #${APP_ID} .scg-job-track i{
      display:block;height:100%;border-radius:inherit;
      background:var(--scg-accent);transition:width .15s;
    }
    #${APP_ID} .scg-job-track i.indeterminate{animation:scg-indeterminate 1s ease-in-out infinite}
    @keyframes scg-indeterminate{0%{transform:translateX(-120%)}50%{transform:translateX(95%)}100%{transform:translateX(290%)}}
    #${APP_ID} .scg-job-saved .scg-job-track i{background:var(--scg-success)}
    #${APP_ID} .scg-job-failed .scg-job-track i,
    #${APP_ID} .scg-job-verification .scg-job-track i{background:var(--scg-danger)}
    #${APP_ID} .scg-job-duplicate .scg-job-track i{background:var(--scg-warn)}
    #${APP_ID} .scg-job-duplicate,#${APP_ID} .scg-job-skipped{opacity:.72}
    #${APP_ID} .scg-download-empty{padding:28px;text-align:center;color:var(--scg-muted);font-size:var(--scg-fs-sm)}

    /* ---- 14. Settings sheet ----------------------------------- */
    #${APP_ID} .scg-settings-panel{
      display:none;position:fixed;inset:0;z-index:2147483647;
      align-items:center;justify-content:center;padding:24px;
      background:color-mix(in srgb,var(--scg-bg) 78%,transparent);
      backdrop-filter:blur(10px);
    }
    #${APP_ID} .scg-settings-panel.open{display:flex}
    #${APP_ID} .scg-settings-dialog{
      display:flex;flex-direction:column;
      width:min(940px,calc(100vw - 32px));max-height:min(820px,calc(100vh - 32px));
      overflow:hidden;outline:none;
      border:1px solid var(--scg-line-strong);border-radius:var(--scg-r-xl);
      background:var(--scg-surface);box-shadow:var(--scg-shadow);
    }
    #${APP_ID} .scg-settings-head{
      display:flex;align-items:center;justify-content:space-between;gap:16px;
      padding:16px 18px;border-bottom:1px solid var(--scg-line);background:var(--scg-surface-2);
    }
    #${APP_ID} .scg-settings-head>div{display:flex;align-items:center;gap:12px;min-width:0}
    #${APP_ID} .scg-settings-head>div>.scg-icon{width:22px;height:22px;color:var(--scg-accent)}
    #${APP_ID} .scg-settings-head h2{margin:0;font-size:var(--scg-fs-xl);font-weight:650;letter-spacing:-.01em}
    #${APP_ID} .scg-settings-head p{margin:3px 0 0;color:var(--scg-muted);font-size:var(--scg-fs-sm)}
    #${APP_ID} .scg-settings-close{
      display:inline-grid;place-items:center;width:38px;height:38px;flex:none;padding:0;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-md);
      background:var(--scg-surface);color:var(--scg-text-soft);cursor:pointer;
    }
    #${APP_ID} .scg-settings-close:hover{
      border-color:color-mix(in srgb,var(--scg-danger) 45%,transparent);
      background:var(--scg-danger-soft);color:var(--scg-danger);
    }
    #${APP_ID} .scg-settings-body{overflow:auto;padding:16px}
    #${APP_ID} .scg-settings-search{
      display:flex;align-items:center;gap:9px;margin:0 0 14px;padding:0 12px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-md);background:var(--scg-surface);
    }
    #${APP_ID} .scg-settings-search .scg-icon{width:16px;height:16px;flex:none;color:var(--scg-muted)}
    #${APP_ID} .scg-settings-search input{
      flex:1;min-width:0;min-height:38px;padding:0;
      border:0;background:none;color:var(--scg-text);font-size:var(--scg-fs-md);
    }
    #${APP_ID} .scg-settings-search input:focus{outline:none}
    #${APP_ID} .scg-settings-search input::-webkit-search-cancel-button{display:none}
    #${APP_ID} .scg-settings-search button{
      display:none;align-items:center;justify-content:center;flex:none;
      width:24px;height:24px;padding:0;border:0;border-radius:99px;
      background:var(--scg-surface-3);color:var(--scg-muted);cursor:pointer;
    }
    #${APP_ID} .scg-settings-search button .scg-icon{width:12px;height:12px;color:inherit}
    #${APP_ID} .scg-settings-search[data-filled] button{display:inline-flex}
    #${APP_ID} .scg-settings-empty{
      margin:0 0 14px;padding:14px;border:1px dashed var(--scg-line);border-radius:var(--scg-r-md);
      color:var(--scg-muted);font-size:var(--scg-fs-sm);text-align:center;
    }
    #${APP_ID} .scg-settings-card[hidden]{display:none}
    #${APP_ID} .scg-viewbar label[data-inert]{opacity:.5}
    #${APP_ID} .scg-shortcut-rows{display:grid;gap:7px}
    #${APP_ID} .scg-shortcut-row{
      display:flex;align-items:center;justify-content:space-between;gap:12px;
      color:var(--scg-text-soft);font-size:var(--scg-fs-sm);
    }
    #${APP_ID} .scg-shortcut-key{
      flex:none;min-width:118px;min-height:32px;padding:5px 11px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-md);
      background:var(--scg-surface);color:var(--scg-text);
      font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
      font-size:var(--scg-fs-sm);font-weight:600;text-align:center;cursor:pointer;
    }
    #${APP_ID} .scg-shortcut-key:hover{border-color:var(--scg-line-strong);background:var(--scg-surface-3)}
    #${APP_ID} .scg-shortcut-key[data-recording]{
      border-color:var(--scg-accent-line);background:var(--scg-accent-soft);color:var(--scg-accent);
    }
    #${APP_ID} .scg-block-patterns{
      width:100%;min-height:84px;padding:9px 11px;resize:vertical;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-md);
      background:var(--scg-surface);color:var(--scg-text);
      font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:var(--scg-fs-sm);line-height:1.6;
    }
    #${APP_ID} .scg-block-summary{margin-top:8px;color:var(--scg-muted);font-size:var(--scg-fs-xs)}
    #${APP_ID} .scg-settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
    #${APP_ID} .scg-settings-card{
      padding:15px;border:1px solid var(--scg-line);border-radius:var(--scg-r-lg);
      background:var(--scg-surface-2);
    }
    #${APP_ID} .scg-settings-card.full{grid-column:1/-1}
    #${APP_ID} .scg-settings-card h3{
      display:flex;align-items:center;gap:9px;margin:0 0 6px;
      color:var(--scg-text);font-size:var(--scg-fs-base);font-weight:650;
    }
    #${APP_ID} .scg-settings-card h3 .scg-icon{color:var(--scg-accent)}
    #${APP_ID} .scg-settings-card>p{margin:0 0 13px;color:var(--scg-muted);font-size:var(--scg-fs-sm);line-height:1.5}
    #${APP_ID} .scg-settings-version{
      display:inline-flex;align-items:center;margin-left:auto;padding:3px 8px;
      border:1px solid var(--scg-accent-line);border-radius:99px;
      background:var(--scg-accent-soft);color:var(--scg-accent);
      font-size:var(--scg-fs-xs);font-weight:650;
    }
    #${APP_ID} .scg-setting-fields{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    #${APP_ID} .scg-setting-fields label{
      display:flex;flex-direction:column;gap:6px;min-width:0;
      color:var(--scg-muted);font-size:var(--scg-fs-2xs);font-weight:700;
      text-transform:uppercase;letter-spacing:.08em;
    }
    #${APP_ID} .scg-setting-fields select{width:100%;min-height:36px;font-size:var(--scg-fs-md)}
    #${APP_ID} .scg-setting-size>span{display:flex;align-items:center;gap:10px;min-height:36px;padding:7px 10px;border:1px solid var(--scg-line);border-radius:var(--scg-r-md);background:var(--scg-surface)}
    #${APP_ID} .scg-setting-size [data-card-scale]{width:100%;flex:1}
    #${APP_ID} .scg-download-settings{grid-template-columns:repeat(4,minmax(0,1fr))}
    #${APP_ID} .scg-archive-checks{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;margin-top:10px}
    #${APP_ID} .scg-settings-check{
      display:flex;align-items:flex-start;gap:9px;margin:10px 0;
      color:var(--scg-muted);font-size:var(--scg-fs-sm);line-height:1.5;cursor:pointer;
    }
    #${APP_ID} .scg-settings-check input{margin-top:1px;flex:none}
    #${APP_ID} .scg-settings-check:hover{color:var(--scg-text-soft)}
    #${APP_ID} .scg-settings-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    #${APP_ID} .scg-settings-actions button{
      display:inline-flex;align-items:center;justify-content:center;gap:7px;
      min-height:36px;padding:8px 12px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-md);
      background:var(--scg-surface);color:var(--scg-text);
      font-size:var(--scg-fs-sm);font-weight:550;cursor:pointer;
    }
    #${APP_ID} .scg-settings-actions button .scg-icon{color:var(--scg-muted)}
    #${APP_ID} .scg-settings-actions button:hover{background:var(--scg-surface-3);border-color:var(--scg-line-strong)}
    #${APP_ID} .scg-settings-actions .danger{
      border-color:color-mix(in srgb,var(--scg-danger) 45%,transparent);
      background:var(--scg-danger-soft);color:var(--scg-danger);
    }
    #${APP_ID} .scg-settings-actions .danger .scg-icon{color:var(--scg-danger)}
    #${APP_ID} .scg-settings-file{display:none}
    #${APP_ID} .scg-diag-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px}
    #${APP_ID} .scg-diag-stat{
      min-width:0;padding:10px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-md);background:var(--scg-surface);
    }
    #${APP_ID} .scg-diag-stat span{
      display:block;color:var(--scg-muted);
      font-size:var(--scg-fs-2xs);font-weight:700;text-transform:uppercase;letter-spacing:.08em;
    }
    #${APP_ID} .scg-diag-stat b{
      display:block;margin-top:5px;overflow:hidden;text-overflow:ellipsis;
      color:var(--scg-text);font-size:var(--scg-fs-sm);font-variant-numeric:tabular-nums;
    }
    #${APP_ID} .scg-storage-note{
      display:flex;align-items:flex-start;gap:9px;padding:10px 12px;
      border:1px solid color-mix(in srgb,var(--scg-success) 34%,var(--scg-line));
      border-radius:var(--scg-r-md);
      background:var(--scg-success-soft);color:var(--scg-text-soft);font-size:var(--scg-fs-sm);line-height:1.5;
    }
    #${APP_ID} .scg-storage-note .scg-icon{color:var(--scg-success);margin-top:1px}
    #${APP_ID} .scg-permission-note{
      padding:11px 13px;border-left:3px solid var(--scg-accent);border-radius:0 var(--scg-r-sm) var(--scg-r-sm) 0;
      background:var(--scg-accent-soft);color:var(--scg-text-soft);font-size:var(--scg-fs-sm);line-height:1.55;
    }
    #${APP_ID} .scg-settings-foot{
      display:flex;align-items:center;justify-content:space-between;gap:12px;
      padding:12px 18px;border-top:1px solid var(--scg-line);
      background:var(--scg-surface-2);color:var(--scg-muted);font-size:var(--scg-fs-sm);
    }
    #${APP_ID} .scg-settings-foot b{color:var(--scg-accent)}

    /* ---- 15. Confirm dialog ----------------------------------- */
    #${APP_ID} .scg-confirm-panel{
      display:none;position:fixed;inset:0;z-index:2147483647;
      align-items:center;justify-content:center;padding:18px;
      background:color-mix(in srgb,var(--scg-bg) 74%,transparent);backdrop-filter:blur(8px);
    }
    #${APP_ID} .scg-confirm-panel.open{display:flex}
    #${APP_ID} .scg-confirm-dialog{
      width:min(440px,100%);padding:24px;text-align:center;
      border:1px solid var(--scg-line-strong);border-radius:var(--scg-r-xl);
      background:var(--scg-surface);box-shadow:var(--scg-shadow);
    }
    #${APP_ID} .scg-confirm-icon{
      display:grid;place-items:center;width:46px;height:46px;margin:0 auto 14px;
      border:1px solid var(--scg-accent-line);border-radius:15px;
      background:var(--scg-accent-soft);color:var(--scg-accent);
    }
    #${APP_ID} .scg-confirm-icon .scg-icon{width:22px;height:22px}
    #${APP_ID} .scg-confirm-dialog h2{margin:0;color:var(--scg-text);font-size:var(--scg-fs-lg);font-weight:650}
    #${APP_ID} .scg-confirm-dialog p{margin:9px 0 20px;color:var(--scg-muted);font-size:var(--scg-fs-md);line-height:1.55}
    #${APP_ID} .scg-confirm-preference{
      display:flex;align-items:center;justify-content:center;gap:8px;
      margin:-8px 0 18px;color:var(--scg-text-soft);font-size:var(--scg-fs-sm);cursor:pointer;
    }
    #${APP_ID} .scg-reply-toggle{
      display:inline-grid;place-items:center;flex:none;
      width:30px;min-height:30px;padding:0;border:1px solid var(--scg-line);border-radius:var(--scg-r-sm);
      background:var(--scg-surface-2);color:var(--scg-text-soft);cursor:pointer;
    }
    #${APP_ID} .scg-reply-select{
      display:inline-flex;align-items:center;gap:6px;flex:none;min-height:30px;padding:5px 8px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-sm);
      background:var(--scg-surface-2);color:var(--scg-text-soft);font-size:var(--scg-fs-xs);cursor:pointer;
    }
    #${APP_ID} .scg-reply-select:hover{border-color:var(--scg-line-strong);background:var(--scg-surface-3)}
    #${APP_ID} .scg-reply-select>span{display:none}
    #${APP_ID} .scg-reply-select input{width:16px;height:16px;margin:0;accent-color:var(--scg-accent);cursor:pointer}
    #${APP_ID} .scg-reply-select .scg-icon{color:var(--scg-accent)}
    #${APP_ID} .scg-reply-toggle:hover{border-color:var(--scg-line-strong);background:var(--scg-surface-3)}
    #${APP_ID} .scg-reply-toggle .scg-icon{transition:transform .18s ease}
    #${APP_ID} .scg-reply-toggle[aria-expanded="false"] .scg-icon{transform:rotate(-90deg)}
    #${APP_ID} .scg-reply-group.collapsed{margin-bottom:var(--scg-s-2)}
    #${APP_ID} .scg-reply-group.collapsed>header{margin-bottom:0}
    #${APP_ID} .scg-collapsed-status{color:var(--scg-accent);font-size:var(--scg-fs-2xs);font-style:normal;font-weight:650;text-transform:uppercase;letter-spacing:.06em}
    #${APP_ID} .scg-confirm-preference[hidden]{display:none}
    #${APP_ID} .scg-confirm-preference input{accent-color:var(--scg-accent)}
    #${APP_ID} .scg-confirm-dialog>div:last-child{display:flex;justify-content:center;gap:9px}
    #${APP_ID} .scg-confirm-dialog button{
      display:inline-flex;align-items:center;justify-content:center;gap:7px;
      min-width:120px;min-height:40px;padding:10px 15px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-md);
      background:var(--scg-surface-2);color:var(--scg-text);
      font-size:var(--scg-fs-md);font-weight:550;cursor:pointer;
    }
    #${APP_ID} .scg-confirm-dialog button:hover{background:var(--scg-surface-3)}
    #${APP_ID} .scg-confirm-accept{
      border-color:var(--scg-accent) !important;
      background:var(--scg-accent) !important;color:var(--scg-accent-ink) !important;font-weight:650;
    }
    #${APP_ID} .scg-confirm-accept .scg-icon{color:var(--scg-accent-ink)}
    #${APP_ID} .scg-confirm-accept.danger{
      border-color:var(--scg-danger) !important;
      background:var(--scg-danger) !important;color:#1b0308 !important;
    }
    #${APP_ID} .scg-confirm-accept.danger .scg-icon{color:#1b0308}


    /* ---- 16. Lightbox: the Theatre ----------------------------- */
    #${APP_ID} .scg-lightbox{
      display:none;position:fixed;inset:0;z-index:2147483647;
      overflow:hidden;background:#000000;color:var(--scg-text);
    }
    #${APP_ID} .scg-lightbox.open{display:block}
    #${APP_ID}[data-theme="light"] .scg-lightbox{background:#c9d1dc}
    #${APP_ID} .scg-viewer-shell{
      display:grid;grid-template-rows:auto minmax(0,1fr) auto;
      width:100%;height:100%;height:100dvh;
      background:radial-gradient(circle at 50% 32%,color-mix(in srgb,var(--scg-surface) 62%,#000000) 0,#050506 62%,#000000 100%);
    }
    #${APP_ID}[data-theme="light"] .scg-viewer-shell{
      background:radial-gradient(circle at 50% 32%,#ffffff 0,#e6ebf2 58%,#cfd7e2 100%);
    }
    #${APP_ID} .scg-lightbox:fullscreen .scg-viewer-shell{height:100vh}

    /* Floating top bar */
    #${APP_ID} .scg-viewer-topbar{
      position:relative;z-index:20;align-self:start;
      display:flex;align-items:center;gap:14px;min-width:0;
      width:calc(100% - 24px);margin:12px;
      padding:8px 10px 8px 14px;
      border:1px solid color-mix(in srgb,#ffffff 15%,var(--scg-line));border-radius:var(--scg-r-lg);
      background:linear-gradient(135deg,
        color-mix(in srgb,var(--scg-surface) 62%,transparent),
        color-mix(in srgb,var(--scg-surface-2) 44%,transparent));
      box-shadow:0 12px 34px #0000005c,inset 0 1px 0 color-mix(in srgb,#ffffff 10%,transparent);
      backdrop-filter:blur(28px) saturate(160%);
      -webkit-backdrop-filter:blur(28px) saturate(160%);
      visibility:visible;will-change:opacity,transform;
      transition:opacity .28s cubic-bezier(.2,.7,.3,1),transform .28s cubic-bezier(.2,.7,.3,1),visibility 0s;
    }
    #${APP_ID} .scg-viewer-identity{display:flex;align-items:center;gap:14px;min-width:0;flex:1}
    #${APP_ID} .scg-viewer-identity>b{
      display:inline-flex;align-items:baseline;gap:3px;flex:none;
      padding:5px 10px;border:1px solid var(--scg-line);border-radius:99px;
      background:var(--scg-surface-2);color:var(--scg-text);
      font-size:var(--scg-fs-base);font-weight:650;font-variant-numeric:tabular-nums;
    }
    #${APP_ID} .scg-viewer-identity>b span{color:var(--scg-muted);font-size:var(--scg-fs-xs);font-weight:550}
    #${APP_ID} .scg-viewer-identity>div{min-width:0}
    #${APP_ID} .scg-viewer-titleline{display:flex;align-items:center;gap:9px;min-width:0}
    #${APP_ID} .scg-viewer-titleline strong{
      min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
      font-size:var(--scg-fs-md);font-weight:600;
    }
    #${APP_ID} .scg-viewer-resolution{
      display:inline-flex;align-items:center;flex:none;
      padding:3px 8px;border:1px solid var(--scg-accent-line);border-radius:99px;
      background:var(--scg-accent-soft);color:var(--scg-accent);
      font-size:var(--scg-fs-xs);font-weight:650;font-variant-numeric:tabular-nums;white-space:nowrap;
    }
    #${APP_ID} .scg-viewer-identity small{
      display:block;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
      max-width:min(760px,54vw);color:var(--scg-muted);font-size:var(--scg-fs-xs);
    }

    #${APP_ID} .scg-viewer-tools{position:relative;z-index:21;display:flex;align-items:center;gap:4px;flex:none}
    #${APP_ID} .scg-viewer-tools button{
      display:inline-grid;place-items:center;
      min-width:36px;height:36px;padding:8px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-md);
      background:var(--scg-surface-2);color:var(--scg-text-soft);
      cursor:pointer;transition:background .14s,border-color .14s,color .14s;
    }
    #${APP_ID} .scg-viewer-tools button:hover:not(:disabled){background:var(--scg-surface-3);color:var(--scg-text);border-color:var(--scg-line-strong)}
    #${APP_ID} .scg-viewer-tools button[aria-pressed="true"]{
      border-color:color-mix(in srgb,var(--scg-accent) 50%,transparent);
      background:var(--scg-accent-soft);color:var(--scg-accent);
    }
    #${APP_ID} .scg-viewer-zoom{
      display:flex;align-items:center;gap:3px;
      padding:3px;margin-right:5px;
      border:1px solid var(--scg-line);border-radius:13px;background:var(--scg-surface-2);
    }
    #${APP_ID} .scg-viewer-zoom.unavailable{display:none}
    #${APP_ID} .scg-viewer-zoom button{min-width:32px;height:30px;border-color:transparent;background:transparent}
    #${APP_ID} .scg-viewer-zoom [data-viewer-fit]{
      grid-auto-flow:column;gap:6px;min-width:84px;padding:6px 9px;
    }
    #${APP_ID} .scg-viewer-zoom [data-viewer-fit] span{
      font-size:var(--scg-fs-xs);font-weight:650;font-variant-numeric:tabular-nums;
    }
    #${APP_ID} .scg-viewer-tools .scg-viewer-download{
      border-color:color-mix(in srgb,var(--scg-accent) 55%,transparent);
      background:var(--scg-accent);color:var(--scg-accent-ink);
    }
    #${APP_ID} .scg-viewer-tools .scg-viewer-download:hover{
      background:color-mix(in srgb,var(--scg-accent) 86%,#ffffff);color:var(--scg-accent-ink);
    }
    #${APP_ID} .scg-viewer-tools .scg-lightbox-close{margin-left:5px;color:var(--scg-text)}
    #${APP_ID} .scg-viewer-tools .scg-lightbox-close:hover{
      border-color:color-mix(in srgb,var(--scg-danger) 50%,transparent);
      background:var(--scg-danger-soft);color:var(--scg-danger);
    }

    /* Stage + details */
    #${APP_ID} .scg-viewer-body{
      position:relative;display:grid;grid-template-columns:minmax(0,1fr) 336px;
      min-width:0;min-height:0;overflow:hidden;
      transition:grid-template-columns .22s ease;
    }
    #${APP_ID} .scg-lightbox.details-hidden .scg-viewer-body{grid-template-columns:minmax(0,1fr) 0}
    #${APP_ID} .scg-lightbox-stage{
      position:relative;display:flex;align-items:center;justify-content:center;
      width:100%;height:100%;min-width:0;min-height:0;
      padding:18px;overflow:hidden;
      touch-action:none;user-select:none;
    }
    #${APP_ID} .scg-lightbox-stage .scg-viewer-image{
      position:relative;z-index:1;display:block;
      width:auto;height:auto;max-width:100%;max-height:100%;
      object-fit:contain;border-radius:4px;
      background:var(--scg-well);
      box-shadow:0 24px 80px #000000b3;
      transform:var(--scg-viewer-transform,translate3d(0,0,0) scale(1)) !important;
      transform-origin:center;transition:transform .14s ease;will-change:transform;cursor:zoom-in;
    }
    #${APP_ID}[data-theme="light"] .scg-lightbox-stage .scg-viewer-image{box-shadow:0 20px 60px #35496433}
    #${APP_ID} .scg-lightbox.viewer-zoomed .scg-viewer-image{cursor:grab;transition:none}
    #${APP_ID} .scg-lightbox.viewer-zoomed .scg-viewer-image.dragging{cursor:grabbing}
    #${APP_ID} .scg-lightbox-stage video,#${APP_ID} .scg-lightbox-stage iframe{
      position:relative;z-index:1;display:block;
      width:100%;height:100%;max-width:100%;max-height:100%;
      border:0;border-radius:10px;background:#000000;object-fit:contain;
      box-shadow:0 24px 80px #000000b3;
    }
    #${APP_ID} .scg-lightbox-stage.viewer-buffering:before{
      content:'';position:absolute;z-index:3;width:30px;height:30px;
      border:3px solid color-mix(in srgb,var(--scg-text) 22%,transparent);
      border-top-color:var(--scg-accent);border-radius:99px;
      animation:scg-viewer-spin .75s linear infinite;pointer-events:none;
    }
    @keyframes scg-viewer-loading-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
    @keyframes scg-viewer-spin{to{transform:rotate(360deg)}}
    #${APP_ID} .scg-viewer-loading{
      display:flex;align-items:center;gap:11px;padding:9px 12px;
      border:1px solid color-mix(in srgb,var(--scg-line-strong) 72%,transparent);border-radius:99px;
      background:color-mix(in srgb,var(--scg-surface) 44%,transparent);
      color:var(--scg-muted);font-size:var(--scg-fs-sm);
      backdrop-filter:blur(14px) saturate(145%);
      -webkit-backdrop-filter:blur(14px) saturate(145%);
      animation:scg-viewer-loading-in .2s ease both;
    }
    #${APP_ID} .scg-viewer-loading i{
      display:block;width:19px;height:19px;flex:none;
      border:2px solid color-mix(in srgb,var(--scg-text) 20%,transparent);
      border-top-color:var(--scg-accent);border-radius:99px;
      animation:scg-viewer-spin .75s linear infinite;
      transform-origin:center;will-change:transform;
    }
    #${APP_ID} .scg-viewer-error{
      max-width:470px;padding:24px;
      border:1px solid color-mix(in srgb,var(--scg-danger) 40%,var(--scg-line));
      border-radius:var(--scg-r-lg);
      background:var(--scg-danger-soft);color:var(--scg-danger);
      text-align:center;font-size:var(--scg-fs-md);line-height:1.55;
    }

    #${APP_ID} .scg-viewer-details{
      min-width:0;overflow:auto;
      margin:0 12px 12px 0;padding:18px;
      border:1px solid var(--scg-line-strong);border-radius:var(--scg-r-lg);
      background:color-mix(in srgb,var(--scg-surface) 90%,transparent);
      box-shadow:var(--scg-shadow);
      backdrop-filter:blur(22px) saturate(130%);
      opacity:1;transition:opacity .18s ease,transform .22s ease;
    }
    #${APP_ID} .scg-lightbox.details-hidden .scg-viewer-details{
      overflow:hidden;opacity:0;pointer-events:none;transform:translateX(34px);
    }
    #${APP_ID} .scg-viewer-details-head{
      display:flex;align-items:center;gap:11px;
      padding-bottom:15px;border-bottom:1px solid var(--scg-line);
    }
    #${APP_ID} .scg-viewer-details-head>span{
      display:grid;place-items:center;width:38px;height:38px;flex:none;
      border:1px solid var(--scg-accent-line);border-radius:12px;
      background:var(--scg-accent-soft);color:var(--scg-accent);
    }
    #${APP_ID} .scg-viewer-details-head>div{min-width:0}
    #${APP_ID} .scg-viewer-details-head b,#${APP_ID} .scg-viewer-details-head small{
      display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    }
    #${APP_ID} .scg-viewer-details-head b{font-size:var(--scg-fs-base);font-weight:650}
    #${APP_ID} .scg-viewer-details-head small{margin-top:3px;color:var(--scg-muted);font-size:var(--scg-fs-xs)}
    #${APP_ID} .scg-viewer-caption{
      margin:15px 0;padding:13px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-md);
      background:var(--scg-surface-2);color:var(--scg-text-soft);
      font-size:var(--scg-fs-sm);line-height:1.6;white-space:pre-wrap;word-break:break-word;
    }
    #${APP_ID} .scg-viewer-details dl{margin:15px 0}
    #${APP_ID} .scg-viewer-details dl>div{
      display:grid;grid-template-columns:88px minmax(0,1fr);gap:10px;
      padding:9px 0;border-bottom:1px solid var(--scg-line);
    }
    #${APP_ID} .scg-viewer-details dt{
      color:var(--scg-muted);font-size:var(--scg-fs-2xs);font-weight:700;
      text-transform:uppercase;letter-spacing:.08em;
    }
    #${APP_ID} .scg-viewer-details dd{
      min-width:0;margin:0;overflow:hidden;text-overflow:ellipsis;
      color:var(--scg-text);font-size:var(--scg-fs-sm);font-weight:550;font-variant-numeric:tabular-nums;
    }
    #${APP_ID} .scg-viewer-details-links{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    #${APP_ID} .scg-viewer-details-links a{
      display:flex;align-items:center;justify-content:center;gap:7px;
      min-height:36px;padding:9px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-md);
      background:var(--scg-surface-2);color:var(--scg-accent);
      text-decoration:none;font-size:var(--scg-fs-sm);font-weight:550;
    }
    #${APP_ID} .scg-viewer-details-links a:hover{background:var(--scg-accent-soft);border-color:var(--scg-accent-line)}
    #${APP_ID} .scg-viewer-details-links a .scg-icon{width:14px;height:14px}
    #${APP_ID} .scg-viewer-shortcuts{
      margin:18px 0 0;padding-top:14px;border-top:1px solid var(--scg-line);
      color:var(--scg-muted);font-size:var(--scg-fs-xs);line-height:1.75;
    }

    /* Navigation */
    #${APP_ID} .scg-lightbox .scg-nav{
      position:absolute;z-index:8;top:50%;transform:translateY(-50%);
      display:grid;place-items:center;width:46px;height:46px;padding:0;
      border:1px solid var(--scg-line-strong);border-radius:50%;
      background:color-mix(in srgb,var(--scg-surface) 84%,transparent);
      color:var(--scg-text);
      box-shadow:var(--scg-shadow);backdrop-filter:blur(16px);
      opacity:.78;cursor:pointer;
      transition:opacity .18s,transform .18s,background .18s,border-color .18s;
    }
    #${APP_ID} .scg-lightbox .scg-nav:hover{
      opacity:1;transform:translateY(-50%) scale(1.06);
      border-color:color-mix(in srgb,var(--scg-accent) 55%,var(--scg-line-strong));
      background:var(--scg-surface);
    }
    #${APP_ID} .scg-lightbox .scg-nav .scg-icon{width:22px;height:22px;stroke-width:2.2}
    #${APP_ID} .scg-lightbox .scg-prev{left:14px}
    #${APP_ID} .scg-lightbox .scg-next{right:362px}
    #${APP_ID} .scg-lightbox.details-hidden .scg-next{right:14px}

    /* Filmstrip footer */
    #${APP_ID} .scg-viewer-footer{
      position:relative;z-index:15;align-self:end;
      display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;
      width:calc(100% - 24px);margin:0 12px 12px;
      padding:8px 10px;
      border:1px solid color-mix(in srgb,#ffffff 15%,var(--scg-line));border-radius:var(--scg-r-lg);
      background:linear-gradient(135deg,
        color-mix(in srgb,var(--scg-surface) 62%,transparent),
        color-mix(in srgb,var(--scg-surface-2) 44%,transparent));
      box-shadow:0 12px 34px #0000005c,inset 0 1px 0 color-mix(in srgb,#ffffff 10%,transparent);
      backdrop-filter:blur(28px) saturate(160%);
      -webkit-backdrop-filter:blur(28px) saturate(160%);
      visibility:visible;will-change:opacity,transform;
      transition:opacity .28s cubic-bezier(.2,.7,.3,1),transform .28s cubic-bezier(.2,.7,.3,1),visibility 0s;
    }
    #${APP_ID} .scg-viewer-strip{
      display:flex;align-items:center;gap:7px;min-width:0;
      overflow-x:auto;padding:2px;
    }
    #${APP_ID} .scg-viewer-thumb{
      position:relative;width:56px;height:56px;flex:none;overflow:hidden;padding:0;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-md);
      background:var(--scg-surface-2);color:var(--scg-muted);
      opacity:.66;cursor:pointer;transition:opacity .14s,border-color .14s,transform .14s;
    }
    #${APP_ID} .scg-viewer-thumb:hover{opacity:.92;transform:translateY(-1px)}
    #${APP_ID} .scg-viewer-thumb.active{
      border-color:var(--scg-accent);opacity:1;
      box-shadow:0 0 0 2px color-mix(in srgb,var(--scg-accent) 34%,transparent);
    }
    #${APP_ID} .scg-viewer-thumb img{display:block;width:100%;height:100%;object-fit:cover;background:var(--scg-well)}
    #${APP_ID} .scg-viewer-thumb>span{display:grid;place-items:center;width:100%;height:100%}
    #${APP_ID} .scg-viewer-thumb em{
      position:absolute;right:3px;bottom:3px;min-width:16px;padding:1px 4px;
      border-radius:5px;background:#05070ad9;color:#e2e6ec;
      font-size:var(--scg-fs-2xs);font-style:normal;font-weight:650;text-align:center;
    }
    #${APP_ID} .scg-viewer-footer .scg-lightbox-actions{display:flex;align-items:center;gap:6px;flex:none}
    #${APP_ID} .scg-viewer-footer .scg-lightbox-actions button{
      display:inline-flex;align-items:center;justify-content:center;gap:7px;
      min-height:36px;padding:8px 11px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-md);
      background:var(--scg-surface-2);color:var(--scg-text-soft);
      font-size:var(--scg-fs-sm);font-weight:550;cursor:pointer;white-space:nowrap;
    }
    #${APP_ID} .scg-viewer-footer .scg-lightbox-actions button .scg-icon{color:var(--scg-muted)}
    #${APP_ID} .scg-viewer-footer .scg-lightbox-actions button:hover{
      background:var(--scg-surface-3);color:var(--scg-text);border-color:var(--scg-line-strong);
    }

    /* The translucent viewer chrome yields to the media after inactivity. */
    #${APP_ID} .scg-lightbox.viewer-idle .scg-viewer-topbar{
      opacity:0;visibility:hidden;pointer-events:none;transform:translate3d(0,-18px,0);
      transition:opacity .28s cubic-bezier(.4,0,1,1),transform .28s cubic-bezier(.4,0,1,1),visibility 0s .28s;
    }
    #${APP_ID} .scg-lightbox.viewer-idle .scg-viewer-footer{
      opacity:0;visibility:hidden;pointer-events:none;transform:translate3d(0,18px,0);
      transition:opacity .28s cubic-bezier(.4,0,1,1),transform .28s cubic-bezier(.4,0,1,1),visibility 0s .28s;
    }
    #${APP_ID} .scg-lightbox.viewer-idle.details-hidden .scg-nav{opacity:0;pointer-events:none}


    /* ---- 17. Responsive: wide laptop ---------------------------- */
    @media(max-width:1340px){
      #${APP_ID} .scg-header{grid-template-columns:auto minmax(0,1fr) auto;row-gap:10px}
      #${APP_ID} .scg-controls{grid-column:1/-1;order:3}
      #${APP_ID}[data-layout="masonry"] .scg-grid:not(.grouped):not(.flowing){columns:4 var(--scg-masonry-width,280px)}
      #${APP_ID}[data-layout="masonry"].compact .scg-grid:not(.grouped):not(.flowing){columns:6 var(--scg-masonry-compact-width,195px)}
      #${APP_ID} .scg-lightbox .scg-next{right:342px}
    }

    /* ---- 18. Responsive: tablet -------------------------------- */
    @media(max-width:1024px){
      #${APP_ID} .scg-plate{margin:10px 10px 0}
      #${APP_ID} .scg-header{grid-template-columns:auto minmax(0,1fr) auto;gap:10px;padding:9px 10px}
      #${APP_ID} .scg-thread-context{padding-left:10px}
      #${APP_ID} .scg-filter-panel{padding:0 10px 9px;gap:8px}
      #${APP_ID} .scg-active-facets{padding:0 10px 9px}
      #${APP_ID} .scg-viewbar{flex-basis:100%;justify-content:flex-start}
      #${APP_ID} .scg-view-summary{margin-right:auto}
      #${APP_ID} .scg-scroll{inset:10px 10px 0;padding:14px 12px 136px}
      #${APP_ID} .scg-activitybar{width:calc(100% - 20px);bottom:10px;flex-wrap:wrap}
      #${APP_ID} .scg-top{right:20px;bottom:122px}
      #${APP_ID}[data-layout="masonry"] .scg-grid:not(.grouped):not(.flowing){columns:3 var(--scg-masonry-width,280px)}
      #${APP_ID}[data-layout="masonry"].compact .scg-grid:not(.grouped):not(.flowing){columns:4 var(--scg-masonry-compact-width,195px)}
      #${APP_ID} .scg-settings-grid{grid-template-columns:1fr}
      #${APP_ID} .scg-settings-card.full{grid-column:auto}
      #${APP_ID} .scg-download-settings{grid-template-columns:repeat(2,minmax(0,1fr))}
    }

    @media(max-width:980px){
      #${APP_ID} .scg-viewer-body{display:block}
      #${APP_ID} .scg-viewer-details{
        position:absolute;z-index:9;top:10px;right:10px;bottom:10px;
        width:min(340px,calc(100vw - 76px));margin:0;
      }
      #${APP_ID} .scg-lightbox.details-hidden .scg-viewer-details{transform:translateX(calc(100% + 26px))}
      #${APP_ID} .scg-lightbox .scg-next,
      #${APP_ID} .scg-lightbox.details-hidden .scg-next{right:14px}
      #${APP_ID} .scg-viewer-footer .scg-lightbox-actions button>span{display:none}
      #${APP_ID} .scg-viewer-footer .scg-lightbox-actions button{min-width:36px;padding:8px}
      #${APP_ID} .scg-viewer-identity small{max-width:40vw}
    }

    /* ---- 19. Responsive: narrow window / phone ------------------ */
    @media(max-width:720px){
      #${APP_ID} .scg-plate{margin:8px 8px 0;border-radius:var(--scg-r-md)}
      #${APP_ID} .scg-header{grid-template-columns:auto minmax(0,1fr) auto;gap:9px;padding:8px}
      #${APP_ID} .scg-brand small{display:none}
      #${APP_ID} .scg-brand-mark{width:34px;height:34px;border-radius:11px}
      #${APP_ID} .scg-thread-context{padding-left:9px}
      #${APP_ID} .scg-thread-context h1{font-size:var(--scg-fs-md)}
      #${APP_ID} .scg-thread-context [data-source-summary]{display:none}
      #${APP_ID} .scg-controls{flex-wrap:wrap}
      #${APP_ID} .scg-search{flex-basis:100%}
      #${APP_ID} .scg-scan-actions{width:100%;justify-content:space-between;flex-wrap:wrap}
      #${APP_ID} .scg-scan-actions button{flex:1;min-width:0;padding:6px 8px}
      #${APP_ID} .scg-scan-actions [data-action="page"]>span{display:none}
      #${APP_ID} .scg-source-page{flex:1 1 120px;min-width:0}
      #${APP_ID} .scg-source-page select{min-width:0;width:100%}
      #${APP_ID} .scg-source-range{flex:1 1 170px;min-width:0}
      #${APP_ID} .scg-source-range input{flex:1;min-width:0}
      #${APP_ID} .scg-filter-panel{padding:0 8px 8px}
      #${APP_ID} .scg-active-facets{padding:0 8px 8px;flex-wrap:nowrap;overflow-x:auto}
      #${APP_ID} .scg-facet-chip{flex:none;max-width:56vw}
      #${APP_ID} .scg-filters{width:100%}
      #${APP_ID} .scg-filters button{flex:1;justify-content:center;padding:6px 8px}
      #${APP_ID} .scg-filters button b{display:none}
      #${APP_ID} .scg-viewbar{flex-wrap:wrap;gap:8px}
      #${APP_ID} .scg-view-summary{flex-basis:100%;margin:0}
      #${APP_ID} .scg-viewbar label{font-size:var(--scg-fs-2xs)}
      #${APP_ID} .scg-refine-popover{
        position:fixed;top:auto;right:8px;left:8px;bottom:auto;
        width:auto;max-height:70vh;overflow:auto;
      }
      #${APP_ID} .scg-refinebar{grid-template-columns:1fr}
      #${APP_ID} .scg-menu{position:fixed;right:8px;left:auto;width:min(280px,calc(100vw - 16px))}
      #${APP_ID} .scg-scroll{inset:8px 8px 0;padding:12px 10px 160px;border-radius:var(--scg-r-md) var(--scg-r-md) 0 0}
      #${APP_ID} .scg-top{right:14px;bottom:146px;padding:8px 12px}
      #${APP_ID} .scg-top>span{display:none}
      #${APP_ID}[data-layout="masonry"] .scg-grid:not(.grouped):not(.flowing){columns:2 var(--scg-masonry-width,280px);column-gap:8px}
      #${APP_ID}[data-layout="masonry"].compact .scg-grid:not(.grouped):not(.flowing){columns:2 var(--scg-masonry-compact-width,195px);column-gap:8px}
      #${APP_ID}[data-layout="masonry"] .scg-group-grid{columns:2 var(--scg-group-width,250px);padding:0}
      #${APP_ID}[data-layout="masonry"].compact .scg-group-grid{columns:2 var(--scg-group-compact-width,180px);padding:0}
      #${APP_ID}[data-layout="grid"] .scg-grid:not(.grouped),
      #${APP_ID}[data-layout="grid"] .scg-group-grid{grid-template-columns:repeat(auto-fill,minmax(min(100%,var(--scg-grid-min,250px)),1fr));gap:8px}
      #${APP_ID}[data-layout="grid"].compact .scg-grid:not(.grouped),
      #${APP_ID}[data-layout="grid"].compact .scg-group-grid{grid-template-columns:repeat(auto-fill,minmax(min(100%,var(--scg-grid-compact-min,180px)),1fr));gap:8px}
      #${APP_ID}[data-layout="grid"] .scg-card{height:var(--scg-grid-height,386px)}
      #${APP_ID}[data-layout="grid"].compact .scg-card{height:var(--scg-grid-compact-height,312px)}
      #${APP_ID} .scg-badge span{display:none}
      #${APP_ID} .scg-reply-group>header a>span{display:none}
      #${APP_ID} .scg-reply-identity>span:nth-of-type(3){display:none}
      #${APP_ID} .scg-activitybar{width:calc(100% - 16px);min-height:68px;bottom:8px;gap:8px;padding:9px 10px;border-radius:16px}
      #${APP_ID} .scg-activity-state{flex:1 1 100%}
      #${APP_ID} .scg-progress{flex:1 1 100%;min-width:0;max-width:none}
      #${APP_ID} .scg-progress-text{max-width:130px}
      #${APP_ID} .scg-selection-toggle>span{display:none}
      #${APP_ID}.has-selection .scg-selection-region,
      #${APP_ID}.downloading .scg-selection-region{flex-wrap:wrap;flex-basis:100%}
      #${APP_ID}.has-selection .scg-selection-region button>span{display:none}
      #${APP_ID}.has-selection .scg-selection-region .scg-primary>span,
      #${APP_ID}.downloading .scg-selection-region .scg-primary>span{display:inline}
      #${APP_ID} .scg-menu-up{left:auto;right:0}
      #${APP_ID} .scg-download-popover{position:fixed;right:8px;left:8px;bottom:76px;width:auto;max-height:62vh}
      #${APP_ID} .scg-download-job>div:first-child{align-items:flex-start;flex-direction:column;gap:3px}
      #${APP_ID} .scg-diag-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
      #${APP_ID} .scg-archive-checks{grid-template-columns:1fr}
      #${APP_ID} .scg-settings-panel{padding:8px}
      #${APP_ID} .scg-settings-dialog{width:100%;max-height:calc(100vh - 16px)}
      #${APP_ID} .scg-settings-head{padding:12px}
      #${APP_ID} .scg-settings-body{padding:10px}
      #${APP_ID} .scg-settings-foot{align-items:flex-start;flex-direction:column;gap:5px}
      #${APP_ID} .scg-viewer-topbar{width:calc(100% - 16px);margin:8px;padding:7px 8px 7px 10px;gap:9px}
      #${APP_ID} .scg-viewer-identity{gap:9px}
      #${APP_ID} .scg-viewer-identity>b{padding:4px 8px;font-size:var(--scg-fs-sm)}
      #${APP_ID} .scg-viewer-identity small{display:none}
      #${APP_ID} .scg-viewer-titleline strong{font-size:var(--scg-fs-sm)}
      #${APP_ID} .scg-viewer-resolution{padding:2px 6px;font-size:var(--scg-fs-2xs)}
      #${APP_ID} .scg-viewer-tools{gap:3px}
      #${APP_ID} .scg-viewer-tools button{min-width:34px;height:34px;padding:7px}
      #${APP_ID} .scg-viewer-zoom{gap:2px;margin-right:3px}
      #${APP_ID} .scg-viewer-zoom [data-viewer-fit]{min-width:34px;padding:6px}
      #${APP_ID} .scg-viewer-zoom [data-viewer-fit] span{display:none}
      #${APP_ID} .scg-lightbox-stage{padding:8px}
      #${APP_ID} .scg-lightbox .scg-nav{width:38px;height:38px}
      #${APP_ID} .scg-lightbox .scg-nav .scg-icon{width:19px;height:19px}
      #${APP_ID} .scg-lightbox .scg-prev{left:6px}
      #${APP_ID} .scg-lightbox .scg-next,
      #${APP_ID} .scg-lightbox.details-hidden .scg-next{right:6px}
      #${APP_ID} .scg-viewer-details{top:auto;right:8px;bottom:8px;left:8px;width:auto;max-height:56%;padding:14px;transform:none}
      #${APP_ID} .scg-lightbox.details-hidden .scg-viewer-details{transform:translateY(calc(100% + 22px))}
      #${APP_ID} .scg-viewer-footer{width:calc(100% - 16px);margin:0 8px 8px;gap:7px;padding:7px}
      #${APP_ID} .scg-viewer-thumb{width:48px;height:48px;border-radius:var(--scg-r-sm)}
      #${APP_ID} .scg-viewer-footer .scg-lightbox-actions [data-copy-current]{display:none}
      #scg-tl-launch{left:12px;bottom:12px;min-height:58px;padding:0 17px 0 10px;gap:10px}
      #scg-tl-launch .scg-launch-icon{width:38px;height:38px;border-radius:12px}
      #scg-tl-launch .scg-launch-copy strong{font-size:var(--scg-fs-md)}
      #scg-tl-launch .scg-launch-copy small{font-size:var(--scg-fs-xs)}
    }

    /* Very short windows: give the canvas the vertical budget. */
    @media(max-height:620px){
      #${APP_ID} .scg-viewer-details{max-height:none}
      #${APP_ID} .scg-viewer-shortcuts{display:none}
      #${APP_ID} .scg-viewer-thumb{width:44px;height:44px}
      #${APP_ID} .scg-download-popover{max-height:52vh}
      #${APP_ID} .scg-download-jobs{max-height:30vh}
    }

    /* ---- 20. Touch targets ------------------------------------- */
    @media(pointer:coarse){
      #${APP_ID} button,#${APP_ID} select,#${APP_ID} .scg-meta a,#${APP_ID} .scg-viewer-details-links a{min-height:44px}
      #${APP_ID} .scg-header-actions button,
      #${APP_ID} .scg-view-pagination button,
      #${APP_ID} .scg-viewer-tools button{min-width:44px}
      #${APP_ID} .scg-select,#${APP_ID} .scg-select span{width:36px;height:36px}
      #${APP_ID} .scg-select{opacity:1}
      #${APP_ID} .scg-viewer-thumb{min-height:0}
      #${APP_ID} [data-tooltip]:hover:after{display:none}
      #${APP_ID} .scg-scan-warning{
        position:static;width:auto;height:auto;padding:5px 8px;margin:0;
        overflow:visible;clip:auto;white-space:normal;
        color:var(--scg-muted);font-size:var(--scg-fs-xs);line-height:1.35;
      }
    }

    /* ---- 21. Reduced motion ------------------------------------ */
    @media(prefers-reduced-motion:reduce){
      #${APP_ID},#${APP_ID} *,#${APP_ID} *:before,#${APP_ID} *:after,
      #scg-tl-launch,#scg-tl-launch *,#scg-tl-toast{
        animation-duration:.001ms !important;
        animation-iteration-count:1 !important;
        transition-duration:.001ms !important;
        transition-delay:0s !important;
      }
      #${APP_ID} .scg-scroll{scroll-behavior:auto}
      #${APP_ID} .scg-viewer-loading i,
      #${APP_ID} .scg-lightbox-stage.viewer-buffering:before{
        animation:none !important;border-color:var(--scg-accent);opacity:.72;
      }
      #${APP_ID} .scg-card:hover,#${APP_ID} .scg-viewer-thumb:hover,
      #scg-tl-launch:hover,#${APP_ID} .scg-embed-placeholder button:hover{transform:none}
      #${APP_ID} .scg-lightbox .scg-nav:hover{transform:translateY(-50%)}
    }

    /* ---- 22. Forced colors ------------------------------------- */
    @media(forced-colors:active){
      #${APP_ID} .scg-card,#${APP_ID} .scg-plate,#${APP_ID} .scg-activitybar,
      #${APP_ID} .scg-menu,#${APP_ID} .scg-refine-popover,#${APP_ID} .scg-download-popover{border:1px solid CanvasText}
      #${APP_ID} .scg-icon{stroke:CanvasText}
    }

  `;
  document.head.appendChild(style);
  restoreItemIndex();

  const launch = document.createElement('button');
  launch.id = 'scg-tl-launch';
  launch.innerHTML = `${iconWell('gallery', 'scg-launch-icon')}<span class="scg-launch-copy"><strong>Open Timeline</strong><small data-launch-detail>Media browser · v${APP_VERSION}</small></span>`;
  launch.setAttribute('aria-label', 'Open SimpCity Thread Gallery Timeline');
  document.body.appendChild(launch);

  function refreshLaunchButton() {
    const count = state.items.filter(isMediaItem).length;
    const detail = launch.querySelector('[data-launch-detail]');
    if (detail) detail.textContent = count ? `Media browser · ${count.toLocaleString()} indexed` : `Media browser · v${APP_VERSION}`;
    launch.setAttribute('aria-label', count ? `Open SimpCity Thread Gallery Timeline, ${count} media items indexed` : 'Open SimpCity Thread Gallery Timeline');
  }
  refreshLaunchButton();

  const app = document.createElement('section');
  app.id = APP_ID;
  app.setAttribute('data-ui', 'gallery');
  app.setAttribute('role', 'dialog');
  app.setAttribute('aria-modal', 'true');
  app.setAttribute('aria-label', 'SimpCity Thread Gallery Timeline');
  app.innerHTML = `
    <div class="scg-plate scg-glass">
      <header class="scg-header">
        <div class="scg-brand">
          <div class="scg-brand-mark" aria-hidden="true">${icon('gallery')}</div>
          <div><b>Timeline</b><small>Media browser</small></div>
        </div>
        <div class="scg-thread-context">
          <h1 data-thread-title>Thread gallery</h1>
          <div><span data-thread-meta>Page 1</span><span data-source-summary>Current page</span></div>
        </div>
        <nav class="scg-controls" aria-label="Search and scanning">
          <label class="scg-search">${iconWell('search')}<input data-search type="search" placeholder="Search author, caption, host or text" aria-label="Search indexed media"></label>
          <div class="scg-scan-actions" role="group" aria-label="Scan sources">
            <button data-action="page" data-tooltip="Index the page you are on">${iconWell('page')}<span>This page</span></button>
            <span class="scg-source-page"><select data-source-page aria-label="Thread page to load"></select><button data-action="load-source-page" data-tooltip="Load the selected thread page" aria-label="Load the selected thread page">${iconWell('download')}</button></span>
            <span class="scg-source-range"><input data-scan-range="start" type="number" min="1" value="1" aria-label="First thread page"><span>–</span><input data-scan-range="end" type="number" min="1" value="1" aria-label="Last thread page"><button data-action="scan-range" data-tooltip="Scan this page range" aria-label="Scan selected page range">${iconWell('scan')}</button></span>
            <button data-action="scan-new" data-tooltip="Scan only pages newer than the last successful scan">${iconWell('download')}<span>New pages</span></button>
            <button class="scg-scan-thread-danger scg-tip-end" data-action="thread" data-tooltip="${escapeHtml(SCAN_WARNING_TEXT)}" aria-describedby="scg-tl-thread-scan-warning">${iconWell('scan')}<span>Scan thread</span></button>
          </div>
          <span class="scg-scan-warning" id="scg-tl-thread-scan-warning" role="note">${escapeHtml(SCAN_WARNING_TEXT)}</span>
        </nav>
        <div class="scg-header-actions">
          <button data-action="filters-toggle" data-tooltip="Hide filters" aria-expanded="true" aria-controls="scg-tl-filter-panel" aria-label="Hide filters">${iconWell('chevron')}<span>Filters</span></button>
          <span class="scg-header-rule" aria-hidden="true"></span>
          <button data-action="settings" data-tooltip="Settings and diagnostics" aria-label="Settings and diagnostics">${iconWell('settings')}<span>Settings</span></button>
          <span class="scg-menu-wrap">
            <button data-action="overflow" class="scg-tip-end" data-tooltip="More options" aria-label="More options" aria-haspopup="true" aria-expanded="false" aria-controls="scg-tl-overflow-menu">${iconWell('more')}<span>More</span></button>
            <div class="scg-menu" id="scg-tl-overflow-menu" role="menu" aria-label="More options">
              <div class="scg-menu-label" role="presentation">Appearance</div>
              <button data-action="theme" role="menuitem">${iconWell('palette')}<span>Theme</span></button>
              <button data-action="density" role="menuitem">${iconWell('layout')}<span>Compact cards</span></button>
              <button data-action="safe-mode" role="menuitem">${iconWell('image')}<span>Blur media</span></button>
              <div class="scg-menu-sep" role="separator"></div>
              <div class="scg-menu-label" role="presentation">Export media list</div>
              <button data-action="copy-urls" role="menuitem">${iconWell('copy')}<span>Copy URLs</span></button>
              <button data-action="export-urls-txt" role="menuitem">${iconWell('download')}<span>Save URL list (.txt)</span></button>
              <button data-action="export-urls-json" role="menuitem">${iconWell('download')}<span>Save URL list (.json)</span></button>
              <button data-action="export-yt-dlp-archive" role="menuitem">${iconWell('download')}<span>Save yt-dlp archive</span></button>
              <div class="scg-menu-sep" role="separator"></div>
              <div class="scg-menu-label" role="presentation">Help</div>
              <button data-action="shortcuts" role="menuitem">${iconWell('keyboard')}<span>Keyboard shortcuts</span></button>
            </div>
          </span>
          <button class="scg-close scg-tip-end" data-tooltip="Close gallery (Esc)" aria-label="Close gallery">${iconWell('close', 'scg-icon-well-danger')}</button>
        </div>
      </header>
      <section class="scg-filter-panel" id="scg-tl-filter-panel" aria-label="Filters and view options">
        <div class="scg-filters" role="group" aria-label="Filter by media type">
          <button class="active" data-filter="all" aria-pressed="true">${icon('gallery')}<b>All</b><span aria-hidden="true">0</span></button>
          <button data-filter="image" aria-pressed="false">${icon('image')}<b>Images</b><span aria-hidden="true">0</span></button>
          <button data-filter="video" aria-pressed="false">${icon('video')}<b>Videos</b><span aria-hidden="true">0</span></button>
          <button data-filter="link" aria-pressed="false">${icon('link')}<b>Links</b><span aria-hidden="true">0</span></button>
          <button data-filter="text" aria-pressed="false">${icon('text')}<b>Text</b><span aria-hidden="true">0</span></button>
        </div>
        <div class="scg-viewbar">
          <span class="scg-view-summary" role="status" aria-live="polite">0 matched</span>
          <span class="scg-reply-group-actions" role="group" aria-label="Reply group visibility">
            <button data-action="collapse-all" data-tooltip="Collapse all reply groups in the filtered results">${iconWell('chevron')}<span>Collapse All</span></button>
            <button data-action="expand-all" data-tooltip="Expand all reply groups in the filtered results">${iconWell('chevron')}<span>Expand All</span></button>
          </span>
          <label class="scg-layout-select" data-tooltip="Gallery layout. L cycles through them.">Layout <select data-setting-layout aria-label="Gallery layout">${layoutOptionsMarkup()}</select></label>
          <span class="scg-refine-wrap">
            <button class="scg-refine-trigger" data-action="refine-toggle" aria-haspopup="true" aria-expanded="false" aria-controls="scg-tl-refine-popover">${iconWell('sliders')}<span>Refine</span><em data-refine-count hidden>0</em></button>
            <div class="scg-refine-popover" id="scg-tl-refine-popover" role="group" aria-label="Refine results">
              <h2>Refine results</h2>
              <div class="scg-refinebar">
                <label>Sort <select data-sort>${Object.entries(SORT_LABELS).map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join('')}</select></label>
                <label>Group <select data-group-by><option value="none">Individual cards</option><option value="reply">Group by reply</option></select></label>
                <label>Downloads <select data-download-state>${DOWNLOAD_STATES.map(value => `<option value="${value}">${escapeHtml(DOWNLOAD_STATE_LABELS[value])}</option>`).join('')}</select></label>
                <label>Resolution <select data-resolution-filter>${RESOLUTION_FILTERS.map(value => `<option value="${value}">${escapeHtml(RESOLUTION_LABELS[value])}</option>`).join('')}</select></label>
                <label>Author <select data-author-filter></select></label>
                <label>Host <select data-host-filter></select></label>
                <label>Per view <select data-page-size>${VIEW_PAGE_SIZES.map(size => `<option value="${size}">${viewPageSizeLabel(size)}</option>`).join('')}</select></label>
                <button data-selected-only aria-pressed="false">${iconWell('select')}<span>Selected only</span></button>
                <button data-action="reset-filters">${iconWell('reset')}<span>Reset all</span></button>
              </div>
            </div>
          </span>
          <span class="scg-view-pagination" role="group" aria-label="Result pages">
            <button data-action="view-prev" class="scg-tip-end" data-tooltip="Previous result page" aria-label="Previous result page">${iconWell('previous')}<span>Previous</span></button>
            <select data-view-page aria-label="Gallery result page"></select>
            <button data-action="view-next" class="scg-tip-end" data-tooltip="Next result page" aria-label="Next result page">${iconWell('next')}<span>Next</span></button>
          </span>
          <label class="scg-size-control"><span>Media size</span><input data-card-scale type="range" min="70" max="160" step="5" value="100" aria-label="Image and video card size"><output data-card-scale-value>100%</output></label>
        </div>
      </section>
      <div class="scg-active-facets" data-active-facets role="group" aria-label="Active filters" hidden></div>
    </div>
    <div class="scg-stage">
      <main class="scg-scroll" tabindex="-1"><div class="scg-grid"></div></main>
      <footer class="scg-bulkbar scg-activitybar scg-glass" aria-label="Activity, selection and downloads">
        <div class="scg-activity-state"><i aria-hidden="true"></i><div><b class="scg-status">Ready</b><span data-activity-detail>Open a page or scan the thread</span></div></div>
        <span class="scg-menu-wrap scg-select-wrap">
          <button class="scg-selection-toggle scg-tip-up" data-action="select-menu" data-tooltip="Bulk selection" aria-haspopup="true" aria-expanded="false" aria-controls="scg-tl-select-menu">${iconWell('select')}<span>Select</span></button>
          <div class="scg-menu scg-menu-up" id="scg-tl-select-menu" role="menu" aria-label="Bulk selection">
            <div class="scg-menu-label" role="presentation">Select</div>
            <button data-action="select-visible" role="menuitem">${iconWell('select')}<span>Everything in this view (A)</span></button>
            <button data-action="select-matching" role="menuitem">${iconWell('filter')}<span>All matching current filters</span></button>
            <button data-action="select-images" role="menuitem">${iconWell('image')}<span>All indexed images</span></button>
            <button data-action="select-videos" role="menuitem">${iconWell('video')}<span>All indexed videos</span></button>
            <div class="scg-menu-sep" role="separator"></div>
            <button data-action="clear-selection" role="menuitem" disabled>${iconWell('clear')}<span>Clear selection (Esc)</span></button>
          </div>
        </span>
        <div class="scg-selection-region" role="group" aria-label="Current selection">
          <span class="scg-selected-count" role="status" aria-live="polite">0 selected</span>
          <button class="scg-tip-up" data-action="clear-selection" data-tooltip="Clear the selection" disabled>${iconWell('clear')}<span>Clear</span></button>
          <button class="scg-primary scg-tip-up scg-tip-end" data-action="download-selected" disabled>${iconWell('archive', 'scg-icon-well-primary')}<span>Download ZIP (0)</span></button>
        </div>
        <div class="scg-progress">
          <button class="scg-progress-summary scg-tip-up scg-tip-end" data-action="download-details" data-tooltip="Open the download queue" aria-expanded="false" aria-controls="scg-tl-download-queue"><span class="scg-progress-track"><span class="scg-progress-fill"></span></span><span class="scg-progress-text">Downloads idle</span></button>
          <aside class="scg-download-popover" id="scg-tl-download-queue" aria-label="Download queue">
            <header><b>Download queue</b><div><button data-action="retry-failed" data-tooltip="Queue the failed and unverified files again" aria-label="Retry failed downloads" hidden>${iconWell('reset')}<span>Retry failed</span></button><button data-action="clear-download-history" data-tooltip="Forget saved-file markers" aria-label="Clear download history">${iconWell('history')}<span>Clear history</span></button><button data-action="close-download-details" aria-label="Close the download queue">${iconWell('close')}<span>Close</span></button></div></header>
            <div class="scg-download-overall" role="status" aria-live="polite">No downloads yet.</div>
            <div class="scg-download-jobs"></div>
          </aside>
        </div>
      </footer>
      <button class="scg-top scg-tip-up scg-tip-end" data-tooltip="Back to the top of the gallery">${iconWell('up')}<span>Top</span></button>
    </div>
    <div class="scg-lightbox" role="dialog" aria-modal="true" aria-label="Media viewer" tabindex="-1"></div>
    <div class="scg-settings-panel" role="dialog" aria-modal="true" aria-label="Settings and diagnostics">
      <section class="scg-settings-dialog" tabindex="-1">
        <header class="scg-settings-head"><div>${icon('settings')}<div><h2>Settings and diagnostics</h2><p>Local preferences, portability and troubleshooting. Nothing leaves this device.</p></div></div><button class="scg-settings-close" data-action="close-settings" aria-label="Close settings">${iconWell('close', 'scg-icon-well-danger')}</button></header>
        <div class="scg-settings-body">
          <div class="scg-settings-search">${icon('search')}<input type="search" data-settings-search placeholder="Search settings" aria-label="Search settings" aria-describedby="scg-tl-settings-empty"><button type="button" data-action="clear-settings-search" aria-label="Clear the settings search">${icon('close')}</button></div>
          <p class="scg-settings-empty" id="scg-tl-settings-empty" data-settings-empty role="status" hidden>No settings match that search.</p>
          <div class="scg-settings-grid">
          <section class="scg-settings-card"><h3>${icon('palette')} Appearance</h3><p>Choose the gallery layout, theme, card density and remembered filter state. Masonry renders only what is on screen, which is what makes it suitable for very large threads. The uniform grid and grouping by reply use the paged renderer instead, so Per view applies again.</p><div class="scg-setting-fields"><label>Gallery layout<select data-setting-layout>${layoutOptionsMarkup()}</select></label><label>Theme<select data-setting-theme><option value="dark">Darkroom (dark)</option><option value="light">Daylight (light)</option></select></label><label>Accent<select data-setting-accent><option value="blue">Blue</option><option value="indigo">Indigo</option><option value="amber">Amber</option><option value="green">Green</option><option value="rose">Rose</option><option value="neutral">Neutral</option></select></label><label>Card density<select data-setting-density><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label><label class="scg-setting-size">Media card size <span><input data-card-scale type="range" min="70" max="160" step="5" value="100" aria-label="Image and video card size in masonry and grid layouts"><output data-card-scale-value>100%</output></span></label></div><label class="scg-settings-check"><input type="checkbox" data-setting-filters-collapsed><span>Keep filters collapsed</span></label><label class="scg-settings-check"><input type="checkbox" data-setting-safe-mode><span>Blur media previews until safe mode is turned off</span></label></section>
          <section class="scg-settings-card full"><h3>${icon('archive')} Archive and downloads <span class="scg-settings-version">v${APP_VERSION}</span></h3><p>Control download throughput, ZIP part limits and archive organization. Changes apply to the next queue.</p><div class="scg-setting-fields scg-download-settings"><label>ZIP folders<select data-setting-archive-layout><option value="page-author">Page / author</option><option value="page">Page only</option><option value="reply">Page / reply</option><option value="flat">Flat archive</option></select></label><label>Simultaneous files<select data-setting-download-concurrency><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option></select></label><label>Maximum part size<select data-setting-zip-part-size><option value="100">100 MB</option><option value="300">300 MB</option><option value="600">600 MB</option><option value="1000">1,000 MB</option></select></label><label>Files per part<select data-setting-zip-part-files><option value="24">24</option><option value="50">50</option><option value="100">100</option></select></label></div><div class="scg-archive-checks"><label class="scg-settings-check"><input type="checkbox" data-setting-include-manifest><span>Add manifest.csv with source URL, reply, author, validation method and CRC32.</span></label><label class="scg-settings-check"><input type="checkbox" data-setting-dedupe-content><span>Merge byte-identical reposts using verified size + CRC32 while preserving download history and provenance.</span></label></div></section>
          <section class="scg-settings-card"><h3>${icon('scan')} Scan and background work</h3><p>Large scans index HTML from every requested page and can use substantial memory. Optional embed posters cost one lazy request per visible host card.</p><label class="scg-settings-check"><input type="checkbox" data-setting-warn-large-scan><span>Warn before scanning ${LARGE_THREAD_WARNING_PAGES} or more pages</span></label><label class="scg-settings-check"><input type="checkbox" data-setting-embed-posters><span>Fetch embed poster images lazily</span></label><label class="scg-settings-check"><input type="checkbox" data-setting-completion-notifications><span>Desktop notification when a long scan or ZIP queue finishes</span></label></section>
          <section class="scg-settings-card"><h3>${icon('keyboard')} Keyboard shortcuts</h3><p>Click a chord and press the keys you want. Escape cancels a recording. Shortcuts never fire while you are typing in a field, and the media viewer's own keys are fixed.</p><div class="scg-shortcut-rows">${SHORTCUT_ACTIONS.map(action => `<div class="scg-shortcut-row"><span>${escapeHtml(action.label)}</span><button type="button" class="scg-shortcut-key" data-shortcut="${action.id}" aria-label="Change the shortcut for ${escapeHtml(action.label)}"></button></div>`).join('')}</div><div class="scg-settings-actions" style="margin-top:10px"><button data-action="reset-shortcuts">${iconWell('reset')}<span>Restore defaults</span></button></div></section>
          <section class="scg-settings-card"><h3>${icon('filter')} Ignore list</h3><p>Media whose URL contains any of these fragments is never indexed, so it costs no card and no memory. One fragment per line or separated by commas. Editing this drops anything already indexed that matches.</p><textarea class="scg-block-patterns" data-setting-block-patterns rows="4" spellcheck="false" placeholder="signature.example.com&#10;/avatars/&#10;banner-"></textarea><div class="scg-block-summary" data-block-summary role="status"></div></section>
          <section class="scg-settings-card"><h3>${icon('info')} Storage</h3><p>Preferences, selections, verified history, and up to six 420 KB thread indexes are stored outside the website. Pre-v0.7.3 history remains visible as LEGACY but will not skip a new download.</p><div class="scg-storage-note">${icon('select')}<span><b data-diag-storage></b><br><span data-diag-migration></span></span></div></section>
          <section class="scg-settings-card"><h3>${icon('upload')} Backup and restore</h3><p>Export preferences as JSON or restore a previous backup.</p><label class="scg-settings-check"><input type="checkbox" data-export-history><span>Include download history. This contains thread and media references.</span></label><div class="scg-settings-actions"><button data-action="export-settings">${iconWell('download')}<span>Export</span></button><button data-action="import-settings">${iconWell('upload')}<span>Import</span></button><input class="scg-settings-file" data-settings-file type="file" accept="application/json,.json"></div></section>
          <section class="scg-settings-card full"><h3>${icon('info')} Diagnostics</h3><p>A local, URL-scrubbed summary for troubleshooting. Nothing is transmitted automatically.</p><div class="scg-diag-grid"><div class="scg-diag-stat"><span>Version</span><b data-diag-version></b></div><div class="scg-diag-stat"><span>Thread pages</span><b data-diag-pages></b></div><div class="scg-diag-stat"><span>Indexed items</span><b data-diag-items></b></div><div class="scg-diag-stat"><span>Download history</span><b data-diag-history></b></div><div class="scg-diag-stat"><span>Resolver failures</span><b data-diag-resolvers></b></div><div class="scg-diag-stat"><span>Download failures</span><b data-diag-downloads></b></div><div class="scg-diag-stat"><span>Scan failures</span><b data-diag-scans></b></div><div class="scg-diag-stat"><span>Storage</span><b data-diag-storage></b></div></div><div class="scg-settings-actions" style="margin-top:10px"><button data-action="copy-debug">${iconWell('copy')}<span>Copy debug report</span></button><button data-action="clear-diagnostics">${iconWell('reset')}<span>Clear diagnostics</span></button></div></section>
          <section class="scg-settings-card"><h3>${icon('reset')} Reset</h3><p>Reset visual preferences, or also forget SAVED download markers.</p><div class="scg-settings-actions"><button data-action="reset-preferences">${iconWell('reset')}<span>Reset preferences</span></button><button class="danger" data-action="reset-everything">${iconWell('trash', 'scg-icon-well-danger')}<span>Reset preferences + history</span></button></div></section>
          <section class="scg-settings-card"><h3>${icon('info')} Cross-host permission</h3><p>The wildcard connection permission is intentionally retained for media hosted on changing third-party domains.</p><div class="scg-permission-note">The script only requests URLs discovered in thread replies or known resolver endpoints. It contains no analytics or telemetry.</div></section>
        </div></div>
        <footer class="scg-settings-foot"><span>SimpCity Thread Gallery Timeline <b>v${APP_VERSION}</b></span><span>Settings remain on this device unless you export them.</span></footer>
      </section>
    </div>
    <div class="scg-confirm-panel" role="dialog" aria-modal="true" aria-labelledby="scg-tl-confirm-title"><section class="scg-confirm-dialog"><div class="scg-confirm-icon">${icon('info')}</div><h2 id="scg-tl-confirm-title" data-confirm-title>Confirm action</h2><p data-confirm-message></p><label class="scg-confirm-preference" data-confirm-preference hidden><input type="checkbox"><span></span></label><div><button data-confirm-cancel>${iconWell('close')}<span>Cancel</span></button><button class="scg-confirm-accept" data-confirm-accept>${iconWell('check', 'scg-icon-well-primary')}<span>Continue</span></button></div></section></div>`;
  document.body.appendChild(app);
  const toast = document.createElement('div');
  toast.id = 'scg-tl-toast';
  toast.className = 'scg-toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.setAttribute('aria-atomic', 'true');
  document.body.appendChild(toast);
  applyShellState();

  function openApp() {
    app.classList.add('open');
    document.documentElement.style.overflow = 'hidden';
    applyShellState();
    requestAnimationFrame(() => app.querySelector('[data-search]')?.focus({ preventScroll: true }));
    if (!state.items.length) scanCurrentPage();
    else render();
    if (migratedLegacyStorage && !openApp.migrationNotified) {
      openApp.migrationNotified = true;
      notify('Your previous gallery settings were moved into private userscript storage.', 5200);
    }
    if (state.itemIndexTruncated && !openApp.indexNoticeShown) {
      openApp.indexNoticeShown = true;
      notify('The cached thread index reached its 420 KB budget. Media was prioritized; rescan to rebuild anything omitted.', 7200);
    }
  }

  function closeApp() {
    closeSettingsPanel();
    closeDisclosures();
    app.classList.remove('open');
    document.documentElement.style.overflow = '';
    state.cancelScan = true;
    state.scanCanceling = state.scanning;
    state.scanController?.abort();
    closeLightbox();
    releaseRenderedMedia();
    state.renderedItems = [];
    document.getElementById('scg-tl-launch')?.focus({ preventScroll: true });
  }

  const controllers = Object.freeze({
    scanner: Object.freeze({ current: scanCurrentPage, page: scanSpecificPage, thread: scanThread, newPages: scanNewPages, range: scanPageRange }),
    gallery: Object.freeze({ open: openApp, close: closeApp, render }),
    viewer: Object.freeze({ open: openLightbox, close: closeLightbox, navigate: navigateLightbox }),
    downloads: Object.freeze({ one: downloadMedia, bulk: bulkDownload }),
    settings: Object.freeze({ open: openSettingsPanel, close: closeSettingsPanel }),
  });

  launch.onclick = controllers.gallery.open;
  app.querySelector('.scg-close').onclick = controllers.gallery.close;
  app.querySelectorAll('[data-filter]').forEach(btn => btn.onclick = () => {
    commitState({ filter: btn.dataset.filter, viewPage: 1 }, { persist: true });
  });
  let searchTimer;
  app.querySelector('[data-search]').oninput = event => {
    clearTimeout(searchTimer);
    const value = event.target.value;
    searchTimer = setTimeout(() => commitState({ query: value, viewPage: 1 }), 140);
  };
  app.querySelector('[data-action="page"]').onclick = () => state.scanning ? notify('Cancel the current scan first.') : controllers.scanner.current();
  app.querySelector('[data-action="load-source-page"]').onclick = () => controllers.scanner.page(app.querySelector('[data-source-page]').value);
  app.querySelector('[data-action="scan-new"]').onclick = () => controllers.scanner.newPages();
  app.querySelector('[data-action="scan-range"]').onclick = () => controllers.scanner.range(
    app.querySelector('[data-scan-range="start"]').value,
    app.querySelector('[data-scan-range="end"]').value,
  );
  app.querySelector('[data-action="thread"]').onclick = () => controllers.scanner.thread();
  app.querySelector('[data-sort]').onchange = event => commitState({ sort: event.target.value, viewPage: 1 }, { persist: true });
  app.querySelector('[data-author-filter]').onchange = event => commitState({ authorFilter: event.target.value, viewPage: 1 });
  app.querySelector('[data-host-filter]').onchange = event => commitState({ hostFilter: event.target.value, viewPage: 1 });
  app.querySelector('[data-group-by]').onchange = event => commitState({ groupBy: event.target.value, viewPage: 1 }, { persist: true });
  app.querySelector('[data-download-state]').onchange = event => {
    commitState({ downloadState: DOWNLOAD_STATES.includes(event.target.value) ? event.target.value : 'all', viewPage: 1 }, { persist: true });
  };
  app.querySelector('[data-resolution-filter]').onchange = event => {
    commitState({ resolutionFilter: RESOLUTION_FILTERS.includes(event.target.value) ? event.target.value : 'all', viewPage: 1 }, { persist: true });
  };
  app.querySelector('[data-selected-only]').onclick = () => commitState({ selectedOnly: !state.selectedOnly, viewPage: 1 });
  app.querySelector('[data-action="collapse-all"]').onclick = () => {
    if (setReplyGroupsCollapsed(visibleItems(), true)) render();
  };
  app.querySelector('[data-action="expand-all"]').onclick = () => {
    if (setReplyGroupsCollapsed(visibleItems(), false)) render();
  };
  // One delegated handler: the bar is rebuilt on every render, so per-chip
  // listeners would have to be rebound with it.
  app.querySelector('[data-active-facets]').onclick = event => {
    const chip = event.target.closest('[data-clear-facet]');
    if (!chip) return;
    const patch = facetClearPatch(chip.dataset.clearFacet);
    if (!patch) return;
    if ('query' in patch) app.querySelector('[data-search]').value = patch.query;
    commitState({ ...patch, viewPage: 1 }, { persist: true });
  };
  app.querySelector('[data-action="reset-filters"]').onclick = () => {
    app.querySelector('[data-search]').value = '';
    commitState({
      filter: 'all', query: '', authorFilter: 'all', hostFilter: 'all', selectedOnly: false,
      downloadState: 'all', resolutionFilter: 'all', sort: 'thread-asc', groupBy: 'none', viewPage: 1,
    }, { persist: true });
  };
  app.querySelector('[data-action="filters-toggle"]').onclick = () => {
    commitState({ filtersCollapsed: !state.filtersCollapsed }, { persist: true, shellOnly: true });
  };
  app.querySelector('[data-action="density"]').onclick = () => {
    commitState({ compact: !state.compact }, { persist: true, shellOnly: true });
  };
  app.querySelector('[data-action="theme"]').onclick = () => {
    const current = Math.max(0, THEME_MODES.indexOf(state.theme));
    commitState({ theme: THEME_MODES[(current + 1) % THEME_MODES.length] }, { persist: true, shellOnly: true });
  };
  app.querySelector('[data-action="safe-mode"]').onclick = () => {
    closeDisclosures();
    commitState({ safeMode: !state.safeMode }, { persist: true, shellOnly: true });
  };
  const overflowTrigger = app.querySelector('[data-action="overflow"]');
  const overflowMenu = app.querySelector('.scg-menu');
  const refineTrigger = app.querySelector('[data-action="refine-toggle"]');
  const refinePopover = app.querySelector('.scg-refine-popover');
  const selectTrigger = app.querySelector('[data-action="select-menu"]');
  const selectMenu = app.querySelector('.scg-menu-up');
  selectTrigger.onclick = event => {
    event.stopPropagation();
    toggleDisclosure(selectTrigger, selectMenu);
  };
  overflowTrigger.onclick = event => {
    event.stopPropagation();
    toggleDisclosure(overflowTrigger, overflowMenu);
  };
  refineTrigger.onclick = event => {
    event.stopPropagation();
    toggleDisclosure(refineTrigger, refinePopover);
  };
  document.addEventListener('pointerdown', event => {
    if (!app.classList.contains('open')) return;
    if (event.target.closest?.('.scg-menu-wrap, .scg-refine-wrap')) return;
    closeDisclosures();
  }, true);
  app.querySelector('[data-action="shortcuts"]').onclick = () => notify(shortcutHelpText(), 11000);
  app.querySelector('[data-action="shortcuts"]').addEventListener('click', () => closeDisclosures());
  app.querySelector('[data-action="copy-urls"]').onclick = () => { closeDisclosures(); copyMediaUrls(); };
  app.querySelector('[data-action="export-urls-txt"]').onclick = () => { closeDisclosures(); exportMediaUrls('txt'); };
  app.querySelector('[data-action="export-urls-json"]').onclick = () => { closeDisclosures(); exportMediaUrls('json'); };
  app.querySelector('[data-action="export-yt-dlp-archive"]').onclick = () => { closeDisclosures(); exportYtDlpArchive(); };
  app.querySelector('[data-action="settings"]').onclick = () => {
    closeDisclosures();
    controllers.settings.open();
  };
  app.querySelector('[data-action="close-settings"]').onclick = controllers.settings.close;
  app.querySelector('[data-setting-accent]').onchange = event => {
    commitState({ accent: ACCENT_MODES.includes(event.target.value) ? event.target.value : DEFAULT_SETTINGS.accent }, { persist: true, shellOnly: true });
  };
  app.querySelector('[data-setting-theme]').onchange = event => {
    commitState({ theme: THEME_MODES.includes(event.target.value) ? event.target.value : DEFAULT_SETTINGS.theme }, { persist: true, shellOnly: true });
  };
  app.querySelector('[data-setting-density]').onchange = event => {
    commitState({ compact: event.target.value === 'compact' }, { persist: true, shellOnly: true });
  };
  // The plate and the settings sheet share the picker, so they share a handler.
  app.querySelectorAll('[data-setting-layout]').forEach(select => {
    select.onchange = event => {
      setLayoutMode(LAYOUT_MODES.includes(event.target.value) ? event.target.value : DEFAULT_SETTINGS.layoutMode);
    };
  });
  app.querySelector('[data-setting-filters-collapsed]').onchange = event => {
    commitState({ filtersCollapsed: event.target.checked }, { persist: true, shellOnly: true });
  };
  app.querySelector('[data-setting-archive-layout]').onchange = event => {
    commitState({ archiveLayout: ['flat', 'page', 'page-author', 'reply'].includes(event.target.value) ? event.target.value : DEFAULT_SETTINGS.archiveLayout }, { persist: true, shellOnly: true });
  };
  app.querySelector('[data-setting-download-concurrency]').onchange = event => {
    commitState({ downloadConcurrency: [1, 2, 3, 4].includes(Number(event.target.value)) ? Number(event.target.value) : DEFAULT_SETTINGS.downloadConcurrency }, { persist: true, shellOnly: true });
  };
  app.querySelector('[data-setting-zip-part-size]').onchange = event => {
    commitState({ zipPartSizeMb: [100, 300, 600, 1000].includes(Number(event.target.value)) ? Number(event.target.value) : DEFAULT_SETTINGS.zipPartSizeMb }, { persist: true, shellOnly: true });
  };
  app.querySelector('[data-setting-zip-part-files]').onchange = event => {
    commitState({ zipPartMaxFiles: [24, 50, 100].includes(Number(event.target.value)) ? Number(event.target.value) : DEFAULT_SETTINGS.zipPartMaxFiles }, { persist: true, shellOnly: true });
  };
  app.querySelector('[data-setting-include-manifest]').onchange = event => {
    commitState({ includeManifest: event.target.checked }, { persist: true, shellOnly: true });
  };
  app.querySelector('[data-setting-dedupe-content]').onchange = event => {
    commitState({ dedupeContent: event.target.checked }, { persist: true, shellOnly: true });
  };
  app.querySelector('[data-setting-warn-large-scan]').onchange = event => {
    commitState({ warnLargeThreadScan: event.target.checked }, { persist: true, shellOnly: true });
  };
  app.querySelector('[data-setting-embed-posters]').onchange = event => {
    commitState({ embedPosters: event.target.checked }, { persist: true });
  };
  app.querySelector('[data-setting-completion-notifications]').onchange = async event => {
    event.target.checked = await setCompletionNotifications(event.target.checked);
  };
  app.querySelector('[data-setting-safe-mode]').onchange = event => {
    commitState({ safeMode: event.target.checked }, { persist: true, shellOnly: true });
  };
  app.querySelector('.scg-settings-panel').onclick = event => {
    if (event.target.classList.contains('scg-settings-panel')) controllers.settings.close();
  };
  const settingsSearch = app.querySelector('[data-settings-search]');
  settingsSearch.oninput = () => applySettingsSearch(settingsSearch.value);
  app.querySelector('[data-action="clear-settings-search"]').onclick = () => {
    settingsSearch.value = '';
    applySettingsSearch('');
    settingsSearch.focus();
  };
  const blockPatternsField = app.querySelector('[data-setting-block-patterns]');
  blockPatternsField.onchange = () => {
    const previousPatterns = blockPatternList(state.blockPatterns);
    commitState({ blockPatterns: String(blockPatternsField.value || '').slice(0, 2000) }, { persist: true, shellOnly: true });
    const nextPatterns = blockPatternList(state.blockPatterns);
    const relaxed = previousPatterns.some(pattern => !nextPatterns.includes(pattern));
    const removed = purgeBlockedItems();
    if (relaxed) storage.remove(itemIndexStorageKey());
    else persistItemIndex();
    render();
    notify(relaxed
      ? 'Ignore list relaxed. Rescan to restore items that were previously excluded.'
      : removed
      ? `Ignore list updated. ${removed} indexed ${removed === 1 ? 'item was' : 'items were'} dropped.`
      : 'Ignore list updated. It applies to everything indexed from now on.');
  };
  app.querySelectorAll('[data-shortcut]').forEach(button => {
    button.onclick = () => recordShortcut(button);
  });
  app.querySelector('[data-action="reset-shortcuts"]').onclick = () => {
    commitState({ shortcuts: normalizedShortcuts(DEFAULT_SHORTCUTS) }, { persist: true, shellOnly: true });
    notify('Keyboard shortcuts restored to their defaults.');
  };
  app.querySelector('[data-action="export-settings"]').onclick = () => exportSettings(app.querySelector('[data-export-history]').checked);
  const settingsFile = app.querySelector('[data-settings-file]');
  app.querySelector('[data-action="import-settings"]').onclick = () => settingsFile.click();
  settingsFile.onchange = async event => {
    await importSettings(event.target.files?.[0]);
    event.target.value = '';
  };
  app.querySelector('[data-action="copy-debug"]').onclick = () => copyText(JSON.stringify(buildDebugReport(), null, 2), 'Debug report copied.');
  app.querySelector('[data-action="clear-diagnostics"]').onclick = clearDiagnostics;
  app.querySelector('[data-action="reset-preferences"]').onclick = async () => {
    if (await confirmAction({ title: 'Reset gallery preferences?', message: 'Theme, density, filters and view preferences will return to their defaults.', confirmLabel: 'Reset preferences' })) resetPreferences(false);
  };
  app.querySelector('[data-action="reset-everything"]').onclick = async () => {
    if (await confirmAction({ title: 'Reset everything?', message: 'Preferences and SAVED markers will be removed. Existing downloaded files will not be deleted.', confirmLabel: 'Reset everything', danger: true })) resetPreferences(true);
  };
  const bulkSelect = items => {
    closeDisclosures();
    selectItems(items);
    if (state.selectedOnly) render();
  };
  app.querySelector('[data-action="select-visible"]').onclick = () => bulkSelect(mediaItems());
  app.querySelector('[data-action="select-matching"]').onclick = () => {
    closeDisclosures();
    selectItems(visibleItems().filter(isMediaItem));
  };
  app.querySelector('[data-action="select-images"]').onclick = () => bulkSelect(state.items.filter(item => item.type === 'image'));
  app.querySelector('[data-action="select-videos"]').onclick = () => bulkSelect(state.items.filter(item => item.type === 'video' || item.type === 'embed'));
  app.querySelectorAll('[data-action="clear-selection"]').forEach(button => {
    button.onclick = () => {
      closeDisclosures();
      clearSelectionAndRefresh();
    };
  });
  // Wrapped: onclick hands the handler a PointerEvent, and bulkDownload now
  // takes an explicit item list as its first argument.
  app.querySelector('[data-action="download-selected"]').onclick = () => controllers.downloads.bulk();
  app.querySelector('[data-action="download-details"]').onclick = event => {
    event.stopPropagation();
    state.downloadDetailsOpen = !state.downloadDetailsOpen;
    updateDownloadUi();
  };
  app.querySelector('[data-action="close-download-details"]').onclick = event => {
    event.stopPropagation();
    state.downloadDetailsOpen = false;
    updateDownloadUi();
    app.querySelector('[data-action="download-details"]')?.focus({ preventScroll: true });
  };
  app.querySelector('[data-action="retry-failed"]').onclick = async event => {
    event.stopPropagation();
    if (state.downloading) return notify('Wait for the current queue to finish or cancel it first.');
    const items = retryableDownloadItems();
    if (!items.length) return notify('Nothing in the queue failed.');
    items.forEach(clearResolutionFailure);
    notify(`Retrying ${items.length} ${items.length === 1 ? 'file' : 'files'}.`);
    await controllers.downloads.bulk(items);
  };
  app.querySelector('[data-action="clear-download-history"]').onclick = async event => {
    event.stopPropagation();
    if (state.downloading) return notify('Finish or cancel the active download before clearing its history.', 5200);
    if (!await confirmAction({ title: 'Clear download history?', message: 'This removes SAVED and LEGACY markers plus completed queue entries. Existing files will stay in your Downloads folder.', confirmLabel: 'Clear history', danger: true })) return;
    if (!clearDownloadHistory()) return;
    notify('Download history cleared. Existing files were not deleted.');
  };
  const scrollArea = app.querySelector('.scg-scroll');
  const topButton = app.querySelector('.scg-top');
  const changeViewPage = page => {
    state.viewPage = Math.min(Math.max(1, Number(page) || 1), state.viewPages);
    scrollArea.scrollTop = 0;
    render();
  };
  app.querySelector('[data-action="view-prev"]').onclick = () => changeViewPage(state.viewPage - 1);
  app.querySelector('[data-action="view-next"]').onclick = () => changeViewPage(state.viewPage + 1);
  app.querySelector('[data-view-page]').onchange = event => changeViewPage(event.target.value);
  app.querySelector('[data-page-size]').onchange = event => {
    const perPage = Number(event.target.value);
    // Windowed layouts already ignore pagination. Everywhere else "All" means
    // every card really is in the DOM, which is worth saying before it happens:
    // on a phone the mount is the part that hurts, and warning afterwards is
    // too late to decline. Above the clamp limit the fallback speaks instead,
    // so the two notices never both fire.
    const matched = visibleItems().length;
    if (perPage === 0 && !usesWindowedRenderer() && matched > UNWINDOWED_ALL_NOTICE && matched <= UNWINDOWED_ALL_LIMIT) {
      notify(`All ${matched.toLocaleString()} matches are about to be put in the page. Masonry without reply grouping renders only what is on screen.`, 6500);
    }
    commitState({ perPage, viewPage: 1 }, { persist: true });
  };
  app.querySelectorAll('[data-card-scale]').forEach(slider => {
    slider.oninput = event => {
      const cardScale = Math.min(160, Math.max(70, Math.round(Number(event.target.value) / 5) * 5));
      commitState({ cardScale }, { shellOnly: true });
    };
    slider.onchange = () => persistSettings();
  });
  topButton.onclick = () => {
    scrollArea.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    app.querySelector('[data-search]')?.focus({ preventScroll: true });
  };
  scrollArea.addEventListener('scroll', () => {
    topButton.classList.toggle('visible', scrollArea.scrollTop > 650);
    scheduleFlowWindow();
  }, { passive: true });
  const gridNode = app.querySelector('.scg-grid');
  gridNode.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target !== gridNode || state.scanning) return;
    const start = { x: event.clientX, y: event.clientY };
    const marquee = document.createElement('div');
    marquee.className = 'scg-marquee';
    app.appendChild(marquee);
    let moved = false;
    const move = pointer => {
      const left = Math.min(start.x, pointer.clientX);
      const top = Math.min(start.y, pointer.clientY);
      const width = Math.abs(pointer.clientX - start.x);
      const height = Math.abs(pointer.clientY - start.y);
      moved ||= width > 5 || height > 5;
      Object.assign(marquee.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    };
    const finish = pointer => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      move(pointer);
      if (moved) {
        const selectionRect = marquee.getBoundingClientRect();
        const items = [...gridNode.querySelectorAll('.scg-card[data-key]')]
          .filter(node => rectanglesIntersect(selectionRect, node.getBoundingClientRect()))
          .map(node => itemForNode(node, 'key'))
          .filter(Boolean);
        selectItems(items, !pointer.ctrlKey && !pointer.metaKey);
      }
      marquee.remove();
    };
    const cancel = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      marquee.remove();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
    event.preventDefault();
  });
  gridNode.onclick = event => {
    const cardNode = event.target.closest?.('.scg-card[data-key]');
    if (cardNode) state.gridFocusKey = cardNode.dataset.key;
    const replySelect = event.target.closest('[data-reply-select]');
    if (replySelect) {
      setReplySelected(replySelect.dataset.replySelect, replySelect.checked);
      if (state.selectedOnly) render();
      else updateSelectionUi();
      return;
    }
    const replyToggle = event.target.closest('[data-reply-toggle]');
    if (replyToggle) {
      setReplyCollapsed(replyToggle.dataset.replyToggle, replyToggle.getAttribute('aria-expanded') === 'true');
      render();
      return;
    }
    const selection = event.target.closest('[data-select]');
    if (selection) {
      // The browser has already flipped the checkbox by the time this runs;
      // updateSelectionUi rewrites every box from state, so a shift-click that
      // means something other than "toggle me" still lands correctly.
      applySelectionGesture(itemForNode(selection, 'select'), event);
      if (state.selectedOnly) render();
      else updateSelectionUi();
      return;
    }
    const player = event.target.closest('[data-load-player]');
    if (player) {
      startEmbeddedPlayer(itemForNode(player, 'loadPlayer'), player.closest('.scg-embed'));
      return;
    }
    const expand = event.target.closest('[data-expand]');
    if (expand) {
      const item = itemForNode(expand, 'expand');
      const paragraph = expand.closest('.scg-textcard').querySelector('p');
      const expanded = paragraph.classList.toggle('expanded');
      if (item) {
        if (expanded) state.expandedKeys.add(item.selectionKey);
        else state.expandedKeys.delete(item.selectionKey);
      }
      setIconButton(expand, 'chevron', expanded ? 'Show less' : 'Show more');
      expand.classList.toggle('expanded', expanded);
      return;
    }
    const download = event.target.closest('[data-download]');
    if (download) {
      downloadMedia(itemForNode(download, 'download'));
      return;
    }
    const button = event.target.closest('[data-open]');
    if (!button) return;
    controllers.viewer.open(itemForNode(button, 'open'));
  };
  app.querySelector('.scg-grid').addEventListener('load', event => {
    const img = event.target;
    if (!img || img.tagName !== 'IMG' || !img.naturalWidth || !img.naturalHeight) return;
    const item = itemForNode(img, 'resolveKey');
    if (!item) return;
    const isThumb = Boolean(item.thumb) && img.currentSrc === absoluteUrl(item.thumb);
    if (!applyMeasuredRatio(item, img.naturalWidth, img.naturalHeight, isThumb ? 'thumb' : 'measured')) return;
    img.closest('.scg-card')?.style.setProperty('--scg-ratio', String(item.ratio.value));
    scheduleFlowRatioLayout();
  }, true);
  app.querySelector('.scg-lightbox').onclick = event => { if (event.target.classList.contains('scg-lightbox')) closeLightbox(); };
  document.addEventListener('keydown', event => {
    const typing = event.target.matches?.('input,textarea,select,[contenteditable="true"]');
    if (typing && event.key !== 'Escape') return;
    const openDisclosure = app.querySelector('.scg-menu.open, .scg-refine-popover.open');
    if (openDisclosure && event.key === 'Escape') {
      event.preventDefault();
      const trigger = openDisclosure.classList.contains('scg-menu')
        ? app.querySelector('[data-action="overflow"]')
        : app.querySelector('[data-action="refine-toggle"]');
      closeDisclosures();
      trigger?.focus();
      return;
    }
    const confirmPanel = app.querySelector('.scg-confirm-panel');
    if (confirmPanel.classList.contains('open')) {
      if (event.key === 'Escape') confirmPanel.querySelector('[data-confirm-cancel]')?.click();
      else if (event.key === 'Tab') containFocus(confirmPanel, event);
      return;
    }
    const settingsPanel = app.querySelector('.scg-settings-panel');
    if (settingsPanel.classList.contains('open')) {
      if (event.key === 'Escape') controllers.settings.close();
      else if (event.key === 'Tab') containFocus(settingsPanel, event);
      return;
    }
    const box = app.querySelector('.scg-lightbox');
    if (box.classList.contains('open')) {
      wakeViewerChrome();
      const item = currentViewerItem();
      if (event.key === 'Tab') {
        const focusable = [...box.querySelectorAll('button:not(:disabled),a[href],video[controls]')].filter(node => node.offsetParent !== null);
        if (focusable.length) {
          const current = focusable.indexOf(document.activeElement);
          const next = event.shiftKey ? (current <= 0 ? focusable.length - 1 : current - 1) : (current >= focusable.length - 1 ? 0 : current + 1);
          event.preventDefault();
          focusable[next].focus();
        }
      } else if (event.key === 'Escape') closeLightbox();
      else if (event.key === 'ArrowLeft') navigateLightbox(-1);
      else if (event.key === 'ArrowRight') navigateLightbox(1);
      else if ((event.key === '+' || event.key === '=') && item?.type === 'image') setViewerZoom(state.viewerZoom + .25);
      else if (event.key === '-' && item?.type === 'image') setViewerZoom(state.viewerZoom - .25);
      else if (event.key === '0' && item?.type === 'image') setViewerZoom(1);
      else if (event.key.toLowerCase() === 'i') toggleViewerInfo();
      else if (event.key.toLowerCase() === 'f') toggleViewerFullscreen();
      else if (event.key === ' ') {
        const video = box.querySelector('video');
        if (video) {
          event.preventDefault();
          if (video.paused) video.play().catch(() => {});
          else video.pause();
        }
      }
      else if (event.key.toLowerCase() === 'd' && item) downloadMedia(item);
      else if (event.key.toLowerCase() === 's') {
        if (!item) return;
        toggleSelected(item);
        setIconButton(box.querySelector('[data-select-current]'), 'select', `${state.selected.has(item.selectionKey) ? 'Unselect' : 'Select'} (S)`);
      }
      return;
    }
    const focusedCard = event.target.closest?.('.scg-card[data-key]');
    const navigation = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[event.key];
    if (app.classList.contains('open') && (focusedCard || state.gridFocusKey) && navigation) {
      event.preventDefault();
      const keys = state.renderedItems.map(item => item.selectionKey);
      focusGridItem(gridNavigationTarget(keys, focusedCard?.dataset.key || state.gridFocusKey, navigation, gridColumnCount()));
      return;
    }
    if (app.classList.contains('open') && focusedCard && event.target === focusedCard && (event.key === ' ' || event.key === 'Enter')) {
      event.preventDefault();
      const item = itemForNode(focusedCard, 'key');
      if (event.key === ' ' && isDownloadableMedia(item)) {
        toggleSelected(item);
        if (state.selectedOnly) render();
      }
      else if (event.key === 'Enter' && isMediaItem(item)) controllers.viewer.open(item);
      return;
    }
    // One normalized chord per event, matched against the bindings, so a
    // rebound key needs no second place to be taught about it.
    const combo = shortcutCombo(event);
    const bound = combo ? SHORTCUT_ACTIONS.find(action => state.shortcuts[action.id] === combo)?.id : '';
    if (event.key === 'Escape' && app.classList.contains('open')) {
      // Escape unwinds one layer at a time: a selection first, the gallery only
      // once there is nothing left to discard.
      if (state.selected.size) clearSelectionAndRefresh();
      else closeApp();
    } else if (bound === 'toggle') {
      event.preventDefault();
      if (app.classList.contains('open')) closeApp();
      else openApp();
    } else if (!app.classList.contains('open')) {
      // Everything below is a control for a gallery that is on screen.
    } else if (bound === 'search') {
      event.preventDefault();
      app.querySelector('[data-search]').focus();
    } else if (bound === 'layout') {
      event.preventDefault();
      cycleLayoutMode(1, true);
    } else if (bound === 'selectAll') {
      event.preventDefault();
      selectItems(mediaItems());
      if (state.selectedOnly) render();
    } else if (event.key === 'Tab') {
      containFocus(app, event);
    }
  });

  /* ---- Cross-tab and unload wiring -----------------------------------------
     Registered last so every handler it reaches is already defined.
     ------------------------------------------------------------------------ */

  // Saved, cleared and imported all invalidate the same way; the receiver goes
  // back to storage rather than trusting anything that arrived on the channel.
  tabSync.on('download-history-changed', reloadDownloadHistory);
  tabSync.start();

  // Downloads live only in this page's memory, so a reload during one loses
  // partially fetched files and any ZIP that has not been written yet.
  window.addEventListener('beforeunload', event => {
    const active = state.downloading || state.downloadJobs.some(job => ['queued', 'preparing', 'downloading', 'packing'].includes(job.status));
    if (!active) return undefined;
    event.preventDefault();
    // Browsers show their own wording; a non-empty return value is the signal.
    event.returnValue = 'Downloads are still running. Leaving now cancels them.';
    return event.returnValue;
  });
})();
