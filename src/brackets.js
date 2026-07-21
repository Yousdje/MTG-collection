/**
 * Commander bracket assessment, computed from the deck list.
 *
 * This deliberately does NOT trust the deck site's own bracket field — that
 * value is whatever the deck's author typed in. Everything here is derived from
 * the actual cards, against the official criteria.
 *
 * The official system (WotC / Commander Format Panel, beta Feb 2025, criteria
 * as of the Oct 2025 and Feb 2026 updates) has five brackets:
 *
 *     1 Exhibition   ultra-casual theme decks
 *     2 Core         precon level
 *     3 Upgraded     tuned beyond precon
 *     4 Optimized    high power, no restrictions
 *     5 cEDH         competitive, metagame-focused
 *
 * Only four things are actually rules, and they gate brackets 1-3:
 *
 *     criterion              B1      B2       B3            B4/B5
 *     Game Changers          none    none     up to 3       unlimited
 *     mass land denial       no      no       no            allowed
 *     extra turns            no      limited  limited       allowed
 *     two-card infinite      no      no       late-game only allowed
 *
 * Tutor limits were part of the original beta but were REMOVED in the October
 * 2025 update, so tutors are counted here for information only and never affect
 * the result. Many third-party calculators still get this wrong.
 *
 * Two honest limits on what a deck list can tell you:
 *
 * - Bracket 5 is not computable. cEDH differs from bracket 4 by intent and
 *   metagame, not by any property of the 99, so this tops out at 4.
 * - Bracket 1 is not computable either. Exhibition is a statement about how you
 *   intend to play a theme deck. A deck that trips none of the criteria is
 *   reported as 2 (Core), the highest bracket it is guaranteed to fit.
 *
 * So the result is a floor: the lowest bracket the deck legally fits in.
 */

export const BRACKET_NAMES = {
  1: 'Exhibition',
  2: 'Core',
  3: 'Upgraded',
  4: 'Optimized',
  5: 'cEDH',
};

export const TAG_NAMES = {
  R: 'Ruthless',
  S: 'Spicy',
  P: 'Powerful',
  O: 'Oddball',
  C: 'Core',
  E: 'Exhibition',
  B: 'Banned',
};

/** Normalise a card name for matching (deck sites keep both DFC faces). */
export const norm = (name) => String(name || '').split('//')[0].trim().toLowerCase();

// WotC's definition: cards that "regularly destroy, exile, and bounce other
// lands, keep lands tapped, or change what mana is produced by four or more
// lands per player without replacing them". There is no machine-readable
// official list (the one on Moxfield is behind Cloudflare), so this is that
// definition implemented as a curated list plus oracle-text rules.
const MLD_CARDS = new Set([
  // sweepers
  'armageddon', 'ravages of war', 'catastrophe', 'cataclysm', 'decree of annihilation',
  'jokulhaups', 'obliterate', 'devastation', 'wildfire', 'burning of xinye',
  'destructive force', 'sunder', 'global ruin', 'boom // bust', 'impending disaster',
  'mana vortex', 'death cloud', 'tectonic break', 'epicenter', 'fall of the thran',
  'realm razer', 'worldfire', 'bend or break', 'acid rain', 'ruination',
  'from the ashes', 'myojin of infinite rage', 'keldon firebombers',
  'wave of vitriol', 'tempt with discovery',
  // keep-lands-tapped locks
  'winter orb', 'static orb', 'stasis', 'rising waters', 'storm cauldron',
  'hokori, dust drinker', 'root maze', 'overburden', 'contamination',
  'infernal darkness', 'mana breach', 'mana web',
  // change what lands produce
  'blood moon', 'magus of the moon', 'back to basics', 'winter moon',
  'harbinger of the seas', 'boil', 'boiling seas', 'choke', 'carpet of flowers',
]);

// Cards the name list would over-catch: these are fine in any bracket.
const MLD_EXCLUDE = new Set(['carpet of flowers', 'tempt with discovery']);

const MLD_ORACLE = new RegExp(
  [
    'destroy all lands',
    'exile all lands',
    String.raw`each player sacrifices (\w+|x) lands?`,
    String.raw`destroy (\w+) target lands?`,
    "lands don't untap",
    "nonbasic lands? (are|don't untap)",
    'lands (are|become) mountains',
    "players can't play lands",
  ].join('|'),
  'i',
);

const EXTRA_TURN = /take an extra turn/i;
const TUTOR = /searche?s? (your|their) library for (a|two|up to \w+)/i;

function findMld(cards) {
  const hits = [];
  for (const c of cards) {
    const name = norm(c.name);
    if (MLD_EXCLUDE.has(name)) continue;
    let why = null;
    if (MLD_CARDS.has(name)) why = 'known mass land denial';
    else if (MLD_ORACLE.test(c.oracle_text || '')) why = 'oracle text denies lands en masse';
    if (why) hits.push({ name: c.name, why });
  }
  return hits;
}

function findCombos(cards, index) {
  const present = new Set(cards.map((c) => norm(c.name)));
  const found = [];
  for (const [key, combo] of Object.entries(index)) {
    const [a, b] = key.split('|');
    if (present.has(a) && present.has(b)) {
      found.push({
        cards: combo.cards,
        tag: combo.tag,
        tag_name: TAG_NAMES[combo.tag] || combo.tag,
        produces: combo.produces,
        id: combo.id,
        // Ruthless is Spellbook's "very fast, infinite turns, or mass land
        // denial" tag — unambiguously the early-game kind bracket 3 excludes.
        fast: combo.tag === 'R',
        // Spicy is explicitly documented as "probably 3 or 4, but hard to
        // classify", so it makes the answer a range rather than pushing the
        // deck to 4 on its own.
        borderline: combo.tag === 'S',
      });
    }
  }
  found.sort(
    (x, y) =>
      Number(y.fast) - Number(x.fast) ||
      Number(y.borderline) - Number(x.borderline) ||
      String(x.cards[0]).localeCompare(String(y.cards[0])),
  );
  return found;
}

