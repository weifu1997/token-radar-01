// Token Launch Radar — the board page. Reads window.RADAR (written by main.ts
// into ../data.js from the same model that wrote board.json), renders the
// ranked board, and wires the search, filters, sorting and the per-protocol
// detail view with its farm plan. No network, no framework.

'use strict';

const R = window.RADAR;
const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function money(v) {
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
  return '$' + v;
}

function pct(v) {
  if (v === null || v === undefined) return '<span class="flat">—</span>';
  const cls = v > 0.05 ? 'up' : v < -0.05 ? 'down' : 'flat';
  return `<span class="${cls}">${v > 0 ? '+' : ''}${v.toFixed(1)}%</span>`;
}

function ageText(days) {
  if (days === null) return '—';
  if (days < 90) return days + 'd';
  if (days < 730) return Math.round(days / 30.4) + ' mo';
  return (days / 365).toFixed(1) + ' yrs';
}

// ---- header and stats -------------------------------------------------------

$('stamp').innerHTML =
  `<b>Snapshot ${esc(R.as_of)}</b>${esc(R.source.replace(/^DefiLlama /, ''))}<br>Model ${esc(R.model_version)}`;

const S = R.stats;
$('stats').innerHTML = [
  [S.scanned, 'protocols scanned'],
  [S.candidates, 'pre-token candidates'],
  [S.watchlist + ' / ' + S.watchlist, 'watchlist covered'],
  [S.board_rows, 'rows on the board'],
  [money(S.total_implied_usd), 'total implied value'],
  ['×' + S.global_multiple.toFixed(2), 'median live multiple'],
]
  .map(([v, k]) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`)
  .join('');

// ---- filters ----------------------------------------------------------------

const state = { q: '', cat: '', chain: '', mintvl: 0, watch: false, sort: 'implied' };

const cats = [...new Set(R.rows.map((r) => r.category).filter(Boolean))].sort();
$('cat').innerHTML = '<option value="">All categories</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join('');

const chains = [...new Set(R.rows.flatMap((r) => r.chains))].sort();
$('chain').innerHTML = '<option value="">All chains</option>' + chains.map((c) => `<option>${esc(c)}</option>`).join('');

function visible() {
  const q = state.q.trim().toLowerCase();
  let out = R.rows.filter((r) => {
    if (q && !(r.name.toLowerCase().includes(q) || r.slug.includes(q))) return false;
    if (state.cat && r.category !== state.cat) return false;
    if (state.chain && !r.chains.includes(state.chain)) return false;
    if (state.watch && !r.on_watchlist) return false;
    if (r.tvl_usd < state.mintvl) return false;
    return true;
  });
  const key = {
    implied: (r) => r.implied_usd,
    tvl: (r) => r.tvl_usd,
    change: (r) => (r.change_7d === null ? -Infinity : r.change_7d),
    age: (r) => (r.age_days === null ? -1 : r.age_days),
    multiple: (r) => r.multiple,
  }[state.sort];
  out = [...out].sort((a, b) => key(b) - key(a) || a.rank - b.rank);
  return out;
}

function render() {
  const rows = visible();
  $('count').textContent = rows.length + ' of ' + R.rows.length + ' protocols';
  $('empty').hidden = rows.length > 0;
  $('rows').innerHTML = rows
    .map(
      (r) => `<tr data-slug="${esc(r.slug)}">
        <td class="num rank">${r.rank}</td>
        <td><span class="pname">${esc(r.name)}</span>${r.on_watchlist ? '<span class="wflag">watchlist</span>' : ''}<span class="cat">${esc(r.category ?? 'Uncategorised')}</span></td>
        <td class="chains">${esc(r.chains.slice(0, 3).join(', '))}${r.chains.length > 3 ? ' +' + (r.chains.length - 3) : ''}</td>
        <td class="num">${money(r.tvl_usd)}</td>
        <td class="num">${pct(r.change_7d)}</td>
        <td class="num">${ageText(r.age_days)}</td>
        <td class="num">×${r.multiple.toFixed(2)}</td>
        <td class="num"><span class="implied">${money(r.implied_usd)}</span><span class="band">${money(r.implied_low_usd)} – ${money(r.implied_high_usd)}</span></td>
        <td class="capital">${esc(r.capital)}</td>
        <td><button class="plan-btn" data-plan="${esc(r.slug)}">Farm plan</button></td>
      </tr>`,
    )
    .join('');
}

for (const [id, apply] of [
  ['q', (el) => (state.q = el.value)],
  ['cat', (el) => (state.cat = el.value)],
  ['chain', (el) => (state.chain = el.value)],
  ['mintvl', (el) => (state.mintvl = Number(el.value))],
  ['sort', (el) => (state.sort = el.value)],
  ['watch', (el) => (state.watch = el.checked)],
]) {
  $(id).addEventListener('input', (e) => {
    apply(e.target);
    render();
  });
}

// ---- detail view --------------------------------------------------------------

function openDetail(slug) {
  const r = R.rows.find((x) => x.slug === slug);
  if (!r) return;
  const factor = (k, v) => `<div class="factor"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  $('detail').innerHTML = `<div class="detail-in">
    <button class="close-btn" id="close-detail">Close</button>
    <h2>#${r.rank} ${esc(r.name)}${r.on_watchlist ? '<span class="wflag">watchlist</span>' : ''}</h2>
    <p class="sub">${esc(r.category ?? 'Uncategorised')} · tracked since ${esc(r.listed_at ?? 'an unreported date')} · ${esc(r.chains.join(', ') || 'no chains listed')} · records no token in DefiLlama's snapshot of ${esc(R.as_of)}</p>
    <div class="factors">
      ${factor('TVL', money(r.tvl_usd))}
      ${factor('Category multiple', '×' + r.multiple.toFixed(2))}
      ${factor('7d momentum', '×' + r.growth_mult.toFixed(2) + (r.change_7d === null ? '' : ` (${r.change_7d > 0 ? '+' : ''}${r.change_7d.toFixed(1)}%)`))}
      ${factor('Maturity', '×' + r.maturity_mult.toFixed(2))}
      ${factor('Chain breadth', '×' + r.breadth_mult.toFixed(2))}
      ${factor('Implied value', money(r.implied_usd))}
      ${factor('Working capital', r.capital)}
      ${factor('Plan length', r.weeks)}
    </div>
    <h3>The farm plan</h3>
    <ol class="steps">${r.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
  </div>`;
  $('detail').hidden = false;
  $('close-detail').addEventListener('click', () => {
    $('detail').hidden = true;
  });
  $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('rows').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-slug]');
  if (tr) openDetail(tr.dataset.slug);
});

