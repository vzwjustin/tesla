import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { getAccessToken, saveTokenCache, teslaAudience, TOKEN_ENDPOINT } from "./teslaApi.js";

const redirectUri = process.env.TESLA_REDIRECT_URI?.trim() || "http://127.0.0.1:43189/callback";
const clientId = process.env.TESLA_CLIENT_ID?.trim();
const clientSecret = process.env.TESLA_CLIENT_SECRET?.trim();

if (!clientId || !clientSecret) {
  console.error("TESLA_CLIENT_ID and TESLA_CLIENT_SECRET are required. Source the private environment file before running this script.");
  process.exit(1);
}

const callback = new URL(redirectUri);
// Paste mode (https) never listens, so only the http listener needs a loopback host.
if (callback.protocol !== "https:" && callback.hostname !== "127.0.0.1" && callback.hostname !== "localhost") {
  console.error("For safety this local OAuth helper only accepts a loopback TESLA_REDIRECT_URI.");
  process.exit(1);
}

const state = randomBytes(24).toString("base64url");
const authorizeUrl = new URL("https://auth.tesla.com/oauth2/v3/authorize");
authorizeUrl.search = new URLSearchParams({
  response_type: "code",
  client_id: clientId,
  redirect_uri: redirectUri,
  scope: "openid offline_access vehicle_device_data vehicle_charging_cmds",
  state,
  prompt: "login",
  require_requested_scopes: "true",
}).toString();

async function completeAuthorization(url: URL): Promise<void> {
  if (url.searchParams.get("state") !== state) throw new Error("OAuth state mismatch. Close the browser and run the helper again.");
  const error = url.searchParams.get("error");
  if (error) throw new Error(`Tesla authorization failed: ${error}`);
  const code = url.searchParams.get("code");
  if (!code) throw new Error("Tesla callback did not include an authorization code.");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId!,
    client_secret: clientSecret!,
    code,
    audience: teslaAudience(),
    redirect_uri: redirectUri,
  });
  const tokenResponse = await fetch(TOKEN_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const raw = await tokenResponse.text();
  if (!tokenResponse.ok) throw new Error(`Tesla token exchange failed (${tokenResponse.status}): ${raw.slice(0, 500)}`);
  const token = JSON.parse(raw) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!token.access_token || !token.refresh_token) throw new Error("Tesla token response did not include both access_token and refresh_token.");
  await saveTokenCache({ accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: Date.now() + Math.max(0, (token.expires_in || 300) - 60) * 1000 });
  console.log("Tesla authorization completed. Token cache written with restricted permissions.");
}

if (callback.protocol === "https:") {
  // ponytail: Tesla requires an https redirect, so no local TLS listener; the browser shows a load error and the user pastes the address bar URL.
  console.log("Open this Tesla authorization URL in a browser:\n");
  console.log(authorizeUrl.toString());
  console.log("\nAfter signing in, the browser will fail to load the callback page. That is expected.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pasted = await rl.question("Paste the full URL from the browser address bar: ");
  rl.close();
  try {
    const url = new URL(pasted.trim());
    if (url.origin !== callback.origin || url.pathname.replace(/\/$/, "") !== callback.pathname.replace(/\/$/, "")) throw new Error("Pasted URL does not match TESLA_REDIRECT_URI.");
    await completeAuthorization(url);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
} else {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", redirectUri);
      if (url.pathname !== callback.pathname) {
        response.writeHead(404).end("Not found");
        return;
      }
      await completeAuthorization(url);
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<h1>Tesla authorization completed.</h1><p>You may close this tab and return to the terminal.</p>");
      server.close();
    } catch (error) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Tesla authorization failed. Check the terminal.");
      console.error((error as Error).message);
      server.close();
      process.exitCode = 1;
    }
  });

  server.listen(Number(callback.port || "80"), callback.hostname, () => {
    console.log("Open this Tesla authorization URL in a browser:\n");
    console.log(authorizeUrl.toString());
    console.log("\nWaiting for the local callback. This helper does not retain the client secret.");
  });
}

void getAccessToken; // Retain a compile-time link to the shared authentication module.
