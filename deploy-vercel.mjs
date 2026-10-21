#!/usr/bin/env node
// Deploy tĩnh trang portfolio + bản clone (chỉ xem) lên Vercel, không cần máy này bật.
// Usage: node deploy-vercel.mjs [--all] [--no-deploy]   (mặc định chỉ các nhóm gần ngành; lần đầu chạy `npx vercel login`)
// VERCEL_PROJECT (.env) đặt tên project -> link <tên>.vercel.app
import { spawn } from 'node:child_process';
import { readdir, readFile, writeFile, copyFile, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeUrl } from './clone.mjs';
import { injectGuard } from './lib/view-guard.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}
const OUTPUT = path.join(ROOT, 'output');
const PUBLIC = path.join(ROOT, 'public');
const DIR = path.join(ROOT, 'deploy', process.env.VERCEL_PROJECT || 'nguyennguyen');
const SITES = path.join(DIR, 'sites');
// Khớp NEAR trong public/portfolio.html.
const NEAR = ['Công nghiệp & năng lượng', 'Công nghệ', 'Nhà cửa & xây dựng',
  'Mua sắm', 'Văn hóa & giải trí', 'Sức khỏe & làm đẹp', 'Giáo dục', 'Ăn uống', 'Tài chính'];
// Video/file lớn làm phình bản deploy mà thumbnail/xem nhanh không cần.
const MAX_FILE = 10 * 1024 * 1024;
const all = process.argv.includes('--all');

async function walk(dir, base = dir) {
  const out = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    if (d.name.startsWith('.')) continue;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...await walk(full, base));
    else out.push({ full, rel: path.relative(base, full) });
  }
  return out;
}

async function siteMeta(site) {
  const dir = path.join(OUTPUT, site);
  const meta = await readFile(path.join(dir, '.crawcode.json'), 'utf8').then(JSON.parse).catch(() => null);
  if (meta) return meta;
  return (await stat(path.join(dir, 'index.html')).catch(() => null)) ? { entry: 'index.html' } : null;
}

const items = [];
for (const it of JSON.parse(await readFile(path.join(ROOT, 'catalog.json'), 'utf8'))) {
  if (!all && !NEAR.includes(it.group)) continue;
  const site = normalizeUrl(it.url).hostname;
  const meta = await siteMeta(site);
  if (meta?.entry) items.push({ group: it.group, field: it.field, name: it.name, site, entry: meta.entry, pages: meta.pages });
}

// Giữ deploy/<project>/.vercel (liên kết project) giữa các lần deploy, chỉ dựng lại phần nội dung.
await rm(SITES, { recursive: true, force: true });
let bytes = 0, files = 0, skipped = 0;
for (const { site } of items) {
  for (const f of await walk(path.join(OUTPUT, site))) {
    const size = (await stat(f.full)).size;
    if (size > MAX_FILE) { skipped++; continue; }
    const to = path.join(SITES, site, f.rel);
    await mkdir(path.dirname(to), { recursive: true });
    if (/\.html?$/i.test(f.rel)) await writeFile(to, injectGuard(await readFile(f.full, 'utf8')));
    else await copyFile(f.full, to);
    bytes += size;
    files++;
  }
}
await writeFile(path.join(DIR, 'portfolio.json'), JSON.stringify({ viewBase: 'sites', items }));
await copyFile(path.join(PUBLIC, 'portfolio.html'), path.join(DIR, 'index.html'));
await copyFile(path.join(PUBLIC, 'portfolio-avatar.png'), path.join(DIR, 'portfolio-avatar.png'));
await writeFile(path.join(DIR, 'vercel.json'), JSON.stringify({
  headers: [{ source: '/(.*)', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] }],
}, null, 2));
console.log(`Đã dựng ${items.length} website: ${files} file, ${(bytes / 1048576).toFixed(0)} MB (bỏ ${skipped} file > ${MAX_FILE / 1048576} MB) -> ${DIR}`);

if (process.argv.includes('--no-deploy')) process.exit(0);
console.log('Đang deploy lên Vercel…');
// --archive=tgz: gói thành archive để không vướng giới hạn số file khi upload.
const v = spawn('npx', ['--yes', 'vercel', 'deploy', '--prod', '--yes', '--archive=tgz'], { cwd: DIR, stdio: 'inherit', shell: true });
v.on('exit', code => {
  if (code !== 0) console.error('Deploy Vercel lỗi. Lần đầu cần chạy: npx vercel login. Nếu báo vượt dung lượng: bớt website hoặc dùng gói Pro.');
  process.exit(code ?? 1);
});
