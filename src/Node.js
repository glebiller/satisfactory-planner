import L from 'leaflet';

class Pin {
    constructor(node, type, index, enabled = true) {
        this.node = node;
        this.type = type;
        this.index = index;
        this.enabled = enabled;
        this.circle = null;
        this.linkedLinks = [];

        this.offset = this.getOffset();
        this.create();
    }

    getOffset() {
        const xFactor = this.type === 'input' ? 0 : 1;
        const yFactor = (this.index + 0.5) / 4;
        return { x: xFactor, y: yFactor };
    }

    create() {
        this.circle = L.circle([0, 0], {
            radius: 0.05,
            interactive: true,
        }).addTo(this.node.mapPlanner.layerGroup);

        this.circle.on('mousedown', (e) => this.handleMouseDown(e));
        this.update();
    }

    remove() {
        this.node.mapPlanner.layerGroup.removeLayer(this.circle);
    }

    update() {
        const isConnected = this.linkedLinks.length > 0;
        const fillOpacity = isConnected ? 0.8 : 0.3;

        this.circle.setStyle({
            color: this.type === 'input' ? 'green' : 'red',
            fillOpacity: this.enabled ? fillOpacity : 0,
            opacity: this.enabled ? 0.8 : 0,
        });

        const nodeBounds = this.node.getBounds();
        const lat = nodeBounds.getSouth() + (nodeBounds.getNorth() - nodeBounds.getSouth()) * this.offset.y;
        const lng = nodeBounds.getWest() + (nodeBounds.getEast() - nodeBounds.getWest()) * this.offset.x;
        const latlng = [lat, lng];
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

                mapPlanner.addLink({
                    from: fromNodeId,
                    to: toNodeId,
                    fromPin,
                    toPin
                });
                fromNode.update();
                toNode.update();
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
        this.isResource = data.isResource || false;

        this.rect = null;

        this.dragThresholdDistance = 8;
        this.mousedown = null;
        this.dragging = null;

        this.create();
    }

    getPin(type, index) {
        return this.pins.find(p => p.type === type && p.index === index);
    }

    getConnectionsForPin(pinType, pinIndex) {
        const pin = this.getPin(pinType, pinIndex);
        return pin ? pin.linkedLinks : [];
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
            interactive: !this.isResource,
        }).addTo(this.mapPlanner.layerGroup);

        if (!this.isResource) {
            this.rect.on('mousedown', (e) => this.handleMouseDown(e));
        }

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
        if (!this.isResource) {
            for (let i = 0; i < 4; i++) {
                const enabled = this.pinsEnabled[`input-${i}`] !== false;
                this.pins.push(new Pin(this, 'input', i, enabled));
            }
        }
        for (let i = 0; i < 4; i++) {
            const enabled = this.pinsEnabled[`output-${i}`] !== false;
            this.pins.push(new Pin(this, 'output', i, enabled));
        }

        this.update();
    }

    remove() {
        for (var pin of this.pins) {
            pin.remove();
        }
        this.mapPlanner.layerGroup.removeLayer(this.rect);
    }

    update() {
        const isSelected = this.mapPlanner.selectedNode === this;

        this.rect.setStyle({
            color: this.color,
            weight: isSelected ? 4 : 2,
            dashArray: isSelected ? '5, 5' : null,
        });

        const bounds = this.getBounds();
        this.rect.setBounds(bounds);

        if (this.icon) {
            this.iconOverlay.setUrl(`icons/${this.icon}.webp`);
            const iconBounds = bounds.pad(-0.85);
            this.iconOverlay.setBounds(iconBounds)
            this.iconOverlay.setOpacity(1);
        } else {
            this.iconOverlay.setOpacity(0);
        }

        this.nameTooltip.setContent(this.name);
        this.nameTooltip.setLatLng(bounds.getCenter());

        const currentZoom = this.mapPlanner.leafletMap.getZoom();
        if (currentZoom >= 7.25) {
            this.nameTooltip.setOpacity(0.9);
        } else {
            this.nameTooltip.setOpacity(0);
        }

        for (const pin of this.pins) {
            pin.update(bounds);
        }
    }

    handleMouseDown(e) {
        if (this.isResource) return;
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
            const newBounds = L.latLngBounds(p1, p2);
            this.dragging.ghostProxy.setBounds(newBounds);

            for (const pin of this.pins) {
                pin.update(newBounds);
            }

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

        this.x = this.mapPlanner.snapToGrid(newX);
        this.y = this.mapPlanner.snapToGrid(newY);
        this.update();
        this.mapPlanner.saveState();

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

                mapPlanner.addLink({
                    from: fromNodeId,
                    to: toNodeId,
                    fromPin,
                    toPin
                });
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

    toPlainObject() {
        if (this.isResource) {
            return null;
        }
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
