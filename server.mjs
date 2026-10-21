#!/usr/bin/env node
// Web UI cho clone.mjs: dán link -> chọn mức clone -> xem tiến độ -> xem/tải ZIP.
// Usage: node server.mjs   (PORT=3000 mặc định, chỉ lắng nghe 127.0.0.1)
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readdir, stat, readFile, writeFile, rm, rename, mkdir, copyFile } from 'node:fs/promises';
import { pipeline } from 'node:stream';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { clone, normalizeUrl } from './clone.mjs';
import { figmaToHtml, parseFigmaUrl, figmaSiteName } from './figma.mjs';
import { figmaToHtmlAI, listModels, resolveAiKey, PROVIDERS } from './figma-ai.mjs';
import { handleImagesApi, initImagesApi } from './lib/images-api.js';
import { buildZip } from './lib/zip.js';
import { injectGuard } from './lib/view-guard.js';

const PORT = Number(process.env.PORT || 3000);
// Bản clone chạy JS của site lạ -> phục vụ ở origin khác để không đọc được token/gọi được API của UI.
const VIEW_PORT = PORT + 1;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.join(ROOT, 'output');
const PUBLIC = path.join(ROOT, 'public');
const DOWNLOADS = path.join(ROOT, 'downloads');
const CATALOG = path.join(ROOT, 'catalog.json');
// API key (FIGMA_TOKEN, GEMINI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY) có thể đặt trong .env
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}
// Giới hạn cho các chế độ chọn mẫu; null nghĩa là không giới hạn ở chế độ cả website.
const MAX_PAGES_PER_SITE = 10;
const TMP = path.join(ROOT, '.crawcode-tmp');
const LEVELS = {
  page: { depth: 0, maxPages: 1 },
  section: { depth: 1, maxPages: MAX_PAGES_PER_SITE },
  site: { depth: null, maxPages: null },
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
};
// Chặn "." và ".." để /..%2f.env hay /download/..zip không thoát ra ngoài output/.
const SITE_RE = /^(?!\.\.?$)[\w.-]+$/;
// node publish.mjs --portfolio: từ Internet chỉ thấy trang portfolio và bản clone (chỉ xem), không thấy công cụ.
const PORTFOLIO = process.env.PUBLISH_MODE === 'portfolio';
const PORTFOLIO_PATHS = new Set(['/', '/portfolio.html', '/portfolio-avatar.png', '/api/config', '/api/portfolio']);
const clamp = (v, min, max, def) => (Number.isFinite(+v) ? Math.min(max, Math.max(min, Math.round(+v))) : def);

// ---------- jobs ----------
const jobs = new Map();
const deletingSites = new Set();

function broadcast(job, msg) {
  if (msg.type !== 'stats') {
    job.log.push(msg);
    if (job.log.length > 300) job.log.shift();
  }
  const line = `data: ${JSON.stringify(msg)}\n\n`;
  for (const c of job.clients) c.write(line);
}

function summary(job) {
  const { id, url, site, status, stats, entry, options } = job;
  return { id, url, site, status, stats, entry, options };
}

// run(signal, onEvent) phải trả về { pages, assets, failed, entry, aborted }.
// Trả về null nếu site đang có job chạy; job.done resolve khi job kết thúc (kể cả lỗi).
function createJob({ url, site, options }, run) {
  if (deletingSites.has(site)) return null;
  if ([...jobs.values()].some(j => j.site === site && j.status === 'running')) return null;
  const job = {
    id: crypto.randomUUID(), url, site, status: 'running', options,
    stats: { pages: 0, assets: 0, failed: 0 }, entry: null, log: [], clients: new Set(), ctrl: new AbortController(),
  };
  jobs.set(job.id, job);

  job.done = run(job.ctrl.signal, e => {
    job.stats = e.stats;
    if (e.type === 'asset' || e.type === 'stats') broadcast(job, { type: 'stats', stats: e.stats });
    else broadcast(job, { type: e.type, url: e.url, message: e.message, stats: e.stats });
  }).then(r => {
    job.entry = r.entry;
    job.status = r.aborted ? 'cancelled' : 'done';
    job.stats = { pages: r.pages, assets: r.assets, failed: r.failed };
  }).catch(e => {
    job.status = job.ctrl.signal.aborted ? 'cancelled' : 'error';
    if (job.status === 'error') broadcast(job, { type: 'error', url: job.url, message: e.message });
  }).finally(() => {
    broadcast(job, { type: 'end', job: summary(job) });
    for (const c of job.clients) c.end();
    job.clients.clear();
  });
  return job;
}

