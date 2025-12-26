#!/usr/bin/env python3
"""
Build layered transformation graphs for selected items using existing aggregated
transformations.json (and tiers.csv for desired output rates). The result is
written as JSON files under public/graphs/{slug}.json and can be used directly
by the UI modal (five fixed input columns, center-first ordering), with
annotations for matches to previous layer (fromPrev), splits, and pass-throughs.

Assumptions
- public/transformations.json already reflects default recipes only and contains
  complete step chains per selected item.
- Steps are ordered from the final product down to raw resource extraction.
- Quantities in transformation steps are per-minute for a baseline of producing
  1 unit/min of the target output. We scale by the desired per-minute rate found
  in public/tiers.csv (column "Output").

CLI
- No args: generate graphs for every item in tiers.csv.
- --target "Name": only for the specified item (exact match on Name column).
- --out-dir path: override output directory (default: public/graphs).

Output schema (per file)
{
  "target": "Reinforced Iron Plate",
  "targetRatePerMin": 1.0,
  "steps": [
    {
      "level": 5,                       # 0..N (top = highest)
      "displayStep": 5,                  # same as level for convenience
      "recipe": "Reinforced Iron Plate",
      "building": "AssemblerMk1",
      "inputs5": [                       # always 5 slots (nullable)
        {"name":"Iron Plate","perMin":6,"fromPrev":true,"role":"normal"},
        null,
        {"name":"Screws","perMin":12,"fromPrev":false,"role":"normal"},
        null,
        null
      ],
      "hiddenInputsCount": 0,
      "byproducts": { ... },
      "outputs": { ... },
      "rowHasPrevMatch": true
    },
    ...
  ],
  "meta": {
    "source": "transformations.json",
    "slug": "reinforced-iron-plate",
    "notes": []
  }
}
"""
from __future__ import annotations
import argparse
import csv
import json
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

ROOT = Path(__file__).resolve().parent.parent
PUBLIC_DIR = ROOT / 'public'
TRANSFORMATIONS_PATH = PUBLIC_DIR / 'transformations.json'
TIERS_CSV_PATH = PUBLIC_DIR / 'tiers.csv'
DEFAULT_OUT_DIR = PUBLIC_DIR / 'graphs'

CENTER_FIRST_ORDER = [2, 1, 3, 0, 4]  # center, left, right, far-left, far-right

@dataclass
class Step:
    recipe: str
    building: Optional[str]
    produces: Dict[str, float]
    requires: Dict[str, float]
    byproducts: Dict[str, float]

@dataclass
class Chain:
    index: int
    tier: str
    output: str
    output_quantity: float
    steps: List[Step]


def slugify(name: str) -> str:
    return (
        name.strip().lower()
        .replace(' / ', '-').replace('/', '-')
        .replace(' ', '-')
        .replace("'", '')
    )


def load_transformations() -> List[Chain]:
    with open(TRANSFORMATIONS_PATH, 'r', encoding='utf-8') as f:
        data = json.load(f)
    chains: List[Chain] = []
    for row in data:
        steps = [
            Step(
                recipe=s.get('recipe'),
                building=s.get('building'),
                produces=s.get('produces') or {},
                requires=s.get('requires') or {},
                byproducts=s.get('byproducts') or {},
            )
            for s in row.get('transformation_steps', [])
        ]
        chains.append(
            Chain(
                index=row.get('index'),
                tier=str(row.get('tier')) if row.get('tier') is not None else '',
                output=row.get('output'),
                output_quantity=float(row.get('output_quantity') or 1.0),
                steps=steps,
            )
        )
    return chains


