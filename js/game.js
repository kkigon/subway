/* ============================================================
   지하철 게임 — 메인 게임 로직
   ============================================================ */

const DEFAULT_GAME_SECONDS = 60;
const HINTS_PER_GAME = 3;
const REVEAL_DELAY = 500; // 정답 공개 후 다음 문제로 넘어가는 시간(ms)
const SUGGEST_LIMIT = 50; // 자동완성에 한 번에 보여줄 최대 추천 개수 (이 이상은 스크롤)

const $ = sel => document.querySelector(sel);

const State = {
  region: "seoul",       // REGION_LABELS의 지역 코드
  mode: "core",          // core | all | custom (노선 범위)
  playMode: "timed",     // timed(시간 도전) | endless(연속 모드)
  gameDuration: DEFAULT_GAME_SECONDS,
  customLines: new Set(),
  playing: false,
  studying: false,       // 공부 모드 여부
  network: null,
  pool: [],              // 출제 대기 역 키
  current: null,         // 현재 문제 역 키
  score: 0,
  hintsLeft: HINTS_PER_GAME,
  endAt: 0,
  timerFrame: null,
  awaitingNext: false,
  suggestions: [],
  suggestIndex: -1,
  // ----- 대전 모드 -----
  versus: false,         // 대전 모드로 진행 중인지
  versusDuration: 60,    // 대전 제한시간(초)
  vsOrder: [],           // 공유 문제 순서(역 키 배열)
  vsIndex: 0,            // 현재 문제 번호(모두 공유)
  vsLocked: false,       // 현재 문제를 누가 이미 맞혔는지(잠금)
  vsScores: {},          // id -> 점수
  vsLastWinner: null,    // 직전 정답자 id (초록 반짝용)
  vsAnsweredWrong: false,// 이번 문제에서 내가 이미 틀렸는지(중복 오답 방지용 표시)
};

/* ---------------- 사운드 ---------------- */
const Sound = (() => {
  const files = {
    correct: new Audio("assets/sounds/correct.mp3"),
    wrong: new Audio("assets/sounds/wrong.mp3"),
  };
  let ctx = null;
  function beep(freqs, dur = 0.12) {
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      freqs.forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = f;
        o.type = "sine";
        g.gain.setValueAtTime(0.12, ctx.currentTime + i * dur);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (i + 1) * dur);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + i * dur);
        o.stop(ctx.currentTime + (i + 1) * dur);
      });
    } catch (e) { /* 무음 */ }
  }
  function play(name) {
    const a = files[name];
    a.currentTime = 0;
    a.play().catch(() => {
      // mp3 파일이 아직 없으면 임시 효과음으로 대체
      name === "correct" ? beep([880, 1320]) : beep([220, 165], 0.16);
    });
  }
  return { play };
})();

/* ---------------- 모드 / 지역 ---------------- */
// 현재 지역에 속한 노선 목록
function regionLines() {
  return linesForRegion(State.region);
}
function regionLineIds() {
  return regionLines().map(l => l.id);
}

function regionMapOptions(displayLineIds = regionLineIds()) {
  return {
    displayLineIds,
    regionLayout: State.region === "nationwide" ? "nationwide" : null,
  };
}

function selectedLineIds() {
  // core 노선이 없는 지역은 all과 동일 처리
  if (State.mode === "core") {
    const core = regionLines().filter(l => l.core).map(l => l.id);
    return core.length ? core : regionLineIds();
  }
  if (State.mode === "all") return regionLineIds();
  return [...State.customLines];
}

function buildCustomPicker() {
  const box = $("#custom-lines");
  box.innerHTML = "";
  for (const line of regionLines()) {
    const label = document.createElement("label");
    label.className = "line-check";
    label.innerHTML = `
      <input type="checkbox" value="${line.id}">
      <span class="line-chip" style="--c:${line.color};--t:${line.darkText ? "#23262b" : "#fff"}">${line.badge}</span>
      <span class="line-check-name">${line.name}</span>`;
    const input = label.querySelector("input");
    input.checked = State.customLines.has(line.id);
    input.addEventListener("change", () => {
      input.checked ? State.customLines.add(line.id) : State.customLines.delete(line.id);
      updateStartButton();
    });
    box.appendChild(label);
  }
}

function updateStartButton() {
  const btn = $("#btn-start");
  const empty = State.mode === "custom" && State.customLines.size === 0;
  btn.disabled = empty;
  btn.textContent = empty ? "노선을 선택하세요" : "게임 시작";
}

