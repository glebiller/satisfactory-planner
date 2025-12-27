import json
import csv
import collections
import sys
from pathlib import Path

# --- Configuration & Constants ---
INPUT_LIMIT = 5
MAX_STEPS = 1000  # Safety cutoff for deep chains

# Items that should never be decomposed further
ALWAYS_STOP = {
    'Plastic', 'Rubber', 'Aluminum Ingot', 'Cooling System',
    'Radio Control Unit', "Fused Modular Frame"
}

# Context-aware stops
ITEM_SPECIFIC_STOPS = {
    'Thermal Propulsion Rocket': {'Turbo Motor'},
    'Superposition Oscillator': {'Crystal Oscillator'},
    'AI Expansion Server': {'Superposition Oscillator', 'Neural-Quantum Processor',
                            'Electromagnetic Control Rod', 'Versatile Framework'},
    'Ballistic Warp Drive': {'AI Expansion Server', 'Superposition Oscillator', 'Singularity Cell'}
}

# Raw categories to automatically stop at (prevents mining loops)
RAW_CATEGORIES = {'ore', 'fluid', 'gas', 'raw'}

# --- Paths ---
ROOT = Path(__file__).resolve().parent.parent if '__file__' in locals() else Path('.').resolve()
PUBLIC_DIR = ROOT / 'public'
PUBLIC_DIR.mkdir(parents=True, exist_ok=True)

TIERS_CSV_PATH = PUBLIC_DIR / 'tiers.csv'
TRANSFORMATIONS_PATH = PUBLIC_DIR / 'transformations_graphs.json'
ITEM_DATA_PATH = PUBLIC_DIR / '1-items-data.json'
RECIPES_DATA_PATH = PUBLIC_DIR / '1-recipes-data.json'

# --- Data Manager ---

class DataManager:
    def __init__(self, items_file, recipes_file):
        self.name_to_id = {}
        self.id_to_name = {}
        self.item_categories = {}
        self.recipes_by_product = {}

        self.load_items(items_file)
        self.load_recipes(recipes_file)

    def load_items(self, filepath):
        if not filepath.exists():
            print(f"Error: {filepath} not found.")
            return
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)
            for uid, info in data.items():
                name = info.get('name')
                self.id_to_name[uid] = name
                self.name_to_id[name] = uid
                self.item_categories[uid] = info.get('category', 'part')

    def load_recipes(self, filepath):
        if not filepath.exists():
            print(f"Error: {filepath} not found.")
            return
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)
            for recipe in data.values():
                if 'produce' in recipe:
                    for prod_id, amount in recipe['produce'].items():
                        # Filter self-loops (e.g. Ore -> Ore)
                        if prod_id in recipe.get('ingredients', {}):
                            continue

                        self.recipes_by_product[prod_id] = {
                            'id': recipe.get('id'),
                            'name': recipe.get('name'),
                            'ingredients': recipe.get('ingredients', {}),
                            'produce': recipe.get('produce', {}), # Store full produce for byproducts
                            'product_amount': amount,
                            'produce_id': prod_id
                        }

    def get_id(self, name):
        return self.name_to_id.get(name)

    def get_name(self, uid):
        return self.id_to_name.get(uid, uid)

    def get_recipe(self, product_id):
        return self.recipes_by_product.get(product_id)

    def is_raw_resource(self, item_id):
        cat = self.item_categories.get(item_id, '')
        if cat in RAW_CATEGORIES:
            return True
        return False

# --- Solver Logic ---

