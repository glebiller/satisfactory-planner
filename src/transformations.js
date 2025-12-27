const DATA_URL = '/satisfactory-planner/transformations_graphs.json';

const el = {
  rows: document.getElementById('rows'),
  filter: document.getElementById('filter'),
  counts: document.getElementById('counts'),
  modalOverlay: document.getElementById('modalOverlay'),
  modalContent: document.getElementById('modalContent'),
  modalClose: document.getElementById('modalClose'),
  modalTitle: document.getElementById('modalTitle'),
};

let data = [];
let view = [];
let sortState = { key: 'index', dir: 'asc' };

init().catch(err => {
  console.error(err);
  el.rows.innerHTML = `<tr><td colspan="7" class="empty">Failed to load: ${escapeHtml(String(err))}</td></tr>`;
});

async function init() {
  const raw = await fetchJson(DATA_URL);
  data = raw;
  
  view = data.slice();
  wireSorting();
  wireFiltering();
  wireModal();
  applyFilter();
}

function wireSorting() {
  const headers = document.querySelectorAll('thead .sort');
  headers.forEach(h => {
    h.addEventListener('click', () => {
      const key = h.dataset.key || 'output';
      if (sortState.key === key) {
        sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sortState.key = key;
        sortState.dir = 'asc';
      }
      headers.forEach(x => x.classList.toggle('active', x === h));
      render();
    });
  });
  const active = Array.from(headers).find(h => h.dataset.key === sortState.key);
  if (active) active.classList.add('active');
}

function wireFiltering() {
  let rafId = 0;
  const schedule = () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => applyFilter());
  };
  el.filter.addEventListener('input', schedule);
}

function wireModal() {
  el.modalClose?.addEventListener('click', closeModal);
  el.modalOverlay?.addEventListener('click', (e) => {
    if (e.target === el.modalOverlay) closeModal();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.modalOverlay.hasAttribute('hidden')) closeModal();
  });
  el.rows.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-open-modal]');
    if (!btn) return;
    const idx = btn.getAttribute('data-row-index');
    if (!idx) return;
    const row = data.find(r => String(r.index) === String(idx));
    if (row) openModalForRow(row);
  });
}

function openModalForRow(row) {
  const titleLeft = row.tier != null ? `Tier ${escapeHtml(String(row.tier))}` : '';
  const titleRight = row.output || 'Transformation';
  el.modalTitle.textContent = `${titleLeft} • ${titleRight}`;

  let html = '';
  if (row.graph && Array.isArray(row.graph) && row.graph.length) {
      html = buildModalHtmlFromGraphV3(row.graph, row.inputs);
  } else {
      html = '<div class="empty">No graph data available</div>';
  }

  el.modalContent.innerHTML = html;
  el.modalOverlay.removeAttribute('hidden');
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';
  el.modalClose?.focus();
}

function closeModal() {
  el.modalOverlay.setAttribute('hidden', '');
  el.modalContent.innerHTML = '';
  document.documentElement.style.overflow = '';
  document.body.style.overflow = '';
}

