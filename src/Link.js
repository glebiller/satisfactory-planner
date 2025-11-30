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

        this.startPin = this.startNode.getPin('output', this.fromPin);
        this.endPin = this.endNode.getPin('input', this.toPin);

        if (this.startPin) this.startPin.linkedLinks.push(this);
        if (this.endPin) this.endPin.linkedLinks.push(this);

        this.polyline = L.polyline([], {
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
        if (!this.startPin || !this.endPin) return [];

        const p1 = this.mapPlanner.leafletMap.project(this.startPin.circle.getLatLng());
        const p2 = this.mapPlanner.leafletMap.project(this.endPin.circle.getLatLng());

        const midX = p1.x + (p2.x - p1.x) / 2;

        const points = [
            p1,
            { x: midX, y: p1.y },
            { x: midX, y: p2.y },
            p2
        ];

        return points.map(p => this.mapPlanner.leafletMap.unproject(p));
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
        if (this.startPin) {
            const index = this.startPin.linkedLinks.indexOf(this);
            if (index > -1) this.startPin.linkedLinks.splice(index, 1);
        }
        if (this.endPin) {
            const index = this.endPin.linkedLinks.indexOf(this);
            if (index > -1) this.endPin.linkedLinks.splice(index, 1);
        }

        if (this.polyline) {
            this.mapPlanner.layerGroup.removeLayer(this.polyline);
        }
    }
}
