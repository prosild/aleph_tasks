-- T07 Plan-Do-See 다이어리 2 — 회원 인증·인가 스키마 (pds7-schema-v1)
-- 범위: 신규 스키마 pds7_private, 신규 public.pds7_* 테이블·함수, auth.users 의 비밀번호 변경 감지 트리거 1개.
--   T06 원본(public.pds_*)과 다른 객체는 변경하지 않는다.
-- 인증: Supabase Auth(이메일+비밀번호, bcrypt). 브라우저는 publishable key + 사용자 access token(JWT)으로
--   public.pds7_* RPC 만 호출한다. 테이블 직접 접근 권한은 anon/authenticated 어디에도 주지 않는다(직접 REST → 403/401).
-- 세션 검증: JWT 서명·만료는 Data API(PostgREST)가 확인한다. 여기서는 추가로
--   ① JWT 의 session_id 가 auth.sessions 에 살아 있는지(로그아웃·계정 삭제 시 행이 지워짐)
--   ② 그 세션이 마지막 비밀번호 변경 이후에 만들어졌는지
--   를 모든 요청에서 확인한다. 둘 중 하나라도 아니면 401.
-- 시간 규칙: Asia/Seoul 날짜. 오류 코드: PT401 → HTTP 401, PT404 → HTTP 404 (PostgREST 규약), 22023 → 400.

begin;

-- ───────────────────────── 비노출 스키마 ─────────────────────────
create schema pds7_private;
revoke all on schema pds7_private from public;
-- RLS 정책이 pds7_private.current_user_id() 를 부를 수 있도록 USAGE 만 준다(이 스키마는 Data API 에 노출하지 않는다).
grant usage on schema pds7_private to authenticated;

-- T07 앱으로 가입·로그인한 계정(공유 프로젝트의 다른 계정과 구분, 계정 삭제·비밀번호 변경 기록 범위 제한)
create table pds7_private.members (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now()
);

-- 마지막 비밀번호 변경 시각(T07 회원만). 이 시각 이전에 만들어진 세션은 모두 거절한다.
create table pds7_private.password_changes (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  changed_at timestamptz not null
);

-- 이 스키마를 적용한 시각. 그보다 먼저 만든 계정(공유 프로젝트의 다른 서비스 계정)은 이 앱에서 삭제하지 못하게 한다.
create table pds7_private.settings (
  key   text primary key,
  value timestamptz not null
);
insert into pds7_private.settings (key, value) values ('schema_applied_at', now());

alter table pds7_private.members enable row level security;
alter table pds7_private.password_changes enable row level security;
alter table pds7_private.settings enable row level security;
revoke all on pds7_private.members, pds7_private.password_changes, pds7_private.settings from public, anon, authenticated;

-- 현재 요청의 사용자 ID. 세션이 살아 있고(로그아웃·삭제 안 됨, not_after 이전) 마지막 비밀번호 변경 이후 세션일 때만 반환.
-- SECURITY DEFINER 인 이유: authenticated 역할은 auth.sessions 를 읽을 권한이 없다(읽기 권한을 주지 않기 위해 이 함수로 한정).
create function pds7_private.current_user_id() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_claims jsonb;
  v_uid    uuid;
  v_sid    uuid;
