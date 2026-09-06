#!/usr/bin/env node
// Chrome-translation drift check.
//
// The app chrome is a finite set of strings, so a dictionary is the right tool —
// the failure mode is forgetting to add one. This finds every t('…') call site
// in src/ and reports any whose key is missing from the Spanish dictionary, so
// the omission surfaces here instead of as an English button in a Spanish UI.
//
//   npm run i18n:check          report, exit 1 if anything is missing
//   npm run i18n:check -- --list  also print every key that IS translated
//
// Trip CONTENT is deliberately out of scope: it is unbounded and lives on the
// trip (see src/i18n/collect.js), not in source.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';

// fileURLToPath, not .pathname — this repo lives under a path with spaces, which
// .pathname hands back percent-encoded.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const DICT = join(ROOT, 'src/engine/settings.jsx');

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(jsx?|mjs)$/.test(name) ? [full] : [];
  });
}

// t('…') / t("…") — single-argument literal calls. Template literals and
// variables are skipped on purpose: they cannot be checked statically, and a
// dynamic key is a design smell worth noticing separately.
const CALL_RE = /\bt\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1\s*\)/g;

// Every entry, in source order, WITH duplicates preserved.
//
// A JS object literal silently keeps the LAST value for a repeated key, so a
// duplicate is not a tidiness problem — it is one screen's translation quietly
// overwriting another's. The dictionary is flat and keyed by the English
// string, and both t() (chrome) and tt() (content, via its fall-through) read
// it, so one word used in two senses collides by construction: 'Clear' the
// button and 'Clear' the weather condition are ONE entry, and whichever is
// written second wins everywhere. Collecting into a Set — which is what this
// check used to do — hides exactly that.
function dictionaryEntries() {
  const src = readFileSync(DICT, 'utf8');
  const start = src.indexOf('const ES = {');
  if (start < 0) throw new Error('could not find `const ES = {` in settings.jsx');
  // The dictionary ends at the first line that is exactly `};`
  const end = src.indexOf('\n};', start);
  const block = src.slice(start, end);
  const out = [];
  const ENTRY_RE = /^\s*(['"])((?:\\.|(?!\1)[^\\])*)\1\s*:\s*(['"])((?:\\.|(?!\3)[^\\])*)\3/gm;
  let m;
  while ((m = ENTRY_RE.exec(block))) {
    out.push({
      key: m[2].replace(/\\(['"])/g, '$1'),
      value: m[4].replace(/\\(['"])/g, '$1'),
      line: src.slice(0, start + m.index).split('\n').length,
    });
  }
  return out;
}

const entries = dictionaryEntries();
const keys = new Set(entries.map((e) => e.key));

const byKey = new Map();
for (const e of entries) {
  if (!byKey.has(e.key)) byKey.set(e.key, []);
  byKey.get(e.key).push(e);
}
const dupes = [...byKey.values()].filter((v) => v.length > 1);
// Same key, DIFFERENT translations: a real defect — one of the two screens is
// showing the other's words, and only the last one written is reachable.
const conflicts = dupes.filter((v) => new Set(v.map((e) => e.value)).size > 1);
// Same key, same translation: dead weight, and a collision waiting to happen
// the next time someone edits one copy and not the other.
const redundant = dupes.filter((v) => new Set(v.map((e) => e.value)).size === 1);
const used = new Map(); // key -> [files]

for (const file of walk(SRC)) {
  const text = readFileSync(file, 'utf8');
  CALL_RE.lastIndex = 0;
  let m;
  while ((m = CALL_RE.exec(text))) {
    const key = m[2].replace(/\\(['"])/g, '$1');
    if (!used.has(key)) used.set(key, []);
    used.get(key).push(relative(ROOT, file));
  }
}

const missing = [...used.keys()].filter((k) => !keys.has(k)).sort();
const unused = [...keys].filter((k) => !used.has(k)).sort();

console.log(`t() call sites: ${used.size} distinct keys · dictionary: ${keys.size} entries`);

if (process.argv.includes('--list')) {
  for (const k of [...used.keys()].sort()) console.log(`  ${keys.has(k) ? 'ok  ' : 'MISS'} ${k}`);
}

if (unused.length) {
  console.log(`\n${unused.length} dictionary entries no longer used by any t() call:`);
  for (const k of unused.slice(0, 40)) console.log(`  · ${k}`);
  if (unused.length > 40) console.log(`  … and ${unused.length - 40} more`);
  console.log('  (harmless — some are content strings tt() falls through to)');
}

if (redundant.length) {
  console.log(`\n${redundant.length} dictionary key(s) written twice with the same translation:`);
  for (const v of redundant) console.log(`  · ${JSON.stringify(v[0].key)} — lines ${v.map((e) => e.line).join(', ')}`);
  console.log('  (harmless today, but drop all but the LAST — the earlier copies are already');
  console.log('   unreachable, so editing one of them changes nothing and reads like it did)');
}

let failed = false;

if (conflicts.length) {
  console.error(`\n${conflicts.length} dictionary key(s) carry CONFLICTING translations — the last one written wins everywhere:`);
  for (const v of conflicts) {
    console.error(`  ✗ ${JSON.stringify(v[0].key)}`);
    for (const e of v) {
      const live = e === v[v.length - 1];
      console.error(`      line ${e.line}: ${JSON.stringify(e.value)}${live ? '   ← this one wins' : '   (dead)'}`);
    }
  }
  console.error('\nOne English string can only carry one translation here: t() and tt() share this'
    + '\ndictionary. Give the two senses different English keys, or accept one translation.');
  failed = true;
}

if (missing.length) {
  console.error(`\n${missing.length} t() call(s) have no Spanish translation:`);
  for (const k of missing) console.error(`  ✗ ${k}\n      ${used.get(k).join(', ')}`);
  console.error('\nAdd them to the ES dictionary in src/engine/settings.jsx.');
  failed = true;
}

if (failed) process.exit(1);

console.log('\nEvery t() call has a translation, and no key is written twice.');
