-- ============================================================
-- 거꾸로 모드 증분 마이그레이션
-- - 기존 plays 행은 전부 normal로 보존 (기존 랭킹 유지)
-- - reverse 기록과 랭킹을 제한시간별로 완전히 분리
-- - 대전방 설정/공개방 목록에 reverse 방식 추가
-- - 기록 삭제 없음, 여러 번 실행 가능
--
-- 기존 운영 DB에서는 이 파일 하나를 SQL Editor에서 실행한다.
-- ============================================================

begin;

alter table public.plays
  add column if not exists play_variant text;

update public.plays
   set play_variant = 'normal'
 where play_variant is null
    or lower(btrim(play_variant)) not in ('normal', 'reverse');

update public.plays
   set play_variant = lower(btrim(play_variant))
 where play_variant is distinct from lower(btrim(play_variant));

alter table public.plays
  alter column play_variant set default 'normal',
  alter column play_variant set not null;

alter table public.plays drop constraint if exists plays_play_variant_check;
alter table public.plays add constraint plays_play_variant_check
  check (play_variant in ('normal', 'reverse'));

-- 기존 랭킹 정규화 트리거에 방식 필드를 포함한다.
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

create index if not exists plays_variant_duration_rank_idx
  on public.plays (play_variant, rank_mode, duration_sec, user_id, score desc, created_at);

drop function if exists public.all_time_ranking_by_duration_variant(text, integer, text, integer);
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

-- 구버전 클라이언트가 쓰는 RPC는 기존과 똑같이 normal 랭킹만 반환한다.
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
  select *
    from public.all_time_ranking_by_duration_variant(
      p_mode, p_duration, 'normal', p_limit
    );
$$;

revoke all on function public.all_time_ranking_by_duration_variant(text, integer, text, integer) from public;
grant execute on function public.all_time_ranking_by_duration_variant(text, integer, text, integer) to anon, authenticated;
revoke all on function public.all_time_ranking_by_duration(text, integer, integer) from public;
grant execute on function public.all_time_ranking_by_duration(text, integer, integer) to anon, authenticated;

-- 대전방의 방식도 normal/reverse와 동등하게 서버에서 검증한다.
alter table public.rooms add column if not exists play_mode text not null default 'timed';
update public.rooms
   set play_mode = 'timed'
 where play_mode not in ('timed', 'endless', 'reverse');
alter table public.rooms drop constraint if exists rooms_play_mode_check;
alter table public.rooms add constraint rooms_play_mode_check
  check (play_mode in ('timed', 'endless', 'reverse'));

create or replace function public.room_update_settings(
  p_room text,
  p_host text,
  p_region text,
  p_mode text,
  p_custom_lines text,
  p_duration integer,
  p_play_mode text
)
returns public.rooms
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
begin
  if p_region not in ('seoul', 'nationwide', 'busan', 'daegu', 'daejeon', 'gwangju')
     or p_mode not in ('core', 'all', 'custom')
     or p_play_mode not in ('timed', 'endless', 'reverse')
     or p_duration not in (60, 120, 300) then
    raise exception 'invalid room settings' using errcode = '22023';
  end if;

  update public.rooms
     set region = p_region,
         mode = p_mode,
         custom_lines = nullif(p_custom_lines, ''),
         duration_sec = p_duration,
         play_mode = p_play_mode,
         updated_at = now()
   where code = p_room
     and host_id = p_host
  returning * into v_room;

  if not found then
    raise exception 'only the current host can update settings' using errcode = '42501';
  end if;
  return v_room;
end;
$$;

-- 공개방 브라우저에서도 방식을 보여준다. 비공개방 노출 규칙은 그대로다.
drop function if exists public.room_list_public(integer);
create function public.room_list_public(p_limit integer default 30)
returns table (
  code text,
  room_title text,
  host_name text,
  region text,
  mode text,
  play_mode text,
  duration_sec integer,
  status text,
  member_count integer,
  created_at timestamptz
)
language sql
security definer
set search_path = ''
stable
as $$
  select rooms.code, rooms.room_title, rooms.host_name, rooms.region, rooms.mode,
         rooms.play_mode, rooms.duration_sec, rooms.status, rooms.member_count, rooms.created_at
    from public.rooms
   where rooms.is_public = true
     and rooms.status = 'waiting'
     and rooms.last_active_at >= now() - interval '90 seconds'
   order by rooms.last_active_at desc, rooms.created_at desc
   limit greatest(1, least(coalesce(p_limit, 30), 50));
$$;

revoke all on function public.room_update_settings(text, text, text, text, text, integer, text) from public;
grant execute on function public.room_update_settings(text, text, text, text, text, integer, text) to anon, authenticated;
revoke all on function public.room_list_public(integer) from public;
grant execute on function public.room_list_public(integer) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
