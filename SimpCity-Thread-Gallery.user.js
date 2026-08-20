// ==UserScript==
// @name         SimpCity Thread Gallery — Hybrid UI Fork
// @namespace    local.simpcity.gallery.hybrid
// @version      0.9.6
// @description  Browse SimpCity thread media in a Darkroom gallery with filtering, lightbox viewing and verified downloads.
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

  // DESIGN DIRECTION: "Darkroom" â€” the media canvas is the page; a single
  // floating instrument plate carries every frequent control; the dock at the
  // foot of the canvas changes identity between browse, select and download.
  // Only behaviour-neutral UI code was changed from 0.9.5; scanning, resolving,
  // validation, ZIP packing, history and diagnostics are untouched.

  const APP_VERSION = '0.9.6';
  const APP_ID = 'sc-thread-gallery';
  const SETTINGS_KEY = 'sc-thread-gallery-settings-v1';
  const DOWNLOAD_HISTORY_KEY = 'sc-thread-gallery-download-history-v1';
  const STORAGE_MIGRATION_KEY = 'sc-thread-gallery-storage-migrated-v072';
  const LARGE_THREAD_WARNING_PAGES = 50;
  const SCAN_WARNING_TEXT = 'Scanning a very large thread can use substantial RAM and may temporarily slow or freeze the browser. Media files remain unloaded until viewed.';
  if (document.getElementById(APP_ID)) return;

  const DEFAULT_SETTINGS = Object.freeze({
    filter: 'all',
    compact: false,
    sort: 'thread-asc',
    groupBy: 'none',
    perPage: 60,
    theme: 'dark',
    filtersCollapsed: false,
    activityCollapsed: false,
    layoutMode: 'masonry',
    cardScale: 100,
    downloadConcurrency: 2,
    zipPartSizeMb: 300,
    zipPartMaxFiles: 24,
    archiveLayout: 'page-author',
    includeManifest: true,
    dedupeContent: true,
    warnLargeThreadScan: true,
  });
  const THEME_MODES = Object.freeze(['dark', 'light', 'midnight', 'graphite']);
  const THEME_LABELS = Object.freeze({ dark: 'Darkroom', light: 'Daylight', midnight: 'Indigo', graphite: 'Graphite' });

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
  const storedSettings = storage.get(SETTINGS_KEY, {});
  const storedDownloadHistory = storage.get(DOWNLOAD_HISTORY_KEY, {});
  const savedSettings = storedSettings && typeof storedSettings === 'object' && !Array.isArray(storedSettings) ? storedSettings : {};
  const savedDownloadHistory = storedDownloadHistory && typeof storedDownloadHistory === 'object' && !Array.isArray(storedDownloadHistory) ? storedDownloadHistory : {};

  function normalizeDownloadHistory(history) {
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
    query: '',
    compact: Boolean(savedSettings.compact),
    sort: ['thread-asc', 'thread-desc', 'author', 'host', 'type'].includes(savedSettings.sort) ? savedSettings.sort : 'thread-asc',
    groupBy: savedSettings.groupBy === 'reply' ? 'reply' : 'none',
    perPage: [40, 60, 100].includes(Number(savedSettings.perPage)) ? Number(savedSettings.perPage) : 60,
    theme: THEME_MODES.includes(savedSettings.theme) ? savedSettings.theme : DEFAULT_SETTINGS.theme,
    filtersCollapsed: Boolean(savedSettings.filtersCollapsed),
    activityCollapsed: Boolean(savedSettings.activityCollapsed),
    layoutMode: ['masonry', 'grid', 'feed'].includes(savedSettings.layoutMode) ? savedSettings.layoutMode : 'masonry',
    cardScale: Number.isFinite(Number(savedSettings.cardScale)) ? Math.min(160, Math.max(70, Math.round(Number(savedSettings.cardScale) / 5) * 5)) : 100,
    downloadConcurrency: [1, 2, 3, 4].includes(Number(savedSettings.downloadConcurrency)) ? Number(savedSettings.downloadConcurrency) : 2,
    zipPartSizeMb: [100, 300, 600, 1000].includes(Number(savedSettings.zipPartSizeMb)) ? Number(savedSettings.zipPartSizeMb) : 300,
    zipPartMaxFiles: [24, 50, 100].includes(Number(savedSettings.zipPartMaxFiles)) ? Number(savedSettings.zipPartMaxFiles) : 24,
    archiveLayout: ['flat', 'page', 'page-author', 'reply'].includes(savedSettings.archiveLayout) ? savedSettings.archiveLayout : 'page-author',
    includeManifest: savedSettings.includeManifest !== false,
    dedupeContent: savedSettings.dedupeContent !== false,
    warnLargeThreadScan: savedSettings.warnLargeThreadScan !== false,
    authorFilter: 'all',
    hostFilter: 'all',
    selectedOnly: false,
    viewPage: 1,
    viewPages: 1,
    renderedItems: [],
    threadPageCount: 1,
    sourcePage: 1,
    selectionMode: false,
    selected: new Set(),
    collapsedReplies: new Set(),
    scanning: false,
    cancelScan: false,
    scannedPages: 0,
    scanCurrentPage: 0,
    scanTotalPages: 0,
    scanFailedPages: 0,
    scanCanceling: false,
    scanController: null,
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
  let visibleItemsCache = { signature: '', items: [] };

  function invalidateVisibleItems({ dataset = false, selection = false } = {}) {
    if (dataset) datasetRevision++;
    if (selection) selectionRevision++;
    visibleItemsCache = { signature: '', items: [] };
  }

  const IMAGE_EXT = /\.(?:jpe?g|png|gif|webp|avif|bmp)(?:$|[?#./])/i;
  const VIDEO_EXT = /\.(?:mp4|webm|mov|m4v)(?:$|[?#./])/i;
  const IGNORE_IMG = /(?:avatar|smilie|emoji|reaction|sprite|logo)/i;
  const TYPE_ORDER = { image: 0, video: 1, embed: 1, link: 2, text: 3 };
  const LAYOUT_MODES = Object.freeze(['masonry', 'grid', 'feed']);
  const LAYOUT_LABELS = Object.freeze({ masonry: 'Masonry', grid: 'Uniform grid', feed: 'Feed' });
  const ICON_PATHS = {
    gallery: '<rect x="3.25" y="6.75" width="14" height="12.5" rx="2.5"/><path d="M7.25 6.75V5.5a2.25 2.25 0 0 1 2.25-2.25h8A2.25 2.25 0 0 1 19.75 5.5v8.25a2.25 2.25 0 0 1-1.5 2.12"/><circle cx="7.9" cy="11" r="1.15"/><path d="m3.6 17.9 3.9-3.6a1.4 1.4 0 0 1 1.9 0l2 1.9 2.2-2a1.4 1.4 0 0 1 1.9 0l1.75 1.6"/>',
    settings: '<circle cx="12" cy="12" r="3.1"/><path d="M19.35 13.4a1.55 1.55 0 0 0 .32 1.72l.05.06a1.85 1.85 0 1 1-2.62 2.62l-.06-.06a1.55 1.55 0 0 0-1.72-.31 1.55 1.55 0 0 0-.94 1.42v.17a1.85 1.85 0 1 1-3.7 0v-.09a1.55 1.55 0 0 0-1-1.42 1.55 1.55 0 0 0-1.72.31l-.06.06a1.85 1.85 0 1 1-2.62-2.62l.06-.06a1.55 1.55 0 0 0 .31-1.72 1.55 1.55 0 0 0-1.42-.94h-.17a1.85 1.85 0 1 1 0-3.7h.09a1.55 1.55 0 0 0 1.42-1 1.55 1.55 0 0 0-.31-1.72l-.06-.06a1.85 1.85 0 1 1 2.62-2.62l.06.06a1.55 1.55 0 0 0 1.72.31h.07a1.55 1.55 0 0 0 .94-1.42v-.17a1.85 1.85 0 1 1 3.7 0v.09a1.55 1.55 0 0 0 .94 1.42 1.55 1.55 0 0 0 1.72-.31l.06-.06a1.85 1.85 0 1 1 2.62 2.62l-.06.06a1.55 1.55 0 0 0-.31 1.72v.07a1.55 1.55 0 0 0 1.42.94h.17a1.85 1.85 0 1 1 0 3.7h-.09a1.55 1.55 0 0 0-1.42.94Z"/>',
    layout: '<rect x="3.25" y="4.25" width="7.25" height="7.25" rx="1.6"/><rect x="13.5" y="4.25" width="7.25" height="4.5" rx="1.6"/><rect x="3.25" y="14.5" width="7.25" height="5.25" rx="1.6"/><rect x="13.5" y="11.75" width="7.25" height="8" rx="1.6"/>',
    keyboard: '<rect x="2.75" y="6" width="18.5" height="12" rx="2.5"/><path d="M6.5 9.75h.01M10 9.75h.01M13.5 9.75h.01M17 9.75h.01M6.5 13.9h.01M17 13.9h.01M9.5 13.9h5" stroke-width="2.1"/>',
    close: '<path d="m6.75 6.75 10.5 10.5M17.25 6.75 6.75 17.25"/>',
    download: '<path d="M12 3.75v10.5m0 0 3.75-3.75M12 14.25 8.25 10.5"/><path d="M4.25 16.25v2a2 2 0 0 0 2 2h11.5a2 2 0 0 0 2-2v-2"/>',
    select: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="m8 12.2 2.7 2.7L16.2 9.4"/>',
    image: '<rect x="3" y="4.25" width="18" height="15.5" rx="2.5"/><circle cx="8.4" cy="9.4" r="1.5"/><path d="m3.4 17.6 4.4-4.1a1.5 1.5 0 0 1 2.05 0l2.15 2 2.4-2.2a1.5 1.5 0 0 1 2.05 0l4.15 3.8"/>',
    video: '<rect x="2.75" y="5" width="18.5" height="14" rx="2.75"/><path d="M10.4 9.35a.4.4 0 0 1 .61-.34l3.9 2.65a.4.4 0 0 1 0 .68l-3.9 2.65a.4.4 0 0 1-.61-.34Z"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
    reset: '<path d="M20.25 12a8.25 8.25 0 1 1-2.42-5.83"/><path d="M20.25 4.5V10h-5.5"/>',
    upload: '<path d="M12 15V4.5m0 0L8.25 8.25M12 4.5l3.75 3.75"/><path d="M4.25 16.25v2a2 2 0 0 0 2 2h11.5a2 2 0 0 0 2-2v-2"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11.25v5"/><path d="M12 7.9h.01" stroke-width="2.2"/>',
    filter: '<path d="M4 5.25h16l-6.15 7v5.35l-3.7 1.65V12.25Z"/>',
    sliders: '<path d="M4.5 7.5h9M17.5 7.5h2M4.5 16.5h2M10.5 16.5h9"/><circle cx="15.5" cy="7.5" r="2.25"/><circle cx="8.5" cy="16.5" r="2.25"/>',
    sun: '<circle cx="12" cy="12" r="3.9"/><path d="M12 2.75v1.9M12 19.35v1.9M4.72 4.72l1.35 1.35M17.93 17.93l1.35 1.35M2.75 12h1.9M19.35 12h1.9M4.72 19.28l1.35-1.35M17.93 6.07l1.35-1.35"/>',
    moon: '<path d="M20.25 14.6A8.75 8.75 0 0 1 9.4 3.75a8.75 8.75 0 1 0 10.85 10.85Z"/>',
    palette: '<path d="M12 3.25a8.75 8.75 0 0 0 0 17.5h1.15a1.9 1.9 0 0 0 1.35-3.25l-.3-.3a1.35 1.35 0 0 1 .95-2.3h1.6a4.5 4.5 0 0 0 4.5-4.5c0-3.95-4.15-7.15-9.25-7.15Z"/><circle cx="7.9" cy="10.4" r="1.05"/><circle cx="10.4" cy="7.1" r="1.05"/><circle cx="14" cy="7.1" r="1.05"/><circle cx="16.6" cy="10.4" r="1.05"/>',
    chevron: '<path d="m6.75 9.75 5.25 5 5.25-5"/>',
    more: '<path d="M6 12h.01M12 12h.01M18 12h.01" stroke-width="2.6"/>',
    scan: '<path d="M3.75 8V5.75a2 2 0 0 1 2-2H8M16 3.75h2.25a2 2 0 0 1 2 2V8M20.25 16v2.25a2 2 0 0 1-2 2H16M8 20.25H5.75a2 2 0 0 1-2-2V16"/><path d="M7.5 12h9"/>',
    masonry: '<rect x="3.5" y="3.5" width="7" height="10.25" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="6" rx="1.6"/><rect x="3.5" y="16" width="7" height="4.5" rx="1.6"/><rect x="13.5" y="11.75" width="7" height="8.75" rx="1.6"/>',
    grid: '<rect x="3.5" y="3.5" width="7.25" height="7.25" rx="1.6"/><rect x="13.25" y="3.5" width="7.25" height="7.25" rx="1.6"/><rect x="3.5" y="13.25" width="7.25" height="7.25" rx="1.6"/><rect x="13.25" y="13.25" width="7.25" height="7.25" rx="1.6"/>',
    feed: '<rect x="3.5" y="4.25" width="6.75" height="6" rx="1.5"/><path d="M13 6h7.5M13 8.9h5.25"/><rect x="3.5" y="13.75" width="6.75" height="6" rx="1.5"/><path d="M13 15.5h7.5M13 18.4h5.25"/>',
    zoomIn: '<circle cx="10.75" cy="10.75" r="6.5"/><path d="m15.6 15.6 4.65 4.65M10.75 7.9v5.7M7.9 10.75h5.7"/>',
    zoomOut: '<circle cx="10.75" cy="10.75" r="6.5"/><path d="m15.6 15.6 4.65 4.65M7.9 10.75h5.7"/>',
    fit: '<path d="M9.75 4.25H4.25V9.75M14.25 4.25h5.5V9.75M9.75 19.75H4.25V14.25M14.25 19.75h5.5V14.25"/><rect x="8.75" y="8.75" width="6.5" height="6.5" rx="1.4"/>',
    fullscreen: '<path d="M9 3.75H5.75a2 2 0 0 0-2 2V9M15 3.75h3.25a2 2 0 0 1 2 2V9M9 20.25H5.75a2 2 0 0 1-2-2V15M15 20.25h3.25a2 2 0 0 0 2-2V15"/>',
    external: '<path d="M14.25 3.75h6v6M20.25 3.75 12 12"/><path d="M18.5 13.5v4.75a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2h4.75"/>',
    play: '<circle cx="12" cy="12" r="8.5"/><path d="M10.4 9.15a.4.4 0 0 1 .61-.34l4.35 2.85a.4.4 0 0 1 0 .68l-4.35 2.85a.4.4 0 0 1-.61-.34Z"/>',
    resolution: '<rect x="2.75" y="4.5" width="18.5" height="12.5" rx="2.5"/><path d="M8.5 20.25h7M12 17v3.25M6.75 8.25h2.75V11M17.25 8.25H14.5V11"/>',
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

  function icon(name, className = '') {
    const paths = ICON_PATHS[name] || ICON_PATHS.info;
    return `<svg class="scg-icon ${escapeHtml(className)}" data-scg-icon="${escapeHtml(name)}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  }

  function iconWell(name, className = '') {
    return `<i class="scg-icon-well ${escapeHtml(className)}" aria-hidden="true">${icon(name)}</i>`;
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
      embed: url => {
        const id = url.pathname.match(/\/(\d+)/)?.[1];
        return id ? `https://player.vimeo.com/video/${id}` : url.href;
      },
    }),
    Object.freeze({
      id: 'streamable', media: 'video',
      matches: host => /(?:^|\.)streamable\.com$/i.test(host),
      embed: url => {
        const id = url.pathname.split('/').filter(Boolean).pop();
        return id ? `https://streamable.com/e/${encodeURIComponent(id)}` : url.href;
      },
    }),
    Object.freeze({
      id: 'redgifs', media: 'video',
      matches: host => /(?:^|\.)redgifs\.com$/i.test(host),
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

  function isDownloadableMedia(item) {
    if (!isMediaItem(item)) return false;
    const candidate = item.resolution?.candidate;
    if (candidate?.status === 'failed' || (item.resolution?.attempted && !candidate?.url)) return false;
    if (item.type === 'image') return Boolean(candidate?.url || item.url || item.thumb);
    if (item.type === 'video') return Boolean((candidate?.url && VIDEO_EXT.test(candidate.url)) || VIDEO_EXT.test(item.url || ''));
    return Boolean(candidate?.status === 'confirmed' && candidate.url) || hostDefinition(item.url)?.id === 'turbo';
  }

  function downloadHistoryKey(item) {
    const base = threadBaseUrl(item?.pageUrl || item?.postUrl || location.href);
    return `${base}|${item?.selectionKey || itemDedupeKey(item)}`;
  }

  function downloadHistoryEntry(item) {
    return item ? state.downloadHistory[downloadHistoryKey(item)] || null : null;
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

  function persistDownloadHistory() {
    try {
      const entries = Object.entries(state.downloadHistory)
        .sort((a, b) => Number(b[1]?.time || 0) - Number(a[1]?.time || 0))
        .slice(0, 5000);
      state.downloadHistory = Object.fromEntries(entries);
      storage.set(DOWNLOAD_HISTORY_KEY, state.downloadHistory);
    } catch { /* Downloading must still work if local storage is unavailable. */ }
  }

  function rememberDownloaded(item, filename, validation, deferPersist = false, container = '') {
    if (!validation?.verified) return false;
    state.downloadHistory[downloadHistoryKey(item)] = {
      filename,
      size: Math.max(0, Number(validation.size || validation.blob?.size || 0)),
      time: Date.now(),
      verified: true,
      legacy: false,
      mime: String(validation.mime || ''),
      method: String(validation.method || 'validated-media'),
      container: String(container || ''),
    };
    if (!deferPersist) {
      persistDownloadHistory();
      updateDownloadedIndicators();
    }
    return true;
  }

  function persistSettings() {
    try {
      storage.set(SETTINGS_KEY, {
        filter: state.filter,
        compact: state.compact,
        sort: state.sort,
        groupBy: state.groupBy,
        perPage: state.perPage,
        theme: state.theme,
        filtersCollapsed: state.filtersCollapsed,
        activityCollapsed: state.activityCollapsed,
        layoutMode: state.layoutMode,
        cardScale: state.cardScale,
        downloadConcurrency: state.downloadConcurrency,
        zipPartSizeMb: state.zipPartSizeMb,
        zipPartMaxFiles: state.zipPartMaxFiles,
        archiveLayout: state.archiveLayout,
        includeManifest: state.includeManifest,
        dedupeContent: state.dedupeContent,
        warnLargeThreadScan: state.warnLargeThreadScan,
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
    if (source) source.textContent = `${state.sourceLabel} Â· ${state.items.length} indexed`;
  }

  function applyShellState() {
    const app = document.getElementById(APP_ID);
    if (!app) return;
    app.dataset.theme = state.theme;
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
    app.classList.toggle('activity-collapsed', state.activityCollapsed);
    const toast = document.getElementById('scg-gallery-toast');
    if (toast) toast.dataset.theme = state.theme;
    const launch = document.getElementById('scg-launch');
    if (launch) launch.dataset.theme = state.theme;
    const filterToggle = app.querySelector('[data-action="filters-toggle"]');
    if (filterToggle) {
      setIconOnlyButton(filterToggle, 'chevron', state.filtersCollapsed ? 'Show filters and view options' : 'Hide filters and view options');
      filterToggle.setAttribute('aria-expanded', String(!state.filtersCollapsed));
      filterToggle.classList.toggle('active', !state.filtersCollapsed);
    }
    setIconButton(app.querySelector('[data-action="density"]'), 'layout', state.compact ? 'Comfortable cards' : 'Compact cards');
    const themeIndex = Math.max(0, THEME_MODES.indexOf(state.theme));
    const nextTheme = THEME_MODES[(themeIndex + 1) % THEME_MODES.length];
    const themeButton = app.querySelector('[data-action="theme"]');
    setIconButton(themeButton, 'palette', `Theme: ${THEME_LABELS[state.theme]}`);
    if (themeButton) themeButton.title = `Current theme: ${THEME_LABELS[state.theme]}. Activate for ${THEME_LABELS[nextTheme]}.`;
    app.querySelectorAll('[data-layout-mode]').forEach(button => {
      const active = button.dataset.layoutMode === state.layoutMode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const activityToggle = app.querySelector('[data-action="activity-toggle"]');
    if (activityToggle) {
      setIconOnlyButton(activityToggle, 'chevron', state.activityCollapsed ? 'Expand activity bar' : 'Collapse activity bar');
      activityToggle.setAttribute('aria-expanded', String(!state.activityCollapsed));
    }
    refreshRefineTrigger();
    const themeSelect = app.querySelector('[data-setting-theme]');
    const densitySelect = app.querySelector('[data-setting-density]');
    const filterCheck = app.querySelector('[data-setting-filters-collapsed]');
    const activityCheck = app.querySelector('[data-setting-activity-collapsed]');
    const layoutSelect = app.querySelector('[data-setting-layout]');
    const sizeSliders = app.querySelectorAll('[data-card-scale]');
    const sizeLabels = app.querySelectorAll('[data-card-scale-value]');
    if (themeSelect) themeSelect.value = state.theme;
    if (densitySelect) densitySelect.value = state.compact ? 'compact' : 'comfortable';
    sizeSliders.forEach(slider => {
      slider.value = String(cardScale);
      slider.disabled = state.layoutMode === 'feed';
      slider.setAttribute('aria-valuetext', `${cardScale}%${state.layoutMode === 'feed' ? ', unavailable in feed layout' : ''}`);
    });
    sizeLabels.forEach(label => { label.textContent = state.layoutMode === 'feed' ? 'Feed' : `${cardScale}%`; });
    if (filterCheck) filterCheck.checked = state.filtersCollapsed;
    if (activityCheck) activityCheck.checked = state.activityCollapsed;
    if (layoutSelect) layoutSelect.value = state.layoutMode;
    refreshThreadHeader();
  }

  // Progressive disclosure: the Refine popover advertises how much it is hiding.
  function activeRefinements() {
    return [
      state.sort !== DEFAULT_SETTINGS.sort,
      state.authorFilter && state.authorFilter !== 'all',
      state.hostFilter && state.hostFilter !== 'all',
      state.groupBy !== DEFAULT_SETTINGS.groupBy,
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
    app.querySelectorAll('[data-action="overflow"], [data-action="refine-toggle"]').forEach(button => {
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

  function cycleLayoutMode(direction = 1, announce = true) {
    const current = Math.max(0, LAYOUT_MODES.indexOf(state.layoutMode));
    const next = LAYOUT_MODES[(current + direction + LAYOUT_MODES.length) % LAYOUT_MODES.length];
    commitState({ layoutMode: next }, { persist: true, shellOnly: true });
    if (announce) notify(`${LAYOUT_LABELS[next]} layout`);
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
    return { article, body, author, postUrl, postId, postNumber };
  };

  function extractFromDocument(doc, pageUrl) {
    const results = [];
    const posts = [...doc.querySelectorAll('article.message, .message--post')];
    const roots = posts.length ? posts : [...doc.querySelectorAll('.message')];

    roots.forEach((root, postIndex) => {
      const { body, author, postUrl, postId, postNumber } = postParts(root);
      if (!body) return;
      const content = body.cloneNode(true);
      content.querySelectorAll('.bbCodeBlock--quote, blockquote.bbCodeBlock, [data-quote], .message-signature').forEach(node => node.remove());
      const base = pageUrl || doc.baseURI;
      const common = {
        author,
        postUrl: absoluteUrl(postUrl, base),
        postId,
        postNumber,
        pageUrl: base,
        pageNumber: pageNumberFromUrl(base),
        postIndex,
      };

      content.querySelectorAll('img').forEach((img, mediaIndex) => {
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
        results.push({
          type: 'image', url: src, thumb, originalLink, lightboxHint,
          mediaKey: `${String(postId).replace(/[^a-z0-9_-]/gi, '')}-${postIndex}-${mediaIndex}`,
          resolution: { candidate: seed },
          caption: img.getAttribute('alt') || img.getAttribute('title') || '', mediaIndex, ...common,
        });
      });

      content.querySelectorAll('video').forEach((video, mediaIndex) => {
        const source = video.querySelector('source');
        const src = absoluteUrl(video.currentSrc || video.getAttribute('data-src') || video.getAttribute('src') ||
          source?.getAttribute('data-src') || source?.getAttribute('src'), base);
        if (!src) return;
        results.push({
          type: 'video', url: src, poster: absoluteUrl(video.getAttribute('data-poster') || video.getAttribute('poster'), base),
          resolution: { candidate: { status: 'confirmed', url: src, method: 'video-element', mediaType: 'video' } },
          mediaIndex, ...common,
        });
      });

      content.querySelectorAll('iframe[src], iframe[data-src]').forEach((frame, mediaIndex) => {
        const src = normalizeSourceUrl(frame.getAttribute('data-src') || frame.getAttribute('src'), base);
        if (!src) return;
        results.push({
          type: 'embed', url: src, title: frame.getAttribute('title') || 'Embedded video',
          wasFrame: true, mediaIndex, ...common,
        });
      });

      content.querySelectorAll('a[href]').forEach((anchor, mediaIndex) => {
        const href = normalizeSourceUrl(anchor.getAttribute('href'), base);
        if (!href || anchor.querySelector('img')) return;
        if (/\/threads\/|\/posts\/|#post-|\/members\//i.test(href)) return;
        const label = (anchor.textContent || href).replace(/\s+/g, ' ').trim();
        if (VIDEO_EXT.test(href) || isKnownVideoHost(href)) {
          const directVideo = VIDEO_EXT.test(href);
          results.push({
            type: directVideo ? 'video' : 'embed', url: href, title: label,
            resolution: directVideo ? { candidate: { status: 'confirmed', url: href, method: 'direct-video-link', mediaType: 'video' } } : {},
            mediaIndex, ...common,
          });
        } else {
          results.push({ type: 'link', url: href, title: label, mediaIndex, ...common });
        }
      });

      const text = cleanText(content);
      if (text) results.push({ type: 'text', text, ...common });
    });
    return results;
  }

  function itemDedupeKey(item) {
    const rawUrl = item.type === 'embed' ? embedUrl(item.url) : item.url;
    const normalizedUrl = rawUrl ? rawUrl.replace(/([?&])width=\d+|([?&])height=\d+/g, '$1').replace(/[?&]$/, '') : '';
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
      item.searchText = `${item.author || ''} ${item.title || ''} ${item.caption || ''} ${item.text || ''} ${item.url || ''} ${item.originalLink || ''} ${item.postNumber || ''} ${item.pageNumber || ''}`.toLowerCase();
      target.push(item);
    });
    return target;
  }

  function dedupe(items) {
    return appendUniqueItems([], items, new Set());
  }

  function escapeHtml(value = '') {
    return String(value).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'link'; }
  }

  function requestText(url, options = {}) {
    const headers = options.headers || {};
    const timeout = options.timeout || 18000;
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        const sameOrigin = (() => { try { return new URL(url).origin === location.origin; } catch { return false; } })();
        fetch(url, {
          credentials: sameOrigin ? 'include' : 'omit',
          headers,
          referrer: headers.Referer || headers.referer || undefined,
        })
          .then(response => response.ok ? response.text() : Promise.reject(new Error(`HTTP ${response.status}`)))
          .then(resolve, reject);
        return;
      }
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers,
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

  async function resolveCandidate(item) {
    if (!item) return failedResolution('Media item is missing', '');
    item.resolution ||= {};
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
    const type = item.type === 'image' ? 'img' : 'vid';
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
    app.querySelectorAll('.scg-card[data-index]').forEach(cardNode => {
      const item = state.renderedItems[Number(cardNode.dataset.index)];
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
    const toast = document.getElementById('scg-gallery-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => toast.classList.remove('show'), duration);
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

  function setSelected(item, selected) {
    if (!isDownloadableMedia(item)) return;
    const changed = selected ? !state.selected.has(item.selectionKey) : state.selected.has(item.selectionKey);
    if (selected) state.selected.add(item.selectionKey);
    else state.selected.delete(item.selectionKey);
    if (changed) invalidateVisibleItems({ selection: true });
  }

  function clearSelection() {
    if (!state.selected.size) return false;
    state.selected.clear();
    invalidateVisibleItems({ selection: true });
    return true;
  }

  function exitSelectionMode() {
    state.selectionMode = false;
    clearSelection();
    state.selectedOnly = false;
  }

  function toggleSelected(item) {
    const selected = !state.selected.has(item.selectionKey);
    setSelected(item, selected);
    updateSelectionUi();
    return selected;
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
      compact: Boolean(input.compact),
      sort: ['thread-asc', 'thread-desc', 'author', 'host', 'type'].includes(input.sort) ? input.sort : DEFAULT_SETTINGS.sort,
      groupBy: input.groupBy === 'reply' ? 'reply' : DEFAULT_SETTINGS.groupBy,
      perPage: [40, 60, 100].includes(Number(input.perPage)) ? Number(input.perPage) : DEFAULT_SETTINGS.perPage,
      theme: THEME_MODES.includes(input.theme) ? input.theme : DEFAULT_SETTINGS.theme,
      filtersCollapsed: Boolean(input.filtersCollapsed),
      activityCollapsed: Boolean(input.activityCollapsed),
      layoutMode: LAYOUT_MODES.includes(input.layoutMode) ? input.layoutMode : DEFAULT_SETTINGS.layoutMode,
      cardScale: Number.isFinite(Number(input.cardScale)) ? Math.min(160, Math.max(70, Math.round(Number(input.cardScale) / 5) * 5)) : DEFAULT_SETTINGS.cardScale,
      downloadConcurrency: [1, 2, 3, 4].includes(Number(input.downloadConcurrency)) ? Number(input.downloadConcurrency) : DEFAULT_SETTINGS.downloadConcurrency,
      zipPartSizeMb: [100, 300, 600, 1000].includes(Number(input.zipPartSizeMb)) ? Number(input.zipPartSizeMb) : DEFAULT_SETTINGS.zipPartSizeMb,
      zipPartMaxFiles: [24, 50, 100].includes(Number(input.zipPartMaxFiles)) ? Number(input.zipPartMaxFiles) : DEFAULT_SETTINGS.zipPartMaxFiles,
      archiveLayout: ['flat', 'page', 'page-author', 'reply'].includes(input.archiveLayout) ? input.archiveLayout : DEFAULT_SETTINGS.archiveLayout,
      includeManifest: input.includeManifest !== false,
      dedupeContent: input.dedupeContent !== false,
      warnLargeThreadScan: input.warnLargeThreadScan !== false,
    };
  }

  function currentPreferences() {
    return normalizedPreferences({
      filter: state.filter,
      compact: state.compact,
      sort: state.sort,
      groupBy: state.groupBy,
      perPage: state.perPage,
      theme: state.theme,
      filtersCollapsed: state.filtersCollapsed,
      activityCollapsed: state.activityCollapsed,
      layoutMode: state.layoutMode,
      cardScale: state.cardScale,
      downloadConcurrency: state.downloadConcurrency,
      zipPartSizeMb: state.zipPartSizeMb,
      zipPartMaxFiles: state.zipPartMaxFiles,
      archiveLayout: state.archiveLayout,
      includeManifest: state.includeManifest,
      dedupeContent: state.dedupeContent,
      warnLargeThreadScan: state.warnLargeThreadScan,
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
      app: 'SimpCity Thread Gallery',
      version: APP_VERSION,
      generatedAt: new Date().toISOString(),
      storage: storage.mode,
      legacyStorageMigrated: state.diagnostics.migratedLegacyStorage,
      thread: { id: thread.id || 'unknown', page: pageNumberFromUrl(), knownPages: state.threadPageCount },
      scan: { source: state.sourceLabel, scannedPages: state.scannedPages, scanning: state.scanning },
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
    const densitySelect = panel.querySelector('[data-setting-density]');
    const filtersCollapsed = panel.querySelector('[data-setting-filters-collapsed]');
    const activityCollapsed = panel.querySelector('[data-setting-activity-collapsed]');
    const layoutSelect = panel.querySelector('[data-setting-layout]');
    const cardScale = panel.querySelector('[data-card-scale]');
    const archiveLayout = panel.querySelector('[data-setting-archive-layout]');
    const concurrency = panel.querySelector('[data-setting-download-concurrency]');
    const partSize = panel.querySelector('[data-setting-zip-part-size]');
    const partFiles = panel.querySelector('[data-setting-zip-part-files]');
    const manifest = panel.querySelector('[data-setting-include-manifest]');
    const dedupeContent = panel.querySelector('[data-setting-dedupe-content]');
    const warnLargeScan = panel.querySelector('[data-setting-warn-large-scan]');
    if (themeSelect) themeSelect.value = state.theme;
    if (densitySelect) densitySelect.value = state.compact ? 'compact' : 'comfortable';
    if (filtersCollapsed) filtersCollapsed.checked = state.filtersCollapsed;
    if (activityCollapsed) activityCollapsed.checked = state.activityCollapsed;
    if (layoutSelect) layoutSelect.value = state.layoutMode;
    if (cardScale) cardScale.value = String(state.cardScale);
    if (archiveLayout) archiveLayout.value = state.archiveLayout;
    if (concurrency) concurrency.value = String(state.downloadConcurrency);
    if (partSize) partSize.value = String(state.zipPartSizeMb);
    if (partFiles) partFiles.value = String(state.zipPartMaxFiles);
    if (manifest) manifest.checked = state.includeManifest;
    if (dedupeContent) dedupeContent.checked = state.dedupeContent;
    if (warnLargeScan) warnLargeScan.checked = state.warnLargeThreadScan;
  }

  function openSettingsPanel() {
    const panel = document.querySelector(`#${APP_ID} .scg-settings-panel`);
    if (!panel) return;
    refreshSettingsPanel();
    panel.classList.add('open');
    panel.querySelector('.scg-settings-dialog')?.focus();
  }

  function closeSettingsPanel() {
    document.querySelector(`#${APP_ID} .scg-settings-panel`)?.classList.remove('open');
  }

  function exportSettings(includeHistory = false) {
    const payload = {
      app: 'SimpCity Thread Gallery',
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
        persistDownloadHistory();
      }
      applyPreferences(payload.settings, true);
      updateDownloadedIndicators();
      notify('Settings imported successfully.');
    } catch (error) {
      notify(`Import failed: ${error.message}`, 6000);
    }
  }

  function resetPreferences(clearHistory = false) {
    storage.remove(SETTINGS_KEY);
    if (clearHistory) {
      storage.remove(DOWNLOAD_HISTORY_KEY);
      state.downloadHistory = {};
      updateDownloadedIndicators();
    }
    applyPreferences(DEFAULT_SETTINGS, true);
    notify(clearHistory ? 'Preferences and download history reset.' : 'Preferences reset.');
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
    });
    if (changed) invalidateVisibleItems({ selection: true });
    updateSelectionUi();
  }

  function updateSelectionUi() {
    const app = document.getElementById(APP_ID);
    if (!app) return;
    app.classList.toggle('selecting', state.selectionMode);
    const selected = selectedMediaItems();
    const count = selected.length;
    const countNode = app.querySelector('.scg-selected-count');
    const downloadButton = app.querySelector('[data-action="download-selected"]');
    const clearButton = app.querySelector('[data-action="clear-selection"]');
    if (countNode) countNode.textContent = `${count} selected`;
    if (downloadButton) {
      setIconButton(downloadButton, state.downloading ? 'close' : 'archive', state.downloading ? 'Cancel ZIP queue' : `Download ZIP (${count})`);
      downloadButton.disabled = !count && !state.downloading;
      downloadButton.classList.toggle('cancel-download', state.downloading);
    }
    if (clearButton) clearButton.disabled = !count;
    const modeButton = app.querySelector('[data-action="selection-mode"]');
    if (modeButton) setIconButton(modeButton, state.selectionMode ? 'close' : 'select', state.selectionMode ? 'Exit selection' : `Select media${count ? ` (${count})` : ''}`);
    const visible = state.renderedItems;
    app.querySelectorAll('.scg-card[data-index]').forEach(cardNode => {
      const item = visible[Number(cardNode.dataset.index)];
      const checked = Boolean(item && isDownloadableMedia(item) && state.selected.has(item.selectionKey));
      cardNode.classList.toggle('selected', state.selectionMode && checked);
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
      if (count) count.textContent = `${replySelection.selected} of ${replySelection.total} downloadable selected`;
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
    const finished = jobs.filter(job => terminal.has(job.status)).length;
    const average = jobs.length ? jobs.reduce((sum, job) => {
      if (terminal.has(job.status)) return sum + 1;
      if (job.status === 'packing') return sum + .92 + (.07 * Number(job.packProgress || 0) / 100);
      return sum + (job.total ? Math.min(.92, job.loaded / job.total) : 0);
    }, 0) / jobs.length : 0;
    const percent = p.zipPercent > 0 ? Math.round(p.zipPercent) : Math.round(average * 100);
    const loaded = jobs.reduce((sum, job) => sum + Number(job.loaded || 0), 0);
    const total = jobs.reduce((sum, job) => sum + Number(job.total || 0), 0);
    const totalsKnown = jobs.filter(job => !['skipped', 'duplicate', 'verification', 'failed', 'canceled'].includes(job.status)).every(job => job.total > 0 || job.status === 'queued' || job.status === 'preparing');
    app.classList.toggle('has-downloads', jobs.length > 0);
    app.classList.toggle('downloading', state.downloading);
    progress.classList.add('visible');
    progress.classList.toggle('expanded', state.downloadDetailsOpen);
    progress.querySelector('[data-action="download-details"]')?.setAttribute('aria-expanded', String(state.downloadDetailsOpen));
    progress.querySelector('.scg-progress-fill').style.width = `${percent}%`;
    progress.querySelector('.scg-progress-text').textContent = p.label || (jobs.length ? `${finished} / ${jobs.length}` : 'Downloads idle');
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
    if (signature.mediaType !== expectedMediaType) throw new Error(`Expected ${expectedMediaType}, but the response contains ${signature.mediaType}`);
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
    const expectedMediaType = item.type === 'image' ? 'image' : 'video';
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
    const columns = ['archive_path', 'stored', 'duplicate_of', 'duplicate_archive', 'media_type', 'page', 'reply', 'author', 'host', 'source_url', 'post_url', 'bytes', 'mime', 'resolution_method', 'crc32', 'archive'];
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

  async function bulkDownload() {
    if (state.downloading) {
      state.cancelDownload = true;
      state.downloadProgress.label = 'Canceling active downloads...';
      [...state.activeDownloadRequests].forEach(request => {
        try { request.abort(); } catch { /* The request may have just completed. */ }
      });
      updateDownloadUi();
      return;
    }
    const selected = selectedMediaItems();
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
    updateDownloadUi();
    notify(p.label, 6000);
  }

  function counts() {
    const c = { all: state.items.length, image: 0, video: 0, link: 0, text: 0 };
    state.items.forEach(i => {
      if (i.type === 'image') c.image++;
      else if (i.type === 'video' || i.type === 'embed') c.video++;
      else if (i.type === 'link') c.link++;
      else if (i.type === 'text') c.text++;
    });
    return c;
  }

  function itemSourceHost(item) {
    if (item.type === 'text') return '';
    return hostOf(item.originalLink || item.url || item.postUrl);
  }

  function compareThreadOrder(a, b) {
    return (Number(a.pageNumber || 1) - Number(b.pageNumber || 1)) ||
      (Number(a.postIndex || 0) - Number(b.postIndex || 0)) ||
      (Number(a.mediaIndex || 0) - Number(b.mediaIndex || 0)) ||
      (Number(TYPE_ORDER[a.type] ?? 9) - Number(TYPE_ORDER[b.type] ?? 9));
  }

  function visibleItems() {
    const signature = JSON.stringify([
      datasetRevision, selectionRevision, state.filter, state.query, state.sort, state.groupBy,
      state.authorFilter, state.hostFilter, state.selectedOnly, state.perPage, state.viewPage,
    ]);
    if (visibleItemsCache.signature === signature) return visibleItemsCache.items;
    const q = state.query.trim().toLowerCase();
    const filtered = state.items.filter(item => {
      const typeMatch = state.filter === 'all' || item.type === state.filter ||
        (state.filter === 'video' && item.type === 'embed');
      const host = itemSourceHost(item);
      const authorMatch = state.authorFilter === 'all' || item.author === state.authorFilter;
      const hostMatch = state.hostFilter === 'all' || host === state.hostFilter;
      const selectedMatch = !state.selectedOnly || (isDownloadableMedia(item) && state.selected.has(item.selectionKey));
      return typeMatch && authorMatch && hostMatch && selectedMatch && (!q || item.searchText.includes(q));
    });

    const thread = (a, b) => compareThreadOrder(a, b);
    const alpha = (left, right) => String(left || '').localeCompare(String(right || ''), undefined, { sensitivity: 'base' });
    if (state.sort === 'thread-desc') filtered.sort((a, b) => thread(b, a));
    else if (state.sort === 'author') filtered.sort((a, b) => alpha(a.author, b.author) || thread(a, b));
    else if (state.sort === 'host') filtered.sort((a, b) => alpha(itemSourceHost(a), itemSourceHost(b)) || thread(a, b));
    else if (state.sort === 'type') filtered.sort((a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) || thread(a, b));
    else filtered.sort(thread);
    visibleItemsCache = { signature, items: filtered };
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

  function replyDownloadableItems(key) {
    return state.items.filter(item => replyKey(item) === key && isDownloadableMedia(item));
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
    if (changed) invalidateVisibleItems({ selection: true });
    return changed;
  }

  function buildViewPages(items) {
    const limit = state.perPage;
    if (!items.length) return [[]];
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
        const item = items[Number(entry.target.dataset.resolveIndex)];
        if (!item || item.type !== 'image') return;
        resolveForDisplay(item).then(result => {
          if (result.url && entry.target.isConnected && entry.target.src !== result.url) entry.target.src = result.url;
        });
      });
    }, { root: app.querySelector('.scg-scroll'), rootMargin: '700px 0px', threshold: 0.01 });
    app.querySelectorAll('img[data-resolve-index]').forEach(img => state.imageObserver.observe(img));
  }

  function releaseRenderedMedia() {
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

  function card(item, index) {
    const sourceHost = hostOf(item.originalLink || item.url || item.postUrl);
    const meta = `<div class="scg-meta"><span>${escapeHtml(item.author)}</span><a href="${escapeHtml(item.postUrl)}" target="_blank" rel="noopener">${icon('external')}<span>View post</span></a></div>`;
    const isSelected = state.selectionMode && state.selected.has(item.selectionKey);
    const downloaded = isMediaItem(item) && wasDownloaded(item);
    const legacyDownload = isMediaItem(item) && hasLegacyDownload(item);
    const historyClass = downloaded ? 'downloaded' : (legacyDownload ? 'download-legacy' : '');
    const selection = isDownloadableMedia(item)
      ? `<label class="scg-select" title="Select for bulk download"><input type="checkbox" data-select="${index}" ${state.selected.has(item.selectionKey) ? 'checked' : ''}><span></span></label>`
      : '';
    const typeLabel = item.type === 'image' ? 'IMAGE' : (item.type === 'video' || item.type === 'embed' ? 'VIDEO' : item.type.toUpperCase());
    const historyLabel = downloaded ? 'VERIFIED' : (legacyDownload ? 'LEGACY' : '');
    const historyTitle = downloaded ? 'Validated media recorded in download history' : (legacyDownload ? 'Older unverified history entry; this item will not be skipped' : '');
    const badge = `<div class="scg-badge"><b>${typeLabel}</b><span>${escapeHtml(sourceHost)}</span><em class="scg-saved-status ${historyLabel ? 'visible' : ''} ${legacyDownload ? 'legacy' : ''}" title="${escapeHtml(historyTitle)}">${historyLabel}</em></div>`;
    const actions = `<div class="scg-actions"><button data-open="${index}">${iconWell('info')}<span>View</span></button><button data-download="${index}" class="scg-download-action">${iconWell('download', 'scg-icon-well-primary')}<span>${downloaded ? 'Download again' : (legacyDownload ? 'Download verified copy' : 'Download')}</span></button></div>`;
    if (item.type === 'image') {
      const displayUrl = item.resolution?.candidate?.url || item.url || item.thumb;
      return `<article class="scg-card scg-media ${isSelected ? 'selected' : ''} ${historyClass}" data-index="${index}">${selection}${badge}<button class="scg-preview" data-open="${index}" title="View original image"><img loading="lazy" data-resolve-index="${index}" src="${escapeHtml(displayUrl)}" alt="${escapeHtml(item.caption)}"></button>${actions}${meta}</article>`;
    }
    if (item.type === 'video' && VIDEO_EXT.test(item.url)) {
      return `<article class="scg-card scg-media ${isSelected ? 'selected' : ''} ${historyClass}" data-index="${index}">${selection}${badge}<video controls preload="none" poster="${escapeHtml(item.poster || '')}" src="${escapeHtml(item.url)}"></video>${actions}${meta}</article>`;
    }
    if (item.type === 'video' || item.type === 'embed') {
      const transformed = embedUrl(item.url);
      if (item.wasFrame || transformed !== unwrapSimpcityRedirect(item.url)) {
        return `<article class="scg-card scg-media ${isSelected ? 'selected' : ''} ${historyClass}" data-index="${index}">${selection}${badge}<div class="scg-embed scg-embed-placeholder"><button data-load-player="${index}">${iconWell('play', 'scg-icon-well-primary')}<b>Play video</b><span>Load ${escapeHtml(sourceHost)} player</span></button></div>${actions}${meta}</article>`;
      }
      return `<article class="scg-card scg-linkcard ${isSelected ? 'selected' : ''} ${historyClass}" data-index="${index}">${selection}${badge}<a class="scg-host" href="${escapeHtml(item.url)}" target="_blank" rel="noopener"><strong>${escapeHtml(item.title || 'Open video host')}</strong><small>${escapeHtml(hostOf(item.url))}</small></a>${actions}${meta}</article>`;
    }
    if (item.type === 'link') {
      return `<article class="scg-card scg-linkcard" data-index="${index}">${badge}<a class="scg-host" href="${escapeHtml(item.url)}" target="_blank" rel="noopener"><strong>${escapeHtml(item.title || item.url)}</strong><small>${escapeHtml(hostOf(item.url))}</small></a>${meta}</article>`;
    }
    const expand = item.text.length > 360 ? `<button class="scg-expand" data-expand>${iconWell('chevron')}<span>Show more</span></button>` : '';
    return `<article class="scg-card scg-textcard" data-index="${index}">${badge}<p>${escapeHtml(item.text)}</p>${expand}${meta}</article>`;
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

  function refreshFilterControls() {
    const app = document.getElementById(APP_ID);
    if (!app) return;
    const authors = [...new Set(state.items.map(item => item.author).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const hosts = [...new Set(state.items.map(itemSourceHost).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    state.authorFilter = setSelectOptions(app.querySelector('[data-author-filter]'), [
      { value: 'all', label: `All authors (${authors.length})` },
      ...authors.map(author => ({ value: author, label: author })),
    ], state.authorFilter);
    state.hostFilter = setSelectOptions(app.querySelector('[data-host-filter]'), [
      { value: 'all', label: `All hosts (${hosts.length})` },
      ...hosts.map(host => ({ value: host, label: host })),
    ], state.hostFilter);

    const pageOptions = Array.from({ length: state.threadPageCount }, (_, index) => ({
      value: String(index + 1),
      label: `Page ${index + 1}`,
    }));
    state.sourcePage = Number(setSelectOptions(app.querySelector('[data-source-page]'), pageOptions, state.sourcePage) || 1);
    const sourceSelect = app.querySelector('[data-source-page]');
    if (sourceSelect) sourceSelect.disabled = state.scanning;
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
      const replySelect = state.selectionMode && replySelection.total
        ? `<label class="scg-reply-select">${iconWell('select')}<input type="checkbox" data-reply-select="${escapeHtml(key)}" ${replySelection.checked ? 'checked' : ''} aria-label="Select all downloadable media in ${escapeHtml(replyLabel)}"><span>Select reply</span></label>`
        : '';
      return `<section class="scg-reply-group ${collapsed ? 'collapsed' : ''}" data-reply-key="${escapeHtml(key)}"><header>${replySelect}<button class="scg-reply-toggle" data-reply-toggle="${escapeHtml(key)}" aria-expanded="${String(!collapsed)}" aria-label="${escapeHtml(toggleLabel)}">${iconWell('chevron')}<span>${collapsed ? 'Expand' : 'Collapse'}</span></button><div><b>${escapeHtml(replyLabel)}</b><span>${escapeHtml(first.author || 'Unknown')}</span><span>Page ${Number(first.pageNumber || 1)}</span><span>${group.entries.length} item${group.entries.length === 1 ? '' : 's'}</span><span data-reply-selection-count>${replySelection.selected} of ${replySelection.total} downloadable selected</span><em class="scg-collapsed-status">${collapsed ? 'Collapsed' : ''}</em></div><a href="${escapeHtml(first.postUrl)}" target="_blank" rel="noopener">${icon('external')}<span>View reply</span></a></header><div class="scg-group-grid">${collapsed ? '' : group.entries.map(entry => card(entry.item, entry.index)).join('')}</div></section>`;
    }).join('');
  }

  function updateViewPager(matchedCount) {
    const app = document.getElementById(APP_ID);
    if (!app) return;
    const pageSelect = app.querySelector('[data-view-page]');
    const options = Array.from({ length: state.viewPages }, (_, index) => ({ value: String(index + 1), label: `View ${index + 1}` }));
    setSelectOptions(pageSelect, options, state.viewPage);
    app.querySelector('[data-action="view-prev"]').disabled = state.scanning || state.viewPage <= 1;
    app.querySelector('[data-action="view-next"]').disabled = state.scanning || state.viewPage >= state.viewPages;
    pageSelect.disabled = state.scanning;
    app.querySelector('[data-page-size]').disabled = state.scanning;
    app.querySelector('[data-page-size]').value = String(state.perPage);
    app.querySelector('.scg-view-summary').textContent = `${matchedCount} matched - showing ${state.renderedItems.length}`;
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
    app.classList.toggle('selecting', state.selectionMode);
    app.classList.toggle('grouped-replies', state.groupBy === 'reply');
    applyShellState();
    app.querySelectorAll('[data-filter], [data-search], [data-card-scale], .scg-refinebar button, .scg-refinebar select, .scg-viewbar button, .scg-viewbar select, [data-action="selection-mode"], [data-action="page"], [data-action="load-source-page"]').forEach(control => {
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
    const pages = buildViewPages(matched);
    state.viewPages = pages.length;
    state.viewPage = Math.min(Math.max(1, state.viewPage), state.viewPages);
    state.renderedItems = pages[state.viewPage - 1] || [];
    const grid = app.querySelector('.scg-grid');
    releaseRenderedMedia();
    grid.classList.toggle('grouped', state.groupBy === 'reply');
    grid.innerHTML = state.scanning
      ? skeletonMarkup(state.compact ? 16 : 12)
      : state.renderedItems.length
        ? (state.groupBy === 'reply' ? replyGroupsMarkup(state.renderedItems) : state.renderedItems.map((item, index) => card(item, index)).join(''))
        : emptyStateMarkup();
    if (!state.scanning) observeFullImages(state.renderedItems);
    app.querySelector('.scg-status').textContent = state.scanning
      ? `Scanning ${state.scannedPages || 1} of ${state.threadPageCount}`
      : state.sourceLabel;
    const activityDetail = app.querySelector('[data-activity-detail]');
    if (activityDetail) activityDetail.textContent = state.scanning
      ? `${state.items.length} items indexed Â· media stays unloaded`
      : `${LAYOUT_LABELS[state.layoutMode]} Â· ${matched.length} matched Â· ${state.items.length} indexed Â· view ${state.viewPage} of ${state.viewPages}`;
    setIconButton(app.querySelector('[data-action="thread"]'), state.scanning ? 'close' : 'scan', state.scanning ? 'Cancel scan' : 'Scan entire thread');
    setIconButton(app.querySelector('[data-action="selection-mode"]'), state.selectionMode ? 'close' : 'select', state.selectionMode
      ? 'Exit selection'
      : `Select media${state.selected.size ? ` (${selectedMediaItems().length})` : ''}`);
    const selectedOnly = app.querySelector('[data-selected-only]');
    selectedOnly.classList.toggle('active', state.selectedOnly);
    selectedOnly.setAttribute('aria-pressed', String(Boolean(state.selectedOnly)));
    refreshRefineTrigger();
    app.querySelector('[data-sort]').value = state.sort;
    app.querySelector('[data-group-by]').value = state.groupBy;
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
    const value = `${normalized.width.toLocaleString()} Ã— ${normalized.height.toLocaleString()}`;
    return qualifier ? `${qualifier} Â· ${value}` : value;
  }

  function cachedMediaResolution(item) {
    const dimensions = normalizeMediaDimensions(item?.mediaDimensions?.width, item?.mediaDimensions?.height);
    if (!dimensions) return 'Detectingâ€¦';
    return mediaResolutionText(dimensions, item.mediaDimensions.qualifier || '');
  }

  function updateViewerResolution(box, item, width, height, qualifier = '', mediaUrl = '') {
    const dimensions = normalizeMediaDimensions(width, height);
    if (!box || !item || !dimensions) return false;
    item.mediaDimensions = { ...dimensions, qualifier, mediaUrl: absoluteUrl(mediaUrl), detectedAt: Date.now() };
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

  function bindViewerVideoLifecycle(video, stage) {
    if (!video) return;
    const stopBuffering = () => stage.classList.remove('viewer-buffering');
    video.addEventListener('loadstart', () => stage.classList.add('viewer-buffering'));
    video.addEventListener('waiting', () => stage.classList.add('viewer-buffering'));
    video.addEventListener('canplay', stopBuffering);
    video.addEventListener('playing', stopBuffering);
    video.addEventListener('error', () => {
      stopBuffering();
      stage.innerHTML = '<div class="scg-viewer-error">This video could not be played here. Use Open source to watch it on the host.</div>';
    }, { once: true });
  }

  let viewerChromeTimer = 0;

  function wakeViewerChrome() {
    const box = document.querySelector(`#${APP_ID} .scg-lightbox.open`);
    if (!box) return;
    box.classList.remove('viewer-idle');
    clearTimeout(viewerChromeTimer);
    viewerChromeTimer = window.setTimeout(() => {
      if (box.classList.contains('open') && !state.viewerInfoOpen) box.classList.add('viewer-idle');
    }, 2800);
  }

  function closeLightbox() {
    const box = document.querySelector(`#${APP_ID} .scg-lightbox`);
    if (!box) return;
    clearTimeout(viewerChromeTimer);
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
          <div class="scg-viewer-identity"><b>${state.lightboxIndex + 1}<span>/ ${items.length}</span></b><div><div class="scg-viewer-titleline"><strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong><span class="scg-viewer-resolution" data-viewer-resolution>${escapeHtml(resolutionLabel)}</span></div><small>${escapeHtml(item.author || 'Unknown')} Â· ${escapeHtml(viewerReplyLabel(item))} Â· Page ${Number(item.pageNumber || 1)} Â· ${escapeHtml(sourceHost)}</small></div></div>
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
          <section class="scg-lightbox-stage" data-viewer-stage aria-live="polite"><div class="scg-viewer-loading"><i></i><span>Resolving original mediaâ€¦</span></div></section>
          <aside class="scg-viewer-details">
            <div class="scg-viewer-details-head"><span>${icon(item.type === 'image' ? 'image' : 'video')}</span><div><b>${escapeHtml(typeLabel)}</b><small>${escapeHtml(sourceHost)}</small></div></div>
            ${item.caption ? `<p class="scg-viewer-caption">${escapeHtml(item.caption)}</p>` : ''}
            <dl><div><dt>Resolution</dt><dd data-viewer-resolution>${escapeHtml(resolutionLabel)}</dd></div><div><dt>Posted by</dt><dd>${escapeHtml(item.author || 'Unknown')}</dd></div><div><dt>Location</dt><dd>${escapeHtml(viewerReplyLabel(item))}, page ${Number(item.pageNumber || 1)}</dd></div><div><dt>Download</dt><dd>${escapeHtml(savedLabel)}</dd></div><div><dt>Collection</dt><dd>${items.length} filtered media items</dd></div></dl>
            <div class="scg-viewer-details-links"><a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener">${icon('external')}<span>Open source</span></a><a href="${escapeHtml(item.postUrl)}" target="_blank" rel="noopener">${icon('external')}<span>View reply</span></a></div>
            <p class="scg-viewer-shortcuts"><b>Keys</b><br>â† â†’ previous / next Â· wheel or + âˆ’ zoom Â· 0 fit<br>I details Â· F fullscreen Â· Space play or pause<br>D download Â· S select Â· Esc close</p>
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
    wakeViewerChrome();
    box.querySelector('.scg-viewer-thumb.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
    if (!wasOpen) box.querySelector('[data-viewer-close]')?.focus({ preventScroll: true });

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
      bindViewerVideoResolution(video, box, item, stillCurrent);
    } else if (item.wasFrame || embedUrl(item.url) !== unwrapSimpcityRedirect(item.url)) {
      if (!stillCurrent()) return;
      stage.innerHTML = iframeHtml(item) || '<div class="scg-viewer-error">This host does not expose an embeddable player. Use Open source to watch it on the host.</div>';
      if (!stage.querySelector('iframe')) {
        setViewerResolutionStatus(box, 'Unavailable');
      } else {
        setViewerResolutionStatus(box, 'Detectingâ€¦');
        resolveForDisplay(item).then(async direct => {
          if (!stillCurrent()) return;
          const dimensions = direct?.url ? await probeVideoDimensions(direct.url) : null;
          if (!stillCurrent()) return;
          if (dimensions) updateViewerResolution(box, item, dimensions.width, dimensions.height, '', direct.url);
          else setViewerResolutionStatus(box, 'Host-controlled embed');
        }).catch(() => {
          if (stillCurrent()) setViewerResolutionStatus(box, 'Host-controlled embed');
        });
      }
    } else {
      const direct = await resolveForDisplay(item);
      if (!stillCurrent()) return;
      stage.innerHTML = direct.url
        ? `<video controls autoplay playsinline preload="metadata" poster="${escapeHtml(item.poster || '')}" src="${escapeHtml(direct.url)}"></video>`
        : '<div class="scg-viewer-error">This host does not expose an embeddable player. Use Open source to watch it on the host.</div>';
      const video = stage.querySelector('video');
      bindViewerVideoLifecycle(video, stage);
      bindViewerVideoResolution(video, box, item, stillCurrent);
    }
  }

  function openLightbox(item) {
    const filteredMedia = visibleItems().filter(isMediaItem);
    const items = filteredMedia.includes(item) ? filteredMedia : mediaItems();
    const index = items.indexOf(item);
    if (index < 0) return;
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
    state.selectionMode = false;
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
    if (detail) detail.textContent = `${state.items.length} items indexed Â· media stays unloaded`;
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

  async function scanThread() {
    if (state.downloading) return notify('Finish or cancel the ZIP queue before scanning another page.');
    if (state.scanning) {
      state.cancelScan = true;
      state.scanCanceling = true;
      state.scanController?.abort();
      updateScanStatus();
      return;
    }
    updateThreadPageInfo(document, location.href);
    const detectedPages = Math.max(1, state.threadPageCount);
    if (state.warnLargeThreadScan && detectedPages >= LARGE_THREAD_WARNING_PAGES) {
      if (!await confirmLargeThreadScan(detectedPages)) return;
    }
    state.scanning = true;
    state.cancelScan = false;
    state.scanCanceling = false;
    state.scannedPages = 0;
    state.scanCurrentPage = 0;
    state.scanFailedPages = 0;
    state.scanTotalPages = Math.min(detectedPages, 250);
    state.items = [];
    resetDatasetState();
    state.sourceLabel = 'Entire thread';
    render();

    const seenItems = new Set();
    const controller = new AbortController();
    state.scanController = controller;
    try {
      for (let page = 1; page <= state.scanTotalPages && !state.cancelScan; page++) {
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
          state.scannedPages++;
        } catch (error) {
          if (error?.name === 'AbortError' || state.cancelScan) break;
          state.scanFailedPages++;
          recordDiagnostic('scanFailures', `Whole-thread page ${page}`, error);
        } finally {
          doc = null;
        }
        updateScanStatus();
        if (page < state.scanTotalPages && !state.cancelScan) await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (detectedPages > 250 && !state.cancelScan) {
        state.sourceLabel = 'Partial thread scan (250-page safety limit)';
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
      state.scanController = null;
      state.scanning = false;
      state.scanCanceling = false;
      state.cancelScan = false;
      render();
    }
  }

  function scanCurrentPage() {
    if (state.downloading) return notify('Finish or cancel the ZIP queue before scanning another page.');
    updateThreadPageInfo(document, location.href);
    state.items = dedupe(extractFromDocument(document, location.href));
    resetDatasetState();
    state.sourcePage = pageNumberFromUrl(location.href);
    state.sourceLabel = `Thread page ${state.sourcePage}`;
    state.scannedPages = 1;
    render();
  }

  async function scanSpecificPage(page) {
    if (state.downloading) return notify('Finish or cancel the ZIP queue before scanning another page.');
    if (state.scanning) return;
    const targetPage = Math.min(Math.max(1, Number(page) || 1), state.threadPageCount);
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
      state.scannedPages = 1;
    } catch (error) {
      console.error('[SimpCity Gallery]', error);
      recordDiagnostic('scanFailures', `Page ${targetPage} scan`, error);
      notify(`Could not load page ${targetPage}: ${error.message}`, 5500);
    } finally {
      state.scanning = false;
      render();
    }
  }

  const style = document.createElement('style');
  style.textContent = `

    /* ============================================================
       DARKROOM  -  design system for SimpCity Thread Gallery 0.9.6
       Direction: full-bleed media canvas, floating instrument plate,
       mode-morphing dock. One restrained signal colour per theme.
       ============================================================ */

    /* ---- 1. Design tokens ------------------------------------- */
    #${APP_ID},
    #scg-launch,
    #scg-gallery-toast{
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
      --scg-accent:#4fb3ff;
      --scg-accent-ink:#04121e;
      --scg-accent-soft:#0d2233;
      --scg-accent-line:#1e5279;
      --scg-success:#4ad4a0;
      --scg-success-soft:#0d2a22;
      --scg-warn:#e0b062;
      --scg-warn-soft:#2a2114;
      --scg-danger:#f06b78;
      --scg-danger-soft:#321316;
      --scg-shadow:0 18px 48px #00000094;
      --scg-shadow-sm:0 6px 18px #0000006b;
      --scg-focus:#7cc8ff;
      --scg-select-arrow:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238e97a3' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9.5 6 6 6-6'/%3E%3C/svg%3E");
      --scg-r-sm:8px;
      --scg-r-md:11px;
      --scg-r-lg:16px;
      --scg-r-xl:22px;
      color-scheme:dark;
    }

    #${APP_ID}[data-theme="light"],
    #scg-launch[data-theme="light"],
    #scg-gallery-toast[data-theme="light"]{
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
      --scg-accent:#0a5fc4;
      --scg-accent-ink:#ffffff;
      --scg-accent-soft:#e0ecfc;
      --scg-accent-line:#a6c8ef;
      --scg-success:#0d6b4b;
      --scg-success-soft:#dff2e9;
      --scg-warn:#8a5a08;
      --scg-warn-soft:#fbeed5;
      --scg-danger:#af1f3d;
      --scg-danger-soft:#fce1e7;
      --scg-shadow:0 16px 40px #2c3c5226;
      --scg-shadow-sm:0 5px 14px #2c3c5220;
      --scg-focus:#0a5fc4;
      --scg-select-arrow:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%234f5a68' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9.5 6 6 6-6'/%3E%3C/svg%3E");
      color-scheme:light;
    }

    #${APP_ID}[data-theme="midnight"],
    #scg-launch[data-theme="midnight"],
    #scg-gallery-toast[data-theme="midnight"]{
      --scg-bg:#060912;
      --scg-canvas:#080d1a;
      --scg-surface:#0e1426;
      --scg-surface-2:#131b31;
      --scg-surface-3:#1a2440;
      --scg-well:#03060d;
      --scg-line:#232f52;
      --scg-line-strong:#31406b;
      --scg-text:#e9eefb;
      --scg-text-soft:#bcc7e4;
      --scg-muted:#93a0c2;
      --scg-accent:#8f9dff;
      --scg-accent-ink:#080b1c;
      --scg-accent-soft:#181f4a;
      --scg-accent-line:#39448c;
      --scg-success:#54d9b4;
      --scg-success-soft:#0c2c2c;
      --scg-warn:#dfb066;
      --scg-warn-soft:#2a2317;
      --scg-danger:#ff86a6;
      --scg-danger-soft:#2e1424;
      --scg-focus:#a8b3ff;
      --scg-select-arrow:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2393a0c2' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9.5 6 6 6-6'/%3E%3C/svg%3E");
      color-scheme:dark;
    }

    #${APP_ID}[data-theme="graphite"],
    #scg-launch[data-theme="graphite"],
    #scg-gallery-toast[data-theme="graphite"]{
      --scg-bg:#101011;
      --scg-canvas:#131314;
      --scg-surface:#1a1a1c;
      --scg-surface-2:#202022;
      --scg-surface-3:#292a2d;
      --scg-well:#0a0a0b;
      --scg-line:#34353a;
      --scg-line-strong:#45464c;
      --scg-text:#f1f1f2;
      --scg-text-soft:#cbcbcf;
      --scg-muted:#a1a2a8;
      --scg-accent:#d8b158;
      --scg-accent-ink:#1a1405;
      --scg-accent-soft:#2c2413;
      --scg-accent-line:#5c4c22;
      --scg-success:#63c99a;
      --scg-success-soft:#16261e;
      --scg-warn:#d8b158;
      --scg-warn-soft:#2c2413;
      --scg-danger:#f08a9e;
      --scg-danger-soft:#2b1519;
      --scg-focus:#e3c479;
      --scg-select-arrow:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23a1a2a8' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9.5 6 6 6-6'/%3E%3C/svg%3E");
      color-scheme:dark;
    }

    /* ---- 2. Primitives ---------------------------------------- */
    #${APP_ID},#${APP_ID} *,#${APP_ID} *:before,#${APP_ID} *:after,
    #scg-launch,#scg-launch *,#scg-gallery-toast,#scg-gallery-toast *{
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
    #scg-launch:focus-visible{
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
      font-size:12px;cursor:pointer;
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
      font-size:11px;font-weight:550;line-height:1.3;pointer-events:none;
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
    #scg-launch{
      position:fixed;z-index:2147483645;left:20px;bottom:20px;
      display:inline-flex;align-items:center;gap:12px;
      min-height:66px;padding:0 22px 0 12px;
      border:1px solid var(--scg-line-strong);border-radius:var(--scg-r-xl);
      background:var(--scg-surface);color:var(--scg-text);
      box-shadow:var(--scg-shadow);
      cursor:pointer;
      transition:transform .18s cubic-bezier(.2,.7,.3,1),border-color .18s,box-shadow .18s,background .18s;
    }
    #scg-launch:before{
      content:'';position:absolute;inset:-1px;border-radius:inherit;pointer-events:none;
      background:linear-gradient(150deg,color-mix(in srgb,var(--scg-accent) 26%,transparent),transparent 46%);
      opacity:.5;
    }
    #scg-launch:hover{
      transform:translateY(-2px);
      border-color:color-mix(in srgb,var(--scg-accent) 55%,var(--scg-line-strong));
      box-shadow:var(--scg-shadow),0 0 0 5px color-mix(in srgb,var(--scg-accent) 14%,transparent);
    }
    #scg-launch:active{transform:translateY(0)}
    #scg-launch .scg-launch-icon{
      position:relative;z-index:1;
      display:inline-grid;place-items:center;width:44px;height:44px;flex:none;
      border:1px solid color-mix(in srgb,var(--scg-accent) 45%,transparent);
      border-radius:13px;
      background:color-mix(in srgb,var(--scg-accent) 16%,var(--scg-surface-3));
      color:var(--scg-accent);font-style:normal;
    }
    #scg-launch .scg-launch-icon .scg-icon{width:23px;height:23px;fill:none;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round}
    #scg-launch .scg-launch-copy{position:relative;z-index:1;display:flex;flex-direction:column;gap:3px;text-align:left;min-width:0}
    #scg-launch .scg-launch-copy strong{font-size:14px;font-weight:650;line-height:1.1;letter-spacing:-.005em}
    #scg-launch .scg-launch-copy small{
      color:var(--scg-muted);font-size:11px;line-height:1.1;
      font-variant-numeric:tabular-nums;
    }

    /* ---- 4. Toast --------------------------------------------- */
    #scg-gallery-toast{
      position:fixed;z-index:2147483647;left:50%;bottom:26px;
      max-width:min(640px,calc(100vw - 32px));
      padding:12px 18px;
      border:1px solid var(--scg-line-strong);border-radius:var(--scg-r-lg);
      background:var(--scg-surface);color:var(--scg-text);
      box-shadow:var(--scg-shadow);
      font-size:13px;line-height:1.45;text-align:center;
      opacity:0;visibility:hidden;
      transform:translate(-50%,14px);
      transition:opacity .2s,transform .2s,visibility .2s;
    }
    #scg-gallery-toast.show{opacity:1;visibility:visible;transform:translate(-50%,0)}

    /* ---- 5. Application shell --------------------------------- */
    #${APP_ID}{
      position:fixed;inset:0;z-index:2147483646;
      display:none;overflow:hidden;
      background:var(--scg-bg);color:var(--scg-text);
      font:400 13px/1.45 ui-sans-serif,system-ui,sans-serif;
    }
    #${APP_ID}.open{display:grid;grid-template-rows:auto minmax(0,1fr)}

    /* The instrument plate: one floating unit instead of four glued bars. */
    #${APP_ID} .scg-plate{
      position:relative;z-index:40;
      margin:12px 12px 0;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-lg);
      background:var(--scg-surface);
      box-shadow:var(--scg-shadow-sm);
    }

    #${APP_ID} .scg-header{
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
    #${APP_ID} .scg-brand b{font-size:13px;font-weight:650;letter-spacing:-.01em;line-height:1}
    #${APP_ID} .scg-brand small{
      color:var(--scg-muted);font-size:10.5px;line-height:1;
      text-transform:uppercase;letter-spacing:.08em;font-weight:600;
    }

    #${APP_ID} .scg-thread-context{min-width:0;border-left:1px solid var(--scg-line);padding-left:14px}
    #${APP_ID} .scg-thread-context h1{
      margin:0;font-size:13.5px;font-weight:600;line-height:1.25;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    }
    #${APP_ID} .scg-thread-context>div{
      display:flex;align-items:center;gap:8px;margin-top:4px;min-width:0;
      color:var(--scg-muted);font-size:11px;font-variant-numeric:tabular-nums;
    }
    #${APP_ID} .scg-thread-context>div span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #${APP_ID} .scg-thread-context [data-thread-meta]{
      flex:none;padding:2px 7px;border-radius:99px;
      background:var(--scg-accent-soft);color:var(--scg-accent);
      font-weight:600;font-size:10.5px;
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
      font-size:13px;
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
      font-size:12px;font-weight:550;cursor:pointer;white-space:nowrap;
      transition:background .14s,color .14s,border-color .14s;
    }
    #${APP_ID} .scg-scan-actions button:hover:not(:disabled){background:var(--scg-surface-3);color:var(--scg-text)}
    #${APP_ID} .scg-scan-actions button .scg-icon{color:var(--scg-muted)}
    #${APP_ID} .scg-scan-actions button:hover:not(:disabled) .scg-icon{color:var(--scg-text)}
    #${APP_ID} .scg-scan-actions .scg-scan-thread-danger{
      border-color:#8f2b3d;background:#561521;color:#ffe7eb;
    }
    #${APP_ID} .scg-scan-actions .scg-scan-thread-danger .scg-icon{color:#ffb4c1}
    #${APP_ID} .scg-scan-actions .scg-scan-thread-danger:hover:not(:disabled),
    #${APP_ID} .scg-scan-actions .scg-scan-thread-danger:focus-visible{
      border-color:#d84760;background:#9e263c;color:#ffffff;
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

    /* ---- 7. Header utilities + overflow menu ------------------- */
    #${APP_ID} .scg-header-actions{display:flex;align-items:center;gap:3px;flex:none}
    #${APP_ID} .scg-header-actions button{
      position:relative;
      display:inline-grid;grid-auto-flow:column;place-items:center;gap:7px;
      min-width:36px;min-height:36px;padding:8px;
      border:1px solid transparent;border-radius:var(--scg-r-md);
      background:transparent;color:var(--scg-muted);
      font-size:12px;cursor:pointer;
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
    #${APP_ID} .scg-menu-label{
      padding:7px 9px 5px;color:var(--scg-muted);
      font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;
    }
    #${APP_ID} .scg-menu button{
      display:grid !important;grid-template-columns:18px minmax(0,1fr);align-items:center;gap:10px;
      width:100%;min-height:38px;padding:8px 9px;
      border:1px solid transparent;border-radius:var(--scg-r-sm);
      background:transparent;color:var(--scg-text);
      font-size:12.5px;text-align:left;cursor:pointer;
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
      font-size:12px;cursor:pointer;white-space:nowrap;
      transition:background .14s,color .14s;
    }
    #${APP_ID} .scg-filters button .scg-icon{width:15px;height:15px}
    #${APP_ID} .scg-filters button b{font-weight:550;font-size:12px}
    #${APP_ID} .scg-filters button>span{
      min-width:20px;padding:2px 6px;border-radius:99px;
      background:var(--scg-surface-3);color:var(--scg-muted);
      font-size:10.5px;font-weight:650;text-align:center;
      font-variant-numeric:tabular-nums;
    }
    #${APP_ID} .scg-filters button:hover:not(:disabled){background:var(--scg-surface-3);color:var(--scg-text)}
    #${APP_ID} .scg-filters button.active{
      background:var(--scg-accent);color:var(--scg-accent-ink);
      box-shadow:var(--scg-shadow-sm);
    }
    #${APP_ID} .scg-filters button.active>span{background:color-mix(in srgb,var(--scg-accent-ink) 18%,transparent);color:var(--scg-accent-ink)}
    #${APP_ID} .scg-filters button.active .scg-icon{color:var(--scg-accent-ink)}

    #${APP_ID} .scg-layout-switcher{
      display:inline-flex;align-items:center;gap:2px;flex:none;
      padding:3px;border:1px solid var(--scg-line);border-radius:13px;
      background:var(--scg-surface-2);
    }
    #${APP_ID} .scg-layout-switcher button{
      display:inline-flex;align-items:center;gap:7px;
      min-width:34px;min-height:32px;padding:6px 9px;
      border:1px solid transparent;border-radius:var(--scg-r-sm);
      background:transparent;color:var(--scg-muted);
      font-size:12px;cursor:pointer;
    }
    #${APP_ID} .scg-layout-switcher button>span{font-size:12px}
    #${APP_ID} .scg-layout-switcher button:hover:not(:disabled){background:var(--scg-surface-3);color:var(--scg-text)}
    #${APP_ID} .scg-layout-switcher button.active{
      border-color:var(--scg-line-strong);background:var(--scg-surface);color:var(--scg-text);
      box-shadow:var(--scg-shadow-sm);
    }
    #${APP_ID} .scg-layout-switcher button.active .scg-icon{color:var(--scg-accent)}

    #${APP_ID} .scg-viewbar{display:flex;align-items:center;gap:10px;flex:1;min-width:0;justify-content:flex-end}
    #${APP_ID} .scg-view-summary{
      margin-right:auto;padding-left:2px;
      color:var(--scg-muted);font-size:11.5px;font-variant-numeric:tabular-nums;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    }
    #${APP_ID} .scg-reply-group-actions{display:none;align-items:center;gap:4px}
    #${APP_ID}.grouped-replies .scg-reply-group-actions{display:inline-flex}
    #${APP_ID} .scg-reply-group-actions button{
      display:inline-flex;align-items:center;gap:6px;min-height:30px;padding:5px 8px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-sm);
      background:var(--scg-surface-2);color:var(--scg-text-soft);font-size:11px;cursor:pointer;
    }
    #${APP_ID} .scg-reply-group-actions button:hover{border-color:var(--scg-line-strong);background:var(--scg-surface-3)}
    #${APP_ID} .scg-reply-group-actions [data-action="expand-all"] .scg-icon{transform:rotate(180deg)}
    #${APP_ID} .scg-viewbar label{
      display:inline-flex;align-items:center;gap:7px;flex:none;
      color:var(--scg-muted);font-size:10.5px;font-weight:650;
      text-transform:uppercase;letter-spacing:.08em;
    }
    #${APP_ID} .scg-view-pagination{
      display:inline-flex;align-items:center;gap:3px;flex:none;
      padding:3px;border:1px solid var(--scg-line);border-radius:13px;background:var(--scg-surface-2);
    }
    #${APP_ID} .scg-view-pagination button{
      display:inline-grid;place-items:center;
      min-width:32px;min-height:32px;padding:6px;
      border:1px solid transparent;border-radius:var(--scg-r-sm);
      background:transparent;color:var(--scg-muted);cursor:pointer;
    }
    #${APP_ID} .scg-view-pagination button:hover:not(:disabled){background:var(--scg-surface-3);color:var(--scg-text)}
    #${APP_ID} .scg-view-pagination button>span{display:none}
    #${APP_ID} .scg-view-pagination select{min-height:32px;min-width:92px;border-color:transparent;background-color:transparent}
    #${APP_ID} .scg-viewbar [data-page-size]{min-width:74px}
    #${APP_ID} .scg-size-control{gap:8px;min-width:178px}
    #${APP_ID} .scg-size-control>span{white-space:nowrap}
    #${APP_ID} [data-card-scale]{
      width:88px;height:20px;padding:0;border:0;background:transparent;accent-color:var(--scg-accent);cursor:pointer;
    }
    #${APP_ID} [data-card-scale]::-webkit-slider-runnable-track{height:4px;border-radius:99px;background:var(--scg-line-strong)}
    #${APP_ID} [data-card-scale]::-webkit-slider-thumb{width:16px;height:16px;margin-top:-6px;border:2px solid var(--scg-surface);border-radius:50%;background:var(--scg-accent);box-shadow:0 1px 5px #0008;-webkit-appearance:none}
    #${APP_ID} [data-card-scale]::-moz-range-track{height:4px;border-radius:99px;background:var(--scg-line-strong)}
    #${APP_ID} [data-card-scale]::-moz-range-thumb{width:14px;height:14px;border:2px solid var(--scg-surface);border-radius:50%;background:var(--scg-accent);box-shadow:0 1px 5px #0008}
    #${APP_ID} [data-card-scale-value]{min-width:38px;color:var(--scg-text-soft);font-size:10.5px;font-weight:700;text-align:right;font-variant-numeric:tabular-nums}
    #${APP_ID} [data-card-scale]:disabled{opacity:.38;cursor:not-allowed}

    /* Refine: progressive disclosure for the low-frequency facets. */
    #${APP_ID} .scg-refine-wrap{position:relative;display:inline-flex;flex:none}
    #${APP_ID} .scg-refine-trigger{
      display:inline-flex;align-items:center;gap:7px;
      min-height:38px;padding:8px 12px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-md);
      background:var(--scg-surface-2);color:var(--scg-text-soft);
      font-size:12px;font-weight:550;cursor:pointer;white-space:nowrap;
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
      font-style:normal;font-size:10px;font-weight:700;
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
      color:var(--scg-muted);font-size:10px;font-weight:700;
      text-transform:uppercase;letter-spacing:.1em;
    }
    #${APP_ID} .scg-refinebar{
      display:grid;grid-template-columns:1fr 1fr;gap:10px;
      padding:12px 14px 14px;
    }
    #${APP_ID} .scg-refinebar label{
      display:flex;flex-direction:column;gap:6px;min-width:0;
      color:var(--scg-muted);font-size:10px;font-weight:700;
      text-transform:uppercase;letter-spacing:.08em;
    }
    #${APP_ID} .scg-refinebar select{width:100%;min-height:36px;font-size:12.5px}
    #${APP_ID} .scg-refinebar button{
      display:inline-flex;align-items:center;justify-content:center;gap:7px;
      min-height:36px;padding:8px 10px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-md);
      background:var(--scg-surface-2);color:var(--scg-text-soft);
      font-size:12px;cursor:pointer;
    }
    #${APP_ID} .scg-refinebar button:hover:not(:disabled){background:var(--scg-surface-3);color:var(--scg-text)}
    #${APP_ID} .scg-refinebar button .scg-icon{color:var(--scg-muted)}
    #${APP_ID} .scg-refinebar button.active{
      border-color:color-mix(in srgb,var(--scg-accent) 45%,transparent);
      background:var(--scg-accent-soft);color:var(--scg-accent);
    }
    #${APP_ID} .scg-refinebar button.active .scg-icon{color:var(--scg-accent)}
    #${APP_ID} .scg-refine-spacer{display:none}


    /* ---- 9. Canvas -------------------------------------------- */
    #${APP_ID} .scg-stage{position:relative;min-width:0;min-height:0}
    #${APP_ID} .scg-scroll{
      position:absolute;inset:12px 12px 0;
      overflow-x:hidden;overflow-y:auto;
      padding:16px 16px 110px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-lg) var(--scg-r-lg) 0 0;
      border-bottom:0;
      background:var(--scg-canvas);
      box-shadow:inset 0 1px 0 color-mix(in srgb,#ffffff 4%,transparent);
      scroll-behavior:smooth;
    }
    #${APP_ID} .scg-top{
      position:absolute;z-index:26;right:26px;bottom:96px;
      display:none;align-items:center;gap:8px;
      min-height:38px;padding:9px 14px;
      border:1px solid var(--scg-line-strong);border-radius:99px;
      background:var(--scg-surface);color:var(--scg-text);
      box-shadow:var(--scg-shadow);
      font-size:12px;font-weight:550;cursor:pointer;
    }
    #${APP_ID} .scg-top.visible{display:inline-flex}
    #${APP_ID} .scg-top:hover{border-color:color-mix(in srgb,var(--scg-accent) 50%,var(--scg-line-strong))}
    #${APP_ID} .scg-top .scg-icon{color:var(--scg-accent)}

    /* Layout: masonry */
    #${APP_ID}[data-layout="masonry"] .scg-grid:not(.grouped){display:block;columns:5 var(--scg-masonry-width,280px);column-gap:14px}
    #${APP_ID}[data-layout="masonry"].compact .scg-grid:not(.grouped){columns:7 var(--scg-masonry-compact-width,195px);column-gap:10px}
    #${APP_ID}[data-layout="masonry"] .scg-group-grid{columns:5 var(--scg-group-width,250px);column-gap:12px;padding:12px}
    #${APP_ID}[data-layout="masonry"].compact .scg-group-grid{columns:7 var(--scg-group-compact-width,180px);column-gap:9px}
    #${APP_ID}[data-layout="masonry"] .scg-card,
    #${APP_ID}[data-layout="masonry"] .scg-skeleton{break-inside:avoid;margin:0 0 14px}
    #${APP_ID}[data-layout="masonry"].compact .scg-card,
    #${APP_ID}[data-layout="masonry"].compact .scg-skeleton{margin-bottom:10px}

    /* Layout: uniform grid */
    #${APP_ID}[data-layout="grid"] .scg-grid:not(.grouped),
    #${APP_ID}[data-layout="grid"] .scg-group-grid{
      display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,var(--scg-grid-min,250px)),1fr));gap:14px;columns:auto;
    }
    #${APP_ID}[data-layout="grid"].compact .scg-grid:not(.grouped),
    #${APP_ID}[data-layout="grid"].compact .scg-group-grid{grid-template-columns:repeat(auto-fill,minmax(min(100%,var(--scg-grid-compact-min,180px)),1fr));gap:10px}
    #${APP_ID}[data-layout="grid"] .scg-group-grid{padding:12px}
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

    /* Layout: feed */
    #${APP_ID}[data-layout="feed"] .scg-grid:not(.grouped),
    #${APP_ID}[data-layout="feed"] .scg-group-grid{
      display:grid;grid-template-columns:minmax(0,1100px);justify-content:center;gap:14px;columns:auto;
    }
    #${APP_ID}[data-layout="feed"] .scg-group-grid{max-width:1140px;margin:auto;padding:14px}
    #${APP_ID}[data-layout="feed"] .scg-card{width:100%;min-width:0;margin:0;break-inside:auto}
    #${APP_ID}[data-layout="feed"] .scg-media,
    #${APP_ID}[data-layout="feed"] .scg-linkcard{
      display:grid;grid-template-columns:minmax(260px,46%) minmax(0,1fr);
      grid-template-areas:"visual actions" "visual meta";
      grid-template-rows:1fr auto;min-height:252px;
    }
    #${APP_ID}[data-layout="feed"].compact .scg-media,
    #${APP_ID}[data-layout="feed"].compact .scg-linkcard{min-height:206px}
    #${APP_ID}[data-layout="feed"] .scg-preview,
    #${APP_ID}[data-layout="feed"] .scg-card>video,
    #${APP_ID}[data-layout="feed"] .scg-embed,
    #${APP_ID}[data-layout="feed"] .scg-host{
      grid-area:visual;width:100%;height:100%;min-height:252px;border-right:1px solid var(--scg-line);
    }
    #${APP_ID}[data-layout="feed"].compact .scg-preview,
    #${APP_ID}[data-layout="feed"].compact .scg-card>video,
    #${APP_ID}[data-layout="feed"].compact .scg-embed,
    #${APP_ID}[data-layout="feed"].compact .scg-host{min-height:206px}
    #${APP_ID}[data-layout="feed"] .scg-preview{overflow:hidden}
    #${APP_ID}[data-layout="feed"] .scg-preview img,
    #${APP_ID}[data-layout="feed"] .scg-card>video{width:100%;height:100%;max-height:540px;object-fit:contain}
    #${APP_ID}[data-layout="feed"] .scg-embed{aspect-ratio:auto}
    #${APP_ID}[data-layout="feed"] .scg-host{justify-content:center;padding:44px 24px 24px}
    #${APP_ID}[data-layout="feed"] .scg-actions{grid-area:actions;align-self:end;border-top:0;border-left:1px solid var(--scg-line);background:transparent}
    #${APP_ID}[data-layout="feed"] .scg-meta{grid-area:meta;border-left:1px solid var(--scg-line);border-top:1px solid var(--scg-line)}
    #${APP_ID}[data-layout="feed"] .scg-textcard{max-width:900px;justify-self:center}
    #${APP_ID}[data-layout="feed"] .scg-textcard p{-webkit-line-clamp:12}
    #${APP_ID}[data-layout="feed"] .scg-skeleton{display:grid;grid-template-columns:minmax(260px,46%) minmax(0,1fr);height:252px;margin:0}
    #${APP_ID}[data-layout="feed"] .scg-skeleton-media{height:100%;grid-row:1/4}
    #${APP_ID}[data-layout="feed"] .scg-skeleton-line{align-self:end}
    #${APP_ID}[data-layout="feed"] .scg-grid.grouped,
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

    #${APP_ID} .scg-badge{
      position:absolute;z-index:7;top:9px;right:9px;
      display:flex;align-items:center;gap:6px;max-width:calc(100% - 60px);
      padding:4px 8px;
      border:1px solid color-mix(in srgb,#ffffff 14%,transparent);
      border-radius:99px;
      background:#0b0d10f2;color:#dfe4ea;
      font-size:10px;font-weight:600;
      box-shadow:0 2px 7px #00000052;
    }
    #${APP_ID} .scg-badge b{
      color:#ffffff;font-size:9.5px;font-weight:700;
      text-transform:uppercase;letter-spacing:.09em;
    }
    #${APP_ID} .scg-badge span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.82}
    #${APP_ID} .scg-saved-status{
      display:none;padding:2px 6px;border-radius:99px;
      background:var(--scg-success);color:#04140e;
      font-size:9px;font-style:normal;font-weight:800;letter-spacing:.05em;
    }
    #${APP_ID} .scg-saved-status.visible{display:inline-block}
    #${APP_ID} .scg-saved-status.legacy{background:var(--scg-warn);color:#1c1405}

    #${APP_ID} .scg-select{position:absolute;z-index:8;top:9px;left:9px;display:none;width:30px;height:30px;cursor:pointer}
    #${APP_ID}.selecting .scg-select{display:block}
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
      font-size:12px;font-weight:550;cursor:pointer;
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
      color:var(--scg-muted);font-size:11.5px;
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
    #${APP_ID} .scg-host strong{font-size:13.5px;word-break:break-word}
    #${APP_ID} .scg-host small{color:var(--scg-muted);font-size:11px}
    #${APP_ID} .scg-host:hover{background:linear-gradient(150deg,var(--scg-accent-soft),var(--scg-surface-2))}

    #${APP_ID} .scg-textcard p{
      display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:8;
      overflow:hidden;margin:0;padding:44px 14px 12px;
      color:var(--scg-text-soft);font-size:12.5px;line-height:1.55;white-space:pre-wrap;
    }
    #${APP_ID} .scg-textcard p.expanded{display:block;-webkit-line-clamp:unset}
    #${APP_ID} .scg-expand{
      display:flex;align-items:center;justify-content:center;gap:7px;
      width:calc(100% - 20px);min-height:32px;margin:0 10px 8px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-sm);
      background:transparent;color:var(--scg-accent);
      font-size:11.5px;font-weight:600;cursor:pointer;
    }
    #${APP_ID} .scg-expand:hover{background:var(--scg-accent-soft)}
    #${APP_ID} .scg-expand .scg-icon{transition:transform .18s ease}
    #${APP_ID} .scg-expand.expanded .scg-icon{transform:rotate(180deg)}

    #${APP_ID} .scg-embed{position:relative;width:100%;aspect-ratio:16/9;background:var(--scg-well)}
    #${APP_ID} .scg-embed iframe{display:block;width:100%;height:100%;border:0}
    #${APP_ID} .scg-embed-placeholder{
      display:grid;place-items:center;min-height:160px;
      background:radial-gradient(circle at 50% 6%,var(--scg-surface-3),var(--scg-well) 72%);
    }
    #${APP_ID} .scg-embed-placeholder button{
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
    #${APP_ID} .scg-embed-placeholder button b{font-size:13px}
    #${APP_ID} .scg-embed-placeholder button span{color:var(--scg-muted);font-size:11px}

    /* ---- 11. Empty + skeleton --------------------------------- */
    #${APP_ID} .scg-empty{
      display:flex;flex-direction:column;align-items:center;gap:10px;
      padding:88px 24px;text-align:center;
      color:var(--scg-muted);font-size:13.5px;
      column-span:all;grid-column:1/-1;
    }
    #${APP_ID} .scg-empty .scg-empty-art{
      display:grid;place-items:center;width:64px;height:64px;
      border:1px solid var(--scg-line);border-radius:20px;
      background:var(--scg-surface);color:var(--scg-muted);
    }
    #${APP_ID} .scg-empty .scg-empty-art .scg-icon{width:28px;height:28px}
    #${APP_ID} .scg-empty b{color:var(--scg-text);font-size:15px;font-weight:600}
    #${APP_ID} .scg-empty span{max-width:420px;font-size:12.5px;line-height:1.55}

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
    #${APP_ID} .scg-reply-group{
      margin:0 0 16px;overflow:hidden;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-lg);
      background:var(--scg-surface);box-shadow:var(--scg-shadow-sm);
    }
    #${APP_ID} .scg-reply-group>header{
      display:flex;align-items:center;justify-content:space-between;gap:12px;
      padding:11px 14px;
      border-bottom:1px solid var(--scg-line);background:var(--scg-surface-2);
    }
    #${APP_ID} .scg-reply-group>header>div{display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-width:0}
    #${APP_ID} .scg-reply-group>header b{font-size:12.5px;color:var(--scg-text)}
    #${APP_ID} .scg-reply-group>header span{color:var(--scg-muted);font-size:11.5px}
    #${APP_ID} .scg-reply-group>header a{
      display:inline-flex;align-items:center;gap:6px;flex:none;
      padding:5px 9px;border:1px solid var(--scg-line);border-radius:var(--scg-r-sm);
      color:var(--scg-accent);text-decoration:none;font-size:11.5px;font-weight:550;white-space:nowrap;
    }
    #${APP_ID} .scg-reply-group>header a:hover{background:var(--scg-accent-soft)}
    #${APP_ID} .scg-reply-group>header a .scg-icon{width:14px;height:14px}


    /* ---- 13. The dock (status / selection / downloads) --------- */
    #${APP_ID} .scg-activitybar{
      position:absolute;z-index:30;left:50%;bottom:14px;transform:translateX(-50%);
      display:flex;align-items:center;gap:10px;flex-wrap:nowrap;
      width:min(1220px,calc(100% - 28px));
      padding:8px 10px;
      border:1px solid var(--scg-line-strong);border-radius:var(--scg-r-xl);
      background:color-mix(in srgb,var(--scg-surface) 92%,transparent);
      box-shadow:var(--scg-shadow);
      backdrop-filter:blur(20px) saturate(130%);
      transition:width .2s ease,padding .2s ease;
    }
    #${APP_ID}.activity-collapsed .scg-activitybar{width:min(760px,calc(100% - 28px));padding:5px 8px}

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
      color:var(--scg-text);font-size:12px;font-weight:600;
      text-overflow:ellipsis;white-space:nowrap;
    }
    #${APP_ID} .scg-activity-state span{
      overflow:hidden;color:var(--scg-muted);font-size:11px;
      text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums;
    }
    #${APP_ID}.activity-collapsed .scg-activity-state span{display:none}

    #${APP_ID} .scg-activitybar button{
      display:inline-flex;align-items:center;justify-content:center;gap:7px;
      min-height:34px;padding:7px 10px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-md);
      background:var(--scg-surface-2);color:var(--scg-text-soft);
      font-size:12px;font-weight:550;cursor:pointer;white-space:nowrap;
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

    #${APP_ID} .scg-selection-toggle{flex:none}
    #${APP_ID}.selecting .scg-selection-toggle{
      border-color:color-mix(in srgb,var(--scg-accent) 50%,transparent);
      background:var(--scg-accent-soft);color:var(--scg-accent);
    }
    #${APP_ID}.selecting .scg-selection-toggle .scg-icon{color:var(--scg-accent)}

    #${APP_ID} .scg-bulk-actions{display:none;align-items:center;gap:6px;min-width:0;flex:1}
    #${APP_ID}.selecting .scg-bulk-actions,
    #${APP_ID}.downloading .scg-bulk-actions{display:flex}
    #${APP_ID}.downloading:not(.selecting) .scg-bulk-actions{flex:0 0 auto}
    #${APP_ID}.downloading:not(.selecting) .scg-bulk-actions>*:not([data-action="download-selected"]){display:none}
    #${APP_ID} .scg-activitybar .cancel-download{
      border-color:color-mix(in srgb,var(--scg-danger) 65%,transparent);
      background:var(--scg-danger-soft);color:var(--scg-danger);
    }
    #${APP_ID} .scg-activitybar .cancel-download .scg-icon{color:var(--scg-danger)}
    #${APP_ID} .scg-activitybar .cancel-download:hover:not(:disabled){
      border-color:var(--scg-danger);background:color-mix(in srgb,var(--scg-danger-soft) 72%,var(--scg-danger));color:#ffffff;
    }
    #${APP_ID} .scg-activitybar .cancel-download:hover:not(:disabled) .scg-icon{color:#ffffff}
    #${APP_ID} .scg-bulk-label{
      flex:none;color:var(--scg-muted);
      font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;
    }
    #${APP_ID} .scg-selected-count{
      flex:none;margin-left:auto;padding:0 4px;
      color:var(--scg-text);font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;
    }
    #${APP_ID}.selecting .scg-activity-state{flex:0 0 auto}
    #${APP_ID}.selecting .scg-activity-state>div{display:none}

    #${APP_ID} .scg-progress{position:relative;display:flex;min-width:220px;max-width:440px;flex:1 1 300px}
    #${APP_ID}.selecting .scg-progress{display:none}
    #${APP_ID}.selecting.has-downloads .scg-progress,
    #${APP_ID}.selecting.downloading .scg-progress{display:flex;min-width:150px;max-width:320px;flex:1 1 220px}
    #${APP_ID} .scg-progress-summary{
      display:flex !important;align-items:center;gap:10px;width:100%;min-width:0;
      min-height:34px;padding:6px 11px !important;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-md);
      background:var(--scg-surface-2);color:var(--scg-text-soft);cursor:pointer;
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
      color:var(--scg-muted);font-size:11.5px;text-align:right;
      text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums;
    }
    #${APP_ID}.activity-collapsed .scg-progress{min-width:120px;max-width:260px;flex:0 1 260px}
    #${APP_ID}.activity-collapsed .scg-progress-track{display:none}

    #${APP_ID} .scg-activity-toggle{flex:none;min-width:34px;padding:7px !important}
    #${APP_ID} .scg-activity-toggle span{display:none}
    #${APP_ID} .scg-activity-toggle .scg-icon{transition:transform .18s ease}
    #${APP_ID}.activity-collapsed .scg-activity-toggle .scg-icon{transform:rotate(180deg)}

    /* Download queue popover */
    #${APP_ID} .scg-download-popover{
      display:none;position:absolute;z-index:320;right:0;bottom:calc(100% + 10px);
      width:min(520px,calc(100vw - 32px));max-height:min(540px,66vh);
      overflow:hidden;
      border:1px solid var(--scg-line-strong);border-radius:var(--scg-r-lg);
      background:var(--scg-surface);color:var(--scg-text);
      box-shadow:var(--scg-shadow);
    }
    #${APP_ID} .scg-progress.expanded .scg-download-popover,
    #${APP_ID} .scg-progress:focus-within .scg-download-popover{display:block}
    #${APP_ID} .scg-download-popover>header{
      display:flex;align-items:center;justify-content:space-between;gap:12px;
      padding:11px 13px;
      border-bottom:1px solid var(--scg-line);background:var(--scg-surface-2);
    }
    #${APP_ID} .scg-download-popover>header b{font-size:13px}
    #${APP_ID} .scg-download-popover>header>div{display:flex;align-items:center;gap:5px}
    #${APP_ID} .scg-download-popover>header button{
      display:inline-flex;align-items:center;gap:6px;
      min-height:30px;padding:5px 9px !important;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-sm);
      background:var(--scg-surface);color:var(--scg-text-soft);
      font-size:11px;cursor:pointer;
    }
    #${APP_ID} .scg-download-popover>header button:hover{background:var(--scg-surface-3);color:var(--scg-text)}
    #${APP_ID} .scg-download-overall{
      padding:10px 13px;border-bottom:1px solid var(--scg-line);
      color:var(--scg-muted);font-size:11.5px;font-variant-numeric:tabular-nums;
    }
    #${APP_ID} .scg-download-jobs{max-height:min(420px,48vh);overflow:auto;padding:8px}
    #${APP_ID} .scg-download-job{padding:9px 10px;border-radius:var(--scg-r-md);contain:content}
    #${APP_ID} .scg-download-job+.scg-download-job{border-top:1px solid var(--scg-line)}
    #${APP_ID} .scg-download-job>div:first-child{display:flex;align-items:center;justify-content:space-between;gap:12px}
    #${APP_ID} .scg-download-job b{
      min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
      color:var(--scg-text);font-size:11.5px;font-weight:550;
    }
    #${APP_ID} .scg-download-job span{flex:none;color:var(--scg-muted);font-size:10.5px;font-variant-numeric:tabular-nums}
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
    #${APP_ID} .scg-download-empty{padding:28px;text-align:center;color:var(--scg-muted);font-size:12px}

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
    #${APP_ID} .scg-settings-head h2{margin:0;font-size:17px;font-weight:650;letter-spacing:-.01em}
    #${APP_ID} .scg-settings-head p{margin:3px 0 0;color:var(--scg-muted);font-size:12px}
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
    #${APP_ID} .scg-settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
    #${APP_ID} .scg-settings-card{
      padding:15px;border:1px solid var(--scg-line);border-radius:var(--scg-r-lg);
      background:var(--scg-surface-2);
    }
    #${APP_ID} .scg-settings-card.full{grid-column:1/-1}
    #${APP_ID} .scg-settings-card h3{
      display:flex;align-items:center;gap:9px;margin:0 0 6px;
      color:var(--scg-text);font-size:13.5px;font-weight:650;
    }
    #${APP_ID} .scg-settings-card h3 .scg-icon{color:var(--scg-accent)}
    #${APP_ID} .scg-settings-card>p{margin:0 0 13px;color:var(--scg-muted);font-size:12px;line-height:1.5}
    #${APP_ID} .scg-settings-version{
      display:inline-flex;align-items:center;margin-left:auto;padding:3px 8px;
      border:1px solid var(--scg-accent-line);border-radius:99px;
      background:var(--scg-accent-soft);color:var(--scg-accent);
      font-size:10.5px;font-weight:650;
    }
    #${APP_ID} .scg-setting-fields{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    #${APP_ID} .scg-setting-fields label{
      display:flex;flex-direction:column;gap:6px;min-width:0;
      color:var(--scg-muted);font-size:10px;font-weight:700;
      text-transform:uppercase;letter-spacing:.08em;
    }
    #${APP_ID} .scg-setting-fields select{width:100%;min-height:36px;font-size:12.5px}
    #${APP_ID} .scg-setting-size>span{display:flex;align-items:center;gap:10px;min-height:36px;padding:7px 10px;border:1px solid var(--scg-line);border-radius:var(--scg-r-md);background:var(--scg-surface)}
    #${APP_ID} .scg-setting-size [data-card-scale]{width:100%;flex:1}
    #${APP_ID} .scg-download-settings{grid-template-columns:repeat(4,minmax(0,1fr))}
    #${APP_ID} .scg-archive-checks{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;margin-top:10px}
    #${APP_ID} .scg-settings-check{
      display:flex;align-items:flex-start;gap:9px;margin:10px 0;
      color:var(--scg-muted);font-size:11.5px;line-height:1.5;cursor:pointer;
    }
    #${APP_ID} .scg-settings-check input{margin-top:1px;flex:none}
    #${APP_ID} .scg-settings-check:hover{color:var(--scg-text-soft)}
    #${APP_ID} .scg-settings-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    #${APP_ID} .scg-settings-actions button{
      display:inline-flex;align-items:center;justify-content:center;gap:7px;
      min-height:36px;padding:8px 12px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-md);
      background:var(--scg-surface);color:var(--scg-text);
      font-size:12px;font-weight:550;cursor:pointer;
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
      font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;
    }
    #${APP_ID} .scg-diag-stat b{
      display:block;margin-top:5px;overflow:hidden;text-overflow:ellipsis;
      color:var(--scg-text);font-size:12px;font-variant-numeric:tabular-nums;
    }
    #${APP_ID} .scg-storage-note{
      display:flex;align-items:flex-start;gap:9px;padding:10px 12px;
      border:1px solid color-mix(in srgb,var(--scg-success) 34%,var(--scg-line));
      border-radius:var(--scg-r-md);
      background:var(--scg-success-soft);color:var(--scg-text-soft);font-size:11.5px;line-height:1.5;
    }
    #${APP_ID} .scg-storage-note .scg-icon{color:var(--scg-success);margin-top:1px}
    #${APP_ID} .scg-permission-note{
      padding:11px 13px;border-left:3px solid var(--scg-accent);border-radius:0 var(--scg-r-sm) var(--scg-r-sm) 0;
      background:var(--scg-accent-soft);color:var(--scg-text-soft);font-size:11.5px;line-height:1.55;
    }
    #${APP_ID} .scg-settings-foot{
      display:flex;align-items:center;justify-content:space-between;gap:12px;
      padding:12px 18px;border-top:1px solid var(--scg-line);
      background:var(--scg-surface-2);color:var(--scg-muted);font-size:11.5px;
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
    #${APP_ID} .scg-confirm-dialog h2{margin:0;color:var(--scg-text);font-size:16.5px;font-weight:650}
    #${APP_ID} .scg-confirm-dialog p{margin:9px 0 20px;color:var(--scg-muted);font-size:12.5px;line-height:1.55}
    #${APP_ID} .scg-confirm-preference{
      display:flex;align-items:center;justify-content:center;gap:8px;
      margin:-8px 0 18px;color:var(--scg-text-soft);font-size:12px;cursor:pointer;
    }
    #${APP_ID} .scg-reply-toggle{
      display:inline-flex;align-items:center;gap:5px;flex:none;
      min-height:30px;padding:5px 8px;border:1px solid var(--scg-line);border-radius:var(--scg-r-sm);
      background:var(--scg-surface);color:var(--scg-text-soft);font-size:11px;cursor:pointer;
    }
    #${APP_ID} .scg-reply-select{
      display:none;align-items:center;gap:6px;flex:none;min-height:30px;padding:5px 8px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-sm);
      background:var(--scg-surface);color:var(--scg-text-soft);font-size:11px;cursor:pointer;
    }
    #${APP_ID}.selecting .scg-reply-select{display:inline-flex}
    #${APP_ID} .scg-reply-select input{width:16px;height:16px;margin:0;accent-color:var(--scg-accent);cursor:pointer}
    #${APP_ID} .scg-reply-select .scg-icon{color:var(--scg-accent)}
    #${APP_ID} .scg-reply-toggle:hover{border-color:var(--scg-line-strong);background:var(--scg-surface-3)}
    #${APP_ID} .scg-reply-toggle .scg-icon{transition:transform .18s ease}
    #${APP_ID} .scg-reply-toggle[aria-expanded="false"] .scg-icon{transform:rotate(-90deg)}
    #${APP_ID} .scg-reply-group.collapsed>header{border-bottom:0}
    #${APP_ID} .scg-collapsed-status{color:var(--scg-accent);font-size:10px;font-style:normal;font-weight:650;text-transform:uppercase;letter-spacing:.06em}
    #${APP_ID} .scg-confirm-preference[hidden]{display:none}
    #${APP_ID} .scg-confirm-preference input{accent-color:var(--scg-accent)}
    #${APP_ID} .scg-confirm-dialog>div:last-child{display:flex;justify-content:center;gap:9px}
    #${APP_ID} .scg-confirm-dialog button{
      display:inline-flex;align-items:center;justify-content:center;gap:7px;
      min-width:120px;min-height:40px;padding:10px 15px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-md);
      background:var(--scg-surface-2);color:var(--scg-text);
      font-size:12.5px;font-weight:550;cursor:pointer;
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
      border:1px solid var(--scg-line-strong);border-radius:var(--scg-r-lg);
      background:color-mix(in srgb,var(--scg-surface) 88%,transparent);
      box-shadow:var(--scg-shadow);
      backdrop-filter:blur(22px) saturate(135%);
      transition:opacity .26s ease,transform .26s ease;
    }
    #${APP_ID} .scg-viewer-identity{display:flex;align-items:center;gap:14px;min-width:0;flex:1}
    #${APP_ID} .scg-viewer-identity>b{
      display:inline-flex;align-items:baseline;gap:3px;flex:none;
      padding:5px 10px;border:1px solid var(--scg-line);border-radius:99px;
      background:var(--scg-surface-2);color:var(--scg-text);
      font-size:14px;font-weight:650;font-variant-numeric:tabular-nums;
    }
    #${APP_ID} .scg-viewer-identity>b span{color:var(--scg-muted);font-size:11px;font-weight:550}
    #${APP_ID} .scg-viewer-identity>div{min-width:0}
    #${APP_ID} .scg-viewer-titleline{display:flex;align-items:center;gap:9px;min-width:0}
    #${APP_ID} .scg-viewer-titleline strong{
      min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
      font-size:13px;font-weight:600;
    }
    #${APP_ID} .scg-viewer-resolution{
      display:inline-flex;align-items:center;flex:none;
      padding:3px 8px;border:1px solid var(--scg-accent-line);border-radius:99px;
      background:var(--scg-accent-soft);color:var(--scg-accent);
      font-size:10.5px;font-weight:650;font-variant-numeric:tabular-nums;white-space:nowrap;
    }
    #${APP_ID} .scg-viewer-identity small{
      display:block;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
      max-width:min(760px,54vw);color:var(--scg-muted);font-size:11px;
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
      font-size:11px;font-weight:650;font-variant-numeric:tabular-nums;
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
    @keyframes scg-viewer-spin{to{transform:rotate(360deg)}}
    #${APP_ID} .scg-viewer-loading{display:flex;align-items:center;gap:11px;color:var(--scg-muted);font-size:12px}
    #${APP_ID} .scg-viewer-loading i{
      width:19px;height:19px;
      border:2px solid color-mix(in srgb,var(--scg-text) 20%,transparent);
      border-top-color:var(--scg-accent);border-radius:99px;
      animation:scg-viewer-spin .75s linear infinite;
    }
    #${APP_ID} .scg-viewer-error{
      max-width:470px;padding:24px;
      border:1px solid color-mix(in srgb,var(--scg-danger) 40%,var(--scg-line));
      border-radius:var(--scg-r-lg);
      background:var(--scg-danger-soft);color:var(--scg-danger);
      text-align:center;font-size:12.5px;line-height:1.55;
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
    #${APP_ID} .scg-viewer-details-head b{font-size:13.5px;font-weight:650}
    #${APP_ID} .scg-viewer-details-head small{margin-top:3px;color:var(--scg-muted);font-size:11px}
    #${APP_ID} .scg-viewer-caption{
      margin:15px 0;padding:13px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-md);
      background:var(--scg-surface-2);color:var(--scg-text-soft);
      font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;
    }
    #${APP_ID} .scg-viewer-details dl{margin:15px 0}
    #${APP_ID} .scg-viewer-details dl>div{
      display:grid;grid-template-columns:88px minmax(0,1fr);gap:10px;
      padding:9px 0;border-bottom:1px solid var(--scg-line);
    }
    #${APP_ID} .scg-viewer-details dt{
      color:var(--scg-muted);font-size:10px;font-weight:700;
      text-transform:uppercase;letter-spacing:.08em;
    }
    #${APP_ID} .scg-viewer-details dd{
      min-width:0;margin:0;overflow:hidden;text-overflow:ellipsis;
      color:var(--scg-text);font-size:11.5px;font-weight:550;font-variant-numeric:tabular-nums;
    }
    #${APP_ID} .scg-viewer-details-links{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    #${APP_ID} .scg-viewer-details-links a{
      display:flex;align-items:center;justify-content:center;gap:7px;
      min-height:36px;padding:9px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-md);
      background:var(--scg-surface-2);color:var(--scg-accent);
      text-decoration:none;font-size:11.5px;font-weight:550;
    }
    #${APP_ID} .scg-viewer-details-links a:hover{background:var(--scg-accent-soft);border-color:var(--scg-accent-line)}
    #${APP_ID} .scg-viewer-details-links a .scg-icon{width:14px;height:14px}
    #${APP_ID} .scg-viewer-shortcuts{
      margin:18px 0 0;padding-top:14px;border-top:1px solid var(--scg-line);
      color:var(--scg-muted);font-size:10.5px;line-height:1.75;
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
      border:1px solid var(--scg-line-strong);border-radius:var(--scg-r-lg);
      background:color-mix(in srgb,var(--scg-surface) 88%,transparent);
      box-shadow:var(--scg-shadow);
      backdrop-filter:blur(22px) saturate(135%);
      transition:opacity .26s ease,transform .26s ease;
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
      font-size:8.5px;font-style:normal;font-weight:650;text-align:center;
    }
    #${APP_ID} .scg-viewer-footer .scg-lightbox-actions{display:flex;align-items:center;gap:6px;flex:none}
    #${APP_ID} .scg-viewer-footer .scg-lightbox-actions button{
      display:inline-flex;align-items:center;justify-content:center;gap:7px;
      min-height:36px;padding:8px 11px;
      border:1px solid var(--scg-line);border-radius:var(--scg-r-md);
      background:var(--scg-surface-2);color:var(--scg-text-soft);
      font-size:12px;font-weight:550;cursor:pointer;white-space:nowrap;
    }
    #${APP_ID} .scg-viewer-footer .scg-lightbox-actions button .scg-icon{color:var(--scg-muted)}
    #${APP_ID} .scg-viewer-footer .scg-lightbox-actions button:hover{
      background:var(--scg-surface-3);color:var(--scg-text);border-color:var(--scg-line-strong);
    }

    /* Idle chrome fade: only when the details rail is closed. */
    #${APP_ID} .scg-lightbox.viewer-idle.details-hidden .scg-viewer-topbar{opacity:0;pointer-events:none;transform:translateY(-14px)}
    #${APP_ID} .scg-lightbox.viewer-idle.details-hidden .scg-viewer-footer{opacity:0;pointer-events:none;transform:translateY(14px)}
    #${APP_ID} .scg-lightbox.viewer-idle.details-hidden .scg-nav{opacity:0;pointer-events:none}


    /* ---- 17. Responsive: wide laptop ---------------------------- */
    @media(max-width:1340px){
      #${APP_ID} .scg-header{grid-template-columns:auto minmax(0,1fr) auto;row-gap:10px}
      #${APP_ID} .scg-controls{grid-column:1/-1;order:3}
      #${APP_ID}[data-layout="masonry"] .scg-grid:not(.grouped){columns:4 var(--scg-masonry-width,280px)}
      #${APP_ID}[data-layout="masonry"].compact .scg-grid:not(.grouped){columns:6 var(--scg-masonry-compact-width,195px)}
      #${APP_ID} .scg-lightbox .scg-next{right:342px}
    }

    /* ---- 18. Responsive: tablet -------------------------------- */
    @media(max-width:1024px){
      #${APP_ID} .scg-plate{margin:10px 10px 0}
      #${APP_ID} .scg-header{grid-template-columns:auto minmax(0,1fr) auto;gap:10px;padding:9px 10px}
      #${APP_ID} .scg-thread-context{padding-left:10px}
      #${APP_ID} .scg-filter-panel{padding:0 10px 9px;gap:8px}
      #${APP_ID} .scg-viewbar{flex-basis:100%;justify-content:flex-start}
      #${APP_ID} .scg-view-summary{margin-right:auto}
      #${APP_ID} .scg-scroll{inset:10px 10px 0;padding:14px 12px 118px}
      #${APP_ID} .scg-activitybar{width:calc(100% - 20px);bottom:10px;flex-wrap:wrap}
      #${APP_ID} .scg-top{right:20px;bottom:104px}
      #${APP_ID}[data-layout="masonry"] .scg-grid:not(.grouped){columns:3 var(--scg-masonry-width,280px)}
      #${APP_ID}[data-layout="masonry"].compact .scg-grid:not(.grouped){columns:4 var(--scg-masonry-compact-width,195px)}
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
      #${APP_ID} .scg-thread-context h1{font-size:12.5px}
      #${APP_ID} .scg-thread-context [data-source-summary]{display:none}
      #${APP_ID} .scg-controls{flex-wrap:wrap}
      #${APP_ID} .scg-search{flex-basis:100%}
      #${APP_ID} .scg-scan-actions{width:100%;justify-content:space-between}
      #${APP_ID} .scg-scan-actions button{flex:1;min-width:0;padding:6px 8px}
      #${APP_ID} .scg-scan-actions [data-action="page"]>span{display:none}
      #${APP_ID} .scg-source-page{flex:1;min-width:0}
      #${APP_ID} .scg-source-page select{min-width:0;width:100%}
      #${APP_ID} .scg-filter-panel{padding:0 8px 8px}
      #${APP_ID} .scg-filters{width:100%}
      #${APP_ID} .scg-filters button{flex:1;justify-content:center;padding:6px 8px}
      #${APP_ID} .scg-filters button b{display:none}
      #${APP_ID} .scg-layout-switcher button>span{display:none}
      #${APP_ID} .scg-viewbar{flex-wrap:wrap;gap:8px}
      #${APP_ID} .scg-view-summary{flex-basis:100%;margin:0}
      #${APP_ID} .scg-viewbar label{font-size:9.5px}
      #${APP_ID} .scg-refine-popover{
        position:fixed;top:auto;right:8px;left:8px;bottom:auto;
        width:auto;max-height:70vh;overflow:auto;
      }
      #${APP_ID} .scg-refinebar{grid-template-columns:1fr}
      #${APP_ID} .scg-menu{position:fixed;right:8px;left:auto;width:min(280px,calc(100vw - 16px))}
      #${APP_ID} .scg-scroll{inset:8px 8px 0;padding:12px 10px 132px;border-radius:var(--scg-r-md) var(--scg-r-md) 0 0}
      #${APP_ID} .scg-top{right:14px;bottom:118px;padding:8px 12px}
      #${APP_ID} .scg-top>span{display:none}
      #${APP_ID}[data-layout="masonry"] .scg-grid:not(.grouped){columns:2 var(--scg-masonry-width,280px);column-gap:8px}
      #${APP_ID}[data-layout="masonry"].compact .scg-grid:not(.grouped){columns:2 var(--scg-masonry-compact-width,195px);column-gap:8px}
      #${APP_ID}[data-layout="masonry"] .scg-group-grid{columns:2 var(--scg-group-width,250px);padding:8px}
      #${APP_ID}[data-layout="masonry"].compact .scg-group-grid{columns:2 var(--scg-group-compact-width,180px);padding:8px}
      #${APP_ID}[data-layout="grid"] .scg-grid:not(.grouped),
      #${APP_ID}[data-layout="grid"] .scg-group-grid{grid-template-columns:repeat(auto-fill,minmax(min(100%,var(--scg-grid-min,250px)),1fr));gap:8px}
      #${APP_ID}[data-layout="grid"].compact .scg-grid:not(.grouped),
      #${APP_ID}[data-layout="grid"].compact .scg-group-grid{grid-template-columns:repeat(auto-fill,minmax(min(100%,var(--scg-grid-compact-min,180px)),1fr));gap:8px}
      #${APP_ID}[data-layout="grid"] .scg-card{height:var(--scg-grid-height,386px)}
      #${APP_ID}[data-layout="grid"].compact .scg-card{height:var(--scg-grid-compact-height,312px)}
      #${APP_ID}[data-layout="feed"] .scg-media,
      #${APP_ID}[data-layout="feed"] .scg-linkcard,
      #${APP_ID}[data-layout="feed"].compact .scg-media,
      #${APP_ID}[data-layout="feed"].compact .scg-linkcard{display:block;min-height:0}
      #${APP_ID}[data-layout="feed"] .scg-preview,
      #${APP_ID}[data-layout="feed"] .scg-card>video,
      #${APP_ID}[data-layout="feed"] .scg-embed,
      #${APP_ID}[data-layout="feed"] .scg-host{height:auto;min-height:182px;border-right:0}
      #${APP_ID}[data-layout="feed"] .scg-actions,
      #${APP_ID}[data-layout="feed"] .scg-meta{border-left:0}
      #${APP_ID}[data-layout="feed"] .scg-skeleton{display:block;height:auto}
      #${APP_ID}[data-layout="feed"] .scg-skeleton-media{height:182px}
      #${APP_ID} .scg-badge span{display:none}
      #${APP_ID} .scg-activitybar{width:calc(100% - 16px);bottom:8px;gap:7px;padding:7px 8px;border-radius:var(--scg-r-lg)}
      #${APP_ID} .scg-activity-state{flex:1 1 100%}
      #${APP_ID} .scg-progress{flex:1 1 100%;min-width:0;max-width:none}
      #${APP_ID} .scg-progress-text{max-width:130px}
      #${APP_ID} .scg-selection-toggle>span{display:none}
      #${APP_ID}.selecting .scg-bulk-actions,
      #${APP_ID}.downloading .scg-bulk-actions{flex-wrap:wrap;flex-basis:100%}
      #${APP_ID}.selecting .scg-bulk-actions button>span{display:none}
      #${APP_ID}.selecting .scg-bulk-actions .scg-primary>span,
      #${APP_ID}.downloading .scg-bulk-actions .scg-primary>span{display:inline}
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
      #${APP_ID} .scg-viewer-identity>b{padding:4px 8px;font-size:12px}
      #${APP_ID} .scg-viewer-identity small{display:none}
      #${APP_ID} .scg-viewer-titleline strong{font-size:11.5px}
      #${APP_ID} .scg-viewer-resolution{padding:2px 6px;font-size:9.5px}
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
      #scg-launch{left:12px;bottom:12px;min-height:58px;padding:0 17px 0 10px;gap:10px}
      #scg-launch .scg-launch-icon{width:38px;height:38px;border-radius:12px}
      #scg-launch .scg-launch-copy strong{font-size:13px}
      #scg-launch .scg-launch-copy small{font-size:10.5px}
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
      #${APP_ID} .scg-viewer-thumb{min-height:0}
      #${APP_ID} [data-tooltip]:hover:after{display:none}
      #${APP_ID} .scg-scan-warning{
        position:static;width:auto;height:auto;padding:5px 8px;margin:0;
        overflow:visible;clip:auto;white-space:normal;
        color:var(--scg-muted);font-size:10.5px;line-height:1.35;
      }
    }

    /* ---- 21. Reduced motion ------------------------------------ */
    @media(prefers-reduced-motion:reduce){
      #${APP_ID},#${APP_ID} *,#${APP_ID} *:before,#${APP_ID} *:after,
      #scg-launch,#scg-launch *,#scg-gallery-toast{
        animation-duration:.001ms !important;
        animation-iteration-count:1 !important;
        transition-duration:.001ms !important;
        transition-delay:0s !important;
      }
      #${APP_ID} .scg-scroll{scroll-behavior:auto}
      #${APP_ID} .scg-card:hover,#${APP_ID} .scg-viewer-thumb:hover,
      #scg-launch:hover,#${APP_ID} .scg-embed-placeholder button:hover{transform:none}
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

  const launch = document.createElement('button');
  launch.id = 'scg-launch';
  launch.innerHTML = `${iconWell('gallery', 'scg-launch-icon')}<span class="scg-launch-copy"><strong>Open Gallery</strong><small data-launch-detail>Darkroom Â· v${APP_VERSION}</small></span>`;
  launch.setAttribute('aria-label', 'Open SimpCity thread gallery');
  document.body.appendChild(launch);

  function refreshLaunchButton() {
    const count = state.items.filter(isMediaItem).length;
    const detail = launch.querySelector('[data-launch-detail]');
    if (detail) detail.textContent = count ? `Darkroom Â· ${count.toLocaleString()} indexed` : `Darkroom Â· v${APP_VERSION}`;
    launch.setAttribute('aria-label', count ? `Open SimpCity thread gallery, ${count} media items indexed` : 'Open SimpCity thread gallery');
  }

  const app = document.createElement('section');
  app.id = APP_ID;
  app.setAttribute('data-ui', 'darkroom');
  app.setAttribute('role', 'dialog');
  app.setAttribute('aria-modal', 'true');
  app.setAttribute('aria-label', 'SimpCity Thread Gallery');
  app.innerHTML = `
    <div class="scg-plate">
      <header class="scg-header">
        <div class="scg-brand">
          <div class="scg-brand-mark" aria-hidden="true">${icon('gallery')}</div>
          <div><b>Gallery</b><small>Darkroom</small></div>
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
            <button class="scg-scan-thread-danger" data-action="thread" data-tooltip="${escapeHtml(SCAN_WARNING_TEXT)}" aria-describedby="scg-thread-scan-warning">${iconWell('scan')}<span>Scan thread</span></button>
          </div>
          <span class="scg-scan-warning" id="scg-thread-scan-warning" role="note">${escapeHtml(SCAN_WARNING_TEXT)}</span>
        </nav>
        <div class="scg-header-actions">
          <button data-action="filters-toggle" data-tooltip="Hide filters" aria-expanded="true" aria-controls="scg-filter-panel" aria-label="Hide filters">${iconWell('chevron')}<span>Filters</span></button>
          <span class="scg-header-rule" aria-hidden="true"></span>
          <button data-action="settings" data-tooltip="Settings and diagnostics" aria-label="Settings and diagnostics">${iconWell('settings')}<span>Settings</span></button>
          <span class="scg-menu-wrap">
            <button data-action="overflow" class="scg-tip-end" data-tooltip="More options" aria-label="More options" aria-haspopup="true" aria-expanded="false" aria-controls="scg-overflow-menu">${iconWell('more')}<span>More</span></button>
            <div class="scg-menu" id="scg-overflow-menu" role="menu" aria-label="More options">
              <div class="scg-menu-label" role="presentation">Appearance</div>
              <button data-action="theme" role="menuitem">${iconWell('palette')}<span>Theme</span></button>
              <button data-action="density" role="menuitem">${iconWell('layout')}<span>Compact cards</span></button>
              <div class="scg-menu-sep" role="separator"></div>
              <div class="scg-menu-label" role="presentation">Help</div>
              <button data-action="shortcuts" role="menuitem">${iconWell('keyboard')}<span>Keyboard shortcuts</span></button>
            </div>
          </span>
          <button class="scg-close scg-tip-end" data-tooltip="Close gallery (Esc)" aria-label="Close gallery">${iconWell('close', 'scg-icon-well-danger')}</button>
        </div>
      </header>
      <section class="scg-filter-panel" id="scg-filter-panel" aria-label="Filters and view options">
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
          <div class="scg-layout-switcher" role="group" aria-label="Gallery layout">
            <button data-layout-mode="masonry" data-tooltip="Masonry layout (L)" aria-pressed="true">${iconWell('masonry')}<span>Masonry</span></button>
            <button data-layout-mode="grid" data-tooltip="Uniform grid layout (L)" aria-pressed="false">${iconWell('grid')}<span>Grid</span></button>
            <button data-layout-mode="feed" data-tooltip="Wide feed layout (L)" aria-pressed="false">${iconWell('feed')}<span>Feed</span></button>
          </div>
          <span class="scg-refine-wrap">
            <button class="scg-refine-trigger" data-action="refine-toggle" aria-haspopup="true" aria-expanded="false" aria-controls="scg-refine-popover">${iconWell('sliders')}<span>Refine</span><em data-refine-count hidden>0</em></button>
            <div class="scg-refine-popover" id="scg-refine-popover" role="group" aria-label="Refine results">
              <h2>Refine results</h2>
              <div class="scg-refinebar">
                <label>Sort <select data-sort><option value="thread-asc">Oldest replies first</option><option value="thread-desc">Newest replies first</option><option value="author">Author A-Z</option><option value="host">Host A-Z</option><option value="type">Media type</option></select></label>
                <label>Group <select data-group-by><option value="none">Individual cards</option><option value="reply">Group by reply</option></select></label>
                <label>Author <select data-author-filter></select></label>
                <label>Host <select data-host-filter></select></label>
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
          <label>Per view <select data-page-size><option value="40">40</option><option value="60">60</option><option value="100">100</option></select></label>
        </div>
      </section>
    </div>
    <div class="scg-stage">
      <main class="scg-scroll" tabindex="-1"><div class="scg-grid"></div></main>
      <footer class="scg-bulkbar scg-activitybar" aria-label="Activity, selection and downloads">
        <div class="scg-activity-state"><i aria-hidden="true"></i><div><b class="scg-status">Ready</b><span data-activity-detail>Open a page or scan the thread</span></div></div>
        <button class="scg-selection-toggle scg-tip-up" data-action="selection-mode" data-tooltip="Turn selection mode on or off">${iconWell('select')}<span>Select media</span></button>
        <div class="scg-bulk-actions" role="group" aria-label="Bulk selection">
          <span class="scg-bulk-label" aria-hidden="true">Select</span>
          <button class="scg-tip-up" data-action="select-visible" data-tooltip="Select every media item in this view">${iconWell('select')}<span>Visible</span></button>
          <button class="scg-tip-up" data-action="select-images" data-tooltip="Select all indexed images">${iconWell('image')}<span>Images</span></button>
          <button class="scg-tip-up" data-action="select-videos" data-tooltip="Select all indexed videos">${iconWell('video')}<span>Videos</span></button>
          <button class="scg-tip-up" data-action="clear-selection" data-tooltip="Clear the selection" disabled>${iconWell('clear')}<span>Clear</span></button>
          <span class="scg-selected-count" role="status" aria-live="polite">0 selected</span>
          <button class="scg-primary scg-tip-up scg-tip-end" data-action="download-selected" disabled>${iconWell('archive', 'scg-icon-well-primary')}<span>Download ZIP (0)</span></button>
        </div>
        <div class="scg-progress">
          <button class="scg-progress-summary scg-tip-up scg-tip-end" data-action="download-details" data-tooltip="Open the download queue" aria-expanded="false" aria-controls="scg-download-queue"><span class="scg-progress-track"><span class="scg-progress-fill"></span></span><span class="scg-progress-text">Downloads idle</span></button>
          <aside class="scg-download-popover" id="scg-download-queue" aria-label="Download queue">
            <header><b>Download queue</b><div><button data-action="clear-download-history" data-tooltip="Forget saved-file markers" aria-label="Clear download history">${iconWell('history')}<span>Clear history</span></button><button data-action="close-download-details" aria-label="Close the download queue">${iconWell('close')}<span>Close</span></button></div></header>
            <div class="scg-download-overall" role="status" aria-live="polite">No downloads yet.</div>
            <div class="scg-download-jobs"></div>
          </aside>
        </div>
        <button class="scg-activity-toggle scg-tip-up scg-tip-end" data-action="activity-toggle" data-tooltip="Collapse activity bar" aria-expanded="true" aria-label="Collapse activity bar">${iconWell('chevron')}<span>Collapse activity</span></button>
      </footer>
      <button class="scg-top scg-tip-up scg-tip-end" data-tooltip="Back to the top of the gallery">${iconWell('up')}<span>Top</span></button>
    </div>
    <div class="scg-lightbox" role="dialog" aria-modal="true" aria-label="Media viewer"></div>
    <div class="scg-settings-panel" role="dialog" aria-modal="true" aria-label="Settings and diagnostics">
      <section class="scg-settings-dialog" tabindex="-1">
        <header class="scg-settings-head"><div>${icon('settings')}<div><h2>Settings and diagnostics</h2><p>Local preferences, portability and troubleshooting. Nothing leaves this device.</p></div></div><button class="scg-settings-close" data-action="close-settings" aria-label="Close settings">${iconWell('close', 'scg-icon-well-danger')}</button></header>
        <div class="scg-settings-body"><div class="scg-settings-grid">
          <section class="scg-settings-card"><h3>${icon('palette')} Appearance</h3><p>Choose the gallery layout, theme, card density and remembered panel state.</p><div class="scg-setting-fields"><label>Gallery layout<select data-setting-layout><option value="masonry">Masonry</option><option value="grid">Uniform grid</option><option value="feed">Feed</option></select></label><label>Theme<select data-setting-theme><option value="dark">Darkroom (default dark)</option><option value="light">Daylight (light)</option><option value="midnight">Indigo (dark)</option><option value="graphite">Graphite (dark)</option></select></label><label>Card density<select data-setting-density><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label><label class="scg-setting-size">Media card size <span><input data-card-scale type="range" min="70" max="160" step="5" value="100" aria-label="Image and video card size in masonry and grid layouts"><output data-card-scale-value>100%</output></span></label></div><label class="scg-settings-check"><input type="checkbox" data-setting-filters-collapsed><span>Keep filters collapsed</span></label><label class="scg-settings-check"><input type="checkbox" data-setting-activity-collapsed><span>Keep the activity bar compact</span></label></section>
          <section class="scg-settings-card full"><h3>${icon('archive')} Archive and downloads <span class="scg-settings-version">v${APP_VERSION}</span></h3><p>Control download throughput, ZIP part limits and archive organization. Changes apply to the next queue.</p><div class="scg-setting-fields scg-download-settings"><label>ZIP folders<select data-setting-archive-layout><option value="page-author">Page / author</option><option value="page">Page only</option><option value="reply">Page / reply</option><option value="flat">Flat archive</option></select></label><label>Simultaneous files<select data-setting-download-concurrency><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option></select></label><label>Maximum part size<select data-setting-zip-part-size><option value="100">100 MB</option><option value="300">300 MB</option><option value="600">600 MB</option><option value="1000">1,000 MB</option></select></label><label>Files per part<select data-setting-zip-part-files><option value="24">24</option><option value="50">50</option><option value="100">100</option></select></label></div><div class="scg-archive-checks"><label class="scg-settings-check"><input type="checkbox" data-setting-include-manifest><span>Add manifest.csv with source URL, reply, author, validation method and CRC32.</span></label><label class="scg-settings-check"><input type="checkbox" data-setting-dedupe-content><span>Merge byte-identical reposts using verified size + CRC32 while preserving download history and provenance.</span></label></div></section>
          <section class="scg-settings-card"><h3>${icon('scan')} Scan safety</h3><p>Large full-thread scans index HTML from every detected page and can use substantial memory.</p><label class="scg-settings-check"><input type="checkbox" data-setting-warn-large-scan><span>Warn before scanning threads with ${LARGE_THREAD_WARNING_PAGES} or more pages</span></label></section>
          <section class="scg-settings-card"><h3>${icon('info')} Storage</h3><p>Preferences and verified download history are stored outside the website. Pre-v0.7.3 history remains visible as LEGACY but will not skip a new download.</p><div class="scg-storage-note">${icon('select')}<span><b data-diag-storage></b><br><span data-diag-migration></span></span></div></section>
          <section class="scg-settings-card"><h3>${icon('upload')} Backup and restore</h3><p>Export preferences as JSON or restore a previous backup.</p><label class="scg-settings-check"><input type="checkbox" data-export-history><span>Include download history. This contains thread and media references.</span></label><div class="scg-settings-actions"><button data-action="export-settings">${iconWell('download')}<span>Export</span></button><button data-action="import-settings">${iconWell('upload')}<span>Import</span></button><input class="scg-settings-file" data-settings-file type="file" accept="application/json,.json"></div></section>
          <section class="scg-settings-card full"><h3>${icon('info')} Diagnostics</h3><p>A local, URL-scrubbed summary for troubleshooting. Nothing is transmitted automatically.</p><div class="scg-diag-grid"><div class="scg-diag-stat"><span>Version</span><b data-diag-version></b></div><div class="scg-diag-stat"><span>Thread pages</span><b data-diag-pages></b></div><div class="scg-diag-stat"><span>Indexed items</span><b data-diag-items></b></div><div class="scg-diag-stat"><span>Download history</span><b data-diag-history></b></div><div class="scg-diag-stat"><span>Resolver failures</span><b data-diag-resolvers></b></div><div class="scg-diag-stat"><span>Download failures</span><b data-diag-downloads></b></div><div class="scg-diag-stat"><span>Scan failures</span><b data-diag-scans></b></div><div class="scg-diag-stat"><span>Storage</span><b data-diag-storage></b></div></div><div class="scg-settings-actions" style="margin-top:10px"><button data-action="copy-debug">${iconWell('copy')}<span>Copy debug report</span></button><button data-action="clear-diagnostics">${iconWell('reset')}<span>Clear diagnostics</span></button></div></section>
          <section class="scg-settings-card"><h3>${icon('reset')} Reset</h3><p>Reset visual preferences, or also forget SAVED download markers.</p><div class="scg-settings-actions"><button data-action="reset-preferences">${iconWell('reset')}<span>Reset preferences</span></button><button class="danger" data-action="reset-everything">${iconWell('trash', 'scg-icon-well-danger')}<span>Reset preferences + history</span></button></div></section>
          <section class="scg-settings-card"><h3>${icon('info')} Cross-host permission</h3><p>The wildcard connection permission is intentionally retained for media hosted on changing third-party domains.</p><div class="scg-permission-note">The script only requests URLs discovered in thread replies or known resolver endpoints. It contains no analytics or telemetry.</div></section>
        </div></div>
        <footer class="scg-settings-foot"><span>SimpCity Thread Gallery <b>v${APP_VERSION}</b></span><span>Settings remain on this device unless you export them.</span></footer>
      </section>
    </div>
    <div class="scg-confirm-panel" role="dialog" aria-modal="true" aria-labelledby="scg-confirm-title"><section class="scg-confirm-dialog"><div class="scg-confirm-icon">${icon('info')}</div><h2 id="scg-confirm-title" data-confirm-title>Confirm action</h2><p data-confirm-message></p><label class="scg-confirm-preference" data-confirm-preference hidden><input type="checkbox"><span></span></label><div><button data-confirm-cancel>${iconWell('close')}<span>Cancel</span></button><button class="scg-confirm-accept" data-confirm-accept>${iconWell('check', 'scg-icon-well-primary')}<span>Continue</span></button></div></section></div>`;
  document.body.appendChild(app);
  const toast = document.createElement('div');
  toast.id = 'scg-gallery-toast';
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
    document.getElementById('scg-launch')?.focus({ preventScroll: true });
  }

  const controllers = Object.freeze({
    scanner: Object.freeze({ current: scanCurrentPage, page: scanSpecificPage, thread: scanThread }),
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
  app.querySelector('[data-action="thread"]').onclick = controllers.scanner.thread;
  app.querySelector('[data-sort]').onchange = event => commitState({ sort: event.target.value, viewPage: 1 }, { persist: true });
  app.querySelector('[data-author-filter]').onchange = event => commitState({ authorFilter: event.target.value, viewPage: 1 });
  app.querySelector('[data-host-filter]').onchange = event => commitState({ hostFilter: event.target.value, viewPage: 1 });
  app.querySelector('[data-group-by]').onchange = event => commitState({ groupBy: event.target.value, viewPage: 1 }, { persist: true });
  app.querySelector('[data-selected-only]').onclick = () => commitState({ selectedOnly: !state.selectedOnly, viewPage: 1 });
  app.querySelector('[data-action="collapse-all"]').onclick = () => {
    if (setReplyGroupsCollapsed(visibleItems(), true)) render();
  };
  app.querySelector('[data-action="expand-all"]').onclick = () => {
    if (setReplyGroupsCollapsed(visibleItems(), false)) render();
  };
  app.querySelector('[data-action="reset-filters"]').onclick = () => {
    app.querySelector('[data-search]').value = '';
    commitState({
      filter: 'all', query: '', authorFilter: 'all', hostFilter: 'all', selectedOnly: false,
      sort: 'thread-asc', groupBy: 'none', viewPage: 1,
    }, { persist: true });
  };
  app.querySelector('[data-action="selection-mode"]').onclick = () => {
    if (state.selectionMode) {
      exitSelectionMode();
    } else {
      state.selectionMode = true;
    }
    commitState({}, { render: true });
  };
  app.querySelector('[data-action="filters-toggle"]').onclick = () => {
    commitState({ filtersCollapsed: !state.filtersCollapsed }, { persist: true, shellOnly: true });
  };
  app.querySelector('[data-action="density"]').onclick = () => {
    commitState({ compact: !state.compact }, { persist: true, shellOnly: true });
  };
  app.querySelectorAll('[data-layout-mode]').forEach(button => {
    button.onclick = () => commitState({ layoutMode: button.dataset.layoutMode }, { persist: true, shellOnly: true });
  });
  app.querySelector('[data-action="theme"]').onclick = () => {
    const current = Math.max(0, THEME_MODES.indexOf(state.theme));
    commitState({ theme: THEME_MODES[(current + 1) % THEME_MODES.length] }, { persist: true, shellOnly: true });
  };
  app.querySelector('[data-action="activity-toggle"]').onclick = () => {
    commitState({ activityCollapsed: !state.activityCollapsed }, { persist: true, shellOnly: true });
  };
  const overflowTrigger = app.querySelector('[data-action="overflow"]');
  const overflowMenu = app.querySelector('.scg-menu');
  const refineTrigger = app.querySelector('[data-action="refine-toggle"]');
  const refinePopover = app.querySelector('.scg-refine-popover');
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
  app.querySelector('[data-action="shortcuts"]').onclick = () => notify('Gallery: / search Â· L cycles layout Â· Shift+A selects this view Â· Shift+G opens or closes Â· Esc closes. Viewer: â† â†’ navigate Â· wheel or + âˆ’ zoom Â· 0 fit Â· I details Â· F fullscreen Â· Space play or pause Â· D download Â· S select.', 11000);
  app.querySelector('[data-action="shortcuts"]').addEventListener('click', () => closeDisclosures());
  app.querySelector('[data-action="settings"]').onclick = () => {
    closeDisclosures();
    controllers.settings.open();
  };
  app.querySelector('[data-action="close-settings"]').onclick = controllers.settings.close;
  app.querySelector('[data-setting-theme]').onchange = event => {
    commitState({ theme: THEME_MODES.includes(event.target.value) ? event.target.value : DEFAULT_SETTINGS.theme }, { persist: true, shellOnly: true });
  };
  app.querySelector('[data-setting-density]').onchange = event => {
    commitState({ compact: event.target.value === 'compact' }, { persist: true, shellOnly: true });
  };
  app.querySelector('[data-setting-layout]').onchange = event => {
    commitState({ layoutMode: LAYOUT_MODES.includes(event.target.value) ? event.target.value : 'masonry' }, { persist: true, shellOnly: true });
  };
  app.querySelector('[data-setting-filters-collapsed]').onchange = event => {
    commitState({ filtersCollapsed: event.target.checked }, { persist: true, shellOnly: true });
  };
  app.querySelector('[data-setting-activity-collapsed]').onchange = event => {
    commitState({ activityCollapsed: event.target.checked }, { persist: true, shellOnly: true });
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
  app.querySelector('.scg-settings-panel').onclick = event => {
    if (event.target.classList.contains('scg-settings-panel')) controllers.settings.close();
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
  app.querySelector('[data-action="select-visible"]').onclick = () => selectItems(mediaItems());
  app.querySelector('[data-action="select-images"]').onclick = () => selectItems(state.items.filter(item => item.type === 'image'));
  app.querySelector('[data-action="select-videos"]').onclick = () => selectItems(state.items.filter(item => item.type === 'video' || item.type === 'embed'));
  app.querySelector('[data-action="clear-selection"]').onclick = () => {
    clearSelection();
    if (state.selectedOnly) render();
    else updateSelectionUi();
  };
  app.querySelector('[data-action="download-selected"]').onclick = controllers.downloads.bulk;
  app.querySelector('[data-action="download-details"]').onclick = event => {
    event.stopPropagation();
    state.downloadDetailsOpen = !state.downloadDetailsOpen;
    updateDownloadUi();
  };
  app.querySelector('[data-action="close-download-details"]').onclick = event => {
    event.stopPropagation();
    state.downloadDetailsOpen = false;
    updateDownloadUi();
  };
  app.querySelector('[data-action="clear-download-history"]').onclick = async event => {
    event.stopPropagation();
    if (!await confirmAction({ title: 'Clear download history?', message: 'This removes SAVED markers only. Existing files will stay in your Downloads folder.', confirmLabel: 'Clear history', danger: true })) return;
    state.downloadHistory = {};
    persistDownloadHistory();
    updateDownloadedIndicators();
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
    commitState({ perPage: Number(event.target.value), viewPage: 1 }, { persist: true });
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
  scrollArea.onscroll = () => topButton.classList.toggle('visible', scrollArea.scrollTop > 650);
  app.querySelector('.scg-grid').onclick = event => {
    const items = state.renderedItems;
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
      const item = items[Number(selection.dataset.select)];
      setSelected(item, selection.checked);
      if (state.selectedOnly) render();
      else updateSelectionUi();
      return;
    }
    const player = event.target.closest('[data-load-player]');
    if (player) {
      const item = items[Number(player.dataset.loadPlayer)];
      const container = player.closest('.scg-embed');
      if (item && container) {
        container.classList.remove('scg-embed-placeholder');
        container.innerHTML = iframeHtml(item);
      }
      return;
    }
    const expand = event.target.closest('[data-expand]');
    if (expand) {
      const paragraph = expand.closest('.scg-textcard').querySelector('p');
      const expanded = paragraph.classList.toggle('expanded');
      setIconButton(expand, 'chevron', expanded ? 'Show less' : 'Show more');
      expand.classList.toggle('expanded', expanded);
      return;
    }
    const download = event.target.closest('[data-download]');
    if (download) {
      downloadMedia(items[Number(download.dataset.download)]);
      return;
    }
    const button = event.target.closest('[data-open]');
    if (!button) return;
    controllers.viewer.open(items[Number(button.dataset.open)]);
  };
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
    if (event.key === 'Escape' && app.classList.contains('open')) closeApp();
    else if (event.key === '/' && app.classList.contains('open')) {
      event.preventDefault();
      app.querySelector('[data-search]').focus();
    } else if (!event.shiftKey && event.key.toLowerCase() === 'l' && app.classList.contains('open')) {
      event.preventDefault();
      cycleLayoutMode(1, true);
    } else if (event.shiftKey && event.key.toLowerCase() === 'a' && app.classList.contains('open')) {
      event.preventDefault();
      state.selectionMode = true;
      selectItems(mediaItems());
      render();
    } else if (event.shiftKey && event.key.toLowerCase() === 'g') {
      event.preventDefault();
      if (app.classList.contains('open')) closeApp();
      else openApp();
    } else if (event.key === 'Tab' && app.classList.contains('open')) {
      containFocus(app, event);
    }
  });
})();
