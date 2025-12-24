import json
import sys
from pathlib import Path

# Paths (relative to this script location)
ROOT = Path(__file__).resolve().parent
INPUT_PATH = ROOT / ".." / "public" / "0-full-data.json"
OUTPUT_PATH = ROOT / ".." / "public" / "1-recipes-data.json"

# Prefixes of className to skip
SKIP_PREFIXES = (
    "/Game/FactoryGame/Recipes/Buildings/",
    "/Game/FactoryGame/Recipes/Equipment/",
    "/Game/FactoryGame/Recipes/AlternateRecipes/",
    "/Game/FactoryGame/Buildable/",
    "/Game/FactoryGame/Events/",
)

# Workbench path to exclude when it is the only production building
WORKBENCH_PATH = "/Game/FactoryGame/Buildable/-Shared/WorkBench/BP_WorkshopComponent.BP_WorkshopComponent_C"

def should_skip_class(class_name: str) -> bool:
    return any(class_name.startswith(prefix) for prefix in SKIP_PREFIXES)


def produced_in_skippable(m_produced_in) -> bool:
    """
    Skip if mProducedIn is null/None/empty, or if the ONLY production place
    is the Workbench path. Handles both string and list representations.
    """
    if not m_produced_in:
        return True

    # If it's a string
    if isinstance(m_produced_in, str):
        return m_produced_in == WORKBENCH_PATH

    # If it's a list/tuple
    if isinstance(m_produced_in, (list, tuple)):
        # Remove falsy values and ensure strings
        places = [p for p in m_produced_in if isinstance(p, str) and p]
        if len(places) == 0:
            return True
        if len(places) == 1 and places[0] == WORKBENCH_PATH:
            return True
        return False

    # Any other unexpected type: be conservative and keep it
    return False


def main():
    try:
        with open(INPUT_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        print(f"Error: Could not find input file: {INPUT_PATH}")
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"Error: Failed to parse JSON from {INPUT_PATH}: {e}")
        sys.exit(1)

    recipes_raw = data.get("recipesData", {})
    if not isinstance(recipes_raw, dict):
        print("Error: 'recipesData' is missing or not a dict in full-data.json")
        sys.exit(1)

    # Build map: entry.className -> { id: <key>, name, ingredients, produce, mProducedIn }
    result = {}
    skipped = 0
    for key, entry in recipes_raw.items():
        if not isinstance(entry, dict):
            continue
        class_name = entry.get("className")
        if not class_name:
            continue
        if should_skip_class(class_name):
            skipped += 1
            continue

        m_produced_in = entry.get("mProducedIn")
        if produced_in_skippable(m_produced_in):
            skipped += 1
            continue

        result[class_name] = {
            "id": key,
            "name": entry.get("name"),
            "ingredients": entry.get("ingredients", {}),
            "produce": entry.get("produce", {}),
            "mProducedIn": m_produced_in,
        }

    # Write output
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    print(f"Wrote {len(result)} recipes to {OUTPUT_PATH} (skipped {skipped}).")


if __name__ == "__main__":
    main()
