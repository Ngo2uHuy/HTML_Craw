// Chuyển frame Figma -> HTML/CSS/JS tĩnh qua Figma REST API.
// Auto-layout -> flexbox, phần còn lại định vị tuyệt đối; vector/icon xuất SVG, ảnh tải về assets/.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const API = 'https://api.figma.com/v1';
const VECTOR_TYPES = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'LINE', 'REGULAR_POLYGON']);
const SHAPE_TYPES = new Set([...VECTOR_TYPES, 'ELLIPSE', 'RECTANGLE']);
const CONTAINER_TYPES = new Set(['FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE']);
const MAX_FRAMES = 30;
const JUSTIFY = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', SPACE_BETWEEN: 'space-between' };
const ALIGN = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', BASELINE: 'baseline' };
const TEXT_ALIGN = { LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' };
const TEXT_CASE = { UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize' };
const TEXT_DECO = { UNDERLINE: 'underline', STRIKETHROUGH: 'line-through' };
const SCALE_MODE = { FILL: 'center / cover no-repeat', FIT: 'center / contain no-repeat', STRETCH: '0 0 / 100% 100% no-repeat', TILE: '0 0 / auto repeat' };

const SCRIPT = `// Thu nhỏ frame cho vừa màn hình hẹp hơn bản thiết kế (không phóng to).
(function () {
  var stage = document.querySelector('.figma-stage');
  var frame = stage.firstElementChild;
  function fit() {
    var w = frame.offsetWidth, h = frame.offsetHeight;
    var k = Math.min(1, document.documentElement.clientWidth / w);
    frame.style.transform = k < 1 ? 'scale(' + k + ')' : '';
    stage.style.width = w * k + 'px';
    stage.style.height = h * k + 'px';
  }
  addEventListener('resize', fit);
  addEventListener('load', fit);
  fit();
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-href]');
    if (el) location.href = el.getAttribute('data-href');
  });
})();
`;
const BASE_CSS = `*,*::before,*::after{box-sizing:border-box}
body{margin:0;-webkit-font-smoothing:antialiased}
p{margin:0}
img{display:block}
.figma-stage{margin:0 auto;overflow:hidden}
.figma-stage>*{transform-origin:0 0}
`;

// ---------- helpers ----------
const round = v => +(+v).toFixed(2);
const px = v => (round(v) === 0 ? '0' : `${round(v)}px`);
const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = s => escHtml(s).replace(/"/g, '&quot;');
const slug = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const visible = arr => (arr || []).filter(x => x.visible !== false);
function unique(base, used) {
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base}-${i}`;
  used.add(name);
  return name;
}
const rgba = (c, opacity = 1) => {
  const a = round((c.a ?? 1) * opacity);
  const [r, g, b] = [c.r, c.g, c.b].map(v => Math.round(v * 255));
  return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;
};
const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

function limiter(n) {
  let active = 0;
  const waiting = [];
  return async fn => {
    if (active < n) active++;
    else await new Promise(r => waiting.push(r));
    try { return await fn(); } finally { const next = waiting.shift(); next ? next() : active--; }
  };
}

export function parseFigmaUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new Error('Link Figma không hợp lệ'); }
  if (!/(^|\.)figma\.com$/i.test(u.hostname)) throw new Error('Không phải link figma.com');
  const m = u.pathname.match(/^\/(?:file|design|proto)\/([A-Za-z0-9]+)/);
  if (!m) throw new Error('Không tìm thấy file key trong link Figma');
  const branch = u.pathname.match(/\/branch\/([A-Za-z0-9]+)/);
  const node = u.searchParams.get('node-id');
  return { key: branch ? branch[1] : m[1], nodeId: node ? node.replace(/-/g, ':') : null };
}

export const figmaSiteName = ({ key, nodeId }) => `figma-${key}${nodeId ? `-${nodeId.replace(/[^\w]+/g, '-')}` : ''}`;

function topFrames(n) {
  if (n.type === 'CANVAS' || n.type === 'SECTION') {
    return visible(n.children)
      .filter(c => c.absoluteBoundingBox && c.type !== 'TEXT' && !VECTOR_TYPES.has(c.type))
      .flatMap(topFrames);
  }
  return [n];
}

// Nhóm chỉ gồm vector/shape (icon, logo) -> xuất nguyên khối thành 1 SVG.
function isGraphic(n, isRoot) {
  if (isRoot) return false;
  if (VECTOR_TYPES.has(n.type)) return true;
  if (!CONTAINER_TYPES.has(n.type)) return false;
  const kids = visible(n.children);
  if (!kids.length) return false;
  let hasVector = false;
  const ok = node => {
    if (visible(node.fills).some(f => f.type === 'IMAGE')) return false;
    if (VECTOR_TYPES.has(node.type)) { hasVector = true; return true; }
    if (SHAPE_TYPES.has(node.type)) return true;
    if (CONTAINER_TYPES.has(node.type)) return visible(node.children).every(ok);
    return false;
  };
  return kids.every(ok) && hasVector;
}

function linkOf(n, pageFiles) {
  const nav = (n.interactions || []).flatMap(i => i.actions || []).find(a => a && (a.type === 'URL' || (a.type === 'NODE' && a.navigation === 'NAVIGATE')));
  if (nav?.type === 'URL') return nav.url;
  return pageFiles.get(nav?.destinationId || n.transitionNodeID) || null;
}

// ---------- paints & styles ----------
function gradient(p) {
  const stops = (p.gradientStops || []).map(s => `${rgba(s.color, p.opacity ?? 1)} ${round(s.position * 100)}%`).join(', ');
  const [h0, h1] = p.gradientHandlePositions || [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }];
  if (p.type === 'GRADIENT_LINEAR') {
    const deg = Math.atan2(h1.y - h0.y, h1.x - h0.x) * 180 / Math.PI + 90;
    return `linear-gradient(${round(deg)}deg, ${stops})`;
  }
  const at = `${round(h0.x * 100)}% ${round(h0.y * 100)}%`;
  if (p.type === 'GRADIENT_ANGULAR') return `conic-gradient(from 90deg at ${at}, ${stops})`;
  return `radial-gradient(ellipse at ${at}, ${stops})`;
}

function background(fills, assetPaths) {
  const layers = visible(fills).reverse().map(p => {
    if (p.type === 'SOLID') return { color: rgba(p.color, p.opacity ?? 1) };
    if (p.type.startsWith('GRADIENT_')) return { image: gradient(p) };
    if (p.type === 'IMAGE' && assetPaths.get(p.imageRef)) {
      return { image: `url("${assetPaths.get(p.imageRef)}") ${SCALE_MODE[p.scaleMode] || SCALE_MODE.FILL}` };
    }
    return null;
  }).filter(Boolean);
  if (!layers.length) return {};
  if (layers.length === 1 && layers[0].color) return { 'background-color': layers[0].color };
  return { background: layers.map(l => l.image || `linear-gradient(${l.color}, ${l.color})`).join(', ') };
}

function radius(n) {
  if (n.rectangleCornerRadii) return n.rectangleCornerRadii.map(px).join(' ');
  return n.cornerRadius ? px(n.cornerRadius) : null;
}

// Stroke dùng box-shadow để không làm lệch layout như border.
function strokeShadows(n) {
  const s = visible(n.strokes).find(p => p.type === 'SOLID');
  if (!s) return [];
  const c = rgba(s.color, s.opacity ?? 1);
  const inset = n.strokeAlign === 'OUTSIDE' ? '' : 'inset ';
  const w = n.individualStrokeWeights;
  if (w) {
    return [
      w.top && `inset 0 ${px(w.top)} 0 0 ${c}`, w.bottom && `inset 0 ${px(-w.bottom)} 0 0 ${c}`,
      w.left && `inset ${px(w.left)} 0 0 0 ${c}`, w.right && `inset ${px(-w.right)} 0 0 0 ${c}`,
    ].filter(Boolean);
  }
  return n.strokeWeight ? [`${inset}0 0 0 ${px(n.strokeWeight)} ${c}`] : [];
}

function effectStyle(n, isText) {
  const s = {};
  const shadows = [];
  for (const e of visible(n.effects)) {
    const { x = 0, y = 0 } = e.offset || {};
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      if (isText) shadows.push(`${px(x)} ${px(y)} ${px(e.radius)} ${rgba(e.color)}`);
      else shadows.push(`${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${px(x)} ${px(y)} ${px(e.radius)} ${px(e.spread || 0)} ${rgba(e.color)}`);
    } else if (e.type === 'LAYER_BLUR') s.filter = `blur(${px(e.radius / 2)})`;
    else if (e.type === 'BACKGROUND_BLUR') s['backdrop-filter'] = `blur(${px(e.radius / 2)})`;
  }
  return { s, shadows };
}

export function addFont(fonts, st) {
  if (!st.fontFamily) return;
  if (!fonts.has(st.fontFamily)) fonts.set(st.fontFamily, new Set());
  fonts.get(st.fontFamily).add(st.fontWeight || 400);
}

export const fontLinks = fonts => [...fonts].map(([fam, w]) =>
  `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(fam).replace(/%20/g, '+')}:wght@${[...w].sort((a, b) => a - b).join(';')}&amp;display=swap">`).join('\n');

function textStyle(st = {}, fonts) {
  const s = {};
  if (st.fontFamily) {
    s['font-family'] = `"${st.fontFamily}", system-ui, sans-serif`;
    addFont(fonts, st);
  }
  if (st.fontWeight) s['font-weight'] = st.fontWeight;
  if (st.fontSize) s['font-size'] = px(st.fontSize);
  if (st.italic) s['font-style'] = 'italic';
  if (st.lineHeightPx && st.lineHeightUnit !== 'INTRINSIC_%') s['line-height'] = px(st.lineHeightPx);
  if (st.letterSpacing) s['letter-spacing'] = px(st.letterSpacing);
  if (TEXT_ALIGN[st.textAlignHorizontal]) s['text-align'] = TEXT_ALIGN[st.textAlignHorizontal];
  if (TEXT_CASE[st.textCase]) s['text-transform'] = TEXT_CASE[st.textCase];
  if (TEXT_DECO[st.textDecoration]) s['text-decoration'] = TEXT_DECO[st.textDecoration];
  return s;
}

function textColor(fills) {
  const f = visible(fills).find(p => p.type === 'SOLID');
  return f ? { color: rgba(f.color, f.opacity ?? 1) } : {};
}

const inlineStyle = s => Object.entries(s).map(([k, v]) => `${k}:${v}`).join(';');

function textRuns(n, fonts) {
  const chars = [...(n.characters || '')];
  const ov = n.characterStyleOverrides || [];
  const table = n.styleOverrideTable || {};
  let html = '';
  for (let i = 0; i < chars.length;) {
    const id = ov[i] || 0;
    let j = i;
    while (j < chars.length && (ov[j] || 0) === id) j++;
    const text = escHtml(chars.slice(i, j).join(''));
    const st = id && table[id];
    if (st) {
      const s = { ...textStyle(st, fonts), ...(st.fills ? textColor(st.fills) : {}) };
      html += Object.keys(s).length ? `<span style="${escAttr(inlineStyle(s))}">${text}</span>` : text;
    } else html += text;
    i = j;
  }
  return html;
}

function layoutStyle(n, parent) {
  const s = {};
  const b = n.absoluteBoundingBox || { x: 0, y: 0, width: 0, height: 0 };
  if (!parent) {
    Object.assign(s, { position: 'relative', width: px(b.width), height: px(b.height) });
    return s;
  }
  const flow = parent.layoutMode && parent.layoutMode !== 'NONE' && n.layoutPositioning !== 'ABSOLUTE';
  if (!flow) {
    const pb = parent.absoluteBoundingBox || b;
    return Object.assign(s, {
      position: 'absolute', left: px(b.x - pb.x), top: px(b.y - pb.y), width: px(b.width), height: px(b.height),
    });
  }
  s.position = 'relative';
  const horiz = parent.layoutMode === 'HORIZONTAL';
  const sizeH = n.layoutSizingHorizontal || (horiz ? (n.layoutGrow ? 'FILL' : 'FIXED') : (n.layoutAlign === 'STRETCH' ? 'FILL' : 'FIXED'));
  const sizeV = n.layoutSizingVertical || (!horiz ? (n.layoutGrow ? 'FILL' : 'FIXED') : (n.layoutAlign === 'STRETCH' ? 'FILL' : 'FIXED'));
  const axis = (mode, prop, along) => {
    if (mode === 'FIXED') s[prop] = px(b[prop]);
    else if (mode === 'FILL') {
      if (along) { s.flex = '1 1 0'; s[`min-${prop}`] = '0'; } else s['align-self'] = 'stretch';
    }
  };
  axis(sizeH, 'width', horiz);
  axis(sizeV, 'height', !horiz);
  if (!s.flex) s['flex-shrink'] = '0';
  return s;
}

function autoLayoutStyle(n) {
  if (!n.layoutMode || n.layoutMode === 'NONE' || n.layoutMode === 'GRID') return {};
  const s = { display: 'flex', 'flex-direction': n.layoutMode === 'HORIZONTAL' ? 'row' : 'column' };
  if (n.layoutWrap === 'WRAP') s['flex-wrap'] = 'wrap';
  if (n.itemSpacing && n.primaryAxisAlignItems !== 'SPACE_BETWEEN') s.gap = px(n.itemSpacing);
  if (n.layoutWrap === 'WRAP' && n.counterAxisSpacing) s[n.layoutMode === 'HORIZONTAL' ? 'row-gap' : 'column-gap'] = px(n.counterAxisSpacing);
  const pad = [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].map(v => px(v || 0));
  if (pad.some(v => v !== '0')) s.padding = pad.join(' ');
  if (JUSTIFY[n.primaryAxisAlignItems]) s['justify-content'] = JUSTIFY[n.primaryAxisAlignItems];
  if (ALIGN[n.counterAxisAlignItems]) s['align-items'] = ALIGN[n.counterAxisAlignItems];
  return s;
}

export { visible, rgba, round, escHtml, linkOf };

// ---------- main ----------
// Đọc frame + tải ảnh/SVG; dùng chung cho bản chuyển pixel và bản AI.
export async function prepareFigma({ url, token, out, signal, onEvent = () => {} }) {
  token ||= process.env.FIGMA_TOKEN;
  if (!token) throw new Error('Thiếu Figma access token (nhập ở form hoặc đặt biến môi trường FIGMA_TOKEN)');
  const ref = parseFigmaUrl(url);
  const { key } = ref;
  const OUT = path.resolve(out || path.join('output', figmaSiteName(ref)));
  const stats = { pages: 0, assets: 0, failed: 0 };
  const emit = (type, data = {}) => onEvent({ type, ...data, stats: { ...stats } });
  const pool = limiter(6);

  async function get(p) {
    const res = await fetch(API + p, { headers: { 'X-Figma-Token': token }, signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Figma API ${res.status}: ${data.err || data.message || res.statusText}`);
    return data;
  }
  async function getNodes(ids) {
    const nodes = {};
    for (const part of chunks(ids, 50)) {
      const d = await get(`/files/${key}/nodes?ids=${part.map(encodeURIComponent).join(',')}`);
      for (const [id, v] of Object.entries(d.nodes || {})) if (v?.document) nodes[id] = v.document;
    }
    return nodes;
  }
  async function save(rel, data) {
    const file = path.join(OUT, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  }

  // 1. Lấy các frame cần chuyển
  emit('page', { url: `Đọc file Figma ${key}${ref.nodeId ? ` (node ${ref.nodeId})` : ''}` });
  let roots;
  if (ref.nodeId) {
    const n = (await getNodes([ref.nodeId]))[ref.nodeId];
    if (!n) throw new Error(`Không tìm thấy node ${ref.nodeId} trong file`);
    roots = [n];
  } else {
    const file = await get(`/files/${key}?depth=2`);
    const page = file.document.children[0];
    const ids = visible(page.children).map(c => c.id);
    const nodes = await getNodes(ids);
    roots = [{ ...page, children: ids.map(id => nodes[id]).filter(Boolean) }];
  }
  const frames = roots.flatMap(topFrames).slice(0, MAX_FRAMES);
  if (!frames.length) throw new Error('Không có frame nào để chuyển');

  // 2. Quét ảnh + vector cần xuất
  const imageRefs = new Set();
  const graphic = new Set();
  const scan = (n, isRoot) => {
    if (n.visible === false) return;
    if (isGraphic(n, isRoot)) return graphic.add(n.id);
    for (const f of visible(n.fills)) if (f.type === 'IMAGE' && f.imageRef) imageRefs.add(f.imageRef);
    visible(n.children).forEach(c => scan(c, false));
  };
  frames.forEach(f => scan(f, true));

  // 3. Tải ảnh và SVG
  const assetPaths = new Map(); // imageRef | nodeId -> rel
  const download = (src, base, k) => pool(async () => {
    try {
      if (!src) throw new Error('Figma không trả về URL');
      const res = await fetch(src, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get('content-type') || '';
      const ext = type.includes('svg') ? '.svg' : type.includes('png') ? '.png' : type.includes('jpeg') ? '.jpg'
        : type.includes('gif') ? '.gif' : type.includes('webp') ? '.webp' : '';
      await save(base + ext, Buffer.from(await res.arrayBuffer()));
      assetPaths.set(k, base + ext);
      stats.assets++;
      emit('asset');
    } catch (e) {
      if (signal?.aborted) throw e;
      stats.failed++;
      emit('error', { url: k, message: e.message });
    }
  });

  if (imageRefs.size) {
    emit('page', { url: `Tải ${imageRefs.size} ảnh` });
    const { meta } = await get(`/files/${key}/images`);
    await Promise.all([...imageRefs].map(r => download(meta?.images?.[r], `assets/img-${r.slice(0, 16)}`, r)));
  }
  if (graphic.size) {
    emit('page', { url: `Xuất ${graphic.size} icon/vector (SVG)` });
    for (const part of chunks([...graphic], 50)) {
      const { images = {} } = await get(`/images/${key}?ids=${part.map(encodeURIComponent).join(',')}&format=svg`);
      await Promise.all(part.map(id => download(images[id], `assets/vec-${id.replace(/[^\w]+/g, '-')}`, id)));
    }
  }

  const usedFiles = new Set(['index']);
  const pageFiles = new Map(frames.map((f, i) => [
    f.id, frames.length === 1 ? 'index.html' : `${unique(slug(f.name) || `frame-${i + 1}`, usedFiles)}.html`,
  ]));
  return { key, OUT, stats, emit, get, save, frames, graphic, assetPaths, pageFiles, signal };
}

export async function figmaToHtml(opts) {
  const { key, OUT, stats, emit, save, frames, graphic, assetPaths, pageFiles, signal } = await prepareFigma(opts);
  await saveIndex(save, key, frames, pageFiles);

  // 4. Sinh HTML/CSS
  const usedCls = new Set();
  const fonts = new Map();
  const cssRules = [];

  function render(n, parent) {
    if (n.visible === false || n.isMask) return '';
    let base = slug(n.name);
    if (!base || /^\d/.test(base)) base = `${n.type.toLowerCase().replace(/_/g, '-')}${base ? `-${base}` : ''}`;
    const cls = unique(base, usedCls);
    const s = layoutStyle(n, parent);
    if (n.opacity != null && n.opacity < 1) s.opacity = round(n.opacity);
    let attrs = `class="${cls}"`;
    const link = linkOf(n, pageFiles);
    if (link) { attrs += ` data-href="${escAttr(link)}"`; s.cursor = 'pointer'; }

    let html;
    if (graphic.has(n.id)) {
      const src = assetPaths.get(n.id);
      html = src ? `<img ${attrs} src="${src}" alt="${escAttr(n.name)}">` : `<div ${attrs}></div>`;
    } else if (n.type === 'TEXT') {
      const { s: fx, shadows } = effectStyle(n, true);
      Object.assign(s, textStyle(n.style, fonts), textColor(n.fills), fx);
      if (shadows.length) s['text-shadow'] = shadows.join(', ');
      s['white-space'] = n.style?.textAutoResize === 'WIDTH_AND_HEIGHT' ? 'pre' : 'pre-wrap';
      let inner = textRuns(n, fonts);
      const va = n.style?.textAlignVertical;
      if (va === 'CENTER' || va === 'BOTTOM') {
        Object.assign(s, { display: 'flex', 'flex-direction': 'column', 'justify-content': va === 'CENTER' ? 'center' : 'flex-end' });
        inner = `<span>${inner}</span>`;
      }
      html = `<p ${attrs}>${inner}</p>`;
    } else {
      const { s: fx, shadows } = effectStyle(n, false);
      Object.assign(s, background(n.fills, assetPaths), autoLayoutStyle(n), fx);
      const r = n.type === 'ELLIPSE' ? '50%' : radius(n);
      if (r) s['border-radius'] = r;
      const allShadows = [...strokeShadows(n), ...shadows];
      if (allShadows.length) s['box-shadow'] = allShadows.join(', ');
      if (n.clipsContent) s.overflow = 'hidden';
      html = `<div ${attrs}>${visible(n.children).map(c => render(c, n)).join('')}</div>`;
    }
    cssRules.push(`.${cls}{${inlineStyle(s)}}`);
    return html;
  }

  for (const f of frames) {
    signal?.throwIfAborted();
    const file = pageFiles.get(f.id);
    emit('page', { url: `Tạo ${file} từ frame "${f.name}"` });
    const body = render(f, null);
    const bg = visible(f.fills).find(p => p.type === 'SOLID');
    await save(file, `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(f.name)}</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
${fontLinks(fonts)}
<link rel="stylesheet" href="style.css">
</head>
<body${bg ? ` style="background:${rgba(bg.color, bg.opacity ?? 1)}"` : ''}>
<div class="figma-stage">${body}</div>
<script src="script.js"></script>
</body>
</html>
`);
    stats.pages++;
    emit('stats');
  }

  await save('style.css', BASE_CSS + cssRules.join('\n') + '\n');
  await save('script.js', SCRIPT);
  return { ...stats, out: OUT, entry: 'index.html', aborted: false };
}

// Nhiều frame -> index.html liệt kê các trang.
export async function saveIndex(save, key, frames, pageFiles) {
  if (frames.length < 2) return;
  await save('index.html', `<!doctype html>
<html lang="vi">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Figma ${key}</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px}a{display:block;padding:10px 0;border-bottom:1px solid #ddd;color:#2f6fed;text-decoration:none}</style>
</head>
<body><h1>Các trang</h1>
${frames.map(f => `<a href="${pageFiles.get(f.id)}">${escHtml(f.name)}</a>`).join('\n')}
</body>
</html>
`);
}
