// T07 화면 시험: 로컬 Supabase 스택 + 실제 화면(Chrome). 확인 메일은 로컬 메일함(Mailpit)에서 읽는다.
// 실행: supabase start 후 npm run test:auth-ui   (화면 캡처는 T07_SHOTS_DIR 에 저장)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { startServer } from './server.mjs';
import { newLocalUser, uiLogin, tokenOf } from './ui-auth.mjs';
import { sql, APP_ROOT } from './stack.mjs';

const SHOTS = process.env.T07_SHOTS_DIR || path.resolve(APP_ROOT, '..', '..', '..', '..', '..', 'T07_UI_SHOTS');
let srv, browser;
const consoleErrors = [];
const seoulToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const addDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const T = seoulToday();

before(async () => {
  await mkdir(SHOTS, { recursive: true });
  srv = await startServer(4173); // 확인 메일의 돌아올 주소(site_url)와 같은 포트
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => { await browser?.close(); srv?.server.close(); });

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ locale: 'ko-KR', acceptDownloads: true, ...opts });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  return { ctx, page };
}
const loaded = (page) => page.waitForFunction(() => /불러옴|저장됨/.test(document.querySelector('#status').textContent) || document.querySelector('#status').classList.contains('error'));
const authMsg = (page) => page.textContent('#auth-msg');
async function apiSnapshot(page, token) {
  return page.evaluate(async (tok) => {
    const c = window.PDS_CONFIG;
    const r = await fetch(`${c.supabaseUrl}/rest/v1/rpc/pds7_snapshot`, { method: 'POST', headers: { apikey: c.publishableKey, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: '{}' });
    return r.status;
  }, token);
}

test('C03·C97: 로그인 없이 첫 화면·자료 화면 주소 → 로그인 화면, 자료 요청 없음', async () => {
  const { ctx, page } = await newPage({ viewport: { width: 1366, height: 768 } });
  const rpcCalls = [];
  page.on('request', (r) => { if (r.url().includes('/rest/v1/')) rpcCalls.push(r.url()); });
  for (const p of ['', '#plan=00000000-0000-4000-8000-000000000000']) {
    await page.goto(srv.url + p);
    await page.waitForSelector('#auth-view:not(.hidden)');
    assert.ok(await page.isHidden('#app-view'));
    assert.ok(await page.isVisible('#login-form'));
  }
  assert.deepEqual(rpcCalls, []);
  await page.screenshot({ path: path.join(SHOTS, 'login-desktop.png') });
  await ctx.close();
});

test('C94·C98·C112: 화면에서 가입 → 확인 메일 링크 → 주소의 코드 즉시 제거 → 로그인, 같은 이메일 재가입 거절', async () => {
  const { ctx, page } = await newPage();
  const email = `t07-local-signup-${randomBytes(3).toString('hex')}@example.com`;
  const pw = `T07ui-${randomBytes(10).toString('base64url')}`;
  await page.goto(srv.url);
  await page.click('#tab-signup');
  await page.fill('#signup-form [name=email]', email);
  await page.fill('#signup-form [name=password]', pw);
  await page.fill('#signup-form [name=password2]', pw);
  await page.click('#signup-form button[type=submit]');
  await page.waitForFunction(() => /확인 메일/.test(document.querySelector('#auth-msg').textContent));
  // 확인 전 로그인 → 확인 안내
  await page.fill('#login-form [name=password]', pw);
  await page.click('#login-form button[type=submit]');
  await page.waitForFunction(() => /이메일 확인을 먼저/.test(document.querySelector('#auth-msg').textContent));
  // 로컬 메일함에서 확인 링크 읽기
  const mail = srv.stack.mail;
  let link = null;
  for (let i = 0; i < 20 && !link; i++) {
    const list = await (await fetch(`${mail}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json();
    if (list.messages?.length) {
      const msg = await (await fetch(`${mail}/api/v1/message/${list.messages[0].ID}`)).json();
      link = (msg.Text.match(/https?:\/\/\S+verify\S+/) || [])[0];
    }
    if (!link) await new Promise((r) => setTimeout(r, 300));
  }
  assert.ok(link, '확인 메일 링크');
  const referers = [];
  page.on('request', (r) => { const h = r.headers().referer; if (h) referers.push(h); });
  await page.goto(link.replace(/&amp;/g, '&'));
  await page.waitForSelector('#auth-view:not(.hidden)');
  await page.waitForFunction(() => /이메일 확인이 끝났습니다/.test(document.querySelector('#auth-msg').textContent));
  const u = new URL(page.url());
  assert.equal(u.search, '', '주소에 코드가 남지 않음');
  assert.equal(u.hash, '');
  assert.ok(!referers.some((r) => /code=|access_token/.test(r)), 'Referer 로 코드·토큰이 나가지 않음');
  assert.ok(!(await page.evaluate(() => Object.keys(localStorage).some((k) => /-auth-token$/.test(k)))), '확인 링크만으로 로그인되지 않음');
  await uiLogin(page, { email, password: pw });
  await loaded(page);
  assert.equal(await page.textContent('#account-email'), email);
  // 같은 이메일로 다시 가입
  await page.click('#logout-btn');
  await page.waitForSelector('#auth-view:not(.hidden)');
  await page.click('#tab-signup');
  await page.fill('#signup-form [name=email]', email);
  await page.fill('#signup-form [name=password]', `Other-${pw}`);
  await page.fill('#signup-form [name=password2]', `Other-${pw}`);
  await page.click('#signup-form button[type=submit]');
  await page.waitForFunction(() => /이미 가입된 이메일/.test(document.querySelector('#auth-msg').textContent));
  assert.equal(sql(`select count(*) from auth.users where email = :'e';`, { e: email }), '1');
  await ctx.close();
});

test('C99: 틀린 비밀번호·없는 이메일 → 같은 안내 문구', async () => {
  const u = newLocalUser('c99');
  const { ctx, page } = await newPage();
  await page.goto(srv.url);
  const tryLogin = async (email, pw) => {
    await page.fill('#login-form [name=email]', email);
    await page.fill('#login-form [name=password]', pw);
    await page.click('#login-form button[type=submit]');
    await page.waitForFunction(() => !/로그인 중/.test(document.querySelector('#auth-msg').textContent));
    return authMsg(page);
  };
  const a = await tryLogin(u.email, 'Wrong-password-1');
  const b = await tryLogin(`t07-nobody-${randomBytes(3).toString('hex')}@example.com`, 'Wrong-password-1');
  assert.equal(a, b);
  assert.equal(a, '이메일 또는 비밀번호가 맞지 않습니다.');
  await ctx.close();
});

test('5일 관찰: 설정 고정·서로 다른 날짜 5일·2일차 뒤 3일차 앞 규칙 변경 1회·합계/평균 대조·내보내기', async () => {
  const u = newLocalUser('obs');
  const { ctx, page } = await newPage({ viewport: { width: 1366, height: 900 } });
  await page.goto(srv.url);
  await uiLogin(page, u);
  await loaded(page);
  assert.match(await page.textContent('#obs-today'), /정하면 시작/);
  await page.click('#obs-section > summary');
  const f = '#obs-form';
  await page.fill(`${f} [name=question]`, '[시험] 질문');
  await page.fill(`${f} [name=metric]`, '[시험] 지표');
  await page.selectOption(`${f} [name=unit]`, '시간(분)');
  await page.fill(`${f} [name=calc_rule]`, '[시험] 계산 규칙');
  await page.fill(`${f} [name=outlier_min]`, '0');
  await page.fill(`${f} [name=outlier_max]`, '600');
  await page.selectOption(`${f} [name=rounding_digits]`, '1');
  await page.fill(`${f} [name=plan_rule]`, '[시험] 규칙 A');
  await page.click(`${f} button[type=submit]`);
  await loaded(page);
  const save = async (v) => { await page.fill('#log-form [name=value]', String(v)); await page.click('#log-form button[type=submit]'); await loaded(page); };
  const shiftAll = (n) => sql(`update public.pds7_daily_logs set log_date = log_date - :n where user_id = :'u';`, { n, u: u.id });
  // 이상값은 저장 안 됨
  await save(700);
  assert.match(await page.textContent('#status'), /이상값/);
  await save(30);                       // 1일차 (오늘)
  assert.ok(await page.isHidden('#obs-edit-btn'), '1일차 뒤 설정 고치기 없음');
  shiftAll(4); await page.click('#reload-btn'); await loaded(page);
  await save(40);                       // 2일차
  assert.ok(await page.isVisible('#rule-form'), '2일차 뒤 규칙 변경 양식');
  assert.match(await page.textContent('#log-label'), /오늘 값 고치기/, '2일차 당일에는 그날 값만 고칠 수 있음');
  shiftAll(1); await page.click('#reload-btn'); await loaded(page);
  assert.ok(await page.isHidden('#log-form'), '규칙 변경 전에는 3일차 기록 불가');
  assert.match(await page.textContent('#obs-today'), /규칙 변경 필요/);
  await page.fill('#rule-form [name=new_rule]', '[시험] 규칙 B');
  await page.fill('#rule-form [name=reason]', '[시험] 이유');
  await page.click('#rule-form button[type=submit]');
  await loaded(page);
  assert.ok(await page.isHidden('#rule-form'), '규칙 변경은 한 번만');
  await save(25);                       // 3일차
  shiftAll(1); await page.click('#reload-btn'); await loaded(page);
  await save(35);                       // 4일차
  shiftAll(1); await page.click('#reload-btn'); await loaded(page);
  await save(20.5);                     // 5일차
  const rows = await page.locator('.obs-table:not(.obs-stats) tbody tr').allTextContents();
  assert.equal(rows.length, 6);
  assert.match(rows[2], /계획 규칙 변경.*규칙 A.*규칙 B.*이유/s);
  const dates = await page.locator('.obs-table:not(.obs-stats) tbody tr[data-log-id] td:nth-child(2)').allTextContents();
  assert.equal(new Set(dates).size, 5);
  assert.equal(dates.at(-1), T);
  const stat = async (phase, field) => page.textContent(`.obs-table.obs-stats tr[data-phase=${phase}] [data-field=${field}]`);
  assert.equal(await stat('before', 'sum'), '70');
  assert.equal(await stat('before', 'avg'), '35');
  assert.equal(await stat('after', 'sum'), '80.5');
  assert.equal(await stat('after', 'avg'), '26.8'); // 80.5/3 = 26.833 → 소수 첫째 자리
  assert.equal(await stat('all', 'sum'), '150.5');
  assert.equal(await stat('all', 'avg'), '30.1');
  assert.match(await page.textContent('.obs-table.obs-stats tr[data-phase=all]'), /30 \+ 40 \+ 25 \+ 35 \+ 20\.5 = 150\.5/);
  assert.ok(await page.isHidden('#log-form') || /고치기/.test(await page.textContent('#log-label')));
  await page.screenshot({ path: path.join(SHOTS, 'observation-desktop.png'), fullPage: true });
  // 내보내기: 내 자료만, 파일 하나
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-btn')]);
  const data = JSON.parse(await readFile(await dl.path(), 'utf8'));
  assert.equal(data.daily_logs.length, 5);
  assert.equal(data.rule_change.new_rule, '[시험] 규칙 B');
  assert.equal(data.observation.unit, '시간(분)');
  assert.ok(data.daily_logs.every((l) => l.user_id === u.id));
  await ctx.close();
});

test('C96·C109: 로그아웃 → 로그인 화면, 화면·저장소에 자료·토큰 없음, 뒤로 가기에도 자료 없음, 같은 토큰 401', async () => {
  const u = newLocalUser('logout');
  const { ctx, page } = await newPage();
  await page.goto(`${srv.url}`);
  await uiLogin(page, u);
  await loaded(page);
  await page.fill('#plan-form [name=title]', '[시험] 로그아웃 확인 계획');
  await page.fill('#plan-form [name=start_date]', T);
  await page.fill('#plan-form [name=end_date]', addDays(T, 1));
  await page.fill('#plan-form [name=success_criteria]', '시험');
  await page.fill('#plan-form [name=estimated_minutes]', '10');
  await page.click('#plan-form button[type=submit]');
  await loaded(page);
  assert.match(page.url(), /#plan=/);
  const token = await tokenOf(page);
  assert.equal(await apiSnapshot(page, token), 200);
  await page.click('#logout-btn');
  await page.waitForSelector('#auth-view:not(.hidden)');
  assert.match(await authMsg(page), /로그아웃했습니다/);
  const leftovers = await page.evaluate(() => ({
    text: document.querySelector('#app-view').innerText.includes('로그아웃 확인 계획'),
    storage: Object.keys(localStorage).filter((k) => /-auth-token$/.test(k)),
    hash: location.hash,
  }));
  assert.deepEqual(leftovers, { text: false, storage: [], hash: '' });
  assert.equal(await apiSnapshot(page, token), 401, '로그아웃 뒤 같은 토큰');
  // 로그아웃 뒤 다른 페이지로 갔다가 뒤로 가기: 캐시된 화면에도 자료가 없어야 한다
  await page.goto(`${srv.url}styles.css`);
  await page.goBack();
  await page.waitForSelector('#auth-view:not(.hidden)');
  const back = await page.evaluate(() => ({ appHidden: document.querySelector('#app-view').classList.contains('hidden'), text: document.body.innerText.includes('로그아웃 확인 계획') }));
  assert.deepEqual(back, { appHidden: true, text: false });
  await ctx.close();
});

test('R-A·R-C: 이 앱을 열기 전부터 있던 공유 계정으로 로그인 → 회원 등록 거절 이유 표시, 로그인 정보 남지 않음', async () => {
  const u = newLocalUser('legacyui');
  sql(`update auth.users set created_at = (select value from pds7_private.settings where key = 'schema_applied_at') - interval '1 day' where id = :'id';`, { id: u.id });
  const { ctx, page } = await newPage();
  await page.goto(`${srv.url}`);
  await page.waitForSelector('#login-form:not(.hidden)');
  await page.fill('#login-form [name=email]', u.email);
  await page.fill('#login-form [name=password]', u.password);
  await page.click('#login-form button[type=submit]');
  await page.waitForFunction(() => /공유 계정은 쓸 수 없습니다/.test(document.querySelector('#auth-msg').textContent));
  assert.ok(await page.isHidden('#app-view'));
  assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter((k) => /-auth-token/.test(k))), []);
  assert.equal(sql(`select count(*) from pds7_private.members where user_id = :'id';`, { id: u.id }), '0');
  await ctx.close();
});

test('검토 지적 #2: 로그인 직후 회원 확인(pds7_me)이 서버 오류면 "불러오는 중"에 멈추지 않고 오류 안내', async () => {
  const u = newLocalUser('meerr');
  const n0 = consoleErrors.length;
  const { ctx, page } = await newPage();
  await page.route('**/rest/v1/rpc/pds7_me', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"시험용 서버 오류"}' }));
  await page.goto(`${srv.url}`);
  await uiLogin(page, u);
  await page.waitForFunction(() => document.querySelector('#status').classList.contains('error'));
  assert.match(await page.textContent('#status'), /계정 확인 실패: 시험용 서버 오류/);
  await ctx.close();
  const mine = consoleErrors.splice(n0);
  consoleErrors.push(...mine.filter((e) => !/status of 500/.test(e)));
});

for (const failure of ['500', 'network']) {
  test(`R-B: 서버 로그아웃 실패(${failure}) → 이 브라우저 토큰은 지우고, 서버 폐기 실패를 그대로 안내, 새로고침·새 탭에도 로그인 안 됨`, async () => {
    const u = newLocalUser(`lo${failure}`);
    const n0 = consoleErrors.length;
    const { ctx, page } = await newPage();
    await page.goto(`${srv.url}`);
    await uiLogin(page, u);
    await loaded(page);
    const token = await tokenOf(page);
    await page.route('**/auth/v1/logout**', (r) => (failure === '500'
      ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"code":500,"msg":"시험용 서버 오류"}' })
      : r.abort('failed')));
    await page.click('#logout-btn');
    await page.waitForSelector('#auth-view:not(.hidden)');
    const storage = await page.evaluate(() => Object.keys(localStorage).filter((k) => /-auth-token/.test(k)));
    assert.deepEqual(storage, [], '토큰 저장소 비어 있음');
    const msg = await authMsg(page);
    assert.match(msg, /이 브라우저의 로그인 정보는 지웠습니다/);
    assert.match(msg, /서버에서 세션을 끝냈는지 확인하지 못했습니다/);
    assert.doesNotMatch(msg, /^로그아웃했습니다/);
    await page.unroute('**/auth/v1/logout**');
    await page.reload();
    await page.waitForSelector('#auth-view:not(.hidden)');
    assert.ok(await page.isHidden('#app-view'), '새로고침 뒤 로그인 화면');
    const tab2 = await ctx.newPage();
    await tab2.goto(`${srv.url}`);
    await tab2.waitForSelector('#auth-view:not(.hidden)');
    assert.ok(await tab2.isHidden('#app-view'), '새 탭도 로그인 화면');
    // 서버 요청이 실패했으므로 서버 세션은 남아 있다(안내 문구가 말하는 한계). 이 사실을 숨기지 않는다.
    assert.equal(await apiSnapshot(page, token), 200, '서버 폐기 실패 시 기존 토큰은 서버에서 아직 유효(한계)');
    await ctx.close();
    // 이 시험이 일부러 만든 로그아웃 실패(500·네트워크 끊김)만 콘솔 오류 목록에서 뺀다
    const mine = consoleErrors.splice(n0);
    consoleErrors.push(...mine.filter((e) => !(failure === '500' ? /status of 500/ : /net::ERR_FAILED/).test(e)));
  });
}

test('C114: 화면에서 비밀번호 변경 → 로그인 화면, 이전 토큰 401, 새 비밀번호로 로그인', async () => {
  const u = newLocalUser('pw');
  const { ctx, page } = await newPage();
  await page.goto(srv.url);
  await uiLogin(page, u);
  await loaded(page);
  const token = await tokenOf(page);
  const np = `${u.password}-new`;
  await page.click('#account-menu > summary');
  await page.fill('#password-form [name=password]', np);
  await page.fill('#password-form [name=password2]', np);
  await page.click('#password-form button[type=submit]');
  await page.waitForSelector('#auth-view:not(.hidden)');
  assert.match(await authMsg(page), /비밀번호를 바꿨습니다/);
  assert.equal(await apiSnapshot(page, token), 401);
  await uiLogin(page, { email: u.email, password: np });
  await loaded(page);
  await ctx.close();
});

test('C134: 화면에서 계정 삭제 → 확인 문구·비밀번호 확인, 삭제 후 로그인 불가·자료 없음', async () => {
  const u = newLocalUser('del');
  const { ctx, page } = await newPage();
  await page.goto(srv.url);
  await uiLogin(page, u);
  await loaded(page);
  await page.click('#account-menu > summary');
  assert.ok(await page.isVisible('#delete-form'));
  assert.match(await page.textContent('#delete-form'), /함께 지워지고 되돌릴 수 없습니다/);
  await page.fill('#delete-form [name=password]', u.password);
  await page.fill('#delete-form [name=confirm]', '삭제');
  await page.click('#delete-form button[type=submit]');
  assert.match(await page.textContent('#status'), /정확히 입력/);
  await page.fill('#delete-form [name=password]', 'Wrong-password-1');
  await page.fill('#delete-form [name=confirm]', '계정 삭제');
  await page.click('#delete-form button[type=submit]');
  await page.waitForFunction(() => /현재 비밀번호가 맞지 않습니다/.test(document.querySelector('#status').textContent));
  await page.fill('#delete-form [name=password]', u.password);
  await page.fill('#delete-form [name=confirm]', '계정 삭제');
  await page.click('#delete-form button[type=submit]');
  await page.waitForSelector('#auth-view:not(.hidden)');
  assert.match(await authMsg(page), /계정과 내 기록을 삭제했습니다/);
  assert.equal(sql(`select count(*) from auth.users where id = :'id';`, { id: u.id }), '0');
  await page.fill('#login-form [name=email]', u.email);
  await page.fill('#login-form [name=password]', u.password);
  await page.click('#login-form button[type=submit]');
  await page.waitForFunction(() => /맞지 않습니다/.test(document.querySelector('#auth-msg').textContent));
  await ctx.close();
});

test('모바일(390×844): 로그인·앱 화면 가로 스크롤 없음, 계정 패널이 화면 안, 핵심 버튼 접근 가능', async () => {
  const u = newLocalUser('mobile');
  const { ctx, page } = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.goto(srv.url);
  const noHScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  assert.ok(await noHScroll(), '로그인 화면');
  await page.screenshot({ path: path.join(SHOTS, 'login-mobile.png') });
  await uiLogin(page, u);
  await loaded(page);
  assert.ok(await noHScroll(), '앱 화면');
  for (const sel of ['#logout-btn', '#export-btn', '#account-menu > summary', '#obs-section > summary']) {
    const b = await page.locator(sel).boundingBox();
    assert.ok(b && b.x >= 0 && b.x + b.width <= 390, `${sel} 화면 안`);
  }
  await page.screenshot({ path: path.join(SHOTS, 'app-mobile.png') });
  await page.click('#account-menu > summary');
  assert.ok(await noHScroll(), '계정 패널 펼침');
  const panel = await page.locator('.account-panel').boundingBox();
  assert.ok(panel.x >= 0 && panel.x + panel.width <= 390);
  await page.screenshot({ path: path.join(SHOTS, 'account-mobile.png'), fullPage: true });
  await ctx.close();
});

test('콘솔 오류 없음(의도한 4xx 응답 제외)', async () => {
  const unexpected = consoleErrors.filter((e) => !/status of (400|401|403|404|422)/.test(e));
  assert.deepEqual(unexpected, []);
});
