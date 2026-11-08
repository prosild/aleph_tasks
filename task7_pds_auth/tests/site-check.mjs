// 실제 Supabase 에 연결된 화면을 읽기 전용으로 확인한다(쓰기 없음).
// 사용: node site-check.mjs [배포 URL]  — URL 이 없으면 이 폴더의 정적 파일을 vercel.json 헤더와 함께 로컬로 서빙한다.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOTICE = '지금은 로그인이 없어 링크를 아는 사람은 누구나 볼 수 있습니다. 남이 봐도 괜찮은 내용만 넣으세요';
let target = process.argv[2];
let server;
if (!target) {
  const vercel = JSON.parse(await readFile(path.join(root, 'vercel.json'), 'utf8'));
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
  server = http.createServer(async (req, res) => {
    const rel = req.url.split(/[?#]/)[0] === '/' ? 'index.html' : req.url.split(/[?#]/)[0].slice(1);
    if (!['index.html', 'app.js', 'styles.css', 'config.js'].includes(rel)) return res.writeHead(404).end();
    for (const { key, value } of vercel.headers[0].headers) res.setHeader(key, value);
    res.writeHead(200, { 'Content-Type': types[path.extname(rel)] }).end(await readFile(path.join(root, rel)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  target = `http://127.0.0.1:${server.address().port}/`;
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext(); // 새 컨텍스트 = 쿠키·저장소 없는 시크릿 창과 같은 조건
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const resp = await page.goto(target);
await page.waitForFunction(() => /불러옴|실패/.test(document.querySelector('#status').textContent), null, { timeout: 30000 });
const out = {
  target, http_status: resp.status(),
  csp: resp.headers()['content-security-policy'] || null,
  notice_exact: (await page.textContent('#public-notice')).trim() === NOTICE,
  status: await page.textContent('#status'),
  plans: await page.locator('#plan-select option').allTextContents(),
  stats: Object.fromEntries(await Promise.all(['planned', 'done', 'overdue', 'blocked', 'estimated', 'actual', 'diff']
    .map(async (k) => [k, await page.textContent(`[data-stat=${k}] .num`).catch(() => null)]))),
  console_errors: errors,
};
if (process.argv[3]) await page.screenshot({ path: process.argv[3], fullPage: true });
console.log(JSON.stringify(out, null, 2));
await browser.close();
server?.close();
