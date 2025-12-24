#!/usr/bin/env python3
"""
calculate.py

Reads public/full_recipes.json and, for each unique output item, computes:
- Simplified output item name (keep last part after '.', remove 'Desc_' prefix and '_C' suffix)
- The list of raw input items (simplified) required per minute to produce 1 per minute of the output item
- The set of recipes used along the way
- The number of transformations (max depth of recipe chain from raw resources to the output)
- The aggregated by-products produced along the selected chain (non-target outputs from used recipes)

Usage:
  python calculate.py [--target ITEM] [--rate PER_MIN] [--json]

If --target is provided, only that target (simplified name or full path) is computed.
If --rate is provided, computes requirements to produce that PER_MIN rate of the target (default: 1.0 per min).
If --json is provided, outputs machine-readable JSON; otherwise prints a human-readable summary.

Notes:
- A raw resource is defined as an item that has no producing recipe in full_recipes.json.
- If multiple recipes produce the same item, the first one found will be used.
"""
from __future__ import annotations
import argparse
import json
import math
from collections import defaultdict
from dataclasses import dataclass
import csv
from typing import Dict, List, Tuple, Set

RECIPES_PATH = "../public/full-recipes.json"

# Global mapping: full item id -> preferred friendly name (recipe name where the item is first output)
OUTPUT_NAME_MAP: Dict[str, str] = {}


def basic_simplify(item: str) -> str:
    """Pure structural simplification of an item id to a compact code.
    Example: '/Game/.../Desc_IronPlate.Desc_IronPlate_C' -> 'IronPlate'"""
    if not isinstance(item, str):
        return str(item)
    last = item.split('.')[-1]
    s = last
    if s.startswith("Desc_"):
        s = s[len("Desc_"):]
    if s.endswith("_C"):
        s = s[: -len("_C")]
    if s.startswith("Ore"):
        s = s[len("Ore"):] + " Ore"
    if s == "LiquidOil":
        return "Liquid Oil"
    if s == "RawQuartz":
        return "Raw Quartz"
    if s == "Stone":
        return "Limestone"
    if s == "NitrogenGas":
        return "Nitrogen Gas"
    return s


def simplify(item: str) -> str:
    """Preferred human-friendly name.
    If a recipe exists where this item is the first output, use the recipe name;
    otherwise fall back to the structural simplification.
    """
    # Prefer mapped friendly name only when input is a full id present in the map
    if isinstance(item, str) and item in OUTPUT_NAME_MAP:
        return OUTPUT_NAME_MAP[item]
    return basic_simplify(item)


@dataclass
class ItemRate:
    item: str
    perMin: float


@dataclass
class Recipe:
    id: str
    name: str
    inputs: List[ItemRate]
    outputs: List[ItemRate]


def load_recipes(path: str = RECIPES_PATH) -> List[Recipe]:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    recipes: List[Recipe] = []
    for r in data:
        inputs = [ItemRate(i["item"], float(i["perMin"])) for i in r.get("inputs", [])]
        outputs = [ItemRate(o["item"], float(o["perMin"])) for o in r.get("outputs", [])]
        recipes.append(Recipe(id=r.get("id", ""), name=r.get("name", r.get("id", "")), inputs=inputs, outputs=outputs))
    return recipes


def build_output_name_map(recipes: List[Recipe]) -> Dict[str, str]:
    """Build mapping: full output item id -> recipe name, but only when that item
    is the first output of the recipe (primary product)."""
    mapping: Dict[str, str] = {}
    for r in recipes:
        if r.outputs:
            first_item = r.outputs[0].item
            # Only set if not already set; first occurrence wins to be deterministic
            mapping.setdefault(first_item, r.name)
    return mapping


def build_producer_map(recipes: List[Recipe]) -> Dict[str, List[Recipe]]:
    """Map full item identifier -> list of recipes that produce it."""
    prod: Dict[str, List[Recipe]] = defaultdict(list)
    for r in recipes:
        for out in r.outputs:
            prod[out.item].append(r)
    return prod


def _norm(s: str) -> str:
    """Normalize a display name for loose matching against CSV names.
    - strip leading/trailing whitespace
    - collapse internal whitespace to single spaces
    - case-insensitive via lowercasing
    """
    if not isinstance(s, str):
        return str(s)
    s = " ".join(s.split())  # collapses runs of whitespace
    return s.strip().lower()


