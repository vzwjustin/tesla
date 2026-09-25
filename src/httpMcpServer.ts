import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { getDashboardSummary, getDashboardVehicleList } from "./dashboardData.js";

const host = process.env.TESLA_HTTP_MCP_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.TESLA_HTTP_MCP_PORT || 4761);
const token = process.env.TESLA_HTTP_MCP_TOKEN?.trim();
if (!token) {
  console.error("TESLA_HTTP_MCP_TOKEN is required. Set a high-entropy local token in the private environment file before starting the HTTP MCP server.");
  process.exit(1);
}
const httpMcpToken = token;

function isAuthorized(request: IncomingMessage): boolean {
  const header = request.headers.authorization;
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : "";
  return supplied.length === httpMcpToken.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(httpMcpToken));
}

async function parseBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

function makeServer() {
  const mcp = new McpServer({ name: "tesla-battery-dashboard-http", version: "1.0.0" }, {
    instructions: "Read-only Tesla battery dashboard companion. Fleet API is the default. Optional Scan My Tesla/OBD diagnostics are shown only as declared evidence; they never silently overwrite Fleet API results.",
  });
  const text = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
  const guarded = <T>(operation: () => Promise<T>) => operation().then(text).catch(error => ({ content: [{ type: "text" as const, text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2) }], isError: true }));

  mcp.registerTool("tesla_dashboard_read", {
    title: "Read Tesla battery dashboard",
    description: "Returns current Fleet API/Fleet Telemetry data, source status, optional BMS evidence, and health-model provenance. Read-only.",
    inputSchema: { vin: z.string().min(11).max(32).optional(), hours: z.number().int().min(1).max(8760).default(720) },
  }, ({ vin, hours }) => guarded(() => getDashboardSummary(vin, hours)));

  mcp.registerTool("tesla_dashboard_list_vehicles", {
    title: "List Tesla dashboard vehicles",
    description: "Lists the Tesla vehicles authorized for this local dashboard. Read-only.",
  }, () => guarded(() => getDashboardVehicleList()));

  mcp.registerTool("tesla_dashboard_source_policy", {
    title: "Explain Tesla dashboard sources",
    description: "Explains Fleet API default behavior and optional Scan My Tesla/TeslaLogger/direct-CAN diagnostic paths, including fallback and calibration safeguards.",
  }, async () => text({
    fleetApiDefault: true,
    sourceModes: ["fleet_api_only", "auto_prefer_bms_when_available", "compare_fleet_and_bms", "bms_constrained_calibration"],
    fallback: "If an optional BMS file, port, or adapter is unavailable, the dashboard returns a labeled Fleet API fallback.",
    bmsRule: "BMS diagnostics provide extra evidence. Only an explicit constrained calibration may calculate a separate direct-BMS retention value, using an evidence-backed as-new reference and confirmed comparable conditions.",
  }));
  return mcp;
}

const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
  if (request.url !== "/mcp") { response.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not found" })); return; }
  if (!isAuthorized(request)) { response.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" }).end(JSON.stringify({ error: "Bearer token required" })); return; }
  try {
    const body = await parseBody(request);
    const mcp = makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    await transport.handleRequest(request, response, body);
  } catch (error) {
    if (!response.headersSent) response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

server.listen(port, host, () => console.log(`Tesla HTTP MCP listening on http://${host}:${port}/mcp`));
