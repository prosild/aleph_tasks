// 브라우저 E2E: 실제 화면(index.html/app.js)을 Chrome 으로 조작하고, 로컬 PGlite DB(같은 스키마 SQL)에 저장·재조회한다.
// 실행: npm run test:e2e  (BASE_URL 을 주면 그 주소의 배포본을 대상으로 읽기 전용 확인만 한다)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

let srv, browser, page, ctx;
const dialogs = [];
const consoleErrors = [];
const seoulToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const addDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const T = seoulToday();
const NOTICE = '지금은 로그인이 없어 링크를 아는 사람은 누구나 볼 수 있습니다. 남이 봐도 괜찮은 내용만 넣으세요';

before(async () => {
  srv = await startServer(0);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  ctx = await browser.newContext({ acceptDownloads: true, locale: 'ko-KR', timezoneId: 'America/Los_Angeles' }); // 브라우저 시간대가 달라도 서울 기준이어야 함
  page = await ctx.newPage();
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await page.goto(srv.url);
  await waitOk();
});
after(async () => { await browser?.close(); srv?.server.close(); });

async function waitOk() {
  await page.waitForFunction(() => /불러옴|저장됨|내보냄|중복/.test(document.querySelector('#status').textContent) || document.querySelector('#status').classList.contains('error'));
}
async function status() { return page.textContent('#status'); }
const snap = async () => page.evaluate(async () => {
  const c = window.PDS_CONFIG;
  const r = await fetch(`${c.supabaseUrl}/rest/v1/rpc/pds_snapshot`, { method: 'POST', headers: { apikey: c.publishableKey, 'Content-Type': 'application/json' }, body: '{}' });
  return r.json();
});
// 접힌 입력 영역(details)은 사용자처럼 요약 줄을 눌러 펼친다.
async function ensureOpen(sel) {
  const closed = await page.locator(sel).evaluate((el) => { const d = el.closest('details'); return d && !d.open ? d.id : null; });
  if (closed) await page.click(`#${closed} > summary`);
}
async function fill(form, values) {
  await ensureOpen(form);
  for (const [k, v] of Object.entries(values)) {
    const el = page.locator(`${form} [name=${k}]`);
    const tag = await el.evaluate((e) => e.tagName);
    if (tag === 'SELECT') await el.selectOption(String(v)); else await el.fill(String(v));
  }
}
async function submit(form) { await page.click(`${form} button[type=submit]`); await waitOk(); }
const todoItem = (title) => page.locator('#todo-list li.item', { has: page.locator('.title-line', { hasText: title }) });

test('C82: 첫 화면에 공개 범위 안내 문구가 그대로 보인다', async () => {
  assert.equal((await page.textContent('#public-notice')).trim(), NOTICE);
  assert.ok(await page.isVisible('#public-notice'));
});

test('C04~C08: 계획 등록 → 수정 → 최초 계획이 이력에 보존', async () => {
  await fill('#plan-form', { title: '[E2E] 계획', description: '설명', start_date: addDays(T, -7), end_date: addDays(T, 12), priority: 1, success_criteria: '기준 A', estimated_minutes: 600 });
  await submit('#plan-form');
  assert.match(await status(), /계획 등록 저장됨/);
  assert.equal(await page.textContent('[data-field=period]'), `${addDays(T, -7)} ~ ${addDays(T, 12)}`);
  assert.equal(await page.textContent('[data-field=priority]'), '1 높음');
  assert.equal(await page.textContent('[data-field=success_criteria]'), '기준 A');
  assert.equal(await page.textContent('[data-field=estimated_minutes]'), '600분');
  const planId = await page.textContent('[data-field=id]');
  await page.click('#edit-plan-btn');
  await fill('#plan-form', { success_criteria: '기준 B', estimated_minutes: 720, change_note: '범위 확대' });
  await submit('#plan-form');
  assert.equal(await page.textContent('[data-field=id]'), planId, '계획 ID 유지');
  assert.equal(await page.textContent('[data-field=success_criteria]'), '기준 B');
  await page.click('#revisions summary');
  const v1 = await page.textContent('#revision-list [data-version="1"]');
  assert.match(v1, /최초 계획/);
  assert.match(v1, /기준 A/);
  assert.match(v1, /600분/);
  assert.match(await page.textContent('#revision-list [data-version="2"]'), /기준 B.*|범위 확대/s);
});

