import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { assessEnergyRetention, getBaseline, getHealthReferences, saveBaseline, saveHealthReference } from "./degradation.js";
import { buildDashboard, degradationEvidence, historySeries, recordFromLive, recordFromTelemetry } from "./analysis.js";
import { buildHealthModelSuite, defaultHealthModelOptions, normalizeHealthOptions } from "./healthModels.js";
import { constrainedBmsCalibration, importBmsDiagnosticFile } from "./scanMyTesla.js";
import { capturePassiveElmCan, listSerialCanPorts } from "./serialCan.js";
import { getVehicleData, listVehicles, resolveVin } from "./teslaApi.js";
import { latestTelemetry, readTelemetry } from "./telemetry.js";
import { estimateSoh, sohObservations, sohReferences } from "./soh.js";

const server = new McpServer({
  name: "tesla-battery-mcp",
  version: "1.0.0",
}, {
  instructions: "This server is strictly read-only. Do not wake vehicles, issue commands, modify charging, or infer undisclosed cell-level readings. Use the returned provenance and confidence limitations in every interpretation.",
});

function result(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }], isError: true };
}

async function safely<T>(operation: () => Promise<T>) {
  try {
    return result(await operation());
  } catch (error) {
    return errorResult(error);
  }
}

const vinInput = { vin: z.string().min(11).max(32).optional().describe("Tesla VIN. Omit only when exactly one allowlisted vehicle exists.") };

const healthOptionSchema = {
  minSocSpanPercent: z.number().min(5).max(100).optional().describe("Capacity-integration requirement: minimum monotonic SOC span. Default: 20%."),
  maxGapSeconds: z.number().int().min(1).max(3600).optional().describe("Maximum accepted telemetry time gap. Default: 300 seconds."),
  minCurrentStepA: z.number().min(1).max(2000).optional().describe("Minimum current change accepted by the apparent-resistance proxy. Default: 20 A."),
  brickWarningMv: z.number().positive().optional().describe("Optional user policy threshold for brick voltage spread. No Tesla threshold is assumed."),
  brickCriticalMv: z.number().positive().optional().describe("Optional user policy critical threshold for brick voltage spread. No Tesla threshold is assumed."),
  thermalWarningC: z.number().positive().optional().describe("Optional user policy threshold for module temperature spread. No Tesla threshold is assumed."),
  thermalCriticalC: z.number().positive().optional().describe("Optional user policy critical threshold for module temperature spread. No Tesla threshold is assumed."),
  energyWeight: z.number().min(0).max(100).optional().describe("Composite-index weight for energy retention. Default: 1."),
  capacityWeight: z.number().min(0).max(100).optional().describe("Composite-index weight for capacity retention. Default: 1."),
  rangeWeight: z.number().min(0).max(100).optional().describe("Composite-index weight for rated-range retention. Default: 1."),
  brickWeight: z.number().min(0).max(100).optional().describe("Composite-index weight for brick envelope. Default: 1."),
  thermalWeight: z.number().min(0).max(100).optional().describe("Composite-index weight for thermal envelope. Default: 1."),
  resistanceWeight: z.number().min(0).max(100).optional().describe("Composite-index weight for apparent resistance. Default: 1."),
};

server.registerTool("tesla_list_vehicles", {
  title: "List authorized Tesla vehicles",
  description: "Returns the Tesla Fleet API vehicle list. Read-only; no vehicle is woken or commanded.",
}, async () => safely(async () => {
  const vehicles = await listVehicles();
  return vehicles.map(vehicle => ({ vin: vehicle.vin, displayName: vehicle.display_name, state: vehicle.state, id: vehicle.id, vehicleId: vehicle.vehicle_id }));
}));

server.registerTool("tesla_battery_live_snapshot", {
  title: "Get live Tesla battery snapshot",
  description: "Performs one Tesla Fleet API vehicle_data read and derives pack power, brick-voltage spread, and module-temperature spread only when Tesla reports the source signals. Does not wake the vehicle and never polls in the background.",
  inputSchema: vinInput,
}, async ({ vin }) => safely(async () => {
  const target = await resolveVin(vin);
  return buildDashboard(recordFromLive(target, await getVehicleData(target)));
}));

