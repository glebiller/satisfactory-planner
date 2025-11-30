import L from 'leaflet';

export class Link {
    constructor(mapPlanner, data) {
        this.mapPlanner = mapPlanner;
        this.id = data.id || `l_${Date.now()}`;
        this.from = data.from;
        this.to = data.to;
        this.fromPin = data.fromPin || 0;
        this.toPin = data.toPin || 0;
        this.color = data.color || '#00aaff';
        this.polyline = null;

        this.create();
    }

    create() {
        this.startNode = this.mapPlanner.nodes.find(n => n.id === this.from);
        this.endNode = this.mapPlanner.nodes.find(n => n.id === this.to);

        if (!this.startNode || !this.endNode) {
            console.error('Could not find start or end node for link', this);
            return;
        }

        this.polyline = L.polyline(this.getLatLngs(), {
            weight: 3
        }).addTo(this.mapPlanner.layerGroup);

        this.polyline.on('click', (e) => {
            L.DomEvent.stop(e);
            this.mapPlanner.selectLink(this);
        });

        this.update();
    }

    update() {
        const isSelected = this.mapPlanner.selectedLink === this;
        this.polyline.setStyle({
            color: this.color,
            weight: isSelected ? 5 : 3,
            dashArray: isSelected ? '10, 5' : null,
        });
        this.polyline.setLatLngs(this.getLatLngs());
    }

    getLatLngs() {
        const p1Offset = this.startNode.getPinOffset('output', this.fromPin);
        const p1 = { x: this.startNode.x + p1Offset.x, y: this.startNode.y + p1Offset.y };

        const p2Offset = this.endNode.getPinOffset('input', this.toPin);
        const p2 = { x: this.endNode.x + p2Offset.x, y: this.endNode.y + p2Offset.y };

        const midX = p1.x + (p2.x - p1.x) / 2;

        const gameCoords = [
            [p1.x, p1.y],
            [midX, p1.y],
            [midX, p2.y],
            [p2.x, p2.y]
        ];
        return gameCoords.map(p => this.mapPlanner.unproject(p));
    }

    toPlainObject() {
        return {
            id: this.id,
            from: this.from,
            to: this.to,
            fromPin: this.fromPin,
            toPin: this.toPin,
            color: this.color,
        };
    }

    remove() {
        if (this.polyline) {
            this.mapPlanner.layerGroup.removeLayer(this.polyline);
        }
    }
}
