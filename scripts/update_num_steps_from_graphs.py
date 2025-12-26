#!/usr/bin/env python3
"""
Update `num_steps` in `public/transformations.json` to match the number
of `steps` found in the optimized `public/graphs/*.json` files.

This is intentionally conservative: it only updates the `num_steps` integer
and leaves `transformation_steps` untouched so the script is safe to run
repeatedly and makes minimal changes.
"""
from pathlib import Path
import json
import sys
import shutil
from datetime import datetime

ROOT = Path(__file__).parent.parent
TRANSFORMATIONS_PATH = ROOT / 'public' / 'transformations.json'
GRAPHS_DIR = ROOT / 'public' / 'graphs'


def load_json(path):
    with open(path, 'r') as f:
        return json.load(f)


def slug_from_name(name: str) -> str:
    # produce the same slug used in graphs filenames: lowercase, spaces -> hyphens
    return name.lower().replace(' ', '-')


def main():
    if not TRANSFORMATIONS_PATH.exists():
        print(f"Error: transformations file not found at {TRANSFORMATIONS_PATH}")
        sys.exit(2)
    if not GRAPHS_DIR.exists():
        print(f"Error: graphs dir not found at {GRAPHS_DIR}")
        sys.exit(2)

    print(f"Loading transformations from: {TRANSFORMATIONS_PATH}")
    transformations = load_json(TRANSFORMATIONS_PATH)

    graph_index_to_steps = {}
    graph_slug_to_steps = {}
    missing_meta = []

    for graph_file in sorted(GRAPHS_DIR.glob('*.json')):
        try:
            graph = load_json(graph_file)
        except Exception as e:
            print(f"  Skipping {graph_file.name}: failed to parse JSON: {e}")
            continue

        meta = graph.get('meta') or {}
        index = meta.get('index')
        slug = meta.get('slug') or graph_file.stem
        steps = graph.get('steps') or []

        if index is not None:
            graph_index_to_steps[int(index)] = len(steps)
        else:
            missing_meta.append(graph_file.name)

        # always record slug mapping (will overwrite duplicates but that's fine)
        graph_slug_to_steps[slug] = len(steps)

    if missing_meta:
        print("Warning: some graph files lacked meta.index; they can still be matched by slug:")
        for name in missing_meta:
            print(f"  - {name}")

    updated = 0
    no_graph = 0

    # Backup
    timestamp = datetime.now().strftime('%Y%m%dT%H%M%S')
    bak_ts = TRANSFORMATIONS_PATH.with_name(f"{TRANSFORMATIONS_PATH.name}.{timestamp}.bak")
    shutil.copy2(TRANSFORMATIONS_PATH, bak_ts)
    print(f"Backup written to: {bak_ts}")

    for t in transformations:
        idx = t.get('index')
        if idx is None:
            continue

        new_steps = None
        # first try index
        if idx in graph_index_to_steps:
            new_steps = graph_index_to_steps[idx]
        else:
            # fallback to slug match
            slug = slug_from_name(t.get('output', ''))
            if slug in graph_slug_to_steps:
                new_steps = graph_slug_to_steps[slug]

        if new_steps is None:
            no_graph += 1
            continue

        old_steps = t.get('num_steps')
        if old_steps != new_steps:
            print(f"Updating index {idx} ('{t.get('output')}'): num_steps {old_steps} -> {new_steps}")
            t['num_steps'] = new_steps
            updated += 1

    if updated:
        with open(TRANSFORMATIONS_PATH, 'w') as f:
            json.dump(transformations, f, indent=2)
        print(f"Wrote updated transformations to {TRANSFORMATIONS_PATH}")
    else:
        print("No updates needed; transformations file left unchanged.")

    print(f"Summary: updated={updated}, graphs_missing_for_transformations={no_graph}")


if __name__ == '__main__':
    main()
