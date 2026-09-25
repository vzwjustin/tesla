import assert from "node:assert/strict";
import { parseElmCanLine, decodeVerifiedModel3YCan, decodeExtendedModel3YCan } from "../dist/scanMyTesla.js";
import { capturePhases } from "../dist/serialCan.js";

// ATH1 ATS1 ATD1 format, spaced bytes.
const f = parseElmCanLine("401 8 01 00 10 83 20 83 30 83");
assert.equal(f.id, 0x401);
assert.equal(f.data.length, 8);
assert.equal(parseElmCanLine("BUFFER FULL"), undefined);
assert.equal(parseElmCanLine("401 8 01 00"), undefined); // truncated frame

// mux 1 = bricks 4..6; mux 0 missing stays null so indices survive.
const s = decodeVerifiedModel3YCan([f, parseElmCanLine("352 8 14 02 00 00 00 00 00 00")]);
assert.deepEqual(s.brickVoltagesV.map(v => v && +v.toFixed(4)), [null, null, null, 3.3552, 3.3568, 3.3584]);
assert.equal(s.brickVoltageMinIndex, 4);
assert.equal(s.nominalFullPackKwh.toFixed(1), "53.2");
// Extended signals. Vectors are hand-encoded from the model3dbc definitions, independent of the decoder's table.
const sig = lines => Object.fromEntries(decodeExtendedModel3YCan(lines.map(parseElmCanLine)).map(x => [x.signal, x]));
// 0x132: 350.00 V (0x88B8), smoothed current raw 1234 × −0.1 = −123.4 A, 90 min remaining at bit 48.
let x = sig(["132 8 B8 88 D2 04 00 00 5A 00"]);
assert.equal(x.BattVoltage132.value, 350); assert.equal(x.SmoothBattCurrent132.value, -123.4); assert.equal(x.ChargeHoursRemaining132.value, 90);
assert.equal(x.PackPower132.value, -43.19); assert.equal(x.PackPower132.unit, "kW");
// Signed: raw 0xFE0C = −500 → −500 × −0.1 = +50 A.
assert.equal(sig(["132 8 B8 88 0C FE 00 00 00 00"]).SmoothBattCurrent132.value, 50);
// 0x352: expected remaining 40.0 kWh at bit 22; buffer 2.5 kWh straddles bytes 6–7 (bit 55, 8 bits); full-charge flag bit 63.
x = sig(["352 8 14 02 00 64 00 00 80 8C"]);
assert.equal(x.BMS_expectedEnergyRemaining.value, 40); assert.equal(x.BMS_energyBuffer.value, 2.5); assert.equal(x.BMS_fullChargeComplete.value, 1); assert.equal(x.BMS_idealEnergyRemaining.value, 0);
assert.equal(decodeVerifiedModel3YCan([parseElmCanLine("352 8 14 02 00 64 00 00 80 8C")]).nominalFullPackKwh.toFixed(1), "53.2", "battery decode unchanged");
// 0x266 signed 11-bit ×0.5: 0x7C4 = −60 → −30 kW regen; the later frame wins.
assert.equal(sig(["266 8 C4 07 00 00 00 00 00 00"]).RearPower266.value, -30);
assert.equal(sig(["266 8 C4 07 00 00 00 00 00 00", "266 8 96 00 00 00 00 00 00 00"]).RearPower266.value, 75);
// 0x3D2 32-bit counters: 12,345.678 and 13,000.5 kWh. A 4-byte frame yields only the first.
x = sig(["3D2 8 4E 61 BC 00 34 5F C6 00"]);
assert.equal(x.TotalDischargeKWh3D2.value, 12345.678); assert.equal(x.TotalChargeKWh3D2.value, 13000.5);
x = sig(["3D2 4 4E 61 BC 00"]); assert.equal(x.TotalDischargeKWh3D2.value, 12345.678); assert.equal(x.TotalChargeKWh3D2, undefined);
// 0x2B4 is a 5-byte message: 12 V bus raw 348 × 0.0390625 = 13.59375 V, 25.0 A out → 340 W.
x = sig(["2B4 5 5C 01 00 FA 00"]);
assert.equal(x.PCS_dcdcLvBusVolt.value, 13.59375); assert.equal(x.PCS_dcdcLvBusVolt.unit, "V"); assert.equal(x.PCS_dcdcLvOutputCurrent.value, 25); assert.equal(x.DcdcOutputPower.value, 340);
// Rear inverter temps use offset −40 and are shown in °C.
x = sig(["315 8 5A 50 64 46 4B 32 3C 00"]);
assert.equal(x.RearTempStator315.value, 60); assert.equal(x.RearTempStator315.unit, "°C"); assert.equal(x.RearTempPctStator315.value, 24);
// Beginning-of-life energy on 0x292 is deliberately not decoded; unknown IDs are ignored.
assert.equal(sig(["292 8 FF FF FF FF FF FF FF FF"]).BattBeginningOfLifeEnergy292, undefined);
assert.deepEqual(sig(["7FF 8 00 00 00 00 00 00 00 00"]), {});

// Capture phases: battery profile unchanged; extended adds one 1 s window per further message ID.
assert.deepEqual(capturePhases(8), [["352", 1.6], ["332", 2.4], ["401", 4]]);
const ext = capturePhases(8, "extended");
assert.deepEqual(ext.slice(0, 3), capturePhases(8));
assert.deepEqual(ext.slice(3).map(p => p[0]).sort(), ["132", "252", "264", "266", "292", "2B4", "2D2", "312", "315", "3D2"]);
assert.ok(ext.slice(3).every(p => p[1] === 1));
console.log("can.test ok");