const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

/**
 * Assess a deck. `cards` need `name` and `oracle_text`; quantity is ignored.
 * `ref` is { gameChangers: Set<normName>, combos: {key: combo} }.
 */
export function assess(cards, ref) {
  const gcSet = ref?.gameChangers;
  const comboIndex = ref?.combos;

  // Without the reference lists every deck would look clean and report as
  // bracket 2. Say so instead of quietly returning a wrong answer.
  if (!gcSet || !gcSet.size || !comboIndex || !Object.keys(comboIndex).length) {
    const missing = [];
    if (!gcSet || !gcSet.size) missing.push('Game Changers');
    if (!comboIndex || !Object.keys(comboIndex).length) missing.push('combo index');
    return {
      bracket: null,
      bracket_high: null,
      uncertain: false,
      label: 'unknown',
      unavailable: `missing reference data (${missing.join(', ')})`,
      reasons: [],
      game_changers: [],
      mass_land_denial: [],
      extra_turns: [],
      combos: [],
      tutors: 0,
      ceiling_note: '',
    };
  }

  const gameChangers = cards.filter((c) => gcSet.has(norm(c.name))).map((c) => ({ name: c.name }));
  const mld = findMld(cards);
  const extraTurns = cards
    .filter((c) => EXTRA_TURN.test(c.oracle_text || ''))
    .map((c) => ({ name: c.name }));
  const combos = findCombos(cards, comboIndex);
  const tutors = cards.filter((c) => TUTOR.test(c.oracle_text || '')).length;

  const fastCombos = combos.filter((c) => c.fast);
  const borderlineCombos = combos.filter((c) => c.borderline);

  // Official decision order: Game Changers, then mass land denial, then
  // two-card combos, then extra turns.
  let floor = 2;
  const reasons = [];

  if (gameChangers.length > 3) {
    floor = Math.max(floor, 4);
    reasons.push({
      level: 4,
      text: `${gameChangers.length} Game Changers — bracket 3 allows at most 3`,
    });
  } else if (gameChangers.length) {
    floor = Math.max(floor, 3);
    reasons.push({
      level: 3,
      text: `${plural(gameChangers.length, 'Game Changer')} — brackets 1 and 2 allow none`,
    });
  }

  if (mld.length) {
    floor = Math.max(floor, 4);
    reasons.push({
      level: 4,
      text: `mass land denial (${mld.slice(0, 3).map((m) => m.name).join(', ')}) — not permitted below bracket 4`,
    });
  }

  if (fastCombos.length) {
    floor = Math.max(floor, 4);
    reasons.push({
      level: 4,
      text:
        `${plural(fastCombos.length, 'fast two-card infinite combo')} ` +
        '(Spellbook-rated Ruthless) — bracket 3 allows only late-game combos',
    });
  } else if (combos.length) {
    floor = Math.max(floor, 3);
    reasons.push({
      level: 3,
      text: `${plural(combos.length, 'two-card infinite combo')} — brackets 1 and 2 allow none`,
    });
  }

  if (extraTurns.length >= 3) {
    floor = Math.max(floor, 4);
    reasons.push({
      level: 4,
      text: `${extraTurns.length} extra-turn cards — enough to chain, which brackets 1-3 exclude`,
    });
  } else if (extraTurns.length) {
    reasons.push({
      level: 2,
      text:
        `${plural(extraTurns.length, 'extra-turn card')} — fine in low quantities, ` +
        'but not allowed at all in bracket 1',
    });
  }

  if (!reasons.length) {
    reasons.push({
      level: 2,
      text: 'no Game Changers, mass land denial, two-card infinites or extra turns',
    });
  }

  // Spicy combos are documented as "probably 3 or 4" — how early they assemble
  // in practice decides it, which a list alone cannot tell us.
  let high = floor;
  if (borderlineCombos.length && floor < 4) {
    high = 4;
    const many = borderlineCombos.length > 1;
    reasons.push({
      level: 4,
      text:
        `${plural(borderlineCombos.length, 'two-card infinite combo')} rated Spicy — ` +
        `bracket 4 if ${many ? 'they assemble' : 'it assembles'} early in practice, otherwise 3`,
    });
  }

  return {
    bracket: floor,
    bracket_high: high,
    uncertain: high !== floor,
    label: high === floor ? BRACKET_NAMES[floor] : `${floor}–${high}`,
    name: BRACKET_NAMES[floor],
    reasons,
    game_changers: gameChangers,
    mass_land_denial: mld,
    extra_turns: extraTurns,
    combos,
    fast_combos: fastCombos.length,
    borderline_combos: borderlineCombos.length,
    tutors,
    ceiling_note:
      floor === 4
        ? 'Bracket 5 (cEDH) is a statement of intent and metagame, not a property of the 99, so this never returns 5.'
        : 'This is a floor: the deck is legal at this bracket and every bracket above it.',
  };
}

/** Lazily load and shape the reference data shipped alongside the app. */
let refPromise = null;
export function loadReference(base = './data') {
  if (!refPromise) {
    refPromise = Promise.all([
      fetch(`${base}/game_changers.json`).then((r) => r.json()),
      fetch(`${base}/combos.json`).then((r) => r.json()),
    ])
      .then(([gc, combos]) => ({
        gameChangers: new Set((gc.cards || []).map(norm)),
        combos: combos.combos || {},
        fetched: { game_changers: gc.fetched, combos: combos.fetched },
      }))
      .catch((err) => {
        refPromise = null;
        throw err;
      });
  }
  return refPromise;
}
