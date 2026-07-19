-- ============================================================
-- 저장됐지만 랭킹에서 누락되는 플레이 복구
-- - rank_mode/region/mode가 비거나 서로 다른 과거 기록 정규화
-- - 구버전(950ms)과 현행(500ms)의 theoretical_max 차이를 서버 기준으로 통일
-- - 프로필 행이 없어도 플레이는 익명 사용자로 집계
-- - 100위 경계의 동점자는 모두 표시
-- - plays 기록을 삭제하지 않으며 여러 번 실행해도 안전
-- ============================================================

begin;

alter table public.plays
  add column if not exists duration_sec integer;

alter table public.plays
  add column if not exists theoretical_max integer;

create or replace function public.normalized_play_rank_mode(
  p_rank_mode text,
  p_region text,
  p_mode text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when lower(btrim(coalesce(p_rank_mode, ''))) ~
         '^(seoul|nationwide|busan|daegu|daejeon|gwangju):(core|all|custom)$'
      then lower(btrim(p_rank_mode))
    else lower(coalesce(nullif(btrim(p_region), ''), 'seoul')) || ':' ||
         lower(coalesce(nullif(btrim(p_mode), ''), 'all'))
  end;
$$;

create or replace function public.ranking_theoretical_max(
  p_rank_mode text,
  p_duration integer
)
returns integer
language sql
immutable
set search_path = ''
as $$
  select greatest(
    1,
    least(
      case lower(btrim(coalesce(p_rank_mode, '')))
        when 'seoul:core' then 404
        when 'seoul:all' then 655
        when 'nationwide:all' then 940
        when 'busan:all' then 147
        when 'daegu:all' then 96
        when 'daejeon:all' then 22
        when 'gwangju:all' then 20
        else 2147483647
      end,
      ceil(greatest(coalesce(p_duration, 60), 1) * 1000.0 / 500.0)::integer
    )
  );
$$;

update public.plays
   set duration_sec = 60
 where duration_sec is null;

with normalized as (
  select id,
         public.normalized_play_rank_mode(rank_mode, region, mode) as rank_mode
    from public.plays
)
update public.plays as plays
   set rank_mode = normalized.rank_mode,
       region = split_part(normalized.rank_mode, ':', 1),
       mode = split_part(normalized.rank_mode, ':', 2)
  from normalized
 where plays.id = normalized.id
   and (plays.rank_mode, plays.region, plays.mode) is distinct from
       (normalized.rank_mode,
        split_part(normalized.rank_mode, ':', 1),
        split_part(normalized.rank_mode, ':', 2));

update public.plays
   set theoretical_max = public.ranking_theoretical_max(rank_mode, duration_sec)
 where duration_sec in (60, 120, 300)
   and theoretical_max is distinct from
       public.ranking_theoretical_max(rank_mode, duration_sec);

alter table public.plays
  alter column duration_sec set default 60,
  alter column theoretical_max set default 120;

create or replace function public.normalize_play_ranking_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.region := lower(coalesce(nullif(btrim(new.region), ''), 'seoul'));
  new.mode := lower(coalesce(nullif(btrim(new.mode), ''), 'all'));
  new.rank_mode := new.region || ':' || new.mode;
  new.theoretical_max := public.ranking_theoretical_max(new.rank_mode, new.duration_sec);
  return new;
end;
$$;

drop trigger if exists normalize_play_ranking_fields_trigger on public.plays;
create trigger normalize_play_ranking_fields_trigger
before insert or update of region, mode, rank_mode, duration_sec, theoretical_max
on public.plays
for each row execute function public.normalize_play_ranking_fields();

revoke all on function public.normalize_play_ranking_fields() from public;

create index if not exists plays_ranking_source_idx
  on public.plays (region, mode, duration_sec, user_id, score desc, created_at);

drop function if exists public.all_time_ranking_by_duration(text, integer, integer);

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
  with eligible_plays as (
    select plays.user_id,
           plays.score::bigint as score,
           public.ranking_theoretical_max(p_mode, p_duration)::bigint as theoretical_max,
           plays.created_at
      from public.plays
     where public.normalized_play_rank_mode(
             plays.rank_mode, plays.region, plays.mode
           ) = p_mode
       and plays.duration_sec = p_duration
       and p_duration in (60, 120, 300)
  ),
  user_bests as (
    select distinct on (eligible_plays.user_id)
           eligible_plays.user_id,
           eligible_plays.score as best_score,
           eligible_plays.theoretical_max,
           eligible_plays.created_at as first_played_at
      from eligible_plays
     order by eligible_plays.user_id,
              eligible_plays.score desc,
              eligible_plays.created_at
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
  ),
  ranked as (
    select rank() over (order by fully_scored.adjusted_score desc) as ranking,
           fully_scored.*
      from fully_scored
  )
  select ranked.ranking,
         ranked.user_id,
         coalesce(profiles.nickname, '알 수 없는 사용자'),
         coalesce(profiles.theme_line, 'L1'),
         ranked.best_score,
         ranked.theoretical_max,
         ranked.record_points,
         ranked.percentile_bonus,
         ranked.adjusted_score
    from ranked
    left join public.profiles on profiles.id = ranked.user_id
   where ranked.ranking <= greatest(1, least(coalesce(p_limit, 100), 100))
   order by ranked.adjusted_score desc, ranked.best_score desc, ranked.first_played_at;
$$;

revoke all on function public.all_time_ranking_by_duration(text, integer, integer) from public;
grant execute on function public.all_time_ranking_by_duration(text, integer, integer) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
