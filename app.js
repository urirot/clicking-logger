/* Count the Dots — records button taps and plots them on a time axis.
   All state lives in localStorage; nothing is ever sent anywhere. */
(() => {
  'use strict';

  const STORE_KEY = 'click-timeline/v1';
  const THEME_KEY = 'click-timeline/theme';
  const DRAWER_KEY = 'click-timeline/drawer';
  const SERIES = { 1: 'var(--series-1)', 2: 'var(--series-2)', 3: 'var(--series-3)' };
  const NAMES  = { 1: 'Blue', 2: 'Yellow', 3: 'Red' };   // 1 at the bottom of the rail
  const DAY = 86400000;

  /* ── State ─────────────────────────────────────────────── */
  let clicks = load();          // [{ id, t, b }] kept sorted ascending by t
  let range = '7';        // a single day rarely shows whether anything changed
  let active = null;            // start time of the period being read, or null
  let activeRow = 0;            // 1..3 while the pointer is over that rail row, else 0
  let pinned = false;           // set by a tap/click: survives hover and pointerleave

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
  const fWkDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const fMonth = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' });
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
     One line per colour through plain integer counts: how many clicks that
     colour got in each period. Nothing is smoothed, weighted or accumulated —
     the number on the axis is a count you could arrive at by hand. The period
     follows the visible span, and the rail underneath keeps every individual
     tap visible at its exact time. */
  let bins = [];          // the periods currently plotted
  let geo = null;         // last render's geometry, for turning a point into a period

  const RAIL_H   = 42;    // event rail at the foot of the plot
  const RAIL_GAP = 14;    // breathing room between the lines and the rail
  const MAX_BINS = 400;   // guard: a pathological domain cannot hang the render
  const DOT_LIMIT = 60;   // past this the per-period dots are just noise

  const PERIODS = [
    { upTo:    2 * DAY, kind: 'hour'  },
    { upTo:  120 * DAY, kind: 'day'   },
    { upTo: 1095 * DAY, kind: 'week'  },
    { upTo:   Infinity, kind: 'month' },
  ];
  const periodOf = span => PERIODS.find(p => span <= p.upTo).kind;

  function binStart(t, kind) {
    const d = new Date(t);
    d.setMinutes(0, 0, 0);
    if (kind === 'hour') return d.getTime();
    d.setHours(0, 0, 0, 0);
    if (kind === 'day') return d.getTime();
    if (kind === 'week') { d.setDate(d.getDate() - d.getDay()); return d.getTime(); }
    d.setDate(1);
    return d.getTime();
  }

  // Stepped with Date methods, not +N ms, so DST shifts don't drift the edges
  function binNext(t, kind) {
    const d = new Date(t);
    if (kind === 'hour')      d.setHours(d.getHours() + 1);
    else if (kind === 'day')  d.setDate(d.getDate() + 1);
    else if (kind === 'week') d.setDate(d.getDate() + 7);
    else                      d.setMonth(d.getMonth() + 1);
    return d.getTime();
  }

  function binize(data, [t0, t1], kind) {
    const list = [], byStart = new Map();
    for (let t = binStart(t0, kind); t <= t1 && list.length < MAX_BINS; t = binNext(t, kind)) {
      const bk = { t, end: binNext(t, kind), kind, n: { 1: 0, 2: 0, 3: 0 }, total: 0 };
      byStart.set(t, bk);
      list.push(bk);
    }
    for (const c of data) {
      const bk = byStart.get(binStart(c.t, kind));
      if (bk) { bk.n[c.b]++; bk.total++; }
    }
    return list;
  }

  function binLabel(bk) {
    const d = new Date(bk.t);
    if (bk.kind === 'hour')  return `${fDay.format(d)} · ${fTime.format(d)}`;
    if (bk.kind === 'day')   return fWkDay.format(d);
    if (bk.kind === 'week')  return `Week of ${fDay.format(d)}`;
    return fMonth.format(d);
  }

  // Whole numbers only — half a click is not a thing
  function countStep(peak, target) {
    const raw = peak / target;
    const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
    for (const f of [1, 2, 2.5, 5, 10]) {
      const v = Math.round(pow * f);
      if (v >= raw) return Math.max(1, v);
    }
    return Math.max(1, Math.round(pow * 10));
  }

  function drawChart(data, [t0, t1]) {
    svg.textContent = '';
    bins = [];
    const empty = !data.length;
    $('chart-empty').hidden = !empty;
    svg.style.visibility = empty ? 'hidden' : 'visible';
    if (empty) { tooltip.hidden = true; return null; }

    const w = svg.clientWidth || svg.getBoundingClientRect().width;
    const h = svg.clientHeight || 272;
    if (!w) return null;   // panel is hidden; activateTab() redraws when it is shown
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

    const m = { top: 16, right: 14, bottom: 24, left: 48 };
    const iw = Math.max(w - m.left - m.right, 10);
    const ih = Math.max(h - m.top - m.bottom, 10);
    const x = t => m.left + ((t - t0) / (t1 - t0 || 1)) * iw;

    const railBottom = m.top + ih;
    const railTop = railBottom - Math.min(RAIL_H, Math.max(ih * 0.35, 18));
    const rowH = (railBottom - railTop) / 3;
    const railY = b => railTop + rowH * (3 - b) + rowH / 2;   // blue at the bottom
    const plotTop = m.top + 6;   // headroom, so a peak never touches the top rule
    const plotBottom = Math.max(railTop - RAIL_GAP, plotTop + 24);

    const kind = periodOf(t1 - t0);
    bins = binize(data, [t0, t1], kind);

    /* Hit-testing reads a period out of an x position — the tooltip describes a
       period, so that is what a tap should select. Proximity to an individual
       tap is not required: tapping a quiet stretch still answers "nothing that
       day", which is a real answer. */
    geo = {
      inPlot: px => px >= m.left - 2 && px <= m.left + iw + 2,
      timeAt: px => t0 + ((px - m.left) / (iw || 1)) * (t1 - t0),
      rowAt: py => (py >= railTop - 4 && py <= railBottom + 4)
        ? Math.min(3, Math.max(1, 3 - Math.floor((py - railTop) / (rowH || 1))))
        : 0,
    };

    let peak = 0;
    for (const bk of bins) for (const b of [1, 2, 3]) if (bk.n[b] > peak) peak = bk.n[b];
    const step = countStep(Math.max(peak, 1), 3);
    const yTop = Math.max(Math.ceil(Math.max(peak, 1) / step) * step, step);
    const y = v => plotBottom - (v / yTop) * (plotBottom - plotTop);

    // A period's point sits at its midpoint, clamped so a part-covered first or
    // last period stays inside the axes instead of bleeding into the gutter
    const mid = bk => (Math.max(x(bk.t), m.left) + Math.min(x(bk.end), m.left + iw)) / 2;

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

    // The period being read, banded across the plot so it is obvious which
    // slice of time the tooltip's numbers cover
    const actBin = active === null ? null : bins.find(bk => bk.t === active);
    if (actBin) {
      const sx = Math.max(x(actBin.t), m.left);
      const ex = Math.min(x(actBin.end), m.left + iw);
      svg.append(el('rect', {
        class: 'band', x: sx, y: plotTop, width: Math.max(ex - sx, 2), height: railBottom - plotTop,
      }));
    }

    // One line per colour, straight between period counts — no smoothing, and
    // no fill: with lines that cross, a wash reads as stacked area.
    for (const b of [1, 2, 3]) {
      if (!data.some(c => c.b === b)) continue;   // nothing in range: no line
      const d = bins.map((bk, i) => `${i ? 'L' : 'M'}${mid(bk)} ${y(bk.n[b])}`).join('');
      svg.append(el('path', { class: 'bloom', d, stroke: SERIES[b] }));
      svg.append(el('path', { class: 'line', d, stroke: SERIES[b], 'data-series': b }));
    }

    if (bins.length <= DOT_LIMIT) {
      for (const b of [1, 2, 3]) {
        if (!data.some(c => c.b === b)) continue;
        for (const bk of bins) {
          svg.append(el('circle', {
            class: 'bin-dot', cx: mid(bk), cy: y(bk.n[b]), r: 2.5, fill: SERIES[b],
          }));
        }
      }
    }

    // Rail: one row per colour, one tick per tap
    for (const b of [1, 2, 3]) {
      const ry = railY(b);
      svg.append(el('line', {
        class: 'rail-rule', x1: m.left + 7, x2: m.left + iw - 7, y1: ry, y2: ry,
      }));
      const lab = el('text', { class: 'lane-label', x: m.left - 8, y: ry + 4, 'text-anchor': 'end' });
      lab.textContent = NAMES[b];
      svg.append(lab);
    }

    // Every tap in the banded period is highlighted — they are what it counts
    const tickH = Math.max(rowH - 6, 4);
    for (const c of data) {
      const on = !!actBin && c.t >= actBin.t && c.t < actBin.end;
      const tw = on ? 5 : 3;
      svg.append(el('rect', {
        class: 'rail-tick' + (on ? ' is-active' : ''), fill: SERIES[c.b],
        x: x(c.t) - tw / 2, y: railY(c.b) - tickH / 2, width: tw, height: tickH, rx: tw / 2,
      }));
    }

    // Readout: a node on every line at the banded period, so the tooltip's
    // three numbers are visibly the three lines
    if (actBin) {
      for (const b of [1, 2, 3]) {
        if (!data.some(c => c.b === b)) continue;
        svg.append(el('circle', {
          class: 'read-dot' + (b === activeRow ? ' is-active' : ''),
          cx: mid(actBin), cy: y(actBin.n[b]), r: b === activeRow ? 5 : 3.5, fill: SERIES[b],
        }));
      }
      showTooltip(actBin, activeRow, plotTop, mid(actBin));
    } else {
      tooltip.hidden = true;
    }

    return { peak, kind };
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

  function showTooltip(bk, tapped, plotTop, px) {
    tooltip.textContent = '';
    const val = document.createElement('span');
    val.className = 'tt-val';
    val.textContent = binLabel(bk);
    const sub = document.createElement('span');
    sub.className = 'tt-sub';
    sub.textContent = plural(bk.total, 'click');
    tooltip.append(val, sub);
    for (const b of [3, 2, 1]) {           // top row first, so it reads like the chart
      const row = ttRow(b, `${NAMES[b]} · ${bk.n[b]}`, b === tapped);
      if (!bk.n[b]) row.classList.add('is-zero');
      tooltip.append(row);
    }
    placeTooltip(px, plotTop);
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
  function pick(ev) {
    if (!geo) return null;
    const r = svg.getBoundingClientRect();
    const scale = (svg.viewBox.baseVal.width || r.width) / (r.width || 1);
    const px = (ev.clientX - r.left) * scale;
    const py = (ev.clientY - r.top) * scale;
    if (!geo.inPlot(px)) return null;
    const t = geo.timeAt(px);
    const bk = bins.find(b => t >= b.t && t < b.end);
    return bk ? { t: bk.t, row: geo.rowAt(py) } : null;
  }

  function show(sel, pin) {
    pinned = pin;
    const t = sel ? sel.t : null;
    const row = sel ? sel.row : 0;
    if (t === active && row === activeRow) return;
    active = t;
    activeRow = row;
    render();
  }

  /* Hover previews; a tap pins. Without pinning, touch is unusable: the browser
     fires pointerleave the moment the finger lifts, so the reading vanishes
     before it can be read. A pinned reading is dismissed by tapping away. */
  svg.addEventListener('pointermove', ev => { if (!pinned) show(pick(ev), false); });
  svg.addEventListener('pointerdown', ev => {
    const sel = pick(ev);
    show(sel, sel !== null);    // tapping outside the plot just clears
  });
  svg.addEventListener('pointerleave', () => { if (!pinned && active) clearActive(); });
  /* Capture phase, deliberately: the chart's own handler re-renders, which
     detaches the very node that was tapped, and by the bubble phase
     svg.contains(target) is false for it — dismissing the reading the tap was
     meant to pin. Tapping blank chart hid the bug, because there the target is
     the <svg> itself, which survives the rebuild. */
  document.addEventListener('pointerdown', ev => {
    if (active && !svg.contains(ev.target)) clearActive();
  }, true);

  function clearActive() {
    if (active === null && !pinned) return;
    active = null;
    activeRow = 0;
    pinned = false;
    render();
  }

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
    $('undo').disabled = !clicks.length;

    const info = drawChart(data, d);

    const sub = [plural(data.length, 'click'), label];
    if (info && info.peak > 0) sub.push(`peak ${info.peak}/${info.kind}`);
    const trend = trendNote(d);
    if (trend) sub.push(trend);
    $('chart-sub').textContent = sub.join(' · ');
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
      activeRow = 0;
      pinned = false;
      render();
    });
  });

  $('undo').addEventListener('click', () => {
    if (!clicks.length) return toast('Nothing to undo');
    const c = clicks.pop();
    active = null;
    activeRow = 0;
    pinned = false;
    save();
    render();
    toast(`Removed ${NAMES[c.b].toLowerCase()} at ${fSec.format(new Date(c.t))}`);
  });

  /* Import merges by whole local day: every day present in the file replaces
     whatever is recorded here for that day, and days the file says nothing
     about are left exactly as they are. Not a dedupe-and-append — re-importing
     a corrected day should fix it, not double it. */
  const dayKey = t => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };

  function importClicks(incoming) {
    const rows = [];
    for (const c of incoming) {
      const t = Number(c && c.t), b = Number(c && c.b);
      if (Number.isFinite(t) && [1, 2, 3].includes(b)) rows.push({ t, b });
    }
    if (!rows.length) return toast('No clicks in that file');

    const days = new Set(rows.map(r => dayKey(r.t)));
    const doomed = clicks.filter(c => days.has(dayKey(c.t))).length;
    // Replacing a day cannot be undone — undo only pops the newest click
    if (doomed && !confirm(
      `This file covers ${plural(days.size, 'day')}. Importing replaces what is already `
      + `recorded on ${days.size === 1 ? 'that day' : 'those days'} — ${plural(doomed, 'click')} `
      + `will be discarded. Every other day is left alone.\n\nContinue?`)) return;

    clicks = clicks.filter(c => !days.has(dayKey(c.t)));
    for (const r of rows) clicks.push({ id: `${r.t}-${r.b}-i${seq++}`, t: r.t, b: r.b });
    clicks.sort((a, z) => a.t - z.t);
    active = null;
    activeRow = 0;
    pinned = false;
    save();
    render();
    toast(`Imported ${plural(rows.length, 'click')} across ${plural(days.size, 'day')}`);
  }

  $('import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', ev => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';                 // so re-picking the same file fires again
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => toast('Could not read that file');
    reader.onload = () => {
      let data;
      try { data = JSON.parse(String(reader.result)); } catch { return toast('Not valid JSON'); }
      if (!Array.isArray(data)) return toast('Expected a JSON array');
      importClicks(data);
    };
    reader.readAsText(file);
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
    activeRow = 0;
    pinned = false;
    document.querySelector('main').scrollTop = 0;
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

  /* ── Data drawer — collapsed by default, choice remembered ─ */
  const drawer = $('data-drawer');
  try { drawer.open = localStorage.getItem(DRAWER_KEY) === '1'; } catch {}
  drawer.addEventListener('toggle', () => {
    try { localStorage.setItem(DRAWER_KEY, drawer.open ? '1' : '0'); } catch {}
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
    if (ev.key === 'Escape') return clearActive();
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
