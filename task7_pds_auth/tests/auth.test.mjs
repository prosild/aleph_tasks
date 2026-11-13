// T07 인증·인가 통합 시험: 실제 GoTrue(Auth)·PostgREST(Data API)에 HTTP 요청을 보내고 응답을 기록한다.
//   로컬: supabase start 후  node --test auth.test.mjs          (관리자 SQL 확인 포함)
//   원격: T07_URL=… T07_KEY=<publishable> node --test auth.test.mjs  (HTTP 확인만, 시험 계정만 사용)
// 시험 계정은 make-test-users.mjs 로 만든 A·B(시험 전용)만 쓴다. 기록 파일의 토큰·비밀번호는 가린다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { target, client, sql, sqlJson, mask, redact, decodeJwt, loadAccounts, ACCOUNTS_FILE, APP_ROOT } from './stack.mjs';

const t = target();
const c = client(t);
const all = loadAccounts();
const acc = t.remote ? all?.remote : all?.local;
if (!acc) throw new Error(`시험 계정 파일이 없습니다: ${ACCOUNTS_FILE}`);
const PW = acc.password;
const NEW_PW = `${PW}-changed`;
let curPw = PW; // 비밀번호 변경 시험 뒤에는 NEW_PW
const local = !t.remote;
const evidence = [];
const EVIDENCE_FILE = process.env.T07_EVIDENCE_FILE || path.resolve(APP_ROOT, '..', '..', '..', '..', '..', `T07_AUTH_EVIDENCE_${t.remote ? 'REMOTE' : 'LOCAL'}${process.env.T07_RUN_LABEL ? `_${process.env.T07_RUN_LABEL}` : ''}.json`);
const secrets = [PW, NEW_PW];

function rec(id, title, res, note) {
  const request = redact(res.request, secrets);
  if (request.body && typeof request.body === 'object' && 'password' in request.body) request.body.password = '(가림)';
  evidence.push({ id, title, request, response: { status: res.status, body: redact(res.body, secrets) }, note });
  return res;
}
const ok = (r) => assert.ok(r.status >= 200 && r.status < 300, `expected 2xx, got ${r.status} ${JSON.stringify(r.body)}`);

const S = {}; // 세션·자료 ID
const day = '2026-11-08';
const planBody = (title) => ({ p_title: title, p_description: '시험 전용', p_start_date: day, p_end_date: day, p_priority: 2, p_success_criteria: '시험', p_estimated_minutes: 30 });
const todoBody = (planId, title) => ({ p_plan_id: planId, p_title: title, p_memo: '', p_due_date: day, p_priority: 2, p_tags: ['test'], p_estimated_minutes: 20 });

async function login(who, pw = curPw) {
  const r = await c.signIn(acc[who].email, pw);
  ok(r);
  return { token: r.body.access_token, refresh: r.body.refresh_token, user: r.body.user, raw: r };
}
// 소유자 본인이 보는 자기 자료(생성 시각 등 변하는 메타 제외)
async function ownView(token) {
  const r = await c.rpc(token, 'pds7_snapshot');
  ok(r);
  const { generated_at, seoul_today, ...rest } = r.body;
  for (const p of rest.plans) delete p.stats.seoul_today;
  return rest;
}

before(async () => {
  S.a = await login('a');
  S.b = await login('b');
  for (const who of ['a', 'b']) ok(await c.rpc(S[who].token, 'pds7_me'));
  // 각 계정에 자료를 넣는다(시험 전용 문구)
  for (const who of ['a', 'b']) {
    const tok = S[who].token;
    const plan = await c.rpc(tok, 'pds7_create_plan', planBody(`[시험] ${who.toUpperCase()} 계획`)); ok(plan);
    const todo = await c.rpc(tok, 'pds7_create_todo', todoBody(plan.body, `[시험] ${who.toUpperCase()} 할 일`)); ok(todo);
    const ex = await c.rpc(tok, 'pds7_add_execution', { p_todo_id: todo.body, p_started_at: `${day}T10:00:00+09:00`, p_ended_at: `${day}T10:20:00+09:00`, p_actual_minutes: 20, p_note: '시험' }); ok(ex);
    const rv = await c.rpc(tok, 'pds7_create_review', { p_plan_id: plan.body, p_improvement: '시험 개선점' }); ok(rv);
    S[who].plan = plan.body; S[who].todo = todo.body; S[who].exec = ex.body; S[who].review = rv.body;
  }
  evidence.push({ id: 'setup', title: '시험 계정 A·B 에 각각 계획·할 일·실행·회고 1건씩 저장(비밀번호 미기재)',
    accounts: { a: acc.a.email, b: acc.b.email }, ids: { a: { plan: S.a.plan, todo: S.a.todo }, b: { plan: S.b.plan, todo: S.b.todo } } });
});

