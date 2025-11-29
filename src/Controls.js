import L from 'leaflet';

export class Controls {
  constructor(mapPlanner) {
    this.mapPlanner = mapPlanner;
    this.leafletMap = mapPlanner.leafletMap;
    this.isEditMode = false;
    this.addNodeControl = null;
  }

  initialize() {
    this.createModeSwitchButton();
    this.createAddNodeButton();
    this.updateAddNodeButtonVisibility();
  }

  createAddNodeButton() {
    const AddNodeControl = L.Control.extend({
      options: {
        position: 'topright'
      },
      onAdd: () => {
        const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
        const button = L.DomUtil.create('a', 'leaflet-control-button', container);
        button.innerHTML = 'Add Node'; // Using text as requested
        button.href = '#';
        button.role = 'button';
        button.title = 'Add Node';
        L.DomEvent.on(button, 'click', L.DomEvent.stop).on(button, 'click', this.mapPlanner.addNode, this.mapPlanner);
        return container;
      }
    });
    this.addNodeControl = new AddNodeControl();
    this.leafletMap.addControl(this.addNodeControl);
    this.toggleMode();
  }

  createModeSwitchButton() {
    const ModeSwitchControl = L.Control.extend({
      options: {
        position: 'topright'
      },
      onAdd: (map) => {
        const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
        this.modeButton = L.DomUtil.create('a', 'leaflet-control-button', container);
        this.updateModeButton();
        this.modeButton.href = '#';
        this.modeButton.role = 'button';
        L.DomEvent.on(this.modeButton, 'click', L.DomEvent.stop).on(this.modeButton, 'click', this.toggleMode, this);
        return container;
      }
    });
    this.leafletMap.addControl(new ModeSwitchControl());

  }

  toggleMode() {
    this.isEditMode = !this.isEditMode;
    this.updateModeButton();
    this.updateAddNodeButtonVisibility();
    if (this.isEditMode) {
      this.mapPlanner.enableEdit();
    } else {
      this.mapPlanner.disableEdit();
    }
  }

  updateModeButton() {
    if (this.isEditMode) {
      this.modeButton.innerHTML = 'Edit Mode';
      this.modeButton.title = 'Switch to Pan Mode';
    } else {
      this.modeButton.innerHTML = 'Pan Mode';
      this.modeButton.title = 'Switch to Edit Mode';
    }
  }

  updateAddNodeButtonVisibility() {
    const container = this.addNodeControl.getContainer();
    if (container) {
      if (this.isEditMode) {
        container.style.display = '';
      } else {
        container.style.display = 'none';
      }
    }
  }
}
