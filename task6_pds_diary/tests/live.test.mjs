// 실제 Supabase(원격 DB) 검증. 합성 검증용 계획 1개를 만들고, 만든 ID 를 live-created-ids.json 에 기록한다.
// 실행: PDS_URL=https://<ref>.supabase.co PDS_KEY=<publishable key> node --test live.test.mjs
// 주의: 공개 DB 에 "[검증용]" 데이터가 남는다. 정리는 기록된 ID 로만 한다(cleanup SQL 은 별도 승인).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const URL_ = process.env.PDS_URL, KEY = process.env.PDS_KEY;
const created = { plans: [], todos: [] };
const H = { apikey: KEY, 'Content-Type': 'application/json' };
async function rpc(fn, body = {}) {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(j?.message || `HTTP ${r.status}`), { status: r.status });
  return j;
}
const save = () => writeFile(new URL('./live-created-ids.json', import.meta.url), JSON.stringify(created, null, 2));

test('원격: 쓰기는 RPC 로만, 테이블 직접 쓰기는 거부', { skip: !URL_ || !KEY }, async () => {
  for (const [method, path, body] of [
    ['POST', 'pds_plans', { title: 'x' }],
    ['POST', 'pds_plan_revisions', { title: 'x' }],
    ['PATCH', 'pds_todos?id=not.is.null', { title: 'x' }],
    ['DELETE', 'pds_executions?id=not.is.null', null],
    ['POST', 'pds_completion_events', { todo_id: randomUUID(), idempotency_key: randomUUID() }],
  ]) {
    const r = await fetch(`${URL_}/rest/v1/${path}`, { method, headers: { ...H, Prefer: 'return=minimal' }, body: body ? JSON.stringify(body) : undefined });
    assert.ok([401, 403, 404, 405].includes(r.status), `${method} ${path} → ${r.status}`);
  }
  const r = await fetch(`${URL_}/rest/v1/rpc/pds_clean_text`, { method: 'POST', headers: H, body: JSON.stringify({ p: 'a', p_field: 'b', p_min: 0, p_max: 1 }) });
  assert.ok(r.status >= 400, '내부 도우미 함수는 호출 불가');
});

test('원격: 저장·재조회·병렬 연속 완료 1건·이력 보존·스크립트 문자열', { skip: !URL_ || !KEY }, async () => {
  const plan = await rpc('pds_create_plan', { p_title: '[검증용] 자동 점검 계획', p_description: '배포 검증용 합성 데이터', p_start_date: '2026-11-07',
    p_end_date: '2026-11-08', p_priority: 3, p_success_criteria: '검증 통과', p_estimated_minutes: 10 });
  created.plans.push(plan); await save();
  await rpc('pds_update_plan', { p_plan_id: plan, p_expected_version: 1, p_title: '[검증용] 자동 점검 계획', p_description: '배포 검증용 합성 데이터',
    p_start_date: '2026-11-07', p_end_date: '2026-11-08', p_priority: 3, p_success_criteria: '검증 통과(수정)', p_estimated_minutes: 12, p_change_note: '검증' });
  const xss = '<img src=x onerror=alert(1)>[검증용]';
  const todo = await rpc('pds_create_todo', { p_plan_id: plan, p_title: xss, p_memo: '', p_due_date: '2026-11-08', p_priority: 3, p_tags: ['검증용'], p_estimated_minutes: 5 });
  created.todos.push(todo); await save();
  const key = randomUUID();
  const results = await Promise.all([1, 2, 3].map(() => rpc('pds_complete_todo', { p_todo_id: todo, p_idempotency_key: key })));
  assert.equal(results.filter((r) => r.created).length, 1, '병렬 3회 중 1회만 생성');
  const s = await rpc('pds_snapshot');
  assert.equal(s.completion_events.filter((e) => e.todo_id === todo).length, 1);
  assert.equal(s.todos.find((t) => t.id === todo).title, xss);
  const revs = s.plan_revisions.filter((r) => r.plan_id === plan);
  assert.deepEqual(revs.map((r) => [r.version, r.success_criteria, r.estimated_minutes]), [[1, '검증 통과', 10], [2, '검증 통과(수정)', 12]]);
  const p = s.plans.find((x) => x.id === plan);
  assert.equal(p.stats.done_count, 1);
  assert.equal(p.start_date, '2026-11-07');
});
