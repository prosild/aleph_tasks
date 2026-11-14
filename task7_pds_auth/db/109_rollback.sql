-- T07 101 되돌림(필요할 때만, 검토 후 실행). auth.users 트리거를 먼저 지우고 T07 객체만 삭제한다.
-- T06 원본(public.pds_*)·기존 Auth 사용자·다른 객체는 건드리지 않는다. T07 자료(pds7_*)는 함께 사라진다.
begin;
drop trigger if exists pds7_on_password_change on auth.users;
drop function if exists
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
  public.pds7_snapshot();
drop table if exists public.pds7_rule_changes, public.pds7_daily_logs, public.pds7_observations,
  public.pds7_completion_events, public.pds7_executions, public.pds7_plan_revisions, public.pds7_todos;
alter table if exists public.pds7_plans drop constraint if exists pds7_plans_source_review_fk;
drop table if exists public.pds7_reviews, public.pds7_plans;
drop schema if exists pds7_private cascade;
commit;
