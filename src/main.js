import './style.css';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Node } from './Node.js';
import { Controls } from './Controls.js';
import { Link } from './Link.js';

const STORAGE_KEY = 'satisfactory-planner-data';

// Simple debounce utility for performance-sensitive handlers
function debounce(fn, wait = 150) {
  let t;
  return function debounced(...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}

const resourceColorMap = {
    'Iron Ore': '#c0c0c0',
    'Copper Ore': '#ff7f50',
    'Limestone': '#a9a9a9',
    'Coal': '#36454f',
    'Caterium Ore': '#f5deb3',
    'Raw Quartz': '#f0e68c',
    'Sulfur': '#ffff00',
    'Bauxite': '#c19a6b',
    'SAM Ore': '#808000',
    'Uranium': '#00ff00',
};

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
      renderer: L.canvas(),
      crs: L.CRS.Simple,
      minZoom: this.minTileZoom,
      maxZoom: this.maxTileZoom + 4,
      zoomDelta: .25,
      zoomSnap: .25,
      attributionControl: !1,
      preferCanvas: !0,
      fullscreenControl: !0
    });
    this.controls = new Controls(this);

    // Data
    this.nodes = [];
    this.linkMap = new Map();

    // State
    this.clickedNode = null;
    this.selectedNodes = [];
    this.selectedLink = null;
    this.previewLink = null;
    // deprecated
    this.interactionState = null; // Can be 'dragging', 'linking', or null
    this.layerGroup = L.layerGroup().addTo(this.leafletMap);
    this.selectionRect = null;
    this.selectionStartPoint = null;

    // Debug grid overlay
    this.showPathGridDebug = false;
    this.debugGridLayer = L.layerGroup().addTo(this.leafletMap);
    this._latestAStarDebug = null; // {grid, minX, minY, rows, cols, resolution}

    // Debounce persistence and hash updates for performance
    this._saveStateImmediate = this.saveState.bind(this);
    this.saveState = debounce(this._saveStateImmediate, 150);
    this._saveStateToHashImmediate = this.saveStateToHash.bind(this);
    this.saveStateToHash = debounce(this._saveStateToHashImmediate, 120);

    this.start();

    // Keyboard toggle for grid debug
    window.addEventListener('keydown', (ev) => {
      if (ev.key.toLowerCase() === 'g') {
        this.toggleGridDebug();
      }
    });
  }

  async start() {
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
    this.gameLayer = L.tileLayer("tiles/{z}/{x}/{y}.webp", {
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

    await this.loadRecipes();
    await this.load();
  }

  snapToGrid(value) {
    return Math.round(value / this.gridSize) * this.gridSize;
  }

  // Recipes loader
  async loadRecipes() {
    try {
      const res = await fetch('recipes.json');
      const data = await res.json();
      // Normalize into maps for quick lookup
      this.recipes = data;
      this.recipesById = new Map(data.map(r => [r.id, r]));
      this.recipesByOutput = new Map();
      for (const r of data) {
        for (const o of r.outputs) {
          const list = this.recipesByOutput.get(o.item) || [];
          list.push(r);
          this.recipesByOutput.set(o.item, list);
        }
      }
    } catch (e) {
      console.error('Failed to load recipes.json', e);
      this.recipes = [];
      this.recipesById = new Map();
      this.recipesByOutput = new Map();
    }
  }

  enableEdit() {
    this.leafletMap.dragging.disable();
  }

  disableEdit() {
    this.leafletMap.dragging.enable();
  }

  setupSidebarListeners() {
    const nodeForm = document.getElementById('edit-node-form');
    nodeForm.addEventListener('input', (e) => {
      if (this.selectedNodes.length === 0) return;
      const selectedNode = this.selectedNodes[0];

      selectedNode.name = document.getElementById('inp_name').value;
      /*selectedNode.x = this.snapToGrid(parseInt(document.getElementById('inp_x').value));
      selectedNode.y = this.snapToGrid(parseInt(document.getElementById('inp_y').value));
      selectedNode.width = this.snapToGrid(parseInt(document.getElementById('inp_w').value));
      selectedNode.height = this.snapToGrid(parseInt(document.getElementById('inp_h').value));*/
      selectedNode.color = document.getElementById('inp_color').value;
      const orientationInput = document.getElementById('inp_orientation');
      if (orientationInput) {
        selectedNode.orientation = orientationInput.value;
      }

      selectedNode.update();
      this.saveState();
    });

    document.getElementById('btn_del_node').addEventListener('click', () => {
        if (this.selectedNodes.length > 0 && confirm('Delete selected nodes?')) {
            for (const selectedNode of this.selectedNodes) {
                const deletedNodeId = selectedNode.id;
                const connectedLinks = this.linkMap.get(deletedNodeId) || [];

                for (const link of [...connectedLinks]) {
                    link.remove();
                    this.removeLink(link);
                }

                selectedNode.remove();
                this.nodes = this.nodes.filter(n => n.id !== deletedNodeId);
                this.linkMap.delete(deletedNodeId);
            }

            this.saveState();
            this.clearSelection();
        }
    });

    const linkForm = document.getElementById('edit-link-form');
    linkForm.addEventListener('input', (e) => {
      if (!this.selectedLink) return;
      this.selectedLink.color = document.getElementById('inp_link_color').value;
      this.selectedLink.update();
      this.saveState();
    });

    document.getElementById('btn_del_link').addEventListener('click', () => {
        if (this.selectedLink && confirm('Delete link?')) {
            const linkToRemove = this.selectedLink;
            linkToRemove.remove();
            this.removeLink(linkToRemove);
            this.selectLink(null);
            this.saveState();
        }
    });
  }

  setupInteractionHandlers() {
    this.leafletMap.on('moveend zoomend', () => {
      this.saveStateToHash();
    });

    this.leafletMap.on('zoomend', () => {
      // Light-weight zoom handler: only toggle name tooltip visibility
      const z = this.leafletMap.getZoom();
      const show = z >= 7.25;
      for (const node of this.nodes) {
        if (node.nameTooltip) node.nameTooltip.setOpacity(show ? 0.9 : 0);
      }
    });

    this.leafletMap.on('mousedown', (e) => {
      if (!this.controls.isEditMode) return;

      if (this.interactionState?.type === 'linking') {
        this.cancelLinking();
        return;
      }

      if (e.originalEvent.target.classList.contains('leaflet-interactive')) {
        return;
      }

      this.selectionStartPoint = e.latlng;
      this.selectionRect = L.rectangle([this.selectionStartPoint, this.selectionStartPoint], {
        color: '#007bff',
        weight: 1,
        fillOpacity: 0.2,
        interactive: false
      }).addTo(this.leafletMap);

      if (!this.interactionState) {
        this.clearSelection();
        this.selectLink(null);
      }
    });

    this.leafletMap.on('mousemove', (e) => {
      if (this.clickedNode) {
        this.clickedNode.handleOnMouseMove(e);
      }

      if (this.selectionRect) {
        this.selectionRect.setBounds([this.selectionStartPoint, e.latlng]);
      }

      if (!this.interactionState) return;

      if (this.interactionState.type === 'linking') {
        this.updateLinkingPreview(e.latlng);
      }
    });

    // Ensure mouseup anywhere finalizes drag or click via the node
    this.leafletMap.on('mouseup', (e) => {
      if (this.clickedNode) {
        this.clickedNode.handleMouseUp(e);
      }

      if (this.selectionRect) {
        const selectionBounds = this.selectionRect.getBounds();
        this.selectionRect.remove();
        this.selectionRect = null;

        const selectedNodes = this.nodes.filter(node => {
          const nodeBounds = node.getBounds();
          return selectionBounds.intersects(nodeBounds) || selectionBounds.contains(nodeBounds);
        });
        this.selectNodes(selectedNodes);
      }

      if (!this.interactionState) return;
      if (this.interactionState.type === 'linking') return;
      const activeNode = this.interactionState.node;
      if (activeNode && typeof activeNode.handleMouseUp === 'function') {
        activeNode.handleMouseUp(e);
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
      color: 'red',
      weight: 3,
      dashArray: '5, 5',
      interactive: false
    }).addTo(this.layerGroup);

    for (const link of this.getLinks()) {
        if (link.polyline) {
            link.polyline.options.interactive = false;
        }
    }
  }

  getPinAt(latlng) {
    const lp = this.leafletMap.latLngToContainerPoint(latlng);
    for (const node of this.nodes) {
      const foundPin = node.pins.find(p => {
        if (!p.enabled) return false;
        const pp = this.leafletMap.latLngToContainerPoint(p.circle.getLatLng());
        const dist = lp.distanceTo(pp);
        return dist <= (p.circle.getRadius ? p.circle.getRadius() : 6) * 1.5;
      });
      if (foundPin) {
        return { node, pin: foundPin };
      }
    }
    return null;
  }

  isValidLink(fromNode, fromType, toNode, toType, fromIndex, toIndex) {
    if (!toNode || !toType) return false;
    if (fromNode.id === toNode.id) return false; // No self-linking
    if (fromType === toType) return false; // Must be input to output or vice-versa

    // Determine source (output) and target (input) nodes and indices
    const srcNode = fromType === 'output' ? fromNode : toNode;
    const dstNode = fromType === 'output' ? toNode : fromNode;
    const srcIndex = fromType === 'output' ? fromIndex : toIndex;
    const dstIndex = fromType === 'output' ? toIndex : fromIndex;

    // Both pins must exist and be enabled
    const srcPin = srcNode.getPin('output', srcIndex);
    const dstPin = dstNode.getPin('input', dstIndex);
    if (!srcPin || !dstPin) return false;
    if (!srcPin.enabled || !dstPin.enabled) return false;

    // Compute/ensure expected IO is present
    if (!srcNode.isResource) this.applyRecipesToNode(srcNode);
    if (!dstNode.isResource) this.applyRecipesToNode(dstNode);

    const srcItem = this.getPinItem(srcNode, 'output', srcIndex);
    const dstItem = this.getPinItem(dstNode, 'input', dstIndex);

    // If either side has no defined item (e.g., missing recipes), allow linking
    if (!srcItem || !dstItem) return true;

    return srcItem === dstItem;
  }

  cancelLinking() {
    if (this.previewLink) {
      this.previewLink.remove();
      this.previewLink = null;
    }
    this.interactionState = null;

    for (const link of this.getLinks()) {
        if (link.polyline) {
            link.polyline.options.interactive = true;
        }
    }
  }

  // --- State Management ---
  async load() {
    const savedData = localStorage.getItem(STORAGE_KEY);
    const data = savedData ? JSON.parse(savedData) : {};

    this.nodes = (data.nodes || []).map(nodeData => new Node(this, nodeData));

    await this.loadResourceNodes();

    (data.links || []).forEach(linkData => this.addLink(linkData, false));

    for (const node of this.nodes) {
        if (!node.isResource) this.applyRecipesToNode(node);
        node.update();
    }
  }

  async loadResourceNodes() {
    const response = await fetch('resource_nodes.json');
    const data = await response.json();
    data.forEach(resource => {
      resource.nodes.forEach(nodeData => {
        const newNode = new Node(this, {
          id: 'resource_' + resource.type + '_' + nodeData.x + '_' + nodeData.y,
          x: nodeData.x,
          y: nodeData.y,
          width: 1200,
          height: 1200,
          name: resource.name + ' (' + nodeData.purity + ')',
          color: resourceColorMap[resource.name] || '#ff0000',
          isResource: true
        });
        this.nodes.push(newNode);
      });
    });
  }

  saveState() {
    const dataToSave = {
        nodes: this.nodes.map(node => node.toPlainObject()).filter(Boolean),
        links: this.getLinks().map(link => link.toPlainObject()),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(dataToSave));
  }

  getLinks() {
    return [...new Set(Array.from(this.linkMap.values()).flat())];
  }

  // --- Rendering ---
  render() {
    this.layerGroup.clearLayers();
    this.createSidebar();
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
      orientation: 'up',
    };
    const newNode = new Node(this, newNodeData);
    this.nodes.push(newNode);
    this.selectNodes([newNode]);
    this.saveState();
  }

  addLink(linkData, save = true) {
    const newLink = new Link(this, linkData);

    if (!this.linkMap.has(newLink.from)) {
        this.linkMap.set(newLink.from, []);
    }
    this.linkMap.get(newLink.from).push(newLink);

    if (!this.linkMap.has(newLink.to)) {
        this.linkMap.set(newLink.to, []);
    }
    this.linkMap.get(newLink.to).push(newLink);

    if (save) {
        this.saveState();
    }
    return newLink;
  }

  removeLink(link) {
    if (this.linkMap.has(link.from)) {
        const links = this.linkMap.get(link.from);
        const index = links.indexOf(link);
        if (index > -1) {
            links.splice(index, 1);
        }
    }
    if (this.linkMap.has(link.to)) {
        const links = this.linkMap.get(link.to);
        const index = links.indexOf(link);
        if (index > -1) {
            links.splice(index, 1);
        }
    }
  }

  updateLinkingPreview(endLatLng) {
    if (!this.interactionState || this.interactionState.type !== 'linking') {
      this.cancelLinking();
      return;
    };

    const { startLatLng, fromNode, fromType, fromIndex } = this.interactionState;

    if (this.previewLink) {
      this.previewLink.setLatLngs([startLatLng, endLatLng]);

      const target = this.getPinAt(endLatLng);
      const isValid = this.isValidLink(fromNode, fromType, target?.node, target?.pin?.type, fromIndex, target?.pin?.index);
      this.previewLink.setStyle({
        color: isValid ? 'green' : 'red'
      });
    }
  }

  createSidebar() {
    const nodeForm = document.getElementById('edit-node-form');
    const linkForm = document.getElementById('edit-link-form');
    const placeholder = document.getElementById('sidebar-placeholder');
    const multiPanel = document.getElementById('multi-select-panel');
    const selectedList = document.getElementById('selected-nodes-list');

    // Hide everything by default
    nodeForm.style.display = 'none';
    linkForm.style.display = 'none';
    placeholder.style.display = 'block';
    if (multiPanel) multiPanel.style.display = 'none';
    if (selectedList) selectedList.innerHTML = '';

    // Prioritize link editing if a link is selected and no nodes are selected
    if (this.selectedNodes.length === 0 && this.selectedLink) {
      linkForm.style.display = 'block';
      placeholder.style.display = 'none';
      this.createLinkSidebar();
      return;
    }

    // If multiple nodes are selected, show the list
    if (this.selectedNodes.length > 1) {
      if (multiPanel) multiPanel.style.display = 'block';
      if (selectedList) {
        selectedList.innerHTML = '';
        for (const node of this.selectedNodes) {
          const li = document.createElement('li');
          li.textContent = node.name || 'Unnamed node';
          selectedList.appendChild(li);
        }
      }
      placeholder.style.display = 'none';
      return;
    }

    // If exactly one node is selected
    if (this.selectedNodes.length === 1) {
      const selectedNode = this.selectedNodes[0];
      if (selectedNode.isResource) {
        placeholder.innerHTML = `
                <h3>${selectedNode.name}</h3>
                <p>Resource nodes are not editable.</p>
            `;
      } else {
        nodeForm.style.display = 'block';
        placeholder.style.display = 'none';
        this.createNodeSidebar();
      }
      return;
    }

    // Fallback: show placeholder (no selection)
  }

  createNodeSidebar() {
    if (this.selectedNodes.length === 0) return;
    const node = this.selectedNodes[0];

    // Ensure fields exist
    if (!Array.isArray(node.recipeLayers)) node.recipeLayers = [];
    if (typeof node.topRate !== 'number') node.topRate = 0;

    document.getElementById('inp_name').value = node.name;
    /*document.getElementById('inp_x').value = node.x;
    document.getElementById('inp_y').value = node.y;
    document.getElementById('inp_w').value = node.width;
    document.getElementById('inp_h').value = node.height;*/
    document.getElementById('inp_color').value = node.color;
    const orientationInput = document.getElementById('inp_orientation');
    if (orientationInput) {
        orientationInput.value = node.orientation;
    }

    // Top rate field
    const rateInput = document.getElementById('inp_top_rate');
    if (rateInput) {
      rateInput.value = node.topRate || '';
      rateInput.oninput = () => {
        const v = parseFloat(rateInput.value);
        node.topRate = isNaN(v) ? 0 : v;
        this.applyRecipesToNode(node);
        this.saveState();
      };
    }

    // Render recipe layers
    this.renderRecipeLayersUI(node);

    const getExpectedItem = (n, type, idx) => this.getPinItem(n, type, idx);

    const renderPinControl = (container, pin) => {
      const index = pin.index;
      const type = pin.type;
      const connections = node.getConnectionsForPin(type, index);
      const connectionDiv = document.createElement('div');
      connectionDiv.className = 'connection-item';

      const expected = getExpectedItem(node, type, index);

      if (connections.length > 0) {
        const parts = connections.map(link => {
          const otherNodeId = type === 'input' ? link.from : link.to;
          const otherNode = this.nodes.find(n => n.id === otherNodeId);
          const remoteName = otherNode ? otherNode.name : 'Unknown';
          // Determine item on the remote side
          const remoteType = type === 'input' ? 'output' : 'input';
          const remoteIdx = type === 'input' ? link.fromPin : link.toPin;
          const item = getExpectedItem(otherNode, remoteType, remoteIdx) || 'Unknown item';
          const text = `${remoteName} — ${item}`;
          // Validate for inputs: expected must match item
          if (type === 'input' && expected && item && expected !== item) {
            return { text, invalid: true };
          }
          return { text, invalid: false };
        });
        // Build HTML
        const inner = parts.map(p => `<span class="connection-status ${p.invalid ? 'invalid' : 'connected'}">${p.text}</span>`).join(', ');
        connectionDiv.innerHTML = `<strong>${index + 1}.</strong> ${inner}`;
        if (parts.some(p => p.invalid)) connectionDiv.classList.add('invalid');
      } else {
        // Not connected: show expected item if any
        const label = expected ? `Expected: ${expected}` : 'Not connected';
        connectionDiv.innerHTML = `<strong>${index + 1}.</strong> <span class="connection-status">${label}</span>`;
      }

      container.appendChild(connectionDiv);
    };

    const inputsContainer = document.getElementById('connections-inputs');
    inputsContainer.innerHTML = '';
    node.pins.filter(p => p.type === 'input' && p.enabled).forEach(p => renderPinControl(inputsContainer, p));

    const outputsContainer = document.getElementById('connections-outputs');
    outputsContainer.innerHTML = '';
    node.pins.filter(p => p.type === 'output' && p.enabled).forEach(p => renderPinControl(outputsContainer, p));
  }

  renderRecipeLayersUI(node) {
    const container = document.getElementById('recipe-layers');
    if (!container) return;
    container.innerHTML = '';

    const makeRow = (idx, selectedId, options) => {
      const row = document.createElement('div');
      row.className = 'row';

      const label = document.createElement('label');
      label.textContent = idx === 0 ? 'Output recipe' : `Layer ${idx + 1}`;
      row.appendChild(label);

      const sel = document.createElement('select');
      sel.style.flex = '1';
      sel.innerHTML = '';

      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = idx === 0 ? 'Select a recipe…' : 'Select next layer…';
      sel.appendChild(empty);

      for (const r of (options || [])) {
        const opt = document.createElement('option');
        opt.value = r.id;
        opt.textContent = r.name;
        sel.appendChild(opt);
      }
      sel.value = selectedId || '';

      sel.onchange = () => {
        const val = sel.value;
        if (!val) {
          // Clearing this row removes this and all following layers
          node.recipeLayers = node.recipeLayers.slice(0, idx);
        } else {
          if (idx === node.recipeLayers.length) {
            node.recipeLayers.push({ recipeId: val });
          } else {
            node.recipeLayers[idx].recipeId = val;
            // Also drop following layers when changing current
            node.recipeLayers = node.recipeLayers.slice(0, idx + 1);
          }
        }
        this.applyRecipesToNode(node);
        this.saveState();
        this.renderRecipeLayersUI(node);
      };

      row.appendChild(sel);
      container.appendChild(row);
    };

    // Build rows: one row per existing layer plus one extra empty row (if first is selected)
    const layers = node.recipeLayers;
    const layerCount = layers.length;
    for (let i = 0; i <= layerCount; i++) {
      let opts = this.recipes || [];
      if (i > 0 && layers[i - 1]?.recipeId && this.recipesById) {
        // Filter options for chaining based on previous required inputs
        const prev = this.recipesById.get(layers[i - 1].recipeId);
        if (prev) {
          const requiredItems = new Set(prev.inputs.map(x => x.item));
          opts = (this.recipes || []).filter(r => r.outputs.length > 0 && r.outputs.every(o => requiredItems.has(o.item)));
        }
      }
      const selectedId = i < layerCount ? layers[i].recipeId : '';
      makeRow(i, selectedId, opts);

      // If first row not selected, don't add an extra empty row beyond i=0
      if (layerCount === 0) break;
    }
  }

  applyRecipesToNode(node) {
    // Compute pin counts and icon from recipe layers and topRate
    const result = this.computeRecipeChain(node);
    // Cache expected IO mapping for validation/display
    node._expectedIO = result.pinItems || { inputs: {}, outputs: {} };
    node._ioItems = { inputs: result.inputItems || [], outputs: result.outputItems || [] };
    this.applyPinCounts(node, result.inputPins, result.outputPins);
    // Update icon from display item
    if (result.displayIconItem) {
      node.icon = this.itemNameToIcon(result.displayIconItem);
    }
    node.update();
    this.createSidebar();
  }

  computeRecipeChain(node) {
    // Defaults
    let outputPins = 0;
    let inputPins = 0;
    let displayIconItem = null;
    const PIN_ORDER = [1,2,0,3];

    if (!node.recipeLayers || node.recipeLayers.length === 0) {
      return { inputPins, outputPins, displayIconItem, outputItems: [], inputItems: [], pinItems: { inputs: {}, outputs: {} } };
    }

    const first = this.recipesById?.get(node.recipeLayers[0].recipeId);
    if (!first) return { inputPins, outputPins, displayIconItem, outputItems: [], inputItems: [], pinItems: { inputs: {}, outputs: {} } };

    // Output pins equal number of outputs of first layer (max 4)
    const topOutputs = (first.outputs || []).slice(0, 4);
    outputPins = topOutputs.length;

    // Determine display icon item: use first output item of top layer
    displayIconItem = first.outputs && first.outputs[0] ? first.outputs[0].item : null;

    // Rate scaling: compute required inputs for the chain based on topRate
    const topRate = node.topRate || 0;
    let required = new Map(); // item -> perMin required from previous layer

    if (first.outputs && first.outputs.length > 0) {
      const mainOut = first.outputs[0];
      const ratio = topRate > 0 && mainOut.perMin > 0 ? (topRate / mainOut.perMin) : 0;
      for (const inp of (first.inputs || [])) {
        const v = (inp.perMin || 0) * ratio;
        required.set(inp.item, (required.get(inp.item) || 0) + v);
      }
    }

    // For each next layer, transform required items into deeper inputs
    for (let i = 1; i < node.recipeLayers.length; i++) {
      const rId = node.recipeLayers[i].recipeId;
      const rcp = this.recipesById?.get(rId);
      if (!rcp) break;
      // For each output item of this recipe, see how much is required; compute ratio and add inputs
      const nextRequired = new Map();
      for (const out of (rcp.outputs || [])) {
        const need = required.get(out.item) || 0;
        if (need <= 0) continue;
        const ratio = out.perMin > 0 ? (need / out.perMin) : 0;
        for (const inp of (rcp.inputs || [])) {
          const add = (inp.perMin || 0) * ratio;
          nextRequired.set(inp.item, (nextRequired.get(inp.item) || 0) + add);
        }
      }
      required = nextRequired;
    }

    // Build input items list (distinct)
    const inputItems = Array.from(required.entries()).map(([item, perMin]) => ({ item, perMin })).slice(0, 4);

    // Input pins equal number of distinct required items at the end (max 4)
    inputPins = inputItems.length;

    // Build output items list (from top recipe)
    const outputItems = topOutputs.map(o => ({ item: o.item, perMin: o.perMin })).slice(0, 4);

    // Assign items to pin indexes using priority order
    const pinItems = { inputs: {}, outputs: {} };
    for (let i = 0; i < outputItems.length && i < PIN_ORDER.length; i++) {
      const pinIdx = PIN_ORDER[i];
      pinItems.outputs[pinIdx] = outputItems[i];
    }
    for (let i = 0; i < inputItems.length && i < PIN_ORDER.length; i++) {
      const pinIdx = PIN_ORDER[i];
      pinItems.inputs[pinIdx] = inputItems[i];
    }

    return { inputPins, outputPins, displayIconItem, outputItems, inputItems, pinItems };
  }

  applyPinCounts(node, inputCount, outputCount) {
    // Priority order: [1,2,0,3]
    const order = [1,2,0,3];

    const enablePins = (type, count) => {
      const pins = node.pins.filter(p => p.type === type);
      const toEnableIdx = new Set(order.slice(0, Math.min(count, pins.length)));
      for (const p of pins) {
        const shouldEnable = toEnableIdx.has(p.index);
        if (p.enabled !== shouldEnable) {
          // If disabling, remove connected links
          if (!shouldEnable) {
            for (const link of [...p.linkedLinks]) {
              link.remove();
              this.removeLink(link);
            }
          }
          p.enabled = shouldEnable;
          node.pinsEnabled[`${type}-${p.index}`] = shouldEnable;
        }
      }
    };

    enablePins('input', inputCount);
    enablePins('output', outputCount);
  }

  itemNameToIcon(name) {
    if (!name) return null;
    // Map human name to icon file, crude normalization
    return name.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_]/g, '');
  }

  inferResourceItemName(node) {
    if (!node || !node.isResource || !node.name) return null;
    // Resource node names look like: "Iron Ore (Normal)" → take part before first '('
    const m = node.name.split('(')[0].trim();
    return m || null;
  }

  getPinItem(node, type, index) {
    if (!node) return null;
    // Resource nodes: single output pin 0 with the resource item name
    if (node.isResource) {
      if (type === 'output' && index === 0) return this.inferResourceItemName(node);
      return null;
    }
    // Non-resource: use cached mapping from recipe chain
    const map = node._expectedIO || { inputs: {}, outputs: {} };
    const entry = (type === 'input' ? map.inputs : map.outputs)[index];
    return entry ? entry.item : null;
  }

  createLinkSidebar() {
    const link = this.selectedLink;
    document.getElementById('inp_link_color').value = link.color;
    const fromNode = this.nodes.find(n => n.id === link.from);
    const toNode = this.nodes.find(n => n.id === link.to);
    document.getElementById('link-from-name').textContent = fromNode?.name || 'Unknown';
    document.getElementById('link-to-name').textContent = toNode?.name || 'Unknown';
  }

  clearSelection() {
    if (this.selectedNodes.length > 0) {
        const previousSelection = [...this.selectedNodes];
        this.selectedNodes = [];
        for (const node of previousSelection) {
            node.update();
        }
    }
    this.createSidebar();
  }

  selectNodes(nodes) {
    this.clearSelection();
    this.selectedNodes = nodes;
    for (const node of this.selectedNodes) {
        node.update();
    }
    this.createSidebar();
  }

  toggleNodeSelection(node) {
    if (this.selectedLink) {
      const prevLink = this.selectedLink;
      this.selectedLink = null;
      prevLink.update();
    }

    const index = this.selectedNodes.indexOf(node);
    if (index > -1) {
        this.selectedNodes.splice(index, 1);
    } else {
        this.selectedNodes.push(node);
    }

    this.createSidebar();
    node.update();
  }

