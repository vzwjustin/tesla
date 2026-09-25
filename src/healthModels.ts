import type { HealthReference } from "./degradation.js";
import { assessEnergyRetention } from "./degradation.js";
import type { JsonObject, TelemetryPoint } from "./types.js";

export type HealthWeights = {
  energy: number;
  capacity: number;
  range: number;
  brick: number;
  thermal: number;
  resistance: number;
};

export type HealthModelOptions = {
  minSocSpanPercent: number;
  maxGapSeconds: number;
  minCurrentStepA: number;
  brickWarningMv?: number;
  brickCriticalMv?: number;
  thermalWarningC?: number;
  thermalCriticalC?: number;
  weights: HealthWeights;
};

export const defaultHealthModelOptions: HealthModelOptions = {
  minSocSpanPercent: 20,
  maxGapSeconds: 300,
  minCurrentStepA: 20,
  weights: { energy: 1, capacity: 1, range: 1, brick: 1, thermal: 1, resistance: 1 },
};

type NumericSample = { at: Date; value: number };
type TimedPair = { at: Date; soc: number; current: number; voltage?: number };

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function arithmeticMean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value: number, lower = 0, upper = 100): number {
  return Math.max(lower, Math.min(upper, value));
}

function statusFor(value: number, warning?: number, critical?: number): string {
  if (critical !== undefined && value >= critical) return "critical_threshold_reached";
  if (warning !== undefined && value >= warning) return "warning_threshold_reached";
  if (warning === undefined && critical === undefined) return "raw_metric_only_thresholds_not_set";
  return "within_user_threshold";
}

