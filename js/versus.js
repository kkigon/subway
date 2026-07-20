/* ============================================================
   versus.js — 대전 모드
   ------------------------------------------------------------
   설계 핵심 (authoritative single-source + 원자적 방장 승계):
   1) "방장이 누구인가"의 단일 진실은 오직 rooms.host_id 다.
      presence는 "누가 접속해 있나 + 이름/색"만 담당하고,
      방장 판단에는 관여하지 않는다 → 진실이 둘로 갈리지 않음(분열 방지).
   2) 참가자 목록은 Supabase Presence의 전체 sync 스냅샷만 사용한다.
      join/leave 이벤트를 증분 적용하지 않아 재동기화 때 한 명씩 사라지는 현상을 막는다.
   3) 방장 변경은 브라우저의 직접 UPDATE가 아니라 Postgres RPC가 원자적으로 처리한다.
   4) 방장이 Presence에서 사라지면 곧장 넘기지 않고 "유예 시간"을 둔다.
      유예(약 10초)가 지나도 방장이 안 돌아오면, 남은 접속자 중
      '가장 오래 접속한 단 한 명'만 자신을 새 host_id로 기록(단일 writer).
      → 새로고침(보통 1~3초)은 유예가 흡수 → 방장 유지.
        진짜 이탈만 승계 발생 → 경쟁/분열 없음.
   5) 브로드캐스트는 "DB를 다시 읽으라"는 알림과 입력중 표시에만 사용한다.
      방장/게임 상태 payload를 신뢰하지 않는다.
   ============================================================ */

