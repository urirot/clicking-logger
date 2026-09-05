import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const dir = new URL('..', import.meta.url).pathname;
const pageSrc = fs.readFileSync(`${dir}/index.html`, 'utf8');
const appjs = fs.readFileSync(`${dir}/app.js`, 'utf8');
const errors = [];
const check = (cond, msg) => { if (!cond) errors.push('FAIL: ' + msg); };

/* jsdom lacks layout, so visible elements are given a size and hidden ones none,
   the way a real browser reports them. Boots a fresh window each call, optionally
   with the log pre-seeded — the rate curve can only be shown to fall against
   history, and taps made through the UI all land at `now`. */
function boot(seed, extra, transform) {
  const dom = new JSDOM(transform ? transform(pageSrc) : pageSrc, {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost:8731/',
  });
  const { window } = dom;
  window.addEventListener('error', e => errors.push('window error: ' + e.message));

  const isVisible = n => { for (let e = n; e; e = e.parentElement) if (e.hidden) return false; return true; };
  Object.defineProperty(window.SVGElement.prototype, 'clientWidth',  { get() { return isVisible(this) ? 640 : 0; } });
  Object.defineProperty(window.SVGElement.prototype, 'clientHeight', { get() { return isVisible(this) ? 272 : 0; } });
  window.Element.prototype.getBoundingClientRect = function () {
    const on = isVisible(this);
    const w = on ? 640 : 0, h = on ? 272 : 0;
    return { width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0 };
  };
  window.scrollTo = () => {};
  Object.defineProperty(window.HTMLElement.prototype, 'scrollTop',
    { configurable: true, get: () => 0, set: () => {} });
  Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth',  { get: () => 120 });
  Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', { get: () => 40 });
  window.confirm = () => true;
  // jsdom ships HTMLDialogElement but not showModal()/close(); the app uses them
  // for focus trapping and Escape, so stand them in for the test.
  const D = window.HTMLDialogElement.prototype;
  if (!D.showModal) {
    D.showModal = function () { this.setAttribute('open', ''); };
    D.close = function () { this.removeAttribute('open'); };
  }

  if (seed) window.localStorage.setItem('click-timeline/v1', JSON.stringify(seed));
  for (const k in extra) window.localStorage.setItem(k, extra[k]);   // each JSDOM has its own storage
  try { window.eval(appjs); } catch (e) { errors.push('app.js threw on load: ' + e.stack); }
  return window;
}

const window = boot(null);

/* jsdom has no layout, so it cannot catch a panel that is `hidden` yet still
   painted. #panel-tap sets display:flex, which outranks the UA [hidden] rule —
   this asserts the reset that beats it is still there. */
check(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(
  fs.readFileSync(`${dir}/styles.css`, 'utf8')),
  'styles.css keeps the [hidden] display reset that outranks #panel-tap');

const $ = id => window.document.getElementById(id);
const q = s => window.document.querySelector(s);
const qa = s => [...window.document.querySelectorAll(s)];
const num = (n, a) => Number(n.getAttribute(a));

// --- the pad is colour-only: no numerals, just a count badge per button
check(qa('.tap .tap-num').length === 0, 'the pad carries no numerals');
check(qa('.tap .tap-count').length === 3, 'each button keeps its count badge');
for (const [n, name] of [[1, 'blue'], [2, 'yellow'], [3, 'red']]) {
  const label = q(`.tap[data-btn="${n}"]`).getAttribute('aria-label') || '';
  check(label.includes(name), `button ${n} is named "${name}" to assistive tech, got "${label}"`);
}

// --- the timeline screen carries a chart, an export button, and nothing else
check(qa('#panel-data .card').length === 1, `one card on the timeline screen, got ${qa('#panel-data .card').length}`);
check($('log') === null && $('log-body') === null, 'the log table is gone');
for (const id of ['clear', 'mode-clicks', 'mode-buckets']) {
  check($(id) === null, `#${id} should be gone`);
}
check(qa('#panel-data .actions .btn').length === 2, 'export and import are the action buttons');
check($('export') !== null && $('import') !== null, 'export and import both present');
check(q('#data-drawer .actions') !== null && q('#data-drawer .footnote') !== null,
  'the buttons and the footnote live inside the collapsible drawer');
