import { getHealthReferences } from "./degradation.js";
import type { TelemetryPoint } from "./types.js";

// State of health, capacity definition (IEEE 1188 / IEC 62660-1 / ISO 12405-4):
//   SOH = full-charge capacity now ÷ full-charge capacity when new × 100
// Full-charge capacity is not measured directly, so it is inferred from signals the BMS reports:
//   rated range  : full = RatedRange at qualified completed full charges   compared with the as-new rated range
//   energy swing : full = slope(EnergyRemaining vs Soc) × 100  compared with the as-new energy (cancels any fixed offset)
//   BMS nominal  : NominalFullPackEnergyKwh                   compared with the as-new nominal energy
// Uncertainty is propagated for a ratio: σ_rel² = (σ_x/x)² + (σ_soc/soc)² + (σ_ref/ref)².
// The estimate is the inverse-variance weighted mean Σ(wᵢ·SOHᵢ)/Σwᵢ with wᵢ = 1/σᵢ².
// EnergyRemaining ÷ Soc is NOT used: EnergyRemaining includes ~2 kWh held below 0% SOC (fit
// intercept on this car), so that ratio drifts from ~57.9 kWh at 45% SOC to ~55.6 kWh at 90%.
// The swing slope removes the offset.
// Full-charge events (the primary evidence). An event is a run of SOC ≥ 99.5 (split by >3 h gaps).
// It qualifies only if the BMS reported ChargeState "Complete" (charging stopped early or unplugged
// before completion reads 1–1.5% low) and the pack was ≤ 40 °C (hot packs read low). Each event is
// valued from samples within 15 min of completion, before standby draw decays the reading. The
// estimate is the median of qualified events in the most recent 30 days (all qualified if fewer than
// 3). Uncertainty = √(σ_stat² + σ_BMS² + σ_ref²), σ_stat = 1.2533·s/√n (standard error of a median),
// σ_BMS = 0.3% systematic full-charge anchoring, σ_ref = reference uncertainty.
// All three read the same BMS state, so their errors are correlated. The reported σ is the
// smallest single-method σ, not the (over-confident) independent-errors pooled σ.

// *SigmaPct is the reference's own relative uncertainty in percent. 0 = verified (e.g. EPA range).
// A rated-range reading the user saw on screen at a known SOC (e.g. 252 mi at 100%). Used only
// by the rated-range method, and only when telemetry has no sample nearer to full.
export type SohObservation = { soc: number; ratedRangeMi: number; at: string };

export type SohReferences = { ahNew?: number; ratedRangeMi?: number; energyKwh?: number; energyKwhSigmaPct?: number; nominalKwh?: number; nominalKwhSigmaPct?: number };

export type SohMethod = {
  method: "rated_range" | "energy_point" | "energy_swing" | "bms_nominal" | "session_energy" | "coulomb";
  sohPercent: number;
  sigmaPercent: number;
  fullValue: number;
  unit: "mi" | "kWh" | "Ah";
  reference: number;
  samples: number;
  basis: string;
  referenceVerified: boolean;
  // energy_swing only: intercept at 0% SOC (energy held below 0%) and the buffer-inclusive total,
  // which is the basis Tesla's in-car battery test and NominalFullPackEnergyKwh use.
  bufferKwh?: number;
  fullIncludingBufferKwh?: number;
  usedInEstimate: boolean;
  note?: string;
  trendPer30d?: number; // SOH points per 30 days, from the linear fit over qualified events
};

export type SohEstimate =
  | { status: "available"; sohPercent: number; sigmaPercent: number; ci95Percent: [number, number]; confidence: "high" | "medium" | "low"; confidenceBasis: string; methods: SohMethod[]; skipped: string[]; warnings: string[]; formula: string; fullChargeEvents?: FullChargeEvent[]; trendPer30d?: number; trendAdjustmentPts?: number; correlation?: number; usableFullPackKwh?: number; nominalFullPackKwh?: { value: number; source: string; samples: number }; bufferKwh?: number }
  | { status: "insufficient_inputs"; methods: SohMethod[]; skipped: string[]; formula: string };

const FORMULA = "SOH = full-charge capacity now ÷ as-new capacity × 100. Best overall fuses up to 5 evidence families (EPA rated range at qualified full charges, usable-energy swing fit, nominal pack at full, per-session ΔEnergy÷ΔSOC, coulomb count), each cross-checked against the EPA anchor, weighted 1/σ², σ combined with ρ = 0.6 correlation (all share BMS SOC), then moved to today by the full-charge fade trend.";
// All methods lean on the BMS SOC, so their errors are positively correlated; 0.6 is a deliberate,
// conservative middle between independent (0, over-confident) and identical (1, ignores extra evidence).
const RHO = 0.6;
const EVENT_WINDOW_MS = 15 * 60_000, RECENT_MS = 30 * 86_400_000, MAX_TEMP_C = 40, BMS_ANCHOR_PCT = 0.3;

