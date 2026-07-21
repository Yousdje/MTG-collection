/**
 * Deck-site adapters.
 *
 * Moxfield and Archidekt model a deck completely differently. Everything above
 * this file works on one normalised shape:
 *
 *   Deck    { id, name, format, url, commanders[], colors[], cards[],
 *             updated, views, siteBracket, eur, usd }
 *   Card    { name, qty, cmc, type_line, mana_cost, oracle_text, colors,
 *             rarity, eur, usd, commander }
 *
 * `type_line` is reconstructed for Archidekt (which sends types as arrays)
 * because both the classifier and the bracket engine match against it.
 */

import { tagCard, broadType } from './classify.js';

export const SITES = {
  moxfield: {
    label: 'Moxfield',
    placeholder: 'Moxfield username',
    deckUrl: (id) => `https://moxfield.com/decks/${id}`,
    profileUrl: (u) => `https://moxfield.com/users/${encodeURIComponent(u)}`,
    note: 'Moxfield actively blocks automated access; lookups can fail.',
  },
  archidekt: {
    label: 'Archidekt',
    placeholder: 'Archidekt username',
    deckUrl: (id) => `https://archidekt.com/decks/${id}`,
    profileUrl: (u) => `https://archidekt.com/u/${encodeURIComponent(u)}`,
    note: null,
  },
};

/** Set at boot from config.js so the site can be re-pointed without a rebuild. */
let API_BASE = '';
export function setApiBase(base) {
  API_BASE = String(base || '').replace(/\/$/, '');
}

async function api(params) {
  if (!API_BASE) throw new Error('API proxy is not configured (see config.js)');
  const url = new URL(API_BASE + '/api');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let resp;
  try {
    resp = await fetch(url);
  } catch {
    throw new Error('Could not reach the lookup service. Check your connection.');
  }

  let body;
  try {
    body = await resp.json();
  } catch {
    throw new Error('The lookup service sent an unreadable response.');
  }
  if (!resp.ok) throw new Error(body?.error || `lookup failed (${resp.status})`);
  return body;
}

// ------------------------------------------------------------------ Moxfield

const MOX_COUNTED = ['mainboard', 'commanders', 'companions', 'signatureSpells'];

function moxOracle(card) {
  const parts = [card.oracle_text || ''];
  for (const face of card.card_faces || []) parts.push(face.oracle_text || '');
  return parts.filter(Boolean).join('\n');
}

function moxDeck(deck) {
  const boards = deck.boards || {};
  const commanders = Object.values(boards.commanders?.cards || {}).map((e) => e.card.name);

  const cards = [];
  for (const boardName of MOX_COUNTED) {
    for (const entry of Object.values(boards[boardName]?.cards || {})) {
      const c = entry.card || {};
      const prices = c.prices || {};
      cards.push({
        name: c.name || '',
        qty: entry.quantity || 1,
        cmc: c.cmc ?? 0,
        type_line: c.type_line || '',
        mana_cost: c.mana_cost || '',
        oracle_text: moxOracle(c),
        colors: c.color_identity || c.colors || [],
        rarity: c.rarity || '',
        usd: Number(prices.usd || 0),
        eur: Number(prices.eur || 0),
        commander: boardName === 'commanders',
      });
    }
  }

  return finishDeck({
    site: 'moxfield',
    id: deck.publicId,
    name: deck.name || '(untitled)',
    format: deck.format || '',
    url: SITES.moxfield.deckUrl(deck.publicId),
    commanders,
    colors: deck.colorIdentity || deck.colors || [],
    updated: (deck.lastUpdatedAtUtc || '').slice(0, 10),
    views: deck.viewCount || 0,
    siteBracket: deck.bracket ?? null,
    cards,
  });
}

// ----------------------------------------------------------------- Archidekt

const COLOR_LETTER = { White: 'W', Blue: 'U', Black: 'B', Red: 'R', Green: 'G' };

/** Archidekt sends types as arrays; both engines match on a type line string. */
function archiTypeLine(oracle) {
  const left = [...(oracle.superTypes || []), ...(oracle.types || [])].join(' ');
  const right = (oracle.subTypes || []).join(' ');
  return right ? `${left} — ${right}` : left;
}

function archiOracleText(oracle) {
  const parts = [oracle.text || ''];
  for (const face of oracle.faces || []) parts.push(face.text || '');
  return parts.filter(Boolean).join('\n');
}