test('C09~C17: 할 일 생성·수정·완료·완료 취소·삭제와 마감일·우선순위·태그·예상 시간', async () => {
  const rows = [
    ['[E2E] 알파', addDays(T, 3), 2, 'ml, 보안', 30],
    ['[E2E] 베타', addDays(T, -2), 1, 'ml', 90],       // 지연 대상
    ['[E2E] 감마', addDays(T, 3), 2, 'ops', 60],       // 알파와 마감·우선순위 동일 → 등록 순 tie-breaker
    ['[E2E] 델타', addDays(T, 1), 3, '', 45],
    ['[E2E] 엡실론', addDays(T, -1), 2, 'ops, 보안', 120],
    ['[E2E] 삭제대상', addDays(T, 5), 3, 'tmp', 10],
  ];
  for (const [title, due, pr, tags, est] of rows) {
    await fill('#todo-form', { title, due_date: due, priority: pr, tags, estimated_minutes: est });
    await submit('#todo-form');
    assert.match(await status(), /할 일 추가 저장됨/);
  }
  assert.equal(await page.locator('#todo-list li.item').count(), 6);
  const a = todoItem('[E2E] 알파');
  assert.match(await a.textContent(), new RegExp(`마감 ${addDays(T, 3)}`));
  assert.match(await a.textContent(), /우선순위 2 보통/);
  assert.match(await a.textContent(), /#ml.*#보안/s);
  assert.match(await a.textContent(), /예상 30분/);
  // 수정
  await a.locator('[data-action=edit]').click();
  await fill('#todo-form', { memo: '수정한 메모', estimated_minutes: 35 });
  await submit('#todo-form');
  assert.match(await todoItem('[E2E] 알파').textContent(), /수정한 메모.*예상 35분/s);
  // 완료 → 완료 취소
  await todoItem('[E2E] 델타').locator('[data-action=complete]').click(); await waitOk();
  assert.match(await todoItem('[E2E] 델타').locator('[data-field=status]').textContent(), /완료/);
  await todoItem('[E2E] 델타').locator('[data-action=reopen]').click(); await waitOk();
  assert.match(await todoItem('[E2E] 델타').locator('[data-field=status]').textContent(), /진행 중/);
  // 삭제
  await todoItem('[E2E] 삭제대상').locator('[data-action=delete]').click(); await waitOk();
  assert.equal(await todoItem('[E2E] 삭제대상').count(), 0);
  assert.equal(dialogs.at(-1).includes('삭제할까요'), true);
});

test('C18~C20: 검색·필터·표시된 기준대로 정렬(보조 기준 포함)', async () => {
  await page.fill('#todo-search', '감마');
  assert.deepEqual(await page.locator('#todo-list .title-line').allTextContents(), ['[E2E] 감마']);
  await page.fill('#todo-search', '보안'); // 태그 검색
  assert.deepEqual((await page.locator('#todo-list .title-line').allTextContents()).sort(), ['[E2E] 알파', '[E2E] 엡실론'].sort());
  await page.fill('#todo-search', '');
  await page.selectOption('#todo-filter-status', 'overdue');
  assert.deepEqual(await page.locator('#todo-list .title-line').allTextContents(), ['[E2E] 베타', '[E2E] 엡실론']);
  await page.selectOption('#todo-filter-status', 'all');
  await page.selectOption('#todo-filter-tag', 'ops');
  assert.deepEqual(await page.locator('#todo-list .title-line').allTextContents(), ['[E2E] 엡실론', '[E2E] 감마']);
  await page.selectOption('#todo-filter-tag', 'all');
  await page.selectOption('#todo-filter-priority', '1');
  assert.deepEqual(await page.locator('#todo-list .title-line').allTextContents(), ['[E2E] 베타']);
  await page.selectOption('#todo-filter-priority', 'all');
  await page.selectOption('#todo-sort', 'due');
  assert.match(await page.textContent('#sort-note'), /정렬 기준: 마감일 빠른 순 → 같으면 우선순위 높은 순 → 등록 순 → ID 순/);
  const byDue = await page.locator('#todo-list .title-line').allTextContents();
  assert.deepEqual(byDue, ['[E2E] 베타', '[E2E] 엡실론', '[E2E] 델타', '[E2E] 알파', '[E2E] 감마']);
  await page.reload(); await waitOk();
  assert.deepEqual(await page.locator('#todo-list .title-line').allTextContents(), byDue, '새로고침해도 같은 순서');
  await page.selectOption('#todo-sort', 'estimate');
  assert.deepEqual(await page.locator('#todo-list .title-line').allTextContents(), ['[E2E] 엡실론', '[E2E] 베타', '[E2E] 감마', '[E2E] 델타', '[E2E] 알파']);
  await page.selectOption('#todo-sort', 'priority');
  assert.deepEqual(await page.locator('#todo-list .title-line').allTextContents(), ['[E2E] 베타', '[E2E] 엡실론', '[E2E] 알파', '[E2E] 감마', '[E2E] 델타']);
  await page.selectOption('#todo-sort', 'due');
});

test('C21·C22: 완료 버튼을 연속 두 번 눌러도 완료 기록 1건, 완료 수 +1', async () => {
  const before = await snap();
  const planId = await page.textContent('[data-field=id]');
  const doneBefore = before.plans.find((p) => p.id === planId).stats.done_count;
  const gammaId = await todoItem('[E2E] 감마').getAttribute('data-todo-id');
  const evBefore = before.completion_events.filter((e) => e.todo_id === gammaId).length;
  // 버튼 비활성화가 아니라 서버 멱등성으로 막는지 보기 위해, 렌더링 전에 같은 버튼을 두 번 클릭한다.
  const reqs = [];
  page.on('request', (r) => { if (r.url().endsWith('/pds_complete_todo')) reqs.push(r.postData()); });
  await todoItem('[E2E] 감마').locator('[data-action=complete]').evaluate((b) => { b.click(); b.click(); });
  await page.waitForFunction(() => /완료 처리 저장됨|중복/.test(document.querySelector('#status').textContent));
  await page.waitForTimeout(300);
  assert.equal(reqs.length, 2, '요청은 실제로 두 번 전송됨');
  assert.equal(JSON.parse(reqs[0]).p_idempotency_key, JSON.parse(reqs[1]).p_idempotency_key);
  const after = await snap();
  assert.equal(after.completion_events.filter((e) => e.todo_id === gammaId).length - evBefore, 1);
  assert.equal(after.plans.find((p) => p.id === planId).stats.done_count - doneBefore, 1);
  await page.reload(); await waitOk();
  assert.equal(await page.textContent('[data-stat=done] .num'), String(doneBefore + 1));
});

test('C23~C27: 실행 기록(시작·종료·소요·막힘) 저장, 할 일 연결 표시, 계획 값 불변', async () => {
  const planBefore = (await snap()).plans.find((p) => p.title === '[E2E] 계획');
  const add = async (todo, s, e, m, blocker = '') => {
    await ensureOpen('#exec-form');
    await page.selectOption('#exec-form [name=todo_id]', { label: todo });
    await fill('#exec-form', { started_at: s, ended_at: e });
    await page.locator('#exec-form [name=ended_at]').dispatchEvent('change');
    await fill('#exec-form', { actual_minutes: m, blocker });
    await submit('#exec-form');
  };
  await add('[E2E] 베타', `${addDays(T, -3)}T09:00`, `${addDays(T, -3)}T10:40`, 100, '데이터셋 라이선스 확인 지연');
  assert.match(await status(), /실행 기록 저장됨/);
  await add('[E2E] 감마', `${addDays(T, -1)}T23:30`, `${T}T00:20`, 50); // 서울 자정 넘김
  await add('[E2E] 베타', `${addDays(T, -2)}T14:00`, `${addDays(T, -2)}T14:30`, 25, '환경 오류');
  const items = page.locator('#exec-list li.item');
  assert.equal(await items.count(), 3);
  const first = await items.first().textContent(); // 최신 시작 순
  assert.match(first, /연결된 할 일: \[E2E\] 감마/);
  assert.match(first, /실제 50분/);
  assert.match(first, /막힘 없음/);
  const s = await snap();
  const ex = s.executions.find((e) => e.actual_minutes === 100);
  assert.equal(new Date(ex.started_at).toISOString(), new Date(`${addDays(T, -3)}T09:00:00+09:00`).toISOString(), '서울 시각으로 저장');
  assert.equal(ex.blocker, '데이터셋 라이선스 확인 지연');
  const planAfter = s.plans.find((p) => p.id === planBefore.id);
  for (const k of ['estimated_minutes', 'success_criteria', 'start_date', 'end_date', 'priority', 'version']) assert.deepEqual(planAfter[k], planBefore[k]);
  // 잘못된 입력은 오류로 보이고 저장되지 않는다
  await page.selectOption('#exec-form [name=todo_id]', { label: '[E2E] 알파' });
  await fill('#exec-form', { started_at: `${T}T10:00`, ended_at: `${T}T09:00`, actual_minutes: 10 });
  await page.click('#exec-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#status').classList.contains('error'));
  assert.match(await status(), /실행 기록 실패: 종료 시각은 시작 시각보다 뒤여야/);
  assert.equal((await snap()).executions.length, 3);
});