export type FullChargeEvent = { at: string; ratedFullMi?: number; energyFullKwh?: number; packTempC?: number; completed: boolean; qualified: boolean; reason?: string };

export function fullChargeEvents(points: TelemetryPoint[]): FullChargeEvent[] {
  type E = { t0: number; last: number; done?: number; states: Set<string>; temps: number[]; samples: Array<{ t: number; r?: number; e?: number }> };
  const events: E[] = [];
  let cur: E | undefined, state: string | undefined, temp: number | undefined;
  for (const p of points) {
    if (typeof p.signals.ChargeState === "string") state = p.signals.ChargeState;
    temp = num(p, "ModuleTempMax") ?? temp;
    const s = num(p, "Soc"), t = p.timestamp.valueOf();
    if (s === undefined || s < 99.5) continue;
    if (!cur || t - cur.last > 3 * 3_600_000) { cur = { t0: t, last: t, states: new Set(), temps: [], samples: [] }; events.push(cur); }
    cur.last = t;
    if (state) cur.states.add(state);
    if (state === "Complete" && cur.done === undefined) cur.done = t;
    if (temp !== undefined) cur.temps.push(temp);
    const r = num(p, "RatedRange"), e = num(p, "EnergyRemaining");
    cur.samples.push({ t, ...(r !== undefined ? { r: r / (s / 100) } : {}), ...(e !== undefined ? { e } : {}) });
  }
  return events.map(ev => {
    const from = ev.done ?? ev.t0, win = ev.samples.filter(x => x.t >= from && x.t - from <= EVENT_WINDOW_MS);
    const rs = win.flatMap(x => x.r === undefined ? [] : [x.r]), es = win.flatMap(x => x.e === undefined ? [] : [x.e]);
    const packTempC = ev.temps.length ? median(ev.temps) : undefined, completed = ev.done !== undefined;
    const reason = !completed ? "no BMS Complete (stopped or unplugged early)" : packTempC !== undefined && packTempC > MAX_TEMP_C ? `pack ${packTempC} °C > ${MAX_TEMP_C} °C` : !rs.length && !es.length ? "no readings in window" : undefined;
    return { at: new Date(from).toISOString(), ...(rs.length ? { ratedFullMi: r2(median(rs)) } : {}), ...(es.length ? { energyFullKwh: r2(median(es)) } : {}), ...(packTempC !== undefined ? { packTempC } : {}), completed, qualified: !reason, ...(reason ? { reason } : {}) };
  });
}

