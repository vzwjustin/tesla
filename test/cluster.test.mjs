import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCluster } from '../dist/clusterData.js';
import { readTelemetry } from '../dist/telemetry.js';
import { clusterHtml } from '../dist/clusterPage.js';
import { runInNewContext } from 'node:vm';
const now = Date.parse('2026-09-24T16:00:00Z');
const p = (age, signals, invalidSignals) => ({ vin: 'fixture-vehicle', timestamp: new Date(now - age * 1000), signals, invalidSignals });
let d = buildCluster([p(2, { Soc: 48, VehicleSpeed: 42, Gear: 'ShiftStateD', PackVoltage: 400, PackCurrent: -20 })], now);
assert.equal(d.fields.speed.value, 42);
assert.equal(d.fields.gear.value, 'D');
assert.equal(d.fields.power.value, -8);
d = buildCluster([p(20, { VehicleSpeed: 42, Gear: 'D', PackCurrent: 20, Soc: 48 }), p(0, { PackVoltage: 400 })], now);
assert.equal(d.fields.speed.value, null);
assert.equal(d.fields.gear.value, null);
assert.equal(d.fields.power.value, null);
assert.equal(d.fields.soc.value, 48);
assert.equal(d.fields.soc.live, false);
d = buildCluster([p(1, { VehicleSpeed: 10 }), p(0, {}, ['VehicleSpeed'])], now);
assert.equal(d.fields.speed.value, null);
assert.equal(buildCluster([p(-60, { VehicleSpeed: 99 })], now).fields.speed.value, null);
assert.equal(buildCluster([p(0, { VehicleSpeed: NaN, Soc: 101 })], now).fields.soc.value, null);
assert.equal(buildCluster([], now).latestAt, null);
assert.throws(() => buildCluster([p(0, {}), { ...p(0, {}), vin: 'another-vehicle' }], now));
const dir = await mkdtemp(join(tmpdir(), 'cluster-test-'));
try {
  const file = join(dir, 'telemetry.jsonl');
  await writeFile(file, JSON.stringify({ vin: 'fixture-vehicle', timestamp: new Date(now).toISOString(), data: { VehicleSpeed: '<invalid>', PackVoltage: null } }));
  const records = await readTelemetry(undefined, undefined, file);
  assert.deepEqual(records[0].invalidSignals.sort(), ['PackVoltage', 'VehicleSpeed']);
  assert.equal(buildCluster(records, now).fields.speed.value, null);
} finally { await rm(dir, { recursive: true, force: true }); }
// Run the actual embedded display script against a small DOM stub: cached motion must expire.
const elements = new Map(), events = new Map(), intervals = [];
const element = () => ({ textContent: '', style: {}, dataset: {}, attributes: {}, classList: { toggle() {} },
  setAttribute(k, v) { this.attributes[k] = v; }, addEventListener() {}, replaceChildren(...children) { this.children = children; } });
const document = { hidden: false, documentElement: { dataset: {} },
  getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
  createElement: element, addEventListener(k, fn) { events.set(k, fn); } };
let elapsed = 0, fail = false;
const snapshot = buildCluster([p(0, { VehicleSpeed: 42, Gear: 'D', PackVoltage: 400, PackCurrent: -20, Soc: 48 })], now);
const js = clusterHtml().match(/<script>([\s\S]*?)<\/script>/)[1];
runInNewContext(js, { document, performance: { now: () => elapsed }, AbortController,
  localStorage: { getItem() { return null; }, setItem() {} },
  fetch: async () => { if (fail) throw new Error('offline'); return { ok: true, json: async () => snapshot }; },
  setTimeout() { return 1; }, clearTimeout() {}, setInterval(fn, delay) { intervals.push({ fn, delay }); } });
await new Promise(setImmediate);
assert.equal(elements.get('speed').textContent, '42');
assert.equal(elements.get('power').textContent, '-8');
elapsed = 16000; intervals.find(i => i.delay === 500).fn();
assert.equal(elements.get('speed').textContent, '—');
assert.equal(elements.get('power').textContent, '—');
assert.equal(elements.get('soc').textContent, '48');
elapsed = 0; fail = true; intervals.find(i => i.delay === 2000).fn();
await new Promise(setImmediate);
assert.equal(elements.get('speed').textContent, '—');
assert.ok(elements.get('statusText').textContent.includes('offline'));
document.hidden = true; events.get('visibilitychange')();
assert.equal(elements.get('speed').textContent, '—');
console.log('Cluster backend and browser freshness/invalidation/offline checks passed');
