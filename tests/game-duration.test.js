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
assert.match(accountUi, /if \(duration !== 60\) return/);
console.log("game duration tests: ok");
