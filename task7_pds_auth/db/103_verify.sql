-- T07 101 적용 후 읽기 전용 확인 (SELECT 만). 각 문장을 따로 실행하고 결과를 남긴다.

-- V1 신규 테이블 9개 RLS 활성, anon/authenticated 테이블 권한 0개
select c.relname, c.relrowsecurity as rls,
       has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as anon_any,
       has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as authenticated_any
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname like 'pds7\_%' and c.relkind = 'r' order by 1;

-- V2 pds7_private 테이블 2개: RLS 활성, anon/authenticated 권한 없음
select c.relname, c.relrowsecurity as rls,
       has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as authenticated_any
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'pds7_private' and c.relkind = 'r' order by 1;

-- V3 함수: search_path 빈 값, SECURITY DEFINER 여부, anon/authenticated/PUBLIC 실행 권한
select n.nspname, p.proname, p.prosecdef as security_definer, p.proconfig,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_exec,
       exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'pds7_private' or (n.nspname = 'public' and p.proname like 'pds7\_%')
order by 1, 2;

-- V4 auth.users 트리거 1개(비밀번호 변경 시에만)
select tgname, tgrelid::regclass as tbl, tgfoid::regprocedure as fn, tgenabled, pg_get_triggerdef(oid) as def
from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal;

-- V5 기존 객체 영향 없음: T06 원본 행 수와 기존 Auth 사용자·세션 수(적용 전 Q1·Q2 와 비교)
select (select count(*) from public.pds_plans) as pds_plans, (select count(*) from public.pds_todos) as pds_todos,
       (select count(*) from public.pds_executions) as pds_executions, (select count(*) from public.pds_reviews) as pds_reviews,
       (select count(*) from auth.users) as auth_users, (select count(*) from auth.sessions) as auth_sessions,
       (select count(*) from pds7_private.members) as t07_members;

