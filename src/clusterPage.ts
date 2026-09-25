export function clusterHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#000000">
  <title>Vehicle telemetry</title>
  <style>
    :root { color-scheme: dark; --bg:#000; --ink:#f2f3f5; --muted:#9299a3; --dim:#57606c; --line:#303841; --blue:#4ca8ff; --blue-soft:#153b5d; --status:#d3d8de; }
    :root[data-theme="day"] { color-scheme: light; --bg:#f2f5f7; --ink:#111b25; --muted:#475563; --dim:#677685; --line:#b8c4cf; --blue:#006fc9; --blue-soft:#b9ddf8; --status:#263747; }
    * { box-sizing:border-box; }
    html, body { margin:0; min-height:100%; background:var(--bg); color:var(--ink); }
    body { font-family:"Arial Narrow","Helvetica Neue",Arial,sans-serif; font-stretch:condensed; font-variant-numeric:tabular-nums; -webkit-font-smoothing:antialiased; }
    button { font:inherit; }
    .shell { min-height:100svh; display:grid; grid-template-rows:auto 1fr auto auto; padding:calc(env(safe-area-inset-top) + 22px) max(24px, env(safe-area-inset-right)) calc(env(safe-area-inset-bottom) + 18px) max(24px, env(safe-area-inset-left)); max-width:1800px; margin:auto; }
    .top { display:flex; align-items:center; justify-content:space-between; gap:20px; }
    .status { display:flex; align-items:center; gap:12px; min-height:48px; color:var(--status); font-size:clamp(17px,1.5vw,23px); font-weight:500; letter-spacing:.01em; }
    .status-dot { width:9px; height:9px; flex:none; border-radius:50%; background:var(--muted); }
    .status[data-state="live"] .status-dot { background:var(--blue); box-shadow:0 0 0 4px var(--blue-soft); }
    .status[data-state="offline"] .status-dot { background:#b35e5e; }
    .controls { display:flex; gap:8px; }
    .control { min-width:44px; min-height:44px; padding:0 14px; border:1px solid var(--line); border-radius:8px; color:var(--ink); background:transparent; cursor:pointer; font-size:15px; }
    .control:hover { border-color:var(--muted); }
    .control:focus-visible { outline:2px solid var(--blue); outline-offset:3px; }
    .control[hidden] { display:none; }
    .cluster { display:grid; grid-template-columns:minmax(0,1fr) minmax(320px,1.55fr) minmax(0,1fr); align-items:center; gap:min(2vw,36px); min-height:0; padding:18px 0 12px; }
    .side { position:relative; min-width:0; display:flex; flex-direction:column; align-items:center; justify-content:center; }
    .arc { display:block; width:min(100%,295px); height:auto; overflow:visible; }
    .arc-track,.arc-fill { fill:none; stroke-width:7; stroke-linecap:round; }
    .arc-track { stroke:var(--line); }
    .arc-fill { stroke:var(--blue); stroke-dasharray:0 100; }
    .last-known .arc-fill { opacity:.45; }
    .power .arc-fill { stroke:var(--ink); }
    .gauge-copy { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); width:70%; text-align:center; }
    .gauge-value { display:block; font-size:clamp(43px,5.5vw,85px); font-weight:300; letter-spacing:-.055em; line-height:1; white-space:nowrap; }
    .gauge-unit { display:block; margin-top:8px; color:var(--muted); font-size:clamp(15px,1.4vw,20px); letter-spacing:.03em; }
    .gauge-age { display:block; min-height:22px; margin-top:15px; color:var(--muted); font-size:clamp(12px,1.1vw,16px); }
    .last-known .gauge-value { color:var(--muted); }
    .center { min-width:0; text-align:center; align-self:center; }
    .speed { font-size:clamp(132px,19vw,350px); font-weight:200; line-height:.9; letter-spacing:-.085em; padding-right:.075em; }
    .speed.empty { color:var(--dim); }
    .speed-unit { margin-top:12px; color:var(--muted); font-size:clamp(23px,2.4vw,36px); letter-spacing:.07em; }
    .gear { display:flex; justify-content:center; gap:clamp(17px,2.5vw,40px); margin-top:clamp(20px,4vh,48px); min-height:48px; align-items:center; }
    .gear span { color:var(--dim); font-size:clamp(23px,2.6vw,38px); line-height:1; }
    .gear span.active { color:var(--ink); font-weight:600; }
    .gear-unavailable { color:var(--muted); font-size:17px; }
    .metrics { border-top:1px solid var(--line); display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:20px; padding:22px 0 18px; }
    .metric { min-width:0; text-align:center; }
    .metric + .metric { border-left:1px solid var(--line); }
    .metric-label { display:block; color:var(--muted); font-size:clamp(15px,1.25vw,19px); }
    .metric-value { display:block; margin-top:6px; font-size:clamp(25px,3vw,42px); font-weight:300; white-space:nowrap; }
    .metric-age { display:block; min-height:18px; margin-top:4px; color:var(--dim); font-size:13px; }
    .metric.last-known .metric-value { color:var(--muted); }
    .note { margin:0; color:var(--dim); text-align:center; font-size:clamp(12px,1vw,15px); line-height:1.4; }
    @media (max-width:850px) { .cluster { grid-template-columns:1fr 1fr; gap:0 10px; padding:22px 0; } .center { grid-column:1/-1; grid-row:1; padding-bottom:22px; } .speed { font-size:clamp(125px,29vw,250px); } .side { grid-row:2; } .arc { width:min(100%,220px); } .gauge-value { font-size:clamp(39px,8vw,64px); } .gear { margin-top:18px; } }
    @media (max-width:530px) { .shell { padding-left:max(16px,env(safe-area-inset-left)); padding-right:max(16px,env(safe-area-inset-right)); } .top { align-items:flex-start; } .status { font-size:16px; } .controls { flex-wrap:wrap; justify-content:flex-end; } .control { padding:0 9px; font-size:13px; } .speed { font-size:clamp(115px,33vw,190px); } .gauge-value { font-size:clamp(35px,9vw,54px); } .gauge-age { margin-top:6px; font-size:12px; } .metrics { gap:6px; } .metric-value { font-size:clamp(18px,5vw,29px); } .metric-label { font-size:13px; } .metric-age { font-size:11px; } }
    @media (prefers-reduced-motion:reduce) { *, *::before, *::after { scroll-behavior:auto !important; animation:none !important; transition:none !important; } }
  </style>
</head>
<body>
  <main class="shell">
    <header class="top">
      <div id="status" class="status" data-state="stale" role="status" aria-live="polite"><span class="status-dot" aria-hidden="true"></span><span id="statusText">Connecting to telemetry…</span></div>
      <div class="controls"><button id="themeButton" class="control" type="button" aria-label="Switch to daylight display">Daylight</button><button id="fullButton" class="control" type="button" hidden>Fullscreen</button></div>
    </header>
    <section class="cluster" aria-label="Vehicle instruments">
      <div id="batteryGauge" class="side battery">
        <svg class="arc" viewBox="0 0 240 300" aria-hidden="true"><path class="arc-track" d="M 190 270 A 120 120 0 0 1 190 30" pathLength="100"/><path id="batteryArc" class="arc-fill" d="M 190 270 A 120 120 0 0 1 190 30" pathLength="100"/></svg>
        <div class="gauge-copy"><span id="soc" class="gauge-value">—</span><span class="gauge-unit">Battery %</span><span id="socAge" class="gauge-age"></span></div>
      </div>
      <div class="center"><div id="speed" class="speed empty" aria-label="Speed unavailable">—</div><div class="speed-unit">mph</div><div id="gear" class="gear" aria-label="Gear unavailable"><span class="gear-unavailable">Gear unavailable</span></div></div>
      <div class="side power">
        <svg class="arc" viewBox="0 0 240 300" aria-hidden="true"><path class="arc-track" d="M 50 270 A 120 120 0 0 0 50 30" pathLength="100"/><path id="powerArc" class="arc-fill" d="M 50 270 A 120 120 0 0 0 50 30" pathLength="100"/></svg>
        <div class="gauge-copy"><span id="power" class="gauge-value">—</span><span class="gauge-unit">Power kW · ±250</span><span id="powerAge" class="gauge-age"></span></div>
      </div>
    </section>
    <section class="metrics" aria-label="Battery details"><div id="rangeMetric" class="metric"><span class="metric-label">Rated range</span><span id="range" class="metric-value">—</span><span id="rangeAge" class="metric-age"></span></div><div id="tempMetric" class="metric"><span class="metric-label">Pack temperature</span><span id="temp" class="metric-value">—</span><span id="tempAge" class="metric-age"></span></div><div id="voltageMetric" class="metric"><span class="metric-label">Voltage</span><span id="voltage" class="metric-value">—</span><span id="voltageAge" class="metric-age"></span></div></section>
    <p class="note">Supplementary telemetry · use vehicle instruments</p>
  </main>
  <script>
    (() => {
      const byId = (id) => document.getElementById(id);
      const status = byId('status');
      const statusText = byId('statusText');
      const themeButton = byId('themeButton');
      const fullButton = byId('fullButton');
      let snapshot = null;
      let receivedAt = 0;
      let offline = false;
      let pending = false;
      let activeAbort = null;
      const freshLimit = 15;
      const field = (name) => snapshot && snapshot.fields && snapshot.fields[name];
      const age = (item) => item && Number.isFinite(item.ageSeconds) ? item.ageSeconds + Math.max(0, (performance.now() - receivedAt) / 1000) : Infinity;
      const fresh = (item) => !!item && item.live === true && item.value !== null && item.value !== undefined && age(item) <= freshLimit;
      const value = (item) => item && item.value !== null && item.value !== undefined && item.value !== '' ? item.value : null;
      const number = (item) => { const n = Number(value(item)); return Number.isFinite(n) && value(item) !== null ? n : null; };
      const ageText = (item) => {
        if (value(item) === null) return '';
        const seconds = age(item);
        if (!Number.isFinite(seconds)) return 'Last known · age unavailable';
        if (seconds <= freshLimit && item.live) return '';
        if (seconds < 60) return 'Last known · ' + Math.floor(seconds) + 's old';
        if (seconds < 3600) return 'Last known · ' + Math.floor(seconds / 60) + 'm old';
        return 'Last known · ' + Math.floor(seconds / 3600) + 'h old';
      };
      const renderMetric = (id, item, formatted) => {
        byId(id).textContent = formatted;
        byId(id + 'Age').textContent = ageText(item);
        byId(id + 'Metric').classList.toggle('last-known', value(item) !== null && (!item.live || age(item) > freshLimit));
      };
      const render = () => {
        const speed = field('speed');
        const speedNumber = number(speed);
        const speedFresh = !offline && !document.hidden && fresh(speed) && speedNumber !== null;
        byId('speed').textContent = speedFresh ? String(Math.round(speedNumber)) : '—';
        byId('speed').classList.toggle('empty', !speedFresh);
        byId('speed').setAttribute('aria-label', speedFresh ? 'Speed ' + Math.round(speedNumber) + ' miles per hour' : 'Speed unavailable');

        const gear = field('gear');
        const gearValue = String(value(gear) || '').toUpperCase();
        const gearElement = byId('gear');
        if (!offline && !document.hidden && fresh(gear) && ['P','R','N','D'].includes(gearValue)) {
          gearElement.replaceChildren(...['P','R','N','D'].map((letter) => {
            const span = document.createElement('span');
            span.textContent = letter;
            if (letter === gearValue) span.className = 'active';
            return span;
          }));
          gearElement.setAttribute('aria-label', 'Gear ' + gearValue);
        } else {
          const span = document.createElement('span');
          span.className = 'gear-unavailable';
          span.textContent = 'Gear unavailable';
          gearElement.replaceChildren(span);
          gearElement.setAttribute('aria-label', 'Gear unavailable');
        }

        const power = field('power');
        const powerNumber = number(power);
        const powerFresh = !offline && !document.hidden && fresh(power) && powerNumber !== null;
        byId('power').textContent = powerFresh ? (powerNumber > 0 ? '+' : '') + Math.round(powerNumber) : '—';
        byId('powerAge').textContent = powerFresh ? '' : 'Live reading unavailable';
        byId('powerArc').style.strokeDasharray = powerFresh ? Math.min(Math.abs(powerNumber) / 250 * 100, 100) + ' 100' : '0 100';

        const soc = field('soc');
        const socNumber = number(soc);
        byId('soc').textContent = socNumber === null ? '—' : String(Math.round(socNumber));
        byId('socAge').textContent = ageText(soc);
        byId('batteryGauge').classList.toggle('last-known', socNumber !== null && (!soc.live || age(soc) > freshLimit));
        byId('batteryArc').style.strokeDasharray = socNumber === null ? '0 100' : Math.max(0, Math.min(socNumber, 100)) + ' 100';

        const range = field('range');
        const rangeNumber = number(range);
        renderMetric('range', range, rangeNumber === null ? '—' : Math.round(rangeNumber) + ' mi');
        const low = field('temperatureMin');
        const high = field('temperatureMax');
        const lowNumber = number(low);
        const highNumber = number(high);
        const tempItem = lowNumber === null ? high : highNumber === null ? low : age(low) >= age(high) ? low : high;
        const tempText = lowNumber === null && highNumber === null ? '—' : lowNumber !== null && highNumber !== null ? Math.round(lowNumber) + '–' + Math.round(highNumber) + '°C' : Math.round(lowNumber === null ? highNumber : lowNumber) + '°C';
        renderMetric('temp', tempItem, tempText);
        const voltage = field('voltage');
        const voltageNumber = number(voltage);
        renderMetric('voltage', voltage, voltageNumber === null ? '—' : Math.round(voltageNumber) + ' V');

        const latestAge = snapshot && Number.isFinite(snapshot.ageSeconds) ? snapshot.ageSeconds + Math.max(0, (performance.now() - receivedAt) / 1000) : Infinity;
        const state = offline ? 'offline' : latestAge <= freshLimit ? 'live' : 'stale';
        status.dataset.state = state;
        statusText.textContent = state === 'offline' ? snapshot ? 'Telemetry offline · last known values' : 'Telemetry offline · no data' : state === 'live' ? 'Telemetry current' : snapshot ? 'Telemetry stale · last known values' : 'Connecting to telemetry…';
      };
      const poll = async () => {
        if (pending || document.hidden) return;
        pending = true;
        const startedAt = performance.now();
        const abort = new AbortController();
        activeAbort = abort;
        const timeout = setTimeout(() => abort.abort(), 5000);
        try {
          const response = await fetch('/api/cluster', { cache:'no-store', signal:abort.signal });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const next = await response.json();
          if (document.hidden || abort.signal.aborted) throw new Error('Telemetry request interrupted');
          if (!next || !next.fields || typeof next.fields !== 'object') throw new Error('Invalid telemetry');
          snapshot = next;
          receivedAt = startedAt;
          offline = false;
        } catch {
          offline = true;
        } finally {
          clearTimeout(timeout);
          if (activeAbort === abort) activeAbort = null;
          pending = false;
          if (document.hidden) offline = true;
          render();
        }
      };
      let theme = 'night';
      try { theme = localStorage.getItem('clusterTheme') === 'day' ? 'day' : 'night'; } catch {}
      const applyTheme = () => {
        document.documentElement.dataset.theme = theme;
        themeButton.textContent = theme === 'day' ? 'Night display' : 'Daylight';
        themeButton.setAttribute('aria-label', theme === 'day' ? 'Switch to night display' : 'Switch to daylight display');
      };
      themeButton.addEventListener('click', () => {
        theme = theme === 'day' ? 'night' : 'day';
        try { localStorage.setItem('clusterTheme', theme); } catch {}
        applyTheme();
      });
      if (document.documentElement.requestFullscreen) {
        fullButton.hidden = false;
        fullButton.addEventListener('click', async () => {
          try {
            if (document.fullscreenElement) await document.exitFullscreen();
            else await document.documentElement.requestFullscreen();
          } catch { fullButton.hidden = true; }
        });
        document.addEventListener('fullscreenchange', () => { fullButton.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen'; });
      }
      document.addEventListener('visibilitychange', () => { offline = true; if (document.hidden) activeAbort?.abort(); render(); if (!document.hidden) poll(); });
      applyTheme();
      render();
      poll();
      setInterval(() => { if (!document.hidden) { render(); poll(); } }, 2000);
      setInterval(() => { if (!document.hidden) render(); }, 500);
    })();
  </script>
</body>
</html>`;
}
