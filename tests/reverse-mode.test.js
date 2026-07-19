const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const html = read("index.html");
const css = read("css/style.css");
const hangul = read("js/hangul.js");
const game = read("js/game.js");
const backend = read("js/backend.js");
const accountUi = read("js/account-ui.js");
const versus = read("js/versus.js");
const versusUi = read("js/versus-ui.js");
const reverseMigration = read("supabase/reverse-mode.sql");
const authorityMigration = read("supabase/versus-multiplayer-authority.sql");

// 한글 음절/별칭의 판정과 검색이 실제로 거꾸로 동작한다.
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${hangul}\nthis.api = { reverseText, reverseDisplayName, matchesReverseAnswer, reverseSearchScore };`, sandbox);
assert.equal(sandbox.api.reverseText("동대문역사문화공원"), "원공화문사역문대동");
assert.equal(sandbox.api.reverseDisplayName("총신대입구(이수)"), "구입대신총 (수이)");
assert.equal(sandbox.api.matchesReverseAnswer("원공화문사역문대동", "동대문역사문화공원"), true);
assert.equal(sandbox.api.matchesReverseAnswer("동대문역사문화공원", "동대문역사문화공원"), false);
assert.equal(sandbox.api.matchesReverseAnswer("수이", "총신대입구(이수)"), true);
assert.ok(sandbox.api.reverseSearchScore("원공화", "동대문역사문화공원") > 0);

// 홈 버튼, NEW 배지, 180도 텍스트와 접근성/저동작 환경 처리가 있다.
assert.match(html, /name="playmode" value="reverse"/);
assert.match(html, /class="play-mode-new"[^>]*>NEW!</);
assert.match(html, /class="reverse-word">거꾸로</);
assert.match(css, /\.reverse-word\s*\{[^}]*rotate\(180deg\)/s);
assert.match(css, /@keyframes reverse-rainbow-glow/);
assert.match(css, /prefers-reduced-motion: reduce[\s\S]*play-mode-card--reverse/);

// 싱글플레이의 판정, 추천, 힌트, 타이머가 모두 거꾸로 방식에 연결된다.
assert.match(game, /matchesReverseAnswer\(input, name\)/);
assert.match(game, /reverseSearchScore\(q, st\.name\)/);
assert.match(game, /isReverseMode\(\) \? reverseText\(originalBase\)/);
assert.match(game, /State\.playMode === "timed" \|\| isReverseMode\(\)/);
assert.match(game, /config\.playMode === "reverse"/);
assert.match(game, /homePlayMode[\s\S]*State\.playMode = homePlayMode/);

// 랭킹 토글과 저장/조회 방식이 normal/reverse로 분리된다.
assert.match(html, /id="rank-reverse-toggle"[\s\S]*role="switch"/);
assert.match(accountUi, /let rankVariant = "normal"/);
assert.match(accountUi, /playVariant: reverse \? "reverse" : "normal"/);
assert.match(backend, /payload\.play_variant = "reverse"/);
assert.match(backend, /all_time_ranking_by_duration_variant/);
assert.match(reverseMigration, /add column if not exists play_variant/);
assert.match(reverseMigration, /set play_variant = 'normal'/);
assert.match(reverseMigration, /plays\.play_variant = lower\(btrim\(p_variant\)\)/);
assert.match(reverseMigration, /all_time_ranking_by_duration_variant/);
assert.doesNotMatch(reverseMigration, /delete\s+from\s+public\.plays/i);

// 대전 설정은 방 DB를 거쳐 참가자에게 전달되고 공개방에도 방식이 표시된다.
assert.match(html, /id="vs-set-play-mode"/);
assert.match(versusUi, /playMode: vsSettings\.playMode/);
assert.match(versus, /await updateSettings\(\{ region, mode, customLines, duration, playMode \}\)/);
assert.match(versus, /playMode: Room\.data\?\.play_mode === "reverse"/);
assert.match(authorityMigration, /p_play_mode not in \('timed', 'endless', 'reverse'\)/);
assert.match(reverseMigration, /rooms\.play_mode/);

console.log("reverse mode tests: ok");
