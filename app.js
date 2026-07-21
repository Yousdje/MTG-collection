'use strict';

import { SITES, setApiBase, listDecks, getDeck } from './src/sources.js';
import { assess, BRACKET_NAMES, loadReference } from './src/brackets.js';
import { composition, collection } from './src/stats.js';

const view = document.getElementById('view');
const nav = document.getElementById('nav');
const whoEl = document.getElementById('who');
const charts = [];

setApiBase(window.MTG_CONFIG?.API_BASE);

/* ------------------------------------------------------------------ Theme */

const cvt = document.createElement('canvas').getContext('2d');

function toHex(color) {
  cvt.fillStyle = '#000';
  cvt.fillStyle = color;
  return cvt.fillStyle;
}
const token = (name) => toHex(getComputedStyle(document.documentElement).getPropertyValue(name).trim());

let COLOR = {};
let TYPE_COLOR = {};
let ACCENT = '#d4a24c';

function loadPalette() {
  COLOR = {
    W: token('--w'), U: token('--u'), B: token('--b'),
    R: token('--r'), G: token('--g'), C: token('--c'),
  };
  ACCENT = token('--accent');
  TYPE_COLOR = {
    Creature: COLOR.G, Instant: COLOR.U, Sorcery: token('--tier-5'), Artifact: COLOR.C,
    Enchantment: COLOR.W, Planeswalker: COLOR.R, Land: token('--accent-deep'),
    Battle: ACCENT, Other: token('--faint'),
  };
  Chart.defaults.color = token('--chart-label');
  Chart.defaults.borderColor = token('--chart-grid');
  Chart.defaults.font.family = 'Inter, ui-sans-serif, system-ui, sans-serif';
}

function destroyCharts() { while (charts.length) charts.pop().destroy(); }
function mkChart(canvas, config) {
  const c = new Chart(canvas, config);
  charts.push(c);
  return c;
}

/* ----------------------------------------------------------------- Format */

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let currency = (() => {
  try { return localStorage.getItem('mtg-currency') || 'EUR'; } catch { return 'EUR'; }
})();

