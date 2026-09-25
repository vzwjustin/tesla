import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(currentDirectory, "index.js");
const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry] });
const client = new Client({ name: "tesla-battery-mcp-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  const response = await client.listTools();
  const names = response.tools.map(tool => tool.name).sort();
  const expected = [
    "tesla_list_vehicles",
    "tesla_battery_live_snapshot",
    "tesla_battery_telemetry_snapshot",
    "tesla_battery_envelope_history",
    "tesla_battery_degradation",
    "tesla_battery_set_energy_baseline",
    "tesla_battery_degradation_evidence",
    "tesla_battery_health_model_catalog",
    "tesla_battery_set_health_reference",
    "tesla_battery_health_models",
    "tesla_scanmytesla_import_diagnostics",
    "tesla_scanmytesla_list_serial_ports",
    "tesla_scanmytesla_capture_passive_can",
    "tesla_battery_bms_constrained_calibration",
    "tesla_battery_source_catalog",
    "tesla_battery_health_by_source",
  ];
  const missing = expected.filter(name => !names.includes(name));
  if (missing.length) throw new Error(`Missing tools: ${missing.join(", ")}`);
  console.log(JSON.stringify({ status: "ok", toolCount: names.length, tools: names }, null, 2));
} finally {
  await client.close();
}
