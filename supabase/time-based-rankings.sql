-- ============================================================
-- 시간별 주간 랭킹 마이그레이션
-- - 기존 플레이는 60초 기록으로 보존
-- - 10/30/60/120/300초 랭킹을 각각 분리 집계
-- - 여러 번 실행해도 안전
-- ============================================================

begin;

alter table public.plays
  add column if not exists duration_sec integer;

update public.plays
   set duration_sec = 60
 where duration_sec is null;

alter table public.plays
  alter column duration_sec set default 60,
  alter column duration_sec set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'plays_duration_sec_check'
       and conrelid = 'public.plays'::regclass
  ) then
    alter table public.plays
      add constraint plays_duration_sec_check
      check (duration_sec in (10, 30, 60, 120, 300));
  end if;
end;
$$;

create index if not exists plays_weekly_duration_rank_idx
  on public.plays (rank_mode, duration_sec, created_at, user_id, score desc);

create or replace function public.weekly_ranking_by_duration(
  p_mode text,
  p_duration integer,
  p_limit integer default 50
)
returns table (
  rank bigint,
  user_id uuid,
  nickname text,
  theme_line text,
  best_score bigint
)
language sql
security definer
set search_path = ''
stable
as $$
  with user_bests as (
    select plays.user_id,
           max(plays.score)::bigint as best_score,
           min(plays.created_at) as first_played_at
      from public.plays
     where plays.rank_mode = p_mode
       and plays.duration_sec = p_duration
       and plays.created_at >= (
         date_trunc('week', now() at time zone 'UTC') at time zone 'UTC'
       )
     group by plays.user_id
  )
  select row_number() over (order by user_bests.best_score desc, user_bests.first_played_at),
         user_bests.user_id,
         profiles.nickname,
         profiles.theme_line,
         user_bests.best_score
    from user_bests
    join public.profiles on profiles.id = user_bests.user_id
   order by user_bests.best_score desc, user_bests.first_played_at
   limit greatest(1, least(coalesce(p_limit, 50), 100));
$$;

revoke all on function public.weekly_ranking_by_duration(text, integer, integer) from public;
grant execute on function public.weekly_ranking_by_duration(text, integer, integer) to anon, authenticated;

commit;
