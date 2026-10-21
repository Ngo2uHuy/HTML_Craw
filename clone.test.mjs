import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { clone } from './clone.mjs';

test('whole website crawls beyond page and depth limits; bounded modes stay bounded', async () => {
  const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
  const levels = vm.runInNewContext(`${source.match(/const MAX_PAGES_PER_SITE = \d+;/)[0]}\n${source.match(/const LEVELS = \{[\s\S]*?\n\};/)[0]}\nLEVELS`);
  const requested = [];
  const server = http.createServer((req, res) => {
    requested.push(req.url);
    if (req.url === '/robots.txt') return res.end('User-agent: *\nDisallow: /blocked');
    res.setHeader('content-type', 'text/html');
    const n = req.url === '/' ? 0 : Number(req.url.slice(2));
    res.end(`<html><body>${n < 24 ? `<a href="/p${n + 1}">Next</a>` : ''}<a href="/">Home</a><a href="/blocked">Blocked</a><a href="http://outside.invalid/">Outside</a></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const temp = await mkdtemp(path.join(os.tmpdir(), 'crawcode-test-'));
  try {
    const url = `http://127.0.0.1:${server.address().port}/`;
    const full = await clone({ url, out: path.join(temp, 'full'), ...levels.site });
    assert.equal(full.pages, 25);
    assert.equal(full.failed, 0);
    assert.ok((await readFile(path.join(temp, 'full/p24/index.html'), 'utf8')).includes('Home'));
    assert.ok(!requested.includes('/blocked'));
    for (const [mode, expected] of [['page', 1], ['section', 2]]) {
      const result = await clone({ url, out: path.join(temp, mode), ...levels[mode] });
      assert.equal(result.pages, expected);
      assert.equal(result.failed, 0);
    }
    const limited = await clone({ url, out: path.join(temp, 'limited'), depth: 20, maxPages: 10 });
    assert.equal(limited.pages, 10);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});
