// 읽기 전용 UI 점검·스크린샷: node ui-shots.mjs [배포 URL] <출력 폴더> <접두사>
// URL 이 비면 이 폴더의 정적 파일을 vercel.json 헤더와 함께 로컬로 서빙(실제 Supabase 를 읽기만 함).
// 쓰기 버튼은 누르지 않고, RPC 요청이 pds_snapshot 뿐인지 기록한다.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let [target, outDir = '.', prefix = 't06-ui'] = process.argv.slice(2);
let server;
if (!target) {
  const vercel = JSON.parse(await readFile(path.join(root, 'vercel.json'), 'utf8'));
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
  server = http.createServer(async (req, res) => {
    const p = req.url.split(/[?#]/)[0];
    const rel = p === '/' ? 'index.html' : p.slice(1);
    if (!['index.html', 'app.js', 'styles.css', 'config.js'].includes(rel)) return res.writeHead(404).end();
    for (const { key, value } of vercel.headers[0].headers) res.setHeader(key, value);
    res.writeHead(200, { 'Content-Type': types[path.extname(rel)] }).end(await readFile(path.join(root, rel)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  target = `http://127.0.0.1:${server.address().port}/`;
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const result = { target, views: {} };
for (const [name, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
  const page = await browser.newPage({ viewport: { width, height }, colorScheme: 'light' });
  const rpcs = [];
  const errors = [];
  page.on('request', (r) => { const m = r.url().match(/\/rest\/v1\/rpc\/([a-z_]+)/); if (m) rpcs.push(m[1]); });
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(target);
  await page.waitForFunction(() => /불러옴|실패/.test(document.querySelector('#status').textContent), null, { timeout: 30000 });
  const plan = await page.locator('#plan-section').boundingBox();
  const todo = await page.locator('#todo-section').boundingBox();
  result.views[name] = {
    todo_right_of_plan: todo.x > plan.x + plan.width - 1,
    todo_below_plan: todo.y >= plan.y + plan.height - 1,
    notice_visible: await page.isVisible('#public-notice'),
    plan_id_hidden: !(await page.isVisible('[data-field=id]')),
    open_title: await page.textContent('#todo-open-title'),
    done_title: await page.textContent('#todo-done-title'),
    no_hscroll: await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
    overflowing: await page.evaluate(() => [...document.querySelectorAll('.card, .item, .chip, .callout')].filter((e) => e.scrollWidth > e.clientWidth + 1).length),
    null_text: /\bnull\b|undefined/.test(await page.textContent('main')),
    first_screen_height: await page.evaluate(() => document.documentElement.scrollHeight),
    rpc_calls: rpcs, only_reads: rpcs.every((r) => r === 'pds_snapshot'), console_errors: errors,
  };
  await page.screenshot({ path: `${outDir}/${prefix}-${name}.png`, fullPage: true });
  await page.screenshot({ path: `${outDir}/${prefix}-${name}-firstscreen.png` });
  await page.close();
}
console.log(JSON.stringify(result, null, 1));
await browser.close();
server?.close();
