/* ============================================================
   versus-ui.js — 대전 모드 화면 제어 (1단계)
   ------------------------------------------------------------
   - 홈의 "⚔️ 대전 모드" 버튼 → 대전 진입 화면(만들기 / 입장)
   - 방 생성/입장 성공 → 대기실(코드·초대링크 표시)
   - URL에 ?room=CODE 가 있으면 자동으로 입장 시도
   - 실시간 참가자 목록/게임 시작은 다음 단계에서 채운다.
   ============================================================ */

(() => {
  const $ = sel => document.querySelector(sel);

  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ---------- 화면 전환 ---------- */
  // 대전 관련 오버레이를 보여주고 홈/게임 오버레이는 숨긴다.
  function showScreen(id) {
    document.querySelectorAll(".vs-screen").forEach(s => s.classList.remove("show"));
    if (id) $(id)?.classList.add("show");
    document.body.classList.toggle("in-versus", !!id);
  }

  function openEntry() {
    // 서버(설정) 준비 확인
    if (!Account.isConfigured || !Account.isConfigured()) {
      alert("대전 모드는 서버 연결이 필요해요. 잠시 후 다시 시도하거나 새로고침 해주세요.");
      return;
    }
    if (Account.isReady && Account.isReady() && Account.isAvailable && !Account.isAvailable()) {
      alert("Supabase에 연결하지 못했어요. Project URL과 Publishable key를 확인해주세요.");
      return;
    }
    $("#vs-entry-error").textContent = "";
    $("#vs-code-input").value = "";
    showScreen("#vs-entry-screen");
  }

  function closeVersus() {
    showScreen(null);                 // 대전 오버레이 숨김 + in-versus 제거
    document.body.classList.remove("in-versus", "versus-mode");
    if (typeof State !== "undefined") State.versus = false;
    // ★ 홈 화면 완전 복원: 게임/엔딩 상태 클래스 정리 + 홈 배경 지도 재구성.
    //   (게임 끝난 결과화면에서 나가도 빈 지도가 아니라 홈 메뉴가 뜨도록)
    if (typeof goHome === "function") {
      try { goHome(); } catch (e) {}
    } else {
      document.body.classList.remove("in-game", "at-end", "studying", "endless-mode");
      document.body.classList.add("at-home");
    }
  }

  // Account(로그인/프로필) 로딩이 끝날 때까지 잠깐 기다린다.
  // → 로그인 사용자가 잠깐 Guest로 표시되는 문제 방지.
  function ensureAccountReady(timeoutMs = 2500) {
    return new Promise((resolve) => {
      if (Account.isReady && Account.isReady()) return resolve();
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      if (Account.onChange) Account.onChange(() => { if (Account.isReady && Account.isReady()) finish(); });
      setTimeout(finish, timeoutMs);
    });
  }

  // 대기실에 들어가면 URL에 ?room=코드를 박아둔다 → 새로고침해도 자동 재입장
  function setRoomUrl(code) {
    try {
      const url = location.pathname + "?room=" + code;
      history.replaceState(null, "", url);
    } catch (e) {}
  }

  /* ---------- 방 만들기 ---------- */
  async function doCreate() {
    const btn = $("#vs-create-btn");
    btn.disabled = true; btn.textContent = "방 만드는 중…";
    await ensureAccountReady();   // 닉네임/프로필 로딩 완료 후 진행
    const res = await Versus.createRoom();
    btn.disabled = false; btn.textContent = "방 만들기";
    if (!res.ok) { $("#vs-entry-error").textContent = res.message || "방 생성 실패"; return; }
    setRoomUrl(res.code);
    enterLobby();
  }

  /* ---------- 코드로 입장 ---------- */
  async function doJoin(codeFromUrl) {
    const code = codeFromUrl || $("#vs-code-input").value;
    const btn = $("#vs-join-btn");
    if (btn) { btn.disabled = true; btn.textContent = "입장 중…"; }
    await ensureAccountReady();   // 닉네임/프로필 로딩 완료 후 진행
    const res = await Versus.joinRoom(code);
    if (btn) { btn.disabled = false; btn.textContent = "입장하기"; }
    if (!res.ok) {
      const errEl = $("#vs-entry-error");
      if (errEl) errEl.textContent = res.message || "입장 실패";
      // URL 자동입장 실패 시: URL의 room 파라미터를 지우고 진입화면 표시
      if (codeFromUrl) { try { history.replaceState(null, "", location.pathname); } catch (e) {} showScreen("#vs-entry-screen"); }
      return;
    }
    setRoomUrl(res.code);
    enterLobby();
  }

  /* ---------- 대기실 ---------- */
  // 테마 노선 색. themeLine이 없으면(게스트) 회색.
  function lineColor(id) {
    if (!id) return "#9aa0a6";  // 게스트: 회색
    if (typeof lineById === "function") { const l = lineById(id); if (l) return l.color; }
    return "#9aa0a6";
  }

  // 참가자 한 명을 닉네임 태그로
  function playerTag(pl) {
    const color = lineColor(pl.themeLine);
    const isMe = (pl.id === Versus.myId());
    const isThisHost = (pl.id === Versus.getHostId());
    const crown = isThisHost ? `<span class="vs-crown" title="방장">👑</span>` : "";
    const meMark = isMe ? `<span class="vs-me">나</span>` : "";
    // 내가 방장이고, 상대가 내가 아니고, 상대가 아직 방장이 아니면 → 위임 버튼
    const giveBtn = (Versus.isHost() && !isMe && !isThisHost)
      ? `<button class="vs-give-host" type="button" data-give="${escapeHtml(pl.id)}" title="방장 넘기기">👑 위임</button>`
      : "";
    return `<div class="vs-player">
      ${crown}
      <span class="nick-tag static" style="--theme:${color}">
        <span class="nick-dot"></span>
        <span class="nick-text">${escapeHtml(pl.name)}</span>
      </span>
      ${meMark}
      ${giveBtn}
    </div>`;
  }

  function renderPlayers(players) {
    const box = $("#vs-players");
    if (!box) return;
    if (!players || players.length === 0) {
      box.innerHTML = `<p class="muted">참가자를 기다리는 중…</p>`;
      return;
    }
    const count = players.length;
    box.innerHTML =
      `<div class="vs-players-count">현재 ${count}명 접속 중</div>` +
      `<div class="vs-players-list">${players.map(playerTag).join("")}</div>`;

    // 방장 위임 버튼 연결
    box.querySelectorAll(".vs-give-host").forEach(btn =>
      btn.addEventListener("click", () => confirmTransfer(btn.dataset.give)));
  }

  async function confirmTransfer(targetId) {
    const target = Versus.getPlayers().find(p => p.id === targetId);
    if (!target) return;
    if (!confirm(`'${target.name}'님에게 방장을 넘길까요?`)) return;
    const result = await Versus.transferHost(targetId);
    if (!result.ok) alert(result.message || "방장을 넘기지 못했어요. 잠시 후 다시 시도해주세요.");
  }

  // 방장 권한이 바뀌면 대기실의 역할 표시/설정 영역을 갱신
  /* ---------- 방장 게임 설정 ---------- */
  const vsSettings = { region: "seoul", mode: "core", customLines: [], duration: 60, playMode: "timed" };

  // 세그먼트 버튼(지역/노선/시간) 한 그룹 처리
  function wireSeg(containerSel, onPick) {
    const box = $(containerSel);
    if (!box) return;
    box.querySelectorAll(".vs-seg-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        box.querySelectorAll(".vs-seg-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        onPick(btn);
      });
    });
  }

  // 지역에 맞춰 노선 세그먼트(core 표시 여부)와 커스텀 picker 갱신
  function syncRegionUI() {
    const regionLines = LINES.filter(l => (l.region || "seoul") === vsSettings.region);
    const hasCore = regionLines.some(line => line.core);
    const modeBox = $("#vs-set-mode");
    const coreBtn = modeBox && modeBox.querySelector('[data-mode="core"]');
    if (coreBtn) coreBtn.style.display = hasCore ? "" : "none";
    if (!hasCore && vsSettings.mode === "core") {
      vsSettings.mode = "all";
      modeBox.querySelectorAll(".vs-seg-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === "all"));
    }
    buildVsCustomPicker();
    updateCustomVisibility();
  }

  function updateCustomVisibility() {
    const box = $("#vs-custom-lines");
    if (box) box.classList.toggle("show", vsSettings.mode === "custom");
  }

  // 커스텀 노선 체크박스 (현재 지역의 노선들)
  function buildVsCustomPicker() {
    const box = $("#vs-custom-lines");
    if (!box || typeof LINES === "undefined") return;
    const lines = LINES.filter(l => (l.region || "seoul") === vsSettings.region);
    // 지역이 바뀌면 이전 지역 선택은 초기화
    vsSettings.customLines = vsSettings.customLines.filter(id => lines.some(l => l.id === id));
    box.innerHTML = "";
    for (const line of lines) {
      const label = document.createElement("label");
      label.className = "line-check";
      const darkText = line.darkText ? "#23262b" : "#fff";
      label.innerHTML =
        `<input type="checkbox" value="${line.id}">` +
        `<span class="line-chip" style="--c:${line.color};--t:${darkText}">${line.badge}</span>` +
        `<span class="line-check-name">${escapeHtml(line.name)}</span>`;
      const input = label.querySelector("input");
      input.checked = vsSettings.customLines.includes(line.id);
      input.addEventListener("change", () => {
        if (input.checked) { if (!vsSettings.customLines.includes(line.id)) vsSettings.customLines.push(line.id); }
        else { vsSettings.customLines = vsSettings.customLines.filter(id => id !== line.id); }
      });
      box.appendChild(label);
    }
  }

  let settingsWired = false;
  function wireSettingsOnce() {
    if (settingsWired) return;
    settingsWired = true;
    wireSeg("#vs-set-region", (btn) => { vsSettings.region = btn.dataset.region; syncRegionUI(); });
    wireSeg("#vs-set-mode", (btn) => { vsSettings.mode = btn.dataset.mode; updateCustomVisibility(); });
    wireSeg("#vs-set-duration", (btn) => { vsSettings.duration = parseInt(btn.dataset.dur, 10) || 60; });
    $("#vs-start-btn")?.addEventListener("click", doStartGame);
  }

  async function doStartGame() {
    if (vsSettings.mode === "custom" && vsSettings.customLines.length === 0) {
      alert("커스텀 모드에서는 노선을 1개 이상 선택해주세요.");
      return;
    }
    const btn = $("#vs-start-btn");
    btn.disabled = true; btn.textContent = "시작하는 중…";
    const res = await Versus.startGame({
      region: vsSettings.region, mode: vsSettings.mode,
      customLines: vsSettings.customLines, duration: vsSettings.duration,
      playMode: "timed",
    });
    btn.disabled = false; btn.textContent = "게임 시작";
    if (!res.ok) alert(res.message || "시작에 실패했어요.");
  }

  function refreshRole() {
    const host = Versus.isHost();
    const roleEl = $("#vs-lobby-role");
    if (roleEl) roleEl.textContent = host ? "방장" : "참가자";
    const hostCtl = $("#vs-host-controls");
    if (hostCtl) hostCtl.style.display = host ? "" : "none";
    const guestNote = $("#vs-guest-note");
    if (guestNote) guestNote.style.display = host ? "none" : "";
    // 참가자 목록도 다시 그려 왕관/위임 버튼 노출을 갱신
    renderPlayers(Versus.getPlayers());
  }

  /* ---------- 상단 실시간 점수판 ---------- */
  function renderScoreboard() {
    const box = $("#vs-scoreboard");
    if (!box) return;
    if (!window.VersusGame || !VersusGame.isVersus()) { box.classList.remove("show"); return; }
    const scores = (VersusGame.getScores && VersusGame.getScores()) || {};
    const lastWinner = VersusGame.lastWinnerId && VersusGame.lastWinnerId();
    const players = Versus.getPlayers();
    const myId = Versus.myId();
    // 점수 내림차순 정렬
    const sorted = [...players].sort((a, b) => (scores[b.id] || 0) - (scores[a.id] || 0) || String(a.name).localeCompare(String(b.name)));
    box.innerHTML = sorted.map(p => {
      const sc = scores[p.id] || 0;
      const color = lineColor(p.themeLine);
      const isMe = p.id === myId;
      const win = p.id === lastWinner;
      const typing = p.typing;
      return `<div class="vs-sb-item${win ? " winner" : ""}${isMe ? " me" : ""}">
        <span class="vs-sb-dot" style="background:${color}"></span>
        <span class="vs-sb-name">${escapeHtml(p.name)}</span>
        <span class="vs-sb-score">${sc}</span>
        ${typing ? `<span class="vs-sb-typing">입력중…</span>` : ""}
      </div>`;
    }).join("");
    box.classList.add("show");
  }

  /* ---------- 최종 순위 화면 ---------- */
  function showResult(data) {
    const list = $("#vs-result-list");
    const ranking = (data && data.ranking) || [];
    const myId = (data && data.myId) || Versus.myId();
    const medals = ["🥇", "🥈", "🥉"];
    list.innerHTML = ranking.map((r, i) => {
      const color = lineColor(r.themeLine);
      const rankIcon = medals[i] || `<span class="vs-rank-num">${i + 1}</span>`;
      const isMe = r.id === myId;
      return `<div class="vs-result-item${isMe ? " me" : ""}${i === 0 ? " first" : ""}">
        <span class="vs-result-rank">${rankIcon}</span>
        <span class="vs-sb-dot" style="background:${color}"></span>
        <span class="vs-result-name">${escapeHtml(r.name)}${isMe ? " (나)" : ""}</span>
        <span class="vs-result-score">${r.score}점</span>
      </div>`;
    }).join("");

    // 방장: 모두 대기실로 / 참가자: 나만 대기실로
    const againBtn = $("#vs-again-btn");
    const note = $("#vs-result-note");
    if (againBtn) {
      againBtn.style.display = "";
      againBtn.textContent = "대기실로 돌아가기";
    }
    if (note) {
      note.textContent = Versus.isHost()
        ? "‘대기실로 돌아가기’를 누르면 모두 함께 대기실로 이동해요."
        : "‘대기실로 돌아가기’를 누르면 나만 대기실로 돌아가요. 방장이 다시 시작할 수 있어요.";
    }
    showScreen("#vs-result-screen");
    document.body.classList.remove("at-end");
  }

  // 대기실로 복귀 (모두)
  function backToLobbyUI() {
    // 게임/엔딩 상태 정리하고 대기실 표시
    document.body.classList.remove("in-game", "at-end", "versus-mode");
    const sb = $("#vs-scoreboard"); if (sb) sb.classList.remove("show");
    enterLobby();
  }

  function enterLobby() {
    const R = Versus.Room;
    $("#vs-lobby-code").textContent = R.code;
    $("#vs-lobby-link").value = Versus.inviteLink(R.code);

    const host = Versus.isHost();
    $("#vs-lobby-role").textContent = host ? "방장" : "참가자";
    $("#vs-host-controls").style.display = host ? "" : "none";
    $("#vs-guest-note").style.display = host ? "none" : "";

    // 내 이름 표시
    $("#vs-my-name").textContent = R.myName;

    // 방장 설정 UI 준비
    wireSettingsOnce();
    syncRegionUI();

    // 실시간 참가자 목록 렌더
    renderPlayers(Versus.getPlayers());

    showScreen("#vs-lobby-screen");
  }

  async function doLeave() {
    try { await Versus.leaveRoom(); } catch (e) {}   // 정리 실패해도 홈 복귀는 무조건 진행
    // URL의 ?room 파라미터 제거
    if (location.search.includes("room=")) {
      try { history.replaceState(null, "", location.pathname); } catch (e) {}
    }
    closeVersus();
  }

  async function copyLink() {
    const box = $("#vs-lobby-link");
    try {
      await navigator.clipboard.writeText(box.value);
    } catch (e) {
      box.select(); document.execCommand("copy");
    }
    const btn = $("#vs-copy-link");
    const orig = btn.textContent;
    btn.textContent = "복사됨!";
    setTimeout(() => { btn.textContent = orig; }, 1500);
  }

  /* ---------- 초기화 ---------- */
  document.addEventListener("DOMContentLoaded", () => {
    $("#btn-versus")?.addEventListener("click", openEntry);
    $("#vs-create-btn")?.addEventListener("click", doCreate);
    $("#vs-join-btn")?.addEventListener("click", () => doJoin());

    // pagehide에서 직접 퇴장시키지 않는다. bfcache나 모바일 앱 전환에도 발생해
    // 실제로는 접속 중인 참가자가 계속 나갔다 들어오는 현상을 만들 수 있다.
    // bfcache에서 돌아온 경우에만 현재 Presence payload를 다시 게시한다.
    window.addEventListener("pageshow", event => {
      if (event.persisted) { try { Versus.retrack(); } catch (e) {} }
    });
    // 로그인 상태가 바뀌면(프로필 로딩 완료 등) 방 안에 있을 때 내 표시 정보 갱신
    Account.onChange && Account.onChange(() => { try { Versus.retrack(); } catch (e) {} });

    // 참가자 목록이 실시간으로 바뀌면 다시 그림
    Versus.onPlayersChange(renderPlayers);
    // 방장 권한이 바뀌면 역할/설정 영역 갱신
    Versus.onHostChange(refreshRole);
    // 게임 시작 신호 → 모두 같은 설정/문제로 게임 화면 진입(카운트다운)
    Versus.onGameStart((cfg) => {
      if (window.VersusGame && typeof window.VersusGame.start === "function") {
        window.VersusGame.start(cfg);
      }
    });
    // ★ 방장 상태 스냅샷 → 화면에 반영(자가치유). 점수판도 함께 갱신됨.
    Versus.onState((snap) => {
      if (window.VersusGame && typeof window.VersusGame.applyState === "function") {
        window.VersusGame.applyState(snap);
      }
    });
    // 점수 변동 시 상단 점수판 갱신
    window.onVersusScoreUpdate = renderScoreboard;
    // Presence(입력중/접속) 변하면 점수판도 갱신
    Versus.onPlayersChange(() => { if (window.VersusGame && VersusGame.isVersus()) renderScoreboard(); });
    // 게임 종료 → 최종 순위 화면
    window.onVersusGameEnd = (data) => showResult(data);
    // 방장이 대기실로 복귀 신호 → 모두 대기실로
    Versus.onBackToLobby(() => { backToLobbyUI(); });
    $("#vs-again-btn")?.addEventListener("click", async () => {
      if (Versus.isHost()) { await Versus.backToLobby(); }  // 방장: 모두 복귀
      else { backToLobbyUI(); }                              // 참가자: 나만 복귀
    });
    $("#vs-code-input")?.addEventListener("keydown", e => { if (e.key === "Enter") doJoin(); });
    // 코드 입력은 자동 대문자
    $("#vs-code-input")?.addEventListener("input", e => {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    });
    $("#vs-copy-link")?.addEventListener("click", copyLink);
    document.querySelectorAll(".vs-leave-btn").forEach(b => b.addEventListener("click", doLeave));
    $("#vs-entry-back")?.addEventListener("click", closeVersus);

    // URL에 ?room=CODE 가 있으면 자동 입장 시도 (Account 준비 후)
    const params = new URLSearchParams(location.search);
    const roomCode = params.get("room");
    if (roomCode) {
      ensureAccountReady().then(() => doJoin(roomCode));
    }
  });

  window.VersusUI = { openEntry, closeVersus };
})();
