#!/usr/bin/env python3
"""
Build layered transformation graphs for selected items using the inputs list
from transformations.json (which respects stop ingredients). We merge duplicate
recipes into single layers and ensure all raw inputs start at the bottom (Level 1)
and flow upward through the tower.

Steps are topologically sorted so that each layer only consumes items that were
either produced in previous layers or are raw inputs.

The tower is built bottom-up: level 1 is at the bottom, and each level's
outputs feed into the level above it.

CLI
- No args: generate graphs for every item in tiers.csv.
- --target "Name": only for the specified item (exact match on Name column).
- --out-dir path: override output directory (default: public/graphs).
"""
from __future__ import annotations
import argparse
import csv
import json
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

ROOT = Path(__file__).resolve().parent.parent
PUBLIC_DIR = ROOT / 'public'
TRANSFORMATIONS_PATH = PUBLIC_DIR / 'transformations.json'
TIERS_CSV_PATH = PUBLIC_DIR / 'tiers.csv'
DEFAULT_OUT_DIR = PUBLIC_DIR / 'graphs'

CENTER_FIRST_ORDER = [2, 1, 3, 0, 4]

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
    raw_inputs: set[str]
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
        raw_inputs = set(inp['name'] for inp in row.get('inputs', []))
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
                raw_inputs=raw_inputs,
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


def _place_lanes_stable(items: List[Tuple[str, float, str]], prev_col_map: Dict[str, int]) -> Tuple[List[Optional[dict]], Dict[str, int]]:
    lanes: List[Optional[dict]] = [None] * 5
    order = CENTER_FIRST_ORDER

    placed_idx: set[int] = set()
    new_col_map: Dict[str, int] = {}

    for idx, (name, per_min, action) in enumerate(items):
        if name in prev_col_map and 0 <= prev_col_map[name] < 5 and lanes[prev_col_map[name]] is None:
            col = prev_col_map[name]
            lanes[col] = {"name": name, "perMin": per_min, "action": action}
            placed_idx.add(idx)
            new_col_map[name] = col

    for idx, (name, per_min, action) in enumerate(items):
        if idx in placed_idx:
            continue
        for si in order:
            if lanes[si] is None:
                lanes[si] = {"name": name, "perMin": per_min, "action": action}
                new_col_map[name] = si
                break

    return lanes, new_col_map


def filter_and_merge_steps(steps: List[Step], raw_inputs: set[str]) -> List[Step]:
    """Filter steps to exclude raw input production, then merge duplicate recipes."""
    filtered = []
    for step in steps:
        produces_raw = any(prod in raw_inputs for prod in step.produces.keys())
        if not produces_raw:
            filtered.append(step)
    
    merged_by_recipe: Dict[str, Step] = {}
    for step in filtered:
        if step.recipe in merged_by_recipe:
            existing = merged_by_recipe[step.recipe]
            for k, v in step.produces.items():
                existing.produces[k] = existing.produces.get(k, 0) + v
            for k, v in step.requires.items():
                existing.requires[k] = existing.requires.get(k, 0) + v
            for k, v in step.byproducts.items():
                existing.byproducts[k] = existing.byproducts.get(k, 0) + v
        else:
            merged_by_recipe[step.recipe] = Step(
                recipe=step.recipe,
                building=step.building,
                produces=dict(step.produces),
                requires=dict(step.requires),
                byproducts=dict(step.byproducts),
            )
    
    return list(merged_by_recipe.values())


def topological_sort_steps(steps: List[Step], raw_inputs: Set[str]) -> List[Step]:
    """Sort steps so that producers come before consumers.
    Uses topological sort based on item dependencies.
    """
    available_items = set(raw_inputs)
    sorted_steps = []
    remaining_steps = list(steps)
    
    max_iterations = len(steps) * 2
    iteration = 0
    
    while remaining_steps and iteration < max_iterations:
        iteration += 1
        made_progress = False
        
        for step in remaining_steps[:]:
            all_requirements_met = all(req in available_items for req in step.requires.keys())
            
            if all_requirements_met:
                sorted_steps.append(step)
                remaining_steps.remove(step)
                for produced_item in step.produces.keys():
                    available_items.add(produced_item)
                made_progress = True
        
        if not made_progress:
            break
    
    if remaining_steps:
        sorted_steps.extend(remaining_steps)
    
    return sorted_steps


