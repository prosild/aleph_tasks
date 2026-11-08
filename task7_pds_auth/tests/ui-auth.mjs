// 브라우저 시험용: 로컬 스택에 시험 전용 계정을 만들고(관리자 SQL, 해시만) 화면에서 로그인한다.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { APP_ROOT, sql } from './stack.mjs';

const tmpl = readFileSync(path.join(APP_ROOT, 'db', '104_create_test_user.sql.tmpl'), 'utf8');

export function newLocalUser(label = 'ui') {
  const email = `t07-local-${label}-${randomBytes(3).toString('hex')}@example.com`;
  const password = `T07ui-${randomBytes(12).toString('base64url')}`;
  const hash = sql(`select extensions.crypt(:'pw', extensions.gen_salt('bf', 10));`, { pw: password });
  const id = sql(tmpl, { email, hash }).split('\n')[0];
  return { email, password, id };
}

export async function uiLogin(page, user) {
  await page.waitForSelector('#login-form:not(.hidden)');
  await page.fill('#login-form [name=email]', user.email);
  await page.fill('#login-form [name=password]', user.password);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#app-view:not(.hidden)');
}

// 브라우저에 저장된 현재 access token (시험에서 같은 값 재사용 확인용)
export const tokenOf = (page) => page.evaluate(() => {
  const k = Object.keys(localStorage).find((x) => /^sb-.*-auth-token$/.test(x));
  return k ? JSON.parse(localStorage.getItem(k)).access_token : null;
});
