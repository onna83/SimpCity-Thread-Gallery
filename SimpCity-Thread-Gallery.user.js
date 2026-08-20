// ==UserScript==
// @name         SimpCity Thread Gallery — Hybrid UI Fork
// @namespace    local.simpcity.gallery.hybrid
// @version      0.9.5
// @description  Apple-inspired thread media browsing with Material-style controls and downloads.
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

  const APP_VERSION = '0.9.5';
  const APP_ID = 'sc-thread-gallery';
  const SETTINGS_KEY = 'sc-thread-gallery-settings-v1';
  const DOWNLOAD_HISTORY_KEY = 'sc-thread-gallery-download-history-v1';
  const STORAGE_MIGRATION_KEY = 'sc-thread-gallery-storage-migrated-v072';
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
    downloadConcurrency: 2,
    zipPartSizeMb: 300,
    zipPartMaxFiles: 24,
    archiveLayout: 'page-author',
    includeManifest: true,
    dedupeContent: true,
  });
  const THEME_MODES = Object.freeze(['dark', 'light', 'midnight', 'graphite']);
  const THEME_LABELS = Object.freeze({ dark: 'Apple Black', light: 'Cloud', midnight: 'Midnight Blue', graphite: 'Graphite' });

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
    downloadConcurrency: [1, 2, 3, 4].includes(Number(savedSettings.downloadConcurrency)) ? Number(savedSettings.downloadConcurrency) : 2,
    zipPartSizeMb: [100, 300, 600, 1000].includes(Number(savedSettings.zipPartSizeMb)) ? Number(savedSettings.zipPartSizeMb) : 300,
    zipPartMaxFiles: [24, 50, 100].includes(Number(savedSettings.zipPartMaxFiles)) ? Number(savedSettings.zipPartMaxFiles) : 24,
    archiveLayout: ['flat', 'page', 'page-author', 'reply'].includes(savedSettings.archiveLayout) ? savedSettings.archiveLayout : 'page-author',
    includeManifest: savedSettings.includeManifest !== false,
    dedupeContent: savedSettings.dedupeContent !== false,
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
    scanning: false,
    cancelScan: false,
    scannedPages: 0,
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

  const IMAGE_EXT = /\.(?:jpe?g|png|gif|webp|avif|bmp)(?:$|[?#./])/i;
  const VIDEO_EXT = /\.(?:mp4|webm|mov|m4v)(?:$|[?#./])/i;
  const IGNORE_IMG = /(?:avatar|smilie|emoji|reaction|sprite|logo)/i;
  const TYPE_ORDER = { image: 0, video: 1, embed: 1, link: 2, text: 3 };
  const LAYOUT_MODES = Object.freeze(['masonry', 'grid', 'feed']);
  const LAYOUT_LABELS = Object.freeze({ masonry: 'Masonry', grid: 'Uniform grid', feed: 'Feed' });
  const ICON_PATHS = {
    gallery: '<rect x="5" y="6" width="15" height="13" rx="2"/><path d="M8 6V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-1 1.73"/><circle cx="10" cy="10" r="1.25"/><path d="m7 17 4-4 3 3 2-2 3 3"/>',
    settings: '<path d="M12 8.5A3.5 3.5 0 1 0 12 15.5 3.5 3.5 0 0 0 12 8.5Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.42 1.42-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.02 1.56V20h-2v-.48A1.7 1.7 0 0 0 12.4 18a1.7 1.7 0 0 0-1.88.34l-.06.06-1.42-1.42.06-.06A1.7 1.7 0 0 0 9.44 15a1.7 1.7 0 0 0-1.56-1.02H7.4v-2h.48A1.7 1.7 0 0 0 9.44 11a1.7 1.7 0 0 0-.34-1.88l-.06-.06 1.42-1.42.06.06A1.7 1.7 0 0 0 12.4 8a1.7 1.7 0 0 0 1.02-1.56V6h2v.44A1.7 1.7 0 0 0 16.44 8a1.7 1.7 0 0 0 1.88-.34l.06-.06L19.8 9l-.06.06A1.7 1.7 0 0 0 19.4 11a1.7 1.7 0 0 0 1.56 1.02h.44v2h-.44A1.7 1.7 0 0 0 19.4 15Z"/>',
    layout: '<rect x="4" y="5" width="6" height="6" rx="1"/><rect x="14" y="5" width="6" height="6" rx="1"/><rect x="4" y="15" width="6" height="4" rx="1"/><rect x="14" y="15" width="6" height="4" rx="1"/>',
    keyboard: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M18 10h.01M7 14h7M16 14h2"/>',
    close: '<path d="m7 7 10 10M17 7 7 17"/>',
    download: '<path d="M12 3v12m0 0 4-4m-4 4-4-4M5 19h14"/>',
    select: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 3 3 5-6"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m5 17 4-4 3 3 2-2 5 3"/>',
    video: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3Z"/>',
    copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    reset: '<path d="M4 12a8 8 0 1 0 2.34-5.66L4 8.68M4 4v4.68h4.68"/>',
    upload: '<path d="M12 16V4m0 0-4 4m4-4 4 4M5 20h14"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    filter: '<path d="M4 5h16l-6.5 7.2V18l-3 1v-6.8Z"/>',
    sun: '<circle cx="12" cy="12" r="3.5"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42"/>',
    moon: '<path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>',
    palette: '<path d="M12 3a9 9 0 0 0 0 18h1.2a2 2 0 0 0 1.42-3.41l-.45-.45a1.2 1.2 0 0 1 .85-2.05H17a4 4 0 0 0 4-4C21 6.62 17 3 12 3Z"/><circle cx="7.5" cy="10" r="1"/><circle cx="10" cy="6.8" r="1"/><circle cx="14" cy="6.8" r="1"/><circle cx="17" cy="10" r="1"/>',
    chevron: '<path d="m8 10 4 4 4-4"/>',
    scan: '<path d="M4 7V4h3M17 4h3v3M20 17v3h-3M7 20H4v-3"/><path d="M8 12h8"/>',
    masonry: '<rect x="3" y="3" width="8" height="11" rx="1"/><rect x="13" y="3" width="8" height="6" rx="1"/><rect x="3" y="16" width="8" height="5" rx="1"/><rect x="13" y="11" width="8" height="10" rx="1"/>',
    grid: '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>',
    feed: '<rect x="3" y="4" width="7" height="6" rx="1"/><path d="M13 6h8M13 9h6"/><rect x="3" y="14" width="7" height="6" rx="1"/><path d="M13 16h8M13 19h6"/>',
    zoomIn: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5M10.5 7.5v6M7.5 10.5h6"/>',
    zoomOut: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5M7.5 10.5h6"/>',
    fit: '<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/><path d="m3 8 5-5M21 8l-5-5M3 16l5 5M21 16l-5 5"/>',
    fullscreen: '<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/>',
    play: '<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4Z"/>',
    resolution: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4M7 8h3v3M17 8h-3v3"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1"/>',
    text: '<path d="M5 5h14M12 5v14M8 19h8"/>',
    page: '<path d="M6 2h9l5 5v15H6Z"/><path d="M14 2v6h6M9 13h6M9 17h6"/>',
    archive: '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 9h18M9 13h6M5 2h14v3"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
    clear: '<rect x="4" y="4" width="16" height="16" rx="3" stroke-dasharray="3 2"/><path d="m9 9 6 6m0-6-6 6"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.7 2.7L16.5 9"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/>',
    previous: '<path d="m15 18-6-6 6-6"/>',
    next: '<path d="m9 18 6-6-6-6"/>',
    up: '<path d="m6 15 6-6 6 6"/><path d="M12 9v11"/>',
  };

  function icon(name, className = '') {
    const paths = ICON_PATHS[name] || ICON_PATHS.info;
    return `<svg class="scg-icon ${escapeHtml(className)}" data-scg-icon="${escapeHtml(name)}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
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
    refreshSettingsPanel();
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
        downloadConcurrency: state.downloadConcurrency,
        zipPartSizeMb: state.zipPartSizeMb,
        zipPartMaxFiles: state.zipPartMaxFiles,
        archiveLayout: state.archiveLayout,
        includeManifest: state.includeManifest,
        dedupeContent: state.dedupeContent,
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
    app.dataset.layout = state.layoutMode;
    app.classList.toggle('compact', state.compact);
    app.classList.toggle('filters-collapsed', state.filtersCollapsed);
    app.classList.toggle('activity-collapsed', state.activityCollapsed);
    const toast = document.getElementById('scg-gallery-toast');
    if (toast) toast.dataset.theme = state.theme;
    const launch = document.getElementById('scg-launch');
    if (launch) launch.dataset.theme = state.theme;
    const filterToggle = app.querySelector('[data-action="filters-toggle"]');
    if (filterToggle) {
      setIconButton(filterToggle, 'filter', state.filtersCollapsed ? 'Show filters' : 'Hide filters');
      filterToggle.setAttribute('aria-expanded', String(!state.filtersCollapsed));
      filterToggle.classList.toggle('active', !state.filtersCollapsed);
    }
    setIconButton(app.querySelector('[data-action="density"]'), 'layout', state.compact ? 'Comfortable cards' : 'Compact cards');
    const themeIndex = Math.max(0, THEME_MODES.indexOf(state.theme));
    const nextTheme = THEME_MODES[(themeIndex + 1) % THEME_MODES.length];
    const themeButton = app.querySelector('[data-action="theme"]');
    setIconButton(themeButton, 'palette', THEME_LABELS[state.theme]);
    if (themeButton) themeButton.title = `Current theme: ${THEME_LABELS[state.theme]}. Click for ${THEME_LABELS[nextTheme]}.`;
    app.querySelectorAll('[data-layout-mode]').forEach(button => {
      const active = button.dataset.layoutMode === state.layoutMode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const activityToggle = app.querySelector('[data-action="activity-toggle"]');
    if (activityToggle) {
      setIconButton(activityToggle, 'chevron', state.activityCollapsed ? 'Expand activity bar' : 'Collapse activity bar');
      activityToggle.setAttribute('aria-expanded', String(!state.activityCollapsed));
    }
    const themeSelect = app.querySelector('[data-setting-theme]');
    const densitySelect = app.querySelector('[data-setting-density]');
    const filterCheck = app.querySelector('[data-setting-filters-collapsed]');
    const activityCheck = app.querySelector('[data-setting-activity-collapsed]');
    const layoutSelect = app.querySelector('[data-setting-layout]');
    if (themeSelect) themeSelect.value = state.theme;
    if (densitySelect) densitySelect.value = state.compact ? 'compact' : 'comfortable';
    if (filterCheck) filterCheck.checked = state.filtersCollapsed;
    if (activityCheck) activityCheck.checked = state.activityCollapsed;
    if (layoutSelect) layoutSelect.value = state.layoutMode;
    refreshThreadHeader();
  }

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
      refreshSettingsPanel();
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
    return job;
  }

  function setDownloadJob(job, changes) {
    if (!job) return;
    Object.assign(job, changes);
    scheduleDownloadUi();
  }

  function scheduleDownloadUi() {
    if (scheduleDownloadUi.timer) return;
    scheduleDownloadUi.timer = setTimeout(() => {
      scheduleDownloadUi.timer = 0;
      updateDownloadUi();
    }, 180);
  }

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

  function confirmAction({ title = 'Confirm action', message, confirmLabel = 'Continue', danger = false } = {}) {
    const panel = document.querySelector(`#${APP_ID} .scg-confirm-panel`);
    if (!panel) return Promise.resolve(false);
    const previousFocus = document.activeElement;
    panel.querySelector('[data-confirm-title]').textContent = title;
    panel.querySelector('[data-confirm-message]').textContent = message || '';
    const accept = panel.querySelector('[data-confirm-accept]');
    setIconButton(accept, danger ? 'trash' : 'check', confirmLabel);
    accept.classList.toggle('danger', danger);
    panel.classList.add('open');
    accept.focus();
    return new Promise(resolve => {
      const finish = value => {
        panel.classList.remove('open');
        accept.onclick = null;
        panel.querySelector('[data-confirm-cancel]').onclick = null;
        panel.onclick = null;
        previousFocus?.focus?.();
        resolve(value);
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
    return state.items.filter(item => isMediaItem(item) && state.selected.has(item.selectionKey));
  }

  function setSelected(item, selected) {
    if (!isMediaItem(item)) return;
    if (selected) state.selected.add(item.selectionKey);
    else state.selected.delete(item.selectionKey);
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
      downloadConcurrency: [1, 2, 3, 4].includes(Number(input.downloadConcurrency)) ? Number(input.downloadConcurrency) : DEFAULT_SETTINGS.downloadConcurrency,
      zipPartSizeMb: [100, 300, 600, 1000].includes(Number(input.zipPartSizeMb)) ? Number(input.zipPartSizeMb) : DEFAULT_SETTINGS.zipPartSizeMb,
      zipPartMaxFiles: [24, 50, 100].includes(Number(input.zipPartMaxFiles)) ? Number(input.zipPartMaxFiles) : DEFAULT_SETTINGS.zipPartMaxFiles,
      archiveLayout: ['flat', 'page', 'page-author', 'reply'].includes(input.archiveLayout) ? input.archiveLayout : DEFAULT_SETTINGS.archiveLayout,
      includeManifest: input.includeManifest !== false,
      dedupeContent: input.dedupeContent !== false,
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
      downloadConcurrency: state.downloadConcurrency,
      zipPartSizeMb: state.zipPartSizeMb,
      zipPartMaxFiles: state.zipPartMaxFiles,
      archiveLayout: state.archiveLayout,
      includeManifest: state.includeManifest,
      dedupeContent: state.dedupeContent,
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
    const archiveLayout = panel.querySelector('[data-setting-archive-layout]');
    const concurrency = panel.querySelector('[data-setting-download-concurrency]');
    const partSize = panel.querySelector('[data-setting-zip-part-size]');
    const partFiles = panel.querySelector('[data-setting-zip-part-files]');
    const manifest = panel.querySelector('[data-setting-include-manifest]');
    const dedupeContent = panel.querySelector('[data-setting-dedupe-content]');
    if (themeSelect) themeSelect.value = state.theme;
    if (densitySelect) densitySelect.value = state.compact ? 'compact' : 'comfortable';
    if (filtersCollapsed) filtersCollapsed.checked = state.filtersCollapsed;
    if (activityCollapsed) activityCollapsed.checked = state.activityCollapsed;
    if (layoutSelect) layoutSelect.value = state.layoutMode;
    if (archiveLayout) archiveLayout.value = state.archiveLayout;
    if (concurrency) concurrency.value = String(state.downloadConcurrency);
    if (partSize) partSize.value = String(state.zipPartSizeMb);
    if (partFiles) partFiles.value = String(state.zipPartMaxFiles);
    if (manifest) manifest.checked = state.includeManifest;
    if (dedupeContent) dedupeContent.checked = state.dedupeContent;
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
    if (replace) state.selected.clear();
    items.filter(isMediaItem).forEach(item => state.selected.add(item.selectionKey));
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
    }
    if (clearButton) clearButton.disabled = !count || state.downloading;
    const modeButton = app.querySelector('[data-action="selection-mode"]');
    if (modeButton) setIconButton(modeButton, state.selectionMode ? 'close' : 'select', state.selectionMode ? 'Exit selection' : `Select media${count ? ` (${count})` : ''}`);
    const visible = state.renderedItems;
    app.querySelectorAll('.scg-card[data-index]').forEach(cardNode => {
      const item = visible[Number(cardNode.dataset.index)];
      const checked = Boolean(item && state.selected.has(item.selectionKey));
      cardNode.classList.toggle('selected', state.selectionMode && checked);
      const input = cardNode.querySelector('[data-select]');
      if (input) input.checked = checked;
    });
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
      list.innerHTML = jobs.slice(-40).map(job => {
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
        return `<div class="scg-download-job scg-job-${escapeHtml(job.status)}"><div><b title="${escapeHtml(job.filename)}">${escapeHtml(job.filename)}</b><span>${escapeHtml(detail)}</span></div><div class="scg-job-track"><i class="${indeterminate ? 'indeterminate' : ''}" style="width:${jobPercent}%"></i></div></div>`;
      }).join('') || '<div class="scg-download-empty">No downloads yet.</div>';
    }
    app.querySelectorAll('[data-action="page"], [data-action="load-source-page"], [data-source-page]').forEach(control => {
      control.disabled = state.downloading || state.scanning;
    });
    const threadScanButton = app.querySelector('[data-action="thread"]');
    if (threadScanButton) threadScanButton.disabled = state.downloading;
    updateSelectionUi();
    updateDownloadedIndicators();
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
    const q = state.query.trim().toLowerCase();
    const filtered = state.items.filter(item => {
      const typeMatch = state.filter === 'all' || item.type === state.filter ||
        (state.filter === 'video' && item.type === 'embed');
      const host = itemSourceHost(item);
      const authorMatch = state.authorFilter === 'all' || item.author === state.authorFilter;
      const hostMatch = state.hostFilter === 'all' || host === state.hostFilter;
      const selectedMatch = !state.selectedOnly || state.selected.has(item.selectionKey);
      return typeMatch && authorMatch && hostMatch && selectedMatch && (!q || item.searchText.includes(q));
    });

    const thread = (a, b) => compareThreadOrder(a, b);
    const alpha = (left, right) => String(left || '').localeCompare(String(right || ''), undefined, { sensitivity: 'base' });
    if (state.sort === 'thread-desc') filtered.sort((a, b) => thread(b, a));
    else if (state.sort === 'author') filtered.sort((a, b) => alpha(a.author, b.author) || thread(a, b));
    else if (state.sort === 'host') filtered.sort((a, b) => alpha(itemSourceHost(a), itemSourceHost(b)) || thread(a, b));
    else if (state.sort === 'type') filtered.sort((a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) || thread(a, b));
    else filtered.sort(thread);
    return filtered;
  }

  function replyKey(item) {
    return `${item.pageNumber || 1}|${item.postId || item.postUrl || item.postIndex || 0}`;
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
    const selection = isMediaItem(item)
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
    return [...groups.values()].map(group => {
      const first = group.first;
      const replyLabel = first.postNumber ? `Reply #${first.postNumber}` : `Reply ${Number(first.postIndex || 0) + 1}`;
      return `<section class="scg-reply-group"><header><div><b>${escapeHtml(replyLabel)}</b><span>${escapeHtml(first.author || 'Unknown')}</span><span>Page ${Number(first.pageNumber || 1)}</span><span>${group.entries.length} item${group.entries.length === 1 ? '' : 's'}</span></div><a href="${escapeHtml(first.postUrl)}" target="_blank" rel="noopener">${icon('external')}<span>View reply</span></a></header><div class="scg-group-grid">${group.entries.map(entry => card(entry.item, entry.index)).join('')}</div></section>`;
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
    applyShellState();
    app.querySelectorAll('[data-filter], [data-search], .scg-refinebar button, .scg-refinebar select, .scg-viewbar button, .scg-viewbar select, [data-action="page"], [data-action="load-source-page"]').forEach(control => {
      control.disabled = state.scanning;
    });
    app.querySelectorAll('[data-filter]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.filter === state.filter);
      const key = btn.dataset.filter;
      btn.querySelector('span').textContent = c[key] ?? 0;
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
        : '<div class="scg-empty">Nothing matched these filters.</div>';
    if (!state.scanning) observeFullImages(state.renderedItems);
    app.querySelector('.scg-status').textContent = state.scanning
      ? `Scanning ${state.scannedPages || 1} of ${state.threadPageCount}`
      : state.sourceLabel;
    const activityDetail = app.querySelector('[data-activity-detail]');
    if (activityDetail) activityDetail.textContent = state.scanning
      ? `${state.items.length} items indexed · media stays unloaded`
      : `${LAYOUT_LABELS[state.layoutMode]} · ${matched.length} matched · ${state.items.length} indexed · view ${state.viewPage} of ${state.viewPages}`;
    setIconButton(app.querySelector('[data-action="thread"]'), state.scanning ? 'close' : 'scan', state.scanning ? 'Cancel scan' : 'Scan entire thread');
    setIconButton(app.querySelector('[data-action="selection-mode"]'), state.selectionMode ? 'close' : 'select', state.selectionMode
      ? 'Exit selection'
      : `Select media${state.selected.size ? ` (${selectedMediaItems().length})` : ''}`);
    app.querySelector('[data-selected-only]').classList.toggle('active', state.selectedOnly);
    app.querySelector('[data-sort]').value = state.sort;
    app.querySelector('[data-group-by]').value = state.groupBy;
    updateViewPager(matched.length);
    updateSelectionUi();
    updateDownloadUi();
    refreshThreadHeader();
    refreshSettingsPanel();
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
          <div class="scg-viewer-identity"><b>${state.lightboxIndex + 1}<span>/ ${items.length}</span></b><div><div class="scg-viewer-titleline"><strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong><span class="scg-viewer-resolution" data-viewer-resolution>${escapeHtml(resolutionLabel)}</span></div><small>${escapeHtml(item.author || 'Unknown')} · ${escapeHtml(viewerReplyLabel(item))} · Page ${Number(item.pageNumber || 1)} · ${escapeHtml(sourceHost)}</small></div></div>
          <div class="scg-viewer-tools">
            <div class="scg-viewer-zoom ${item.type === 'image' ? '' : 'unavailable'}"><button data-viewer-zoom-out data-tooltip="Zoom out" aria-label="Zoom out">${iconWell('zoomOut')}</button><button data-viewer-fit data-tooltip="Fit image" aria-label="Fit image">${iconWell('fit')}<span data-viewer-zoom-value>100%</span></button><button data-viewer-zoom-in data-tooltip="Zoom in" aria-label="Zoom in">${iconWell('zoomIn')}</button></div>
            <button class="scg-viewer-download" data-download-current data-tooltip="${wasDownloaded(item) ? 'Download again (D)' : 'Download (D)'}" aria-label="${wasDownloaded(item) ? 'Download again' : 'Download media'}">${iconWell('download', 'scg-icon-well-primary')}</button>
            <button data-viewer-info data-tooltip="Toggle details (I)" aria-label="Toggle details" aria-pressed="${state.viewerInfoOpen}">${iconWell('info')}</button>
            <button data-viewer-fullscreen data-tooltip="Fullscreen (F)" aria-label="Toggle fullscreen">${iconWell('fullscreen')}</button>
            <button class="scg-lightbox-close" data-viewer-close data-tooltip="Close (Esc)" aria-label="Close viewer">${iconWell('close', 'scg-icon-well-danger')}</button>
          </div>
        </header>
        <div class="scg-viewer-body">
          <button class="scg-nav scg-prev" data-viewer-prev aria-label="Previous media">${icon('previous')}</button>
          <section class="scg-lightbox-stage" data-viewer-stage aria-live="polite"><div class="scg-viewer-loading"><i></i><span>Resolving original media…</span></div></section>
          <aside class="scg-viewer-details">
            <div class="scg-viewer-details-head"><span>${icon(item.type === 'image' ? 'image' : 'video')}</span><div><b>${escapeHtml(typeLabel)}</b><small>${escapeHtml(sourceHost)}</small></div></div>
            ${item.caption ? `<p class="scg-viewer-caption">${escapeHtml(item.caption)}</p>` : ''}
            <dl><div><dt>Resolution</dt><dd data-viewer-resolution>${escapeHtml(resolutionLabel)}</dd></div><div><dt>Posted by</dt><dd>${escapeHtml(item.author || 'Unknown')}</dd></div><div><dt>Location</dt><dd>${escapeHtml(viewerReplyLabel(item))}, page ${Number(item.pageNumber || 1)}</dd></div><div><dt>Download</dt><dd>${escapeHtml(savedLabel)}</dd></div><div><dt>Collection</dt><dd>${items.length} filtered media items</dd></div></dl>
            <div class="scg-viewer-details-links"><a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener">${icon('external')}<span>Open source</span></a><a href="${escapeHtml(item.postUrl)}" target="_blank" rel="noopener">${icon('external')}<span>View reply</span></a></div>
            <p class="scg-viewer-shortcuts">← → navigate · wheel / + − zoom · 0 fit · I details · F fullscreen · D download · S select</p>
          </aside>
          <button class="scg-nav scg-next" data-viewer-next aria-label="Next media">${icon('next')}</button>
        </div>
        <footer class="scg-viewer-footer">
          <div class="scg-viewer-strip" aria-label="Nearby media">${viewerStripMarkup(items, state.lightboxIndex)}</div>
          <div class="scg-lightbox-actions"><button data-select-current>${iconWell('select')}<span>${state.selected.has(item.selectionKey) ? 'Unselect' : 'Select'} (S)</span></button><button data-copy-current>${iconWell('copy')}<span>Copy link</span></button></div>
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
        setViewerResolutionStatus(box, 'Detecting…');
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
    state.selected.clear();
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
    app.querySelector('.scg-status').textContent = `Indexed ${state.scannedPages} page${state.scannedPages === 1 ? '' : 's'} - ${state.items.length} items - media not loaded yet`;
    const detail = app.querySelector('[data-activity-detail]');
    if (detail) detail.textContent = `${state.items.length} items indexed · media stays unloaded`;
    refreshThreadHeader();
    setIconButton(app.querySelector('[data-action="thread"]'), 'close', 'Cancel scan');
  }

  async function scanThread() {
    if (state.downloading) return notify('Finish or cancel the ZIP queue before scanning another page.');
    if (state.scanning) {
      state.cancelScan = true;
      return;
    }
    state.scanning = true;
    state.cancelScan = false;
    state.scannedPages = 0;
    state.items = [];
    resetDatasetState();
    state.sourceLabel = 'Entire thread';
    render();

    const base = threadBaseUrl();
    let nextUrl = base;
    const visited = new Set();
    const seenItems = new Set();
    try {
      while (nextUrl && !visited.has(nextUrl) && !state.cancelScan && visited.size < 250) {
        visited.add(nextUrl);
        let doc;
        if (new URL(nextUrl).pathname === location.pathname && visited.size === 1) {
          doc = document;
        } else {
          const response = await fetch(nextUrl, { credentials: 'include' });
          if (!response.ok) throw new Error(`Page request failed (${response.status})`);
          doc = new DOMParser().parseFromString(await response.text(), 'text/html');
        }
        updateThreadPageInfo(doc, nextUrl);
        appendUniqueItems(state.items, extractFromDocument(doc, nextUrl), seenItems);
        state.scannedPages = visited.size;
        updateScanStatus();
        const next = doc.querySelector('a.pageNav-jump--next[href], a[rel="next"][href]');
        nextUrl = next ? absoluteUrl(next.getAttribute('href'), nextUrl) : '';
        doc = null;
        if (nextUrl && !state.cancelScan) await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (nextUrl && visited.size >= 250) {
        state.sourceLabel = 'Partial thread scan (250-page safety limit)';
        notify('Stopped at the 250-page safety limit. Use the page picker for later pages.', 6500);
      }
    } catch (error) {
      console.error('[SimpCity Gallery]', error);
      recordDiagnostic('scanFailures', 'Whole-thread scan', error);
      notify(`Gallery scan stopped: ${error.message}`, 6500);
    } finally {
      if (state.cancelScan && state.scannedPages) state.sourceLabel = `Partial thread scan (${state.scannedPages} pages)`;
      state.scanning = false;
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
    #scg-launch{position:fixed;right:18px;bottom:18px;z-index:2147483645;border:0;border-radius:999px;background:#8b5cf6;color:#fff;padding:12px 17px;font:700 14px system-ui;box-shadow:0 8px 28px #0008;cursor:pointer}
    #${APP_ID}{position:fixed;inset:0;z-index:2147483646;background:#0b0d12;color:#e8eaf0;font:14px/1.45 system-ui;display:none;overflow:hidden}
    #${APP_ID}.open{display:flex;flex-direction:column}.scg-header{display:flex;align-items:center;gap:12px;padding:12px 16px;background:#131722;border-bottom:1px solid #2a3040;flex-wrap:wrap}.scg-title{font-size:18px;font-weight:800;margin-right:auto}.scg-close{border:0;background:#252b3a;color:#fff;width:38px;height:38px;border-radius:10px;font-size:20px;cursor:pointer}.scg-controls{display:flex;gap:8px;align-items:center;padding:10px 16px;background:#10141d;border-bottom:1px solid #242a38;flex-wrap:wrap}.scg-controls button{border:1px solid #30384b;background:#191f2c;color:#cad0dc;border-radius:9px;padding:8px 11px;cursor:pointer}.scg-controls button.active{background:#7c3aed;border-color:#8b5cf6;color:#fff}.scg-controls button span{opacity:.75;margin-left:4px}.scg-controls input{min-width:220px;flex:1;background:#090c12;border:1px solid #30384b;color:#fff;border-radius:9px;padding:9px 11px}.scg-status{color:#929bad;margin-left:auto}.scg-scroll{overflow:auto;padding:14px}.scg-grid{columns:5 260px;column-gap:12px}.scg-card{break-inside:avoid;margin:0 0 12px;background:#161b26;border:1px solid #272e3e;border-radius:12px;overflow:hidden;box-shadow:0 3px 12px #0004}.scg-preview{display:block;width:100%;border:0;padding:0;background:#080a0e;cursor:zoom-in}.scg-card img,.scg-card video{display:block;width:100%;max-height:620px;object-fit:contain;background:#080a0e}.scg-meta{display:flex;justify-content:space-between;gap:8px;padding:8px 10px;color:#9ca5b5;font-size:12px}.scg-meta a{color:#a78bfa;text-decoration:none}.scg-host{display:flex;min-height:120px;padding:18px;box-sizing:border-box;flex-direction:column;justify-content:center;gap:5px;color:#edf0f7;text-decoration:none;background:linear-gradient(135deg,#20283a,#141824)}.scg-host small{color:#aab1bf}.scg-textcard p{margin:0;padding:14px;color:#d4d8e1;white-space:pre-wrap}.scg-empty{padding:60px;text-align:center;color:#9ca3af;column-span:all}
    #scg-launch,#${APP_ID},#${APP_ID} *{box-sizing:border-box;font-family:Arial,Helvetica,sans-serif;letter-spacing:normal;text-transform:none}#${APP_ID} button,#${APP_ID} input{font:inherit}.scg-actions{display:flex;gap:7px;padding:8px;background:#10141d;border-top:1px solid #272e3e}.scg-actions button,.scg-lightbox-bar button{border:1px solid #3b455d;background:#202738;color:#eef1f7;border-radius:7px;padding:7px 10px;cursor:pointer}.scg-actions button:hover,.scg-lightbox-bar button:hover{background:#7c3aed}.scg-embed{position:relative;width:100%;aspect-ratio:16/9;background:#05070a}.scg-embed iframe{display:block;width:100%;height:100%;border:0}
    .scg-lightbox{display:none;position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.96);align-items:center;justify-content:center;padding:48px 84px}.scg-lightbox.open{display:flex}.scg-lightbox-main{display:flex;flex-direction:column;max-width:calc(100vw - 170px);max-height:calc(100vh - 80px)}.scg-lightbox-stage{display:flex;align-items:center;justify-content:center;min-width:280px;min-height:180px;overflow:hidden}.scg-lightbox-stage img,.scg-lightbox-stage video,.scg-lightbox-stage iframe{display:block;max-width:calc(100vw - 190px);max-height:calc(100vh - 145px);width:auto;height:auto;object-fit:contain;border:0;background:#000}.scg-lightbox-stage iframe{width:min(1280px,calc(100vw - 190px));height:min(720px,calc(100vh - 145px));aspect-ratio:16/9}.scg-lightbox-bar{display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;padding:10px;color:#d5dae5}.scg-lightbox-bar a{color:#c4b5fd;text-decoration:none}.scg-lightbox-close{position:absolute;right:18px;top:14px;border:1px solid #4b5563;background:#171b24;color:#fff;width:40px;height:40px;border-radius:50%;font-size:18px;cursor:pointer}.scg-nav{position:absolute;top:50%;transform:translateY(-50%);width:54px;height:76px;border:1px solid #495166;background:#171b24;color:#fff;border-radius:12px;cursor:pointer}.scg-prev{left:16px}.scg-next{right:16px}.scg-nav span{display:block;width:18px;height:18px;border-top:4px solid #fff;border-left:4px solid #fff;margin:auto}.scg-prev span{transform:rotate(-45deg);margin-left:19px}.scg-next span{transform:rotate(135deg);margin-right:19px}.scg-loading{color:#cbd1dc}.scg-toast{position:fixed;left:50%;bottom:22px;z-index:2147483647;transform:translate(-50%,25px);background:#242b3b;color:#fff;border:1px solid #47516a;border-radius:9px;padding:10px 14px;opacity:0;pointer-events:none;transition:.18s}.scg-toast.show{opacity:1;transform:translate(-50%,0)}
    @media(max-width:700px){.scg-controls input{order:2;flex-basis:100%}.scg-status{display:none}.scg-scroll{padding:8px}.scg-grid{columns:2 150px}.scg-lightbox{padding:54px 42px}.scg-lightbox-main{max-width:calc(100vw - 84px)}.scg-lightbox-stage img,.scg-lightbox-stage video,.scg-lightbox-stage iframe{max-width:calc(100vw - 90px);max-height:calc(100vh - 180px)}.scg-lightbox-stage iframe{width:calc(100vw - 90px)}.scg-nav{width:36px;height:62px}.scg-prev{left:3px}.scg-next{right:3px}.scg-prev span{margin-left:12px}.scg-next span{margin-right:12px}}

    #scg-launch{right:22px;bottom:22px;padding:13px 19px;border:1px solid #8b7cff;background:linear-gradient(135deg,#6d5dfc,#9b5cf6);box-shadow:0 12px 36px #5b3fd966,0 5px 16px #0008;transition:transform .18s,box-shadow .18s}
    #scg-launch:hover{transform:translateY(-2px);box-shadow:0 16px 42px #5b3fd988,0 7px 20px #0009}
    #${APP_ID}{--bg:#090b11;--panel:#111520;--panel2:#171c29;--line:#293144;--muted:#98a2b6;--text:#eef1f7;--accent:#8071ff;--accent2:#a35cf6;background:radial-gradient(circle at 14% -12%,#2b2055 0,transparent 33%),radial-gradient(circle at 90% -25%,#173a52 0,transparent 30%),var(--bg);color:var(--text);font:14px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Arial,sans-serif}
    #${APP_ID},#${APP_ID} *{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Arial,sans-serif}
    #${APP_ID} button:focus-visible,#${APP_ID} input:focus-visible,#${APP_ID} a:focus-visible{outline:2px solid #a99fff;outline-offset:2px}
    .scg-header{min-height:68px;padding:11px 18px;background:#0d1018e8;border-color:#2c3346;backdrop-filter:blur(18px);flex-wrap:nowrap}
    .scg-brand{display:flex;align-items:center;gap:11px;min-width:250px;margin-right:auto}.scg-brand-mark{display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:linear-gradient(145deg,#7768ff,#a456ef);box-shadow:inset 0 1px #fff4,0 8px 24px #6850ef55;font-size:20px;font-weight:900}.scg-title{font-size:17px;line-height:1.15;margin:0}.scg-brand small{display:block;color:var(--muted);font-size:11px;margin-top:4px;letter-spacing:.02em}.scg-header-actions{display:flex;align-items:center;gap:8px}.scg-header-actions button{border:1px solid var(--line);background:#171c28;color:#d9deea;border-radius:10px;padding:8px 11px;cursor:pointer}.scg-header-actions button:hover{background:#22293a;border-color:#44506b}.scg-close{width:38px!important;height:38px!important;padding:0!important;background:#261922!important;border-color:#573143!important}
    .scg-controls{display:flex;align-items:center;gap:10px;padding:10px 16px;background:#0e121be8;border-color:#242b3c;backdrop-filter:blur(15px)}.scg-filters{display:flex;gap:5px;align-items:center;padding:4px;background:#080b12;border:1px solid #242b3b;border-radius:12px}.scg-controls button{border-color:transparent;background:transparent;border-radius:8px;padding:7px 10px;color:#aeb6c6}.scg-controls button:hover{background:#202636;color:#fff}.scg-controls button.active{background:linear-gradient(135deg,#6758e9,#8b5cf6);border-color:#8e80ff;color:#fff;box-shadow:0 5px 14px #6d55e83d}.scg-search{position:relative;flex:1;min-width:210px;max-width:560px}.scg-search input{width:100%;min-width:0!important;background:#090c13!important;border:1px solid #2d3548!important;border-radius:11px!important;padding:9px 12px 9px 35px!important}.scg-search:before{content:'';position:absolute;left:13px;top:50%;width:9px;height:9px;border:2px solid #8f99ad;border-radius:50%;transform:translateY(-60%)}.scg-search:after{content:'';position:absolute;left:23px;top:56%;width:6px;height:2px;background:#8f99ad;transform:rotate(45deg)}.scg-scan-actions{display:flex;gap:6px;margin-left:auto}.scg-scan-actions button{border:1px solid #30394d;background:#171c28}.scg-status{margin:0;color:#9ba5b8;font-size:12px;white-space:nowrap}
    .scg-bulkbar{display:flex;align-items:center;gap:7px;padding:8px 16px;background:#121722;border-bottom:1px solid #283044;box-shadow:0 8px 20px #0002;flex-wrap:wrap}.scg-bulk-label{font-size:12px;font-weight:800;color:#b9c1d0;margin-right:3px}.scg-bulkbar button{border:1px solid #323b50;background:#1a202d;color:#d1d6e1;border-radius:9px;padding:7px 10px;cursor:pointer}.scg-bulkbar button:hover:not(:disabled){background:#262e40;border-color:#4a5772;color:#fff}.scg-bulkbar button:disabled{opacity:.42;cursor:not-allowed}.scg-selected-count{color:#aab3c4;font-size:12px;margin-left:2px}.scg-bulkbar .scg-primary{background:linear-gradient(135deg,#6a5bea,#9259ed);border-color:#8b7cfc;color:#fff;font-weight:750;margin-left:3px}.scg-progress{display:none;align-items:center;gap:9px;min-width:240px;margin-left:auto}.scg-progress.visible{display:flex}.scg-progress-track{height:6px;flex:1;min-width:90px;border-radius:99px;background:#080b11;overflow:hidden;border:1px solid #283044}.scg-progress-fill{height:100%;width:0;background:linear-gradient(90deg,#6e62ff,#45c6d9);transition:width .2s}.scg-progress-text{font-size:11px;color:#aeb7c8;white-space:nowrap;max-width:290px;overflow:hidden;text-overflow:ellipsis}
    .scg-scroll{position:relative;padding:16px 18px 80px;scroll-behavior:smooth}.scg-grid{columns:5 275px;column-gap:14px}.compact .scg-grid{columns:7 190px;column-gap:10px}.scg-card{position:relative;margin-bottom:14px;background:linear-gradient(155deg,#171c28,#121722);border-color:#293246;border-radius:14px;box-shadow:0 9px 26px #0003;transition:transform .16s,border-color .16s,box-shadow .16s}.compact .scg-card{margin-bottom:10px;border-radius:11px}.scg-card:hover{transform:translateY(-2px);border-color:#414d69;box-shadow:0 13px 34px #0005}.scg-card.selected{border-color:#8878ff;box-shadow:0 0 0 2px #7161ec55,0 14px 34px #0005}
    .scg-select{position:absolute;z-index:8;left:9px;top:9px;width:29px;height:29px;cursor:pointer}.scg-select input{position:absolute;opacity:0;pointer-events:none}.scg-select span{display:block;width:29px;height:29px;border:1px solid #9aa4b8;background:#0b0e16d9;border-radius:9px;box-shadow:0 4px 15px #0008;backdrop-filter:blur(8px)}.scg-select input:checked+span{background:linear-gradient(145deg,#7161ef,#9a5bf3);border-color:#c0b8ff}.scg-select input:checked+span:after{content:'';display:block;width:11px;height:6px;border-left:3px solid #fff;border-bottom:3px solid #fff;transform:rotate(-45deg);margin:8px 0 0 8px}.scg-badge{position:absolute;z-index:7;top:9px;right:9px;display:flex;align-items:center;gap:6px;max-width:calc(100% - 52px);padding:5px 7px;border:1px solid #ffffff22;background:#0a0d14d9;border-radius:8px;color:#c4cada;font-size:9px;box-shadow:0 4px 15px #0007;backdrop-filter:blur(8px)}.scg-badge b{color:#b9afff;font-size:9px;letter-spacing:.07em}.scg-badge span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .scg-preview{background:#080a0f}.scg-card img,.scg-card video{max-height:680px;background:#07090e}.compact .scg-card img,.compact .scg-card video{max-height:420px}.scg-embed{background:#06080d}.scg-actions{gap:6px;padding:8px;background:#10141e;border-color:#283044}.scg-actions button{flex:1;border-color:#303a50;background:#1a202e;border-radius:8px;padding:7px 8px}.scg-actions button:hover{background:#293247}.scg-actions .scg-download-action{background:#29224a;border-color:#564a8c;color:#ddd8ff}.scg-meta{padding:8px 10px;color:#8994a8}.scg-meta a{color:#aa9eff}.scg-host{min-height:135px;padding:42px 17px 18px;background:linear-gradient(145deg,#202840,#131824)}.scg-host strong{word-break:break-word}.scg-textcard p{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:8;overflow:hidden;padding:42px 14px 12px;margin:0;white-space:pre-wrap}.scg-textcard p.expanded{display:block;-webkit-line-clamp:unset}.scg-expand{width:calc(100% - 20px);margin:0 10px 7px;border:0;background:transparent;color:#ad9fff;padding:5px;cursor:pointer}.scg-expand:hover{color:#fff}.scg-empty{padding:90px 20px;color:#a1aabc;font-size:15px}.scg-top{display:none;position:fixed;right:25px;bottom:25px;z-index:20;border:1px solid #495573;background:#1b2130;color:#fff;border-radius:11px;padding:9px 12px;box-shadow:0 8px 24px #0008;cursor:pointer}.scg-top.visible{display:block}
    .scg-lightbox{background:#05070bee;padding:38px 78px;backdrop-filter:blur(18px)}.scg-lightbox-main{width:min(1440px,calc(100vw - 170px));max-width:none}.scg-lightbox-stage{min-height:240px;max-height:calc(100vh - 150px);border-radius:12px;overflow:hidden}.scg-lightbox-stage img,.scg-lightbox-stage video,.scg-lightbox-stage iframe{max-width:100%;max-height:calc(100vh - 160px);border-radius:10px}.scg-lightbox-stage img{cursor:zoom-in}.scg-lightbox.zoomed .scg-lightbox-stage{display:block;overflow:auto}.scg-lightbox.zoomed .scg-lightbox-stage img{max-width:none;max-height:none;cursor:zoom-out;margin:auto}.scg-lightbox-bar{justify-content:space-between;padding:12px 4px 0;gap:14px}.scg-lightbox-info,.scg-lightbox-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.scg-lightbox-info{color:#99a3b7;font-size:12px}.scg-lightbox-info b{color:#fff;font-size:13px}.scg-lightbox-actions button{background:#191f2c;border-color:#39445b}.scg-lightbox-actions a{display:inline-flex;border:1px solid #39445b;border-radius:7px;padding:7px 10px;color:#c8c1ff;background:#161b27}.scg-lightbox-close,.scg-nav{background:#151a25d9;border-color:#4a566f;backdrop-filter:blur(10px)}.scg-toast{bottom:26px;max-width:min(620px,calc(100vw - 30px));background:#202738;border-color:#526079;border-radius:11px;padding:12px 16px;box-shadow:0 10px 30px #0008;text-align:center}
    @media(max-width:1050px){.scg-header{flex-wrap:wrap}.scg-brand{min-width:200px}.scg-controls{align-items:stretch}.scg-filters{order:1}.scg-search{order:2;max-width:none}.scg-scan-actions{order:3;width:100%;margin:0}.scg-status{margin-left:auto;align-self:center}.scg-progress{width:100%;margin-left:0}.scg-grid{columns:4 230px}}
    @media(max-width:700px){.scg-header{padding:8px 10px;min-height:58px}.scg-brand-mark{width:35px;height:35px}.scg-brand small{display:none}.scg-header-actions [data-action="shortcuts"]{display:none}.scg-header-actions button{padding:7px 8px}.scg-controls{padding:8px;gap:7px}.scg-filters{width:100%;overflow-x:auto}.scg-filters button{flex:1;white-space:nowrap}.scg-search{flex-basis:100%}.scg-scan-actions{flex-wrap:wrap}.scg-status{width:100%;text-align:right}.scg-bulkbar{padding:8px}.scg-bulk-label{width:100%}.scg-bulkbar button{padding:7px 8px}.scg-selected-count{margin-left:auto}.scg-scroll{padding:8px 8px 70px}.scg-grid,.compact .scg-grid{columns:2 155px;column-gap:8px}.scg-badge span{display:none}.scg-actions{padding:6px}.scg-actions button{font-size:12px;padding:6px 4px}.scg-meta{font-size:10px}.scg-lightbox{padding:50px 38px}.scg-lightbox-main{width:calc(100vw - 76px);max-width:none}.scg-lightbox-stage{max-height:calc(100vh - 210px)}.scg-lightbox-stage img,.scg-lightbox-stage video,.scg-lightbox-stage iframe{max-width:100%;max-height:calc(100vh - 220px)}.scg-lightbox-bar{justify-content:center}.scg-lightbox-info,.scg-lightbox-actions{justify-content:center}.scg-nav{width:34px}.scg-prev{left:2px}.scg-next{right:2px}}

    .scg-refinebar,.scg-viewbar{display:flex;align-items:center;gap:8px;padding:8px 16px;background:#0c1018e8;border-bottom:1px solid #252d3e;flex-wrap:wrap}.scg-refinebar label,.scg-viewbar label{display:flex;align-items:center;gap:6px;color:#8f9aae;font-size:11px;font-weight:700}.scg-refinebar select,.scg-viewbar select,.scg-scan-actions select{min-width:120px;border:1px solid #313a50;background:#151a25;color:#e1e5ed;border-radius:9px;padding:7px 9px;font:inherit}.scg-refinebar button,.scg-viewbar button{border:1px solid #313a50;background:#171d29;color:#d2d8e3;border-radius:9px;padding:7px 10px;cursor:pointer}.scg-refinebar button:hover,.scg-viewbar button:hover:not(:disabled){background:#252d3f;color:#fff}.scg-refinebar button.active{background:#30275a;border-color:#7164bd;color:#e5e0ff}.scg-refine-spacer{flex:1}.scg-viewbar{padding-top:6px;padding-bottom:6px}.scg-view-summary{color:#9da7b9;font-size:11px;margin-right:auto}.scg-viewbar button:disabled{opacity:.35;cursor:not-allowed}.scg-viewbar [data-view-page]{min-width:92px}.scg-viewbar [data-page-size]{min-width:72px}
    .scg-bulkbar{display:none}.selecting .scg-bulkbar{display:flex}.scg-select{display:none}.selecting .scg-select{display:block}.scg-selection-toggle{background:linear-gradient(135deg,#322a61,#242042)!important;border-color:#6256a4!important;color:#e4dfff!important}
    .scg-embed-placeholder{display:grid;place-items:center;min-height:150px;background:radial-gradient(circle at 50% 0,#2c2850,#0b0e16 68%)}.scg-embed-placeholder button{display:flex;flex-direction:column;align-items:center;gap:5px;border:1px solid #5d548c;background:#211d3be8;color:#fff;border-radius:12px;padding:13px 18px;cursor:pointer;box-shadow:0 8px 25px #0007}.scg-embed-placeholder button:hover{background:#342b5c;transform:translateY(-1px)}.scg-embed-placeholder button b{font-size:14px}.scg-embed-placeholder button span{font-size:10px;color:#aaa5c9}
    .scg-grid.grouped{columns:auto!important;display:block}.scg-reply-group{margin:0 0 16px;border:1px solid #30394d;background:#0e121b;border-radius:14px;overflow:hidden;box-shadow:0 10px 28px #0003}.scg-reply-group>header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 13px;background:linear-gradient(90deg,#1a2030,#121722);border-bottom:1px solid #30394b}.scg-reply-group>header>div{display:flex;align-items:center;gap:11px;flex-wrap:wrap}.scg-reply-group>header b{color:#e7eaff}.scg-reply-group>header span{color:#929caf;font-size:11px}.scg-reply-group>header a{color:#b7acff;text-decoration:none;font-size:11px;white-space:nowrap}.scg-group-grid{columns:5 260px;column-gap:12px;padding:12px 12px 1px}.compact .scg-group-grid{columns:7 185px;column-gap:9px}.scg-group-grid .scg-card{margin-bottom:11px}
    .scg-source-page{display:flex;align-items:center;gap:5px}.scg-source-page select{min-width:92px}.scg-scan-actions .scg-status{align-self:center}.scg-scan-actions button:disabled,.scg-scan-actions select:disabled{opacity:.45;cursor:not-allowed}
    @media(max-width:1050px){.scg-refinebar label{flex:1;min-width:165px}.scg-refinebar select{flex:1}.scg-group-grid{columns:4 220px}.scg-scan-actions{align-items:center}}
    @media(max-width:700px){.scg-refinebar,.scg-viewbar{padding:7px 8px}.scg-refinebar label{min-width:145px}.scg-refine-spacer{display:none}.scg-view-summary{width:100%}.scg-source-page{flex:1}.scg-source-page select{flex:1;min-width:85px}.scg-group-grid,.compact .scg-group-grid{columns:2 145px;padding:8px 8px 1px}.scg-reply-group>header{align-items:flex-start}.scg-reply-group>header>div{gap:7px}.scg-reply-group>header span:nth-of-type(2){display:none}}

    .has-downloads:not(.selecting) .scg-bulkbar{display:flex;justify-content:flex-end}.has-downloads:not(.selecting) .scg-bulkbar>:not(.scg-progress){display:none}.scg-progress{position:relative;min-width:300px;margin-left:auto}.scg-progress-summary{display:flex!important;align-items:center;gap:9px;width:100%;min-width:300px;padding:7px 9px!important;background:#0b0e15!important;border-color:#30394e!important}.scg-progress-summary .scg-progress-track{flex:1;height:7px;min-width:95px}.scg-progress-text{max-width:250px;text-align:right}.scg-download-popover{display:none;position:absolute;z-index:80;top:calc(100% + 9px);right:0;width:min(500px,calc(100vw - 28px));max-height:min(520px,70vh);overflow:hidden;border:1px solid #3a455d;border-radius:14px;background:#0d111a;box-shadow:0 22px 60px #000c;color:#e9edf5}.scg-progress:hover .scg-download-popover,.scg-progress.expanded .scg-download-popover,.scg-progress:focus-within .scg-download-popover{display:block}.scg-download-popover>header{display:flex;align-items:center;justify-content:space-between;padding:11px 12px;border-bottom:1px solid #2c3548;background:#151b27}.scg-download-popover>header>div{display:flex;align-items:center;gap:5px}.scg-download-popover>header b{font-size:13px}.scg-download-popover>header button{padding:4px 7px!important;font-size:10px}.scg-download-overall{padding:9px 12px;color:#aeb7c7;font-size:11px;border-bottom:1px solid #242c3c}.scg-download-jobs{max-height:min(420px,57vh);overflow:auto;padding:7px}.scg-download-job{padding:8px;border-radius:9px}.scg-download-job+ .scg-download-job{border-top:1px solid #202838}.scg-download-job>div:first-child{display:flex;align-items:center;justify-content:space-between;gap:12px}.scg-download-job b{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:#e4e8f0}.scg-download-job span{flex:none;color:#8f9aae;font-size:9px}.scg-job-track{height:4px;margin-top:6px;border-radius:99px;background:#05070b;overflow:hidden}.scg-job-track i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#7567f5,#40bed0);transition:width .15s}.scg-job-track i.indeterminate{animation:scg-indeterminate 1s ease-in-out infinite}.scg-job-saved .scg-job-track i{background:#42b883}.scg-job-failed .scg-job-track i,.scg-job-verification .scg-job-track i{background:#d27b55}.scg-job-skipped{opacity:.67}.scg-download-empty{padding:24px;text-align:center;color:#7f899c;font-size:11px}.scg-saved-status{display:none;padding:2px 4px;border-radius:4px;background:#174434;color:#82e5b5;font-size:8px;font-style:normal;font-weight:800;letter-spacing:.04em}.scg-saved-status.visible{display:inline-block}.scg-saved-status.legacy{background:#49331d;color:#f3bd75}.scg-card.downloaded{border-color:#315447}.scg-card.downloaded .scg-download-action{background:#17352d;border-color:#326452;color:#b9f0d8}.scg-card.download-legacy{border-color:#594226}.scg-card.download-legacy .scg-download-action{background:#312515;border-color:#654a28;color:#f2c487}@keyframes scg-indeterminate{0%{transform:translateX(-120%)}50%{transform:translateX(95%)}100%{transform:translateX(290%)}}
    @media(max-width:700px){.scg-progress{width:100%;min-width:0;margin-left:0}.scg-progress-summary{min-width:0}.scg-download-popover{right:0;width:calc(100vw - 16px)}.scg-download-job>div:first-child{align-items:flex-start;flex-direction:column;gap:2px}.scg-progress-text{max-width:190px}}

    .scg-icon{display:inline-block;flex:none;width:16px;height:16px;vertical-align:-3px}.scg-header-actions button,.scg-actions button,.scg-bulkbar button,.scg-settings-actions button,.scg-lightbox-actions button{display:inline-flex;align-items:center;justify-content:center;gap:6px}.scg-close .scg-icon{width:19px;height:19px}.scg-settings-panel{display:none;position:fixed;inset:0;z-index:2147483647;align-items:center;justify-content:center;padding:24px;background:#03050ad9;backdrop-filter:blur(12px)}.scg-settings-panel.open{display:flex}.scg-settings-dialog{display:flex;flex-direction:column;width:min(900px,calc(100vw - 32px));max-height:min(780px,calc(100vh - 32px));overflow:hidden;border:1px solid #3b465f;border-radius:18px;background:linear-gradient(155deg,#151a26,#0d1119);box-shadow:0 30px 90px #000d;outline:none}.scg-settings-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 18px;border-bottom:1px solid #2d3548;background:#181e2b}.scg-settings-head>div{display:flex;align-items:center;gap:11px}.scg-settings-head .scg-icon{width:21px;height:21px;color:#aa9fff}.scg-settings-head h2{margin:0;font-size:17px}.scg-settings-head p{margin:2px 0 0;color:#919bad;font-size:11px}.scg-settings-close{display:inline-grid!important;place-items:center;width:36px;height:36px;padding:0!important;border:1px solid #414b61;background:#202636;color:#fff;border-radius:10px;cursor:pointer}.scg-settings-body{overflow:auto;padding:16px}.scg-settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.scg-settings-card{padding:14px;border:1px solid #2f384d;border-radius:14px;background:#10151f}.scg-settings-card.full{grid-column:1/-1}.scg-settings-card h3{display:flex;align-items:center;gap:7px;margin:0 0 5px;font-size:13px}.scg-settings-card h3 .scg-icon{color:#9e93ff}.scg-settings-card>p{margin:0 0 12px;color:#929caf;font-size:11px}.scg-settings-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.scg-settings-actions button{border:1px solid #3a455c;background:#1b2230;color:#e2e6ee;border-radius:9px;padding:8px 10px;cursor:pointer}.scg-settings-actions button:hover{background:#293247}.scg-settings-actions .danger{background:#351c25;border-color:#6c3448;color:#ffd7e2}.scg-settings-file{display:none}.scg-settings-check{display:flex;align-items:flex-start;gap:8px;margin:10px 0;color:#9da7b8;font-size:10px}.scg-settings-check input{margin-top:2px;accent-color:#8273ff}.scg-diag-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.scg-diag-stat{min-width:0;padding:9px;border:1px solid #2c3548;border-radius:10px;background:#0a0e15}.scg-diag-stat span{display:block;color:#7f899d;font-size:9px;text-transform:uppercase!important;letter-spacing:.07em}.scg-diag-stat b{display:block;margin-top:4px;overflow:hidden;text-overflow:ellipsis;color:#edf0f6;font-size:11px}.scg-storage-note{display:flex;align-items:flex-start;gap:8px;padding:9px 10px;border:1px solid #2e4c43;border-radius:10px;background:#10261f;color:#a7d8c6;font-size:10px}.scg-storage-note .scg-icon{color:#65c9a4}.scg-permission-note{padding:10px;border-left:3px solid #846ff5;background:#15132a;color:#aaa6c5;font-size:10px}.scg-settings-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 16px;border-top:1px solid #2d3548;background:#0d1119;color:#7f899c;font-size:10px}.scg-settings-foot b{color:#b9b1ff}.scg-settings-version{display:inline-flex;align-items:center;padding:3px 6px;border:1px solid #4c426f;border-radius:6px;background:#241e3a;color:#c8c1ff;font-size:9px;margin-left:6px}
    @media(max-width:720px){.scg-settings-panel{padding:8px}.scg-settings-dialog{width:100%;max-height:calc(100vh - 16px)}.scg-settings-grid{grid-template-columns:1fr}.scg-settings-card.full{grid-column:auto}.scg-diag-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.scg-settings-head{padding:12px}.scg-settings-body{padding:10px}.scg-settings-foot{align-items:flex-start;flex-direction:column}.scg-header-actions button span{display:none}}

    /* v0.8 application shell */
    #${APP_ID}{--scg-bg:#090c12;--scg-surface:#111722;--scg-surface-2:#171e2b;--scg-surface-3:#202838;--scg-line:#2a3448;--scg-text:#eef1f7;--scg-muted:#929eb1;--scg-accent:#8b7cf6;--scg-accent-soft:#2c2854;--scg-success:#62d7a3;--scg-danger:#f08aa6;--scg-shadow:#0009;background:var(--scg-bg);color:var(--scg-text);color-scheme:dark}
    #${APP_ID}[data-theme="light"]{--scg-bg:#f4f6fb;--scg-surface:#ffffff;--scg-surface-2:#f7f8fc;--scg-surface-3:#e9edf5;--scg-line:#d8deea;--scg-text:#1d2533;--scg-muted:#657187;--scg-accent:#6858da;--scg-accent-soft:#eeeaff;--scg-success:#167b56;--scg-danger:#b83257;--scg-shadow:#24304724;color-scheme:light}
    #${APP_ID} *,#${APP_ID} *:before,#${APP_ID} *:after{box-sizing:border-box}
    #${APP_ID} button,#${APP_ID} input,#${APP_ID} select{font:inherit}
    #${APP_ID} button:focus-visible,#${APP_ID} input:focus-visible,#${APP_ID} select:focus-visible,#${APP_ID} a:focus-visible{outline:2px solid var(--scg-accent);outline-offset:2px}
    .scg-header{display:grid;grid-template-columns:auto minmax(180px,1fr) auto;align-items:center;gap:16px;flex:none;min-height:66px;padding:10px 14px;background:color-mix(in srgb,var(--scg-surface) 94%,transparent);border-color:var(--scg-line);box-shadow:0 8px 28px var(--scg-shadow);backdrop-filter:blur(18px)}
    .scg-brand{display:flex;align-items:center;gap:9px;min-width:0}.scg-brand-mark{display:grid;place-items:center;width:38px;height:38px;flex:none;border-radius:12px;background:linear-gradient(145deg,#7867ed,#9f5bea);box-shadow:0 8px 22px #6754d951;color:#fff;font-size:18px;font-weight:900}.scg-brand>div:last-child{display:flex;flex-direction:column;line-height:1.05}.scg-brand b{font-size:12px;letter-spacing:.04em}.scg-brand small{margin-top:4px;color:var(--scg-muted);font-size:9px}
    .scg-thread-context{min-width:0}.scg-thread-context h1{margin:0;overflow:hidden;color:var(--scg-text);font-size:15px;font-weight:800;line-height:1.25;text-overflow:ellipsis;white-space:nowrap}.scg-thread-context>div{display:flex;gap:8px;min-width:0;margin-top:4px;color:var(--scg-muted);font-size:10px}.scg-thread-context>div span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.scg-thread-context [data-thread-meta]{flex:none;padding-right:8px;border-right:1px solid var(--scg-line);color:var(--scg-accent)}
    .scg-header-actions{display:flex;align-items:center;gap:5px}.scg-header-actions button{position:relative;display:inline-flex;align-items:center;gap:6px;min-height:36px;border:1px solid transparent;background:transparent;color:var(--scg-muted);border-radius:10px;padding:8px 9px;cursor:pointer}.scg-header-actions button:hover,.scg-header-actions button.active{border-color:var(--scg-line);background:var(--scg-surface-3);color:var(--scg-text)}.scg-header-actions button span{font-size:11px}.scg-header-actions .scg-close{width:36px;height:36px;padding:0;color:var(--scg-text)}
    #${APP_ID} [data-tooltip]{position:relative}#${APP_ID} [data-tooltip]:hover:after{content:attr(data-tooltip);position:absolute;z-index:120;top:calc(100% + 8px);left:50%;width:max-content;max-width:220px;transform:translateX(-50%);padding:6px 8px;border:1px solid var(--scg-line);border-radius:7px;background:var(--scg-surface-3);box-shadow:0 8px 24px var(--scg-shadow);color:var(--scg-text);font-size:10px;font-weight:600;line-height:1.25;pointer-events:none}.scg-header-actions button:last-child[data-tooltip]:hover:after{right:0;left:auto;transform:none}
    .scg-controls{display:flex;align-items:center;gap:10px;flex:none;padding:9px 14px;background:var(--scg-surface);border-color:var(--scg-line);backdrop-filter:none}.scg-search{max-width:none;min-width:180px}.scg-search input{height:38px!important;background:var(--scg-bg)!important;border-color:var(--scg-line)!important;color:var(--scg-text)!important}.scg-scan-actions{display:flex;align-items:center;gap:6px;margin-left:auto}.scg-scan-actions button{display:inline-flex;align-items:center;gap:6px;min-height:36px;border:1px solid var(--scg-line);background:var(--scg-surface-2);color:var(--scg-text)}.scg-scan-actions button:hover{background:var(--scg-surface-3)}
    .scg-filter-panel{display:block;flex:none;overflow:hidden;background:var(--scg-surface-2);border-bottom:1px solid var(--scg-line)}.filters-collapsed .scg-filter-panel{display:none}.scg-filter-panel .scg-filters{display:flex;gap:5px;overflow-x:auto;padding:7px 14px;border:0;border-bottom:1px solid var(--scg-line);border-radius:0;background:transparent;scrollbar-width:thin}.scg-filter-panel .scg-filters button{flex:none;border:1px solid transparent;background:transparent;color:var(--scg-muted);border-radius:9px;padding:6px 10px;cursor:pointer}.scg-filter-panel .scg-filters button:hover{background:var(--scg-surface-3);color:var(--scg-text)}.scg-filter-panel .scg-filters button.active{border-color:color-mix(in srgb,var(--scg-accent) 45%,var(--scg-line));background:var(--scg-accent-soft);color:var(--scg-accent);box-shadow:none}.scg-refinebar{padding:8px 14px;background:transparent;border:0}.scg-refinebar label,.scg-viewbar label{color:var(--scg-muted)}.scg-refinebar select,.scg-viewbar select,.scg-scan-actions select{border-color:var(--scg-line);background:var(--scg-surface);color:var(--scg-text)}.scg-refinebar button,.scg-viewbar button{border-color:var(--scg-line);background:var(--scg-surface);color:var(--scg-text)}.scg-refinebar button:hover,.scg-viewbar button:hover:not(:disabled){background:var(--scg-surface-3)}.scg-refinebar button.active{border-color:var(--scg-accent);background:var(--scg-accent-soft);color:var(--scg-accent)}
    .scg-viewbar{flex:none;padding:6px 14px;background:var(--scg-surface);border-color:var(--scg-line)}.scg-view-summary{color:var(--scg-muted)}.scg-scroll{min-width:0;min-height:0;flex:1;overflow-x:hidden;overflow-y:auto;padding:14px;background:var(--scg-bg)}.scg-grid{width:100%}.scg-card{background:var(--scg-surface);border-color:var(--scg-line);box-shadow:0 5px 18px var(--scg-shadow)}.scg-card:hover{border-color:color-mix(in srgb,var(--scg-accent) 48%,var(--scg-line));transform:translateY(-1px)}.scg-meta{color:var(--scg-muted)}.scg-meta a,.scg-reply-group>header a{color:var(--scg-accent)}.scg-textcard p{color:var(--scg-text)}.scg-host{color:var(--scg-text);background:linear-gradient(135deg,var(--scg-surface-3),var(--scg-surface-2))}.scg-host small{color:var(--scg-muted)}.scg-reply-group{background:var(--scg-surface);border-color:var(--scg-line);box-shadow:0 10px 28px var(--scg-shadow)}.scg-reply-group>header{background:var(--scg-surface-2);border-color:var(--scg-line)}
    .scg-skeleton{break-inside:avoid;margin:0 0 12px;overflow:hidden;border:1px solid var(--scg-line);border-radius:12px;background:var(--scg-surface)}.scg-skeleton-media,.scg-skeleton-line{position:relative;overflow:hidden;background:var(--scg-surface-3)}.scg-skeleton-media{height:var(--scg-skeleton-height,210px)}.scg-skeleton-line{height:9px;margin:12px;border-radius:99px}.scg-skeleton-line.short{width:48%;margin-top:0}.scg-skeleton-media:after,.scg-skeleton-line:after{content:'';position:absolute;inset:0;transform:translateX(-110%);background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--scg-text) 12%,transparent),transparent);animation:scg-shimmer 1.35s infinite}@keyframes scg-shimmer{to{transform:translateX(110%)}}
    .scg-activitybar,.has-downloads:not(.selecting) .scg-bulkbar{display:flex!important;align-items:center;gap:10px;flex:none;flex-wrap:nowrap;min-width:0;padding:8px 12px;background:color-mix(in srgb,var(--scg-surface) 96%,transparent);border:0;border-top:1px solid var(--scg-line);box-shadow:0 -8px 28px var(--scg-shadow);backdrop-filter:blur(16px)}.scg-activity-state{display:flex!important;align-items:center;gap:9px;min-width:180px}.scg-activity-state>i{width:8px;height:8px;flex:none;border-radius:99px;background:var(--scg-success);box-shadow:0 0 0 4px color-mix(in srgb,var(--scg-success) 14%,transparent)}.scanning .scg-activity-state>i,.downloading .scg-activity-state>i{background:var(--scg-accent);animation:scg-pulse 1.2s infinite}.scg-activity-state>div{display:flex;min-width:0;flex-direction:column}.scg-activity-state .scg-status{display:block;width:auto;margin:0;overflow:hidden;color:var(--scg-text);font-size:11px;text-align:left;text-overflow:ellipsis;white-space:nowrap}.scg-activity-state span{overflow:hidden;color:var(--scg-muted);font-size:9px;text-overflow:ellipsis;white-space:nowrap}@keyframes scg-pulse{50%{opacity:.35}}
    .scg-bulk-actions{display:none;align-items:center;gap:6px;min-width:0}.selecting .scg-bulk-actions,.activity-collapsed.selecting .scg-bulk-actions{display:flex}.scg-bulk-label{color:var(--scg-muted)}.scg-activitybar button{display:inline-flex;align-items:center;justify-content:center;gap:5px;border:1px solid var(--scg-line);background:var(--scg-surface-2);color:var(--scg-text);border-radius:9px;padding:7px 9px;cursor:pointer}.scg-activitybar button:hover:not(:disabled){background:var(--scg-surface-3)}.scg-activitybar .scg-primary{background:linear-gradient(135deg,#6d5dea,#9259ed);border-color:#8e7df7;color:#fff}.scg-selected-count{color:var(--scg-muted)}
    .scg-progress,.scg-progress.visible{position:relative;display:flex;min-width:260px;max-width:460px;flex:1;margin-left:auto}.scg-progress-summary{display:flex!important;width:100%;min-width:0;padding:7px 9px!important;background:var(--scg-bg)!important;border-color:var(--scg-line)!important}.scg-progress-track{background:var(--scg-surface-3);border-color:var(--scg-line)}.scg-progress-text{color:var(--scg-muted)}.scg-download-popover{top:auto;right:0;bottom:calc(100% + 10px);border-color:var(--scg-line);background:var(--scg-surface);box-shadow:0 22px 60px var(--scg-shadow);color:var(--scg-text)}.scg-download-popover>header{background:var(--scg-surface-2);border-color:var(--scg-line)}.scg-download-overall{color:var(--scg-muted);border-color:var(--scg-line)}.scg-download-job+ .scg-download-job{border-color:var(--scg-line)}.scg-download-job b{color:var(--scg-text)}.scg-job-track{background:var(--scg-surface-3)}.scg-activity-toggle,.has-downloads:not(.selecting) .scg-bulkbar>.scg-activity-toggle{display:inline-flex!important;width:34px;flex:none;padding:7px!important}.scg-activity-toggle span{display:none}.scg-activitybar [data-tooltip]:hover:after{top:auto!important;bottom:calc(100% + 8px)}.activity-collapsed .scg-activity-state{min-width:0}.activity-collapsed .scg-activity-state span,.activity-collapsed:not(.selecting) .scg-bulk-actions,.activity-collapsed .scg-progress-track{display:none}.activity-collapsed .scg-progress{min-width:110px;max-width:240px;flex:0 1 240px}.activity-collapsed .scg-progress-summary{justify-content:flex-end;background:transparent!important;border-color:transparent!important}.activity-collapsed .scg-activity-toggle .scg-icon{transform:rotate(180deg)}
    .scg-setting-fields{display:grid;grid-template-columns:1fr 1fr;gap:8px}.scg-setting-fields label{display:flex;flex-direction:column;gap:5px;color:var(--scg-muted);font-size:10px}.scg-setting-fields select{width:100%;border:1px solid var(--scg-line);border-radius:9px;background:var(--scg-surface-2);color:var(--scg-text);padding:8px}.scg-download-settings{grid-template-columns:repeat(4,minmax(0,1fr))}.scg-archive-checks{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;margin-top:8px}.scg-archive-checks .scg-settings-check{margin:5px 0}.scg-settings-dialog{background:var(--scg-surface);border-color:var(--scg-line);box-shadow:0 30px 90px var(--scg-shadow)}.scg-settings-head,.scg-settings-foot{background:var(--scg-surface-2);border-color:var(--scg-line)}.scg-settings-head h2,.scg-settings-card h3{color:var(--scg-text)}.scg-settings-head p,.scg-settings-card>p,.scg-settings-foot,.scg-settings-check{color:var(--scg-muted)}.scg-settings-card,.scg-diag-stat{background:var(--scg-surface-2);border-color:var(--scg-line)}.scg-diag-stat b{color:var(--scg-text)}.scg-settings-actions button,.scg-settings-close{background:var(--scg-surface-3);border-color:var(--scg-line);color:var(--scg-text)}
    .scg-confirm-panel{display:none;position:fixed;inset:0;z-index:2147483647;align-items:center;justify-content:center;padding:18px;background:#05070bb8;backdrop-filter:blur(9px)}.scg-confirm-panel.open{display:flex}.scg-confirm-dialog{width:min(420px,100%);padding:22px;border:1px solid var(--scg-line);border-radius:18px;background:var(--scg-surface);box-shadow:0 26px 80px var(--scg-shadow);text-align:center}.scg-confirm-icon{display:grid;place-items:center;width:42px;height:42px;margin:0 auto 12px;border-radius:13px;background:var(--scg-accent-soft);color:var(--scg-accent)}.scg-confirm-icon .scg-icon{width:21px;height:21px}.scg-confirm-dialog h2{margin:0;color:var(--scg-text);font-size:16px}.scg-confirm-dialog p{margin:8px 0 18px;color:var(--scg-muted);font-size:11px}.scg-confirm-dialog>div:last-child{display:flex;justify-content:center;gap:8px}.scg-confirm-dialog button{min-width:100px;border:1px solid var(--scg-line);border-radius:9px;background:var(--scg-surface-3);color:var(--scg-text);padding:9px 13px;cursor:pointer}.scg-confirm-dialog .scg-confirm-accept{border-color:var(--scg-accent);background:var(--scg-accent);color:#fff}.scg-confirm-dialog .scg-confirm-accept.danger{border-color:#a82d4e;background:#a82d4e}
    #${APP_ID}[data-theme="light"] .scg-actions{background:var(--scg-surface-2);border-color:var(--scg-line)}#${APP_ID}[data-theme="light"] .scg-actions button{border-color:var(--scg-line);background:var(--scg-surface-3);color:var(--scg-text)}#${APP_ID}[data-theme="light"] .scg-actions .scg-download-action{border-color:#cfc8ff;background:#eeeaff;color:#5948c3}#${APP_ID}[data-theme="light"] .scg-expand{color:var(--scg-accent)}#${APP_ID}[data-theme="light"] .scg-permission-note{background:#f0edff;color:#5f5878}#${APP_ID}[data-theme="light"] .scg-storage-note{background:#edf9f4;color:#286c55}

    /* v0.8.1 gallery layouts */
    .scg-view-summary{min-width:120px}.scg-layout-switcher{display:inline-flex;align-items:center;gap:3px;padding:3px;border:1px solid var(--scg-line);border-radius:10px;background:var(--scg-bg)}.scg-layout-switcher button{display:inline-flex;align-items:center;gap:5px;padding:5px 8px;border:0;background:transparent;color:var(--scg-muted);border-radius:7px}.scg-layout-switcher button:hover{background:var(--scg-surface-3)}.scg-layout-switcher button.active{background:var(--scg-accent-soft);color:var(--scg-accent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--scg-accent) 35%,transparent)}.scg-layout-switcher .scg-icon{width:14px;height:14px}.scg-layout-switcher span{font-size:10px;font-weight:750}.scg-view-pagination{display:inline-flex;align-items:center;gap:5px;margin-left:auto}.scg-setting-fields{grid-template-columns:repeat(3,minmax(0,1fr))}
    #${APP_ID}[data-layout="masonry"] .scg-grid:not(.grouped){display:block;columns:5 275px;column-gap:14px}#${APP_ID}[data-layout="masonry"].compact .scg-grid:not(.grouped){columns:7 190px;column-gap:10px}
    #${APP_ID}[data-layout="grid"] .scg-grid:not(.grouped),#${APP_ID}[data-layout="grid"] .scg-group-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(245px,1fr));gap:14px;columns:auto}#${APP_ID}[data-layout="grid"].compact .scg-grid:not(.grouped),#${APP_ID}[data-layout="grid"].compact .scg-group-grid{grid-template-columns:repeat(auto-fill,minmax(175px,1fr));gap:10px}#${APP_ID}[data-layout="grid"] .scg-group-grid{padding:12px}#${APP_ID}[data-layout="grid"] .scg-card{display:flex;height:380px;min-width:0;flex-direction:column;margin:0;break-inside:auto}#${APP_ID}[data-layout="grid"].compact .scg-card{height:310px}#${APP_ID}[data-layout="grid"] .scg-preview,#${APP_ID}[data-layout="grid"] .scg-card>video,#${APP_ID}[data-layout="grid"] .scg-embed,#${APP_ID}[data-layout="grid"] .scg-host{min-height:0;flex:1}#${APP_ID}[data-layout="grid"] .scg-preview{overflow:hidden}#${APP_ID}[data-layout="grid"] .scg-preview img,#${APP_ID}[data-layout="grid"] .scg-card>video{width:100%;height:100%;max-height:none;object-fit:cover}#${APP_ID}[data-layout="grid"] .scg-card>video{min-height:190px}#${APP_ID}[data-layout="grid"] .scg-embed{aspect-ratio:auto;min-height:190px}#${APP_ID}[data-layout="grid"] .scg-host{min-height:180px}#${APP_ID}[data-layout="grid"] .scg-actions,#${APP_ID}[data-layout="grid"] .scg-meta{flex:none}#${APP_ID}[data-layout="grid"] .scg-textcard p{min-height:0;flex:1;-webkit-line-clamp:12}#${APP_ID}[data-layout="grid"].compact .scg-textcard p{-webkit-line-clamp:9}#${APP_ID}[data-layout="grid"] .scg-skeleton{height:380px;margin:0}#${APP_ID}[data-layout="grid"].compact .scg-skeleton{height:310px}#${APP_ID}[data-layout="grid"] .scg-skeleton-media{height:auto;min-height:0;flex:1}#${APP_ID}[data-layout="grid"] .scg-skeleton{display:flex;flex-direction:column}
    #${APP_ID}[data-layout="feed"] .scg-grid:not(.grouped),#${APP_ID}[data-layout="feed"] .scg-group-grid{display:grid;grid-template-columns:minmax(0,1100px);justify-content:center;gap:14px;columns:auto}#${APP_ID}[data-layout="feed"] .scg-group-grid{max-width:1140px;margin:auto;padding:14px}#${APP_ID}[data-layout="feed"] .scg-card{width:100%;min-width:0;margin:0;break-inside:auto}#${APP_ID}[data-layout="feed"] .scg-media,#${APP_ID}[data-layout="feed"] .scg-linkcard{display:grid;grid-template-columns:minmax(260px,46%) minmax(0,1fr);grid-template-areas:"visual actions" "visual meta";grid-template-rows:1fr auto;min-height:250px}#${APP_ID}[data-layout="feed"].compact .scg-media,#${APP_ID}[data-layout="feed"].compact .scg-linkcard{min-height:205px}#${APP_ID}[data-layout="feed"] .scg-preview,#${APP_ID}[data-layout="feed"] .scg-card>video,#${APP_ID}[data-layout="feed"] .scg-embed,#${APP_ID}[data-layout="feed"] .scg-host{grid-area:visual;width:100%;height:100%;min-height:250px;border-right:1px solid var(--scg-line)}#${APP_ID}[data-layout="feed"].compact .scg-preview,#${APP_ID}[data-layout="feed"].compact .scg-card>video,#${APP_ID}[data-layout="feed"].compact .scg-embed,#${APP_ID}[data-layout="feed"].compact .scg-host{min-height:205px}#${APP_ID}[data-layout="feed"] .scg-preview{overflow:hidden}#${APP_ID}[data-layout="feed"] .scg-preview img,#${APP_ID}[data-layout="feed"] .scg-card>video{width:100%;height:100%;max-height:520px;object-fit:contain}#${APP_ID}[data-layout="feed"] .scg-embed{aspect-ratio:auto}#${APP_ID}[data-layout="feed"] .scg-host{justify-content:center;padding:42px 24px 24px}#${APP_ID}[data-layout="feed"] .scg-actions{grid-area:actions;align-self:end;border-top:0;border-left:1px solid var(--scg-line);background:transparent}#${APP_ID}[data-layout="feed"] .scg-meta{grid-area:meta;border-left:1px solid var(--scg-line);border-top:1px solid var(--scg-line)}#${APP_ID}[data-layout="feed"] .scg-textcard{max-width:900px;justify-self:center}#${APP_ID}[data-layout="feed"] .scg-textcard p{-webkit-line-clamp:12}#${APP_ID}[data-layout="feed"] .scg-skeleton{display:grid;grid-template-columns:minmax(260px,46%) minmax(0,1fr);height:250px;margin:0}#${APP_ID}[data-layout="feed"] .scg-skeleton-media{height:100%;grid-row:1/4}#${APP_ID}[data-layout="feed"] .scg-skeleton-line{align-self:end}
    #${APP_ID}[data-layout="feed"] .scg-grid.grouped{display:block}#${APP_ID}[data-layout="grid"] .scg-grid.grouped{display:block}
    #scg-gallery-toast{bottom:72px}#scg-gallery-toast[data-theme="light"]{border-color:#d8deea;background:#fff;color:#1d2533;box-shadow:0 14px 45px #24304733}
    @media(max-width:1180px){.scg-brand>div:last-child{display:none}.scg-header-actions button span{display:none}.scg-header-actions button{width:36px;justify-content:center;padding:8px}.scg-thread-context{max-width:none}.scg-progress{max-width:340px}.selecting .scg-activity-state{display:none!important}.scg-bulk-actions{flex:1}#${APP_ID}[data-layout="masonry"] .scg-grid:not(.grouped){columns:4 230px}#${APP_ID}[data-layout="masonry"].compact .scg-grid:not(.grouped){columns:6 175px}}
    @media(max-width:850px){.scg-header{grid-template-columns:auto minmax(0,1fr) auto;gap:9px;padding:8px 10px}.scg-controls{align-items:stretch;flex-wrap:wrap;padding:8px 10px}.scg-search{order:1;flex-basis:100%;max-width:none}.scg-scan-actions{order:2;width:100%;margin:0}.scg-scan-actions [data-action="thread"]{margin-left:auto}.scg-refinebar label{flex:1;min-width:145px}.scg-scroll{padding:10px}.scg-layout-switcher span{display:none}.scg-activitybar{gap:7px;padding:7px 9px}.scg-activity-state{min-width:140px}.scg-progress{min-width:180px}.selecting .scg-progress{display:none}.scg-bulk-actions span:not(.scg-selected-count),.scg-bulk-actions button span{display:none}.scg-bulk-actions button{width:34px;padding:7px}.scg-bulk-actions .scg-primary{width:auto}.scg-bulk-actions .scg-primary span{display:inline}#${APP_ID}[data-layout="masonry"] .scg-grid:not(.grouped){columns:3 205px}#${APP_ID}[data-layout="masonry"].compact .scg-grid:not(.grouped){columns:4 165px}}
    @media(max-width:620px){.scg-header{grid-template-columns:auto minmax(0,1fr) auto;min-height:56px}.scg-brand-mark{width:34px;height:34px;border-radius:10px}.scg-thread-context h1{font-size:12px}.scg-thread-context [data-source-summary]{display:none}.scg-header-actions [data-action="shortcuts"],.scg-header-actions [data-action="density"]{display:none}.scg-header-actions{gap:2px}.scg-header-actions button{width:32px;height:32px;min-height:32px;padding:6px}.scg-controls{gap:6px}.scg-scan-actions{display:grid;grid-template-columns:auto minmax(0,1fr) auto}.scg-scan-actions [data-action="page"] span{display:none}.scg-scan-actions [data-action="thread"]{margin:0;font-size:10px}.scg-source-page{min-width:0}.scg-source-page select{min-width:0;width:100%}.scg-filter-panel .scg-filters{padding:6px 8px}.scg-filter-panel .scg-filters button{padding:6px 9px}.scg-refinebar{padding:7px 8px}.scg-refinebar label{min-width:calc(50% - 5px);font-size:9px}.scg-refinebar select{min-width:0;width:100%;padding:6px}.scg-refine-spacer{display:none}.scg-viewbar{padding:6px 8px;gap:5px}.scg-view-summary{width:auto;min-width:0;flex:1}.scg-layout-switcher button{padding:5px 7px}.scg-layout-switcher button span{display:none}.scg-view-pagination{margin-left:0}.scg-view-pagination button{padding:6px}.scg-viewbar label{display:none}.scg-viewbar button{padding:6px 8px}.scg-scroll{padding:8px}.scg-grid,.compact .scg-grid{columns:2 145px}#${APP_ID}[data-layout="grid"] .scg-grid:not(.grouped),#${APP_ID}[data-layout="grid"] .scg-group-grid,#${APP_ID}[data-layout="grid"].compact .scg-grid:not(.grouped),#${APP_ID}[data-layout="grid"].compact .scg-group-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}#${APP_ID}[data-layout="grid"] .scg-card,#${APP_ID}[data-layout="grid"].compact .scg-card{height:280px}#${APP_ID}[data-layout="feed"] .scg-media,#${APP_ID}[data-layout="feed"] .scg-linkcard,#${APP_ID}[data-layout="feed"].compact .scg-media,#${APP_ID}[data-layout="feed"].compact .scg-linkcard{display:block;min-height:0}#${APP_ID}[data-layout="feed"] .scg-preview,#${APP_ID}[data-layout="feed"] .scg-card>video,#${APP_ID}[data-layout="feed"] .scg-embed,#${APP_ID}[data-layout="feed"] .scg-host,#${APP_ID}[data-layout="feed"].compact .scg-preview,#${APP_ID}[data-layout="feed"].compact .scg-card>video,#${APP_ID}[data-layout="feed"].compact .scg-embed,#${APP_ID}[data-layout="feed"].compact .scg-host{height:auto;min-height:180px;border-right:0}#${APP_ID}[data-layout="feed"] .scg-actions,#${APP_ID}[data-layout="feed"] .scg-meta{border-left:0}#${APP_ID}[data-layout="feed"] .scg-skeleton{display:block;height:auto}#${APP_ID}[data-layout="feed"] .scg-skeleton-media{height:180px}.scg-activity-state{min-width:0;flex:1}.scg-activity-state span{display:none}.scg-progress{min-width:128px;max-width:48%;flex:0 1 48%}.scg-progress-summary{min-width:0}.scg-progress-track{min-width:45px}.scg-progress-text{max-width:85px}.scg-activity-toggle{display:none!important}.selecting .scg-activity-state,.selecting .scg-progress{display:none!important}.selecting .scg-bulk-actions{display:flex;width:100%}.scg-bulk-actions .scg-selected-count{margin-left:auto}.scg-download-popover{position:fixed;right:8px;bottom:58px;width:calc(100vw - 16px);max-height:65vh}.scg-setting-fields{grid-template-columns:1fr}#${APP_ID} [data-tooltip]:hover:after{display:none}}
    @media(max-width:620px){#${APP_ID}[data-layout="masonry"] .scg-grid:not(.grouped),#${APP_ID}[data-layout="masonry"].compact .scg-grid:not(.grouped){columns:2 145px;column-gap:8px}}

    /* v0.8.2 flagship media viewer */
    #${APP_ID} .scg-lightbox{display:none;position:fixed;inset:0;z-index:2147483647;padding:0;background:#03050a;color:#f3f5fa;backdrop-filter:none;overflow:hidden}#${APP_ID} .scg-lightbox.open{display:block}#${APP_ID} .scg-viewer-shell{display:grid;grid-template-rows:auto minmax(0,1fr) auto;width:100%;height:100%;height:100dvh;background:radial-gradient(circle at 45% 20%,#151b28 0,#080b11 48%,#03050a 100%)}
    #${APP_ID} .scg-viewer-topbar{display:flex;align-items:center;gap:16px;min-width:0;min-height:62px;padding:9px 12px 9px 16px;border-bottom:1px solid #283044;background:#0d1119eb;box-shadow:0 8px 30px #0008;backdrop-filter:blur(18px)}#${APP_ID} .scg-viewer-identity{display:flex;align-items:center;gap:13px;min-width:0;flex:1}#${APP_ID} .scg-viewer-identity>b{display:flex;align-items:baseline;gap:4px;flex:none;color:#fff;font-size:18px}#${APP_ID} .scg-viewer-identity>b span{color:#78849a;font-size:10px;font-weight:600}#${APP_ID} .scg-viewer-identity>div{min-width:0}#${APP_ID} .scg-viewer-identity strong,#${APP_ID} .scg-viewer-identity small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#${APP_ID} .scg-viewer-identity strong{max-width:min(680px,50vw);font-size:12px}#${APP_ID} .scg-viewer-identity small{max-width:min(760px,56vw);margin-top:3px;color:#8995aa;font-size:9px}
    #${APP_ID} .scg-viewer-tools,#${APP_ID} .scg-viewer-zoom{display:flex;align-items:center;gap:5px}#${APP_ID} .scg-viewer-tools button{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:5px;height:36px;min-width:36px;padding:7px;border:1px solid #30394d;border-radius:9px;background:#171d29;color:#cdd3de;cursor:pointer}#${APP_ID} .scg-viewer-tools button:hover,#${APP_ID} .scg-viewer-tools button[aria-pressed="true"]{border-color:#5d5792;background:#292448;color:#fff}#${APP_ID} .scg-viewer-tools .scg-lightbox-close{position:static;inset:auto;width:36px;height:36px;margin-left:3px;background:#321923;border-color:#663247;border-radius:9px}#${APP_ID} .scg-viewer-zoom{padding-right:6px;margin-right:2px;border-right:1px solid #2c3446}#${APP_ID} .scg-viewer-zoom.unavailable{display:none}#${APP_ID} .scg-viewer-zoom [data-viewer-fit]{min-width:68px}#${APP_ID} .scg-viewer-zoom [data-viewer-fit] span{font-size:9px;font-weight:800}
    #${APP_ID} .scg-viewer-body{position:relative;display:grid;grid-template-columns:minmax(0,1fr) 320px;min-width:0;min-height:0;overflow:hidden;transition:grid-template-columns .2s ease}#${APP_ID} .scg-lightbox.details-hidden .scg-viewer-body{grid-template-columns:minmax(0,1fr) 0}#${APP_ID} .scg-lightbox-stage{position:relative;display:flex;align-items:center;justify-content:center;width:100%;height:100%;min-width:0;min-height:0;max-height:none;padding:18px;overflow:hidden;border-radius:0;background:radial-gradient(circle at 50% 44%,#151a24,#05070b 70%);touch-action:none;user-select:none}#${APP_ID} .scg-lightbox-stage:after{content:'';position:absolute;inset:0;pointer-events:none;box-shadow:inset 0 0 80px #0008}
    #${APP_ID} .scg-lightbox-stage .scg-viewer-image{position:relative;z-index:1;display:block;width:auto;height:auto;max-width:100%;max-height:100%;object-fit:contain;border:0;border-radius:4px;background:#05070a;box-shadow:0 15px 70px #000b;transform-origin:center;transition:transform .12s ease;will-change:transform;cursor:zoom-in}#${APP_ID} .scg-lightbox.viewer-zoomed .scg-viewer-image{cursor:grab;transition:none}#${APP_ID} .scg-lightbox.viewer-zoomed .scg-viewer-image.dragging{cursor:grabbing}#${APP_ID} .scg-lightbox-stage video,#${APP_ID} .scg-lightbox-stage iframe{position:relative;z-index:1;display:block;width:100%;height:100%;max-width:100%;max-height:100%;border:0;border-radius:8px;background:#000;box-shadow:0 18px 70px #000c;object-fit:contain}#${APP_ID} .scg-lightbox-stage iframe{aspect-ratio:auto}#${APP_ID} .scg-lightbox-stage.viewer-buffering:before{content:'';position:absolute;z-index:3;width:28px;height:28px;border:3px solid #ffffff35;border-top-color:#a99dff;border-radius:99px;animation:scg-viewer-spin .75s linear infinite;pointer-events:none}#${APP_ID} .scg-viewer-loading{display:flex;align-items:center;gap:10px;color:#a8b1c1;font-size:11px}#${APP_ID} .scg-viewer-loading i{width:18px;height:18px;border:2px solid #414b61;border-top-color:#9487ff;border-radius:99px;animation:scg-viewer-spin .75s linear infinite}@keyframes scg-viewer-spin{to{transform:rotate(360deg)}}#${APP_ID} .scg-viewer-error{max-width:460px;padding:22px;border:1px solid #543b47;border-radius:13px;background:#20131a;color:#e8bcc9;text-align:center;font-size:12px}
    #${APP_ID} .scg-viewer-details{min-width:0;overflow:auto;padding:18px;border-left:1px solid #293145;background:#0d1119ed;opacity:1;transition:opacity .15s ease,transform .2s ease;backdrop-filter:blur(16px)}#${APP_ID} .scg-lightbox.details-hidden .scg-viewer-details{overflow:hidden;opacity:0;pointer-events:none;transform:translateX(30px)}#${APP_ID} .scg-viewer-details-head{display:flex;align-items:center;gap:10px;padding-bottom:14px;border-bottom:1px solid #283044}#${APP_ID} .scg-viewer-details-head>span{display:grid;place-items:center;width:38px;height:38px;border-radius:11px;background:#29244a;color:#b9b0ff}#${APP_ID} .scg-viewer-details-head>div{min-width:0}#${APP_ID} .scg-viewer-details-head b,#${APP_ID} .scg-viewer-details-head small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#${APP_ID} .scg-viewer-details-head b{font-size:13px}#${APP_ID} .scg-viewer-details-head small{margin-top:3px;color:#8792a6;font-size:9px}#${APP_ID} .scg-viewer-caption{margin:14px 0;padding:12px;border:1px solid #2b3447;border-radius:10px;background:#141925;color:#c9d0dc;font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-word}#${APP_ID} .scg-viewer-details dl{margin:14px 0}#${APP_ID} .scg-viewer-details dl>div{display:grid;grid-template-columns:82px minmax(0,1fr);gap:8px;padding:8px 0;border-bottom:1px solid #202738}#${APP_ID} .scg-viewer-details dt{color:#737f94;font-size:9px;text-transform:uppercase!important;letter-spacing:.06em}#${APP_ID} .scg-viewer-details dd{min-width:0;margin:0;overflow:hidden;color:#d8dde6;font-size:10px;text-overflow:ellipsis}#${APP_ID} .scg-viewer-details-links{display:grid;grid-template-columns:1fr 1fr;gap:7px}#${APP_ID} .scg-viewer-details-links a{display:flex;align-items:center;justify-content:center;gap:6px;padding:8px;border:1px solid #354057;border-radius:9px;background:#181e2a;color:#cfc8ff;text-decoration:none;font-size:10px}#${APP_ID} .scg-viewer-details-links a:hover{background:#292448;border-color:#625b94}#${APP_ID} .scg-viewer-shortcuts{margin:16px 0 0;color:#69758a;font-size:8px;line-height:1.6}
    #${APP_ID} .scg-lightbox .scg-nav{position:absolute;z-index:8;top:50%;display:grid;place-items:center;width:42px;height:70px;padding:0;transform:translateY(-50%);border:1px solid #48546d;background:#111722d9;color:#fff;border-radius:11px;opacity:.72;backdrop-filter:blur(10px);cursor:pointer;transition:opacity .15s,background .15s}#${APP_ID} .scg-lightbox .scg-nav:hover{opacity:1;background:#2a254c}#${APP_ID} .scg-lightbox .scg-prev{left:12px}#${APP_ID} .scg-lightbox .scg-next{right:332px}#${APP_ID} .scg-lightbox.details-hidden .scg-next{right:12px}#${APP_ID} .scg-lightbox .scg-nav span{width:14px;height:14px;border-width:3px}#${APP_ID} .scg-lightbox .scg-prev span{margin-left:16px}#${APP_ID} .scg-lightbox .scg-next span{margin-right:16px}
    #${APP_ID} .scg-viewer-footer{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;min-width:0;min-height:78px;padding:8px 12px;border-top:1px solid #293145;background:#0b0f17ed;box-shadow:0 -8px 30px #0008;backdrop-filter:blur(18px)}#${APP_ID} .scg-viewer-strip{display:flex;align-items:center;gap:6px;min-width:0;overflow-x:auto;padding:2px;scrollbar-width:thin;scrollbar-color:#4a5369 transparent}#${APP_ID} .scg-viewer-thumb{position:relative;width:54px;height:54px;flex:none;overflow:hidden;padding:0;border:1px solid #30394d;border-radius:9px;background:#141925;color:#8994a7;cursor:pointer;opacity:.62}#${APP_ID} .scg-viewer-thumb:hover{opacity:.9}#${APP_ID} .scg-viewer-thumb.active{border-color:#9b8cff;box-shadow:0 0 0 2px #7868ed66;opacity:1}#${APP_ID} .scg-viewer-thumb img{display:block;width:100%;height:100%;object-fit:cover;background:#07090d}#${APP_ID} .scg-viewer-thumb>span{display:grid;place-items:center;width:100%;height:100%}#${APP_ID} .scg-viewer-thumb em{position:absolute;right:3px;bottom:3px;min-width:15px;padding:1px 3px;border-radius:4px;background:#05070bd9;color:#d7dce5;font-size:7px;font-style:normal;text-align:center}#${APP_ID} .scg-viewer-footer .scg-lightbox-actions{display:flex;align-items:center;gap:6px;flex:none}#${APP_ID} .scg-viewer-footer .scg-lightbox-actions button{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:36px;padding:7px 10px;border:1px solid #354057;border-radius:9px;background:#171d29;color:#dce1ea;cursor:pointer}#${APP_ID} .scg-viewer-footer .scg-lightbox-actions button:hover{background:#292448;border-color:#625b94}#${APP_ID} .scg-viewer-footer .scg-viewer-download{border-color:#6559a4;background:#29244c;color:#e5e0ff}
    #${APP_ID} .scg-lightbox:fullscreen .scg-viewer-shell{height:100vh}
    @media(max-width:980px){#${APP_ID} .scg-viewer-body{display:block}#${APP_ID} .scg-viewer-details{position:absolute;z-index:9;top:10px;right:10px;bottom:10px;width:min(320px,calc(100vw - 70px));border:1px solid #343e54;border-radius:13px;box-shadow:0 18px 55px #000c}#${APP_ID} .scg-lightbox.details-hidden .scg-viewer-details{transform:translateX(calc(100% + 22px))}#${APP_ID} .scg-lightbox .scg-next,#${APP_ID} .scg-lightbox.details-hidden .scg-next{right:10px}#${APP_ID} .scg-viewer-footer .scg-lightbox-actions button span{display:none}#${APP_ID} .scg-viewer-footer .scg-lightbox-actions button{width:36px;padding:7px}}
    @media(max-width:620px){#${APP_ID} .scg-viewer-topbar{min-height:54px;padding:7px 8px}#${APP_ID} .scg-viewer-identity{gap:8px}#${APP_ID} .scg-viewer-identity>b{font-size:14px}#${APP_ID} .scg-viewer-identity strong{max-width:32vw;font-size:10px}#${APP_ID} .scg-viewer-identity small{display:none}#${APP_ID} .scg-viewer-tools{gap:3px}#${APP_ID} .scg-viewer-tools button{width:32px;height:32px;min-width:32px;padding:6px}#${APP_ID} .scg-viewer-zoom{gap:2px;padding-right:3px}#${APP_ID} .scg-viewer-zoom [data-viewer-fit]{min-width:32px}#${APP_ID} .scg-viewer-zoom [data-viewer-fit] span{display:none}#${APP_ID} .scg-lightbox-stage{padding:8px}#${APP_ID} .scg-lightbox .scg-nav{width:32px;height:56px;opacity:.58}#${APP_ID} .scg-lightbox .scg-prev{left:4px}#${APP_ID} .scg-lightbox .scg-next,#${APP_ID} .scg-lightbox.details-hidden .scg-next{right:4px}#${APP_ID} .scg-lightbox .scg-prev span{margin-left:11px}#${APP_ID} .scg-lightbox .scg-next span{margin-right:11px}#${APP_ID} .scg-viewer-details{top:auto;right:7px;bottom:7px;left:7px;width:auto;max-height:55%;transform:none}#${APP_ID} .scg-lightbox.details-hidden .scg-viewer-details{transform:translateY(calc(100% + 18px))}#${APP_ID} .scg-viewer-footer{grid-template-columns:minmax(0,1fr) auto;gap:6px;min-height:66px;padding:6px}#${APP_ID} .scg-viewer-thumb{width:46px;height:46px;border-radius:7px}#${APP_ID} .scg-viewer-footer .scg-lightbox-actions{gap:3px}#${APP_ID} .scg-viewer-footer .scg-lightbox-actions button{width:32px;height:32px;min-width:32px;padding:6px}#${APP_ID} .scg-viewer-footer .scg-lightbox-actions [data-copy-current]{display:none}#${APP_ID} .scg-viewer-tools [data-tooltip]:hover:after{display:none}}
    .scg-job-duplicate .scg-job-track i{background:linear-gradient(90deg,#d59b45,#9d72dc)}.scg-job-duplicate{opacity:.82}

    /* v0.9 true-dark shell and hardened viewer controls */
    #scg-launch{right:auto;left:20px;bottom:20px;display:inline-flex;align-items:center;justify-content:center;gap:9px;min-height:54px;padding:0 18px;border:1px solid #303741;border-radius:15px;background:#0b0d10;color:#f3f5f7;box-shadow:0 14px 38px #000a,0 0 0 1px #ffffff08;font:750 14px/1 system-ui;letter-spacing:.01em;transition:transform .16s ease,border-color .16s ease,background .16s ease,box-shadow .16s ease}#scg-launch:hover{transform:translateY(-2px);border-color:#4f8dcc;background:#11161c;box-shadow:0 18px 46px #000c,0 0 0 3px #4f8dcc20}#scg-launch .scg-icon{width:21px;height:21px;color:#72b7ff}#scg-launch [data-launch-count]{display:inline-grid;place-items:center;min-width:23px;height:23px;padding:0 6px;border-radius:99px;background:#1d65a6;color:#fff;font-size:10px;font-weight:800}#scg-launch [data-launch-count][hidden]{display:none}
    #${APP_ID}:not([data-theme="light"]){--scg-bg:#050607;--scg-surface:#0b0d10;--scg-surface-2:#101318;--scg-surface-3:#181d23;--scg-line:#293039;--scg-text:#f1f3f5;--scg-muted:#969fa9;--scg-accent:#66aaff;--scg-accent-soft:#10243c;--scg-success:#4fd1a1;--scg-danger:#ef7895;--scg-shadow:#000b;background:var(--scg-bg)}
    #${APP_ID} .scg-icon,#${APP_ID} .scg-icon *{fill:none!important;stroke:currentColor!important;stroke-linecap:round!important;stroke-linejoin:round!important}
    #${APP_ID}:not([data-theme="light"]) .scg-brand-mark{background:#155995;box-shadow:0 8px 22px #0008;color:#fff}
    #${APP_ID}:not([data-theme="light"]) .scg-controls button.active,#${APP_ID}:not([data-theme="light"]) .scg-bulkbar .scg-primary,#${APP_ID}:not([data-theme="light"]) .scg-activitybar .scg-primary{border-color:#3f82c2;background:#175d9c;box-shadow:none;color:#fff}
    #${APP_ID}:not([data-theme="light"]) .scg-selection-toggle{border-color:#34414f!important;background:#151a20!important;color:var(--scg-text)!important}
    #${APP_ID}:not([data-theme="light"]) .scg-card.selected{border-color:var(--scg-accent);box-shadow:0 0 0 2px #66aaff32,0 14px 34px #0007}
    #${APP_ID}:not([data-theme="light"]) .scg-select input:checked+span{border-color:#72b7ff;background:#1762a3}
    #${APP_ID}:not([data-theme="light"]) .scg-actions .scg-download-action{border-color:#315678;background:#10263a;color:#b9ddff}
    #${APP_ID}:not([data-theme="light"]) .scg-embed-placeholder{background:radial-gradient(circle at 50% 0,#18222d,#050607 70%)}#${APP_ID}:not([data-theme="light"]) .scg-embed-placeholder button{border-color:#36516b;background:#101922;color:var(--scg-text)}#${APP_ID}:not([data-theme="light"]) .scg-embed-placeholder button:hover{background:#172431}
    #${APP_ID}:not([data-theme="light"]) .scg-progress-fill,#${APP_ID}:not([data-theme="light"]) .scg-job-track i{background:linear-gradient(90deg,#358be0,#45b8c8)}
    #${APP_ID} .scg-viewer-topbar{position:relative;z-index:20;overflow:visible}#${APP_ID} .scg-viewer-tools{position:relative;z-index:21}#${APP_ID} .scg-viewer-body{z-index:1}
    #${APP_ID} .scg-viewer-tools [data-tooltip]:hover:after{top:calc(100% + 7px);bottom:auto;display:block;z-index:240}
    #${APP_ID} .scg-lightbox-stage .scg-viewer-image{transform:var(--scg-viewer-transform,translate3d(0,0,0) scale(1))!important}
    #${APP_ID}:not([data-theme="light"]) .scg-lightbox,#${APP_ID}:not([data-theme="light"]) .scg-viewer-shell{background:#030405;color:var(--scg-text)}
    #${APP_ID}:not([data-theme="light"]) .scg-viewer-topbar,#${APP_ID}:not([data-theme="light"]) .scg-viewer-footer,#${APP_ID}:not([data-theme="light"]) .scg-viewer-details{border-color:var(--scg-line);background:#090b0eeF}
    #${APP_ID}:not([data-theme="light"]) .scg-lightbox-stage{background:radial-gradient(circle at 50% 44%,#111418,#030405 70%)}
    #${APP_ID}:not([data-theme="light"]) .scg-viewer-tools button{border-color:var(--scg-line);background:#11151a;color:#cdd3da}#${APP_ID}:not([data-theme="light"]) .scg-viewer-tools button:hover,#${APP_ID}:not([data-theme="light"]) .scg-viewer-tools button[aria-pressed="true"]{border-color:#3d6588;background:#132338;color:#fff}
    #${APP_ID}:not([data-theme="light"]) .scg-viewer-tools .scg-viewer-download{border-color:#356b9d;background:#12385b;color:#d7ebff}
    #${APP_ID}:not([data-theme="light"]) .scg-viewer-details-head>span{background:var(--scg-accent-soft);color:var(--scg-accent)}#${APP_ID}:not([data-theme="light"]) .scg-viewer-caption{border-color:var(--scg-line);background:var(--scg-surface-2);color:#cdd2d8}#${APP_ID}:not([data-theme="light"]) .scg-viewer-details-links a{border-color:var(--scg-line);background:var(--scg-surface-2);color:#a9d3ff}#${APP_ID}:not([data-theme="light"]) .scg-viewer-details-links a:hover{border-color:#3d6588;background:#132338}
    #${APP_ID}:not([data-theme="light"]) .scg-lightbox .scg-nav{border-color:#35404b;background:#0d1116db}#${APP_ID}:not([data-theme="light"]) .scg-lightbox .scg-nav:hover{background:#16212c}
    #${APP_ID}:not([data-theme="light"]) .scg-viewer-thumb.active{border-color:var(--scg-accent);box-shadow:0 0 0 2px #66aaff4d}

    /* v0.9.1 single-blue icon system and live media dimensions */
    #${APP_ID}[data-theme="light"]{--scg-accent:#276fd1;--scg-accent-soft:#e7f1ff;--scg-line:#d6e0ed;--scg-shadow:#16365b1f}
    #scg-launch .scg-icon{box-sizing:content-box!important;width:19px;height:19px;padding:6px;border-radius:9px;background:linear-gradient(155deg,#3b96f4,#155da8);box-shadow:0 6px 15px #0b4d8c55,inset 0 1px 0 #ffffff48;color:#fff}
    #${APP_ID} .scg-brand-mark{background:linear-gradient(155deg,#3b96f4,#155da8);box-shadow:0 8px 22px #0b4d8c55;color:#fff}#${APP_ID} .scg-controls button.active,#${APP_ID} .scg-bulkbar .scg-primary,#${APP_ID} .scg-activitybar .scg-primary{border-color:color-mix(in srgb,var(--scg-accent) 70%,var(--scg-line));background:var(--scg-accent);color:#fff}#${APP_ID} .scg-progress-fill,#${APP_ID} .scg-job-track i{background:linear-gradient(90deg,#2f83d7,#63adf4)}#${APP_ID} .scg-job-duplicate .scg-job-track i{background:linear-gradient(90deg,#b9822f,#d9a349)}
    #${APP_ID} .scg-header-actions button>.scg-icon,#${APP_ID} .scg-controls button>.scg-icon,#${APP_ID} .scg-actions button>.scg-icon,#${APP_ID} .scg-bulkbar button>.scg-icon,#${APP_ID} .scg-settings-actions button>.scg-icon,#${APP_ID} .scg-lightbox-actions button>.scg-icon,#${APP_ID} .scg-layout-switcher button>.scg-icon,#${APP_ID} .scg-viewer-tools button>.scg-icon{color:var(--scg-accent)}
    #${APP_ID} .scg-controls button.active>.scg-icon,#${APP_ID} .scg-primary>.scg-icon,#${APP_ID} .scg-viewer-tools .scg-viewer-download>.scg-icon,#${APP_ID} .scg-viewer-tools .scg-lightbox-close>.scg-icon{color:#fff}
    #${APP_ID} .scg-settings-head .scg-icon,#${APP_ID} .scg-settings-card h3 .scg-icon,#${APP_ID} .scg-settings-foot b{color:var(--scg-accent)}#${APP_ID} .scg-settings-check input{accent-color:var(--scg-accent)}#${APP_ID} .scg-permission-note{border-color:var(--scg-accent);background:var(--scg-accent-soft)}
    #${APP_ID} .scg-settings-version{border-color:color-mix(in srgb,var(--scg-accent) 42%,var(--scg-line));background:var(--scg-accent-soft);color:var(--scg-accent)}
    #${APP_ID} .scg-actions button:hover,#${APP_ID} .scg-viewer-tools button:hover,#${APP_ID} .scg-viewer-tools button[aria-pressed="true"],#${APP_ID} .scg-viewer-footer .scg-lightbox-actions button:hover{border-color:color-mix(in srgb,var(--scg-accent) 55%,var(--scg-line));background:var(--scg-accent-soft);color:var(--scg-text)}
    #${APP_ID} .scg-actions .scg-download-action,#${APP_ID}[data-theme="light"] .scg-actions .scg-download-action{border-color:color-mix(in srgb,var(--scg-accent) 50%,var(--scg-line));background:var(--scg-accent-soft);color:var(--scg-accent)}
    #${APP_ID} .scg-viewer-details-head>span{background:var(--scg-accent-soft);color:var(--scg-accent)}#${APP_ID} .scg-viewer-details-links a{color:var(--scg-accent)}#${APP_ID} .scg-viewer-details-links a:hover{border-color:color-mix(in srgb,var(--scg-accent) 55%,var(--scg-line));background:var(--scg-accent-soft)}
    #${APP_ID} .scg-lightbox .scg-nav:hover{background:var(--scg-accent-soft)}#${APP_ID} .scg-viewer-thumb.active{border-color:var(--scg-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--scg-accent) 38%,transparent)}
    #${APP_ID} .scg-viewer-loading i,#${APP_ID} .scg-lightbox-stage.viewer-buffering:before{border-top-color:var(--scg-accent)}
    #${APP_ID} .scg-viewer-titleline{display:flex;align-items:center;gap:8px;min-width:0}#${APP_ID} .scg-viewer-titleline strong{min-width:0;max-width:none;flex:1}#${APP_ID} .scg-viewer-resolution{display:inline-flex;align-items:center;flex:none;padding:3px 7px;border:1px solid color-mix(in srgb,var(--scg-accent) 40%,var(--scg-line));border-radius:7px;background:var(--scg-accent-soft);color:var(--scg-accent);font-size:9px;font-weight:800;font-variant-numeric:tabular-nums;white-space:nowrap}#${APP_ID} .scg-viewer-details [data-viewer-resolution]{color:var(--scg-accent);font-weight:800;font-variant-numeric:tabular-nums}
    #${APP_ID}[data-theme="light"] .scg-viewer-topbar,#${APP_ID}[data-theme="light"] .scg-viewer-footer,#${APP_ID}[data-theme="light"] .scg-viewer-details{border-color:var(--scg-line);background:#f8fbffef}#${APP_ID}[data-theme="light"] .scg-lightbox-stage{background:radial-gradient(circle at 50% 44%,#edf4fc,#dce8f5 72%)}#${APP_ID}[data-theme="light"] .scg-viewer-tools button{border-color:var(--scg-line);background:#f3f7fc;color:#506176}#${APP_ID}[data-theme="light"] .scg-viewer-tools .scg-viewer-download{border-color:#8ab8e8;background:#dceeff;color:#145896}

    /* v0.9.2 installed blue icon language and larger launcher */
    #${APP_ID} .scg-icon-well{position:relative;display:inline-grid;place-items:center;width:24px;height:24px;flex:none;border:1px solid color-mix(in srgb,var(--scg-accent) 22%,var(--scg-line));border-radius:8px;background:var(--scg-accent-soft);box-shadow:inset 0 1px 0 color-mix(in srgb,#fff 10%,transparent);color:var(--scg-accent);font-style:normal}#${APP_ID} .scg-icon-well>.scg-icon{width:14px;height:14px;color:currentColor}#${APP_ID} .scg-icon-well-primary{border-color:#438dd3;background:linear-gradient(155deg,#3b96f4,#155da8);box-shadow:0 4px 10px #0b4d8c3d,inset 0 1px 0 #ffffff3d;color:#fff}#${APP_ID} .scg-icon-well-danger{border-color:color-mix(in srgb,var(--scg-danger) 48%,var(--scg-line));background:color-mix(in srgb,var(--scg-danger) 16%,var(--scg-surface));color:var(--scg-danger)}
    #${APP_ID} .scg-primary .scg-icon-well-primary,#${APP_ID} .scg-viewer-download .scg-icon-well-primary{border-color:#ffffff26;background:#ffffff17;box-shadow:inset 0 1px 0 #ffffff24;color:#fff}#${APP_ID} .danger .scg-icon-well{border-color:#ffffff1a;background:#ffffff12;color:inherit}
    #${APP_ID} .scg-header-actions .scg-icon-well,#${APP_ID} .scg-viewer-tools .scg-icon-well,#${APP_ID} .scg-settings-close .scg-icon-well{width:22px;height:22px;border-radius:7px}#${APP_ID} .scg-viewer-tools .scg-icon-well>.scg-icon,#${APP_ID} .scg-header-actions .scg-icon-well>.scg-icon{width:13px;height:13px}
    #${APP_ID} .scg-search:before,#${APP_ID} .scg-search:after{content:none}#${APP_ID} .scg-search>.scg-icon-well{position:absolute;z-index:2;top:50%;left:7px;width:24px;height:24px;transform:translateY(-50%)}#${APP_ID} .scg-search input{padding-left:39px!important}
    #${APP_ID} .scg-filter-panel .scg-filters button{display:inline-flex;align-items:center;gap:6px}#${APP_ID} .scg-filter-panel .scg-filters button .scg-icon{width:14px;height:14px;color:var(--scg-accent)}#${APP_ID} .scg-filter-panel .scg-filters button b{font-size:inherit}#${APP_ID} .scg-filter-panel .scg-filters button>span{min-width:18px;padding:1px 5px;border-radius:99px;background:var(--scg-surface-3);color:var(--scg-muted);font-size:9px;text-align:center}#${APP_ID} .scg-filter-panel .scg-filters button.active>span{background:color-mix(in srgb,var(--scg-accent) 18%,var(--scg-surface));color:var(--scg-accent)}
    #${APP_ID} .scg-refinebar button,#${APP_ID} .scg-view-pagination button,#${APP_ID} .scg-top,#${APP_ID} .scg-download-popover header button{display:inline-flex;align-items:center;justify-content:center;gap:6px}#${APP_ID} .scg-layout-switcher .scg-icon-well{width:22px;height:22px;border-radius:7px}#${APP_ID} .scg-view-pagination button span{font-size:9px}#${APP_ID} .scg-meta a,#${APP_ID} .scg-reply-group>header a{display:inline-flex;align-items:center;gap:4px}#${APP_ID} .scg-meta a .scg-icon,#${APP_ID} .scg-reply-group>header a .scg-icon{width:12px;height:12px}
    #${APP_ID} .scg-expand{display:flex;align-items:center;justify-content:center;gap:6px}#${APP_ID} .scg-expand .scg-icon-well{width:21px;height:21px}#${APP_ID} .scg-expand.expanded .scg-icon-well{transform:rotate(180deg)}#${APP_ID} .scg-embed-placeholder button .scg-icon-well{width:34px;height:34px;border-radius:11px}#${APP_ID} .scg-embed-placeholder button .scg-icon{width:17px;height:17px}
    #${APP_ID} .scg-lightbox .scg-nav .scg-icon{width:23px;height:23px;stroke-width:2.4}#${APP_ID} .scg-viewer-zoom [data-viewer-fit]{min-width:78px}#${APP_ID} .scg-settings-actions button,#${APP_ID} .scg-confirm-dialog button{display:inline-flex;align-items:center;justify-content:center;gap:6px}
    /* v0.9.3 launcher C: larger two-line media summary */
    #scg-launch{min-height:76px;padding:0 22px;gap:13px;border-radius:20px;font-size:15px}#scg-launch .scg-launch-icon{position:relative;isolation:isolate;display:inline-grid;place-items:center;width:48px;height:48px;flex:none;border:1px solid #65b0f5;border-radius:15px;background:linear-gradient(155deg,#3b96f4,#155da8);box-shadow:0 9px 21px #0b4d8c59,inset 0 1px 0 #ffffff4a;color:#fff;font-style:normal}#scg-launch .scg-launch-icon:before{content:'';position:absolute;z-index:-1;top:-5px;right:8px;left:8px;height:9px;border-radius:7px 7px 0 0;background:#155da8}#scg-launch .scg-launch-icon .scg-icon{box-sizing:border-box!important;width:23px;height:23px;padding:0;border-radius:0;background:none;box-shadow:none;color:#fff}#scg-launch .scg-launch-copy{display:grid;gap:4px;min-width:116px;text-align:left}#scg-launch .scg-launch-copy strong{font-size:15px;font-weight:800;line-height:1.05}#scg-launch .scg-launch-copy small{color:#93a7ba;font-size:10px;font-weight:650;line-height:1.05;white-space:nowrap}
    @media(max-width:620px){#${APP_ID} .scg-viewer-titleline{gap:4px}#${APP_ID} .scg-viewer-titleline strong{max-width:20vw}#${APP_ID} .scg-viewer-resolution{padding:2px 4px;font-size:8px}.scg-archive-checks{grid-template-columns:1fr}#${APP_ID} .scg-view-pagination button span{display:none}#scg-launch{min-height:66px;padding:0 17px;gap:11px}#scg-launch .scg-launch-icon{width:42px;height:42px;border-radius:13px}#scg-launch .scg-launch-icon .scg-icon{width:21px;height:21px}#scg-launch .scg-launch-copy{min-width:108px}}

    /* Hybrid fork: Apple-inspired media canvas with Material-style task controls */
    #${APP_ID}[data-ui="hybrid"]{--scg-bg:#000;--scg-surface:#0b0c0f;--scg-surface-2:#121419;--scg-surface-3:#1a1d23;--scg-line:#ffffff17;--scg-text:#f7f8fa;--scg-muted:#9298a3;--scg-accent:#0a84ff;--scg-accent-soft:#0a84ff20;--scg-success:#30d158;--scg-danger:#ff647c;--scg-shadow:#000d;background:radial-gradient(circle at 50% -20%,#17202c 0,#07090d 36%,#000 78%);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",sans-serif}
    #${APP_ID}[data-ui="hybrid"],#${APP_ID}[data-ui="hybrid"] *{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",sans-serif}
    #${APP_ID}[data-ui="hybrid"] .scg-header{display:grid;grid-template-columns:auto minmax(180px,1fr) auto;gap:14px;min-height:72px;padding:10px 14px;border:0;border-bottom:1px solid #ffffff12;background:#11141abf;box-shadow:0 10px 36px #0007;backdrop-filter:blur(28px) saturate(145%)}
    #${APP_ID}[data-ui="hybrid"] .scg-brand{min-width:0;margin:0}#${APP_ID}[data-ui="hybrid"] .scg-brand-mark{width:44px;height:44px;border:1px solid #68b5ff70;border-radius:14px;background:linear-gradient(155deg,#2898ff,#075fc1);box-shadow:0 8px 22px #0075e455,inset 0 1px 0 #ffffff5c}#${APP_ID}[data-ui="hybrid"] .scg-brand-mark .scg-icon{width:22px;height:22px;color:#fff}
    #${APP_ID}[data-ui="hybrid"] .scg-thread-context h1{font-size:15px;letter-spacing:-.015em}#${APP_ID}[data-ui="hybrid"] .scg-thread-context div{color:#8e96a3}
    #${APP_ID}[data-ui="hybrid"] .scg-header-actions{padding:4px;border:1px solid #ffffff14;border-radius:14px;background:#ffffff0a;box-shadow:inset 0 1px 0 #ffffff0a}#${APP_ID}[data-ui="hybrid"] .scg-header-actions button{min-height:38px;border:0;border-radius:10px;background:transparent;color:#c6cad1}#${APP_ID}[data-ui="hybrid"] .scg-header-actions button:hover{background:#ffffff12;color:#fff}#${APP_ID}[data-ui="hybrid"] .scg-header-actions .scg-close{background:#ff453a18!important;border:0!important;color:#ff7b72}
    #${APP_ID}[data-ui="hybrid"] .scg-controls{gap:10px;padding:12px 16px 9px;border:0;background:transparent}#${APP_ID}[data-ui="hybrid"] .scg-search{max-width:620px}#${APP_ID}[data-ui="hybrid"] .scg-search input{height:44px;border:1px solid #ffffff16;border-radius:14px;background:#15181edb;color:#fff;box-shadow:inset 0 1px 0 #ffffff0a,0 8px 24px #0004}#${APP_ID}[data-ui="hybrid"] .scg-search input:focus{border-color:#0a84ff99;box-shadow:0 0 0 3px #0a84ff28,0 8px 24px #0004}
    #${APP_ID}[data-ui="hybrid"] .scg-scan-actions{padding:4px;border:1px solid #ffffff14;border-radius:14px;background:#15181edb}#${APP_ID}[data-ui="hybrid"] .scg-scan-actions button,#${APP_ID}[data-ui="hybrid"] .scg-scan-actions select{min-height:36px;border:0;border-radius:10px;background:transparent}#${APP_ID}[data-ui="hybrid"] .scg-scan-actions button:hover{background:#ffffff10}#${APP_ID}[data-ui="hybrid"] .scg-scan-actions [data-action="thread"]{background:#0a84ff;color:#fff;box-shadow:0 5px 16px #0a84ff42}
    #${APP_ID}[data-ui="hybrid"] .scg-filter-panel{border:0;background:transparent}#${APP_ID}[data-ui="hybrid"] .scg-filter-panel .scg-filters{display:flex;width:max-content;max-width:calc(100% - 32px);margin:2px 16px 8px;padding:4px;border:1px solid #ffffff14;border-radius:14px;background:#15181edb;box-shadow:inset 0 1px 0 #ffffff0a}#${APP_ID}[data-ui="hybrid"] .scg-filter-panel .scg-filters button{min-height:36px;padding:7px 14px;border:0;border-radius:10px;background:transparent;color:#979eaa}#${APP_ID}[data-ui="hybrid"] .scg-filter-panel .scg-filters button:hover{background:#ffffff0b;color:#fff}#${APP_ID}[data-ui="hybrid"] .scg-filter-panel .scg-filters button.active{background:#f5f7fb;color:#0b0c0f;box-shadow:0 3px 12px #0007}#${APP_ID}[data-ui="hybrid"] .scg-filter-panel .scg-filters button.active .scg-icon{color:#0a84ff}#${APP_ID}[data-ui="hybrid"] .scg-filter-panel .scg-filters button.active>span{background:#0a84ff18;color:#0675df}
    #${APP_ID}[data-ui="hybrid"] .scg-refinebar,#${APP_ID}[data-ui="hybrid"] .scg-viewbar{margin:0 16px 8px;padding:8px 10px;border:1px solid #ffffff12;border-radius:14px;background:#0f1116b8;backdrop-filter:blur(20px)}#${APP_ID}[data-ui="hybrid"] .scg-refinebar select,#${APP_ID}[data-ui="hybrid"] .scg-viewbar select,#${APP_ID}[data-ui="hybrid"] .scg-refinebar button,#${APP_ID}[data-ui="hybrid"] .scg-viewbar button{border:0;border-radius:9px;background:#ffffff0b;color:#d8dbe1}#${APP_ID}[data-ui="hybrid"] .scg-refinebar button:hover,#${APP_ID}[data-ui="hybrid"] .scg-viewbar button:hover:not(:disabled){background:#ffffff16}#${APP_ID}[data-ui="hybrid"] .scg-layout-switcher{border:0;border-radius:11px;background:#ffffff0b}#${APP_ID}[data-ui="hybrid"] .scg-layout-switcher button.active{background:#ffffff18;color:#fff;box-shadow:none}
    #${APP_ID}[data-ui="hybrid"] .scg-scroll{padding:12px 18px 92px;background:transparent}#${APP_ID}[data-ui="hybrid"] .scg-card{overflow:hidden;border:1px solid #ffffff0d;border-radius:18px;background:#111318;box-shadow:0 10px 34px #0008;transform:translateZ(0);transition:transform .22s cubic-bezier(.2,.8,.2,1),box-shadow .22s,border-color .22s}#${APP_ID}[data-ui="hybrid"] .scg-card:hover{z-index:2;border-color:#ffffff22;box-shadow:0 18px 48px #000b;transform:translateY(-3px) scale(1.006)}#${APP_ID}[data-ui="hybrid"] .scg-card.selected{border-color:#0a84ff;box-shadow:0 0 0 3px #0a84ff3d,0 18px 48px #000b}
    #${APP_ID}[data-ui="hybrid"] .scg-preview,#${APP_ID}[data-ui="hybrid"] .scg-card img,#${APP_ID}[data-ui="hybrid"] .scg-card video{background:#050506}#${APP_ID}[data-ui="hybrid"] .scg-actions{padding:7px;border-color:#ffffff0e;background:#0d0f13}#${APP_ID}[data-ui="hybrid"] .scg-actions button{border:0;border-radius:10px;background:#ffffff0a;color:#d8dbe1}#${APP_ID}[data-ui="hybrid"] .scg-actions button:hover{background:#ffffff17}#${APP_ID}[data-ui="hybrid"] .scg-actions .scg-download-action{background:#0a84ff1f;color:#74baff}#${APP_ID}[data-ui="hybrid"] .scg-meta{border-top:1px solid #ffffff09;color:#858c98}#${APP_ID}[data-ui="hybrid"] .scg-meta a{color:#6ab5ff}
    #${APP_ID}[data-ui="hybrid"] .scg-reply-group{border-color:#ffffff12;border-radius:20px;background:#0b0d11;box-shadow:0 18px 50px #0008}#${APP_ID}[data-ui="hybrid"] .scg-reply-group>header{border-color:#ffffff10;background:#15181ec7;backdrop-filter:blur(18px)}
    #${APP_ID}[data-ui="hybrid"] .scg-activitybar{margin:0 12px 12px;padding:8px 10px;border:1px solid #ffffff18;border-radius:18px;background:#171a20d9;box-shadow:0 12px 42px #000a;backdrop-filter:blur(28px) saturate(145%)}#${APP_ID}[data-ui="hybrid"] .scg-activity-state i{background:#30d158;box-shadow:0 0 0 4px #30d15818}#${APP_ID}[data-ui="hybrid"] .scg-bulkbar button{border:0;border-radius:10px;background:#ffffff0b}#${APP_ID}[data-ui="hybrid"] .scg-bulkbar .scg-primary{background:#0a84ff;color:#fff;box-shadow:0 5px 16px #0a84ff3d}#${APP_ID}[data-ui="hybrid"] .scg-progress-summary{border:0!important;border-radius:11px;background:#08090cc7!important}#${APP_ID}[data-ui="hybrid"] .scg-progress-fill{background:linear-gradient(90deg,#0a84ff,#64d2ff)}
    #${APP_ID}[data-ui="hybrid"] .scg-download-popover{border:1px solid #ffffff1c;border-radius:18px;background:#191c22ed;box-shadow:0 24px 70px #000d;backdrop-filter:blur(30px) saturate(140%)}#${APP_ID}[data-ui="hybrid"] .scg-download-popover header{border-color:#ffffff12;background:#ffffff08}#${APP_ID}[data-ui="hybrid"] .scg-job{border-color:#ffffff10;border-radius:12px;background:#ffffff08}
    #${APP_ID}[data-ui="hybrid"] .scg-settings-panel{background:#0009;backdrop-filter:blur(22px)}#${APP_ID}[data-ui="hybrid"] .scg-settings-dialog{border:1px solid #ffffff1c;border-radius:24px;background:#111318ed;box-shadow:0 30px 100px #000e;backdrop-filter:blur(34px) saturate(140%)}#${APP_ID}[data-ui="hybrid"] .scg-settings-head{border-color:#ffffff12;background:#ffffff06}#${APP_ID}[data-ui="hybrid"] .scg-settings-card{border-color:#ffffff12;border-radius:18px;background:#ffffff07;box-shadow:inset 0 1px 0 #ffffff08}
    #${APP_ID}[data-ui="hybrid"] .scg-lightbox,#${APP_ID}[data-ui="hybrid"] .scg-viewer-shell{background:#000}#${APP_ID}[data-ui="hybrid"] .scg-viewer-shell{grid-template-rows:78px minmax(0,1fr) 90px}#${APP_ID}[data-ui="hybrid"] .scg-viewer-topbar{z-index:20;align-self:center;width:calc(100% - 24px);min-height:58px;margin:10px 12px;padding:8px 10px 8px 14px;border:1px solid #ffffff1c;border-radius:18px;background:#181b21c7;box-shadow:0 12px 42px #000a;backdrop-filter:blur(30px) saturate(150%);transition:opacity .28s,transform .28s}
    #${APP_ID}[data-ui="hybrid"] .scg-viewer-tools{padding:3px;border:1px solid #ffffff12;border-radius:13px;background:#0003}#${APP_ID}[data-ui="hybrid"] .scg-viewer-tools button{height:38px;min-width:38px;border:0;border-radius:10px;background:transparent;color:#c8ccd3}#${APP_ID}[data-ui="hybrid"] .scg-viewer-tools button:hover,#${APP_ID}[data-ui="hybrid"] .scg-viewer-tools button[aria-pressed="true"]{background:#ffffff14;color:#fff}#${APP_ID}[data-ui="hybrid"] .scg-viewer-tools .scg-viewer-download{background:#0a84ff;color:#fff;box-shadow:0 5px 16px #0a84ff42}#${APP_ID}[data-ui="hybrid"] .scg-viewer-tools .scg-lightbox-close{background:#ff453a17!important;color:#ff817a}
    #${APP_ID}[data-ui="hybrid"] .scg-viewer-body{grid-template-columns:minmax(0,1fr) 330px;background:#000}#${APP_ID}[data-ui="hybrid"] .scg-lightbox.details-hidden .scg-viewer-body{grid-template-columns:minmax(0,1fr) 0}#${APP_ID}[data-ui="hybrid"] .scg-lightbox-stage{padding:12px;background:radial-gradient(circle at 50% 45%,#111317,#000 72%)}#${APP_ID}[data-ui="hybrid"] .scg-lightbox-stage:after{box-shadow:inset 0 0 90px #0007}#${APP_ID}[data-ui="hybrid"] .scg-lightbox-stage .scg-viewer-image{border-radius:8px;box-shadow:0 22px 90px #000}
    #${APP_ID}[data-ui="hybrid"] .scg-viewer-details{margin:8px 12px 8px 0;padding:18px;border:1px solid #ffffff18;border-radius:18px;background:#181b21d9;box-shadow:0 18px 52px #000b;backdrop-filter:blur(28px) saturate(135%)}#${APP_ID}[data-ui="hybrid"] .scg-viewer-caption{border:0;border-radius:12px;background:#ffffff0a}#${APP_ID}[data-ui="hybrid"] .scg-viewer-details-links a{border:0;border-radius:11px;background:#ffffff0b;color:#67b4ff}
    #${APP_ID}[data-ui="hybrid"] .scg-lightbox .scg-nav{width:44px;height:44px;border:1px solid #ffffff20;border-radius:50%;background:#1c1f25b8;box-shadow:0 8px 26px #0009;opacity:.72;backdrop-filter:blur(22px);transition:opacity .2s,transform .2s,background .2s}#${APP_ID}[data-ui="hybrid"] .scg-lightbox .scg-nav:hover{background:#2a2e36;opacity:1;transform:translateY(-50%) scale(1.06)}#${APP_ID}[data-ui="hybrid"] .scg-lightbox .scg-prev{left:18px}#${APP_ID}[data-ui="hybrid"] .scg-lightbox .scg-next{right:348px}#${APP_ID}[data-ui="hybrid"] .scg-lightbox.details-hidden .scg-next{right:18px}
    #${APP_ID}[data-ui="hybrid"] .scg-viewer-footer{align-self:center;width:calc(100% - 24px);min-height:72px;margin:0 12px 10px;padding:7px 9px;border:1px solid #ffffff1c;border-radius:18px;background:#181b21c7;box-shadow:0 -8px 38px #0008;backdrop-filter:blur(30px) saturate(150%);transition:opacity .28s,transform .28s}#${APP_ID}[data-ui="hybrid"] .scg-viewer-thumb{width:58px;height:58px;border:0;border-radius:11px;background:#0b0c0f;opacity:.52}#${APP_ID}[data-ui="hybrid"] .scg-viewer-thumb.active{box-shadow:0 0 0 3px #0a84ff;opacity:1}#${APP_ID}[data-ui="hybrid"] .scg-viewer-footer .scg-lightbox-actions button{border:0;border-radius:11px;background:#ffffff0c}
    #${APP_ID}[data-ui="hybrid"] .scg-lightbox.viewer-idle.details-hidden .scg-viewer-topbar{opacity:0;pointer-events:none;transform:translateY(-12px)}#${APP_ID}[data-ui="hybrid"] .scg-lightbox.viewer-idle.details-hidden .scg-viewer-footer{opacity:0;pointer-events:none;transform:translateY(12px)}#${APP_ID}[data-ui="hybrid"] .scg-lightbox.viewer-idle.details-hidden .scg-nav{opacity:0;pointer-events:none}#${APP_ID}[data-ui="hybrid"] .scg-lightbox.viewer-idle.details-hidden .scg-lightbox-stage{cursor:none}
    #scg-launch{border:1px solid #ffffff1b;background:#15181ed9;box-shadow:0 18px 48px #000c,inset 0 1px 0 #ffffff10;backdrop-filter:blur(24px) saturate(145%)}#scg-launch:hover{border-color:#0a84ff8c;background:#1a1e25;box-shadow:0 22px 58px #000e,0 0 0 4px #0a84ff1c}#scg-launch .scg-launch-copy small{color:#9ca3af}

    /* Hybrid 2: larger icon scale */
    #${APP_ID}[data-ui="hybrid"] .scg-icon-well{width:29px;height:29px;border-radius:10px}#${APP_ID}[data-ui="hybrid"] .scg-icon-well>.scg-icon{width:17px;height:17px;stroke-width:2.15}#${APP_ID}[data-ui="hybrid"] .scg-header-actions .scg-icon-well,#${APP_ID}[data-ui="hybrid"] .scg-viewer-tools .scg-icon-well,#${APP_ID}[data-ui="hybrid"] .scg-settings-close .scg-icon-well{width:27px;height:27px;border-radius:9px}#${APP_ID}[data-ui="hybrid"] .scg-header-actions .scg-icon-well>.scg-icon,#${APP_ID}[data-ui="hybrid"] .scg-viewer-tools .scg-icon-well>.scg-icon{width:16px;height:16px}#${APP_ID}[data-ui="hybrid"] .scg-filter-panel .scg-filters button .scg-icon{width:17px;height:17px;stroke-width:2.15}#${APP_ID}[data-ui="hybrid"] .scg-actions .scg-icon-well,#${APP_ID}[data-ui="hybrid"] .scg-bulkbar .scg-icon-well,#${APP_ID}[data-ui="hybrid"] .scg-refinebar .scg-icon-well,#${APP_ID}[data-ui="hybrid"] .scg-viewbar .scg-icon-well{width:27px;height:27px}#${APP_ID}[data-ui="hybrid"] .scg-actions .scg-icon-well>.scg-icon,#${APP_ID}[data-ui="hybrid"] .scg-bulkbar .scg-icon-well>.scg-icon,#${APP_ID}[data-ui="hybrid"] .scg-refinebar .scg-icon-well>.scg-icon,#${APP_ID}[data-ui="hybrid"] .scg-viewbar .scg-icon-well>.scg-icon{width:16px;height:16px}#${APP_ID}[data-ui="hybrid"] .scg-search>.scg-icon-well{width:29px;height:29px}#${APP_ID}[data-ui="hybrid"] .scg-search input{padding-left:44px!important}#${APP_ID}[data-ui="hybrid"] .scg-settings-card h3>.scg-icon{width:19px;height:19px}#${APP_ID}[data-ui="hybrid"] .scg-meta .scg-icon,#${APP_ID}[data-ui="hybrid"] .scg-reply-group>header .scg-icon{width:14px;height:14px}#${APP_ID}[data-ui="hybrid"] .scg-lightbox .scg-nav .scg-icon{width:25px;height:25px}

    /* Cloud: complete light palette */
    #${APP_ID}[data-ui="hybrid"][data-theme="light"]{--scg-bg:#eef3f9;--scg-surface:#fff;--scg-surface-2:#f5f8fc;--scg-surface-3:#e8eef6;--scg-line:#cfd9e6;--scg-text:#17202c;--scg-muted:#687588;--scg-accent:#087cf0;--scg-accent-soft:#e2f0ff;--scg-success:#168247;--scg-danger:#c9344f;--scg-shadow:#29415e2e;color-scheme:light;background:radial-gradient(circle at 50% -20%,#fff 0,#edf4fb 42%,#e3ebf4 100%);color:var(--scg-text)}
    #${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-header{border-color:#afbdce80;background:#f8fbffcc;box-shadow:0 10px 34px #47617f20}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-thread-context h1,#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-brand{color:#17202c}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-thread-context div{color:#6c7888}
    #${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-header-actions,#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-scan-actions,#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-filter-panel .scg-filters,#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-refinebar,#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-viewbar{border-color:#bdc9d7;background:#ffffffb8;box-shadow:inset 0 1px 0 #fff,0 6px 20px #47617f12}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-header-actions button,#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-scan-actions button,#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-refinebar button,#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-viewbar button{color:#526174}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-header-actions button:hover,#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-scan-actions button:hover,#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-refinebar button:hover,#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-viewbar button:hover:not(:disabled){background:#dfe8f3;color:#152238}
    #${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-search input{border-color:#bdc9d7;background:#ffffffd9;color:#17202c;box-shadow:inset 0 1px 0 #fff,0 8px 24px #47617f18}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-search input::placeholder{color:#8190a3}#${APP_ID}[data-ui="hybrid"][data-theme="light"] select{color:#273548!important;background-color:#edf2f8!important}
    #${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-filter-panel .scg-filters button{color:#667588}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-filter-panel .scg-filters button:hover{background:#e8eef6;color:#17202c}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-filter-panel .scg-filters button.active{background:#167ee6;color:#fff;box-shadow:0 4px 14px #087cf04d}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-filter-panel .scg-filters button.active .scg-icon,#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-filter-panel .scg-filters button.active>span{color:#fff}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-filter-panel .scg-filters button.active>span{background:#ffffff24}
    #${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-layout-switcher{background:#dfe7f1}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-layout-switcher button.active{background:#fff;color:#126fca;box-shadow:0 2px 8px #405c7d24}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-card{border-color:#cbd6e3;background:#fff;box-shadow:0 10px 28px #47617f1f}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-card:hover{border-color:#aabdd2;box-shadow:0 18px 42px #47617f2e}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-actions{border-color:#dbe3ec;background:#f6f9fc}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-actions button{background:#e8eef5;color:#38485d}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-actions button:hover{background:#dce7f2}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-actions .scg-download-action{background:#dceeff;color:#086cc8}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-meta{border-color:#e1e7ee;color:#687588}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-reply-group{border-color:#cbd6e3;background:#f7faff;box-shadow:0 16px 38px #47617f1c}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-reply-group>header{border-color:#cbd6e3;background:#edf3f9}
    #${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-activitybar{border-color:#bbc8d7;background:#f8fbffdf;box-shadow:0 12px 36px #47617f2b}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-bulkbar button{background:#e4ebf3;color:#34445a}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-progress-summary{background:#e4ebf3!important;color:#33445a}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-progress-track{background:#c9d5e2}
    #${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-download-popover{border-color:#b9c7d8;background:#fbfdffef;color:#17202c;box-shadow:0 24px 64px #47617f38}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-download-popover header{border-color:#d3dde8;background:#edf3f8}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-job{border-color:#d3dde8;background:#f1f5f9}
    #${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-settings-panel{background:#b9c8d760}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-settings-dialog{border-color:#b9c7d7;background:#f9fbfeef;color:#17202c;box-shadow:0 30px 90px #334f7040}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-settings-head{border-color:#d2dce7;background:#eef4fa}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-settings-card{border-color:#d3dde8;background:#fff;box-shadow:0 6px 18px #47617f13}
    #${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-lightbox,#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-viewer-shell,#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-viewer-body{background:#e9eff6;color:#17202c}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-viewer-topbar,#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-viewer-footer,#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-viewer-details{border-color:#b8c6d6;background:#f9fbfedb;color:#17202c;box-shadow:0 14px 40px #415b792d}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-viewer-identity>b,#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-viewer-identity strong{color:#17202c}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-viewer-identity small{color:#687588}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-viewer-tools{border-color:#c6d2df;background:#e9eff6}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-viewer-tools button{color:#4d5d72}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-viewer-tools button:hover,#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-viewer-tools button[aria-pressed="true"]{background:#dce7f2;color:#17202c}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-viewer-tools .scg-viewer-download{background:#087cf0;color:#fff}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-lightbox-stage{background:radial-gradient(circle at 50% 45%,#fff,#dfe7f0 76%)}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-viewer-caption,#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-viewer-details-links a,#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-viewer-footer .scg-lightbox-actions button{background:#e7edf5;color:#35506d}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-viewer-thumb{background:#d8e1eb}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-lightbox .scg-nav{border-color:#b6c4d4;background:#f8fbffd9;color:#30445e;box-shadow:0 8px 24px #415b7930}

    /* Midnight Blue and Graphite alternatives */
    #${APP_ID}[data-ui="hybrid"][data-theme="midnight"]{--scg-bg:#030a13;--scg-surface:#07111d;--scg-surface-2:#0b1928;--scg-surface-3:#10243a;--scg-line:#28435e;--scg-text:#eef7ff;--scg-muted:#8ba1b7;--scg-accent:#42a5ff;--scg-accent-soft:#0d2d4b;--scg-shadow:#000d;background:radial-gradient(circle at 50% -15%,#153553 0,#071522 38%,#02070d 80%)}#${APP_ID}[data-ui="hybrid"][data-theme="midnight"] .scg-header,#${APP_ID}[data-ui="hybrid"][data-theme="midnight"] .scg-activitybar,#${APP_ID}[data-ui="hybrid"][data-theme="midnight"] .scg-viewer-topbar,#${APP_ID}[data-ui="hybrid"][data-theme="midnight"] .scg-viewer-footer,#${APP_ID}[data-ui="hybrid"][data-theme="midnight"] .scg-viewer-details{border-color:#31506b;background:#0b1b2bd9}#${APP_ID}[data-ui="hybrid"][data-theme="midnight"] .scg-search input,#${APP_ID}[data-ui="hybrid"][data-theme="midnight"] .scg-scan-actions,#${APP_ID}[data-ui="hybrid"][data-theme="midnight"] .scg-filter-panel .scg-filters,#${APP_ID}[data-ui="hybrid"][data-theme="midnight"] .scg-refinebar,#${APP_ID}[data-ui="hybrid"][data-theme="midnight"] .scg-viewbar{border-color:#28445f;background:#0a1826d9}#${APP_ID}[data-ui="hybrid"][data-theme="midnight"] .scg-card{border-color:#1d3852;background:#081522}#${APP_ID}[data-ui="hybrid"][data-theme="midnight"] .scg-actions{background:#07111c}#${APP_ID}[data-ui="hybrid"][data-theme="midnight"] .scg-download-popover,#${APP_ID}[data-ui="hybrid"][data-theme="midnight"] .scg-settings-dialog{border-color:#31506b;background:#0b1928f2}#${APP_ID}[data-ui="hybrid"][data-theme="midnight"] .scg-lightbox-stage{background:radial-gradient(circle at 50% 45%,#10283e,#01060b 74%)}
    #${APP_ID}[data-ui="hybrid"][data-theme="graphite"]{--scg-bg:#111214;--scg-surface:#18191c;--scg-surface-2:#1f2024;--scg-surface-3:#292b30;--scg-line:#3b3e45;--scg-text:#f1f1f3;--scg-muted:#a0a1a7;--scg-accent:#78aef2;--scg-accent-soft:#25374d;--scg-shadow:#000b;background:radial-gradient(circle at 50% -10%,#303238 0,#191a1d 40%,#0e0f11 85%)}#${APP_ID}[data-ui="hybrid"][data-theme="graphite"] .scg-header,#${APP_ID}[data-ui="hybrid"][data-theme="graphite"] .scg-activitybar,#${APP_ID}[data-ui="hybrid"][data-theme="graphite"] .scg-viewer-topbar,#${APP_ID}[data-ui="hybrid"][data-theme="graphite"] .scg-viewer-footer,#${APP_ID}[data-ui="hybrid"][data-theme="graphite"] .scg-viewer-details{border-color:#45484f;background:#202125dc}#${APP_ID}[data-ui="hybrid"][data-theme="graphite"] .scg-search input,#${APP_ID}[data-ui="hybrid"][data-theme="graphite"] .scg-scan-actions,#${APP_ID}[data-ui="hybrid"][data-theme="graphite"] .scg-filter-panel .scg-filters,#${APP_ID}[data-ui="hybrid"][data-theme="graphite"] .scg-refinebar,#${APP_ID}[data-ui="hybrid"][data-theme="graphite"] .scg-viewbar{border-color:#3b3e45;background:#1c1d21df}#${APP_ID}[data-ui="hybrid"][data-theme="graphite"] .scg-card{border-color:#32343a;background:#1b1c20}#${APP_ID}[data-ui="hybrid"][data-theme="graphite"] .scg-actions{background:#17181b}#${APP_ID}[data-ui="hybrid"][data-theme="graphite"] .scg-download-popover,#${APP_ID}[data-ui="hybrid"][data-theme="graphite"] .scg-settings-dialog{border-color:#45484f;background:#202125f2}#${APP_ID}[data-ui="hybrid"][data-theme="graphite"] .scg-lightbox-stage{background:radial-gradient(circle at 50% 45%,#24262a,#08090a 74%)}
    #scg-launch[data-theme="light"]{border-color:#b9c6d5;background:#f8fbffdf;color:#17202c;box-shadow:0 18px 44px #3b57762e,inset 0 1px 0 #fff}#scg-launch[data-theme="light"]:hover{border-color:#4d9deb;background:#fff;box-shadow:0 20px 52px #3b57763b,0 0 0 4px #0a84ff1c}#scg-launch[data-theme="light"] .scg-launch-copy small{color:#687588}#scg-launch[data-theme="midnight"]{border-color:#31506b;background:#0b1b2bdf}#scg-launch[data-theme="graphite"]{border-color:#45484f;background:#202125df}#scg-gallery-toast[data-theme="midnight"]{border-color:#31506b;background:#0b1b2b;color:#eef7ff}#scg-gallery-toast[data-theme="graphite"]{border-color:#45484f;background:#202125;color:#f1f1f3}

    /* v0.9.5 native dropdown palettes and lightbox metadata contrast */
    #${APP_ID}[data-ui="hybrid"][data-theme="dark"],#${APP_ID}[data-ui="hybrid"][data-theme="midnight"],#${APP_ID}[data-ui="hybrid"][data-theme="graphite"]{color-scheme:dark}#${APP_ID}[data-ui="hybrid"][data-theme="dark"] select,#${APP_ID}[data-ui="hybrid"][data-theme="midnight"] select,#${APP_ID}[data-ui="hybrid"][data-theme="graphite"] select{color-scheme:dark}
    #${APP_ID}[data-ui="hybrid"][data-theme="dark"] select option{background:#11161c;color:#edf3f9}#${APP_ID}[data-ui="hybrid"][data-theme="midnight"] select option{background:#0b1928;color:#eef7ff}#${APP_ID}[data-ui="hybrid"][data-theme="graphite"] select option{background:#202125;color:#f1f1f3}#${APP_ID}[data-ui="hybrid"] select option:checked{background:#2b82d3;color:#fff}#${APP_ID}[data-ui="hybrid"] select option:disabled{color:#7f8996}
    #${APP_ID}[data-ui="hybrid"][data-theme="light"] select option{background:#fff;color:#26364a}#${APP_ID}[data-ui="hybrid"][data-theme="light"] select option:checked{background:#167ee6;color:#fff}
    #${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-viewer-details dl>div{border-bottom-color:#cbd6e2}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-viewer-details dt{color:#607187;font-weight:750}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-viewer-details dd{color:#26364a;font-weight:650}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-viewer-details [data-viewer-resolution]{color:#086cc8}#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-viewer-details-head small,#${APP_ID}[data-ui="hybrid"][data-theme="light"] .scg-viewer-shortcuts{color:#637389}
    @media(max-width:980px){#${APP_ID}[data-ui="hybrid"] .scg-viewer-details{margin:10px;border-radius:18px}#${APP_ID}[data-ui="hybrid"] .scg-lightbox .scg-next,#${APP_ID}[data-ui="hybrid"] .scg-lightbox.details-hidden .scg-next{right:10px}}
    @media(max-width:620px){#${APP_ID}[data-ui="hybrid"] .scg-header{grid-template-columns:auto minmax(0,1fr) auto;padding:8px}#${APP_ID}[data-ui="hybrid"] .scg-header-actions{border:0;background:transparent}#${APP_ID}[data-ui="hybrid"] .scg-filter-panel .scg-filters{max-width:calc(100% - 16px);margin:0 8px 7px;overflow-x:auto}#${APP_ID}[data-ui="hybrid"] .scg-filter-panel .scg-filters button{padding:7px 10px}#${APP_ID}[data-ui="hybrid"] .scg-refinebar,#${APP_ID}[data-ui="hybrid"] .scg-viewbar{margin:0 8px 7px}#${APP_ID}[data-ui="hybrid"] .scg-scroll{padding:8px 8px 78px}#${APP_ID}[data-ui="hybrid"] .scg-card{border-radius:14px}#${APP_ID}[data-ui="hybrid"] .scg-activitybar{margin:0 6px 6px;border-radius:15px}#${APP_ID}[data-ui="hybrid"] .scg-viewer-shell{grid-template-rows:64px minmax(0,1fr) 72px}#${APP_ID}[data-ui="hybrid"] .scg-viewer-topbar{width:calc(100% - 12px);margin:6px;padding:6px;border-radius:15px}#${APP_ID}[data-ui="hybrid"] .scg-viewer-footer{width:calc(100% - 12px);margin:0 6px 6px;border-radius:15px}#${APP_ID}[data-ui="hybrid"] .scg-viewer-thumb{width:48px;height:48px}}
  `;
  document.head.appendChild(style);

  const launch = document.createElement('button');
  launch.id = 'scg-launch';
  launch.innerHTML = `${iconWell('gallery', 'scg-launch-icon')}<span class="scg-launch-copy"><strong>Open Gallery</strong><small data-launch-detail>Browse this thread</small></span>`;
  launch.setAttribute('aria-label', 'Open thread gallery');
  document.body.appendChild(launch);

  function refreshLaunchButton() {
    const count = state.items.filter(isMediaItem).length;
    const detail = launch.querySelector('[data-launch-detail]');
    if (detail) detail.textContent = count ? `${count.toLocaleString()} media indexed` : 'Browse this thread';
    launch.setAttribute('aria-label', count ? `Open thread gallery, ${count} media items indexed` : 'Open thread gallery');
  }

  const app = document.createElement('section');
  app.id = APP_ID;
  app.setAttribute('data-ui', 'hybrid');
  app.setAttribute('role', 'dialog');
  app.setAttribute('aria-modal', 'true');
  app.setAttribute('aria-label', 'SimpCity Thread Gallery');
  app.innerHTML = `
    <header class="scg-header">
      <div class="scg-brand"><div class="scg-brand-mark">${icon('gallery')}</div><div><b>Gallery</b><small>Hybrid 2 · v0.9.5</small></div></div>
      <div class="scg-thread-context"><h1 data-thread-title>Thread gallery</h1><div><span data-thread-meta>Page 1</span><span data-source-summary>Current page</span></div></div>
      <div class="scg-header-actions"><button data-action="filters-toggle" data-tooltip="Toggle filters" aria-expanded="true">${iconWell('filter')}<span>Filters</span></button><button data-action="density" data-tooltip="Change card density">${iconWell('layout')}<span>Compact cards</span></button><button data-action="theme" data-tooltip="Change theme">${iconWell('sun')}<span>Light theme</span></button><button data-action="shortcuts" data-tooltip="Keyboard shortcuts">${iconWell('keyboard')}<span>Shortcuts</span></button><button data-action="settings" data-tooltip="Settings and diagnostics">${iconWell('settings')}<span>Settings</span></button><button class="scg-close" data-tooltip="Close gallery" aria-label="Close">${iconWell('close', 'scg-icon-well-danger')}</button></div>
    </header>
    <nav class="scg-controls">
      <label class="scg-search">${iconWell('search')}<input data-search type="search" placeholder="Search author, caption, host or text..."></label>
      <div class="scg-scan-actions">
        <button data-action="page">${iconWell('page')}<span>Current page</span></button>
        <span class="scg-source-page"><select data-source-page aria-label="Thread page"></select><button data-action="load-source-page">${iconWell('page')}<span>Load</span></button></span>
        <button data-action="thread">${iconWell('scan', 'scg-icon-well-primary')}<span>Scan entire thread</span></button>
      </div>
    </nav>
    <section class="scg-filter-panel" aria-label="Gallery filters">
      <div class="scg-filters">
        <button class="active" data-filter="all">${icon('gallery')}<b>All</b><span>0</span></button>
        <button data-filter="image">${icon('image')}<b>Images</b><span>0</span></button>
        <button data-filter="video">${icon('video')}<b>Videos</b><span>0</span></button>
        <button data-filter="link">${icon('link')}<b>Links</b><span>0</span></button>
        <button data-filter="text">${icon('text')}<b>Text</b><span>0</span></button>
      </div>
      <div class="scg-refinebar">
        <label>Sort <select data-sort><option value="thread-asc">Oldest replies first</option><option value="thread-desc">Newest replies first</option><option value="author">Author A-Z</option><option value="host">Host A-Z</option><option value="type">Media type</option></select></label>
        <label>Author <select data-author-filter></select></label>
        <label>Host <select data-host-filter></select></label>
        <label>Group <select data-group-by><option value="none">Individual cards</option><option value="reply">Group by reply</option></select></label>
        <button data-selected-only>${iconWell('select')}<span>Selected only</span></button>
        <button data-action="reset-filters">${iconWell('reset')}<span>Reset</span></button>
        <span class="scg-refine-spacer"></span>
        <button class="scg-selection-toggle" data-action="selection-mode">${iconWell('select')}<span>Select media</span></button>
      </div>
    </section>
    <section class="scg-viewbar"><span class="scg-view-summary">0 matched</span><div class="scg-layout-switcher" role="group" aria-label="Gallery layout"><button data-layout-mode="masonry" data-tooltip="Masonry layout" aria-pressed="true">${iconWell('masonry')}<span>Masonry</span></button><button data-layout-mode="grid" data-tooltip="Uniform grid layout" aria-pressed="false">${iconWell('grid')}<span>Grid</span></button><button data-layout-mode="feed" data-tooltip="Wide feed layout" aria-pressed="false">${iconWell('feed')}<span>Feed</span></button></div><span class="scg-view-pagination"><button data-action="view-prev" aria-label="Previous result page">${iconWell('previous')}<span>Previous</span></button><select data-view-page aria-label="Gallery result page"></select><button data-action="view-next" aria-label="Next result page">${iconWell('next')}<span>Next</span></button></span><label>Items per view <select data-page-size><option value="40">40</option><option value="60">60</option><option value="100">100</option></select></label></section>
    <main class="scg-scroll"><div class="scg-grid"></div><button class="scg-top">${iconWell('up')}<span>Back to top</span></button></main>
    <footer class="scg-bulkbar scg-activitybar">
      <div class="scg-activity-state"><i></i><div><b class="scg-status">Ready</b><span data-activity-detail>Open a page or scan the thread</span></div></div>
      <div class="scg-bulk-actions"><span class="scg-bulk-label">SELECT</span><button data-action="select-visible">${iconWell('select')}<span>Visible</span></button><button data-action="select-images">${iconWell('image')}<span>Images</span></button><button data-action="select-videos">${iconWell('video')}<span>Videos</span></button><button data-action="clear-selection" disabled>${iconWell('clear')}<span>Clear</span></button><span class="scg-selected-count">0 selected</span><button class="scg-primary" data-action="download-selected" disabled>${iconWell('archive', 'scg-icon-well-primary')}<span>Download ZIP (0)</span></button></div>
      <div class="scg-progress">
        <button class="scg-progress-summary" data-action="download-details" data-tooltip="Open download queue"><div class="scg-progress-track"><div class="scg-progress-fill"></div></div><span class="scg-progress-text">Downloads idle</span></button>
        <aside class="scg-download-popover"><header><b>Download queue</b><div><button data-action="clear-download-history" title="Forget saved-file markers">${iconWell('history')}<span>Clear history</span></button><button data-action="close-download-details" title="Close">${iconWell('close')}<span>Close</span></button></div></header><div class="scg-download-overall">No downloads yet.</div><div class="scg-download-jobs"></div></aside>
      </div>
      <button class="scg-activity-toggle" data-action="activity-toggle" data-tooltip="Collapse activity bar" aria-expanded="true">${iconWell('chevron')}<span>Collapse activity</span></button>
    </footer>
    <div class="scg-lightbox" role="dialog" aria-modal="true" aria-label="Media viewer"></div>
    <div class="scg-settings-panel" role="dialog" aria-modal="true" aria-label="Settings and diagnostics">
      <section class="scg-settings-dialog" tabindex="-1">
        <header class="scg-settings-head"><div>${icon('settings')}<div><h2>Settings & diagnostics</h2><p>Private local preferences, portability and troubleshooting</p></div></div><button class="scg-settings-close" data-action="close-settings" aria-label="Close settings">${iconWell('close', 'scg-icon-well-danger')}</button></header>
        <div class="scg-settings-body"><div class="scg-settings-grid">
          <section class="scg-settings-card"><h3>${icon('palette')} Appearance</h3><p>Choose the gallery layout, theme, card density and remembered panel state.</p><div class="scg-setting-fields"><label>Gallery layout<select data-setting-layout><option value="masonry">Masonry</option><option value="grid">Uniform grid</option><option value="feed">Feed</option></select></label><label>Theme<select data-setting-theme><option value="dark">Apple Black</option><option value="light">Cloud</option><option value="midnight">Midnight Blue</option><option value="graphite">Graphite</option></select></label><label>Card density<select data-setting-density><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label></div><label class="scg-settings-check"><input type="checkbox" data-setting-filters-collapsed><span>Keep filters collapsed</span></label><label class="scg-settings-check"><input type="checkbox" data-setting-activity-collapsed><span>Keep the activity bar compact</span></label></section>
          <section class="scg-settings-card full"><h3>${icon('download')} Archive & downloads <span class="scg-settings-version">v${APP_VERSION}</span></h3><p>Control download throughput, ZIP part limits and archive organization. Changes apply to the next queue.</p><div class="scg-setting-fields scg-download-settings"><label>ZIP folders<select data-setting-archive-layout><option value="page-author">Page / author</option><option value="page">Page only</option><option value="reply">Page / reply</option><option value="flat">Flat archive</option></select></label><label>Simultaneous files<select data-setting-download-concurrency><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option></select></label><label>Maximum part size<select data-setting-zip-part-size><option value="100">100 MB</option><option value="300">300 MB</option><option value="600">600 MB</option><option value="1000">1,000 MB</option></select></label><label>Files per part<select data-setting-zip-part-files><option value="24">24</option><option value="50">50</option><option value="100">100</option></select></label></div><div class="scg-archive-checks"><label class="scg-settings-check"><input type="checkbox" data-setting-include-manifest><span>Add manifest.csv with source URL, reply, author, validation method and CRC32.</span></label><label class="scg-settings-check"><input type="checkbox" data-setting-dedupe-content><span>Merge byte-identical reposts using verified size + CRC32 while preserving download history and provenance.</span></label></div></section>
          <section class="scg-settings-card"><h3>${icon('info')} Storage</h3><p>Preferences and verified download history are stored outside the website. Pre-v0.7.3 history remains visible as LEGACY but will not skip a new download.</p><div class="scg-storage-note">${icon('select')}<span><b data-diag-storage></b><br><span data-diag-migration></span></span></div></section>
          <section class="scg-settings-card"><h3>${icon('upload')} Backup and restore</h3><p>Export preferences as JSON or restore a previous backup.</p><label class="scg-settings-check"><input type="checkbox" data-export-history><span>Include download history. This contains thread and media references.</span></label><div class="scg-settings-actions"><button data-action="export-settings">${iconWell('download')}<span>Export</span></button><button data-action="import-settings">${iconWell('upload')}<span>Import</span></button><input class="scg-settings-file" data-settings-file type="file" accept="application/json,.json"></div></section>
          <section class="scg-settings-card full"><h3>${icon('info')} Diagnostics</h3><p>A local, URL-scrubbed summary for troubleshooting. Nothing is transmitted automatically.</p><div class="scg-diag-grid"><div class="scg-diag-stat"><span>Version</span><b data-diag-version></b></div><div class="scg-diag-stat"><span>Thread pages</span><b data-diag-pages></b></div><div class="scg-diag-stat"><span>Indexed items</span><b data-diag-items></b></div><div class="scg-diag-stat"><span>Download history</span><b data-diag-history></b></div><div class="scg-diag-stat"><span>Resolver failures</span><b data-diag-resolvers></b></div><div class="scg-diag-stat"><span>Download failures</span><b data-diag-downloads></b></div><div class="scg-diag-stat"><span>Scan failures</span><b data-diag-scans></b></div><div class="scg-diag-stat"><span>Storage</span><b data-diag-storage></b></div></div><div class="scg-settings-actions" style="margin-top:10px"><button data-action="copy-debug">${iconWell('copy')}<span>Copy debug report</span></button><button data-action="clear-diagnostics">${iconWell('reset')}<span>Clear diagnostics</span></button></div></section>
          <section class="scg-settings-card"><h3>${icon('reset')} Reset</h3><p>Reset visual preferences, or also forget SAVED download markers.</p><div class="scg-settings-actions"><button data-action="reset-preferences">${iconWell('reset')}<span>Reset preferences</span></button><button class="danger" data-action="reset-everything">${iconWell('trash', 'scg-icon-well-danger')}<span>Reset preferences + history</span></button></div></section>
          <section class="scg-settings-card"><h3>${icon('info')} Cross-host permission</h3><p>The wildcard connection permission is intentionally retained for media hosted on changing third-party domains.</p><div class="scg-permission-note">The script only requests URLs discovered in thread replies or known resolver endpoints. It contains no analytics or telemetry.</div></section>
        </div></div>
        <footer class="scg-settings-foot"><span>SimpCity Thread Gallery <b>v${APP_VERSION}</b></span><span>Settings remain on this device unless you export them.</span></footer>
      </section>
    </div>
    <div class="scg-confirm-panel" role="dialog" aria-modal="true" aria-labelledby="scg-confirm-title"><section class="scg-confirm-dialog"><div class="scg-confirm-icon">${icon('info')}</div><h2 id="scg-confirm-title" data-confirm-title>Confirm action</h2><p data-confirm-message></p><div><button data-confirm-cancel>${iconWell('close')}<span>Cancel</span></button><button class="scg-confirm-accept" data-confirm-accept>${iconWell('check', 'scg-icon-well-primary')}<span>Continue</span></button></div></section></div>`;
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
    if (!state.items.length) scanCurrentPage();
    else render();
    if (migratedLegacyStorage && !openApp.migrationNotified) {
      openApp.migrationNotified = true;
      notify('Your previous gallery settings were moved into private userscript storage.', 5200);
    }
  }

  function closeApp() {
    closeSettingsPanel();
    app.classList.remove('open');
    document.documentElement.style.overflow = '';
    state.cancelScan = true;
    closeLightbox();
    releaseRenderedMedia();
    state.renderedItems = [];
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
  app.querySelector('[data-action="reset-filters"]').onclick = () => {
    app.querySelector('[data-search]').value = '';
    commitState({
      filter: 'all', query: '', authorFilter: 'all', hostFilter: 'all', selectedOnly: false,
      sort: 'thread-asc', groupBy: 'none', viewPage: 1,
    }, { persist: true });
  };
  app.querySelector('[data-action="selection-mode"]').onclick = () => {
    if (state.downloading) return notify('The bulk download is still running.');
    if (state.selectionMode) {
      state.selectionMode = false;
      state.selected.clear();
      state.selectedOnly = false;
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
  app.querySelector('[data-action="shortcuts"]').onclick = () => notify('Gallery: L layout, / search, Shift+A select view, Shift+G open/close. Viewer: arrows navigate, wheel or +/− zoom, 0 fit, I details, F fullscreen, Space play/pause, D download, S select.', 9000);
  app.querySelector('[data-action="settings"]').onclick = controllers.settings.open;
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
    state.selected.clear();
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
  topButton.onclick = () => scrollArea.scrollTo({ top: 0, behavior: 'smooth' });
  scrollArea.onscroll = () => topButton.classList.toggle('visible', scrollArea.scrollTop > 650);
  app.querySelector('.scg-grid').onclick = event => {
    const items = state.renderedItems;
    const selection = event.target.closest('[data-select]');
    if (selection) {
      const item = items[Number(selection.dataset.select)];
      setSelected(item, selection.checked);
      updateSelectionUi();
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
    const confirmPanel = app.querySelector('.scg-confirm-panel');
    if (confirmPanel.classList.contains('open')) {
      if (event.key === 'Escape') confirmPanel.querySelector('[data-confirm-cancel]')?.click();
      return;
    }
    const settingsPanel = app.querySelector('.scg-settings-panel');
    if (settingsPanel.classList.contains('open')) {
      if (event.key === 'Escape') controllers.settings.close();
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
    }
  });
})();
