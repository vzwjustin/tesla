export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type MetricOrigin = "reported" | "derived";

export interface Metric<T extends JsonPrimitive = JsonPrimitive> {
  value: T;
  unit?: string;
  origin: MetricOrigin;
  sourceField?: string;
}

export interface TelemetryPoint {
  vin: string;
  timestamp: Date;
  signals: Record<string, JsonPrimitive>;
  invalidSignals?: string[];
}

export interface BatteryDashboard {
  generatedAt: string;
  vin: string;
  source: "live_vehicle_data" | "fleet_telemetry";
  sourceTimestamp?: string;
  battery: {
    stateOfCharge?: Metric<number>;
    reportedBatteryLevel?: Metric<number>;
    ratedRange?: Metric<number>;
    estimatedRange?: Metric<number>;
    usableRange?: Metric<number>;
    energyRemaining?: Metric<number>;
  };
  electrical: {
    packVoltage?: Metric<number>;
    packCurrent?: Metric<number>;
    calculatedPackPower?: Metric<number>;
    isolationResistance?: Metric<number>;
  };
  brickEnvelope: {
    minVoltage?: Metric<number>;
    maxVoltage?: Metric<number>;
    spread?: Metric<number>;
    minBrickNumber?: Metric<number>;
    maxBrickNumber?: Metric<number>;
  };
  thermalEnvelope: {
    minTemperature?: Metric<number>;
    maxTemperature?: Metric<number>;
    spread?: Metric<number>;
    minModuleNumber?: Metric<number>;
    maxModuleNumber?: Metric<number>;
    batteryHeaterOn?: Metric<boolean>;
  };
  charging: {
    state?: Metric<string>;
    detailedState?: Metric<string | number>;
    chargerPhases?: Metric<number>;
    bmsState?: Metric<string | number>;
    bmsFullChargeComplete?: Metric<boolean>;
    chargeLimitSoc?: Metric<number>;
    chargerPower?: Metric<number>;
    acChargingPower?: Metric<number>;
    dcChargingPower?: Metric<number>;
    chargerVoltage?: Metric<number>;
    chargeAmps?: Metric<number>;
    timeToFullCharge?: Metric<number>;
    addedEnergy?: Metric<number>;
    dcAddedEnergy?: Metric<number>;
    acAddedEnergy?: Metric<number>;
  };
  lifetime: {
    energyUsed?: Metric<number>;
    odometer?: Metric<number>;
  };
  dataQuality: {
    availableSignals: string[];
    unavailableTeslaApiFields: string[];
    notes: string[];
  };
}

export interface HistorySeries {
  field: string;
  unit: string;
  samples: number;
  earliestAt: string;
  latestAt: string;
  earliestValue: number;
  latestValue: number;
  minimum: number;
  maximum: number;
  observedChange: number;
}
