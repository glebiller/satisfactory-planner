import json
import sys
from pathlib import Path

# Paths (relative to this script location)
ROOT = Path(__file__).resolve().parent
INPUT_PATH = ROOT / ".." / "public" / "0-full-data.json"
OUTPUT_PATH = ROOT / ".." / "public" / "1-items-data.json"


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

    items_raw = data.get("itemsData", {})
    if not isinstance(items_raw, dict):
        print("Error: 'itemsData' is missing or not a dict in full-data.json")
        sys.exit(1)

    # Build map: entry.className -> { id: <key>, name: entry.name, category: entry.category }
    result = {}
    for key, entry in items_raw.items():
        if not isinstance(entry, dict):
            continue
        class_name = entry.get("className")
        name = entry.get("name")
        category = entry.get("category")

        # Only include entries that have a className
        if not class_name:
            continue

        result[class_name] = {
            "name": name,
            "category": category,
        }

    # Write output
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    print(f"Wrote {len(result)} entries to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