after(() => {
  writeFileSync(EVIDENCE_FILE, JSON.stringify({ target: t.remote ? 'remote' : 'local', url: t.url, generated_at: new Date().toISOString(), evidence }, null, 2));
});

test('C97·C124: 로그인 없이 자료 요청 → 401 (RPC·테이블 직접)', async () => {
  const r1 = rec('C124-rpc', '로그인 없이 내 자료 목록(RPC) 요청', await c.rpc(null, 'pds7_snapshot'));
  assert.equal(r1.status, 401);
  const r2 = rec('C124-rest', '로그인 없이 테이블 직접 요청', await c.rest(null, 'GET', `pds7_todos?select=*`));
  assert.equal(r2.status, 401);
  assert.ok(!JSON.stringify(r2.body).includes(S.a.todo));
});

test('C99: 비밀번호만 틀림 / 없는 아이디 → 같은 응답', async () => {
  const wrong = rec('C99-wrong-pw', '있는 이메일 + 틀린 비밀번호', await c.signIn(acc.a.email, 'Wrong-password-123'));
  const none = rec('C99-no-user', '없는 이메일', await c.signIn(`t07-nobody-${randomUUID().slice(0, 8)}@example.com`, 'Wrong-password-123'));
  assert.equal(wrong.status, none.status);
  assert.deepEqual(wrong.body, none.body);
});

test('C98: 같은 이메일로 다시 가입해도 새 계정이 생기지 않는다', async () => {
  const r = rec('C98-dup-signup', '이미 있는 이메일로 가입 요청', await c.signUp(acc.a.email, `Other-${randomUUID()}`));
  assert.ok(!r.body?.access_token, '중복 가입에 세션이 발급되면 안 됨');
  const again = await c.signIn(acc.a.email, PW); // 기존 비밀번호 그대로 동작, 같은 사용자
  ok(again);
  assert.equal(again.body.user.id, S.a.user.id);
  if (local) assert.equal(sql(`select count(*) from auth.users where email = :'e';`, { e: acc.a.email }), '1');
});

