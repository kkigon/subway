const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// layout.js(buildNetwork/layoutSegment/nationwidePoint)는 모든 화면의 렌더 기하를
// 떠받치지만 런타임 커버리지가 0이었다(레드팀 R2). 합성 데이터로 순수 로직을 고정한다.
const source = fs.readFileSync(path.join(__dirname, "..", "js", "layout.js"), "utf8");

// layout.js는 로드 시 ALL_STATION_LINES를 즉시 계산하므로 LINES/ANCHORS/DISPLAY_NAME이
// 먼저 정의돼 있어야 한다. 합성 데이터셋 주입:
const sandbox = {
  ANCHORS: { A: [0, 0], C: [100, 0], D: [100, 100] },
  DISPLAY_NAME: { A: "에이" },
  LINES: [
    { id: "L1", region: "seoul", color: "#e00", segments: [["A", "B", "C"]] },
    { id: "L2", region: "seoul", color: "#0a0", segments: [["C", "D"]] }, // C는 환승역
  ],
};
vm.createContext(sandbox);
vm.runInContext(
  `${source}\nthis.api = { buildNetwork, layoutSegment, nationwidePoint, stationDisplayName, ALL_STATION_LINES };`,
  sandbox
);
const { buildNetwork, layoutSegment, nationwidePoint, stationDisplayName, ALL_STATION_LINES } = sandbox.api;

// vm 컨텍스트가 돌려주는 배열/객체는 다른 realm 소속이라 deepStrictEqual이 프로토타입
// 불일치로 실패한다. 구조 비교는 JSON 문자열로 한다(-0도 "0"으로 정규화됨).
const j = JSON.stringify;
const eq = (actual, expected, msg) => assert.equal(j(actual), j(expected), msg);

/* ---------- layoutSegment ---------- */
{
  const pts = layoutSegment(["A", "B", "C"]);
  eq(pts[0], [0, 0], "앵커 A 고정");
  eq(pts[2], [100, 0], "앵커 C 고정");
  eq(pts[1], [50, 0], "앵커 사이 선형 보간");
}
// 앵커가 하나도 없는 세그먼트는 한 줄로 폴백
eq(layoutSegment(["X", "Y", "Z"]), [[100, 100], [130, 100], [160, 100]], "앵커 없음 → 폴백");

/* ---------- stationDisplayName ---------- */
assert.equal(stationDisplayName("A"), "에이", "DISPLAY_NAME 우선");
assert.equal(stationDisplayName("B"), "B", "없으면 키 그대로");

/* ---------- buildNetwork: 정상 ---------- */
{
  const net = buildNetwork(["L1", "L2"]);
  assert.equal(net.stations.size, 4, "A,B,C,D");
  assert.equal(net.quizStations.size, 4, "모두 활성 노선 소속");
  const c = net.stations.get("C");
  assert.equal(c.x, 100, "환승역 x 공유");
  assert.equal(c.y, 0, "환승역 y 공유");
  eq(c.lines.slice().sort(), ["L1", "L2"], "환승역은 두 노선 모두 표시");
  eq(net.bounds, { minX: 0, minY: 0, maxX: 100, maxY: 100 }, "경계 상자");
  assert.equal(net.edges.length, 3, "세 구간 A-B,B-C,C-D");
}

/* ---------- buildNetwork: 부분 활성(displayLineIds) ---------- */
{
  const net = buildNetwork(["L1"], { displayLineIds: ["L1", "L2"] });
  assert.equal(net.stations.has("D"), true, "L2 역도 표시용으로 존재");
  assert.equal(net.quizStations.has("D"), false, "비활성 L2 전용역은 출제 제외");
  assert.equal(net.quizStations.has("A"), true, "활성 L1 역은 출제 대상");
}

/* ---------- buildNetwork: 빈 네트워크(degenerate) ---------- */
{
  const net = buildNetwork([]);
  assert.equal(net.stations.size, 0, "역 없음");
  assert.equal(net.quizStations.size, 0, "출제역 없음");
  // 경계가 ±Infinity로 남는다 — map.js fitAll이 이 비유한값을 감지해 기본 뷰로 폴백해야 한다.
  assert.equal(Number.isFinite(net.bounds.minX), false, "빈 네트워크 경계는 비유한값");
}

/* ---------- nationwidePoint ---------- */
eq(nationwidePoint([100, 0], "seoul"), [42, 0], "seoul 타일 스케일 0.42");
eq(nationwidePoint([0, 0], "busan"), [2050, 80], "busan 타일 오프셋");

/* ---------- ALL_STATION_LINES ---------- */
eq(ALL_STATION_LINES.get("C").slice().sort(), ["L1", "L2"], "환승역 전체 노선 집계");

console.log("layout network tests: ok");