// Median of qualified events' values (recent 30 days, else all), with σ_stat and a linear trend per 30 days.
function eventStats(events: FullChargeEvent[], pick: (e: FullChargeEvent) => number | undefined) {
  const q = events.flatMap(e => { const v = pick(e); return e.qualified && v !== undefined ? [{ t: Date.parse(e.at), v }] : []; });
  if (!q.length) return undefined;
  const latest = q.at(-1)!.t, recent = q.filter(x => latest - x.t <= RECENT_MS), use = recent.length >= 3 ? recent : q;
  const vs = use.map(x => x.v), n = vs.length, mean = vs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(vs.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : 0;
  let trendPer30d: number | undefined;
  if (q.length >= 5 && q.at(-1)!.t - q[0]!.t >= 14 * 86_400_000) {
    const mt = q.reduce((a, x) => a + x.t, 0) / q.length, mv = q.reduce((a, x) => a + x.v, 0) / q.length;
    trendPer30d = q.reduce((a, x) => a + (x.t - mt) * (x.v - mv), 0) / q.reduce((a, x) => a + (x.t - mt) ** 2, 0) * RECENT_MS;
  }
  return { value: median(vs), n, statRel: n > 1 ? 1.2533 * sd / Math.sqrt(n) / median(vs) : 0.005, recent: use === recent, from: new Date(use[0]!.t).toISOString().slice(0, 10), to: new Date(latest).toISOString().slice(0, 10), totalQualified: q.length, trendPer30d };
}

// BMS SOC error, in SOC points. The LFP voltage curve is flat between ~15% and ~95%, so the BMS
// SOC is only well anchored near the ends of the curve (a full charge or a deep discharge).
function socSigma(soc: number): number {
  return soc >= 99.5 ? 0.5 : soc >= 95 || soc <= 10 ? 1 : soc >= 80 ? 2 : 3;
}
const r2 = (v: number) => Math.round(v * 100) / 100;
const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

const num = (point: TelemetryPoint, key: string) => { const v = point.signals[key]; return typeof v === "number" && Number.isFinite(v) ? v : undefined; };

// Per-sample ratio estimate. Prefers samples nearest a full charge, where SOC error is smallest.
function ratioMethod(points: TelemetryPoint[], field: string, reference: number, quantSigma: number, method: SohMethod["method"], unit: SohMethod["unit"], refSigmaPct = 0, manual: SohObservation[] = [], verified = refSigmaPct === 0): SohMethod | undefined {
  const telemetry = points.flatMap(p => { const x = num(p, field), s = num(p, "Soc"); return x !== undefined && s !== undefined && s >= 5 ? [{ x, s, manual: false }] : []; });
  const bestTelemetry = Math.max(-1, ...telemetry.map(p => p.s));
  const samples = [...telemetry, ...manual.filter(o => o.soc > bestTelemetry + 2).map(o => ({ x: o.ratedRangeMi, s: o.soc, manual: true }))];
  if (!samples.length) return undefined;
  // At a completed full charge (SOC ≥ 99.5) the reading IS the full-pack value and the BMS has just
  // recalibrated, so use only those samples. Otherwise fall back to the 2-point window below the best SOC.
  const best = Math.max(...samples.map(p => p.s));
  const chosen = samples.filter(p => best >= 99.5 ? p.s >= 99.5 : best - p.s <= 2);
  // Median: the value decays while the car sits at "100%" (self-discharge, standby draw).
  const full = median(chosen.map(p => p.x / (p.s / 100)));
  const soc = median(chosen.map(p => p.s));
  const rel = Math.hypot(quantSigma / (full * soc / 100), socSigma(soc) / soc, refSigmaPct / 100);
  const soh = 100 * full / reference;
  return { method, sohPercent: r2(soh), sigmaPercent: r2(soh * rel), fullValue: r2(full), unit, reference, samples: chosen.length, basis: (best >= 99.5 ? `median ${field} at ≥99.5% SOC (completed full charge)` : `median ${field} ÷ Soc at ~${r2(soc)}% SOC`) + (chosen.some(p => p.manual) ? ` (user-reported reading: ${manual.map(o => `${o.ratedRangeMi} mi at ${o.soc}% on ${o.at}`).join(', ')})` : ''), referenceVerified: verified, usedInEstimate: true };
}

// Least-squares fit EnergyRemaining = slope·Soc + intercept over the window. slope·100 is usable
// full-pack energy; intercept is energy the BMS still reports at 0% SOC (the below-zero buffer).
export function energySocFit(points: TelemetryPoint[]): { usableKwh: number; bufferKwh: number; rSquared: number; samples: number; socSpan: number; slopeSe: number } | undefined {
  const xy = points.flatMap(p => { const e = num(p, "EnergyRemaining"), s = num(p, "Soc"); return e !== undefined && s !== undefined ? [[s, e] as const] : []; });
  if (xy.length < 5) return undefined;
  const xs = xy.map(p => p[0]), ys = xy.map(p => p[1]), n = xy.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0), sxy = xs.reduce((a, x, i) => a + (x - mx) * (ys[i]! - my), 0), syy = ys.reduce((a, y) => a + (y - my) ** 2, 0);
  if (!sxx || !syy) return undefined;
  const slope = sxy / sxx, intercept = my - slope * mx;
  const sse = xs.reduce((a, x, i) => a + (ys[i]! - (intercept + slope * x)) ** 2, 0);
  return { usableKwh: slope * 100, bufferKwh: intercept, rSquared: sxy * sxy / (sxx * syy), samples: n, socSpan: Math.max(...xs) - Math.min(...xs), slopeSe: n > 2 ? Math.sqrt(sse / (n - 2) / sxx) * 100 : 0 };
}

// Least-squares slope of EnergyRemaining on Soc. Needs a ≥20-point SOC swing.
function swingMethod(points: TelemetryPoint[], reference: number, refSigmaPct = 0, nominalNow?: number): SohMethod | string {
  // Most recent 30 days when that window alone spans ≥20% SOC, so the slope reflects the pack now.
  const last = points.at(-1)?.timestamp.valueOf() ?? 0, recentPts = points.filter(p => last - p.timestamp.valueOf() <= RECENT_MS);
  const recentFit = energySocFit(recentPts), fit = recentFit && recentFit.socSpan >= 20 ? recentFit : energySocFit(points);
  if (!fit) return "energy_swing: fewer than 5 paired EnergyRemaining + Soc samples";
  const span = fit.socSpan, n = fit.samples, full = fit.usableKwh, intercept = fit.bufferKwh;
  if (span < 20) return `energy_swing: SOC swing ${r2(span)}%, need ≥20%`;
  // SOC scale error (BMS miscalibration) is spread over the swing; ~1 point at each end.
  const scaleRel = Math.SQRT2 / span;
  const soh = 100 * full / reference;
  return { method: "energy_swing", sohPercent: r2(soh), sigmaPercent: r2(soh * Math.hypot(fit.slopeSe / full, scaleRel, refSigmaPct / 100)), fullValue: r2(full), unit: "kWh", reference, samples: n, basis: `least-squares slope over ${r2(span)}% SOC swing${fit === recentFit ? " (last 30 d)" : ""}`, referenceVerified: refSigmaPct === 0, usedInEstimate: true, bufferKwh: r2(nominalNow !== undefined ? nominalNow - full : intercept), fullIncludingBufferKwh: r2(nominalNow ?? full + intercept) };
}