test('C105·C106·C111·C112: 로그인 응답에 비밀번호 원문 없음, 토큰은 본문(헤더용)으로만, 만료 1시간', async () => {
  const r = rec('C105-login', '로그인 요청·응답(비밀번호·토큰 가림)', S.a.raw);
  assert.ok(!JSON.stringify(r.body).includes(PW));
  const claims = decodeJwt(S.a.token);
  assert.ok(claims.session_id);
  assert.equal(claims.exp - claims.iat, 3600);
  evidence.push({ id: 'C111-exp', title: 'access token 만료', claims: { iat: claims.iat, exp: claims.exp, lifetime_seconds: claims.exp - claims.iat, session_id: mask(claims.session_id) } });
  if (local) {
    const logs = execFileSync('docker', ['logs', 'supabase_auth_task7_pds_auth'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.ok(!logs.includes(PW), 'Auth 서버 로그에 비밀번호 원문이 있으면 안 됨');
    evidence.push({ id: 'C106-logs', title: '로컬 Auth 서버 로그에서 비밀번호 원문 검색', result: '0건' });
  }
});

test('C117~C122: 다른 계정 자료 읽기·수정·삭제 → 양방향 모두 404, 반대편 자료 값 불변', async () => {
  for (const [me, other] of [['b', 'a'], ['a', 'b']]) {
    const tok = S[me].token;
    const o = S[other];
    const before = await ownView(o.token);
    const tag = `${me.toUpperCase()}→${other.toUpperCase()}`;
    const attempts = [
      ['read', 'pds7_get_todo', { p_todo_id: o.todo }],
      ['update', 'pds7_update_todo', { p_todo_id: o.todo, p_title: '남이 고침', p_memo: '', p_due_date: day, p_priority: 1, p_tags: [], p_estimated_minutes: 1 }],
      ['delete', 'pds7_delete_todo', { p_todo_id: o.todo }],
      ['update-plan', 'pds7_update_plan', { p_plan_id: o.plan, p_expected_version: 1, ...planBody('남이 고침') }],
      ['delete-plan', 'pds7_delete_plan', { p_plan_id: o.plan }],
      ['complete', 'pds7_complete_todo', { p_todo_id: o.todo, p_idempotency_key: randomUUID() }],
      ['add-exec', 'pds7_add_execution', { p_todo_id: o.todo, p_started_at: `${day}T11:00:00+09:00`, p_ended_at: `${day}T11:10:00+09:00`, p_actual_minutes: 10 }],
      ['add-todo', 'pds7_create_todo', todoBody(o.plan, '남의 계획에 추가')],
      ['review', 'pds7_create_review', { p_plan_id: o.plan, p_improvement: '남의 계획 회고' }],
      ['plan-from-review', 'pds7_create_plan', { ...planBody('남의 회고 사용'), p_source_review_id: o.review }],
    ];
    for (const [kind, fn, body] of attempts) {
      const r = rec(`C117-121-${tag}-${kind}`, `${tag} ${kind}`, await c.rpc(tok, fn, body));
      assert.equal(r.status, 404, `${tag} ${kind} → ${r.status} ${JSON.stringify(r.body)}`);
    }
    const afterView = await ownView(o.token);
    assert.deepEqual(afterView, before, `${tag}: 반대편 자료가 바뀌면 안 됨`);
    evidence.push({ id: `C122-${tag}`, title: `${tag} 거절 앞뒤 반대편 자료(건수·값) 비교`,
      before_counts: Object.fromEntries(['plans', 'todos', 'executions', 'reviews'].map((k) => [k, before[k].length])),
      after_counts: Object.fromEntries(['plans', 'todos', 'executions', 'reviews'].map((k) => [k, afterView[k].length])),
      values_equal: true });
  }
});

test('C123·C125: 주소·헤더·본문에 다른 계정을 적어도 내 자료만, 목록에 남의 자료 없음', async () => {
  const aId = S.a.user.id;
  const header = rec('C123-header', '헤더에 다른 계정 ID(X-User-Id) 추가', await c.rpc(S.b.token, 'pds7_snapshot', {}, { 'X-User-Id': aId }));
  ok(header);
  const txt = JSON.stringify(header.body);
  for (const id of [S.a.plan, S.a.todo, S.a.exec, S.a.review]) assert.ok(!txt.includes(id), '남의 자료가 섞이면 안 됨');
  assert.ok(txt.includes(S.b.todo));
  rec('C125-list', 'B 목록(RPC) 응답에 A 자료 없음', header, `A의 ID ${[S.a.plan, S.a.todo].map(mask).join(', ')} 포함 여부: 없음`);

  const body = rec('C123-body', '본문에 다른 계정 user_id 추가', await c.rpc(S.b.token, 'pds7_snapshot', { user_id: aId }));
  assert.ok([400, 404].includes(body.status));
  assert.ok(!JSON.stringify(body.body).includes(S.a.todo));

  const addr = rec('C123-address', '주소(쿼리)에 다른 계정 조건', await c.rest(S.b.token, 'GET', `pds7_todos?user_id=eq.${aId}&select=*`));
  assert.ok([401, 403].includes(addr.status));
  assert.ok(!JSON.stringify(addr.body).includes(S.a.todo));

  // 토큰의 사용자(sub)를 A 로 바꾼 위조 토큰 → 서명 불일치로 거절
  const [h, p, s] = S.b.token.split('.');
  const forged = JSON.parse(Buffer.from(p, 'base64url'));
  forged.sub = aId;
  const tok = `${h}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${s}`;
  const fr = rec('C123-forged-jwt', '토큰 안의 사용자 ID 를 A 로 바꿔 요청', await c.rpc(tok, 'pds7_snapshot'));
  assert.equal(fr.status, 401);
});

test('직접 Data API 우회: 로그인한 토큰으로도 테이블 직접 읽기·쓰기·소유자 변경 불가', async () => {
  const tok = S.b.token;
  const cases = [
    ['GET', `pds7_todos?id=eq.${S.a.todo}&select=*`, undefined],
    ['GET', 'pds7_plans?select=*', undefined],
    ['PATCH', `pds7_todos?id=eq.${S.a.todo}`, { title: '직접 수정' }],
    ['PATCH', `pds7_plans?id=eq.${S.b.plan}`, { user_id: S.a.user.id }],
    ['DELETE', `pds7_todos?id=eq.${S.a.todo}`, undefined],
    ['POST', 'pds7_plans', { user_id: S.a.user.id, title: 'x', start_date: day, end_date: day, priority: 1, success_criteria: 'x', estimated_minutes: 1 }],
  ];
  const beforeA = await ownView(S.a.token);
  for (const [m, p, b] of cases) {
    const r = rec(`bypass-${m}-${p.split('?')[0]}`, `직접 REST ${m} ${p.split('?')[0]}`, await c.rest(tok, m, p, b, { Prefer: 'return=representation' }));
    assert.ok([401, 403].includes(r.status), `${m} ${p} → ${r.status}`);
  }
  assert.deepEqual(await ownView(S.a.token), beforeA);
  // 내부 스키마는 Data API 에 노출되지 않음
  const priv = rec('bypass-private-schema', '비노출 스키마 함수 직접 호출', await c.call('POST', '/rest/v1/rpc/current_user_id', { token: tok, body: {}, headers: { 'Content-Profile': 'pds7_private' } }));
  assert.ok([400, 404, 406].includes(priv.status), `private → ${priv.status}`);
});

test('C109·C110: 같은 주소·같은 방식·같은 토큰 — 로그아웃 전 200, 후 401', async () => {
  const s = await login('a');
  const before = rec('C109-before', '로그인 상태 POST /rest/v1/rpc/pds7_snapshot', await c.rpc(s.token, 'pds7_snapshot'));
  assert.equal(before.status, 200);
  const out = rec('C109-logout', '로그아웃(POST /auth/v1/logout, 서버 세션 삭제)', await c.logout(s.token));
  assert.equal(out.status, 204);
  const afterR = rec('C109-after', '로그아웃 뒤 같은 토큰으로 같은 요청', await c.rpc(s.token, 'pds7_snapshot'));
  assert.equal(afterR.status, 401);
  assert.equal(before.request.auth, afterR.request.auth);
  const ref = rec('C114-refresh-after-logout', '로그아웃 뒤 리프레시 토큰으로 새 토큰 요청', await c.refresh(s.refresh));
  assert.ok(ref.status >= 400);
  if (local) {
    const sid = decodeJwt(s.token).session_id;
    assert.equal(sql(`select count(*) from auth.sessions where id = :'sid';`, { sid }), '0');
  }
});

test('C114: 비밀번호를 직접 Auth API 로 바꾸면(로그아웃 호출 없이) 이전 세션 토큰이 모두 거절된다', async () => {
  const s1 = await login('a');
  const s2 = await login('a');
  ok(await c.rpc(s1.token, 'pds7_snapshot'));
  ok(await c.rpc(s2.token, 'pds7_snapshot'));
  const ch = rec('C114-change', '비밀번호 변경 PUT /auth/v1/user (앱 거치지 않음, signOut 미호출)', await c.updatePassword(s1.token, NEW_PW));
  ok(ch);
  // 비밀번호 파일 갱신(시험 계정만, 저장소 밖)
  for (const who of ['a']) acc[who].password_override = NEW_PW;
  const r1 = rec('C114-s1-after', '변경에 쓴 세션 토큰으로 같은 요청', await c.rpc(s1.token, 'pds7_snapshot'));
  const r2 = rec('C114-s2-after', '다른 기존 세션 토큰으로 같은 요청', await c.rpc(s2.token, 'pds7_snapshot'));
  assert.equal(r1.status, 401);
  assert.equal(r2.status, 401);
  const old = rec('C114-old-pw', '이전 비밀번호로 로그인', await c.signIn(acc.a.email, PW));
  assert.equal(old.status, 400);
  const fresh = await login('a', NEW_PW);
  const ok2 = rec('C114-new-session', '새 비밀번호로 다시 로그인 후 같은 요청', await c.rpc(fresh.token, 'pds7_snapshot'));
  assert.equal(ok2.status, 200);
  S.a = { ...S.a, ...fresh };
  curPw = NEW_PW;
  // B 도 같은 새 비밀번호로 바꿔 GoTrue 가 만든 해시끼리 비교한다(C104)
  const bs = await login('b', PW);
  ok(await c.updatePassword(bs.token, NEW_PW));
  S.b = { ...S.b, ...(await login('b', NEW_PW)) };
  const saved = loadAccounts();
  saved[t.remote ? 'remote' : 'local'].password = NEW_PW;
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(saved, null, 2));
  if (local) {
    const pc = sqlJson(`select user_id, changed_at from pds7_private.password_changes where user_id in (:'a', :'b')`, { a: S.a.user.id, b: S.b.user.id });
    assert.equal(pc.length, 2);
  }
});

test('C101~C104 (로컬 관리자 SQL): 저장값은 bcrypt 해시, 같은 비밀번호라도 계정마다 다름', { skip: !local }, async () => {
  const rows = sqlJson(`select email, encrypted_password from auth.users where email in (:'a', :'b') order by email`, { a: acc.a.email, b: acc.b.email });
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.match(r.encrypted_password, /^\$2[aby]\$10\$/);
    assert.ok(!r.encrypted_password.includes(NEW_PW));
  }
  assert.notEqual(rows[0].encrypted_password, rows[1].encrypted_password);
  evidence.push({ id: 'C103-C104', title: '시험 계정 A·B(같은 비밀번호)의 auth.users.encrypted_password', rows });
});

