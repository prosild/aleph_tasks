// T07 시험 도구: 로컬 Supabase 스택(supabase start, Docker) 또는 원격 프로젝트에 실제 HTTP 로 요청한다.
// 비밀값(키·토큰·비밀번호)은 화면·파일에 원문으로 쓰지 않는다. 기록용 문자열은 mask() 를 거친다.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(here, '..');
export const CLI = ['-y', 'supabase@2.121.0'];
export const DB_CONTAINER = 'supabase_db_task7_pds_auth';
// 시험 계정 비밀번호는 저장소 밖(작업 루트, 공개 저장소에 올리지 않음)에만 둔다.
export const ACCOUNTS_FILE = process.env.T07_ACCOUNTS_FILE || path.resolve(APP_ROOT, '..', '..', '..', '..', '..', '.t07-local-test-accounts.json');

export function localStatus() {
  const out = execFileSync('npx', [...CLI, 'status', '-o', 'json'], { cwd: APP_ROOT, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const j = JSON.parse(out.slice(out.indexOf('{')));
  return { url: j.API_URL, key: j.PUBLISHABLE_KEY, secret: j.SECRET_KEY, jwtSecret: j.JWT_SECRET, mail: j.MAILPIT_URL };
}

export function target() {
  if (process.env.T07_URL) return { remote: true, url: process.env.T07_URL, key: process.env.T07_KEY };
  return { remote: false, ...localStatus() };
}

// 로컬 DB 에서만 쓰는 관리자 SQL(psql, postgres 역할 = 원격 마이그레이션 역할과 같은 비슈퍼유저)
export function sql(query, vars = {}) {
  const args = ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-q'];
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  return execFileSync('docker', args, { input: query, encoding: 'utf8' }).trim();
}
export const sqlJson = (query, vars) => JSON.parse(sql(`select coalesce(json_agg(x), '[]') from (${query}) x;`, vars) || '[]');

export function mask(s) {
  if (s == null) return s;
  const t = String(s);
  if (t.length <= 12) return '…생략';
  return `${t.slice(0, 5)}…생략`;
}
// 응답 본문에서 토큰·비밀번호 같은 값을 가린다(기록용)
export function redact(obj, secrets = []) {
  let text = JSON.stringify(obj);
  for (const s of secrets.filter(Boolean)) text = text.split(s).join(mask(s));
  text = text.replace(/"(access_token|refresh_token|token|provider_token|provider_refresh_token)":"([^"]+)"/g, (_, k, v) => `"${k}":"${mask(v)}"`);
  return JSON.parse(text);
}

export function client(t) {
  const base = t.url;
  async function call(method, p, { token, body, headers = {}, apikey = t.key } = {}) {
    const h = { apikey, 'Content-Type': 'application/json', Accept: 'application/json', ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    const res = await fetch(`${base}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json, request: { method, path: p, auth: token ? `Bearer ${mask(token)}` : '(없음)', body } };
  }
  return {
    call,
    signUp: (email, password, redirect) => call('POST', `/auth/v1/signup${redirect ? `?redirect_to=${encodeURIComponent(redirect)}` : ''}`, { body: { email, password } }),
    signIn: (email, password) => call('POST', '/auth/v1/token?grant_type=password', { body: { email, password } }),
    logout: (token, scope = 'local') => call('POST', `/auth/v1/logout?scope=${scope}`, { token }),
    user: (token) => call('GET', '/auth/v1/user', { token }),
    updatePassword: (token, password) => call('PUT', '/auth/v1/user', { token, body: { password } }),
    refresh: (refreshToken) => call('POST', '/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: refreshToken } }),
    rpc: (token, fn, body = {}, headers) => call('POST', `/rest/v1/rpc/${fn}`, { token, body, headers }),
    rest: (token, method, p, body, headers) => call(method, `/rest/v1/${p}`, { token, body, headers }),
  };
}

export function decodeJwt(tok) {
  const [, payload] = tok.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

export function loadAccounts() {
  if (!existsSync(ACCOUNTS_FILE)) return null;
  return JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
}