export function estimateSoh(points: TelemetryPoint[], refs: SohReferences, manual: SohObservation[] = []): SohEstimate {
  const methods: SohMethod[] = [];
  const skipped: string[] = [];
  const events = fullChargeEvents(points);
  const add = (m: SohMethod | string | undefined, missing: string) => { if (typeof m === "object") methods.push(m); else skipped.push(m ?? missing); };

  // Nominal full pack now (buffer-inclusive; the basis of Tesla's in-car test): the BMS field when the car
  // reports it, else EnergyRemaining at a completed full charge, where remaining = full pack.
  const carNominal = points.map(p => num(p, "NominalFullPackEnergyKwh")).filter((v): v is number => v !== undefined);
  const es = eventStats(events, e => e.energyFullKwh);
  const nominal = carNominal.length ? { value: r2(carNominal.at(-1)!), source: "BMS NominalFullPackEnergyKwh", samples: carNominal.length, statRel: 0 }
    : es ? { value: r2(es.value), source: `median EnergyRemaining at ${es.n} qualified full charges${es.recent ? " (last 30 d)" : ""}`, samples: es.n, statRel: es.statRel } : undefined;

  // EPA figure is published and exact for the trim; ±0.4% covers display rounding of the as-new value.
  const rs = eventStats(events, e => e.ratedFullMi);
  if (refs.ratedRangeMi && rs) {
    const soh = 100 * rs.value / refs.ratedRangeMi;
    methods.push({ method: "rated_range", sohPercent: r2(soh), sigmaPercent: r2(soh * Math.hypot(rs.statRel, BMS_ANCHOR_PCT / 100, 0.004)), fullValue: r2(rs.value), unit: "mi", reference: refs.ratedRangeMi, samples: rs.n,
      basis: `median RatedRange of ${rs.n} qualified full charges ${rs.from}→${rs.to}${rs.recent ? " (last 30 d)" : ""}; ${rs.totalQualified} qualified of ${events.length} events`, referenceVerified: true, usedInEstimate: true,
      ...(rs.trendPer30d !== undefined ? { trendPer30d: r2(100 * rs.trendPer30d / refs.ratedRangeMi) } : {}) });
  } else if (refs.ratedRangeMi) add(ratioMethod(points, "RatedRange", refs.ratedRangeMi, 0.5, "rated_range", "mi", 0.4, manual, true), "rated_range: no RatedRange + Soc samples");
  else skipped.push("rated_range: no as-new ratedRange reference");
  if (refs.energyKwh) {
    add(swingMethod(points, refs.energyKwh, refs.energyKwhSigmaPct, nominal?.value), "");
  } else skipped.push("energy_swing: no as-new energyKwh reference");
  if (!refs.nominalKwh) skipped.push("bms_nominal: no as-new nominal reference (TESLA_SOH_NEW_NOMINAL_KWH)");
  else if (!nominal) skipped.push("bms_nominal: no NominalFullPackEnergyKwh report and no EnergyRemaining sample at ≥99.5% SOC");
  else {
    const soh = 100 * nominal.value / refs.nominalKwh, refPct = refs.nominalKwhSigmaPct ?? 0;
    // ±1% BMS model error, plus SOC anchoring error when inferred from EnergyRemaining at full.
    const socTerm = carNominal.length ? 0 : BMS_ANCHOR_PCT / 100;
    methods.push({ method: "bms_nominal", sohPercent: r2(soh), sigmaPercent: r2(soh * Math.hypot(0.05 / nominal.value, nominal.statRel, 0.01, socTerm, refPct / 100)), fullValue: nominal.value, unit: "kWh", reference: refs.nominalKwh, samples: nominal.samples, basis: `${nominal.source}; ±1% BMS model error`, referenceVerified: refPct === 0, usedInEstimate: true });
  }

  // Per charge session: (EnergyRemaining end − start) ÷ ΔSOC × 100, sessions with ΔSOC ≥ 20. Median; σ from spread.
  if (refs.energyKwh) {
    const sess = chargeSessionCapacities(points);
    if (sess.length >= 2) {
      const v = median(sess), mean = sess.reduce((a, b) => a + b, 0) / sess.length, sd = Math.sqrt(sess.reduce((a, x) => a + (x - mean) ** 2, 0) / (sess.length - 1));
      const soh = 100 * v / refs.energyKwh;
      methods.push({ method: "session_energy", sohPercent: r2(soh), sigmaPercent: r2(soh * Math.hypot(1.2533 * sd / Math.sqrt(sess.length) / v, 0.01, (refs.energyKwhSigmaPct ?? 0) / 100)), fullValue: r2(v), unit: "kWh", reference: refs.energyKwh, samples: sess.length, basis: `median ΔEnergyRemaining ÷ ΔSOC × 100 over ${sess.length} charge sessions (ΔSOC ≥ 20)`, referenceVerified: (refs.energyKwhSigmaPct ?? 0) === 0, usedInEstimate: true });
    } else skipped.push(`session_energy: ${sess.length} charge session(s) with ΔSOC ≥ 20, need 2`);
  }
  // Coulomb count vs as-new Ah: TESLA_SOH_NEW_AH, else nominal new kWh ÷ (bricks × 3.2 V LFP nominal). ±5% model error.
  const cc = coulombCapacity(points), bricks = bricksInSeries(points);
  const ahRef = refs.ahNew ?? (refs.nominalKwh && bricks ? refs.nominalKwh * 1000 / (bricks * 3.2) : undefined);
  if (cc && ahRef) {
    const soh = 100 * cc.fullAh / ahRef;
    methods.push({ method: "coulomb", sohPercent: r2(soh), sigmaPercent: r2(soh * Math.hypot(0.05, (cc.spreadAh[1] - cc.spreadAh[0]) / 2 / cc.fullAh, refs.ahNew ? 0 : 0.03)), fullValue: cc.fullAh, unit: "Ah" as SohMethod["unit"], reference: r2(ahRef), samples: cc.sessions, basis: `∫PackCurrent dt ÷ ΔSOC over ${cc.sessions} clean charge run(s); reference ${refs.ahNew ? "TESLA_SOH_NEW_AH" : `derived ${r2(ahRef)} Ah`}`, referenceVerified: false, usedInEstimate: true });
  } else skipped.push(cc ? "coulomb: no as-new Ah reference" : "coulomb: no clean charge run (ΔSOC ≥ 20, no gaps > 3 min, ≥ 100 samples)");

  if (!methods.length) return { status: "insufficient_inputs", methods, skipped, formula: FORMULA };

  // Cross-check unverified references against verified methods. Every ratio method divides by the
  // same Soc, so SOC error cancels in the comparison; only the references' own uncertainty remains.
  // Disagreement beyond 2σ of that means the reference is likely on a different basis (usable vs
  // nominal, wrong pack), so the method is shown but kept out of the estimate.
  const warnings: string[] = [];
  const anchors = methods.filter(m => m.referenceVerified);
  for (const m of methods.filter(x => !x.referenceVerified)) {
    const refPct = m.method === "bms_nominal" ? refs.nominalKwhSigmaPct ?? 0 : m.method === "coulomb" ? 100 * m.sigmaPercent / m.sohPercent : refs.energyKwhSigmaPct ?? 0;
    for (const a of anchors) {
      const diffPct = 100 * Math.abs(m.sohPercent - a.sohPercent) / a.sohPercent;
      if (diffPct > 2 * Math.hypot(refPct, 1)) {
        m.usedInEstimate = false;
        m.note = `disagrees with ${a.method} by ${r2(diffPct)}% (limit ${r2(2 * Math.hypot(refPct, 1))}%); reference ${r2(m.reference)} ${m.unit} implies ${r2(m.reference * m.sohPercent / a.sohPercent)} ${m.unit} on this signal's basis`;
        warnings.push(`${m.method} excluded: ${m.note}`);
      } else if (m.usedInEstimate) m.note = `cross-checked: within ${r2(diffPct)}% of ${a.method} (limit ${r2(2 * Math.hypot(refPct, 1))}%)`;
    }
  }
  // Same-reference check: session_energy and energy_swing share the 57.5 kWh reference, so it cancels and
  // only their measurement σ remains. Partial top-of-pack sessions sit on the steep LFP end and read high.
  const sw0 = methods.find(m => m.method === "energy_swing"), se = methods.find(m => m.method === "session_energy");
  if (sw0 && se && se.usedInEstimate) {
    const ref = (refs.energyKwhSigmaPct ?? 0) / 100, noRef = (m: SohMethod) => Math.sqrt(Math.max(0, (m.sigmaPercent / m.sohPercent) ** 2 - ref ** 2));
    const diff = Math.abs(se.fullValue - sw0.fullValue) / sw0.fullValue, lim = 2 * Math.hypot(noRef(se), noRef(sw0));
    if (diff > lim) { se.usedInEstimate = false; se.note = `disagrees with energy_swing on the same reference by ${r2(100 * diff)}% (limit ${r2(100 * lim)}%); sessions mostly cover the steep top of the LFP curve`; warnings.push(`session_energy excluded: ${se.note}`); }
  }
  if (!anchors.length && methods.length) warnings.push("no verified reference; estimate rests only on unverified references");
  const used = methods.filter(m => m.usedInEstimate);
  const swing = methods.find(m => m.method === "energy_swing");
  const weights = used.map(m => 1 / m.sigmaPercent ** 2), wsum = weights.reduce((a, b) => a + b, 0);
  const fused = used.reduce((a, m, i) => a + weights[i]! * m.sohPercent, 0) / wsum;
  // Var = Σᵢⱼ wᵢwⱼρᵢⱼσᵢσⱼ ÷ (Σw)², ρᵢᵢ = 1, ρᵢⱼ = RHO.
  let v = 0;
  used.forEach((a, i) => used.forEach((b, j) => { v += weights[i]! * weights[j]! * (i === j ? 1 : RHO) * a.sigmaPercent * b.sigmaPercent; }));
  // Move to today: fade trend × days since the last qualified full charge (trend needs ≥5 events over ≥14 d).
  const rrM = methods.find(m => m.method === "rated_range"), lastQ = events.filter(e => e.qualified).at(-1);
  const lastT = points.at(-1)?.timestamp.valueOf();
  const trendAdj = rrM?.trendPer30d !== undefined && lastQ && lastT ? rrM.trendPer30d * Math.max(0, lastT - Date.parse(lastQ.at)) / RECENT_MS : 0;
  const soh = fused + trendAdj;
  const sigma = Math.sqrt(v) / wsum;
  return {
    status: "available",
    sohPercent: r2(soh),
    sigmaPercent: r2(sigma),
    ci95Percent: [r2(soh - 1.96 * sigma), r2(Math.min(soh + 1.96 * sigma, 110))],
    confidence: sigma <= 1.5 ? "high" : sigma <= 3.5 ? "medium" : "low",
    // The interval is conditional on the model: all methods share BMS inputs and most references are unverified.
    confidenceBasis: "Agreement between methods under the model's assumptions (shared BMS inputs, " +
      `${methods.filter(m => m.usedInEstimate && !m.referenceVerified).length} unverified reference(s)). Not a validated diagnostic interval or a Tesla Battery Health Test result.`,
    methods,
    skipped,
    warnings,
    formula: FORMULA,
    fullChargeEvents: events,
    trendAdjustmentPts: r2(trendAdj),
    correlation: RHO,
    ...(methods.find(m => m.method === "rated_range")?.trendPer30d !== undefined ? { trendPer30d: methods.find(m => m.method === "rated_range")!.trendPer30d } : {}),
    ...(swing ? { usableFullPackKwh: swing.fullValue } : {}),
    ...(nominal ? { nominalFullPackKwh: nominal } : {}),
    ...(nominal && swing ? { bufferKwh: r2(nominal.value - swing.fullValue) } : {}),
  };
}