test('세션 검증 함수(로컬 SQL): 잘못된 session_id·없는 세션·만료 세션·익명은 오류 노출 없이 거절', { skip: !local }, async () => {
  const uid = S.a.user.id;
  const sid = decodeJwt(S.a.token).session_id;
  const run = (claims) => sql(`begin; set local role authenticated; select set_config('request.jwt.claims', :'c', true);
    select coalesce(pds7_private.current_user_id()::text, 'NULL'); rollback;`, { c: JSON.stringify(claims) }).split('\n').filter((l) => /^(NULL|[0-9a-f-]{36})$/.test(l)).pop();
  const base = { role: 'authenticated', sub: uid, session_id: sid };
  assert.equal(run(base), uid);
  assert.equal(run({ ...base, session_id: 'not-a-uuid' }), 'NULL');
  assert.equal(run({ ...base, session_id: "1' or '1'='1" }), 'NULL');
  assert.equal(run({ ...base, session_id: randomUUID() }), 'NULL');
  assert.equal(run({ ...base, sub: randomUUID() }), 'NULL');
  assert.equal(run({ ...base, is_anonymous: true }), 'NULL');
  assert.equal(run({ ...base, role: 'anon' }), 'NULL');
  // not_after 가 지난 세션
  sql(`update auth.sessions set not_after = now() - interval '1 minute' where id = :'sid';`, { sid });
  assert.equal(run(base), 'NULL');
  const r = await c.rpc(S.a.token, 'pds7_snapshot');
  assert.equal(r.status, 401);
  assert.deepEqual(Object.keys(r.body).sort(), ['code', 'details', 'hint', 'message']);
  assert.equal(r.body.message, '로그인이 필요합니다');
  sql(`update auth.sessions set not_after = null where id = :'sid';`, { sid });
  ok(await c.rpc(S.a.token, 'pds7_snapshot'));
  evidence.push({ id: 'session-fn', title: 'current_user_id: 정상/잘못된 session_id/없는 세션/다른 sub/익명/anon/만료 세션', result: '정상만 사용자 ID, 나머지 NULL → 401 "로그인이 필요합니다"' });
});

