import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { getDashboardSeries, getDashboardSummary, getDashboardVehicleList } from "./dashboardData.js";
import { getClusterSnapshot } from "./clusterData.js";
import { clusterHtml } from "./clusterPage.js";
import { dashboardHtml } from "./dashboardPage.js";

const host = process.env.TESLA_DASHBOARD_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.TESLA_DASHBOARD_PORT || 4760);
const token = process.env.TESLA_DASHBOARD_TOKEN?.trim();

if (!token) {
  console.error("TESLA_DASHBOARD_TOKEN is required. Set a high-entropy local token in the private environment file before starting the dashboard.");
  process.exit(1);
}
const dashboardToken = token;

function authorized(request: IncomingMessage): boolean {
  const header = request.headers.authorization;
  const cookie = request.headers.cookie || "";
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : cookie.match(/(?:^|;\s*)tesla_dashboard=([^;]+)/)?.[1];
  if (!supplied || supplied.length !== dashboardToken.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(dashboardToken));
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(body, null, 2));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${host}:${port}`);
  if (url.pathname === "/healthz") return sendJson(response, 200, { status: "ok", bind: `${host}:${port}` });
  if (url.pathname === "/" && url.searchParams.has("token")) {
    const supplied = url.searchParams.get("token") || "";
    if (supplied.length === dashboardToken.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(dashboardToken))) {
      response.writeHead(302, { "Set-Cookie": `tesla_dashboard=${dashboardToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`, Location: "/", "Cache-Control": "no-store" });
      response.end();
      return;
    }
  }
  if (!authorized(request)) return sendJson(response, 401, { error: "Local dashboard authorization required. Open the loopback URL with ?token=<TESLA_DASHBOARD_TOKEN>." });
  if (url.pathname === "/cluster" || url.pathname === "/cluster/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY" }); response.end(clusterHtml()); return;
  }
  if (url.pathname === "/api/cluster") {
    try { return sendJson(response, 200, await getClusterSnapshot()); }
    catch { return sendJson(response, 503, { error: "Telemetry unavailable" }); }
  }
  if (url.pathname === "/") {
    // Per-response nonce: only this page's own inline script may run, so an unescaped value from telemetry,
    // an alert, or a Supercharger site name cannot execute script alongside the dashboard cookie.
    const nonce = randomBytes(18).toString("base64");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
    response.end(dashboardHtml(nonce)); return;
  }
  if (url.pathname === "/api/summary") {
    try { return sendJson(response, 200, await getDashboardSummary(url.searchParams.get("vin") || undefined, Number(url.searchParams.get("hours")) || 2160, url.searchParams.get("sync") === "1")); } catch (error) { return sendJson(response, 502, { error: error instanceof Error ? error.message : String(error) }); }
  }
  if (url.pathname === "/api/series") {
    const hours = Math.min(8760, Math.max(1, Number(url.searchParams.get("hours")) || 168));
    try { return sendJson(response, 200, await getDashboardSeries(url.searchParams.get("vin") || undefined, hours)); } catch (error) { return sendJson(response, 502, { error: error instanceof Error ? error.message : String(error) }); }
  }
  if (url.pathname === "/api/vehicles") { try { return sendJson(response, 200, await getDashboardVehicleList()); } catch (error) { return sendJson(response, 502, { error: error instanceof Error ? error.message : String(error) }); } }
  return sendJson(response, 404, { error: "Not found" });
});

server.listen(port, host, () => console.log(`Tesla dashboard listening on http://${host}:${port}`));
