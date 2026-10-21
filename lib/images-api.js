// API quét & tải ảnh/icon (gộp từ project Craw): /api/scan, /api/file, /api/zip, /api/save.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { crawl } from './crawler.js';
import { buildZip } from './zip.js';

const CACHE = path.join(os.tmpdir(), 'craw-cache');
const MAX_JOBS = 5;
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', heic: 'image/heic',
  svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
};

const jobs = new Map();

export async function initImagesApi() {
  await fs.rm(CACHE, { recursive: true, force: true });
}

async function addJob(job) {
  jobs.set(job.id, job);
  while (jobs.size > MAX_JOBS) {
    const [oldId, old] = jobs.entries().next().value;
    jobs.delete(oldId);
    await fs.rm(old.dir, { recursive: true, force: true });
  }
}

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', ...headers });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function normalizeUrl(raw) {
  raw = String(raw || '').trim();
  if (!raw) throw new Error('Chưa nhập URL');
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  const u = new URL(raw);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Chỉ hỗ trợ http/https');
  return u.href;
}

async function handleScan(req, res, query) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const ctrl = new AbortController();
  // Người dùng bấm Huỷ / đóng tab → dừng crawl
  res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });

  const id = randomUUID();
  const dir = path.join(CACHE, id);
  try {
    const url = normalizeUrl(query.get('url'));
    await fs.mkdir(dir, { recursive: true });
    let last = 0;
    const assets = await crawl({
      url,
      depth: query.get('depth'),
      maxPages: query.get('maxPages'),
      sameHost: query.get('sameHost') !== '0',
      concurrency: query.get('concurrency'),
    }, {
      dir,
      signal: ctrl.signal,
      onProgress: (p) => {
        // Giới hạn tần suất gửi để không nghẽn SSE khi tải hàng nghìn ảnh
        const now = Date.now();
        if (now - last > 120 || p.phase === 'pages') { last = now; emit('progress', p); }
      },
    });
    await addJob({ id, dir, host: new URL(url).hostname, assets: new Map(assets.map((a) => [a.id, a])) });
    emit('done', {
      job: id,
      assets: assets.map(({ file, ...a }) => ({
        ...a,
        url: a.url.startsWith('data:') ? a.url.slice(0, 40) + '…' : a.url,
        aliases: a.aliases.filter((x) => !x.startsWith('data:')),
      })),
    });
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true });
    if (!ctrl.signal.aborted) emit('fail', { message: e.message });
  }
  res.end();
}

async function handleFile(res, jobId, assetId) {
  const a = jobs.get(jobId)?.assets.get(assetId);
  if (!a) return send(res, 404, 'Not found');
  const data = await fs.readFile(a.file);
  // SVG lấy từ site lạ có thể chứa script → sandbox khi mở trực tiếp
  send(res, 200, data, {
    'Content-Type': MIME[a.ext] || 'application/octet-stream',
    'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
    'Cache-Control': 'private, max-age=3600',
  });
}

// items: [{ id, folder: 'images' | 'icons' }]
function planFiles(job, items) {
  const used = new Set(), out = [];
  for (const it of items || []) {
    const a = job.assets.get(it.id);
    if (!a) continue;
    const folder = it.folder === 'icons' ? 'icons' : 'images';
    let name = `${a.name}.${a.ext}`;
    if (used.has(`${folder}/${name}`.toLowerCase())) name = `${a.name}-${a.width}x${a.height}.${a.ext}`;
    for (let i = 2; used.has(`${folder}/${name}`.toLowerCase()); i++) name = `${a.name}-${i}.${a.ext}`;
    used.add(`${folder}/${name}`.toLowerCase());
    out.push({ asset: a, rel: `${folder}/${name}` });
  }
  return out;
}

async function handleZip(req, res) {
  const { job: jobId, items } = await readJson(req);
  const job = jobs.get(jobId);
  if (!job) return send(res, 404, { error: 'Phiên crawl đã hết hạn, hãy quét lại' });
  const files = planFiles(job, items);
  const entries = await Promise.all(files.map(async (f) => ({ name: f.rel, data: await fs.readFile(f.asset.file) })));
  send(res, 200, buildZip(entries), {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${job.host}-images.zip"`,
  });
}

async function handleSave(req, res, downloadsDir) {
  const { job: jobId, items } = await readJson(req);
  const job = jobs.get(jobId);
  if (!job) return send(res, 404, { error: 'Phiên crawl đã hết hạn, hãy quét lại' });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const outDir = path.join(downloadsDir, `${job.host}_${stamp}`);
  const files = planFiles(job, items);
  for (const f of files) {
    const dest = path.join(outDir, f.rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(f.asset.file, dest);
  }
  send(res, 200, { dir: outDir, count: files.length });
}

// Trả về true nếu request thuộc API ảnh và đã được xử lý.
export async function handleImagesApi(req, res, u, { downloadsDir }) {
  if (req.method === 'GET' && u.pathname === '/api/scan') { await handleScan(req, res, u.searchParams); return true; }
  const fm = u.pathname.match(/^\/api\/file\/([\w-]+)\/(\w+)$/);
  if (req.method === 'GET' && fm) { await handleFile(res, fm[1], fm[2]); return true; }
  if (req.method === 'POST' && u.pathname === '/api/zip') { await handleZip(req, res); return true; }
  if (req.method === 'POST' && u.pathname === '/api/save') { await handleSave(req, res, downloadsDir); return true; }
  return false;
}
