import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildDashboard, historySeries, recordFromLive, recordFromTelemetry } from "./analysis.js";
import { getHealthReferences } from "./degradation.js";
import { buildHealthModelSuite, defaultHealthModelOptions } from "./healthModels.js";
import { importBmsDiagnosticFile, type BmsDiagnosticSnapshot } from "./scanMyTesla.js";
import { capturePassiveElmCan } from "./serialCan.js";
import { getAccessToken, getVehicleData, listVehicles, resolveVin } from "./teslaApi.js";
import { mergeLatest, readTelemetry } from "./telemetry.js";
import type { TelemetryPoint } from "./types.js";
import { energySocFit, estimateSoh, fullChargeEvents, sohObservations, sohReferences, sohScenarios, type SohEstimate } from "./soh.js";

export type DashboardSummary = {
  generatedAt: string;
  vehicle: { vin: string; displayName?: string; state?: string };
  sources: Array<{ id: string; label: string; status: "available" | "not_configured" | "unavailable"; detail: string }>;
  latest: Record<string, unknown>;
  health?: Record<string, unknown>;
  rawSignals?: Record<string, unknown>;
  rawTimestamp?: string;
  history?: unknown[];
  syncResult?: string;
  analytics?: Record<string, unknown>;
  series?: Record<string, Array<[number, number]>>;
  warranty?: unknown;
  soh?: SohEstimate;
  sohScenarios?: unknown;
  charging?: unknown;
  chargeSessions?: unknown;
  alerts?: unknown;
  optionalBms?: BmsDiagnosticSnapshot;
  optionalBmsError?: string;
  attention?: AttentionItem[];
};

