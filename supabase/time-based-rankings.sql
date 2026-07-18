-- ============================================================
-- 시간별 역대 랭킹 마이그레이션
-- - 기존 플레이는 60초 기록으로 보존
-- - 10/30/60/120/300초 랭킹을 각각 분리 집계
-- - 날짜 제한 없이 전체 기간의 최고 기록을 집계
-- - 기록 70점 + 백분위 30점, 분야별 이론 최고점 100점
-- - 여러 번 실행해도 안전
-- ============================================================

begin;

alter table public.plays
  add column if not exists duration_sec integer;

alter table public.plays
  add column if not exists theoretical_max integer;

update public.plays
   set duration_sec = 60
 where duration_sec is null;

-- 기존 기록은 당시 950ms 전환 규칙의 시간상 최고치로 보정한다.
-- 노선의 역 수가 더 적으면 실제 출제 가능한 역 수를 최고치로 사용한다.
update public.plays
   set theoretical_max = least(
     case rank_mode
       when 'seoul:core' then 404
       when 'seoul:all' then 655
       when 'nationwide:all' then 940
       when 'busan:all' then 147
       when 'daegu:all' then 96
       when 'daejeon:all' then 22
       when 'gwangju:all' then 20
       else 2147483647
     end,
     case duration_sec
       when 10 then 11
       when 30 then 32
       when 60 then 64
       when 120 then 127
       when 300 then 316
       else greatest(1, ceil(duration_sec * 1000.0 / 950.0)::integer)
     end
   )
 where theoretical_max is null;

alter table public.plays
  alter column duration_sec set default 60,
  alter column duration_sec set not null,
  alter column theoretical_max set default 64,
  alter column theoretical_max set not null;

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
  if not exists (
    select 1 from pg_constraint
     where conname = 'plays_theoretical_max_check'
       and conrelid = 'public.plays'::regclass
  ) then
    alter table public.plays
      add constraint plays_theoretical_max_check
      check (theoretical_max > 0);
  end if;
end;
$$;

drop index if exists public.plays_weekly_duration_rank_idx;

create index if not exists plays_duration_rank_idx
  on public.plays (rank_mode, duration_sec, user_id, score desc, created_at);

-- 반환 컬럼이 확장될 수 있도록 이전 버전 함수를 먼저 제거한다.
drop function if exists public.all_time_ranking_by_duration(text, integer, integer);
drop function if exists public.weekly_ranking_by_duration(text, integer, integer);
drop function if exists public.weekly_ranking(text, integer);

create function public.all_time_ranking_by_duration(
  p_mode text,
  p_duration integer,
  p_limit integer default 100
)
returns table (
  rank bigint,
  user_id uuid,
  nickname text,
  theme_line text,
  best_score bigint,
  theoretical_max bigint,
  record_points numeric,
  percentile_bonus numeric,
  adjusted_score numeric
)
language sql
security definer
set search_path = ''
stable
as $$
  with user_bests as (
    select distinct on (plays.user_id)
           plays.user_id,
           plays.score::bigint as best_score,
           plays.theoretical_max::bigint as theoretical_max,
           plays.created_at as first_played_at
      from public.plays
     where plays.rank_mode = p_mode
       and plays.duration_sec = p_duration
     order by plays.user_id,
              (plays.score::numeric / plays.theoretical_max) desc,
              plays.score desc,
              plays.created_at
  ),
  record_scored as (
    select user_bests.*,
           round(
             70 * sqrt(greatest(0, least(1, user_bests.best_score::numeric / user_bests.theoretical_max))),
             2
           ) as record_points
      from user_bests
  ),
  percentile_scored as (
    select record_scored.*,
           case when count(*) over () = 1 then 30::numeric
                else round(30 * (percent_rank() over (order by record_scored.record_points))::numeric, 2)
            end as percentile_bonus
      from record_scored
  ),
  fully_scored as (
    select percentile_scored.*,
           round(percentile_scored.record_points + percentile_scored.percentile_bonus, 2) as adjusted_score
      from percentile_scored
  )
  select rank() over (order by fully_scored.adjusted_score desc),
         fully_scored.user_id,
         profiles.nickname,
         profiles.theme_line,
         fully_scored.best_score,
         fully_scored.theoretical_max,
         fully_scored.record_points,
         fully_scored.percentile_bonus,
         fully_scored.adjusted_score
    from fully_scored
    join public.profiles on profiles.id = fully_scored.user_id
   order by fully_scored.adjusted_score desc, fully_scored.best_score desc, fully_scored.first_played_at
   limit greatest(1, least(coalesce(p_limit, 100), 100));
$$;

revoke all on function public.all_time_ranking_by_duration(text, integer, integer) from public;
grant execute on function public.all_time_ranking_by_duration(text, integer, integer) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
