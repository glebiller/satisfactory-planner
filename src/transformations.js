const DATA_URL = '/satisfactory-planner/transformations.json';

const el = {
  rows: document.getElementById('rows'),
  filter: document.getElementById('filter'),
  counts: document.getElementById('counts'),
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
  const buildingsArr = steps.map(s => s.building).filter(b => b);
  const buildingsCount = buildingsArr.length;
  const buildingsTitle = buildingsArr.join('\n');
  const recipesCell = `<span class="badge" title="${escapeHtml(buildingsTitle)}">${buildingsCount}</span>`;
  
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