const money = (card) => (currency === 'EUR' ? card.eur : card.usd) || 0;
function fmt(n) {
  const v = Number(n || 0);
  return currency === 'EUR'
    ? '€' + v.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const deckValue = (d) => (currency === 'EUR' ? d.eur : d.usd) || 0;

function pips(colors) {
  if (!colors || !colors.length) return '<span class="pip C"></span>';
  return colors.map((c) => `<span class="pip ${esc(c)}"></span>`).join('');
}
function deckGradient(colors) {
  const list = (colors && colors.length ? colors : ['C']).map((c) => `var(--${String(c).toLowerCase()})`);
  return list.length > 1 ? `linear-gradient(90deg, ${list.join(', ')})` : list[0];
}

function bracketBadge(a, big) {
  if (!a) return '';
  if (a.unavailable) return `<span class="bracket b3${big ? ' big' : ''}">B?</span>`;
  const label = a.uncertain ? `${a.bracket}–${a.bracket_high}` : String(a.bracket);
  const name = a.uncertain ? '' : ' ' + BRACKET_NAMES[a.bracket];
  return `<span class="bracket b${a.bracket_high}${big ? ' big' : ''}">B${label}${esc(name)}</span>`;
}

function barList(obj) {
  const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  const top = Math.max(1, ...entries.map((e) => e[1]));
  return entries.map(([k, v]) => `
    <div class="bar-row">
      <div>${esc(k)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${((v / top) * 100).toFixed(1)}%"></div></div>
      <div class="n">${v}</div>
    </div>`).join('');
}

/* ------------------------------------------------------------------ State */

const state = {
  site: null,
  user: null,
  summaries: [],      // cheap deck list, available immediately
  decks: new Map(),   // id -> fully loaded deck
  failed: new Map(),  // id -> error message
  loading: false,
  loadAll: false,     // set once the user opts into the full set
  ref: null,
};

const loadedDecks = () => state.summaries.map((s) => state.decks.get(s.id)).filter(Boolean);

/**
 * How many decks to pull automatically. Deck contents are one request each, and
 * plenty of accounts have hundreds of decks — firing all of them would be slow
 * for the user and rude to the deck site. The newest decks load on sight and
 * the rest are opt-in.
 */
const AUTOLOAD = 24;

/** Fetch deck contents a few at a time, calling onProgress as each lands. */
async function loadAllDecks(onProgress) {
  let pending = state.summaries.filter((s) => !state.decks.has(s.id) && !state.failed.has(s.id));
  if (!state.loadAll) pending = pending.slice(0, Math.max(0, AUTOLOAD - state.decks.size));
  if (!pending.length) return;

  state.loading = true;
  let done = 0;
  const queue = [...pending];
  const CONCURRENCY = 3;

  const worker = async () => {
    while (queue.length) {
      const summary = queue.shift();
      try {
        const deck = await getDeck(state.site, summary.id);
        deck.assessed = assess(deck.cards, state.ref);
        state.decks.set(summary.id, deck);
      } catch (err) {
        state.failed.set(summary.id, err.message);
      }
      done += 1;
      onProgress?.(done, pending.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  state.loading = false;
}

/* --------------------------------------------------------------- Landing */

function renderLanding() {
  nav.hidden = true;
  whoEl.hidden = true;

  let site = 'moxfield';
  view.innerHTML = `
    <div class="landing">
      <div class="mark"></div>
      <h2>Deck stats for any collection</h2>
      <p class="lede">Enter a username and get deck values, mana curves, card roles,
        collection overlap — and a Commander bracket assessment computed from the
        actual cards, not from what the author typed in.</p>

      <div class="sitepick">
        ${Object.entries(SITES).map(([key, s]) => `
          <button type="button" data-site="${key}" aria-pressed="${key === site}">
            ${esc(s.label)}<span class="sub">${key === 'archidekt' ? 'most reliable' : 'largest site'}</span>
          </button>`).join('')}
      </div>

      <form class="lookup" id="lookupForm">
        <input type="text" id="username" autocomplete="off" spellcheck="false"
               placeholder="${esc(SITES[site].placeholder)}" aria-label="Username">
        <button type="submit">Look up</button>
      </form>
      <div class="sitenote" id="sitenote">${esc(SITES[site].note || '')}</div>

      <div class="examples">Try
        <button type="button" data-try="archidekt/tolariancommunitycollege">tolariancommunitycollege</button>
        on Archidekt.
      </div>

      <div class="feats">
        <div><b>Bracket engine</b>Game Changers, two-card infinites and mass land denial,
          against the current official criteria — tutors correctly ignored.</div>
        <div><b>Collection overlap</b>Which cards you already own across decks, and what
          buying one copy of each would actually cost.</div>
        <div><b>Roles</b>Ramp, removal, draw and 15 more, derived from oracle text.</div>
      </div>
    </div>`;

  const input = document.getElementById('username');
  const note = document.getElementById('sitenote');

  view.querySelectorAll('.sitepick button').forEach((btn) => {
    btn.onclick = () => {
      site = btn.dataset.site;
      view.querySelectorAll('.sitepick button').forEach((b) =>
        b.setAttribute('aria-pressed', String(b === btn)));
      input.placeholder = SITES[site].placeholder;
      note.textContent = SITES[site].note || '';
      input.focus();
    };
  });

  view.querySelector('[data-try]').onclick = (e) => {
    location.hash = '#/' + e.target.dataset.try;
  };

  document.getElementById('lookupForm').onsubmit = (e) => {
    e.preventDefault();
    const user = input.value.trim();
    if (user) location.hash = `#/${site}/${encodeURIComponent(user)}`;
  };

  input.focus();
}

/* -------------------------------------------------------------- Overview */

function kpiRow() {
  const decks = loadedDecks();
  const col = decks.length ? collection(decks) : null;
  const total = decks.reduce((n, d) => n + deckValue(d), 0);
  const uniqueVal = col ? (currency === 'EUR' ? col.unique_eur : col.unique_usd) : 0;

  return `
    <div class="kpis">
      <div class="kpi"><div class="label">Decks</div><div class="value">${state.summaries.length}</div>
        <div class="sub">public on ${esc(SITES[state.site].label)}</div></div>
      <div class="kpi"><div class="label">Combined value</div><div class="value">${fmt(total)}</div>
        <div class="sub">${decks.length} of ${state.summaries.length} loaded</div></div>
      <div class="kpi"><div class="label">Cost to own</div><div class="value">${fmt(uniqueVal)}</div>
        <div class="sub">one copy of each card</div></div>
      <div class="kpi"><div class="label">Unique cards</div><div class="value">${col?.unique_cards ?? '–'}</div>
        <div class="sub">${col?.shared ?? 0} used in 2+ decks</div></div>
      <div class="kpi"><div class="label">Cards total</div><div class="value">${col?.total_cards ?? '–'}</div>
        <div class="sub">slots across all decks</div></div>
    </div>`;
}

function deckCard(summary) {
  const deck = state.decks.get(summary.id);
  const failed = state.failed.get(summary.id);
  const colors = deck?.colors?.length ? deck.colors : summary.colors;
  const cards = deck?.cards_total ?? summary.cards_total;

  const value = deck
    ? `<span class="val">${fmt(deckValue(deck))}</span>`
    : `<span class="val muted">${failed ? '—' : '···'}</span>`;

  const comp = deck ? composition(deck) : null;

  return `
    <div class="deck" data-id="${esc(summary.id)}" style="--deck-grad:${deckGradient(colors)}">
      <div class="name">${esc(summary.name)}</div>
      <div class="cmdr">${esc(deck?.commanders?.join(' // ') || summary.format || '')}</div>
      <div class="row money"><span class="pips">${pips(colors)}</span>${value}</div>
      <div class="row">
        <span>${deck ? bracketBadge(deck.assessed) : ''}</span>
        <span>${failed ? '<span class="pill">unavailable</span>' : ''}</span>
      </div>
      <div class="row meta">
        <span>${cards ?? '–'} cards${comp ? ` · avg CMC ${comp.avg_cmc}` : ''}</span>
      </div>
      <div class="row">
        <span>updated ${esc(summary.updated || '–')}</span>
        <span>${summary.views} views</span>
      </div>
    </div>`;
}

/** How many decks this pass is actually going to fetch. */
function loadTarget() {
  return state.loadAll ? state.summaries.length : Math.min(AUTOLOAD, state.summaries.length);
}

function progressHtml() {
  const done = state.decks.size + state.failed.size;
  const total = loadTarget();
  const pct = total ? Math.round((done / total) * 100) : 100;
  return `
    <div class="progress" id="progress">
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="txt">Loading decks — ${done} of ${total}. Values and brackets fill in as they arrive.</div>
    </div>`;
}

/** Offer the rest only when there is a rest, and say what it will cost. */
function loadMoreHtml() {
  const remaining = state.summaries.length - state.decks.size - state.failed.size;
  if (state.loading || state.loadAll || remaining <= 0) return '';
  return `
    <div class="panel loadmore">
      <div>
        <b>${state.decks.size} of ${state.summaries.length} decks loaded.</b>
        Totals, collection overlap and top cards below cover only the loaded decks.
      </div>
      <button class="ghost" id="loadAll" type="button">Load remaining ${remaining}</button>
    </div>`;
}

function wireLoadMore(rerender) {
  const btn = document.getElementById('loadAll');
  if (!btn) return;
  btn.onclick = async () => {
    state.loadAll = true;
    btn.disabled = true;
    btn.textContent = 'Loading…';
    await loadAllDecks(() => rerender());
    rerender();
  };
}

async function renderOverview() {
  const draw = () => {
    view.innerHTML = `
      ${state.loading ? progressHtml() : ''}
      ${kpiRow()}
      ${loadMoreHtml()}
      ${loadedDecks().length > 1 ? `
        <div class="panel">
          <h3>Deck value spread${loadedDecks().length > 15 ? ' — 15 most valuable' : ''}</h3>
          <div class="chartbox"><canvas id="spread"></canvas></div>
        </div>` : ''}
      <h2>Decks</h2>
      <div class="decks">${state.summaries.map(deckCard).join('')}</div>`;

    view.querySelectorAll('.deck').forEach((el) => {
      el.onclick = () => { location.hash = route(`deck/${el.dataset.id}`); };
    });
    wireLoadMore(draw);

    const canvas = document.getElementById('spread');
    if (canvas) {
      // Beyond ~15 bars the labels turn into an unreadable smear.
      const decks = [...loadedDecks()].sort((a, b) => deckValue(b) - deckValue(a)).slice(0, 15);
      destroyCharts();
      mkChart(canvas, {
        type: 'bar',
        data: {
          labels: decks.map((d) => d.name),
          datasets: [{
            data: decks.map((d) => deckValue(d)),
            backgroundColor: decks.map((d) => (d.colors.length === 1 ? COLOR[d.colors[0]] : ACCENT)),
            borderRadius: 3,
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: (c) => fmt(c.parsed.y) } },
          },
          scales: {
            y: { ticks: { callback: (v) => fmt(v).replace(/[.,]\d\d$/, '') } },
            x: { ticks: { maxRotation: 40, minRotation: 0, autoSkip: false, font: { size: 10 } } },
          },
        },
      });
    }
  };

  draw();
  await loadAllDecks(() => draw());
  draw();
}

/* ----------------------------------------------------------- Deck detail */

function deckDetail(id) {
  const deck = state.decks.get(id);
  const summary = state.summaries.find((s) => s.id === id);
  if (!deck) {
    const err = state.failed.get(id);
    view.innerHTML = `<a class="back" href="${route('')}">← All decks</a>
      <div class="error"><b>Could not load this deck</b>${esc(err || 'Still loading — try again in a moment.')}</div>`;
    return;
  }

  const comp = composition(deck);
  const a = deck.assessed;

  view.innerHTML = `
    <a class="back" href="${route('')}">← All decks</a>
    <div class="deckhdr">
      <h2>${esc(deck.name)}</h2>
      <span class="pips">${pips(deck.colors)}</span>
      <span class="muted">${esc(deck.commanders.join(' // '))}</span>
      <a class="ext right" href="${esc(deck.url)}" target="_blank" rel="noopener">
        Open on ${esc(SITES[deck.site].label)} ↗</a>
    </div>

    <div class="kpis">
      <div class="kpi"><div class="label">Deck value</div><div class="value">${fmt(deckValue(deck))}</div>
        <div class="sub">${currency === 'EUR' ? 'Cardmarket' : 'TCGplayer'}</div></div>
      <div class="kpi"><div class="label">Cards</div><div class="value">${comp.total_cards}</div>
        <div class="sub">${comp.lands} lands</div></div>
      <div class="kpi"><div class="label">Avg CMC</div><div class="value">${comp.avg_cmc}</div>
        <div class="sub">non-land</div></div>
      <div class="kpi"><div class="label">Bracket</div>
        <div class="value">${a?.unavailable ? '?' : a.uncertain ? `${a.bracket}–${a.bracket_high}` : a.bracket}</div>
        <div class="sub">computed${deck.siteBracket ? ` · site says ${esc(deck.siteBracket)}` : ''}</div></div>
      <div class="kpi"><div class="label">Updated</div><div class="value">${esc((summary?.updated || deck.updated || '–').slice(5))}</div>
        <div class="sub">${esc((summary?.updated || deck.updated || '').slice(0, 4))}</div></div>
    </div>

    ${bracketPanel(deck)}

    <div class="grid2">
      <div class="panel"><h3>Mana curve</h3><div class="chartbox"><canvas id="curve"></canvas></div></div>
      <div class="panel"><h3>Card types</h3><div class="chartbox"><canvas id="types"></canvas></div></div>
      <div class="panel"><h3>Colour pips</h3><div class="chartbox"><canvas id="pipsChart"></canvas></div></div>
      <div class="panel"><h3>What the deck does</h3><div class="bars">${barList(comp.tags)}</div></div>
    </div>

    <div class="panel">
      <h3>Cards — ${deck.cards.length} entries</h3>
      <div class="controls"><input type="search" id="cardFilter" placeholder="Filter cards, types or roles…"></div>
      <div class="scroll"><table id="cardTable">
        <thead><tr>
          <th data-k="name">Card</th><th data-k="qty" class="num">#</th><th data-k="cmc" class="num">CMC</th>
          <th data-k="type">Type</th><th data-k="tags">Roles</th>
          <th data-k="rarity">Rarity</th><th data-k="price" class="num">${currency}</th>
        </tr></thead><tbody></tbody>
      </table></div>
    </div>`;

  const rows = deck.cards.map((c) => ({ ...c, price: money(c) }));
  const tbody = document.querySelector('#cardTable tbody');
  const render = (list) => {
    tbody.innerHTML = list.map((c) => `
      <tr>
        <td>${esc(c.name)}</td>
        <td class="num">${c.qty}</td>
        <td class="num">${c.type === 'Land' ? '–' : c.cmc}</td>
        <td>${esc(c.type)}</td>
        <td>${c.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</td>
        <td class="muted">${esc(c.rarity)}</td>
        <td class="num">${fmt(c.price)}</td>
      </tr>`).join('');
  };
  render(rows);
  sortable('#cardTable', rows, render);
  document.getElementById('cardFilter').oninput = (e) => {
    const q = e.target.value.toLowerCase();
    render(rows.filter((c) => !q
      || c.name.toLowerCase().includes(q)
      || c.type_line.toLowerCase().includes(q)
      || c.tags.some((t) => t.toLowerCase().includes(q))));
  };

  destroyCharts();

  mkChart(document.getElementById('curve'), {
    type: 'bar',
    data: {
      labels: comp.curve.map((c) => c.cmc),
      datasets: [{ data: comp.curve.map((c) => c.count), backgroundColor: COLOR.U, borderRadius: 4 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });

  mkChart(document.getElementById('types'), {
    type: 'doughnut',
    data: {
      labels: Object.keys(comp.types),
      datasets: [{
        data: Object.values(comp.types),
        backgroundColor: Object.keys(comp.types).map((t) => TYPE_COLOR[t] || TYPE_COLOR.Other),
        borderColor: token('--card-solid'), borderWidth: 2,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'right', labels: { boxWidth: 12, padding: 8 } } },
    },
  });

  const pipKeys = Object.keys(comp.pips);
  mkChart(document.getElementById('pipsChart'), {
    type: 'bar',
    data: {
      labels: pipKeys,
      datasets: [{ data: pipKeys.map((k) => comp.pips[k]), backgroundColor: pipKeys.map((k) => COLOR[k]), borderRadius: 4 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });
}

function bracketPanel(deck) {
  const a = deck.assessed;
  if (!a) return '';
  if (a.unavailable) {
    return `<div class="panel"><h3>Bracket assessment</h3>
      <p class="muted" style="margin:0">Cannot assess: ${esc(a.unavailable)}</p></div>`;
  }

  const list = (title, items) => (items.length ? `
    <div><h4>${title}</h4><ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div>` : '');

  const combos = a.combos.length ? `
    <div style="grid-column:1/-1"><h4>Two-card infinite combos (${a.combos.length})</h4>
      ${a.combos.map((c) => `
        <div class="combo">
          <span class="pieces">${esc(c.cards.join('  +  '))}</span>
          <span class="bracket b${c.fast ? 4 : c.borderline ? 3 : 2}" style="margin-left:8px">${esc(c.tag_name)}</span>
          <div class="out">${esc(c.produces.join(', '))}</div>
        </div>`).join('')}
    </div>` : '';

  const siteSays = deck.siteBracket
    ? `<span class="right muted" style="font-size:13px">Author says: ${esc(deck.siteBracket)}</span>`
    : '';

  return `
    <div class="panel">
      <h3>Bracket assessment</h3>
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px">
        ${bracketBadge(a, true)}
        <span class="muted">${a.uncertain ? 'depends on how early the combos assemble' : esc(BRACKET_NAMES[a.bracket])}</span>
        ${siteSays}
      </div>
      <div class="reasons">
        ${a.reasons.map((r) => `
          <div class="reason l${r.level}"><span class="lvl">B${r.level}</span><span>${esc(r.text)}</span></div>`).join('')}
      </div>
      <div class="evidence">
        ${list(`Game Changers (${a.game_changers.length})`, a.game_changers.map((g) => g.name))}
        ${list(`Mass land denial (${a.mass_land_denial.length})`, a.mass_land_denial.map((m) => `${m.name} — ${m.why}`))}
        ${list(`Extra turns (${a.extra_turns.length})`, a.extra_turns.map((e) => e.name))}
        ${combos}
      </div>
      <div class="note">${esc(a.ceiling_note)} Tutors (${a.tutors}) are shown for context only —
        tutor limits were removed from the bracket rules in October 2025.</div>
    </div>`;
}

/* ------------------------------------------------------------- Collection */

async function renderCollection() {
  const draw = () => {
    const decks = loadedDecks();
    if (!decks.length) {
      view.innerHTML = state.loading
        ? progressHtml()
        : '<div class="empty">No decks could be loaded.</div>';
      return;
    }

    const col = collection(decks);
    const deckNames = [...new Set(col.cards.flatMap((c) => c.decks.map((d) => d.name)))].sort();
    const tags = Object.keys(col.tags).sort();
    const uniqueVal = currency === 'EUR' ? col.unique_eur : col.unique_usd;
    const totalVal = currency === 'EUR' ? col.total_eur : col.total_usd;

    view.innerHTML = `
      ${state.loading ? progressHtml() : ''}
      ${loadMoreHtml()}
      <div class="kpis">
        <div class="kpi"><div class="label">Unique cards</div><div class="value">${col.unique_cards}</div>
          <div class="sub">${col.total_cards} slots across all decks</div></div>
        <div class="kpi"><div class="label">Cost to own</div><div class="value">${fmt(uniqueVal)}</div>
          <div class="sub">one copy of each</div></div>
        <div class="kpi"><div class="label">Combined value</div><div class="value">${fmt(totalVal)}</div>
          <div class="sub">counting reuse</div></div>
        <div class="kpi"><div class="label">Shared cards</div><div class="value">${col.shared}</div>
          <div class="sub">saves ${fmt(totalVal - uniqueVal)} vs buying separately</div></div>
      </div>

      <div class="panel">
        <h3>Roles across the collection</h3>
        <div class="bars">${barList(col.tags)}</div>
      </div>

      <div class="panel">
        <h3>Every card</h3>
        <div class="controls">
          <input type="search" id="q" placeholder="Search cards…">
          <select id="deckSel"><option value="">All decks</option>${deckNames.map((d) => `<option>${esc(d)}</option>`).join('')}</select>
          <select id="tagSel"><option value="">All roles</option>${tags.map((t) => `<option>${esc(t)}</option>`).join('')}</select>
          <label class="muted"><input type="checkbox" id="sharedOnly"> shared only</label>
          <span class="right muted" id="count"></span>
        </div>
        <div class="scroll"><table id="colTable">
          <thead><tr>
            <th data-k="name">Card</th><th data-k="deck_count" class="num">Decks</th>
            <th>Used in</th><th data-k="type">Type</th><th data-k="tags">Roles</th>
            <th data-k="price" class="num">${currency}</th><th data-k="total_qty" class="num">Copies</th>
          </tr></thead><tbody></tbody>
        </table></div>
      </div>`;

    const rows = col.cards.map((c) => ({ ...c, price: money(c) }));
    const tbody = document.querySelector('#colTable tbody');
    const countEl = document.getElementById('count');
    const render = (list) => {
      countEl.textContent = `${list.length} cards`;
      tbody.innerHTML = list.map((c) => `
        <tr>
          <td>${esc(c.name)}</td>
          <td class="num">${c.deck_count}</td>
          <td class="muted">${esc(c.decks.map((d) => d.name).join(', '))}</td>
          <td>${esc(c.type)}</td>
          <td>${c.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</td>
          <td class="num">${fmt(c.price)}</td>
          <td class="num">${c.total_qty}</td>
        </tr>`).join('');
    };

    const apply = () => {
      const q = document.getElementById('q').value.toLowerCase();
      const deck = document.getElementById('deckSel').value;
      const tag = document.getElementById('tagSel').value;
      const sharedOnly = document.getElementById('sharedOnly').checked;
      render(rows.filter((c) =>
        (!q || c.name.toLowerCase().includes(q))
        && (!deck || c.decks.some((d) => d.name === deck))
        && (!tag || (tag === 'Untagged' ? !c.tags.length : c.tags.includes(tag)))
        && (!sharedOnly || c.deck_count > 1)));
    };

    ['q', 'deckSel', 'tagSel', 'sharedOnly'].forEach((id) => {
      const el = document.getElementById(id);
      el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', apply);
    });
    render(rows);
    sortable('#colTable', rows, render);
    wireLoadMore(draw);
  };

  draw();
  await loadAllDecks(() => { if (currentRoute().section === 'collection') draw(); });
  draw();
}

/* -------------------------------------------------------------- Top cards */

async function renderCards() {
  const draw = () => {
    const decks = loadedDecks();
    if (!decks.length) {
      view.innerHTML = state.loading
        ? progressHtml()
        : '<div class="empty">No decks could be loaded.</div>';
      return;
    }

    const col = collection(decks);
    const top = [...col.cards].sort((a, b) => money(b) - money(a)).slice(0, 60);
    const share = top.slice(0, 12);

    view.innerHTML = `
      ${state.loading ? progressHtml() : ''}
      ${loadMoreHtml()}
      <div class="panel">
        <h3>Where the money is — 12 most valuable cards</h3>
        <div class="chartbox tall"><canvas id="topChart"></canvas></div>
      </div>
      <div class="panel">
        <h3>60 most valuable cards</h3>
        <div class="scroll"><table id="topTable">
          <thead><tr>
            <th data-k="name">Card</th><th data-k="type">Type</th>
            <th>Used in</th><th data-k="deck_count" class="num">Decks</th>
            <th data-k="price" class="num">${currency}</th>
          </tr></thead><tbody></tbody>
        </table></div>
      </div>`;

    const rows = top.map((c) => ({ ...c, price: money(c) }));
    const tbody = document.querySelector('#topTable tbody');
    const render = (list) => {
      tbody.innerHTML = list.map((c) => `
        <tr>
          <td>${esc(c.name)}</td>
          <td>${esc(c.type)}</td>
          <td class="muted">${esc(c.decks.map((d) => d.name).join(', '))}</td>
          <td class="num">${c.deck_count}</td>
          <td class="num">${fmt(c.price)}</td>
        </tr>`).join('');
    };
    render(rows);
    sortable('#topTable', rows, render);
    wireLoadMore(draw);

    destroyCharts();
    mkChart(document.getElementById('topChart'), {
      type: 'bar',
      data: {
        labels: share.map((c) => c.name),
        datasets: [{ data: share.map((c) => money(c)), backgroundColor: ACCENT, borderRadius: 3 }],
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => fmt(c.parsed.x) } } },
        scales: { x: { ticks: { callback: (v) => fmt(v).replace(/[.,]\d\d$/, '') } } },
      },
    });
  };

  draw();
  await loadAllDecks(() => { if (currentRoute().section === 'cards') draw(); });
  draw();
}

/* ------------------------------------------------------------------ Shared */

function sortable(selector, rows, render) {
  const table = document.querySelector(selector);
  const dir = {};
  table.querySelectorAll('th[data-k]').forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.k;
      dir[k] = !dir[k];
      const sorted = [...rows].sort((a, b) => {
        let x = a[k];
        let y = b[k];
        if (Array.isArray(x)) { x = x.join(); y = y.join(); }
        if (typeof x === 'string' || typeof y === 'string') {
          return dir[k] ? String(x).localeCompare(String(y)) : String(y).localeCompare(String(x));
        }
        return dir[k] ? (x ?? 0) - (y ?? 0) : (y ?? 0) - (x ?? 0);
      });
      render(sorted);
    };
  });
}

/* ------------------------------------------------------------------ Router */

/** Parse `#/<site>/<user>[/<section>[/<id>]]`. */
function currentRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [site, user, section, id] = parts;
  return { site, user, section: section || 'overview', id };
}

/** Build a hash for the current user. */
function route(suffix) {
  const base = `#/${state.site}/${encodeURIComponent(state.user)}`;
  return suffix ? `${base}/${suffix}` : base;
}

async function go() {
  destroyCharts();
  const { site, user, section, id } = currentRoute();

  if (!site || !user || !SITES[site]) {
    state.site = null;
    state.user = null;
    renderLanding();
    return;
  }

  // New user or site: reset everything cached for the previous one.
  if (site !== state.site || user !== state.user) {
    state.site = site;
    state.user = user;
    state.summaries = [];
    state.decks = new Map();
    state.failed = new Map();
    state.loadAll = false;

    nav.hidden = false;
    whoEl.hidden = false;
    whoEl.innerHTML = `<b>${esc(user)}</b> on ${esc(SITES[site].label)}`;
    view.innerHTML = '<div class="loading">Looking up decks…</div>';

    try {
      if (!state.ref) state.ref = await loadReference('./data');
    } catch {
      state.ref = null;  // brackets degrade to "unavailable", everything else works
    }

    try {
      state.summaries = await listDecks(site, user);
    } catch (err) {
      view.innerHTML = `
        <div class="error">
          <b>Could not look up ${esc(user)}</b>
          ${esc(err.message)}
          <div class="hint">Check the spelling, or try the other site — usernames are
            not shared between Moxfield and Archidekt.</div>
        </div>`;
      return;
    }

    if (!state.summaries.length) {
      view.innerHTML = `
        <div class="error">
          <b>No public decks found for ${esc(user)}</b>
          The account exists but has no public decks, or the name is spelled differently.
          <div class="hint">Private and unlisted decks are never visible to this tool.</div>
        </div>`;
      return;
    }
  }

  nav.querySelectorAll('a').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === (section === 'deck' ? 'overview' : section));
    a.href = route(a.dataset.route === 'overview' ? '' : a.dataset.route);
  });

  try {
    if (section === 'collection') await renderCollection();
    else if (section === 'cards') await renderCards();
    else if (section === 'deck' && id) {
      if (!state.decks.has(id) && !state.failed.has(id)) {
        view.innerHTML = '<div class="loading">Loading deck…</div>';
        try {
          const deck = await getDeck(state.site, id);
          deck.assessed = assess(deck.cards, state.ref);
          state.decks.set(id, deck);
        } catch (err) {
          state.failed.set(id, err.message);
        }
      }
      deckDetail(id);
    } else await renderOverview();
  } catch (err) {
    view.innerHTML = `<div class="error"><b>Something went wrong</b>${esc(err.message)}</div>`;
  }
}

/* ------------------------------------------------------------------- Boot */

const themeBtn = document.getElementById('themeToggle');
const themeLabel = document.getElementById('themeLabel');
const currencyBtn = document.getElementById('currency');

function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  themeLabel.textContent = name === 'light' ? 'Light' : 'Dark';
  try { localStorage.setItem('mtg-theme', name); } catch {}
  loadPalette();
}

themeBtn.onclick = () => {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  go();  // charts bake their colours in, so rebuild them
};

currencyBtn.textContent = currency;
currencyBtn.onclick = () => {
  currency = currency === 'EUR' ? 'USD' : 'EUR';
  currencyBtn.textContent = currency;
  try { localStorage.setItem('mtg-currency', currency); } catch {}
  go();
};

applyTheme(document.documentElement.dataset.theme || 'dark');
window.addEventListener('hashchange', go);
go();