// One line in the dashboard's "needs attention" strip. Levels: ok = checked and fine, info = a suggested
// action, warn = something may be wrong, bad = likely problem. Every item states its evidence in `detail`.
export type AttentionItem = { id: string; level: "ok" | "info" | "warn" | "bad"; title: string; detail: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// PackVoltage reads ~4 V while the HV contactors are open (car asleep); those samples are not pack voltage.
const num = (point: TelemetryPoint, key: string) => { const v = point.signals[key]; return typeof v === "number" && Number.isFinite(v) && !(key === "PackVoltage" && v < 100) ? v : undefined; };
const round = (value: number, digits = 3) => Number(value.toFixed(digits));
const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

// Min/max-per-bucket downsampling. Plain every-Nth thinning drops short spikes (a DC fast-charge peak,
// a brick-spread excursion); keeping each bucket's lowest and highest sample preserves every extreme.
// Returns at most `max` points, first and last included, in time order.
export function downsample(data: Array<[number, number]>, max = 600): Array<[number, number]> {
  if (data.length <= max) return data;
  const buckets = Math.floor((max - 2) / 2), size = (data.length - 2) / buckets, out = [data[0]!];
  for (let b = 0; b < buckets; b++) {
    const from = 1 + Math.floor(b * size), to = 1 + Math.floor((b + 1) * size);
    let lo = from, hi = from;
    for (let k = from; k < to; k++) { if (data[k]![1] < data[lo]![1]) lo = k; if (data[k]![1] > data[hi]![1]) hi = k; }
    out.push(...(lo === hi ? [data[lo]!] : [data[Math.min(lo, hi)]!, data[Math.max(lo, hi)]!]));
  }
  out.push(data.at(-1)!);
  return out;
}

// Chart series, downsampled to at most `max` samples each.
export function buildSeries(points: TelemetryPoint[], max = 600): Record<string, Array<[number, number]>> {
  const pick = (f: (p: TelemetryPoint) => number | undefined) =>
    downsample(points.flatMap(p => { const v = f(p); return v === undefined ? [] : [[p.timestamp.valueOf(), round(v, 3)] as [number, number]]; }), max);
  const both = (a: string, b: string, f: (x: number, y: number) => number) => (p: TelemetryPoint) => { const x = num(p, a), y = num(p, b); return x === undefined || y === undefined ? undefined : f(x, y); };
  return {
    soc: pick(p => num(p, "Soc")),
    powerKw: pick(both("PackVoltage", "PackCurrent", (v, i) => v * i / 1000)),
    brickSpreadMv: pick(both("BrickVoltageMax", "BrickVoltageMin", (a, b) => (a - b) * 1000)),
    moduleTempMin: pick(p => num(p, "ModuleTempMin")),
    moduleTempMax: pick(p => num(p, "ModuleTempMax")),
  };
}

// Warranty rarely changes; cache a day. Failure only hides the tile.
let warrantyCache: { at: number; data: unknown } | undefined;
async function getWarranty(vin: string): Promise<unknown> {
  if (warrantyCache && Date.now() - warrantyCache.at < 86_400_000) return warrantyCache.data;
  const base = process.env.TESLA_BASE_URL?.trim() || "https://fleet-api.prd.na.vn.cloud.tesla.com";
  const response = await fetch(`${base}/api/1/dx/warranty/details?vin=${encodeURIComponent(vin)}`, { headers: { Authorization: `Bearer ${await getAccessToken()}` } });
  if (!response.ok) throw new Error(`warranty lookup failed: HTTP ${response.status}`);
  warrantyCache = { at: Date.now(), data: await response.json() };
  return warrantyCache.data;
}

// Charge sessions reconstructed from telemetry history (TeslaFi / Tessie / Fleet Telemetry).
// A session is a run of ChargeState Charging/Starting, ended by any other state or a >30 min gap.
//   wall kWh : ∫ ChargerPower dt (AC input side; steps capped at 10 min)
//   pack kWh : ΔEnergyRemaining          efficiency = pack ÷ wall
//   implied full pack = pack kWh ÷ ΔSOC × 100 (usable basis; sessions with ΔSOC ≥ 20 only)
// Home = TESLA_HOME_LATLON if set, else the most common ~100 m cell among AC session locations.
export function chargeSessionsFrom(points: TelemetryPoint[]): Record<string, unknown> {
  type S = { start: number; end: number; soc0?: number; soc1?: number; e0?: number; e1?: number; wall: number; peakKw: number; lat?: number; lon?: number; added?: number };
  const sessions: S[] = [];
  let cur: S | undefined, lastT = 0, lastKw = 0, soc: number | undefined, energy: number | undefined, lat: number | undefined, lon: number | undefined;
  const close = () => { if (cur && cur.end - cur.start >= 5 * 60_000) sessions.push(cur); cur = undefined; };
  for (const p of points) {
    const t = p.timestamp.valueOf(), st = p.signals.ChargeState;
    soc = num(p, "Soc") ?? soc; energy = num(p, "EnergyRemaining") ?? energy; lat = num(p, "Latitude") ?? lat; lon = num(p, "Longitude") ?? lon;
    const charging = st === "Charging" || st === "Starting";
    if (cur && t - lastT > 30 * 60_000) close();
    if (charging) {
      if (!cur) cur = { start: t, end: t, soc0: soc, e0: energy, wall: 0, peakKw: 0, lat, lon };
      else cur.wall += lastKw * Math.min(t - lastT, 600_000) / 3_600_000;
      const kw = num(p, "ChargerPower") ?? num(p, "AcChargingPower") ?? num(p, "DcChargingPower");
      if (kw !== undefined) lastKw = kw;
      cur.peakKw = Math.max(cur.peakKw, lastKw); cur.end = t; cur.soc1 = soc; cur.e1 = energy;
      const added = num(p, "AddedEnergy"); if (added !== undefined) cur.added = Math.max(cur.added ?? 0, added);
    } else if (typeof st === "string") { if (cur) { cur.soc1 = soc; cur.e1 = energy; } close(); }
    lastT = t;
  }
  close();
  const cell = (a?: number, b?: number) => a === undefined || b === undefined ? undefined : `${a.toFixed(3)},${b.toFixed(3)}`;
  const envHome = process.env.TESLA_HOME_LATLON?.split(",").map(Number);
  let home: string | undefined = envHome?.length === 2 ? cell(envHome[0], envHome[1]) : undefined;
  if (!home) { const c: Record<string, number> = {}; for (const s of sessions) { const k = cell(s.lat, s.lon); if (k && s.peakKw < 25) c[k] = (c[k] || 0) + 1; } home = Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0]; }
  const near = (s: S) => { if (!home || s.lat === undefined || s.lon === undefined) return false; const [a, b] = home.split(",").map(Number); return Math.hypot((s.lat - a!) * 111, (s.lon - b!) * 111 * Math.cos(a! * Math.PI / 180)) < 0.3; };
  const rate = Number(process.env.TESLA_HOME_RATE_PER_KWH) || undefined;
  const rows = sessions.map(s => {
    const type = s.peakKw >= 25 ? "DC fast" : near(s) ? "Home" : "Other AC";
    const pack = s.e0 !== undefined && s.e1 !== undefined ? s.e1 - s.e0 : undefined, dsoc = s.soc0 !== undefined && s.soc1 !== undefined ? s.soc1 - s.soc0 : undefined;
    const wall = s.added ?? (s.wall > 0 ? s.wall : undefined);
    return { start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString(), type, minutes: round((s.end - s.start) / 60000, 0), socFrom: s.soc0 === undefined ? undefined : round(s.soc0, 1), socTo: s.soc1 === undefined ? undefined : round(s.soc1, 1),
      wallKwh: wall === undefined ? undefined : round(wall, 2), packKwh: pack === undefined ? undefined : round(pack, 2), peakKw: round(s.peakKw, 1),
      // ChargerPower is whole-kW, so short sessions carry ±10–20% integration error; only report ≥5 kWh.
      efficiencyPct: wall && wall >= 5 && pack && pack >= 3 ? round(100 * pack / wall, 1) : undefined,
      impliedFullPackKwh: pack && dsoc && dsoc >= 20 ? round(pack / dsoc * 100, 2) : undefined,
      cost: type === "Home" && rate && wall ? round(wall * rate, 2) : undefined };
  }).reverse();
  const homeRows = rows.filter(r => r.type === "Home");
  const sum = (xs: Array<number | undefined>) => round(xs.reduce<number>((a, x) => a + (x ?? 0), 0), 1);
  const implied = rows.map(r => r.impliedFullPackKwh).filter((v): v is number => v !== undefined);
  const eff = homeRows.map(r => r.efficiencyPct).filter((v): v is number => v !== undefined);
  return {
    source: "reconstructed from telemetry history (ChargeState runs); wall kWh = ∫ChargerPower dt, pack kWh = ΔEnergyRemaining",
    homeLocated: Boolean(home), homeBasis: envHome?.length === 2 ? "TESLA_HOME_LATLON" : "most frequent AC charging location",
    sessions: rows.length, home: { sessions: homeRows.length, wallKwh: sum(homeRows.map(r => r.wallKwh)), packKwh: sum(homeRows.map(r => r.packKwh)), medianEfficiencyPct: eff.length ? round(median(eff), 1) : undefined, ...(rate ? { cost: sum(homeRows.map(r => r.cost)), ratePerKwh: rate } : {}) },
    capacityCrossCheck: implied.length ? { impliedUsableKwh: round(median(implied), 2), sessions: implied.length, min: Math.min(...implied), max: Math.max(...implied), basis: "median ΔEnergyRemaining ÷ ΔSOC × 100 over sessions with ΔSOC ≥ 20" } : undefined,
    rows,
  };
}