check($('data-drawer').open === false, 'the drawer starts collapsed');
check(q('.topbar-actions #undo') !== null, 'undo sits in the top bar, next to the theme toggle');
check(q('.topbar-actions #theme-toggle') !== null, 'theme toggle keeps its place');
check(q('.pad-caption') === null, 'the caption under the pad is gone');
check($('undo').disabled === true, 'undo is disabled with an empty log');

// --- the drawer remembers its state across a reload
{
  const tick = () => new Promise(r => setTimeout(r, 0));   // `toggle` is queued
  q('#data-drawer > summary').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick();
  check($('data-drawer').open === true, 'clicking the summary opens the drawer');
  check(window.localStorage.getItem('click-timeline/drawer') === '1', 'opening the drawer is stored');

  check(boot(null, { 'click-timeline/drawer': '1' }).document.getElementById('data-drawer').open === true,
    'a window started with the flag set opens the drawer');
  check(boot(null, { 'click-timeline/drawer': '0' }).document.getElementById('data-drawer').open === false,
    'and one started with it clear leaves it collapsed');

  q('#data-drawer > summary').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick();
  check($('data-drawer').open === false, 'clicking again collapses it');
  check(window.localStorage.getItem('click-timeline/drawer') === '0', 'closing it is stored too');
}

// --- empty state
check(q('.chip.is-selected').dataset.range === '7', `7 days is the default range, got ${q('.chip.is-selected').dataset.range}`);
check(q('.chip[data-range="7"]').getAttribute('aria-pressed') === 'true', 'default chip is pressed');
check(qa('.chip[aria-pressed="true"]').length === 1, 'exactly one chip pressed on load');
check($('chart-empty').hidden === false, 'empty chart notice should show with no data');
check($('last-line').textContent.includes('No clicks yet'), 'empty last-line');
check(qa('#chart path.line').length === 0, 'no curves with no data');

// --- record clicks
const tap = n => q(`.tap[data-btn="${n}"]`).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
tap(1); tap(3); tap(2); tap(1);

check($('count-1').textContent === '2', `badge 1 = 2, got ${$('count-1').textContent}`);
check($('count-2').textContent === '1', `badge 2 = 1, got ${$('count-2').textContent}`);
check($('count-3').textContent === '1', `badge 3 = 1, got ${$('count-3').textContent}`);
check($('legend-1').textContent === '2', `legend 1 = 2, got ${$('legend-1').textContent}`);
check(q('#panel-data .legend').textContent.replace(/\s+/g, ' ').includes('Red · 1'),
  `legend names colours: "${q('#panel-data .legend').textContent.replace(/\s+/g, ' ').trim()}"`);
check($('chart-empty').hidden === true, 'empty notice hidden once data exists');

// --- tabs: tap screen is the landing screen
check($('panel-tap').hidden === false, 'tap panel visible on load');
check($('panel-data').hidden === true, 'timeline panel hidden on load');
check(q('#tab-tap').getAttribute('aria-selected') === 'true', 'tap tab selected on load');
check($('screen-title') === null, 'the header carries no screen title');
check(q('.topbar h1.sr-only') !== null, 'but the page still has an h1 for structure');
check(qa('#chart circle.dot').length === 0, 'chart is not drawn while its panel is hidden');

const goto = id => q('#' + id).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
goto('tab-data');
check($('panel-data').hidden === false, 'timeline panel visible after switching');
check($('panel-tap').hidden === true, 'tap panel hidden after switching');
check(q('#tab-data').getAttribute('aria-selected') === 'true', 'timeline tab marked selected');
check(q('#tab-data').tabIndex === 0 && q('#tab-tap').tabIndex === -1, 'roving tabindex');

