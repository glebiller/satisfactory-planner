import L from 'leaflet';
import { Link } from './Link.js';

export class Node {
    constructor(mapPlanner, data) {
        this.mapPlanner = mapPlanner;
        this.id = data.id;
        this.x = data.x;
        this.y = data.y;
        this.width = data.width;
        this.height = data.height;
        this.type = data.type;
        this.color = data.color;
        this.name = data.name || 'Node';
        this.inputs = data.inputs || [];
        this.outputs = data.outputs || [];

        this.rect = null;
        this.textLayer = null;
        this.pins = [];
    }

    /**
     * Get all links connected to this node
     */
    getConnectedLinks() {
        return this.mapPlanner.links.filter(link => link.from === this.id || link.to === this.id);
    }

    /**
     * Get connections for a specific input/output
     */
    getConnectionsForPin(pinType, pinIndex) {
        const links = this.getConnectedLinks();
        if (pinType === 'input') {
            // Input receives from output, so link.to === this.id
            return links.filter(link => link.to === this.id && link.toPin === pinIndex);
        } else {
            // Output sends to input, so link.from === this.id
            return links.filter(link => link.from === this.id && link.fromPin === pinIndex);
        }
    }

    /**
     * Get the connected node for a specific pin
     */
    getConnectedNode(pinType, pinIndex) {
        const connections = this.getConnectionsForPin(pinType, pinIndex);
        if (connections.length === 0) return null;

        const link = connections[0];
        if (pinType === 'input') {
            return this.mapPlanner.nodes.find(n => n.id === link.from);
        } else {
            return this.mapPlanner.nodes.find(n => n.id === link.to);
        }
    }

    render() {
        const isSelected = this.mapPlanner.selectedNode === this;
        const style = {
            renderer: this.mapPlanner.canvasRenderer,
            color: this.color,
            weight: isSelected ? 4 : 2,
            fillOpacity: 0.8,
            dashArray: isSelected ? '5, 5' : null,
            interactive: true,
        };

        const bounds = this.getBounds();
        this.rect = L.rectangle(bounds, style).addTo(this.mapPlanner.layerGroup);
        
        this.rect.on('mousedown', (e) => this.handleMouseDown(e));
        this.rect.on('mouseup', (e) => this.handleMouseUp(e));

        this.mapPlanner.nodeRectangles.set(this.id, this);

        // Add text layer with node name
        const center = this.mapPlanner.unproject([this.x + this.width / 2, this.y + this.height / 2]);
        if (this.textLayer) {
            this.mapPlanner.layerGroup.removeLayer(this.textLayer);
        }
        this.textLayer = L.tooltip(center, {
            permanent: true,
            direction: 'center',
            className: 'node-name-tooltip',
            interactive: false,
        }).setContent(this.name).addTo(this.mapPlanner.layerGroup);

        this.renderPins();
    }

    handleMouseDown(e) {
        L.DomEvent.stop(e);
        if (this.mapPlanner.interactionState?.type === 'linking') {
            return;
        }
        const rasterPoint = this.mapPlanner.project(e.latlng);
        const gameCoords = this.mapPlanner.convertToGameCoordinates([rasterPoint.x, rasterPoint.y]);
        this.mapPlanner.interactionState = {
            type: 'dragging',
            node: this,
            offset: [gameCoords[0] - this.x, gameCoords[1] - this.y],
            wasDragging: false
        };
    }

    handleMouseUp(e) {
        L.DomEvent.stop(e);
        if (this.mapPlanner.interactionState?.type === 'dragging' && this.mapPlanner.interactionState.node === this) {
            if (!this.mapPlanner.interactionState.wasDragging) {
                // This was a click, not a drag
                this.mapPlanner.selectNode(this);
            }
            this.mapPlanner.interactionState = null;
        }
    }

    handlePinMouseDown(e, pinType, pinIndex) {
        const mapPlanner = this.mapPlanner;
        const interactionState = mapPlanner.interactionState;

        L.DomEvent.stop(e);
        if (interactionState?.type === 'linking') {
            const { fromNode, fromType, fromIndex } = interactionState;
            const toNode = this;
            const toType = pinType;
            const toIndex = pinIndex;

            if (mapPlanner.isValidLink(fromNode, fromType, toNode, toType)) {
                const fromNodeId = fromType === 'output' ? fromNode.id : toNode.id;
                const toNodeId = fromType === 'output' ? toNode.id : fromNode.id;
                const fromPin = fromType === 'output' ? fromIndex : toIndex;
                const toPin = fromType === 'output' ? toIndex : fromIndex;

                const newLink = new Link(mapPlanner, {
                    from: fromNodeId,
                    to: toNodeId,
                    fromPin,
                    toPin
                });
                mapPlanner.links.push(newLink);
                mapPlanner.saveState();
                newLink.render();
            }

            mapPlanner.cancelLinking();
        } else {
            mapPlanner.startLinking(this, pinType, pinIndex, e.latlng);
        }
    }

    renderPins() {
        this.pins.forEach(pin => this.mapPlanner.layerGroup.removeLayer(pin));
        this.pins = [];

        const pinPositions = [];

        // Create 4 input pins on the left side, evenly spaced
        for (let i = 0; i < 4; i++) {
            const y = this.y + ((i + 1) * this.height / 5); // Divide height into 5 sections
            pinPositions.push({ x: this.x, y, type: 'input', index: i });
        }

        // Create 4 output pins on the right side, evenly spaced
        for (let i = 0; i < 4; i++) {
            const y = this.y + ((i + 1) * this.height / 5); // Divide height into 5 sections
            pinPositions.push({ x: this.x + this.width, y, type: 'output', index: i });
        }

        pinPositions.forEach(p => {
            const latlng = this.mapPlanner.unproject([p.x, p.y]);

            // Check if pin is connected
            const isConnected = this.getConnectionsForPin(p.type, p.index).length > 0;
            const opacity = isConnected ? 0.8 : 0.3;

            const pin = L.circle(latlng, {
                renderer: this.mapPlanner.canvasRenderer,
                radius: 0.03,
                color: p.type === 'input' ? 'green' : 'red',
                fillOpacity: opacity,
                interactive: true,
            }).addTo(this.mapPlanner.layerGroup);

            pin.on('mousedown', (e) => this.handlePinMouseDown(e, p.type, p.index));

            // Attach data to the layer for identification
            pin.nodeId = this.id;
            pin.pinType = p.type;
            pin.pinIndex = p.index;

            this.pins.push(pin);
        });
    }

    getBounds() {
        const p1 = this.mapPlanner.unproject([this.x, this.y]);
        const p2 = this.mapPlanner.unproject([this.x + this.width, this.y + this.height]);
        return [p1, p2];
    }

    updatePosition(newX, newY) {
        this.x = newX;
        this.y = newY;
        this.rect.setBounds(this.getBounds());
        if (this.textLayer) {
            const center = this.mapPlanner.unproject([this.x + this.width / 2, this.y + this.height / 2]);
            this.textLayer.setLatLng(center);
        }
        this.renderPins();
        this.mapPlanner.saveState();
    }

    toPlainObject() {
        return {
            id: this.id,
            x: this.x,
            y: this.y,
            width: this.width,
            height: this.height,
            type: this.type,
            color: this.color,
            name: this.name,
            inputs: this.inputs,
            outputs: this.outputs,
        };
    }
}
