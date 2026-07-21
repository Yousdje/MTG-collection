#!/usr/bin/env python3
"""Regenerate the bracket reference data in ./data.

Two external lists are needed and both change over time, so neither is
hardcoded:

* **Game Changers** — the official WotC list, read from Scryfall's
  `is:gamechanger` query, which Scryfall keeps in sync with WotC.
* **Two-card combos** — from Commander Spellbook, distilled to just the
  card-name pairs that actually end the game. The full bulk export is ~580 MB;
  the distilled index is a few hundred KB, so assessment stays fast and works
  entirely in the browser.

Run by CI weekly. Standard library only.
"""

from __future__ import annotations

import json
import os
import time
import urllib.parse
import urllib.request

DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
GC_PATH = os.path.join(DATA, "game_changers.json")
COMBO_PATH = os.path.join(DATA, "combos.json")

UA = "MTG-collection/1.0 (+https://github.com/yousdje/MTG-collection)"

# A Spellbook variant only counts as a "two-card infinite combo" for bracket
# purposes if it actually produces something game-ending.
WINCON_MARKERS = ("infinite", "win the game", "loses the game", "lose the game")

# Commander Spellbook's own bracket tags -> the Commander bracket a combo
# implies. Source: https://commanderspellbook.com/syntax-guide/
#   R Ruthless (4+), S Spicy (3-4), P Powerful (3+),
#   O Oddball (2), C Core (2+), E Exhibition (1), B Banned
TAG_BRACKET = {"R": 4, "S": 3, "P": 3, "O": 2, "C": 2, "E": 1, "B": 5}


def get_json(url: str, timeout: int = 60) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def norm(name: str) -> str:
    return name.split("//")[0].strip().lower()


def fetch_game_changers() -> list[str]:
    cards: list[str] = []
    url = "https://api.scryfall.com/cards/search?" + urllib.parse.urlencode(
        {"q": "is:gamechanger", "format": "json"}
    )
    while url:
        data = get_json(url)
        cards.extend(c["name"] for c in data.get("data", []))
        url = data.get("next_page")
        if url:
            time.sleep(0.15)  # Scryfall asks for 50-100ms between requests
    return sorted(cards)


def fetch_combos(max_pages: int = 200) -> dict:
    url = "https://backend.commanderspellbook.com/variants/?" + urllib.parse.urlencode(
        {"q": "cards=2", "limit": 100}
    )
    index: dict[str, dict] = {}
    pages = 0
    while url and pages < max_pages:
        data = get_json(url)
        pages += 1
        for v in data.get("results", []):
            if not (v.get("legalities") or {}).get("commander", True):
                continue
            uses = v.get("uses") or []
            if len(uses) != 2:
                continue
            produces = [p["feature"]["name"] for p in (v.get("produces") or [])]
            if not any(m in p.lower() for p in produces for m in WINCON_MARKERS):
                continue

            key = "|".join(sorted(norm(u["card"]["name"]) for u in uses))
            tag = v.get("bracketTag") or "S"
            # Keep the most permissive (highest-bracket) reading of a pair.
            if key in index and TAG_BRACKET.get(tag, 4) <= TAG_BRACKET.get(index[key]["tag"], 4):
                continue
            index[key] = {
                "cards": [u["card"]["name"] for u in uses],
                "tag": tag,
                "produces": produces[:3],
                "id": v.get("id"),
            }
        url = data.get("next")
        if url:
            time.sleep(0.2)
    return index


def main() -> int:
    os.makedirs(DATA, exist_ok=True)
    today = time.strftime("%Y-%m-%d")

    print("Fetching Game Changers from Scryfall …")
    gc = fetch_game_changers()
    print(f"  {len(gc)} cards")

    print("Fetching two-card combos from Commander Spellbook …")
    combos = fetch_combos()
    print(f"  {len(combos)} game-ending two-card combos")

    # Refuse to overwrite good data with an empty or obviously truncated fetch —
    # a silent partial write would make every deck look like bracket 2.
    if len(gc) < 20:
        print(f"ERROR: only {len(gc)} Game Changers, refusing to write")
        return 1
    if len(combos) < 500:
        print(f"ERROR: only {len(combos)} combos, refusing to write")
        return 1

    with open(GC_PATH, "w") as fh:
        json.dump({"fetched": today, "cards": gc}, fh, indent=1)
    with open(COMBO_PATH, "w") as fh:
        json.dump({"fetched": today, "combos": combos}, fh)

    print("Wrote data/game_changers.json and data/combos.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
