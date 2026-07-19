const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const html = read("index.html");
const versus = read("js/versus.js");
const ui = read("js/versus-ui.js");
const migration = read("supabase/versus-public-rooms-chat.sql");
const durationMigration = read("supabase/remove-short-duration-modes.sql");

// 공개/비공개 방 생성과 활성 방 브라우저
assert.match(html, /id="vs-room-title"[^>]*maxlength="30"/);
assert.match(html, /id="vs-room-public"[^>]*checked/);
assert.match(html, /id="vs-public-rooms"/);
assert.match(ui, /setInterval\(refreshPublicRooms, 10000\)/);
assert.match(ui, /setTimeout\(async \(\) =>[\s\S]*Versus\.updateSettings/);
assert.match(versus, /rpc\("room_create_v2"/);
assert.match(versus, /rpc\("room_list_public"/);
assert.match(versus, /rpc\("room_get"/);
assert.doesNotMatch(versus, /from\("rooms"\)\.select\("\*"\)/);

// 채팅, 필터링, 신고 UI 및 서버 RPC
for (const id of ["vs-chat-toggle", "vs-chat-panel", "vs-chat-messages", "vs-chat-form", "vs-chat-input"]) {
  assert.match(html, new RegExp(`id="${id}"`));
}
assert.match(versus, /validateChatText/);
assert.match(versus, /rpc\("room_send_message"/);
assert.match(versus, /rpc\("room_report_message"/);
assert.match(ui, /class="vs-chat-report"/);
assert.match(migration, /create table if not exists public\.room_messages/);
assert.match(migration, /create table if not exists public\.room_message_reports/);
assert.match(migration, /unique \(message_id, reporter_id\)/);
assert.match(migration, /coalesce\(auth\.uid\(\)::text, p_reporter\)/);
assert.match(migration, /is_hidden = reports\.count >= 3/);
assert.match(migration, /v_recent_count >= 6/);
assert.match(migration, /versus_has_blocked_terms/);

// 비공개방 보호, 활성 방 판정, 정리 정책
assert.match(migration, /create policy "rooms_select_public"[\s\S]*is_public = true/);
assert.doesNotMatch(migration, /create policy "rooms_select_all"/);
assert.match(migration, /status = 'waiting'[\s\S]*interval '90 seconds'/);
assert.match(migration, /cleanup_stale_versus_rooms/);
assert.match(migration, /interval '24 hours'/);

// 폐지 시간 기록과 대전 상태를 모두 60/120/300초로 제한
assert.match(durationMigration, /delete from public\.plays[\s\S]*duration_sec in \(10, 30\)/);
assert.match(durationMigration, /plays_duration_sec_check[\s\S]*duration_sec in \(60, 120, 300\)/);
assert.match(durationMigration, /rooms_duration_sec_check[\s\S]*duration_sec in \(60, 120, 300\)/);
assert.match(durationMigration, /game_states_duration_sec_check[\s\S]*duration_sec in \(60, 120, 300\)/);

console.log("versus lobby/chat tests: ok");
