import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import type { JsonObject, JsonValue } from "./types.js";

const TOKEN_ENDPOINT = "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token";
const DEFAULT_BASE_URL = "https://fleet-api.prd.na.vn.cloud.tesla.com";

type TokenCache = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
};

type TeslaTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};

export type TeslaVehicle = {
  id?: number;
  vehicle_id?: number;
  vin?: string;
  display_name?: string;
  state?: string;
  [key: string]: JsonValue | undefined;
};

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? path.replace("~", homedir()) : path;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required. Add it to the private environment file configured for this MCP.`);
  return value;
}

function baseUrl(): string {
  return (process.env.TESLA_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, "");
}

function tokenCachePath(): string {
  return expandHome(process.env.TESLA_TOKEN_CACHE_FILE?.trim() || "~/.config/tesla-battery-mcp/token-cache.json");
}

async function readTokenCache(): Promise<TokenCache> {
  try {
    const raw = await readFile(tokenCachePath(), "utf8");
    const parsed = JSON.parse(raw) as TokenCache;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    throw new Error(`Unable to read TESLA_TOKEN_CACHE_FILE: ${(error as Error).message}`);
  }
}

export async function saveTokenCache(cache: TokenCache): Promise<void> {
  const target = tokenCachePath();
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, `${JSON.stringify(cache, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function fetchToken(params: URLSearchParams): Promise<TeslaTokenResponse> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
    signal: AbortSignal.timeout(Number(process.env.TESLA_REQUEST_TIMEOUT_MS || 20_000)),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Tesla authentication failed (${response.status}). ${raw.slice(0, 500)}`);
  }
  let data: TeslaTokenResponse;
  try {
    data = JSON.parse(raw) as TeslaTokenResponse;
  } catch {
    throw new Error("Tesla authentication returned a non-JSON response.");
  }
  if (!data.access_token) throw new Error("Tesla authentication response did not include access_token.");
  return data;
}

export async function getAccessToken(): Promise<string> {
  const directToken = process.env.TESLA_ACCESS_TOKEN?.trim();
  if (directToken) return directToken;

  const cache = await readTokenCache();
  if (cache.accessToken && cache.expiresAt && cache.expiresAt > Date.now() + 60_000) {
    return cache.accessToken;
  }

  const refreshToken = cache.refreshToken || process.env.TESLA_REFRESH_TOKEN?.trim();
  if (!refreshToken) {
    throw new Error("No Tesla access token or refresh token found. Run `pnpm oauth` or add TESLA_REFRESH_TOKEN to the private environment file.");
  }

  const token = await fetchToken(new URLSearchParams({
    grant_type: "refresh_token",
    client_id: requiredEnv("TESLA_CLIENT_ID"),
    refresh_token: refreshToken,
  }));

  await saveTokenCache({
    accessToken: token.access_token,
    refreshToken: token.refresh_token || refreshToken,
    expiresAt: Date.now() + Math.max(0, (token.expires_in || 300) - 60) * 1000,
  });
  return token.access_token;
}

function allowlisted(vin: string): boolean {
  const list = process.env.TESLA_VIN_ALLOWLIST?.split(",").map(value => value.trim()).filter(Boolean);
  return !list?.length || list.includes(vin);
}

async function requestTesla<T>(path: string): Promise<T> {
  const response = await fetch(`${baseUrl()}${path}`, {
    headers: { Authorization: `Bearer ${await getAccessToken()}` },
    signal: AbortSignal.timeout(Number(process.env.TESLA_REQUEST_TIMEOUT_MS || 20_000)),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Tesla Fleet API request failed (${response.status}) for ${path}. ${raw.slice(0, 700)}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Tesla Fleet API returned non-JSON content for ${path}.`);
  }
}

export async function listVehicles(): Promise<TeslaVehicle[]> {
  const result = await requestTesla<{ response?: TeslaVehicle[]; vehicles?: TeslaVehicle[] }>("/api/1/vehicles");
  return result.response || result.vehicles || [];
}

export async function resolveVin(requestedVin?: string): Promise<string> {
  if (requestedVin) {
    if (!allowlisted(requestedVin)) throw new Error("Requested VIN is not included in TESLA_VIN_ALLOWLIST.");
    return requestedVin;
  }
  const vehicles = await listVehicles();
  const candidates = vehicles.map(vehicle => vehicle.vin).filter((vin): vin is string => typeof vin === "string" && allowlisted(vin));
  if (candidates.length === 0) throw new Error("No Tesla VIN is available for this account or VIN allowlist.");
  if (candidates.length > 1) throw new Error(`Multiple vehicles are available. Supply a VIN explicitly: ${candidates.join(", ")}`);
  return candidates[0]!;
}

export async function getVehicleData(vin: string): Promise<JsonObject> {
  if (!allowlisted(vin)) throw new Error("Requested VIN is not included in TESLA_VIN_ALLOWLIST.");
  const result = await requestTesla<{ response?: JsonObject }>(`/api/1/vehicles/${encodeURIComponent(vin)}/vehicle_data`);
  if (!result.response || typeof result.response !== "object") throw new Error("Tesla Fleet API did not return a vehicle data response.");
  return result.response;
}

export function teslaAudience(): string {
  return baseUrl();
}

export { TOKEN_ENDPOINT };