def load_targets_from_tiers() -> Dict[str, float]:
    targets: Dict[str, float] = {}
    with open(TIERS_CSV_PATH, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = row.get('Name')
            if not name:
                continue
            try:
                rate = float(row.get('Output') or 1.0)
            except Exception:
                rate = 1.0
            targets[name] = rate
    return targets


def center_first_slots(pairs: List[Tuple[str, float]]) -> Tuple[List[Optional[dict]], int]:
    """Place up to 5 inputs into center-first slots, preserving relative order.
    Returns (slots, hiddenCount).
    """
    slots: List[Optional[dict]] = [None] * 5
    if not pairs:
        return slots, 0
    hidden = max(0, len(pairs) - 5)
    for idx, (name, per_min) in enumerate(pairs[:5]):
        slot_index = CENTER_FIRST_ORDER[idx]
        slots[slot_index] = {"name": name, "perMin": per_min}
        if idx == 4 and hidden:
            slots[slot_index]["hiddenCountOnThisSlot"] = hidden
    return slots, hidden


def compute_annotations(steps: List[Step]) -> Tuple[List[set], Dict[int, Counter], Dict[int, Dict[str, int]]]:
    """Pre-compute helper structures for annotations.
    - prev_outputs[i] = set of output names at level i (the immediate previous level for i+1)
    - splits_by_level[i+1][name] = count of how many times an item from level i is required at level i+1 across all inputs
    - pass_through_targets[level][name] = deepest future level where this name is eventually consumed, if it skips immediate next level
    """
    n = len(steps)
    prev_outputs: List[set] = [set() for _ in range(n)]
    for i in range(n):
        prev_outputs[i] = set(steps[i].produces.keys())

    # Splits: count per name from level i outputs used at level i+1 requires
    splits_by_level: Dict[int, Counter] = defaultdict(Counter)
    for i in range(n - 1):
        produced = prev_outputs[i]
        requires_next = steps[i + 1].requires
        for name in produced:
            count = sum(1 for req_name in requires_next.keys() if req_name == name)
            if count:
                splits_by_level[i + 1][name] += count

    # Pass-through: if an item produced at level i is not used at i+1 but used later at j>i+1
    pass_through_targets: Dict[int, Dict[str, int]] = defaultdict(dict)
    for i in range(n - 2):
        produced = prev_outputs[i]
        next_requires = set(steps[i + 1].requires.keys())
        if not produced:
            continue
        for name in produced:
            if name in next_requires:
                continue
            # look ahead
            used_level: Optional[int] = None
            for j in range(i + 2, n):
                if name in steps[j].requires:
                    used_level = j
                    break
            if used_level is not None:
                pass_through_targets[i][name] = used_level
    return prev_outputs, splits_by_level, pass_through_targets


def _build_recipe_map(chains: List[Chain]) -> Dict[str, dict]:
    """Extract a per-item default recipe mapping normalized to 1 unit/min of that item.
    Uses all chains' steps to infer ratios by dividing step requires/byproducts by the
    produced quantity of that specific item within that step.

    Skips MinerMk1 (treat raw items as terminals).
    """
    recipe_map: Dict[str, dict] = {}
    for ch in chains:
        for s in ch.steps:
            building = (s.building or '').strip()
            # normalize per produced item
            for out_name, out_qty in (s.produces or {}).items():
                if not out_qty:
                    continue
                if building.lower() == 'minermk1':
                    # treat as terminal; do not register a recipe
                    continue
                # If we've already recorded a recipe for this item, keep the first
                if out_name in recipe_map:
                    continue
                ratio = 1.0 / float(out_qty)
                requires_norm = {k: float(v) * ratio for k, v in (s.requires or {}).items()}
                byproducts_norm = {k: float(v) * ratio for k, v in (s.byproducts or {}).items()}
                # Skip identity/self-referential extractors (e.g., Water, Miner-like),
                # where the recipe requires the same output item; treat as terminal.
                if out_name in requires_norm:
                    continue
                recipe_map[out_name] = {
                    'recipe': s.recipe,
                    'building': s.building,
                    'requires': requires_norm,
                    'byproducts': byproducts_norm,
                }
    return recipe_map


def _is_terminal(item: str, recipe_map: Dict[str, dict]) -> bool:
    r = recipe_map.get(item)
    return r is None


def _depth(item: str, recipe_map: Dict[str, dict], memo: Dict[str, int], stack: Optional[set] = None) -> int:
    if item in memo:
        return memo[item]
    if stack is None:
        stack = set()
    if item in stack:
        # Cycle detected; treat as terminal depth
        memo[item] = 0
        return 0
    stack.add(item)
    r = recipe_map.get(item)
    if not r:
        memo[item] = 0
        stack.discard(item)
        return 0
    if not r['requires']:
        memo[item] = 1
        stack.discard(item)
        return 1
    depths = []
    for k in r['requires'].keys():
        depths.append(_depth(k, recipe_map, memo, stack))
    d = 1 + (max(depths) if depths else 0)
    memo[item] = d
    stack.discard(item)
    return d


def _simulate_expand(belts: Counter, item: str, recipe_map: Dict[str, dict]) -> Counter:
    """Return a new belts Counter after expanding `item` once, merging duplicates."""
    need = float(belts[item])
    new_belts = belts.copy()
    del new_belts[item]
    recipe = recipe_map.get(item)
    if not recipe:
        return new_belts
    reqs = {k: v * need for k, v in recipe['requires'].items()}
    for k, v in reqs.items():
        new_belts[k] += v
    # prune zeros
    for k in list(new_belts.keys()):
        if abs(new_belts[k]) < 1e-12:
            del new_belts[k]
    return new_belts


def _choose_candidate(belts: Counter, recipe_map: Dict[str, dict], max_belts: int = 5) -> str:
    memo_depth: Dict[str, int] = {}
    candidates = [it for it in belts if it in recipe_map]
    if not candidates:
        return ''

    def belt_count(c: Counter) -> int:
        return sum(1 for _ in c.keys())

    scored = []
    for it in candidates:
        after = _simulate_expand(belts, it, recipe_map)
        cnt = belt_count(after)
        depth_score = _depth(it, recipe_map, memo_depth)
        rate = float(belts[it])
        scored.append((it, cnt, depth_score, rate))

    # Prefer keeping belts within limit, then highest depth, then largest rate, then smallest resulting count
    within = [t for t in scored if t[1] <= max_belts]
    if within:
        within.sort(key=lambda x: (-x[2], -x[3], x[1]))
        return within[0][0]
    # Otherwise pick minimal resulting count, then depth, then rate
    scored.sort(key=lambda x: (x[1], -x[2], -x[3]))
    return scored[0][0]


def _stable_inputs5(level_pairs: List[dict], prev_cols: Dict[str, int]) -> Tuple[List[Optional[dict]], int, Dict[str, int]]:
    """Place up to 5 inputs keeping previous column positions when possible, otherwise
    use center-first order. Supports duplicate names by treating each occurrence
    separately. `level_pairs` elements are dicts with keys: name, perMin, src.
    Returns (cells, hiddenCount, new_col_map)."""
    slots: List[Optional[dict]] = [None] * 5
    order = CENTER_FIRST_ORDER

    # First pass: place one occurrence per name into its previous column if available
    placed_prev_idx: set[int] = set()
    placed_counts: Counter = Counter()
    for idx_pair, pair in enumerate(level_pairs):
        name = pair['name']
        per_min = pair['perMin']
        if name in prev_cols and 0 <= prev_cols[name] < 5 and slots[prev_cols[name]] is None and placed_counts[name] == 0:
            slots[prev_cols[name]] = {"name": name, "perMin": per_min, "src": pair.get('src')}
            placed_prev_idx.add(idx_pair)
            placed_counts[name] += 1

    # Second pass: place remaining occurrences center-first
    for idx_pair, pair in enumerate(level_pairs):
        if idx_pair in placed_prev_idx:
            continue
        name = pair['name']
        per_min = pair['perMin']
        for si in order:
            if slots[si] is None:
                slots[si] = {"name": name, "perMin": per_min, "src": pair.get('src')}
                break

    # Count hidden if more than 5 inputs
    hidden = max(0, len(level_pairs) - 5)
    if hidden:
        # Attach to the last filled slot
        for si in reversed(range(5)):
            if slots[si] is not None:
                slots[si]["hiddenCountOnThisSlot"] = hidden
                break

    # Build new col map
    new_cols: Dict[str, int] = {}
    for i, cell in enumerate(slots):
        if cell:
            new_cols[cell["name"]] = i
    return slots, hidden, new_cols


def build_graph_for_chain(chain: Chain, target_rate: float) -> dict:
    """Construct a levelized tower by expanding one belt per level while keeping total
    inputs ≤ 5 and merging identical conversions. The resulting steps are ordered
    top→bottom. Bottom level is 1; top is N.
    """
    # Load recipe map across all chains once per program run; to avoid reloading here,
    # we rebuild it from transformations.json content available in memory via load_transformations().
    # For locality, we recompute from all chains.
    # NOTE: The caller (main) loads all chains; reuse there would need refactor. For simplicity,
    # reload here from file paths already defined.
    all_chains = load_transformations()
    recipe_map = _build_recipe_map(all_chains)

    # Initialize with the target requirement
    belts: Counter = Counter({chain.output: float(target_rate)})

    # Build snapshots top→bottom; each snapshot records belts before and after expanding one item
    snapshots: List[dict] = []

    # Safety to avoid infinite loops in pathological data
    max_levels = 200
    levels = 0
    while levels < max_levels:
        # Candidates are items with a known recipe (non-terminal)
        candidates = [it for it in belts.keys() if it in recipe_map]
        if not candidates:
            break
        chosen = _choose_candidate(belts, recipe_map, max_belts=5)
        if not chosen:
            break
        need = float(belts[chosen])
        rec = recipe_map[chosen]

        # Snapshot belts BEFORE expansion and compute requires/pass-through pairs
        belts_before = belts.copy()
        requires_pairs: List[dict] = [{"name": k, "perMin": v * need, "src": "req"} for k, v in rec['requires'].items()]
        pass_pairs: List[dict] = [{"name": k, "perMin": float(v), "src": "pass"} for k, v in belts_before.items() if k != chosen]

        # Compute new belts after expansion
        new_belts = _simulate_expand(belts, chosen, recipe_map)

        # Record snapshot with explicit inputs
        snapshots.append({
            'belts_before': belts_before,       # Counter-like: feeds into this level
            'belts_after': new_belts,           # Counter-like: feeds next level up
            'requires_pairs': requires_pairs,   # list[(name, perMin)] required by chosen
            'pass_pairs': pass_pairs,           # list[(name, perMin)] passing through unchanged
            'operated': chosen,                 # produced/operated at this level
            'producedAmount': need,             # perMin
            'recipe': rec['recipe'],
            'building': rec['building'],
            'byproducts': {k: v * need for k, v in rec['byproducts'].items()},
        })

        belts = new_belts
        levels += 1

    # Serialize snapshots to steps (top→bottom). numbering: top=N ... bottom=1
    n = len(snapshots)

    steps_out: List[dict] = []
    prev_col_map: Dict[str, int] = {}
    for i, snap in enumerate(snapshots):
        level_index_top_based = n - i

        # Build display list preserving duplicates: pass-through first to stabilize columns, then requires
        level_pairs: List[Tuple[str, float]] = []
        level_pairs.extend(snap.get('pass_pairs') or [])
        level_pairs.extend(snap.get('requires_pairs') or [])

        # Column placement with stability
        inputs5_cells, hidden, new_col_map = _stable_inputs5(level_pairs, prev_col_map)

        # Determine previous row (the one below in the UI)
        prev_row = snapshots[i + 1] if i + 1 < n else None
        prev_outputs_name = prev_row['operated'] if prev_row else None

        # Annotate cells with fromPrev and role based on membership in requires vs pass-through
        # To support duplicates in requires/pass, build multisets by counting occurrences
        req_names_multiset = Counter(cell['name'] for cell in (snap.get('requires_pairs') or []))

        any_match = False
        annotated_cells: List[Optional[dict]] = []
        # Also build a multiset for pass-through for role tagging
        pass_names_multiset = Counter(cell['name'] for cell in (snap.get('pass_pairs') or []))

        for cell in inputs5_cells:
            if cell is None:
                annotated_cells.append(None)
                continue
            name = cell['name']
            from_prev = (prev_outputs_name == name) if prev_outputs_name else False
            # Decide role by checking where this occurrence came from: prefer consuming (requires) over pass if name exists in both
            role = 'pass'
            if req_names_multiset.get(name, 0) > 0:
                role = 'normal'
                req_names_multiset[name] -= 1
            elif pass_names_multiset.get(name, 0) > 0:
                pass_names_multiset[name] -= 1
            if from_prev:
                any_match = True
            cell = {**cell, 'fromPrev': bool(from_prev), 'role': role}
            annotated_cells.append(cell)

        steps_out.append({
            'level': level_index_top_based,
            'displayStep': level_index_top_based,
            'recipe': snap['recipe'],
            'building': snap['building'],
            'inputs5': annotated_cells,
            'hiddenInputsCount': hidden,
            'byproducts': snap['byproducts'],
            'outputs': {snap['operated']: snap['producedAmount']},
            'rowHasPrevMatch': any_match,
        })

        prev_col_map = new_col_map

    result = {
        'target': chain.output,
        'targetRatePerMin': float(target_rate),
        'steps': steps_out,
        'meta': {
            'source': 'transformations.json',
            'tier': chain.tier,
            'index': chain.index,
            'slug': slugify(chain.output or 'item'),
            'notes': ['levelized_scheduler=true']
        }
    }
    return result


def main():
    parser = argparse.ArgumentParser(description="Generate layered graphs for items")
    parser.add_argument('--target', help='Only generate for this item name (exact match)')
    parser.add_argument('--out-dir', default=str(DEFAULT_OUT_DIR), help='Output directory for graphs')
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    chains = load_transformations()
    chains_by_output = {c.output: c for c in chains if c.output}

    targets = load_targets_from_tiers()

    # If --target provided, restrict
    if args.target:
        targets = {k: v for k, v in targets.items() if k == args.target}
        if not targets:
            raise SystemExit(f"Target '{args.target}' not found in tiers.csv")

    # Generate for each target in tiers.csv that also exists in transformations.json
    for name, rate in targets.items():
        chain = chains_by_output.get(name)
        if not chain:
            print(f"[warn] No transformation chain found for '{name}', skipping")
            continue
        graph = build_graph_for_chain(chain, rate)
        slug = graph['meta']['slug']
        path = out_dir / f"{slug}.json"
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(graph, f, ensure_ascii=False, indent=2)
        print(f"Wrote {path}")


if __name__ == '__main__':
    main()
