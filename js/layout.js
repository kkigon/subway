/* ============================================================
   레이아웃 — 역 좌표 계산 및 네트워크 구성
   - 앵커가 있는 역은 고정 좌표, 없는 역은 앵커 사이 직선 보간
   - 같은 키의 역(환승역)은 모든 노선에서 같은 좌표 공유
   ============================================================ */

function stationDisplayName(key) {
  return DISPLAY_NAME[key] || key;
}

// 한 세그먼트(역 키 배열)의 좌표 배열 계산
function layoutSegment(keys) {
  const pts = new Array(keys.length).fill(null);
  keys.forEach((k, i) => { if (ANCHORS[k]) pts[i] = [...ANCHORS[k]]; });

  const anchorIdx = [];
  pts.forEach((p, i) => { if (p) anchorIdx.push(i); });

  if (anchorIdx.length === 0) {
    // 앵커가 전혀 없으면 (이론상 없음) 한 줄로 나열
    return keys.map((_, i) => [100 + i * 30, 100]);
  }

  // 첫 앵커 이전 구간: 첫 두 앵커 방향으로 역방향 외삽
  const first = anchorIdx[0];
  if (first > 0) {
    const a = pts[anchorIdx[0]];
    const b = pts[anchorIdx[1] ?? anchorIdx[0]] || a;
    const dx = (b[0] - a[0]) || 20, dy = (b[1] - a[1]) || 0;
    const len = Math.hypot(dx, dy) || 1;
    for (let i = 0; i < first; i++) {
      const d = (first - i) * 24;
      pts[i] = [a[0] - dx / len * d, a[1] - dy / len * d];
    }
  }
  // 마지막 앵커 이후 구간: 외삽
  const last = anchorIdx[anchorIdx.length - 1];
  if (last < keys.length - 1) {
    const a = pts[last];
    const b = pts[anchorIdx[anchorIdx.length - 2] ?? last] || a;
    const dx = (a[0] - b[0]) || 20, dy = (a[1] - b[1]) || 0;
    const len = Math.hypot(dx, dy) || 1;
    for (let i = last + 1; i < keys.length; i++) {
      const d = (i - last) * 24;
      pts[i] = [a[0] + dx / len * d, a[1] + dy / len * d];
    }
  }
  // 앵커 사이 보간
  for (let a = 0; a < anchorIdx.length - 1; a++) {
    const i0 = anchorIdx[a], i1 = anchorIdx[a + 1];
    const p0 = pts[i0], p1 = pts[i1];
    for (let i = i0 + 1; i < i1; i++) {
      const t = (i - i0) / (i1 - i0);
      pts[i] = [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
    }
  }
  return pts;
}

/**
 * 선택된 노선들로 네트워크 구성
 * @returns {
 *   stations: Map<key, {key, name, x, y, lines: lineId[]}>,
 *   paths: [{line, points: [[x,y],...]}],
 *   bounds: {minX, minY, maxX, maxY}
 * }
 */
function buildNetwork(lineIds) {
  const stations = new Map();
  const paths = [];
  const selected = LINES.filter(l => lineIds.includes(l.id));

  for (const line of selected) {
    for (const seg of line.segments) {
      const pts = layoutSegment(seg);
      paths.push({ line, points: pts });
      seg.forEach((key, i) => {
        if (!stations.has(key)) {
          stations.set(key, {
            key,
            name: stationDisplayName(key),
            x: pts[i][0], y: pts[i][1],
            lines: []
          });
        }
        const st = stations.get(key);
        if (!st.lines.includes(line.id)) st.lines.push(line.id);
      });
    }
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const st of stations.values()) {
    minX = Math.min(minX, st.x); maxX = Math.max(maxX, st.x);
    minY = Math.min(minY, st.y); maxY = Math.max(maxY, st.y);
  }
  return { stations, paths, bounds: { minX, minY, maxX, maxY } };
}

// 전체 데이터셋 기준, 역 키 → 소속 노선 전부 (환승 표시용)
const ALL_STATION_LINES = (() => {
  const map = new Map();
  for (const line of LINES) {
    for (const seg of line.segments) {
      for (const key of seg) {
        if (!map.has(key)) map.set(key, []);
        const arr = map.get(key);
        if (!arr.includes(line.id)) arr.push(line.id);
      }
    }
  }
  return map;
})();

function lineById(id) {
  return LINES.find(l => l.id === id);
}
