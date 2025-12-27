const DATA_URL = '/satisfactory-planner/transformations.json';
const GRAPHS_BASE = '/satisfactory-planner/graphs';
const graphCache = new Map();

function slugifyName(name) {
  if (!name) return '';
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/ \//g, '-')
    .replace(/\//g, '-')
    .replace(/\s+/g, '-')
    .replace(/'/g, '');
}

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
  data = raw.map(computePerMin);
  
  await preloadGraphLayerCounts();
  
  view = data.slice();
  wireSorting();
  wireFiltering();
  wireModal();
  applyFilter();
}

async function preloadGraphLayerCounts() {
  for (const row of data) {
    try {
      const graph = await loadGraphForOutput(row.output);
      if (graph && graph.rows) {
        const layerCount = graph.rows.filter(r => r.rowType === 'layer').length;
        row.graphLayerCount = layerCount;
      }
    } catch (e) {
    }
  }
}

function computePerMin(row) {
  const steps = row.transformation_steps || [];
  
  const inputsWithPerMin = (row.inputs || []).map(input => {
    let totalPerMin = 0;
    for (const step of steps) {
      if (step.requires && step.requires[input.name]) {
        totalPerMin += step.requires[input.name];
      }
    }
    return {
      name: input.name,
      perMin: totalPerMin
    };
  });
  
  const byproductsWithPerMin = (row.byproducts || []).map(byproduct => {
    let totalPerMin = 0;
    for (const step of steps) {
      if (step.byproducts && step.byproducts[byproduct.name]) {
        totalPerMin += step.byproducts[byproduct.name];
      }
    }
    return {
      name: byproduct.name,
      perMin: totalPerMin
    };
  });
  
  const recipeNames = steps.map(s => s.recipe);
  
  return {
    ...row,
    inputs: inputsWithPerMin,
    byproducts: byproductsWithPerMin,
    recipes: recipeNames
  };
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

async function openModalForRow(row) {
  const titleLeft = row.tier != null ? `Tier ${escapeHtml(String(row.tier))}` : '';
  const titleRight = row.output || 'Transformation';
  el.modalTitle.textContent = `${titleLeft} • ${titleRight}`;

  let html = '';
  try {
    const graph = await loadGraphForOutput(row.output);
    if (graph && graph.rows && Array.isArray(graph.rows) && graph.rows.length) {
      html = buildModalHtmlFromGraphV3(graph);
    }
  } catch (e) {
    console.warn('Graph load failed, falling back to inline steps:', e);
  }
  if (!html) {
    html = buildModalHtml(row);
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

function buildModalHtml(row) {
  const steps = row.transformation_steps || [];
  const header = `
    <table>
      <thead>
        <tr>
          <th style="width:52px">Step</th>
          <th>Recipe</th>
          <th class="input-col">In‑1</th>
          <th class="input-col">In‑2</th>
          <th class="input-col">In‑3</th>
          <th class="input-col">In‑4</th>
          <th class="input-col">In‑5</th>
          <th style="width:16%">By‑products</th>
        </tr>
      </thead>
      <tbody>
  `;

  const rowsHtml = steps.map((s, i) => {
    const byps = kvTags(s.byproducts);

    const prev = i > 0 ? steps[i - 1] : null;
    const prevOutNames = new Set(
      prev && prev.produces ? Object.keys(prev.produces) : []
    );

    const inputCells = placeInputsIntoFive(s.requires, prevOutNames);
    const anyMatched = inputCells.some(cell => cell && cell.matched);

    const inputTds = inputCells.map(cell => {
      const cls = 'input-col' + (cell && cell.matched ? ' matched' : '');
      if (!cell) return `<td class="${cls}"><span class="meta">—</span></td>`;
      const pill = `<span class="tag${cell.matched ? ' match' : ''}">${escapeHtml(String(cell.name))} <small>${formatNumber(cell.perMin)}/min</small></span>`;
      const title = cell.extraCount && cell.extraCount > 0 ? ` title="+${cell.extraCount} more not shown"` : '';
      return `<td class="${cls}"${title}>${pill}</td>`;
    }).join('');

    return `
      <tr${anyMatched ? ' class="row-matched"' : ''}>
        <td class="meta">${i + 1}</td>
        <td>${escapeHtml(String(s.recipe || ''))}<br/><span class="tag">${escapeHtml(String(s.building || ''))}</span></td>
        ${inputTds}
        <td>${byps || '<span class="meta">—</span>'}</td>
      </tr>
    `;
  }).join('');

  const footer = '</tbody></table>';
  return header + rowsHtml + footer;
}

async function loadGraphForOutput(outputName) {
  const slug = slugifyName(outputName);
  if (graphCache.has(slug)) return graphCache.get(slug);
  const url = `${GRAPHS_BASE}/${slug}.json`;
  const graph = await fetchJson(url);
  graphCache.set(slug, graph);
  return graph;
}

function buildModalHtmlFromGraphV3(graph) {
  const rows = Array.isArray(graph.rows) ? graph.rows : [];
  const maxLevel = Math.max(...rows.filter(r => r.level).map(r => r.level), 0);
  
  const header = `
    <table class="flow-table">
      <thead>
        <tr>
          <th style="width:50px">Lvl</th>
          <th style="width:160px">Recipe/Building</th>
          <th class="lane-col">Lane 1</th>
          <th class="lane-col">Lane 2</th>
          <th class="lane-col">Lane 3</th>
          <th class="lane-col">Lane 4</th>
          <th class="lane-col">Lane 5</th>
          <th style="width:14%">By‑products</th>
        </tr>
      </thead>
      <tbody>
  `;

  const rowsHtml = rows.slice().reverse().map((row, i) => {
    if (row.rowType === 'layer') {
      return buildLayerRowV3(row);
    } else if (row.rowType === 'belts') {
      return buildBeltsRowV3(row);
    }
    return '';
  }).join('');

  const footer = '</tbody></table>';
  return header + rowsHtml + footer;
}

function buildLayerRowV3(row) {
  const level = row.level != null ? row.level : '?';
  const recipe = row.recipe || '';
  const building = row.building ? escapeHtml(String(row.building)) : '<span class="meta">—</span>';
  const byps = kvTags(row.byproducts);
  
  const lanes = row.lanes || [];
  const laneTds = lanes.map(lane => {
    if (!lane) return '<td class="lane-col"><span class="meta">—</span></td>';
    
    const action = lane.action || 'unknown';
    let indicator = '';
    let className = 'lane-item';
    
    if (action === 'consume') {
      indicator = '↓';
      className += ' lane-consume';
    } else if (action === 'pass') {
      indicator = '↑';
      className += ' lane-pass';
    }
    
    return `<td class="lane-col"><div class="${className}"><span class="lane-indicator">${indicator}</span>${escapeHtml(String(lane.name))}<br/><small>${formatNumber(lane.perMin)}/min</small></div></td>`;
  }).join('');

  return `
    <tr class="layer-row">
      <td class="level-cell">${level}</td>
      <td class="recipe-cell"><strong>${escapeHtml(recipe)}</strong><br/><span class="building-tag">${building}</span></td>
      ${laneTds}
      <td>${byps || '<span class="meta">—</span>'}</td>
    </tr>
  `;
}

function buildBeltsRowV3(row) {
  const lanes = row.lanes || [];
  const laneTds = lanes.map(lane => {
    if (!lane) return '<td class="lane-col belt-cell"></td>';
    
    const action = lane.action || '';
    let className = 'belt-item';
    let indicator = '';
    
    if (action === 'fromBelow') {
      className += ' belt-produced';
      indicator = '↑';
    } else if (action === 'pass') {
      className += ' belt-passthrough';
      indicator = '↑';
    }
    
    return `<td class="lane-col belt-cell"><div class="${className}"><span class="belt-indicator">${indicator}</span>${escapeHtml(String(lane.name))}<br/><small>${formatNumber(lane.perMin)}/min</small></div></td>`;
  }).join('');

  return `
    <tr class="belt-row">
      <td colspan="2" class="belt-label">Belts ↑</td>
      ${laneTds}
      <td></td>
    </tr>
  `;
}

function placeInputsIntoFive(requires, prevOutNames) {
  const slots = new Array(5).fill(null);
  if (!requires || typeof requires !== 'object') return slots;

  const entries = Object.entries(requires).map(([name, perMin]) => ({ name, perMin }));

  const order = [2, 1, 3, 0, 4];

  let extraCount = Math.max(0, entries.length - 5);
  entries.slice(0, 5).forEach((item, idx) => {
    const slotIndex = order[idx];
    const matched = prevOutNames && prevOutNames.has(item.name);
    slots[slotIndex] = { name: item.name, perMin: item.perMin, matched, extraCount: idx === 4 ? extraCount : 0 };
  });

  return slots;
}

function kvTags(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return Object.entries(obj)
    .map(([k, v]) => `<span class="tag">${escapeHtml(String(k))} <small>${formatNumber(v)}/min</small></span>`) 
    .join('');
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

  const inputs = (row.inputs || []).map(i => `${i.name} ${i.perMin}`).join(' ').toLowerCase();
  if (inputs.includes(q)) return true;

  const byps = (row.byproducts || []).map(b => `${b.name} ${b.perMin}`).join(' ').toLowerCase();
  if (byps.includes(q)) return true;

  const recipes = (row.recipes || []).join(' ').toLowerCase();
  if (recipes.includes(q)) return true;

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
      case 'inputs': return (row.inputs || []).map(i => `${i.name}:${i.perMin}`).join(', ');
      case 'byProducts': return (row.byproducts || []).map(b => `${b.name}:${b.perMin}`).join(', ');
      case 'recipes': return (row.recipes || []).length;
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
  const inputs = (row.inputs || []).map(i => pill(i.name, i.perMin)).join('');
  const byps = (row.byproducts || []).map(b => pill(b.name, b.perMin)).join('');
  
  let stepsCount;
  if (typeof row.graphLayerCount === 'number') {
    stepsCount = row.graphLayerCount;
  } else {
    const steps = row.transformation_steps || [];
    const buildingsArr = steps.map(s => s.building).filter(b => b);
    const buildingsCountFallback = buildingsArr.length;
    stepsCount = (typeof row.num_steps === 'number') ? row.num_steps : buildingsCountFallback;
  }
  
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

function pill(name, perMin) {
  const qty = perMin == null ? '' : ` <small>${formatNumber(perMin)}/min</small>`;
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
