#!/usr/bin/env node
// Trim a raw asciicast v3 recording: drop the startup noise before the TUI is drawn and the
// shutdown tail (typed /exit, resume line). Event content is never modified; only the header's
// recorded command line (which holds a local temp path) is replaced with a placeholder.
//
// usage: node trim-cast.js <in.cast> <out.cast> [--end-before "<substring>"]
//   --end-before  drop every event from the first one whose data contains this substring
//                 (default: "/exit", the typed exit command)
const fs = require('fs');

const [inFile, outFile, ...rest] = process.argv.slice(2);
if (!inFile || !outFile) {
  console.error('usage: node trim-cast.js <in.cast> <out.cast> [--end-before "<substring>"]');
  process.exit(2);
}
const endIdx = rest.indexOf('--end-before');
const endMarker = endIdx >= 0 ? rest[endIdx + 1] : '/exit';

const lines = fs.readFileSync(inFile, 'utf8').split('\n').filter(Boolean);
const header = JSON.parse(lines[0]);
const events = lines.slice(1).map((l) => JSON.parse(l));

// Start: the first event that begins drawing the Claude Code TUI (window-title set to
// "Claude Code" is immediately followed by the header paint). Everything before is shell and
// terminal-negotiation noise.
const start = events.findIndex((e) => e[1] === 'o' && e[2].includes('Claude Code'));
if (start < 0) throw new Error('TUI start not found');

// End: first event containing the end marker; keep everything before it.
const end = events.findIndex((e, i) => i > start && e[1] === 'o' && e[2].includes(endMarker));
if (end < 0) throw new Error('end marker not found: ' + endMarker);

const kept = events.slice(start, end);
kept[0] = [0, kept[0][1], kept[0][2]]; // first kept event at t=0

header.command = 'claude --settings <tmp>/demo-settings.json --permission-mode default --allowedTools "Bash(git:*)"';
delete header.env;

const out = [JSON.stringify(header), ...kept.map((e) => JSON.stringify(e))].join('\n') + '\n';
fs.writeFileSync(outFile, out);
console.log(`kept events ${start + 1}..${end} of ${events.length} (dropped ${start} leading, ${events.length - end} trailing)`);