test('C28~C32·C83: 회고 집계 값과 근거 기록 이동', async () => {
  await page.reload(); await waitOk();
  const num = async (k) => page.textContent(`[data-stat=${k}] .num`);
  assert.equal(await num('planned'), '5');
  assert.equal(await num('done'), '1');      // 감마
  assert.equal(await num('overdue'), '2');   // 베타, 엡실론 (미완료 + 마감 < 서울 오늘)
  assert.equal(await num('blocked'), '1');   // 베타 (막힘 2건이어도 1)
  assert.equal(await num('estimated'), '350분'); // 35+90+60+45+120
  assert.equal(await num('actual'), '175분');    // 100+50+25
  assert.equal(await num('diff'), '-175분');
  await page.click('[data-stat=overdue]');
  assert.match(await page.textContent('#todo-evidence'), /근거: 지연 수.*2건/s);
  assert.deepEqual(await page.locator('#todo-list .title-line').allTextContents(), ['[E2E] 베타', '[E2E] 엡실론']);
  await page.click('[data-stat=blocked]');
  assert.deepEqual(await page.locator('#todo-list .title-line').allTextContents(), ['[E2E] 베타']);
  await page.click('[data-stat=actual]');
  assert.match(await page.textContent('#exec-evidence'), /실제 시간.*3건/s);
  assert.equal(await page.locator('#exec-list li.item').count(), 3);
  await page.click('#todo-evidence button');
  assert.equal(await page.locator('#todo-list li.item').count(), 5);
});

