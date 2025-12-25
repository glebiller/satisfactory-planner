#!/usr/bin/env python3
"""
Intelligently optimize production chains by finding minimal intermediate stops
to meet the 5 input constraint. Only stops at intermediates when necessary.
"""
import json
import csv
from collections import defaultdict
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
ITEMS_DATA_PATH = SCRIPT_DIR / '../public/1-items-data.json'
RECIPES_DATA_PATH = SCRIPT_DIR / '../public/1-recipes-data.json'
TIERS_CSV_PATH = SCRIPT_DIR / '../public/tiers.csv'
OUTPUT_PATH = SCRIPT_DIR / '../public/transformations.json'

RAW_RESOURCE_CATEGORIES = {'ore', 'fluid', 'gas'}

ALWAYS_STOP = {'Plastic', 'Rubber', 'Aluminum Ingot', 'Cooling System', 'Radio Control Unit',
                "Fused Modular Frame"}

ITEM_SPECIFIC_STOPS = {
    'Thermal Propulsion Rocket': {'Turbo Motor'},
    'Superposition Oscillator': {'Crystal Oscillator'},
    'AI Expansion Server': {'Superposition Oscillator', 'Neural-Quantum Processor',
                            'Electromagnetic Control Rod', 'Versatile Framework'},
    'Ballistic Warp Drive': {'AI Expansion Server', 'Superposition Oscillator', 'Singularity Cell'}
}

MAX_INPUTS = 5


def extract_building_name(produced_in_path):
    if not produced_in_path:
        return None
    parts = produced_in_path.split('/')
    for part in reversed(parts):
        if part.startswith('Build_'):
            name = part.replace('Build_', '').replace('_C', '')
            if '.' in name:
                name = name.split('.', 1)[1]
            return name
    return None


def load_data():
    with open(ITEMS_DATA_PATH, 'r') as f:
        items = json.load(f)
    
    with open(RECIPES_DATA_PATH, 'r') as f:
        recipes = json.load(f)
    
    with open(TIERS_CSV_PATH, 'r') as f:
        reader = csv.DictReader(f)
        target_items = [(idx + 1, row['Tier'], row['Name']) for idx, row in enumerate(reader)]
    
    item_key_map = {item_data['name']: key for key, item_data in items.items()}
    item_category_map = {item_data['name']: item_data.get('category') for key, item_data in items.items()}
    
    recipes_by_output = defaultdict(list)
    for recipe_key, recipe_data in recipes.items():
        for output_key, output_qty in recipe_data['produce'].items():
            output_name = items.get(output_key, {}).get('name')
            if output_name:
                recipes_by_output[output_name].append(recipe_data)
    
    return items, recipes, target_items, item_key_map, item_category_map, recipes_by_output


def is_raw_resource(item_name, item_category_map):
    category = item_category_map.get(item_name)
    return category in RAW_RESOURCE_CATEGORIES


def compute_production_chain(target_item, items, item_key_map, item_category_map, recipes_by_output, quantity=1.0, visited=None, is_root=True, stop_at_items=None, root_item=None):
    if stop_at_items is None:
        stop_at_items = set()
    
    if root_item is None:
        root_item = target_item
    
    if visited is None:
        visited = set()
    
    if target_item in visited:
        return {
            'item': target_item,
            'quantity': quantity,
            'is_cycle': True,
            'raw_ingredients': {target_item: quantity},
            'steps': []
        }
    
    effective_stops = stop_at_items.copy()
    if root_item in ITEM_SPECIFIC_STOPS:
        effective_stops |= ITEM_SPECIFIC_STOPS[root_item]
    
    if not is_root and target_item in effective_stops:
        return {
            'item': target_item,
            'quantity': quantity,
            'raw_ingredients': {target_item: quantity},
            'steps': []
        }
    
    available_recipes = recipes_by_output.get(target_item, [])
    if not available_recipes:
        return {
            'item': target_item,
            'quantity': quantity,
            'raw_ingredients': {target_item: quantity},
            'steps': []
        }
    
    if is_raw_resource(target_item, item_category_map) and not available_recipes:
        return {
            'item': target_item,
            'quantity': quantity,
            'raw_ingredients': {target_item: quantity},
            'steps': []
        }
    
    recipe = available_recipes[0]
    
    target_item_key = item_key_map.get(target_item)
    if not target_item_key:
        return {
            'item': target_item,
            'quantity': quantity,
            'raw_ingredients': {target_item: quantity},
            'steps': []
        }
    
    recipe_output_qty = recipe['produce'].get(target_item_key, 1)
    ratio = quantity / recipe_output_qty
    
    building = None
    if recipe.get('mProducedIn'):
        building = extract_building_name(recipe['mProducedIn'][0])
    
    step = {
        'recipe': recipe['name'],
        'building': building,
        'produces': {target_item: quantity},
        'requires': {},
        'byproducts': {}
    }
    
    for output_key, output_qty in recipe['produce'].items():
        output_name = items.get(output_key, {}).get('name')
        if output_name and output_name != target_item:
            step['byproducts'][output_name] = output_qty * ratio
    
    raw_ingredients = defaultdict(float)
    ingredient_chains = []
    
    visited_with_current = visited | {target_item}
    
    has_ingredients = bool(recipe.get('ingredients'))
    
    if has_ingredients:
        for ingredient_key, ingredient_qty in recipe['ingredients'].items():
            ingredient_name = items.get(ingredient_key, {}).get('name')
            if not ingredient_name:
                continue
            
            required_qty = ingredient_qty * ratio
            step['requires'][ingredient_name] = required_qty
            
            ingredient_chain = compute_production_chain(
                ingredient_name, 
                items, 
                item_key_map, 
                item_category_map, 
                recipes_by_output, 
                required_qty, 
                visited_with_current,
                is_root=False,
                stop_at_items=stop_at_items,
                root_item=root_item
            )
            ingredient_chains.append(ingredient_chain)
            
            for raw_item, raw_qty in ingredient_chain['raw_ingredients'].items():
                raw_ingredients[raw_item] += raw_qty
    
    all_steps = [step]
    for chain in ingredient_chains:
        all_steps.extend(chain.get('steps', []))
    
    return {
        'item': target_item,
        'quantity': quantity,
        'raw_ingredients': dict(raw_ingredients),
        'steps': all_steps
    }


