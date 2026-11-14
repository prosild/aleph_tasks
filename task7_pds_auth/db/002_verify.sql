-- 001_pds_schema.sql 적용 후 읽기 전용 검증. 데이터를 바꾸지 않는다.
-- 1) 새 객체 목록과 RLS 상태 (6개 테이블, 모두 rls_enabled = true 이어야 함)
select c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'pds\_%'
order by 1;

-- 2) anon 테이블 권한: SELECT 만 있어야 함 (INSERT/UPDATE/DELETE 없음)
select table_name, string_agg(privilege_type, ',' order by privilege_type) as anon_privileges
from information_schema.role_table_grants
where table_schema = 'public' and table_name like 'pds\_%' and grantee = 'anon'
group by table_name order by 1;

-- 3) 함수 보안 속성과 anon 실행 가능 여부
select p.proname, p.prosecdef as security_definer, p.proconfig as config,
       has_function_privilege('anon', p.oid, 'execute') as anon_can_execute
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'pds\_%'
order by 1;

-- 4) 기존 객체 영향 없음 확인 (행 수만 조회)
select (select count(*) from public.study_notes) as study_notes_rows,
       (select count(*) from public.vault_announcements) as vault_announcements_rows;

-- 5) 빈 상태 스냅샷 (anon 역할로 실행해도 동작해야 함)
select public.pds_snapshot() ->> 'schema' as schema, public.pds_snapshot() ->> 'seoul_today' as seoul_today;