// --- three rate curves, no fills, one rail tick per click
check(qa('#chart path.line').length === 3, `one line per active button, got ${qa('#chart path.line').length}`);
check(qa('#chart path.bloom').length === 3, 'each line gets its bloom pass');
check(qa('#chart path.area').length === 0, 'no wash under the curves — that would read as stacking');
check(qa('#chart circle.dot').length === 0, 'a rate curve carries no per-tap node');
check(qa('#chart rect.rail-tick').length === 4, `4 rail ticks drawn, got ${qa('#chart rect.rail-tick').length}`);
check(qa('#chart line.gridline').length >= 2, 'gridlines drawn');
check(qa('#chart line.baseline').length === 1, 'a zero baseline is drawn');
check(qa('#chart rect.rail-bg').length === 1, 'the event rail has its own ground');
check(q('#chart text.y-unit') === null, 'the axis carries no unit caption');

{ // THE FIX: the axis counts clicks, so every tick is a whole number
  const ys = qa('#chart text.y-label').map(t => t.textContent);
  check(ys[0] === '0', `count axis starts at 0, got "${ys[0]}"`);
  check(ys.every(v => /^\d+$/.test(v)), `whole-number ticks only — no fractions, got [${ys}]`);
  check(Number(ys[ys.length - 1]) > 0, 'the axis reaches a positive count');
}
{ // and every plotted y sits exactly on a whole count
  const zero = num(q('#chart line.baseline'), 'y1');
  const top = Math.min(...qa('#chart text.y-label').map(t => num(t, 'y'))) - 3.5;
  const topVal = Math.max(...qa('#chart text.y-label').map(t => Number(t.textContent)));
  const line = q('#chart path.line[data-series="1"]');
  const nums = (line.getAttribute('d').match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const vals = nums.filter((_, i) => i % 2 === 1).map(py => ((zero - py) / (zero - top)) * topVal);
  check(vals.every(v => Math.abs(v - Math.round(v)) < 0.01),
    `every plotted point is an integer count, got [${vals.map(v => v.toFixed(2))}]`);
  check(vals.reduce((a, v) => a + Math.round(v), 0) === 2,
    `blue's points sum to its 2 clicks, got ${vals.reduce((a, v) => a + Math.round(v), 0)}`);
}
{ // rail rows read Red, Yellow, Blue top to bottom — blue sits at the bottom
  const rows = qa('#chart text.lane-label')
    .sort((a, b) => num(a, 'y') - num(b, 'y')).map(t => t.textContent).join(',');
  check(rows === 'Red,Yellow,Blue', 'rail rows top-to-bottom should be Red,Yellow,Blue — got ' + rows);
  const railY = Object.fromEntries(qa('#chart text.lane-label').map(t => [t.textContent, num(t, 'y')]));
  const tickMid = t => num(t, 'y') + num(t, 'height') / 2;
  const t1 = qa('#chart rect.rail-tick').find(t => t.getAttribute('fill') === 'var(--series-1)');
  check(Math.abs(tickMid(t1) - (railY['Blue'] - 4)) < 0.01, 'ticks centre on their row');
  // the whole rail sits below the plot's zero line
  const zero = num(q('#chart line.baseline'), 'y1');
  check(Math.min(...qa('#chart rect.rail-tick').map(t => num(t, 'y'))) > zero,
    'the event rail sits under the plot');
}
check($('last-line').textContent.includes('Today: 4 clicks'), 'last-line total: ' + $('last-line').textContent);
check($('chart-sub').textContent.includes('4 clicks · last 7 days'), `subtitle: "${$('chart-sub').textContent}"`);
check(/peak \d+\/day$/.test($('chart-sub').textContent.trim()),
  `subtitle peak is a whole number per period: "${$('chart-sub').textContent}"`);

// --- persistence
const stored = JSON.parse(window.localStorage.getItem('click-timeline/v1'));
check(stored.length === 4, 'persisted 4 clicks');
check(stored.every((c, i, a) => i === 0 || a[i - 1].t <= c.t), 'stored sorted ascending');

// --- hover: crosshair, halo, and a tooltip carrying the running totals
const t0tick = qa('#chart rect.rail-tick')[0];
$('chart').dispatchEvent(new window.MouseEvent('pointermove', {
  bubbles: true, clientX: num(t0tick, 'x'), clientY: num(t0tick, 'y'),
}));
check($('tooltip').hidden === false, 'tooltip shows on hover near a click');
check(qa('#chart rect.band').length === 1, 'the period being read is banded across the plot');
check(qa('#chart circle.read-dot').length === 3, 'the crosshair reads all three curves');
check(qa('#chart circle.read-dot.is-active').length === 1, 'the tapped colour is emphasised');
{ // every tap the banded period counts is highlighted — no more, no less
  const lit = qa('#chart rect.rail-tick.is-active').length;
  const total = Number(($('tooltip').textContent.match(/(\d+) clicks?/) || [])[1]);
  check(lit === total, `highlighted ticks match the period total (${lit} vs ${total})`);
}
check(qa('#tooltip .tt-row').length === 3, `tooltip lists all three buttons, got ${qa('#tooltip .tt-row').length}`);
check(qa('#tooltip .tt-row.is-strong').length === 1, 'the hovered button’s row is emphasised');
check(/Red|Yellow|Blue/.test($('tooltip').textContent), 'tooltip names the colours in words');
check(/\d+ clicks?/.test($('tooltip').textContent),
  `tooltip totals the period: "${$('tooltip').textContent}"`);

// hovering the rail row works as well as hovering the curve
{
  const t1 = qa('#chart rect.rail-tick').find(t => t.getAttribute('fill') === 'var(--series-2)');
  $('chart').dispatchEvent(new window.MouseEvent('pointermove', {
    bubbles: true, clientX: num(t1, 'x') + 1.5, clientY: num(t1, 'y') + num(t1, 'height') / 2,
  }));
  check(q('#tooltip .tt-row.is-strong').textContent.includes('Yellow'),
    `rail hover picks a yellow tap: "${q('#tooltip .tt-row.is-strong').textContent}"`);
}
$('chart').dispatchEvent(new window.MouseEvent('pointerleave', { bubbles: true }));
check($('tooltip').hidden === true, 'an un-pinned hover clears on leave');

/* --- a tap pins the reading: on touch, pointerleave fires the instant the
   finger lifts, so without this the tooltip would never be readable. */
{
  const tick = qa('#chart rect.rail-tick')[1];
  const at = (type, node) => $('chart').dispatchEvent(new window.MouseEvent(type, {
    bubbles: true, clientX: num(node, 'x'), clientY: num(node, 'y'),
  }));
  at('pointerdown', tick);
  check($('tooltip').hidden === false, 'tapping the chart shows the reading');
  const pinnedText = $('tooltip').textContent;

  $('chart').dispatchEvent(new window.MouseEvent('pointerleave', { bubbles: true }));
  check($('tooltip').hidden === false, 'a pinned reading survives pointerleave');

  at('pointermove', qa('#chart rect.rail-tick')[3]);
  check($('tooltip').textContent === pinnedText, 'and hover does not drag it elsewhere');
  check(qa('#chart rect.band').length === 1, 'the banded period stays put too');

  // tapping a different spot on the chart re-pins rather than dismissing
  at('pointerdown', qa('#chart rect.rail-tick')[3]);
  check($('tooltip').hidden === false, 'tapping elsewhere on the chart re-pins');

  /* Tapping a mark, not blank chart. render() rebuilds the whole SVG, so the
     node that was tapped is detached mid-dispatch — anything that then asks
     "was the target inside the chart?" gets the wrong answer. */
  const onMark = (sel, xa, ya) => {
    at('pointerdown', qa('#chart rect.rail-tick')[1]);          // start from a pinned state
    const node = q(sel);
    if (!node) return `no ${sel} to tap`;
    node.dispatchEvent(new window.MouseEvent('pointerdown', {
      bubbles: true, clientX: num(node, xa), clientY: num(node, ya),
    }));
    return $('tooltip').hidden ? 'dismissed' : 'pinned';
  };
  check(onMark('#chart rect.rail-tick', 'x', 'y') === 'pinned',
    'tapping a rail tick itself pins, same as tapping blank chart');
  check(onMark('#chart circle.read-dot', 'cx', 'cy') === 'pinned',
    'tapping a plotted dot pins too');
  check(onMark('#chart circle.bin-dot', 'cx', 'cy') === 'pinned',
    'tapping a period dot pins too');

  // ...and a tap outside dismisses it
  window.document.body.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
  check($('tooltip').hidden === true, 'tapping outside the chart dismisses it');
  check(qa('#chart rect.band').length === 0, 'the band goes with it');

  // Escape also releases it
  at('pointerdown', tick);
  check($('tooltip').hidden === false, 'pinned again');
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check($('tooltip').hidden === true, 'Escape releases a pinned reading');
}

// --- range filter: every range draws the same kind of picture
for (const r of ['7', '30', 'all', 'today']) {
  q(`.chip[data-range="${r}"]`).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check(q('.chip.is-selected').dataset.range === r, `chip ${r} selected`);
  check(qa('#chart path.line').length === 3, `range ${r} draws curves, got ${qa('#chart path.line').length}`);
  check(qa('#chart rect.rail-tick').length === 4, `range ${r} keeps every click on the rail`);
  check(q(`.chip[data-range="${r}"]`).getAttribute('aria-pressed') === 'true', `aria-pressed on ${r}`);
}
check(qa('.chip[aria-pressed="true"]').length === 1, 'exactly one chip pressed');

// --- keyboard
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: '2', bubbles: true }));
check($('count-2').textContent === '2', `keyboard "2" records, got ${$('count-2').textContent}`);
check(qa('#chart rect.rail-tick').length === 5, `the new click lands on the rail, got ${qa('#chart rect.rail-tick').length}`);

