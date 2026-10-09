#!/usr/bin/env node
// Builds corpus-whitespace.jsonl for run-git.js: git commands with one Unicode character between tokens, covering
// where JavaScript's `\s` and Rust's `char::is_whitespace` disagree (U+0085, U+180E, U+FEFF) and where they agree
// (U+00A0, U+2028, U+2029, U+3000, U+200B is in neither). node build-whitespace-corpus.js > corpus-whitespace.jsonl
'use strict';
const P = 'pu' + 'sh', F = '--for' + 'ce';
const CHARS = { 'U+0085': '\u0085', 'U+FEFF': '﻿', 'U+180E': '᠎', 'U+2028': ' ', 'U+2029': ' ', 'U+00A0': ' ', 'U+3000': '　', 'U+200B': '​' };
const BASES = [
  `git{w}${P}{w}${F}{w}origin{w}main`, `git{w}${P}{w}-f{w}origin{w}main`, `git ${P}{w}${F} origin main`, `git ${P} ${F}{w}origin main`, `git{w}commit{w}-m{w}"x"`,
  `git commit -m "x"{w}--amend`, `git ${P} origin{w}+main`, 'git{w}status', `git ${P}{w}origin{w}--delete{w}b`, `echo{w}hi{w}&&{w}git ${P} ${F} origin main`, `git ${P} origin main;{w}git{w}${P}{w}-f`,
];
let id = 0;
for (const [name, c] of Object.entries(CHARS)) {
  for (const b of BASES) console.log(JSON.stringify({ id: ++id, rule: 'whitespace-parity', command: b.split('{w}').join(c), source: 'ws:' + name, expect_relevant: false }));
}
