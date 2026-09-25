import { mkdir, readFile, writeFile } from "node:fs/promises";
import { energySocFit } from "./soh.js";
import { dirname } from "node:path";
import { homedir } from "node:os";
import type { JsonObject, TelemetryPoint } from "./types.js";

export type BaselineKind = "as_new" | "observed";

export type EnergyBaseline = {
  vin: string;
  energyKwh: number;
  kind: BaselineKind;
  source: string;
  evidence: string;
  capturedAt: string;
};

export type HealthReferenceMetric = "energyKwh" | "capacityAh" | "ratedRange" | "apparentResistanceMilliohm";

export type HealthReference = {
  vin: string;
  metric: HealthReferenceMetric;
  value: number;
  unit: "kWh" | "Ah" | "mi" | "mΩ";
  kind: BaselineKind;
  source: string;
  evidence: string;
  capturedAt: string;
};

type BaselineStore = {
  baselines: Record<string, EnergyBaseline>;
  healthReferences?: Record<string, Partial<Record<HealthReferenceMetric, HealthReference>>>;
};

export type EnergyEstimate = {
  timestamp: string;
  stateOfChargePercent: number;
  nominalEnergyRemainingKwh: number;
  inferredNominalFullPackKwh: number;
};

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? path.replace("~", homedir()) : path;
}

function baselinePath(): string {
  return expandHome(process.env.TESLA_BASELINE_FILE?.trim() || "~/.config/tesla-battery-mcp/energy-baselines.json");
}

