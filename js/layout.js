/* ============================================================
   레이아웃 — 역 좌표 계산 및 네트워크 구성
   - 앵커가 있는 역은 고정 좌표, 없는 역은 앵커 사이 직선 보간
   - 같은 키의 역(환승역)은 모든 노선에서 같은 좌표 공유
   ============================================================ */

function stationDisplayName(key) {
  return DISPLAY_NAME[key] || key;
}

/* ------------------------------------------------------------
   구간 우회 경로(ROUTE_VIA)
   특정 두 역 사이 구간을, 직선이 아니라 지정한 중간점들을 거쳐
   곡선으로 그리고 싶을 때 사용한다.
   - 예: GTX-A의 대곡~연신내 구간은 3호선과 같은 높이(y=530)라
     직선으로 그리면 완전히 겹친다. 살짝 위로 띄워 우회시킨다.
   - 키는 "정렬된키A||정렬된키B", from은 points가 향하는 시작 역.
   - lines를 지정하면 그 노선이 포함된 구간에만 적용.
   ------------------------------------------------------------ */
const ROUTE_VIA = {
  "대곡||연신내": {
    from: "대곡",
    lines: ["GTXA"],
    // 대곡(781,530) → 연신내(1325,530). 3호선보다 살짝 위(y=490)로 띄움.
    points: [[831, 490], [1275, 490]]
  },
  "서울역||연신내": {
    from: "연신내",
    lines: ["GTXA"],
    points: [[1800, 700], [1325, 700]]
  },
  "구성||성남": {
    from: "구성",
    lines: ["GTXA"],
    points: [[3120, 2500], [3120, 2600]]
  },
  "김포공항||원종": {
    from: "김포공항",
    lines: ["SH"],
    points: [[600, 1100]]
  }
};

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


function buildNetwork(lineIds, options = {}) {
  const stations = new Map();
  const paths = [];

  // lineIds: 실제 게임 출제 대상 노선
  // displayLineIds: 화면에 표시할 노선
  // 지정하지 않으면 기존처럼 lineIds만 표시
  const activeSet = new Set(lineIds);
  const displayLineIds = options.displayLineIds || lineIds;
  const selected = LINES.filter(l => displayLineIds.includes(l.id));

  for (const line of selected) {
    const isActiveLine = activeSet.has(line.id);

    for (const seg of line.segments) {
      const pts = layoutSegment(seg);

      // 노선은 항상 원래 색으로 그릴 것이므로 active 정보는 필요 없음
      paths.push({ line, points: pts });

      seg.forEach((key, i) => {
        if (!stations.has(key)) {
          stations.set(key, {
            key,
            name: stationDisplayName(key),
            x: pts[i][0],
            y: pts[i][1],
            lines: [],
            activeLines: []
          });
        }

        const st = stations.get(key);

        // 화면 표시용 전체 노선 정보
        if (!st.lines.includes(line.id)) {
          st.lines.push(line.id);
        }

        // 실제 문제 출제 대상 노선 정보
        if (isActiveLine && !st.activeLines.includes(line.id)) {
          st.activeLines.push(line.id);
        }
      });
    }
  }

  // 문제 출제용 역 목록: 선택한 노선에 포함된 역만
  const quizStations = new Map(
    [...stations.entries()].filter(([, st]) => st.activeLines.length > 0)
  );

  // ---- 구간(edge)별 노선 목록 집계 ----
  // 같은 두 역을 잇는 구간을 여러 노선이 공유하면(예: 4호선·수인분당선 안산~오이도),
  // 한 구간에 두 노선 색을 나란히 그리기 위해 edge 단위로 모은다.
  const edgeMap = new Map(); // "keyA||keyB" -> { ax, ay, bx, by, lines: [lineId,...] }
  for (const line of selected) {
    for (const seg of line.segments) {
      for (let i = 0; i < seg.length - 1; i++) {
        const a = seg[i], b = seg[i + 1];
        const sa = stations.get(a), sb = stations.get(b);
        if (!sa || !sb) continue;
        const k = [a, b].sort().join("||");
        if (!edgeMap.has(k)) {
          edgeMap.set(k, {
            ax: sa.x, ay: sa.y, bx: sb.x, by: sb.y, lines: []
          });
        }
        const e = edgeMap.get(k);
        if (!e.lines.includes(line.id)) e.lines.push(line.id);
      }
    }
  }
  // 표시 순서를 일정하게 (노선 정의 순서 따라)
  const lineOrder = new Map(LINES.map((l, i) => [l.id, i]));
  const edges = [...edgeMap.entries()].map(([k, e]) => {
    const out = {
      ...e,
      lines: e.lines.slice().sort((x, y) => lineOrder.get(x) - lineOrder.get(y))
    };
    // 특정 구간은 곡선 우회 경로(via)를 부여해 다른 노선과 겹치지 않게 한다.
    const route = ROUTE_VIA[k];
    if (route) {
      // route.lines가 있으면 해당 노선이 이 구간에 포함될 때만 적용
      const applies = !route.lines || route.lines.some(id => out.lines.includes(id));
      if (applies) {
        // via 좌표는 "대곡→연신내" 기준 방향. 정렬된 키 순서와 맞춰 뒤집기.
        const [ka, kb] = k.split("||");
        const forward = (route.from === ka); // route.from이 정렬상 앞이면 그대로
        out.via = forward ? route.points.map(p => [...p])
                          : route.points.map(p => [...p]).reverse();
      }
    }
    return out;
  });

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const st of stations.values()) {
    minX = Math.min(minX, st.x);
    maxX = Math.max(maxX, st.x);
    minY = Math.min(minY, st.y);
    maxY = Math.max(maxY, st.y);
  }

  return {
    stations,
    quizStations,
    paths,
    edges,
    bounds: { minX, minY, maxX, maxY }
  };
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