function validNumeric(point: TelemetryPoint, key: string): number | undefined {
  const value = point.signals[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function referenceFor(references: Partial<Record<HealthReference["metric"], HealthReference>>, metric: HealthReference["metric"]): HealthReference | undefined {
  return references[metric];
}

function retentionResult(model: string, current: number, reference: HealthReference | undefined, unit: string, currentFormula: string): JsonObject {
  const common: JsonObject = {
    model,
    metricUnit: unit,
    currentEstimate: current,
    currentFormula,
    reference: reference ?? null,
  };
  if (!reference) {
    return {
      ...common,
      status: "reference_required",
      nextStep: `Set an evidence-backed ${unit} reference through tesla_battery_set_health_reference before calculating retention or degradation.`,
    };
  }
  const retentionPercent = 100 * current / reference.value;
  return {
    ...common,
    status: reference.kind === "as_new" ? "retention_since_new_available" : "retention_since_observed_reference",
    retentionPercent,
    degradationPercent: 100 - retentionPercent,
    interpretation: reference.kind === "as_new"
      ? "This is a relative retention calculation against the supplied as-new reference. It is not Tesla's proprietary Battery Health Test."
      : "This measures change since the supplied observed reference, not degradation since new.",
  };
}

function selectCapacityWindow(points: TelemetryPoint[], options: HealthModelOptions): { samples: TimedPair[]; direction: "charge" | "discharge"; socSpan: number; chargeAh: number; energyKwh?: number } | undefined {
  const pairs = points.flatMap(point => {
    const soc = validNumeric(point, "Soc");
    const current = validNumeric(point, "PackCurrent");
    if (soc === undefined || current === undefined || soc < 0 || soc > 100) return [];
    return [{ at: point.timestamp, soc, current, voltage: validNumeric(point, "PackVoltage") }];
  });
  if (pairs.length < 2) return undefined;

  let best: { samples: TimedPair[]; direction: "charge" | "discharge"; socSpan: number; chargeAh: number; energyKwh?: number } | undefined;
  for (const direction of ["charge", "discharge"] as const) {
    const compatible: TimedPair[] = [pairs[0]!];
    for (let index = 1; index < pairs.length; index += 1) {
      const previous = compatible.at(-1)!;
      const candidate = pairs[index]!;
      const deltaSeconds = (candidate.at.valueOf() - previous.at.valueOf()) / 1000;
      const deltaSoc = candidate.soc - previous.soc;
      const isExpectedDirection = direction === "charge" ? deltaSoc >= 0 : deltaSoc <= 0;
      if (deltaSeconds > 0 && deltaSeconds <= options.maxGapSeconds && isExpectedDirection) compatible.push(candidate);
    }
    if (compatible.length < 2) continue;

    let chargeAh = 0;
    let energyKwh = 0;
    let integratedEnergy = true;
    for (let index = 1; index < compatible.length; index += 1) {
      const previous = compatible[index - 1]!;
      const current = compatible[index]!;
      const deltaHours = (current.at.valueOf() - previous.at.valueOf()) / 3_600_000;
      chargeAh += ((Math.abs(previous.current) + Math.abs(current.current)) / 2) * deltaHours;
      if (previous.voltage === undefined || current.voltage === undefined) {
        integratedEnergy = false;
      } else {
        const previousPowerKw = Math.abs(previous.current * previous.voltage) / 1000;
        const currentPowerKw = Math.abs(current.current * current.voltage) / 1000;
        energyKwh += ((previousPowerKw + currentPowerKw) / 2) * deltaHours;
      }
    }
    const socSpan = Math.abs(compatible.at(-1)!.soc - compatible[0]!.soc);
    if (socSpan < options.minSocSpanPercent || chargeAh <= 0) continue;
    const candidate = { samples: compatible, direction, socSpan, chargeAh, ...(integratedEnergy ? { energyKwh } : {}) };
    if (!best || candidate.socSpan > best.socSpan) best = candidate;
  }
  return best;
}

export function assessCapacityRetention(points: TelemetryPoint[], reference: HealthReference | undefined, options: HealthModelOptions): JsonObject {
  const window = selectCapacityWindow(points, options);
  if (!window) {
    return {
      model: "capacity_coulomb_counting",
      status: "insufficient_telemetry",
      formula: "Q_full,estimated = (∫ |PackCurrent| dt) ÷ (ΔSoc ÷ 100)",
      requirements: ["Paired Tesla Fleet Telemetry PackCurrent and Soc readings.", `A monotonic charge or discharge window spanning at least ${options.minSocSpanPercent}% SOC.`, `No record gaps over ${options.maxGapSeconds} seconds.`],
    };
  }
  const fullCapacityAh = window.chargeAh / (window.socSpan / 100);
  const result = retentionResult("capacity_coulomb_counting", fullCapacityAh, reference, "Ah", "Q_full,estimated = integrated absolute pack current ÷ observed SOC fraction");
  return {
    ...result,
    testWindow: {
      direction: window.direction,
      start: window.samples[0]!.at.toISOString(),
      end: window.samples.at(-1)!.at.toISOString(),
      samples: window.samples.length,
      observedSocSpanPercent: window.socSpan,
      integratedChargeAh: window.chargeAh,
    },
    limitations: [
      "This is an integrated-current estimate, not a laboratory capacity test.",
      "Tesla does not document PackCurrent sign convention in the Fleet Telemetry field description; absolute current is used and a monotonic SOC window is required.",
      "Thermal conditions, BMS SOC calibration, auxiliary loads, telemetry sampling gaps, and partial-SOC scaling can affect the result.",
    ],
  };
}

export function assessRangeRetention(points: TelemetryPoint[], reference: HealthReference | undefined): JsonObject {
  const estimates: NumericSample[] = points.flatMap(point => {
    const soc = validNumeric(point, "Soc");
    const range = validNumeric(point, "RatedRange");
    if (soc === undefined || range === undefined || soc <= 5 || soc > 100 || range <= 0) return [];
    return [{ at: point.timestamp, value: range / (soc / 100) }];
  });
  if (!estimates.length) {
    return {
      model: "rated_range_retention",
      status: "insufficient_telemetry",
      formula: "Range_100,estimated = RatedRange ÷ (Soc ÷ 100)",
      requirements: ["Tesla Fleet Telemetry RatedRange and Soc in the same record."],
      limitation: "Estimated driving range is not a direct usable-capacity measurement and is not a substitute for an energy-based SOH result.",
    };
  }
  // LFP SOC is only well anchored near full; use the samples within 2 points of the highest SOC seen.
  const socAt = new Map(points.map(p => [p.timestamp, validNumeric(p, "Soc")]));
  const socOf = (at: Date) => socAt.get(at)!;
  const top = Math.max(...estimates.map(sample => socOf(sample.at)));
  const nearFull = estimates.filter(sample => top >= 99.5 ? socOf(sample.at) >= 99.5 : top - socOf(sample.at) <= 2);
  const currentRange = median(nearFull.map(sample => sample.value));
  const result = retentionResult("rated_range_retention", currentRange, reference, "mi", `median(RatedRange ÷ (Soc ÷ 100)) over ${nearFull.length} samples ${top >= 99.5 ? "at ≥99.5% SOC (completed full charge)" : `within 2 points of the highest SOC (${top}%)`}`);
  return {
    ...result,
    qualifyingSamples: estimates.length,
    windowStart: estimates[0]!.at.toISOString(),
    windowEnd: estimates.at(-1)!.at.toISOString(),
    limitation: "This is a range-retention proxy. Tesla's RatedRange can be recalibrated and is not a direct all-conditions capacity measurement.",
  };
}

export function assessBrickEnvelope(points: TelemetryPoint[], options: HealthModelOptions): JsonObject {
  const latest = points.at(-1);
  const minimum = latest ? validNumeric(latest, "BrickVoltageMin") : undefined;
  const maximum = latest ? validNumeric(latest, "BrickVoltageMax") : undefined;
  if (minimum === undefined || maximum === undefined) {
    return { model: "brick_voltage_imbalance", status: "insufficient_telemetry", requiredSignals: ["BrickVoltageMin", "BrickVoltageMax"] };
  }
  const spreadMv = (maximum - minimum) * 1000;
  return {
    model: "brick_voltage_imbalance",
    status: statusFor(spreadMv, options.brickWarningMv, options.brickCriticalMv),
    formula: "BrickVoltageSpread = (BrickVoltageMax − BrickVoltageMin) × 1000",
    observedAt: latest!.timestamp.toISOString(),
    minimumVoltageV: minimum,
    maximumVoltageV: maximum,
    spreadMv,
    minimumBrickNumber: validNumeric(latest!, "NumBrickVoltageMin") ?? null,
    maximumBrickNumber: validNumeric(latest!, "NumBrickVoltageMax") ?? null,
    adjustableThresholdsMv: { warning: options.brickWarningMv ?? null, critical: options.brickCriticalMv ?? null },
    limitation: "Tesla provides only the pack's reported minimum and maximum brick voltages. This is an envelope, not individual-cell diagnosis; thresholds are user policy settings, not Tesla-documented fault limits.",
  };
}

export function assessThermalEnvelope(points: TelemetryPoint[], options: HealthModelOptions): JsonObject {
  const latest = points.at(-1);
  const minimum = latest ? validNumeric(latest, "ModuleTempMin") : undefined;
  const maximum = latest ? validNumeric(latest, "ModuleTempMax") : undefined;
  if (minimum === undefined || maximum === undefined) {
    return { model: "module_temperature_uniformity", status: "insufficient_telemetry", requiredSignals: ["ModuleTempMin", "ModuleTempMax"] };
  }
  const spreadC = maximum - minimum;
  return {
    model: "module_temperature_uniformity",
    status: statusFor(spreadC, options.thermalWarningC, options.thermalCriticalC),
    formula: "ModuleTemperatureSpread = ModuleTempMax − ModuleTempMin",
    observedAt: latest!.timestamp.toISOString(),
    minimumTemperatureC: minimum,
    maximumTemperatureC: maximum,
    spreadC,
    minimumModuleNumber: validNumeric(latest!, "NumModuleTempMin") ?? null,
    maximumModuleNumber: validNumeric(latest!, "NumModuleTempMax") ?? null,
    batteryHeaterOn: latest ? latest.signals.BatteryHeaterOn ?? null : null,
    adjustableThresholdsC: { warning: options.thermalWarningC ?? null, critical: options.thermalCriticalC ?? null },
    limitation: "Tesla documents only module-temperature extrema. Thermal spread varies with ambient conditions, drive/charge load, and active heating/cooling; thresholds are user policy settings, not Tesla-documented fault limits.",
  };
}

export function assessApparentResistance(points: TelemetryPoint[], reference: HealthReference | undefined, options: HealthModelOptions): JsonObject {
  const candidates: NumericSample[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    const previousCurrent = validNumeric(previous, "PackCurrent");
    const currentCurrent = validNumeric(current, "PackCurrent");
    const previousVoltage = validNumeric(previous, "PackVoltage");
    const currentVoltage = validNumeric(current, "PackVoltage");
    const deltaSeconds = (current.timestamp.valueOf() - previous.timestamp.valueOf()) / 1000;
    if (previousCurrent === undefined || currentCurrent === undefined || previousVoltage === undefined || currentVoltage === undefined || deltaSeconds <= 0 || deltaSeconds > options.maxGapSeconds) continue;
    const deltaCurrent = currentCurrent - previousCurrent;
    if (Math.abs(deltaCurrent) < options.minCurrentStepA) continue;
    const apparentResistanceMilliohm = Math.abs((currentVoltage - previousVoltage) / deltaCurrent) * 1000;
    if (Number.isFinite(apparentResistanceMilliohm) && apparentResistanceMilliohm > 0 && apparentResistanceMilliohm < 1000) candidates.push({ at: current.timestamp, value: apparentResistanceMilliohm });
  }
  if (!candidates.length) {
    return {
      model: "apparent_pack_resistance",
      status: "insufficient_telemetry",
      formula: "R_apparent = |ΔPackVoltage ÷ ΔPackCurrent| × 1000",
      requirements: [`Paired PackVoltage and PackCurrent samples with an absolute current step of at least ${options.minCurrentStepA} A.`, `Sample spacing no greater than ${options.maxGapSeconds} seconds.`],
      limitation: "This is not a DCIR measurement. It contains dynamic, thermal, and control-system effects.",
    };
  }
  const currentResistance = median(candidates.map(candidate => candidate.value));
  const result = retentionResult("apparent_pack_resistance", currentResistance, reference, "mΩ", "median(|ΔPackVoltage ÷ ΔPackCurrent| × 1000)");
  const referenceValue = reference?.value;
  return {
    ...result,
    resistanceIncreasePercent: referenceValue ? 100 * (currentResistance / referenceValue - 1) : null,
    qualifyingStepPairs: candidates.length,
    windowStart: candidates[0]!.at.toISOString(),
    windowEnd: candidates.at(-1)!.at.toISOString(),
    limitation: "This is a comparative screening proxy, not laboratory DCIR. Never interpret it as a Tesla diagnostic result or a cell-resistance measurement.",
  };
}

function modelScore(result: JsonObject, metric: "retention" | "brick" | "thermal" | "resistance", options: HealthModelOptions): number | undefined {
  if (metric === "retention") {
    const value = result.retentionPercent;
    return typeof value === "number" ? clamp(value) : undefined;
  }
  if (metric === "brick") {
    const spread = result.spreadMv;
    if (typeof spread !== "number" || options.brickCriticalMv === undefined || options.brickCriticalMv <= 0) return undefined;
    return clamp(100 * (1 - spread / options.brickCriticalMv));
  }
  if (metric === "thermal") {
    const spread = result.spreadC;
    if (typeof spread !== "number" || options.thermalCriticalC === undefined || options.thermalCriticalC <= 0) return undefined;
    return clamp(100 * (1 - spread / options.thermalCriticalC));
  }
  const increase = result.resistanceIncreasePercent;
  if (typeof increase !== "number") return undefined;
  return clamp(100 - increase);
}

export function assessCompositeHealth(models: { energy: JsonObject; capacity: JsonObject; range: JsonObject; brick: JsonObject; thermal: JsonObject; resistance: JsonObject }, options: HealthModelOptions): JsonObject {
  const candidates = [
    { key: "energy", score: modelScore(models.energy, "retention", options), weight: options.weights.energy },
    { key: "capacity", score: modelScore(models.capacity, "retention", options), weight: options.weights.capacity },
    { key: "range", score: modelScore(models.range, "retention", options), weight: options.weights.range },
    { key: "brick", score: modelScore(models.brick, "brick", options), weight: options.weights.brick },
    { key: "thermal", score: modelScore(models.thermal, "thermal", options), weight: options.weights.thermal },
    { key: "resistance", score: modelScore(models.resistance, "resistance", options), weight: options.weights.resistance },
  ].filter(candidate => candidate.score !== undefined && Number.isFinite(candidate.weight) && candidate.weight > 0) as Array<{ key: string; score: number; weight: number }>;

  if (!candidates.length) {
    return {
      model: "user_weighted_composite_screening_index",
      status: "insufficient_inputs",
      formula: "Σ(component score × user weight) ÷ Σ(user weight), using available components only",
      nextStep: "Set as-new references for energy/capacity/range/resistance and critical policy thresholds for brick/thermal metrics, then collect compatible telemetry.",
      limitation: "No Tesla, regulatory, or clinical validation supports this composite as a battery-health diagnosis.",
    };
  }
  const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  const score = candidates.reduce((sum, candidate) => sum + candidate.score * candidate.weight, 0) / totalWeight;
  return {
    model: "user_weighted_composite_screening_index",
    status: "available_as_user_policy_index",
    formula: "Σ(component score × user weight) ÷ Σ(user weight), using available components only",
    score: clamp(score),
    includedComponents: candidates,
    excludedComponents: ["energy", "capacity", "range", "brick", "thermal", "resistance"].filter(key => !candidates.some(candidate => candidate.key === key)),
    userWeights: options.weights,
    limitation: "This is a user-configurable screening index. It is not Tesla's Battery Health Test, a validated state-of-health measurement, or a service diagnosis.",
  };
}

export function buildHealthModelSuite(vin: string, points: TelemetryPoint[], references: Partial<Record<HealthReference["metric"], HealthReference>>, options: HealthModelOptions): JsonObject {
  const energyReference = referenceFor(references, "energyKwh");
  const models = {
    energy: assessEnergyRetention(vin, points, energyReference ? {
      vin,
      energyKwh: energyReference.value,
      kind: energyReference.kind,
      source: energyReference.source,
      evidence: energyReference.evidence,
      capturedAt: energyReference.capturedAt,
    } : undefined),
    capacity: assessCapacityRetention(points, referenceFor(references, "capacityAh"), options),
    range: assessRangeRetention(points, referenceFor(references, "ratedRange")),
    brick: assessBrickEnvelope(points, options),
    thermal: assessThermalEnvelope(points, options),
    resistance: assessApparentResistance(points, referenceFor(references, "apparentResistanceMilliohm"), options),
  };
  return {
    vin,
    modelOptions: options,
    models,
    composite: assessCompositeHealth(models, options),
    provenance: {
      reportedTeslaSignals: ["Soc", "EnergyRemaining", "PackCurrent", "PackVoltage", "RatedRange", "BrickVoltageMin", "BrickVoltageMax", "ModuleTempMin", "ModuleTempMax"],
      userInputs: ["As-new or observed reference values, threshold policies, and composite weights"],
      noFabrication: "Missing signals, references, and thresholds result in an unavailable model component rather than an inferred substitute.",
    },
  };
}

export function normalizeHealthOptions(input: Partial<HealthModelOptions>): HealthModelOptions {
  const weights = { ...defaultHealthModelOptions.weights, ...(input.weights || {}) };
  for (const [key, value] of Object.entries(weights)) {
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error(`Composite weight ${key} must be a number from 0 to 100.`);
  }
  const options: HealthModelOptions = {
    ...defaultHealthModelOptions,
    ...input,
    weights,
  };
  if (!Number.isFinite(options.minSocSpanPercent) || options.minSocSpanPercent < 5 || options.minSocSpanPercent > 100) throw new Error("minSocSpanPercent must be from 5 to 100.");
  if (!Number.isFinite(options.maxGapSeconds) || options.maxGapSeconds < 1 || options.maxGapSeconds > 3_600) throw new Error("maxGapSeconds must be from 1 to 3600.");
  if (!Number.isFinite(options.minCurrentStepA) || options.minCurrentStepA < 1 || options.minCurrentStepA > 2_000) throw new Error("minCurrentStepA must be from 1 to 2000.");
  for (const [key, value] of Object.entries({ brickWarningMv: options.brickWarningMv, brickCriticalMv: options.brickCriticalMv, thermalWarningC: options.thermalWarningC, thermalCriticalC: options.thermalCriticalC })) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error(`${key} must be a positive number when supplied.`);
  }
  return options;
}