function buildModalHtmlFromGraphV3(rows, rawInputs) {
  // rows is the array of layers from the JSON
  // We want to display them in reverse order (top to bottom)
  // But wait, the user said: "the table should represent a tower from the bottom to the top, the top is the first row and the final item produced, while the last row is the bottom with all the raw materials coming in."
  // The JSON 'rows' are ordered by step 1, 2, 3... where step 1 is the first processing step (closest to raw inputs usually).
  // If we want the FINAL item at the TOP, we should reverse the array.
  // Step N (Final Product) -> Row 1
  // ...
  // Step 1 (First Processing) -> Row N-1
  // Raw Inputs -> Row N (Bottom)
  
  const reversedRows = rows.slice().reverse();
  
  const header = `
    <table class="flow-table">
      <thead>
        <tr>
          <th style="width:50px">Step</th>
          <th style="width:160px">Recipe</th>
          <th class="lane-col">Lane 1</th>
          <th class="lane-col">Lane 2</th>
          <th class="lane-col">Lane 3</th>
          <th class="lane-col">Lane 4</th>
          <th class="lane-col">Lane 5</th>
        </tr>
      </thead>
      <tbody>
  `;

  const displayOrder = [3, 1, 0, 2, 4];

  // Build processing rows
  let rowsHtml = reversedRows.map((row, index) => {
    // We need to know the NEXT row (which is logically below in the table, so previous step in processing)
    // to draw lines FROM below TO current.
    // Actually, lines should go from Source (Below) to Destination (Above).
    // In this table, "Below" is higher index in the table (Raw inputs at bottom).
    // "Above" is lower index (Final product at top).
    
    // Let's pass the 'next' logical step (which is the row below in the table) to calculate connections.
    // The row below in the table corresponds to the PREVIOUS processing step (step - 1).
    // Or if it's the last row, it connects to Raw Inputs.
    
    const nextRowInTable = reversedRows[index + 1]; // This is the step BEFORE current step
    const isLastProcessingRow = index === reversedRows.length - 1;
    
    return buildLayerRowV3(row, displayOrder, nextRowInTable, isLastProcessingRow ? rawInputs : null);
  }).join('');

  // Add Raw Inputs Row at the bottom
  rowsHtml += buildRawInputsRow(rawInputs, displayOrder);

  const footer = '</tbody></table>';
  return header + rowsHtml + footer;
}