function sendJob(res, job, site) {
  if (!job) return json(res, 409, { error: `Đang có job xử lý ${site}` });
  json(res, 200, summary(job));
}

const runJob = (res, spec, run) => sendJob(res, createJob(spec, run), spec.site);

// Clone vào thư mục tạm rồi mới thay bản cũ: lỗi/dừng giữa chừng thì giữ nguyên bản cũ,
// và bản mới không lẫn trang thừa của lần clone trước. Ghi kèm .crawcode.json cho thư viện.
function cloneJob(url, options, extra = {}) {
  const site = new URL(url).hostname;
  const job = createJob({ url, site, options }, async (signal, onEvent) => {
    const tmp = path.join(TMP, site);
    const dest = path.join(OUTPUT, site);
    const bak = path.join(TMP, `${site}.old`);
    await rm(tmp, { recursive: true, force: true });
    try {
      const r = await clone({ url, out: tmp, ...options, signal, onEvent });
      if (r.aborted) return r;
      if (!r.pages) throw new Error('Không tải được trang nào');
      const meta = { url, entry: r.entry, pages: r.pages, assets: r.assets, failed: r.failed, maxPages: options.maxPages, clonedAt: new Date().toISOString() };
      await writeFile(path.join(tmp, '.crawcode.json'), JSON.stringify(meta, null, 2));
      await rm(bak, { recursive: true, force: true });
      const hadOld = !!(await stat(dest).catch(() => null));
      try {
        if (hadOld) await rename(dest, bak);
      } catch (e) {
        if (!LOCKED.has(e.code)) throw e;
        await syncDir(tmp, dest);
        return r;
      }
      try {
        await mkdir(OUTPUT, { recursive: true });
        await rename(tmp, dest);
      } catch (e) {
        if (hadOld) await rename(bak, dest);
        if (!LOCKED.has(e.code)) throw e;
        await syncDir(tmp, dest);
      }
      await rm(bak, { recursive: true, force: true });
      return r;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
  if (job) Object.assign(job, extra);
  return job;
}

// Windows: thư mục có sẵn hay bị tiến trình khác (file watcher của editor, antivirus) giữ handle nên không rename được.
// Khi đó ghi đè từng file rồi xoá file của lần clone trước; thư mục rỗng còn sót không ảnh hưởng gì.
const LOCKED = new Set(['EPERM', 'EBUSY', 'EACCES']);
async function syncDir(src, dest) {
  const fresh = await walk(src);
  for (const f of fresh) {
    const to = path.join(dest, f.rel);
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(f.full, to);
  }
  const keep = new Set(fresh.map(f => f.rel));
  for (const f of await walk(dest)) if (!keep.has(f.rel)) await rm(f.full, { force: true });
}

async function startClone(req, res) {
  const body = JSON.parse(await readBody(req) || '{}');
  let start;
  try { start = normalizeUrl(String(body.url || '').trim()); } catch {}
  if (!start || !/^https?:$/.test(start.protocol) || !start.hostname) return json(res, 400, { error: 'URL không hợp lệ' });

  const preset = LEVELS[body.level];
  const options = {
    depth: preset ? preset.depth : clamp(body.depth, 0, 20, 1),
    maxPages: preset ? preset.maxPages : clamp(body.maxPages, 1, MAX_PAGES_PER_SITE, MAX_PAGES_PER_SITE),
    concurrency: clamp(body.concurrency, 1, 16, 6),
  };
  sendJob(res, cloneJob(start.href, options), start.hostname);
}

// ---------- thư viện (catalog.json) + clone hàng loạt ----------
const BATCH_CONCURRENCY = 3;
const batchQueue = []; // { url, site, options }
let batchActive = 0;

async function readCatalog() {
  return JSON.parse(await readFile(CATALOG, 'utf8'));
}

function pumpBatch() {
  while (batchActive < BATCH_CONCURRENCY && batchQueue.length) {
    const item = batchQueue.shift();
    const job = cloneJob(item.url, item.options, { batch: true });
    if (!job) continue;
    batchActive++;
    job.done.finally(() => { batchActive--; pumpBatch(); });
  }
}

async function siteMeta(site) {
  const dir = path.join(OUTPUT, site);
  const meta = await readFile(path.join(dir, '.crawcode.json'), 'utf8').then(JSON.parse).catch(() => null);
  if (meta) return meta;
  // Bản clone cũ (trước khi có .crawcode.json)
  return (await stat(path.join(dir, 'index.html')).catch(() => null)) ? { entry: 'index.html' } : null;
}

async function catalogStatus(res) {
  const items = await Promise.all((await readCatalog()).map(async it => {
    const site = normalizeUrl(it.url).hostname;
    const meta = await siteMeta(site);
    const job = [...jobs.values()].filter(j => j.site === site).at(-1);
    let status = meta ? 'done' : 'none';
    if (batchQueue.some(q => q.site === site)) status = 'queued';
    if (job?.status === 'running') status = 'running';
    else if (job?.status === 'error') status = 'error';
    const error = status === 'error' ? job?.log.findLast(l => l.type === 'error')?.message || 'Không tải được trang' : undefined;
    return { ...it, site, status, meta, stats: job?.status === 'running' ? job.stats : undefined, error };
  }));
  json(res, 200, { items, queued: batchQueue.length, active: batchActive });
}

async function portfolioSites(res) {
  const items = [];
  for (const it of await readCatalog()) {
    const site = normalizeUrl(it.url).hostname;
    const meta = await siteMeta(site);
    if (meta?.entry) items.push({ group: it.group, field: it.field, name: it.name, site, entry: meta.entry, pages: meta.pages });
  }
  json(res, 200, items);
}

async function startBatch(req, res) {
  const body = JSON.parse(await readBody(req) || '{}');
  const maxPages = clamp(body.maxPages, 1, MAX_PAGES_PER_SITE, MAX_PAGES_PER_SITE);
  const options = { depth: 5, maxPages, concurrency: 6 };
  const only = Array.isArray(body.urls) ? new Set(body.urls) : null;
  let queued = 0;
  for (const it of await readCatalog()) {
    if (only && !only.has(it.url)) continue;
    const site = normalizeUrl(it.url).hostname;
    if (batchQueue.some(q => q.site === site) || [...jobs.values()].some(j => j.site === site && j.status === 'running')) continue;
    if (!body.force && (await siteMeta(site))?.pages) continue;
    batchQueue.push({ url: it.url, site, options });
    queued++;
  }
  pumpBatch();
  json(res, 200, { queued, total: batchQueue.length + batchActive });
}

function cancelBatch(res) {
  const dropped = batchQueue.splice(0).length;
  for (const j of jobs.values()) if (j.batch && j.status === 'running') j.ctrl.abort();
  json(res, 200, { dropped });
}

async function startFigma(req, res) {
  const body = JSON.parse(await readBody(req) || '{}');
  let ref;
  try { ref = parseFigmaUrl(body.url || ''); } catch (e) { return json(res, 400, { error: e.message }); }
  const token = String(body.token || '').trim() || process.env.FIGMA_TOKEN;
  if (!token) return json(res, 400, { error: 'Cần Figma access token (nhập ở form hoặc đặt biến môi trường FIGMA_TOKEN)' });
  const url = String(body.url).trim();
  if (body.mode !== 'ai') {
    const site = figmaSiteName(ref);
    return runJob(res, { url, site, options: { source: 'figma' } }, (signal, onEvent) =>
      figmaToHtml({ url, token, out: path.join(OUTPUT, site), signal, onEvent }));
  }

  const provider = String(body.provider || '');
  if (!PROVIDERS[provider]) return json(res, 400, { error: 'Chọn nhà cung cấp AI' });
  const aiKey = resolveAiKey(provider, body.aiKey);
  if (!aiKey) return json(res, 400, { error: `Cần API key ${PROVIDERS[provider].label} (nhập ở form hoặc đặt ${PROVIDERS[provider].env})` });
  const model = String(body.model || '').trim() || PROVIDERS[provider].defaultModel;
  const site = `${figmaSiteName(ref)}-${provider}`;
  runJob(res, { url, site, options: { source: 'figma-ai', provider, model } }, (signal, onEvent) =>
    figmaToHtmlAI({
      url, token, out: path.join(OUTPUT, site), provider, model, aiKey,
      prompt: String(body.prompt || '').slice(0, 2000), signal, onEvent,
    }));
}

async function aiModels(req, res) {
  const body = JSON.parse(await readBody(req) || '{}');
  const p = PROVIDERS[body.provider];
  if (!p) return json(res, 400, { error: 'Provider không hỗ trợ' });
  const key = resolveAiKey(body.provider, body.key);
  const base = { default: p.defaultModel, env: p.env, hasEnvKey: !!process.env[p.env] };
  if (!key) return json(res, 200, { ...base, models: [] });
  try { json(res, 200, { ...base, models: await listModels(body.provider, key) }); } catch (e) { json(res, 200, { ...base, models: [], error: e.message }); }
}

function events(job, req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(`data: ${JSON.stringify({ type: 'init', job: summary(job), log: job.log })}\n\n`);
  if (job.status !== 'running') return res.end();
  job.clients.add(res);
  req.on('close', () => job.clients.delete(res));
}

// ---------- sites ----------
async function walk(dir, base = dir) {
  const out = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...await walk(full, base));
    else out.push({ full, rel: path.relative(base, full).split(path.sep).join('/') });
  }
  return out;
}

async function listSites(res) {
  let dirs = [];
  try { dirs = (await readdir(OUTPUT, { withFileTypes: true })).filter(d => d.isDirectory()); } catch {}
  const sites = await Promise.all(dirs.map(async d => {
    const files = await walk(path.join(OUTPUT, d.name));
    const sizes = await Promise.all(files.map(f => stat(f.full)));
    return {
      name: d.name,
      pages: files.filter(f => f.rel.endsWith('.html') && !f.rel.startsWith('assets/')).length,
      files: files.length,
      size: sizes.reduce((s, x) => s + x.size, 0),
      mtime: Math.max(0, ...sizes.map(x => x.mtimeMs)),
      running: [...jobs.values()].some(j => j.site === d.name && j.status === 'running'),
    };
  }));
  json(res, 200, sites.sort((a, b) => b.mtime - a.mtime));
}

async function deleteSite(site, res) {
  const target = path.resolve(OUTPUT, site);
  if (!SITE_RE.test(site) || path.dirname(target) !== path.resolve(OUTPUT)) {
    return json(res, 400, { error: 'Tên website không hợp lệ' });
  }
  if (deletingSites.has(site) || [...jobs.values()].some(j => j.site === site && j.status === 'running')) {
    return json(res, 409, { error: 'Website đang được xử lý. Hãy đợi hoàn tất rồi xóa.' });
  }
  deletingSites.add(site);
  try {
    await rm(target, { recursive: true });
    return json(res, 200, { deleted: site });
  } catch (e) {
    if (e.code === 'ENOENT') return json(res, 404, { error: 'Website không tồn tại' });
    throw e;
  } finally {
    deletingSites.delete(site);
  }
}

async function zipSite(site, res) {
  const files = await walk(path.join(OUTPUT, site));
  const entries = await Promise.all(files.map(async f => ({ name: `${site}/${f.rel}`, data: await readFile(f.full) })));
  const zip = buildZip(entries, { deflate: true });
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-length': zip.length,
    'content-disposition': `attachment; filename="${site}.zip"`,
  });
  res.end(zip);
}

