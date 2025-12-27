#!/usr/bin/env python3
"""
Belt Verification Script for Satisfactory Factory Transformations

This script verifies that no more than 5 different belt types are needed
simultaneously at any point during the manufacturing process for each
transformation in the transformations.json file.

The script simulates the manufacturing process step by step, tracking which
materials need to be transported on belts at each stage.
"""

import json
from collections import defaultdict, deque
from typing import Dict, List, Set, Tuple, Any


def load_transformations(file_path: str) -> List[Dict[str, Any]]:
    """Load the transformations from the JSON file."""
    with open(file_path, 'r') as f:
        return json.load(f)


def analyze_belt_requirements(transformation: Dict[str, Any]) -> Tuple[bool, int, List[Dict[str, Any]]]:
    """
    Analyze a single transformation to check if it violates the 5-belt constraint.

    Returns:
        - bool: True if constraint is satisfied (<=5 belts), False otherwise
        - int: Maximum number of concurrent belts needed
        - List: Detailed step-by-step analysis
    """
    steps = transformation['transformation_steps']
    analysis = []

    # Track materials that need to be transported at each step
    # Key: step_index, Value: set of materials on belts
    active_materials = defaultdict(set)

    # For each step, we need to transport its inputs
    for step_idx, step in enumerate(steps):
        # Materials needed as inputs for this step
        required_materials = set(step['requires'].keys())

        # Add these materials to active transport
        active_materials[step_idx].update(required_materials)

        # Check which materials are produced in previous steps
        materials_from_previous_steps = set()
        for prev_idx in range(step_idx):
            prev_step = steps[prev_idx]
            materials_from_previous_steps.update(prev_step['produces'].keys())

        # Materials that need to come from external sources (initial inputs)
        external_materials = required_materials - materials_from_previous_steps

        # Materials that come from previous steps in the same transformation
        internal_materials = required_materials & materials_from_previous_steps

        # Count active belts at this step
        # We need belts for:
        # 1. Materials coming from external sources (if not already counted)
        # 2. Materials being transported between internal steps

        current_active_belts = set()

        # Add external materials (these are inputs to the entire process)
        current_active_belts.update(external_materials)

        # Add internal materials being transported from previous steps
        current_active_belts.update(internal_materials)

        # Track this step's analysis
        step_analysis = {
            'step_index': step_idx,
            'recipe': step['recipe'],
            'requires': step['requires'],
            'produces': step['produces'],
            'external_materials': list(external_materials),
            'internal_materials': list(internal_materials),
            'active_belts': list(current_active_belts),
            'belt_count': len(current_active_belts)
        }

        analysis.append(step_analysis)

    # Calculate the maximum concurrent belts needed
    max_belts = max(step['belt_count'] for step in analysis) if analysis else 0
    constraint_satisfied = max_belts <= 5

    return constraint_satisfied, max_belts, analysis


def print_analysis_summary(transformation: Dict[str, Any], constraint_satisfied: bool,
                         max_belts: int, analysis: List[Dict[str, Any]]):
    """Print a summary of the belt analysis for a transformation."""
    print(f"\n{'='*80}")
    print(f"Transformation: {transformation['output']} (Tier {transformation['tier']})")
    print(f"Index: {transformation['index']}")
    print(f"Total Steps: {transformation['num_steps']}")
    print(f"Max Concurrent Belts: {max_belts}")
    print(f"Constraint Satisfied (≤5 belts): {'✅ YES' if constraint_satisfied else '❌ NO'}")

    if not constraint_satisfied:
        print(f"\n⚠️  VIOLATION: This transformation requires {max_belts} concurrent belts!")

        # Show the steps that cause the violation
        violation_steps = [step for step in analysis if step['belt_count'] > 5]
        print(f"Violation occurs at {len(violation_steps)} step(s):")

        for step in violation_steps:
            print(f"  - Step {step['step_index'] + 1}: {step['recipe']}")
            print(f"    Active belts ({step['belt_count']}): {', '.join(step['active_belts'])}")

    print(f"{'='*80}")


