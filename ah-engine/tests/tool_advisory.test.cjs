// Focused tests of the shipped helper: state transitions, configured controls, fail-open and metrics.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../../plugins/anti-hall/engine/logic/lib/74-emit-dedupe.js'), 'utf8');
function fixture() {
  let now = 10000, writable = true, enabled = true, unreadable = false;
  const files = new Map(), metrics = [];
  const cfg = {
    'tool_advisory.profiles': { usage: { setting: 'usage.enabled', repeat: 'usage.repeat' } },
    'tool_advisory.key_prefix': 'tool:', 'emit_dedupe.state_dir': 'store', 'emit_dedupe.file_prefix': 'session',
    'emit_dedupe.reset_key': 'reset', 'emit_dedupe.stats_key': 'stats', 'emit_dedupe.session_safe_max': 64,
    'emit_dedupe.key_ttl_ms': 86400000, 'emit_dedupe.ms_per_second': 1000, 'waste.bytes_per_token': 4,
  };
  const context = vm.createContext({
    ah: { cfg: k => cfg[k], cfgNum: k => cfg[k], clock: { now: () => now },
      settings: { bool: k => k !== 'waste.sw_warn' && (k === 'emit_dedupe.sw_enabled' || enabled),
        num: k => k === 'usage.repeat' ? 2 : 20 },
      metric: (name, labels, by = 1) => metrics.push({ name, labels: Array.from(labels), by }),
      sha1: value => crypto.createHash('sha1').update(value).digest('hex'),
      state: { readText: rel => { if (unreadable) throw new Error("no absolute home directory"); return files.get(rel) ?? null; },
        writeAtomic: (rel, body) => { if (!writable) return false; files.set(rel, body); return true; } } },
    gk: { pruneStale() {} },
  });
  vm.runInContext(source, context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../plugins/anti-hall/engine/logic/lib/83-waste.js'), 'utf8'), context);
  return { emit: (facts, content = 'notice') => context.dedupe.advisory({ session_id: 's' }, 'usage', facts, content),
    advance: ms => now += ms, disable: () => enabled = false, failWrites: () => writable = false, failReads: () => unreadable = true, metrics };
}
test('ten identical tool advisories emit once and count nine saved events with the source', () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) assert.equal(f.emit('A'), i === 0);
  const events = f.metrics.filter(metric => metric.name === 'waste_events_total');
  assert.equal(events.length, 9);
  for (const metric of events) {
    assert.deepEqual(metric.labels, ['category', 'repeated_advisory', 'source', 'usage']);
    assert.equal(metric.by, 1);
  }
});
test('cooldown boundary and A to B to A transitions speak', () => {
  const f = fixture();
  assert.equal(f.emit('A'), true); f.advance(1999); assert.equal(f.emit('A'), false);
  f.advance(1); assert.equal(f.emit('A'), true);
  assert.equal(f.emit('B'), true); assert.equal(f.emit('A'), true);
  assert.equal(f.emit('ok', ''), false); assert.equal(f.emit('A'), true);
});
test('disabled behavior and failed persistence both speak', () => {
  const off = fixture(); off.disable(); assert.equal(off.emit('A'), true); assert.equal(off.emit('A'), true);
  const failed = fixture(); failed.failWrites(); assert.equal(failed.emit('A'), true); assert.equal(failed.emit('A'), true);
});

test('an unavailable state home fails open instead of losing protocol context', () => {
  const f = fixture(); f.failReads();
  assert.equal(f.emit('A'), true); assert.equal(f.emit('A'), true);
});