function buildLayerRowV3(row, displayOrder, nextRowInTable, rawInputsForConnection) {
  const stepNum = row.step != null ? row.step : '?';
  const recipe = row.recipe || '';
  
  const laneMap = {};
  if (row.inputs) {
      row.inputs.forEach(input => {
          laneMap[input.index] = input;
      });
  }
  
  const output = row.output;
  const targetLaneIdx = output ? output.target_lane : -1;

  const laneTds = displayOrder.map(laneIdx => {
    const input = laneMap[laneIdx];
    const isTarget = (laneIdx === targetLaneIdx);
    
    if (!input && !isTarget) return '<td class="lane-col"></td>';
    
    const action = input ? input.action : 'empty';
    
    if (action === 'empty' && !isTarget) {
         return '<td class="lane-col"></td>';
    }

    let content = '';
    let className = 'lane-item';
    let lines = '';

    // Logic for drawing lines FROM the row below (source) TO this cell (destination)
    // Sources can be:
    // 1. Passing item from below (same lane)
    // 2. Consumed item from below (same lane)
    // 3. Split item from below (same lane) -> but wait, split happens AT the source.
    
    // Let's look at it from the perspective of the current cell.
    // If I am 'passing', I receive from the same lane below.
    // If I am 'consumed', I receive from the same lane below.
    // If I am 'produce' (target), I am created here. I don't receive from below in the same lane (usually).
    // Wait, the 'produce' puts the item into the lane for the NEXT step (Row Above).
    // So in THIS row, the 'target' cell shows the item being CREATED.
    // The inputs for this creation come from the 'consumed' cells in THIS row.
    // So we need lines connecting 'consumed' cells in THIS row to the 'target' cell in THIS row?
    // No, the user said: "lines ... to link outputs of the previous layer, to inputs of this layer."
    // Previous layer = Row Below.
    // Inputs of this layer = The items available to be consumed/passed.
    
    // Actually, the JSON structure is:
    // Step N:
    //   Inputs: [ {index: 0, item: "Iron Ore", action: "consumed"}, ... ]
    //   Output: { item: "Iron Ingot", target_lane: 0 }
    
    // This means at Step N, "Iron Ore" was sitting in Lane 0. It got consumed.
    // "Iron Ingot" was produced and put into Lane 0.
    // So visually:
    // Row N (Step N): Shows "Iron Ingot" (Produced) ? Or "Iron Ore" (Consumed)?
    // The user wants "each rows will show the expected outputs only for each lane".
    // This implies the row should show the STATE of the lanes AFTER the step?
    // Or maybe the row represents the ACTION?
    
    // "I want some lines ... to link outputs of the previous layer, to inputs of this layer."
    // "In case of an item is created from one or multiple items, it should show the lines coming from all items, and maybe a circle in the middle to show it's a transformation."
    
    // Let's interpret:
    // Row N (Step N):
    // Shows the OUTPUT of Step N. i.e. The item produced.
    // And also shows items that are just passing through.
    // The "Inputs" for Step N came from Row N+1 (Step N-1).
    
    // So, for a specific lane in Row N:
    // - If it's the target lane: Show the Produced Item.
    // - If it's a passing lane: Show the Passing Item.
    // - If it was consumed: It shouldn't be shown as an "output" of this row? 
    //   Wait, if it's consumed, it's GONE. It doesn't exist in the output of this step.
    //   But we need to visualize the consumption.
    
    // Let's try this:
    // The row represents the OPERATION.
    // We display the RESULT of the operation in the lanes.
    // But we also need to show what was consumed to create that result.
    // The "consumed" items were present in the Previous Row (Row Below).
    // So we draw lines from the specific lanes in Row Below (where ingredients were) 
    // converging to the Target Lane in Current Row (where product is).
    
    // If an item is "passing", we draw a vertical line from Row Below (same lane) to Current Row (same lane).
    
    // If an item is "split":
    // It means in this step, some amount was taken, but some remains.
    // The remaining amount appears in Current Row (same lane).
    // The taken amount contributes to the production (Target Lane).
    // So we need a line from Row Below (same lane) to Current Row (same lane) [for the remainder]
    // AND a line from Row Below (same lane) to Current Row (Target Lane) [for the consumption].
    
    // Implementation details:
    // We need to look at the 'inputs' of the CURRENT step to know where connections come from.
    // The 'inputs' array tells us which lanes had items that were used/passed.
    
    // For the current cell (laneIdx):
    // 1. Am I the Target Lane?
    //    If yes, I need lines coming from ALL lanes that were 'consumed' or 'split' in this step.
    //    I display the Produced Item.
    
    // 2. Am I a Passing Lane? (action == 'passing')
    //    If yes, I need a vertical line from the same lane below.
    //    I display the Item.
    
    // 3. Am I a Split Lane? (action == 'split')
    //    If yes, I need a vertical line from the same lane below (carrying the remainder).
    //    I display the Item (remainder).
    //    (The 'split' portion line is handled by the Target Lane logic).
    
    // 4. Was I fully Consumed? (action == 'consumed')
    //    Then I am empty in THIS row (the output row).
    //    I display nothing (or empty placeholder).
    //    (The connection line goes to the Target Lane).
    
    // Wait, if I am fully consumed, I don't appear in this row. 
    // But the line from the row below needs to go SOMEWHERE.
    // It goes to the Target Lane of THIS row.
    
    // So, drawing logic is mostly on the Target Lane Cell.
    // It draws SVG lines from the coordinates of the source lanes in the row below.
    // Since we are in a table, absolute coordinates are tricky.
    // But we can use relative CSS positioning if we assume standard column widths.
    // Or simpler: We can use a small SVG overlay in the Target Cell that reaches out? No, that's hard with overflow.
    // Better: Use a dedicated container for lines?
    
    // Simplified approach for lines using CSS borders/pseudo-elements is hard for diagonal/converging.
    // SVG is best. We can put an SVG in the `td` that is absolutely positioned to cover the area between rows?
    // Or just use simple CSS lines for vertical, and maybe horizontal connectors?
    // User said: "ideally following vertical / horizontal only, no diagonal".
    // This implies a "circuit board" style trace.
    // Vertical up from source, Horizontal to target column, Vertical up to target.
    
    // Let's try to render lines within the cell if possible, or use a background SVG.
    // Given the constraints, maybe we just render the lines on the Target Cell?
    // "In case of an item is created ... lines coming from all items".
    
    // Let's calculate the "Sources" for the current Target.
    const sources = [];
    if (isTarget) {
        // Find all inputs that contributed
        if (row.inputs) {
            row.inputs.forEach(inp => {
                if (['consumed', 'consumed_partial', 'split'].includes(inp.action)) {
                    // This lane contributed.
                    // We need to find its visual column index.
                    const sourceVisualIdx = displayOrder.indexOf(inp.index);
                    sources.push(sourceVisualIdx);
                }
            });
        }
    }
    
    // Current visual index
    const currentVisualIdx = displayOrder.indexOf(laneIdx);
    
    // Generate SVG for connections if this is the target
    if (isTarget && sources.length > 0) {
        // We need to draw lines from the bottom of the cell (which connects to row below)
        // The sources are at different columns.
        // We need to go Down, then Horizontal, then Up (from the perspective of the source).
        // Since we are drawing IN the target cell, we are looking "Down".
        // We need to reach the columns of the sources.
        
        // Calculate offsets.
        // Assuming each column is 13% width (from CSS).
        // This is tricky to get exact pixels.
        // But we can use percentages if the SVG covers the whole row width?
        // No, SVG in TD is confined to TD.
        
        // Alternative: Render the lines as a separate row? No, user wants cleaner display.
        // Alternative: Render lines in the "Recipe" cell? No.
        
        // Let's try a full-width SVG overlay for the row?
        // We can put a <tr> with height 0, and a <td> spanning all cols, containing an SVG that overflows upwards?
        // Or just put the SVG in the Target Cell and make it `position: absolute; width: 500%; left: -200%;` etc?
        // Let's try the absolute positioning approach on the Target Cell content.
        
        // We need to know the relative distance to sources.
        // distance = (sourceVisualIdx - currentVisualIdx) * 100% (of cell width).
        
        const paths = sources.map(srcIdx => {
            const diff = srcIdx - currentVisualIdx;
            // We want to go from Center of Source (diff * 100% + 50%) to Center of Target (50%).
            // Vertical / Horizontal style.
            // From Source: Up (which is bottom of this cell + some padding).
            // Then Horizontal to Target.
            // Then Up to Target Center.
            
            // Coordinates in the SVG (0,0 is top-left of Target Cell):
            // Target Center: 50%, 50%
            // Source Center: (diff * 100%) + 50%, 150% (assuming row height is similar and we draw below)
            
            // Wait, we are drawing lines FROM the row below.
            // So the lines start at y=100% (bottom of current cell) and x = source_center.
            // And go to y=50% (middle of current cell) and x = 50%.
            
            // Path:
            // MoveTo (diff*100% + 50%, 100%)  [Bottom of source col]
            // LineTo (diff*100% + 50%, 75%)   [Up a bit]
            // LineTo (50%, 75%)               [Horizontal to target col]
            // LineTo (50%, 50%)               [Up to target center]
            
            // We need to handle the width of the SVG.
            // Let's make the SVG wide enough to cover all columns.
            // But `overflow: visible` on the cell might be easier.
            
            const xStart = (diff * 100) + 50;
            const xEnd = 50;
            
            return `<path d="M ${xStart} 100 L ${xStart} 75 L ${xEnd} 75 L ${xEnd} 50" fill="none" stroke="#4aa8ff" stroke-width="2" />`;
        }).join('');
        
        // Circle in the middle
        const circle = `<circle cx="50" cy="50" r="4" fill="#4aa8ff" />`;
        
        // We need a wrapper that allows the SVG to spill out horizontally
        lines = `
            <div style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; z-index: 1;">
                <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" style="overflow: visible;">
                    ${paths}
                    ${circle}
                </svg>
            </div>
        `;
    }
    
    // Vertical lines for Passing / Split-Remainder
    // These just go straight down to the bottom (connecting to row below).
    if (action === 'passing' || action === 'split') {
         lines = `
            <div style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; z-index: 1;">
                <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" style="overflow: visible;">
                    <path d="M 50 100 L 50 50" fill="none" stroke="#3a4a5a" stroke-width="2" stroke-dasharray="4" />
                </svg>
            </div>
         `;
         // Note: The item is "passing", so it comes from below and goes up.
         // In this row (Output of Step N), the item IS here.
         // So we draw a line from bottom (Row N+1) to center.
         // And presumably a line from center to top (Row N-1) will be drawn by the row above?
         // Yes, the row above will look down and draw the line.
         // So we only need to draw the line coming FROM below.
    }

    if (isTarget) {
        className += ' lane-produce';
        content = `
            <div class="${className}">
                <strong>${escapeHtml(String(output.item))}</strong><br/>
                <small>+${formatNumber(output.amount)}</small>
            </div>
        `;
    } else if (action === 'passing') {
        className += ' lane-pass';
        content = `
            <div class="${className}">
                ${escapeHtml(String(input.item))}
            </div>
        `;
    } else if (action === 'split') {
         className += ' lane-split';
         content = `
            <div class="${className}">
                ${escapeHtml(String(input.item))}<br/>
                <small>${formatNumber(input.amount)}</small>
            </div>
         `;
    } else if (action === 'consumed' || action === 'consumed_partial') {
        // Consumed items are NOT shown in the output row, because they are gone.
        // But we might want to show a ghost or just the line originating from below?
        // The line logic is handled by the Target cell.
        // So here we render nothing.
        return '<td class="lane-col"></td>';
    }
    
    return `<td class="lane-col">${lines}${content}</td>`;
  }).join('');

  return `
    <tr class="layer-row">
      <td class="level-cell">${stepNum}</td>
      <td class="recipe-cell"><strong>${escapeHtml(recipe)}</strong></td>
      ${laneTds}
    </tr>
  `;
}

