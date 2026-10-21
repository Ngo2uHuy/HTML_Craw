#!/usr/bin/env node
// Tải giao diện (HTML + CSS + JS + ảnh + font) của một website về máy để xem/học offline.
// CLI:    node clone.mjs <url> [outDir] [--depth=0] [--max-pages=20] [--concurrency=8]
// Module: import { clone } from './clone.mjs'
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { decodeEntities as dec } from './lib/extract.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const EXT = {
  'text/css': '.css', 'application/javascript': '.js', 'text/javascript': '.js', 'application/json': '.json',
  'application/manifest+json': '.json', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/avif': '.avif', 'image/svg+xml': '.svg', 'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico', 'font/woff2': '.woff2', 'font/woff': '.woff', 'font/ttf': '.ttf',
  'font/otf': '.otf', 'application/font-woff': '.woff', 'application/font-woff2': '.woff2', 'video/mp4': '.mp4',
};
const ASSET_ATTRS = new Set(['src', 'data-src', 'data-lazy-src', 'data-original', 'data-bg', 'data-background', 'data-image', 'poster']);
const SRCSET_ATTRS = new Set(['srcset', 'data-srcset', 'data-lazy-srcset', 'imagesrcset']);
const LINK_ASSET_REL = /\b(stylesheet|icon|preload|prefetch|modulepreload|manifest|apple-touch-icon|mask-icon)\b/i;
const NON_PAGE_EXT = /\.(css|js|mjs|json|xml|txt|pdf|zip|rar|png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|mp3|woff2?|ttf|otf|eot)$/i;
// script/style được bắt nguyên khối để không sửa nhầm chuỗi "<img ...>" nằm trong JS.
const TAG_RE = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>|<!--[\s\S]*?-->|<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
const ATTR_RE = /([^\s=>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
const CSS_URL_RE = /url\(\s*(['"]?)(.*?)\1\s*\)|@import\s+(['"])(.*?)\3/gi;

// ---------- helpers ----------
const hash = s => crypto.createHash('md5').update(s).digest('hex').slice(0, 8);
const esc = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const safe = s => {
  try { s = decodeURIComponent(s); } catch {}
  return s.replace(/[<>:"\\|?*\x00-\x1f]/g, '_') || '_';
};
const segments = u => u.pathname.split('/').filter(s => s && s !== '.' && s !== '..').map(safe);
function withQuery(name, u) {
  if (!u.search) return name;
  const ext = path.extname(name);
  return `${name.slice(0, name.length - ext.length)}_${hash(u.search)}${ext}`;
}
function assetRel(u, type) {
  const segs = segments(u);
  let name = segs.pop() || 'index';
  if (!path.extname(name) && EXT[type]) name += EXT[type];
  return ['assets', u.hostname, ...segs, withQuery(name, u)].join('/');
}
function pageRel(u) {
  const segs = segments(u);
  let name = 'index.html';
  if (segs.length && /\.(html?|php|aspx?|jsp)$/i.test(segs.at(-1))) name = segs.pop().replace(/\.\w+$/, '.html');
  return [...segs, withQuery(name, u)].join('/');
}
const ref = (fromRel, toRel) =>
  path.posix.relative(path.posix.dirname(fromRel), toRel).split('/').map(encodeURIComponent).join('/');

async function replaceAsync(str, re, fn) {
  const tasks = [];
  str.replace(re, (...a) => { tasks.push(fn(...a)); return ''; });
  const results = await Promise.all(tasks);
  let i = 0;
  return str.replace(re, () => results[i++]);
}

function resolve(raw, base) {
  raw = raw.trim();
  if (!raw || /^(data:|blob:|#|mailto:|tel:|javascript:|about:)/i.test(raw)) return null;
  try {
    const u = new URL(raw, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    return u;
  } catch { return null; }
}

export const normalizeUrl = raw => new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);

// ---------- robots.txt ----------
// Chỉ lấy nhóm "User-agent: *"; hỗ trợ wildcard * và neo $, luật dài nhất thắng, Allow thắng khi bằng nhau.
function parseRobots(txt) {
  const rules = [];
  let agents = [], inRules = false, mine = false;
  for (const raw of txt.split(/\r?\n/)) {
    const m = raw.replace(/#.*/, '').trim().match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') {
      if (inRules) { agents = []; inRules = false; }
      agents.push(val.toLowerCase());
      mine = agents.includes('*');
    } else if (key === 'allow' || key === 'disallow') {
      inRules = true;
      if (mine && val) {
        const re = new RegExp('^' + val.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
        rules.push({ allow: key === 'allow', len: val.length, re });
      }
    }
  }
  return rules;
}

function robotsAllowed(rules, u) {
  const p = u.pathname + u.search;
  let best = null;
  for (const r of rules) if (r.re.test(p) && (!best || r.len > best.len || (r.len === best.len && r.allow))) best = r;
  return !best || best.allow;
}

async function loadRobots(start) {
  try {
    const res = await fetch(new URL('/robots.txt', start), { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
    return res.ok ? parseRobots(await res.text()) : [];
  } catch { return []; }
}

// ---------- chọn trang điển hình ----------
const SURVEY_LIMIT = 40;
const SKIP_PAGE_RE = /\/(wp-admin|wp-login|login|logout|dang-nhap|dang-ky|register|signup|account|tai-khoan|cart|gio-hang|checkout|thanh-toan|feed)\b/i;
const KEY_PAGE_RE = /(gioi-thieu|about|lien-he|contact|san-pham|product|dich-vu|service|bang-gia|pricing|blog|tin-tuc|news|du-an|project|faq|hoi-dap|tuyen-dung|career|menu|cua-hang|store)/i;

// Gom các URL cùng "khuôn": segment có số hoặc slug dài (bài viết, sản phẩm) coi như biến.
function urlPattern(u) {
  const segs = u.pathname.split('/').filter(Boolean);
  if (!segs.length) return '/';
  return '/' + segs.map(s => (/\d/.test(s) || s.split('-').length > 3 || s.length > 30 ? ':x' : s.toLowerCase())).join('/');
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// ---------- clone ----------
// Khi lấy nhiều trang có giới hạn: khảo sát trước rồi chọn mẫu (xem surveyTypical).
// null cho depth/maxPages nghĩa là không giới hạn.
export async function clone({ url, out, depth = 0, maxPages = 20, concurrency = 8, signal, onEvent = () => {} }) {
  depth = depth === null ? Infinity : depth;
  maxPages = maxPages === null ? Infinity : maxPages;
  const START = normalizeUrl(url);
  const OUT = path.resolve(out || path.join('output', START.hostname));
  const hosts = new Set();
  const assets = new Map(); // url -> Promise<local rel | null>
  const pages = new Map();  // url -> { url, rel, depth }
  const queue = [];
  const htmlCache = new Map(); // HTML đã tải lúc khảo sát, dùng lại khi clone
  let fixedPages = false;      // đã chọn xong danh sách trang -> không thêm trang mới khi gặp link
  const stats = { pages: 0, assets: 0, failed: 0 };
  const emit = (type, data) => onEvent({ type, ...data, stats: { ...stats } });

  let active = 0;
  const waiting = [];
  async function limited(fn) {
    if (active < concurrency) active++;
    else await new Promise(r => waiting.push(r));
    try { return await fn(); } finally { const next = waiting.shift(); next ? next() : active--; }
  }

  function fetchBody(u, tries = 3) {
    return limited(async () => {
      for (let i = 1; ; i++) {
        signal?.throwIfAborted();
        try {
          const timeout = AbortSignal.timeout(30000);
          const res = await fetch(u, {
            headers: { 'user-agent': UA, 'accept-language': 'vi,en;q=0.8' },
            redirect: 'follow',
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return {
            url: new URL(res.url),
            type: (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(),
            buf: Buffer.from(await res.arrayBuffer()),
          };
        } catch (e) {
          if (i >= tries || signal?.aborted || /HTTP 4\d\d/.test(e.message)) throw e;
          await new Promise(r => setTimeout(r, 500 * i));
        }
      }
    });
  }

  async function save(rel, data) {
    const file = path.join(OUT, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  }

  function asset(u) {
    if (!assets.has(u.href)) assets.set(u.href, (async () => {
      try {
        const { url, type, buf } = await fetchBody(u);
        const rel = assetRel(u, type);
        const data = type === 'text/css' || rel.endsWith('.css') ? await rewriteCss(buf.toString('utf8'), url, rel) : buf;
        await save(rel, data);
        stats.assets++;
        emit('asset', { url: u.href });
        return rel;
      } catch (e) {
        stats.failed++;
        emit('error', { url: u.href, message: e.message });
        return null;
      }
    })());
    return assets.get(u.href);
  }

  // Trả về null nếu không cần sửa; tải lỗi thì giữ URL tuyệt đối để vẫn chạy được khi online.
  async function assetRef(raw, base, fromRel) {
    const u = resolve(raw, base);
    if (!u) return null;
    const rel = await asset(u);
    return rel ? ref(fromRel, rel) : u.href;
  }

  function rewriteCss(css, base, fromRel) {
    return replaceAsync(css, CSS_URL_RE, async (m, _q, u1, _q2, u2) => {
      const r = await assetRef(u1 ?? u2, base, fromRel);
      if (r == null) return m;
      return u1 != null ? `url("${r}")` : `@import "${r}"`;
    });
  }

  async function rewriteSrcset(val, base, fromRel) {
    const parts = await Promise.all(val.split(/,\s+/).map(async c => {
      const [url, ...desc] = c.trim().split(/\s+/);
      return [(await assetRef(url, base, fromRel)) ?? url, ...desc].join(' ');
    }));
    return parts.join(', ');
  }

  function pageRef(raw, ctx) {
    const u = resolve(raw, ctx.base);
    if (!u) return null;
    if (!hosts.has(u.hostname) || NON_PAGE_EXT.test(u.pathname)) return u.href;
    let p = pages.get(u.href);
    if (!p && !fixedPages && ctx.depth < depth && pages.size < maxPages && robotsAllowed(robots, u)) {
      p = { url: u, rel: pageRel(u), depth: ctx.depth + 1 };
      pages.set(u.href, p);
      queue.push(p);
    }
    if (!p) return u.href;
    const i = raw.indexOf('#');
    return ref(ctx.rel, p.rel) + (i >= 0 ? raw.slice(i) : '');
  }

  async function rewriteTag(tag, attrs, ctx) {
    const t = tag.toLowerCase();
    if (t === 'base') return '';
    const relAttr = (attrs.match(/\brel\s*=\s*["']?([^"'>]+)/i) || [])[1] || '';
    const out = await replaceAsync(attrs, ATTR_RE, async (m, name, dq, sq, uq) => {
      const n = name.toLowerCase();
      const v = dq ?? sq ?? uq;
      if (v == null) return m;
      // CSS bị sửa url() nên hash SRI không còn khớp.
      if (n === 'integrity') return '';
      let nv = null;
      if (SRCSET_ATTRS.has(n)) nv = await rewriteSrcset(dec(v), ctx.base, ctx.rel);
      else if (n === 'style') nv = await rewriteCss(dec(v), ctx.base, ctx.rel);
      else if (n === 'href' && (t === 'a' || t === 'area')) nv = pageRef(dec(v), ctx);
      else if ((n === 'href' && t === 'link' && LINK_ASSET_REL.test(relAttr)) ||
               (ASSET_ATTRS.has(n) && t !== 'iframe' && t !== 'frame')) nv = await assetRef(dec(v), ctx.base, ctx.rel);
      return nv == null ? m : `${name}="${esc(nv)}"`;
    });
    return `<${tag}${out}>`;
  }

  async function clonePage(p) {
    emit('page', { url: p.url.href });
    const { url, type, buf } = htmlCache.get(p.url.href) || await fetchBody(p.url);
    pages.set(url.href, p);
    if (p.depth === 0) {
      const bare = url.hostname.replace(/^www\./, '');
      hosts.add(bare).add(`www.${bare}`);
    }
    if (type && type !== 'text/html' && !type.includes('xhtml')) return save(p.rel, buf);

    let html = buf.toString('utf8');
    let base = url;
    const b = html.match(/<base\b[^>]*\bhref\s*=\s*["']?([^"'\s>]+)/i);
    if (b) try { base = new URL(dec(b[1]), url); } catch {}
    const ctx = { base, rel: p.rel, depth: p.depth };

    html = await replaceAsync(html, TAG_RE, async (m, block, blockAttrs, body, tag, attrs) => {
      if (block) {
        const open = await rewriteTag(block, blockAttrs, ctx);
        const inner = block.toLowerCase() === 'style' ? await rewriteCss(body, ctx.base, ctx.rel) : body;
        return `${open}${inner}</${block}>`;
      }
      return tag ? rewriteTag(tag, attrs, ctx) : m;
    });
    await save(p.rel, html);
    stats.pages++;
  }

  // Khảo sát HTML (chưa tải asset) của tối đa SURVEY_LIMIT trang, gom theo khuôn URL + class riêng của trang
  // (bỏ class "khung" có ở gần hết các trang như header/footer), mỗi nhóm giữ 1 trang điểm cao nhất:
  // nằm trong menu chính, là trang quen thuộc (giới thiệu, sản phẩm, blog...), nhiều ảnh/section; nhóm đông được cộng điểm.
  async function surveyTypical(root) {
    const addHosts = h => { const bare = h.replace(/^www\./, ''); hosts.add(bare).add(`www.${bare}`); };
    addHosts(START.hostname);
    const seen = new Map([[START.href, root]]);
    const infos = [];
    let frontier = [{ url: START, depth: 0, nav: true }];
    while (frontier.length && infos.length < SURVEY_LIMIT && !signal?.aborted) {
      const batch = frontier.splice(0, SURVEY_LIMIT - infos.length);
      const fetched = await Promise.all(batch.map(async c => {
        try {
          const r = await fetchBody(c.url);
          if (r.type && r.type !== 'text/html' && !r.type.includes('xhtml')) return null;
          htmlCache.set(c.url.href, r);
          if (c.depth === 0) addHosts(r.url.hostname);
          return { ...c, final: r.url, html: r.buf.toString('utf8') };
        } catch { return null; }
      }));
      const next = [];
      for (const r of fetched.filter(Boolean)) {
        const hrefs = s => [...s.matchAll(/<a\b[^>]*?\shref\s*=\s*["']?([^"'\s>]+)/gi)].map(m => resolve(dec(m[1]), r.final)).filter(Boolean);
        const navLinks = new Set(hrefs((r.html.match(/<(nav|header)\b[\s\S]*?<\/\1>/gi) || []).join(' ')).map(u => u.href));
        const classes = new Set();
        for (const m of r.html.matchAll(/\sclass\s*=\s*["']([^"']+)["']/gi)) for (const c of m[1].split(/\s+/)) if (c && !/\d/.test(c)) classes.add(c);
        infos.push({
          ...r, classes, pattern: urlPattern(r.url),
          imgs: (r.html.match(/<img\b/gi) || []).length, blocks: (r.html.match(/<(section|article)\b/gi) || []).length,
        });
        if (r.depth >= depth) continue;
        for (const u of hrefs(r.html)) {
          if (!hosts.has(u.hostname) || u.search || NON_PAGE_EXT.test(u.pathname) || SKIP_PAGE_RE.test(u.pathname) || !robotsAllowed(robots, u)) continue;
          const old = seen.get(u.href);
          if (old) { if (navLinks.has(u.href)) old.nav = true; continue; }
          const c = { url: u, depth: r.depth + 1, nav: navLinks.has(u.href) };
          seen.set(u.href, c);
          next.push(c);
        }
      }
      frontier.push(...next.sort((a, b) => b.nav - a.nav));
    }
    emit('page', { url: `Khảo sát ${infos.length} trang để chọn ${maxPages} trang điển hình` });

    const count = new Map();
    for (const i of infos) for (const c of i.classes) count.set(c, (count.get(c) || 0) + 1);
    const chrome = new Set([...count].filter(([, n]) => n >= infos.length * 0.8).map(([c]) => c));
    const clusters = [];
    for (const i of infos) {
      if (i.depth === 0) continue;
      i.sig = new Set([...i.classes].filter(c => !chrome.has(c)));
      i.score = (seen.get(i.url.href)?.nav ? 3 : 0) + (KEY_PAGE_RE.test(i.url.pathname) ? 2 : 0)
        + Math.min(i.imgs, 30) / 10 + Math.min(i.blocks, 10) / 5 + (i.depth === 1 ? 0.5 : 0);
      const cl = clusters.find(c => c.pattern === i.pattern) || clusters.find(c => jaccard(c.sig, i.sig) >= 0.6);
      if (cl) cl.members.push(i);
      else clusters.push({ pattern: i.pattern, sig: i.sig, members: [i] });
    }
    const picks = clusters
      .map(c => {
        const best = c.members.reduce((a, b) => (b.score > a.score ? b : a));
        return { best, score: best.score + Math.log2(c.members.length) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, maxPages - 1)
      .map(x => x.best);
    // Site ít kiểu trang hơn số trang cần lấy -> bù bằng các trang điểm cao còn lại.
    const rest = infos.filter(i => i.depth > 0 && !picks.includes(i)).sort((a, b) => b.score - a.score);
    picks.push(...rest.slice(0, maxPages - 1 - picks.length));
    for (const best of picks) {
      const p = { url: best.url, rel: pageRel(best.url), depth: 1 };
      pages.set(best.url.href, p);
      queue.push(p);
    }
    fixedPages = true;
  }

  const robots = await loadRobots(START);
  const root = { url: START, rel: pageRel(START), depth: 0 };
  pages.set(START.href, root);
  queue.push(root);
  if (Number.isFinite(maxPages) && maxPages > 1 && depth > 0) await surveyTypical(root);
  while (queue.length && !signal?.aborted) {
    const p = queue.shift();
    try { await clonePage(p); } catch (e) {
      if (signal?.aborted) break;
      stats.failed++;
      emit('error', { url: p.url.href, message: e.message });
    }
  }
  return { ...stats, out: OUT, entry: root.rel, aborted: !!signal?.aborted };
}

// ---------- CLI ----------
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const opts = Object.fromEntries(argv.filter(a => a.startsWith('--')).map(a => {
    const [k, v = 'true'] = a.slice(2).split('=');
    return [k, v];
  }));
  const [url, out] = argv.filter(a => !a.startsWith('--'));
  if (!url) {
    console.error('Usage: node clone.mjs <url> [outDir] [--depth=0] [--max-pages=20] [--concurrency=8]');
    process.exit(1);
  }
  const r = await clone({
    url, out,
    depth: Number(opts.depth ?? 0),
    maxPages: Number(opts['max-pages'] ?? 20),
    concurrency: Number(opts.concurrency ?? 8),
    onEvent: e => {
      if (e.type === 'page') console.log(`> ${e.url}`);
      else if (e.type === 'error') console.warn(`  ! ${e.url} (${e.message})`);
    },
  });
  console.log(`\nDone: ${r.pages} page(s), ${r.assets} asset(s), ${r.failed} failed -> ${r.out}`);
}