/* ---------------- 게임 시작 ---------------- */
function startGame() {
  const ids = selectedLineIds();
  if (ids.length === 0) return;

  State.network = buildNetwork(ids, regionMapOptions());
  SubwayMap.render(State.network);

  State.pool = shuffle([...State.network.quizStations.keys()]);
  State.score = 0;
  State.hintsLeft = HINTS_PER_GAME;
  State.playing = true;
  State.awaitingNext = false;

  $("#score").textContent = "0";
  $("#hint-count").textContent = State.hintsLeft;
  $("#btn-hint").disabled = false;
  $("#hint-display").classList.remove("show");

  document.body.classList.add("in-game");
  document.body.classList.remove("at-home", "at-end", "studying");
  // 연속 모드면 타이머 숨김
  document.body.classList.toggle("endless-mode", State.playMode === "endless");

  // 노선도가 선명해진 뒤 첫 문제로 줌인
  setTimeout(() => {
    nextQuestion();
    if (State.playMode === "timed") {
      State.endAt = performance.now() + State.gameDuration * 1000;
      tickTimer();
    } else {
      // 연속 모드: 시간 제한 없음
      State.endAt = Infinity;
    }
    SubwayMap.setInteractive(true); // 게임 중에도 드래그/줌으로 둘러보기 가능
    $("#answer-input").focus();
  }, 700);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ---------------- 대전 모드 게임 시작 ----------------
   config = {
     region: REGION_LABELS의 지역 코드,
     lineIds: [...],          // 출제 대상 노선 id
     playMode: 'timed'|'endless',
     duration: 60,            // 초 (timed일 때)
     order: [stationKey, ...] // 방장이 정한 문제 순서(모두 동일)
   }
   모든 참가자가 같은 config로 호출 → 같은 문제를 같은 순서로 본다.
------------------------------------------------------ */
function startVersusGame(config) {
  State.region = config.region || "seoul";
  State.mode = config.mode || "all";
  State.playMode = "timed";
  State.versus = true;
  State.versusDuration = config.duration || 60;

  State.network = buildNetwork(config.lineIds, regionMapOptions());
  SubwayMap.render(State.network);

  const validKeys = new Set(State.network.quizStations.keys());
  let order = Array.isArray(config.order) ? config.order.filter(k => validKeys.has(k)) : null;
  if (!order || order.length === 0) order = shuffle([...validKeys]);
  State.vsOrder = order;
  State.vsIndex = -1;          // 아직 첫 문제 표시 전
  State.vsScores = {};
  State.vsLastWinner = null;
  State.vsPhase = "countdown";
  State.score = 0;
  // ★ 이전 게임 잔재 리셋(안 하면 두 번째 게임이 종료/진행이 안 됨)
  State._vsEnded = false;
  State._revealedIndex = null;
  State.answeredThisQ = false;
  State.vsGameEndsAt = 0;
  State.vsQEndsAt = 0;

  State.hintsLeft = HINTS_PER_GAME;
  State.playing = true;
  State.awaitingNext = false;

  $("#score").textContent = "0";
  $("#hint-count").textContent = State.hintsLeft;
  $("#btn-hint").disabled = State.hintsLeft <= 0;   // 대전에서도 힌트 사용 가능(각자 3개)
  $("#hint-display").classList.remove("show");

  document.body.classList.remove("in-versus");
  document.querySelectorAll(".vs-screen").forEach(s => s.classList.remove("show"));
  document.body.classList.add("in-game", "versus-mode");
  document.body.classList.remove("at-home", "at-end", "studying", "endless-mode");

  SubwayMap.setInteractive(false);
  $("#answer-input").disabled = true;

  // 카운트다운은 playAt(방장이 정한 절대시각)에 맞춰 표시 → 모두 동시
  const playAt = config.playAt || (Date.now() + 3300);
  runVersusCountdownUntil(playAt);

  // 메인 타이머 표시 루프 시작(절대시각 기반). 종료 판정은 방장이 함.
  startVersusDisplayTimer();
}

// playAt(절대시각)까지 남은 시간으로 3-2-1-시작! 표시
function runVersusCountdownUntil(playAt) {
  const box = $("#vs-countdown");
  const num = $("#vs-countdown-num");
  if (!box || !num) return;
  box.classList.add("show");
  const render = () => {
    if (!State.versus) { box.classList.remove("show"); return; }
    const remainMs = playAt - Date.now();
    if (remainMs <= 0) { box.classList.remove("show"); return; }
    const label = remainMs > 2600 ? "3" : remainMs > 1700 ? "2" : remainMs > 800 ? "1" : "시작!";
    if (num.textContent !== label) {
      num.textContent = label;
      num.classList.toggle("go", label === "시작!");
      num.style.animation = "none"; void num.offsetWidth; num.style.animation = "";
    }
    requestAnimationFrame(render);
  };
  render();
}

// 메인 타이머 + 문제별 타이머 표시(절대시각 기반). 방장이 보낸 snapshot의 시각을 사용.
function startVersusDisplayTimer() {
  cancelAnimationFrame(State.timerFrame);
  const timerEl = $("#timer");
  const qBadge = $("#vs-qtimer");
  const loop = () => {
    if (!State.versus || !State.playing) return;
    const now = Date.now();
    // 메인 타이머
    if (State.vsGameEndsAt) {
      const remain = Math.max(0, State.vsGameEndsAt - now);
      const s = Math.ceil(remain / 1000);
      const mm = Math.floor(s / 60), ss = s % 60;
      timerEl.textContent = `${mm}:${String(ss).padStart(2, "0")}`;
      timerEl.classList.toggle("danger", remain <= 10000);
      // ★ 0이 되면 무조건 게임 종료를 요청(틱 루프와 별개의 안전 트리거). 멱등.
      if (remain <= 0 && typeof Versus !== "undefined" && Versus.forceEnd) { try { Versus.forceEnd(); } catch (e) {} }
    }
    // 문제별 타이머(진행 중일 때만)
    if (qBadge) {
      if (State.vsPhase === "playing" && State.vsQEndsAt) {
        const qr = Math.max(0, State.vsQEndsAt - now);
        const qs = Math.ceil(qr / 1000);
        qBadge.textContent = qs;
        qBadge.classList.add("show");
        qBadge.classList.toggle("danger", qr <= 3000);
      } else {
        qBadge.classList.remove("show");
      }
    }
    State.timerFrame = requestAnimationFrame(loop);
  };
  loop();
}

// ★ 핵심: 방장이 보낸 상태 스냅샷을 받아 화면을 그 상태로 맞춘다 (자가치유)
function applyVersusState(snap) {
  if (!State.versus || !snap) return;
  State.vsGameEndsAt = snap.gameEndsAt;
  State.vsQEndsAt = snap.qEndsAt;
  State.vsScores = snap.scores || {};
  State.vsPhase = snap.phase;

  // 내 점수 상단 표시
  const myVsId = (typeof Versus !== "undefined" && Versus.myId) ? Versus.myId() : null;
  State.score = (myVsId && State.vsScores[myVsId]) || 0;
  $("#score").textContent = State.score;

  // 점수판/이름 갱신 (versus-ui가 snap.names도 활용)
  State.vsNames = snap.names || {};
  State.vsLastWinner = (snap.phase === "reveal" && snap.winnerId) ? snap.winnerId : null;
  if (typeof window.onVersusScoreUpdate === "function") window.onVersusScoreUpdate();

  // 게임 종료
  if (snap.phase === "ended") {
    if (!State._vsEnded) { State._vsEnded = true; endVersusFromState(snap); }
    return;
  }

  // 문제 인덱스가 바뀌었으면 새 문제 렌더
  if (typeof snap.index === "number" && snap.index !== State.vsIndex && snap.phase !== "countdown") {
    State.vsIndex = snap.index;
    State.current = State.vsOrder[snap.index];
    if (State.current) {
      renderCurrentQuestion();
      const input = $("#answer-input");
      input.value = "";
      input.disabled = false;
      State.answeredThisQ = false;
      // 새 문제 → 이전 힌트 숨기고, 남은 힌트 있으면 버튼 다시 활성(힌트는 게임당 3개 공용)
      $("#hint-display").classList.remove("show");
      $("#btn-hint").disabled = State.hintsLeft <= 0;
      if (snap.phase === "playing") { SubwayMap.setInteractive(true); setTimeout(() => input.focus(), 50); }
    }
  }

  // 정답 공개(reveal) 상태 반영
  if (snap.phase === "reveal" && State.current) {
    if (!State._revealedIndex || State._revealedIndex !== snap.index) {
      State._revealedIndex = snap.index;
      const st = State.network.stations.get(State.current);
      $("#answer-input").disabled = true;
      clearSuggestions();
      if (snap.winnerId) {
        SubwayMap.revealLabel(State.current, true);
        Sound.play("correct");
        popFeedback(`⭕ ${snap.winnerName} 정답! 「${st.name}」`, "ok");
      } else {
        SubwayMap.revealLabel(State.current, false);
        Sound.play("wrong");
        popFeedback(`⏱️ 시간 초과! 정답은 「${st.name}」`, "no");
      }
    }
  } else if (snap.phase === "playing") {
    State._revealedIndex = null;
  }
}

function endVersusFromState(snap) {
  // 최종 순위 만들기 (방장 권위 점수 사용)
  const scores = snap.scores || {};
  const names = snap.names || {};
  const players = (typeof Versus !== "undefined" && Versus.getPlayers) ? Versus.getPlayers() : [];
  const nameMap = {}, themeMap = {};
  players.forEach(p => { nameMap[p.id] = p.name; themeMap[p.id] = p.themeLine; });
  Object.keys(names).forEach(id => { if (!nameMap[id]) { nameMap[id] = names[id].name; themeMap[id] = names[id].themeLine; } });
  const ids = new Set([...Object.keys(scores), ...players.map(p => p.id)]);
  const ranking = [...ids].map(id => ({
    id, name: nameMap[id] || "(나간 참가자)", themeLine: themeMap[id] || null, score: scores[id] || 0,
  })).sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)));

  State.playing = false;
  State.versus = false;
  cancelAnimationFrame(State.timerFrame);
  SubwayMap.setInteractive(false); SubwayMap.hideFocus(); SubwayMap.fitAll();
  document.body.classList.remove("in-game", "versus-mode");
  const sb = $("#vs-scoreboard"); if (sb) sb.classList.remove("show");
  const qb = $("#vs-qtimer"); if (qb) qb.classList.remove("show");

  if (typeof window.onVersusGameEnd === "function") {
    window.onVersusGameEnd({ ranking, myId: (typeof Versus !== "undefined" && Versus.myId) ? Versus.myId() : null });
  }
}

