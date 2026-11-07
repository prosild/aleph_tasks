// T06 DB 계약 테스트: db/001_pds_schema.sql 을 PGlite 에 적용하고 anon 역할의 RPC 로 검증한다.
// 실행: npm run test:db   (tests 폴더)
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDb } from './pg.mjs';

let rpc, asAnon, db;
before(async () => { ({ rpc, asAnon, db } = await createDb()); });

const seoulToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const addDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const planArgs = (o = {}) => ({ p_title: '[TEST] 계획', p_description: '설명', p_start_date: '2026-11-01', p_end_date: '2026-11-19',
  p_priority: 1, p_success_criteria: '성공 기준', p_estimated_minutes: 600, ...o });
const todoArgs = (planId, o = {}) => ({ p_plan_id: planId, p_title: '[TEST] 할 일', p_memo: '', p_due_date: '2026-11-10',
  p_priority: 2, p_tags: ['mlops'], p_estimated_minutes: 60, ...o });
const snap = () => rpc('pds_snapshot');
const findPlan = async (id) => (await snap()).plans.find((p) => p.id === id);
const findTodo = async (id) => (await snap()).todos.find((t) => t.id === id);
async function rejects(promise, re) {
  await assert.rejects(promise, (e) => { assert.match(e.message, re); return true; });
}

test('C04~C07: 계획에 기간·우선순위·성공 기준·예상 시간이 저장된다', async () => {
  const id = await rpc('pds_create_plan', planArgs());
  const p = await findPlan(id);
  assert.equal(p.start_date, '2026-11-01');
  assert.equal(p.end_date, '2026-11-19');
  assert.equal(p.priority, 1);
  assert.equal(p.success_criteria, '성공 기준');
  assert.equal(p.estimated_minutes, 600);
  assert.equal(p.version, 1);
});

test('C08: 계획을 수정해도 최초 계획이 이력으로 보존되고 ID는 유지된다', async () => {
  const id = await rpc('pds_create_plan', planArgs({ p_title: '원래 제목', p_estimated_minutes: 300 }));
  const v2 = await rpc('pds_update_plan', { p_plan_id: id, p_expected_version: 1, ...strip(planArgs({ p_title: '수정 제목', p_estimated_minutes: 420 })), p_change_note: '범위 조정' });
  assert.equal(v2, 2);
  // 내용이 같으면 새 이력을 만들지 않는다
  const same = await rpc('pds_update_plan', { p_plan_id: id, p_expected_version: 2, ...strip(planArgs({ p_title: '수정 제목', p_estimated_minutes: 420 })) });
  assert.equal(same, 2);
  // 오래된 버전으로 수정하면 거부 (덮어쓰기 방지)
  await rejects(rpc('pds_update_plan', { p_plan_id: id, p_expected_version: 1, ...strip(planArgs({ p_title: 'x' })) }), /먼저 수정/);
  const s = await snap();
  const revs = s.plan_revisions.filter((r) => r.plan_id === id);
  assert.deepEqual(revs.map((r) => r.version), [1, 2]);
  assert.equal(revs[0].title, '원래 제목');
  assert.equal(revs[0].estimated_minutes, 300);
  assert.equal(revs[1].title, '수정 제목');
  assert.equal(revs[1].change_note, '범위 조정');
  const p = s.plans.find((x) => x.id === id);
  assert.equal(p.title, '수정 제목');
  assert.equal(p.version, 2);
  // 이력은 DB 트리거로 변경 불가 (소유자 권한이어도)
  await rejects(db.query(`update public.pds_plan_revisions set title = 'x' where plan_id = $1`, [id]), /변경할 수 없습니다/);
});

function strip(a) { const { p_title, p_description, p_start_date, p_end_date, p_priority, p_success_criteria, p_estimated_minutes } = a;
  return { p_title, p_description, p_start_date, p_end_date, p_priority, p_success_criteria, p_estimated_minutes }; }