function buildRawInputsRow(inputs, displayOrder) {
    if (!inputs) return '';
    
    // Map inputs to lanes.
    // The inputs array is a summary list: [{name, quantity}, ...].
    // But we need to know which LANE they are in.
    // The 'inputs' summary in JSON doesn't have lane info.
    // However, the first step of the graph (which is the last in our reversed list)
    // has 'inputs' with 'amount' (current amount before step).
    // Wait, the solver initializes lanes with raw inputs.
    // So we can infer the raw inputs from the 'inputs' of the FIRST step (Step 1).
    // Step 1 is the LAST row in our reversed table (before we add this raw row).
    // Actually, we can just look at the 'inputs' of Step 1.
    // Any item with 'amount' > 0 in Step 1 inputs is a raw input (or intermediate if we started mid-way, but usually raw).
    
    // We need to pass the Step 1 data to this function?
    // Or just pass the rawInputs summary and try to map?
    // The rawInputs summary doesn't have lane index.
    // Let's use the logic: The row below Step 1 is the "Initial State".
    // We can reconstruct it from Step 1's inputs.
    
    // But wait, `buildModalHtmlFromGraphV3` doesn't have easy access to Step 1 data inside this helper unless passed.
    // Let's assume `rawInputs` passed here is actually the `inputs` array from Step 1 of the graph.
    
    // Let's adjust `buildModalHtmlFromGraphV3` to pass the right data.
    
    // In `buildRawInputsRow`, `inputs` is `row.inputs` from Step 1.
    const laneMap = {};
    if (inputs) {
        inputs.forEach(inp => {
            laneMap[inp.index] = inp;
        });
    }

    const laneTds = displayOrder.map(laneIdx => {
        const input = laneMap[laneIdx];
        if (!input || !input.item) return '<td class="lane-col"></td>';
        
        // This is the starting amount
        return `
            <td class="lane-col">
                <div class="lane-item lane-pass" style="border-style: dashed;">
                    ${escapeHtml(String(input.item))}<br/>
                    <small>${formatNumber(input.amount)}</small>
                </div>
            </td>
        `;
    }).join('');

    return `
        <tr class="raw-inputs-row">
            <td class="level-cell">0</td>
            <td class="recipe-cell"><span class="meta">Raw Inputs</span></td>
            ${laneTds}
        </tr>
    `;
}

