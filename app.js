/* Click Timeline — records button taps and plots them on a time axis.
   All state lives in localStorage; nothing is ever sent anywhere. */
(() => {
  'use strict';

  const STORE_KEY = 'click-timeline/v1';
  const THEME_KEY = 'click-timeline/theme';
  const SERIES = { 1: 'var(--series-1)', 2: 'var(--series-2)', 3: 'var(--series-3)' };
  const DAY = 86400000;

  /* ── State ─────────────────────────────────────────────── */
  let clicks = load();          // [{ id, t, b }] kept sorted ascending by t
  let range = 'today';
  let active = null;            // hovered click id

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
  let hits = [];   // { x, y, c } in px, for nearest-point hover

  function drawChart(data, [t0, t1]) {
    svg.textContent = '';
    hits = [];
    const empty = !data.length;
    $('chart-empty').hidden = !empty;
    svg.style.visibility = empty ? 'hidden' : 'visible';
    if (empty) return;

    const w = svg.clientWidth || svg.getBoundingClientRect().width;
    const h = svg.clientHeight || 210;
    if (!w) return;   // panel is hidden; activateTab() redraws when it is shown
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

    const m = { top: 12, right: 12, bottom: 26, left: 26 };
    const iw = Math.max(w - m.left - m.right, 10);
    const ih = Math.max(h - m.top - m.bottom, 10);
    const x = t => m.left + ((t - t0) / (t1 - t0 || 1)) * iw;
    const laneH = ih / 3;
    const y = b => m.top + laneH * (3 - b + 0.5);   // 1 at the bottom, 3 at the top

    // Gridlines + x labels
    const tickTarget = w < 380 ? 4 : w < 560 ? 5 : 7;
    for (const tk of ticks(t0, t1, tickTarget)) {
      const px = x(tk.t);
      svg.append(el('line', { class: 'gridline', x1: px, x2: px, y1: m.top, y2: m.top + ih }));
      const label = el('text', { x: px, y: h - 8, 'text-anchor': 'middle' });
      label.textContent = tickLabel(tk);
      svg.append(label);
    }

    // Lane rules + labels (the direct-label relief for low-contrast series)
    for (const b of [1, 2, 3]) {
      svg.append(el('line', {
        class: 'lane-rule', x1: m.left, x2: m.left + iw, y1: y(b), y2: y(b), opacity: 0.55,
      }));
      const lab = el('text', { class: 'lane-label', x: m.left - 9, y: y(b) + 4, 'text-anchor': 'end' });
      lab.textContent = String(b);
      svg.append(lab);
    }

    // Dots
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
      placeTooltip(hit);
    } else {
      tooltip.hidden = true;
    }
  }

  function placeTooltip(hit) {
    tooltip.textContent = '';
    const val = document.createElement('span');
    val.className = 'tt-val';
    val.textContent = fSec.format(new Date(hit.c.t));
    const row = document.createElement('span');
    const key = document.createElement('i');
    key.className = 'tt-key';
    key.style.background = SERIES[hit.c.b];
    row.append(key, document.createTextNode(`Button ${hit.c.b} · ${fDay.format(new Date(hit.c.t))}`));
    tooltip.append(val, row);
    tooltip.hidden = false;

    const wrap = tooltip.parentElement.getBoundingClientRect();
    const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    const left = Math.min(Math.max(hit.x, tw / 2 + 2), Math.max(wrap.width - tw / 2 - 2, tw / 2 + 2));
    const above = hit.y - 12 - th >= 0;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${above ? hit.y - 12 : hit.y + 12}px`;
    tooltip.style.transform = above ? 'translate(-50%, -100%)' : 'translate(-50%, 0)';
  }

  function nearest(px, py) {
    let best = null, bestD = Infinity;
    for (const p of hits) {
      const d = (p.x - px) ** 2 + ((p.y - py) * 0.6) ** 2;   // favour horizontal aim
      if (d < bestD) { bestD = d; best = p; }
    }
    return best && bestD <= 44 ** 2 ? best : null;
  }

  function onPoint(ev) {
    const r = svg.getBoundingClientRect();
    const scale = (svg.viewBox.baseVal.width || r.width) / (r.width || 1);
    const hit = nearest((ev.clientX - r.left) * scale, (ev.clientY - r.top) * scale);
    const id = hit ? hit.c.id : null;
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
    $('chart-sub').textContent = `${plural(data.length, 'click')} · ${label}`;
    $('table-sub').textContent = `${plural(data.length, 'click')} · newest first`;

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
