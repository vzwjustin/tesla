// Run: node test/telemetry.test.mjs (after pnpm build)
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTelemetry } from "../dist/telemetry.js";

const dir = await mkdtemp(join(tmpdir(), "telemetry-cache-"));
const now = Date.now(), VIN = "VIN0000000000001";
const line = (minutesAgo, soc, vin = VIN) => JSON.stringify({ vin, created_at: new Date(now - minutesAgo * 60_000).toISOString(), data: { Soc: soc } }) + "\n";
try {
  const file = join(dir, "fleet.jsonl");
  await writeFile(file, line(120, 50) + line(30, 49) + line(10, 48));

  // A hit returns the same parsed points in a new array, so a caller cannot change what the next caller sees.
  const a = await readTelemetry(VIN, undefined, file), b = await readTelemetry(VIN, undefined, file);
  assert.equal(a.length, 3); assert.notEqual(a, b); assert.equal(a[0], b[0]);
  a.pop(); a.reverse();
  assert.deepEqual((await readTelemetry(VIN, undefined, file)).map(p => p.signals.Soc), [50, 49, 48]);

  // Lookback is applied per call, after the cache.
  assert.deepEqual((await readTelemetry(VIN, 1, file)).map(p => p.signals.Soc), [49, 48]);

  // Concurrent cold reads share one parse.
  const other = join(dir, "other.jsonl");
  await writeFile(other, line(5, 70));
  const [c1, c2] = await Promise.all([readTelemetry(VIN, undefined, other), readTelemetry(VIN, undefined, other)]);
  assert.equal(c1[0], c2[0]);

  // An append (size + mtime) invalidates.
  await appendFile(file, line(1, 47));
  const appended = await readTelemetry(VIN, undefined, file);
  assert.deepEqual(appended.map(p => p.signals.Soc), [50, 49, 48, 47]); assert.notEqual(appended[0], b[0]);

  // telemetry.sh sync replaces the file by rename: same size and mtime, new inode, still invalidates.
  // Whole-second mtimes make the two stamps identical except for the inode (Date-based utimes drops sub-ms digits).
  const second = new Date(Math.floor(now / 1000) * 1000 - 60_000), replacement = join(dir, "sync.tmp");
  await utimes(file, second, second);
  await readTelemetry(VIN, undefined, file);
  const before = await stat(file);
  await writeFile(replacement, line(120, 60) + line(30, 59) + line(10, 58) + line(1, 57));
  await utimes(replacement, second, second);
  await rename(replacement, file);
  const after = await stat(file);
  assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs); assert.notEqual(after.ino, before.ino);
  assert.deepEqual((await readTelemetry(VIN, undefined, file)).map(p => p.signals.Soc), [60, 59, 58, 57]);

  // An in-place rewrite of the same size is caught by mtime.
  await writeFile(file, line(120, 40) + line(30, 39) + line(10, 38) + line(1, 37));
  await utimes(file, new Date(), new Date(Date.now() + 5_000));
  assert.deepEqual((await readTelemetry(VIN, undefined, file)).map(p => p.signals.Soc), [40, 39, 38, 37]);

  // Entries are per VIN; the least recently used is evicted beyond four.
  const multi = join(dir, "multi.jsonl"), vins = ["VIN000000000000A", "VIN000000000000B", "VIN000000000000C", "VIN000000000000D", "VIN000000000000E"];
  await writeFile(multi, vins.map((vin, k) => line(k + 1, 10 + k, vin)).join(""));
  const first = {};
  for (const vin of vins.slice(0, 4)) first[vin] = (await readTelemetry(vin, undefined, multi))[0];
  assert.equal((await readTelemetry(vins[0], undefined, multi))[0], first[vins[0]], "hit refreshes recency");
  await readTelemetry(vins[4], undefined, multi);
  assert.equal((await readTelemetry(vins[0], undefined, multi))[0], first[vins[0]], "recently used entry kept");
  assert.notEqual((await readTelemetry(vins[1], undefined, multi))[0], first[vins[1]], "least recently used entry evicted");
  assert.equal((await readTelemetry(vins[1], undefined, multi))[0].signals.Soc, 11);

  // A failed read is reported on every call (a directory passes stat, then fails to read).
  const notAFile = join(dir, "folder.jsonl");
  await mkdir(notAFile);
  for (let k = 0; k < 2; k++) await assert.rejects(readTelemetry(VIN, undefined, notAFile), /Unable to read TESLA_TELEMETRY_FILE entry .*folder\.jsonl/);
  await assert.rejects(readTelemetry(VIN, undefined, join(dir, "missing.jsonl")), /Unable to read TESLA_TELEMETRY_FILE entry .*missing\.jsonl: ENOENT/);
} finally { await rm(dir, { recursive: true, force: true }); }
console.log("telemetry cache ok");