// Only as-new references count toward SOH; "observed" ones measure change since a later date.
export async function sohReferences(vin: string): Promise<SohReferences> {
  const refs = await getHealthReferences(vin);
  const asNew = (metric: "ratedRange" | "energyKwh") => refs[metric]?.kind === "as_new" ? refs[metric]!.value : undefined;
  const nominal = Number(process.env.TESLA_SOH_NEW_NOMINAL_KWH);
  // ponytail: only EPA range counts as verified; energy/nominal refs carry ±3% unless overridden by env.
  const pct = (name: string) => { const v = Number(process.env[name]); return Number.isFinite(v) && v >= 0 && process.env[name]?.trim() ? v : 3; };
  const ah = Number(process.env.TESLA_SOH_NEW_AH);
  return { ...(ah > 0 ? { ahNew: ah } : {}), ratedRangeMi: asNew("ratedRange"), energyKwh: asNew("energyKwh"), energyKwhSigmaPct: pct("TESLA_SOH_ENERGY_REF_SIGMA_PCT"), nominalKwh: nominal > 0 ? nominal : undefined, nominalKwhSigmaPct: pct("TESLA_SOH_NOMINAL_REF_SIGMA_PCT") };
}

// TESLA_SOH_FULL_CHARGE_READINGS="252@100@2026-09-24,..." = rated miles @ SOC % @ date, as read off the car.
export function sohObservations(): SohObservation[] {
  return (process.env.TESLA_SOH_FULL_CHARGE_READINGS || "").split(",").flatMap(item => {
    const [mi, soc, at] = item.trim().split("@");
    const ratedRangeMi = Number(mi), s = Number(soc);
    return ratedRangeMi > 0 && s > 0 && s <= 100 && at ? [{ ratedRangeMi, soc: s, at }] : [];
  });
}

