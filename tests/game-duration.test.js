const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const game = fs.readFileSync(path.join(root, "js", "game.js"), "utf8");
const accountUi = fs.readFileSync(path.join(root, "js", "account-ui.js"), "utf8");

const expected = [10, 30, 60, 120, 300];
const singlePlayer = Array.from(html.matchAll(/class="game-duration-btn(?: active)?" data-duration="(\d+)"/g), match => Number(match[1]));
const versus = Array.from(html.matchAll(/class="vs-seg-btn(?: active)?" data-dur="(\d+)"/g), match => Number(match[1]));

assert.deepEqual(singlePlayer, expected, "싱글플레이 시간 옵션");
assert.deepEqual(versus, expected, "대전 모드 시간 옵션");
assert.match(game, /State\.gameDuration \* 1000/);
assert.match(game, /duration: State\.gameDuration/);
assert.doesNotMatch(accountUi, /if \(duration !== 60\) return/);
assert.match(accountUi, /Account\.weeklyRanking\(rankKey, rankDuration, 50\)/);

const rankingDurations = Array.from(html.matchAll(/class="rank-duration-tab(?: active)?" type="button" data-duration="(\d+)"/g), match => Number(match[1]));
assert.deepEqual(rankingDurations, expected, "랭킹 시간 탭");

const backend = fs.readFileSync(path.join(root, "js", "backend.js"), "utf8");
const migration = fs.readFileSync(path.join(root, "supabase", "time-based-rankings.sql"), "utf8");
assert.match(backend, /duration_sec: duration/);
assert.match(backend, /weekly_ranking_by_duration/);
assert.match(migration, /duration_sec in \(10, 30, 60, 120, 300\)/);
console.log("game duration tests: ok");
