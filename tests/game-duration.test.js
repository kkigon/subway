const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const game = fs.readFileSync(path.join(root, "js", "game.js"), "utf8");
const accountUi = fs.readFileSync(path.join(root, "js", "account-ui.js"), "utf8");
const scoring = fs.readFileSync(path.join(root, "js", "scoring.js"), "utf8");
const settings = fs.readFileSync(path.join(root, "js", "settings.js"), "utf8");

const expected = [60, 120, 300];
const singlePlayer = Array.from(html.matchAll(/class="game-duration-btn(?: active)?" data-duration="(\d+)"/g), match => Number(match[1]));
const versus = Array.from(html.matchAll(/class="vs-seg-btn(?: active)?" data-dur="(\d+)"/g), match => Number(match[1]));

assert.deepEqual(singlePlayer, expected, "싱글플레이 시간 옵션");
assert.deepEqual(versus, expected, "대전 모드 시간 옵션");
assert.doesNotMatch(html, /data-(?:duration|dur)="(?:10|30)"/);
assert.doesNotMatch(html, /주간 랭킹|ranking-reset|후 리셋/);
assert.match(game, /State\.gameDuration \* 1000/);
assert.match(game, /duration: State\.gameDuration/);
assert.match(game, /const REVEAL_DELAY = 500/);
assert.match(game, /theoreticalMax: theoreticalMaxScore/);
assert.doesNotMatch(accountUi, /if \(duration !== 60\) return/);
assert.match(accountUi, /Account\.allTimeRanking\(rankKey, requestedDuration, 100, requestedVariant\)/);
assert.match(accountUi, /const loadRevision = \+\+rankLoadRevision/);
assert.match(accountUi, /if \(loadRevision !== rankLoadRevision\) return/);
assert.match(accountUi, /if \(result\.error\)/);
assert.doesNotMatch(accountUi, /nextResetText|이번 주/);

const rankingDurations = Array.from(html.matchAll(/class="rank-duration-tab(?: active)?" type="button" data-duration="(\d+)"/g), match => Number(match[1]));
assert.deepEqual(rankingDurations, expected, "랭킹 시간 탭");

const backend = fs.readFileSync(path.join(root, "js", "backend.js"), "utf8");
const migration = fs.readFileSync(path.join(root, "supabase", "time-based-rankings.sql"), "utf8");
assert.match(backend, /duration_sec: duration/);
assert.match(backend, /theoretical_max: theoreticalMax/);
assert.match(backend, /all_time_ranking_by_duration/);
assert.match(backend, /allTimeRanking\(mode, duration, limit = 100, variant = "normal"\)/);
assert.match(backend, /return \{ rows: data \|\| \[\], error: null \}/);
assert.doesNotMatch(backend, /nextResetText|weeklyRanking/);
assert.match(migration, /duration_sec in \(60, 120, 300\)/);
assert.match(migration, /delete from public\.plays[\s\S]*duration_sec in \(10, 30\)/);
assert.match(migration, /set duration_sec = 60[\s\S]*where duration_sec is null/);
assert.match(migration, /all_time_ranking_by_duration/);
assert.match(migration, /p_limit integer default 100/);
assert.match(migration, /coalesce\(p_limit, 100\), 100/);
assert.doesNotMatch(migration, /date_trunc\('week'/);
assert.doesNotMatch(migration, /create(?: or replace)? function public\.weekly_ranking/);
assert.match(migration, /70 \* sqrt/);
assert.match(migration, /30 \* \(percent_rank/);

const scoringSandbox = {};
require("node:vm").createContext(scoringSandbox);
require("node:vm").runInContext(`${scoring}\nthis.api = { theoreticalMaxScore, rankingScoreParts, scoreAchievement, rankingPlacementBadge };`, scoringSandbox);
assert.equal(scoringSandbox.api.theoreticalMaxScore(60, 100, 500), 100);
assert.equal(scoringSandbox.api.theoreticalMaxScore(300, 22, 500), 22);
// 시간 제한 분기(역 수 > 시간상 낼 수 있는 최대): 60초 @ 500ms → ceil(60000/500)=120, 역 300개여도 120으로 캡
assert.equal(scoringSandbox.api.theoreticalMaxScore(60, 300, 500), 120);
// Math.max(1,...) 바닥: duration 0이면 timeMaximum 0이지만 최소 1을 보장(0 나눗셈 방지)
assert.equal(scoringSandbox.api.theoreticalMaxScore(0, 22, 500), 1);
const perfect = scoringSandbox.api.rankingScoreParts(20, 20, 1);
assert.equal(perfect.adjustedScore, 100);
const improved = scoringSandbox.api.rankingScoreParts(15, 20, 1).adjustedScore;
const previous = scoringSandbox.api.rankingScoreParts(10, 20, 1).adjustedScore;
assert.ok(improved > previous, "1위라도 기록을 높이면 보정 점수가 올라야 한다");

assert.equal(scoringSandbox.api.rankingPlacementBadge(1, 30).key, "first");
assert.equal(scoringSandbox.api.rankingPlacementBadge(7, 28).key, "top-ten");
assert.equal(scoringSandbox.api.rankingPlacementBadge(14, 27).key, "top-percent");
assert.equal(scoringSandbox.api.rankingPlacementBadge(14, 26.99), null);
assert.equal(scoringSandbox.api.scoreAchievement(9.9).key, "0");
assert.equal(scoringSandbox.api.scoreAchievement(10).key, "10");
assert.equal(scoringSandbox.api.scoreAchievement(94.9).key, "90");
assert.equal(scoringSandbox.api.scoreAchievement(95).key, "95");

assert.match(accountUi, /rank-placement--\$\{placement\.key\}/);
// r.rank는 XSS 방어 일관성을 위해 Number()로 강제 변환된다(레드팀 R2).
assert.match(accountUi, /class="rank-num">\$\{Number\(r\.rank\) \|\| 0\}위/);
assert.match(accountUi, /score-achievement--\$\{achievement\.key\}/);
assert.match(html, /id="btn-settings"/);
assert.match(html, /id="settings-sound-toggle"[\s\S]*role="switch"/);
assert.match(settings, /subwaySoundEnabled/);
assert.match(game, /GameSettings\.isSoundEnabled\(\)/);
console.log("game duration tests: ok");