server.registerTool("tesla_battery_telemetry_snapshot", {
  title: "Get latest local Fleet Telemetry battery snapshot",
  description: "Reads the most recent decoded Tesla Fleet Telemetry JSONL record retained locally. Includes brick-voltage and thermal envelopes when configured. Does not call Tesla or wake a vehicle.",
  inputSchema: vinInput,
}, async ({ vin }) => safely(async () => {
  const point = await latestTelemetry(vin);
  if (!point) throw new Error("No qualifying decoded Fleet Telemetry record was found for this VIN.");
  return buildDashboard(recordFromTelemetry(point));
}));

server.registerTool("tesla_battery_soh_estimate", {
  title: "Estimate battery state of health",
  description: "Capacity-based SOH (full-charge capacity now ÷ as-new × 100) from local Fleet Telemetry, fusing rated-range, energy and BMS-nominal methods by inverse-variance weighting with propagated uncertainty. Needs as-new references set with tesla_battery_set_health_reference.",
  inputSchema: { ...vinInput, hours: z.number().int().min(1).max(24 * 365).default(720).describe("Lookback window in hours.") },
}, async ({ vin, hours }) => safely(async () => {
  const points = await readTelemetry(vin, hours);
  const target = vin || points[0]?.vin;
  if (!target || !points.length) throw new Error("No qualifying local Fleet Telemetry records were found.");
  return estimateSoh(points, await sohReferences(target), sohObservations());
}));

server.registerTool("tesla_battery_envelope_history", {
  title: "Analyze battery envelope history",
  description: "Summarizes local Tesla Fleet Telemetry values over time for pack voltage/current, brick extrema, thermal extrema, SOC, energy remaining, charging, and lifetime counters. It does not invent missing readings.",
  inputSchema: {
    ...vinInput,
    hours: z.number().int().min(1).max(24 * 365).default(168).describe("Lookback window in hours, from 1 to 8760."),
  },
}, async ({ vin, hours }) => safely(async () => {
  const points = await readTelemetry(vin, hours);
  const target = vin || points[0]?.vin;
  if (!target || !points.length) throw new Error("No qualifying local Fleet Telemetry records were found.");
  const series = historySeries(points, [
    "Soc", "EnergyRemaining", "PackVoltage", "PackCurrent", "BrickVoltageMin", "BrickVoltageMax", "ModuleTempMin", "ModuleTempMax", "IsolationResistance", "ChargerPower", "AcChargingPower", "DcChargingPower", "LifetimeEnergyUsed", "Odometer",
  ]);
  return {
    vin: target,
    lookbackHours: hours,
    telemetryRecords: points.length,
    windowStart: points[0]!.timestamp.toISOString(),
    windowEnd: points.at(-1)!.timestamp.toISOString(),
    series,
    limitation: "Tesla Fleet API documents extrema, not an array of every physical cell or brick. A spread is a max-minus-min envelope, not a per-cell diagnostic map.",
  };
}));

server.registerTool("tesla_battery_degradation", {
  title: "Calculate energy-based battery degradation",
  description: "Calculates capacity/energy-based state of health using Tesla Fleet Telemetry Soc and EnergyRemaining. Requires an explicit as-new energy baseline to report degradation since new; otherwise returns only an auditable current-capacity estimate and the data needed to complete it.",
  inputSchema: {
    ...vinInput,
    hours: z.number().int().min(1).max(24 * 365).default(720).describe("Telemetry lookback window in hours, from 1 to 8760."),
  },
}, async ({ vin, hours }) => safely(async () => {
  const points = await readTelemetry(vin, hours);
  const target = vin || points[0]?.vin;
  if (!target || !points.length) throw new Error("No qualifying local Fleet Telemetry records were found.");
  return assessEnergyRetention(target, points, await getBaseline(target));
}));