function localUser(label, { legacy = false } = {}) {
  const email = `t07-local-${label}-${randomUUID().slice(0, 6)}@example.com`;
  const hash = sql(`select extensions.crypt(:'pw', extensions.gen_salt('bf', 10));`, { pw: PW });
  const tmpl = readFileSync(path.join(APP_ROOT, 'db', '104_create_test_user.sql.tmpl'), 'utf8');
  const id = sql(tmpl, { email, hash }).split('\n')[0];
  // 공유 프로젝트의 기존 계정 흉내: 가입 시각을 스키마 적용 시각보다 앞으로 옮긴다(로컬 전용)
  if (legacy) sql(`update auth.users set created_at = (select value from pds7_private.settings where key = 'schema_applied_at') - interval '1 day' where id = :'id';`, { id });
  return { email, id };
}

// R-A: 시험 계정 C(회원 등록 전 상태). 로컬·원격 같은 코드. 원격은 1회용(등록 뒤에는 다시 돌릴 수 없음).
test('R-A: 회원 등록 전 세션은 자료 RPC 403, 등록 전 직접 비밀번호 변경 뒤 옛 세션·변경 세션은 등록·접근 불가, 새 로그인만 등록', { skip: !acc.c || Boolean(t.remote && process.env.T07_RUN_DELETE) }, async () => {
  const cu = acc.c;
  const cNew = `${cu.password}-changed`;
  secrets.push(cu.password, cNew);
  const s1r = await c.signIn(cu.email, cu.password);
  assert.equal(s1r.status, 200, 'C 로그인(등록 전 상태여야 함)');
  const s1 = s1r.body.access_token;
  const pre = rec('R-A-no-enroll', '회원 등록(pds7_me) 없이 자료 쓰기', await c.rpc(s1, 'pds7_create_plan', planBody('[시험] 등록 전 계획')));
  assert.equal(pre.status, 403, `등록 전 자료 쓰기는 거절: ${JSON.stringify(pre.body)}`);
  assert.equal(rec('R-A-no-enroll-read', '회원 등록 없이 목록 조회', await c.rpc(s1, 'pds7_snapshot')).status, 403);
  const s2 = (await c.signIn(cu.email, cu.password)).body.access_token;
  ok(rec('R-A-pw-change', '등록 전 직접 Auth API 비밀번호 변경(PUT /auth/v1/user, signOut 미호출)', await c.updatePassword(s2, cNew)));
  const saved = loadAccounts();
  saved[t.remote ? 'remote' : 'local'].c.password = cNew; // 저장소 밖 파일만
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(saved, null, 2));
  if (local) assert.equal(sql(`select count(*) from pds7_private.password_changes where user_id = :'id';`, { id: s1r.body.user.id }), '1', '등록 전 비밀번호 변경도 기록');
  assert.equal(rec('R-A-old-enroll', '변경 전 세션(s1)으로 회원 등록', await c.rpc(s1, 'pds7_me')).status, 401);
  assert.equal(rec('R-A-changer-enroll', '비밀번호를 바꾼 세션(s2)으로 회원 등록', await c.rpc(s2, 'pds7_me')).status, 401);
  for (const tok of [s1, s2]) assert.equal((await c.rpc(tok, 'pds7_snapshot')).status, 401);
  if (local) assert.equal(sql(`select count(*) from pds7_private.members where user_id = :'id';`, { id: s1r.body.user.id }), '0', '옛 세션으로 등록되지 않음');
  const s3 = (await c.signIn(cu.email, cNew)).body.access_token;
  ok(rec('R-A-new-enroll', '새 비밀번호로 로그인한 세션으로 회원 등록', await c.rpc(s3, 'pds7_me')));
  ok(rec('R-A-new-data', '등록 뒤 자료 쓰기', await c.rpc(s3, 'pds7_create_plan', planBody('[시험] C 등록 후 계획'))));
  assert.equal(rec('R-A-old-after', '등록 뒤 옛 세션(s1)으로 조회', await c.rpc(s1, 'pds7_snapshot')).status, 401);
});

