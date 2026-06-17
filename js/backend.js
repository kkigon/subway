/* ============================================================
   backend.js — Supabase 연동 (로그인 / 프로필 / 기록 / 랭킹)
   ------------------------------------------------------------
   게임 로직(game.js)은 이 파일이 노출하는 Account 객체만 사용한다.
   Supabase가 설정 안 됐거나 오프라인이어도 게임 자체는 그대로 동작하도록,
   모든 함수는 실패 시 조용히 null/false를 돌려준다.
   ============================================================ */

const Account = (() => {
  let client = null;       // Supabase 클라이언트
  let session = null;      // 현재 로그인 세션 (없으면 null)
  let profile = null;      // 현재 사용자 프로필 {id, nickname, theme_line}
  let ready = false;       // 초기화 완료 여부
  const listeners = [];    // 로그인/프로필 변경 구독자

  function configured() {
    return typeof SUPABASE_URL === "string" &&
           SUPABASE_URL.startsWith("http") &&
           typeof SUPABASE_ANON_KEY === "string" &&
           SUPABASE_ANON_KEY.length > 20;
  }

  function notify() { listeners.forEach(fn => { try { fn(); } catch (e) {} }); }

  // 외부에서 로그인 상태 변화를 구독
  function onChange(fn) { listeners.push(fn); }

  async function init() {
    if (!configured()) {
      console.warn("[Account] Supabase 설정이 없어 로그인 기능이 꺼진 상태로 동작합니다. js/supabase-config.js 를 채워주세요.");
      ready = true; notify(); return;
    }
    if (!window.supabase || !window.supabase.createClient) {
      console.warn("[Account] Supabase 라이브러리가 로드되지 않았습니다.");
      ready = true; notify(); return;
    }
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // 현재 세션 읽기
    const { data } = await client.auth.getSession();
    session = data.session || null;
    if (session) await loadProfile();

    // 로그인/로그아웃 등 상태 변화 감지
    client.auth.onAuthStateChange(async (_event, newSession) => {
      session = newSession;
      profile = null;
      if (session) await loadProfile();
      notify();
    });

    ready = true;
    notify();
  }

  async function loadProfile() {
    if (!client || !session) { profile = null; return; }
    const { data, error } = await client
      .from("profiles")
      .select("id, nickname, theme_line")
      .eq("id", session.user.id)
      .maybeSingle();
    if (error) { console.warn("[Account] 프로필 조회 실패", error.message); profile = null; return; }
    profile = data || null;
  }

  // 구글 로그인 시작 (성공하면 페이지가 리디렉션됨)
  async function signInWithGoogle() {
    if (!client) return false;
    const redirectTo = location.href.split("#")[0];
    const { error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });
    if (error) { console.warn("[Account] 구글 로그인 실패", error.message); return false; }
    return true;
  }

  async function signOut() {
    if (!client) return;
    await client.auth.signOut();
    session = null; profile = null;
    notify();
  }

  // 처음 로그인한 사용자의 프로필 생성 (닉네임 + 테마 노선)
  // 반환: { ok:true } 또는 { ok:false, reason:"duplicate"|"error", message }
  async function createProfile(nickname, themeLine) {
    if (!client || !session) return { ok: false, reason: "error", message: "로그인이 필요합니다." };
    nickname = (nickname || "").trim();
    if (nickname.length < 1 || nickname.length > 12) {
      return { ok: false, reason: "error", message: "닉네임은 1~12자여야 해요." };
    }
    const { error } = await client.from("profiles").insert({
      id: session.user.id,
      nickname,
      theme_line: themeLine || "L1",
    });
    if (error) {
      // 닉네임 유니크 인덱스 위반(중복)
      if (error.code === "23505") return { ok: false, reason: "duplicate", message: "이미 사용 중인 닉네임이에요." };
      return { ok: false, reason: "error", message: error.message };
    }
    await loadProfile();
    notify();
    return { ok: true };
  }

  // 테마 노선 변경 (마이페이지)
  async function updateThemeLine(themeLine) {
    if (!client || !session) return false;
    const { error } = await client
      .from("profiles")
      .update({ theme_line: themeLine, updated_at: new Date().toISOString() })
      .eq("id", session.user.id);
    if (error) { console.warn("[Account] 테마 변경 실패", error.message); return false; }
    if (profile) profile.theme_line = themeLine;
    notify();
    return true;
  }

  // 닉네임 변경 (마이페이지)
  async function updateNickname(nickname) {
    if (!client || !session) return { ok: false, message: "로그인이 필요합니다." };
    nickname = (nickname || "").trim();
    if (nickname.length < 1 || nickname.length > 12) {
      return { ok: false, message: "닉네임은 1~12자여야 해요." };
    }
    const { error } = await client
      .from("profiles")
      .update({ nickname, updated_at: new Date().toISOString() })
      .eq("id", session.user.id);
    if (error) {
      if (error.code === "23505") return { ok: false, message: "이미 사용 중인 닉네임이에요." };
      return { ok: false, message: error.message };
    }
    if (profile) profile.nickname = nickname;
    notify();
    return { ok: true };
  }

  // 시간제한 모드 플레이 기록 저장 (연속 모드는 호출하지 않음)
  async function savePlay({ score, region, mode, rankMode, modeLabel }) {
    if (!client || !session) return false;
    const { error } = await client.from("plays").insert({
      user_id: session.user.id,
      score,
      region: region || "seoul",
      mode,
      rank_mode: rankMode || `${region || "seoul"}:${mode}`,
      mode_label: modeLabel,
    });
    if (error) { console.warn("[Account] 기록 저장 실패", error.message); return false; }
    return true;
  }

  // 내 플레이 기록 가져오기 (마이페이지)
  async function myPlays(limit = 50) {
    if (!client || !session) return [];
    const { data, error } = await client
      .from("plays")
      .select("score, region, mode, mode_label, created_at")
      .eq("user_id", session.user.id)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) { console.warn("[Account] 기록 조회 실패", error.message); return []; }
    return data || [];
  }

  // 내 최고점 (지역+모드별) — 마이페이지 요약용
  async function myBest() {
    const plays = await myPlays(500);
    const best = {};
    for (const p of plays) {
      const key = `${p.region || "seoul"}:${p.mode}`;
      if (best[key] === undefined || p.score > best[key]) best[key] = p.score;
    }
    return best; // { "seoul:core": 23, "busan:all": 12, ... } 형태
  }

  // 주간 랭킹 (mode: 'core' | 'all')
  async function weeklyRanking(mode, limit = 50) {
    if (!client) return [];
    const { data, error } = await client.rpc("weekly_ranking", { p_mode: mode, p_limit: limit });
    if (error) { console.warn("[Account] 랭킹 조회 실패", error.message); return []; }
    return data || [];
  }

  // 다음 주간 리셋까지 남은 시간(월요일 00:00 UTC 기준)
  function nextResetText() {
    const now = new Date();
    // 이번 주 월요일 00:00 UTC
    const day = now.getUTCDay(); // 0=일,1=월,...
    const daysSinceMon = (day + 6) % 7;
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMon, 0, 0, 0));
    const nextMonday = new Date(monday.getTime() + 7 * 24 * 3600 * 1000);
    const ms = nextMonday - now;
    const d = Math.floor(ms / (24 * 3600 * 1000));
    const h = Math.floor((ms % (24 * 3600 * 1000)) / (3600 * 1000));
    if (d > 0) return `${d}일 ${h}시간 후 리셋`;
    const m = Math.floor((ms % (3600 * 1000)) / (60 * 1000));
    return `${h}시간 ${m}분 후 리셋`;
  }

  return {
    init, onChange,
    isConfigured: configured,
    isReady: () => ready,
    isLoggedIn: () => !!session,
    hasProfile: () => !!profile,
    getProfile: () => profile,
    getEmail: () => session?.user?.email || null,
    getUserId: () => session?.user?.id || null,
    getClient: () => client,          // 대전 모드(Realtime)에서 사용
    signInWithGoogle, signOut,
    createProfile, updateThemeLine, updateNickname,
    savePlay, myPlays, myBest, weeklyRanking, nextResetText,
  };
})();