def print_detailed_analysis(transformation: Dict[str, Any], analysis: List[Dict[str, Any]]):
    """Print detailed step-by-step analysis."""
    print(f"\nDetailed Analysis for: {transformation['output']}")
    print(f"{'-'*60}")

    for step in analysis:
        print(f"Step {step['step_index'] + 1}: {step['recipe']}")
        print(f"  Requires: {step['requires']}")
        print(f"  Produces: {step['produces']}")
        print(f"  External materials: {step['external_materials']}")
        print(f"  Internal materials: {step['internal_materials']}")
        print(f"  Active belts ({step['belt_count']}): {step['active_belts']}")
        print()


def main():
    """Main function to run the belt verification."""
    try:
        # Load transformations
        print("Loading transformations from public/transformations.json...")
        transformations = load_transformations('public/transformations.json')
        print(f"Loaded {len(transformations)} transformations.")

        # Analyze each transformation
        violations = []
        max_belts_overall = 0

        print("\n🔍 Analyzing belt requirements for each transformation...\n")

        for i, transformation in enumerate(transformations):
            constraint_satisfied, max_belts, analysis = analyze_belt_requirements(transformation)

            max_belts_overall = max(max_belts_overall, max_belts)

            if not constraint_satisfied:
                violations.append({
                    'transformation': transformation,
                    'max_belts': max_belts,
                    'analysis': analysis
                })

            # Print progress
            if (i + 1) % 10 == 0:
                print(f"Processed {i + 1}/{len(transformations)} transformations...")

        # Print summary
        print(f"\n{'='*80}")
        print("BELT VERIFICATION SUMMARY")
        print(f"{'='*80}")
        print(f"Total transformations analyzed: {len(transformations)}")
        print(f"Transformations violating 5-belt constraint: {len(violations)}")
        print(f"Maximum concurrent belts needed overall: {max_belts_overall}")
        print(f"5-belt constraint satisfied: {'✅ YES' if len(violations) == 0 else '❌ NO'}")

        if violations:
            print(f"\n❌ CONSTRAINT VIOLATIONS ({len(violations)} total):")
            print(f"{'='*80}")

            # Sort violations by severity (most belts first)
            violations.sort(key=lambda x: x['max_belts'], reverse=True)

            for violation in violations:
                print_analysis_summary(
                    violation['transformation'],
                    False,
                    violation['max_belts'],
                    violation['analysis']
                )

            # Ask if user wants detailed analysis
            if len(violations) <= 5:  # Only for manageable number of violations
                show_details = input(f"\nShow detailed step-by-step analysis for violations? (y/n): ").lower().strip()
                if show_details == 'y':
                    for violation in violations:
                        print_detailed_analysis(violation['transformation'], violation['analysis'])
        else:
            print(f"\n✅ All transformations satisfy the 5-belt constraint!")
            print("Your tower-style factory design is feasible with maximum 5 concurrent belts.")

        # Show distribution of belt requirements
        belt_counts = defaultdict(int)
        for transformation in transformations:
            _, max_belts, _ = analyze_belt_requirements(transformation)
            belt_counts[max_belts] += 1

        print(f"\nDISTRIBUTION OF BELT REQUIREMENTS:")
        print(f"{'-'*40}")
        for belts in sorted(belt_counts.keys()):
            count = belt_counts[belts]
            percentage = (count / len(transformations)) * 100
            bar = '█' * (count // max(1, len(transformations) // 20))
            print(f"{belts:2d} belts: {count:3d} transformations ({percentage:5.1f}%) {bar}")

    except FileNotFoundError:
        print("❌ Error: transformations.json file not found!")
        print("Please make sure you're running this script from the correct directory.")
        print("Expected file location: public/transformations.json")
    except json.JSONDecodeError as e:
        print(f"❌ Error: Invalid JSON format in transformations.json: {e}")
    except Exception as e:
        print(f"❌ Unexpected error: {e}")


if __name__ == "__main__":
    main()