server.registerTool("tesla_battery_set_energy_baseline", {
  title: "Set auditable energy baseline",
  description: "Stores a local kWh reference used only by the degradation calculation. Use kind=as_new only with documentary evidence of new-condition usable/nominal energy. This tool changes only the local MCP configuration file; it never modifies Tesla or the vehicle.",
  inputSchema: {
    vin: z.string().min(11).max(32).describe("Tesla VIN."),
    energyKwh: z.number().positive().max(500).describe("Reference full-pack energy in kWh."),
    kind: z.enum(["as_new", "observed"]).describe("as_new calculates SOH/degradation since new; observed measures change only since an earlier observation."),
    source: z.string().min(3).max(200).describe("Source, such as manufacturer specification, delivery-time test, or technician report."),
    evidence: z.string().min(3).max(1000).describe("Evidence supporting the value and its measurement conditions."),
  },
}, async ({ vin, energyKwh, kind, source, evidence }) => safely(async () => {
  return {
    savedBaseline: await saveBaseline({ vin, energyKwh, kind, source, evidence }),
    nextStep: "Run tesla_battery_degradation after valid Fleet Telemetry records containing Soc and EnergyRemaining have been retained locally.",
  };
}));

server.registerTool("tesla_battery_degradation_evidence", {
  title: "Review available degradation evidence",
  description: "Explains which real Tesla telemetry signals are available for battery-energy analysis and distinguishes a manufacturer Health Test from API-derived estimates. No health percentage is fabricated.",
  inputSchema: { ...vinInput, hours: z.number().int().min(1).max(24 * 365).default(720) },
}, async ({ vin, hours }) => safely(async () => {
  const point = await latestTelemetry(vin);
  if (!point) throw new Error("No qualifying decoded Fleet Telemetry record was found.");
  const points = await readTelemetry(point.vin, hours);
  const dashboard = buildDashboard(recordFromTelemetry(point));
  return degradationEvidence(points, dashboard);
}));

server.registerTool("tesla_battery_health_model_catalog", {
  title: "Describe available configurable health models",
  description: "Lists every read-only health model, its formula, inputs, required Tesla signals, adjustable parameters, and diagnostic limitations before making a calculation.",
}, async () => result({
  defaultOptions: defaultHealthModelOptions,
  models: [
    { id: "energy", formula: "median(EnergyRemaining ÷ (Soc ÷ 100))", requires: ["Soc", "EnergyRemaining", "as-new kWh reference"], output: "Energy-based SOH and degradation." },
    { id: "capacity", formula: "integrated |PackCurrent| ÷ observed SOC fraction", requires: ["Soc", "PackCurrent", "as-new Ah reference", "monotonic SOC window"], adjusts: ["minSocSpanPercent", "maxGapSeconds"], output: "Coulomb-counted capacity retention." },
    { id: "range", formula: "median(RatedRange ÷ (Soc ÷ 100))", requires: ["Soc", "RatedRange", "as-new 100% rated-range reference"], output: "Range-retention proxy, not direct capacity." },
    { id: "brick", formula: "(BrickVoltageMax − BrickVoltageMin) × 1000", requires: ["BrickVoltageMin", "BrickVoltageMax"], adjusts: ["brickWarningMv", "brickCriticalMv"], output: "Max-min brick-voltage envelope." },
    { id: "thermal", formula: "ModuleTempMax − ModuleTempMin", requires: ["ModuleTempMin", "ModuleTempMax"], adjusts: ["thermalWarningC", "thermalCriticalC"], output: "Max-min module-temperature envelope." },
    { id: "resistance", formula: "median(|ΔPackVoltage ÷ ΔPackCurrent| × 1000)", requires: ["PackVoltage", "PackCurrent", "optional mΩ reference"], adjusts: ["minCurrentStepA", "maxGapSeconds"], output: "Apparent-resistance screening proxy, not DCIR." },
    { id: "composite", formula: "Σ(available component score × user weight) ÷ Σ(user weight)", requires: ["Available model components and weights"], output: "User policy screening index; not an official or validated Tesla health score." },
  ],
  invariant: "No missing API field, baseline, threshold, or telemetry window is silently estimated. The corresponding model is reported unavailable instead.",
}));

