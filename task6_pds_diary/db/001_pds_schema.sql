-- T06 Plan-Do-See 다이어리 스키마 (pds-schema-v2)
-- 범위: 신규 public.pds_* 테이블·함수·트리거·정책만 생성한다. 기존 객체는 변경하지 않는다.
-- 접근 모델: 로그인 없음(과제 T06 요구). 브라우저는 publishable key(anon 역할)로
--   읽기 = 테이블 SELECT(RLS 정책 using(true)), 쓰기 = 아래 pds_* RPC 함수만 사용한다.
--   anon/authenticated 에게 테이블 INSERT/UPDATE/DELETE 권한을 주지 않아 수정 이력·완료 이벤트를
--   클라이언트가 직접 변조할 수 없다. 쓰기 함수는 SECURITY DEFINER + search_path='' 로 입력을 검증한다.
-- 시간 규칙: DATE 컬럼(기간·마감일)은 YYYY-MM-DD 달력 날짜, timestamptz 는 UTC 저장·Asia/Seoul 표시.
--   "오늘"은 (now() at time zone 'Asia/Seoul')::date. 시간 단위는 모두 분(minutes, 정수).

begin;

-- ───────────────────────── 테이블 ─────────────────────────
create table public.pds_plans (
  id                  uuid primary key default gen_random_uuid(),
  title               text not null check (char_length(title) between 1 and 120),
  description         text not null default '' check (char_length(description) <= 2000),
  start_date          date not null,
  end_date            date not null,
  priority            smallint not null check (priority between 1 and 3),
  success_criteria    text not null check (char_length(success_criteria) between 1 and 1000),
  estimated_minutes   integer not null check (estimated_minutes between 1 and 100000),
  source_review_id    uuid null,
  applied_improvement text null check (applied_improvement is null or char_length(applied_improvement) <= 500),
  version             integer not null default 1 check (version >= 1),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint pds_plans_period_chk check (end_date >= start_date)
);

create table public.pds_plan_revisions (
  id                  bigint generated always as identity primary key,
  plan_id             uuid not null references public.pds_plans(id) on delete cascade,
  version             integer not null check (version >= 1),
  title               text not null,
  description         text not null,
  start_date          date not null,
  end_date            date not null,
  priority            smallint not null,
  success_criteria    text not null,
  estimated_minutes   integer not null,
  applied_improvement text null,
  change_note         text not null default '' check (char_length(change_note) <= 500),
  recorded_at         timestamptz not null default now(),
  constraint pds_plan_revisions_plan_version_uq unique (plan_id, version)
);

create table public.pds_todos (
  id                uuid primary key default gen_random_uuid(),
  plan_id           uuid not null references public.pds_plans(id) on delete cascade,
  title             text not null check (char_length(title) between 1 and 200),
  memo              text not null default '' check (char_length(memo) <= 2000),
  due_date          date not null,
  priority          smallint not null check (priority between 1 and 3),
  tags              text[] not null default '{}' check (cardinality(tags) <= 10),
  estimated_minutes integer not null check (estimated_minutes between 1 and 100000),
  status            text not null default 'open' check (status in ('open', 'done')),
  completed_at      timestamptz null,
  deleted_at        timestamptz null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint pds_todos_done_chk check ((status = 'done') = (completed_at is not null))
);
create index pds_todos_plan_idx on public.pds_todos (plan_id);

create table public.pds_completion_events (
  id              bigint generated always as identity primary key,
  todo_id         uuid not null references public.pds_todos(id) on delete cascade,
  idempotency_key uuid not null,
  completed_at    timestamptz not null default now(),
  undone_at       timestamptz null,
  constraint pds_completion_events_key_uq unique (idempotency_key)
);
-- 할 일 하나에 "현재 유효한 완료" 이벤트는 최대 1건 (중복 완료 방지의 DB 강제 조건)
create unique index pds_completion_events_one_active_uq
  on public.pds_completion_events (todo_id) where undone_at is null;