// --- undo drops the newest click and re-enables/disables itself
{
  const before = qa('#chart rect.rail-tick').length;
  check($('undo').disabled === false, 'undo is live once there are clicks');
  $('undo').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check(qa('#chart rect.rail-tick').length === before - 1,
    `undo removes one tap, ${before} -> ${qa('#chart rect.rail-tick').length}`);
  check(/^Removed (blue|yellow|red) at /.test($('toast').textContent),
    `undo names the colour it dropped: "${$('toast').textContent}"`);
  q('.tap[data-btn="2"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));   // put it back
}

// --- arrow keys move between tabs
q('#tab-data').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
check($('panel-tap').hidden === false, 'ArrowLeft returns to the tap screen');
tap(3);
check($('count-3').textContent !== '0', 'recording still works after tab switches');
goto('tab-data');
check(qa('#chart rect.rail-tick').length === 6, `6 rail ticks after coming back, got ${qa('#chart rect.rail-tick').length}`);
check(qa('#chart path.line').length === 3, 'all three curves redrawn');

// --- theme cycle
const html = window.document.documentElement;
check(html.getAttribute('data-theme') === null, 'starts on auto');
for (const [i, want] of [['light'], ['dark'], [null]].entries()) {
  $('theme-toggle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check(html.getAttribute('data-theme') === want[0], `theme step ${i + 1} -> ${want[0]}, got ${html.getAttribute('data-theme')}`);
}

// --- export hands over exactly what is stored
{
  let downloaded = null;
  const realCreate = window.document.createElement.bind(window.document);
  window.URL.createObjectURL = () => 'blob:stub';
  window.URL.revokeObjectURL = () => {};
  window.document.createElement = name => {
    const node = realCreate(name);
    if (name === 'a') node.click = () => { downloaded = node.download; };
    return node;
  };
  $('export').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  window.document.createElement = realCreate;
  check(/^clicks-[\d-]+\.json$/.test(downloaded || ''), `export names a dated file, got "${downloaded}"`);
}

// --- reload keeps data
check(JSON.parse(window.localStorage.getItem('click-timeline/v1')).length === 6, 'all 6 clicks persisted');

// --- storage durability request must be guarded (jsdom has no navigator.storage)
check(errors.filter(e => /storage/i.test(e)).length === 0, 'no storage-related errors');


/* --- THE POINT OF THE CHART: a rate falls as well as rises.
   Two bursts a few days apart must produce a curve that climbs, comes back
   down between them, and climbs again — a running total never could. */
{
  const DAY = 86400000, now = Date.now();
  const rows = [];
  let k = 0;
  for (const d of [5, 5, 5, 5, 5, 5, 2, 2, 2, 2]) {
    rows.push({ id: `seed-${k}`, t: now - d * DAY + (k++) * 60000, b: 1 });
  }
  const w2 = boot(rows);
  const q2 = sel => w2.document.querySelector(sel);
  const fire = sel => q2(sel).dispatchEvent(new w2.MouseEvent('click', { bubbles: true }));
  fire('#tab-data');
  fire('.chip[data-range="7"]');

  const line = q2('#chart path.line[data-series="1"]');
  check(!!line, 'seeded history draws a blue curve');
  const nums = ((line && line.getAttribute('d')) || '').match(/-?\d+(?:\.\d+)?/g) || [];
  const ys = nums.map(Number).filter((_, i) => i % 2 === 1);
  const rose = ys.some((v, i) => i > 0 && v < ys[i - 1] - 0.01);   // smaller y = higher count
  const fell = ys.some((v, i) => i > 0 && v > ys[i - 1] + 0.01);
  check(rose && fell, `a per-period count rises AND falls (rose=${rose} fell=${fell})`);
  check(q2('#chart path.line[data-series="2"]') === null, 'a colour with no taps in range gets no line');
  check(w2.document.querySelectorAll('#chart rect.rail-tick').length === 10, 'every seeded tap is on the rail');

  /* Tapping anywhere in the plot reads that period — no need to hit a mark.
     With taps spread over several days, exactly one day may light up. */
  const svg2 = w2.document.getElementById('chart');
  const plot = { left: 48, right: 640 - 14 };
  const tapAt = frac => svg2.dispatchEvent(new w2.MouseEvent('pointerdown', {
    bubbles: true, clientX: plot.left + (plot.right - plot.left) * frac, clientY: 60,
  }));
  const litOn = () => w2.document.querySelectorAll('#chart rect.rail-tick.is-active').length;
  const tip = () => w2.document.getElementById('tooltip');

  let anyQuiet = false, anyBusy = false;
  for (let i = 1; i <= 12; i++) {
    tapAt(i / 13);
    check(tip().hidden === false, `tapping at ${Math.round((i / 13) * 100)}% across the plot reads a period`);
    const total = Number((tip().textContent.match(/(\d+) clicks?/) || [])[1]);
    check(litOn() === total, `and lights exactly that period's taps (${litOn()} vs ${total})`);
    if (total === 0) anyQuiet = true; else anyBusy = true;
  }
  check(anyQuiet, 'a quiet period still answers, with zero');
  check(anyBusy, 'a busy period reports its count');
  check(litOn() <= 6, 'never lights the whole rail at once');
}


/* --- Import merges by whole day: a day in the file replaces that day here,
   and days the file is silent about are untouched. */
{
  const DAY = 86400000, now = Date.now();
  const day = n => { const d = new Date(now - n * DAY); d.setHours(12, 0, 0, 0); return d.getTime(); };
  const keyOf = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

  const seeded = [
    { id: 'a', t: day(5),          b: 1 },      // day 5: two blue, about to be replaced
    { id: 'b', t: day(5) + 60000,  b: 1 },
    { id: 'c', t: day(2),          b: 2 },      // day 2: the file says nothing — must survive
  ];
  const w3 = boot(seeded);
  check(JSON.parse(w3.localStorage.getItem('click-timeline/v1')).length === 3, 'seed loaded');

  const file = [
    { t: day(5) + 3600e3, b: 3 },               // day 5 replaced by one red
    { t: day(9),          b: 2 },               // day 9 is new
  ];
  const input = w3.document.getElementById('import-file');
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [new w3.File([JSON.stringify(file)], 'clicks.json', { type: 'application/json' })],
  });
  input.dispatchEvent(new w3.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 60));    // FileReader is async

  const after = JSON.parse(w3.localStorage.getItem('click-timeline/v1'));
  const on = n => after.filter(c => keyOf(c.t) === keyOf(day(n)));
  check(after.length === 3, `3 clicks after import, got ${after.length}: ${JSON.stringify(after)}`);
  check(on(5).length === 1 && on(5)[0].b === 3,
    `day 5 replaced wholesale by the file, got ${JSON.stringify(on(5))}`);
  check(on(2).length === 1 && on(2)[0].b === 2, 'a day absent from the file is left alone');
  check(on(9).length === 1 && on(9)[0].b === 2, 'a day only in the file is added');
  check(after.every((c, i, a) => i === 0 || a[i - 1].t <= c.t), 'still sorted after import');
  check(new Set(after.map(c => c.id)).size === 3, 'imported clicks get unique ids');
  check(/Imported 2 clicks across 2 days/.test(w3.document.getElementById('toast').textContent),
    `import reports what it did: "${w3.document.getElementById('toast').textContent}"`);

  // Replacing a day is not undoable, so declining the prompt must change nothing
  const w4 = boot(seeded);
  w4.confirm = () => false;
  const input4 = w4.document.getElementById('import-file');
  Object.defineProperty(input4, 'files', {
    configurable: true,
    value: [new w4.File([JSON.stringify(file)], 'clicks.json', { type: 'application/json' })],
  });
  input4.dispatchEvent(new w4.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 60));
  check(JSON.parse(w4.localStorage.getItem('click-timeline/v1')).length === 3,
    'declining the overwrite prompt leaves the log untouched');
}