test('R-A·R-C(로컬 SQL): 스키마 적용 전 계정은 회원 등록 자체가 거절(403, 조용한 예외 없음), 비밀번호 변경 기록·회원 행도 남기지 않음', { skip: !local }, async () => {
  const u = localUser('legacy', { legacy: true });
  const s = (await c.signIn(u.email, PW)).body.access_token;
  const en = rec('R-A-legacy-enroll', '스키마 적용 전 계정의 회원 등록', await c.rpc(s, 'pds7_me'));
  assert.equal(en.status, 403);
  assert.equal((await c.rpc(s, 'pds7_snapshot')).status, 403);
  assert.equal((await c.rpc(s, 'pds7_delete_account', { p_confirm: '계정 삭제' })).status, 403);
  ok(await c.updatePassword(s, NEW_PW));
  assert.equal(sql(`select (select count(*) from pds7_private.password_changes where user_id = :'id') + (select count(*) from pds7_private.members where user_id = :'id');`, { id: u.id }), '0');
  assert.equal(sql(`select count(*) from auth.users where id = :'id';`, { id: u.id }), '1');
  sql(`delete from auth.users where id = :'id';`, { id: u.id });
});

// 원격에서는 해시 증거(C103·C104)를 관리자 SQL 로 먼저 받은 뒤 T07_RUN_DELETE=1 로 따로 실행한다
test('C134: 계정 삭제 — 확인 문구·최근 재로그인 필요, 삭제 후 계정·자료·세션 모두 사라지고 A 는 그대로', { skip: t.remote && !process.env.T07_RUN_DELETE }, async () => {
  const beforeA = await ownView(S.a.token);
  const bad = rec('C134-wrong-confirm', '확인 문구 없이 삭제 요청', await c.rpc(S.b.token, 'pds7_delete_account', { p_confirm: '' }));
  assert.equal(bad.status, 400);
  if (local) {
    const sid = decodeJwt(S.b.token).session_id;
    // 비밀번호 변경 기록보다는 뒤, 지금보다 10분 전에 만든 세션으로 만든다(변경 이전 세션이면 401 이 맞음)
    sql(`update pds7_private.password_changes set changed_at = now() - interval '20 minutes' where user_id = :'u';
         update auth.sessions set created_at = now() - interval '10 minutes' where id = :'sid';`, { sid, u: S.b.user.id });
    const stale = rec('C134-stale-session', '로그인한 지 5분 넘은 세션으로 삭제 요청', await c.rpc(S.b.token, 'pds7_delete_account', { p_confirm: '계정 삭제' }));
    assert.equal(stale.status, 403);
  }
  const fresh = await login('b');
  const other = rec('C134-delete', '비밀번호로 다시 로그인한 직후 삭제 요청', await c.rpc(fresh.token, 'pds7_delete_account', { p_confirm: '계정 삭제' }));
  assert.equal(other.status, 200);
  assert.equal(other.body.deleted, true);
  const after1 = rec('C134-token-after', '삭제 뒤 같은 토큰으로 요청', await c.rpc(fresh.token, 'pds7_snapshot'));
  assert.equal(after1.status, 401);
  const after2 = rec('C134-login-after', '삭제 뒤 같은 이메일·비밀번호로 로그인', await c.signIn(acc.b.email, curPw));
  assert.equal(after2.status, 400);
  assert.deepEqual(await ownView(S.a.token), beforeA, '다른 계정 자료는 그대로');
  if (local) {
    const uid = S.b.user.id;
    const left = sql(`select (select count(*) from auth.users where id = :'u') + (select count(*) from auth.sessions where user_id = :'u')
      + (select count(*) from public.pds7_plans where user_id = :'u') + (select count(*) from public.pds7_todos where user_id = :'u')
      + (select count(*) from public.pds7_executions where user_id = :'u') + (select count(*) from pds7_private.members where user_id = :'u');`, { u: uid });
    assert.equal(left, '0');
    evidence.push({ id: 'C134-db', title: '삭제 후 B 의 auth.users·sessions·pds7 자료·회원 행 수', result: 0 });
  }
});

