import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

export type BmsSourceKind = "scanmytesla_export" | "teslalogger_export" | "direct_can_capture";

export type BmsDiagnosticSnapshot = {
  source: BmsSourceKind;
  timestamp?: string;
  nominalFullPackKwh?: number;
  nominalEnergyRemainingKwh?: number;
  usableFullPackKwh?: number;
  fullPackWhenNewKwh?: number;
  brickVoltageMinV?: number;
  brickVoltageMaxV?: number;
  brickVoltageSpreadMv?: number;
  brickVoltageMinIndex?: number;
  brickVoltageMaxIndex?: number;
  brickVoltagesV?: Array<number | null>; // index = brick number − 1; null = group not seen in capture
  moduleTemperatureMinC?: number;
  moduleTemperatureMaxC?: number;
  moduleTemperatureSpreadC?: number;
  rawFields: Record<string, string | number | boolean | null>;
  provenance: string[];
};

export type CanFrame = { id: number; data: Uint8Array; receivedAt: string; raw: string };

type FlatRecord = Record<string, string | number | boolean | null>;

function numberFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = value.trim().replace(/\s/g, "").replace(/,(?=\d{1,3}(?:\D|$))/g, ".");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function flatten(value: unknown, prefix = "", output: FlatRecord = {}): FlatRecord {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (prefix) output[prefix] = value;
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${prefix}${prefix ? "_" : ""}${index}`, output));
    return output;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) flatten(nested, `${prefix}${prefix ? "_" : ""}${key}`, output);
  }
  return output;
}

function latestRecord(records: FlatRecord[]): FlatRecord {
  if (!records.length) throw new Error("No diagnostic records were found in the supplied file.");
  const timestampKeys = ["timestamp", "time", "datetime", "date"];
  return [...records].sort((a, b) => {
    const value = (record: FlatRecord) => {
      const key = Object.keys(record).find(candidate => timestampKeys.includes(normalizeKey(candidate)));
      return key && typeof record[key] === "string" ? new Date(record[key] as string).valueOf() || 0 : 0;
    };
    return value(a) - value(b);
  }).at(-1)!;
}

function parseCsv(text: string): FlatRecord[] {
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) return [];
  const delimiter = lines[0]!.includes(";") && !lines[0]!.includes(",") ? ";" : ",";
  const splitLine = (line: string) => {
    const output: string[] = [];
    let current = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index]!;
      if (character === '"') {
        if (quoted && line[index + 1] === '"') { current += '"'; index += 1; } else quoted = !quoted;
      } else if (character === delimiter && !quoted) { output.push(current.trim()); current = ""; } else current += character;
    }
    output.push(current.trim());
    return output;
  };
  const headers = splitLine(lines[0]!);
  return lines.slice(1).map(line => Object.fromEntries(splitLine(line).map((value, index) => [headers[index] || `column_${index}`, value])));
}

function toSnapshot(record: FlatRecord, source: BmsSourceKind, provenance: string[]): BmsDiagnosticSnapshot {
  const indexed = Object.fromEntries(Object.entries(record).map(([key, value]) => [normalizeKey(key), value]));
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = numberFrom(indexed[normalizeKey(key)]);
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const timestamp = Object.entries(indexed).find(([key]) => ["timestamp", "time", "datetime", "date"].includes(key))?.[1];
  const nominalFullPackKwh = pick("nominal full pack", "nominal full pack energy", "nominalfullpack", "bms nominal full pack", "bms nominal full pack energy");
  const nominalEnergyRemainingKwh = pick("nominal energy remaining", "nominal remaining", "bms nominal energy remaining");
  const usableFullPackKwh = pick("usable full pack", "usable full pack energy", "bms usable full pack");
  const fullPackWhenNewKwh = pick("full pack when new", "full pack new", "bms full pack when new");
  const brickVoltageMinV = pick("brick voltage min", "cell voltage min", "min cell voltage", "bms brick voltage min");
  const brickVoltageMaxV = pick("brick voltage max", "cell voltage max", "max cell voltage", "bms brick voltage max");
  const moduleTemperatureMinC = pick("module temp min", "cell temp min", "battery min temp", "bms module temp min");
  const moduleTemperatureMaxC = pick("module temp max", "cell temp max", "battery max temp", "bms module temp max");
  const brickVoltageSpreadMv = brickVoltageMinV !== undefined && brickVoltageMaxV !== undefined ? (brickVoltageMaxV - brickVoltageMinV) * 1000 : pick("cell imbalance", "brick voltage spread");
  const moduleTemperatureSpreadC = moduleTemperatureMinC !== undefined && moduleTemperatureMaxC !== undefined ? moduleTemperatureMaxC - moduleTemperatureMinC : undefined;
  return {
    source,
    ...(typeof timestamp === "string" ? { timestamp } : {}),
    nominalFullPackKwh,
    nominalEnergyRemainingKwh,
    usableFullPackKwh,
    fullPackWhenNewKwh,
    brickVoltageMinV,
    brickVoltageMaxV,
    brickVoltageSpreadMv,
    moduleTemperatureMinC,
    moduleTemperatureMaxC,
    moduleTemperatureSpreadC,
    rawFields: record,
    provenance,
  };
}

export async function importBmsDiagnosticFile(filePath: string, source: Exclude<BmsSourceKind, "direct_can_capture">): Promise<BmsDiagnosticSnapshot> {
  const absolute = resolve(filePath);
  const text = await readFile(absolute, "utf8");
  let records: FlatRecord[] = [];
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Diagnostic export file is empty.");
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    records = entries.map(entry => flatten(entry));
  } else {
    records = parseCsv(trimmed);
  }
  const snapshot = toSnapshot(latestRecord(records), source, [
    `Imported on demand from ${basename(absolute)}.`,
    source === "scanmytesla_export"
      ? "File is treated as a Scan My Tesla export. Unknown columns are preserved in rawFields instead of guessed."
      : "File is treated as a TeslaLogger diagnostic export. The documented Scan My Tesla → TeslaLogger route uses an app token and HTTPS relay; this MCP reads only your local export.",
    "FullPackWhenNew is retained as evidence but excluded from the constrained calibration formula because Scan My Tesla removed its prior degradation calculation as incorrect.",
  ]);
  if (snapshot.nominalFullPackKwh === undefined && snapshot.brickVoltageSpreadMv === undefined) {
    throw new Error("No recognized BMS capacity or brick-envelope fields were found. Export column names are included in rawFields only when at least one recognized field is present.");
  }
  return snapshot;
}

function extractLittleEndian(data: Uint8Array, startBit: number, length: number): number {
  let value = 0;
  for (let offset = 0; offset < length; offset += 1) {
    const absoluteBit = startBit + offset;
    const byte = data[Math.floor(absoluteBit / 8)];
    if (byte !== undefined && ((byte >> (absoluteBit % 8)) & 1)) value += 2 ** offset;
  }
  return value;
}

function frameDataFromHex(hex: string): Uint8Array | undefined {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 || hex.length > 16) return undefined;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

export function parseElmCanLine(line: string): CanFrame | undefined {
  // ATH1 ATS1 ATD1 output: "352 8 AB CD EF 01 23 45 67 89" (bytes may also arrive unspaced).
  const match = line.trim().match(/^([0-9A-Fa-f]{3}|[0-9A-Fa-f]{8})\s+([0-8])\s+((?:[0-9A-Fa-f]{2}\s*){1,8})$/);
  if (!match) return undefined;
  const data = frameDataFromHex(match[3]!.replace(/\s+/g, ""));
  if (!data || data.length < Number(match[2])) return undefined;
  return { id: Number.parseInt(match[1]!, 16), data: data.slice(0, Number(match[2])), receivedAt: new Date().toISOString(), raw: line.trim() };
}

export function decodeVerifiedModel3YCan(frames: CanFrame[]): BmsDiagnosticSnapshot {
  let nominalFullPackKwh: number | undefined;
  let nominalEnergyRemainingKwh: number | undefined;
  let brickVoltageMinV: number | undefined;
  let brickVoltageMaxV: number | undefined;
  let brickVoltageMinIndex: number | undefined;
  let brickVoltageMaxIndex: number | undefined;
  let moduleTemperatureMinC: number | undefined;
  let moduleTemperatureMaxC: number | undefined;
  const bricks: number[] = [];

  for (const frame of frames) {
    if (frame.id === 0x352 && frame.data.length >= 3) {
      nominalFullPackKwh = extractLittleEndian(frame.data, 0, 11) * 0.1;
      nominalEnergyRemainingKwh = extractLittleEndian(frame.data, 11, 11) * 0.1;
    }
    if (frame.id === 0x332 && frame.data.length >= 6) {
      const multiplexer = extractLittleEndian(frame.data, 0, 2);
      if (multiplexer === 1) {
        brickVoltageMaxV = extractLittleEndian(frame.data, 2, 12) * 0.002;
        brickVoltageMinV = extractLittleEndian(frame.data, 16, 12) * 0.002;
        brickVoltageMaxIndex = extractLittleEndian(frame.data, 32, 7) + 1;
        brickVoltageMinIndex = extractLittleEndian(frame.data, 40, 7) + 1;
      } else if (multiplexer === 0) {
        moduleTemperatureMaxC = extractLittleEndian(frame.data, 16, 8) * 0.5 - 40;
        moduleTemperatureMinC = extractLittleEndian(frame.data, 24, 8) * 0.5 - 40;
      }
    }
    if (frame.id === 0x401 && frame.data.length >= 8) {
      const group = extractLittleEndian(frame.data, 0, 8);
      for (let offset = 0; offset < 3; offset += 1) {
        const value = extractLittleEndian(frame.data, 16 + offset * 16, 16) * 0.0001;
        if (value > 1 && value < 6) bricks[group * 3 + offset] = value;
      }
    }
  }
  if (bricks.length) {
    const validBricks = bricks.filter((value): value is number => typeof value === "number");
    if (validBricks.length) {
      brickVoltageMinV = Math.min(...validBricks);
      brickVoltageMaxV = Math.max(...validBricks);
      brickVoltageMinIndex = bricks.indexOf(brickVoltageMinV) + 1;
      brickVoltageMaxIndex = bricks.indexOf(brickVoltageMaxV) + 1;
    }
  }
  return {
    source: "direct_can_capture",
    timestamp: frames.at(-1)?.receivedAt,
    nominalFullPackKwh,
    nominalEnergyRemainingKwh,
    brickVoltageMinV,
    brickVoltageMaxV,
    brickVoltageSpreadMv: brickVoltageMinV !== undefined && brickVoltageMaxV !== undefined ? (brickVoltageMaxV - brickVoltageMinV) * 1000 : undefined,
    brickVoltageMinIndex,
    brickVoltageMaxIndex,
    brickVoltagesV: Array.from(bricks, value => value ?? null),
    moduleTemperatureMinC,
    moduleTemperatureMaxC,
    moduleTemperatureSpreadC: moduleTemperatureMinC !== undefined && moduleTemperatureMaxC !== undefined ? moduleTemperatureMaxC - moduleTemperatureMinC : undefined,
    rawFields: { decodedFrameCount: frames.length, observedMessageIds: [...new Set(frames.map(frame => `0x${frame.id.toString(16).toUpperCase()}`))].sort().join(", ") },
    provenance: [
      "Direct passive CAN capture decoded with the MIT-licensed joshwardell/model3dbc Model 3/Y mappings: ID 0x352 energy, 0x332 extrema, and 0x401 brick-voltage groups.",
      "Tesla firmware changes can invalidate decoded signals. Compare values with the Scan My Tesla app before relying on them.",
      "No FullPackWhenNew mapping is used by this decoder; it is neither guessed nor used in constrained calibration.",
    ],
  };
}

export function constrainedBmsCalibration(snapshot: BmsDiagnosticSnapshot, reference: { value: number; kind: "as_new" | "observed"; source: string; evidence: string } | undefined, conditionsConfirmed: boolean, conditionNote?: string): Record<string, unknown> {
  const base = {
    model: "constrained_bms_nominal_energy_calibration",
    currentNominalFullPackKwh: snapshot.nominalFullPackKwh ?? null,
    reference: reference ?? null,
    conditionNote: conditionNote || null,
    excludedLegacyEvidence: snapshot.fullPackWhenNewKwh ?? null,
    formula: "100 × direct BMS Nominal Full Pack kWh ÷ evidence-backed reference kWh",
  };
  if (snapshot.nominalFullPackKwh === undefined) return { ...base, status: "bms_nominal_full_pack_unavailable" };
  if (!reference) return { ...base, status: "as_new_energy_reference_required" };
  if (reference.kind !== "as_new") return { ...base, status: "as_new_reference_required_observed_reference_is_not_sufficient" };
  if (!conditionsConfirmed) return { ...base, status: "user_confirmation_of_comparable_conditions_required" };
  const retentionPercent = 100 * snapshot.nominalFullPackKwh / reference.value;
  return {
    ...base,
    status: "constrained_calibration_available",
    retentionPercent,
    degradationPercent: 100 - retentionPercent,
    interpretation: "This uses a direct BMS nominal full-pack reading with an evidence-backed as-new reference and user-confirmed comparable conditions. It remains an auditable calibration result, not Tesla's proprietary Battery Health Test.",
    warning: "Scan My Tesla removed its former Full Pack When New ratio because it was proven incorrect. That value is never included in this calculation.",
  };
}