// ---------- http ----------
const json = (res, code, data) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};

function readBody(req) {
  return new Promise((ok, fail) => {
    let s = '';
    req.on('data', c => {
      s += c;
      if (s.length > 1e5) { req.destroy(); fail(new Error('Request quá lớn')); }
    });
    req.on('end', () => ok(s));
    req.on('error', fail);
  });
}

async function sendFile(root, rel, res, guard) {
  let file = path.join(root, rel);
  if (file !== root && !file.startsWith(root + path.sep)) return json(res, 403, { error: 'Forbidden' });
  let st = await stat(file).catch(() => null);
  if (st?.isDirectory()) {
    file = path.join(file, 'index.html');
    st = await stat(file).catch(() => null);
  }
  if (!st) return json(res, 404, { error: 'Not found' });
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  if (guard && type.startsWith('text/html')) {
    const body = Buffer.from(injectGuard(await readFile(file, 'utf8')));
    res.writeHead(200, { 'content-type': type, 'content-length': body.length });
    return res.end(body);
  }
  res.writeHead(200, { 'content-type': type, 'content-length': st.size });
  // pipeline (không dùng .pipe) để đóng file khi client huỷ giữa chừng, tránh giữ handle làm khoá thư mục.
  pipeline(createReadStream(file), res, () => {});
}

