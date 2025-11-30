import L from 'leaflet';
import { Link } from './Link.js';

class Pin {
    constructor(node, type, index, enabled = true) {
        this.node = node;
        this.type = type;
        this.index = index;
        this.enabled = enabled;
        this.circle = null;
        this.linkedLinks = [];

        this.create();
    }

    create() {
        const offset = this.node.getPinOffset(this.type, this.index);
        const latlng = this.node.mapPlanner.unproject([this.node.x + offset.x, this.node.y + offset.y]);

        this.circle = L.circle(latlng, {
            radius: 0.05,
            interactive: true,
        }).addTo(this.node.mapPlanner.layerGroup);

        this.circle.on('mousedown', (e) => this.handleMouseDown(e));

        this.update();
    }

    getLinkedLinks() {
        return this.node.getConnectionsForPin(this.type, this.index);
    }

    update() {
        const offset = this.node.getPinOffset(this.type, this.index);
        const latlng = this.node.mapPlanner.unproject([this.node.x + offset.x, this.node.y + offset.y]);

        this.linkedLinks = this.getLinkedLinks();

        const isConnected = this.linkedLinks.length > 0;
        const fillOpacity = isConnected ? 0.8 : 0.3;

        this.circle.setStyle({
            color: this.type === 'input' ? 'green' : 'red',
            fillOpacity: this.enabled ? fillOpacity : 0,
            opacity: this.enabled ? 0.8 : 0,
        });

        this.circle.setLatLng(latlng);

        for (const link of this.linkedLinks) {
            link.update();
        }
    }

    handleMouseDown(e) {
        L.DomEvent.stop(e);
        const mapPlanner = this.node.mapPlanner;

        if (!mapPlanner.controls.isEditMode) return;

        const interactionState = mapPlanner.interactionState;

        if (interactionState?.type === 'linking') {
            const { fromNode, fromType, fromIndex } = interactionState;
            const toNode = this.node;
            const toType = this.type;
            const toIndex = this.index;

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
                fromNode.update();
                toNode.update();
                mapPlanner.saveState();
            }

            mapPlanner.cancelLinking();
        } else {
            mapPlanner.startLinking(this.node, this.type, this.index, e.latlng);
        }
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
        this.icon = data.icon || null;
        this.pinsEnabled = data.pinsEnabled || {};

        this.rect = null;

        this.dragThresholdDistance = 8;
        this.mousedown = null;
        this.dragging = null;

        this.create();
    }
    getPinOffset(pinType, pinIndex) {
        const xOffset = pinType === 'input' ? 0 : this.width;
        const yOffset = (pinIndex / 3) * this.height;
        return { x: xOffset, y: yOffset };
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
            fillOpacity: 0.8,
            interactive: true,
        }).addTo(this.mapPlanner.layerGroup);
        this.rect.on('mousedown', (e) => this.handleMouseDown(e));

        this.iconOverlay = L.imageOverlay(`icons/${this.icon}.webp`, bounds, {
            zIndex: 400
        }).addTo(this.mapPlanner.layerGroup);

        this.nameTooltip = L.tooltip(bounds.getCenter(), {
            permanent: true,
            direction: 'center',
            className: 'node-name-tooltip',
            interactive: false,
            offset: [0, 30]
        }).setContent(this.name)
          .addTo(this.mapPlanner.layerGroup);

        // Pins
        this.pins = [];
        for (let i = 0; i < 4; i++) {
            const enabled = this.pinsEnabled[`input-${i}`] !== false;
            this.pins.push(new Pin(this, 'input', i, enabled));
        }
        for (let i = 0; i < 4; i++) {
            const enabled = this.pinsEnabled[`output-${i}`] !== false;
            this.pins.push(new Pin(this, 'output', i, enabled));
        }

        this.update();
    }

    update() {
        const isSelected = this.mapPlanner.selectedNode === this;
        const currentZoom = this.mapPlanner.leafletMap.getZoom();

        this.rect.setStyle({
            color: this.color,
            weight: isSelected ? 4 : 2,
            dashArray: isSelected ? '5, 5' : null,
        });

        const bounds = this.getBounds();
        this.rect.setBounds(bounds);

        if (this.icon) {
            /*this.iconOverlay.setUrl(`icons/${this.icon}.webp`);
            const iconBounds = bounds.pad(-0.85);
            this.iconOverlay.setBounds(iconBounds)
            this.iconOverlay.setOpacity(1);*/
        } else {
            this.iconOverlay.setOpacity(0);
        }

        this.nameTooltip.setContent(this.name);
        this.nameTooltip.setLatLng(bounds.getCenter());

        if (currentZoom >= 7.25) {
            this.nameTooltip.setOpacity(0.9);
        } else {
            this.nameTooltip.setOpacity(0);
        }

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
            renderer: L.svg(),
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
            }

            mapPlanner.cancelLinking();
        } else {
            mapPlanner.startLinking(this, pinType, pinIndex, e.latlng);
        }
    }

    getBounds() {
        const p1 = this.mapPlanner.unproject([this.x, this.y]);
        const p2 = this.mapPlanner.unproject([this.x + this.width, this.y + this.height]);
        return L.latLngBounds(p1, p2);
    }

    updatePosition(newX, newY) {
        this.x = this.mapPlanner.snapToGrid(newX);
        this.y = this.mapPlanner.snapToGrid(newY);
        this.update();
        this.mapPlanner.saveState();
    }

    toPlainObject() {
        const pinsEnabled = {};
        for (const pin of this.pins) {
            pinsEnabled[`${pin.type}-${pin.index}`] = pin.enabled;
        }

        return {
            id: this.id,
            x: this.x,
            y: this.y,
            width: this.width,
            height: this.height,
            type: this.type,
            color: this.color,
            name: this.name,
            icon: this.icon,
            pinsEnabled: pinsEnabled,
        };
    }
}
