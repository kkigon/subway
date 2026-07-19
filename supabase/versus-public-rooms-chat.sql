-- ============================================================
-- 대전 모드: 공개방 목록 + 비공개방 + 영속 채팅/신고 마이그레이션
--
-- 적용 전제: versus-step1-rooms.sql, versus-multiplayer-authority.sql
-- 여러 번 실행해도 안전하다.
-- ============================================================

begin;

alter table public.rooms add column if not exists room_title text not null default '지하철 대전방';
alter table public.rooms add column if not exists is_public boolean not null default true;
alter table public.rooms add column if not exists member_count integer not null default 1;
alter table public.rooms add column if not exists last_active_at timestamptz not null default now();

alter table public.rooms drop constraint if exists rooms_title_length_check;
alter table public.rooms add constraint rooms_title_length_check
  check (char_length(room_title) between 2 and 30);
alter table public.rooms drop constraint if exists rooms_member_count_check;
alter table public.rooms add constraint rooms_member_count_check
  check (member_count between 1 and 32);

create index if not exists rooms_public_lobby_idx
  on public.rooms (last_active_at desc)
  where is_public and status = 'waiting';

-- 직접 테이블 조회에서는 공개방만 보인다. 비공개방은 정확한 코드를
-- room_get RPC에 전달해야만 조회할 수 있다.
alter table public.rooms enable row level security;
drop policy if exists "rooms_select_all" on public.rooms;
drop policy if exists "rooms_select_public" on public.rooms;
create policy "rooms_select_public" on public.rooms
  for select using (is_public = true);

