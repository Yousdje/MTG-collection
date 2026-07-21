/**
 * Rule-based card function tagging.
 *
 * Ported from the Python original. Every deck site ships Scryfall oracle text
 * with the deck payload, so "roles" (removal, ramp, draw, ...) are derived
 * locally by regex rather than by calling another service. A card can carry
 * several tags; cards matching nothing stay untagged, which is itself useful
 * signal when auditing a deck.
 */

// Tag order controls display order in the UI.
export const TAG_ORDER = [
  'Land',
  'Ramp',
  'Mana Rock',
  'Mana Dork',
  'Card Advantage',
  'Tutor',
  'Spot Removal',
  'Board Wipe',
  'Counterspell',
  'Protection',
  'Recursion',
  'Graveyard Hate',
  'Token Maker',
  'Sacrifice Outlet',
  'Lifegain',
  'Discard',
  'Stax / Taxes',
  'Extra Turn / Combat',
];

const r = (src) => new RegExp(src, 'i');

// [tag, oracle-text regex, required substring in type line or null]
const RULES = [
  ['Mana Rock', r(String.raw`\{t\}[^:.]{0,40}:[^.]{0,80}\badd\b`), 'Artifact'],
  ['Mana Dork', r(String.raw`\{t\}[^:.]{0,40}:[^.]{0,80}\badd\b`), 'Creature'],
  [
    'Ramp',
    r(
      String.raw`search your library for (a|up to \w+) basic land|` +
        String.raw`search your library for (a|up to \w+)[^.]{0,40}land card[^.]{0,60}battlefield|` +
        String.raw`put a land card[^.]{0,40}onto the battlefield|` +
        String.raw`\bput (it|them|that card) onto the battlefield[^.]{0,30}tapped|` +
        String.raw`you may play an additional land|` +
        String.raw`adds? \{[wubrgc]\}|adds? (one|two|three|x|\w+) mana|adds? an amount of mana|` +
        String.raw`adds? an additional|` +
        String.raw`lands you control (produce|tap for)|` +
        String.raw`spells?( you cast)? cost \{\d+\} less to cast|` +
        String.raw`you cast cost \{\d+\} less`,
    ),
    null,
  ],
  [
    'Card Advantage',
    r(
      String.raw`draws? (a|one|two|three|four|x|\w+) cards?|` +
        String.raw`draw that many cards|draw cards equal to|` +
        String.raw`exile the top[^.]{0,120}you may (play|cast)|` +
        String.raw`\bcascade\b|` +
        String.raw`(play|cast) (lands and )?spells from the top of your library|` +
        String.raw`cast (it|them|\w+ spells?) [^.]{0,40}without paying (its|their) mana costs?|` +
        String.raw`look at the top[^.]{0,60}put[^.]{0,40}into your hand`,
    ),
    null,
  ],
  [
    'Tutor',
    r(String.raw`searche?s? (your|their) library for (a|two|up to \w+)[^.]{0,80}(card|permanent)`),
    null,
  ],
  [
    'Spot Removal',
    r(
      String.raw`(destroy|exile) (target|x target) (creature|permanent|artifact|enchantment|planeswalker|` +
        String.raw`nonland|player|battle|land|token)|` +
        String.raw`deals? (\d+|x) damage to (target|any target)|` +
        String.raw`target creature gets [-−](\d+|x)/[-−](\d+|x)|` +
        String.raw`target (creature|player) sacrifices|` +
        String.raw`(target opponent|each opponent) sacrifices a (creature|permanent)|` +
        String.raw`put target (creature|permanent)[^.]{0,40}(on top of|into)[^.]{0,20}(library|graveyard)|` +
        String.raw`(shuffles? it|shuffle target)[^.]{0,30}into[^.]{0,20}library|` +
        String.raw`return target (creature|permanent|nonland)[^.]{0,40}to (its|their) owner's hand|` +
        String.raw`fight target creature`,
    ),
    null,
  ],
  [
    'Board Wipe',
    r(
      String.raw`(destroy|exile) (all|each)[^.]{0,30}(creature|permanent|nonland|artifact|enchantment)|` +
        String.raw`all creatures get [-−](\d+|x)/[-−](\d+|x)|` +
        String.raw`deals? (\d+|x) damage to each (creature|other creature|player)|` +
        String.raw`each player sacrifices|` +
        String.raw`all players sacrifice|` +
        String.raw`return all (creature|permanent)`,
    ),
    null,
  ],
  ['Counterspell', r(String.raw`counter target (spell|ability|activated|triggered)`), null],
  [
    'Protection',
    r(
      String.raw`gains? (hexproof|indestructible|protection|shroud|ward)|` +
        String.raw`has (hexproof|indestructible|protection from)|` +
        String.raw`you have hexproof|` +
        String.raw`phases out|` +
        String.raw`can't be (countered|blocked|targeted)|` +
        String.raw`prevent all (combat )?damage|` +
        String.raw`choose new targets for target spell|` +
        String.raw`regenerate target`,
    ),
    null,
  ],
  [
    'Recursion',
    r(
      String.raw`return (target|all|each|up to \w+)[^.]{0,80}from (your|a|their|an opponent's) graveyard to ` +
        String.raw`(the battlefield|your hand|its owner's hand)|` +
        String.raw`put (target|a|any number of target)[^.]{0,80}(card|cards) from (a|your|their)[^.]{0,20}` +
        String.raw`graveyard onto the battlefield|` +
        String.raw`put (those cards|that card) onto the battlefield|` +
        String.raw`you may cast [^.]{0,40}from your graveyard|` +
        String.raw`return (it|that card) from your graveyard|` +
        String.raw`enchant creature card in a graveyard`,
    ),
    null,
  ],
  [
    'Graveyard Hate',
    r(
      String.raw`exile (target|all|each)[^.]{0,60}(from|in)[^.]{0,20}graveyard|` +
        String.raw`exile (all|each) (card|cards) from all graveyards|` +
        String.raw`would be put into (a|an opponent's|their)[^.]{0,40}graveyard[^.]{0,40}` +
        String.raw`(exile it instead|instead exile it)|` +
        String.raw`graveyards? (can't|instead)`,
    ),
    null,
  ],
  ['Token Maker', r(String.raw`creates? (a|an|one|two|three|\w+|x)\b[^.]{0,60}token`), null],
  [
    'Sacrifice Outlet',
    r(String.raw`sacrifice (a|another|an)[^:.]{0,40}(creature|permanent|artifact|token)[^:.]{0,20}:`),
    null,
  ],
  ['Lifegain', r(String.raw`(you )?gains? \d+ life|gain life equal to|lifelink`), null],
  [
    'Discard',
    r(
      String.raw`(each opponent|target player|target opponent|players?) discards?|` +
        String.raw`discards? (a|their|\w+) (card|hand)`,
    ),
    null,
  ],
  [
    'Stax / Taxes',
    r(
      String.raw`cost \{\d+\} more to cast|` +
        String.raw`don't untap|doesn't untap|` +
        String.raw`(players|opponents|each opponent) can't|` +
        String.raw`can't be cast|` +
        String.raw`skip (your|their) (draw|untap)|` +
        String.raw`spells your opponents cast cost`,
    ),
    null,
  ],
  [
    'Extra Turn / Combat',
    r(
      String.raw`take an extra turn|` +
        String.raw`untap all creatures you control[^.]{0,40}additional combat|additional combat phase`,
    ),
    null,
  ],
];