// Vehicle alerts (Fleet API recent_alerts). Account-level call; does not wake the car. Cached 10 min.
// Battery-relevant prefixes: BMS_ (battery management), CP_ (charge port), CC_/UMC_ (charge cable/connector), THC_ (thermal).
let alertCache: { at: number; data: unknown } | undefined;
async function getAlerts(vin: string): Promise<unknown> {
  if (alertCache && Date.now() - alertCache.at < 600_000) return alertCache.data;
  const base = process.env.TESLA_BASE_URL?.trim() || "https://fleet-api.prd.na.vn.cloud.tesla.com";
  const response = await fetch(`${base}/api/1/vehicles/${encodeURIComponent(vin)}/recent_alerts`, { headers: { Authorization: `Bearer ${await getAccessToken()}` } });
  if (!response.ok) throw new Error(`recent_alerts failed: HTTP ${response.status}`);
  const body = await response.json() as { response?: { recent_alerts?: Array<{ name: string; time: string; user_text?: string; audiences?: string[] }> } };
  const rows = (body.response?.recent_alerts || []).map(a => ({ name: a.name, time: new Date(a.time).toISOString(), text: a.user_text, battery: /^(BMS|CP|CC|UMC|THC|VCFRONT_a\d+_.*(12V|HV))/i.test(a.name) }));
  alertCache = { at: Date.now(), data: { total: rows.length, batteryRelated: rows.filter(r => r.battery).length, rows } };
  return alertCache.data;
}

// Supercharger session history (Tesla dx/charging/history; needs vehicle_charging_cmds). Cached 1 h.
let chargingCache: { at: number; data: unknown } | undefined;
async function getChargingHistory(vin: string): Promise<unknown> {
  if (chargingCache && Date.now() - chargingCache.at < 3_600_000) return chargingCache.data;
  const base = process.env.TESLA_BASE_URL?.trim() || "https://fleet-api.prd.na.vn.cloud.tesla.com";
  const token = await getAccessToken();
  type Fee = { feeType: string; usageBase?: number; usageTier1?: number; usageTier2?: number; totalDue?: number; netDue?: number; currencyCode?: string; uom?: string };
  type Session = { sessionId: number; siteLocationName?: string; chargeStartDateTime: string; chargeStopDateTime?: string; fees?: Fee[] };
  const sessions: Session[] = [];
  for (let page = 1; page <= 20; page++) {
    const response = await fetch(`${base}/api/1/dx/charging/history?vin=${encodeURIComponent(vin)}&pageNo=${page}&pageSize=50&sortBy=start_datetime&sortOrder=DESC`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`charging history failed: HTTP ${response.status}`);
    const body = await response.json() as { data?: Session[] };
    sessions.push(...(body.data || []));
    if ((body.data || []).length < 50) break;
  }
  const rows = sessions.map(s => {
    const charge = (s.fees || []).find(f => f.feeType === "CHARGING");
    const kwh = charge?.uom === "kwh" ? (charge.usageBase || 0) + (charge.usageTier1 || 0) + (charge.usageTier2 || 0) : undefined;
    const cost = (s.fees || []).reduce((a, f) => a + (f.netDue ?? f.totalDue ?? 0), 0);
    const minutes = s.chargeStopDateTime ? (Date.parse(s.chargeStopDateTime) - Date.parse(s.chargeStartDateTime)) / 60000 : undefined;
    return { start: s.chargeStartDateTime, site: s.siteLocationName, kwh: kwh === undefined ? undefined : round(kwh, 2), cost: round(cost, 2), currency: charge?.currencyCode, minutes: minutes === undefined ? undefined : round(minutes, 0), avgKw: kwh && minutes ? round(kwh / (minutes / 60), 1) : undefined };
  });
  const kwhTotal = rows.reduce((a, r) => a + (r.kwh || 0), 0), costTotal = rows.reduce((a, r) => a + r.cost, 0);
  chargingCache = { at: Date.now(), data: { source: "Tesla Supercharger history (dx/charging/history); home/AC charging is not included", sessions: rows.length, kwhTotal: round(kwhTotal, 1), costTotal: round(costTotal, 2), avgCostPerKwh: kwhTotal ? round(costTotal / kwhTotal, 3) : undefined, rows } };
  return chargingCache.data;
}