class ProductionSolver:
    def __init__(self, data_mgr):
        self.mgr = data_mgr

    def solve(self, target_name, target_amount):
        target_id = self.mgr.get_id(target_name)
        if not target_id:
            return None, None, None

        # --- Phase 1: Backward Search (Planning) ---
        current_bus = collections.Counter()
        current_bus[target_id] = float(target_amount)

        steps = []
        visited_states = set()

        step_count = 0
        while step_count < MAX_STEPS:
            step_count += 1

            state_key = tuple(sorted([(k, round(v, 4)) for k, v in current_bus.items() if v > 1e-6]))
            if state_key in visited_states:
                break
            visited_states.add(state_key)

            candidates = []
            bus_items = [k for k, v in current_bus.items() if v > 1e-6]

            if not bus_items:
                break 

            for item_id in bus_items:
                item_name = self.mgr.get_name(item_id)

                if item_name in ALWAYS_STOP:
                    continue
                if self.mgr.is_raw_resource(item_id):
                    continue
                if target_name in ITEM_SPECIFIC_STOPS and \
                        item_name in ITEM_SPECIFIC_STOPS[target_name]:
                    continue

                recipe = self.mgr.get_recipe(item_id)
                if not recipe:
                    continue

                ingredients = recipe['ingredients']
                current_keys = {k for k, v in current_bus.items() if v > 1e-6}
                potential_keys = set(current_keys)
                potential_keys.discard(item_id)
                for ing_id in ingredients:
                    potential_keys.add(ing_id)

                if len(potential_keys) <= INPUT_LIMIT:
                    candidates.append({
                        'item_id': item_id,
                        'recipe': recipe,
                        'new_size': len(potential_keys)
                    })

            if not candidates:
                break 

            candidates.sort(key=lambda x: x['new_size'])
            best = candidates[0]

            recipe = best['recipe']
            product_id = best['item_id']
            amount_needed = current_bus[product_id]
            runs = amount_needed / recipe['product_amount']

            step_record = {
                'recipe_name': recipe['name'],
                'output_item_id': product_id,
                'output_amount': amount_needed,
                'ingredients': {},
                'byproducts': {}
            }

            del current_bus[product_id]
            for ing_id, ing_qty in recipe['ingredients'].items():
                total_ing = ing_qty * runs
                current_bus[ing_id] += total_ing
                step_record['ingredients'][ing_id] = total_ing
            
            # Calculate byproducts (other items produced by this recipe)
            for prod_id, prod_qty in recipe.get('produce', {}).items():
                if prod_id != product_id:
                    total_byp = prod_qty * runs
                    # Byproducts are effectively "negative ingredients" on the bus? 
                    # Or just side outputs. In this backward search, we are decomposing.
                    # If a recipe produces X and Y, and we needed X. We ran the recipe.
                    # We consumed ingredients. We "produced" X (which satisfied the need).
                    # We also "produced" Y. So Y should appear on the bus?
                    # If Y is on the bus, it might satisfy another need?
                    # For simplicity, let's just record it as byproduct but NOT put it on the bus 
                    # to satisfy other needs, unless we want to handle joint production logic which is complex.
                    # Actually, if we produce Y, we have Y. If we needed Y, we could use it.
                    # But the current logic is greedy decomposition.
                    # Let's just record it for display.
                    step_record['byproducts'][prod_id] = total_byp

            steps.append(step_record)

        steps.reverse()

        # --- Phase 2: Forward Lane Simulation ---
        current_inventory = dict(current_bus)
        
        # Prepare inputs summary
        inputs_summary = []
        for item_id, amt in current_inventory.items():
            if amt > 1e-6:
                inputs_summary.append({
                    'name': self.mgr.get_name(item_id),
                    'quantity': amt
                })

        lanes = [None] * 5
        for i, (item_id, amt) in enumerate(current_inventory.items()):
            if i < 5:
                lanes[i] = {'item_id': item_id, 'amount': amt}

        final_layers = []
        
        # Track total byproducts
        total_byproducts = collections.Counter()

        for step_idx, step in enumerate(steps):
            required_inputs = step['ingredients']
            
            # Add step byproducts to total
            for bp_id, bp_amt in step['byproducts'].items():
                total_byproducts[bp_id] += bp_amt

            step_lanes_output = []
            consumed_indices = []

            for idx, lane in enumerate(lanes):
                if lane is None:
                    step_lanes_output.append({'index': idx, 'item': None, 'action': 'empty'})
                    continue

                item_id = lane['item_id']
                item_name = self.mgr.get_name(item_id)
                current_amt = lane['amount']

                if item_id in required_inputs:
                    req_amt = required_inputs[item_id]

                    if abs(current_amt - req_amt) < 1e-6:
                        action = 'consumed'
                        consumed_indices.append(idx)
                        lane['amount'] = 0 
                    elif current_amt > req_amt:
                        action = 'split'
                        lane['amount'] -= req_amt 
                    else:
                        action = 'consumed_partial'
                        consumed_indices.append(idx)
                        lane['amount'] = 0

                    step_lanes_output.append({
                        'index': idx,
                        'item': item_name,
                        'amount': current_amt,
                        'used_amount': req_amt,
                        'action': action
                    })
                else:
                    step_lanes_output.append({
                        'index': idx,
                        'item': item_name,
                        'amount': current_amt,
                        'action': 'passing'
                    })

            prod_id = step['output_item_id']
            prod_amt = step['output_amount']
            prod_name = self.mgr.get_name(prod_id)

            target_idx = -1
            for idx in consumed_indices:
                if lanes[idx]['amount'] < 1e-6: 
                    target_idx = idx
                    break

            if target_idx == -1:
                for idx, lane in enumerate(lanes):
                    if lane is None or lane['amount'] < 1e-6:
                        target_idx = idx
                        break

            if target_idx != -1:
                lanes[target_idx] = {'item_id': prod_id, 'amount': prod_amt}

            final_layers.append({
                "step": step_idx + 1,
                "recipe": step['recipe_name'],
                "inputs": step_lanes_output,
                "output": {
                    "item": prod_name,
                    "amount": prod_amt,
                    "target_lane": target_idx
                }
            })

            for i in range(5):
                if lanes[i] is not None and lanes[i]['amount'] < 1e-6:
                    lanes[i] = None
        
        byproducts_summary = []
        for bp_id, bp_amt in total_byproducts.items():
            byproducts_summary.append({
                'name': self.mgr.get_name(bp_id),
                'quantity': bp_amt
            })

        return final_layers, inputs_summary, byproducts_summary

# --- Main Execution ---

def main():
    print("Initializing Data Manager...")
    mgr = DataManager(ITEM_DATA_PATH, RECIPES_DATA_PATH)
    solver = ProductionSolver(mgr)

    all_data = []

    if not TIERS_CSV_PATH.exists():
        print("Tiers CSV not found, skipping processing.")
        return

    print("Processing Tiers...")
    with open(TIERS_CSV_PATH, 'r') as f:
        reader = csv.DictReader(f)
        # Use enumerate to get an index, starting from 1 or 0 as preferred. 
        # transformations.json used 1-based index.
        for i, row in enumerate(reader, start=1):
            target = row['Name']
            tier = row['Tier']
            try:
                amount = float(row['Output'])
            except ValueError:
                continue

            print(f"  Calculating: {target} (Tier {tier})")
            layers, inputs, byproducts = solver.solve(target, amount)
            
            if layers is not None:
                entry = {
                    "index": i,
                    "tier": tier,
                    "output": target,
                    "output_quantity": amount,
                    "inputs": inputs,
                    "byproducts": byproducts,
                    "graph": layers
                }
                all_data.append(entry)
            else:
                print(f"    [!] Could not solve for {target}")

    with open(TRANSFORMATIONS_PATH, 'w') as f:
        json.dump(all_data, f, indent=2)

    print(f"Success! Transformation plan saved to {TRANSFORMATIONS_PATH}")

if __name__ == "__main__":
    main()
