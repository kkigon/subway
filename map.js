/* ============================================================
   지도 — SVG 노선도 렌더링 & 부드러운 카메라 이동
   ============================================================ */

const SubwayMap = (() => {
  const NS = "http://www.w3.org/2000/svg";
  let svg, gLines, gStations, gLabels, focusRing;
  let network = null;
  let view = { x: 0, y: 0, w: 2400, h: 1600 };
  let animFrame = null;
  let interactive = false;   // 자유 이동(드래그/줌) 허용 여부
  let minW = 200, maxW = 200000; // 줌 한계(뷰 너비 기준)

  function el(tag, attrs = {}) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  function init(container) {
    container.innerHTML = "";
    svg = el("svg", { id: "metro-svg" });
    gLines = el("g", { class: "g-lines" });
    gStations = el("g", { class: "g-stations" });
    gLabels = el("g", { class: "g-labels" });
    focusRing = el("circle", { class: "focus-ring", r: 16, opacity: 0 });
    svg.append(gLines, gStations, gLabels, focusRing);
    container.appendChild(svg);
    setupInteraction(container);
  }

  /* ---------------- 자유 이동(드래그/휠/핀치) ---------------- */
  // 화면 픽셀 한 칸이 SVG 좌표로 몇 단위인지
  function unitsPerPixel() {
    const r = svg.getBoundingClientRect();
    return r.width > 0 ? view.w / r.width : 1;
  }
  function clampZoom(w) {
    return Math.max(minW, Math.min(maxW, w));
  }
  // 화면 좌표(clientX/Y)를 현재 view 기준 SVG 좌표로
  function clientToSvg(cx, cy) {
    const r = svg.getBoundingClientRect();
    return {
      x: view.x + (cx - r.left) / r.width * view.w,
      y: view.y + (cy - r.top) / r.height * view.h
    };
  }
  // 특정 화면 지점을 고정한 채 배율(factor)만큼 확대/축소
  function zoomAt(cx, cy, factor) {
    cancelAnimationFrame(animFrame);
    const before = clientToSvg(cx, cy);
    const newW = clampZoom(view.w * factor);
    const newH = newW * (view.h / view.w);
    const r = svg.getBoundingClientRect();
    const fx = (cx - r.left) / r.width, fy = (cy - r.top) / r.height;
    view = { x: before.x - fx * newW, y: before.y - fy * newH, w: newW, h: newH };
    applyView();
  }

  function setupInteraction(container) {
    const pointers = new Map(); // id -> {x,y}
    let pinchDist = 0, pinchMid = null;

    container.addEventListener("pointerdown", e => {
      if (!interactive) return;
      container.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      }
      cancelAnimationFrame(animFrame);
      container.classList.add("grabbing");
    });

    container.addEventListener("pointermove", e => {
      if (!interactive || !pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size === 1) {
        // 드래그 패닝
        const upp = unitsPerPixel();
        view.x -= (e.clientX - prev.x) * upp;
        view.y -= (e.clientY - prev.y) * upp;
        applyView();
      } else if (pointers.size === 2) {
        // 핀치 줌
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (pinchDist > 0) zoomAt(mid.x, mid.y, pinchDist / dist);
        // 두 손가락 중심 이동으로 패닝
        if (pinchMid) {
          const upp = unitsPerPixel();
          view.x -= (mid.x - pinchMid.x) * upp;
          view.y -= (mid.y - pinchMid.y) * upp;
          applyView();
        }
        pinchDist = dist; pinchMid = mid;
      }
    });

    const endPointer = e => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) { pinchDist = 0; pinchMid = null; }
      if (pointers.size === 0) container.classList.remove("grabbing");
    };
    container.addEventListener("pointerup", endPointer);
    container.addEventListener("pointercancel", endPointer);

    // 휠 줌 (트랙패드 핀치도 wheel+ctrlKey로 들어옴)
    container.addEventListener("wheel", e => {
      if (!interactive) return;
      e.preventDefault();
      const factor = Math.exp(e.deltaY * 0.0015); // 위로 굴리면 축소값<1 → 확대
      zoomAt(e.clientX, e.clientY, factor);
    }, { passive: false });
  }

  function setInteractive(on) {
    interactive = on;
    if (svg) svg.parentElement.classList.toggle("interactive", on);
  }

  function render(net) {
    network = net;
    gLines.innerHTML = "";
    gStations.innerHTML = "";
    gLabels.innerHTML = "";

    // 노선 그리기 — 구간(edge) 단위
    // 한 구간을 여러 노선이 공유하면 각 노선 색을 진행방향에 수직으로
    // 나란히(위 반/아래 반) 그려 두 색이 모두 보이게 한다.
    // 또 via(우회 중간점)가 있으면 직선 대신 둥근 폴리라인으로 그린다.
    const LINE_W = 8;

    // 점 배열을 받아 진행방향 수직으로 off만큼 평행이동
    const offsetPts = (pts, off) => {
      if (off === 0) return pts.map(p => [...p]);
      return pts.map((p, i) => {
        const prev = pts[Math.max(0, i - 1)];
        const next = pts[Math.min(pts.length - 1, i + 1)];
        const dx = next[0] - prev[0], dy = next[1] - prev[1];
        const len = Math.hypot(dx, dy) || 1;
        return [p[0] + (-dy / len) * off, p[1] + (dx / len) * off];
      });
    };
    // 점 배열 → 둥근 모서리 path d
    const roundedD = (pts, radius = 14) => {
      const f = p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
      const v = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 0.5);
      if (v.length < 2) return "";
      if (v.length === 2) return `M${f(v[0])} L${f(v[1])}`;
      let d = `M${f(v[0])}`;
      for (let i = 1; i < v.length - 1; i++) {
        const p = v[i - 1], c = v[i], n = v[i + 1];
        const din = Math.hypot(c[0] - p[0], c[1] - p[1]) || 1;
        const dout = Math.hypot(n[0] - c[0], n[1] - c[1]) || 1;
        const rin = Math.min(radius, din / 2), rout = Math.min(radius, dout / 2);
        const a = [c[0] - (c[0] - p[0]) / din * rin, c[1] - (c[1] - p[1]) / din * rin];
        const b = [c[0] + (n[0] - c[0]) / dout * rout, c[1] + (n[1] - c[1]) / dout * rout];
        d += ` L${f(a)} Q${f(c)} ${f(b)}`;
      }
      d += ` L${f(v[v.length - 1])}`;
      return d;
    };

    if (net.edges) {
      for (const e of net.edges) {
        // 경로 기준점: 시작 → (via들) → 끝
        const base = [[e.ax, e.ay], ...(e.via || []), [e.bx, e.by]];
        const n = e.lines.length;
        const w = n > 1 ? LINE_W * 0.62 : LINE_W;
        const gap = w;
        const span = (n - 1) * gap;
        e.lines.forEach((id, i) => {
          const off = i * gap - span / 2;
          const pts = offsetPts(base, off);
          gLines.appendChild(el("path", {
            d: roundedD(pts),
            fill: "none", stroke: lineById(id).color,
            "stroke-width": w, "stroke-linecap": "round", "stroke-linejoin": "round",
            class: "line-path"
          }));
        });
      }
    } else {
      // 폴백: 기존 폴리라인 방식
      for (const { line, points } of net.paths) {
        const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
        gLines.appendChild(el("path", {
          d, fill: "none", stroke: line.color,
          "stroke-width": LINE_W, "stroke-linecap": "round", "stroke-linejoin": "round",
          class: "line-path"
        }));
      }
    }

    // 역 + 이름 라벨
    for (const st of net.stations.values()) {
      const isTransfer = st.lines.length > 1;
      const color = lineById(st.lines[0]).color;
      const c = el("circle", {
        cx: st.x, cy: st.y,
        r: isTransfer ? 9 : 6,
        fill: "#ffffff",
        stroke: isTransfer ? "#23262b" : color,
        "stroke-width": isTransfer ? 3.5 : 3,
        class: "station-dot",
        "data-key": st.key
      });
      gStations.appendChild(c);

      const label = el("text", {
        x: st.x, y: st.y + (isTransfer ? 26 : 22),
        class: "station-label",
        "text-anchor": "middle",
        "data-key": st.key
      });
      label.textContent = st.name;
      gLabels.appendChild(label);
    }

    fitAll(true);
  }

  function aspect() {
    const r = svg.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r.width / r.height : 16 / 10;
  }

  function applyView() {
    svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
  }

  function fitAll(instant = false) {
    const b = network.bounds;
    const pad = 80;
    const mapW = (b.maxX - b.minX) + pad * 2;
    const mapH = (b.maxY - b.minY) + pad * 2;
    const a = aspect();              // 컨테이너 가로/세로 비
    const mapAspect = mapW / mapH;
    let w, h;
    if (a >= mapAspect) {
      // 화면이 지도보다 옆으로 넓음(데스크탑 등): 지도 전체가 보이게 세로 기준 맞춤
      h = mapH; w = h * a;
    } else {
      // 화면이 세로로 김(모바일 세로): 지도 '세로'를 화면에 꽉 채워 크게 보이게.
      // 가로는 화면보다 넓어져서 잘리지만, 드래그로 좌우를 탐색할 수 있다.
      h = mapH; w = h * a;           // w < mapW → 좌우 일부만 보이고 패닝 가능
    }
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    // 줌 한계: 전체(가로 기준)보다 더 멀리까지 축소 허용, 한 역 수준까지 확대
    maxW = Math.max(mapW, w) * 1.5;
    minW = Math.max(120, mapW / 22);
    const target = { x: cx - w / 2, y: cy - h / 2, w, h };
    instant ? jumpTo(target) : animateTo(target, 900);
  }

  function jumpTo(t) {
    cancelAnimationFrame(animFrame);
    view = { ...t };
    applyView();
  }

  // 부드러운 카메라 이동 (ease-in-out)
  function animateTo(t, duration = 750) {
    cancelAnimationFrame(animFrame);
    const from = { ...view };
    const start = performance.now();
    const ease = x => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    const step = now => {
      const p = Math.min(1, (now - start) / duration);
      const e = ease(p);
      view = {
        x: from.x + (t.x - from.x) * e,
        y: from.y + (t.y - from.y) * e,
        w: from.w + (t.w - from.w) * e,
        h: from.h + (t.h - from.h) * e
      };
      applyView();
      if (p < 1) animFrame = requestAnimationFrame(step);
    };
    animFrame = requestAnimationFrame(step);
  }

  // 특정 역으로 줌인
  function focusStation(key, zoomWidth = 1000) {
    const st = network.stations.get(key);
    if (!st) return;
    const a = aspect();
    const w = zoomWidth, h = zoomWidth / a;
    animateTo({ x: st.x - w / 2, y: st.y - h / 2 + h * 0.06, w, h }, 850);

    focusRing.setAttribute("cx", st.x);
    focusRing.setAttribute("cy", st.y);
    focusRing.setAttribute("opacity", 1);
    focusRing.classList.remove("pulse");
    void focusRing.getBoundingClientRect(); // 애니메이션 재시작
    focusRing.classList.add("pulse");
  }

  function revealLabel(key, correct) {
    const label = gLabels.querySelector(`text[data-key="${CSS.escape(key)}"]`);
    const dot = gStations.querySelector(`circle[data-key="${CSS.escape(key)}"]`);
    if (label) label.classList.add("revealed");
    if (dot) {
      dot.classList.remove("flash-correct", "flash-wrong");
      void dot.getBoundingClientRect();
      dot.classList.add(correct ? "flash-correct" : "flash-wrong");
    }
  }

  function hideFocus() {
    focusRing.setAttribute("opacity", 0);
    focusRing.classList.remove("pulse");
  }

  // 공부 모드: 모든 역 이름 표시 / 숨김
  function showAllLabels() {
    gLabels.querySelectorAll("text").forEach(t => t.classList.add("revealed"));
  }
  function hideAllLabels() {
    gLabels.querySelectorAll("text").forEach(t => t.classList.remove("revealed"));
  }

  function handleResize() {
    if (!network) return;
    // 컨테이너 비율이 바뀌면 뷰 높이를 비율에 맞춰 보정(중심 유지)
    const a = aspect();
    const cx = view.x + view.w / 2, cy = view.y + view.h / 2;
    const newH = view.w / a;
    view.h = newH;
    view.x = cx - view.w / 2;
    view.y = cy - newH / 2;
    applyView();
  }

  return {
    init, render, fitAll, focusStation, revealLabel, hideFocus, handleResize,
    setInteractive, showAllLabels, hideAllLabels
  };
})();