function applyFilter() {
  const q = (el.filter.value || '').trim().toLowerCase();
  if (!q) {
    view = data.slice();
  } else {
    view = data.filter(row => matchRow(row, q));
  }
  render();
}

function matchRow(row, q) {
  const output = String(row.output || '').toLowerCase();
  if (output.includes(q)) return true;

  if (row.index != null && String(row.index).toLowerCase().includes(q)) return true;
  if (row.tier != null && String(row.tier).toLowerCase().includes(q)) return true;

  const inputs = (row.inputs || []).map(i => `${i.name} ${i.quantity}`).join(' ').toLowerCase();
  if (inputs.includes(q)) return true;

  const byps = (row.byproducts || []).map(b => `${b.name} ${b.quantity}`).join(' ').toLowerCase();
  if (byps.includes(q)) return true;

  return false;
}

function render() {
  const key = sortState.key;
  const dir = sortState.dir === 'asc' ? 1 : -1;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  const getter = (row) => {
    switch (key) {
      case 'index': return row.index == null ? null : Number(row.index);
      case 'tier': {
        const t = row.tier;
        if (t == null) return null;
        const n = Number(t);
        return Number.isFinite(n) ? n : String(t);
      }
      case 'output': return row.output || '';
      case 'inputs': return (row.inputs || []).map(i => `${i.name}:${i.quantity}`).join(', ');
      case 'byProducts': return (row.byproducts || []).map(b => `${b.name}:${b.quantity}`).join(', ');
      case 'recipes': return (row.graph || []).length;
      default: return '';
    }
  };

  view.sort((a, b) => {
    const av = getter(a);
    const bv = getter(b);
    let cmp = 0;
    if (av == null && bv == null) cmp = 0;
    else if (av == null) cmp = 1;
    else if (bv == null) cmp = -1;
    else if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
    else cmp = collator.compare(String(av), String(bv));
    return cmp * dir;
  });

  el.counts.textContent = `${view.length} shown / ${data.length} total`;

  if (!view.length) {
    el.rows.innerHTML = `<tr><td colspan="6" class="empty">No results</td></tr>`;
    return;
  }

  const rowsHtml = view.map(row => rowHtml(row)).join('');
  el.rows.innerHTML = rowsHtml;
}

