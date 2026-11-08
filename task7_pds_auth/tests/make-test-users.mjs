// 시험 전용 계정 A·B 를 만든다(같은 비밀번호 → 저장 해시가 서로 다른지 확인용).
// 비밀번호는 무작위로 만들어 저장소 밖 파일(ACCOUNTS_FILE)에만 저장하고, SQL 에는 bcrypt 해시만 넣는다.
//   node make-test-users.mjs local          → 로컬 스택에 바로 생성
//   node make-test-users.mjs remote-sql OUT → 원격용 SQL 파일(해시만 포함) 생성. 실행은 검토 후 별도.
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
}
