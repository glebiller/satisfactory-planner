import json

def transform_data():
    input_file = '/Users/glebiller/Workspace/satisfactory-planner/public/data.json'
    output_file = '/Users/glebiller/Workspace/satisfactory-planner/public/resource_nodes.json'

    with open(input_file, 'r') as f:
        data = json.load(f)

    resource_nodes_data = data[0]
    output_data = []

    for resource_type in resource_nodes_data['options']:
        if resource_type['name'] == 'Unknown nodes':
            continue

        resource_output = {
            "name": resource_type['name'],
            "type": resource_type['type'],
            "nodes": []
        }
        if 'options' in resource_type:
            for purity_option in resource_type['options']:
                if 'markers' in purity_option:
                    for marker in purity_option['markers']:
                        node = {
                            "purity": purity_option.get('purity'),
                            "x": marker.get('x'),
                            "y": marker.get('y'),
                            "z": marker.get('z'),
                            "size": [3200, 3200]
                        }
                        resource_output['nodes'].append(node)
        output_data.append(resource_output)

    with open(output_file, 'w') as f:
        json.dump(output_data, f, indent=2)

if __name__ == '__main__':
    transform_data()
    print(f"Successfully generated {output_file}")
