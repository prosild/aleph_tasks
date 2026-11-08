-- T07 카드 1: T06 에 입력한 본인 기록을 본인 계정으로 옮긴다(복사). 관리자 1회 실행.
-- 원본 public.pds_* 는 읽기만 하고 바꾸지 않는다(같은 트랜잭션 안에서 실행 전후 원본 지문을 비교).
-- 대상 계정: 사용자가 화면에서 가입·메일 확인·로그인(→ pds7_private.members 등록)까지 마친 계정 1개.
-- 실행 전 __OWNER_USER_ID__ 를 그 계정의 auth.users.id 로 바꾼다(이메일로 조회해 사용자 본인 확인 후).
-- 같은 계정에 이미 이관분이 있으면 아무것도 하지 않고 오류로 멈춘다(중복 이관 방지). ID 는 원본과 같은 UUID 를 쓴다.
begin;

create temp table _owner on commit drop as select '__OWNER_USER_ID__'::uuid as id;

do $$
declare v_owner uuid := (select id from _owner);
begin
  if not exists (select 1 from pds7_private.members m join auth.users u on u.id = m.user_id
                  where m.user_id = v_owner and u.email_confirmed_at is not null) then
    raise exception '대상 계정이 메일 확인을 마친 T07 회원이 아닙니다';
  end if;
  if exists (select 1 from public.pds7_plans where t06_source_id is not null) then
    raise exception '이미 이관된 기록이 있습니다(중복 이관 방지)';
  end if;
end $$;

-- 원본 지문(행 전체 JSON 의 md5)
create temp table _src_before on commit drop as
select 'plans' as t, count(*) as n, md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) as h from public.pds_plans x
union all select 'plan_revisions', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) from public.pds_plan_revisions x
union all select 'todos', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) from public.pds_todos x
union all select 'completion_events', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) from public.pds_completion_events x
union all select 'executions', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) from public.pds_executions x
union all select 'reviews', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) from public.pds_reviews x;

-- 1) 계획(회고 참조는 회고를 넣은 뒤 연결)
insert into public.pds7_plans (id, user_id, title, description, start_date, end_date, priority, success_criteria,
                               estimated_minutes, source_review_id, applied_improvement, version, t06_source_id, created_at, updated_at)
select p.id, o.id, p.title, p.description, p.start_date, p.end_date, p.priority, p.success_criteria,
       p.estimated_minutes, null, p.applied_improvement, p.version, p.id, p.created_at, p.updated_at
from public.pds_plans p cross join _owner o;

insert into public.pds7_plan_revisions (plan_id, user_id, version, title, description, start_date, end_date, priority,
                                        success_criteria, estimated_minutes, applied_improvement, change_note, recorded_at)
select r.plan_id, o.id, r.version, r.title, r.description, r.start_date, r.end_date, r.priority,
       r.success_criteria, r.estimated_minutes, r.applied_improvement, r.change_note, r.recorded_at
from public.pds_plan_revisions r cross join _owner o order by r.id;

insert into public.pds7_todos (id, plan_id, user_id, title, memo, due_date, priority, tags, estimated_minutes, status,
                               completed_at, deleted_at, t06_source_id, created_at, updated_at)
select t.id, t.plan_id, o.id, t.title, t.memo, t.due_date, t.priority, t.tags, t.estimated_minutes, t.status,
       t.completed_at, t.deleted_at, t.id, t.created_at, t.updated_at
from public.pds_todos t cross join _owner o;

insert into public.pds7_completion_events (todo_id, user_id, idempotency_key, completed_at, undone_at)
select c.todo_id, o.id, c.idempotency_key, c.completed_at, c.undone_at
from public.pds_completion_events c cross join _owner o order by c.id;

insert into public.pds7_executions (id, todo_id, user_id, started_at, ended_at, actual_minutes, blocker, note, t06_source_id, created_at)
select e.id, e.todo_id, o.id, e.started_at, e.ended_at, e.actual_minutes, e.blocker, e.note, e.id, e.created_at
from public.pds_executions e cross join _owner o;

insert into public.pds7_reviews (id, plan_id, user_id, improvement, stats, seoul_date, t06_source_id, created_at)
select v.id, v.plan_id, o.id, v.improvement, v.stats, v.seoul_date, v.id, v.created_at
from public.pds_reviews v cross join _owner o;

update public.pds7_plans p7 set source_review_id = p.source_review_id
from public.pds_plans p where p7.id = p.id and p.source_review_id is not null;

-- 2) 검증: 건수 일치, 원본 불변, 모두 대상 계정 소유. 하나라도 어긋나면 전체 취소.
do $$
declare
  v_owner uuid := (select id from _owner);
  bad text;
begin
  select string_agg(b.t, ', ') into bad
  from _src_before b
  join (
    select 'plans' as t, count(*) as n, md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) as h from public.pds_plans x
    union all select 'plan_revisions', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) from public.pds_plan_revisions x
    union all select 'todos', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) from public.pds_todos x
    union all select 'completion_events', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) from public.pds_completion_events x
    union all select 'executions', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) from public.pds_executions x
    union all select 'reviews', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) from public.pds_reviews x
  ) a on a.t = b.t
  where a.n <> b.n or a.h <> b.h;
  if bad is not null then raise exception '원본이 바뀌었습니다: %', bad; end if;

  select string_agg(t, ', ') into bad from (
    select 'plans' t where (select count(*) from public.pds7_plans where user_id = v_owner and t06_source_id is not null) <> (select n from _src_before where t = 'plans')
    union all select 'plan_revisions' where (select count(*) from public.pds7_plan_revisions r join public.pds7_plans p on p.id = r.plan_id
                                             where r.user_id = v_owner and p.t06_source_id is not null) <> (select n from _src_before where t = 'plan_revisions')
    union all select 'todos' where (select count(*) from public.pds7_todos where user_id = v_owner and t06_source_id is not null) <> (select n from _src_before where t = 'todos')
    union all select 'completion_events' where (select count(*) from public.pds7_completion_events c join public.pds7_todos t on t.id = c.todo_id
                                                where c.user_id = v_owner and t.t06_source_id is not null) <> (select n from _src_before where t = 'completion_events')
    union all select 'executions' where (select count(*) from public.pds7_executions where user_id = v_owner and t06_source_id is not null) <> (select n from _src_before where t = 'executions')
    union all select 'reviews' where (select count(*) from public.pds7_reviews where user_id = v_owner and t06_source_id is not null) <> (select n from _src_before where t = 'reviews')
  ) s;
  if bad is not null then raise exception '이관 건수가 다릅니다: %', bad; end if;
end $$;

-- 3) 결과(건수·원본 지문) — 실행 기록으로 남긴다
select b.t as table_name, b.n as t06_rows, b.h as t06_md5_unchanged from _src_before b order by b.t;

commit;
