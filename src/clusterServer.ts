import { createServer } from "node:http";
import { getClusterSnapshot } from "./clusterData.js";
import { clusterHtml } from "./clusterPage.js";

// The private container port is reachable only through Caddy's authenticated HTTPS route.
const server = createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  const path = new URL(request.url || "/", "http://localhost").pathname;
  if (request.method !== "GET") { response.writeHead(405); response.end(); return; }
  if (path === "/cluster" || path === "/cluster/") {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(clusterHtml()); return;
  }
  if (path === "/api/cluster") {
    response.setHeader("Content-Type", "application/json");
    try { response.end(JSON.stringify(await getClusterSnapshot())); }
    catch { response.writeHead(503); response.end(JSON.stringify({ error: "Telemetry unavailable" })); }
    return;
  }
  response.writeHead(404); response.end();
});
server.listen(Number(process.env.PORT || 4761), process.env.HOST || "127.0.0.1", () => console.log("Telemetry cluster ready"));
