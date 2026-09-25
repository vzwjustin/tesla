import type { JsonPrimitive, TelemetryPoint } from "./types.js";

// Scan My Tesla-style system panels built from Fleet Telemetry signals the car already streams.
// Field names and enum values follow teslamotors/fleet-telemetry protos/vehicle_data.proto. A unit is shown
// only where Tesla's "Available Data" reference states it (tire pressure in bar, acceleration in m/s², cabin
// and HVAC set temperatures in °C, speed in mph) or where the dashboard already uses one (°C for pack and
// drive-unit temperatures, kΩ for isolation). Torque, axle speed, pedal, brake pressure and fan level have no
// documented unit and are shown as reported.

type Spec = { field: string; label: string; unit?: string; kind?: "enum" | "bool" | "yesno" | "psi" | "accel"; digits?: number };
export type SystemReading = { field: string; label: string; value: JsonPrimitive; display: string; unit?: string; detail?: string; at: string; ageSeconds: number };
export type SystemGroup = { id: string; title: string; note: string; readings: SystemReading[] };

const DRIVE_UNITS = [["R", "Rear"], ["F", "Front"], ["REL", "Rear-left"], ["RER", "Rear-right"]] as const;
const GROUPS: Array<{ id: string; title: string; note: string; specs: Spec[] }> = [
  { id: "driveUnit", title: "Drive unit", note: "Tesla documents no units for drive-unit fields: temperatures are shown in °C, current in A and voltage in V by convention; torque and axle speed are axle-referred and shown as reported.",
    specs: [...DRIVE_UNITS.flatMap(([s, name]): Spec[] => [
      { field: `DiState${s}`, label: `${name} inverter`, kind: "enum" },
      { field: `DiStatorTemp${s}`, label: `${name} stator`, unit: "°C", digits: 1 },
      { field: `DiInverterT${s}`, label: `${name} inverter outlet`, unit: "°C", digits: 1 },
      { field: `DiHeatsinkT${s}`, label: `${name} heatsink`, unit: "°C", digits: 1 },
      { field: `DiTorqueActual${s}`, label: `${name} torque, actual` },
      { field: `DiMotorCurrent${s}`, label: `${name} motor current`, unit: "A" },
      { field: `DiVBat${s}`, label: `${name} inverter DC bus`, unit: "V", digits: 1 },
      { field: `DiAxleSpeed${s}`, label: `${name} axle speed` },
    ]), { field: "DiTorquemotor", label: "Torque command" }] },
  { id: "driving", title: "Driving", note: "Accelerator and brake values are raw (the brake field is master-cylinder pressure). Grade is Tesla's estimate.",
    specs: [
      { field: "VehicleSpeed", label: "Speed", unit: "mph", digits: 0 },
      { field: "Gear", label: "Gear", kind: "enum" },
      { field: "PedalPosition", label: "Accelerator pedal" },
      { field: "BrakePedalPos", label: "Brake pressure" },
      { field: "LongitudinalAcceleration", label: "Longitudinal accel", kind: "accel" },
      { field: "LateralAcceleration", label: "Lateral accel", kind: "accel" },
      { field: "GradeEstimatePercent", label: "Road grade", unit: "%", digits: 1 },
      { field: "CruiseSetSpeed", label: "Cruise set speed" },
    ] },
  { id: "climate", title: "Climate", note: "HVAC power is an on/off/precondition state; Fleet Telemetry does not report HVAC kW.",
    specs: [
      { field: "HvacPower", label: "HVAC", kind: "enum" },
      { field: "HvacACEnabled", label: "A/C", kind: "bool" },
      { field: "HvacAutoMode", label: "Auto mode", kind: "enum" },
      { field: "HvacFanSpeed", label: "Fan level" },
      { field: "InsideTemp", label: "Cabin", unit: "°C", digits: 1 },
      { field: "OutsideTemp", label: "Outside", unit: "°C", digits: 1 },
      { field: "HvacLeftTemperatureRequest", label: "Driver set", unit: "°C", digits: 1 },
      { field: "HvacRightTemperatureRequest", label: "Passenger set", unit: "°C", digits: 1 },
      { field: "PreconditioningEnabled", label: "Preconditioning", kind: "bool" },
      { field: "ClimateKeeperMode", label: "Climate keeper", kind: "enum" },
      { field: "CabinOverheatProtectionMode", label: "Overheat protection", kind: "enum" },
      { field: "DefrostMode", label: "Defrost", kind: "enum" },
      { field: "HvacSteeringWheelHeatLevel", label: "Steering wheel heat" },
      { field: "SeatHeaterLeft", label: "Driver seat heat" },
      { field: "SeatHeaterRight", label: "Passenger seat heat" },
    ] },
  { id: "hv", title: "High-voltage system", note: "States are as the car reports them. Isolation is HV bus to chassis, in kΩ as elsewhere on this dashboard.",
    specs: [
      { field: "BMSState", label: "BMS state", kind: "enum" },
      { field: "Hvil", label: "HV interlock (HVIL)", kind: "enum" },
      { field: "IsolationResistance", label: "Isolation resistance", unit: "kΩ", digits: 0 },
      { field: "DCDCEnable", label: "DC-DC converter", kind: "bool" },
      { field: "DriveRail", label: "Drive rail", kind: "bool" },
      { field: "BatteryHeaterOn", label: "Pack heater", kind: "bool" },
      { field: "NotEnoughPowerToHeat", label: "Too little power to heat", kind: "yesno" },
    ] },
  { id: "tires", title: "Tires", note: "Pressures are reported in bar and shown in psi. Warning fields are the car's own TPMS flags.",
    specs: [
      { field: "TpmsPressureFl", label: "Front left", kind: "psi" },
      { field: "TpmsPressureFr", label: "Front right", kind: "psi" },
      { field: "TpmsPressureRl", label: "Rear left", kind: "psi" },
      { field: "TpmsPressureRr", label: "Rear right", kind: "psi" },
      { field: "TpmsHardWarnings", label: "Hard warning", kind: "yesno" },
      { field: "TpmsSoftWarnings", label: "Soft warning", kind: "yesno" },
    ] },
];

