'use strict';

/* Synthetic benchmark for the hot paths the windowed renderer walks.
   Not part of the test suite -- run it by hand:  node tests/bench.cjs

   Each case contrasts an item as it existed before v0.13.0 (URLs re-parsed on
   every read) with one carrying the fields appendUniqueItems now derives once.
   The numbers that matter are relative; a realistically large thread is the
   only honest input size, since all of this used to run over the whole indexed
   set once per scroll frame or once per keystroke. */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'SimpCity-Thread-Gallery-Timeline.user.js'),
  'utf8',
);

const location = { href: 'https://simpcity.cr/threads/example-thread.12345/page-2', origin: 'https://simpcity.cr' };

function slice(startMarker, endMarker, names, context = {}) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`missing marker: ${startMarker} .. ${endMarker}`);
  const code = `${source.slice(start, end)}\n;globalThis.__out = { ${names.join(', ')} };`;
  const sandbox = { URL, location, console, Date, Math, JSON, Intl, ...context };
  vm.runInNewContext(code, sandbox);
  return sandbox.__out;
}

const VIDEO_EXT = /\.(?:mp4|webm|mov|m4v)(?:$|[?#./])/i;

const resolvers = slice(
  'const absoluteUrl =',
  'function downloadHistoryKey',
  ['hostOf', 'hostDefinition', 'hasDirectResolver', 'isDownloadableMedia', 'threadBaseUrl'],
  { VIDEO_EXT, state: { threadPageCount: 1 }, hostOf: url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'link'; } } },
);

const HOSTS = [
  'https://bunkr.cr/f/AbCdEf123',
  'https://turbo.cr/v/xyz789',
  'https://gofile.io/d/QWERTY',
  'https://pixeldrain.com/u/abcd1234',
  'https://voe.sx/e/somevideo',
];

// A thread shaped like the ones this fork exists for: mostly images, a heavy
// minority of embeds on hosts that need a resolver, a few direct videos.
function buildItems(count, { derived }) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const kind = i % 5;
    const common = {
      pageUrl: `https://simpcity.cr/threads/example-thread.12345/page-${1 + (i % 200)}`,
      postUrl: `https://simpcity.cr/threads/example-thread.12345/post-${1000 + i}`,
      author: `Poster ${i % 140}`,
    };
    let item;
    if (kind < 3) {
      item = { ...common, type: 'image', url: `https://cdn.example.com/img/${i}.jpg`, thumb: `https://cdn.example.com/t/${i}.jpg`, originalLink: `https://jpg6.su/i/${i}`, selectionKey: `image|${i}` };
    } else if (kind === 3) {
      item = { ...common, type: 'embed', url: HOSTS[i % HOSTS.length], originalLink: '', resolution: {}, selectionKey: `videoish|${i}` };
    } else {
      item = { ...common, type: 'video', url: `https://cdn.example.com/v/${i}.mp4`, resolution: { candidate: { status: 'confirmed', url: `https://cdn.example.com/v/${i}.mp4` } }, selectionKey: `video|${i}` };
    }
    if (derived) {
      // What appendUniqueItems now writes once, at index time.
      item.sourceHost = item.type === 'text' ? '' : resolvers.hostOf(item.originalLink || item.url || item.postUrl);
      item.historyKey = `${resolvers.threadBaseUrl(item.pageUrl)}|${item.selectionKey}`;
      item.directResolver = resolvers.hasDirectResolver(item);
    }
    items.push(item);
  }
  return items;
}

function time(label, iterations, fn) {
  fn();
  const started = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  return { label, ms: Number(process.hrtime.bigint() - started) / 1e6 / iterations };
}

function report(before, after) {
  const speedup = before.ms / after.ms;
  console.log(`  ${before.label.padEnd(46)} ${before.ms.toFixed(2).padStart(8)} ms  ->  ${after.ms.toFixed(2).padStart(7)} ms   ${speedup.toFixed(0)}x`);
}

const RAW = buildItems(5000, { derived: false });
const INDEXED = buildItems(5000, { derived: true });
const AUTHORS = RAW.map(item => item.author);

console.log(`\nSynthetic thread: ${RAW.length} items (${RAW.filter(i => i.type === 'embed').length} embeds)\n`);
console.log('                                                    before        after   gain');

const scan = items => { let n = 0; for (const item of items) if (resolvers.isDownloadableMedia(item)) n++; return n; };
report(
  time('selection scan over every indexed item', 20, () => scan(RAW)),
  time('', 20, () => scan(INDEXED)),
);

report(
  time('download-history key for 5000 cards', 20, () => { for (const i of RAW) resolvers.threadBaseUrl(i.pageUrl); }),
  time('', 20, () => { for (const i of INDEXED) void i.historyKey; }),
);

const collator = new Intl.Collator(undefined, { sensitivity: 'base' });
report(
  time('author sort, 5000 items', 5, () => AUTHORS.slice().sort((a, b) => String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base' }))),
  time('', 5, () => AUTHORS.slice().sort((a, b) => collator.compare(String(a || ''), String(b || '')))),
);

// Not a before/after: this is the cost the scroll frame no longer pays at all,
// because updateFlowWindow stopped calling updateSelectionUi.
const perFrame = time('selection scan (now removed from the frame)', 20, () => scan(RAW));
console.log(`\n  ${perFrame.label.padEnd(46)} ${perFrame.ms.toFixed(2).padStart(8)} ms  ->  removed`);
console.log(`  (a 60fps frame budget is 16.67 ms)\n`);