def find_best_intermediate_stops(target_item, items, item_key_map, item_category_map, recipes_by_output):
    base_stops = ALWAYS_STOP.copy()
    if target_item in ITEM_SPECIFIC_STOPS:
        base_stops |= ITEM_SPECIFIC_STOPS[target_item]
    
    base_chain = compute_production_chain(
        target_item, items, item_key_map, item_category_map, recipes_by_output,
        quantity=1.0, stop_at_items=base_stops, root_item=target_item
    )
    
    num_inputs = len(base_chain['raw_ingredients'])
    
    if num_inputs <= MAX_INPUTS:
        return base_chain, set()
    
    steps = base_chain.get('steps', [])
    
    intermediate_candidates = defaultdict(int)
    for step in steps:
        for prod_item in step['produces'].keys():
            if prod_item != target_item:
                intermediate_candidates[prod_item] += 1
    
    candidates = [(item, count) for item, count in intermediate_candidates.items() 
                  if not is_raw_resource(item, item_category_map)]
    candidates.sort(key=lambda x: x[1], reverse=True)
    
    best_chain = base_chain
    best_stops = base_stops.copy()
    
    for i in range(len(candidates)):
        for candidate_item, _ in candidates[:i+1]:
            test_stops = base_stops | {candidate_item}
            
            test_chain = compute_production_chain(
                target_item, items, item_key_map, item_category_map, recipes_by_output,
                quantity=1.0, stop_at_items=test_stops, root_item=target_item
            )
            
            num_test_inputs = len(test_chain['raw_ingredients'])
            
            if num_test_inputs <= MAX_INPUTS:
                if num_test_inputs < len(best_chain['raw_ingredients']):
                    best_chain = test_chain
                    best_stops = test_stops.copy()
                    break
        
        if len(best_chain['raw_ingredients']) <= MAX_INPUTS:
            break
    
    item_specific = ITEM_SPECIFIC_STOPS.get(target_item, set())
    return best_chain, (best_stops - ALWAYS_STOP - item_specific)


def format_transformation(index, tier, item_name, chain):
    raw_ingredients = chain['raw_ingredients']
    steps = chain['steps']
    
    inputs = []
    for raw_item, raw_qty in sorted(raw_ingredients.items()):
        inputs.append({
            'name': raw_item,
            'quantity': round(raw_qty, 4)
        })
    
    byproducts = {}
    for step in steps:
        for byproduct, qty in step.get('byproducts', {}).items():
            byproducts[byproduct] = byproducts.get(byproduct, 0) + qty
    
    byproducts_list = []
    for byproduct, qty in sorted(byproducts.items()):
        byproducts_list.append({
            'name': byproduct,
            'quantity': round(qty, 4)
        })
    
    transformation_steps = []
    for step in steps:
        transformation_steps.append({
            'recipe': step['recipe'],
            'building': step['building'],
            'produces': {k: round(v, 4) for k, v in step['produces'].items()},
            'requires': {k: round(v, 4) for k, v in step['requires'].items()},
            'byproducts': {k: round(v, 4) for k, v in step.get('byproducts', {}).items()}
        })
    
    return {
        'index': index,
        'tier': tier,
        'output': item_name,
        'output_quantity': round(chain['quantity'], 4),
        'inputs': inputs,
        'byproducts': byproducts_list,
        'num_steps': len(steps),
        'transformation_steps': transformation_steps
    }


def main():
    items, recipes, target_items, item_key_map, item_category_map, recipes_by_output = load_data()
    
    transformations = []
    optimizations = []
    
    for index, tier, item_name in target_items:
        print(f"Computing production chain for {item_name} (Tier {tier})...")
        
        chain, intermediate_stops = find_best_intermediate_stops(
            item_name, 
            items, 
            item_key_map, 
            item_category_map, 
            recipes_by_output
        )
        
        num_inputs = len(chain['raw_ingredients'])
        
        if intermediate_stops:
            print(f"  → Optimized: {num_inputs} inputs (stopped at: {', '.join(sorted(intermediate_stops))})")
            optimizations.append({
                'item': item_name,
                'stops': sorted(intermediate_stops),
                'num_inputs': num_inputs
            })
        elif num_inputs > MAX_INPUTS:
            print(f"  ⚠ Could not optimize to {MAX_INPUTS} inputs (has {num_inputs})")
        
        transformation = format_transformation(index, tier, item_name, chain)
        transformations.append(transformation)
    
    with open(OUTPUT_PATH, 'w') as f:
        json.dump(transformations, f, indent=2)
    
    print(f"\nGenerated {len(transformations)} transformations")
    print(f"Optimized {len(optimizations)} items with intermediate stops")
    
    if optimizations:
        print("\nOptimizations applied:")
        for opt in optimizations:
            print(f"  {opt['item']}: {opt['num_inputs']} inputs, stopped at {', '.join(opt['stops'])}")
    
    print(f"\nOutput written to {OUTPUT_PATH}")


if __name__ == '__main__':
    main()
