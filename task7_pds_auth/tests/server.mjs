// 로컬 E2E 용 서버: 정적 파일 + PostgREST 형태의 RPC(POST /rest/v1/rpc/<fn>)를 PGlite 로 처리한다.
// 실제 배포에서는 쓰지 않는다. config.js 만 로컬 주소로 바꿔서 내려준다.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from './pg.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
export const TEST_KEY = 'local-test-publishable-key';

export async function startServer(port = 0) {
  const { rpc, db } = await createDb();
  // 배포와 같은 보안 헤더(vercel.json)를 적용한다. CSP 의 Supabase 주소만 로컬 주소로 바꾼다.
  const vercel = JSON.parse(await readFile(path.join(root, 'vercel.json'), 'utf8'));
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const origin = `http://127.0.0.1:${server.address().port}`;
      for (const { key, value } of vercel.headers[0].headers) {
        res.setHeader(key, value.replace('https://ocacvvmryvtqajlmosqj.supabase.co', origin));
      }
      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
        if (req.headers.apikey !== TEST_KEY) { res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: 'Invalid API key' })); return; }
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        try {
          const out = await rpc(url.pathname.slice('/rest/v1/rpc/'.length), body);
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: e.code, message: e.message }));
        }
        return;
      }
      if (url.pathname === '/config.js') {
        const addr = server.address();
        res.writeHead(200, { 'Content-Type': TYPES['.js'] }).end(
          `window.PDS_CONFIG = { supabaseUrl: 'http://127.0.0.1:${addr.port}', publishableKey: '${TEST_KEY}' };`);
        return;
      }
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!['index.html', 'app.js', 'styles.css'].includes(rel)) { res.writeHead(404).end('not found'); return; }
      const data = await readFile(path.join(root, rel));
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(rel)] || 'application/octet-stream' }).end(data);
    } catch (e) {
      res.writeHead(500).end(String(e.message));
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { server, db, url: `http://127.0.0.1:${server.address().port}/` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await startServer(Number(process.env.PORT || 4173));
  console.log(`ready ${url}`);
}