begin
  begin
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  exception when others then
    return null;
  end;
  if v_claims is null
     or coalesce(v_claims ->> 'role', '') <> 'authenticated'
     or coalesce(v_claims ->> 'is_anonymous', 'false') = 'true'
     or coalesce(v_claims ->> 'sub', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or coalesce(v_claims ->> 'session_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  v_uid := (v_claims ->> 'sub')::uuid;
  v_sid := (v_claims ->> 'session_id')::uuid;
  if exists (
    select 1 from auth.sessions s
     where s.id = v_sid and s.user_id = v_uid
       and (s.not_after is null or s.not_after > now())
       and not exists (select 1 from pds7_private.password_changes pc
                        where pc.user_id = v_uid and pc.changed_at >= s.created_at)
  ) then
    return v_uid;
  end if;
  return null;
end $$;

-- 로그인 필수: 유효하지 않으면 401
create function pds7_private.require_user() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := pds7_private.current_user_id();
begin
  if v_uid is null then
    raise sqlstate 'PT401' using message = '로그인이 필요합니다', hint = '다시 로그인하세요';
  end if;
  return v_uid;
end $$;

-- 비밀번호 변경 감지: auth.users.encrypted_password 가 바뀌면(앱·직접 Auth API·재설정 메일 모두) T07 회원의 변경 시각을 기록한다.
-- auth 테이블은 읽기·삭제하지 않고 pds7_private.password_changes 한 행만 쓴다(다른 계정·서비스 영향 없음).
create function pds7_private.on_auth_password_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into pds7_private.password_changes (user_id, changed_at)
  select new.id, now()
   where exists (select 1 from pds7_private.members m where m.user_id = new.id)
  on conflict (user_id) do update set changed_at = excluded.changed_at;
  return null;
end $$;

create trigger pds7_on_password_change
  after update of encrypted_password on auth.users
  for each row
  when (old.encrypted_password is distinct from new.encrypted_password)
  execute function pds7_private.on_auth_password_change();

revoke all on function pds7_private.current_user_id(), pds7_private.require_user(),
                       pds7_private.on_auth_password_change() from public, anon, authenticated;
grant execute on function pds7_private.current_user_id() to authenticated;  -- RLS 정책용

-- ───────────────────────── 다이어리 테이블 (T06 구조 + user_id) ─────────────────────────
create table public.pds7_plans (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
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
  t06_source_id       uuid null,           -- T06 원본 pds_plans.id (이관 근거, 이관분만)
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint pds7_plans_period_chk check (end_date >= start_date),
  constraint pds7_plans_id_user_uq unique (id, user_id)
);
create index pds7_plans_user_idx on public.pds7_plans (user_id);

create table public.pds7_plan_revisions (
  id                  bigint generated always as identity primary key,
  plan_id             uuid not null,
  user_id             uuid not null,
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
  constraint pds7_plan_revisions_plan_fk foreign key (plan_id, user_id) references public.pds7_plans(id, user_id) on delete cascade,
  constraint pds7_plan_revisions_plan_version_uq unique (plan_id, version)
);
create index pds7_plan_revisions_user_idx on public.pds7_plan_revisions (user_id);

create table public.pds7_todos (
  id                uuid primary key default gen_random_uuid(),
  plan_id           uuid not null,
  user_id           uuid not null,
  title             text not null check (char_length(title) between 1 and 200),
  memo              text not null default '' check (char_length(memo) <= 2000),
  due_date          date not null,
  priority          smallint not null check (priority between 1 and 3),
  tags              text[] not null default '{}' check (cardinality(tags) <= 10),
  estimated_minutes integer not null check (estimated_minutes between 1 and 100000),
  status            text not null default 'open' check (status in ('open', 'done')),
  completed_at      timestamptz null,
  deleted_at        timestamptz null,
  t06_source_id     uuid null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint pds7_todos_plan_fk foreign key (plan_id, user_id) references public.pds7_plans(id, user_id) on delete cascade,
  constraint pds7_todos_done_chk check ((status = 'done') = (completed_at is not null)),
  constraint pds7_todos_id_user_uq unique (id, user_id)
);
create index pds7_todos_plan_idx on public.pds7_todos (plan_id);
create index pds7_todos_user_idx on public.pds7_todos (user_id);

create table public.pds7_completion_events (
  id              bigint generated always as identity primary key,
  todo_id         uuid not null,
  user_id         uuid not null,
  idempotency_key uuid not null,
  completed_at    timestamptz not null default now(),
  undone_at       timestamptz null,
  constraint pds7_completion_events_todo_fk foreign key (todo_id, user_id) references public.pds7_todos(id, user_id) on delete cascade,
  constraint pds7_completion_events_key_uq unique (idempotency_key)
);
create unique index pds7_completion_events_one_active_uq
  on public.pds7_completion_events (todo_id) where undone_at is null;
create index pds7_completion_events_user_idx on public.pds7_completion_events (user_id);

create table public.pds7_executions (
  id             uuid primary key default gen_random_uuid(),
  todo_id        uuid not null,
  user_id        uuid not null,
  started_at     timestamptz not null,
  ended_at       timestamptz not null,
  actual_minutes integer not null check (actual_minutes >= 1),
  blocker        text null check (blocker is null or char_length(blocker) between 1 and 1000),
  note           text not null default '' check (char_length(note) <= 1000),
  t06_source_id  uuid null,
  created_at     timestamptz not null default now(),
  constraint pds7_executions_todo_fk foreign key (todo_id, user_id) references public.pds7_todos(id, user_id) on delete cascade,
  constraint pds7_executions_range_chk check (ended_at > started_at and ended_at - started_at <= interval '24 hours'),
  constraint pds7_executions_minutes_chk check (actual_minutes <= ceil(extract(epoch from (ended_at - started_at)) / 60))
);
create index pds7_executions_todo_idx on public.pds7_executions (todo_id);
create index pds7_executions_user_idx on public.pds7_executions (user_id);

create table public.pds7_reviews (
  id            uuid primary key default gen_random_uuid(),
  plan_id       uuid not null,
  user_id       uuid not null,
  improvement   text not null check (char_length(improvement) between 1 and 500),
  stats         jsonb not null,
  seoul_date    date not null,
  t06_source_id uuid null,
  created_at    timestamptz not null default now(),
  constraint pds7_reviews_plan_fk foreign key (plan_id, user_id) references public.pds7_plans(id, user_id) on delete cascade,
  constraint pds7_reviews_id_user_uq unique (id, user_id)
);
create index pds7_reviews_plan_idx on public.pds7_reviews (plan_id);
create index pds7_reviews_user_idx on public.pds7_reviews (user_id);

alter table public.pds7_plans
  add constraint pds7_plans_source_review_fk
  foreign key (source_review_id, user_id) references public.pds7_reviews(id, user_id) on delete set null (source_review_id);

-- ───────────────────────── 5일 관찰 테이블 (T07 카드 5) ─────────────────────────
-- 관찰 설정: 계정당 1개. 첫 일별 기록을 남긴 뒤에는 바꿀 수 없다(1일차 고정).
create table public.pds7_observations (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  question        text not null check (char_length(question) between 1 and 300),
  metric          text not null check (char_length(metric) between 1 and 100),
  unit            text not null check (unit in ('완료 과제 수(개)', '시간(분)', '항목 수(개)', '비율 구간(%)', '그 밖의 개수')),
  calc_rule       text not null check (char_length(calc_rule) between 1 and 500),
  outlier_min     numeric(12, 2) not null,
  outlier_max     numeric(12, 2) not null,
  rounding_digits smallint not null check (rounding_digits between 0 and 2),
  week_start      text not null check (week_start in ('월요일', '일요일')),
  plan_rule       text not null check (char_length(plan_rule) between 1 and 500),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint pds7_observations_range_chk check (outlier_min <= outlier_max)
);

-- 일별 기록: 서울 날짜당 1건(같은 날 다시 저장하면 그날 값을 덮어씀). 날짜는 서버가 정한다(소급 불가).
create table public.pds7_daily_logs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.pds7_observations(user_id) on delete cascade,
  log_date   date not null,
  value      numeric(12, 2) not null,
  note       text not null default '' check (char_length(note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pds7_daily_logs_user_date_uq unique (user_id, log_date)
);
create index pds7_daily_logs_user_idx on public.pds7_daily_logs (user_id);

-- 계획 규칙 변경: 계정당 정확히 1회, 2일차 기록 뒤·3일차 기록 앞.
create table public.pds7_rule_changes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null unique references public.pds7_observations(user_id) on delete cascade,
  old_rule    text not null,
  new_rule    text not null check (char_length(new_rule) between 1 and 500),
  reason      text not null check (char_length(reason) between 1 and 500),
  day1_log_id uuid not null references public.pds7_daily_logs(id) on delete cascade,
  day2_log_id uuid not null references public.pds7_daily_logs(id) on delete cascade,
  changed_at  timestamptz not null default now(),
  seoul_date  date not null
);

-- ───────────────────────── 불변 조건 트리거 ─────────────────────────
create function pds7_private.forbid_revision_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '계획 수정 이력은 변경할 수 없습니다' using errcode = '42501';
end $$;
create trigger pds7_plan_revisions_immutable
  before update on public.pds7_plan_revisions
  for each row execute function pds7_private.forbid_revision_update();

create function pds7_private.guard_completion_event_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.todo_id <> old.todo_id or new.user_id <> old.user_id or new.idempotency_key <> old.idempotency_key
     or new.completed_at <> old.completed_at or old.undone_at is not null or new.undone_at is null then
    raise exception '완료 이벤트는 취소 시각 기록 외에 변경할 수 없습니다' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger pds7_completion_events_guard
  before update on public.pds7_completion_events
  for each row execute function pds7_private.guard_completion_event_update();

-- 소유자(user_id)는 어떤 경로로도 바꿀 수 없다
create function pds7_private.forbid_owner_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception '소유자는 변경할 수 없습니다' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger pds7_plans_owner_fixed before update of user_id on public.pds7_plans
  for each row execute function pds7_private.forbid_owner_change();
create trigger pds7_todos_owner_fixed before update of user_id on public.pds7_todos
  for each row execute function pds7_private.forbid_owner_change();
create trigger pds7_executions_owner_fixed before update of user_id on public.pds7_executions
  for each row execute function pds7_private.forbid_owner_change();
create trigger pds7_reviews_owner_fixed before update of user_id on public.pds7_reviews
  for each row execute function pds7_private.forbid_owner_change();
create trigger pds7_daily_logs_owner_fixed before update of user_id on public.pds7_daily_logs
  for each row execute function pds7_private.forbid_owner_change();
create trigger pds7_observations_owner_fixed before update of user_id on public.pds7_observations
  for each row execute function pds7_private.forbid_owner_change();
create trigger pds7_rule_changes_owner_fixed before update of user_id on public.pds7_rule_changes
  for each row execute function pds7_private.forbid_owner_change();

-- ───────────────────────── 내부 검증 도우미 ─────────────────────────
create function pds7_private.clean_text(p text, p_field text, p_min int, p_max int) returns text
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

create function pds7_private.clean_tags(p text[]) returns text[]
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

create function pds7_private.check_minutes(p int, p_field text) returns int
language plpgsql immutable set search_path = '' as $$
begin
  if p is null or p < 1 or p > 100000 then
    raise exception '%: 1~100000 분 사이 정수로 입력하세요', p_field using errcode = '22023';
  end if;
  return p;
end $$;

create function pds7_private.check_priority(p int) returns smallint
language plpgsql immutable set search_path = '' as $$
begin
  if p is null or p not in (1, 2, 3) then
    raise exception '우선순위: 1(높음)·2(보통)·3(낮음) 중 하나여야 합니다' using errcode = '22023';
  end if;
  return p::smallint;
end $$;

create function pds7_private.not_found(p_what text) returns void
language plpgsql immutable set search_path = '' as $$
begin
  -- 다른 계정의 자료와 없는 자료를 구분하지 않는다(존재 자체를 숨기는 404)
  raise sqlstate 'PT404' using message = p_what || '을(를) 찾을 수 없습니다';
end $$;

create function pds7_private.seoul_today() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'Asia/Seoul')::date;
$$;

-- ───────────────────────── 계정 (카드 1·5) ─────────────────────────
-- 로그인 직후 앱이 호출: T07 회원으로 등록하고 내 계정 정보만 돌려준다.
create function public.pds7_me() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := pds7_private.require_user();
  v_email text;
begin
  insert into pds7_private.members (user_id) values (v_uid) on conflict (user_id) do nothing;
  select email into v_email from auth.users where id = v_uid;
  return jsonb_build_object('user_id', v_uid, 'email', v_email,
    'joined_at', (select joined_at from pds7_private.members where user_id = v_uid),
    'session_expires_at', to_timestamp((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'exp')::bigint));
end $$;

-- 계정 삭제: 최근 5분 안에 비밀번호로 다시 로그인한 세션 + 확인 문구가 있어야 한다.
-- auth.users 행을 지우면 FK(on delete cascade)로 세션·리프레시 토큰·T07 자료가 함께 지워진다.
create function public.pds7_delete_account(p_confirm text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := pds7_private.require_user();
  v_sid uuid := ((nullif(current_setting('request.jwt.claims', true), '')::jsonb) ->> 'session_id')::uuid;
  v_session_created timestamptz;
  v_counts jsonb;
begin
  if coalesce(p_confirm, '') <> '계정 삭제' then
    raise exception '확인 문구로 "계정 삭제"를 정확히 입력하세요' using errcode = '22023';
  end if;
  if not exists (select 1 from pds7_private.members where user_id = v_uid)
     or (select created_at from auth.users where id = v_uid) < (select value from pds7_private.settings where key = 'schema_applied_at') then
    raise sqlstate 'PT403' using message = '이 앱에서 가입한 계정만 여기서 삭제할 수 있습니다';
  end if;
  select created_at into v_session_created from auth.sessions where id = v_sid;
  if v_session_created is null or v_session_created < now() - interval '5 minutes' then
    raise sqlstate 'PT403' using message = '보안을 위해 비밀번호를 다시 입력해 확인한 뒤 5분 안에 삭제하세요';
  end if;
  select jsonb_build_object(
    'plans', (select count(*) from public.pds7_plans where user_id = v_uid),
    'todos', (select count(*) from public.pds7_todos where user_id = v_uid),
    'executions', (select count(*) from public.pds7_executions where user_id = v_uid),
    'reviews', (select count(*) from public.pds7_reviews where user_id = v_uid),
    'daily_logs', (select count(*) from public.pds7_daily_logs where user_id = v_uid)) into v_counts;
  delete from auth.users where id = v_uid;
  return jsonb_build_object('deleted', true, 'deleted_counts', v_counts);
end $$;

-- ───────────────────────── 계획 ─────────────────────────
create function public.pds7_create_plan(
  p_title text, p_description text, p_start_date date, p_end_date date, p_priority int,
  p_success_criteria text, p_estimated_minutes int, p_source_review_id uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := pds7_private.require_user();
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
    select improvement into v_improvement from public.pds7_reviews where id = p_source_review_id and user_id = v_uid;
    if not found then perform pds7_private.not_found('회고'); end if;
  end if;

  insert into public.pds7_plans (user_id, title, description, start_date, end_date, priority, success_criteria,
                                 estimated_minutes, source_review_id, applied_improvement)
  values (v_uid, pds7_private.clean_text(p_title, '계획 제목', 1, 120),
          pds7_private.clean_text(p_description, '설명', 0, 2000),
          p_start_date, p_end_date, pds7_private.check_priority(p_priority),
          pds7_private.clean_text(p_success_criteria, '성공 기준', 1, 1000),
          pds7_private.check_minutes(p_estimated_minutes, '예상 시간'),
          p_source_review_id, v_improvement)
  returning id into v_id;

  insert into public.pds7_plan_revisions (plan_id, user_id, version, title, description, start_date, end_date, priority,
                                          success_criteria, estimated_minutes, applied_improvement, change_note)
  select id, user_id, version, title, description, start_date, end_date, priority, success_criteria,
         estimated_minutes, applied_improvement, '최초 계획'
  from public.pds7_plans where id = v_id;

  return v_id;
end $$;

create function public.pds7_update_plan(
  p_plan_id uuid, p_expected_version int, p_title text, p_description text, p_start_date date,
  p_end_date date, p_priority int, p_success_criteria text, p_estimated_minutes int, p_change_note text default ''
) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := pds7_private.require_user();
  cur public.pds7_plans%rowtype;
  v_title text;
  v_desc text;
  v_crit text;
  v_prio smallint;
  v_min int;
  v_note text;
begin
  -- 소유자 확인을 입력 검증·쓰기보다 먼저 한다(남의 ID 는 내용과 무관하게 404)
  select * into cur from public.pds7_plans where id = p_plan_id and user_id = v_uid for update;
  if not found then perform pds7_private.not_found('계획'); end if;

  v_title := pds7_private.clean_text(p_title, '계획 제목', 1, 120);
  v_desc := pds7_private.clean_text(p_description, '설명', 0, 2000);
  v_crit := pds7_private.clean_text(p_success_criteria, '성공 기준', 1, 1000);
  v_prio := pds7_private.check_priority(p_priority);
  v_min := pds7_private.check_minutes(p_estimated_minutes, '예상 시간');
  v_note := pds7_private.clean_text(p_change_note, '수정 사유', 0, 500);
  if p_start_date is null or p_end_date is null or p_end_date < p_start_date then
    raise exception '기간: 시작일·종료일을 확인하세요(종료일 ≥ 시작일)' using errcode = '22023';
  end if;
  if p_expected_version is distinct from cur.version then
    raise exception '다른 곳에서 먼저 수정되었습니다(현재 버전 %). 새로고침 후 다시 시도하세요', cur.version
      using errcode = '40001';
  end if;

  if cur.title = v_title and cur.description = v_desc and cur.start_date = p_start_date
     and cur.end_date = p_end_date and cur.priority = v_prio and cur.success_criteria = v_crit
     and cur.estimated_minutes = v_min then
    return cur.version;
  end if;

  update public.pds7_plans
     set title = v_title, description = v_desc, start_date = p_start_date, end_date = p_end_date,
         priority = v_prio, success_criteria = v_crit, estimated_minutes = v_min,
         version = cur.version + 1, updated_at = now()
   where id = p_plan_id and user_id = v_uid;

  insert into public.pds7_plan_revisions (plan_id, user_id, version, title, description, start_date, end_date, priority,
                                          success_criteria, estimated_minutes, applied_improvement, change_note)
  select id, user_id, version, title, description, start_date, end_date, priority, success_criteria,
         estimated_minutes, applied_improvement, v_note
  from public.pds7_plans where id = p_plan_id and user_id = v_uid;

  return cur.version + 1;
end $$;

-- 계획 삭제(소유자만): 연결된 할 일·실행·회고·이력이 함께 지워진다
create function public.pds7_delete_plan(p_plan_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := pds7_private.require_user();
begin
  delete from public.pds7_plans where id = p_plan_id and user_id = v_uid;
  if not found then perform pds7_private.not_found('계획'); end if;
  return jsonb_build_object('deleted', true);
end $$;

-- ───────────────────────── 할 일 ─────────────────────────
create function public.pds7_create_todo(
  p_plan_id uuid, p_title text, p_memo text, p_due_date date, p_priority int, p_tags text[], p_estimated_minutes int
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := pds7_private.require_user();
  v_id uuid;
begin
  if not exists (select 1 from public.pds7_plans where id = p_plan_id and user_id = v_uid) then
    perform pds7_private.not_found('계획');
  end if;
  if p_due_date is null then
    raise exception '마감일: 날짜를 입력하세요' using errcode = '22023';
  end if;
  insert into public.pds7_todos (plan_id, user_id, title, memo, due_date, priority, tags, estimated_minutes)
  values (p_plan_id, v_uid, pds7_private.clean_text(p_title, '할 일 제목', 1, 200), pds7_private.clean_text(p_memo, '메모', 0, 2000),
          p_due_date, pds7_private.check_priority(p_priority), pds7_private.clean_tags(p_tags),
          pds7_private.check_minutes(p_estimated_minutes, '예상 시간'))
  returning id into v_id;
  return v_id;
end $$;

-- 할 일 1건 조회(소유자만, 다른 계정 자료는 404)
create function public.pds7_get_todo(p_todo_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := pds7_private.require_user();
  v jsonb;
begin
  select to_jsonb(t) into v from public.pds7_todos t where t.id = p_todo_id and t.user_id = v_uid;
  if v is null then perform pds7_private.not_found('할 일'); end if;
  return v;
end $$;

create function public.pds7_update_todo(
  p_todo_id uuid, p_title text, p_memo text, p_due_date date, p_priority int, p_tags text[], p_estimated_minutes int
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := pds7_private.require_user();
begin
  perform 1 from public.pds7_todos where id = p_todo_id and user_id = v_uid and deleted_at is null for update;
  if not found then perform pds7_private.not_found('할 일'); end if;
  if p_due_date is null then
    raise exception '마감일: 날짜를 입력하세요' using errcode = '22023';
  end if;
  update public.pds7_todos
     set title = pds7_private.clean_text(p_title, '할 일 제목', 1, 200),
         memo = pds7_private.clean_text(p_memo, '메모', 0, 2000),
         due_date = p_due_date, priority = pds7_private.check_priority(p_priority),
         tags = pds7_private.clean_tags(p_tags),
         estimated_minutes = pds7_private.check_minutes(p_estimated_minutes, '예상 시간'),
         updated_at = now()
   where id = p_todo_id and user_id = v_uid;
end $$;

create function public.pds7_complete_todo(p_todo_id uuid, p_idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := pds7_private.require_user();
  t public.pds7_todos%rowtype;
  ev public.pds7_completion_events%rowtype;
begin
  select * into t from public.pds7_todos where id = p_todo_id and user_id = v_uid for update;
  if not found or t.deleted_at is not null then perform pds7_private.not_found('할 일'); end if;
  if p_idempotency_key is null then
    raise exception '멱등성 키가 필요합니다' using errcode = '22023';
  end if;

  select * into ev from public.pds7_completion_events where idempotency_key = p_idempotency_key;
  if found then
    if ev.todo_id <> p_todo_id or ev.user_id <> v_uid then
      raise exception '다른 할 일에 사용된 멱등성 키입니다' using errcode = '22023';
    end if;
    return jsonb_build_object('created', false, 'reason', 'duplicate_request', 'event_id', ev.id, 'status', t.status);
  end if;

  if t.status = 'done' then
    return jsonb_build_object('created', false, 'reason', 'already_done', 'status', t.status);
  end if;

  insert into public.pds7_completion_events (todo_id, user_id, idempotency_key)
  values (p_todo_id, v_uid, p_idempotency_key)
  returning * into ev;
  update public.pds7_todos set status = 'done', completed_at = ev.completed_at, updated_at = now()
   where id = p_todo_id and user_id = v_uid;
  return jsonb_build_object('created', true, 'event_id', ev.id, 'status', 'done');
end $$;

create function public.pds7_reopen_todo(p_todo_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := pds7_private.require_user();
  t public.pds7_todos%rowtype;
begin
  select * into t from public.pds7_todos where id = p_todo_id and user_id = v_uid for update;
  if not found or t.deleted_at is not null then perform pds7_private.not_found('할 일'); end if;
  if t.status = 'open' then
    return jsonb_build_object('changed', false, 'status', 'open');
  end if;
  update public.pds7_completion_events set undone_at = now()
   where todo_id = p_todo_id and user_id = v_uid and undone_at is null;
  update public.pds7_todos set status = 'open', completed_at = null, updated_at = now()
   where id = p_todo_id and user_id = v_uid;
  return jsonb_build_object('changed', true, 'status', 'open');
end $$;

-- 삭제: T06 과 같이 삭제 표시(deleted_at)만 남긴다(실행 기록 보존)
create function public.pds7_delete_todo(p_todo_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := pds7_private.require_user();
  v_deleted timestamptz;
begin
  select deleted_at into v_deleted from public.pds7_todos where id = p_todo_id and user_id = v_uid for update;
  if not found then perform pds7_private.not_found('할 일'); end if;
  if v_deleted is not null then
    return jsonb_build_object('changed', false);
  end if;
  update public.pds7_todos set deleted_at = now(), updated_at = now() where id = p_todo_id and user_id = v_uid;
  return jsonb_build_object('changed', true);
end $$;

-- ───────────────────────── 실행 기록 ─────────────────────────
create function public.pds7_add_execution(
  p_todo_id uuid, p_started_at timestamptz, p_ended_at timestamptz, p_actual_minutes int,
  p_blocker text default null, p_note text default ''
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := pds7_private.require_user();
  v_id uuid;
  v_span int;
  v_blocker text := nullif(btrim(coalesce(p_blocker, '')), '');
begin
  if not exists (select 1 from public.pds7_todos where id = p_todo_id and user_id = v_uid and deleted_at is null) then
    perform pds7_private.not_found('할 일');
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
  insert into public.pds7_executions (todo_id, user_id, started_at, ended_at, actual_minutes, blocker, note)
  values (p_todo_id, v_uid, p_started_at, p_ended_at, p_actual_minutes, v_blocker,
          pds7_private.clean_text(p_note, '메모', 0, 1000))
  returning id into v_id;
  return v_id;
end $$;

-- ───────────────────────── 회고 ─────────────────────────
-- 내부 집계(호출자가 소유자 확인 후 사용). T06 pds_plan_stats 와 같은 정의 + user_id 조건.
create function pds7_private.plan_stats(p_plan_id uuid, p_uid uuid) returns jsonb
language sql stable set search_path = '' as $$
  with today as (select pds7_private.seoul_today() as d),
  t as (select * from public.pds7_todos where plan_id = p_plan_id and user_id = p_uid and deleted_at is null),
  e as (select e.* from public.pds7_executions e join t on t.id = e.todo_id where e.user_id = p_uid),
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

create function public.pds7_create_review(p_plan_id uuid, p_improvement text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := pds7_private.require_user();
  v_id uuid;
begin
  if not exists (select 1 from public.pds7_plans where id = p_plan_id and user_id = v_uid) then
    perform pds7_private.not_found('계획');
  end if;
  insert into public.pds7_reviews (plan_id, user_id, improvement, stats, seoul_date)
  values (p_plan_id, v_uid, pds7_private.clean_text(p_improvement, '개선점', 1, 500), pds7_private.plan_stats(p_plan_id, v_uid),
          pds7_private.seoul_today())
  returning id into v_id;
  return v_id;
end $$;

-- ───────────────────────── 5일 관찰 ─────────────────────────
create function public.pds7_save_observation(
  p_question text, p_metric text, p_unit text, p_calc_rule text, p_outlier_min numeric, p_outlier_max numeric,
  p_rounding_digits int, p_week_start text, p_plan_rule text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := pds7_private.require_user();
begin
  if exists (select 1 from public.pds7_daily_logs where user_id = v_uid) then
    raise exception '1일차 기록 뒤에는 관찰 질문·지표·단위·규칙을 바꿀 수 없습니다(고정)' using errcode = '22023';
  end if;
  if p_unit is null or p_unit not in ('완료 과제 수(개)', '시간(분)', '항목 수(개)', '비율 구간(%)', '그 밖의 개수') then
    raise exception '측정 단위: 목록에서 고르세요' using errcode = '22023';
  end if;
  if p_outlier_min is null or p_outlier_max is null or p_outlier_min > p_outlier_max then
    raise exception '이상값 기준: 최솟값 ≤ 최댓값으로 입력하세요' using errcode = '22023';
  end if;
  if p_rounding_digits is null or p_rounding_digits not between 0 and 2 then
    raise exception '반올림 자릿수: 0~2 중 고르세요' using errcode = '22023';
  end if;
  if p_week_start is null or p_week_start not in ('월요일', '일요일') then
    raise exception '주 시작 요일: 월요일 또는 일요일' using errcode = '22023';
  end if;
  insert into public.pds7_observations (user_id, question, metric, unit, calc_rule, outlier_min, outlier_max,
                                        rounding_digits, week_start, plan_rule)
  values (v_uid, pds7_private.clean_text(p_question, '관찰 질문', 1, 300), pds7_private.clean_text(p_metric, '측정 지표', 1, 100),
          p_unit, pds7_private.clean_text(p_calc_rule, '계산 규칙', 1, 500), p_outlier_min, p_outlier_max,
          p_rounding_digits, p_week_start, pds7_private.clean_text(p_plan_rule, '계획 규칙', 1, 500))
  on conflict (user_id) do update
    set question = excluded.question, metric = excluded.metric, unit = excluded.unit, calc_rule = excluded.calc_rule,
        outlier_min = excluded.outlier_min, outlier_max = excluded.outlier_max,
        rounding_digits = excluded.rounding_digits, week_start = excluded.week_start,
        plan_rule = excluded.plan_rule, updated_at = now();
  return jsonb_build_object('saved', true);
end $$;

-- 오늘(서울) 기록 저장. 같은 날 다시 저장하면 덮어쓴다. 3일차는 규칙 변경 뒤에만, 최대 5일.
create function public.pds7_save_daily_log(p_value numeric, p_note text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := pds7_private.require_user();
  o public.pds7_observations%rowtype;
  v_today date := pds7_private.seoul_today();
  v_existing public.pds7_daily_logs%rowtype;
  v_count int;
  v_id uuid;
begin
  select * into o from public.pds7_observations where user_id = v_uid;
  if not found then
    raise exception '먼저 관찰 질문·지표·규칙을 저장하세요' using errcode = '22023';
  end if;
  if p_value is null then
    raise exception '값을 입력하세요' using errcode = '22023';
  end if;
  if p_value <> round(p_value, 2) then
    raise exception '값은 소수 둘째 자리까지 입력하세요' using errcode = '22023';
  end if;
  if p_value < o.outlier_min or p_value > o.outlier_max then
    raise exception '이상값: % ~ % 범위 밖의 값은 저장하지 않습니다. 값을 다시 확인하세요', o.outlier_min, o.outlier_max
      using errcode = '22023';
  end if;
  select * into v_existing from public.pds7_daily_logs where user_id = v_uid and log_date = v_today for update;
  if found then
    if exists (select 1 from public.pds7_rule_changes rc where rc.user_id = v_uid
               and v_existing.id in (rc.day1_log_id, rc.day2_log_id)) then
      raise exception '규칙 변경에 연결된 1·2일차 기록은 고칠 수 없습니다' using errcode = '22023';
    end if;
    update public.pds7_daily_logs set value = p_value, note = pds7_private.clean_text(p_note, '메모', 0, 500), updated_at = now()
     where id = v_existing.id;
    return jsonb_build_object('id', v_existing.id, 'log_date', v_today, 'overwritten', true);
  end if;
  select count(*) into v_count from public.pds7_daily_logs where user_id = v_uid;
  if v_count >= 5 then
    raise exception '5일 기록을 모두 남겼습니다' using errcode = '22023';
  end if;
  if v_count = 2 and not exists (select 1 from public.pds7_rule_changes where user_id = v_uid) then
    raise exception '3일차 기록 전에 계획 규칙을 한 번 바꿔야 합니다' using errcode = '22023';
  end if;
  insert into public.pds7_daily_logs (user_id, log_date, value, note)
  values (v_uid, v_today, p_value, pds7_private.clean_text(p_note, '메모', 0, 500))
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'log_date', v_today, 'overwritten', false);
end $$;

-- 계획 규칙 1회 변경: 1·2일차 기록이 정확히 있을 때만(2일차 뒤·3일차 앞)
create function public.pds7_change_rule(p_new_rule text, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := pds7_private.require_user();
  o public.pds7_observations%rowtype;
  v_ids uuid[];
  v_id uuid;
begin
  select * into o from public.pds7_observations where user_id = v_uid for update;
  if not found then
    raise exception '먼저 관찰 설정을 저장하세요' using errcode = '22023';
  end if;
  if exists (select 1 from public.pds7_rule_changes where user_id = v_uid) then
    raise exception '계획 규칙은 한 번만 바꿀 수 있습니다' using errcode = '22023';
  end if;
  select array_agg(id order by log_date) into v_ids from public.pds7_daily_logs where user_id = v_uid;
  if coalesce(cardinality(v_ids), 0) <> 2 then
    raise exception '규칙 변경은 2일차 기록 뒤, 3일차 기록 앞에만 할 수 있습니다(현재 기록 %일)', coalesce(cardinality(v_ids), 0)
      using errcode = '22023';
  end if;
  insert into public.pds7_rule_changes (user_id, old_rule, new_rule, reason, day1_log_id, day2_log_id, seoul_date)
  values (v_uid, o.plan_rule, pds7_private.clean_text(p_new_rule, '바꾼 계획 규칙', 1, 500),
          pds7_private.clean_text(p_reason, '바꾼 이유', 1, 500), v_ids[1], v_ids[2], pds7_private.seoul_today())
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end $$;

-- 관찰 집계: 규칙 변경 전(1·2일차)·후(3~5일차)·전체를 같은 지표·단위·계산 규칙으로 계산
create function pds7_private.observation_stats(p_uid uuid) returns jsonb
language sql stable set search_path = '' as $$
  with o as (select * from public.pds7_observations where user_id = p_uid),
  l as (select d.*, row_number() over (order by d.log_date) as day_no from public.pds7_daily_logs d where d.user_id = p_uid),
  g as (
    select 'before' as phase, * from l where day_no <= 2
    union all select 'after', * from l where day_no >= 3
    union all select 'all', * from l
  )
  select case when not exists (select 1 from o) then null else jsonb_build_object(
    'rounding_digits', (select rounding_digits from o),
    'phases', coalesce((select jsonb_object_agg(phase, x) from (
       select p.phase, jsonb_build_object(
         'days', count(g.id),
         'sum', coalesce(sum(g.value), 0),
         'avg', case when count(g.id) = 0 then null else round(avg(g.value), (select rounding_digits from o)) end,
         'log_ids', coalesce(jsonb_agg(g.id order by g.log_date) filter (where g.id is not null), '[]')) as x
       from (values ('before'), ('after'), ('all')) p(phase) left join g on g.phase = p.phase
       group by p.phase) s), '{}')
  ) end;
$$;

-- ───────────────────────── 내 자료 전체 조회·내보내기 ─────────────────────────
create function public.pds7_snapshot() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := pds7_private.require_user();
begin
  return jsonb_build_object(
    'schema', 'pds7-schema-v1',
    'generated_at', now(),
    'seoul_today', pds7_private.seoul_today(),
    'time_unit', 'minutes',
    'timezone_display', 'Asia/Seoul',
    'plans', coalesce((select jsonb_agg(to_jsonb(p) || jsonb_build_object('stats', pds7_private.plan_stats(p.id, v_uid))
                                        order by p.created_at, p.id) from public.pds7_plans p where p.user_id = v_uid), '[]'),
    'plan_revisions', coalesce((select jsonb_agg(to_jsonb(r) order by r.plan_id, r.version) from public.pds7_plan_revisions r where r.user_id = v_uid), '[]'),
    'todos', coalesce((select jsonb_agg(to_jsonb(t) order by t.created_at, t.id) from public.pds7_todos t where t.user_id = v_uid), '[]'),
    'completion_events', coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from public.pds7_completion_events c where c.user_id = v_uid), '[]'),
    'executions', coalesce((select jsonb_agg(to_jsonb(x) order by x.started_at, x.id) from public.pds7_executions x where x.user_id = v_uid), '[]'),
    'reviews', coalesce((select jsonb_agg(to_jsonb(v) order by v.created_at, v.id) from public.pds7_reviews v where v.user_id = v_uid), '[]'),
    'observation', (select to_jsonb(o) from public.pds7_observations o where o.user_id = v_uid),
    'daily_logs', coalesce((select jsonb_agg(to_jsonb(d) order by d.log_date) from public.pds7_daily_logs d where d.user_id = v_uid), '[]'),
    'rule_change', (select to_jsonb(rc) from public.pds7_rule_changes rc where rc.user_id = v_uid),
    'observation_stats', pds7_private.observation_stats(v_uid)
  );
end $$;

-- ───────────────────────── 권한·RLS ─────────────────────────
-- 테이블: RLS 활성 + 소유자·세션 조건 정책(심층 방어). 직접 접근 권한은 주지 않는다 → Data API 직접 요청은 401/403.
alter table public.pds7_plans             enable row level security;
alter table public.pds7_plan_revisions    enable row level security;
alter table public.pds7_todos             enable row level security;
alter table public.pds7_completion_events enable row level security;
alter table public.pds7_executions        enable row level security;
alter table public.pds7_reviews           enable row level security;
alter table public.pds7_observations      enable row level security;
alter table public.pds7_daily_logs        enable row level security;
alter table public.pds7_rule_changes      enable row level security;

revoke all on public.pds7_plans, public.pds7_plan_revisions, public.pds7_todos, public.pds7_completion_events,
              public.pds7_executions, public.pds7_reviews, public.pds7_observations, public.pds7_daily_logs,
              public.pds7_rule_changes from public, anon, authenticated;

create policy pds7_plans_owner             on public.pds7_plans             for select to authenticated using (user_id = (select pds7_private.current_user_id()));
create policy pds7_plan_revisions_owner    on public.pds7_plan_revisions    for select to authenticated using (user_id = (select pds7_private.current_user_id()));
create policy pds7_todos_owner             on public.pds7_todos             for select to authenticated using (user_id = (select pds7_private.current_user_id()));
create policy pds7_completion_events_owner on public.pds7_completion_events for select to authenticated using (user_id = (select pds7_private.current_user_id()));
create policy pds7_executions_owner        on public.pds7_executions        for select to authenticated using (user_id = (select pds7_private.current_user_id()));
create policy pds7_reviews_owner           on public.pds7_reviews           for select to authenticated using (user_id = (select pds7_private.current_user_id()));
create policy pds7_observations_owner      on public.pds7_observations      for select to authenticated using (user_id = (select pds7_private.current_user_id()));
create policy pds7_daily_logs_owner        on public.pds7_daily_logs        for select to authenticated using (user_id = (select pds7_private.current_user_id()));
create policy pds7_rule_changes_owner      on public.pds7_rule_changes      for select to authenticated using (user_id = (select pds7_private.current_user_id()));

-- 함수: 기본 PUBLIC 실행 권한을 모두 제거하고, 공개 RPC 만 authenticated 에 허용(anon 불가 → 401)
revoke execute on function
  pds7_private.forbid_revision_update(), pds7_private.guard_completion_event_update(), pds7_private.forbid_owner_change(),
  pds7_private.clean_text(text, text, int, int), pds7_private.clean_tags(text[]),
  pds7_private.check_minutes(int, text), pds7_private.check_priority(int), pds7_private.not_found(text),
  pds7_private.seoul_today(), pds7_private.plan_stats(uuid, uuid), pds7_private.observation_stats(uuid),
  public.pds7_me(), public.pds7_delete_account(text),
  public.pds7_create_plan(text, text, date, date, int, text, int, uuid),
  public.pds7_update_plan(uuid, int, text, text, date, date, int, text, int, text),
  public.pds7_delete_plan(uuid),
  public.pds7_create_todo(uuid, text, text, date, int, text[], int),
  public.pds7_get_todo(uuid),
  public.pds7_update_todo(uuid, text, text, date, int, text[], int),
  public.pds7_complete_todo(uuid, uuid), public.pds7_reopen_todo(uuid), public.pds7_delete_todo(uuid),
  public.pds7_add_execution(uuid, timestamptz, timestamptz, int, text, text),
  public.pds7_create_review(uuid, text),
  public.pds7_save_observation(text, text, text, text, numeric, numeric, int, text, text),
  public.pds7_save_daily_log(numeric, text), public.pds7_change_rule(text, text),
  public.pds7_snapshot()
from public, anon, authenticated;

grant execute on function
  public.pds7_me(), public.pds7_delete_account(text),
  public.pds7_create_plan(text, text, date, date, int, text, int, uuid),
  public.pds7_update_plan(uuid, int, text, text, date, date, int, text, int, text),
  public.pds7_delete_plan(uuid),
  public.pds7_create_todo(uuid, text, text, date, int, text[], int),
  public.pds7_get_todo(uuid),
  public.pds7_update_todo(uuid, text, text, date, int, text[], int),
  public.pds7_complete_todo(uuid, uuid), public.pds7_reopen_todo(uuid), public.pds7_delete_todo(uuid),
  public.pds7_add_execution(uuid, timestamptz, timestamptz, int, text, text),
  public.pds7_create_review(uuid, text),
  public.pds7_save_observation(text, text, text, text, numeric, numeric, int, text, text),
  public.pds7_save_daily_log(numeric, text), public.pds7_change_rule(text, text),
  public.pds7_snapshot()
to authenticated;

commit;
