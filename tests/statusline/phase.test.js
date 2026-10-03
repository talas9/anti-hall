'use strict';
// phase.js — the phase-state machine that drives the line-2 phase bar.
// Subcommands: set / advance / step / agents / update / clear. State persists to
// <HOME>/.anti-hall/phase-state.json. Every test gets its own fake HOME so the
// real machine's state is never touched. We assert the PERSISTED JSON + that the
// script always exits 0 (fail-open).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runSL, makeStatusHome } = require('./helper.js');

function statePath(h) {
  return path.join(h.antiHall, 'phase-state.json');
}
function readState(h) {
  return JSON.parse(fs.readFileSync(statePath(h), 'utf8'));
}

test('phase.js set writes code/desc/done/total + a started timestamp', () => {
  const h = makeStatusHome();
  try {
    const before = Date.now();
    const r = runSL('phase.js', { home: h.home, args: ['set', 'P2', 'build api', '2', '5'] });
    assert.strictEqual(r.status, 0);
    const s = readState(h);
    assert.strictEqual(s.code, 'P2');
    assert.strictEqual(s.desc, 'build api');
    assert.strictEqual(s.done, 2);
    assert.strictEqual(s.total, 5);
    assert.ok(typeof s.started === 'number' && s.started >= before, 'started is a fresh ms timestamp');
  } finally { h.cleanup(); }
});

test('phase.js set coerces non-numeric done/total to 0', () => {
  const h = makeStatusHome();
  try {
    runSL('phase.js', { home: h.home, args: ['set', 'P1', 'x', 'abc', ''] });
    const s = readState(h);
    assert.strictEqual(s.done, 0);
    assert.strictEqual(s.total, 0);
  } finally { h.cleanup(); }
});

test('phase.js advance increments done by 1 (default)', () => {
  const h = makeStatusHome();
  try {
    runSL('phase.js', { home: h.home, args: ['set', 'P2', 'd', '2', '5'] });
    runSL('phase.js', { home: h.home, args: ['advance'] });
    assert.strictEqual(readState(h).done, 3);
  } finally { h.cleanup(); }
});

test('phase.js advance N increments done by N', () => {
  const h = makeStatusHome();
  try {
    runSL('phase.js', { home: h.home, args: ['set', 'P2', 'd', '1', '9'] });
    runSL('phase.js', { home: h.home, args: ['advance', '3'] });
    assert.strictEqual(readState(h).done, 4);
  } finally { h.cleanup(); }
});

test('phase.js step joins args into the step text', () => {
  const h = makeStatusHome();
  try {
    runSL('phase.js', { home: h.home, args: ['set', 'P2', 'd', '0', '3'] });
    runSL('phase.js', { home: h.home, args: ['step', 'wiring', 'the', 'routes'] });
    assert.strictEqual(readState(h).step, 'wiring the routes');
  } finally { h.cleanup(); }
});

test('phase.js agents sets a numeric agent count', () => {
  const h = makeStatusHome();
  try {
    runSL('phase.js', { home: h.home, args: ['set', 'P2', 'd', '0', '3'] });
    runSL('phase.js', { home: h.home, args: ['agents', '4'] });
    assert.strictEqual(readState(h).agents, 4);
  } finally { h.cleanup(); }
});

test('phase.js agents with a non-numeric value deletes the agents field', () => {
  const h = makeStatusHome();
  try {
    runSL('phase.js', { home: h.home, args: ['set', 'P2', 'd', '0', '3'] });
    runSL('phase.js', { home: h.home, args: ['agents', '4'] });
    runSL('phase.js', { home: h.home, args: ['agents', 'NaN'] });
    assert.ok(!('agents' in readState(h)), 'agents key removed when value is not a number');
  } finally { h.cleanup(); }
});

test('phase.js update merges key=value (ints parsed, strings kept)', () => {
  const h = makeStatusHome();
  try {
    runSL('phase.js', { home: h.home, args: ['set', 'P2', 'd', '0', '3'] });
    runSL('phase.js', { home: h.home, args: ['update', 'done=2', 'note=hello'] });
    const s = readState(h);
    assert.strictEqual(s.done, 2, 'numeric string parsed to int');
    assert.strictEqual(s.note, 'hello', 'non-numeric kept as string');
  } finally { h.cleanup(); }
});

test('phase.js clear removes the state file and the bar hides', () => {
  const h = makeStatusHome();
  try {
    runSL('phase.js', { home: h.home, args: ['set', 'P2', 'd', '1', '3'] });
    assert.ok(fs.existsSync(statePath(h)), 'state exists before clear');
    const r = runSL('phase.js', { home: h.home, args: ['clear'] });
    assert.strictEqual(r.status, 0);
    assert.ok(!fs.existsSync(statePath(h)), 'state removed after clear');
  } finally { h.cleanup(); }
});

test('phase.js clear is idempotent when no state exists', () => {
  const h = makeStatusHome();
  try {
    const r = runSL('phase.js', { home: h.home, args: ['clear'] });
    assert.strictEqual(r.status, 0, 'fail-open: clear on absent state still exits 0');
  } finally { h.cleanup(); }
});

test('phase.js unknown command exits 0 and writes no state', () => {
  const h = makeStatusHome();
  try {
    const r = runSL('phase.js', { home: h.home, args: ['bogus'] });
    assert.strictEqual(r.status, 0);
    assert.match(r.stderr, /unknown command/i);
    assert.ok(!fs.existsSync(statePath(h)), 'no state file created by an unknown command');
  } finally { h.cleanup(); }
});

test('phase.js advance/step/agents preserve prior fields (merge, not replace)', () => {
  const h = makeStatusHome();
  try {
    runSL('phase.js', { home: h.home, args: ['set', 'P7', 'ship it', '1', '4'] });
    runSL('phase.js', { home: h.home, args: ['advance'] });
    runSL('phase.js', { home: h.home, args: ['agents', '2'] });
    runSL('phase.js', { home: h.home, args: ['step', 'deploy'] });
    const s = readState(h);
    assert.strictEqual(s.code, 'P7');
    assert.strictEqual(s.desc, 'ship it');
    assert.strictEqual(s.done, 2);
    assert.strictEqual(s.total, 4);
    assert.strictEqual(s.agents, 2);
    assert.strictEqual(s.step, 'deploy');
  } finally { h.cleanup(); }
});