def build_graph_from_steps(chain: Chain, target_rate: float) -> dict:
    """Build a graph from transformation steps, stopping at raw inputs.
    Steps are merged, topologically sorted, so level 1 is at the bottom.
    All raw inputs start at level 1 and flow upward.
    """
    merged_steps = filter_and_merge_steps(chain.steps, chain.raw_inputs)
    sorted_steps = topological_sort_steps(merged_steps, chain.raw_inputs)
    n = len(sorted_steps)
    
    rows_out: List[dict] = []
    prev_col_map: Dict[str, int] = {}
    
    total_raw_inputs_needed = Counter()
    for step in sorted_steps:
        for req_name, req_qty in step.requires.items():
            if req_name in chain.raw_inputs:
                total_raw_inputs_needed[req_name] += req_qty * target_rate
    
    all_inputs_on_belts = Counter(total_raw_inputs_needed)
    
    for step_idx in range(n):
        step = sorted_steps[step_idx]
        level_index = step_idx + 1
        
        produced_items = step.produces
        required_items = step.requires
        
        layer_items = []
        for name, qty in required_items.items():
            scaled_qty = qty * target_rate
            layer_items.append((name, scaled_qty, 'consume'))
        
        for name, qty in all_inputs_on_belts.items():
            if name not in required_items:
                layer_items.append((name, qty, 'pass'))
        
        lanes, new_col_map = _place_lanes_stable(layer_items, prev_col_map)
        
        scaled_produces = {k: v * target_rate for k, v in produced_items.items()}
        scaled_byproducts = {k: v * target_rate for k, v in step.byproducts.items()}
        
        rows_out.append({
            'rowType': 'layer',
            'level': level_index,
            'recipe': step.recipe,
            'building': step.building,
            'operation': 'produces',
            'produces': scaled_produces,
            'consumes': {k: v * target_rate for k, v in required_items.items()},
            'lanes': lanes,
            'byproducts': scaled_byproducts
        })
        
        for req_name, req_qty in required_items.items():
            scaled_req_qty = req_qty * target_rate
            if req_name in all_inputs_on_belts:
                all_inputs_on_belts[req_name] -= scaled_req_qty
                if all_inputs_on_belts[req_name] <= 1e-9:
                    del all_inputs_on_belts[req_name]
        
        belt_items = []
        for name, qty in scaled_produces.items():
            belt_items.append((name, qty, 'fromBelow'))
        
        for name, qty in all_inputs_on_belts.items():
            belt_items.append((name, qty, 'pass'))
        
        belt_lanes, updated_col_map = _place_lanes_stable(belt_items, new_col_map)
        
        rows_out.append({
            'rowType': 'belts',
            'level': level_index,
            'lanes': belt_lanes
        })
        
        prev_col_map = updated_col_map

    result = {
        'target': chain.output,
        'targetRatePerMin': float(target_rate),
        'rows': rows_out,
        'meta': {
            'source': 'transformations.json',
            'tier': chain.tier,
            'index': chain.index,
            'slug': slugify(chain.output or 'item'),
            'notes': ['topologically_sorted_v7']
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

    if args.target:
        targets = {k: v for k, v in targets.items() if k == args.target}
        if not targets:
            raise SystemExit(f"Target '{args.target}' not found in tiers.csv")

    for name, rate in targets.items():
        chain = chains_by_output.get(name)
        if not chain:
            print(f"[warn] No transformation chain found for '{name}', skipping")
            continue
        graph = build_graph_from_steps(chain, rate)
        slug = graph['meta']['slug']
        path = out_dir / f"{slug}.json"
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(graph, f, ensure_ascii=False, indent=2)
        print(f"Wrote {path}")


if __name__ == '__main__':
    main()
