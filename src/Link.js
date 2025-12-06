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

    // Returns current polyline (A* result if available, else fallback elbow)
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

        // Fallback: simple elbow in screen-projected space
        const p1 = this.mapPlanner.leafletMap.project(startLL);
        const p2 = this.mapPlanner.leafletMap.project(endLL);
        const midX = p1.x + (p2.x - p1.x) / 2;
        const points = [
            p1,
            { x: midX, y: p1.y },
            { x: midX, y: p2.y },
            p2
        ];
        return points.map(p => this.mapPlanner.leafletMap.unproject(p));
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
        const [sx, sy] = this.mapPlanner.convertToGameCoordinates([sp.x, sp.y]);
        const [ex, ey] = this.mapPlanner.convertToGameCoordinates([ep.x, ep.y]);

        const cell = Math.max(150, this.mapPlanner.gridSize); // cell size in game coords (smaller min for smoother paths)

        // Calculate grid offset to center the grid on the start pin
        const offsetX = (sx % cell) - (cell / 2);
        const offsetY = (sy % cell);

        // Build a local grid around endpoints
        const padding = Math.max(this.startNode.width, this.endNode.width) * 4;
        const minX = Math.min(sx, ex) - padding - offsetX;
        const maxX = Math.max(sx, ex) + padding - offsetX;
        const minY = Math.min(sy, ey) - padding - offsetY;
        const maxY = Math.max(sy, ey) + padding - offsetY;

        const cols = Math.max(2, Math.ceil((maxX - minX) / cell) + 1);
        const rows = Math.max(2, Math.ceil((maxY - minY) / cell) + 1);

        // Helper mappings
        const toCellX = (x) => Math.min(cols - 1, Math.max(0, Math.floor((x - minX) / cell)));
        const toCellY = (y) => Math.min(rows - 1, Math.max(0, Math.floor((y - minY) / cell)));
        const toPoint = (cx, cy) => [minX + cx * cell + cell / 2, minY + cy * cell + cell / 2];

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
            for (let cy = mincY; cy <= maxcY; cy++) {
                for (let cx = mincX; cx <= maxcX; cx++) {
                    if (blockInside) {
                        grid[cy][cx] = 0; // 0 = blocked
                    } else {
                        // Only increase cost, never decrease
                        grid[cy][cx] = Math.max(grid[cy][cx], value);
                    }
                }
            }
        };

        const haloCells = 1;

        for (const node of this.mapPlanner.nodes) {
            // Skip if node entirely outside local bbox
            const nx1 = node.x;
            const ny1 = node.y;
            const nx2 = node.x + node.width;
            const ny2 = node.y + node.height;
            if (nx2 < minX || nx1 > maxX || ny2 < minY || ny1 > maxY) continue;

            // Add a stronger, wider halo to discourage hugging borders
            const halo = haloCells * cell;
            markRect(nx1 - halo, ny1 - halo, nx2 + halo, ny2 + halo, 55, false);
            markRect(nx1, ny1, nx2, ny2, 0, true);
        }
        const gridString = grid.map(row =>
          row.map(cell => String(cell).padStart(3, ' ')).join('')
        ).join('\n');
        console.log(gridString);

        // Carve start/end cells to be walkable (will be refined by pin corridors below)
        grid[startCY][startCX] = 1;
        grid[endCY][endCX] = 1;

        // Create helper to hard-set a cell (even if previously blocked)
        const forceSetCell = (cy, cx, value) => {
            if (cy < 0 || cy >= rows || cx < 0 || cx >= cols) return;
            grid[cy][cx] = value;
        };
        const raiseCellCost = (cy, cx, value) => {
            if (cy < 0 || cy >= rows || cx < 0 || cx >= cols) return;
            if (grid[cy][cx] !== 0) grid[cy][cx] = Math.max(grid[cy][cx], value);
        };

        // Carve short outward corridors from pin cells through node boundary and halo
        const carveCorridor = (px, py, node, startCx, startCy) => {
            const nx1 = node.x, ny1 = node.y, nx2 = node.x + node.width, ny2 = node.y + node.height;
            const dLeft = Math.abs(px - nx1);
            const dRight = Math.abs(nx2 - px);
            const dTop = Math.abs(py - ny1);
            const dBottom = Math.abs(ny2 - py);
            let dir = [0, 0];
            let axis = 'x';
            const minD = Math.min(dLeft, dRight, dTop, dBottom);
            if (minD === dLeft) { dir = [-1, 0]; axis = 'x'; }
            else if (minD === dRight) { dir = [1, 0]; axis = 'x'; }
            else if (minD === dTop) { dir = [0, -1]; axis = 'y'; }
            else { dir = [0, 1]; axis = 'y'; }

            const corridorLenCells = 2 + haloCells; // exit node + clear halo
            let cx = startCx, cy = startCy;
            for (let k = 0; k < corridorLenCells; k++) {
                forceSetCell(cy, cx, 3); // low-cost corridor
                cx += dir[0];
                cy += dir[1];
            }
            // Slightly raise cost at the very first cell to avoid lingering on node edge
            raiseCellCost(startCy, startCx, 6);
        };

        carveCorridor(sx, sy, this.startNode, startCX, startCY);
        carveCorridor(ex, ey, this.endNode, endCX, endCY);

        // Penalize running parallel to existing links, but allow cheap crossings
        const otherLinks = this.mapPlanner.getLinks().filter(l => l !== this && l.polyline);
        for (const l of otherLinks) {
            const ll = l.polyline.getLatLngs();
            for (let i = 0; i < ll.length - 1; i++) {
                const a = this.mapPlanner.project(ll[i]);
                const b = this.mapPlanner.project(ll[i + 1]);
                const [ax, ay] = this.mapPlanner.convertToGameCoordinates([a.x, a.y]);
                const [bx, by] = this.mapPlanner.convertToGameCoordinates([b.x, b.y]);
                // sample along segment
                const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / cell));
                for (let s = 0; s <= steps; s++) {
                    const tx = ax + (bx - ax) * (s / steps);
                    const ty = ay + (by - ay) * (s / steps);
                    const cx = toCellX(tx);
                    const cy = toCellY(ty);
                    if (grid[cy]) {
                        // Core link cell: small cost, so crossing is cheap
                        if (grid[cy][cx] !== 0) grid[cy][cx] = Math.max(grid[cy][cx], 6);
                        // Neighbor ring: higher cost to discourage running parallel alongside
                        const neigh = [
                            [cy-1, cx], [cy+1, cx], [cy, cx-1], [cy, cx+1]
                        ];
                        for (const [ny, nx] of neigh) {
                            if (ny < 0 || ny >= rows || nx < 0 || nx >= cols) continue;
                            if (grid[ny][nx] !== 0) grid[ny][nx] = Math.max(grid[ny][nx], 14);
                        }
                    }
                }
            }
        }

        // Setup EasyStar
        const easystar = new EasyStar.js();
        easystar.setGrid(grid);
        // Acceptable tiles include base walkable and all weighted costs we use
        easystar.setAcceptableTiles([1, 3, 5, 6, 10, 12, 14, 25, 55]);
        easystar.setTileCost(3, 3);   // pin corridor core
        easystar.setTileCost(5, 5);   // legacy light penalty (unused mostly)
        easystar.setTileCost(6, 6);   // link core (cheap to cross)
        easystar.setTileCost(10, 20); // legacy heavier penalty
        easystar.setTileCost(12, 12); // medium overlap discouragement
        easystar.setTileCost(14, 14); // near-link ring (discourage parallel running)
        easystar.setTileCost(25, 30); // old halo
        easystar.setTileCost(55, 55); // strong halo cost
        //easystar.enableCornerCutting(false);
        //easystar.disableDiagonals();
        easystar.setIterationsPerCalculation(2000);

        let finished = false;
        //console.log(startCX + " " + startCY + " " + endCX + " " + endCY)
        easystar.findPath(startCX, startCY, endCX, endCY, (path) => {
            finished = true;
            if (!path || path.length === 0) {
                // leave fallback; just request a visual refresh
                this._pathLatLngs = null;
                this.polyline.setLatLngs(this.getLatLngs());
                return;
            }
            // Convert path to game coords, simplify, prune, and stitch exact pin endpoints
            const pts = path.map(p => toPoint(p.x, p.y));
            let simplified = this._simplifyOrthogonal(pts);
            simplified = this._pruneShortSegments(simplified, Math.max(1, 0.4 * cell));
            //const stitched = this._stitchEndpoints([sx, sy], simplified, [ex, ey], cell);
            const stitched = simplified;
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

    // Simplify a polyline that moves on a grid by removing middle points on straight lines
    _simplifyOrthogonal(points) {
        if (points.length <= 2) return points;
        const res = [points[0]];
        let prevDx = null, prevDy = null;
        for (let i = 1; i < points.length; i++) {
            const [x0, y0] = res[res.length - 1];
            const [x1, y1] = points[i];
            const dx = Math.sign(x1 - x0);
            const dy = Math.sign(y1 - y0);
            if (prevDx === dx && prevDy === dy) {
                // continue straight, replace last point
                res[res.length - 1] = [x1, y1];
            } else {
                res.push([x1, y1]);
                prevDx = dx; prevDy = dy;
            }
        }
        return res;
    }

    // Remove duplicate and near-duplicate points and tiny wiggles
    _pruneShortSegments(points, minLen = 1) {
        if (!points || points.length < 3) return points || [];
        const dist = (a,b)=> Math.hypot(a[0]-b[0], a[1]-b[1]);
        const out = [points[0]];
        for (let i = 1; i < points.length - 1; i++) {
            const prev = out[out.length - 1];
            const curr = points[i];
            const next = points[i+1];
            // Drop exact duplicates
            if ((curr[0] === prev[0] && curr[1] === prev[1])) continue;
            // Drop extremely short collinear steps
            if ((prev[0] === curr[0] && curr[0] === next[0]) || (prev[1] === curr[1] && curr[1] === next[1])) {
                if (dist(prev, curr) < minLen) continue;
            }
            out.push(curr);
        }
        out.push(points[points.length - 1]);
        return out;
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
        // Final simplify
        return this._simplifyOrthogonal(this._pruneShortSegments(result, Math.max(1, 0.25 * cell)));
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
