// Run: node test/analytics.test.mjs (after pnpm build)
import assert from "node:assert/strict";
import { computeAnalytics, driveConsumption } from "../dist/dashboardData.js";
import { mergeLatest, readTelemetry } from "../dist/telemetry.js";

const t0 = Date.parse("2026-01-01T00:00:00Z");
// 58 kWh pack, 0.1 Ω: 100%→60% over 40 records, odometer +1 mi per record at 250 Wh/mi, alternating 0/100 A load.
const points = Array.from({ length: 41 }, (_, k) => {
  const soc = 100 - k, i = k % 2 ? 100 : 0;
  return { vin: "V", timestamp: new Date(t0 + k * 10_000), signals: {
    Soc: soc, EnergyRemaining: 0.58 * soc, Odometer: 1000 + k * (0.58 / 0.25),
    LifetimeEnergyUsed: 100 + 0.58 * k, PackVoltage: 360 - 0.1 * i, PackCurrent: i, BrickVoltageMax: 3.3, BrickVoltageMin: 3.298 } };
});
const a = computeAnalytics(points);
assert.equal(a.capacityFromSocSwing.usableKwh, 58);
assert.ok(Math.abs(a.capacityFromSocSwing.bufferKwh) < 1e-9);
assert.equal(a.consumption.whPerMile, 250);
assert.equal(a.packResistance.milliohms, 100);
assert.equal(a.brickSpreadMv.max, 2);

const merged = mergeLatest([{ vin: "V", timestamp: new Date(t0), signals: { Soc: 50, PackVoltage: 355 } }, { vin: "V", timestamp: new Date(t0 + 1), signals: { Soc: 49 } }]);
assert.deepEqual(merged.signals, { Soc: 49, PackVoltage: 355 });

// Imported history fills only gaps in earlier-listed (Fleet Telemetry) files.
const { writeFile, mkdtemp } = await import("node:fs/promises");
const dir = await mkdtemp((await import("node:os")).tmpdir() + "/tel-");
const rec = (min, source) => JSON.stringify({ vin: "VIN0000000000001", created_at: new Date(t0 + min * 60_000).toISOString(), data: { Soc: min, Source: source } });
await writeFile(`${dir}/fleet.jsonl`, [rec(0, "fleet"), rec(60, "fleet")].join("\n"));
await writeFile(`${dir}/import.jsonl`, [rec(10, "teslafi"), rec(30, "teslafi"), rec(31, "teslafi"), rec(55, "teslafi")].join("\n"));
const filled = await readTelemetry(undefined, undefined, `${dir}/fleet.jsonl,${dir}/import.jsonl`);
assert.deepEqual(filled.map(p => p.signals.Soc), [0, 30, 31, 60]);

// Field-level: a nearby imported point still supplies fields the fleet file lacks.
await writeFile(`${dir}/import2.jsonl`, JSON.stringify({ vin: "VIN0000000000001", created_at: new Date(t0 + 5 * 60_000).toISOString(), data: { Soc: 99, EnergyRemaining: 30, Source: "tessie" } }));
const fieldFilled = await readTelemetry(undefined, undefined, `${dir}/fleet.jsonl,${dir}/import2.jsonl`);
assert.deepEqual(fieldFilled[1].signals, { EnergyRemaining: 30, Source: "tessie" });
// Driving-only consumption without LifetimeEnergyUsedDrive (Semi-only). Two drives: 3 kWh / 12 mi and 2 kWh / 8 mi
// = 250 Wh/mi. Parked HVAC/Sentry use (+1 kWh on LifetimeEnergyUsed) and a charge right after parking stay out.
const m = min => new Date(t0 + min * 60_000), pt = (min, signals) => ({ vin: "V", timestamp: m(min), signals });
const trip = [
  pt(0, { Gear: "ShiftStateP", EnergyRemaining: 50, Odometer: 1000, LifetimeEnergyUsed: 100, LifetimeEnergyGainedRegen: 10 }),
  pt(10, { Gear: "ShiftStateD" }), pt(15, { EnergyRemaining: 48.5, Odometer: 1006 }), pt(20, { EnergyRemaining: 47, Odometer: 1012, LifetimeEnergyGainedRegen: 10.5 }),
  pt(21, { Gear: "ShiftStateP", LifetimeEnergyUsed: 103 }),
  pt(30, { ChargeState: "Charging", EnergyRemaining: 49 }), pt(90, { EnergyRemaining: 55, LifetimeEnergyUsed: 104 }),
  pt(120, { Gear: "ShiftStateR" }), pt(121, { Gear: "ShiftStateD" }), pt(130, { EnergyRemaining: 53, Odometer: 1020, LifetimeEnergyGainedRegen: 11 }),
  pt(131, { Gear: "ShiftStateP", LifetimeEnergyUsed: 106 }),
];
assert.deepEqual(driveConsumption(trip), { kwh: 5, miles: 20, drives: 2, regenKwh: 1 });
const c = computeAnalytics(trip);
assert.equal(c.consumption.whPerMile, 250); assert.match(c.consumption.basis, /over 2 drive\(s\).*driving only/);
assert.equal(c.consumption.allInWhPerMile, 300, "all-in keeps parked use");
assert.equal(c.regenRecoveredPct, 16.7, "regen ÷ (net drive + regen) = 1 ÷ 6");
// Without Gear, VehicleSpeed defines the drive; plain Gear letters work too.
assert.deepEqual(driveConsumption(trip.map(p => ({ ...p, signals: Object.fromEntries(Object.entries(p.signals).map(([k, v]) => k === "Gear" ? ["VehicleSpeed", /[DR]$/.test(v) ? 30 : 0] : [k, v])) }))).kwh, 5);
assert.equal(driveConsumption(trip.map(p => ({ ...p, signals: { ...p.signals, ...(p.signals.Gear ? { Gear: p.signals.Gear.replace("ShiftState", "") } : {}) } }))).miles, 20);
assert.equal(driveConsumption(trip.slice(0, 2)), undefined, "an unfinished drive is not counted");
// A charge reported while Gear still reads D ends the drive; the energy it adds never offsets the drive.
const noPark = trip.filter(p => p.timestamp.valueOf() !== m(21).valueOf());
assert.deepEqual(driveConsumption(noPark), { kwh: 5, miles: 20, drives: 2, regenKwh: 1 });
console.log("analytics ok");