def load_tiers_csv(path: str = "../public/tiers.csv") -> Dict[str, Tuple[str, int]]:
    """Load tiers.csv and return mapping: normalized name -> (tier, index).
    Index is the 1-based row number in the CSV file (including header line as row 1).
    Tier is kept as string to preserve values like 'MAM'."""
    mapping: Dict[str, Tuple[str, int]] = {}
    try:
        with open(path, newline='', encoding='utf-8') as f:
            reader = csv.reader(f)
            header = next(reader, None)
            # Detect columns if header present; otherwise assume [Tier, Name]
            name_idx = 1
            tier_idx = 0
            if header and len(header) >= 2:
                low = [h.strip().lower() for h in header]
                # find by names
                if 'name' in low:
                    name_idx = low.index('name')
                if 'tier' in low:
                    tier_idx = low.index('tier')
            # Start row numbering at 2 (header is row 1)
            for file_row_number, row in enumerate(reader, start=2):
                if not row or all(not str(x).strip() for x in row):
                    continue
                # Safe access
                name_val = row[name_idx] if len(row) > name_idx else ''
                tier_val = row[tier_idx] if len(row) > tier_idx else ''
                norm_name = _norm(name_val)
                if not norm_name:
                    continue
                mapping[norm_name] = (str(tier_val).strip(), file_row_number)
    except FileNotFoundError:
        # No tiers file, return empty mapping
        print("Fail to load tiers.csv")
        mapping = {}
    return mapping


def choose_recipe_for_item(item: str, producers: Dict[str, List[Recipe]]) -> Recipe | None:
    candidates = producers.get(item)
    if not candidates:
        return None
    # Prefer dedicated (single-output) recipes for the target over byproduct recipes;
    # within the same class, prefer the highest output rate for this item.
    def out_rate_for(r: Recipe) -> float:
        for o in r.outputs:
            if o.item == item:
                return o.perMin
        return 0.0
    def sort_key(r: Recipe):
        is_single_output_for_target = (len(r.outputs) == 1 and any(o.item == item for o in r.outputs))
        return (1 if is_single_output_for_target else 0, out_rate_for(r))
    candidates = sorted(candidates, key=sort_key, reverse=True)
    return candidates[0]


def compute_requirements(
    target_item: str,
    target_rate: float,
    producers: Dict[str, List[Recipe]],
    memo: Dict[Tuple[str, float], Tuple[Dict[str, float], Set[str], int, Dict[str, float]]] | None = None,
    path: Set[str] | None = None,
) -> Tuple[Dict[str, float], Set[str], int, Dict[str, float]]:
    """
    Recursively compute raw input requirements, recipes used, and depth for producing
    `target_item` at `target_rate` per minute.

    Returns tuple: (raw_inputs_map, recipes_used_set, depth, byproducts_map)
      - raw_inputs_map: simplified_item -> perMin float
      - recipes_used_set: set of recipe names used
      - depth: number of transformations (max chain length)
      - byproducts_map: simplified_item -> perMin float (all non-target outputs from recipes along the chain)
    """
    if memo is None:
        memo = {}
    if path is None:
        path = set()
    # Detect cycles: if we revisit the same item in the current expansion path,
    # stop recursion and treat it as a raw requirement to avoid infinite loops.
    if target_item in path:
        raw = {simplify(target_item): target_rate}
        result = (raw, set(), 0, {})
        return result
    # We don't memoize on float directly to avoid blowup; quantize rate a bit
    key = (target_item, round(target_rate, 6))
    if key in memo:
        return memo[key]

    recipe = choose_recipe_for_item(target_item, producers)
    if recipe is None:
        # Raw resource; no transformations. Count as base case.
        raw = {simplify(target_item): target_rate}
        result = (raw, set(), 0, {})
        memo[key] = result
        return result

    # Find this item's output rate in the recipe
    out_rate = None
    for o in recipe.outputs:
        if o.item == target_item:
            out_rate = o.perMin
            break
    if not out_rate or out_rate <= 0:
        # Defensive: treat as raw if malformed
        raw = {simplify(target_item): target_rate}
        result = (raw, set(), 0, {})
        memo[key] = result
        return result

    scale = target_rate / out_rate

    total_raw: Dict[str, float] = defaultdict(float)
    recipes_used: Set[str] = {recipe.name}
    max_depth = 0
    byproducts: Dict[str, float] = defaultdict(float)

    # Add byproducts from the current recipe (all outputs except the targeted one)
    for o in recipe.outputs:
        if o.item != target_item:
            byproducts[simplify(o.item)] += o.perMin * scale

    for inp in recipe.inputs:
        needed = inp.perMin * scale
        sub_raw, sub_recipes, sub_depth, sub_byprod = compute_requirements(
            inp.item,
            needed,
            producers,
            memo,
            path | {target_item},
        )
        for k, v in sub_raw.items():
            total_raw[k] += v
        for k, v in sub_byprod.items():
            byproducts[k] += v
        recipes_used.update(sub_recipes)
        max_depth = max(max_depth, sub_depth)

    depth = 1 + max_depth if recipe.inputs else 1
    result = (dict(total_raw), recipes_used, depth, dict(byproducts))
    memo[key] = result
    return result