function archiDeck(deck) {
  // A category can be excluded from the deck (maybeboard, sideboard-ish
  // buckets). Respect that or the counts and prices are wrong.
  const excluded = new Set(
    (deck.categories || []).filter((c) => c.includedInDeck === false).map((c) => c.name),
  );

  const cards = [];
  const commanders = [];

  for (const entry of deck.cards || []) {
    const cats = entry.categories || [];
    if (cats.some((c) => excluded.has(c))) continue;

    const card = entry.card || {};
    const oracle = card.oracleCard || {};
    const prices = card.prices || {};
    const isCommander = cats.includes('Commander');
    const name = oracle.name || card.displayName || '';

    if (isCommander) commanders.push(name);

    cards.push({
      name,
      qty: entry.quantity || 1,
      cmc: oracle.cmc ?? 0,
      type_line: archiTypeLine(oracle),
      mana_cost: oracle.manaCost || '',
      oracle_text: archiOracleText(oracle),
      colors: (oracle.colorIdentity || []).map((c) => COLOR_LETTER[c] || c),
      rarity: card.rarity || '',
      // cm is Cardmarket (EUR), tcg is TCGplayer (USD), and both are priced for
      // the exact printing the deck author picked. That is frequently absurd —
      // one Summer Magic Island at €500 will dwarf a whole deck — so prefer the
      // cheapest printing, which is what "cost to own" actually means.
      usd: Number(prices.tcgMinimum ?? prices.tcg ?? 0),
      eur: Number(prices.cmMinimum ?? prices.cm ?? 0),
      commander: isCommander,
    });
  }

  const colors = new Set();
  for (const c of cards) for (const col of c.colors) colors.add(col);

  return finishDeck({
    site: 'archidekt',
    id: String(deck.id),
    name: deck.name || '(untitled)',
    format: 'Commander',
    url: SITES.archidekt.deckUrl(deck.id),
    commanders,
    colors: [...colors],
    updated: (deck.updatedAt || '').slice(0, 10),
    views: deck.viewCount || 0,
    siteBracket: deck.edhBracket ?? null,
    cards,
  });
}

// ------------------------------------------------------------------- Shared

const WUBRG = ['W', 'U', 'B', 'R', 'G'];

/** Tag every card and roll up the totals both views need. */
function finishDeck(deck) {
  let eur = 0;
  let usd = 0;
  let count = 0;

  for (const c of deck.cards) {
    c.tags = tagCard(c.type_line, c.oracle_text);
    c.type = broadType(c.type_line);
    eur += c.eur * c.qty;
    usd += c.usd * c.qty;
    count += c.qty;
  }

  deck.eur = eur;
  deck.usd = usd;
  deck.cards_total = count;
  deck.colors = WUBRG.filter((c) => deck.colors.includes(c));
  return deck;
}

// --------------------------------------------------------------- Public API

/** Deck summaries for a username. Does not fetch card contents. */
export async function listDecks(site, username) {
  if (site === 'moxfield') {
    const out = [];
    for (let page = 1; page <= 20; page++) {
      const data = await api({ site, action: 'decks', user: username, page });
      out.push(
        ...(data.data || []).map((d) => ({
          site,
          id: d.publicId,
          name: d.name || '(untitled)',
          format: d.format || '',
          url: SITES.moxfield.deckUrl(d.publicId),
          colors: WUBRG.filter((c) => (d.colorIdentity || []).includes(c)),
          updated: (d.lastUpdatedAtUtc || '').slice(0, 10),
          views: d.viewCount || 0,
          cards_total: d.mainboardCount ?? null,
        })),
      );
      if (page >= (data.totalPages || 1)) break;
    }
    return out;
  }

  if (site === 'archidekt') {
    const out = [];
    for (let page = 1; page <= 20; page++) {
      const data = await api({ site, action: 'decks', user: username, page });
      // Archidekt answers an unknown user with count -1 rather than an error.
      if (data.count === -1) throw new Error('no such Archidekt user');
      out.push(
        ...(data.results || []).map((d) => ({
          site,
          id: String(d.id),
          name: d.name || '(untitled)',
          format: 'Commander',
          url: SITES.archidekt.deckUrl(d.id),
          colors: [],
          updated: (d.updatedAt || '').slice(0, 10),
          views: d.viewCount || 0,
          cards_total: d.size ?? null,
        })),
      );
      if (!data.next) break;
    }
    return out;
  }

  throw new Error(`unsupported site: ${site}`);
}

/** One deck, fully normalised, with every card tagged. */
export async function getDeck(site, id) {
  const raw = await api({ site, action: 'deck', id });
  return site === 'moxfield' ? moxDeck(raw) : archiDeck(raw);
}