/* --- The milestone nudge: configured links arm it, a real tap at a round
   hundred opens it, an import never does. */
{
  const live = html => html.replace(/REPLACE-WITH-PAYPAL-USERNAME/g, 'someone');
  const at = n => Array.from({ length: n },
    (_, i) => ({ id: `s${i}`, t: Date.now() - (n - i) * 60000, b: 1 + (i % 3) }));
  const tapOn = w => w.document.querySelector('.tap[data-btn="1"]')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const fire = (w, id) => w.document.getElementById(id)
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

  { // unconfigured links keep the whole feature switched off
    const w = boot(at(99));
    tapOn(w);
    check(w.document.getElementById('nudge').open !== true,
      'placeholder donate links mean the popup never shows');
  }

  const w = boot(at(99), null, live);
  const dlg = () => w.document.getElementById('nudge');
  check(dlg().open !== true, 'closed before the hundredth click');
  tapOn(w);
  check(dlg().open === true, 'the hundredth click opens the nudge');
  check(w.document.getElementById('nudge-title').textContent === '100 clicks. So much data.',
    `titled with the count, got "${w.document.getElementById('nudge-title').textContent}"`);
  check(w.document.getElementById('nudge-later').textContent === 'Nudge me at 200',
    `later names the next milestone, got "${w.document.getElementById('nudge-later').textContent}"`);
  check(w.document.querySelectorAll('.nudge-dot').length === 3, 'three amounts, on three dots');
  check([...w.document.querySelectorAll('.nudge-dot')].every(a => a.rel.includes('noopener')),
    'donate links hand the payment page no window reference');

  fire(w, 'nudge-later');
  check(dlg().open !== true, 'later closes it');
  check(w.localStorage.getItem('click-timeline/nudge-next') === '200', 'later stores the next milestone');
  tapOn(w);
  check(dlg().open !== true, 'and it stays shut on click 101');

  { // an import that vaults past a milestone must not ambush anyone
    const w2 = boot(at(99), null, live);
    const input = w2.document.getElementById('import-file');
    const rows = at(400).map(c => ({ t: c.t, b: c.b }));
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new w2.File([JSON.stringify(rows)], 'c.json', { type: 'application/json' })],
    });
    input.dispatchEvent(new w2.Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 60));
    check(w2.document.getElementById('nudge').open !== true,
      'importing past a milestone does not open the nudge');
  }

  { // never is permanent, and tapping an amount counts as never
    const w3 = boot(at(99), null, live);
    tapOn(w3);
    fire(w3, 'nudge-never');
    check(w3.localStorage.getItem('click-timeline/nudge-off') === '1', 'never is recorded');
    check(boot(at(199), { 'click-timeline/nudge-off': '1' }, live)
      .document.getElementById('nudge').open !== true, 'and survives a reload');

    const w4 = boot(at(99), null, live);
    tapOn(w4);
    w4.document.querySelector('.nudge-dot')
      .dispatchEvent(new w4.MouseEvent('click', { bubbles: true }));
    check(w4.localStorage.getItem('click-timeline/nudge-off') === '1',
      'tapping an amount also stops the asking');
  }
}

console.log(errors.length ? errors.join('\n') : '✓ all smoke checks passed');
process.exit(errors.length ? 1 : 0);
