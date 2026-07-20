/* ============================================================
   versus-ui.js — 대전 모드 화면 제어 (1단계)
   ------------------------------------------------------------
   - 홈의 "⚔️ 대전 모드" 버튼 → 대전 진입 화면(만들기 / 입장)
   - 방 생성/입장 성공 → 대기실(코드·초대링크 표시)
   - URL에 ?room=CODE 가 있으면 자동으로 입장 시도
   - 실시간 참가자 목록/게임 시작은 다음 단계에서 채운다.
   ============================================================ */

(() => {
  // $ / escapeHtml / lineColor 는 util.js(전역)에서 제공된다.
  // 게스트/미지정 노선 기본색은 회색(#9aa0a6) — lineColor 호출 시 fallback으로 전달.

  let publicRoomTimer = null;
  let publicRoomRequest = 0;
  let unreadChat = 0;
  let lastChatMessageId = null;

  function applyVersusTheme(playMode) {
    const reverse = playMode === "reverse";
    if (typeof setReverseModeVisuals === "function") setReverseModeVisuals(reverse);
    else document.body.classList.toggle("reverse-mode", reverse);
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
    const title = $("#vs-room-title");
    if (title && !title.value.trim()) {
      title.value = `${Versus.resolveMyName()}님의 대전방`.slice(0, 30);
      const initialTitle = title.value;
      ensureAccountReady().then(() => {
        if (title.value === initialTitle) title.value = `${Versus.resolveMyName()}님의 대전방`.slice(0, 30);
      });
    }
    const publicToggle = $("#vs-room-public");
    if (publicToggle) publicToggle.checked = true;
    showScreen("#vs-entry-screen");
    startPublicRoomBrowser();
  }

  function closeVersus() {
    stopPublicRoomBrowser();
    if (settingsSaveTimer) { clearTimeout(settingsSaveTimer); settingsSaveTimer = null; }
    closeChat();
    document.body.classList.remove("vs-room-connected");
    showScreen(null);                 // 대전 오버레이 숨김 + in-versus 제거
    document.body.classList.remove("in-versus", "versus-mode");
    if (typeof State !== "undefined") State.versus = false;
    // ★ 홈 화면 완전 복원: 게임/엔딩 상태 클래스 정리 + 홈 배경 지도 재구성.
    //   (게임 끝난 결과화면에서 나가도 빈 지도가 아니라 홈 메뉴가 뜨도록)
    if (typeof goHome === "function") {
      try { goHome(); } catch (e) {}
    } else {
      document.body.classList.remove("in-game", "at-end", "studying", "endless-mode", "reverse-mode");
      document.body.classList.add("at-home");
    }
  }

  // Account(로그인/프로필) 로딩이 끝날 때까지 잠깐 기다린다.
  // → 로그인 사용자가 잠깐 Guest로 표시되는 문제 방지.
  function ensureAccountReady(timeoutMs = 2500) {
    return new Promise((resolve) => {
      if (Account.isReady && Account.isReady()) return resolve();
      let done = false;
      let handler = null;
      // 완료(변경 감지/타임아웃) 시 리스너를 반드시 해제한다. 예전엔 open/create/join마다
      // onChange 구독을 남겨 리스너 배열이 무한히 커지고 매 account 변경마다 stale 클로저가 재실행됐다.
      const finish = () => {
        if (done) return;
        done = true;
        if (handler && Account.offChange) Account.offChange(handler);
        resolve();
      };
      if (Account.onChange) {
        handler = () => { if (Account.isReady && Account.isReady()) finish(); };
        Account.onChange(handler);
      }
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
    // 단일 실행 가드: Enter 키 핸들러는 disabled 속성을 무시하므로 더블 제출 시
    // room_create_v2가 두 번 실행돼 고아 방/epoch 경쟁이 생긴다. disabled로 재진입 차단.
    if (btn?.disabled) return;
    btn.disabled = true; btn.textContent = "방 만드는 중…";
    await ensureAccountReady();   // 닉네임/프로필 로딩 완료 후 진행
    const res = await Versus.createRoom({
      title: $("#vs-room-title")?.value,
      isPublic: $("#vs-room-public")?.checked !== false,
    });
    btn.disabled = false; btn.textContent = "방 만들기";
    if (!res.ok) { $("#vs-entry-error").textContent = res.message || "방 생성 실패"; return; }
    setRoomUrl(res.code);
    enterLobby();
  }

  /* ---------- 코드로 입장 ---------- */
  async function doJoin(codeOverride, fromUrl = false) {
    const code = codeOverride || $("#vs-code-input").value;
    const btn = $("#vs-join-btn");
    if (btn?.disabled) return;   // 단일 실행 가드(Enter 더블 제출 → 중복 joinRoom 방지)
    if (btn) { btn.disabled = true; btn.textContent = "입장 중…"; }
    await ensureAccountReady();   // 닉네임/프로필 로딩 완료 후 진행
    const res = await Versus.joinRoom(code);
    if (btn) { btn.disabled = false; btn.textContent = "입장하기"; }
    if (!res.ok) {
      const errEl = $("#vs-entry-error");
      if (errEl) errEl.textContent = res.message || "입장 실패";
      // URL 자동입장 실패 시: URL의 room 파라미터를 지우고 진입화면 표시
      if (fromUrl) { try { history.replaceState(null, "", location.pathname); } catch (e) {} showScreen("#vs-entry-screen"); startPublicRoomBrowser(); }
      return;
    }
    setRoomUrl(res.code);
    enterLobby();
  }

  function stopPublicRoomBrowser() {
    if (publicRoomTimer) { clearInterval(publicRoomTimer); publicRoomTimer = null; }
  }

  function startPublicRoomBrowser() {
    stopPublicRoomBrowser();
    refreshPublicRooms();
    publicRoomTimer = setInterval(refreshPublicRooms, 10000);
  }

  function roomModeLabel(room) {
    if (room.mode === "core") return "1~9호선";
    if (room.mode === "custom") return "커스텀";
    return "전체 노선";
  }

  function renderPublicRooms(rooms) {
    const box = $("#vs-public-rooms");
    if (!box) return;
    if (!rooms.length) {
      box.innerHTML = `<p class="muted">지금 참여 가능한 공개방이 없어요.<br>새 방의 첫 방장이 되어보세요!</p>`;
      return;
    }
    box.innerHTML = rooms.map(room => {
      const region = (typeof REGION_LABELS !== "undefined" && REGION_LABELS[room.region]) || room.region;
      return `<article class="vs-room-item">
        <div class="vs-room-main">
          <strong class="vs-room-title">${escapeHtml(room.room_title || "이름 없는 대전방")}</strong>
          <div class="vs-room-meta">
            <span>👑 ${escapeHtml(room.host_name)}</span>
            <span>📍 ${escapeHtml(region)}</span>
            <span>${escapeHtml(roomModeLabel(room))}</span>
            <span>${room.play_mode === "reverse" ? "🙃 거꾸로" : "⏱ 시간 도전"}</span>
            <span>⏱ ${Number(room.duration_sec) || 60}초</span>
            <span>👥 ${Math.max(1, Number(room.member_count) || 1)}명</span>
          </div>
        </div>
        <button class="vs-room-join" type="button" data-room-code="${escapeHtml(room.code)}">참여</button>
      </article>`;
    }).join("");
    box.querySelectorAll(".vs-room-join").forEach(button => {
      button.addEventListener("click", async () => {
        button.disabled = true; button.textContent = "입장 중";
        await doJoin(button.dataset.roomCode);
        if (button.isConnected) { button.disabled = false; button.textContent = "참여"; }
      });
    });
  }

  async function refreshPublicRooms() {
    const box = $("#vs-public-rooms");
    if (!box || !$("#vs-entry-screen")?.classList.contains("show")) return;
    const request = ++publicRoomRequest;
    const refresh = $("#vs-room-refresh");
    if (refresh) refresh.disabled = true;
    const result = await Versus.listPublicRooms(30);
    if (refresh) refresh.disabled = false;
    if (request !== publicRoomRequest) return;
    if (!result.ok) {
      box.innerHTML = `<p class="muted">공개방을 불러오지 못했어요.<br>${escapeHtml(result.message || "잠시 후 다시 시도해주세요.")}</p>`;
      return;
    }
    renderPublicRooms(result.rooms);
  }

  /* ---------- 대기실 ---------- */
  // 게스트/미지정 노선 기본색 (util.js lineColor의 fallback 인자로 전달)
  const GUEST_COLOR = "#9aa0a6";

  // 참가자 한 명을 닉네임 태그로
  function playerTag(pl) {
    const color = lineColor(pl.themeLine, GUEST_COLOR);
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
  let settingsSaveTimer = null;

  function queueSettingsSave() {
    if (!Versus.isHost() || !Versus.Room.code) return;
    if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
    settingsSaveTimer = setTimeout(async () => {
      settingsSaveTimer = null;
      const result = await Versus.updateSettings({
        region: vsSettings.region, mode: vsSettings.mode,
        customLines: vsSettings.customLines, duration: vsSettings.duration,
        playMode: vsSettings.playMode,
      });
      if (!result.ok) console.warn("[VersusUI] 방 설정 저장 실패", result.message || "unknown");
    }, 250);
  }

  function syncSettingsFromRoom() {
    const data = Versus.Room.data || {};
    const allowedDurations = [60, 120, 300];
    vsSettings.region = data.region || "seoul";
    vsSettings.mode = ["core", "all", "custom"].includes(data.mode) ? data.mode : "all";
    vsSettings.duration = allowedDurations.includes(Number(data.duration_sec)) ? Number(data.duration_sec) : 60;
    vsSettings.playMode = data.play_mode === "reverse" ? "reverse" : "timed";
    applyVersusTheme(vsSettings.playMode);
    vsSettings.customLines = String(data.custom_lines || "").split(",").filter(Boolean);
    document.querySelectorAll("#vs-set-region .vs-seg-btn").forEach(button =>
      button.classList.toggle("active", button.dataset.region === vsSettings.region));
    document.querySelectorAll("#vs-set-mode .vs-seg-btn").forEach(button =>
      button.classList.toggle("active", button.dataset.mode === vsSettings.mode));
    document.querySelectorAll("#vs-set-duration .vs-seg-btn").forEach(button =>
      button.classList.toggle("active", Number(button.dataset.dur) === vsSettings.duration));
    document.querySelectorAll("#vs-set-play-mode .vs-seg-btn").forEach(button =>
      button.classList.toggle("active", button.dataset.playMode === vsSettings.playMode));
  }

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
    const regionLines = linesForRegion(vsSettings.region);
    const hasCore = regionSupportsCore(vsSettings.region);
    const modeBox = $("#vs-set-mode");
    const coreBtn = modeBox && modeBox.querySelector('[data-mode="core"]');
    if (coreBtn) coreBtn.style.display = hasCore ? "" : "none";
    if (!hasCore && vsSettings.mode === "core") {
      vsSettings.mode = "all";
      modeBox.querySelectorAll(".vs-seg-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === "all"));
      queueSettingsSave();
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
    const lines = linesForRegion(vsSettings.region);
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
        queueSettingsSave();
      });
      box.appendChild(label);
    }
  }

  let settingsWired = false;
  function wireSettingsOnce() {
    if (settingsWired) return;
    settingsWired = true;
    wireSeg("#vs-set-region", (btn) => { vsSettings.region = btn.dataset.region; syncRegionUI(); queueSettingsSave(); });
    wireSeg("#vs-set-mode", (btn) => { vsSettings.mode = btn.dataset.mode; updateCustomVisibility(); queueSettingsSave(); });
    wireSeg("#vs-set-play-mode", (btn) => {
      vsSettings.playMode = btn.dataset.playMode === "reverse" ? "reverse" : "timed";
      applyVersusTheme(vsSettings.playMode);
      queueSettingsSave();
    });
    wireSeg("#vs-set-duration", (btn) => { vsSettings.duration = parseInt(btn.dataset.dur, 10) || 60; queueSettingsSave(); });
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
      playMode: vsSettings.playMode,
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
    if (host) { syncSettingsFromRoom(); syncRegionUI(); }
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
    const sorted = [...players].sort((a, b) => (Number(scores[b.id]) || 0) - (Number(scores[a.id]) || 0) || String(a.name).localeCompare(String(b.name)));
    box.innerHTML = sorted.map(p => {
      // 점수는 host가 쓰는 game_states.scores JSON에서 온다 → 숫자로 강제 변환해
      // innerHTML에 문자열(<img onerror=…>)이 주입되는 저장형 XSS를 차단한다.
      const sc = Number(scores[p.id]) || 0;
      const color = lineColor(p.themeLine, GUEST_COLOR);
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
      const color = lineColor(r.themeLine, GUEST_COLOR);
      const rankIcon = medals[i] || `<span class="vs-rank-num">${i + 1}</span>`;
      const isMe = r.id === myId;
      return `<div class="vs-result-item${isMe ? " me" : ""}${i === 0 ? " first" : ""}">
        <span class="vs-result-rank">${rankIcon}</span>
        <span class="vs-sb-dot" style="background:${color}"></span>
        <span class="vs-result-name">${escapeHtml(r.name)}${isMe ? " (나)" : ""}</span>
        <span class="vs-result-score">${Number(r.score) || 0}점</span>
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
    stopPublicRoomBrowser();
    document.body.classList.add("vs-room-connected");
    $("#vs-lobby-code").textContent = R.code;
    $("#vs-lobby-link").value = Versus.inviteLink(R.code);
    const roomTitle = R.data?.room_title || `${R.data?.host_name || R.myName}님의 대전방`;
    $("#vs-lobby-title").textContent = roomTitle;
    $("#vs-chat-room-name").textContent = roomTitle;
    const visibility = $("#vs-lobby-visibility");
    if (visibility) {
      const isPublic = R.data?.is_public !== false;
      visibility.textContent = isPublic ? "공개" : "비공개";
      visibility.classList.toggle("private", !isPublic);
    }

    const host = Versus.isHost();
    $("#vs-lobby-role").textContent = host ? "방장" : "참가자";
    $("#vs-host-controls").style.display = host ? "" : "none";
    $("#vs-guest-note").style.display = host ? "none" : "";

    // 내 이름 표시
    $("#vs-my-name").textContent = R.myName;

    // 방장 설정 UI 준비
    wireSettingsOnce();
    syncSettingsFromRoom();
    syncRegionUI();

    // 실시간 참가자 목록 렌더
    renderPlayers(Versus.getPlayers());
    renderChat(Versus.getMessages());

    showScreen("#vs-lobby-screen");
  }

  async function doLeave() {
    try { await Versus.leaveRoom(); } catch (e) {}   // 정리 실패해도 홈 복귀는 무조건 진행
    // URL의 ?room 파라미터 제거
    if (location.search.includes("room=")) {
      try { history.replaceState(null, "", location.pathname); } catch (e) {}
    }
    document.body.classList.remove("vs-room-connected");
    closeChat();
    lastChatMessageId = null;
    unreadChat = 0;            // 방을 나가면 안읽음 배지 초기화(다음 방에 이월 방지)
    updateUnread();
    closeVersus();
  }

  async function copyLobbyLink() {
    const box = $("#vs-lobby-link");
    if (!box) return;
    // 공용 util.copyToClipboard로 실제 성공 여부를 받아 UI에 정직하게 반영한다.
    // (예전엔 iOS 인앱에서 복사 실패해도 "복사됨!"을 띄워 초대 링크 공유가 조용히 실패했다.)
    const ok = await copyToClipboard(box.value);
    const btn = $("#vs-copy-link");
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = ok ? "복사됨!" : "복사 실패";
    setTimeout(() => { btn.textContent = orig; }, 1500);
  }

  /* ---------- 대전방 채팅 ---------- */
  function updateUnread() {
    const badge = $("#vs-chat-unread");
    if (!badge) return;
    badge.hidden = unreadChat <= 0;
    badge.textContent = unreadChat > 99 ? "99+" : String(unreadChat);
  }

  function openChat() {
    if (!Versus.Room.code) return;
    const panel = $("#vs-chat-panel");
    panel?.classList.add("open");
    panel?.setAttribute("aria-hidden", "false");
    $("#vs-chat-toggle")?.setAttribute("aria-expanded", "true");
    unreadChat = 0;
    updateUnread();
    renderChat(Versus.getMessages());
    setTimeout(() => $("#vs-chat-input")?.focus(), 0);
  }

  function closeChat() {
    const panel = $("#vs-chat-panel");
    panel?.classList.remove("open");
    panel?.setAttribute("aria-hidden", "true");
    $("#vs-chat-toggle")?.setAttribute("aria-expanded", "false");
  }

  function formatChatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

  function renderChat(messages) {
    const box = $("#vs-chat-messages");
    if (!box) return;
    const list = Array.isArray(messages) ? messages : [];
    const newest = list.length ? String(list[list.length - 1].id) : null;
    const prevSeen = lastChatMessageId;
    const panelOpen = $("#vs-chat-panel")?.classList.contains("open");
    // 폴링(5초)이 여러 메시지를 한꺼번에 가져오면 실제 새 메시지 수만큼 증가(util.js).
    if (!panelOpen) unreadChat += countNewMessages(list, lastChatMessageId);
    lastChatMessageId = newest;
    updateUnread();
    // 스크린리더: 전체 목록을 aria-live로 두면 새 메시지마다 대화 전체를 다시 읽는다.
    // 대신 최신 새 메시지 1건만 별도 polite 영역에 넣는다(첫 렌더/내 메시지는 제외).
    if (newest && prevSeen !== null && newest !== prevSeen) {
      const latest = list[list.length - 1];
      if (latest && latest.player_id !== Versus.myId()) {
        const sr = $("#vs-chat-sr");
        if (sr) sr.textContent = `${latest.player_name || "참가자"}: ${latest.body || ""}`;
      }
    }
    if (!list.length) {
      box.innerHTML = `<p class="muted">아직 메시지가 없어요.<br>먼저 인사해보세요!</p>`;
      return;
    }
    box.innerHTML = list.map(message => {
      const mine = message.player_id === Versus.myId();
      return `<div class="vs-chat-message${mine ? " mine" : ""}">
        <div class="vs-chat-message-head">
          <b>${escapeHtml(message.player_name || "참가자")}</b>
          <time>${escapeHtml(formatChatTime(message.created_at))}</time>
          ${mine ? "" : `<button class="vs-chat-report" type="button" data-message-id="${escapeHtml(message.id)}">신고</button>`}
        </div>
        <div class="vs-chat-bubble">${escapeHtml(message.body)}</div>
      </div>`;
    }).join("");
    box.querySelectorAll(".vs-chat-report").forEach(button => {
      button.addEventListener("click", () => reportMessage(button.dataset.messageId));
    });
    box.scrollTop = box.scrollHeight;
  }

  async function reportMessage(messageId) {
    if (!confirm("이 메시지를 부적절한 내용으로 신고할까요?\n허위 신고는 삼가주세요.")) return;
    const result = await Versus.reportChat(messageId, "부적절한 내용");
    const msg = $("#vs-chat-msg");
    if (msg) {
      msg.textContent = result.ok ? "신고가 접수됐어요." : (result.message || "신고하지 못했어요.");
      msg.className = `field-msg ${result.ok ? "ok" : "no"}`;
    }
  }

  async function submitChat(event) {
    event?.preventDefault();
    const input = $("#vs-chat-input");
    const button = $("#vs-chat-send");
    const msg = $("#vs-chat-msg");
    if (!input || !button) return;
    button.disabled = true;
    const result = await Versus.sendChat(input.value);
    button.disabled = false;
    if (result.ok) {
      input.value = "";
      if (msg) { msg.textContent = ""; msg.className = "field-msg"; }
      input.focus();
    } else if (msg) {
      msg.textContent = result.message || "메시지를 보내지 못했어요.";
      msg.className = "field-msg no";
    }
  }

  /* ---------- 초기화 ---------- */
  document.addEventListener("DOMContentLoaded", () => {
    $("#btn-versus")?.addEventListener("click", openEntry);
    $("#vs-create-btn")?.addEventListener("click", doCreate);
    $("#vs-join-btn")?.addEventListener("click", () => doJoin());
    $("#vs-room-refresh")?.addEventListener("click", refreshPublicRooms);
    $("#vs-room-title")?.addEventListener("keydown", event => { if (event.key === "Enter") doCreate(); });

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
    Versus.onChatChange(renderChat);
    // 방장 권한이 바뀌면 역할/설정 영역 갱신
    Versus.onHostChange(refreshRole);
    Versus.onRoomChange((room) => {
      if (!document.body.classList.contains("vs-room-connected")) return;
      applyVersusTheme(room?.play_mode);
      if (!Versus.isHost()) syncSettingsFromRoom();
    });
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
    $("#vs-copy-link")?.addEventListener("click", copyLobbyLink);
    $("#vs-chat-toggle")?.addEventListener("click", openChat);
    $("#vs-chat-close")?.addEventListener("click", closeChat);
    $("#vs-chat-form")?.addEventListener("submit", submitChat);
    document.querySelectorAll(".vs-leave-btn").forEach(b => b.addEventListener("click", doLeave));
    $("#vs-entry-back")?.addEventListener("click", closeVersus);

    // URL에 ?room=CODE 가 있으면 자동 입장 시도 (Account 준비 후)
    const params = new URLSearchParams(location.search);
    const roomCode = params.get("room");
    if (roomCode) {
      ensureAccountReady().then(() => doJoin(roomCode, true));
    }
  });

  window.VersusUI = { openEntry, closeVersus };
})();