server.registerTool("tesla_battery_set_health_reference", {
  title: "Set adjustable health-model reference",
  description: "Stores a local, auditable as-new or observed reference for energy, capacity, rated range, or apparent resistance. This changes only a restricted local configuration file and never Tesla or the vehicle.",
  inputSchema: {
    vin: z.string().min(11).max(32).describe("Tesla VIN."),
    metric: z.enum(["energyKwh", "capacityAh", "ratedRange", "apparentResistanceMilliohm"]).describe("The health-model baseline to store."),
    value: z.number().positive().max(10_000).describe("Positive reference value in the metric's documented unit."),
    kind: z.enum(["as_new", "observed"]).describe("as_new enables degradation/retention since new; observed measures change since that observation only."),
    source: z.string().min(3).max(200).describe("Reference source, such as a manufacturer specification, delivery-time measurement, or technician report."),
    evidence: z.string().min(3).max(1000).describe("Evidence and conditions supporting this value."),
  },
}, async ({ vin, metric, value, kind, source, evidence }) => safely(async () => ({
  savedReference: await saveHealthReference({ vin, metric, value, kind, source, evidence }),
  note: "The MCP will retain provenance and will not treat observed references as as-new battery capacity.",
})));

server.registerTool("tesla_battery_health_models", {
  title: "Calculate all configurable battery health models",
  description: "Calculates energy, coulomb-counted capacity, range retention, brick envelope, thermal envelope, apparent resistance, and a user-weighted composite. Every result includes formula, inputs, availability, caveats, and no unreported Tesla field is assumed.",
  inputSchema: {
    ...vinInput,
    hours: z.number().int().min(1).max(24 * 365).default(720).describe("Telemetry lookback window in hours, from 1 to 8760."),
    ...healthOptionSchema,
  },
}, async ({ vin, hours, minSocSpanPercent, maxGapSeconds, minCurrentStepA, brickWarningMv, brickCriticalMv, thermalWarningC, thermalCriticalC, energyWeight, capacityWeight, rangeWeight, brickWeight, thermalWeight, resistanceWeight }) => safely(async () => {
  const points = await readTelemetry(vin, hours);
  const target = vin || points[0]?.vin;
  if (!target || !points.length) throw new Error("No qualifying local Fleet Telemetry records were found.");
  const options = normalizeHealthOptions({
    minSocSpanPercent,
    maxGapSeconds,
    minCurrentStepA,
    brickWarningMv,
    brickCriticalMv,
    thermalWarningC,
    thermalCriticalC,
    weights: {
      energy: energyWeight ?? defaultHealthModelOptions.weights.energy,
      capacity: capacityWeight ?? defaultHealthModelOptions.weights.capacity,
      range: rangeWeight ?? defaultHealthModelOptions.weights.range,
      brick: brickWeight ?? defaultHealthModelOptions.weights.brick,
      thermal: thermalWeight ?? defaultHealthModelOptions.weights.thermal,
      resistance: resistanceWeight ?? defaultHealthModelOptions.weights.resistance,
    },
  });
  return buildHealthModelSuite(target, points, await getHealthReferences(target), options);
}));

server.registerTool("tesla_scanmytesla_import_diagnostics", {
  title: "Import Scan My Tesla or TeslaLogger diagnostics",
  description: "Imports a local Scan My Tesla CSV/JSON export or a locally exported TeslaLogger diagnostic record. Recognized direct-BMS readings are normalized while unknown fields are retained as raw evidence. It never uploads the file or controls the vehicle.",
  inputSchema: {
    filePath: z.string().min(1).describe("Absolute or relative path to a locally retained CSV or JSON diagnostic export."),
    source: z.enum(["scanmytesla_export", "teslalogger_export"]).describe("Origin of the local export."),
  },
}, async ({ filePath, source }) => safely(async () => importBmsDiagnosticFile(filePath, source)));

