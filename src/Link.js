import L from 'leaflet';
import EasyStar from 'easystarjs';

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

        // Pathfinding state
        this._pathLatLngs = null;
        this._lastEndpointsKey = null;
        this._recomputeScheduled = false;

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

        // Update geometry; may trigger recomputation
        const latlngs = this.getLatLngs();
        this.polyline.setLatLngs(latlngs);
    }

    // Returns current polyline (A* result if available)
    getLatLngs() {
        if (!this.startPin || !this.endPin) return [];

        const startLL = this.startPin.circle.getLatLng();
        const endLL = this.endPin.circle.getLatLng();
        const key = `${startLL.lat.toFixed(5)},${startLL.lng.toFixed(5)}-${endLL.lat.toFixed(5)},${endLL.lng.toFixed(5)}`;
        if (this._lastEndpointsKey !== key) {
            this._lastEndpointsKey = key;
            this._pathLatLngs = null; // invalidate
            this._schedulePathRecompute();
        }

        if (this._pathLatLngs && this._pathLatLngs.length > 0) {
            return this._pathLatLngs;
        }
        return [];
    }

    _schedulePathRecompute() {
        if (this._recomputeScheduled) return;
        this._recomputeScheduled = true;
        setTimeout(() => {
            this._recomputeScheduled = false;
            this._computeAStarPathAsync();
        }, 50);
    }

    _computeAStarPathAsync() {
        if (!this.startPin || !this.endPin) return;

        // Convert pin lat/lng to game coordinates
        const map = this.mapPlanner.leafletMap;
        const sp = this.mapPlanner.project(this.startPin.circle.getLatLng());
        const ep = this.mapPlanner.project(this.endPin.circle.getLatLng());
        let [sx, sy] = this.mapPlanner.convertToGameCoordinates([sp.x, sp.y]);
        let [ex, ey] = this.mapPlanner.convertToGameCoordinates([ep.x, ep.y]);

        // Build a local grid around endpoints – snap the local grid to the global building grid
        // so EasyStar cell centers always fall in the center of building cells
        const resolution = this.mapPlanner.gridSize;
        const padding = resolution * 4; // local bbox padding in game units

        // Raw min/max bounds around the endpoints
        const rawMinX = Math.min(sx, ex) - padding;
        const rawMaxX = Math.max(sx, ex) + padding;
        const rawMinY = Math.min(sy, ey) - padding;
        const rawMaxY = Math.max(sy, ey) + padding;

        // Snap local grid bounds to the global grid lines
        const minX = Math.floor(rawMinX / resolution) * resolution;
        const maxX = Math.ceil(rawMaxX / resolution) * resolution;
        const minY = Math.floor(rawMinY / resolution) * resolution;
        const maxY = Math.ceil(rawMaxY / resolution) * resolution;

        // Compute discrete grid dimensions (inclusive end, centers at +res/2)
        const cols = Math.round((maxX - minX) / resolution) + 1;
        const rows = Math.round((maxY - minY) / resolution) + 1;

        // Helper mappings
        const toCellX = (x) => Math.min(cols - 1, Math.max(0, Math.floor((x - minX) / resolution)));
        const toCellY = (y) => Math.min(rows - 1, Math.max(0, Math.floor((y - minY) / resolution)));
        const toPoint = (cx, cy) => [minX + cx * resolution + resolution / 2, minY + cy * resolution + resolution / 2];

        const startCX = toCellX(sx), startCY = toCellY(sy);
        const endCX = toCellX(ex), endCY = toCellY(ey);

        // Build grid with default walkable cost 1
        const grid = new Array(rows);
        for (let y = 0; y < rows; y++) {
            const row = new Array(cols);
            for (let x = 0; x < cols; x++) row[x] = 1; // 1 = normal walkable
            grid[y] = row;
        }

        // Rasterize node obstacles and halos
        const markRect = (x1, y1, x2, y2, value, blockInside = false) => {
            const mincX = toCellX(Math.min(x1, x2));
            const maxcX = toCellX(Math.max(x1, x2));
            const mincY = toCellY(Math.min(y1, y2));
            const maxcY = toCellY(Math.max(y1, y2));
            for (let cy = mincY; cy < maxcY; cy++) {
                for (let cx = mincX; cx < maxcX; cx++) {
                    if (blockInside) {
                        grid[cy][cx] = 9; // 9 = blocked
                    } else {
                        // Only increase cost, never decrease
                        grid[cy][cx] = Math.max(grid[cy][cx], value);
                    }
                }
            }
        };

        const haloCells = 1;

        for (const node of this.mapPlanner.nodes) {
            // Use live/proxy bounds during drag if available
            const gb = (typeof node.getCurrentGameBounds === 'function')
                ? node.getCurrentGameBounds()
                : [node.x, node.y, node.x + node.width, node.y + node.height];
            const nx1 = gb[0];
            const ny1 = gb[1];
            const nx2 = gb[2];
            const ny2 = gb[3];

            if (nx2 < minX || nx1 > maxX || ny2 < minY || ny1 > maxY) continue;

            const halo = haloCells * resolution;
            markRect(nx1 - halo, ny1 - halo, nx2 + halo, ny2 + halo, 3, false);
            markRect(nx1, ny1, nx2, ny2, 9, true);
        }

        const isNullish = (v) => v === null || v === undefined;
        const otherLinks = this.mapPlanner.getLinks().filter(l =>
            l !== this &&
            l.polyline &&
            l._pathLatLngs && l._pathLatLngs.length > 0 &&
            !l._recomputeScheduled &&
            isNullish(l.startNode?._proxyX) &&
            isNullish(l.endNode?._proxyX)
        );
        for (const l of otherLinks) {
            const ll = l.polyline.getLatLngs();
            for (let i = 0; i < ll.length - 1; i++) {
                const a = this.mapPlanner.project(ll[i]);
                const b = this.mapPlanner.project(ll[i + 1]);
                const [ax, ay] = this.mapPlanner.convertToGameCoordinates([a.x, a.y]);
                const [bx, by] = this.mapPlanner.convertToGameCoordinates([b.x, b.y]);

                const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / resolution));
                for (let s = 0; s <= steps; s++) {
                    const tx = ax + (bx - ax) * (s / steps);
                    const ty = ay + (by - ay) * (s / steps);
                    const cx = toCellX(tx);
                    const cy = toCellY(ty);
                    if (grid[cy]) {
                        if (grid[cy][cx] !== 0) grid[cy][cx] = Math.max(grid[cy][cx], 6);
                    }
                }
            }
        }

        // Publish debug data for grid overlay
        if (this.mapPlanner && typeof this.mapPlanner.setAStarDebugData === 'function') {
            this.mapPlanner.setAStarDebugData({
                grid,
                minX,
                minY,
                rows,
                cols,
                resolution
            });
        }

        // Setup EasyStar
        const easystar = new EasyStar.js();
        easystar.setGrid(grid);
        easystar.setAcceptableTiles([1, 3, 6]);
        easystar.setTileCost(3, 3);
        easystar.setTileCost(6, 6);
        easystar.enableDiagonals();
        easystar.setIterationsPerCalculation(2000);

        let finished = false;
        easystar.findPath(startCX, startCY, endCX, endCY, (path) => {
            finished = true;
            if (!path || path.length === 0) {
                this._pathLatLngs = null;
                this.polyline.setLatLngs(this.getLatLngs());
                return;
            }
            // Convert path to game coords, simplify, prune, and stitch exact pin endpoints
            const pts = path.map(p => toPoint(p.x, p.y));
            const stitched = this._stitchEndpoints([sx, sy], pts, [ex, ey], resolution);
            const latlngs = stitched.map(([gx, gy]) => this.mapPlanner.unproject([gx, gy]));
            this._pathLatLngs = latlngs;
            this.polyline.setLatLngs(latlngs);
        });

        const tick = () => {
            if (finished) return;
            easystar.calculate();
            if (!finished) setTimeout(tick, 0);
        };
        tick();
    }

    // Ensure the path starts/ends exactly at the pin positions with an orthogonal join
    _stitchEndpoints(start, points, end, cell = 100) {
        const stitchAxis = (a, b) => {
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            if (dx === 0 || dy === 0) return [];
            // Prefer the dominant axis first to keep it tidy
            if (Math.abs(dx) >= Math.abs(dy)) {
                return [[a[0] + Math.sign(dx) * Math.min(Math.abs(dx), cell * 0.5), a[1]], [b[0], a[1]]];
            } else {
                return [[a[0], a[1] + Math.sign(dy) * Math.min(Math.abs(dy), cell * 0.5)], [a[0], b[1]]];
            }
        };

        let path = points && points.length ? [...points] : [end];
        const result = [];
        // Start at exact pin
        result.push([start[0], start[1]]);
        if (path.length > 0) {
            const first = path[0];
            if (!(first[0] === start[0] || first[1] === start[1])) {
                const seg = stitchAxis(start, first);
                for (const p of seg) result.push(p);
            }
        }
        for (const p of path) result.push(p);
        // End stitching
        const last = path[path.length - 1] || start;
        if (!(end[0] === last[0] || end[1] === last[1])) {
            const seg2 = stitchAxis(last, end);
            for (const p of seg2) result.push(p);
        }
        result.push([end[0], end[1]]);
        return result;
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