const ENUM_PREFIX = /^(DriveInverterState|HvilStatus|HvacPowerState|HvacAutoModeState|BMSState|CabinOverheatProtectionModeState|ClimateKeeperModeState|DefrostModeState|ShiftState)(?=.)/;
// "HvacPowerStateOverheatProtect" → "Overheat protect"; acronyms and single gear letters stay as they are.
export function enumLabel(value: string): string {
  const bare = value.replace(ENUM_PREFIX, "");
  return /^[A-Z0-9]+$/.test(bare) ? bare : bare.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/^./, c => c.toUpperCase());
}

const truthy = (value: JsonPrimitive) => value === true || value === "true" || (typeof value === "number" && value !== 0);
const fixed = (value: number, digits = 2) => Number(value.toFixed(digits)).toLocaleString("en-US", { maximumFractionDigits: digits });

function reading(spec: Spec, value: JsonPrimitive, at: number, now: number): SystemReading {
  const base = { field: spec.field, label: spec.label, value, at: new Date(at).toISOString(), ageSeconds: Math.max(0, Math.round((now - at) / 1000)) };
  if (value === null) return { ...base, display: "invalid", detail: "the car reported this signal as invalid" };
  if (spec.kind === "bool" || spec.kind === "yesno") return { ...base, display: truthy(value) ? (spec.kind === "bool" ? "On" : "Yes") : spec.kind === "bool" ? "Off" : "No", ...(typeof value === "boolean" ? {} : { detail: `reported as ${value}` }) };
  if (spec.kind === "enum" && typeof value === "string") return { ...base, display: enumLabel(value) };
  if (typeof value !== "number") return { ...base, display: String(value) };
  if (spec.kind === "psi") return { ...base, display: fixed(value * 14.5038, 1), unit: "psi", detail: `${fixed(value, 3)} bar` };
  if (spec.kind === "accel") return { ...base, display: fixed(value, 2), unit: "m/s²", detail: `${fixed(value / 9.80665, 2)} g` };
  return { ...base, display: fixed(value, spec.digits ?? 2), ...(spec.unit ? { unit: spec.unit } : {}) };
}

// Latest value of every catalogued signal, each with its own age: Fleet Telemetry is change-based, so a
// stator temperature can be hours older than the newest record while the car sleeps.
export function vehicleSystems(points: TelemetryPoint[], now = Date.now()): SystemGroup[] {
  const last = new Map<string, { value: JsonPrimitive; at: number }>();
  for (const point of points) {
    const at = point.timestamp.valueOf();
    for (const [field, value] of Object.entries(point.signals)) last.set(field, { value, at });
    for (const field of point.invalidSignals || []) last.set(field, { value: null, at });
  }
  return GROUPS.flatMap(group => {
    const readings = group.specs.flatMap(spec => { const seen = last.get(spec.field); return seen ? [reading(spec, seen.value, seen.at, now)] : []; });
    return readings.length ? [{ id: group.id, title: group.title, note: group.note, readings }] : [];
  });
}

// Car-reported fault states and TPMS warnings, for the dashboard's attention strip. Only the latest value of
// each field counts, and its age is stated, since a sleeping car keeps its last report.
export function systemFaults(groups: SystemGroup[]): { checked: number; faults: SystemReading[] } {
  const all = groups.flatMap(group => group.readings);
  const states = all.filter(r => /^(DiState|Hvil$|BMSState$)/.test(r.field) && typeof r.value === "string");
  const tpms = all.filter(r => /^Tpms(Hard|Soft)Warnings$/.test(r.field));
  const faults = [...states.filter(r => /Fault$/.test(String(r.value)) && !/ClearFault$/.test(String(r.value))), ...tpms.filter(r => r.value !== null && truthy(r.value))];
  return { checked: states.length + tpms.length, faults };
}
