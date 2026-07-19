const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const sources = ["js/data.js", "js/data-busan.js", "js/data-nationwide.js", "js/layout.js"]
  .map(file => fs.readFileSync(path.join(root, file), "utf8"))
  .join("\n");
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${sources}\nthis.snapshot = { LINES, ANCHORS, DISPLAY_NAME, REGION_LABELS, linesForRegion, regionSupportsCore, buildNetwork };`, sandbox);

const { LINES, ANCHORS, DISPLAY_NAME, REGION_LABELS, linesForRegion, regionSupportsCore, buildNetwork } = sandbox.snapshot;
assert.deepEqual(Object.keys(REGION_LABELS), ["seoul", "nationwide", "busan", "daegu", "daejeon", "gwangju"]);

const expectedLines = {
  busan: ["BS1", "BS2", "BS3", "BS4", "BSDH", "BSGH"],
  daegu: ["DG1", "DG2", "DG3", "DGK"],
  daejeon: ["DJ1"],
  gwangju: ["GJ1"],
};
for (const [region, ids] of Object.entries(expectedLines)) {
  assert.deepEqual(Array.from(LINES.filter(line => line.region === region), line => line.id), ids);
  const network = buildNetwork(ids);
  assert.ok(network.stations.size > 0, `${region} 노선도가 비어 있지 않아야 한다`);
  for (const station of network.stations.values()) {
    assert.ok(Number.isFinite(station.x) && Number.isFinite(station.y), `${station.name} 좌표가 유효해야 한다`);
  }
}

const allLineIds = Array.from(LINES, line => line.id);
assert.deepEqual(Array.from(linesForRegion("nationwide"), line => line.id), allLineIds);
assert.equal(regionSupportsCore("nationwide"), false);
const nationwide = buildNetwork(allLineIds, { regionLayout: "nationwide" });
assert.ok(nationwide.stations.size > 700, "전국 노선도에 모든 권역 역이 포함되어야 한다");
assert.ok(nationwide.bounds.maxX - nationwide.bounds.minX > 3500, "전국 노선도가 권역별로 펼쳐져야 한다");

const expectedStationCounts = { DG1: 35, DG2: 29, DG3: 30, DGK: 7, DJ1: 22, GJ1: 20 };
for (const [id, count] of Object.entries(expectedStationCounts)) {
  const line = LINES.find(candidate => candidate.id === id);
  assert.ok(line, `${id} 노선이 있어야 한다`);
  assert.equal(new Set(line.segments.flat()).size, count, `${id} 역 수`);
  assert.ok(line.segments.flat().every(key => DISPLAY_NAME[key]), `${id} 표시명이 모두 있어야 한다`);
  assert.ok(line.segments.some(segment => segment.filter(key => ANCHORS[key]).length >= 2), `${id}에 앵커가 2개 이상 있어야 한다`);
}

// 대구 노선도는 공식 도식처럼 긴 수평축과 도심 환승 구간을 유지해야 한다.
const daeguNetwork = buildNetwork(expectedLines.daegu);
const daeguStation = name => daeguNetwork.stations.get(`DG:${name}`);
assert.equal(daeguStation("문양").y, daeguStation("영남대").y, "대구 2호선 동서축은 수평이어야 한다");
assert.equal(daeguStation("설화명곡").y, daeguStation("영대병원").y, "대구 1호선 서쪽 구간은 수평이어야 한다");
assert.equal(daeguStation("동구청").y, daeguStation("하양(대구가톨릭대)").y, "대구 1호선 동쪽 구간은 수평이어야 한다");
assert.ok(daeguStation("부호(경일대·호산대)").x - daeguStation("대구한의대병원").x >= 140,
  "1호선 동쪽의 긴 역명이 서로 겹치지 않을 간격이어야 한다");
assert.ok(daeguStation("하양(대구가톨릭대)").x - daeguStation("부호(경일대·호산대)").x >= 140,
  "1호선 종점의 긴 역명이 서로 겹치지 않을 간격이어야 한다");
assert.equal(daeguStation("구미").y, daeguStation("서대구").y, "대경선 서쪽 구간은 수평이어야 한다");
assert.equal(daeguStation("동대구역").y, daeguStation("경산").y, "대경선 동쪽 구간은 수평이어야 한다");
assert.ok(daeguStation("명덕").y < daeguStation("반월당").y, "1호선 도심 구간은 명덕에서 반월당 방향으로 내려가야 한다");
assert.ok(daeguStation("반월당").y < daeguStation("대구역").y, "1호선 도심 구간은 반월당에서 대구역 방향으로 내려가야 한다");
const daeguAspect = ((daeguNetwork.bounds.maxX - daeguNetwork.bounds.minX) + 160) /
  ((daeguNetwork.bounds.maxY - daeguNetwork.bounds.minY) + 160);
assert.ok(daeguAspect < 1.8, "대구 노선도는 일반 데스크톱 화면에서 좌우가 잘리지 않는 비율이어야 한다");

assert.equal(DISPLAY_NAME["DG:하양(대구가톨릭대)"], "하양(대구가톨릭대)");
assert.equal(DISPLAY_NAME["GJ:학동·증심사입구"], "학동·증심사입구");
assert.equal(DISPLAY_NAME["GJ:문화전당(구도청)"], "문화전당(구도청)");

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
for (const region of Object.keys(REGION_LABELS)) {
  assert.ok(html.includes(`class="region-btn${region === "seoul" ? " active" : ""}" data-region="${region}"`));
  assert.ok(html.includes(`class="rank-region-tab${region === "seoul" ? " active" : ""}" type="button" data-region="${region}"`));
}
const menuRegionOrder = Array.from(
  html.matchAll(/class="region-btn(?: active)?" data-region="([^"]+)"/g),
  match => match[1],
);
const rankingRegionOrder = Array.from(
  html.matchAll(/class="rank-region-tab(?: active)?" type="button" data-region="([^"]+)"/g),
  match => match[1],
);
const visibleRegionOrder = ["seoul", "busan", "daegu", "daejeon", "gwangju", "nationwide"];
assert.deepEqual(menuRegionOrder, visibleRegionOrder, "메인 메뉴의 전국 옵션은 두 번째 줄이어야 한다");
assert.deepEqual(rankingRegionOrder, visibleRegionOrder, "랭킹 메뉴의 전국 옵션은 두 번째 줄이어야 한다");

const css = fs.readFileSync(path.join(root, "css", "style.css"), "utf8");
assert.match(css, /\.region-btn\[data-region="nationwide"\]\s*\{\s*grid-column:\s*1 \/ -1;/);
assert.match(css, /\.rank-region-tab\[data-region="nationwide"\]\s*\{\s*grid-column:\s*1 \/ -1;/);
assert.ok(html.includes('<script src="js/data-nationwide.js"></script>'));
console.log("nationwide data tests: ok");
