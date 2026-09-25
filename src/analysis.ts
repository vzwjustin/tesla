import type { BatteryDashboard, HistorySeries, JsonObject, JsonPrimitive, Metric, TelemetryPoint } from "./types.js";

const UNAVAILABLE = [
  "Individual cell-voltage array: Tesla Fleet API does not document a full per-cell or per-brick voltage array.",
  "Battery health/degradation percentage: Tesla Fleet API does not document a direct SOH or usable-capacity field.",
  "Cell-internal resistance: Tesla Fleet API does not document per-cell resistance.",
];

type SourceRecord = { source: "live_vehicle_data" | "fleet_telemetry"; vin: string; timestamp?: Date; fields: Record<string, JsonPrimitive> };

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asPrimitive(value: unknown): JsonPrimitive | undefined {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}

function liveField(data: JsonObject, keys: string[]): JsonPrimitive | undefined {
  const groups = [data, data.charge_state, data.climate_state, data.drive_state, data.vehicle_state].filter(isObject);
  for (const group of groups) {
    for (const key of keys) {
      const direct = asPrimitive(group[key]);
      if (direct !== undefined) return direct;
    }
  }
  return undefined;
}

function numberMetric(fields: Record<string, JsonPrimitive>, keys: string[], unit: string, origin: "reported" | "derived" = "reported"): Metric<number> | undefined {
  for (const key of keys) {
    const value = fields[key];
    if (typeof value === "number" && Number.isFinite(value)) return { value, unit, origin, sourceField: key };
  }
  return undefined;
}

function boolMetric(fields: Record<string, JsonPrimitive>, keys: string[]): Metric<boolean> | undefined {
  for (const key of keys) {
    const value = fields[key];
    if (typeof value === "boolean") return { value, origin: "reported", sourceField: key };
  }
  return undefined;
}

function textMetric(fields: Record<string, JsonPrimitive>, keys: string[]): Metric<string | number> | undefined {
  for (const key of keys) {
    const value = fields[key];
    if (typeof value === "string" || typeof value === "number") return { value, origin: "reported", sourceField: key };
  }
  return undefined;
}

function stringMetric(fields: Record<string, JsonPrimitive>, keys: string[]): Metric<string> | undefined {
  for (const key of keys) {
    const value = fields[key];
    if (typeof value === "string") return { value, origin: "reported", sourceField: key };
  }
  return undefined;
}

function fieldsFromLive(data: JsonObject): Record<string, JsonPrimitive> {
  return {
    Soc: liveField(data, ["usable_battery_level", "battery_level"]),
    BatteryLevel: liveField(data, ["battery_level"]),
    RatedRange: liveField(data, ["battery_range", "rated_range"]),
    EstBatteryRange: liveField(data, ["est_battery_range"]),
    PackVoltage: liveField(data, ["pack_voltage"]),
    PackCurrent: liveField(data, ["pack_current"]),
    BrickVoltageMin: liveField(data, ["brick_voltage_min"]),
    BrickVoltageMax: liveField(data, ["brick_voltage_max"]),
    NumBrickVoltageMin: liveField(data, ["num_brick_voltage_min"]),
    NumBrickVoltageMax: liveField(data, ["num_brick_voltage_max"]),
    ModuleTempMin: liveField(data, ["module_temp_min"]),
    ModuleTempMax: liveField(data, ["module_temp_max"]),
    NumModuleTempMin: liveField(data, ["num_module_temp_min"]),
    NumModuleTempMax: liveField(data, ["num_module_temp_max"]),
    IsolationResistance: liveField(data, ["isolation_resistance"]),
    BatteryHeaterOn: liveField(data, ["battery_heater_on"]),
    ChargeState: liveField(data, ["charging_state"]),
    BmsState: liveField(data, ["bms_state"]),
    BmsFullchargecomplete: liveField(data, ["bms_fullchargecomplete"]),
    ChargeLimitSoc: liveField(data, ["charge_limit_soc"]),
    ChargerPower: liveField(data, ["charger_power"]),
    AcChargingPower: liveField(data, ["ac_charging_power"]),
    DcChargingPower: liveField(data, ["dc_charging_power"]),
    ChargerVoltage: liveField(data, ["charger_voltage"]),
    ChargeAmps: liveField(data, ["charger_actual_current", "charge_amps"]),
    TimeToFullCharge: liveField(data, ["time_to_full_charge"]),
    AddedEnergy: liveField(data, ["charge_energy_added"]),
    DcChargingEnergyIn: liveField(data, ["dc_charging_energy_in"]),
    AcChargingEnergyIn: liveField(data, ["ac_charging_energy_in"]),
    LifetimeEnergyUsed: liveField(data, ["lifetime_energy_used"]),
    Odometer: liveField(data, ["odometer"]),
  } as Record<string, JsonPrimitive>;
}