def find_unique_output_items(recipes: List[Recipe]) -> Set[str]:
    unique: Set[str] = set()
    for r in recipes:
        for o in r.outputs:
            unique.add(o.item)
    return unique


def to_readable_number(x: float) -> float:
    # Keep two decimals, trim tiny floating noise
    y = round(x + 1e-10, 4)
    # Keep 0.0 for tiny values
    if abs(y) < 1e-6:
        return 0.0
    return y


def main():
    parser = argparse.ArgumentParser(description="Compute recipe chains and raw input requirements.")
    parser.add_argument("--target", dest="target", help="Target item to compute (simplified name or full path). If omitted, computes for all unique outputs.")
    parser.add_argument("--rate", dest="rate", type=float, default=1.0, help="Target production rate per minute (default: 1.0)")
    parser.add_argument("--json", dest="as_json", action="store_true", help="Output JSON instead of text")
    args = parser.parse_args()

    recipes = load_recipes(RECIPES_PATH)
    # Initialize friendly output name mapping
    global OUTPUT_NAME_MAP
    OUTPUT_NAME_MAP = build_output_name_map(recipes)
    producers = build_producer_map(recipes)
    # Load tiers mapping from CSV (normalized name -> (tier, index))
    tiers_map = load_tiers_csv("../public/tiers.csv")

    targets: List[str]
    if args.target:
        # Accept either simplified (structural) name, friendly recipe-based name, or full path
        unique_outputs = list(find_unique_output_items(recipes))
        inp_basic = basic_simplify(args.target)
        inp_friendly = args.target  # if user typed a friendly name directly
        candidates = []
        for it in unique_outputs:
            names_for_it = {basic_simplify(it), simplify(it)}
            if inp_basic in names_for_it or inp_friendly in names_for_it or args.target == it:
                candidates.append(it)
        if not candidates:
            # Fallback: assume target is a full path or already correct string
            candidates = [args.target]
        targets = [candidates[0]]
    else:
        targets = sorted(find_unique_output_items(recipes))

    results = []
    for item in targets:
        simplified_item = simplify(item)
        raw_inputs, used_recipes, depth, byproducts = compute_requirements(item, args.rate, producers)
        # Normalize numbers
        raw_inputs = {k: to_readable_number(v) for k, v in sorted(raw_inputs.items())}
        # Remove any accidental inclusion of the target item itself as a by-product
        if simplified_item in byproducts:
            del byproducts[simplified_item]
        byproducts = {k: to_readable_number(v) for k, v in sorted(byproducts.items())}
        results.append({
            "target": simplified_item,
            "targetFull": item,
            "rate": args.rate,
            "rawInputsPerMin": raw_inputs,
            "recipesUsed": sorted(used_recipes),
            "transformations": int(depth),
            "byProductsPerMin": byproducts,
        })

    # If no specific target requested, write the full transformations file
    if not args.target:
        transformations = []
        for r in results:
            inputs_list = [{"name": k, "perMin": v} for k, v in r["rawInputsPerMin"].items()]
            byproducts_list = [{"name": k, "perMin": v} for k, v in r.get("byProductsPerMin", {}).items() if v != 0]
            # Determine if the direct recipe for this output is a Space Elevator project part
            direct_recipe = choose_recipe_for_item(r["targetFull"], producers)
            project_parts = bool(direct_recipe and direct_recipe.id.startswith("Recipe_SpaceElevatorPart_"))

            # Lookup tier and index from CSV by normalized friendly output name
            t_tier = None
            t_index = None
            key = _norm(r["target"]) if r.get("target") else None
            if key and key in tiers_map:
                t_tier, t_index = tiers_map[key]

            transformations.append({
                "output": r["target"],
                "inputs": inputs_list,
                "byProducts": byproducts_list,
                "Recipes": r["recipesUsed"],
                "projectParts": project_parts,
                "tier": t_tier,
                "index": t_index,
            })
        out_path = "../public/transformations.json"
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(transformations, f, indent=2)
        print(f"Wrote {len(transformations)} transformations to {out_path}")
    else:
        # Preserve previous behavior for targeted queries
        if args.as_json:
            print(json.dumps(results, indent=2))
        else:
            for r in results:
                print(f"=== {r['target']} (rate: {r['rate']}/min, transformations: {r['transformations']}) ===")
                if not r["rawInputsPerMin"]:
                    print("  Raw inputs: (none)")
                else:
                    print("  Raw inputs (per min):")
                    for k, v in r["rawInputsPerMin"].items():
                        print(f"    - {k}: {v}")
                if r.get("byProductsPerMin"):
                    print("  By-products (per min):")
                    for k, v in r["byProductsPerMin"].items():
                        print(f"    - {k}: {v}")
                if r["recipesUsed"]:
                    print("  Recipes used:")
                    for name in r["recipesUsed"]:
                        print(f"    - {name}")
                print()


if __name__ == "__main__":
    main()
