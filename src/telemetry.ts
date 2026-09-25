import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import type { JsonObject, JsonPrimitive, JsonValue, TelemetryPoint } from "./types.js";

const SIGNAL_ALIASES: Record<string, string[]> = {
  Soc: ["Soc", "soc", "usable_battery_level"],
  BatteryLevel: ["BatteryLevel", "battery_level"],
  RatedRange: ["RatedRange", "rated_range", "battery_range"],
  EstBatteryRange: ["EstBatteryRange", "est_battery_range"],
  PackVoltage: ["PackVoltage", "pack_voltage"],
  PackCurrent: ["PackCurrent", "pack_current"],
  BrickVoltageMin: ["BrickVoltageMin", "brick_voltage_min"],
  BrickVoltageMax: ["BrickVoltageMax", "brick_voltage_max"],
  NumBrickVoltageMin: ["NumBrickVoltageMin", "num_brick_voltage_min"],
  NumBrickVoltageMax: ["NumBrickVoltageMax", "num_brick_voltage_max"],
  ModuleTempMin: ["ModuleTempMin", "module_temp_min"],
  ModuleTempMax: ["ModuleTempMax", "module_temp_max"],
  NumModuleTempMin: ["NumModuleTempMin", "num_module_temp_min"],
  NumModuleTempMax: ["NumModuleTempMax", "num_module_temp_max"],
  IsolationResistance: ["IsolationResistance", "isolation_resistance"],
  ChargeState: ["ChargeState", "charging_state"],
  ChargeLimitSoc: ["ChargeLimitSoc", "charge_limit_soc"],
  ChargerPower: ["ChargerPower", "charger_power"],
  ChargeAmps: ["ChargeAmps", "charger_actual_current", "charge_amps"],
  ChargerVoltage: ["ChargerVoltage", "charger_voltage"],
  TimeToFullCharge: ["TimeToFullCharge", "time_to_full_charge"],
  DcChargingPower: ["DcChargingPower", "DCChargingPower", "dc_charging_power"],
  AcChargingPower: ["AcChargingPower", "ACChargingPower", "ac_charging_power"],
  DcChargingEnergyIn: ["DcChargingEnergyIn", "DCChargingEnergyIn", "dc_charging_energy_in"],
  AcChargingEnergyIn: ["AcChargingEnergyIn", "ACChargingEnergyIn", "ac_charging_energy_in"],
  EnergyRemaining: ["EnergyRemaining", "energy_remaining"],
  LifetimeEnergyUsed: ["LifetimeEnergyUsed", "lifetime_energy_used"],
  Odometer: ["Odometer", "odometer"],
  BatteryHeaterOn: ["BatteryHeaterOn", "battery_heater_on"],
  DetailedChargeState: ["DetailedChargeState", "detailed_charge_state"],
  ChargerPhases: ["ChargerPhases", "charger_phases"],
};

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? path.replace("~", homedir()) : path;
}