test('C09~C17: 할 일 생성·수정·완료·완료 취소·삭제 및 마감일·우선순위·태그·예상 시간 저장', async () => {
  const plan = await rpc('pds_create_plan', planArgs());
  const id = await rpc('pds_create_todo', todoArgs(plan, { p_title: '처음', p_tags: [' 보안 ', 'mlops', '보안', ''] }));
  let t = await findTodo(id);
  assert.equal(t.title, '처음');
  assert.equal(t.due_date, '2026-11-10');
  assert.equal(t.priority, 2);
  assert.deepEqual(t.tags, ['보안', 'mlops']);
  assert.equal(t.estimated_minutes, 60);
  await rpc('pds_update_todo', { p_todo_id: id, p_title: '수정됨', p_memo: '메모', p_due_date: '2026-11-12', p_priority: 1, p_tags: ['ai'], p_estimated_minutes: 90 });
  t = await findTodo(id);
  assert.equal(t.title, '수정됨');
  assert.equal(t.due_date, '2026-11-12');
  assert.equal(t.priority, 1);
  assert.deepEqual(t.tags, ['ai']);
  assert.equal(t.estimated_minutes, 90);
  const c = await rpc('pds_complete_todo', { p_todo_id: id, p_idempotency_key: randomUUID() });
  assert.equal(c.created, true);
  assert.equal((await findTodo(id)).status, 'done');
  const r = await rpc('pds_reopen_todo', { p_todo_id: id });
  assert.equal(r.changed, true);
  t = await findTodo(id);
  assert.equal(t.status, 'open');
  assert.equal(t.completed_at, null);
  await rpc('pds_delete_todo', { p_todo_id: id });
  t = await findTodo(id);
  assert.ok(t.deleted_at, '삭제 표시가 남는다');
  await rejects(rpc('pds_update_todo', { p_todo_id: id, p_title: 'x', p_memo: '', p_due_date: '2026-11-12', p_priority: 1, p_tags: [], p_estimated_minutes: 1 }), /삭제/);
  const stats = await rpc('pds_plan_stats', { p_plan_id: plan });
  assert.equal(stats.planned_count, 0, '삭제한 할 일은 집계에서 빠진다');
});

test('C21·C22: 완료를 연속 두 번 요청해도 완료 기록 1건, 완료 수 1 증가', async () => {
  const plan = await rpc('pds_create_plan', planArgs());
  const id = await rpc('pds_create_todo', todoArgs(plan));
  const before = (await rpc('pds_plan_stats', { p_plan_id: plan })).done_count;
  const key = randomUUID();
  const [a, b] = await Promise.all([
    rpc('pds_complete_todo', { p_todo_id: id, p_idempotency_key: key }),
    rpc('pds_complete_todo', { p_todo_id: id, p_idempotency_key: key }),
  ]);
  assert.deepEqual([a.created, b.created].sort(), [false, true]);
  // 다른 키로 다시 눌러도(새로 그린 버튼) 이미 완료 상태라 새 기록이 생기지 않는다
  const c = await rpc('pds_complete_todo', { p_todo_id: id, p_idempotency_key: randomUUID() });
  assert.equal(c.created, false);
  assert.equal(c.reason, 'already_done');
  const s = await snap();
  assert.equal(s.completion_events.filter((e) => e.todo_id === id).length, 1);
  const after = (await rpc('pds_plan_stats', { p_plan_id: plan })).done_count;
  assert.equal(after - before, 1);
  // DB 유니크 제약 자체도 중복을 막는다
  await rejects(db.query(`insert into public.pds_completion_events (todo_id, idempotency_key) values ($1, $2)`, [id, randomUUID()]), /duplicate key|unique/);
  // 다른 할 일에 같은 키 사용 거부
  const other = await rpc('pds_create_todo', todoArgs(plan));
  await rejects(rpc('pds_complete_todo', { p_todo_id: other, p_idempotency_key: key }), /다른 할 일/);
  // 취소 후 의도적 재완료는 가능, 유효 완료는 여전히 1건
  await rpc('pds_reopen_todo', { p_todo_id: id });
  const again = await rpc('pds_complete_todo', { p_todo_id: id, p_idempotency_key: randomUUID() });
  assert.equal(again.created, true);
  const ev = (await snap()).completion_events.filter((e) => e.todo_id === id);
  assert.equal(ev.length, 2);
  assert.equal(ev.filter((e) => e.undone_at === null).length, 1);
  assert.equal((await rpc('pds_plan_stats', { p_plan_id: plan })).done_count, 1);
});