// Derived, clearly-labelled estimates from the telemetry window. Each returns undefined when evidence is insufficient.
export function computeAnalytics(points: TelemetryPoint[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  // Capacity from the SOC swing: EnergyRemaining = slope·Soc + buffer. slope×100 = usable full pack.
  const fit = energySocFit(points);
  const atFull = points.flatMap(p => { const e = num(p, "EnergyRemaining"), s = num(p, "Soc"); return e !== undefined && s !== undefined && s >= 99.5 ? [e] : []; });
  const nominalAt100 = atFull.length ? median(atFull) : undefined;
  if (fit && fit.socSpan >= 20) out.capacityFromSocSwing = { usableKwh: round(fit.usableKwh, 2), bufferKwh: round(nominalAt100 !== undefined ? nominalAt100 - fit.usableKwh : fit.bufferKwh, 2), bufferInclusiveKwh: round(nominalAt100 ?? fit.usableKwh + fit.bufferKwh, 2), bufferBasis: nominalAt100 !== undefined ? `EnergyRemaining at ≥99.5% SOC (${atFull.length} samples) − usable` : "fit intercept at 0% SOC", fitInterceptKwh: round(fit.bufferKwh, 2), rSquared: round(fit.rSquared, 4), samples: fit.samples, socSpanPct: round(fit.socSpan, 1), method: "least-squares EnergyRemaining vs Soc" };
  else if (fit) out.capacityFromSocSwing = { status: "needs ≥20% SOC swing", samples: fit.samples, socSpanPct: round(fit.socSpan, 1) };
  const nominal = points.map(p => num(p, "NominalFullPackEnergyKwh")).filter((v): v is number => v !== undefined);
  if (nominal.length) out.bmsNominalFullPackKwh = { latest: nominal.at(-1), min: Math.min(...nominal), max: Math.max(...nominal) };

  // Lifetime counter deltas across the window.
  const delta = (key: string) => { const v = points.map(p => num(p, key)).filter((x): x is number => x !== undefined); return v.length >= 2 ? round(v.at(-1)! - v[0]!, 3) : undefined; };
  const counters = Object.fromEntries(["LifetimeEnergyUsed", "LifetimeEnergyUsedDrive", "LifetimeEnergyGainedRegen", "LifetimeEnergyChargedKwh", "ACChargingEnergyIn", "DCChargingEnergyIn", "Odometer"].map(k => [k, delta(k)]).filter(([, v]) => v !== undefined));
  if (Object.keys(counters).length) out.windowDeltas = counters;
  const drive = counters.LifetimeEnergyUsedDrive as number | undefined, regen = counters.LifetimeEnergyGainedRegen as number | undefined;
  if (drive && regen !== undefined) out.regenRecoveredPct = round(regen / drive * 100, 1);

  // Consumption from lifetime counters: Δenergy ÷ Δodometer over the window. EnergyRemaining updates
  // less often than Odometer, so per-interval EnergyRemaining deltas undercount. Drive-only counter
  // preferred; LifetimeEnergyUsed also includes parked use (HVAC, Sentry, standby).
  const span = (key: string) => { const v = points.flatMap(p => { const x = num(p, key); return x === undefined ? [] : [x]; }); return v.length >= 2 ? v.at(-1)! - v[0]! : undefined; };
  const miles = span("Odometer"), driveKwh = span("LifetimeEnergyUsedDrive"), totalKwh = span("LifetimeEnergyUsed");
  if (miles && miles >= 1 && (driveKwh || totalKwh)) out.consumption = {
    whPerMile: round((driveKwh ?? totalKwh!) / miles * 1000, 0),
    basis: driveKwh ? "ΔLifetimeEnergyUsedDrive ÷ ΔOdometer (driving only)" : "ΔLifetimeEnergyUsed ÷ ΔOdometer (includes parked use)",
    ...(totalKwh ? { allInWhPerMile: round(totalKwh / miles * 1000, 0) } : {}),
    kwhUsed: round(driveKwh ?? totalKwh!, 1),
    miles: round(miles, 1),
  };
  // Quick pack resistance: −ΔV/ΔI between same-record samples ≤30 s apart with ≥30 A current step.
  // ponytail: crude step-response estimate; the resistance health model is the rigorous version.
  const vi = points.flatMap(p => { const v = num(p, "PackVoltage"), i = num(p, "PackCurrent"); return v !== undefined && i !== undefined ? [{ t: p.timestamp.valueOf(), v, i }] : []; });
  const rs: number[] = [];
  for (let k = 1; k < vi.length; k++) { const a = vi[k - 1]!, b = vi[k]!, di = b.i - a.i; if (b.t - a.t <= 30_000 && Math.abs(di) >= 30) { const r = -(b.v - a.v) / di; if (r > 0 && r < 1) rs.push(r); } }
  out.packResistance = rs.length >= 3 ? { milliohms: round(median(rs) * 1000, 1), steps: rs.length, method: "median −ΔV/ΔI, current steps ≥30 A" } : { status: "needs load steps (drive or charge start/stop)", steps: rs.length };

  // Imbalance / thermal envelopes over the window.
  const spreads = points.flatMap(p => { const a = num(p, "BrickVoltageMax"), b = num(p, "BrickVoltageMin"); return a !== undefined && b !== undefined ? [(a - b) * 1000] : []; });
  if (spreads.length) out.brickSpreadMv = { latest: round(spreads.at(-1)!, 1), min: round(Math.min(...spreads), 1), max: round(Math.max(...spreads), 1), median: round(median(spreads), 1), samples: spreads.length };
  const temps = points.flatMap(p => { const a = num(p, "ModuleTempMax"), b = num(p, "ModuleTempMin"); return a !== undefined && b !== undefined ? [[b, a] as const] : []; });
  if (temps.length) out.moduleTempC = { lowest: Math.min(...temps.map(t => t[0])), highest: Math.max(...temps.map(t => t[1])), maxSpread: Math.max(...temps.map(t => t[1] - t[0])) };
  const power = points.flatMap(p => { const v = num(p, "PackVoltage"), i = num(p, "PackCurrent"); return v !== undefined && i !== undefined ? [v * i / 1000] : []; });
  if (power.length) out.packPowerKw = { max: round(Math.max(...power), 2), min: round(Math.min(...power), 2), note: "PackVoltage × PackCurrent; sign follows Tesla PackCurrent" };
  const brickSoc = points.map(p => num(p, "BrickSocMinPercent")).filter((v): v is number => v !== undefined);
  const soc = points.map(p => num(p, "Soc")).filter((v): v is number => v !== undefined);
  if (brickSoc.length && soc.length) out.weakestBrickSocGapPct = round(soc.at(-1)! - brickSoc.at(-1)!, 2);
  // Pack voltage & cell balance. Rest = |PackCurrent| < 2 A (no IR drop).
  const rest = points.flatMap(p => { const v = num(p, "PackVoltage"), s = num(p, "Soc"), i = num(p, "PackCurrent"); return v !== undefined && s !== undefined && i !== undefined && Math.abs(i) < 2 ? [{ v, s }] : []; });
  // Bricks in series = PackVoltage ÷ mean brick voltage, from records carrying both.
  const ratios = points.flatMap(p => { const v = num(p, "PackVoltage"), a = num(p, "BrickVoltageMin"), b = num(p, "BrickVoltageMax"); return v !== undefined && a !== undefined && b !== undefined && a > 2 ? [v / ((a + b) / 2)] : []; });
  const series = ratios.length ? Math.round(median(ratios)) : undefined;
  const curve: Array<{ socFrom: number; socTo: number; samples: number; packV: number; perBrickV?: number }> = [];
  for (let lo = 0; lo < 100; lo += 5) {
    const hi = lo === 95 ? 100.01 : lo + 5, vs = rest.filter(r => r.s >= lo && r.s < hi).map(r => r.v);
    if (vs.length >= 3) { const v = median(vs); curve.push({ socFrom: lo, socTo: Math.min(hi, 100), samples: vs.length, packV: round(v, 1), ...(series ? { perBrickV: round(v / series, 3) } : {}) }); }
  }
  const full = rest.filter(r => r.s >= 99.5).map(r => r.v);
  const peak = points.map(p => num(p, "PackVoltage")).filter((v): v is number => v !== undefined);
  const count = (key: string) => { const c: Record<string, number> = {}; for (const p of points) { const v = num(p, key); if (v !== undefined) c[v] = (c[v] || 0) + 1; } return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([brick, n]) => ({ brick: Number(brick), samples: n })); };
  out.packVoltage = {
    bricksInSeries: series, bricksInSeriesBasis: series ? `median PackVoltage ÷ mean brick voltage over ${ratios.length} records` : "needs PackVoltage with BrickVoltageMin/Max",
    restSamples: rest.length, curve,
    ...(full.length ? { atFullRestV: round(median(full), 1), atFullPerBrickV: series ? round(median(full) / series, 3) : undefined, atFullSamples: full.length } : {}),
    ...(peak.length ? { peakV: round(Math.max(...peak), 1), peakPerBrickV: series ? round(Math.max(...peak) / series, 3) : undefined, minV: round(Math.min(...peak), 1) } : {}),
  };
  // Chemistry from brick voltage: LFP cells top out near 3.65 V, nickel (NCA/NMC) cells near 4.2 V.
  // LFP is only claimed once the pack has been seen near full, since a nickel pack also sits below 3.7 V at low SOC.
  const brickPeak = points.reduce((a, p) => Math.max(a, num(p, "BrickVoltageMax") ?? -Infinity), -Infinity);
  const socPeak = soc.reduce((a, v) => Math.max(a, v), -Infinity);
  const chem = brickPeak >= 3.95 ? "NCA/NMC" : brickPeak > 2 && brickPeak <= 3.7 && socPeak >= 95 ? "LFP" : undefined;
  if (chem) out.chemistry = { value: chem, basis: `peak BrickVoltageMax ${round(brickPeak, 3)} V at up to ${round(socPeak, 1)}% SOC` };
  out.cellBalance = { lowestBrickMostOften: count("NumBrickVoltageMin"), highestBrickMostOften: count("NumBrickVoltageMax"), thresholdsMv: { healthy: "<10", watch: "10–30", concern: ">30" }, note: "Tesla reports only min/max brick; per-brick voltages need OBD. Imbalance shows best at 100% SOC on LFP." };
  out.window = { records: points.length, from: points[0]?.timestamp.toISOString(), to: points.at(-1)?.timestamp.toISOString() };
  return out;
}

