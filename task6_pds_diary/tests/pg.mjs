// PGlite(WASM PostgreSQL) 위에 실제 스키마 SQL을 적용하고, PostgREST 의 RPC 호출(POST /rest/v1/rpc/<fn>)을
// anon 역할로 흉내 내는 테스트 도구. 원격 Supabase 와 같은 SQL 파일을 그대로 실행한다.
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA_SQL = path.join(here, '..', 'db', '001_pds_schema.sql');

export async function createDb() {
  const db = new PGlite();
  // Supabase 에 원래 있는 역할을 재현한다.
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    grant usage on schema public to anon, authenticated;
  `);
  await db.exec(await readFile(SCHEMA_SQL, 'utf8'));
  const sigCache = new Map();

  async function signature(fn) {
    if (sigCache.has(fn)) return sigCache.get(fn);
    const r = await db.query(
      `select coalesce(proargnames, '{}') as names, proargtypes::regtype[]::text[] as types
         from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace`, [fn]);
    if (r.rows.length !== 1) throw Object.assign(new Error(`unknown rpc ${fn}`), { code: 'PGRST202' });
    const sig = r.rows[0].names.map((n, i) => ({ name: n, type: r.rows[0].types[i] }));
    sigCache.set(fn, sig);
    return sig;
  }

  // PostgREST 와 같은 방식: JSON 본문의 키를 이름 있는 인자로 넘긴다.
  async function rpc(fn, body = {}, role = 'anon') {
    if (!/^pds_[a-z_]+$/.test(fn)) throw Object.assign(new Error('bad rpc name'), { code: 'PGRST202' });
    const sig = await signature(fn);
    const known = new Set(sig.map((s) => s.name));
    for (const k of Object.keys(body)) {
      if (!known.has(k)) throw Object.assign(new Error(`unknown argument ${k}`), { code: 'PGRST202' });
    }
    const parts = sig.filter((s) => Object.hasOwn(body, s.name)).map((s) => {
      const src = `($1::jsonb -> '${s.name}')`;
      if (s.type.endsWith('[]')) {
        return `${s.name} => case when jsonb_typeof(${src}) = 'array' then array(select jsonb_array_elements_text(${src}))::${s.type} end`;
      }
      return `${s.name} => (${src} #>> '{}')::${s.type}`;
    });
    const sql = `select to_jsonb(public.${fn}(${parts.join(', ')})) as result`;
    return db.transaction(async (tx) => {
      await tx.exec(`set local role ${role === 'anon' ? 'anon' : 'authenticated'}`);
      const r = await tx.query(sql, parts.length ? [JSON.stringify(body)] : []);
      return r.rows[0].result;
    });
  }

  // anon 으로 임의 SQL 실행 (권한 거부 확인용)
  async function asAnon(sql, params = []) {
    return db.transaction(async (tx) => {
      await tx.exec('set local role anon');
      return tx.query(sql, params);
    });
  }

  return { db, rpc, asAnon };
}