// ---------- publish qua Cloudflare Tunnel ----------
// Request đi qua Cloudflare luôn có cf-ray; truy cập trực tiếp trên máy thì không.
const isExternal = req => !!(req.headers['cf-ray'] || req.headers['cf-connecting-ip']);
const sha = s => crypto.createHash('sha256').update(String(s)).digest();

// Từ ngoài vào:
// - Có AUTH_USER/AUTH_PASS trong .env -> đăng nhập (Basic auth), dùng đủ chức năng.
// - Không có -> public chỉ xem: chặn mọi thao tác crawl/AI vì chúng có thể bị lợi dụng để quét mạng nội bộ,
//   tiêu API key AI của server và làm đầy ổ đĩa; chặn tải ZIP bản clone website bên thứ ba.
// Trên máy: bản clone (cổng VIEW_PORT, chạy JS của site lạ) vẫn gửi được request "simple" (không preflight) sang UI,
// và trang lạ có thể dùng DNS rebinding trỏ tên miền của nó về 127.0.0.1 -> chặn cả hai cho API/download.
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
function isTrustedLocal(req, p) {
  if (!/^\/(api|download)\//.test(p)) return true;
  const site = req.headers['sec-fetch-site'];
  return LOCAL_HOST_RE.test(req.headers.host || '') && (!site || site === 'same-origin' || site === 'none');
}

function checkAuth(req, res, p) {
  if (!isExternal(req)) {
    if (isTrustedLocal(req, p)) return true;
    json(res, 403, { error: 'Forbidden' });
    return false;
  }
  if (PORTFOLIO) {
    if (req.method === 'GET' && PORTFOLIO_PATHS.has(p)) return true;
    json(res, 404, { error: 'Not found' });
    return false;
  }
  const { AUTH_USER, AUTH_PASS } = process.env;
  if (!AUTH_USER || !AUTH_PASS) {
    const zip = p.match(/^\/download\/([^/]+)\.zip$/);
    const readOnly = req.method === 'GET' && !/^\/api\/(scan|file)\b/.test(p) && (!zip || zip[1].startsWith('figma-'));
    if (!readOnly) json(res, 403, { error: 'Bản public chỉ để xem. Chạy clone/Figma/AI trên máy đang chạy CrawCode.' });
    return readOnly;
  }
  if (validCreds(req)) return true;
  askLogin(res);
  return false;
}

function validCreds(req) {
  const { AUTH_USER, AUTH_PASS } = process.env;
  const [user, ...rest] = Buffer.from((req.headers.authorization || '').replace(/^Basic\s+/i, ''), 'base64').toString().split(':');
  return !!(crypto.timingSafeEqual(sha(user), sha(AUTH_USER)) & crypto.timingSafeEqual(sha(rest.join(':')), sha(AUTH_PASS)));
}

function askLogin(res) {
  res.writeHead(401, { 'www-authenticate': 'Basic realm="CrawCode", charset="UTF-8"', 'content-type': 'text/plain; charset=utf-8' });
  res.end('Cần đăng nhập');
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(u.pathname);
    if (!checkAuth(req, res, p)) return;
    let m;
    if (req.method === 'POST' && p === '/api/clone') return await startClone(req, res);
    if (req.method === 'POST' && p === '/api/figma') return await startFigma(req, res);
    if (p === '/api/config') return json(res, 200, { viewPort: VIEW_PORT, viewBase: process.env.VIEW_URL || null });
    if (req.method === 'POST' && p === '/api/ai/models') return await aiModels(req, res);
    if (p === '/api/catalog') return await catalogStatus(res);
    if (p === '/api/portfolio') return await portfolioSites(res);
    if (req.method === 'POST' && p === '/api/batch') return await startBatch(req, res);
    if (req.method === 'POST' && p === '/api/batch/cancel') return cancelBatch(res);
    if (await handleImagesApi(req, res, u, { downloadsDir: DOWNLOADS })) return;
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)(\/events|\/cancel)?$/))) {
      const job = jobs.get(m[1]);
      if (!job) return json(res, 404, { error: 'Job không tồn tại' });
      if (m[2] === '/events') return events(job, req, res);
      if (m[2] === '/cancel' && req.method === 'POST') { job.ctrl.abort(); return json(res, 200, summary(job)); }
      return json(res, 200, summary(job));
    }
    if (req.method === 'DELETE' && (m = p.match(/^\/api\/sites\/(.+)$/))) return await deleteSite(m[1], res);
    if (p === '/api/sites') return await listSites(res);
    if ((m = p.match(/^\/download\/([^/]+)\.zip$/)) && SITE_RE.test(m[1])) return await zipSite(m[1], res);
    const home = PORTFOLIO && isExternal(req) ? 'portfolio.html' : 'index.html';
    return await sendFile(PUBLIC, p === '/' ? home : p, res);
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
});