async function readStore(): Promise<BaselineStore> {
  try {
    const raw = await readFile(baselinePath(), "utf8");
    const parsed = JSON.parse(raw) as BaselineStore;
    return parsed && typeof parsed === "object" && parsed.baselines && typeof parsed.baselines === "object" ? parsed : { baselines: {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { baselines: {} };
    throw new Error(`Unable to read TESLA_BASELINE_FILE: ${(error as Error).message}`);
  }
}

async function writeStore(store: BaselineStore): Promise<void> {
  const target = baselinePath();
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[midpoint]! : (sorted[midpoint - 1]! + sorted[midpoint]!) / 2;
}

function standardDeviation(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

export function energyEstimates(points: TelemetryPoint[]): EnergyEstimate[] {
  return points.flatMap(point => {
    const soc = point.signals.Soc;
    const remaining = point.signals.EnergyRemaining;
    if (typeof soc !== "number" || typeof remaining !== "number" || !Number.isFinite(soc) || !Number.isFinite(remaining)) return [];
    if (soc <= 5 || soc > 100 || remaining <= 0) return [];
    const inferredNominalFullPackKwh = remaining / (soc / 100);
    if (!Number.isFinite(inferredNominalFullPackKwh) || inferredNominalFullPackKwh <= 0) return [];
    return [{ timestamp: point.timestamp.toISOString(), stateOfChargePercent: soc, nominalEnergyRemainingKwh: remaining, inferredNominalFullPackKwh }];
  });
}

export async function getBaseline(vin: string): Promise<EnergyBaseline | undefined> {
  return (await readStore()).baselines[vin];
}

export async function saveBaseline(input: Omit<EnergyBaseline, "capturedAt">): Promise<EnergyBaseline> {
  if (!Number.isFinite(input.energyKwh) || input.energyKwh <= 0) throw new Error("Baseline energy must be a positive number of kWh.");
  if (input.kind === "as_new" && !input.evidence.trim()) {
    throw new Error("An as-new baseline requires evidence, such as a manufacturer specification, a delivery-time capacity result, or an official test record.");
  }
  const store = await readStore();
  const baseline = { ...input, source: input.source.trim(), evidence: input.evidence.trim(), capturedAt: new Date().toISOString() };
  store.baselines[input.vin] = baseline;
  await writeStore(store);
  return baseline;
}

const metricUnits: Record<HealthReferenceMetric, HealthReference["unit"]> = {
  energyKwh: "kWh",
  capacityAh: "Ah",
  ratedRange: "mi",
  apparentResistanceMilliohm: "mΩ",
};

export async function getHealthReferences(vin: string): Promise<Partial<Record<HealthReferenceMetric, HealthReference>>> {
  const store = await readStore();
  const references = store.healthReferences?.[vin] || {};
  const energyBaseline = store.baselines[vin];
  if (!references.energyKwh && energyBaseline) {
    references.energyKwh = {
      vin,
      metric: "energyKwh",
      value: energyBaseline.energyKwh,
      unit: "kWh",
      kind: energyBaseline.kind,
      source: energyBaseline.source,
      evidence: energyBaseline.evidence,
      capturedAt: energyBaseline.capturedAt,
    };
  }
  return references;
}

export async function saveHealthReference(input: Omit<HealthReference, "unit" | "capturedAt">): Promise<HealthReference> {
  if (!Number.isFinite(input.value) || input.value <= 0) throw new Error("Health-reference value must be a positive number.");
  if (input.kind === "as_new" && !input.evidence.trim()) {
    throw new Error("An as-new reference requires evidence, such as a manufacturer specification, a delivery-time result, or an official test record.");
  }
  const store = await readStore();
  const reference: HealthReference = {
    ...input,
    unit: metricUnits[input.metric],
    source: input.source.trim(),
    evidence: input.evidence.trim(),
    capturedAt: new Date().toISOString(),
  };
  store.healthReferences = store.healthReferences || {};
  store.healthReferences[input.vin] = { ...(store.healthReferences[input.vin] || {}), [input.metric]: reference };
  if (input.metric === "energyKwh") {
    store.baselines[input.vin] = {
      vin: input.vin,
      energyKwh: input.value,
      kind: input.kind,
      source: input.source.trim(),
      evidence: input.evidence.trim(),
      capturedAt: reference.capturedAt,
    };
  }
  await writeStore(store);
  return reference;
}

export function assessEnergyRetention(vin: string, points: TelemetryPoint[], baseline?: EnergyBaseline): JsonObject {
  const estimates = energyEstimates(points);
  if (!estimates.length) {
    return {
      vin,
      status: "insufficient_telemetry",
      requiredSignals: ["Soc", "EnergyRemaining"],
      formula: "E_full,estimated = EnergyRemaining ÷ (Soc ÷ 100)",
      explanation: "Tesla documents EnergyRemaining as nominal pack energy (kWh) and Soc as usable state of charge (% of total capacity). No valid paired readings were found in the local telemetry window.",
    };
  }

  const energies = estimates.map(sample => sample.inferredNominalFullPackKwh);
  // EnergyRemaining ÷ Soc drifts with SOC because EnergyRemaining keeps ~2 kWh at 0% SOC. The fitted
  // slope (usable basis, matching a usable as-new reference) removes that offset; ratio median is fallback only.
  const fit = energySocFit(points);
  const swingOk = fit !== undefined && fit.socSpan >= 20;
  const currentEnergyKwh = swingOk ? fit.usableKwh : median(energies);
  const mean = energies.reduce((sum, value) => sum + value, 0) / energies.length;
  const coefficientOfVariationPercent = mean ? (standardDeviation(energies, mean) / mean) * 100 : null;
  const result: JsonObject = {
    vin,
    status: baseline?.kind === "as_new" ? "energy_based_soh_available" : baseline ? "relative_retention_since_observed_baseline" : "baseline_required",
    formula: {
      currentUsableFullPackEnergy: swingOk ? "100 × least-squares slope of EnergyRemaining vs Soc (removes the below-0% offset)" : "median(EnergyRemaining ÷ (Soc ÷ 100)) — FALLBACK, biased high by the below-0% offset; needs ≥20% SOC swing",
      capacityStateOfHealth: "100 × current nominal full-pack energy ÷ as-new reference energy",
      degradation: "100 − capacity state of health",
    },
    latestWindow: {
      qualifyingSamples: estimates.length,
      windowStart: estimates[0]!.timestamp,
      windowEnd: estimates.at(-1)!.timestamp,
      estimatedUsableFullPackEnergyKwh: currentEnergyKwh,
      ...(fit ? { fit: { bufferKwhAtZeroSoc: fit.bufferKwh, bufferInclusiveFullPackKwh: fit.usableKwh + fit.bufferKwh, rSquared: fit.rSquared, socSpanPercent: fit.socSpan } } : {}),
      ratioMedianKwh: median(energies),
      coefficientOfVariationPercent,
      samples: estimates.slice(-20),
    },
    dataRequirements: [
      "Uses Tesla Fleet Telemetry fields Soc and EnergyRemaining; live vehicle polling alone cannot provide historical confidence.",
      "EnergyRemaining is Tesla-documented nominal energy remaining, not a direct official Battery Health Test result.",
      "For a repeatable comparison, collect a sufficiently large telemetry window at comparable thermal and operating conditions.",
    ],
  };

  if (!baseline) {
    result.nextStep = "Record an as-new reference energy in kWh to calculate degradation since new. An observed baseline can only quantify change since that observation.";
    return result;
  }

  const stateOfHealthPercent = 100 * currentEnergyKwh / baseline.energyKwh;
  const degradationPercent = 100 - stateOfHealthPercent;
  result.reference = baseline;
  result.energyBasedStateOfHealthPercent = stateOfHealthPercent;
  result.energyBasedDegradationPercent = degradationPercent;
  result.interpretation = baseline.kind === "as_new"
    ? "This is capacity/energy-based SOH relative to the supplied as-new reference. A negative degradation result means the selected reference and present BMS estimate are not comparable; it is not evidence of battery improvement."
    : "This is relative energy retention since an observed baseline, not degradation since new. Replace it with an as-new reference to obtain a degradation calculation.";
  result.validation = "Tesla's on-screen Battery Health Test, when supported, is the vehicle maker's authoritative energy-retention assessment. Tesla does not document an API field that exposes its result, so this MCP cannot claim to reproduce it exactly.";
  return result;
}