selectLink(link) {
    if (this.selectedLink === link) return;

    this.clearSelection();

    const previousLink = this.selectedLink;
    this.selectedLink = link;

    if (previousLink) {
      previousLink.update();
    }
    if (link) {
      link.update();
    }

    this.createSidebar();
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
      [Math.round(t), Math.round(a)]
  }

  // ===== Debug grid (EasyStar) overlay =====
  setAStarDebugData(data) {
    this._latestAStarDebug = data; // {grid, minX, minY, rows, cols, resolution}
    if (this.showPathGridDebug) this.renderDebugGrid();
  }

  toggleGridDebug() {
    this.showPathGridDebug = !this.showPathGridDebug;
    if (this.showPathGridDebug) this.renderDebugGrid();
    else this.clearDebugGrid();
  }

  clearDebugGrid() {
    this.debugGridLayer.clearLayers();
  }

  renderDebugGrid(options = {}) {
    if (!this._latestAStarDebug) return;
    const { grid, minX, minY, rows, cols, resolution } = this._latestAStarDebug;
    this.debugGridLayer.clearLayers();

    // Performance guard
    const maxCells = options.maxCells || 4000; // safe upper bound per overlay
    if (rows * cols > maxCells) {
      console.warn('Debug grid too big to render:', rows, 'x', cols);
      return;
    }

    const costColor = (v) => {
      // 0=blocked, 1=walkable, >1=costy
      if (v === 0) return '#000000';
      if (v === 1) return 'rgba(0,200,0,0.15)';
      if (v === 3) return 'rgba(0,180,255,0.25)';
      if (v === 5) return 'rgba(255,255,0,0.25)';
      if (v === 6) return 'rgba(0,120,255,0.25)';
      if (v === 9) return 'rgba(255,0,0,0.35)';
      if (v === 10) return 'rgba(255,140,0,0.35)';
      if (v === 12) return 'rgba(255,105,180,0.35)';
      if (v === 14) return 'rgba(186,85,211,0.35)';
      if (v === 25) return 'rgba(255,0,0,0.45)';
      if (v === 55) return 'rgba(139,0,0,0.5)';
      return 'rgba(128,128,128,0.2)';
    };

    // Draw rectangles for each cell; outline grid lightly
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const val = grid[cy][cx];
        const x0 = minX + cx * resolution;
        const y0 = minY + cy * resolution;
        const x1 = x0 + resolution;
        const y1 = y0 + resolution;
        const sw = this.unproject([x0, y0]);
        const ne = this.unproject([x1, y1]);
        const rect = L.rectangle([sw, ne], {
          color: 'rgba(0,0,0,0.25)',
          weight: 0.5,
          fill: true,
          fillColor: costColor(val),
          fillOpacity: 1.0,
          interactive: false
        });
        rect.addTo(this.debugGridLayer);

        // Optionally draw cost label for blocked or higher-cost cells
        if (val !== 1) {
          const cxg = x0 + resolution / 2;
          const cyg = y0 + resolution / 2;
          const latlng = this.unproject([cxg, cyg]);
          const label = L.marker(latlng, {
            interactive: false,
            keyboard: false,
            icon: L.divIcon({
              className: 'grid-cost-label',
              html: `<div style="font: 10px/10px monospace; color:#111; text-shadow:0 0 2px #fff;">${val}</div>`,
              iconSize: [1, 1]
            })
          });
          label.addTo(this.debugGridLayer);
        }
      }
    }

    // Draw outer contour box
    const pSW = this.unproject([minX, minY]);
    const pNE = this.unproject([minX + cols * resolution, minY + rows * resolution]);
    L.rectangle([pSW, pNE], { color: '#222', weight: 1, fill: false, dashArray: '4,3' })
      .addTo(this.debugGridLayer);
  }
}

const map = new MapPlanner();