const Versus = (() => {
  const HOST_GRACE_MS = 10000;   // 방장이 사라진 뒤 승계까지 기다리는 유예
  const GAME_DURATIONS = [60, 120, 300];

  const Room = {
    code: null,
    myName: null,
    data: null,             // rooms 행 캐시
    channel: null,          // Presence + 가벼운 broadcast(room_changed/state_changed/typing)
    dbChannel: null,        // rooms/game_states Postgres Changes
    players: [],            // [{id,name,themeLine,joinedAt}] — Presence sync가 단일 진실
    presenceReady: false,   // 최초 전체 sync 수신 여부(받기 전에는 방장 승계를 하지 않음)
    hostId: null,           // 단일 진실: 현재 방장(rooms.host_id)
    hostRevision: -1,       // 오래된 DB 이벤트가 최신 방장을 덮지 못하게 하는 단조 증가 버전
    messages: [],           // 서버에 저장된 최근 채팅(신고 누적 숨김 제외)
    epoch: 0,               // 이전 방의 늦은 비동기 응답을 무시하기 위한 연결 세대
  };

  const playerListeners = [];
  const hostListeners = [];
  const roomListeners = [];
  const backToLobbyListeners = [];
  const chatListeners = [];
  function onPlayersChange(fn) { playerListeners.push(fn); }
  function onHostChange(fn) { hostListeners.push(fn); }
  function onRoomChange(fn) { roomListeners.push(fn); }
  function onBackToLobby(fn) { backToLobbyListeners.push(fn); }
  function onChatChange(fn) { chatListeners.push(fn); }
  function notifyPlayers() { const list = withTyping(Room.players); playerListeners.forEach(fn => { try { fn(list); } catch (e) {} }); }
  function notifyChat() { chatListeners.forEach(fn => { try { fn([...Room.messages]); } catch (e) {} }); }
  let lastNotifiedHost = undefined;
  function notifyHostIfChanged() {
    if (Room.hostId !== lastNotifiedHost) {
      lastNotifiedHost = Room.hostId;
      hostListeners.forEach(fn => { try { fn(isHost()); } catch (e) {} });
    }
  }

  function client() { return Account.getClient ? Account.getClient() : null; }

  // 대전 참가자 id는 계정 id와 분리한다.
  // sessionStorage라서 새로고침에는 유지되고, 다른 탭/창은 별도 참가자로 표시된다.
  // (기존 localStorage id는 같은 브라우저의 모든 탭이 공유해 두 명이 한 명으로 합쳐지는 원인이었다.)
  let cachedPlayerId = null;
  function myId() {
    if (cachedPlayerId) return cachedPlayerId;
    try { cachedPlayerId = sessionStorage.getItem("vsPlayerId"); } catch (e) {}
    if (!cachedPlayerId) {
      const uuid = (window.crypto && typeof window.crypto.randomUUID === "function")
        ? window.crypto.randomUUID()
        : Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);
      cachedPlayerId = "p_" + uuid;
      try { sessionStorage.setItem("vsPlayerId", cachedPlayerId); } catch (e) {}
    }
    return cachedPlayerId;
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

  let guestNameCache = null;
  function guestName() {
    // localStorage는 프라이빗 모드/잠금형 인앱 WebView에서 접근만으로 throw할 수 있다.
    // 가드 없으면 게스트 대전 진입(openEntry/doCreate/doJoin)이 전부 죽는다 → try/catch + 세션 캐시 폴백.
    if (guestNameCache) return guestNameCache;
    let n = null;
    try { n = localStorage.getItem("guestName"); } catch (e) {}
    if (!n) {
      n = "Guest #" + Math.floor(1000 + Math.random() * 9000);
      try { localStorage.setItem("guestName", n); } catch (e) {}
    }
    guestNameCache = n;
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

  const BLOCKED_TEXT = /(시+발|씨+발|ㅅㅂ|병+신|ㅂㅅ|좆|존+나|개+새+끼|새+끼|지+랄|꺼+져|닥+쳐|니+애+미|느+금+마)/i;
  function compactText(value) {
    return String(value || "").normalize("NFKC").toLowerCase().replace(/[^0-9a-z가-힣ㄱ-ㅎㅏ-ㅣ]/g, "");
  }
  function hasBlockedTerms(value) { return BLOCKED_TEXT.test(compactText(value)); }
  function validateRoomTitle(value) {
    const title = String(value || "").trim().replace(/\s+/g, " ");
    if (title.length < 2 || title.length > 30) return { ok: false, message: "방 제목은 2~30자로 입력해주세요." };
    if (hasBlockedTerms(title)) return { ok: false, message: "방 제목에 사용할 수 없는 표현이 포함되어 있어요." };
    if (/(.)\1{7,}/u.test(title)) return { ok: false, message: "같은 문자를 지나치게 반복할 수 없어요." };
    return { ok: true, value: title };
  }
  function validateChatText(value) {
    const body = String(value || "").trim().replace(/\s+/g, " ");
    if (!body) return { ok: false, message: "메시지를 입력해주세요." };
    if (body.length > 200) return { ok: false, message: "메시지는 200자까지 보낼 수 있어요." };
    if (hasBlockedTerms(body)) return { ok: false, message: "욕설·비속어가 포함된 메시지는 보낼 수 없어요." };
    if (/(.)\1{9,}/u.test(body)) return { ok: false, message: "같은 문자를 지나치게 반복할 수 없어요." };
    const links = body.match(/https?:\/\//gi) || [];
    if (links.length > 1) return { ok: false, message: "한 메시지에는 링크를 하나만 넣을 수 있어요." };
    return { ok: true, value: body };
  }

  /* ---------- 참가자 목록(Presence 전체 sync가 단일 진실) ---------- */
  // typing(입력중)은 가벼운 broadcast로만 주고받는다(DB에 쓰지 않음 → 깜빡임/부하 없음).
  const typingIds = {};   // { player_id: true }
  function withTyping(list) { return (list || []).map(p => Object.assign({}, p, { typing: !!typingIds[p.id] })); }

  function sortPlayers(list) {
    // 방장(host_id) 먼저, 그다음 합류 순
    return [...list].sort((a, b) => {
      const ha = a.id === Room.hostId ? 1 : 0, hb = b.id === Room.hostId ? 1 : 0;
      return (hb - ha) || (a.joinedAt - b.joinedAt) || String(a.name || "").localeCompare(String(b.name || ""));
    });
  }
  function samePlayerSet(a, b) {
    if (a.length !== b.length) return false;
    const key = p => [p.id, p.name || "", p.themeLine || "", p.joinedAt || 0].join(":");
    const ka = a.map(key).sort().join("|");
    const kb = b.map(key).sort().join("|");
    return ka === kb;
  }

  function presencePayload() {
    return {
      id: myId(), name: Room.myName || resolveMyName(), themeLine: myThemeLine(),
      joinedAt: mySessionJoinedAt,
    };
  }

  // Presence의 join/leave를 직접 더하고 빼지 않는다. 공식 동작상 sync 과정에서 두 이벤트가
  // 동시에 올 수 있으므로, 매번 presenceState() 전체를 평탄화/중복제거해 교체한다.
  function refreshMembers(channel = Room.channel) {
    if (!channel || channel !== Room.channel || !Room.code) return;
    let state = {};
    try { state = channel.presenceState() || {}; } catch (e) { return; }
    const byId = new Map();
    Object.values(state).forEach(entries => {
      (Array.isArray(entries) ? entries : []).forEach(meta => {
        if (!meta || !meta.id) return;
        const joinedAt = Number(meta.joinedAt) || Date.now();
        const current = byId.get(meta.id);
        // 같은 id가 잠깐 두 소켓에 보이는 재연결 구간에는 더 오래된 접속을 대표로 유지한다.
        if (!current || joinedAt < current.joinedAt) {
          byId.set(meta.id, {
            id: String(meta.id), name: String(meta.name || "Guest"),
            themeLine: meta.themeLine || null, joinedAt,
          });
        }
      });
    });
    if (!byId.has(myId())) byId.set(myId(), presencePayload());
    const next = sortPlayers([...byId.values()]);
    const changed = !samePlayerSet(next, Room.players);
    Room.players = next;
    Room.presenceReady = true;

    // 나간 사용자의 입력중 표시는 함께 정리한다.
    Object.keys(typingIds).forEach(id => { if (!byId.has(id)) delete typingIds[id]; });
    if (changed) {
      notifyPlayers();
      heartbeatRoom();
    }
    scheduleHostCheck();
  }

  function hostPresent() { return !!Room.hostId && Room.players.some(p => p.id === Room.hostId); }

  // 내 "입력중" 상태를 broadcast로 전파 (디바운스는 호출측에서)
  let myTyping = false;
  function setTyping(on) {
    on = !!on;
    if (on === myTyping) return;
    myTyping = on;
    if (Room.channel) { try { Room.channel.send({ type: "broadcast", event: "typing", payload: { id: myId(), on } }); } catch (e) {} }
  }

  /* ---------- 방장 승계 워치독 ---------- */
  let hostCheckTimer = null;
  function scheduleHostCheck() {
    if (!Room.presenceReady) return;  // 불완전한 목록으로 방장을 빼앗지 않는다.
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
    if (!Room.presenceReady || hostPresent()) return;
    const expectedHost = Room.hostId;
    await refreshRoom();                       // claim 직전 DB 최신값 확인
    if (Room.hostId !== expectedHost || hostPresent()) return;
    const players = Room.players || [];
    if (players.length === 0) return;
    // 가장 오래 접속한 사람(=joinedAt 최소, 동률 id순)
    const sorted = [...players].sort((a, b) =>
      (a.joinedAt - b.joinedAt) || String(a.id).localeCompare(String(b.id)));
    const heir = sorted[0];
    if (!heir || heir.id !== myId()) return;   // 나는 후계자가 아님 → 아무것도 안 함(단일 writer)
    // DB가 expectedHost가 아직 현재 방장일 때만 원자적으로 교체한다(CAS).
    const c = client();
    if (!c || !Room.code) return;
    try {
      const { data, error } = await c.rpc("room_claim_host", {
        p_room: Room.code, p_expected_host: expectedHost,
        p_claimant: myId(), p_claimant_name: Room.myName,
      });
      if (error) throw error;
      const row = rpcRow(data);
      if (row) {
        applyRoomSnapshot(row);
        signalRoomChanged();
      } else {
        await refreshRoom();                    // 다른 참가자가 먼저 승계한 경우
      }
    } catch (e) {
      console.warn("[Versus] 방장 자동 승계 실패", e && e.message ? e.message : e);
      await refreshRoom();
    }
  }

  function rpcRow(data) { return Array.isArray(data) ? (data[0] || null) : (data || null); }

  // DB 스냅샷만 방장 정보로 적용한다. revision이 작은 Realtime 이벤트는 무시한다.
  function applyRoomSnapshot(row) {
    if (!row) return false;
    const revision = Number(row.host_revision);
    const hasRevision = Number.isFinite(revision);
    if (hasRevision && revision < Room.hostRevision) return false;
    const previousHost = Room.hostId;
    Room.data = Object.assign({}, Room.data || {}, row);
    Room.hostId = row.host_id || null;
    if (hasRevision) Room.hostRevision = revision;
    roomListeners.forEach(fn => { try { fn(Room.data); } catch (e) {} });
    if (previousHost !== Room.hostId) {
      Room.players = sortPlayers(Room.players);
      notifyHostIfChanged();
      notifyPlayers();
      heartbeatRoom();
    }
    scheduleHostCheck();
    return true;
  }

  let roomSyncEntry = null;
  function refreshRoom() {
    const roomCode = Room.code;
    const epoch = Room.epoch;
    const key = epoch + ":" + roomCode;
    if (roomSyncEntry && roomSyncEntry.key === key) return roomSyncEntry.promise;
    const promise = (async () => {
      const c = client();
      if (!c || !roomCode) return null;
      try {
        const { data, error } = await c.rpc("room_get", { p_code: roomCode });
        if (error) throw error;
        const row = rpcRow(data);
        if (row && Room.code === roomCode && Room.epoch === epoch) applyRoomSnapshot(row);
        return row || null;
      } catch (e) {
        console.warn("[Versus] 방 상태 동기화 실패", e && e.message ? e.message : e);
        return null;
      }
    })();
    roomSyncEntry = { key, promise };
    promise.finally(() => { if (roomSyncEntry && roomSyncEntry.promise === promise) roomSyncEntry = null; });
    return promise;
  }

  function signalRoomChanged() {
    if (!Room.channel) return;
    try {
      Room.channel.send({
        type: "broadcast", event: "room_changed",
        payload: { revision: Room.hostRevision },
      });
    } catch (e) {}
  }

  function waitForSubscription(channel, onSubscribed) {
    return new Promise(resolve => {
      let settled = false;
      const finish = ok => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok); } };
      const timer = setTimeout(() => finish(false), 6000);
      channel.subscribe(async status => {
        if (status === "SUBSCRIBED") {
          let ok = true;
          try { if (onSubscribed) ok = (await onSubscribed()) !== false; } catch (e) { ok = false; }
          finish(ok);
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          finish(false);
        }
      });
    });
  }

  /* ---------- Realtime 연결 ---------- */
  async function connectChannel() {
    const c = client();
    if (!c || !Room.code) return false;
    await disconnectChannel(true);

    refreshJoinTime();
    Room.myName = resolveMyName();
    Room.presenceReady = false;
    const epoch = ++Room.epoch;
    const roomCode = Room.code;

    // 온라인 참가자 목록과 일회성 신호는 하나의 방 채널에서 관리한다.
    const channel = c.channel("room:" + Room.code, {
      config: { broadcast: { self: false }, presence: { key: myId() } },
    });
    channel.on("presence", { event: "sync" }, () => {
      if (Room.epoch === epoch && Room.code === roomCode) refreshMembers(channel);
    });
    // payload를 상태로 적용하지 않고 DB 재조회 트리거로만 사용한다.
    channel.on("broadcast", { event: "room_changed" }, () => {
      if (Room.epoch === epoch && Room.code === roomCode) refreshRoom();
    });
    channel.on("broadcast", { event: "state_changed" }, ({ payload }) => {
      if (Room.epoch !== epoch || Room.code !== roomCode) return;
      if (!payload || typeof payload.rev !== "number" || payload.rev > lastRev) syncNow();
    });
    // 입력중 표시: 가벼운 broadcast로만 주고받음(DB 미사용)
    channel.on("broadcast", { event: "typing" }, ({ payload }) => {
      if (Room.epoch !== epoch || Room.code !== roomCode) return;
      if (!payload || !payload.id) return;
      if (!Room.players.some(p => p.id === payload.id)) return;
      if (payload.on) typingIds[payload.id] = true; else delete typingIds[payload.id];
      notifyPlayers();
    });
    // 채팅 payload 자체는 신뢰하지 않고, 변경 알림을 받으면 서버 기록을 다시 읽는다.
    channel.on("broadcast", { event: "chat_changed" }, () => {
      if (Room.epoch === epoch && Room.code === roomCode) refreshChat();
    });

    Room.channel = channel;

    // rooms와 game_states를 한 DB 채널에서 함께 구독한다. 실패해도 폴링으로 자가치유한다.
    const dbCh = c.channel("roomdb:" + Room.code + ":" + myId());
    dbCh.on("postgres_changes",
      { event: "*", schema: "public", table: "rooms", filter: "code=eq." + Room.code },
      (payload) => {
        if (Room.epoch !== epoch || Room.code !== roomCode) return;
        if (payload.eventType === "DELETE") return;
        if (payload.new) applyRoomSnapshot(payload.new);
      });
    dbCh.on("postgres_changes",
      { event: "*", schema: "public", table: "game_states", filter: "room_code=eq." + Room.code },
      (payload) => {
        if (Room.epoch !== epoch || Room.code !== roomCode) return;
        if (payload.eventType === "DELETE") return;
        if (payload.new) applyState(snapFromRow(payload.new));
      });
    Room.dbChannel = dbCh;

    // 병렬 구독: 기존처럼 채널마다 최대 5초씩 직렬 대기하지 않는다.
    const [presenceReady] = await Promise.all([
      waitForSubscription(channel, async () => {
        const optimistic = sortPlayers(Room.players.filter(p => p.id !== myId()).concat([presencePayload()]));
        if (!samePlayerSet(optimistic, Room.players)) {
          Room.players = optimistic;
          notifyPlayers();
        }
        const trackStatus = await channel.track(presencePayload());
        return trackStatus === "ok";
      }),
      waitForSubscription(dbCh),
    ]);
    if (!presenceReady) {
      await disconnectChannel(true);
      return false;
    }

    startReconciler();
    await refreshRoom();
    await refreshChat();
    await syncNow();
    ensureWatcher();

    return true;
  }

  // Postgres Changes가 꺼져 있거나 일시적으로 끊겨도 DB 상태를 복구한다.
  // 공개방 활성 여부와 인원 수는 현재 방장이 주기적으로 heartbeat로 갱신한다.
  let reconcileTimer = null, heartbeatTimer = null, chatPollTimer = null;
  function startReconciler() {
    stopReconciler();
    reconcileTimer = setInterval(refreshRoom, 3000);
    chatPollTimer = setInterval(refreshChat, 5000);
    heartbeatRoom();
    heartbeatTimer = setInterval(heartbeatRoom, 30000);
  }
  function stopReconciler() {
    if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; }
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
  }

  let heartbeatInFlight = false;
  async function heartbeatRoom() {
    if (heartbeatInFlight || !Room.code || !isHost()) return;
    const c = client();
    if (!c) return;
    heartbeatInFlight = true;
    try {
      const { data, error } = await c.rpc("room_heartbeat", {
        p_room: Room.code, p_host: myId(), p_member_count: Math.max(1, Room.players.length || 1),
      });
      if (!error) {
        const row = rpcRow(data);
        if (row) applyRoomSnapshot(row);
      }
    } catch (e) {}
    heartbeatInFlight = false;
  }

  function sameMessages(a, b) {
    if (a.length !== b.length) return false;
    return a.every((message, index) => {
      const other = b[index];
      return other && String(message.id) === String(other.id)
        && Number(message.report_count || 0) === Number(other.report_count || 0);
    });
  }

  let chatInFlight = false;
  async function refreshChat() {
    if (chatInFlight || !Room.code) return Room.messages;
    const c = client();
    if (!c) return Room.messages;
    chatInFlight = true;
    const roomCode = Room.code;
    const epoch = Room.epoch;
    try {
      const { data, error } = await c.rpc("room_chat_history", { p_room: roomCode, p_limit: 80 });
      if (error) throw error;
      if (Room.code === roomCode && Room.epoch === epoch) {
        const next = (Array.isArray(data) ? data : (data ? [data] : []))
          .filter(message => !message.is_hidden)
          .sort((a, b) => Number(a.id) - Number(b.id));
        if (!sameMessages(next, Room.messages)) {
          Room.messages = next;
          notifyChat();
        }
      }
    } catch (e) {
      console.warn("[Versus] 채팅 동기화 실패", e && e.message ? e.message : e);
    }
    chatInFlight = false;
    return Room.messages;
  }

  function signalChatChanged() {
    if (!Room.channel) return;
    try { Room.channel.send({ type: "broadcast", event: "chat_changed", payload: {} }); } catch (e) {}
  }

  let lastChatSentAt = 0;
  async function sendChat(value) {
    if (!Room.code) return { ok: false, message: "먼저 방에 입장해주세요." };
    const checked = validateChatText(value);
    if (!checked.ok) return checked;
    const now = Date.now();
    if (now - lastChatSentAt < 1000) return { ok: false, message: "메시지를 너무 빠르게 보내고 있어요." };
    const c = client();
    if (!c) return { ok: false, message: "서버 연결이 필요해요." };
    lastChatSentAt = now;
    try {
      const { error } = await c.rpc("room_send_message", {
        p_room: Room.code, p_player: myId(), p_player_name: Room.myName, p_body: checked.value,
      });
      if (error) throw error;
      await refreshChat();
      signalChatChanged();
      return { ok: true };
    } catch (e) {
      return { ok: false, message: serverErrorMessage(e) };
    }
  }

  async function reportChat(messageId, reason) {
    if (!Room.code) return { ok: false, message: "방 연결이 끊어졌어요." };
    const c = client();
    if (!c) return { ok: false, message: "서버 연결이 필요해요." };
    const cleanReason = String(reason || "부적절한 내용").trim().slice(0, 80);
    try {
      const { data, error } = await c.rpc("room_report_message", {
        p_room: Room.code, p_message: Number(messageId), p_reporter: myId(), p_reason: cleanReason,
      });
      if (error) throw error;
      if (data === false) return { ok: false, message: "이미 신고한 메시지예요." };
      await refreshChat();
      signalChatChanged();
      return { ok: true };
    } catch (e) {
      return { ok: false, message: serverErrorMessage(e) };
    }
  }

  async function retrack() {
    if (!Room.channel || !Room.code) return;
    Room.myName = resolveMyName();
    try { await Room.channel.track(presencePayload()); } catch (e) {}
    refreshMembers(Room.channel);
  }

  async function disconnectChannel(keepList) {
    const c = client();
    if (hostCheckTimer) { clearTimeout(hostCheckTimer); hostCheckTimer = null; }
    stopReconciler();
    stopWatcher();
    const ch = Room.channel, dbch = Room.dbChannel;
    Room.channel = null; Room.dbChannel = null; Room.presenceReady = false;
    Room.epoch += 1;
    if (!keepList && ch) { try { await ch.untrack(); } catch (e) {} }
    if (c) {
      try { if (ch) await c.removeChannel(ch); } catch (e) {}
      try { if (dbch) await c.removeChannel(dbch); } catch (e) {}
    }
    if (!keepList) {
      Room.players = [];
      Object.keys(typingIds).forEach(id => delete typingIds[id]);
      lastNotifiedHost = undefined;
    }
  }

  function resetRoomState() {
    Room.code = null;
    Room.myName = null;
    Room.data = null;
    Room.players = [];
    Room.presenceReady = false;
    Room.hostId = null;
    Room.hostRevision = -1;
    Room.messages = [];
    lastNotifiedHost = undefined;
    Object.keys(typingIds).forEach(id => delete typingIds[id]);
    myTyping = false;
    lastRev = -1;
    lastSnapshot = null;
    lastPushedRev = -1;
    inGame = false;
    startedSig = null;
    lastChatSentAt = 0;
    notifyChat();
  }

  /* ---------- 방 생성 ---------- */
  async function listPublicRooms(limit = 30) {
    const c = client();
    if (!c) return { ok: false, rooms: [], message: "서버 연결이 필요해요." };
    try {
      const { data, error } = await c.rpc("room_list_public", { p_limit: Math.max(1, Math.min(Number(limit) || 30, 50)) });
      if (error) throw error;
      return { ok: true, rooms: Array.isArray(data) ? data : [] };
    } catch (e) {
      return { ok: false, rooms: [], message: serverErrorMessage(e) };
    }
  }

  async function createRoom(options = {}) {
    const c = client();
    if (!c) return { ok: false, message: "서버 연결이 필요해요. 잠시 후 다시 시도해주세요." };
    Room.myName = resolveMyName();
    const titleResult = validateRoomTitle(options.title || `${Room.myName}님의 대전방`);
    if (!titleResult.ok) return titleResult;
    const isPublic = options.isPublic !== false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = makeCode(6);
      const { data, error } = await c.rpc("room_create_v2", {
        p_code: code, p_host: myId(), p_host_name: Room.myName,
        p_region: (typeof State !== "undefined" && State.region) ? State.region : "seoul",
        p_room_title: titleResult.value, p_is_public: isPublic,
      });
      if (!error) {
        const row = rpcRow(data);
        if (!row) return { ok: false, message: "방 생성 결과를 받지 못했어요." };
        Room.code = code;
        Room.hostRevision = -1;
        applyRoomSnapshot(row);
        const connected = await connectChannel();
        if (!connected) {
          try { await c.rpc("room_delete", { p_room: code, p_host: myId() }); } catch (e) {}
          resetRoomState();
          return { ok: false, message: "실시간 서버에 연결하지 못했어요. 잠시 후 다시 시도해주세요." };
        }
        notifyHostIfChanged();
        return { ok: true, code };
      }
      if (error.code !== "23505") {
        console.warn("[Versus] 방 생성 실패", error.message);
        return { ok: false, message: serverErrorMessage(error) };
      }
    }
    return { ok: false, message: "방 코드 생성에 실패했어요. 다시 시도해주세요." };
  }

  /* ---------- 방 입장 (새로고침 재접속도 이 경로) ---------- */
  async function joinRoom(code) {
    const c = client();
    if (!c) return { ok: false, message: "서버 연결이 필요해요." };
    code = (code || "").trim().toUpperCase();
    if (code.length < 4) return { ok: false, message: "코드를 정확히 입력해주세요." };

    const { data, error } = await c.rpc("room_get", { p_code: code });
    if (error) { console.warn("[Versus] 입장 조회 실패", error.message); return { ok: false, message: serverErrorMessage(error) }; }
    const row = rpcRow(data);
    if (!row) return { ok: false, message: "그런 방이 없어요. 코드를 다시 확인해주세요." };
    if (row.status === "ended") return { ok: false, message: "이미 끝난 방이에요." };

    Room.code = code;
    Room.myName = resolveMyName();
    Room.hostRevision = -1;
    applyRoomSnapshot(row);
    const connected = await connectChannel();
    if (!connected) {
      resetRoomState();
      return { ok: false, message: "실시간 서버에 연결하지 못했어요. 잠시 후 다시 시도해주세요." };
    }
    notifyHostIfChanged();
    return { ok: true, code };
  }

  function serverErrorMessage(error) {
    if (!error) return "서버 요청에 실패했어요.";
    if (error.code === "PGRST202" || /room_(create|create_v2|get|list_public|chat|send_message|report_message|heartbeat|claim_host|transfer_host)/.test(error.message || "")) {
      return "멀티플레이어 DB 업데이트가 필요해요. README의 Supabase SQL 적용 순서를 확인해주세요.";
    }
    if (error.code === "22023") {
      const message = error.message || "";
      if (/blocked (chat|room title)|invalid chat/i.test(message)) return "사용할 수 없는 표현이 포함되어 있어요.";
      if (/too many links/i.test(message)) return "한 메시지에는 링크를 하나만 넣을 수 있어요.";
      if (/room not found|closed/i.test(message)) return "방이 종료되었거나 연결이 끊어졌어요.";
      return message || "입력 내용을 확인해주세요.";
    }
    if (error.code === "P0001") {
      if (/duplicate/i.test(error.message || "")) return "같은 메시지를 연속해서 보낼 수 없어요.";
      return "메시지를 너무 빠르게 보내고 있어요. 잠시 후 다시 시도해주세요.";
    }
    if (error.code === "42501") return "방장 권한이 바뀌었어요. 방 상태를 다시 확인해주세요.";
    return error.message || "서버 요청에 실패했어요.";
  }

  /* ---------- 게임 설정 / 시작 ---------- */
  // 방장이 대기실에서 설정을 바꾸면 DB에 저장(다음 단계에서 대기실 표시에 활용 가능)
  async function updateSettings(s) {
    if (!Room.code || !isHost()) return { ok: false };
    const c = client();
    if (!c) return { ok: false, message: "서버 연결이 필요해요." };
    try {
      const current = Room.data || {};
      const { data, error } = await c.rpc("room_update_settings", {
        p_room: Room.code, p_host: myId(),
        p_region: s.region !== undefined ? s.region : current.region,
        p_mode: s.mode !== undefined ? s.mode : current.mode,
        p_custom_lines: s.customLines !== undefined ? (s.customLines || []).join(",") : current.custom_lines,
        p_duration: GAME_DURATIONS.includes(Number(s.duration !== undefined ? s.duration : current.duration_sec))
          ? Number(s.duration !== undefined ? s.duration : current.duration_sec) : 60,
        p_play_mode: s.playMode !== undefined ? s.playMode : (current.play_mode || "timed"),
      });
      if (error) throw error;
      const row = rpcRow(data);
      if (row) applyRoomSnapshot(row);
      signalRoomChanged();
      return { ok: true };
    } catch (e) {
      await refreshRoom();
      return { ok: false, message: serverErrorMessage(e) };
    }
  }

  async function setRoomStatus(status) {
    const c = client();
    if (!c || !Room.code || !isHost()) return { ok: false };
    try {
      const { data, error } = await c.rpc("room_set_status", {
        p_room: Room.code, p_host: myId(), p_status: status,
      });
      if (error) throw error;
      const row = rpcRow(data);
      if (row) applyRoomSnapshot(row);
      signalRoomChanged();
      return { ok: true };
    } catch (e) {
      await refreshRoom();
      return { ok: false, message: serverErrorMessage(e) };
    }
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
      playMode: Room.data?.play_mode === "reverse" ? "reverse" : "timed",
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
          duration: snap.duration, playMode: snap.playMode,
          order: snap.order, playAt: snap.playAt,
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
    const roomCode = Room.code;
    const epoch = Room.epoch;
    try {
      const c = client();
      if (c && roomCode) {
        const { data, error } = await c.rpc("vs_end", { p_room: roomCode });
        if (!error && data && Room.code === roomCode && Room.epoch === epoch) {
          const ns = snapFromRow(data); applyState(ns); pushState(ns);
        }
      }
    } catch (e) {}
    endInFlight = false;   // 실패 시 다음 틱에서 재시도(끝날 때까지)
  }
  // 저지연 알림: 스냅샷 자체를 브로드캐스트하지 않고 새 revision만 알린다.
  // 수신자는 반드시 vs_sync로 DB의 권위 상태를 다시 읽는다.
  let lastPushedRev = -1;
  function pushState(snap) {
    if (!snap || typeof snap.rev !== "number") return;
    if (snap.rev <= lastPushedRev) return;   // 이미 전파했거나 더 오래된 상태면 스킵(스팸 방지)
    lastPushedRev = snap.rev;
    if (Room.channel) {
      try { Room.channel.send({ type: "broadcast", event: "state_changed", payload: { rev: snap.rev } }); } catch (e) {}
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
    const roomCode = Room.code;
    const epoch = Room.epoch;
    try {
      const c = client();
      if (c) {
        const { data, error } = await c.rpc("vs_tick", { p_room: roomCode });
        if (!error && data && Room.code === roomCode && Room.epoch === epoch) {
          const ns = snapFromRow(data); applyState(ns); pushState(ns);
        }
      }
    } catch (e) {}
    tickInFlight = false;
  }

  let syncInFlight = false;
  async function syncNow() {
    if (syncInFlight || !Room.code) return;
    syncInFlight = true;
    const roomCode = Room.code;
    const epoch = Room.epoch;
    try {
      const c = client();
      if (c) {
        const { data, error } = await c.rpc("vs_sync", { p_room: roomCode });
        if (!error && data && Room.code === roomCode && Room.epoch === epoch) applyState(snapFromRow(data));
      }
    } catch (e) {}
    syncInFlight = false;
  }

  /* ---------- 방장: 게임 시작 (서버에 상태 생성) ---------- */
  async function startGame(settings) {
    if (!Room.code || !isHost()) return { ok: false, message: "방장만 시작할 수 있어요." };
    const region = settings.region || (Room.data && Room.data.region) || "seoul";
    const mode = settings.mode || "all";
    const customLines = settings.customLines || [];
    const duration = GAME_DURATIONS.includes(Number(settings.duration)) ? Number(settings.duration) : 60;
    const playMode = settings.playMode === "reverse" ? "reverse" : "timed";

    // 디바운스 저장이 아직 대기 중이어도 시작 직전에 방 설정을 확정한다.
    // 참가자들은 rooms Realtime 행의 play_mode를 받아 같은 판정 규칙으로 시작한다.
    const settingsResult = await updateSettings({ region, mode, customLines, duration, playMode });
    if (!settingsResult.ok) return { ok: false, message: settingsResult.message || "방 설정을 저장하지 못했어요." };

    const lineIds = window.VersusGame.resolveLineIds(region, mode, customLines);
    if (!lineIds || lineIds.length === 0) return { ok: false, message: "노선을 선택해주세요." };
    const order = window.VersusGame.buildOrder(region, lineIds);

    const c = client();
    if (!c) return { ok: false, message: "서버 연결이 필요해요. 잠시 후 다시 시도해주세요." };
    const roomCode = Room.code;
    const epoch = Room.epoch;

    const names = {}; names[myId()] = { name: Room.myName, themeLine: myThemeLine() };
    try {
      const { data, error } = await c.rpc("vs_start", {
        p_room: roomCode, p_region: region, p_line_ids: lineIds,
        p_order: order, p_duration: duration, p_names: names,
      });
      if (error) { console.warn("[Versus] 게임 시작 실패", error.message); return { ok: false, message: error.message }; }
      if (Room.code !== roomCode || Room.epoch !== epoch) return { ok: false, message: "방 연결이 바뀌었어요." };
      const statusResult = await setRoomStatus("playing");
      if (!statusResult.ok) console.warn("[Versus] 방 상태 playing 반영 실패", statusResult.message || "권한 변경");
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
    const roomCode = Room.code;
    const epoch = Room.epoch;
    try {
      const { data, error } = await c.rpc("vs_claim", {
        p_room: roomCode, p_index: index,
        p_player_id: myId(), p_player_name: Room.myName,
      });
      if (!error && data && Room.code === roomCode && Room.epoch === epoch) {
        const ns = snapFromRow(data); applyState(ns); pushState(ns);
      }
    } catch (e) {}
  }

  /* ---------- 방장: 결과 화면에서 "대기실로" → 모두 대기실로 ---------- */
  async function backToLobby() {
    if (!isHost()) return { ok: false };
    const c = client();
    if (c && Room.code) {
      const statusResult = await setRoomStatus("waiting");
      if (!statusResult.ok) return statusResult;
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
    if (!c) return { ok: false };
    try {
      const { data, error } = await c.rpc("room_transfer_host", {
        p_room: Room.code, p_current_host: myId(),
        p_new_host: newHostId, p_new_host_name: target.name,
      });
      if (error) throw error;
      const row = rpcRow(data);
      if (!row) throw new Error("방장 변경 결과가 없습니다.");
      applyRoomSnapshot(row);
      signalRoomChanged();
      return { ok: true };
    } catch (e) {
      console.warn("[Versus] 방장 위임 실패", e && e.message ? e.message : e);
      await refreshRoom();
      return { ok: false, message: serverErrorMessage(e) };
    }
  }

  /* ---------- 방 나가기 (버튼 전용) ---------- */
  async function leaveRoom() {
    const c = client();
    const amHost = isHost();
    const others = (Room.players || []).filter(p => p.id !== myId());

    if (c && Room.code && amHost && others.length > 0) {
      // 방장이 직접 나감 → 원자적 RPC로 가장 오래 접속한 남은 사람에게 즉시 위임
      const sorted = [...others].sort((a, b) => (a.joinedAt - b.joinedAt) || String(a.id).localeCompare(String(b.id)));
      const heir = sorted[0];
      await transferHost(heir.id);  // 실패해도 남은 참가자의 유예 후 CAS 승계가 복구한다.
      await disconnectChannel();
    } else if (c && Room.code && amHost && Room.presenceReady && others.length === 0) {
      // 전체 Presence 스냅샷상 혼자일 때만 서버 권한 함수로 방 삭제
      try {
        const { error } = await c.rpc("room_delete", { p_room: Room.code, p_host: myId() });
        if (error) throw error;
      } catch (e) { console.warn("[Versus] 빈 방 삭제 실패", e && e.message ? e.message : e); }
      await disconnectChannel();
    } else {
      await disconnectChannel();
    }
    resetRoomState();
  }

  // Presence는 소켓 종료를 서버가 감지해 정리한다. pagehide에서 직접 untrack하면
  // bfcache/탭 전환에도 가짜 퇴장-재입장이 생기므로 의도적으로 아무것도 하지 않는다.
  function quickLeave() {
    return;
  }

  return {
    Room,
    makeCode, guestName, resolveMyName, myThemeLine, inviteLink, myId,
    createRoom, listPublicRooms, joinRoom, leaveRoom, transferHost, quickLeave, retrack,
    updateSettings, startGame, onGameStart, onState, sendAnswer,
    setTyping, backToLobby, onBackToLobby, forceEnd,
    validateRoomTitle, validateChatText, sendChat, reportChat, refreshChat, onChatChange,
    onPlayersChange, onHostChange, onRoomChange, getPlayers: () => withTyping(Room.players),
    getMessages: () => [...Room.messages],
    isHost, getHostId,
  };
})();
