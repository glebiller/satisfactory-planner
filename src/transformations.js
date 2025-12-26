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
  view = data.slice();
  wireSorting();
  wireFiltering();
  wireModal();
  applyFilter();
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
  // Close button
  el.modalClose?.addEventListener('click', closeModal);
  // Overlay click (outside dialog)
  el.modalOverlay?.addEventListener('click', (e) => {
    if (e.target === el.modalOverlay) closeModal();
  });
  // Escape key
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.modalOverlay.hasAttribute('hidden')) closeModal();
  });
  // Delegate clicks from table for opening the modal
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

  // Try to load precomputed graph JSON for this output
  let html = '';
  try {
    const graph = await loadGraphForOutput(row.output);
    if (graph && graph.steps && Array.isArray(graph.steps) && graph.steps.length) {
      html = buildModalHtmlFromGraph(graph);
    }
  } catch (e) {
    console.warn('Graph load failed, falling back to inline steps:', e);
  }
  if (!html) {
    html = buildModalHtml(row);
  }
  el.modalContent.innerHTML = html;
  el.modalOverlay.removeAttribute('hidden');
  // Prevent background scroll
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';
  // Focus close button for accessibility
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

    // Compute previous step outputs set for matching
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

function buildModalHtmlFromGraph(graph) {
  const steps = Array.isArray(graph.steps) ? graph.steps : [];
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
    const inputs5 = s.inputs5 || [];
    const anyPrev = inputs5.some(cell => cell && cell.fromPrev);
    const inputTds = inputs5.map(cell => {
      const cls = 'input-col' + (cell && cell.fromPrev ? ' matched' : '');
      if (!cell) return `<td class="${cls}"><span class="meta">—</span></td>`;
      const roleClass = cell.role === 'pass' ? ' role-pass' : (cell.role === 'split' ? ' role-split' : '');
      const arrow = cell.fromPrev ? ' ↓' : '';
      const hiddenNote = cell.hiddenCountOnThisSlot ? ` title="+${cell.hiddenCountOnThisSlot} more not shown"` : '';
      return `<td class="${cls}"${hiddenNote}><span class="tag${cell.fromPrev ? ' match' : ''}${roleClass}">${escapeHtml(String(cell.name))} <small>${formatNumber(cell.perMin)}/min${arrow}</small></span></td>`;
    }).join('');

    const byps = kvTags(s.byproducts);
    const building = s.building ? `<span class="tag">${escapeHtml(String(s.building))}</span>` : '<span class="meta">—</span>';
    const stepNum = s.displayStep != null ? s.displayStep : (steps.length - i);
    const recipe = s.recipe || '';

    return `
      <tr${anyPrev ? ' class="row-matched"' : ''}>
        <td class="meta">${escapeHtml(String(stepNum))}</td>
        <td>${escapeHtml(String(recipe))}<br/>${building}</td>
        ${inputTds}
        <td>${byps || '<span class="meta">—</span>'}</td>
      </tr>
    `;
  }).join('');

  const footer = '</tbody></table>';
  return header + rowsHtml + footer;
}

function placeInputsIntoFive(requires, prevOutNames) {
  // returns an array of 5 slots; each slot is either null or { name, perMin, matched, extraCount }
  const slots = new Array(5).fill(null);
  if (!requires || typeof requires !== 'object') return slots;

  // Get inputs in their original order as provided
  const entries = Object.entries(requires).map(([name, perMin]) => ({ name, perMin }));

  // Center-first order of slot indices
  const order = [2, 1, 3, 0, 4];

  // Fill up to five inputs, preserving their relative order
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
  
  const steps = row.transformation_steps || [];
  // Prefer the precomputed `num_steps` (new) when available; otherwise fall back
  // to counting non-empty building entries in `transformation_steps` to remain
  // compatible with older data.
  const buildingsArr = steps.map(s => s.building).filter(b => b);
  const buildingsCountFallback = buildingsArr.length;
  const stepsCount = (typeof row.num_steps === 'number') ? row.num_steps : buildingsCountFallback;
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
