import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractFromHtml, cssUrls, isLikelyImageUrl, isNonImageUrl } from './extract.js';
import { variantInfo } from './variants.js';
import { imageInfo } from './imagesize.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const MAX_BYTES = 40 * 1024 * 1024;
const PAGE_SKIP_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|pdf|zip|rar|7z|docx?|xlsx?|pptx?|mp[34]|webm|avi|mov|css|js|json|xml|txt)(\?|$)/i;

class UnionFind {
  parent = new Map();
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r);
    while (x !== r) { const n = this.parent.get(x); this.parent.set(x, r); x = n; }
    return r;
  }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent.set(ra, rb); }
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

const bareHost = (h) => h.replace(/^www\./, '');

function fileBaseName(url, fallback) {
  if (url.startsWith('data:')) return fallback;
  try {
    const u = new URL(url);
    let name = decodeURIComponent(u.pathname.split('/').pop() || '');
    if (/\/_next\/image\/?$/.test(u.pathname) && u.searchParams.get('url')) {
      name = decodeURIComponent(u.searchParams.get('url').split('/').pop());
    }
    name = name.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 80);
    return name || fallback;
  } catch { return fallback; }
}

/**
 * opts: { url, depth, maxPages, sameHost, concurrency }
 * ctx:  { dir, signal, onProgress }
 */
