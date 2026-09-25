import assert from "node:assert/strict";
import { parseElmCanLine, decodeVerifiedModel3YCan } from "../dist/scanMyTesla.js";

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
console.log("can.test ok");
