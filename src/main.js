import './style.css';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Node } from './Node.js';
import { Controls } from './Controls.js';
import { Link } from './Link.js';

const STORAGE_KEY = 'satisfactory-planner-data';

class MapPlanner {
  constructor() {
    this.backgroundSize = 32768;
    this.extraBackgroundSize = 4096;
    this.tileSize = 256;
    this.minTileZoom = 3;
    this.maxTileZoom = 8;
    this.mappingBoundWest = -324698.832031;
    this.mappingBoundEast = 425301.832031;
    this.mappingBoundNorth = -375e3;
    this.mappingBoundSouth = 375e3;
    this.gridSize = 800;
    this.leafletMap = L.map("map", {
      crs: L.CRS.Simple,
      minZoom: this.minTileZoom,
      maxZoom: this.maxTileZoom + 4,
      zoomDelta: .25,
      zoomSnap: .25,
      attributionControl: !1,
      preferCanvas: !0,
      fullscreenControl: !0
    });
    this.canvasRenderer = L.canvas();
    this.controls = new Controls(this);

    // Data
    this.nodes = [];
    this.links = [];

    // State
    this.interactionState = null; // Can be 'dragging', 'linking', or null
    this.selectedNode = null;
    this.nodeRectangles = new Map();
    this.layerGroup = L.layerGroup().addTo(this.leafletMap);
    this.previewLink = null;

    this.start();
  }

  start() {
    let e = (Math.abs(this.mappingBoundWest) + Math.abs(this.mappingBoundEast)) / this.backgroundSize
      , t = (Math.abs(this.mappingBoundNorth) + Math.abs(this.mappingBoundSouth)) / this.backgroundSize;
    this.westOffset = e * this.extraBackgroundSize;
    this.northOffset = t * this.extraBackgroundSize;
    this.mappingBoundWest -= this.westOffset;
    this.mappingBoundEast += this.westOffset;
    this.mappingBoundNorth -= this.northOffset;
    this.mappingBoundSouth += this.northOffset;
    this.backgroundSize += 2 * this.extraBackgroundSize;
    this.zoomRatio = this.zoomRatio();
    this.gameLayer = L.tileLayer("tiles/{z}/{x}/{y}.png", {
      crs: L.CRS.Simple,
      noWrap: !0,
      bounds: this.getBounds(),
      maxZoom: this.maxTileZoom + 4,
      maxNativeZoom: this.maxTileZoom
    }).addTo(this.leafletMap);
    this.leafletMap.setMaxBounds(this.getBounds());

    // Restore map state from hash or fit to bounds
    const savedState = this.getStateFromHash();
    if (savedState) {
      this.leafletMap.setView([savedState.lat, savedState.lng], savedState.zoom);
    } else {
      this.leafletMap.fitBounds(this.getBounds());
    }

    this.controls.initialize();
    this.setupSidebarListeners();
    this.setupInteractionHandlers();

    this.loadState();
    this.render();
  }

  snapToGrid(value) {
    return Math.round(value / this.gridSize) * this.gridSize;
  }

  enableEdit() {
    this.leafletMap.dragging.disable();
  }

  disableEdit() {
    this.leafletMap.dragging.enable();
  }

  setupSidebarListeners() {
    const form = document.getElementById('edit-node-form');
    form.addEventListener('input', (e) => {
      if (!this.selectedNode) return;

      this.selectedNode.name = document.getElementById('inp_name').value;
      this.selectedNode.x = this.snapToGrid(parseInt(document.getElementById('inp_x').value));
      this.selectedNode.y = this.snapToGrid(parseInt(document.getElementById('inp_y').value));
      this.selectedNode.width = this.snapToGrid(parseInt(document.getElementById('inp_w').value));
      this.selectedNode.height = this.snapToGrid(parseInt(document.getElementById('inp_h').value));
      this.selectedNode.color = document.getElementById('inp_color').value;
      this.selectedNode.outputs = document.getElementById('inp_out').value.split(',').filter(s => s.trim());
      this.saveState();
      this.render();
    });

    document.getElementById('btn_del').addEventListener('click', () => {
      if (this.selectedNode && confirm('Delete node?')) {
        this.nodes = this.nodes.filter(n => n.id !== this.selectedNode.id);
        this.links = this.links.filter(l => l.from !== this.selectedNode.id && l.to !== this.selectedNode.id);
        this.saveState();
        this.selectNode(null);
      }
    });
  }