// State.current 역으로 문제 UI(배지/문구/포커스)를 그린다
function renderCurrentQuestion() {
  const st = State.network.stations.get(State.current);
  if (!st) return;
  SubwayMap.focusStation(State.current);
  const badges = $("#question-lines");
  badges.innerHTML = "";
  const lineIds = ALL_STATION_LINES.get(State.current) || st.lines;
  for (const id of lineIds) {
    const line = lineById(id);
    const chip = document.createElement("span");
    chip.className = "line-chip";
    chip.style.setProperty("--c", line.color);
    chip.style.setProperty("--t", line.darkText ? "#23262b" : "#fff");
    chip.textContent = line.badge;
    badges.appendChild(chip);
  }
  $("#question-text").textContent = lineIds.length > 1 ? "이 환승역의 이름은?" : "이 역의 이름은?";
  $("#hint-display").classList.remove("show");
  clearSuggestions();
}

// 대전용 문제 순서 생성(방장이 호출)
function buildVersusOrder(region, lineIds) {
  const prevRegion = State.region;
  State.region = region;
  const net = buildNetwork(lineIds, { displayLineIds: lineIds });
  State.region = prevRegion;
  return shuffle([...net.quizStations.keys()]);
}

// 대전: 입력 감지 → "입력중" presence 전파
let _typingTimer = null;
function onVersusTyping() {
  if (!State.versus || typeof Versus === "undefined" || !Versus.setTyping) return;
  const hasText = $("#answer-input").value.trim().length > 0;
  Versus.setTyping(hasText);
  if (_typingTimer) clearTimeout(_typingTimer);
  if (hasText) _typingTimer = setTimeout(() => { try { Versus.setTyping(false); } catch (e) {} }, 1500);
}