// Alternative SOH definitions shown side by side on the dashboard. Each is a different, stated question:
// which capacity (rated miles, usable kWh, buffer-inclusive kWh, Ah), which window, which statistic.
export type SohScenario = { id: string; label: string; sohPercent?: number; sigmaPercent?: number; value?: number; unit?: string; reference?: number; formula: string; note: string; experimental?: boolean };

// Coulomb count: ∫PackCurrent dt and ∫PackVoltage·PackCurrent dt over charge runs with ≥20% SOC gain,
// no sample gaps > 3 min and ≥100 samples. Independent of the BMS energy estimate (only SOC comes from BMS).
export function coulombCapacity(points: TelemetryPoint[]): { fullAh: number; fullKwh: number; sessions: number; spreadAh: [number, number] } | undefined {
  type Run = { t: number; soc0?: number; soc1?: number; ah: number; wh: number; n: number; gaps: number; prev?: { t: number; v: number; i: number } };
  const runs: Run[] = [];
  let cur: Run | undefined;
  for (const p of points) {
    const t = p.timestamp.valueOf();
    if (p.signals.ChargeState !== "Charging") continue;
    if (!cur || t - cur.t > 30 * 60_000) { cur = { t, soc0: num(p, "Soc"), ah: 0, wh: 0, n: 0, gaps: 0 }; runs.push(cur); }
    cur.t = t;
    const v = num(p, "PackVoltage"), i = num(p, "PackCurrent"), s = num(p, "Soc");
    if (cur.soc0 === undefined) cur.soc0 = s;
    if (s !== undefined) cur.soc1 = s;
    if (v !== undefined && v > 100 && i !== undefined) {
      if (cur.prev) { const dt = (t - cur.prev.t) / 3_600_000; if (dt <= 0.05) { cur.ah += cur.prev.i * dt; cur.wh += cur.prev.v * cur.prev.i * dt; } else cur.gaps++; }
      cur.prev = { t, v, i }; cur.n++;
    }
  }
  const good = runs.filter(r => r.soc0 !== undefined && r.soc1 !== undefined && r.soc1 - r.soc0 >= 20 && r.gaps === 0 && r.n >= 100 && r.ah > 0);
  if (!good.length) return undefined;
  const ah = good.map(r => r.ah / (r.soc1! - r.soc0!) * 100), kwh = good.map(r => r.wh / 1000 / (r.soc1! - r.soc0!) * 100);
  return { fullAh: r2(median(ah)), fullKwh: r2(median(kwh)), sessions: good.length, spreadAh: [r2(Math.min(...ah)), r2(Math.max(...ah))] };
}

