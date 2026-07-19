const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const migration = fs.readFileSync(
  path.join(root, "supabase", "fix-ranking-eligibility.sql"),
  "utf8"
);
const baseRanking = fs.readFileSync(
  path.join(root, "supabase", "time-based-rankings.sql"),
  "utf8"
);

for (const sql of [migration, baseRanking]) {
  assert.match(sql, /normalized_play_rank_mode\(/);
  assert.match(sql, /coalesce\(nullif\(btrim\(p_region\), ''\), 'seoul'\)/);
  assert.match(sql, /ranking_theoretical_max\(/);
  assert.match(sql, /1000\.0 \/ 500\.0/);
  assert.match(sql, /normalize_play_ranking_fields_trigger/);
  assert.match(sql, /left join public\.profiles/);
  assert.match(sql, /coalesce\(profiles\.nickname, '알 수 없는 사용자'\)/);
  assert.match(sql, /ranked\.ranking <= greatest\(1, least\(coalesce\(p_limit, 100\), 100\)\)/);
  assert.match(sql, /eligible_plays\.score desc/);
  assert.doesNotMatch(sql, /plays\.score::numeric \/ plays\.theoretical_max/);
}

assert.doesNotMatch(migration, /delete\s+from\s+public\.plays/i);
assert.match(migration, /plays 기록을 삭제하지 않으며 여러 번 실행해도 안전/);

console.log("ranking eligibility tests: ok");
