const $ = (id) => document.getElementById(id);
const state = { job: null, assets: [], selected: new Set(), kind: 'all', formats: new Set(), es: null, visible: [] };
const PREF_KEYS = ['depth', 'maxPages', 'concurrency', 'quality', 'minW', 'minH', 'minKB', 'iconMax'];
const MEDIUM_TARGET = 800;

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('craw-prefs') || '{}');
    for (const k of PREF_KEYS) if (p[k] != null) $(k).value = p[k];
    if (p.sameHost != null) $('sameHost').checked = p.sameHost;
  } catch { /* storage bị chặn */ }
}
function savePrefs() {
  try {
    const p = { sameHost: $('sameHost').checked };
    for (const k of PREF_KEYS) p[k] = $(k).value;
    localStorage.setItem('craw-prefs', JSON.stringify(p));
  } catch { /* storage bị chặn */ }
}

const fmtBytes = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`);
const num = (id) => Math.max(0, Number($(id).value) || 0);

function kindOf(a) {
  const max = Math.max(a.width, a.height);
  if (a.iconHint || a.format === 'ico') return 'icon';
  if (max > 0 && max <= num('iconMax')) return 'icon';
  if (a.format === 'svg' && max === 0) return 'icon';
  return 'image';
}

// Mỗi nhóm = các biến thể kích thước của cùng một ảnh → chọn theo mức chất lượng
function pickByQuality(list, mode) {
  if (mode === 'all' || list.length < 2) return list;
  const area = (a) => a.width * a.height;
  const sorted = [...list].sort((x, y) => area(x) - area(y) || x.bytes - y.bytes);
  if (mode === 'min') return [sorted[0]];
  if (mode === 'max') return [sorted[sorted.length - 1]];
  const dist = (a) => Math.abs(Math.max(a.width, a.height) - MEDIUM_TARGET);
  return [sorted.reduce((best, a) => (dist(a) < dist(best) ? a : best))];
}

function computeVisible() {
  const minW = num('minW'), minH = num('minH'), minB = num('minKB') * 1024;
  const q = $('search').value.trim().toLowerCase();
  const passed = state.assets.filter((a) => {
    if (a.format !== 'svg' && (a.width < minW || a.height < minH)) return false;
    if (a.bytes < minB) return false;
    if (!state.formats.has(a.format)) return false;
    if (state.kind !== 'all' && kindOf(a) !== state.kind) return false;
    if (q && !(a.name + ' ' + a.url).toLowerCase().includes(q)) return false;
    return true;
  });
  const groups = new Map();
  for (const a of passed) {
    if (!groups.has(a.group)) groups.set(a.group, []);
    groups.get(a.group).push(a);
  }
  const mode = $('quality').value;
  const out = [];
  for (const list of groups.values()) out.push(...pickByQuality(list, mode).map((a) => ({ a, variants: list.length })));
  return out.sort((x, y) => (kindOf(x.a) === kindOf(y.a) ? y.a.width * y.a.height - x.a.width * x.a.height : kindOf(x.a) === 'image' ? -1 : 1));
}

function render() {
  state.visible = computeVisible();
  const grid = $('grid');
  grid.textContent = '';
  if (!state.visible.length) {
    grid.innerHTML = '<div class="empty">Không có ảnh nào khớp bộ lọc</div>';
  }
  const frag = document.createDocumentFragment();
  for (const { a, variants } of state.visible) {
    const card = document.createElement('div');
    card.className = 'card' + (state.selected.has(a.id) ? ' sel' : '');
    card.dataset.id = a.id;
    const dims = a.width ? `${a.width}×${a.height}` : '?';
    card.innerHTML = `
      <input type="checkbox" ${state.selected.has(a.id) ? 'checked' : ''}>
      <div class="badges">
        ${kindOf(a) === 'icon' ? '<span class="badge">icon</span>' : ''}
        ${variants > 1 ? `<span class="badge" title="Số biến thể kích thước">${variants} bản</span>` : ''}
      </div>
      <div class="thumb"><img loading="lazy" alt=""></div>
      <div class="meta">
        <div class="name"></div>
        <div class="info"><span>${dims} · ${a.format.toUpperCase()}</span><span>${fmtBytes(a.bytes)}</span></div>
      </div>`;
    card.querySelector('img').src = `/api/file/${state.job}/${a.id}`;
    const name = card.querySelector('.name');
    name.textContent = `${a.name}.${a.ext}`;
    name.title = [a.url, ...a.aliases].join('\n') + `\nNguồn: ${a.sources.join(', ')}`;
    frag.appendChild(card);
  }
  grid.appendChild(frag);
  updateSummary();
}

function selectedVisible() {
  return state.visible.filter(({ a }) => state.selected.has(a.id)).map(({ a }) => a);
}

function updateSummary() {
  const sel = selectedVisible();
  const total = sel.reduce((s, a) => s + a.bytes, 0);
  $('summary').textContent = `Hiển thị ${state.visible.length}/${state.assets.length} file · đã chọn ${sel.length} (${fmtBytes(total)})`;
  $('zipBtn').disabled = $('saveBtn').disabled = !sel.length;
}

function renderFormats() {
  const counts = {};
  for (const a of state.assets) counts[a.format] = (counts[a.format] || 0) + 1;
  state.formats = new Set(Object.keys(counts));
  $('formats').innerHTML = Object.entries(counts).sort((x, y) => y[1] - x[1])
    .map(([f, n]) => `<label><input type="checkbox" value="${f}" checked> ${f} (${n})</label>`).join('');
}

function setBusy(busy) {
  $('scanBtn').disabled = busy;
  $('cancelBtn').hidden = !busy;
  $('progress').hidden = !busy;
}

function showError(msg) {
  $('error').hidden = !msg;
  $('error').textContent = msg || '';
}

function startScan(e) {
  e.preventDefault();
  savePrefs();
  showError('');
  state.es?.close();
  const params = new URLSearchParams({
    url: $('url').value, depth: $('depth').value, maxPages: $('maxPages').value,
    concurrency: $('concurrency').value, sameHost: $('sameHost').checked ? '1' : '0',
  });
  const es = new EventSource(`/api/scan?${params}`);
  state.es = es;
  setBusy(true);
  const bar = $('progress').querySelector('i'), label = $('progress').querySelector('span');
  bar.style.width = '0';
  label.textContent = 'Đang kết nối…';

  es.addEventListener('progress', (ev) => {
    const p = JSON.parse(ev.data);
    if (p.phase === 'pages') {
      bar.style.width = '5%';
      label.textContent = `Đang đọc trang (${p.pages}) · tìm thấy ${p.found} URL · ${p.msg || ''}`;
    } else {
      bar.style.width = `${p.total ? Math.round(((p.downloaded + p.failed) / p.total) * 100) : 0}%`;
      label.textContent = `Đang tải ảnh ${p.downloaded}/${p.total}${p.failed ? ` · lỗi ${p.failed}` : ''}`;
    }
  });
  es.addEventListener('done', (ev) => {
    const d = JSON.parse(ev.data);
    es.close();
    setBusy(false);
    state.job = d.job;
    state.assets = d.assets;
    state.selected = new Set(d.assets.map((a) => a.id));
    $('filters').hidden = false;
    renderFormats();
    render();
    if (!d.assets.length) showError('Không tìm thấy ảnh nào. Trang có thể render hoàn toàn bằng JavaScript hoặc chặn bot.');
  });
  es.addEventListener('fail', (ev) => {
    es.close();
    setBusy(false);
    showError(JSON.parse(ev.data).message);
  });
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) return;
    es.close();
    setBusy(false);
    showError('Mất kết nối tới server');
  };
}

async function exportSelected(kind) {
  const items = selectedVisible().map((a) => ({ id: a.id, folder: kindOf(a) === 'icon' ? 'icons' : 'images' }));
  if (!items.length) return;
  const btn = kind === 'zip' ? $('zipBtn') : $('saveBtn');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Đang xử lý…';
  try {
    const res = await fetch(`/api/${kind}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job: state.job, items }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    if (kind === 'zip') {
      const blob = await res.blob();
      const name = (res.headers.get('Content-Disposition') || '').match(/filename="(.+?)"/)?.[1] || 'images.zip';
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } else {
      const d = await res.json();
      alert(`Đã lưu ${d.count} file vào:\n${d.dir}`);
    }
  } catch (err) {
    showError(err.message);
  } finally {
    btn.textContent = old;
    btn.disabled = false;
  }
}