export function sohScenarios(points: TelemetryPoint[], est: SohEstimate, refs: SohReferences): SohScenario[] {
  if (est.status !== "available") return [];
  const out: SohScenario[] = [];
  const m = (id: SohMethod["method"]) => est.methods.find(x => x.method === id);
  const rr = m("rated_range"), sw = m("energy_swing"), bn = m("bms_nominal");
  out.push({ id: "best", label: "Best overall", sohPercent: est.sohPercent, sigmaPercent: est.sigmaPercent, formula: `fusion of ${est.methods.filter(x => x.usedInEstimate).length} cross-checked methods (1/σ² weights, ρ = ${est.correlation}) + trend to today (${est.trendAdjustmentPts ?? 0} pt)`, note: `Uses: ${est.methods.filter(x => x.usedInEstimate).map(x => x.method.replace("_", " ")).join(", ")}${est.methods.some(x => !x.usedInEstimate) ? `; excluded: ${est.methods.filter(x => !x.usedInEstimate).map(x => x.method).join(", ")}` : ""}.` });
  if (bn) out.push({ id: "tesla_test", label: `BMS nominal ÷ ${bn.reference} kWh`, sohPercent: bn.sohPercent, sigmaPercent: bn.sigmaPercent, value: bn.fullValue, unit: "kWh", reference: bn.reference, formula: `nominal full pack now (buffer included) ${bn.fullValue} kWh ÷ assumed new ${bn.reference} kWh`, note: "Not a Tesla Battery Health Test result: Tesla's test measures retained energy separately. The new-pack reference is assumed, not verified." });
  if (rr) out.push({ id: "rated_range", label: "Rated range (EPA)", sohPercent: rr.sohPercent, sigmaPercent: rr.sigmaPercent, value: rr.fullValue, unit: "mi", reference: rr.reference, formula: `RatedRange at completed full charges ÷ ${rr.reference} mi EPA`, note: "Only method with a verified reference." });
  if (sw) out.push({ id: "usable", label: "Usable energy", sohPercent: sw.sohPercent, sigmaPercent: sw.sigmaPercent, value: sw.fullValue, unit: "kWh", reference: sw.reference, formula: "100 × slope(EnergyRemaining vs SOC) ÷ usable new", note: "Energy you can drive on above 0%. Reference unverified." });
  out.push({ id: "conservative", label: "Conservative (95% low)", sohPercent: est.ci95Percent[0], formula: "best estimate − 1.96σ", note: "Lower edge of the model range. Holds only if the model's references and assumptions are right; not a guaranteed floor." });
  const events = (est.fullChargeEvents || []).filter(e => e.qualified && e.ratedFullMi !== undefined);
  if (refs.ratedRangeMi && events.length) {
    const all = median(events.map(e => e.ratedFullMi!)), best = Math.max(...events.map(e => e.ratedFullMi!));
    out.push({ id: "all_window", label: "Whole history", sohPercent: r2(100 * all / refs.ratedRangeMi), value: r2(all), unit: "mi", reference: refs.ratedRangeMi, formula: `median rated range of all ${events.length} qualified full charges`, note: "Longer window: steadier, but lags real fade." });
    out.push({ id: "optimistic", label: "Best full charge", sohPercent: r2(100 * best / refs.ratedRangeMi), value: r2(best), unit: "mi", reference: refs.ratedRangeMi, formula: `highest qualified full-charge rated range ÷ ${refs.ratedRangeMi} mi`, note: "Upper bound: the BMS's most generous full-pack estimate." });
    if (rr?.trendPer30d !== undefined) {
      const days = (Date.now() - Date.parse(events.at(-1)!.at)) / 86_400_000;
      out.push({ id: "trend_today", label: "Trend-adjusted today", sohPercent: r2(rr.sohPercent + rr.trendPer30d * days / 30), formula: `30-day median + trend (${rr.trendPer30d} pt/30 d) × ${r2(days)} d since last full charge`, note: "Accounts for fade since the last qualified full charge." });
    }
  }
  const cc = coulombCapacity(points), newAh = Number(process.env.TESLA_SOH_NEW_AH) || undefined;
  if (cc) out.push({ id: "coulomb", label: "Coulomb count", experimental: true, ...(newAh ? { sohPercent: r2(100 * cc.fullAh / newAh), reference: newAh } : {}), value: cc.fullAh, unit: "Ah", formula: `∫PackCurrent dt ÷ ΔSOC × 100 over ${cc.sessions} clean charge run(s); range ${cc.spreadAh[0]}–${cc.spreadAh[1]} Ah; pack-side ${cc.fullKwh} kWh`, note: newAh ? "Independent of BMS energy estimate; 1-min sampling limits precision." : "Set TESLA_SOH_NEW_AH (cell rated Ah) to turn this into SOH. Experimental: 1-min sampling." });
  return out;
}