// Pulls the VPS telemetry file down via telemetry.sh before reading. Failure is reported, never fatal.
// Skipped when TESLA_TELEMETRY_VPS is unset: telemetry.sh cannot sync without it, so it would only ever fail.
async function syncTelemetry(): Promise<string | undefined> {
  if (!process.env.TESLA_TELEMETRY_VPS?.trim()) return undefined;
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "telemetry.sh");
  try {
    const { stdout } = await promisify(execFile)(script, ["sync"], { timeout: 60_000 });
    return stdout.trim();
  } catch (error) {
    return `sync failed: ${errorMessage(error)}`;
  }
}

// "Needs attention" checks. Each uses only evidence already on the dashboard; thresholds that are this
// dashboard's own screening policy (cell balance) say so. Sorted most severe first.
export function attentionItems(input: { latestAt?: string; syncResult?: string; chemistry?: string; lastFullChargeAt?: string | null; brickSpreadMedianMv?: number; alerts?: unknown }, now = Date.now()): AttentionItem[] {
  const items: AttentionItem[] = [];
  const age = (iso: string) => { const h = (now - Date.parse(iso)) / 3_600_000; return h < 1 ? `${Math.max(0, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`; };
  if (!input.latestAt) items.push({ id: "freshness", level: "info", title: "No Fleet Telemetry history", detail: "Showing one live snapshot. Health trends need local Fleet Telemetry records." });
  else if (now - Date.parse(input.latestAt) > 24 * 3_600_000) items.push({ id: "freshness", level: "warn", title: `Latest car data is ${age(input.latestAt)} old`, detail: "Normal while the car sleeps. If it has been driven or charged since, check the telemetry server (telemetry.sh status) and sync." });
  else items.push({ id: "freshness", level: "ok", title: `Car data ${age(input.latestAt)} old`, detail: `Latest Fleet Telemetry record ${input.latestAt}.` });
  if (input.syncResult?.startsWith("sync failed")) {
    const reason = input.syncResult.split(" · ")[0]!.split("\n").map(line => line.trim()).filter(Boolean).at(-1)!.replace(/^sync failed:\s*/, "");
    items.push({ id: "sync", level: "warn", title: "Telemetry sync failed", detail: `${reason.slice(0, 200)} Showing the last local copy.` });
  }
  // Tesla's Model 3/Y manual: with an LFP battery, keep the limit at 100% and fully charge to 100% at least once a week.
  if (input.chemistry === "LFP" && input.lastFullChargeAt !== undefined) {
    const days = input.lastFullChargeAt ? (now - Date.parse(input.lastFullChargeAt)) / 86_400_000 : undefined;
    if (days === undefined) items.push({ id: "fullCharge", level: "info", title: "No completed 100% charge in this window", detail: "Tesla recommends LFP packs reach 100% at least once a week (BMS calibration). It also anchors the SOH estimate. Check Controls > Charging for your car's current guidance." });
    else if (days > 7) items.push({ id: "fullCharge", level: "info", title: `Last 100% charge was ${Math.floor(days)} d ago`, detail: "Tesla recommends LFP packs reach 100% at least once a week so the BMS can recalibrate. Check Controls > Charging for your car's current guidance." });
    else items.push({ id: "fullCharge", level: "ok", title: "Weekly 100% charge done", detail: `Last completed full charge ${age(input.lastFullChargeAt!)} ago.` });
  }
  const alerts = input.alerts as { error?: string; rows?: Array<{ name: string; time: string; text?: string; battery?: boolean }> } | undefined;
  if (alerts?.rows) {
    const recent = alerts.rows.filter(row => row.battery && now - Date.parse(row.time) <= 7 * 86_400_000);
    items.push(recent.length
      ? { id: "alerts", level: "warn", title: `${recent.length} battery/charging alert${recent.length === 1 ? "" : "s"} this week`, detail: [...new Set(recent.map(row => row.text ? `${row.name} (${row.text})` : row.name))].slice(0, 3).join("; ") }
      : { id: "alerts", level: "ok", title: "No battery alerts this week", detail: `${alerts.rows.length} recent vehicle alert(s), none battery or charging related in 7 d.` });
  }
  const mv = input.brickSpreadMedianMv;
  if (mv !== undefined) items.push({ id: "cellBalance", level: mv < 10 ? "ok" : mv <= 30 ? "warn" : "bad", title: `Cell balance ${mv < 10 ? "healthy" : mv <= 30 ? "worth watching" : "a concern"}`, detail: `Median brick spread ${round(mv, 1)} mV over the window. Screening policy: <10 healthy, 10–30 watch, >30 concern; not Tesla limits.` });
  const rank = { bad: 0, warn: 1, info: 2, ok: 3 };
  return items.sort((a, b) => rank[a.level] - rank[b.level]);
}