// ---- method -------------------------------------------------------------------

$('method-text').textContent =
  `Every protocol whose token already trades in the snapshot is a comparable: its market cap divided by its TVL, ` +
  `medianed per category and shrunk toward the global median of ×${S.global_multiple.toFixed(2)} where a category has few tokens to go on. ` +
  `A pre-token protocol is priced at its TVL times its category's multiple, adjusted for seven-day momentum (a hot week is worth up to about ×1.5, a cold one down to ×0.73), ` +
  `for maturity (a protocol that has run for years without a token is a more proven launch than a new one), and for chain breadth. ` +
  `The board excludes exchanges, wrapped and staked products of tokens that already trade, and versioned re-releases — the same reading the snapshot's own watchlist uses, without its $50M floor.`;

$('calibration').innerHTML =
  '<tr><th>Category</th><th class="num">Live tokens</th><th class="num">Multiple</th></tr>' +
  R.calibration
    .slice(0, 12)
    .map((c) => `<tr><td>${esc(c.category)}</td><td class="num">${c.comparables}</td><td class="num">×${c.multiple.toFixed(2)}</td></tr>`)
    .join('');

$('live').innerHTML =
  '<tr><th>Protocol</th><th class="num">Market cap</th><th class="num">Multiple</th></tr>' +
  R.live
    .slice(0, 8)
    .map((l) => `<tr><td>${esc(l.name)}${l.symbol ? ' · ' + esc(l.symbol) : ''}</td><td class="num">${money(l.mcap_usd)}</td><td class="num">×${l.multiple.toFixed(2)}</td></tr>`)
    .join('');

// ---- deep links: #p=<slug> opens a detail, #cat=<category> filters ------------

const hash = new URLSearchParams(location.hash.slice(1));
if (hash.get('cat')) {
  state.cat = hash.get('cat');
  $('cat').value = state.cat;
}
if (hash.get('watch') === '1') {
  state.watch = true;
  $('watch').checked = true;
}
render();
if (hash.get('p')) openDetail(hash.get('p'));