export function recordFromLive(vin: string, data: JsonObject): SourceRecord {
  return { source: "live_vehicle_data", vin, fields: fieldsFromLive(data) };
}

export function recordFromTelemetry(point: TelemetryPoint): SourceRecord {
  return { source: "fleet_telemetry", vin: point.vin, timestamp: point.timestamp, fields: point.signals };
}

export function buildDashboard(record: SourceRecord): BatteryDashboard {
  const f = record.fields;
  const packVoltage = numberMetric(f, ["PackVoltage"], "V");
  const packCurrent = numberMetric(f, ["PackCurrent"], "A");
  const brickMin = numberMetric(f, ["BrickVoltageMin"], "V");
  const brickMax = numberMetric(f, ["BrickVoltageMax"], "V");
  const moduleMin = numberMetric(f, ["ModuleTempMin"], "°C");
  const moduleMax = numberMetric(f, ["ModuleTempMax"], "°C");

  const calculatedPackPower = packVoltage && packCurrent
    ? { value: (packVoltage.value * packCurrent.value) / 1000, unit: "kW", origin: "derived" as const, sourceField: "PackVoltage × PackCurrent" }
    : undefined;
  const brickSpread = brickMin && brickMax
    ? { value: (brickMax.value - brickMin.value) * 1000, unit: "mV", origin: "derived" as const, sourceField: "BrickVoltageMax − BrickVoltageMin" }
    : undefined;
  const energyRemaining = numberMetric(f, ["EnergyRemaining"], "kWh");
  const thermalSpread = moduleMin && moduleMax
    ? { value: moduleMax.value - moduleMin.value, unit: "°C", origin: "derived" as const, sourceField: "ModuleTempMax − ModuleTempMin" }
    : undefined;

  const reported = Object.entries(f).filter(([, value]) => value !== undefined).map(([key]) => key).sort();
  const notes = [
    record.source === "live_vehicle_data"
      ? "Live vehicle data is a point-in-time request. This MCP never wakes the vehicle or background-polls it."
      : "Fleet Telemetry is vehicle-pushed data. The timestamp is retained from the local decoded telemetry record.",
    "No health threshold or fault verdict is inferred because Tesla does not document Fleet API diagnostic limits for these fields.",
  ];

  return {
    generatedAt: new Date().toISOString(),
    vin: record.vin,
    source: record.source,
    ...(record.timestamp ? { sourceTimestamp: record.timestamp.toISOString() } : {}),
    battery: {
      stateOfCharge: numberMetric(f, ["Soc"], "%"),
      reportedBatteryLevel: numberMetric(f, ["BatteryLevel"], "%"),
      ratedRange: numberMetric(f, ["RatedRange"], "mi"),
      estimatedRange: numberMetric(f, ["EstBatteryRange"], "mi"),
      usableRange: numberMetric(f, ["RatedRange"], "mi"),
      energyRemaining,
    },
    electrical: {
      packVoltage,
      packCurrent,
      calculatedPackPower,
      isolationResistance: numberMetric(f, ["IsolationResistance"], "kΩ"),
    },
    brickEnvelope: {
      minVoltage: brickMin,
      maxVoltage: brickMax,
      spread: brickSpread,
      minBrickNumber: numberMetric(f, ["NumBrickVoltageMin"], "index"),
      maxBrickNumber: numberMetric(f, ["NumBrickVoltageMax"], "index"),
    },
    thermalEnvelope: {
      minTemperature: moduleMin,
      maxTemperature: moduleMax,
      spread: thermalSpread,
      minModuleNumber: numberMetric(f, ["NumModuleTempMin"], "index"),
      maxModuleNumber: numberMetric(f, ["NumModuleTempMax"], "index"),
      batteryHeaterOn: boolMetric(f, ["BatteryHeaterOn"]),
    },
    charging: {
      state: stringMetric(f, ["ChargeState"]),
      detailedState: textMetric(f, ["DetailedChargeState"]),
      chargerPhases: numberMetric(f, ["ChargerPhases"], "phases"),
      bmsState: textMetric(f, ["BmsState"]),
      bmsFullChargeComplete: boolMetric(f, ["BmsFullchargecomplete"]),
      chargeLimitSoc: numberMetric(f, ["ChargeLimitSoc"], "%"),
      chargerPower: numberMetric(f, ["ChargerPower"], "kW"),
      acChargingPower: numberMetric(f, ["AcChargingPower"], "kW"),
      dcChargingPower: numberMetric(f, ["DcChargingPower"], "kW"),
      chargerVoltage: numberMetric(f, ["ChargerVoltage"], "V"),
      chargeAmps: numberMetric(f, ["ChargeAmps"], "A"),
      timeToFullCharge: numberMetric(f, ["TimeToFullCharge"], "h"),
      addedEnergy: numberMetric(f, ["AddedEnergy"], "kWh"),
      dcAddedEnergy: numberMetric(f, ["DcChargingEnergyIn"], "kWh"),
      acAddedEnergy: numberMetric(f, ["AcChargingEnergyIn"], "kWh"),
    },
    lifetime: {
      energyUsed: numberMetric(f, ["LifetimeEnergyUsed"], "kWh"),
      odometer: numberMetric(f, ["Odometer"], "mi"),
    },
    dataQuality: { availableSignals: reported, unavailableTeslaApiFields: UNAVAILABLE, notes },
  };
}

