import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const directory = dirname(fileURLToPath(import.meta.url));
const entry = join(directory, "httpMcpServer.js");
const port = 4781;
const token = "tesla-http-smoke-token-change-on-install";
const child = spawn(process.execPath, [entry], { env: { ...process.env, TESLA_HTTP_MCP_PORT: String(port), TESLA_HTTP_MCP_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"] });

function wait(milliseconds: number) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

try {
  await wait(450);
  const client = new Client({ name: "tesla-battery-http-smoke", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  const response = await client.listTools();
  const expected = ["tesla_dashboard_read", "tesla_dashboard_list_vehicles", "tesla_dashboard_source_policy"];
  const names = response.tools.map(tool => tool.name).sort();
  const missing = expected.filter(name => !names.includes(name));
  if (missing.length) throw new Error(`Missing HTTP MCP tools: ${missing.join(", ")}`);
  console.log(JSON.stringify({ status: "ok", tools: names }, null, 2));
  await client.close();
} finally {
  child.kill();
}