  setupInteractionHandlers() {
    this.leafletMap.on('moveend zoomend', () => {
      this.saveStateToHash();
    });

    this.leafletMap.on('mousedown', (e) => {
      if (!this.controls.isEditMode) return;

      if (this.interactionState?.type === 'linking') {
        this.cancelLinking();
        return;
      }

      if (!this.interactionState) {
        this.selectNode(null);
      }
    });

    this.leafletMap.on('mousemove', (e) => {
      if (!this.interactionState) return;

      if (this.interactionState.type === 'linking') {
        this.updateLinkingPreview(e.latlng);
      } else if (this.interactionState.type === 'dragging') {
        this.interactionState.wasDragging = true;
        const { node, offset } = this.interactionState;
        const rasterPoint = this.project(e.latlng);
        const gameCoords = this.convertToGameCoordinates([rasterPoint.x, rasterPoint.y]);
        const newX = this.snapToGrid(gameCoords[0] - offset[0]);
        const newY = this.snapToGrid(gameCoords[1] - offset[1]);
        node.updatePosition(newX, newY);
      }
    });
  }

  startLinking(fromNode, fromType, fromIndex, startLatLng) {
    this.interactionState = {
      type: 'linking',
      fromNode,
      fromType,
      fromIndex,
      startLatLng
    };

    this.previewLink = L.polyline([startLatLng, startLatLng], {
      renderer: this.canvasRenderer,
      color: 'red', // Default to red
      weight: 3,
      dashArray: '5, 5',
      interactive: false
    }).addTo(this.layerGroup);
  }

  getPinAt(latlng) {
    for (const node of this.nodes) {
      const foundPin = node.pins.find(p => {
        return this.leafletMap.distance(latlng, p.getLatLng()) <= p.getRadius() * 1.5; // A bit more forgiving
      });
      if (foundPin) {
        return { node, pin: foundPin, pinType: foundPin.pinType };
      }
    }
    return null;
  }

  isValidLink(fromNode, fromType, toNode, toType) {
    if (!toNode || !toType) return false;
    if (fromNode.id === toNode.id) return false; // No self-linking
    if (fromType === toType) return false; // Must be input to output or vice-versa
    return true;
  }

  cancelLinking() {
    if (this.previewLink) {
      this.previewLink.remove();
      this.previewLink = null;
    }
    this.interactionState = null;
  }

  // --- State Management ---
  loadState() {
    const savedData = localStorage.getItem(STORAGE_KEY);
    if (savedData) {
      const data = JSON.parse(savedData);
      this.nodes = (data.nodes || []).map(nodeData => new Node(this, nodeData));
      this.links = (data.links || []).map(linkData => new Link(this, linkData));
    }
  }

  saveState() {
    const dataToSave = {
      nodes: this.nodes.map(node => node.toPlainObject()),
      links: this.links.map(link => link.toPlainObject()),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(dataToSave));
  }

  // --- Rendering ---
  render() {
    this.layerGroup.clearLayers();
    this.nodeRectangles.clear();

    this.renderNodes();
    this.renderLinks();
    this.renderSidebar();
  }

  addNode() {
    const centerLatLng = this.leafletMap.getCenter();
    const rasterPoint = this.project(centerLatLng);
    const gameCoords = this.convertToGameCoordinates([rasterPoint.x, rasterPoint.y]);

    const newNodeData = {
      id: 'n_' + Date.now(),
      x: this.snapToGrid(Math.round(gameCoords[0])),
      y: this.snapToGrid(Math.round(gameCoords[1])),
      width: 3200,
      height: 3200,
      name: 'New Node',
      color: '#5f5f5f',
    };
    const newNode = new Node(this, newNodeData);
    this.nodes.push(newNode);
    this.selectNode(newNode);
    this.saveState();
  }

  renderNodes() {
    this.nodes.forEach(node => {
      node.render();
    });
  }

  renderLinks() {
    this.links.forEach(link => {
      link.render();
    });
  }

  updateLinkingPreview(endLatLng) {
    if (!this.interactionState || this.interactionState.type !== 'linking') {
      this.cancelLinking();
      return;
    };

    const { startLatLng, fromNode, fromType } = this.interactionState;

    if (this.previewLink) {
      this.previewLink.setLatLngs([startLatLng, endLatLng]);

      // Check for valid target and update color
      const target = this.getPinAt(endLatLng);
      const isValid = this.isValidLink(fromNode, fromType, target?.node, target?.pinType);
      this.previewLink.setStyle({
        color: isValid ? 'green' : 'red'
      });
    }
  }