// ΔEnergyRemaining ÷ ΔSOC × 100 for each charge session (run of ChargeState Charging, split by >30 min gaps) with ΔSOC ≥ 20.
export function chargeSessionCapacities(points: TelemetryPoint[]): number[] {
  const out: number[] = [];
  let cur: { t: number; s0?: number; e0?: number; s1?: number; e1?: number } | undefined, state: string | undefined;
  const close = () => { if (cur && cur.s0 !== undefined && cur.s1 !== undefined && cur.e0 !== undefined && cur.e1 !== undefined && cur.s1 - cur.s0 >= 20) out.push((cur.e1 - cur.e0) / (cur.s1 - cur.s0) * 100); cur = undefined; };
  for (const p of points) {
    if (typeof p.signals.ChargeState === "string") state = p.signals.ChargeState;
    const t = p.timestamp.valueOf(), s = num(p, "Soc"), e = num(p, "EnergyRemaining");
    if (cur && t - cur.t > 30 * 60_000) close();
    if (state === "Charging") {
      if (!cur) cur = { t };
      cur.t = t;
      if (s !== undefined && e !== undefined) { if (cur.s0 === undefined) { cur.s0 = s; cur.e0 = e; } cur.s1 = s; cur.e1 = e; }
    } else close();
  }
  close();
  return out;
}

// Bricks in series = median PackVoltage ÷ mean brick voltage over records carrying both.
export function bricksInSeries(points: TelemetryPoint[]): number | undefined {
  const r = points.flatMap(p => { const v = num(p, "PackVoltage"), a = num(p, "BrickVoltageMin"), b = num(p, "BrickVoltageMax"); return v !== undefined && v > 100 && a !== undefined && b !== undefined && a > 2 ? [v / ((a + b) / 2)] : []; });
  return r.length ? Math.round(median(r)) : undefined;
}