test('C33: 회고 개선점 → 다음 계획에 반영', async () => {
  await fill('#review-form', { improvement: '외부 의존 확인을 첫 30분 안에 끝낸다' });
  await submit('#review-form');
  await page.click('[data-action=make-next]');
  assert.match(await page.textContent('#plan-form-improvement'), /외부 의존 확인을 첫 30분 안에 끝낸다/);
  await fill('#plan-form', { title: '[E2E] 다음 계획', start_date: addDays(T, 13), end_date: addDays(T, 20), priority: 2, success_criteria: '기준 C', estimated_minutes: 300 });
  await submit('#plan-form');
  assert.equal(await page.textContent('[data-field=title]'), '[E2E] 다음 계획');
  assert.match(await page.textContent('[data-field=applied_improvement]'), /외부 의존 확인을 첫 30분 안에 끝낸다/);
  await page.click('[data-field=applied_improvement] button');
  assert.match(await page.textContent('[data-action=open-next]'), /반영된 다음 계획: \[E2E\] 다음 계획/);
});

test('C57: 스크립트 형태 문자열이 실행되지 않고 텍스트로 보인다', async () => {
  const xss = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>`;
  await fill('#todo-form', { title: xss, due_date: addDays(T, 2), priority: 3, tags: '<b>x</b>', estimated_minutes: 5 });
  await submit('#todo-form');
  await page.reload(); await waitOk();
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.equal(await page.locator('#todo-list img, #todo-list script, #todo-list b').count(), 0);
  assert.ok((await page.locator('#todo-list .title-line').allTextContents()).includes(xss));
  assert.equal(dialogs.filter((d) => !d.includes('삭제할까요')).length, 0);
});

test('C35·C36: 새로고침·새 브라우저 컨텍스트에서 같은 값 복원, 전체 JSON 한 파일 내보내기', async () => {
  const before = await snap();
  const ctx2 = await browser.newContext({ acceptDownloads: true, timezoneId: 'Asia/Seoul' });
  const p2 = await ctx2.newPage();
  await p2.goto(`${srv.url}#plan=${before.plans[0].id}`);
  await p2.waitForFunction(() => /불러옴/.test(document.querySelector('#status').textContent));
  assert.equal(await p2.textContent('[data-field=id]'), before.plans[0].id);
  assert.equal(await p2.textContent('[data-field=period]'), `${before.plans[0].start_date} ~ ${before.plans[0].end_date}`);
  assert.equal(await p2.textContent('[data-field=estimated_minutes]'), `${before.plans[0].estimated_minutes}분`);
  const [dl] = await Promise.all([p2.waitForEvent('download'), p2.click('#export-btn')]);
  const file = await dl.path();
  const data = JSON.parse(await readFile(file, 'utf8'));
  assert.match(dl.suggestedFilename(), /^pds-export-.*\.json$/);
  assert.equal(data.schema, 'pds-schema-v2');
  assert.equal(data.time_unit, 'minutes');
  for (const k of ['plans', 'plan_revisions', 'todos', 'completion_events', 'executions', 'reviews']) assert.ok(data[k].length > 0, k);
  assert.deepEqual(data.todos.map((t) => [t.id, t.due_date, t.estimated_minutes, t.status]), before.todos.map((t) => [t.id, t.due_date, t.estimated_minutes, t.status]));
  await ctx2.close();
});