server.registerTool("tesla_scanmytesla_list_serial_ports", {
  title: "List local Bluetooth/serial CAN ports",
  description: "Lists local serial devices that may represent a paired Bluetooth Classic OBD adapter or a USB CAN bridge. It does not open a device, start a scan, or interact with a vehicle.",
}, async () => safely(async () => ({
  ports: await listSerialCanPorts(),
  guidance: "On Windows, a paired Bluetooth Classic OBD adapter usually appears as a COM port. On macOS, provide a compatible serial/RFCOMM device path if one is created. Scan My Tesla and the MCP generally cannot share one active Bluetooth Classic serial adapter at the same time.",
})));

server.registerTool("tesla_scanmytesla_capture_passive_can", {
  title: "Capture Model 3/Y BMS data from a passive Bluetooth/serial CAN adapter",
  description: "Performs a short, on-demand passive ELM/STN CAN monitor capture through a user-selected Windows COM port or macOS serial path. It sends adapter configuration commands only; it never transmits a Tesla CAN frame, wakes the car, or issues a vehicle command. Decodes open model3dbc Model 3/Y mappings and returns unknown data as untrusted evidence. The extended profile adds Scan My Tesla-style signals (pack V/I, BMS limits and thermal, lifetime kWh, DC-DC, charge line, rear inverter), decoded as the DBC defines them but not checked against the car, and takes about 15 s longer.",
  inputSchema: {
    portPath: z.string().min(2).max(260).describe("Windows COM port or macOS serial device path for the paired compatible adapter."),
    baudRate: z.number().int().min(9600).max(1_000_000).default(38400).describe("Adapter serial baud rate. OBDLink/ELM defaults are commonly 38400, but verify the adapter setting."),
    durationSeconds: z.number().int().min(1).max(20).default(8).describe("Passive CAN capture duration for the battery messages. Maximum 20 seconds to reduce adapter-buffer risk."),
    profile: z.enum(["battery", "extended"]).default("battery").describe("battery: energy, extrema and brick voltages. extended: also 10 more Scan My Tesla-style messages, about 1.5 s each."),
  },
}, async ({ portPath, baudRate, durationSeconds, profile }) => safely(async () => {
  const capture = await capturePassiveElmCan({ path: portPath, baudRate, durationSeconds, profile });
  return {
    ...capture,
    safety: [
      "The capture contains adapter AT commands only and sends no Tesla CAN request frame.",
      "Do not run this tool while Scan My Tesla has an active Bluetooth Classic connection to the same adapter.",
      "Use a compatible Model 3/Y harness. Tesla states that the ordinary OBD-II port does not expose the internal CAN data used by Scan My Tesla.",
    ],
  };
}));

server.registerTool("tesla_battery_bms_constrained_calibration", {
  title: "Calibrate health with imported direct BMS energy",
  description: "Uses an imported Scan My Tesla or TeslaLogger diagnostic file and a saved evidence-backed as-new kWh reference to calculate a constrained direct-BMS nominal-energy retention result. The user must explicitly confirm comparable conditions. It never uses Scan My Tesla's retired Full Pack When New ratio in the result.",
  inputSchema: {
    vin: z.string().min(11).max(32).describe("Tesla VIN associated with the saved energy reference."),
    filePath: z.string().min(1).describe("Local Scan My Tesla or TeslaLogger diagnostic CSV/JSON export."),
    source: z.enum(["scanmytesla_export", "teslalogger_export"]).describe("Origin of the local export."),
    conditionsConfirmed: z.boolean().describe("True only after confirming the BMS reading and saved as-new reference are being compared under appropriate, documented conditions."),
    conditionNote: z.string().min(10).max(1000).optional().describe("The comparable conditions or reason for treating the direct BMS reading as a constrained calibration."),
  },
}, async ({ vin, filePath, source, conditionsConfirmed, conditionNote }) => safely(async () => {
  const diagnostics = await importBmsDiagnosticFile(filePath, source);
  const references = await getHealthReferences(vin);
  return {
    diagnostics,
    calibration: constrainedBmsCalibration(diagnostics, references.energyKwh, conditionsConfirmed, conditionNote),
    sourcePolicy: "BMS data is used only in this explicit constrained-calibration tool. It does not silently overwrite the Fleet API health-model suite.",
  };
}));