function isPrimitive(value: JsonValue | undefined): value is JsonPrimitive {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function objectAt(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function firstObject(...candidates: Array<JsonValue | undefined>): JsonObject {
  for (const candidate of candidates) {
    const object = objectAt(candidate);
    if (object) return object;
  }
  return {};
}

function signalValue(record: JsonObject, aliases: string[]): JsonPrimitive | undefined {
  const containers = [record, objectAt(record.data), objectAt(record.vehicle_data), objectAt(record.payload), objectAt(record.response)].filter(Boolean) as JsonObject[];
  for (const container of containers) {
    for (const alias of aliases) {
      const value = container[alias];
      if (isPrimitive(value)) return value;
      const nested = objectAt(value);
      if (nested && isPrimitive(nested.value)) return nested.value;
    }
  }
  return undefined;
}

function parseTimestamp(record: JsonObject): Date | undefined {
  const raw = signalValue(record, ["timestamp", "ts", "time", "created_at", "CreatedAt"]);
  if (typeof raw === "number") {
    const millis = raw > 10_000_000_000 ? raw : raw * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.valueOf()) ? undefined : date;
  }
  if (typeof raw === "string") {
    const date = new Date(raw);
    return Number.isNaN(date.valueOf()) ? undefined : date;
  }
  return undefined;
}

function extractVin(record: JsonObject): string | undefined {
  const value = signalValue(record, ["vin", "VIN", "vehicle_vin", "vehicle_identification_number"]);
  return typeof value === "string" && value.length >= 11 ? value : undefined;
}

function toPoint(record: JsonObject): TelemetryPoint | undefined {
  const vin = extractVin(record);
  const timestamp = parseTimestamp(record);
  if (!vin || !timestamp) return undefined;

  const signals: Record<string, JsonPrimitive> = {};
  const invalidSignals: string[] = [];
  for (const [canonical, aliases] of Object.entries(SIGNAL_ALIASES)) {
    const value = signalValue(record, aliases);
    if (value === null || value === "<invalid>") invalidSignals.push(canonical);
    else if (value !== undefined) signals[canonical] = value;
  }
  // Pass through any extra fields the car streams (drive unit, HVAC, BMS...) under their Tesla names.
  const data = objectAt(record.data) || {};
  const aliased = new Set(Object.values(SIGNAL_ALIASES).flat());
  for (const [key, value] of Object.entries(data)) {
    if (["Vin", "CreatedAt", "IsResend"].includes(key) || aliased.has(key)) continue;
    if (value === null || value === "<invalid>") invalidSignals.push(key);
    else if (isPrimitive(value)) signals[key] = value;
  }
  return Object.keys(signals).length || invalidSignals.length
    ? { vin, timestamp, signals, ...(invalidSignals.length ? { invalidSignals } : {}) } : undefined;
}

export function aliasesFor(canonical: string): string[] {
  return SIGNAL_ALIASES[canonical] || [canonical];
}

// Parsed history is cached per (files, VIN, gap setting) and reused until any file's inode, size or mtime
// changes: an append, a rewrite, or telemetry.sh sync's atomic rename all invalidate it. Re-parsing a large
// JSONL file dominated every dashboard refresh and chart-range change. The cache holds full history, with
// gap-filling decided across all of it; the lookback is applied per call on a copy, so callers never alter
// the cache. Concurrent cold reads share one parse. Least recently used entries beyond CACHE_ENTRIES drop.
const CACHE_ENTRIES = 4;
const parseCache = new Map<string, { stamp: string; points: Promise<TelemetryPoint[]> }>();

export async function readTelemetry(vin?: string, lookbackHours?: number, configured = process.env.TESLA_TELEMETRY_FILE?.trim()): Promise<TelemetryPoint[]> {
  if (!configured) {
    throw new Error("TESLA_TELEMETRY_FILE is not configured. Brick/module extrema and history require a local decoded Tesla Fleet Telemetry JSONL file.");
  }
  const paths = configured.split(",").map(item => item.trim()).filter(Boolean);
  const gapMs = Number(process.env.TESLA_TELEMETRY_GAP_MINUTES || 15) * 60_000;
  const key = JSON.stringify([paths, vin ?? null, gapMs]);
  // Stat before reading: if a file changes mid-parse, the stored stamp is already stale and the next call re-parses.
  const stamp = (await Promise.all(paths.map(async path => {
    try {
      const info = await stat(expandHome(path));
      return `${info.ino}:${info.size}:${info.mtimeMs}`;
    } catch (error) {
      parseCache.delete(key);
      throw new Error(`Unable to read TESLA_TELEMETRY_FILE entry ${path}: ${(error as Error).message}`);
    }
  }))).join("|");
  let entry = parseCache.get(key);
  if (entry?.stamp !== stamp) {
    const fresh = { stamp, points: parseTelemetry(paths, vin, gapMs) };
    fresh.points.catch(() => { if (parseCache.get(key) === fresh) parseCache.delete(key); });
    entry = fresh;
  }
  parseCache.delete(key);
  parseCache.set(key, entry);
  for (const oldest of parseCache.keys()) { if (parseCache.size <= CACHE_ENTRIES) break; parseCache.delete(oldest); }
  const points = await entry.points;
  const after = lookbackHours ? Date.now() - lookbackHours * 3_600_000 : 0;
  return after ? points.filter(point => point.timestamp.valueOf() >= after) : points.slice();
}

// Comma-separated: the live Fleet Telemetry file first, then imported history (e.g. TeslaFi/Tessie export).
// Imported files only fill gaps, per field: an imported signal is kept only where no earlier-listed
// file reported that same field nearby. Fleet Telemetry is change-based, so fields go quiet independently.
async function parseTelemetry(paths: string[], vin: string | undefined, gapMs: number): Promise<TelemetryPoint[]> {
  const points: TelemetryPoint[] = [];
  for (const path of paths) {
    let raw: string;
    try {
      raw = await readFile(expandHome(path), "utf8");
    } catch (error) {
      throw new Error(`Unable to read TESLA_TELEMETRY_FILE entry ${path}: ${(error as Error).message}`);
    }
    const covered = new Map<string, number[]>();
    for (const point of points) {
      for (const field of Object.keys(point.signals)) {
        const times = covered.get(field) ?? [];
        times.push(point.timestamp.valueOf());
        covered.set(field, times);
      }
    }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as JsonObject;
        const point = toPoint(parsed);
        if (!point || (vin && point.vin !== vin)) continue;
        const at = point.timestamp.valueOf();
        const fields = Object.keys(point.signals).filter(field => field !== "Source");
        const missing = fields.filter(field => !nearAny(covered.get(field) ?? [], at, gapMs));
        if (fields.length && !missing.length) continue;
        if (missing.length < fields.length) {
          point.signals = Object.fromEntries(Object.entries(point.signals).filter(([field]) => field === "Source" || missing.includes(field)));
        }
        points.push(point);
      } catch {
        // Non-JSON lines are safely ignored. Tesla reference logger output can coexist with JSON records.
      }
    }
    points.sort((a, b) => a.timestamp.valueOf() - b.timestamp.valueOf());
  }
  return points;
}

// True when sorted `times` has an entry within `windowMs` of `at` (binary search).
export function nearAny(times: number[], at: number, windowMs: number): boolean {
  let low = 0, high = times.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (times[mid]! < at) low = mid + 1; else high = mid;
  }
  return (low < times.length && times[low]! - at <= windowMs) || (low > 0 && at - times[low - 1]! <= windowMs);
}

// Vehicles push only changed fields, so the newest record alone is sparse.
// Carry each signal's last reported value forward onto the newest timestamp.
export function mergeLatest(points: TelemetryPoint[]): TelemetryPoint | undefined {
  const last = points.at(-1);
  return last && { ...last, signals: Object.assign({}, ...points.map(point => point.signals)) };
}

export async function latestTelemetry(vin?: string): Promise<TelemetryPoint | undefined> {
  return mergeLatest(await readTelemetry(vin));
}
