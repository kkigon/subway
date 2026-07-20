const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// util.js의 공용 헬퍼(escapeHtml=XSS 방어, lineColor, countNewMessages=대전 채팅 안읽음 카운트)
// 를 실제 실행해 고정한다. escapeHtml은 보안 인접 함수라 반드시 커버한다(레드팀 R2/R3).
const source = fs.readFileSync(path.join(__dirname, "..", "js", "util.js"), "utf8");

// $는 로드 시 호출되지 않으므로 document 없이도 안전. lineById는 선택적으로 주입.
const sandbox = {
  document: { querySelector: () => null },
  lineById: (id) => (id === "L1" ? { color: "#e00" } : null),
};
vm.createContext(sandbox);
vm.runInContext(
  `${source}\nthis.api = { escapeHtml, lineColor, countNewMessages };`,
  sandbox
);
const { escapeHtml, lineColor, countNewMessages } = sandbox.api;

/* ---------- escapeHtml ---------- */
assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), "&lt;img src=x onerror=alert(1)&gt;", "꺾쇠 이스케이프");
assert.equal(escapeHtml(`"&'`), "&quot;&amp;&#39;", "따옴표/앰퍼샌드 이스케이프");
assert.equal(escapeHtml(""), "");
assert.equal(escapeHtml(null), "", "null 안전");
assert.equal(escapeHtml(5), "5", "숫자 문자열화");
assert.equal(escapeHtml("정상 텍스트"), "정상 텍스트", "일반 텍스트 보존");

/* ---------- lineColor ---------- */
assert.equal(lineColor("L1"), "#e00", "노선 색 조회");
assert.equal(lineColor("없는노선"), "#0052A4", "미존재 → 기본 파랑");
assert.equal(lineColor(null), "#0052A4", "id 없음 → 기본");
assert.equal(lineColor(null, "#9aa0a6"), "#9aa0a6", "게스트 fallback 인자");
assert.equal(lineColor("없는노선", "#9aa0a6"), "#9aa0a6", "미존재 + fallback");

/* ---------- countNewMessages ---------- */
const msgs = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
assert.equal(countNewMessages(msgs, 2), 2, "id=2 이후 2개(3,4)");
assert.equal(countNewMessages(msgs, 4), 0, "최신과 동일 → 0");
assert.equal(countNewMessages(msgs, null), 0, "첫 렌더(null) → 0");
assert.equal(countNewMessages([], 3), 0, "빈 목록 → 0");
assert.equal(countNewMessages(msgs, "2"), 2, "문자/숫자 id 혼용 매칭");
// 윈도우 밖(오래된 last-seen이 목록에서 밀려남): last-seen보다 엄격히 큰 id만 센다
assert.equal(countNewMessages(msgs, 0), 4, "id=0 이후 전부(1,2,3,4)가 새 것");
// 마지막으로 본 메시지가 숨김/삭제돼 목록에서 사라진 경우: 더 새 메시지 없음 → 0 (과다 카운트 방지)
assert.equal(countNewMessages([{ id: 1 }, { id: 2 }, { id: 3 }], 4), 0, "본 메시지 숨김 → 0 (전체 아님)");

console.log("util tests: ok");
