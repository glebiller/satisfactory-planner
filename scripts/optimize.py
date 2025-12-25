#!/usr/bin/env python3
"""
Optimize production chains to meet constraints:
1. Maximum 5 raw inputs
2. Minimize liquid/gas inputs
3. Maximum 5 concurrent "lanes" (belts) at any transformation step
"""
import json
from collections import defaultdict
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
ITEMS_DATA_PATH = SCRIPT_DIR / '../public/1-items-data.json'
TRANSFORMATIONS_PATH = SCRIPT_DIR / '../public/transformations.json'

LIQUID_GAS_CATEGORIES = {'fluid', 'gas'}
MAX_RAW_INPUTS = 5
MAX_LANES = 5


def load_data():
    with open(ITEMS_DATA_PATH, 'r') as f:
        items = json.load(f)
    
    with open(TRANSFORMATIONS_PATH, 'r') as f:
        transformations = json.load(f)
    
    item_category_map = {item_data['name']: item_data.get('category') for key, item_data in items.items()}
    
    return items, transformations, item_category_map


def is_liquid_or_gas(item_name, item_category_map):
    category = item_category_map.get(item_name)
    return category in LIQUID_GAS_CATEGORIES


def count_lanes_at_step(step, accumulated_intermediates):
    required_items = set(step['requires'].keys())
    produced_items = set(step['produces'].keys())
    
    available_items = accumulated_intermediates.copy()
    
    items_to_bring = 0
    for req_item in required_items:
        if req_item in available_items and available_items[req_item] > 0:
            available_items[req_item] -= 1
        else:
            items_to_bring += 1
    
    total_lanes = items_to_bring + len(available_items)
    
    new_accumulated = available_items.copy()
    for prod_item in produced_items:
        new_accumulated[prod_item] = new_accumulated.get(prod_item, 0) + 1
    
    return total_lanes, new_accumulated


def compute_max_lanes(transformation):
    steps = transformation.get('transformation_steps', [])
    if not steps:
        return 0
    
    accumulated_intermediates = defaultdict(int)
    max_lanes = 0
    
    for step in steps:
        lanes_at_step, accumulated_intermediates = count_lanes_at_step(step, accumulated_intermediates)
        max_lanes = max(max_lanes, lanes_at_step)
    
    return max_lanes


def analyze_transformation(transformation, item_category_map):
    inputs = transformation.get('inputs', [])
    num_inputs = len(inputs)
    
    liquid_gas_inputs = [i['name'] for i in inputs if is_liquid_or_gas(i['name'], item_category_map)]
    num_liquid_gas = len(liquid_gas_inputs)
    
    max_lanes = compute_max_lanes(transformation)
    
    return {
        'output': transformation['output'],
        'index': transformation['index'],
        'tier': transformation['tier'],
        'num_inputs': num_inputs,
        'inputs': [i['name'] for i in inputs],
        'liquid_gas_inputs': liquid_gas_inputs,
        'num_liquid_gas': num_liquid_gas,
        'max_lanes': max_lanes,
        'num_steps': transformation['num_steps'],
        'exceeds_input_limit': num_inputs > MAX_RAW_INPUTS,
        'has_liquids': num_liquid_gas > 0,
        'exceeds_lane_limit': max_lanes > MAX_LANES
    }


def suggest_intermediate_stops(transformation, item_category_map):
    steps = transformation.get('transformation_steps', [])
    
    intermediate_products = defaultdict(int)
    for step in steps:
        for prod_item in step['produces'].keys():
            if prod_item != transformation['output']:
                intermediate_products[prod_item] += 1
    
    candidates = []
    for item, usage_count in intermediate_products.items():
        if usage_count >= 2 and not is_liquid_or_gas(item, item_category_map):
            candidates.append((item, usage_count))
    
    candidates.sort(key=lambda x: x[1], reverse=True)
    return candidates[:5]


def main():
    items, transformations, item_category_map = load_data()
    
    print("=" * 80)
    print("PRODUCTION CHAIN OPTIMIZATION ANALYSIS")
    print("=" * 80)
    print(f"\nConstraints:")
    print(f"  - Max raw inputs: {MAX_RAW_INPUTS}")
    print(f"  - Max concurrent lanes: {MAX_LANES}")
    print(f"  - Avoid liquids/gases when possible")
    print()
    
    issues = []
    
    for transformation in transformations:
        analysis = analyze_transformation(transformation, item_category_map)
        
        has_issue = (analysis['exceeds_input_limit'] or 
                     analysis['has_liquids'] or 
                     analysis['exceeds_lane_limit'])
        
        if has_issue:
            issues.append(analysis)
    
    if not issues:
        print("✓ All transformations meet constraints!")
        return
    
    print(f"Found {len(issues)} transformations with issues:\n")
    
    for analysis in sorted(issues, key=lambda x: (x['num_inputs'], x['max_lanes']), reverse=True):
        print(f"[{analysis['index']}] {analysis['output']} (Tier {analysis['tier']})")
        
        if analysis['exceeds_input_limit']:
            print(f"  ⚠ Too many inputs: {analysis['num_inputs']} > {MAX_RAW_INPUTS}")
            print(f"    Inputs: {', '.join(analysis['inputs'])}")
        
        if analysis['has_liquids']:
            print(f"  ⚠ Uses {analysis['num_liquid_gas']} liquid/gas: {', '.join(analysis['liquid_gas_inputs'])}")
        
        if analysis['exceeds_lane_limit']:
            print(f"  ⚠ Exceeds lane limit: {analysis['max_lanes']} > {MAX_LANES}")
        
        transformation = next(t for t in transformations if t['output'] == analysis['output'])
        candidates = suggest_intermediate_stops(transformation, item_category_map)
        if candidates:
            print(f"  💡 Suggested intermediate stops:")
            for item, usage in candidates[:3]:
                print(f"     - {item} (used {usage} times)")
        
        print()
    
    print("=" * 80)
    print("\nSUMMARY")
    print("=" * 80)
    
    exceeds_inputs = sum(1 for a in issues if a['exceeds_input_limit'])
    has_liquids = sum(1 for a in issues if a['has_liquids'])
    exceeds_lanes = sum(1 for a in issues if a['exceeds_lane_limit'])
    
    print(f"Transformations exceeding input limit: {exceeds_inputs}")
    print(f"Transformations with liquids/gases: {has_liquids}")
    print(f"Transformations exceeding lane limit: {exceeds_lanes}")
    print()
    
    print("RECOMMENDATIONS:")
    print("1. Add suggested intermediate products to STOP_AT_ITEMS in calculate.py")
    print("2. Re-run calculate.py to regenerate transformations")
    print("3. Run this script again to verify improvements")


if __name__ == '__main__':
    main()