server.registerTool("tesla_battery_source_catalog", {
  title: "List battery data sources and hardware requirements",
  description: "Explains the Fleet API default and every optional Scan My Tesla, TeslaLogger, and direct CAN source before the user selects one. No connection, capture, or vehicle action occurs.",
}, async () => result({
  default: {
    source: "fleet_api_only",
    hardwareRequirement: "none beyond Tesla account access and a registered Tesla Fleet API application",
    detail: "Single live snapshot plus Fleet Telemetry history when the user configures it. It provides documented pack, brick-extrema, thermal-extrema, charging, and energy fields but does not expose every BMS signal or every cell voltage.",
  },
  optionalSources: [
    {
      source: "scanmytesla_export",
      hardwareRequirement: "Scan My Tesla-compatible Model 3/Y internal-CAN harness, CAN-capable adapter, Android app, and a local CSV/JSON export",
      detail: "Imports selected direct BMS evidence from a local app export. No app token or upload is required by this MCP.",
    },
    {
      source: "teslalogger_export",
      hardwareRequirement: "The Scan My Tesla app and its documented TeslaLogger integration, plus a local diagnostic export",
      detail: "Imports locally exported diagnostic values. Scan My Tesla's documented relay is separate from this MCP.",
    },
    {
      source: "direct_passive_can",
      hardwareRequirement: "Model 3/Y internal-CAN harness, a compatible ELM/STN Bluetooth Classic or USB serial adapter, and a Windows COM port or compatible macOS serial path",
      detail: "Runs a short passive CAN monitor and decodes only verified open Model 3/Y mappings. It cannot normally share one active Bluetooth Classic adapter with Scan My Tesla.",
    },
  ],
  sourceModes: [
    "fleet_api_only: default; health calculations use Fleet API and Fleet Telemetry only.",
    "auto_prefer_bms_when_available: use direct BMS data for additional diagnostic detail, otherwise label a Fleet API fallback; BMS does not overwrite health percentage.",
    "compare_fleet_and_bms: show both sources and their provenance side by side when BMS data are available.",
    "bms_constrained_calibration: calculate direct BMS nominal-energy retention only after an evidence-backed as-new reference and explicit comparable-condition confirmation.",
  ],
  invariant: "The direct BMS source never silently changes the Fleet API health result. Scan My Tesla's retired Full Pack When New ratio remains excluded from health calculations.",
}));

