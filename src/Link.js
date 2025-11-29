import L from 'leaflet';

export class Link {
    constructor(mapPlanner, data) {
        this.mapPlanner = mapPlanner;
        this.from = data.from;
        this.to = data.to;
        this.fromPin = data.fromPin || 0;
        this.toPin = data.toPin || 0;
    }

    render() {
        const startNode = this.mapPlanner.nodes.find(n => n.id === this.from);
        const endNode = this.mapPlanner.nodes.find(n => n.id === this.to);

        if (!startNode || !endNode) {
            return;
        }

        // Calculate pin positions based on pin indices
        // Output pins are on the right side: x: node.x + node.width
        const p1Y = startNode.y + ((this.fromPin + 1) * startNode.height / 5);
        const p1 = { x: startNode.x + startNode.width, y: p1Y };

        // Input pins are on the left side: x: node.x
        const p2Y = endNode.y + ((this.toPin + 1) * endNode.height / 5);
        const p2 = { x: endNode.x, y: p2Y };

        const midX = p1.x + (p2.x - p1.x) / 2;

        const gameCoords = [
            [p1.x, p1.y],
            [midX, p1.y],
            [midX, p2.y],
            [p2.x, p2.y]
        ];

        const latLngs = gameCoords.map(p => this.mapPlanner.unproject(p));

        L.polyline(latLngs, {
            renderer: this.mapPlanner.canvasRenderer,
            color: 'blue',
            weight: 3
        }).addTo(this.mapPlanner.layerGroup);
    }

    toPlainObject() {
        return {
            from: this.from,
            to: this.to,
            fromPin: this.fromPin,
            toPin: this.toPin,
        };
    }
}