test('C23~C27: 실행 기록에 시작·종료·소요·막힘이 저장되고 계획 값은 그대로', async () => {
  const plan = await rpc('pds_create_plan', planArgs({ p_estimated_minutes: 777 }));
  const id = await rpc('pds_create_todo', todoArgs(plan, { p_estimated_minutes: 45 }));
  const before = await snap();
  const ex = await rpc('pds_add_execution', { p_todo_id: id, p_started_at: '2026-11-07T10:00:00+09:00',
    p_ended_at: '2026-11-07T11:30:00+09:00', p_actual_minutes: 80, p_blocker: '  의존성 충돌  ', p_note: '' });
  const s = await snap();
  const e = s.executions.find((x) => x.id === ex);
  assert.equal(new Date(e.started_at).toISOString(), '2026-11-07T01:00:00.000Z');
  assert.equal(new Date(e.ended_at).toISOString(), '2026-11-07T02:30:00.000Z');
  assert.equal(e.actual_minutes, 80);
  assert.equal(e.blocker, '의존성 충돌');
  assert.equal(e.todo_id, id);
  const pB = before.plans.find((p) => p.id === plan), pA = s.plans.find((p) => p.id === plan);
  for (const k of ['title', 'start_date', 'end_date', 'priority', 'success_criteria', 'estimated_minutes', 'version']) assert.deepEqual(pA[k], pB[k]);
  const tB = before.todos.find((t) => t.id === id), tA = s.todos.find((t) => t.id === id);
  for (const k of ['estimated_minutes', 'due_date', 'status', 'updated_at']) assert.deepEqual(tA[k], tB[k]);
  // 극단·잘못된 입력
  await rejects(rpc('pds_add_execution', { p_todo_id: id, p_started_at: '2026-11-07T11:00:00+09:00', p_ended_at: '2026-11-07T10:00:00+09:00', p_actual_minutes: 10 }), /종료 시각/);
  await rejects(rpc('pds_add_execution', { p_todo_id: id, p_started_at: '2026-11-07T10:00:00+09:00', p_ended_at: '2026-11-07T10:30:00+09:00', p_actual_minutes: 31 }), /1~30/);
  await rejects(rpc('pds_add_execution', { p_todo_id: id, p_started_at: '2026-11-07T10:00:00+09:00', p_ended_at: '2026-11-08T10:01:00+09:00', p_actual_minutes: 10 }), /24시간/);
  await rejects(rpc('pds_add_execution', { p_todo_id: randomUUID(), p_started_at: '2026-11-07T10:00:00+09:00', p_ended_at: '2026-11-07T10:30:00+09:00', p_actual_minutes: 5 }), /찾을 수 없/);
  // 막힘 사유가 공백뿐이면 막힘 없음(null)으로 저장
  const ex2 = await rpc('pds_add_execution', { p_todo_id: id, p_started_at: '2026-11-07T12:00:00+09:00', p_ended_at: '2026-11-07T12:20:00+09:00', p_actual_minutes: 20, p_blocker: '   ' });
  assert.equal((await snap()).executions.find((x) => x.id === ex2).blocker, null);
});

