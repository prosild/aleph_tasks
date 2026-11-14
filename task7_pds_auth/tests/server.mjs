// 로컬 E2E 용 정적 서버: index.html·app.js·styles.css·vendor/supabase.js 를 내려주고,
// config.js 만 로컬 Supabase 스택(supabase start) 주소·publishable key 로 바꾼다. 배포에서는 쓰지 않는다.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localStatus } from './stack.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
const FILES = new Set(['index.html', 'app.js', 'styles.css', 'vendor/supabase.js']);
const REMOTE = 'https://ocacvvmryvtqajlmosqj.supabase.co';

export async function startServer(port = 4173) {
  const st = localStatus();
  // 배포와 같은 보안 헤더(vercel.json). CSP 의 Supabase 주소만 로컬 스택 주소로 바꾼다.
  const vercel = JSON.parse(await readFile(path.join(root, 'vercel.json'), 'utf8'));
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      for (const { key, value } of vercel.headers[0].headers) res.setHeader(key, value.replace(REMOTE, st.url));
      if (url.pathname === '/config.js') {
        res.writeHead(200, { 'Content-Type': TYPES['.js'] }).end(
          `window.PDS_CONFIG = { supabaseUrl: ${JSON.stringify(st.url)}, publishableKey: ${JSON.stringify(st.key)} };`);
        return;
      }
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!FILES.has(rel)) { res.writeHead(404).end('not found'); return; }
      const data = await readFile(path.join(root, rel));
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(rel)] || 'application/octet-stream' }).end(data);
    } catch (e) {
      res.writeHead(500).end(String(e.message));
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/`, stack: st };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await startServer(Number(process.env.PORT || 4173));
  console.log(`ready ${url}`);
}