/* ---------------- 대전: 정답 제출 ---------------- */
// 내가 답을 제출 (대전 모드) — 맞으면 방장에게 보고만 함. 진행은 스냅샷이 결정.
function submitVersusAnswer() {
  if (!State.playing || State.vsPhase !== "playing" || !State.current) return;
  const input = $("#answer-input");
  const value = input.value.trim();
  if (!value) return;
  const st = State.network.stations.get(State.current);
  const correct = matchesAnswer(value, st.name);

  if (!correct) {
    Sound.play("wrong");
    popFeedback("❌ 다시!", "no");
    input.select();
    return;
  }
  // 정답: 방장에게 보고(중복 보고 방지). 점수/진행은 방장이 스냅샷으로 알려줌.
  if (State.answeredThisQ) return;
  State.answeredThisQ = true;
  input.value = "";
  popFeedback("✅ 제출!", "ok");
  if (typeof Versus !== "undefined" && Versus.setTyping) { try { Versus.setTyping(false); } catch (e) {} }
  if (typeof Versus !== "undefined" && Versus.sendAnswer) { try { Versus.sendAnswer(State.vsIndex); } catch (e) {} }
}

/* ---------------- 타이머 ---------------- */
function tickTimer() {
  cancelAnimationFrame(State.timerFrame);
  const timerEl = $("#timer");
  const loop = () => {
    if (!State.playing) return;
    const remain = Math.max(0, State.endAt - performance.now());
    const s = Math.ceil(remain / 1000);
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    timerEl.textContent = `${mm}:${String(ss).padStart(2, "0")}`;
    timerEl.classList.toggle("danger", s <= 10);
    if (remain <= 0) {
      if (!State.awaitingNext) endGame();
      return; // 정답 공개 중이면 공개 후 종료
    }
    State.timerFrame = requestAnimationFrame(loop);
  };
  loop();
}

