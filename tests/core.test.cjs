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
  assert.match(metadataValue('version'), /^0\.9\.[56]$/);
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

test('preview-only Darkroom UI is recognized without making it a stable tag', () => {
  if (metadataValue('version') !== '0.9.6') return;
  assert.match(source, /data-ui', 'darkroom'/);
  assert.match(source, /Object\.freeze\(\['masonry', 'grid', 'feed'\]\)/);
  assert.match(source, /const THEME_MODES = Object\.freeze\(\['dark', 'light', 'midnight', 'graphite'\]\)/);
  assert.match(source, /min="70" max="160" step="5"/);
});

