import json
import sys
import re

# Path to your local file
FILE_PATH = "../public/full-data.json"

def calculate_rate(amount, duration_seconds):
    if duration_seconds <= 0:
        return 0
    return (amount / duration_seconds) * 60

def main():
    print(f"Loading data from {FILE_PATH}...")

    try:
        with open(FILE_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except FileNotFoundError:
        print(f"Error: Could not find file '{FILE_PATH}'")
        sys.exit(1)

    recipes_raw = data.get('recipesData', {})
    items_raw = data.get('itemsData', {})

    # Create a lookup: Item_Code -> Item Name
    # e.g., "Desc_IronPlate_C" -> "Iron Plate"
    item_lookup = {code: item.get('className', code) for code, item in items_raw.items()}

    converted_recipes = []

    for recipe_code, recipe_data in recipes_raw.items():
        duration = recipe_data.get('mManufactoringDuration', 0)
        if duration <= 0:
            continue

        id = recipe_data.get('slug', recipe_code)
        if id.startswith("Recipe_Alternate_") \
                or id.startswith("Recipe_Protein_") \
                or id.startswith("Recipe_Biomass_") \
                or id.startswith("Recipe_Biofuel_") \
                or id.startswith("Recipe_ResidualRubber") \
                or id.startswith("Recipe_ResidualFuel_") \
                or id.startswith("Recipe_ResidualPlastic_") \
                or id.startswith("Recipe_SyntheticPowerShard") \
                or id.startswith("Recipe_Cartridge_") \
                or id.startswith("Recipe_AlienPowerFuel_") \
                or id.startswith("Recipe_AlienDNACapsule_") \
                or id.startswith("Recipe_FicsiteIngot_AL_") \
                or id.startswith("Recipe_FicsiteIngot_CAT_") \
                or id.startswith("Recipe_SpikedRebar_") \
                or id.startswith("Recipe_Snowball_"):
            continue

        name = recipe_data.get('name', 'Unknown')
        if name.startswith("Unpackage ") \
                or name.startswith("Alternate: ") \
                or name.startswith("Power Shard") \
                or name.startswith("Packaged "):
            continue

        # Prepare inputs
        inputs = []
        for item_code, amount in recipe_data.get('ingredients', {}).items():
            item = item_lookup.get(item_code, item_code)
            inputs.append({
                "item": item,
                "perMin": round(calculate_rate(amount, duration), 2)
            })

        # Prepare outputs
        outputs = []
        for item_code, amount in recipe_data.get('produce', {}).items():
            item = item_lookup.get(item_code, item_code)
            if item.startswith("/Game/FactoryGame/Buildable/") \
                    or item.startswith("/Game/FactoryGame/Prototype/Buildable/") \
                    or item.startswith("/Game/FactoryGame/Resource/Equipment/") \
                    or item.startswith("/Game/FactoryGame/Equipment/") \
                    or item.startswith("/Game/FactoryGame/Events/Christmas/") \
                    or item.startswith("/Game/FactoryGame/Resource/RawResources/"):
                print(f"Skipping {name}")
                continue

            outputs.append({
                "item": item,
                "perMin": round(calculate_rate(amount, duration), 2)
            })

        if len(outputs) == 0:
            print(f"Skipping {name}")
            continue

        # Construct final object
        converted_recipes.append({
            "id": id,
            "name": name,
            "inputs": inputs,
            "outputs": outputs
        })

    # Save to disk
    output_filename = "../public/full-recipes.json"
    with open(output_filename, "w", encoding="utf-8") as f:
        json.dump(converted_recipes, f, indent=2)

    print(f"Done! Converted {len(converted_recipes)} recipes to '{output_filename}'.")

if __name__ == "__main__":
    main()