server.registerTool("tesla_battery_health_by_source", {
  title: "Get battery health using Fleet API with optional BMS diagnostics",
  description: "Uses Fleet API as the default. Optional Scan My Tesla/TeslaLogger exports or an on-demand direct passive CAN capture add BMS evidence, compare sources, or enable only the explicit constrained calibration. If optional BMS data are unavailable, automatically returns a labeled Fleet API fallback rather than failing.",
  inputSchema: {
    ...vinInput,
    hours: z.number().int().min(1).max(24 * 365).default(720).describe("Fleet Telemetry health-model lookback window in hours."),
    sourceMode: z.enum(["fleet_api_only", "auto_prefer_bms_when_available", "compare_fleet_and_bms", "bms_constrained_calibration"]).default("fleet_api_only").describe("Selects the default Fleet API path or an optional BMS diagnostic behavior."),
    diagnosticKind: z.enum(["scanmytesla_export", "teslalogger_export", "direct_passive_can"]).optional().describe("Optional direct-BMS ingestion path. Omit for Fleet API only."),
    diagnosticFilePath: z.string().min(1).optional().describe("Required for Scan My Tesla or TeslaLogger local export import."),
    directPortPath: z.string().min(2).max(260).optional().describe("Required only for direct passive CAN capture: Windows COM port or compatible macOS serial device."),
    directBaudRate: z.number().int().min(9600).max(1_000_000).default(38400).describe("Direct serial-adapter baud rate."),
    directCaptureSeconds: z.number().int().min(1).max(20).default(8).describe("Direct passive CAN capture duration."),
    conditionsConfirmed: z.boolean().optional().describe("Required only to calculate BMS constrained calibration."),
    conditionNote: z.string().min(10).max(1000).optional().describe("Comparable-condition statement required for BMS constrained calibration."),
  },
}, async ({ vin, hours, sourceMode, diagnosticKind, diagnosticFilePath, directPortPath, directBaudRate, directCaptureSeconds, conditionsConfirmed, conditionNote }) => safely(async () => {
  const target = await resolveVin(vin);
  const references = await getHealthReferences(target);
  let fleet: Record<string, unknown>;
  try {
    const telemetry = await readTelemetry(target, hours);
    if (!telemetry.length) throw new Error("No qualifying Fleet Telemetry records were found.");
    fleet = { status: "fleet_telemetry_health_available", source: "fleet_telemetry", models: buildHealthModelSuite(target, telemetry, references, defaultHealthModelOptions) };
  } catch (telemetryError) {
    const snapshot = buildDashboard(recordFromLive(target, await getVehicleData(target)));
    fleet = {
      status: "fleet_api_live_snapshot_only",
      source: "fleet_api",
      snapshot,
      limitation: "Fleet Telemetry history is not configured or unavailable, so longitudinal health models cannot be calculated. A one-time live Fleet API snapshot is returned instead.",
      telemetryReason: telemetryError instanceof Error ? telemetryError.message : String(telemetryError),
    };
  }

  if (sourceMode === "fleet_api_only") {
    return {
      selectedSourceMode: sourceMode,
      effectiveHealthSource: "fleet_api",
      hardwareRequirement: "none beyond Tesla Fleet API access",
      fleet,
      optionalBmsStatus: "not_requested",
    };
  }

  let diagnostics: Awaited<ReturnType<typeof importBmsDiagnosticFile>> | undefined;
  let bmsStatus = "not_available_falling_back_to_fleet_api";
  let bmsReason: string | undefined;
  try {
    if (diagnosticKind === "scanmytesla_export" || diagnosticKind === "teslalogger_export") {
      if (!diagnosticFilePath) throw new Error("diagnosticFilePath is required for the selected local export source.");
      diagnostics = await importBmsDiagnosticFile(diagnosticFilePath, diagnosticKind);
    } else if (diagnosticKind === "direct_passive_can") {
      if (!directPortPath) throw new Error("directPortPath is required for direct passive CAN capture.");
      diagnostics = (await capturePassiveElmCan({ path: directPortPath, baudRate: directBaudRate, durationSeconds: directCaptureSeconds })).snapshot;
    } else {
      throw new Error("No optional BMS source was supplied.");
    }
    bmsStatus = "available";
  } catch (bmsError) {
    bmsReason = bmsError instanceof Error ? bmsError.message : String(bmsError);
  }

  const output: Record<string, unknown> = {
    selectedSourceMode: sourceMode,
    fleet,
    bms: diagnostics ? { status: bmsStatus, diagnostics, healthInfluence: "diagnostic detail only unless sourceMode is bms_constrained_calibration" } : { status: bmsStatus, reason: bmsReason },
    fallback: diagnostics ? null : "Fleet API result remains active because optional BMS hardware/data were not available.",
  };
  if (sourceMode === "auto_prefer_bms_when_available") {
    output.effectiveHealthSource = "fleet_api";
    output.diagnosticDetailSource = diagnostics ? diagnostics.source : "fleet_api_only";
    output.policy = "BMS data adds diagnostic detail but does not override Fleet API health output.";
  } else if (sourceMode === "compare_fleet_and_bms") {
    output.effectiveHealthSource = "fleet_api";
    output.policy = "Both sources are retained side by side with provenance. No automated reconciliation or overwrite is performed.";
  } else {
    output.effectiveHealthSource = diagnostics ? "bms_constrained_calibration" : "fleet_api";
    output.calibration = diagnostics
      ? constrainedBmsCalibration(diagnostics, references.energyKwh, conditionsConfirmed === true, conditionNote)
      : { status: "unavailable_falling_back_to_fleet_api" };
    output.policy = "Only this explicit source mode allows direct BMS nominal energy to calculate an additional retention value.";
  }
  return output;
}));

const transport = new StdioServerTransport();
await server.connect(transport);
