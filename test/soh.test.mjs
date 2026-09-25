// Run: node test/soh.test.mjs (after pnpm build)
import assert from "node:assert/strict";
import { estimateSoh } from "../dist/soh.js";

const at = k => new Date(Date.parse("2026-01-01T00:00:00Z") + k * 60_000);
// Full charge showing 252 mi against 272 mi new: 252/272 = 92.65%, σ ≈ 1% (SOC anchored at 100%).
const full = estimateSoh([{ vin: "V", timestamp: at(0), signals: { Soc: 100, RatedRange: 252 } }], { ratedRangeMi: 272 });
assert.equal(full.status, "available");
assert.equal(full.sohPercent, 92.65);
assert.ok(full.sigmaPercent > 0.4 && full.sigmaPercent < 0.9, String(full.sigmaPercent));
assert.equal(full.confidence, "high");

// Mid-SOC only: same capacity, but σ widens (flat LFP curve).
const mid = estimateSoh([{ vin: "V", timestamp: at(0), signals: { Soc: 48, RatedRange: 120.96 } }], { ratedRangeMi: 272 });
assert.equal(mid.sohPercent, 92.65);
assert.equal(mid.confidence, "low");

// Energy swing 100%→40% on a 55.8 kWh pack vs 60 kWh new = 93%, plus a range sample: fused estimate lies between.
const swing = Array.from({ length: 61 }, (_, k) => ({ vin: "V", timestamp: at(k), signals: { Soc: 100 - k, EnergyRemaining: 0.558 * (100 - k), RatedRange: 2.52 * (100 - k) } }));
const fused = estimateSoh(swing, { ratedRangeMi: 272, energyKwh: 60 });
const byMethod = Object.fromEntries(fused.methods.map(m => [m.method, m.sohPercent]));
assert.equal(byMethod.energy_swing, 93);
assert.equal(byMethod.rated_range, 92.65);
assert.ok(fused.sohPercent >= 92.65 && fused.sohPercent <= 93);
assert.equal(byMethod.energy_point, undefined);

assert.equal(estimateSoh(swing, {}).status, "insufficient_inputs");

// Real TeslaFi shape: EnergyRemaining = 0.5355·SOC + 1.9 kWh (buffer offset). Swing slope ignores the
// offset → 53.55/57.5 = 93.13%, cross-checks against range 252.7/272 = 92.9%.
const real = Array.from({ length: 55 }, (_, k) => { const soc = 100 - k; return { vin: "V", timestamp: at(k), signals: { Soc: soc, EnergyRemaining: 0.5355 * soc + 1.917, RatedRange: 2.527 * soc, ...(k === 0 ? { ChargeState: "Complete", ModuleTempMax: 30 } : {}) } }; });
const cautious = estimateSoh(real, { ratedRangeMi: 272, energyKwh: 57.5, energyKwhSigmaPct: 3 });
const sw = cautious.methods.find(m => m.method === "energy_swing");
assert.equal(sw.sohPercent, 93.13);
assert.equal(sw.usedInEstimate, true);
assert.match(sw.note, /cross-checked/);
assert.equal(sw.bufferKwh, 1.92);
assert.equal(sw.fullIncludingBufferKwh, 55.47);
assert.equal(cautious.nominalFullPackKwh.value, 55.47);
assert.equal(cautious.usableFullPackKwh, 53.55);
// Nominal method from EnergyRemaining at full: 55.47 / 59.4 = 93.38%, cross-checks against range.
const withNominal = estimateSoh(real, { ratedRangeMi: 272, energyKwh: 57.5, energyKwhSigmaPct: 3, nominalKwh: 59.4, nominalKwhSigmaPct: 3 });
const bn = withNominal.methods.find(m => m.method === "bms_nominal");
assert.equal(bn.sohPercent, 93.38);
assert.equal(bn.usedInEstimate, true);
// Car-reported NominalFullPackEnergyKwh takes precedence over the inferred value.
const carNom = estimateSoh([...real, { vin: "V", timestamp: at(99), signals: { NominalFullPackEnergyKwh: 56.2 } }], { ratedRangeMi: 272, nominalKwh: 60, nominalKwhSigmaPct: 3 });
assert.equal(carNom.nominalFullPackKwh.value, 56.2);
assert.match(carNom.nominalFullPackKwh.source, /NominalFullPackEnergyKwh/);
// Value decays while parked at "100%": median ignores the tail.
const parked = [252.7, 252.7, 252.2, 251.0, 248.2].map((mi, k) => ({ vin: "V", timestamp: at(k), signals: { Soc: 100, RatedRange: mi } }));
assert.equal(estimateSoh(parked, { ratedRangeMi: 272 }).methods[0].fullValue, 252.2);
assert.ok(!cautious.methods.some(m => m.method === "energy_point"));
// A mismatched reference (e.g. nominal 62.5 kWh as usable) is excluded.
const bad = estimateSoh(real, { ratedRangeMi: 272, energyKwh: 50, energyKwhSigmaPct: 3 });
assert.equal(bad.methods.find(m => m.method === "energy_swing").usedInEstimate, false);
assert.equal(bad.warnings.length, 1);

// User-reported 252 mi @ 100% beats mid-SOC telemetry and yields high confidence.
const midOnly = [{ vin: "V", timestamp: at(0), signals: { Soc: 48.19, RatedRange: 119.86 } }];
const withManual = estimateSoh(midOnly, { ratedRangeMi: 272 }, [{ ratedRangeMi: 252, soc: 100, at: "2026-09-24" }]);
assert.equal(withManual.sohPercent, 92.65);
assert.equal(withManual.confidence, "high");
// Full-charge events: only BMS-Complete, ≤40 °C events count; early-stopped and hot events are ignored.
const day = 86_400_000, base = Date.parse("2026-09-01T00:00:00Z");
const ev = (d, mi, state, temp) => [0, 5, 10].map(m => ({ vin: "V", timestamp: new Date(base + d * day + m * 60_000), signals: { Soc: 100, RatedRange: mi, EnergyRemaining: 55.9, ChargeState: state, ModuleTempMax: temp } }));
const evPts = [...ev(0, 252.2, "Complete", 31), ...ev(2, 252.0, "Complete", 30), ...ev(4, 248.5, "Stopped", 30), ...ev(6, 249.0, "Complete", 45), ...ev(8, 252.2, "Complete", 32)];
const evEst = estimateSoh(evPts, { ratedRangeMi: 272 });
const rr = evEst.methods.find(m => m.method === "rated_range");
assert.equal(rr.fullValue, 252.2);
assert.equal(rr.samples, 3);
assert.equal(evEst.fullChargeEvents.filter(e => e.qualified).length, 3);
assert.match(evEst.fullChargeEvents[2].reason, /Complete/);
assert.match(evEst.fullChargeEvents[3].reason, /°C/);
assert.ok(rr.sigmaPercent < 0.62, String(rr.sigmaPercent));
console.log("soh ok");