const LAND_FETCH_RE = /search your library for a[^.]{0,40}land/i;

export function tagCard(typeLine, oracle) {
  typeLine = typeLine || '';
  oracle = oracle || '';

  // Only the front face decides "is this a land" — an MDFC like
  // "Sorcery // Land" is cast as a sorcery and belongs on the curve.
  if (typeLine.split('//')[0].includes('Land')) {
    const tags = ['Land'];
    if (LAND_FETCH_RE.test(oracle)) tags.push('Ramp');
    return tags;
  }

  const tags = [];
  for (const [tag, pattern, needsType] of RULES) {
    if (needsType && !typeLine.includes(needsType)) continue;
    if (pattern.test(oracle)) tags.push(tag);
  }

  // Mana rocks and dorks are a kind of ramp; don't make the user infer it.
  if ((tags.includes('Mana Rock') || tags.includes('Mana Dork')) && !tags.includes('Ramp')) {
    tags.push('Ramp');
  }

  const rank = (t) => (TAG_ORDER.includes(t) ? TAG_ORDER.indexOf(t) : 99);
  return [...new Set(tags)].sort((a, b) => rank(a) - rank(b));
}

const PIP_RE = /\{([^}]+)\}/g;

/** Count coloured mana symbols, treating hybrid/phyrexian as one of each. */
export function colorPips(manaCost) {
  const pips = {};
  for (const m of String(manaCost || '').matchAll(PIP_RE)) {
    for (const ch of m[1].toUpperCase()) {
      if ('WUBRG'.includes(ch)) pips[ch] = (pips[ch] || 0) + 1;
    }
  }
  return pips;
}

const BROAD_TYPES = [
  'Creature',
  'Planeswalker',
  'Instant',
  'Sorcery',
  'Artifact',
  'Enchantment',
  'Battle',
  'Land',
];

/** The single headline type used for the deck's type breakdown. */
export function broadType(typeLine) {
  const tl = String(typeLine || '').split('//')[0];
  for (const t of BROAD_TYPES) if (tl.includes(t)) return t;
  return 'Other';
}