test('UI: 데스크톱 2열(할 일 오른쪽)·남은 일/완료한 일 분리·ID 접힘·가로 스크롤 없음', async () => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(srv.url); await waitOk();
  const plan = await page.locator('#plan-section').boundingBox();
  const todo = await page.locator('#todo-section').boundingBox();
  assert.ok(todo.x > plan.x + plan.width - 1, '할 일 영역이 오른쪽');
  assert.ok(await page.isVisible('#public-notice'), '필수 안내는 첫 화면에 보임');
  assert.equal(await page.isVisible('[data-field=id]'), false, '계획 ID 는 기본으로 접힘');
  await page.click('#plan-more > summary');
  assert.ok(await page.isVisible('[data-field=id]'), '상세를 펼치면 ID 확인 가능');
  assert.equal(await page.isVisible('#todo-form'), false, '할 일 입력 폼은 접힘');
  assert.ok(await page.isVisible('#todo-add > summary'), '할 일 추가 버튼은 보임');
  assert.equal(await page.textContent('#todo-open-title'), '남은 일');
  assert.equal(await page.textContent('#todo-done-title'), '완료한 일');
  // 할 일 섹션 안에서 남은 일·완료한 일이 각각 별도 영역(div)
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('#todo-section .todo-group')].map((g) => g.id).join(',')), 'todo-open-group,todo-done-group');
  assert.ok(await page.evaluate(() => document.querySelector('#todo-open-list').closest('.todo-group').id === 'todo-open-group' && document.querySelector('#todo-done-list').closest('.todo-group').id === 'todo-done-group'));
  const doneTitles = await page.locator('#todo-done-list .title-line').allTextContents();
  assert.ok(doneTitles.includes('[E2E] 감마'), '완료한 할 일은 완료 섹션');
  assert.ok(!(await page.locator('#todo-open-list .title-line').allTextContents()).includes('[E2E] 감마'));
  const counts = await page.evaluate(() => [document.querySelectorAll('#todo-open-list li.item').length, document.querySelectorAll('#todo-done-list li.item').length]);
  assert.equal(await page.textContent('#todo-open-count'), String(counts[0]));
  assert.equal(await page.textContent('#todo-done-count'), String(counts[1]));
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).wordBreak), 'keep-all');
  assert.ok(!/\bnull\b|undefined/.test(await page.textContent('#plan-detail')), '빈 값이 글자로 찍히지 않음');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), '가로 스크롤 없음');
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/t06-ui-local-desktop.png`, fullPage: true });
});

test('UI: 모바일 폭 한 열·가로 스크롤 없음', async () => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(srv.url); await waitOk();
  const plan = await page.locator('#plan-section').boundingBox();
  const todo = await page.locator('#todo-section').boundingBox();
  assert.ok(todo.y >= plan.y + plan.height - 1, '좁은 화면에서는 아래로 쌓임');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), '가로 스크롤 없음');
  const overflow = await page.evaluate(() => [...document.querySelectorAll('.card, .item, .chip, .callout')].filter((e) => e.scrollWidth > e.clientWidth + 1).length);
  assert.equal(overflow, 0, '칸 밖으로 넘치는 요소 없음');
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/t06-ui-local-mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('콘솔 오류 없음(의도한 400 응답 제외)', async () => {
  const unexpected = consoleErrors.filter((e) => !/status of 400/.test(e));
  assert.deepEqual(unexpected, []);
});