/* ---------------- 문제 출제 ---------------- */
function nextQuestion() {
  if (!State.playing) return;
  if (State.pool.length === 0) { endGame(); return; }

  State.current = State.pool.pop();
  State.awaitingNext = false;

  const st = State.network.stations.get(State.current);
  SubwayMap.focusStation(State.current);

  // 노선 배지 (환승역이면 전체 노선 표시)
  const badges = $("#question-lines");
  badges.innerHTML = "";
  const lineIds = ALL_STATION_LINES.get(State.current) || st.lines;
  for (const id of lineIds) {
    const line = lineById(id);
    const chip = document.createElement("span");
    chip.className = "line-chip";
    chip.style.setProperty("--c", line.color);
    chip.style.setProperty("--t", line.darkText ? "#23262b" : "#fff");
    chip.textContent = line.badge;
    badges.appendChild(chip);
  }
  $("#question-text").textContent = lineIds.length > 1 ? "이 환승역의 이름은?" : "이 역의 이름은?";

  const input = $("#answer-input");
  input.value = "";
  input.disabled = false;
  $("#hint-display").classList.remove("show");
  clearSuggestions();
  input.focus();
}

/* ---------------- 정답 처리 ---------------- */
function submitAnswer() {
  // 대전 모드면 선착순 경쟁 로직으로
  if (State.versus) { submitVersusAnswer(); return; }
  if (!State.playing || State.awaitingNext || !State.current) return;
  const input = $("#answer-input");
  const value = input.value.trim();
  const st = State.network.stations.get(State.current);
  const correct = matchesAnswer(value, st.name);

  State.awaitingNext = true;
  input.disabled = true;
  clearSuggestions();

  SubwayMap.revealLabel(State.current, correct);
  Sound.play(correct ? "correct" : "wrong");

  if (correct) {
    State.score++;
    $("#score").textContent = State.score;
    popFeedback("⭕ 정답!", "ok");
  } else {
    popFeedback(`❌ 정답은 「${st.name}」`, "no");
  }

  // 연속 모드: 틀리면 게임 오버
  if (State.playMode === "endless" && !correct) {
    setTimeout(() => endGame(), REVEAL_DELAY);
    return;
  }

  const remain = State.endAt - performance.now();
  setTimeout(() => {
    if (remain <= 0) { endGame(); return; }
    nextQuestion();
  }, REVEAL_DELAY);
}

function popFeedback(text, kind) {
  const fb = $("#feedback");
  fb.textContent = text;
  fb.className = `feedback show ${kind}`;
  setTimeout(() => fb.classList.remove("show"), REVEAL_DELAY - 100);
}

/* ---------------- 힌트 ---------------- */
function useHint() {
  if (!State.playing || State.awaitingNext || State.hintsLeft <= 0) return;
  State.hintsLeft--;
  $("#hint-count").textContent = State.hintsLeft;
  if (State.hintsLeft === 0) $("#btn-hint").disabled = true;

  const st = State.network.stations.get(State.current);
  const base = st.name.replace(/\(.+?\)$/, ""); // 괄호 별칭 제외하고 초성 표시
  $("#hint-chars").textContent = toChosung(base).split("").join(" ");
  $("#hint-display").classList.add("show");
  $("#answer-input").focus();
}

