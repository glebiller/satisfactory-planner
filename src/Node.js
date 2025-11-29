import L from 'leaflet';
import { Link } from './Link.js';

class Pin {
    constructor(node, type, index) {
        this.node = node;
        this.type = type;
        this.index = index;
        this.circle = null;

        this.create();
    }

    create() {
        // Calculate pin position based on type (left/right) and index (top/bottom spread)
        const xOffset = this.type === 'input' ? 0 : this.node.width;
        const yOffset = (this.index / 3) * this.node.height;

        const latlng = this.node.mapPlanner.unproject([this.node.x + xOffset, this.node.y + yOffset]);
        const isConnected = this.node.getConnectionsForPin(this.type, this.index).length > 0;
        const opacity = isConnected ? 0.8 : 0.3;

        this.circle = L.circle(latlng, {
            radius: 0.03,
            color: this.type === 'input' ? 'green' : 'red',
            fillOpacity: opacity,
            interactive: true,
        }).addTo(this.node.mapPlanner.layerGroup);

        this.circle.on('mousedown', (e) => this.node.handlePinMouseDown(e, this.type, this.index));

        this.circle.nodeId = this.node.id;
        this.circle.pinType = this.type;
        this.circle.pinIndex = this.index;
    }

    update() {
        const xOffset = this.type === 'input' ? 0 : this.node.width;
        const yOffset = (this.index / 3) * this.node.height;

        const latlng = this.node.mapPlanner.unproject([this.node.x + xOffset, this.node.y + yOffset]);
        const isConnected = this.node.getConnectionsForPin(this.type, this.index).length > 0;
        const opacity = isConnected ? 0.8 : 0.3;

        this.circle.setStyle({
            color: this.type === 'input' ? 'green' : 'red',
            fillOpacity: opacity,
        });

        this.circle.setLatLng(latlng);
    }
}

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
        for (let i = 0; i < 4; i++) {
            this.pins.push(new Pin(this, 'input', i));
        }
        for (let i = 0; i < 4; i++) {
            this.pins.push(new Pin(this, 'output', i));
        }

        this.dragThresholdDistance = 8;
        this.mousedown = null;
        this.dragging = null;

        this.create();
    }
    getConnectedLinks() {
        return this.mapPlanner.links.filter(link => link.from === this.id || link.to === this.id);
    }
    getConnectionsForPin(pinType, pinIndex) {
        const links = this.getConnectedLinks();
        if (pinType === 'input') {
            return links.filter(link => link.to === this.id && link.toPin === pinIndex);
        } else {
            return links.filter(link => link.from === this.id && link.fromPin === pinIndex);
        }
    }
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

    create() {
        const bounds = this.getBounds();
        this.rect = L.rectangle(bounds, {
            color: this.color,
            weight: 2,
            fillOpacity: 0.8,
            interactive: true,
        }).addTo(this.mapPlanner.layerGroup);

        this.rect.on('mousedown', (e) => this.handleMouseDown(e));
        this.mapPlanner.nodeRectangles.set(this.id, this);

        const center = this.mapPlanner.unproject([this.x + this.width / 2, this.y + this.height / 2]);
        this.textLayer = L.tooltip(center, {
            permanent: true,
            direction: 'center',
            className: 'node-name-tooltip',
            interactive: false,
        }).setContent(this.name).addTo(this.mapPlanner.layerGroup);
    }

    update() {
        const isSelected = this.mapPlanner.selectedNode === this;

        this.rect.setStyle({
            color: this.color,
            weight: isSelected ? 4 : 2,
            dashArray: isSelected ? '5, 5' : null,
        });

        this.rect.setBounds(this.getBounds());

        const center = this.mapPlanner.unproject([this.x + this.width / 2, this.y + this.height / 2]);
        this.textLayer.setLatLng(center);
        this.textLayer.setContent(this.name);

        for (const pin of this.pins) {
            pin.update();
        }
    }

    handleMouseDown(e) {
        this.mousedown = e;
        this.mapPlanner.clickedNode = this;
    }

    handleOnMouseMove(e) {
        if (this.dragging) {
            const rasterPoint = this.mapPlanner.project(e.latlng);
            const gameCoords = this.mapPlanner.convertToGameCoordinates([rasterPoint.x, rasterPoint.y]);
            const newX = this.mapPlanner.snapToGrid(gameCoords[0] - this.dragging.offset[0]);
            const newY = this.mapPlanner.snapToGrid(gameCoords[1] - this.dragging.offset[1]);

            const p1 = this.mapPlanner.unproject([newX, newY]);
            const p2 = this.mapPlanner.unproject([newX + this.width, newY + this.height]);
            this.dragging.ghostProxy.setBounds([p1, p2]);
        } else if (this.mousedown) {
            if (this.mousedown.containerPoint.distanceTo(e.containerPoint) >= this.dragThresholdDistance) {
                const rasterPoint = this.mapPlanner.project(this.mousedown.latlng);
                const gameCoords = this.mapPlanner.convertToGameCoordinates([rasterPoint.x, rasterPoint.y]);
                const offset = [gameCoords[0] - this.x, gameCoords[1] - this.y];
                this.startDragging(offset);
            }
        }
    }

    handleMouseUp(e) {
        if (this.dragging) {
            this.stopDragging(e);
            this.mapPlanner.clickedNode = null;
        } else if (this.mousedown) {
            this.mousedown = null;
            this.mapPlanner.selectNode(this);
        }
    }

    startDragging(offset) {
        const bounds = this.getBounds();
        const ghostProxy = L.rectangle(bounds, {
            color: this.color,
            weight: 2,
            fillOpacity: 0.4,
            interactive: false,
            className: 'ghost-proxy'
        }).addTo(this.mapPlanner.layerGroup);

        this.dragging = { offset, ghostProxy };
    }

    stopDragging(e) {
        const rasterPoint = this.mapPlanner.project(e.latlng);
        const newGameCoordinates = this.mapPlanner.convertToGameCoordinates([rasterPoint.x, rasterPoint.y]);
        const newX = newGameCoordinates[0] - this.dragging.offset[0];
        const newY = newGameCoordinates[1] - this.dragging.offset[1];

        this.updatePosition(newX, newY);
        this.mapPlanner.layerGroup.removeLayer(this.dragging.ghostProxy);

        this.dragging = null;
        this.mousedown = null;
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

    getBounds() {
        const p1 = this.mapPlanner.unproject([this.x, this.y]);
        const p2 = this.mapPlanner.unproject([this.x + this.width, this.y + this.height]);
        return [p1, p2];
    }

    updatePosition(newX, newY) {
        this.x = this.mapPlanner.snapToGrid(newX);
        this.y = this.mapPlanner.snapToGrid(newY);
        this.update();
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