  renderSidebar() {
    const form = document.getElementById('edit-node-form');
    const placeholder = document.getElementById('sidebar-placeholder');

    if (!this.selectedNode) {
      form.style.display = 'none';
      placeholder.style.display = 'block';
      return;
    }

    form.style.display = 'block';
    placeholder.style.display = 'none';

    const node = this.selectedNode;
    document.getElementById('inp_name').value = node.name;
    document.getElementById('inp_x').value = node.x;
    document.getElementById('inp_y').value = node.y;
    document.getElementById('inp_w').value = node.width;
    document.getElementById('inp_h').value = node.height;
    document.getElementById('inp_color').value = node.color;
    document.getElementById('inp_out').value = (node.outputs || []).join(',');

    // Render input connections
    const inputsContainer = document.getElementById('connections-inputs');
    inputsContainer.innerHTML = '';
    node.inputs.forEach((inputLabel, index) => {
      const connectedNode = node.getConnectedNode('input', index);
      const connectionDiv = document.createElement('div');
      connectionDiv.className = 'connection-item';
      if (connectedNode) {
        connectionDiv.innerHTML = `<strong>${index + 1}. ${inputLabel}</strong><br/><span class="connection-status connected">Connected to: ${connectedNode.name}</span>`;
      } else {
        connectionDiv.innerHTML = `<strong>${index + 1}. ${inputLabel}</strong><br/><span class="connection-status">Not connected</span>`;
      }
      inputsContainer.appendChild(connectionDiv);
    });

    // Render output connections
    const outputsContainer = document.getElementById('connections-outputs');
    outputsContainer.innerHTML = '';
    node.outputs.forEach((outputLabel, index) => {
      const connectedNode = node.getConnectedNode('output', index);
      const connectionDiv = document.createElement('div');
      connectionDiv.className = 'connection-item';
      if (connectedNode) {
        connectionDiv.innerHTML = `<strong>${index + 1}. ${outputLabel}</strong><br/><span class="connection-status connected">Connected to: ${connectedNode.name}</span>`;
      } else {
        connectionDiv.innerHTML = `<strong>${index + 1}. ${outputLabel}</strong><br/><span class="connection-status">Not connected</span>`;
      }
      outputsContainer.appendChild(connectionDiv);
    });
  }

  selectNode(node) {
    this.selectedNode = node;
    this.render();
  }

  getStateFromHash() {
    const hash = window.location.hash.slice(1);
    if (!hash) return null;

    const parts = hash.split('/').map(parseFloat);
    const [zoom, lat, lng] = parts;
    return (zoom && lat && lng) ? { zoom, lat, lng } : null;
  }

  saveStateToHash() {
    const center = this.leafletMap.getCenter();
    const zoom = this.leafletMap.getZoom();
    window.location.hash = `${zoom}/${center.lat}/${center.lng}`;
  }

  renderLink(startNode, endNode) {
    const p1 = { x: startNode.x + startNode.width, y: startNode.y + (startNode.height / 2) };
    const p2 = { x: endNode.x, y: endNode.y + (endNode.height / 2) };

    const midX = p1.x + (p2.x - p1.x) / 2;

    const gameCoords = [
      [p1.x, p1.y],
      [midX, p1.y],
      [midX, p2.y],
      [p2.x, p2.y]
    ];

    const latLngs = gameCoords.map(p => this.unproject(p));

    L.polyline(latLngs, {
      renderer: this.canvasRenderer,
      color: 'gray',
      weight: 3
    }).addTo(this.layerGroup);
  }
  unprojectNode(node) {
    const p1 = this.unproject([node.x, node.y]);
    const p2 = this.unproject([node.x + node.width, node.y + node.height]);
    return [p1, p2];
  }
  zoomRatio() {
    return Math.ceil(Math.log(Math.max(this.backgroundSize, this.backgroundSize) / this.tileSize) / Math.log(2));
  }
  unproject(e) {
    return this.leafletMap.unproject(this.convertToRasterCoordinates(e), this.zoomRatio)
  }
  project(e) {
    return this.leafletMap.project(e, this.zoomRatio)
  }
  getBounds() {
    let e = this.leafletMap.unproject([0, this.backgroundSize], this.zoomRatio)
      , t = this.leafletMap.unproject([this.backgroundSize, 0], this.zoomRatio);
    return new L.LatLngBounds(e, t)
  }
  getCenter() {
    return this.leafletMap.unproject([this.backgroundSize / 2, this.backgroundSize / 2], this.zoomRatio)
  }
  convertToRasterCoordinates(e) {
    let t = parseFloat(e[0]) || 0
      , a = parseFloat(e[1]) || 0
      , s = Math.abs(this.mappingBoundWest) + Math.abs(this.mappingBoundEast)
      , r = Math.abs(this.mappingBoundNorth) + Math.abs(this.mappingBoundSouth)
      , i = Math.abs(this.backgroundSize) / s
      , o = Math.abs(this.backgroundSize) / r;
    return t = (s - this.mappingBoundEast + t) * i,
      a = (r - this.mappingBoundNorth + a) * o - this.backgroundSize,
      [t, a]
  }
  convertToGameCoordinates(e) {
    let t = parseFloat(e[0]) || 0
      , a = parseFloat(e[1]) || 0
      , s = Math.abs(this.mappingBoundWest) + Math.abs(this.mappingBoundEast)
      , r = Math.abs(this.mappingBoundNorth) + Math.abs(this.mappingBoundSouth)
      , i = s / Math.abs(this.backgroundSize)
      , o = r / Math.abs(this.backgroundSize);
    return t = t * i - (s - this.mappingBoundEast),
      a = a * o - (r - this.mappingBoundNorth) + r,
      [t, a]
  }
}

const map = new MapPlanner();