create table public.pds_executions (
  id             uuid primary key default gen_random_uuid(),
  todo_id        uuid not null references public.pds_todos(id) on delete cascade,
  started_at     timestamptz not null,
  ended_at       timestamptz not null,
  actual_minutes integer not null check (actual_minutes >= 1),
  blocker        text null check (blocker is null or char_length(blocker) between 1 and 1000),
  note           text not null default '' check (char_length(note) <= 1000),
  created_at     timestamptz not null default now(),
  constraint pds_executions_range_chk check (ended_at > started_at and ended_at - started_at <= interval '24 hours'),
  constraint pds_executions_minutes_chk check (actual_minutes <= ceil(extract(epoch from (ended_at - started_at)) / 60))
);
create index pds_executions_todo_idx on public.pds_executions (todo_id);

create table public.pds_reviews (
  id          uuid primary key default gen_random_uuid(),
  plan_id     uuid not null references public.pds_plans(id) on delete cascade,
  improvement text not null check (char_length(improvement) between 1 and 500),
  stats       jsonb not null,
  seoul_date  date not null,
  created_at  timestamptz not null default now()
);
create index pds_reviews_plan_idx on public.pds_reviews (plan_id);

alter table public.pds_plans
  add constraint pds_plans_source_review_fk
  foreign key (source_review_id) references public.pds_reviews(id) on delete set null;

-- ───────────────────────── 불변 조건 트리거 ─────────────────────────
create function public.pds_forbid_revision_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '계획 수정 이력은 변경할 수 없습니다' using errcode = '42501';
end $$;
create trigger pds_plan_revisions_immutable
  before update on public.pds_plan_revisions
  for each row execute function public.pds_forbid_revision_update();

create function public.pds_guard_completion_event_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.todo_id <> old.todo_id or new.idempotency_key <> old.idempotency_key
     or new.completed_at <> old.completed_at or old.undone_at is not null or new.undone_at is null then
    raise exception '완료 이벤트는 취소 시각 기록 외에 변경할 수 없습니다' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger pds_completion_events_guard
  before update on public.pds_completion_events
  for each row execute function public.pds_guard_completion_event_update();

-- ───────────────────────── 내부 검증 도우미 ─────────────────────────
create function public.pds_clean_text(p text, p_field text, p_min int, p_max int) returns text
language plpgsql immutable set search_path = '' as $$
declare v text := btrim(coalesce(p, ''));
begin
  if char_length(v) < p_min then
    raise exception '%: 값을 입력하세요', p_field using errcode = '22023';
  end if;
  if char_length(v) > p_max then
    raise exception '%: % 자 이하로 입력하세요', p_field, p_max using errcode = '22023';
  end if;
  return v;
end $$;

create function public.pds_clean_tags(p text[]) returns text[]
language plpgsql immutable set search_path = '' as $$
declare v text[];
begin
  select coalesce(array_agg(t order by first_pos), '{}') into v
  from (
    select btrim(x) as t, min(ord) as first_pos
    from unnest(coalesce(p, '{}')) with ordinality as u(x, ord)
    where btrim(x) <> ''
    group by btrim(x)
  ) s;
  if cardinality(v) > 10 then
    raise exception '태그: 10개 이하로 입력하세요' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v) t where char_length(t) > 30) then
    raise exception '태그: 각 30자 이하로 입력하세요' using errcode = '22023';
  end if;
  return v;
end $$;

create function public.pds_check_minutes(p int, p_field text) returns int
language plpgsql immutable set search_path = '' as $$
begin
  if p is null or p < 1 or p > 100000 then
    raise exception '%: 1~100000 분 사이 정수로 입력하세요', p_field using errcode = '22023';
  end if;
  return p;
end $$;

create function public.pds_check_priority(p int) returns smallint
language plpgsql immutable set search_path = '' as $$
begin
  if p is null or p not in (1, 2, 3) then
    raise exception '우선순위: 1(높음)·2(보통)·3(낮음) 중 하나여야 합니다' using errcode = '22023';
  end if;
  return p::smallint;
end $$;

