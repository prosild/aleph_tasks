// C100 이관 SQL(db/102_migrate_t06_to_owner.sql) 로컬 시험: 합성 T06 기록 → 본인 계정 복사, 원본 불변, 중복·비회원 거절.
// 실행: supabase start 후 node --test migrate.test.mjs  (로컬 DB 전용)
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { localStatus, client, sql, APP_ROOT } from './stack.mjs';
import { newLocalUser } from './ui-auth.mjs';

const st = localStatus();
const c = client({ url: st.url, key: st.key });
const MIGRATE = readFileSync(path.join(APP_ROOT, 'db', '102_migrate_t06_to_owner.sql'), 'utf8');
const anon = async (fn, body) => { const r = await c.rpc(null, fn, body); assert.ok(r.status < 300, `${fn} ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const fingerprint = () => sql(`select string_agg(t || ':' || n || ':' || h, ' ' order by t) from (
  select 'plans' t, count(*) n, md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) h from public.pds_plans x
  union all select 'todos', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) from public.pds_todos x
  union all select 'executions', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) from public.pds_executions x
  union all select 'reviews', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) from public.pds_reviews x) s;`);
const run = (owner) => sql(MIGRATE.replaceAll('__OWNER_USER_ID__', owner));

let owner;
before(async () => {
  sql(`delete from public.pds7_plans where t06_source_id is not null;`); // 이전 로컬 시험의 이관분 정리(로컬 전용)
  // T06 공개 RPC(로그인 없음)로 합성 기록을 만든다(로컬 DB 전용)
  const plan = await anon('pds_create_plan', { p_title: '[합성] T06 계획', p_description: '', p_start_date: '2026-11-01', p_end_date: '2026-11-07', p_priority: 2, p_success_criteria: '합성', p_estimated_minutes: 60 });
  await anon('pds_update_plan', { p_plan_id: plan, p_expected_version: 1, p_title: '[합성] T06 계획 v2', p_description: '', p_start_date: '2026-11-01', p_end_date: '2026-11-07', p_priority: 2, p_success_criteria: '합성', p_estimated_minutes: 90, p_change_note: '합성' });
  const todo = await anon('pds_create_todo', { p_plan_id: plan, p_title: '[합성] 할 일', p_memo: '', p_due_date: '2026-11-03', p_priority: 1, p_tags: ['x'], p_estimated_minutes: 30 });
  await anon('pds_complete_todo', { p_todo_id: todo, p_idempotency_key: randomUUID() });
  await anon('pds_add_execution', { p_todo_id: todo, p_started_at: '2026-11-03T09:00:00+09:00', p_ended_at: '2026-11-03T09:40:00+09:00', p_actual_minutes: 40, p_blocker: '합성 막힘' });
  const review = await anon('pds_create_review', { p_plan_id: plan, p_improvement: '[합성] 개선점' });
  await anon('pds_create_plan', { p_title: '[합성] 다음 계획', p_description: '', p_start_date: '2026-11-08', p_end_date: '2026-11-10', p_priority: 2, p_success_criteria: '합성', p_estimated_minutes: 60, p_source_review_id: review });
  owner = newLocalUser('owner');
});

test('비회원(로그인 전) 계정으로는 이관하지 않는다', () => {
  assert.throws(() => run(owner.id), /T07 회원이 아닙니다/);
});

test('C100: 본인 계정으로 복사, 원본 지문 불변, 본인 화면 자료에 이관분, 중복 이관 거절', async () => {
  const s = await c.signIn(owner.email, owner.password);
  const tok = s.body.access_token;
  assert.equal((await c.rpc(tok, 'pds7_me')).status, 200); // T07 회원 등록
  const before = fingerprint();
  const out = run(owner.id);
  assert.match(out, /plans\|\d+\|[0-9a-f]{32}/);
  assert.equal(fingerprint(), before, 'T06 원본 불변');
  const snap = (await c.rpc(tok, 'pds7_snapshot')).body;
  const src = sql(`select count(*) from public.pds_plans;`);
  assert.equal(String(snap.plans.length), src);
  assert.equal(String(snap.todos.length), sql(`select count(*) from public.pds_todos;`));
  assert.equal(String(snap.executions.length), sql(`select count(*) from public.pds_executions;`));
  assert.equal(String(snap.reviews.length), sql(`select count(*) from public.pds_reviews;`));
  assert.equal(String(snap.plan_revisions.length), sql(`select count(*) from public.pds_plan_revisions;`));
  const next = snap.plans.find((p) => p.title === '[합성] 다음 계획');
  assert.ok(next.source_review_id && snap.reviews.some((r) => r.id === next.source_review_id), '회고→다음 계획 연결 유지');
  assert.ok(snap.plans.every((p) => p.t06_source_id === p.id));
  // 다른 계정은 이관분을 보지 못한다
  const other = newLocalUser('other');
  const o = await c.signIn(other.email, other.password);
  const os = (await c.rpc(o.body.access_token, 'pds7_snapshot')).body;
  assert.equal(os.plans.length, 0);
  // 두 번째 실행(같은·다른 계정 모두) 거절
  assert.throws(() => run(owner.id), /이미 이관된 기록/);
  assert.equal(fingerprint(), before);
});
