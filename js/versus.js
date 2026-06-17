/* ============================================================
   versus.js — 대전 모드
   ------------------------------------------------------------
   설계 핵심 (authoritative single-source + 단일 writer 승계):
   1) "방장이 누구인가"의 단일 진실은 오직 rooms.host_id 다.
      presence는 "누가 접속해 있나 + 이름/색"만 담당하고,
      방장 판단에는 관여하지 않는다 → 진실이 둘로 갈리지 않음(분열 방지).
   2) host_id 변경은 Postgres Changes(Realtime)로 모두에게 실시간 전파.
   3) 위임 = host_id 를 그 사람으로 UPDATE.
   4) 방장이 presence에서 사라지면 곧장 넘기지 않고 "유예 시간"을 둔다.
      유예(약 10초)가 지나도 방장이 안 돌아오면, 남은 접속자 중
      '가장 오래 접속한 단 한 명'만 자신을 새 host_id로 기록(단일 writer).
      → 새로고침(보통 1~3초)은 유예가 흡수 → 방장 유지.
        진짜 이탈만 승계 발생 → 경쟁/분열 없음.
   5) presence stale 방지: Account 준비 후에만 track, 탭 복귀/재연결 시
      fresh 데이터로 다시 track.
   ============================================================ */

const Versus = (() => {
  const HOST_GRACE_MS = 10000;   // 방장이 사라진 뒤 승계까지 기다리는 유예

  const Room = {
    code: null,
    myName: null,
    data: null,             // rooms 행 캐시
    channel: null,          // presence + broadcast
    dbChannel: null,        // rooms 행 Postgres Changes
    gsChannel: null,        // game_states 행 Postgres Changes(게임 상태 푸시)
    players: [],            // [{id,name,themeLine,joinedAt}]
    hostId: null,           // 단일 진실: 현재 방장(rooms.host_id)
  };

  const playerListeners = [];
  const hostListeners = [];
  const backToLobbyListeners = [];
  function onPlayersChange(fn) { playerListeners.push(fn); }
  function onHostChange(fn) { hostListeners.push(fn); }
  function onBackToLobby(fn) { backToLobbyListeners.push(fn); }
  function notifyPlayers() { playerListeners.forEach(fn => { try { fn(Room.players); } catch (e) {} }); }
  let lastNotifiedHost = undefined;
  function notifyHostIfChanged() {
    if (Room.hostId !== lastNotifiedHost) {
      lastNotifiedHost = Room.hostId;
      hostListeners.forEach(fn => { try { fn(isHost()); } catch (e) {} });
    }
  }

  function client() { return Account.getClient ? Account.getClient() : null; }

  // 내 고유 id: 로그인 사용자는 user id, 게스트는 localStorage에 영구 보관
  function myId() {
    const uid = Account.getUserId && Account.getUserId();
    if (uid) return uid;
    let id = localStorage.getItem("vsGuestId");
    if (!id) { id = "g_" + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem("vsGuestId", id); }
    return id;
  }

  // 이번 접속의 합류 시각(승계 시 '가장 오래 접속한 사람' 판정용 tiebreaker)
  let mySessionJoinedAt = Date.now();
  function refreshJoinTime() { mySessionJoinedAt = Date.now(); }

  /* ---------- 방장 판단 ---------- */
  // 방장은 오직 rooms.host_id. presence와 무관.
  function getHostId() { return Room.hostId; }
  function isHost() { return !!Room.hostId && Room.hostId === myId(); }

  /* ---------- 이름/코드 유틸 ---------- */
  const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  function makeCode(len = 6) { let s = ""; for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; return s; }

  function guestName() {
    let n = localStorage.getItem("guestName");
    if (!n) { n = "Guest #" + Math.floor(1000 + Math.random() * 9000); localStorage.setItem("guestName", n); }
    return n;
  }
  function resolveMyName() {
    const loggedIn = Account.isLoggedIn && Account.isLoggedIn();
    const p = Account.getProfile && Account.getProfile();
    if (loggedIn && p && p.nickname) return p.nickname;
    return guestName();
  }
  function myThemeLine() {
    const loggedIn = Account.isLoggedIn && Account.isLoggedIn();
    const p = Account.getProfile && Account.getProfile();
    if (loggedIn && p && p.theme_line) return p.theme_line;
    return null;
  }
  function inviteLink(code) { return location.href.split("#")[0].split("?")[0] + "?room=" + code; }

  /* ---------- presence → 참가자 배열 ---------- */
  function buildPlayers(state) {
    const list = [];
    const seen = new Set();
    for (const key in state) {
      const metas = state[key];
      if (!Array.isArray(metas) || metas.length === 0) continue;
      // 같은 key에 메타 여러 개면 가장 최근(joinedAt 최대) 것만 → stale 방지
      let m = metas[0];
      for (const cand of metas) { if ((cand.joinedAt || 0) > (m.joinedAt || 0)) m = cand; }
      if (!m || !m.id || !m.name) continue;
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      list.push(m);
    }
    // 방장(host_id) 먼저, 그다음 joinedAt 순
    list.sort((a, b) => {
      const ha = a.id === Room.hostId ? 1 : 0, hb = b.id === Room.hostId ? 1 : 0;
      return (hb - ha) || (a.joinedAt - b.joinedAt) || String(a.name).localeCompare(String(b.name));
    });
    return list;
  }
  let myTyping = false;
  function myMeta() { return { id: myId(), name: Room.myName, themeLine: myThemeLine(), joinedAt: mySessionJoinedAt, typing: myTyping }; }
  function hostPresent() { return !!Room.hostId && Room.players.some(p => p.id === Room.hostId); }

  // 내 "입력중" 상태를 presence로 전파 (디바운스는 호출측에서)
  function setTyping(on) {
    on = !!on;
    if (on === myTyping) return;
    myTyping = on;
    if (Room.channel) { try { Room.channel.track(myMeta()); } catch (e) {} }
  }

  // presence 동기화 시
  function handleSync() {
    if (!Room.channel) return;
    Room.players = buildPlayers(Room.channel.presenceState());
    notifyPlayers();
    scheduleHostCheck();   // 방장이 사라졌는지 유예 후 점검
  }

  /* ---------- 방장 승계 워치독 ---------- */
  let hostCheckTimer = null;
  function scheduleHostCheck() {
    // 방장이 접속 중이면 예약 취소
    if (hostPresent()) {
      if (hostCheckTimer) { clearTimeout(hostCheckTimer); hostCheckTimer = null; }
      return;
    }
    // 이미 예약돼 있으면 그대로 둠(중복 방지)
    if (hostCheckTimer) return;
    hostCheckTimer = setTimeout(async () => {
      hostCheckTimer = null;
      await maybeClaimHost();
    }, HOST_GRACE_MS);
  }

  // 유예가 지난 시점에 방장이 여전히 없으면, '가장 오래 접속한 단 한 명'만 승계 기록.
  async function maybeClaimHost() {
    if (hostPresent()) return;                 // 그새 방장이 돌아옴
    const players = Room.players || [];
    if (players.length === 0) return;
    // 가장 오래 접속한 사람(=joinedAt 최소, 동률 id순)
    const sorted = [...players].sort((a, b) =>
      (a.joinedAt - b.joinedAt) || String(a.id).localeCompare(String(b.id)));
    const heir = sorted[0];
    if (!heir || heir.id !== myId()) return;   // 나는 후계자가 아님 → 아무것도 안 함(단일 writer)
    // 내가 후계자 → DB에 새 방장으로 기록(모두에게 Postgres Changes로 전파됨)
    const c = client();
    if (c && Room.code) {
      try { await c.from("rooms").update({ host_id: myId(), host_name: Room.myName }).eq("code", Room.code); } catch (e) {}
    }
    applyHost(myId(), Room.myName);            // 내 화면 즉시 반영
    // 보조: 브로드캐스트로도 빠르게 알림
    if (Room.channel) { try { await Room.channel.send({ type: "broadcast", event: "host_set", payload: { hostId: myId(), hostName: Room.myName } }); } catch (e) {} }
  }

  // 방장 정보 적용(공통). ※ 게임 진행은 DB가 하므로 방장이 바뀌어도 게임은 안 멈춘다.
  //    방장은 이제 '시작/대기실로 버튼 권한'과 왕관 표시 용도만.
  function applyHost(hostId, hostName) {
    Room.hostId = hostId || null;
    if (Room.data) { Room.data.host_id = Room.hostId; if (hostName !== undefined) Room.data.host_name = hostName; }
    notifyHostIfChanged();
    notifyPlayers();   // 왕관 위치 갱신
  }

  /* ---------- Realtime 연결 ---------- */
  async function connectChannel() {
    const c = client();
    if (!c || !Room.code) return false;
    await disconnectChannel(true);

    refreshJoinTime();

    // broadcast self:true → 내가 보낸 host_set도 동일 경로로 처리(일관성)
    const channel = c.channel("room:" + Room.code, {
      config: { presence: { key: myId() }, broadcast: { self: true } },
    });
    channel.on("presence", { event: "sync" }, handleSync);
    // 승계/위임 즉시 반영 — 이게 화면 갱신의 주 경로(브로드캐스트는 빠르고 안정적)
    channel.on("broadcast", { event: "host_set" }, ({ payload }) => {
      if (payload && payload.hostId) applyHost(payload.hostId, payload.hostName);
    });
    // 새로 들어온 사람이 현재 방장을 물어보면, 방장(또는 아는 사람)이 알려줌
    channel.on("broadcast", { event: "host_who" }, () => {
      if (Room.hostId && Room.channel) {
        try { Room.channel.send({ type: "broadcast", event: "host_set", payload: { hostId: Room.hostId, hostName: Room.data && Room.data.host_name } }); } catch (e) {}
      }
    });
    // ★ 게임 상태 저지연 전파: 전이를 일으킨 클라가 그 결과를 즉시 브로드캐스트 → 모두 한 홉에 반영.
    //    DB(game_states)는 여전히 단일 진실/심판이고, Postgres Changes·vs_sync는 안전망으로 유지.
    //    같은 rev는 중복제거되므로 브로드캐스트/Changes/RPC응답이 겹쳐도 충돌 없음.
    channel.on("broadcast", { event: "vs_state" }, ({ payload }) => {
      if (payload && payload.snap) applyState(payload.snap);
    });

    Room.channel = channel;
    await new Promise((resolve) => {
      channel.subscribe(async (status) => {
        if (status === "SUBSCRIBED") { await channel.track(myMeta()); resolve(true); }
      });
      setTimeout(() => resolve(false), 5000);
    });

    // rooms 행 변경 실시간 감지 → host_id/상태 동기화 (Realtime 켜져 있으면 동작)
    const dbCh = c.channel("roomdb:" + Room.code);
    dbCh.on("postgres_changes",
      { event: "*", schema: "public", table: "rooms", filter: "code=eq." + Room.code },
      (payload) => {
        if (payload.eventType === "DELETE") return;
        const row = payload.new || {};
        if (Room.data) Room.data = Object.assign({}, Room.data, row);
        if (row.host_id !== undefined) applyHost(row.host_id, row.host_name);
      });
    Room.dbChannel = dbCh;
    await new Promise((resolve) => { dbCh.subscribe(() => resolve(true)); setTimeout(() => resolve(false), 5000); });

    // ★ 게임 상태(game_states) 실시간 구독 → 변경되는 즉시 화면 반영(자가치유의 주 경로)
    const gsCh = c.channel("gs:" + Room.code);
    gsCh.on("postgres_changes",
      { event: "*", schema: "public", table: "game_states", filter: "room_code=eq." + Room.code },
      (payload) => {
        if (payload.eventType === "DELETE") return;
        if (payload.new) applyState(snapFromRow(payload.new));
      });
    Room.gsChannel = gsCh;
    await new Promise((resolve) => { gsCh.subscribe(() => resolve(true)); setTimeout(() => resolve(false), 5000); });

    // 안전망: 주기적으로 DB의 host_id를 다시 읽어 화면을 자가 치유.
    // (Postgres Changes가 혹시 안 켜져 있어도 몇 초 안에 방장 표시가 맞춰짐)
    startReconciler();

    // 입장 즉시 현재 게임 상태 따라잡기 + 시계/동기화 와처 가동(폴링 안전망 포함)
    syncNow();
    ensureWatcher();

    return true;
  }

  // 주기적 DB 재동기화 (3초마다 host_id 확인)
  let reconcileTimer = null;
  function startReconciler() {
    stopReconciler();
    reconcileTimer = setInterval(async () => {
      const c = client();
      if (!c || !Room.code) return;
      try {
        const { data } = await c.from("rooms").select("host_id, host_name, status").eq("code", Room.code).maybeSingle();
        if (data && data.host_id && data.host_id !== Room.hostId) {
          applyHost(data.host_id, data.host_name);   // 화면 자가 치유
        }
        if (data && data.status && Room.data) Room.data.status = data.status;
      } catch (e) {}
    }, 3000);
  }
  function stopReconciler() { if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; } }

  async function retrack() {
    if (!Room.channel) return;
    Room.myName = resolveMyName();
    try { await Room.channel.track(myMeta()); } catch (e) {}
  }

  async function disconnectChannel(keepList) {
    const c = client();
    if (hostCheckTimer) { clearTimeout(hostCheckTimer); hostCheckTimer = null; }
    stopReconciler();
    stopWatcher();
    // ★ 채널 해제를 '기다리지 않는다'. 참조를 즉시 끊고 실제 해제는 백그라운드로.
    //   (untrack/removeChannel이 느리거나 멈춰도 나가기/재접속이 막히지 않게)
    const ch = Room.channel, dbch = Room.dbChannel, gsch = Room.gsChannel;
    Room.channel = null; Room.dbChannel = null; Room.gsChannel = null;
    if (c) {
      try { if (ch) { ch.untrack(); c.removeChannel(ch); } } catch (e) {}
      try { if (dbch) c.removeChannel(dbch); } catch (e) {}
      try { if (gsch) c.removeChannel(gsch); } catch (e) {}
    }
    if (!keepList) { Room.players = []; lastNotifiedHost = undefined; }
  }

  /* ---------- 방 생성 ---------- */
  async function createRoom() {
    const c = client();
    if (!c) return { ok: false, message: "서버 연결이 필요해요. 잠시 후 다시 시도해주세요." };
    Room.myName = resolveMyName();
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = makeCode(6);
      const row = {
        code, host_id: myId(), host_name: Room.myName,
        region: (typeof State !== "undefined" && State.region) ? State.region : "seoul",
        mode: "all", duration_sec: 90, status: "waiting",
      };
      const { error } = await c.from("rooms").insert(row);
      if (!error) {
        Room.code = code; Room.data = row; Room.hostId = myId();
        await connectChannel();
        notifyHostIfChanged();
        return { ok: true, code };
      }
      if (error.code !== "23505") { console.warn("[Versus] 방 생성 실패", error.message); return { ok: false, message: error.message }; }
    }
    return { ok: false, message: "방 코드 생성에 실패했어요. 다시 시도해주세요." };
  }

  /* ---------- 방 입장 (새로고침 재접속도 이 경로) ---------- */
  async function joinRoom(code) {
    const c = client();
    if (!c) return { ok: false, message: "서버 연결이 필요해요." };
    code = (code || "").trim().toUpperCase();
    if (code.length < 4) return { ok: false, message: "코드를 정확히 입력해주세요." };

    const { data, error } = await c.from("rooms").select("*").eq("code", code).maybeSingle();
    if (error) { console.warn("[Versus] 입장 조회 실패", error.message); return { ok: false, message: error.message }; }
    if (!data) return { ok: false, message: "그런 방이 없어요. 코드를 다시 확인해주세요." };
    if (data.status === "ended") return { ok: false, message: "이미 끝난 방이에요." };

    Room.code = code;
    Room.myName = resolveMyName();
    Room.data = data;
    Room.hostId = data.host_id || null;   // DB가 곧 진실
    await connectChannel();
    notifyHostIfChanged();
    return { ok: true, code };
  }

  /* ---------- 게임 설정 / 시작 ---------- */
  // 방장이 대기실에서 설정을 바꾸면 DB에 저장(다음 단계에서 대기실 표시에 활용 가능)
  async function updateSettings(s) {
    if (!Room.code || !isHost()) return { ok: false };
    const patch = {};
    if (s.region !== undefined) patch.region = s.region;
    if (s.mode !== undefined) patch.mode = s.mode;
    if (s.customLines !== undefined) patch.custom_lines = (s.customLines || []).join(",");
    if (s.duration !== undefined) patch.duration_sec = s.duration;
    if (s.playMode !== undefined) patch.play_mode = s.playMode;
    Room.data = Object.assign({}, Room.data, patch);
    const c = client();
    if (c) { try { await c.from("rooms").update(patch).eq("code", Room.code); } catch (e) {} }
    return { ok: true };
  }

  /* ============================================================
     서버(DB) 권위 모델  ★ 핵심 변경
     ------------------------------------------------------------
     실제 실시간 경쟁 게임(Kahoot/Jackbox/skribbl 등)의 표준:
     • 게임의 단일 진실(점수·현재문제·타이머)은 '서버'가 소유한다.
       여기선 Supabase의 Postgres(game_states 테이블)가 그 서버 역할.
     • 정답 선착순 판정은 DB의 원자적 UPDATE(vs_claim)가 결정한다.
       → 어느 브라우저도 심판이 아니다(=방장 탭이 멈춰도 게임 안 멈춤).
     • 시계 진행(다음 문제)은 아무 참가자나 vs_tick을 깨워도 DB가 '정확히 한 번'만 진행.
     • 모든 클라이언트는 game_states 변경(Realtime Postgres Changes)을 받아 '그리기만' 한다.
     • 끊기거나 늦게 들어와도 현재 행을 1번 읽으면(vs_sync) 즉시 따라잡는다 → 자가치유.
     ============================================================ */
  const gameStartListeners = [];
  const stateListeners = [];
  const VS_Q_SECONDS = 10;   // (표시는 서버가 준 절대시각 기준; 이 값은 보조)
  function onGameStart(fn) { gameStartListeners.push(fn); }
  function onState(fn) { stateListeners.push(fn); }

  // DB 행 → 게임이 쓰는 스냅샷(기존 game.js가 그대로 먹는 모양). 시각은 epoch ms로 변환.
  function snapFromRow(row) {
    // 빈/유령 행 방어: 진짜 행은 phase가 항상 있다(NOT NULL DEFAULT). phase 없으면 '상태 없음'으로 취급.
    if (!row || !row.phase) return null;
    const ms = v => (v ? new Date(v).getTime() : 0);
    return {
      rev: row.rev,
      phase: row.phase,
      index: row.question_index,
      order: row.q_order || [],
      region: row.region,
      lineIds: row.line_ids || [],
      duration: row.duration_sec,
      playAt: ms(row.play_at),
      qEndsAt: ms(row.q_ends_at),
      gameEndsAt: ms(row.game_ends_at),
      revealUntil: ms(row.reveal_until),
      winnerId: row.winner_id || null,
      winnerName: row.winner_name || null,
      scores: row.scores || {},
      names: row.names || {},
      hostId: Room.hostId,
      ts: ms(row.updated_at),
    };
  }

  // 모든 상태는 이 한 곳을 통과한다(푸시/폴링/RPC응답 공통). rev로 순서 보장+중복 방지.
  let lastRev = -1;
  let lastSnapshot = null;
  let inGame = false;        // 현재 게임 화면에 들어와 있나(시작 1회 감지용)
  let startedSig = null;     // 이번 게임의 식별자(playAt) — onGameStart 1회만 쏘기 위함
  const KNOWN_PHASES = ["lobby", "countdown", "playing", "reveal", "ended"];
  function applyState(snap) {
    if (!snap) return;
    // ★ 빈/이상 상태 방어: 알 수 없는 phase면 게임 화면에 진입하지 않는다(방 만들자마자 가짜 시작 차단).
    if (KNOWN_PHASES.indexOf(snap.phase) === -1) { ensureWatcher(); return; }
    if (typeof snap.rev === "number") {
      if (snap.rev < lastRev) return;                     // 더 오래된 상태면 무시
      if (snap.rev === lastRev && lastRev !== -1) return; // 같은 상태 중복이면 무시
      lastRev = snap.rev;
    }
    lastSnapshot = snap;

    // 대기실 복귀
    if (snap.phase === "lobby") {
      if (inGame) {
        inGame = false; startedSig = null;
        backToLobbyListeners.forEach(fn => { try { fn(); } catch (e) {} });
      }
      ensureWatcher();
      return;
    }

    // 새 게임 시작 감지 → 모두 같은 설정/문제로 게임 화면 진입(카운트다운). 1회만.
    // ★ '진짜' 시작일 때만: 시작시각(playAt)과 문제목록(order)이 있어야 한다.
    const hasGame = snap.playAt > 0 && Array.isArray(snap.order) && snap.order.length > 0;
    if (hasGame) {
      const sig = snap.playAt + ":" + snap.order.length;
      if (!inGame || startedSig !== sig) {
        inGame = true; startedSig = sig;
        // ★ 이전 게임에서 남았을 수 있는 in-flight 플래그 정리 → 두 번째 게임 시계/종료가 막히지 않게
        tickInFlight = false; endInFlight = false; lastTickAt = 0;
        if (Room.data) Room.data.status = "playing";
        registerSelf();   // 내 이름/색을 DB names에 등록(나가도 순위에 남게)
        const cfg = {
          region: snap.region, mode: "all", lineIds: snap.lineIds,
          duration: snap.duration, order: snap.order, playAt: snap.playAt,
        };
        gameStartListeners.forEach(fn => { try { fn(cfg); } catch (e) {} });
      }
    } else if (!inGame) {
      // 아직 시작 정보가 없는 상태면 그리지 않고 대기(빈 행 방어).
      ensureWatcher();
      return;
    }

    // 화면 반영(게임 진행/공개/종료 전부 game.js의 applyVersusState가 처리)
    stateListeners.forEach(fn => { try { fn(snap); } catch (e) {} });

    ensureWatcher();
  }

  // 내 이름/색 등록(게임당 1회). presence가 끊겨도 최종 순위에 이름이 남도록.
  function registerSelf() {
    const c = client();
    if (!c || !Room.code) return;
    try { c.rpc("vs_join", { p_room: Room.code, p_player_id: myId(), p_name: Room.myName, p_theme: myThemeLine() }); } catch (e) {}
  }

  // ★ 무조건 종료: 메인 타이머가 0이 되면 클라가 직접 호출. 서버 시계 판단을 기다리지 않는다.
  //   (reveal 중 종료 시 멈추던 버그 해결) 멱등 — 여러 번/여러 명이 불러도 안전.
  let endInFlight = false;
  async function forceEnd() {
    if (endInFlight) return;
    if (lastSnapshot && lastSnapshot.phase === "ended") return;   // 이미 끝났으면 스킵
    endInFlight = true;
    try {
      const c = client();
      if (c && Room.code) {
        const { data, error } = await c.rpc("vs_end", { p_room: Room.code });
        if (!error && data) { const ns = snapFromRow(data); applyState(ns); pushState(ns); }
      }
    } catch (e) {}
    endInFlight = false;   // 실패 시 다음 틱에서 재시도(끝날 때까지)
  }
  // ★ 저지연 전파: RPC로 새 상태를 받은 클라가 그걸 즉시 브로드캐스트(더 새로운 rev만).
  //    모두가 한 홉에 같은 상태를 받는다. (DB는 진실, 이건 가속 레이어)
  let lastPushedRev = -1;
  function pushState(snap) {
    if (!snap || typeof snap.rev !== "number") return;
    if (snap.rev <= lastPushedRev) return;   // 이미 전파했거나 더 오래된 상태면 스킵(스팸 방지)
    lastPushedRev = snap.rev;
    if (Room.channel) {
      try { Room.channel.send({ type: "broadcast", event: "vs_state", payload: { snap } }); } catch (e) {}
    }
  }

  /* ---------- 시계/동기화 와처 ----------
     • tick: 마감시각이 지났으면 서버에 진행을 '부탁'(멱등). 평소엔 로컬 no-op.
     • sync: 안전망. Postgres Changes가 꺼져 있어도 주기적으로 현재 행을 읽어 따라잡음.
     둘 다 어느 한 명에게 의존하지 않는다 → 단일 실패점 없음. */
  let tickTimer = null, syncTimer = null;
  function ensureWatcher() {
    if (!Room.code) { stopWatcher(); return; }
    if (!tickTimer) tickTimer = setInterval(tickLoop, 250);
    if (!syncTimer) syncTimer = setInterval(syncNow, 1500);
  }
  function stopWatcher() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  }

  let tickInFlight = false, lastTickAt = 0;
  async function tickLoop() {
    const s = lastSnapshot;
    if (!s || !Room.code) return;
    if (s.phase === "ended" || s.phase === "lobby") return;   // 진행할 게 없음
    const now = Date.now();
    // ★ 메인 타이머 끝 → 무조건 즉시 종료. 서버 시계 판단/공개 단계와 무관하게 끝낸다.
    if (s.gameEndsAt && now >= s.gameEndsAt) { forceEnd(); return; }
    let due = false;
    if (s.phase === "countdown") due = now >= s.playAt;
    else if (s.phase === "playing") due = now >= s.qEndsAt;
    else if (s.phase === "reveal") due = now >= s.revealUntil;
    if (!due) return;
    if (tickInFlight || (now - lastTickAt) < 120) return;     // 과도한 호출 방지
    tickInFlight = true; lastTickAt = now;
    try {
      const c = client();
      if (c) { const { data, error } = await c.rpc("vs_tick", { p_room: Room.code }); if (!error && data) { const ns = snapFromRow(data); applyState(ns); pushState(ns); } }
    } catch (e) {}
    tickInFlight = false;
  }

  let syncInFlight = false;
  async function syncNow() {
    if (syncInFlight || !Room.code) return;
    syncInFlight = true;
    try {
      const c = client();
      if (c) { const { data, error } = await c.rpc("vs_sync", { p_room: Room.code }); if (!error && data) applyState(snapFromRow(data)); }
    } catch (e) {}
    syncInFlight = false;
  }

  /* ---------- 방장: 게임 시작 (서버에 상태 생성) ---------- */
  async function startGame(settings) {
    if (!Room.code || !isHost()) return { ok: false, message: "방장만 시작할 수 있어요." };
    const region = settings.region || (Room.data && Room.data.region) || "seoul";
    const mode = settings.mode || "all";
    const customLines = settings.customLines || [];
    const duration = settings.duration || 60;

    const lineIds = window.VersusGame.resolveLineIds(region, mode, customLines);
    if (!lineIds || lineIds.length === 0) return { ok: false, message: "노선을 선택해주세요." };
    const order = window.VersusGame.buildOrder(region, lineIds);

    const c = client();
    if (!c) return { ok: false, message: "서버 연결이 필요해요. 잠시 후 다시 시도해주세요." };

    const names = {}; names[myId()] = { name: Room.myName, themeLine: myThemeLine() };
    try {
      const { data, error } = await c.rpc("vs_start", {
        p_room: Room.code, p_region: region, p_line_ids: lineIds,
        p_order: order, p_duration: duration, p_names: names,
      });
      if (error) { console.warn("[Versus] 게임 시작 실패", error.message); return { ok: false, message: error.message }; }
      try { await c.from("rooms").update({ status: "playing" }).eq("code", Room.code); } catch (e) {}
      if (data) { const ns = snapFromRow(data); applyState(ns); pushState(ns); }   // 내 화면 즉시 + 모두에게 즉시 전파
      ensureWatcher();
      return { ok: true };
    } catch (e) {
      console.warn("[Versus] 게임 시작 예외", e);
      return { ok: false, message: "시작 중 오류가 났어요. 다시 시도해주세요." };
    }
  }

  /* ---------- 참가자: 정답 제출 (서버가 선착순 판정) ---------- */
  // game.js가 정답 맞춤을 확인한 뒤 호출. 진행/점수는 서버가 돌려준 상태가 결정.
  async function sendAnswer(index) {
    const c = client();
    if (!c || !Room.code) return;
    try {
      const { data, error } = await c.rpc("vs_claim", {
        p_room: Room.code, p_index: index,
        p_player_id: myId(), p_player_name: Room.myName,
      });
      if (!error && data) { const ns = snapFromRow(data); applyState(ns); pushState(ns); }   // 이겼든 졌든 최신 상태 즉시 반영 + 전파
    } catch (e) {}
  }

  /* ---------- 방장: 결과 화면에서 "대기실로" → 모두 대기실로 ---------- */
  async function backToLobby() {
    if (!isHost()) return { ok: false };
    const c = client();
    if (c && Room.code) {
      try { await c.from("rooms").update({ status: "waiting" }).eq("code", Room.code); } catch (e) {}
      try { const { data } = await c.rpc("vs_lobby", { p_room: Room.code }); if (data) { const ns = snapFromRow(data); applyState(ns); pushState(ns); } } catch (e) {}
    }
    if (inGame) { inGame = false; startedSig = null; }
    backToLobbyListeners.forEach(fn => { try { fn(); } catch (e) {} });
    return { ok: true };
  }

  /* ---------- 수동 위임 ---------- */
  async function transferHost(newHostId) {
    if (!Room.code || !isHost()) return { ok: false };
    const target = Room.players.find(p => p.id === newHostId);
    if (!target) return { ok: false };
    const c = client();
    if (c) { try { await c.from("rooms").update({ host_id: newHostId, host_name: target.name }).eq("code", Room.code); } catch (e) {} }
    applyHost(newHostId, target.name);   // 내 화면 즉시
    if (Room.channel) { try { await Room.channel.send({ type: "broadcast", event: "host_set", payload: { hostId: newHostId, hostName: target.name } }); } catch (e) {} }
    return { ok: true };
  }

  /* ---------- 방 나가기 (버튼 전용) ---------- */
  async function leaveRoom() {
    const c = client();
    const amHost = isHost();
    const others = (Room.players || []).filter(p => p.id !== myId());

    if (c && Room.code && amHost && others.length > 0) {
      // 방장이 직접 나감 → 가장 오래 접속한 남은 사람에게 즉시 위임
      const sorted = [...others].sort((a, b) => (a.joinedAt - b.joinedAt) || String(a.id).localeCompare(String(b.id)));
      const heir = sorted[0];
      try { await c.from("rooms").update({ host_id: heir.id, host_name: heir.name }).eq("code", Room.code); } catch (e) {}
      if (Room.channel) { try { await Room.channel.send({ type: "broadcast", event: "host_set", payload: { hostId: heir.id, hostName: heir.name } }); } catch (e) {} }
      await new Promise(r => setTimeout(r, 200));
      await disconnectChannel();
    } else if (c && Room.code && others.length === 0) {
      // 아무도 안 남으면 방 삭제
      await disconnectChannel();
      try { await c.from("rooms").delete().eq("code", Room.code); } catch (e) {}
    } else {
      await disconnectChannel();
    }
    Room.code = null; Room.data = null; Room.players = []; Room.hostId = null; lastNotifiedHost = undefined;
  }

  // 새로고침/창닫기 직전: presence에서 즉시 이탈. (방장이면 host_id는 DB에 남아 유예 동안 유지)
  function quickLeave() { try { if (Room.channel) Room.channel.untrack(); } catch (e) {} }

  return {
    Room,
    makeCode, guestName, resolveMyName, myThemeLine, inviteLink, myId,
    createRoom, joinRoom, leaveRoom, transferHost, quickLeave, retrack,
    updateSettings, startGame, onGameStart, onState, sendAnswer,
    setTyping, backToLobby, onBackToLobby, forceEnd,
    onPlayersChange, onHostChange, getPlayers: () => Room.players,
    isHost, getHostId,
  };
})();
