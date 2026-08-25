/* Click Timeline — records button taps and plots them on a time axis.
   All state lives in localStorage; nothing is ever sent anywhere. */
(() => {
  'use strict';

  const STORE_KEY = 'click-timeline/v1';
  const THEME_KEY = 'click-timeline/theme';
  const MODE_KEY  = 'click-timeline/chart-mode';
  const SERIES = { 1: 'var(--series-1)', 2: 'var(--series-2)', 3: 'var(--series-3)' };
  const DAY = 86400000;

  /* ── State ─────────────────────────────────────────────── */
  let clicks = load();          // [{ id, t, b }] kept sorted ascending by t
  let range = 'today';
  let modePref = loadMode();    // 'auto' | 'clicks' | 'buckets' — chart detail
  let active = null;            // hovered click id, or 'bk:<ms>' for a hovered bucket

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

  function loadMode() {
    try {
      const v = localStorage.getItem(MODE_KEY);
      return v === 'clicks' || v === 'buckets' ? v : 'auto';
    } catch { return 'auto'; }
  }

  /* ── Formatting ────────────────────────────────────────── */
  const fTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
  const fSec  = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fDay  = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
  const fWkDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const fMonth = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' });
  const fFull = new Intl.DateTimeFormat(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
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

  /* ── Aggregation — counts per hour / day / week / month ───
     The bucket follows the visible span, so "Per day" becomes "Per hour" on
     Today and "Per week"/"Per month" once the domain outgrows a daily bar. */
  const BUCKET_NOUN = { hour: 'hour', day: 'day', week: 'week', month: 'month' };

  function bucketOf([t0, t1]) {
    const span = t1 - t0;
    if (span <=   2 * DAY) return 'hour';
    if (span <= 120 * DAY) return 'day';
    if (span <= 1095 * DAY) return 'week';
    return 'month';
  }

  // Aggregate on every range but Today, until the toggle is used explicitly
  const aggregated = () => (modePref === 'auto' ? range !== 'today' : modePref === 'buckets');

  function bucketStart(t, bucket) {
    const d = new Date(t);
    d.setMinutes(0, 0, 0);
    if (bucket === 'hour') return d.getTime();
    d.setHours(0, 0, 0, 0);
    if (bucket === 'day') return d.getTime();
    if (bucket === 'week') { d.setDate(d.getDate() - d.getDay()); return d.getTime(); }
    d.setDate(1);
    return d.getTime();
  }

  // Stepped with Date methods, not +N ms, so DST shifts don't drift the edges
  function bucketNext(t, bucket) {
    const d = new Date(t);
    if (bucket === 'hour')      d.setHours(d.getHours() + 1);
    else if (bucket === 'day')  d.setDate(d.getDate() + 1);
    else if (bucket === 'week') d.setDate(d.getDate() + 7);
    else                        d.setMonth(d.getMonth() + 1);
    return d.getTime();
  }

  const MAX_BUCKETS = 2000;   // guard: a pathological domain can't hang the render

  function buckets(data, [t0, t1], bucket) {
    const out = [], byStart = new Map();
    for (let t = bucketStart(t0, bucket); t <= t1 && out.length < MAX_BUCKETS; t = bucketNext(t, bucket)) {
      const bk = { t, end: bucketNext(t, bucket), k: bucket, n: [0, 0, 0, 0], total: 0 };
      byStart.set(t, bk);
      out.push(bk);
    }
    for (const c of data) {
      const bk = byStart.get(bucketStart(c.t, bucket));
      if (bk) { bk.n[c.b]++; bk.total++; }
    }
    return out;
  }

  function bucketCount([t0, t1], bucket) {
    let n = 0;
    for (let t = bucketStart(t0, bucket); t <= t1 && n < MAX_BUCKETS; t = bucketNext(t, bucket)) n++;
    return n;
  }

  const bucketId = bk => `bk:${bk.t}`;

  function bucketLabel(bk) {
    const d = new Date(bk.t);
    if (bk.k === 'hour')  return `${fDay.format(d)} · ${fTime.format(d)}`;
    if (bk.k === 'day')   return fWkDay.format(d);
    if (bk.k === 'week')  return `Week of ${fDay.format(d)}`;
    return fMonth.format(d);
  }

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

  /* ── Chart ─────────────────────────────────────────────── */
  let hits  = [];   // { x, y, c }  dot mode: one entry per click
  let bhits = [];   // { x, bk }    bucket mode: one entry per time bucket

  function drawChart(data, [t0, t1]) {
    svg.textContent = '';
    hits = [];
    bhits = [];
    const empty = !data.length;
    $('chart-empty').hidden = !empty;
    svg.style.visibility = empty ? 'hidden' : 'visible';
    if (empty) { tooltip.hidden = true; return; }

    const w = svg.clientWidth || svg.getBoundingClientRect().width;
    const h = svg.clientHeight || 210;
    if (!w) return;   // panel is hidden; activateTab() redraws when it is shown
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

    const m = { top: 12, right: 12, bottom: 26, left: 26 };
    const iw = Math.max(w - m.left - m.right, 10);
    const ih = Math.max(h - m.top - m.bottom, 10);
    const x = t => m.left + ((t - t0) / (t1 - t0 || 1)) * iw;
    const geo = { m, iw, ih, x, laneH: ih / 3 };

    // Gridlines + x labels
    const tickTarget = w < 380 ? 4 : w < 560 ? 5 : 7;
    for (const tk of ticks(t0, t1, tickTarget)) {
      const px = x(tk.t);
      svg.append(el('line', { class: 'gridline', x1: px, x2: px, y1: m.top, y2: m.top + ih }));
      // Anchor the outermost labels inward instead of letting them hang off the edge
      const edge = px > w - 30 ? ['end', w - 4] : px < 30 ? ['start', 4] : ['middle', px];
      const label = el('text', { x: edge[1], y: h - 8, 'text-anchor': edge[0] });
      label.textContent = tickLabel(tk);
      svg.append(label);
    }

    if (aggregated()) drawBars(data, [t0, t1], geo);
    else              drawDots(data, geo);
  }

  function laneLabel(b, yPx, m) {
    const lab = el('text', { class: 'lane-label', x: m.left - 9, y: yPx, 'text-anchor': 'end' });
    lab.textContent = String(b);
    svg.append(lab);
  }

  /* ── One dot per click ─────────────────────────────────── */
  function drawDots(data, { m, iw, ih, laneH, x }) {
    const y = b => m.top + laneH * (3 - b + 0.5);   // 1 at the bottom, 3 at the top

    // Lane rules + labels (the direct-label relief for low-contrast series)
    for (const b of [1, 2, 3]) {
      svg.append(el('line', {
        class: 'lane-rule', x1: m.left, x2: m.left + iw, y1: y(b), y2: y(b), opacity: 0.55,
      }));
      laneLabel(b, y(b) + 4, m);
    }

    for (const c of data) {
      const cx = x(c.t), cy = y(c.b);
      hits.push({ x: cx, y: cy, c });
      svg.append(el('circle', {
        class: 'dot' + (active === c.id ? ' is-active' : ''),
        cx, cy, r: 5, fill: SERIES[c.b], 'data-id': c.id,
      }));
    }

    // Crosshair for the active point
    const hit = hits.find(p => p.c.id === active);
    if (hit) {
      svg.insertBefore(el('line', {
        class: 'crosshair', x1: hit.x, x2: hit.x, y1: m.top, y2: m.top + ih,
      }), svg.firstChild);
      dotTooltip(hit);
    } else {
      tooltip.hidden = true;
    }
  }

  /* ── Counts per bucket: three rows of bars, one row per button ──
     Every row shares one scale, so row heights are comparable — that is the
     whole point of the view. Square at the baseline, 4px rounded at the data
     end, 2px of surface between neighbours. */
  const LABEL_ROOM = 16;   // headroom kept above the tallest bar, clear of the lane rule above

  function barPath(x0, yTop, w, hh, r) {
    const rr = Math.max(0, Math.min(r, w / 2, hh));
    return `M${x0} ${yTop + hh}`
         + `L${x0} ${yTop + rr}Q${x0} ${yTop} ${x0 + rr} ${yTop}`
         + `L${x0 + w - rr} ${yTop}Q${x0 + w} ${yTop} ${x0 + w} ${yTop + rr}`
         + `L${x0 + w} ${yTop + hh}Z`;
  }

  function drawBars(data, [t0, t1], { m, iw, ih, laneH, x }) {
    const bks = buckets(data, [t0, t1], bucketOf([t0, t1]));
    const peak = Math.max(1, ...bks.map(bk => Math.max(bk.n[1], bk.n[2], bk.n[3])));
    const barMax = Math.max(laneH - LABEL_ROOM, 6);
    const base = b => m.top + laneH * (3 - b + 1);   // lane baseline; 1 at the bottom

    // Bucket edges clamped to the plot, so a part-covered first/last bucket
    // stays inside the axes instead of bleeding into the label gutter
    const span = bk => {
      const sx = Math.max(x(bk.t), m.left);
      const ex = Math.min(x(bk.end), m.left + iw);
      return { sx, ex, slot: ex - sx };
    };

    const act = bks.find(bk => bucketId(bk) === active);
    if (act) {
      const { sx, slot } = span(act);
      svg.append(el('rect', { class: 'band', x: sx, y: m.top, width: Math.max(slot, 2), height: ih }));
    }

    for (const b of [1, 2, 3]) {
      const y0 = base(b);
      svg.append(el('line', { class: 'lane-rule', x1: m.left, x2: m.left + iw, y1: y0, y2: y0 }));
      laneLabel(b, y0 - 3, m);

      let top = null;   // this row's own peak — the one bar that gets a value label
      for (const bk of bks) {
        if (!bk.n[b]) continue;
        const { sx, slot } = span(bk);
        if (slot <= 0) continue;
        const bw = Math.max(1.5, Math.min(24, slot - 2));
        const bx = sx + (slot - bw) / 2;
        const bh = Math.max((bk.n[b] / peak) * barMax, 2);
        svg.append(el('path', { class: 'bar', d: barPath(bx, y0 - bh, bw, bh, 4), fill: SERIES[b] }));
        if (!top || bk.n[b] > top.n) top = { n: bk.n[b], x: bx + bw / 2, y: y0 - bh };
      }
      if (top && top.n > 1) {
        const lab = el('text', {
          class: 'bar-val', 'text-anchor': 'middle', y: top.y - 3,
          x: Math.min(Math.max(top.x, m.left + 8), m.left + iw - 8),
        });
        lab.textContent = String(top.n);
        svg.append(lab);
      }
    }

    for (const bk of bks) {
      const { sx, ex, slot } = span(bk);
      if (slot > 0) bhits.push({ x: (sx + ex) / 2, bk });
    }

    if (act) bucketTooltip(act, span(act), m);
    else tooltip.hidden = true;
  }

  /* ── Tooltips ──────────────────────────────────────────── */
  function ttRow(b, text) {
    const row = document.createElement('span');
    row.className = 'tt-row';
    const key = document.createElement('i');
    key.className = 'tt-key';
    key.style.background = SERIES[b];
    row.append(key, document.createTextNode(text));
    return row;
  }

  function dotTooltip(hit) {
    tooltip.textContent = '';
    const val = document.createElement('span');
    val.className = 'tt-val';
    val.textContent = fSec.format(new Date(hit.c.t));
    tooltip.append(val, ttRow(hit.c.b, `Button ${hit.c.b} · ${fDay.format(new Date(hit.c.t))}`));
    placeTooltip(hit.x, hit.y);
  }

  function bucketTooltip(bk, { sx, ex }, m) {
    tooltip.textContent = '';
    const val = document.createElement('span');
    val.className = 'tt-val';
    val.textContent = `${bucketLabel(bk)} · ${plural(bk.total, 'click')}`;
    tooltip.append(val);
    for (const b of [3, 2, 1]) {           // top row first, so it reads like the chart
      const row = ttRow(b, `Button ${b} · ${bk.n[b]}`);
      if (!bk.n[b]) row.classList.add('is-zero');
      tooltip.append(row);
    }
    placeTooltip((sx + ex) / 2, m.top);
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
    if (aggregated()) {
      // The whole bucket column is the hit target — no vertical aim needed
      for (const p of bhits) {
        const d = Math.abs(p.x - px);
        if (d < bestD) { bestD = d; best = bucketId(p.bk); }
      }
      return best;
    }
    for (const p of hits) {
      const d = (p.x - px) ** 2 + ((p.y - py) * 0.6) ** 2;   // favour horizontal aim
      if (d < bestD) { bestD = d; best = p.c.id; }
    }
    return bestD <= 44 ** 2 ? best : null;
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

  /* ── Table ─────────────────────────────────────────────── */
  function drawTable(data) {
    const body = $('log-body');
    body.textContent = '';
    $('table-empty').hidden = data.length > 0;
    const rows = data.slice().reverse();
    rows.forEach((c, i) => {
      const tr = document.createElement('tr');

      const n = document.createElement('td');
      n.textContent = String(rows.length - i);

      const btn = document.createElement('td');
      btn.className = 'c-btn';
      const key = document.createElement('i');
      key.className = `key key-${c.b}`;
      btn.append(key, document.createTextNode(String(c.b)));

      const time = document.createElement('td');
      time.textContent = fFull.format(new Date(c.t));

      const act = document.createElement('td');
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'row-del';
      del.textContent = '×';
      del.title = 'Delete this click';
      del.setAttribute('aria-label', `Delete click on button ${c.b} at ${fFull.format(new Date(c.t))}`);
      del.addEventListener('click', () => remove(c.id));
      act.append(del);

      tr.append(n, btn, time, act);
      body.append(tr);
    });
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
        .setAttribute('aria-label', `Record a click on button ${b} — ${plural(n, 'click')} today`);
      $(`legend-${b}`).textContent = String(data.filter(c => c.b === b).length);
    }

    const todayTotal = clicks.filter(c => c.t >= today).length;
    const last = clicks[clicks.length - 1];
    $('last-line').textContent = last
      ? `Today: ${plural(todayTotal, 'click')} · last was button ${last.b} at ${fSec.format(new Date(last.t))}`
      : 'No clicks yet — tap a button.';

    const label = range === 'today' ? 'today' : range === 'all' ? 'all time' : `last ${range} days`;
    const agg = aggregated();
    const bucket = bucketOf(d);
    const noun = BUCKET_NOUN[bucket];

    const sub = [plural(data.length, 'click'), label];
    if (agg) {
      const avg = data.length / (bucketCount(d, bucket) || 1);
      sub.push(`avg ${avg >= 10 ? Math.round(avg) : avg.toFixed(1)}/${noun}`);
      const trend = trendNote(d);
      if (trend) sub.push(trend);
    }
    $('chart-sub').textContent = sub.join(' · ');
    $('table-sub').textContent = `${plural(data.length, 'click')} · newest first`;

    // Detail toggle: its label names the bucket the current span resolves to
    $('mode-buckets').textContent = `Per ${noun}`;
    for (const btn of document.querySelectorAll('.seg-btn')) {
      const on = (btn.dataset.mode === 'buckets') === agg;
      btn.classList.toggle('is-selected', on);
      btn.setAttribute('aria-pressed', String(on));
    }

    $('chart-title-a11y').textContent = agg
      ? `Clicks per ${noun}. Three rows, one per button (1 at the bottom, 3 at the top); `
        + `each bar is how many clicks that button got in that ${noun}, on a scale shared by `
        + `all three rows. The log table below lists every click.`
      : 'Timeline of clicks. Each row is a button (1 at the bottom, 3 at the top); each dot is '
        + 'one click at the time shown on the horizontal axis. The log table below lists the same data.';

    drawChart(data, d);
    drawTable(data);
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

  function remove(id) {
    const i = clicks.findIndex(c => c.id === id);
    if (i < 0) return;
    clicks.splice(i, 1);
    active = null;
    save();
    render();
    toast('Deleted');
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
      active = null;
      render();
    });
  });

  document.querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      modePref = btn.dataset.mode;
      try { localStorage.setItem(MODE_KEY, modePref); } catch {}
      active = null;
      render();
    });
  });

  $('undo').addEventListener('click', () => {
    if (!clicks.length) return toast('Nothing to undo');
    const c = clicks.pop();
    save();
    render();
    toast(`Removed button ${c.b} at ${fSec.format(new Date(c.t))}`);
  });

  $('clear').addEventListener('click', () => {
    if (!clicks.length) return toast('Already empty');
    if (!confirm(`Delete all ${clicks.length} clicks? This cannot be undone.`)) return;
    clicks = [];
    save();
    render();
    toast('Cleared');
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

  $('import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', ev => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let incoming;
      try { incoming = JSON.parse(String(reader.result)); } catch { return toast('Not valid JSON'); }
      if (!Array.isArray(incoming)) return toast('Expected a JSON array');
      const seen = new Set(clicks.map(c => `${c.t}|${c.b}`));
      let added = 0;
      for (const c of incoming) {
        const t = Number(c && c.t), b = Number(c && c.b);
        if (!Number.isFinite(t) || ![1, 2, 3].includes(b)) continue;
        const k = `${t}|${b}`;
        if (seen.has(k)) continue;
        seen.add(k);
        clicks.push({ id: `${t}-${b}-i${seq++}`, t, b });
        added++;
      }
      clicks.sort((a, z) => a.t - z.t);
      save();
      render();
      toast(added ? `Imported ${plural(added, 'click')}` : 'Nothing new to import');
    };
    reader.readAsText(file);
    ev.target.value = '';
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
