/* Click Timeline — records button taps and plots them on a time axis.
   All state lives in localStorage; nothing is ever sent anywhere. */
(() => {
  'use strict';

  const STORE_KEY = 'click-timeline/v1';
  const THEME_KEY = 'click-timeline/theme';
  const SERIES = { 1: 'var(--series-1)', 2: 'var(--series-2)', 3: 'var(--series-3)' };
  const NAMES  = { 1: 'Blue', 2: 'Yellow', 3: 'Red' };   // 1 at the bottom of the rail
  const DAY = 86400000;

  /* ── State ─────────────────────────────────────────────── */
  let clicks = load();          // [{ id, t, b }] kept sorted ascending by t
  let range = 'today';
  let active = null;            // id of the hovered click

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
      if (!Array.isArray(raw)) return [];
      return raw
        .filter(c => c && Number.isFinite(c.t) && [1, 2, 3].includes(Number(c.b)))
        .map(c => ({ id: String(c.id || `${c.t}-${c.b}`), t: Number(c.t), b: Number(c.b) }))
        .sort((a, b) => a.t - b.t);
    } catch { return []; }
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(clicks));
    } catch {
      toast('Could not save — storage is full or blocked');
    }
  }

  /* ── Formatting ────────────────────────────────────────── */
  const fTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
  const fSec  = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fDay  = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  function startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /* ── Range → [t0, t1] domain and the slice it selects ───── */
  function domain() {
    const now = Date.now();
    if (range === 'today') return [startOfToday(), Math.max(now, startOfToday() + 3600000)];
    if (range === '7')     return [now - 7 * DAY, now];
    if (range === '30')    return [now - 30 * DAY, now];
    if (!clicks.length)    return [now - 3600000, now];
    const lo = clicks[0].t, hi = clicks[clicks.length - 1].t;
    const pad = Math.max((hi - lo) * 0.04, 300000);
    return [lo - pad, hi + pad];
  }

  const inRange = ([t0, t1]) => clicks.filter(c => c.t >= t0 && c.t <= t1);

  /* Period-over-period change. Only stated when the previous window is fully
     covered by recorded history — otherwise "up 300%" is just the log starting. */
  function trendNote([t0, t1]) {
    if (range !== '7' && range !== '30') return '';
    const span = t1 - t0;
    if (!clicks.length || clicks[0].t > t0 - span) return '';
    const cur  = clicks.filter(c => c.t >= t0 && c.t <= t1).length;
    const prev = clicks.filter(c => c.t >= t0 - span && c.t < t0).length;
    if (!prev) return '';
    const days = Math.round(span / DAY);
    const pct = Math.round(((cur - prev) / prev) * 100);
    if (pct === 0) return `level vs previous ${days} days`;
    return `${pct > 0 ? '↑' : '↓'} ${Math.abs(pct)}% vs previous ${days} days`;
  }

  /* ── Axis ticks (local-time aligned) ───────────────────── */
  const STEPS = [
    60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3,
    DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 90 * DAY, 365 * DAY,
  ];

  function floorTo(t, step) {
    const off = new Date(t).getTimezoneOffset() * 60000;
    return Math.floor((t - off) / step) * step + off;
  }

  function ticks(t0, t1, target) {
    const span = t1 - t0;
    const step = STEPS.find(s => span / s <= target) || STEPS[STEPS.length - 1];
    const out = [];
    for (let t = floorTo(t0, step); t <= t1; t += step) {
      if (t >= t0) out.push({ t, step });
    }
    return out;
  }

  function tickLabel({ t, step }) {
    const d = new Date(t);
    const midnight = d.getHours() === 0 && d.getMinutes() === 0;
    if (step >= DAY || midnight) return fDay.format(d);
    return fTime.format(d);
  }

  /* ── DOM handles ───────────────────────────────────────── */
  const $ = id => document.getElementById(id);
  const svg = $('chart');
  const tooltip = $('tooltip');
  const NS = 'http://www.w3.org/2000/svg';
  const el = (name, attrs) => {
    const n = document.createElementNS(NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };

  /* ── Chart ─────────────────────────────────────────────────
     One picture, two readings. Three cumulative curves carry the shape of the
     day — the running total per button across the visible span — and the rail
     along the foot keeps every single click visible as its own tick, one row
     per button with 1 at the bottom. */
  let hits = [];          // { x, y, ry, c, cum } — one entry per click

  const RAIL_H   = 42;    // event rail at the foot of the plot
  const RAIL_GAP = 14;    // breathing room between the curves and the rail
  const MAX_DOTS = 300;   // past this the per-event dots merge into noise

  /* A running total holds flat and then jumps, so the line is a staircase —
     corners rounded, and only as much as the step itself allows, so a burst of
     clicks stays crisp instead of smoothing into a slope that never happened. */
  const STEP_R = 7;

  function stepPath(pts) {
    if (!pts.length) return '';
    let d = `M${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) {
      const { x: x0, y: y0 } = pts[i - 1];
      const { x: x1, y: y1 } = pts[i];
      const rise = y0 - y1;                 // a total only ever climbs: y falls
      if (rise <= 0) { d += `L${x1} ${y1}`; continue; }
      const next = i + 1 < pts.length ? pts[i + 1].x - x1 : 0;
      const rIn  = Math.min(STEP_R, (x1 - x0) / 2, rise / 2);
      const rOut = Math.min(STEP_R, next / 2, rise / 2);
      d += `L${x1 - rIn} ${y0}Q${x1} ${y0} ${x1} ${y0 - rIn}`
         + `L${x1} ${y1 + rOut}Q${x1} ${y1} ${x1 + rOut} ${y1}`;
    }
    return d;
  }

  // Count axis: whole numbers only — half a click is not a thing
  function countStep(peak, target) {
    const raw = peak / target;
    const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
    for (const f of [1, 2, 2.5, 5, 10]) {
      if (pow * f >= raw) return Math.max(1, Math.round(pow * f));
    }
    return Math.max(1, Math.round(pow * 10));
  }

  /* One shared vertical fade per series, in user space, so all three areas
     wash out at the same rate instead of each over its own bounding box. */
  function chartDefs(top, bottom) {
    const defs = el('defs');
    for (const b of [1, 2, 3]) {
      const g = el('linearGradient', {
        id: `fade-${b}`, gradientUnits: 'userSpaceOnUse', x1: 0, y1: top, x2: 0, y2: bottom,
      });
      g.append(
        el('stop', { offset: '0%',   'stop-color': `var(--series-${b})`, 'stop-opacity': 0.16 }),
        el('stop', { offset: '100%', 'stop-color': `var(--series-${b})`, 'stop-opacity': 0 }),
      );
      defs.append(g);
    }
    return defs;
  }

  function drawChart(data, [t0, t1]) {
    svg.textContent = '';
    hits = [];
    const empty = !data.length;
    $('chart-empty').hidden = !empty;
    svg.style.visibility = empty ? 'hidden' : 'visible';
    if (empty) { tooltip.hidden = true; return; }

    const w = svg.clientWidth || svg.getBoundingClientRect().width;
    const h = svg.clientHeight || 272;
    if (!w) return;   // panel is hidden; activateTab() redraws when it is shown
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

    const m = { top: 16, right: 14, bottom: 24, left: 48 };
    const iw = Math.max(w - m.left - m.right, 10);
    const ih = Math.max(h - m.top - m.bottom, 10);
    const x = t => m.left + ((t - t0) / (t1 - t0 || 1)) * iw;

    const railBottom = m.top + ih;
    const railTop = railBottom - Math.min(RAIL_H, Math.max(ih * 0.35, 18));
    const rowH = (railBottom - railTop) / 3;
    const railY = b => railTop + rowH * (3 - b) + rowH / 2;   // 1 at the bottom
    const plotTop = m.top + 6;   // headroom, so the peak node clears the top rule
    const plotBottom = Math.max(railTop - RAIL_GAP, plotTop + 24);

    // Running totals, plus a snapshot of all three at every click for the tooltip
    const run = { 1: 0, 2: 0, 3: 0 };
    const series = { 1: [], 2: [], 3: [] };
    const snaps = [];
    for (const c of data) {
      run[c.b]++;
      series[c.b].push({ t: c.t, n: run[c.b] });
      snaps.push({ 1: run[1], 2: run[2], 3: run[3] });
    }
    const peak = Math.max(1, run[1], run[2], run[3]);
    const step = countStep(peak, 3);
    const yTop = Math.ceil(peak / step) * step;
    const y = n => plotBottom - (n / yTop) * (plotBottom - plotTop);

    svg.append(chartDefs(plotTop, plotBottom));

    // The rail reads as its own strip, not as more plot
    svg.append(el('rect', {
      class: 'rail-bg', x: m.left, y: railTop - 3,
      width: iw, height: railBottom - railTop + 6, rx: 9,
    }));

    // Count grid
    for (let v = 0; v <= yTop; v += step) {
      const py = y(v);
      svg.append(el('line', {
        class: v === 0 ? 'baseline' : 'gridline', x1: m.left, x2: m.left + iw, y1: py, y2: py,
      }));
      const lab = el('text', { class: 'y-label', x: m.left - 8, y: py + 3.5, 'text-anchor': 'end' });
      lab.textContent = String(v);
      svg.append(lab);
    }

    // Time grid
    const tickTarget = w < 380 ? 4 : w < 560 ? 5 : 7;
    for (const tk of ticks(t0, t1, tickTarget)) {
      const tx = x(tk.t);
      svg.append(el('line', { class: 'gridline', x1: tx, x2: tx, y1: plotTop, y2: railBottom }));
      // Anchor the outermost labels inward instead of letting them hang off the edge
      const edge = tx > w - 30 ? ['end', w - 4] : tx < 30 ? ['start', 4] : ['middle', tx];
      const lab = el('text', { x: edge[1], y: h - 7, 'text-anchor': edge[0] });
      lab.textContent = tickLabel(tk);
      svg.append(lab);
    }

    // Crosshair sits under the washes, so the curves still read across it
    const cross = data.find(c => c.id === active);
    if (cross) {
      const cx = x(cross.t);
      svg.append(el('line', { class: 'crosshair', x1: cx, x2: cx, y1: plotTop, y2: railBottom }));
    }

    // Curve points, padded to both edges of the domain so no line floats
    const curve = b => {
      const out = [];
      for (const p of [{ t: t0, n: 0 }, ...series[b], { t: t1, n: run[b] }]) {
        const cx = x(p.t), cy = y(p.n);
        const last = out[out.length - 1];
        // Two clicks in the same pixel column: keep the later (higher) total
        if (last && Math.abs(last.x - cx) < 0.5) { last.x = cx; last.y = cy; continue; }
        out.push({ x: cx, y: cy });
      }
      return out;
    };

    for (const b of [1, 2, 3]) {
      if (!run[b]) continue;   // a flat line on the baseline says nothing
      const pts = curve(b);
      const d = stepPath(pts);
      const y0 = y(0);
      svg.append(el('path', {
        class: 'area', fill: `url(#fade-${b})`,
        d: `${d}L${pts[pts.length - 1].x} ${y0}L${pts[0].x} ${y0}Z`,
      }));
      svg.append(el('path', { class: 'bloom', d, stroke: SERIES[b] }));
      svg.append(el('path', { class: 'line', d, stroke: SERIES[b], 'data-series': b }));
    }

    // Every click: a node on its curve and a tick on the rail
    const showDots = data.length <= MAX_DOTS;
    data.forEach((c, i) => {
      const cx = x(c.t), cy = y(snaps[i][c.b]);
      hits.push({ x: cx, y: cy, ry: railY(c.b), c, cum: snaps[i] });
      if (showDots) {
        svg.append(el('circle', { class: 'dot', cx, cy, r: 3, fill: SERIES[c.b], 'data-id': c.id }));
      }
    });

    for (const b of [1, 2, 3]) {
      const ry = railY(b);
      svg.append(el('line', {
        class: 'rail-rule', x1: m.left + 7, x2: m.left + iw - 7, y1: ry, y2: ry,
      }));
      const lab = el('text', { class: 'lane-label', x: m.left - 8, y: ry + 4, 'text-anchor': 'end' });
      lab.textContent = NAMES[b];
      svg.append(lab);
    }

    const tickH = Math.max(rowH - 6, 4);
    for (const p of hits) {
      const on = p.c.id === active;
      const tw = on ? 5 : 3;
      svg.append(el('rect', {
        class: 'rail-tick' + (on ? ' is-active' : ''), fill: SERIES[p.c.b],
        x: p.x - tw / 2, y: p.ry - tickH / 2, width: tw, height: tickH, rx: tw / 2,
      }));
    }

    // The hovered click, lifted out of the crowd
    const act = hits.find(p => p.c.id === active);
    if (act) {
      svg.append(el('circle', { class: 'halo', cx: act.x, cy: act.y, r: 10, fill: SERIES[act.c.b] }));
      svg.append(el('circle', { class: 'dot is-active', cx: act.x, cy: act.y, r: 5, fill: SERIES[act.c.b] }));
      showTooltip(act);
    } else {
      tooltip.hidden = true;
    }
  }

  /* ── Tooltip ───────────────────────────────────────────── */
  function ttRow(b, text, strong) {
    const row = document.createElement('span');
    row.className = 'tt-row' + (strong ? ' is-strong' : '');
    const key = document.createElement('i');
    key.className = 'tt-key';
    key.style.background = SERIES[b];
    row.append(key, document.createTextNode(text));
    return row;
  }

  function showTooltip(hit) {
    tooltip.textContent = '';
    const val = document.createElement('span');
    val.className = 'tt-val';
    val.textContent = `${fSec.format(new Date(hit.c.t))} · ${NAMES[hit.c.b].toLowerCase()}`;
    const sub = document.createElement('span');
    sub.className = 'tt-sub';
    sub.textContent = `${fDay.format(new Date(hit.c.t))} · running total`;
    tooltip.append(val, sub);
    for (const b of [3, 2, 1]) {           // top row first, so it reads like the chart
      const row = ttRow(b, `${NAMES[b]} · ${hit.cum[b]}`, b === hit.c.b);
      if (!hit.cum[b]) row.classList.add('is-zero');
      tooltip.append(row);
    }
    placeTooltip(hit.x, hit.y);
  }

  function placeTooltip(px, py) {
    tooltip.hidden = false;
    const wrap = tooltip.parentElement.getBoundingClientRect();
    const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    const left = Math.min(Math.max(px, tw / 2 + 2), Math.max(wrap.width - tw / 2 - 2, tw / 2 + 2));
    const above = py - 12 - th >= 0;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${above ? py - 12 : py + 12}px`;
    tooltip.style.transform = above ? 'translate(-50%, -100%)' : 'translate(-50%, 0)';
  }

  /* ── Hover / tap ───────────────────────────────────────── */
  function nearest(px, py) {
    let best = null, bestD = Infinity;
    for (const p of hits) {
      const dx = p.x - px;
      // whichever anchor is closer — the node on the curve or the rail tick
      const dy = Math.min(Math.abs(p.y - py), Math.abs(p.ry - py));
      const d = dx * dx + (dy * 0.45) ** 2;   // favour horizontal aim
      if (d < bestD) { bestD = d; best = p.c.id; }
    }
    return bestD <= 56 ** 2 ? best : null;
  }

  function onPoint(ev) {
    const r = svg.getBoundingClientRect();
    const scale = (svg.viewBox.baseVal.width || r.width) / (r.width || 1);
    const id = nearest((ev.clientX - r.left) * scale, (ev.clientY - r.top) * scale);
    if (id !== active) { active = id; render(); }
  }

  svg.addEventListener('pointermove', onPoint);
  svg.addEventListener('pointerdown', onPoint);
  svg.addEventListener('pointerleave', () => { if (active) { active = null; render(); } });
  document.addEventListener('pointerdown', ev => {
    if (active && !svg.contains(ev.target)) { active = null; render(); }
  });

  /* ── Render ────────────────────────────────────────────── */
  function render() {
    const d = domain();
    const data = inRange(d);

    // Badges: today's counts (stated in the caption under the pad)
    const today = startOfToday();
    for (const b of [1, 2, 3]) {
      const n = clicks.filter(c => c.b === b && c.t >= today).length;
      $(`count-${b}`).textContent = String(n);
      document.querySelector(`.tap[data-btn="${b}"]`)
        .setAttribute('aria-label', `Record a click on the ${NAMES[b].toLowerCase()} button — ${plural(n, 'click')} today`);
      $(`legend-${b}`).textContent = String(data.filter(c => c.b === b).length);
    }

    const todayTotal = clicks.filter(c => c.t >= today).length;
    const last = clicks[clicks.length - 1];
    $('last-line').textContent = last
      ? `Today: ${plural(todayTotal, 'click')} · last was ${NAMES[last.b].toLowerCase()} at ${fSec.format(new Date(last.t))}`
      : 'No clicks yet — tap a button.';

    const label = range === 'today' ? 'today' : range === 'all' ? 'all time' : `last ${range} days`;
    const sub = [plural(data.length, 'click'), label];
    const trend = trendNote(d);
    if (trend) sub.push(trend);
    $('chart-sub').textContent = sub.join(' · ');

    drawChart(data, d);
  }

  /* ── Mutations ─────────────────────────────────────────── */
  let seq = 0;
  function add(b) {
    const t = Date.now();
    clicks.push({ id: `${t}-${b}-${seq++}`, t, b });
    clicks.sort((a, z) => a.t - z.t);
    save();
    render();
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch {} }
  }

  /* ── Toast ─────────────────────────────────────────────── */
  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
  }

  /* ── Wiring ────────────────────────────────────────────── */
  document.querySelectorAll('.tap').forEach(btn => {
    btn.addEventListener('click', () => {
      add(Number(btn.dataset.btn));
      btn.classList.remove('is-hit');
      void btn.offsetWidth;
      btn.classList.add('is-hit');
    });
  });

  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach(c => {
        const on = c === chip;
        c.classList.toggle('is-selected', on);
        c.setAttribute('aria-pressed', String(on));
      });
      range = chip.dataset.range;
      active = null;
      render();
    });
  });

  $('export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(clicks, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.href = url;
    a.download = `clicks-${stamp}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });

  /* ── Tabs ──────────────────────────────────────────────── */
  const tabs = [...document.querySelectorAll('.tabbtn')];

  function activateTab(btn) {
    for (const t of tabs) {
      const on = t === btn;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.dataset.panel).hidden = !on;
    }
    $('screen-title').textContent = btn.dataset.title;
    active = null;
    window.scrollTo(0, 0);
    render();   // the newly shown panel now has a real width
  }

  tabs.forEach((btn, i) => {
    btn.addEventListener('click', () => activateTab(btn));
    btn.addEventListener('keydown', ev => {
      const step = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      ev.preventDefault();
      const next = tabs[(i + step + tabs.length) % tabs.length];
      activateTab(next);
      next.focus();
    });
  });

  /* ── Theme ─────────────────────────────────────────────── */
  const glyphs = { auto: '◐', light: '☀', dark: '☾' };
  function applyTheme(mode) {
    if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    $('theme-glyph').textContent = glyphs[mode];
    try { localStorage.setItem(THEME_KEY, mode); } catch {}
  }
  let theme = 'auto';
  try { theme = localStorage.getItem(THEME_KEY) || 'auto'; } catch {}
  if (!glyphs[theme]) theme = 'auto';
  applyTheme(theme);
  $('theme-toggle').addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    theme = order[(order.indexOf(theme) + 1) % order.length];
    applyTheme(theme);
    render();
  });

  /* ── Keyboard: 1 / 2 / 3 ───────────────────────────────── */
  document.addEventListener('keydown', ev => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
    if (['1', '2', '3'].includes(ev.key)) { add(Number(ev.key)); ev.preventDefault(); }
  });

  /* ── Resize / clock ────────────────────────────────────── */
  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(render, 120); });
  setInterval(() => { if (range !== 'all') render(); }, 60000);   // keep "now" edge moving

  render();

  /* ── Offline support ───────────────────────────────────── */
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  /* ── Ask the browser not to evict the log ──────────────── */
  // localStorage is "best effort" by default: Android can clear it when the device
  // is low on space. Persistent storage makes it durable until explicitly deleted.
  // Granted silently for installed PWAs; ignored elsewhere. Never blocks anything.
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persisted()
      .then(already => (already ? null : navigator.storage.persist()))
      .catch(() => {});
  }
})();