test('C28~C32: 회고 집계 = 미삭제 할 일 기준 계획·완료·지연(서울)·막힘·시간 합계와 차이', async () => {
  const today = seoulToday();
  const plan = await rpc('pds_create_plan', planArgs());
  const empty = await rpc('pds_plan_stats', { p_plan_id: plan });
  assert.deepEqual([empty.planned_count, empty.done_count, empty.overdue_count, empty.blocked_count, empty.estimated_minutes, empty.actual_minutes, empty.diff_minutes], [0, 0, 0, 0, 0, 0, 0]);
  const mk = (o) => rpc('pds_create_todo', todoArgs(plan, o));
  const a = await mk({ p_due_date: addDays(today, -1), p_estimated_minutes: 30 });  // 지연(미완료, 어제 마감)
  const b = await mk({ p_due_date: addDays(today, -3), p_estimated_minutes: 40 });  // 완료 → 지연 아님
  const c = await mk({ p_due_date: today, p_estimated_minutes: 50 });               // 오늘 마감 → 지연 아님
  const d = await mk({ p_due_date: addDays(today, -2), p_estimated_minutes: 999 }); // 삭제 → 제외
  await rpc('pds_complete_todo', { p_todo_id: b, p_idempotency_key: randomUUID() });
  await rpc('pds_add_execution', { p_todo_id: a, p_started_at: '2026-11-05T09:00:00+09:00', p_ended_at: '2026-11-05T10:00:00+09:00', p_actual_minutes: 60, p_blocker: '자료 부족' });
  await rpc('pds_add_execution', { p_todo_id: a, p_started_at: '2026-11-06T09:00:00+09:00', p_ended_at: '2026-11-06T09:10:00+09:00', p_actual_minutes: 10, p_blocker: '재발' });
  await rpc('pds_add_execution', { p_todo_id: b, p_started_at: '2026-11-06T13:00:00+09:00', p_ended_at: '2026-11-06T13:25:00+09:00', p_actual_minutes: 25 });
  await rpc('pds_add_execution', { p_todo_id: d, p_started_at: '2026-11-06T14:00:00+09:00', p_ended_at: '2026-11-06T15:00:00+09:00', p_actual_minutes: 60, p_blocker: '삭제됨' });
  await rpc('pds_delete_todo', { p_todo_id: d });
  const s = await rpc('pds_plan_stats', { p_plan_id: plan });
  assert.equal(s.seoul_today, today);
  assert.equal(s.planned_count, 3);
  assert.deepEqual(new Set(s.planned_todo_ids), new Set([a, b, c]));
  assert.equal(s.done_count, 1);
  assert.deepEqual(s.done_todo_ids, [b]);
  assert.equal(s.overdue_count, 1);
  assert.deepEqual(s.overdue_todo_ids, [a]);
  assert.equal(s.blocked_count, 1, '실행 기록이 2건이어도 할 일 1개로 센다');
  assert.deepEqual(s.blocked_todo_ids, [a]);
  assert.equal(s.estimated_minutes, 120);
  assert.equal(s.actual_minutes, 95);
  assert.equal(s.diff_minutes, -25);
  assert.equal(s.execution_ids.length, 3);
});

test('C30 보조: 서울 자정 경계에서 날짜 변환이 서울 기준이다', async () => {
  const r = await db.query(`select ((timestamptz '2026-11-06 14:59:59+00') at time zone 'Asia/Seoul')::date::text as before_midnight,
                                   ((timestamptz '2026-11-06 15:00:00+00') at time zone 'Asia/Seoul')::date::text as after_midnight`);
  assert.equal(r.rows[0].before_midnight, '2026-11-06');
  assert.equal(r.rows[0].after_midnight, '2026-11-07');
});

test('C33: 회고 개선점이 다음 계획에 연결·반영된다', async () => {
  const plan = await rpc('pds_create_plan', planArgs());
  await rpc('pds_create_todo', todoArgs(plan));
  const review = await rpc('pds_create_review', { p_plan_id: plan, p_improvement: '할 일을 90분 이하로 쪼갠다' });
  const next = await rpc('pds_create_plan', planArgs({ p_title: '다음 계획', p_source_review_id: review }));
  const s = await snap();
  const rv = s.reviews.find((r) => r.id === review);
  assert.equal(rv.stats.planned_count, 1, '회고 시점 집계 스냅샷 저장');
  const p = s.plans.find((x) => x.id === next);
  assert.equal(p.source_review_id, review);
  assert.equal(p.applied_improvement, '할 일을 90분 이하로 쪼갠다');
  assert.equal(s.plan_revisions.find((r) => r.plan_id === next && r.version === 1).applied_improvement, '할 일을 90분 이하로 쪼갠다');
  await rejects(rpc('pds_create_plan', planArgs({ p_source_review_id: randomUUID() })), /회고를 찾을 수 없/);
});