export async function crawl(opts, { dir, signal, onProgress }) {
  const start = new URL(opts.url);
  const depth = Math.max(0, Math.min(Number(opts.depth) || 0, 5));
  const maxPages = Math.max(1, Math.min(Number(opts.maxPages) || 20, 500));
  const concurrency = Math.max(1, Math.min(Number(opts.concurrency) || 8, 32));
  const sameHost = opts.sameHost !== false;

  const cands = new Map();
  const uf = new UnionFind();
  const svgs = new Map();
  const seenCss = new Set(), seenManifest = new Set(), seenPages = new Set();
  const stats = { pages: 0, found: 0, downloaded: 0, failed: 0, total: 0 };
  const progress = (phase, msg) => onProgress?.({ phase, msg, ...stats });

  const request = (url, referer, accept = '*/*', timeout = 30000) => fetch(url, {
    headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'vi,en;q=0.8', ...(referer ? { Referer: referer } : {}) },
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    redirect: 'follow',
  });

  function addCand(raw, base, page, source, { iconHint = false, group, derived = false } = {}) {
    if (!raw) return null;
    let abs;
    if (raw.startsWith('data:')) {
      if (!/^data:image\//i.test(raw)) return null;
      abs = raw;
    } else {
      try { const u = new URL(raw, base); if (!/^https?:$/.test(u.protocol)) return null; u.hash = ''; abs = u.href; } catch { return null; }
      if (isNonImageUrl(abs)) return null;
    }
    let c = cands.get(abs);
    if (!c) {
      c = { url: abs, sources: new Set(), pages: new Set(), groups: new Set(), iconHint: false, derived };
      cands.set(abs, c);
      stats.found = cands.size;
    }
    if (!derived) { c.derived = false; c.sources.add(source); c.pages.add(page); }
    if (iconHint) c.iconHint = true;
    if (group) c.groups.add(`${page}#${group}`);
    uf.find(abs);
    return abs;
  }

  async function loadCss(cssUrl, page, level = 0) {
    if (seenCss.has(cssUrl) || level > 2 || signal.aborted) return;
    seenCss.add(cssUrl);
    try {
      const res = await request(cssUrl, page, 'text/css,*/*;q=0.1');
      if (!res.ok) return;
      const css = await res.text();
      for (const u of cssUrls(css)) {
        if (/\.css(\?|$)/i.test(u)) {
          try { await loadCss(new URL(u, cssUrl).href, page, level + 1); } catch { /* url lỗi */ }
        } else addCand(u, cssUrl, page, 'css');
      }
    } catch { /* bỏ qua CSS lỗi */ }
  }

  async function loadManifest(mUrl, page) {
    if (seenManifest.has(mUrl) || signal.aborted) return;
    seenManifest.add(mUrl);
    try {
      const res = await request(mUrl, page, 'application/json,*/*;q=0.1');
      if (!res.ok) return;
      const json = await res.json();
      for (const ic of json.icons || []) addCand(ic.src, mUrl, page, 'manifest', { iconHint: true });
    } catch { /* bỏ qua manifest lỗi */ }
  }

  async function processPage(pageUrl) {
    if (signal.aborted) return [];
    const res = await request(pageUrl, null, 'text/html,application/xhtml+xml,*/*;q=0.8');
    if (!res.ok || !/html/i.test(res.headers.get('content-type') || 'html')) {
      if (pageUrl === start.href) throw new Error(`Trang trả về HTTP ${res.status}`);
      return [];
    }
    const html = await res.text();
    const finalUrl = res.url || pageUrl;
    stats.pages++;
    progress('pages', finalUrl);

    const ex = extractFromHtml(html);
    let base = finalUrl;
    if (ex.base) try { base = new URL(ex.base, finalUrl).href; } catch { /* base lỗi */ }

    for (const img of ex.images) {
      // URL quét từ văn bản thô phải có đuôi ảnh, tránh bắt nhầm
      if (img.source === 'text' && !isLikelyImageUrl(img.url)) continue;
      addCand(img.url, base, finalUrl, img.source, { iconHint: img.iconHint, group: img.group });
    }
    for (const s of ex.svgs) {
      const hash = createHash('sha1').update(s.svg).digest('hex');
      if (!svgs.has(hash)) svgs.set(hash, { ...s, pages: new Set() });
      svgs.get(hash).pages.add(finalUrl);
    }
    const resolve = (u) => { try { const x = new URL(u, base); x.hash = ''; return x.href; } catch { return null; } };
    await Promise.all([
      ...ex.stylesheets.map(resolve).filter(Boolean).map((u) => loadCss(u, finalUrl)),
      ...ex.manifests.map(resolve).filter(Boolean).map((u) => loadManifest(u, finalUrl)),
    ]);

    const next = [];
    for (const l of ex.links) {
      if (/^(mailto|tel|javascript|data):/i.test(l)) continue;
      const u = resolve(l);
      if (!u || !/^https?:/.test(u) || PAGE_SKIP_EXT.test(u)) continue;
      if (sameHost && bareHost(new URL(u).host) !== bareHost(start.host)) continue;
      next.push(u);
    }
    return next;
  }

  // 1) Duyệt trang theo từng tầng (BFS)
  progress('pages', start.href);
  let level = [start.href];
  seenPages.add(start.href);
  for (let d = 0; d <= depth && level.length && !signal.aborted; d++) {
    const found = [];
    await pool(level, 4, async (p) => {
      try {
        found.push(...await processPage(p));
      } catch (e) {
        // Trang con lỗi/timeout thì bỏ qua, chỉ trang đầu lỗi mới dừng cả lượt crawl
        if (p === start.href && !signal.aborted) {
          throw new Error(`Không tải được trang: ${e.name === 'TimeoutError' ? 'quá thời gian chờ' : e.message}`);
        }
      }
    });
    level = [];
    for (const u of found) {
      if (seenPages.size >= maxPages) break;
      if (!seenPages.has(u)) { seenPages.add(u); level.push(u); }
    }
  }
  if (signal.aborted) throw new Error('Đã huỷ');

  addCand('/favicon.ico', start.href, start.href, 'favicon.ico', { iconHint: true, derived: true });

  // 2) Gom biến thể kích thước + thêm ứng viên "ảnh gốc" suy ra từ tên file
  for (const c of [...cands.values()]) {
    if (c.url.startsWith('data:')) continue;
    // URL nằm ở nhiều thẻ (vd: ảnh placeholder lazy-load dùng chung) không được làm cầu nối,
    // nếu không mọi ảnh trên trang sẽ bị gộp chung một nhóm
    if (c.groups.size === 1) uf.union(c.url, [...c.groups][0]);
    const v = variantInfo(c.url);
    uf.union(c.url, 'k:' + v.key);
    if (v.original && !cands.has(v.original)) {
      addCand(v.original, c.url, [...c.pages][0], 'original', { derived: true, iconHint: c.iconHint });
      uf.union(v.original, 'k:' + v.key);
    }
  }

  // 3) Tải ảnh, đọc kích thước, gộp file trùng nội dung
  const assets = [], byHash = new Map();
  const list = [...cands.values()];
  stats.total = list.length + svgs.size;
  progress('download');

  function register(buf, info, meta) {
    const hash = createHash('sha1').update(buf).digest('hex');
    const dup = byHash.get(hash);
    if (dup) {
      dup.aliases.push(meta.url);
      for (const s of meta.sources) dup.sources.add(s);
      for (const p of meta.pages) dup.pages.add(p);
      dup.iconHint ||= meta.iconHint;
      uf.union(meta.url, dup.url);
      return null;
    }
    const ext = info.format === 'jpg' ? 'jpg' : info.format;
    const asset = {
      id: hash.slice(0, 16), url: meta.url, aliases: [], file: path.join(dir, `${hash.slice(0, 16)}.${ext}`),
      format: info.format, width: info.width, height: info.height, bytes: buf.length, iconHint: meta.iconHint,
      sources: new Set(meta.sources), pages: new Set(meta.pages), name: meta.name, ext,
    };
    byHash.set(hash, asset);
    assets.push(asset);
    return asset;
  }

  await pool(list, concurrency, async (c) => {
    if (signal.aborted) return;
    try {
      let buf;
      if (c.url.startsWith('data:')) {
        const m = c.url.match(/^data:([^,;]+)((?:;[^,;]+)*?)(;base64)?,(.*)$/is);
        if (!m) throw new Error('data URI lỗi');
        buf = m[3] ? Buffer.from(m[4], 'base64') : Buffer.from(decodeURIComponent(m[4]), 'utf8');
      } else {
        const res = await request(c.url, [...c.pages][0] || start.href, 'image/avif,image/webp,image/*,*/*;q=0.8', 90000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (Number(res.headers.get('content-length') || 0) > MAX_BYTES) throw new Error('File quá lớn');
        buf = Buffer.from(await res.arrayBuffer());
      }
      const info = imageInfo(buf);
      if (!info) throw new Error('Không phải ảnh');
      const asset = register(buf, info, { ...c, name: fileBaseName(c.url, info.format === 'svg' ? 'icon' : 'image') });
      if (asset) await fs.writeFile(asset.file, buf);
      stats.downloaded++;
    } catch {
      // Ứng viên tự suy ra (ảnh gốc, favicon mặc định) lỗi là bình thường, không tính là thất bại
      if (!c.derived) stats.failed++;
    }
    progress('download');
  });

  for (const [hash, s] of svgs) {
    const buf = Buffer.from(s.svg, 'utf8');
    const info = imageInfo(buf) || { format: 'svg', width: 0, height: 0 };
    const url = `inline-svg:${hash.slice(0, 12)}`;
    const name = (s.name || 'inline-svg').replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 60);
    const asset = register(buf, info, { url, sources: ['inline svg'], pages: s.pages, iconHint: true, name });
    if (asset) await fs.writeFile(asset.file, buf);
    stats.downloaded++;
  }
  if (signal.aborted) throw new Error('Đã huỷ');

  const groupIds = new Map();
  return assets.map((a) => {
    const root = uf.find(a.url);
    if (!groupIds.has(root)) groupIds.set(root, groupIds.size + 1);
    return {
      id: a.id, url: a.url, aliases: a.aliases, group: groupIds.get(root), format: a.format, ext: a.ext,
      width: a.width, height: a.height, bytes: a.bytes, iconHint: a.iconHint,
      sources: [...a.sources], pages: a.pages.size, name: a.name, file: a.file,
    };
  });
}