/* ---------------- 자동완성 ---------------- */
function updateSuggestions() {
  const q = $("#answer-input").value.trim();
  const box = $("#suggestions");
  if (!q || !State.playing || State.awaitingNext) { clearSuggestions(); return; }

  const results = [];
  for (const st of State.network.stations.values()) {
    const score = searchScore(q, st.name);
    if (score > 0) results.push({ st, score });
  }
  results.sort((a, b) => b.score - a.score || a.st.name.length - b.st.name.length || a.st.name.localeCompare(b.st.name, "ko"));
  State.suggestions = results.slice(0, SUGGEST_LIMIT).map(r => r.st);
  State.suggestIndex = -1;

  box.innerHTML = "";
  for (const st of State.suggestions) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "suggest-item";
    const chips = st.lines.map(id => {
      const l = lineById(id);
      return `<span class="line-chip sm" style="--c:${l.color};--t:${l.darkText ? "#23262b" : "#fff"}">${l.badge}</span>`;
    }).join("");
    item.innerHTML = `${chips}<span class="suggest-name">${st.name}</span>`;
    item.addEventListener("pointerdown", e => {
      e.preventDefault(); // 입력창 포커스 유지
      pickSuggestion(st);
    });
    box.appendChild(item);
  }
  box.classList.toggle("show", State.suggestions.length > 0);
}

function pickSuggestion(st) {
  $("#answer-input").value = st.name;
  clearSuggestions();
  $("#answer-input").focus();
}

function moveSuggestion(dir) {
  if (State.suggestions.length === 0) return;
  State.suggestIndex = (State.suggestIndex + dir + State.suggestions.length) % State.suggestions.length;
  const items = document.querySelectorAll(".suggest-item");
  items.forEach((el, i) => el.classList.toggle("active", i === State.suggestIndex));
  // 목록이 길어 스크롤될 때, 선택 항목이 보이도록 따라 스크롤
  const active = items[State.suggestIndex];
  if (active) active.scrollIntoView({ block: "nearest" });
}

function clearSuggestions() {
  State.suggestions = [];
  State.suggestIndex = -1;
  const box = $("#suggestions");
  box.innerHTML = "";
  box.classList.remove("show");
}

/* ---------------- 종료 & 공유 (싱글플레이 전용; 대전은 endVersusFromState) ---------------- */
function endGame() {
  State.playing = false;
  cancelAnimationFrame(State.timerFrame);
  const qb = $("#vs-qtimer"); if (qb) qb.classList.remove("show");
  SubwayMap.setInteractive(false);
  SubwayMap.hideFocus();
  SubwayMap.fitAll();

  $("#final-score").textContent = State.score;
  $("#final-message").textContent = scoreMessage(State.score);
  if (State.playMode === "endless") {
    $("#end-label").textContent = "🔥 연속 정답";
    $("#final-score-unit").textContent = "연속";
  } else {
    $("#end-label").textContent = "최종 점수";
    $("#final-score-unit").textContent = "역";
  }

  document.body.classList.remove("in-game", "versus-mode");
  document.body.classList.add("at-end");

  // 백엔드 기록 저장 (시간제한 모드 + 로그인 상태일 때만; 훅이 내부 판단)
  if (typeof window.onPlayFinished === "function") {
    window.onPlayFinished({
      score: State.score,
      region: State.region,
      mode: State.mode,
      modeLabel: modeLabel(),
      playMode: State.playMode,
      duration: State.gameDuration,
    });
  }
}

function scoreMessage(score) {
  if (State.playMode === "endless") {
    if (score >= 30) return "도저히 인간으로는 보이지 않군요!";
    if (score >= 20) return "끊김 없는 레전드 질주!";
    if (score >= 12) return "엄청난 집중력이네요!";
    if (score >= 6) return "안정적인 출발, 한 판 더?";
    if (score >= 1) return "다음엔 더 멀리 갈 수 있어요!";
    return "괜찮아요, 첫 역부터 다시!";
  }
  if (score >= 25) return "이게 말이 되는 경우인가요???";
  if (score >= 18) return "당신은 걸어다니는 노선도!";
  if (score >= 12) return "철도공사 직원도 깜짝 놀랄 실력!";
  if (score >= 6) return "지리 좀 공부하셨나봐요? 한 판 더?";
  return "다음 열차가 곧 도착합니다. 다시 도전!";
}

// 지역 이름
function regionLabel() {
  return REGION_LABELS[State.region] || State.region;
}

// 현재 게임 모드를 사람이 읽을 수 있는 문구로 (지역 포함)
function modeLabel() {
  const rg = regionLabel();
  if (State.mode === "core") return `${rg} 1~9호선`;
  if (State.mode === "all") return `${rg} 전체 노선`;
  // 커스텀: 고른 노선이 3개 이하면 이름을 직접 나열, 많으면 개수로
  const ids = [...State.customLines];
  const names = ids.map(id => lineById(id)?.name).filter(Boolean);
  if (names.length === 0) return `${rg} 커스텀`;
  if (names.length <= 3) return `${rg} 커스텀(${names.join("·")})`;
  return `${rg} 커스텀(${names.length}개 노선)`;
}