$('scanForm').addEventListener('submit', startScan);
$('cancelBtn').addEventListener('click', () => { state.es?.close(); setBusy(false); showError('Đã huỷ'); });
for (const id of ['quality', 'minW', 'minH', 'minKB', 'iconMax', 'search']) {
  $(id).addEventListener('input', () => { savePrefs(); render(); });
}
$('kindTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.kind = b.dataset.kind;
  for (const x of $('kindTabs').children) x.classList.toggle('on', x === b);
  render();
});
$('formats').addEventListener('change', (e) => {
  if (e.target.checked) state.formats.add(e.target.value); else state.formats.delete(e.target.value);
  render();
});
$('grid').addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const id = card.dataset.id;
  if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
  card.classList.toggle('sel', state.selected.has(id));
  card.querySelector('input').checked = state.selected.has(id);
  updateSummary();
});
$('grid').addEventListener('dblclick', (e) => {
  const card = e.target.closest('.card');
  if (card) window.open(`/api/file/${state.job}/${card.dataset.id}`, '_blank');
});
$('selAll').addEventListener('click', () => { for (const { a } of state.visible) state.selected.add(a.id); render(); });
$('selNone').addEventListener('click', () => { for (const { a } of state.visible) state.selected.delete(a.id); render(); });
$('zipBtn').addEventListener('click', () => exportSelected('zip'));
$('saveBtn').addEventListener('click', () => exportSelected('save'));
loadPrefs();