-- ───────────────────────── 계획 (카드 1) ─────────────────────────
create function public.pds_create_plan(
  p_title text, p_description text, p_start_date date, p_end_date date, p_priority int,
  p_success_criteria text, p_estimated_minutes int, p_source_review_id uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_improvement text := null;
begin
  if p_start_date is null or p_end_date is null then
    raise exception '기간: 시작일과 종료일을 입력하세요' using errcode = '22023';
  end if;
  if p_end_date < p_start_date then
    raise exception '기간: 종료일이 시작일보다 앞설 수 없습니다' using errcode = '22023';
  end if;
  if p_source_review_id is not null then
    select improvement into v_improvement from public.pds_reviews where id = p_source_review_id;
    if not found then
      raise exception '회고를 찾을 수 없습니다' using errcode = 'P0002';
    end if;
  end if;

  insert into public.pds_plans (title, description, start_date, end_date, priority, success_criteria,
                                estimated_minutes, source_review_id, applied_improvement)
  values (public.pds_clean_text(p_title, '계획 제목', 1, 120),
          public.pds_clean_text(p_description, '설명', 0, 2000),
          p_start_date, p_end_date, public.pds_check_priority(p_priority),
          public.pds_clean_text(p_success_criteria, '성공 기준', 1, 1000),
          public.pds_check_minutes(p_estimated_minutes, '예상 시간'),
          p_source_review_id, v_improvement)
  returning id into v_id;

  insert into public.pds_plan_revisions (plan_id, version, title, description, start_date, end_date, priority,
                                         success_criteria, estimated_minutes, applied_improvement, change_note)
  select id, version, title, description, start_date, end_date, priority, success_criteria,
         estimated_minutes, applied_improvement, '최초 계획'
  from public.pds_plans where id = v_id;

  return v_id;
end $$;

create function public.pds_update_plan(
  p_plan_id uuid, p_expected_version int, p_title text, p_description text, p_start_date date,
  p_end_date date, p_priority int, p_success_criteria text, p_estimated_minutes int, p_change_note text default ''
) returns int
language plpgsql security definer set search_path = '' as $$
declare
  cur public.pds_plans%rowtype;
  v_title text := public.pds_clean_text(p_title, '계획 제목', 1, 120);
  v_desc text := public.pds_clean_text(p_description, '설명', 0, 2000);
  v_crit text := public.pds_clean_text(p_success_criteria, '성공 기준', 1, 1000);
  v_prio smallint := public.pds_check_priority(p_priority);
  v_min int := public.pds_check_minutes(p_estimated_minutes, '예상 시간');
  v_note text := public.pds_clean_text(p_change_note, '수정 사유', 0, 500);
begin
  if p_start_date is null or p_end_date is null or p_end_date < p_start_date then
    raise exception '기간: 시작일·종료일을 확인하세요(종료일 ≥ 시작일)' using errcode = '22023';
  end if;

  select * into cur from public.pds_plans where id = p_plan_id for update;
  if not found then
    raise exception '계획을 찾을 수 없습니다' using errcode = 'P0002';
  end if;
  if p_expected_version is distinct from cur.version then
    raise exception '다른 곳에서 먼저 수정되었습니다(현재 버전 %). 새로고침 후 다시 시도하세요', cur.version
      using errcode = '40001';
  end if;

  if cur.title = v_title and cur.description = v_desc and cur.start_date = p_start_date
     and cur.end_date = p_end_date and cur.priority = v_prio and cur.success_criteria = v_crit
     and cur.estimated_minutes = v_min then
    return cur.version; -- 변경 없음: 새 이력을 만들지 않는다
  end if;

  update public.pds_plans
     set title = v_title, description = v_desc, start_date = p_start_date, end_date = p_end_date,
         priority = v_prio, success_criteria = v_crit, estimated_minutes = v_min,
         version = cur.version + 1, updated_at = now()
   where id = p_plan_id;

  insert into public.pds_plan_revisions (plan_id, version, title, description, start_date, end_date, priority,
                                         success_criteria, estimated_minutes, applied_improvement, change_note)
  select id, version, title, description, start_date, end_date, priority, success_criteria,
         estimated_minutes, applied_improvement, v_note
  from public.pds_plans where id = p_plan_id;

  return cur.version + 1;
end $$;

-- ───────────────────────── 할 일 (카드 2) ─────────────────────────
create function public.pds_create_todo(
  p_plan_id uuid, p_title text, p_memo text, p_due_date date, p_priority int, p_tags text[], p_estimated_minutes int
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not exists (select 1 from public.pds_plans where id = p_plan_id) then
    raise exception '계획을 찾을 수 없습니다' using errcode = 'P0002';
  end if;
  if p_due_date is null then
    raise exception '마감일: 날짜를 입력하세요' using errcode = '22023';
  end if;
  insert into public.pds_todos (plan_id, title, memo, due_date, priority, tags, estimated_minutes)
  values (p_plan_id, public.pds_clean_text(p_title, '할 일 제목', 1, 200), public.pds_clean_text(p_memo, '메모', 0, 2000),
          p_due_date, public.pds_check_priority(p_priority), public.pds_clean_tags(p_tags),
          public.pds_check_minutes(p_estimated_minutes, '예상 시간'))
  returning id into v_id;
  return v_id;
end $$;

create function public.pds_update_todo(
  p_todo_id uuid, p_title text, p_memo text, p_due_date date, p_priority int, p_tags text[], p_estimated_minutes int
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_due_date is null then
    raise exception '마감일: 날짜를 입력하세요' using errcode = '22023';
  end if;
  update public.pds_todos
     set title = public.pds_clean_text(p_title, '할 일 제목', 1, 200),
         memo = public.pds_clean_text(p_memo, '메모', 0, 2000),
         due_date = p_due_date, priority = public.pds_check_priority(p_priority),
         tags = public.pds_clean_tags(p_tags),
         estimated_minutes = public.pds_check_minutes(p_estimated_minutes, '예상 시간'),
         updated_at = now()
   where id = p_todo_id and deleted_at is null;
  if not found then
    raise exception '할 일을 찾을 수 없거나 삭제되었습니다' using errcode = 'P0002';
  end if;
end $$;

-- 완료: 같은 멱등성 키 재전송·연속 클릭·동시 요청에도 완료 이벤트는 1건만 생긴다.
create function public.pds_complete_todo(p_todo_id uuid, p_idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.pds_todos%rowtype;
  ev public.pds_completion_events%rowtype;
begin
  if p_idempotency_key is null then
    raise exception '멱등성 키가 필요합니다' using errcode = '22023';
  end if;
  select * into t from public.pds_todos where id = p_todo_id for update;
  if not found or t.deleted_at is not null then
    raise exception '할 일을 찾을 수 없거나 삭제되었습니다' using errcode = 'P0002';
  end if;

  select * into ev from public.pds_completion_events where idempotency_key = p_idempotency_key;
  if found then
    if ev.todo_id <> p_todo_id then
      raise exception '다른 할 일에 사용된 멱등성 키입니다' using errcode = '22023';
    end if;
    return jsonb_build_object('created', false, 'reason', 'duplicate_request', 'event_id', ev.id, 'status', t.status);
  end if;

  if t.status = 'done' then
    return jsonb_build_object('created', false, 'reason', 'already_done', 'status', t.status);
  end if;

  insert into public.pds_completion_events (todo_id, idempotency_key)
  values (p_todo_id, p_idempotency_key)
  returning * into ev;
  update public.pds_todos set status = 'done', completed_at = ev.completed_at, updated_at = now()
   where id = p_todo_id;
  return jsonb_build_object('created', true, 'event_id', ev.id, 'status', 'done');
end $$;

create function public.pds_reopen_todo(p_todo_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.pds_todos%rowtype;
begin
  select * into t from public.pds_todos where id = p_todo_id for update;
  if not found or t.deleted_at is not null then
    raise exception '할 일을 찾을 수 없거나 삭제되었습니다' using errcode = 'P0002';
  end if;
  if t.status = 'open' then
    return jsonb_build_object('changed', false, 'status', 'open');
  end if;
  update public.pds_completion_events set undone_at = now() where todo_id = p_todo_id and undone_at is null;
  update public.pds_todos set status = 'open', completed_at = null, updated_at = now() where id = p_todo_id;
  return jsonb_build_object('changed', true, 'status', 'open');
end $$;

-- 삭제: 실행 기록·완료 이력을 보존하기 위해 삭제 표시(deleted_at)만 남기고 화면·회고 대상에서 제외한다.
create function public.pds_delete_todo(p_todo_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_deleted timestamptz;
begin
  select deleted_at into v_deleted from public.pds_todos where id = p_todo_id for update;
  if not found then
    raise exception '할 일을 찾을 수 없습니다' using errcode = 'P0002';
  end if;
  if v_deleted is not null then
    return jsonb_build_object('changed', false);
  end if;
  update public.pds_todos set deleted_at = now(), updated_at = now() where id = p_todo_id;
  return jsonb_build_object('changed', true);
end $$;

-- ───────────────────────── 실행 기록 (카드 3) ─────────────────────────
create function public.pds_add_execution(
  p_todo_id uuid, p_started_at timestamptz, p_ended_at timestamptz, p_actual_minutes int,
  p_blocker text default null, p_note text default ''
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_span int;
  v_blocker text := nullif(btrim(coalesce(p_blocker, '')), '');
begin
  if not exists (select 1 from public.pds_todos where id = p_todo_id and deleted_at is null) then
    raise exception '할 일을 찾을 수 없거나 삭제되었습니다' using errcode = 'P0002';
  end if;
  if p_started_at is null or p_ended_at is null then
    raise exception '시작·종료 시각을 입력하세요' using errcode = '22023';
  end if;
  if p_ended_at <= p_started_at then
    raise exception '종료 시각은 시작 시각보다 뒤여야 합니다' using errcode = '22023';
  end if;
  if p_ended_at - p_started_at > interval '24 hours' then
    raise exception '실행 기록 1건은 24시간 이하여야 합니다' using errcode = '22023';
  end if;
  v_span := ceil(extract(epoch from (p_ended_at - p_started_at)) / 60);
  if p_actual_minutes is null or p_actual_minutes < 1 or p_actual_minutes > v_span then
    raise exception '실제 소요 시간: 1~% 분(시작~종료 범위) 사이로 입력하세요', v_span using errcode = '22023';
  end if;
  if v_blocker is not null and char_length(v_blocker) > 1000 then
    raise exception '막힘 사유: 1000자 이하로 입력하세요' using errcode = '22023';
  end if;
  insert into public.pds_executions (todo_id, started_at, ended_at, actual_minutes, blocker, note)
  values (p_todo_id, p_started_at, p_ended_at, p_actual_minutes, v_blocker,
          public.pds_clean_text(p_note, '메모', 0, 1000))
  returning id into v_id;
  return v_id;
end $$;

-- ───────────────────────── 회고 집계 (카드 4) ─────────────────────────
-- 대상 = 해당 계획의 삭제되지 않은 할 일. 각 값과 함께 근거 ID 목록을 돌려준다.
create function public.pds_plan_stats(p_plan_id uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  with today as (select (now() at time zone 'Asia/Seoul')::date as d),
  t as (select * from public.pds_todos where plan_id = p_plan_id and deleted_at is null),
  e as (select e.* from public.pds_executions e join t on t.id = e.todo_id),
  blocked as (select distinct todo_id from e where blocker is not null)
  select jsonb_build_object(
    'plan_id', p_plan_id,
    'seoul_today', (select d from today),
    'planned_count', (select count(*) from t),
    'planned_todo_ids', coalesce((select jsonb_agg(id order by created_at, id) from t), '[]'),
    'done_count', (select count(*) from t where status = 'done'),
    'done_todo_ids', coalesce((select jsonb_agg(id order by created_at, id) from t where status = 'done'), '[]'),
    'overdue_count', (select count(*) from t, today where t.status = 'open' and t.due_date < today.d),
    'overdue_todo_ids', coalesce((select jsonb_agg(t.id order by t.created_at, t.id) from t, today
                                  where t.status = 'open' and t.due_date < today.d), '[]'),
    'blocked_count', (select count(*) from blocked),
    'blocked_todo_ids', coalesce((select jsonb_agg(t.id order by t.created_at, t.id) from t
                                  where t.id in (select todo_id from blocked)), '[]'),
    'estimated_minutes', coalesce((select sum(estimated_minutes) from t), 0),
    'actual_minutes', coalesce((select sum(actual_minutes) from e), 0),
    'diff_minutes', coalesce((select sum(actual_minutes) from e), 0) - coalesce((select sum(estimated_minutes) from t), 0),
    'execution_ids', coalesce((select jsonb_agg(id order by started_at, id) from e), '[]')
  );
$$;

create function public.pds_create_review(p_plan_id uuid, p_improvement text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not exists (select 1 from public.pds_plans where id = p_plan_id) then
    raise exception '계획을 찾을 수 없습니다' using errcode = 'P0002';
  end if;
  insert into public.pds_reviews (plan_id, improvement, stats, seoul_date)
  values (p_plan_id, public.pds_clean_text(p_improvement, '개선점', 1, 500), public.pds_plan_stats(p_plan_id),
          (now() at time zone 'Asia/Seoul')::date)
  returning id into v_id;
  return v_id;
end $$;

-- ───────────────────────── 전체 조회·내보내기 (카드 5) ─────────────────────────
create function public.pds_snapshot() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'schema', 'pds-schema-v2',
    'generated_at', now(),
    'seoul_today', (now() at time zone 'Asia/Seoul')::date,
    'time_unit', 'minutes',
    'timezone_display', 'Asia/Seoul',
    'plans', coalesce((select jsonb_agg(to_jsonb(p) || jsonb_build_object('stats', public.pds_plan_stats(p.id))
                                        order by p.created_at, p.id) from public.pds_plans p), '[]'),
    'plan_revisions', coalesce((select jsonb_agg(to_jsonb(r) order by r.plan_id, r.version) from public.pds_plan_revisions r), '[]'),
    'todos', coalesce((select jsonb_agg(to_jsonb(t) order by t.created_at, t.id) from public.pds_todos t), '[]'),
    'completion_events', coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from public.pds_completion_events c), '[]'),
    'executions', coalesce((select jsonb_agg(to_jsonb(x) order by x.started_at, x.id) from public.pds_executions x), '[]'),
    'reviews', coalesce((select jsonb_agg(to_jsonb(v) order by v.created_at, v.id) from public.pds_reviews v), '[]')
  );
$$;

-- ───────────────────────── 권한·RLS ─────────────────────────
alter table public.pds_plans             enable row level security;
alter table public.pds_plan_revisions    enable row level security;
alter table public.pds_todos             enable row level security;
alter table public.pds_completion_events enable row level security;
alter table public.pds_executions        enable row level security;
alter table public.pds_reviews           enable row level security;

revoke all on public.pds_plans, public.pds_plan_revisions, public.pds_todos, public.pds_completion_events,
              public.pds_executions, public.pds_reviews from public, anon, authenticated;
grant select on public.pds_plans, public.pds_plan_revisions, public.pds_todos, public.pds_completion_events,
                public.pds_executions, public.pds_reviews to anon, authenticated;

create policy pds_plans_public_read             on public.pds_plans             for select to anon, authenticated using (true);
create policy pds_plan_revisions_public_read    on public.pds_plan_revisions    for select to anon, authenticated using (true);
create policy pds_todos_public_read             on public.pds_todos             for select to anon, authenticated using (true);
create policy pds_completion_events_public_read on public.pds_completion_events for select to anon, authenticated using (true);
create policy pds_executions_public_read        on public.pds_executions        for select to anon, authenticated using (true);
create policy pds_reviews_public_read           on public.pds_reviews           for select to anon, authenticated using (true);

-- 함수: 기본 PUBLIC 실행 권한 제거 후 공개 API 함수만 anon/authenticated 에 허용
revoke execute on function
  public.pds_forbid_revision_update(), public.pds_guard_completion_event_update(),
  public.pds_clean_text(text, text, int, int), public.pds_clean_tags(text[]),
  public.pds_check_minutes(int, text), public.pds_check_priority(int),
  public.pds_create_plan(text, text, date, date, int, text, int, uuid),
  public.pds_update_plan(uuid, int, text, text, date, date, int, text, int, text),
  public.pds_create_todo(uuid, text, text, date, int, text[], int),
  public.pds_update_todo(uuid, text, text, date, int, text[], int),
  public.pds_complete_todo(uuid, uuid), public.pds_reopen_todo(uuid), public.pds_delete_todo(uuid),
  public.pds_add_execution(uuid, timestamptz, timestamptz, int, text, text),
  public.pds_plan_stats(uuid), public.pds_create_review(uuid, text), public.pds_snapshot()
from public, anon, authenticated;

grant execute on function
  public.pds_create_plan(text, text, date, date, int, text, int, uuid),
  public.pds_update_plan(uuid, int, text, text, date, date, int, text, int, text),
  public.pds_create_todo(uuid, text, text, date, int, text[], int),
  public.pds_update_todo(uuid, text, text, date, int, text[], int),
  public.pds_complete_todo(uuid, uuid), public.pds_reopen_todo(uuid), public.pds_delete_todo(uuid),
  public.pds_add_execution(uuid, timestamptz, timestamptz, int, text, text),
  public.pds_plan_stats(uuid), public.pds_create_review(uuid, text), public.pds_snapshot()
to anon, authenticated;

commit;
