import { readTelemetry } from "./telemetry.js";
import type { JsonPrimitive, TelemetryPoint } from "./types.js";

type Reading = { value: number | string | null; at: string | null; ageSeconds: number | null; live: boolean };
const MOTION_MAX_AGE_SECONDS = 15;
const fields = {
  soc: "Soc", range: "RatedRange", speed: "VehicleSpeed", gear: "Gear",
  voltage: "PackVoltage", current: "PackCurrent", temperatureMin: "ModuleTempMin",
  temperatureMax: "ModuleTempMax", outsideTemperature: "OutsideTemp", odometer: "Odometer",
  chargeLimit: "ChargeLimitSoc", charging: "ChargeState",
  tireFrontLeft: "TpmsPressureFl", tireFrontRight: "TpmsPressureFr",
  tireRearLeft: "TpmsPressureRl", tireRearRight: "TpmsPressureRr",
} as const;
const empty = (): Reading => ({ value: null, at: null, ageSeconds: null, live: false });

export function buildCluster(points: TelemetryPoint[], now = Date.now()) {
  if (new Set(points.map(point => point.vin)).size > 1) throw new Error("Select one vehicle for the cluster");
  const latest = new Map<string, { value: JsonPrimitive; at: number }>();
  let lastAt: number | undefined;
  for (const point of points) {
    const at = point.timestamp.valueOf();
    if (!Number.isFinite(at) || at > now) continue;
    if (lastAt === undefined || at > lastAt) lastAt = at;
    for (const key of point.invalidSignals || []) {
      if ((latest.get(key)?.at ?? -Infinity) <= at) latest.set(key, { value: null, at });
    }
    for (const [key, value] of Object.entries(point.signals)) {
      if ((latest.get(key)?.at ?? -Infinity) <= at) latest.set(key, { value, at });
    }
  }
  const readings: Record<string, Reading> = {};
  for (const [name, key] of Object.entries(fields)) {
    const sample = latest.get(key);
    if (!sample) { readings[name] = empty(); continue; }
    const ageSeconds = (now - sample.at) / 1000;
    const numeric = typeof sample.value === "number" && Number.isFinite(sample.value);
    let value: number | string | null = numeric ? sample.value as number : null;
    if (name === "gear" && typeof sample.value === "string") {
      const gears: Record<string, string> = { P: "P", R: "R", N: "N", D: "D", ShiftStateP: "P", ShiftStateR: "R", ShiftStateN: "N", ShiftStateD: "D", Park: "P", Reverse: "R", Neutral: "N", Drive: "D" };
      value = gears[sample.value] ?? null;
    }
    if (name === "charging" && typeof sample.value === "string") value = sample.value;
    if ((name === "soc" || name === "chargeLimit") && numeric && (Number(value) < 0 || Number(value) > 100)) value = null;
    if (name === "speed" && numeric && (Number(value) < 0 || Number(value) > 300)) value = null;
    const live = value !== null && ageSeconds <= MOTION_MAX_AGE_SECONDS;
    readings[name] = { value: (name === "speed" || name === "gear") && !live ? null : value, at: new Date(sample.at).toISOString(), ageSeconds, live };
  }
  const v = readings.voltage!, i = readings.current!;
  // Never multiply old voltage by newer current and call the result live power.
  readings.power = v.live && i.live && Math.abs(v.ageSeconds! - i.ageSeconds!) <= 10
    && typeof v.value === "number" && typeof i.value === "number"
    ? { value: v.value * i.value / 1000, at: i.at, ageSeconds: Math.max(v.ageSeconds!, i.ageSeconds!), live: true } : empty();
  return { generatedAt: new Date(now).toISOString(), latestAt: lastAt === undefined ? null : new Date(lastAt).toISOString(),
    ageSeconds: lastAt === undefined ? null : (now - lastAt) / 1000, fields: readings };
}

export async function getClusterSnapshot() {
  const configured = process.env.TESLA_CLUSTER_TELEMETRY_FILE?.trim() || process.env.TESLA_TELEMETRY_FILE?.split(",")[0]?.trim();
  if (!configured) throw new Error("Cluster telemetry file is not configured");
  // readTelemetry reuses its parse until the file changes.
  // ponytail: a growing file is fully re-parsed on each change; use an incremental reader if log growth makes this slow.
  return buildCluster(await readTelemetry(process.env.TESLA_CLUSTER_VIN?.trim() || undefined, undefined, configured));
}
