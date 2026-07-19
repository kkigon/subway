-- ============================================================
-- 시간별 역대 랭킹 마이그레이션
-- - 기존 플레이는 60초 기록으로 보존
-- - 60/120/300초 랭킹을 각각 분리 집계
-- - 폐지된 10/30초 기록은 삭제
-- - 날짜 제한 없이 전체 기간의 최고 기록을 집계
-- - 기록 70점 + 백분위 30점, 분야별 이론 최고점 100점
-- - 여러 번 실행해도 안전
-- ============================================================

begin;

alter table public.plays
  add column if not exists duration_sec integer;

alter table public.plays
  add column if not exists theoretical_max integer;

alter table public.plays
  add column if not exists play_variant text;

-- rank_mode는 region/mode의 중복 저장값이라 예전 클라이언트나 부분 마이그레이션에서
-- 비어 있을 수 있다. 조회 때도 쓸 수 있는 단일 정규화 함수를 둔다.
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

-- 클라이언트 버전에 따라 달라질 수 있는 theoretical_max를 신뢰하지 않는다.
-- 현재 게임의 정답 공개 간격(500ms)과 노선별 역 수로 서버가 같은 기준을 계산한다.
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

-- 이 마이그레이션 이전의 모든 기록은 기존 일반 모드 기록이다.
update public.plays
   set play_variant = 'normal'
 where play_variant is null
    or lower(btrim(play_variant)) not in ('normal', 'reverse');

update public.plays
   set play_variant = lower(btrim(play_variant))
 where play_variant is distinct from lower(btrim(play_variant));

delete from public.plays
 where duration_sec in (10, 30);

-- 비어 있거나 잘못 저장된 지역/모드 키를 기존 데이터로부터 복원한다.
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

-- 모든 과거 기록도 현재 500ms 규칙의 동일한 서버 기준으로 다시 보정한다.
update public.plays
   set theoretical_max = public.ranking_theoretical_max(rank_mode, duration_sec)
 where theoretical_max is distinct from
       public.ranking_theoretical_max(rank_mode, duration_sec);

alter table public.plays
  alter column duration_sec set default 60,
  alter column duration_sec set not null,
  alter column theoretical_max set default 120,
  alter column theoretical_max set not null,
  alter column play_variant set default 'normal',
  alter column play_variant set not null;

alter table public.plays drop constraint if exists plays_duration_sec_check;
alter table public.plays
  add constraint plays_duration_sec_check
  check (duration_sec in (60, 120, 300));

alter table public.plays drop constraint if exists plays_play_variant_check;
alter table public.plays add constraint plays_play_variant_check
  check (play_variant in ('normal', 'reverse'));

do $$
begin
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

-- 새 기록도 브라우저가 보낸 중복/계산 필드를 그대로 믿지 않고 서버에서 정규화한다.
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
  new.play_variant := case
    when lower(btrim(coalesce(new.play_variant, 'normal'))) = 'reverse' then 'reverse'
    else 'normal'
  end;
  new.theoretical_max := public.ranking_theoretical_max(new.rank_mode, new.duration_sec);
  return new;
end;
$$;

drop trigger if exists normalize_play_ranking_fields_trigger on public.plays;
create trigger normalize_play_ranking_fields_trigger
before insert or update of region, mode, rank_mode, duration_sec, theoretical_max, play_variant
on public.plays
for each row execute function public.normalize_play_ranking_fields();

revoke all on function public.normalize_play_ranking_fields() from public;

drop index if exists public.plays_weekly_duration_rank_idx;

create index if not exists plays_duration_rank_idx
  on public.plays (play_variant, rank_mode, duration_sec, user_id, score desc, created_at);

create index if not exists plays_ranking_source_idx
  on public.plays (play_variant, region, mode, duration_sec, user_id, score desc, created_at);

-- 반환 컬럼이 확장될 수 있도록 이전 버전 함수를 먼저 제거한다.
drop function if exists public.all_time_ranking_by_duration(text, integer, integer);
drop function if exists public.all_time_ranking_by_duration_variant(text, integer, text, integer);
drop function if exists public.weekly_ranking_by_duration(text, integer, integer);
drop function if exists public.weekly_ranking(text, integer);

create function public.all_time_ranking_by_duration_variant(
  p_mode text,
  p_duration integer,
  p_variant text,
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
       and plays.play_variant = lower(btrim(p_variant))
       and lower(btrim(p_variant)) in ('normal', 'reverse')
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

create function public.all_time_ranking_by_duration(
  p_mode text,
  p_duration integer,
  p_limit integer default 100
)
returns table (
  rank bigint, user_id uuid, nickname text, theme_line text, best_score bigint,
  theoretical_max bigint, record_points numeric, percentile_bonus numeric, adjusted_score numeric
)
language sql security definer set search_path = '' stable
as $$
  select * from public.all_time_ranking_by_duration_variant(p_mode, p_duration, 'normal', p_limit);
$$;

revoke all on function public.all_time_ranking_by_duration_variant(text, integer, text, integer) from public;
grant execute on function public.all_time_ranking_by_duration_variant(text, integer, text, integer) to anon, authenticated;
revoke all on function public.all_time_ranking_by_duration(text, integer, integer) from public;
grant execute on function public.all_time_ranking_by_duration(text, integer, integer) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