test('피드백 반영(로컬 SQL): 관찰·규칙 소유자 변경 불가, 남의 회고 연결은 외래키가 거절 (스키마 이전 계정 삭제 거절은 R-A·R-C 시험)', { skip: !local }, async () => {
  const u = localUser('fb');
  const tok = (await c.signIn(u.email, PW)).body.access_token;
  ok(await c.rpc(tok, 'pds7_me'));
  ok(await c.rpc(tok, 'pds7_save_observation', { p_question: 'q', p_metric: 'm', p_unit: '시간(분)', p_calc_rule: 'c', p_outlier_min: 0, p_outlier_max: 10, p_rounding_digits: 1, p_week_start: '월요일', p_plan_rule: 'r' }));
  assert.throws(() => sql(`update public.pds7_observations set user_id = :'other' where user_id = :'id';`, { id: u.id, other: S.a.user.id }), /소유자는 변경할 수 없습니다/);
  const myPlan = (await c.rpc(tok, 'pds7_create_plan', planBody('[시험] 피드백 계획'))).body;
  assert.throws(() => sql(`update public.pds7_plans set source_review_id = :'rv' where id = :'p';`, { rv: S.a.review, p: myPlan }), /pds7_plans_source_review_fk/);
  sql(`delete from auth.users where id = :'id';`, { id: u.id });
});
