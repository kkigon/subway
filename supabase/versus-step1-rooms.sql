-- ============================================================
--  대전 모드 — 1단계: 방(rooms) 테이블
--  사용법: Supabase 대시보드 → SQL Editor → New query
--           → 이 파일 전체 붙여넣고 → Run
-- ------------------------------------------------------------
--  기본 테이블을 만든 뒤 versus-multiplayer-authority.sql,
--  versus-public-rooms-chat.sql 순서로 이어서 적용한다.
-- ============================================================

create table if not exists public.rooms (
  code         text primary key,                 -- 방 코드 (예: 'K7Q2M9') — 사람이 입력/공유
  host_id      text,                              -- 대전 세션 id(로그인/게스트 공통, 탭별 고유값)
  host_name    text not null,                     -- 방장 표시 이름 (닉네임 또는 'Guest #1234')
  region       text not null default 'seoul',     -- seoul | nationwide | busan | daegu | daejeon | gwangju
  mode         text not null default 'all',       -- 'core' | 'all' | 'custom'
  custom_lines text,                              -- 커스텀일 때 노선 id들(콤마구분), 아니면 null
  duration_sec integer not null default 60,       -- 60 | 120 | 300
  play_mode    text not null default 'timed',     -- 'timed' | 'reverse'
  status       text not null default 'waiting',   -- 'waiting' | 'playing' | 'ended'
  room_title   text not null default '지하철 대전방',
  is_public    boolean not null default true,
  member_count integer not null default 1,
  last_active_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  constraint rooms_duration_sec_check check (duration_sec in (60, 120, 300)),
  constraint rooms_play_mode_check check (play_mode in ('timed', 'endless', 'reverse')),
  constraint rooms_title_length_check check (char_length(room_title) between 2 and 30),
  constraint rooms_member_count_check check (member_count between 1 and 32)
);

-- 오래된 방 정리를 쉽게 하기 위한 인덱스 (생성시각)
create index if not exists rooms_created_idx on public.rooms (created_at);

-- ============================================================
--  RLS: 공개방만 직접 조회할 수 있다.
--  쓰기는 versus-multiplayer-authority.sql의 SECURITY DEFINER RPC만 허용한다.
-- ============================================================
alter table public.rooms enable row level security;

-- 공개방만 직접 조회할 수 있다. 비공개방은 후속 마이그레이션의 room_get RPC를 사용한다.
drop policy if exists "rooms_select_all" on public.rooms;
drop policy if exists "rooms_select_public" on public.rooms;
create policy "rooms_select_public" on public.rooms
  for select using (is_public = true);

-- 직접 쓰기 정책은 제거한다. 생성/설정/위임/삭제는 서버 권한 RPC가 검증한다.
drop policy if exists "rooms_insert_all" on public.rooms;
drop policy if exists "rooms_update_all" on public.rooms;
drop policy if exists "rooms_delete_all" on public.rooms;
