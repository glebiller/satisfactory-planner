import './style.css';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Node } from './Node.js';
import { Controls } from './Controls.js';
import { Link } from './Link.js';

const STORAGE_KEY = 'satisfactory-planner-data';

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

    this.start();
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
    this.initializeIconDropdown();
    this.setupInteractionHandlers();

    await this.load();
  }

  snapToGrid(value) {
    return Math.round(value / this.gridSize) * this.gridSize;
  }

  initializeIconDropdown() {
    // List of available icons (based on files in public/icons/)
    const icons = [
      'Actual_Snow', 'Adaptive_Control_Unit', 'AI_Limiter', 'Alclad_Aluminum_Sheet',
      'Alien_Carapace', 'Alien_DNA_Capsule', 'Alien_Organs', 'Alien_Protein',
      'Aluminum_Casing', 'Aluminum_Ingot', 'Aluminum_Scrap', 'Assembly_Director_System',
      'Automated_Wiring', 'Bacon_Agaric', 'Battery', 'Bauxite', 'Bauxite_v0347',
      'Beacon', 'Beryl_Nut', 'Biofuel', 'Biomass', 'Black_Powder', 'Blade_Runners',
      'Blue_FICSMAS_Ornament', 'Blue_Power_Slug', 'Boom_Box', 'Build_Gun', 'Cable',
      'Candy_Cane', 'Candy_Cane_Basher', 'Caterium_Ingot', 'Caterium_Ore', 'Caterium_Ore_v0347',
      'Chainsaw', 'Circuit_Board', 'Cluster_Nobelisk', 'Coal', 'Color_Cartridge',
      'Color_Gun', 'Compacted_Coal', 'Computer', 'Concrete', 'Cooling_System',
      'Copper_FICSMAS_Ornament', 'Copper_Ingot', 'Copper_Ore', 'Copper_Ore_v0347',
      'Copper_Powder', 'Copper_Sheet', 'Crystal_Oscillator', 'Cup', 'Dark_Matter',
      'Electromagnetic_Control_Rod', 'Empty_Canister', 'Empty_Fluid_Tank', 'Encased_Industrial_Beam',
      'Encased_Plutonium_Cell', 'Encased_Uranium_Cell', 'Explosive_Rebar', 'Fabric',
      'Fancy_Fireworks', 'FICSIT_Coupon', 'FICSMAS_Bow', 'FICSMAS_Decoration', 'FICSMAS_Gift',
      'FICSMAS_Ornament_Bundle', 'FICSMAS_Tree_Branch', 'FICSMAS_Wonder_Star', 'Flower_Petals',
      'Fused_Modular_Frame', 'Gas_Filter', 'Gas_Mask', 'Gas_Nobelisk', 'Green_Power_Slug',
      'Hard_Drive', 'Hatcher_Remains', 'Hazmat_Suit', 'Heat_Sink', 'Heavy_Modular_Frame',
      'High-Speed_Connector', 'Hog_Remains', 'Homing_Rifle_Ammo', 'Hover_Pack', 'HUB_Parts',
      'Iodine_Infused_Filter', 'Iron_FICSMAS_Ornament', 'Iron_Ingot', 'Iron_Ore', 'Iron_Ore_v0347',
      'Iron_Plate', 'Iron_Rebar', 'Iron_Rod', 'Jetpack', 'Leaves', 'Limestone',
      'Magnetic_Field_Generator', 'Medicinal_Inhaler', 'Mercer_Sphere', 'Modular_Engine',
      'Modular_Frame', 'Modular_Frame_Light', 'Motor', 'Mycelia', 'Nobelisk',
      'Nobelisk_Detonator', 'Non-fissile_Uranium', 'Nuclear_Pasta', 'Nuke_Nobelisk',
      'Object_Scanner', 'Packaged_Alumina_Solution', 'Packaged_Fuel', 'Packaged_Heavy_Oil_Residue',
      'Packaged_Liquid_Biofuel', 'Packaged_Nitric_Acid', 'Packaged_Nitrogen_Gas', 'Packaged_Oil',
      'Packaged_Sulfuric_Acid', 'Packaged_Turbofuel', 'Packaged_Water', 'Paleberry', 'Parachute',
      'Petroleum_Coke', 'Plasma_Spitter_Remains', 'Plastic', 'Plutonium_Fuel_Rod', 'Plutonium_Pellet',
      'Plutonium_Waste', 'Polymer_Resin', 'Portable_Miner', 'Power_Shard', 'Pressure_Conversion_Cube',
      'Pulse_Nobelisk', 'Purple_Power_Slug', 'Quantum_Computer', 'Quantum_Crystal', 'Quartz_Crystal',
      'Quickwire', 'Radio_Control_Unit', 'Raw_Quartz', 'Raw_Quartz_v0347', 'Rebar_Gun',
      'Red_FICSMAS_Ornament', 'Reinforced_Iron_Plate', 'Reinforced_Steel_Plate', 'Rifle',
      'Rifle_Ammo', 'Rifle_Cartridge', 'Rotor', 'Rubber', 'SAM_Ingot', 'SAM_Ore',
      'Screw', 'Shatter_Rebar', 'Silica', 'Smart_Plating', 'Smokeless_Powder', 'Snowball',
      'Snowball_Pile', 'Solid_Biofuel', 'Somersloop', 'Sparkly_Fireworks', 'Spiked_Rebar',
      'Stator', 'Steel_Beam', 'Steel_Ingot', 'Steel_Pipe', 'Steel_Plate', 'Stinger_Remains',
      'Stun_Rebar', 'Sulfur', 'Sulfur_v0347', 'Supercomputer', 'Superposition_Oscillator',
      'Sweet_Fireworks', 'Thermal_Propulsion_Rocket', 'Turbo_Motor', 'Turbo_Rifle_Ammo',
      'Uranium', 'Uranium_Fuel_Rod', 'Uranium_Pellet', 'Uranium_Waste', 'Uranium_v0347',
      'Versatile_Framework', 'Vines', 'Wire', 'Wood', 'Xeno-Basher', 'Xeno-Zapper',
      'Yellow_Power_Slug', 'Zipline'
    ];

    const select = document.getElementById('inp_icon');
    icons.forEach(icon => {
      const option = document.createElement('option');
      option.value = icon;
      option.textContent = icon.replace(/_/g, ' ');
      select.appendChild(option);
    });
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
      selectedNode.icon = document.getElementById('inp_icon').value || null;
      selectedNode.x = this.snapToGrid(parseInt(document.getElementById('inp_x').value));
      selectedNode.y = this.snapToGrid(parseInt(document.getElementById('inp_y').value));
      selectedNode.width = this.snapToGrid(parseInt(document.getElementById('inp_w').value));
      selectedNode.height = this.snapToGrid(parseInt(document.getElementById('inp_h').value));
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
      // Performance issue
        /*for (const node of this.nodes) {
            node.update();
        }*/
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
      renderer: L.svg(),
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
    for (const node of this.nodes) {
      const foundPin = node.pins.find(p => {
        return this.leafletMap.distance(latlng, p.circle.getLatLng()) <= p.circle.getRadius() * 1.5;
      });
      if (foundPin) {
        return { node, pin: foundPin };
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

    const { startLatLng, fromNode, fromType } = this.interactionState;

    if (this.previewLink) {
      this.previewLink.setLatLngs([startLatLng, endLatLng]);

      const target = this.getPinAt(endLatLng);
      const isValid = this.isValidLink(fromNode, fromType, target?.node, target?.pin?.type);
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

    document.getElementById('inp_name').value = node.name;
    document.getElementById('inp_icon').value = node.icon || '';
    document.getElementById('inp_x').value = node.x;
    document.getElementById('inp_y').value = node.y;
    document.getElementById('inp_w').value = node.width;
    document.getElementById('inp_h').value = node.height;
    document.getElementById('inp_color').value = node.color;
    const orientationInput = document.getElementById('inp_orientation');
    if (orientationInput) {
        orientationInput.value = node.orientation;
    }

    const renderPinControl = (container, type, index) => {
      const pin = node.pins.find(p => p.type === type && p.index === index);
      if (!pin) return;

      const connections = node.getConnectionsForPin(type, index);
      const connectionDiv = document.createElement('div');
      connectionDiv.className = 'connection-item';

      let status = '';
      if (connections.length > 0) {
        const connectedNodes = connections.map(link => {
          const otherNodeId = type === 'input' ? link.from : link.to;
          const otherNode = this.nodes.find(n => n.id === otherNodeId);
          return otherNode ? otherNode.name : 'Unknown';
        });
        status = `<span class="connection-status connected">Connected to: ${connectedNodes.join(', ')} (${connections.length})</span>`;
      } else {
        status = `<span class="connection-status">Not connected</span>`;
      }

      const toggleButton = document.createElement('button');
      toggleButton.textContent = pin.enabled ? 'On' : 'Off';
      toggleButton.className = `pin-toggle ${pin.enabled ? 'pin-on' : 'pin-off'}`;
      toggleButton.addEventListener('click', () => {
        pin.enabled = !pin.enabled;
        node.pinsEnabled[`${type}-${index}`] = pin.enabled;
        pin.update(node.getBounds());
        this.createSidebar();
        this.saveState();
      });

      connectionDiv.innerHTML = `<strong>${index + 1}.</strong> ${status}`;
      connectionDiv.prepend(toggleButton);
      container.appendChild(connectionDiv);
    };

    const inputsContainer = document.getElementById('connections-inputs');
    inputsContainer.innerHTML = '';
    for (let i = 0; i < 4; i++) {
      renderPinControl(inputsContainer, 'input', i);
    }

    const outputsContainer = document.getElementById('connections-outputs');
    outputsContainer.innerHTML = '';
    for (let i = 0; i < 4; i++) {
      renderPinControl(outputsContainer, 'output', i);
    }
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
      [t, a]
  }
}

const map = new MapPlanner();