create or replace function public.versus_has_blocked_terms(p_text text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(lower(coalesce(p_text, '')), '[^0-9a-z가-힣ㄱ-ㅎㅏ-ㅣ]', '', 'g')
         ~ '(시+발|씨+발|ㅅㅂ|병+신|ㅂㅅ|좆|존+나|개+새+끼|새+끼|지+랄|꺼+져|닥+쳐|니+애+미|느+금+마)';
$$;

revoke all on function public.versus_has_blocked_terms(text) from public;

create or replace function public.room_create_v2(
  p_code text,
  p_host text,
  p_host_name text,
  p_region text,
  p_room_title text,
  p_is_public boolean
)
returns public.rooms
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
  v_title text := regexp_replace(trim(coalesce(p_room_title, '')), '\s+', ' ', 'g');
begin
  if p_code !~ '^[A-Z2-9]{4,8}$' then
    raise exception 'invalid room code' using errcode = '22023';
  end if;
  if coalesce(length(p_host), 0) < 3 or length(p_host) > 128 then
    raise exception 'invalid player id' using errcode = '22023';
  end if;
  if coalesce(length(trim(p_host_name)), 0) < 1 or length(p_host_name) > 40 then
    raise exception 'invalid player name' using errcode = '22023';
  end if;
  if p_region not in ('seoul', 'nationwide', 'busan', 'daegu', 'daejeon', 'gwangju') then
    raise exception 'invalid region' using errcode = '22023';
  end if;
  if char_length(v_title) not between 2 and 30 or public.versus_has_blocked_terms(v_title) then
    raise exception 'invalid or blocked room title' using errcode = '22023';
  end if;

  insert into public.rooms (
    code, host_id, host_name, region, mode, duration_sec, status,
    play_mode, host_revision, host_changed_at, updated_at,
    room_title, is_public, member_count, last_active_at
  ) values (
    p_code, p_host, trim(p_host_name), p_region, 'all', 60, 'waiting',
    'timed', 0, now(), now(), v_title, coalesce(p_is_public, true), 1, now()
  )
  returning * into v_room;

  return v_room;
end;
$$;

create or replace function public.room_get(p_code text)
returns public.rooms
language sql
security definer
set search_path = ''
stable
as $$
  select rooms.*
    from public.rooms
   where rooms.code = upper(trim(p_code))
     and upper(trim(p_code)) ~ '^[A-Z2-9]{4,8}$'
   limit 1;
$$;

create or replace function public.room_list_public(p_limit integer default 30)
returns table (
  code text,
  room_title text,
  host_name text,
  region text,
  mode text,
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
         rooms.duration_sec, rooms.status, rooms.member_count, rooms.created_at
    from public.rooms
   where rooms.is_public = true
     and rooms.status = 'waiting'
     and rooms.last_active_at >= now() - interval '90 seconds'
   order by rooms.last_active_at desc, rooms.created_at desc
   limit greatest(1, least(coalesce(p_limit, 30), 50));
$$;

create or replace function public.room_heartbeat(
  p_room text,
  p_host text,
  p_member_count integer
)
returns public.rooms
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
begin
  if p_member_count not between 1 and 32 then
    raise exception 'invalid member count' using errcode = '22023';
  end if;
  update public.rooms
     set member_count = p_member_count,
         last_active_at = now(),
         updated_at = now()
   where code = upper(trim(p_room))
     and host_id = p_host
  returning * into v_room;
  return v_room;
end;
$$;

create table if not exists public.room_messages (
  id bigint generated by default as identity primary key,
  room_code text not null references public.rooms(code) on delete cascade,
  player_id text not null,
  player_name text not null,
  body text not null,
  report_count integer not null default 0,
  is_hidden boolean not null default false,
  created_at timestamptz not null default now(),
  constraint room_messages_player_id_check check (char_length(player_id) between 3 and 128),
  constraint room_messages_player_name_check check (char_length(player_name) between 1 and 40),
  constraint room_messages_body_check check (char_length(body) between 1 and 200),
  constraint room_messages_report_count_check check (report_count >= 0)
);

create index if not exists room_messages_room_created_idx
  on public.room_messages (room_code, created_at desc);

create table if not exists public.room_message_reports (
  id bigint generated by default as identity primary key,
  message_id bigint not null references public.room_messages(id) on delete cascade,
  room_code text not null references public.rooms(code) on delete cascade,
  reporter_id text not null,
  reason text not null default '부적절한 내용',
  created_at timestamptz not null default now(),
  unique (message_id, reporter_id),
  constraint room_message_reports_reason_check check (char_length(reason) between 1 and 80)
);

alter table public.room_messages enable row level security;
alter table public.room_message_reports enable row level security;

-- 채팅 테이블 직접 접근은 모두 닫고, 방 코드를 받는 아래 RPC로만 읽고 쓴다.
revoke all on public.room_messages from anon, authenticated;
revoke all on public.room_message_reports from anon, authenticated;

create or replace function public.room_chat_history(
  p_room text,
  p_limit integer default 80
)
returns table (
  id bigint,
  player_id text,
  player_name text,
  body text,
  report_count integer,
  is_hidden boolean,
  created_at timestamptz
)
language sql
security definer
set search_path = ''
stable
as $$
  select history.id, history.player_id, history.player_name, history.body,
         history.report_count, history.is_hidden, history.created_at
    from (
      select messages.*
        from public.room_messages messages
       where messages.room_code = upper(trim(p_room))
         and messages.is_hidden = false
       order by messages.id desc
       limit greatest(1, least(coalesce(p_limit, 80), 100))
    ) history
   order by history.id;
$$;

create or replace function public.room_send_message(
  p_room text,
  p_player text,
  p_player_name text,
  p_body text
)
returns public.room_messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_message public.room_messages;
  v_body text := regexp_replace(trim(coalesce(p_body, '')), '\s+', ' ', 'g');
  v_compact text;
  v_recent_count integer;
begin
  if not exists (select 1 from public.rooms where code = upper(trim(p_room)) and status <> 'ended') then
    raise exception 'room not found or closed' using errcode = '22023';
  end if;
  if char_length(coalesce(p_player, '')) not between 3 and 128
     or char_length(trim(coalesce(p_player_name, ''))) not between 1 and 40
     or char_length(v_body) not between 1 and 200 then
    raise exception 'invalid chat message' using errcode = '22023';
  end if;
  v_compact := regexp_replace(lower(v_body), '[^0-9a-z가-힣ㄱ-ㅎㅏ-ㅣ]', '', 'g');
  if public.versus_has_blocked_terms(v_body) or v_compact ~ '(.)\1{9,}' then
    raise exception 'blocked chat message' using errcode = '22023';
  end if;
  if (select count(*) from regexp_matches(lower(v_body), 'https?://', 'g')) > 1 then
    raise exception 'too many links' using errcode = '22023';
  end if;

  select count(*) into v_recent_count
    from public.room_messages
   where room_code = upper(trim(p_room))
     and player_id = p_player
     and created_at >= now() - interval '10 seconds';
  if v_recent_count >= 6 then
    raise exception 'chat rate limit exceeded' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.room_messages
     where room_code = upper(trim(p_room)) and player_id = p_player
       and body = v_body and created_at >= now() - interval '30 seconds'
  ) then
    raise exception 'duplicate chat message' using errcode = 'P0001';
  end if;

  insert into public.room_messages (room_code, player_id, player_name, body)
  values (upper(trim(p_room)), p_player, trim(p_player_name), v_body)
  returning * into v_message;
  return v_message;
end;
$$;

create or replace function public.room_report_message(
  p_room text,
  p_message bigint,
  p_reporter text,
  p_reason text default '부적절한 내용'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted integer := 0;
  v_reason text := left(trim(coalesce(p_reason, '부적절한 내용')), 80);
  v_reporter_identity text := coalesce(auth.uid()::text, p_reporter);
begin
  if char_length(coalesce(p_reporter, '')) not between 3 and 128
     or char_length(v_reason) < 1 then
    raise exception 'invalid report' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.room_messages
     where id = p_message and room_code = upper(trim(p_room))
       and player_id <> p_reporter
  ) then
    raise exception 'message not found or self report' using errcode = '22023';
  end if;

  insert into public.room_message_reports (message_id, room_code, reporter_id, reason)
  values (p_message, upper(trim(p_room)), v_reporter_identity, v_reason)
  on conflict (message_id, reporter_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then return false; end if;

  update public.room_messages messages
     set report_count = reports.count,
         is_hidden = reports.count >= 3
    from (
      select count(*)::integer as count
        from public.room_message_reports
       where message_id = p_message
    ) reports
   where messages.id = p_message;
  return true;
end;
$$;

-- Supabase Cron에서 하루 한 번 호출할 수 있는 정리 함수.
-- 24시간 이상 heartbeat가 없는 방과 연결된 채팅/신고가 CASCADE로 함께 삭제된다.
create or replace function public.cleanup_stale_versus_rooms()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.rooms
   where last_active_at < now() - interval '24 hours';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.room_create_v2(text, text, text, text, text, boolean) from public;
revoke all on function public.room_get(text) from public;
revoke all on function public.room_list_public(integer) from public;
revoke all on function public.room_heartbeat(text, text, integer) from public;
revoke all on function public.room_chat_history(text, integer) from public;
revoke all on function public.room_send_message(text, text, text, text) from public;
revoke all on function public.room_report_message(text, bigint, text, text) from public;
revoke all on function public.cleanup_stale_versus_rooms() from public;

grant execute on function public.room_create_v2(text, text, text, text, text, boolean) to anon, authenticated;
grant execute on function public.room_get(text) to anon, authenticated;
grant execute on function public.room_list_public(integer) to anon, authenticated;
grant execute on function public.room_heartbeat(text, text, integer) to anon, authenticated;
grant execute on function public.room_chat_history(text, integer) to anon, authenticated;
grant execute on function public.room_send_message(text, text, text, text) to anon, authenticated;
grant execute on function public.room_report_message(text, bigint, text, text) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
