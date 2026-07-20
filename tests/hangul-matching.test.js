const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// 핵심 정답 판정 로직(hangul.js)을 실제로 실행해 검증한다.
// 기존 테스트는 hangul.js를 한 번도 실행하지 않아, NFC 정규화·별칭 분리·
// 초성 오프셋이 깨져도 전부 green으로 통과했다(레드팀 C2). 이 테스트가 그 공백을 메운다.
const source = fs.readFileSync(path.join(__dirname, "..", "js", "hangul.js"), "utf8");

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  `${source}\nthis.api = { toChosung, normalizeName, nameAliases, matchesAnswer, searchScore };`,
  sandbox
);
const { toChosung, normalizeName, nameAliases, matchesAnswer, searchScore } = sandbox.api;

/* ---------- toChosung ---------- */
assert.equal(toChosung("서울역"), "ㅅㅇㅇ", "초성 추출 오프셋");
assert.equal(toChosung("강남"), "ㄱㄴ");
assert.equal(toChosung("A1역"), "A1ㅇ", "비한글은 그대로 통과");

/* ---------- normalizeName ---------- */
assert.equal(normalizeName("총신대 입구"), "총신대입구", "공백 제거");
assert.equal(normalizeName("동대문·역사문화공원"), "동대문역사문화공원", "가운뎃점 제거");
assert.equal(normalizeName("서울역."), "서울역", "마침표 제거");
assert.equal(normalizeName(""), "");
assert.equal(normalizeName(null), "", "null 안전");
// NFD(분해형) 입력도 NFC로 정규화되어 동일 문자열이 된다
const nfd = "서울역".normalize("NFD");
assert.notEqual(nfd, "서울역", "테스트 전제: NFD와 NFC 바이트가 다르다");
assert.equal(normalizeName(nfd), "서울역", "NFD 입력을 NFC로 정규화");

/* ---------- nameAliases ---------- */
const aliases = nameAliases("총신대입구(이수)");
assert.ok(aliases.includes("총신대입구(이수)"), "전체 표기 포함");
assert.ok(aliases.includes("총신대입구"), "괄호 앞 별칭");
assert.ok(aliases.includes("이수"), "괄호 안 별칭");

/* ---------- matchesAnswer (정답 판정) ---------- */
// 별칭 어느 쪽으로 답해도 정답
assert.equal(matchesAnswer("이수", "총신대입구(이수)"), true);
assert.equal(matchesAnswer("총신대입구", "총신대입구(이수)"), true);
assert.equal(matchesAnswer("총신대입구(이수)", "총신대입구(이수)"), true);
// 공백/구두점 정규화 후에도 정답
assert.equal(matchesAnswer(" 서울 역 ", "서울역"), true, "공백 무시");
assert.equal(matchesAnswer("동대문·역사문화공원", "동대문역사문화공원"), true);
// NFD 입력도 정답
assert.equal(matchesAnswer(nfd, "서울역"), true, "NFD 입력 정답 처리");
// 오답은 오답
assert.equal(matchesAnswer("강남", "역삼"), false);
assert.equal(matchesAnswer("총신대", "총신대입구(이수)"), false, "부분 문자열은 정답 아님");
// 빈/공백 입력은 정답이 아니어야 한다
assert.equal(matchesAnswer("", "서울역"), false);
assert.equal(matchesAnswer("   ", "서울역"), false);
// 초성만 입력한 것은 정답으로 인정하면 안 된다(초성은 자동완성 전용)
assert.equal(matchesAnswer("ㅅㅇㅇ", "서울역"), false, "초성은 정답 판정에서 제외");

/* ---------- searchScore (자동완성 랭킹) ---------- */
assert.equal(searchScore("서울역", "서울역"), 3, "정확 일치");
assert.equal(searchScore("서울", "서울역"), 2, "접두 일치");
assert.equal(searchScore("울역", "서울역"), 1, "포함 일치");
assert.equal(searchScore("ㅅㅇ", "서울역"), 0.5, "초성 접두 일치");
assert.equal(searchScore("부산", "서울역"), -1, "불일치");
assert.equal(searchScore("", "서울역"), -1, "빈 쿼리");
// 괄호 별칭도 후보로 평가해 최고점 사용
assert.equal(searchScore("이수", "총신대입구(이수)"), 3, "별칭 정확 일치");

console.log("hangul matching tests: ok");
