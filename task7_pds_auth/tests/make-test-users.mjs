// 시험 전용 계정 A·B 를 만든다(같은 비밀번호 → 저장 해시가 서로 다른지 확인용).
// 비밀번호는 무작위로 만들어 저장소 밖 파일(ACCOUNTS_FILE)에만 저장하고, SQL 에는 bcrypt 해시만 넣는다.
//   node make-test-users.mjs local          → 로컬 스택에 바로 생성
//   node make-test-users.mjs remote-sql OUT → 원격용 SQL 파일(해시만 포함) 생성. 실행은 검토 후 별도.
//   node make-test-users.mjs remote-sql-c OUT → 원격 R-A 시험 계정 C(회원 등록 전 상태로 시험) SQL 만 따로 생성.
//     A·B 와 같은 접두어·태그, 비밀번호는 C 전용으로 새로 만든다. 기존 A·B 계정·파일은 바꾸지 않는다.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { APP_ROOT, ACCOUNTS_FILE, sql, loadAccounts } from './stack.mjs';

const mode = process.argv[2] || 'local';
const prefix = mode === 'local' ? 't07-local' : 't07-review';
const tag = randomBytes(3).toString('hex');
const password = `T07test-${randomBytes(12).toString('base64url')}`;
const accounts = {
  created_for: mode, created_at: new Date().toISOString(), note: '시험 전용 계정. 비밀번호를 제출물·저장소에 쓰지 않는다.',
  password,
  a: { email: `${prefix}-a-${tag}@example.com` },
  b: { email: `${prefix}-b-${tag}@example.com` },
};
// 해시는 로컬 DB 의 pgcrypto(bcrypt, cost 10 = GoTrue 와 같은 형식 $2a$10$)로 계정마다 새 솔트로 만든다.
const hashOf = () => sql(`select extensions.crypt(:'pw', extensions.gen_salt('bf', 10));`, { pw: password });
const tmpl = readFileSync(path.join(APP_ROOT, 'db', '104_create_test_user.sql.tmpl'), 'utf8');

if (mode === 'local') {
  for (const k of ['a', 'b']) {
    const out = sql(tmpl, { email: accounts[k].email, hash: hashOf() });
    accounts[k].user_id = out.split('\n')[0];
  }
  // R-A 시험 계정 C: 회원 등록 전 상태로 시작, 비밀번호는 C 전용
  const cPw = `T07c-${randomBytes(12).toString('base64url')}`;
  accounts.c = { email: `${prefix}-c-${tag}@example.com`, password: cPw };
  accounts.c.user_id = sql(tmpl, { email: accounts.c.email, hash: sql(`select extensions.crypt(:'pw', extensions.gen_salt('bf', 10));`, { pw: cPw }) }).split('\n')[0];
  const prev = loadAccounts() || {};
  writeFileSync(ACCOUNTS_FILE, JSON.stringify({ ...prev, local: accounts }, null, 2));
  console.log(`local test users created: a=${accounts.a.email} b=${accounts.b.email} (password saved outside repo)`);
} else if (mode === 'remote-sql') {
  const out = process.argv[3];
  const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const parts = ['-- T07 원격 시험 계정 생성(시험 전용, 관리자 경로). 비밀번호 원문 없음, bcrypt 해시만 포함.', 'begin;'];
  for (const k of ['a', 'b']) {
    parts.push(`-- 계정 ${k.toUpperCase()}`);
    parts.push(tmpl.replace(/^--.*\n/gm, '').replaceAll(":'email'", lit(accounts[k].email)).replaceAll(":'hash'", lit(hashOf())).trim());
  }
  parts.push('commit;', '');
  writeFileSync(out, parts.join('\n'));
  const prev = loadAccounts() || {};
  writeFileSync(ACCOUNTS_FILE, JSON.stringify({ ...prev, remote: accounts }, null, 2));
  console.log(`remote SQL written: ${out} (a=${accounts.a.email} b=${accounts.b.email}; password saved outside repo)`);
} else if (mode === 'remote-sql-c') {
  const out = process.argv[3];
  const all = loadAccounts();
  const remote = all?.remote;
  if (!remote?.a?.email) throw new Error('원격 A·B 계정 기록이 없습니다');
  if (remote.c) throw new Error(`원격 C 계정이 이미 기록돼 있습니다: ${remote.c.email}`);
  const rtag = remote.a.email.match(/-a-([0-9a-f]{6})@/)[1];
  const cPw = `T07c-${randomBytes(12).toString('base64url')}`;
  const email = `t07-review-c-${rtag}@example.com`;
  const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const hash = sql(`select extensions.crypt(:'pw', extensions.gen_salt('bf', 10));`, { pw: cPw });
  const body = tmpl.replace(/^--.*\n/gm, '').replaceAll(":'email'", lit(email)).replaceAll(":'hash'", lit(hash)).trim();
  writeFileSync(out, ['-- T07 원격 R-A 시험 계정 C 생성(시험 전용, 관리자 경로). 비밀번호 원문 없음, bcrypt 해시만 포함.',
    '-- 반드시 101 스키마 적용(R1) 뒤 실행: 가입 시각이 적용 뒤여야 회원 등록 시험이 된다. 회원 등록은 하지 않는다.', 'begin;', body, 'commit;', ''].join('\n'));
  remote.c = { email, password: cPw };
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(all, null, 2));
  console.log(`remote C SQL written: ${out} (c=${email}; password saved outside repo)`);
}
