// Run: node test/systems.test.mjs (after pnpm build)
import assert from "node:assert/strict";
import { enumLabel, systemFaults, vehicleSystems } from "../dist/vehicleSystems.js";
import { attentionItems, buildSeries } from "../dist/dashboardData.js";

// Enum values as Fleet Telemetry sends them (protos/vehicle_data.proto).
assert.equal(enumLabel("HvacPowerStateOverheatProtect"), "Overheat protect");
assert.equal(enumLabel("DriveInverterStateEnable"), "Enable");
assert.equal(enumLabel("HvilStatusOK"), "OK");
assert.equal(enumLabel("ShiftStateD"), "D");
assert.equal(enumLabel("BMSStateClearFault"), "Clear fault");
assert.equal(enumLabel("CabinOverheatProtectionModeStateFanOnly"), "Fan only");
assert.equal(enumLabel("Charging"), "Charging");

const now = Date.parse("2026-09-25T12:00:00Z"), at = minutesAgo => new Date(now - minutesAgo * 60_000);
const points = [
  { vin: "V", timestamp: at(600), signals: { VehicleSpeed: 44, DiTorqueActualR: 350, LongitudinalAcceleration: 1.96133, DiStatorTempR: 71.26 } },
  { vin: "V", timestamp: at(5), signals: { DiStateR: "DriveInverterStateStandby", DiStatorTempR: 31.04, Gear: "ShiftStateP", HvacPower: "HvacPowerStatePrecondition", HvacACEnabled: true,
    TpmsPressureFl: 2.9, TpmsPressureRl: 2.6, TpmsSoftWarnings: false, IsolationResistance: 4812, Hvil: "HvilStatusOK", NotEnoughPowerToHeat: false }, invalidSignals: ["InsideTemp"] },
];
const groups = vehicleSystems(points, now), byField = Object.fromEntries(groups.flatMap(g => g.readings).map(r => [r.field, r]));
assert.deepEqual(groups.map(g => g.id), ["driveUnit", "driving", "climate", "hv", "tires"]);
assert.equal(byField.DiStatorTempR.display, "31"); assert.equal(byField.DiStatorTempR.unit, "°C"); assert.equal(byField.DiStatorTempR.ageSeconds, 300, "latest value wins, with its own age");
assert.equal(byField.VehicleSpeed.ageSeconds, 36_000, "an old motion value keeps its old age");
assert.equal(byField.DiTorqueActualR.unit, undefined, "no unit where Tesla documents none");
assert.equal(byField.DiStateR.display, "Standby"); assert.equal(byField.Gear.display, "P"); assert.equal(byField.HvacPower.display, "Precondition");
assert.equal(byField.HvacACEnabled.display, "On"); assert.equal(byField.NotEnoughPowerToHeat.display, "No");
assert.equal(byField.LongitudinalAcceleration.display, "1.96"); assert.equal(byField.LongitudinalAcceleration.detail, "0.2 g");
assert.equal(byField.TpmsPressureFl.display, "42.1"); assert.equal(byField.TpmsPressureFl.unit, "psi"); assert.equal(byField.TpmsPressureFl.detail, "2.9 bar");
assert.equal(byField.IsolationResistance.display, "4,812"); assert.equal(byField.IsolationResistance.unit, "kΩ");
assert.equal(byField.InsideTemp.display, "invalid");
assert.deepEqual(vehicleSystems([{ vin: "V", timestamp: at(1), signals: { Soc: 50 } }], now), [], "no panels without system signals");

// Faults: only car-reported fault states and TPMS flags; ClearFault is a recovery state, not a fault.
assert.deepEqual(systemFaults(groups), { checked: 3, faults: [] });
const faulty = vehicleSystems([{ vin: "V", timestamp: at(2), signals: { DiStateR: "DriveInverterStateFault", BMSState: "BMSStateClearFault", Hvil: "HvilStatusFault", TpmsHardWarnings: true } }], now);
assert.deepEqual(systemFaults(faulty).faults.map(r => r.field), ["DiStateR", "Hvil", "TpmsHardWarnings"]);
const items = Object.fromEntries(attentionItems({ latestAt: at(2).toISOString(), systems: faulty }, now).map(i => [i.id, i]));
assert.equal(items.systemFaults.level, "bad"); assert.match(items.systemFaults.title, /3 faults/); assert.match(items.systemFaults.detail, /Rear inverter: Fault \(2 min ago\)/);
assert.equal(Object.fromEntries(attentionItems({ latestAt: at(2).toISOString(), systems: groups }, now).map(i => [i.id, i])).systemFaults.level, "ok");

// Systems chart series ride along with the telemetry series.
const series = buildSeries(points);
assert.deepEqual(series.statorR.map(p => p[1]), [71.26, 31.04]);
assert.deepEqual(series.tireRl.map(p => p[1]), [2.6]);
assert.deepEqual(series.statorF, []);
console.log("systems ok");