// Chart series for the most recent `hours` of telemetry, anchored to the newest record rather than the
// wall clock so a car that has been asleep still shows its last day of data.
export async function getDashboardSeries(vin: string | undefined, hours: number) {
  const target = await resolveVin(vin);
  const points = await readTelemetry(target, Math.max(hours, 2160));
  const to = points.at(-1)?.timestamp.valueOf();
  const window = to === undefined ? [] : points.filter(point => point.timestamp.valueOf() >= to - hours * 3_600_000);
  return { hours, records: window.length, from: window[0]?.timestamp.toISOString(), to: window.at(-1)?.timestamp.toISOString(), series: buildSeries(window) };
}

export async function getDashboardSummary(vin?: string, hours = 2160, sync = false): Promise<DashboardSummary> {
  let syncResult = sync ? await syncTelemetry() : undefined;
  const target = await resolveVin(vin);
  const vehicle = (await listVehicles()).find(item => item.vin === target);
  const sources: DashboardSummary["sources"] = [];
  let latest: Record<string, unknown>;
  let health: Record<string, unknown> | undefined;
  let rawSignals: Record<string, unknown> | undefined;
  let rawTimestamp: string | undefined;
  let history: unknown[] | undefined;
  let analytics: Record<string, unknown> | undefined;
  let series: DashboardSummary["series"];
  let soh: SohEstimate | undefined;
  let scenarios: unknown;
  let chargeSessions: Record<string, unknown> | undefined;
  let lastFullChargeAt: string | null | undefined;

  try {
    const telemetry = await readTelemetry(target, hours);
    if (syncResult) syncResult += ` · ${telemetry.length} total with imported history`;
    const point = mergeLatest(telemetry);
    if (!point) throw new Error("No qualifying local Fleet Telemetry records were found.");
    latest = buildDashboard(recordFromTelemetry(point)) as unknown as Record<string, unknown>;
    rawSignals = point.signals;
    rawTimestamp = point.timestamp.toISOString();
    const numericFields = [...new Set(telemetry.flatMap(item => Object.keys(item.signals)))].sort();
    history = historySeries(telemetry, numericFields);
    analytics = computeAnalytics(telemetry);
    series = buildSeries(telemetry);
    chargeSessions = chargeSessionsFrom(telemetry);
    lastFullChargeAt = fullChargeEvents(telemetry).filter(event => event.completed).at(-1)?.at ?? null;
    const refs = await sohReferences(target);
    soh = estimateSoh(telemetry, refs, sohObservations());
    scenarios = sohScenarios(telemetry, soh, refs);
    health = buildHealthModelSuite(target, telemetry, await getHealthReferences(target), defaultHealthModelOptions);
    sources.push({ id: "fleetTelemetry", label: "Tesla Fleet Telemetry", status: "available", detail: `${telemetry.length} local record(s) in the selected ${hours}-hour window.` });
  } catch (telemetryError) {
    sources.push({ id: "fleetTelemetry", label: "Tesla Fleet Telemetry", status: "not_configured", detail: errorMessage(telemetryError) });
    const live = await getVehicleData(target);
    latest = buildDashboard(recordFromLive(target, live)) as unknown as Record<string, unknown>;
    sources.push({ id: "fleetApi", label: "Tesla Fleet API", status: "available", detail: "One live vehicle_data snapshot. Longitudinal health calculations require local Fleet Telemetry records." });
  }

  const result: DashboardSummary = {
    generatedAt: new Date().toISOString(),
    vehicle: { vin: target, ...(vehicle?.display_name ? { displayName: vehicle.display_name } : {}), ...(vehicle?.state ? { state: vehicle.state } : {}) },
    sources,
    latest,
    ...(health ? { health } : {}),
    ...(rawSignals ? { rawSignals, rawTimestamp } : {}),
    ...(history ? { history } : {}),
    ...(analytics ? { analytics } : {}),
    ...(series ? { series } : {}),
    ...(soh ? { soh } : {}),
    ...(scenarios ? { sohScenarios: scenarios } : {}),
    ...(chargeSessions ? { chargeSessions } : {}),
    ...(syncResult ? { syncResult } : {}),
  };

  try { result.warranty = await getWarranty(target); } catch { /* optional */ }
  try { result.alerts = await getAlerts(target); } catch (error) { result.alerts = { error: errorMessage(error) }; }
  try { result.charging = await getChargingHistory(target); } catch (error) { result.charging = { error: errorMessage(error) }; }

  await addOptionalBms(result);
  const chemistry = asRecord(analytics?.chemistry).value, spread = asRecord(analytics?.brickSpreadMv).median;
  result.attention = attentionItems({ latestAt: rawTimestamp, syncResult, chemistry: typeof chemistry === "string" ? chemistry : undefined, lastFullChargeAt, brickSpreadMedianMv: typeof spread === "number" ? spread : undefined, alerts: result.alerts });
  return result;
}

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

