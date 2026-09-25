// Run: node test/dashboard.test.mjs (after pnpm build)
import assert from "node:assert/strict";
import { runInNewContext, Script } from "node:vm";
import { attentionItems, buildSeries, computeAnalytics, downsample } from "../dist/dashboardData.js";
import { dashboardHtml } from "../dist/dashboardPage.js";

// Downsampling keeps every extreme, both ends and time order, and never exceeds the cap.
const flat = Array.from({ length: 10_000 }, (_, k) => [k * 1000, 5 + (k % 7) * 0.01]);
flat[4321] = [4321 * 1000, 160]; flat[8765] = [8765 * 1000, -40];
const thin = downsample(flat, 600);
assert.ok(thin.length <= 600);
assert.deepEqual(thin[0], flat[0]); assert.deepEqual(thin.at(-1), flat.at(-1));
assert.ok(thin.some(p => p[1] === 160) && thin.some(p => p[1] === -40), "spikes survive");
assert.ok(thin.every((p, k) => k === 0 || p[0] > thin[k - 1][0]), "time order");
assert.equal(downsample(flat.slice(0, 50), 600).length, 50);

// A single 1-minute DC fast-charge peak in 90 days of 1-minute samples stays in the power series.
const t0 = Date.parse("2026-06-01T00:00:00Z");
const points = Array.from({ length: 90 * 1440 }, (_, k) => ({ vin: "V", timestamp: new Date(t0 + k * 60_000), signals: { PackVoltage: 350, PackCurrent: k === 50_000 ? 480 : 2 } }));
assert.equal(Math.max(...buildSeries(points).powerKw.map(p => p[1])), 168);

// Chemistry: LFP only once seen near full; nickel packs exceed 3.95 V per brick; otherwise undecided.
const chem = (brick, soc) => computeAnalytics([{ vin: "V", timestamp: new Date(t0), signals: { Soc: soc, BrickVoltageMax: brick, BrickVoltageMin: brick - 0.005 } }]).chemistry?.value;
assert.equal(chem(3.45, 100), "LFP");
assert.equal(chem(4.12, 90), "NCA/NMC");
assert.equal(chem(3.62, 40), undefined);

// Attention checks.
const now = Date.parse("2026-09-25T12:00:00Z"), iso = hoursAgo => new Date(now - hoursAgo * 3_600_000).toISOString();
const byId = items => Object.fromEntries(items.map(item => [item.id, item]));
let a = byId(attentionItems({ latestAt: iso(0.5), chemistry: "LFP", lastFullChargeAt: iso(72), brickSpreadMedianMv: 6, alerts: { rows: [{ name: "BMS_a066", time: iso(24 * 20), battery: true }] } }, now));
assert.equal(a.freshness.level, "ok");
assert.equal(a.fullCharge.level, "ok");
assert.equal(a.alerts.level, "ok", "battery alert older than 7 days is not flagged");
assert.equal(a.cellBalance.level, "ok");
assert.equal(a.sync, undefined, "no sync item when sync was not attempted");

const items = attentionItems({ latestAt: iso(50), syncResult: "sync failed: Command failed: telemetry.sh sync\ntelemetry.sh: line 6: TESLA_TELEMETRY_VPS: unset · 10 total", chemistry: "LFP", lastFullChargeAt: iso(24 * 10),
  brickSpreadMedianMv: 35, alerts: { rows: [{ name: "BMS_a066", text: "Charge limit reduced", time: iso(30), battery: true }, { name: "UI_a020", time: iso(2), battery: false }] } }, now);
a = byId(items);
assert.equal(a.freshness.level, "warn"); assert.match(a.freshness.title, /2 d old/);
assert.equal(a.sync.level, "warn"); assert.match(a.sync.detail, /^telemetry\.sh: line 6: TESLA_TELEMETRY_VPS: unset/);
assert.equal(a.fullCharge.level, "info"); assert.match(a.fullCharge.title, /10 d ago/);
assert.equal(a.alerts.level, "warn"); assert.match(a.alerts.detail, /BMS_a066 \(Charge limit reduced\)/);
assert.equal(a.cellBalance.level, "bad");
assert.equal(items[0].id, "cellBalance", "most severe first");
assert.equal(byId(attentionItems({ latestAt: iso(1), chemistry: "LFP", lastFullChargeAt: null }, now)).fullCharge.title, "No completed 100% charge in this window");
assert.equal(byId(attentionItems({ latestAt: iso(1), chemistry: "NCA/NMC", lastFullChargeAt: iso(24 * 30) }, now)).fullCharge, undefined, "weekly 100% advice is LFP-only");
assert.equal(byId(attentionItems({}, now)).freshness.level, "info");

// Page: nonce on the only script, script parses, and backslashes survive the template (String.raw).
const html = dashboardHtml("n0nce");
const scripts = [...html.matchAll(/<script nonce="n0nce">([\s\S]*?)<\/script>/g)].map(match => match[1]);
assert.equal((html.match(/<script/g) || []).length, scripts.length, "every script carries the nonce");
assert.equal(scripts.length, 2, "early theme script + page script");
scripts.forEach(code => new Script(code));
const js = scripts.at(-1);
assert.ok(js.includes("replace(/ to \\S+/,'')"));

// CSV export quotes text and defuses spreadsheet formulas.
const csv = runInNewContext(js.split("\n").find(line => line.startsWith("function csv(")) + ";csv");
assert.equal(csv([{ a: '=HYPERLINK("x")', b: -3, c: null, d: "Gurnee, IL" }], ["a", "b", "c", "d"]), '\ufeffa,b,c,d\r\n"\'=HYPERLINK(""x"")",-3,,"Gurnee, IL"\r\n');
console.log("dashboard ok");