function shareText() {
  if (State.playMode === "endless") {
    return `🚇 지하철 게임 — ${modeLabel()} · 연속 모드에서 ${State.score}개 역을 맞췄어요! 당신도 도전해보세요!`;
  }
  return `🚇 지하철 게임 — ${modeLabel()}에서 ${State.gameDuration}초 동안 ${State.score}개 역을 맞췄어요! 당신도 도전해보세요!`;
}

async function doShare(kind) {
  const url = location.href.split("#")[0];
  const text = shareText();
  if (kind === "native") {
    if (navigator.share) {
      try { await navigator.share({ title: "지하철 게임", text, url }); } catch (e) {}
    } else {
      copyLink();
    }
  } else if (kind === "copy") {
    copyLink();
  } else if (kind === "x") {
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`, "_blank");
  } else if (kind === "kakao") {
    if (window.Kakao && Kakao.isInitialized()) {
      Kakao.Share.sendDefault({
        objectType: "text",
        text,
        link: { mobileWebUrl: url, webUrl: url },
      });
    } else if (navigator.share) {
      try { await navigator.share({ title: "지하철 게임", text, url }); } catch (e) {}
    } else {
      copyLink("링크를 복사했어요! 카카오톡에 붙여넣어 공유하세요.");
    }
  }
}

function copyLink(msg = "링크를 복사했어요!") {
  const url = location.href.split("#")[0];
  navigator.clipboard?.writeText(`${shareText()}\n${url}`).then(() => toast(msg))
    .catch(() => toast("복사에 실패했어요. 주소창의 링크를 직접 복사해주세요."));
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}

/* ---------------- 초기화 & 이벤트 ---------------- */
function goHome() {
  State.playing = false;
  State.studying = false;
  cancelAnimationFrame(State.timerFrame);
  document.body.classList.remove("in-game", "at-end", "studying", "endless-mode");
  document.body.classList.add("at-home");
  SubwayMap.setInteractive(false);
  SubwayMap.hideFocus();
  // 홈 배경용 전체 노선도
  State.network = buildNetwork(regionLineIds(), regionMapOptions());
  SubwayMap.render(State.network);
}

/* ---------------- 공부 모드 ---------------- */
function startStudy() {
  State.playing = false;
  State.studying = true;
  cancelAnimationFrame(State.timerFrame);

  // 전체 노선 + 모든 역을 표시
  State.network = buildNetwork(regionLineIds(), regionMapOptions());
  SubwayMap.render(State.network);

  document.body.classList.remove("at-home", "at-end", "in-game");
  document.body.classList.add("studying");

  SubwayMap.hideFocus();
  // 선명해진 뒤 라벨 표시 + 자유 이동 켜기
  setTimeout(() => {
    SubwayMap.showAllLabels();
    SubwayMap.setInteractive(true);
  }, 650);
}

function exitStudy() {
  SubwayMap.setInteractive(false);
  SubwayMap.hideAllLabels();
  goHome();
}

/* ---------------- 지역 전환 ---------------- */
// 지역을 바꾸고: 커스텀 선택 초기화, core 모드 가시성 조정,
// 배경 노선도를 부드럽게 전환, 모드 라디오 상태 정리
function selectRegion(region) {
  if (region === State.region) return;
  State.region = region;
  State.customLines.clear();

  // 지역 버튼 활성 표시
  document.querySelectorAll(".region-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.region === region));

  // core 노선이 없는 비수도권 지역은 전체/커스텀만 제공한다.
  const hasCore = regionSupportsCore(region);
  const coreOption = document.querySelector('.mode-option.core-only');
  if (coreOption) coreOption.style.display = hasCore ? "" : "none";
  // core가 없으면 모드 선택을 2칸 그리드로 (전체/커스텀이 절반씩 차지)
  const modeSelect = document.querySelector('.mode-select');
  if (modeSelect) modeSelect.classList.toggle("two-cols", !hasCore);
  if (!hasCore && State.mode === "core") {
    State.mode = "all";
    const allRadio = document.querySelector('input[name="mode"][value="all"]');
    if (allRadio) allRadio.checked = true;
  }

  // 커스텀 선택창을 현재 지역 노선으로 다시 그림
  buildCustomPicker();
  $("#custom-lines").classList.toggle("show", State.mode === "custom");
  updateStartButton();

  // 배경 노선도를 현재 지역으로 전환 (홈 화면일 때만 즉시 반영)
  State.network = buildNetwork(regionLineIds(), regionMapOptions());
  SubwayMap.render(State.network);
}

document.addEventListener("DOMContentLoaded", () => {
  SubwayMap.init($("#map-container"));
  buildCustomPicker();
  goHome();

  // 지역 선택
  document.querySelectorAll(".region-btn").forEach(btn =>
    btn.addEventListener("click", () => selectRegion(btn.dataset.region)));

  // 노선 범위 선택
  document.querySelectorAll('input[name="mode"]').forEach(radio => {
    radio.addEventListener("change", () => {
      State.mode = radio.value;
      $("#custom-lines").classList.toggle("show", State.mode === "custom");
      updateStartButton();
    });
  });
  // 플레이 모드 선택 (시간 도전 / 연속 모드)
  document.querySelectorAll('input[name="playmode"]').forEach(radio => {
    radio.addEventListener("change", () => {
      State.playMode = radio.value;
      $("#game-duration-setting")?.classList.toggle("hidden", State.playMode !== "timed");
    });
  });
  document.querySelectorAll(".game-duration-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      State.gameDuration = parseInt(btn.dataset.duration, 10) || DEFAULT_GAME_SECONDS;
      document.querySelectorAll(".game-duration-btn").forEach(candidate =>
        candidate.classList.toggle("active", candidate === btn));
    });
  });
  updateStartButton();

  $("#btn-start").addEventListener("click", startGame);
  $("#btn-retry").addEventListener("click", startGame);
  $("#btn-change-mode").addEventListener("click", goHome);
  $("#btn-hint").addEventListener("click", useHint);
  $("#btn-submit").addEventListener("click", submitAnswer);
  $("#btn-study").addEventListener("click", startStudy);
  $("#btn-exit-study").addEventListener("click", exitStudy);

  document.querySelectorAll("[data-share]").forEach(btn =>
    btn.addEventListener("click", () => doShare(btn.dataset.share)));

  const input = $("#answer-input");
  input.addEventListener("input", updateSuggestions);
  // 대전: 입력중 상태를 presence로 전파 (디바운스)
  input.addEventListener("input", onVersusTyping);
  input.addEventListener("keydown", e => {
    if (e.isComposing) return; // 한글 조합 중에는 무시
    const hasSuggest = State.suggestions.length > 0;
    if (e.key === "ArrowDown") { e.preventDefault(); moveSuggestion(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveSuggestion(-1); }
    // 좌/우 키: 자동완성 목록이 떠 있을 때만 탐색에 사용 (아니면 커서 이동 그대로)
    else if (e.key === "ArrowRight" && hasSuggest) { e.preventDefault(); moveSuggestion(1); }
    else if (e.key === "ArrowLeft" && hasSuggest) { e.preventDefault(); moveSuggestion(-1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (State.suggestIndex >= 0 && State.suggestions[State.suggestIndex]) {
        pickSuggestion(State.suggestions[State.suggestIndex]);
      } else {
        submitAnswer();
      }
    } else if (e.key === "Escape") {
      clearSuggestions();
    }
  });

  window.addEventListener("resize", () => {
    // 홈/엔딩 화면은 전체보기를 다시 맞추고, 게임/공부 중엔 현재 시점 유지
    if (document.body.classList.contains("at-home") ||
        document.body.classList.contains("at-end")) {
      SubwayMap.fitAll(true);
    } else {
      SubwayMap.handleResize();
    }
  });

  // 초기 레이아웃이 늦게 잡히는 모바일 대비: 한 번 더 맞춤
  requestAnimationFrame(() => SubwayMap.fitAll(true));
});

/* ---------------- 대전 모드 연동 (versus-ui.js에서 사용) ---------------- */
window.VersusGame = {
  start: startVersusGame,        // 게임 시작(설정+순서로 화면 준비)
  buildOrder: buildVersusOrder,  // 방장이 호출: 문제 순서 생성
  applyState: applyVersusState,  // 방장 스냅샷 수신 → 화면 반영(자가치유)
  resolveLineIds(region, mode, customLines) {
    const lines = linesForRegion(region);
    if (mode === "core") {
      const core = lines.filter(l => l.core).map(l => l.id);
      return core.length ? core : lines.map(l => l.id);
    }
    if (mode === "custom" && customLines && customLines.length) return customLines.slice();
    return lines.map(l => l.id);
  },
  isVersus: () => State.versus,
  currentIndex: () => State.vsIndex,
  getScores: () => State.vsScores,
  lastWinnerId: () => State.vsLastWinner,
};
