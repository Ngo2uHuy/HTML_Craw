#!/usr/bin/env node
// Publish CrawCode ra Internet qua Cloudflare Quick Tunnel (cần cài cloudflared).
// Usage: node publish.mjs   (đọc AUTH_USER/AUTH_PASS và các key khác từ .env)
// Mở 2 tunnel: giao diện (PORT) và trang xem kết quả (PORT+1, origin riêng), rồi chạy server.mjs với VIEW_URL.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}
const PORT = Number(process.env.PORT || 3000);

// --portfolio: chỉ publish trang portfolio + bản clone (chỉ xem), không publish giao diện công cụ.
const portfolio = process.argv.includes('--portfolio');
const hasAuth = !portfolio && !!(process.env.AUTH_USER && process.env.AUTH_PASS);
if (hasAuth && process.env.AUTH_PASS.length < 8) {
  console.error('AUTH_PASS phải >= 8 ký tự (hoặc bỏ AUTH_USER/AUTH_PASS để publish chế độ chỉ xem).');
  process.exit(1);
}

const children = [];
const stopAll = () => { for (const c of children) c.kill(); process.exit(0); };
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);

function tunnel(port) {
  return new Promise((resolve, reject) => {
    const cf = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`]);
    children.push(cf);
    cf.on('error', e => reject(e.code === 'ENOENT'
      ? new Error('Chưa cài cloudflared. Cài bằng: winget install --id Cloudflare.cloudflared (rồi mở terminal mới)')
      : e));
    const onData = d => {
      const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) resolve(m[0]);
    };
    cf.stdout.on('data', onData);
    cf.stderr.on('data', onData);
    cf.on('exit', code => reject(new Error(`cloudflared thoát (code ${code}) trước khi có URL`)));
    setTimeout(() => reject(new Error('Quá 60 giây chưa lấy được URL tunnel')), 60000);
  });
}

try {
  console.log('Đang mở Cloudflare tunnel…');
  const [ui, view] = await Promise.all([tunnel(PORT), tunnel(PORT + 1)]);
  const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, PORT: String(PORT), VIEW_URL: view, ...(portfolio && { PUBLISH_MODE: 'portfolio' }) },
  });
  children.push(server);
  server.on('exit', code => { console.error(`server.mjs dừng (code ${code})`); stopAll(); });
  if (portfolio) console.log(`\nPortfolio public: ${ui}   (chỉ trang portfolio + bản clone, chỉ xem)`);
  else console.log(`\nCrawCode public:  ${ui}   ${hasAuth ? '(đăng nhập bằng AUTH_USER/AUTH_PASS)' : '(không đăng nhập, chỉ xem)'}`);
  console.log(`Trang kết quả:    ${view}   (chỉ phục vụ trang sinh từ Figma)`);
  console.log('Ctrl+C để dừng publish.\n');
} catch (e) {
  console.error(e.message);
  stopAll();
}
