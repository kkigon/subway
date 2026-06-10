const fs = require("fs");
const vm = require("vm");

if (process.argv.length < 4) {
  console.error("사용법: node tools/extract-anchors-from-svg.js js/data.js standard-map.svg > js/generatedAnchors.js");
  process.exit(1);
}

const dataPath = process.argv[2];
const svgPath = process.argv[3];

const dataCode = fs.readFileSync(dataPath, "utf8");
const svg = fs.readFileSync(svgPath, "utf8");

const context = {};
vm.createContext(context);
vm.runInContext(
  dataCode + "\nthis.LINES = LINES; this.DISPLAY_NAME = DISPLAY_NAME;",
  context
);

const LINES = context.LINES;
const DISPLAY_NAME = context.DISPLAY_NAME || {};

function decodeHtml(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function normalizeName(s) {
  return decodeHtml(s)
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, "")
    .replace(/역$/g, "")
    .trim();
}

function getAttr(attrText, name) {
  const re = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i");
  const m = attrText.match(re);
  return m ? m[1] : null;
}

function parseTransformXY(transform) {
  if (!transform) return null;

  let m = transform.match(/matrix\(([^)]+)\)/i);
  if (m) {
    const nums = m[1]
      .split(/[,\s]+/)
      .map(Number)
      .filter(n => Number.isFinite(n));

    if (nums.length >= 6) {
      return [nums[4], nums[5]];
    }
  }

  m = transform.match(/translate\(([^)]+)\)/i);
  if (m) {
    const nums = m[1]
      .split(/[,\s]+/)
      .map(Number)
      .filter(n => Number.isFinite(n));

    if (nums.length >= 2) {
      return [nums[0], nums[1]];
    }
  }

  return null;
}

function parseXY(attrText) {
  const x = getAttr(attrText, "x");
  const y = getAttr(attrText, "y");

  if (x !== null && y !== null) {
    const nx = Number(String(x).split(/\s+/)[0]);
    const ny = Number(String(y).split(/\s+/)[0]);

    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      return [nx, ny];
    }
  }

  return parseTransformXY(getAttr(attrText, "transform"));
}

function getAllStationKeys() {
  const set = new Set();

  for (const line of LINES) {
    for (const seg of line.segments) {
      for (const key of seg) {
        set.add(key);
      }
    }
  }

  return [...set];
}

const stationKeys = getAllStationKeys();

// 표시명 → 실제 key 목록
// 예: 양평, 신촌처럼 동명이역이 있으면 자동 매칭에서 제외한다.
const displayToKeys = new Map();

for (const key of stationKeys) {
  const display = DISPLAY_NAME[key] || key;
  const norm = normalizeName(display);

  if (!displayToKeys.has(norm)) {
    displayToKeys.set(norm, []);
  }

  displayToKeys.get(norm).push(key);
}

const rawPoints = new Map();

const textRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
let match;

while ((match = textRe.exec(svg)) !== null) {
  const attrText = match[1];
  const body = match[2];

  const cleanText = normalizeName(body);
  if (!cleanText) continue;

  const keys = displayToKeys.get(cleanText);
  if (!keys || keys.length !== 1) continue;

  const xy = parseXY(attrText);
  if (!xy) continue;

  const key = keys[0];

  if (!rawPoints.has(key)) {
    rawPoints.set(key, []);
  }

  rawPoints.get(key).push(xy);
}

// 같은 역명이 여러 text로 잡히면 평균 좌표 사용
const points = {};

for (const [key, arr] of rawPoints.entries()) {
  const x = arr.reduce((sum, p) => sum + p[0], 0) / arr.length;
  const y = arr.reduce((sum, p) => sum + p[1], 0) / arr.length;
  points[key] = [x, y];
}

const xs = Object.values(points).map(p => p[0]);
const ys = Object.values(points).map(p => p[1]);

if (xs.length === 0) {
  console.error("역 좌표를 하나도 추출하지 못했습니다. SVG 안의 역명이 <text>로 들어있는지 확인하세요.");
  process.exit(1);
}

const minX = Math.min(...xs);
const maxX = Math.max(...xs);
const minY = Math.min(...ys);
const maxY = Math.max(...ys);

// 현재 게임 좌표계에 맞게 정규화
const TARGET_W = 3200;
const TARGET_H = 2200;
const PAD = 120;

const scale = Math.min(
  (TARGET_W - PAD * 2) / Math.max(1, maxX - minX),
  (TARGET_H - PAD * 2) / Math.max(1, maxY - minY)
);

const normalized = {};

for (const [key, [x, y]] of Object.entries(points)) {
  normalized[key] = [
    Math.round((x - minX) * scale + PAD),
    Math.round((y - minY) * scale + PAD)
  ];
}

console.error(`추출 성공: ${Object.keys(normalized).length}개 역`);

console.log("/* 자동 생성 파일: 표준 노선도 SVG에서 추출한 역 좌표 */");
console.log("const STANDARD_ANCHORS = {");

for (const key of Object.keys(normalized).sort((a, b) => a.localeCompare(b, "ko"))) {
  const [x, y] = normalized[key];
  console.log(`  ${JSON.stringify(key)}: [${x}, ${y}],`);
}

console.log("};");
console.log("");
console.log("Object.assign(ANCHORS, STANDARD_ANCHORS);");
