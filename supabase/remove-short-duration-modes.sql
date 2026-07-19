-- ============================================================
-- 10초/30초 모드 제거 마이그레이션 (기존 서비스 DB용)
--
-- 주의: 10초와 30초 plays 기록은 요구사항에 따라 영구 삭제한다.
--       실행 전 필요하면 Supabase 백업을 먼저 생성한다.
-- 60초 기존 기록과 120초/300초 기록은 그대로 보존한다.
-- 여러 번 실행해도 안전하다.
-- ============================================================

begin;

alter table public.plays
  drop constraint if exists plays_duration_sec_check;

delete from public.plays
 where duration_sec in (10, 30);

update public.plays
   set duration_sec = 60
 where duration_sec not in (60, 120, 300);

alter table public.plays
  alter column duration_sec set default 60,
  add constraint plays_duration_sec_check
    check (duration_sec in (60, 120, 300));

-- 대전 대기방과 진행 상태에 남은 짧은 시간 설정도 60초로 보정한다.
do $$
begin
  if to_regclass('public.rooms') is not null then
    alter table public.rooms drop constraint if exists rooms_duration_sec_check;
    update public.rooms
       set duration_sec = 60
     where duration_sec not in (60, 120, 300);
    alter table public.rooms
      alter column duration_sec set default 60,
      add constraint rooms_duration_sec_check
        check (duration_sec in (60, 120, 300));
  end if;

  if to_regclass('public.game_states') is not null then
    alter table public.game_states drop constraint if exists game_states_duration_sec_check;
    update public.game_states
       set duration_sec = 60
     where duration_sec not in (60, 120, 300);
    alter table public.game_states
      alter column duration_sec set default 60,
      add constraint game_states_duration_sec_check
        check (duration_sec in (60, 120, 300));
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