function rowHtml(row) {
  const inputs = (row.inputs || []).map(i => pill(i.name, i.quantity)).join('');
  const byps = (row.byproducts || []).map(b => pill(b.name, b.quantity)).join('');
  
  const stepsCount = (row.graph || []).length;
  
  const recipesCell = `<button type="button" class="pill pill-btn" data-open-modal data-row-index="${escapeHtml(String(row.index))}">${stepsCount}</button>`;

  const idx = row.index == null ? '<span class="meta">—</span>' : String(row.index);
  const tier = row.tier == null ? '<span class="meta">—</span>' : escapeHtml(String(row.tier));
  return `
    <tr>
      <td>${idx}</td>
      <td>${tier}</td>
      <td><strong>${escapeHtml(row.output || '')}</strong></td>
      <td>${inputs || '<span class="meta">—</span>'}</td>
      <td>${byps || '<span class="meta">—</span>'}</td>
      <td>${recipesCell}</td>
    </tr>
  `;
}

function pill(name, quantity) {
  const qty = quantity == null ? '' : ` <small>${formatNumber(quantity)}/min</small>`;
  return `<span class="pill">${escapeHtml(String(name))}${qty}</span>`;
}

function formatNumber(n) {
  if (typeof n !== 'number' || !isFinite(n)) return String(n);
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (Math.abs(n) >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 3 });
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

function escapeHtml(str) {
  return str.replace(/[&<>"]+/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[s]));
}