export function historySeries(points: TelemetryPoint[], requestedFields: string[]): HistorySeries[] {
  return requestedFields.flatMap(field => {
    const samples = points.flatMap(point => {
      const value = point.signals[field];
      return typeof value === "number" && Number.isFinite(value) ? [{ at: point.timestamp, value }] : [];
    });
    if (!samples.length) return [];
    const values = samples.map(sample => sample.value);
    return [{
      field,
      unit: field.includes("Voltage") ? "V" : field.includes("Temp") ? "°C" : field === "Soc" || field === "BatteryLevel" ? "%" : "reported unit",
      samples: samples.length,
      earliestAt: samples[0]!.at.toISOString(),
      latestAt: samples.at(-1)!.at.toISOString(),
      earliestValue: samples[0]!.value,
      latestValue: samples.at(-1)!.value,
      minimum: Math.min(...values),
      maximum: Math.max(...values),
      observedChange: samples.at(-1)!.value - samples[0]!.value,
    }];
  });
}

export function degradationEvidence(points: TelemetryPoint[], dashboard: BatteryDashboard): JsonObject {
  const rangePoints = points.flatMap(point => {
    const soc = point.signals.Soc;
    const ratedRange = point.signals.RatedRange;
    return typeof soc === "number" && typeof ratedRange === "number" ? [{ at: point.timestamp.toISOString(), soc, ratedRange }] : [];
  });
  return {
    directStateOfHealth: "Unavailable: Tesla Fleet API does not document a state-of-health or usable-capacity field.",
    currentRatedRange: dashboard.battery.ratedRange?.value ?? null,
    currentStateOfCharge: dashboard.battery.stateOfCharge?.value ?? null,
    lifetimeEnergyUsedKwh: dashboard.lifetime.energyUsed?.value ?? null,
    comparableRangeObservations: rangePoints,
    interpretation: "Range observations are reported values, not a degradation calculation. They vary with state of charge and vehicle conditions; no capacity estimate is fabricated by this MCP.",
  };
}