test('C34·C35·C36: 전체 스냅샷(내보내기)에 모든 테이블과 ID·날짜·단위가 그대로 담긴다', async () => {
  const s = await snap();
  assert.equal(s.schema, 'pds-schema-v2');
  assert.equal(s.time_unit, 'minutes');
  for (const k of ['plans', 'plan_revisions', 'todos', 'completion_events', 'executions', 'reviews']) assert.ok(Array.isArray(s[k]) && s[k].length > 0, k);
  const again = await snap();
  assert.deepEqual(again.plans.map((p) => [p.id, p.start_date, p.estimated_minutes]), s.plans.map((p) => [p.id, p.start_date, p.estimated_minutes]));
  assert.ok(s.todos.every((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.due_date)));
});

test('C57: 스크립트 형태 문자열은 변형 없이 텍스트 데이터로 저장된다', async () => {
  const xss = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>`;
  const plan = await rpc('pds_create_plan', planArgs({ p_title: xss.slice(0, 120) }));
  const id = await rpc('pds_create_todo', todoArgs(plan, { p_title: xss }));
  assert.equal((await findTodo(id)).title, xss);
});

test('입력 검증: 빈 값·범위 초과·뒤집힌 기간·잘못된 우선순위·과도한 태그', async () => {
  await rejects(rpc('pds_create_plan', planArgs({ p_title: '   ' })), /계획 제목: 값을 입력/);
  await rejects(rpc('pds_create_plan', planArgs({ p_title: 'x'.repeat(121) })), /120 자 이하/);
  await rejects(rpc('pds_create_plan', planArgs({ p_end_date: '2026-10-01' })), /종료일/);
  await rejects(rpc('pds_create_plan', planArgs({ p_priority: 4 })), /우선순위/);
  await rejects(rpc('pds_create_plan', planArgs({ p_estimated_minutes: -5 })), /예상 시간/);
  await rejects(rpc('pds_create_plan', planArgs({ p_estimated_minutes: 100001 })), /예상 시간/);
  await rejects(rpc('pds_create_plan', planArgs({ p_success_criteria: '' })), /성공 기준/);
  const plan = await rpc('pds_create_plan', planArgs());
  await rejects(rpc('pds_create_todo', todoArgs(plan, { p_tags: Array.from({ length: 11 }, (_, i) => `t${i}`) })), /10개 이하/);
  await rejects(rpc('pds_create_todo', todoArgs(plan, { p_tags: ['x'.repeat(31)] })), /30자 이하/);
  await rejects(rpc('pds_create_todo', todoArgs(plan, { p_due_date: null })), /마감일/);
  await rejects(rpc('pds_create_todo', todoArgs(randomUUID())), /계획을 찾을 수 없/);
  await rejects(rpc('pds_complete_todo', { p_todo_id: randomUUID(), p_idempotency_key: randomUUID() }), /찾을 수 없/);
});

test('권한: anon 은 테이블을 직접 쓰거나 이력을 바꿀 수 없고, 내부 함수도 호출할 수 없다', async () => {
  const plan = await rpc('pds_create_plan', planArgs());
  await rejects(asAnon(`insert into public.pds_plan_revisions (plan_id, version, title, description, start_date, end_date, priority, success_criteria, estimated_minutes) values ($1, 99, 'x', '', '2026-11-01', '2026-11-02', 1, 'x', 1)`, [plan]), /permission denied/);
  await rejects(asAnon(`update public.pds_plans set title = 'hacked' where id = $1`, [plan]), /permission denied/);
  await rejects(asAnon(`delete from public.pds_todos`), /permission denied/);
  await rejects(asAnon(`insert into public.pds_completion_events (todo_id, idempotency_key) select id, gen_random_uuid() from public.pds_todos limit 1`), /permission denied/);
  await rejects(asAnon(`select public.pds_clean_text('a', 'b', 0, 1)`), /permission denied/);
  const r = await asAnon(`select count(*)::int as n from public.pds_plans`);
  assert.ok(r.rows[0].n > 0, 'anon 읽기는 허용');
});