async function addOptionalBms(result: DashboardSummary): Promise<void> {
  const scanMyTeslaPath = process.env.TESLA_SCANMYTESLA_EXPORT_FILE?.trim();
  const teslaLoggerPath = process.env.TESLA_TESLALOGGER_EXPORT_FILE?.trim();
  const directPort = process.env.TESLA_DIRECT_CAN_PORT?.trim();
  if (!scanMyTeslaPath && !teslaLoggerPath && !directPort) {
    result.sources.push({ id: "directBms", label: "Scan My Tesla / Direct BMS", status: "not_configured", detail: "Optional. Configure a local Scan My Tesla or TeslaLogger export path to show higher-detail BMS evidence." });
    return;
  }
  try {
    if (directPort) {
      const capture = await capturePassiveElmCan({
        path: directPort,
        baudRate: Number(process.env.TESLA_DIRECT_CAN_BAUD || 38400),
        durationSeconds: Number(process.env.TESLA_DIRECT_CAN_SECONDS || 8),
      });
      result.optionalBms = capture.snapshot;
      result.sources.push({ id: "directBms", label: "Scan My Tesla / Direct BMS", status: "available", detail: `On-demand passive CAN capture: ${capture.frameCount} frame(s); ${capture.rawLinesDropped} unparsed line(s).` });
    } else {
      const path = scanMyTeslaPath || teslaLoggerPath!;
      const source = scanMyTeslaPath ? "scanmytesla_export" : "teslalogger_export";
      result.optionalBms = await importBmsDiagnosticFile(path, source);
      result.sources.push({ id: "directBms", label: "Scan My Tesla / Direct BMS", status: "available", detail: `Imported local ${source === "scanmytesla_export" ? "Scan My Tesla" : "TeslaLogger"} diagnostic export.` });
    }
  } catch (bmsError) {
    result.optionalBmsError = errorMessage(bmsError);
    result.sources.push({ id: "directBms", label: "Scan My Tesla / Direct BMS", status: "unavailable", detail: result.optionalBmsError });
  }
}

export async function getDashboardVehicleList() {
  return (await listVehicles()).map(vehicle => ({ vin: vehicle.vin, displayName: vehicle.display_name, state: vehicle.state }));
}