const viewer = http.createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const m = p.match(/^\/([^/]+)(\/.*)?$/);
    if (!m || !SITE_RE.test(m[1])) return json(res, 404, { error: 'Not found' });
    // Bản clone website bên thứ ba không phát tán công khai: từ Internet chỉ chủ máy (đăng nhập) xem được;
    // trang sinh từ Figma thì xem tự do.
    let guard = false;
    if (isExternal(req)) {
      res.setHeader('x-robots-tag', 'noindex, nofollow');
      if (PORTFOLIO) {
        // Không lộ file nội bộ như .crawcode.json
        if (/\/\./.test(m[2] || '')) return json(res, 404, { error: 'Not found' });
        guard = true;
      } else if (!m[1].startsWith('figma-')) {
        if (!process.env.AUTH_USER || !process.env.AUTH_PASS) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          return res.end('Bản clone website bên thứ ba chỉ xem được trên máy chạy CrawCode, hoặc từ xa khi bật đăng nhập (AUTH_USER/AUTH_PASS).');
        }
        if (!validCreds(req)) return askLogin(res);
      }
    }
    if (!m[2]) { res.writeHead(302, { location: `/${m[1]}/` }); return res.end(); }
    return await sendFile(path.join(OUTPUT, m[1]), m[2], res, guard);
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
});

await initImagesApi();
server.listen(PORT, '127.0.0.1', () => console.log(`CrawCode UI: http://localhost:${PORT}`));
viewer.listen(VIEW_PORT, '127.0.0.1', () => console.log(`Viewer:      http://localhost:${VIEW_PORT}`));
