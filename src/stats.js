/**
 * Aggregations over normalised decks.
 *
 * The personal version of this tool computed these in SQL against a snapshot
 * database. Here everything is stateless and in-memory: there is no server and
 * no history, so these are all pure functions of the decks currently loaded.
 */

import { colorPips } from './classify.js';

/** Per-deck composition: curve, types, pips, roles. */
export function composition(deck) {
  const curve = {};
  const types = {};
  const pips = {};
  const tags = {};

  let lands = 0;
  let nonLandCards = 0;
  let cmcTotal = 0;

  for (const card of deck.cards) {
    const isLand = card.type === 'Land';
    if (isLand) lands += card.qty;
    else {
      nonLandCards += card.qty;
      cmcTotal += (card.cmc || 0) * card.qty;
      const bucket = card.cmc >= 7 ? '7+' : String(card.cmc ?? 0);
      curve[bucket] = (curve[bucket] || 0) + card.qty;
    }

    types[card.type] = (types[card.type] || 0) + card.qty;

    for (const [sym, n] of Object.entries(colorPips(card.mana_cost))) {
      pips[sym] = (pips[sym] || 0) + n * card.qty;
    }

    if (!card.tags.length) tags.Untagged = (tags.Untagged || 0) + card.qty;
    for (const t of card.tags) tags[t] = (tags[t] || 0) + card.qty;
  }

  const order = ['0', '1', '2', '3', '4', '5', '6', '7+'];
  return {
    total_cards: deck.cards_total,
    lands,
    avg_cmc: nonLandCards ? +(cmcTotal / nonLandCards).toFixed(3) : 0,
    curve: order.map((cmc) => ({ cmc, count: curve[cmc] || 0 })),
    types,
    pips,
    tags,
  };
}

/**
 * Union of every loaded deck, keyed by card name.
 *
 * "Collection" here means the union of the tracked decks, not cards actually
 * owned — no deck site exposes a private collection.
 */
export function collection(decks) {
  const byName = new Map();

  for (const deck of decks) {
    for (const card of deck.cards) {
      let e = byName.get(card.name);
      if (!e) {
        e = {
          name: card.name,
          type: card.type,
          tags: card.tags,
          rarity: card.rarity,
          eur: card.eur,
          usd: card.usd,
          total_qty: 0,
          decks: [],
        };
        byName.set(card.name, e);
      }
      e.total_qty += card.qty;
      e.decks.push({ id: deck.id, name: deck.name });
    }
  }

  const cards = [...byName.values()].map((c) => ({ ...c, deck_count: c.decks.length }));
  cards.sort((a, b) => b.eur - a.eur || a.name.localeCompare(b.name));

  const tags = {};
  for (const c of cards) {
    if (!c.tags.length) tags.Untagged = (tags.Untagged || 0) + 1;
    for (const t of c.tags) tags[t] = (tags[t] || 0) + 1;
  }

  return {
    cards,
    tags,
    unique_cards: cards.length,
    total_cards: cards.reduce((n, c) => n + c.total_qty, 0),
    unique_eur: cards.reduce((n, c) => n + c.eur, 0),
    unique_usd: cards.reduce((n, c) => n + c.usd, 0),
    total_eur: decks.reduce((n, d) => n + d.eur, 0),
    total_usd: decks.reduce((n, d) => n + d.usd, 0),
    shared: cards.filter((c) => c.deck_count > 1).length,
  };
}
