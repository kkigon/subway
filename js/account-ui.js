/* ============================================================
   account-ui.js — 계정/랭킹/마이페이지 화면 제어
   ------------------------------------------------------------
   backend.js의 Account 객체를 사용해 화면을 그린다.
   game.js와는 window.onPlayFinished(...) 훅으로만 연결된다.
   ============================================================ */

(() => {
  const $ = sel => document.querySelector(sel);

  // 테마 노선 옵션 (data.js의 LINES 사용)
  function lineColor(id) { const l = lineById(id); return l ? l.color : "#0052A4"; }
  function lineName(id) { const l = lineById(id); return l ? l.name : id; }
  function lineDarkText(id) { const l = lineById(id); return l && l.darkText; }

  /* ---------- 인앱 브라우저 로그인 처리 ---------- */
  // 카카오톡 등 인앱 브라우저에서 구글 로그인을 누르면 외부 브라우저로 유도
  function handleInAppLogin() {
    const name = InAppBrowser.label() || "인앱 브라우저";
    // 카카오톡·라인·안드로이드 → 외부 브라우저 강제 오픈 시도
    const escaped = InAppBrowser.tryEscape(location.href);
    if (escaped) return; // 외부 브라우저로 넘어감

    // iOS 기타 인앱 브라우저 → 직접 탈출 불가, 안내 모달 표시
    openInAppGuide(name);
  }

  function openInAppGuide(name) {
    const modal = $("#inapp-modal");
    if (!modal) {
      // 모달이 없으면 최소한 토스트로 안내
      if (typeof toast === "function") {
        toast("구글 로그인은 크롬·사파리에서 가능해요. 우측 메뉴(···)에서 ‘다른 브라우저로 열기’를 눌러주세요.");
      }
      return;
    }
    const msg = $("#inapp-msg");
    if (msg) {
      msg.innerHTML = `지금 <b>${escapeHtml(name)}</b> 안에서 열려 있어, 구글 로그인이 차단돼요.<br>
        아래 방법으로 <b>크롬·사파리</b> 같은 기본 브라우저에서 열어주세요.`;
    }
    // 현재 주소를 복사용으로 채움
    const urlBox = $("#inapp-url");
    if (urlBox) urlBox.value = location.href;
    openModal("#inapp-modal");
  }

  /* ---------- 상단 우측 계정 버튼 ---------- */
  function renderAccountButton() {
    const wrap = $("#account-area");
    if (!wrap) return;
    wrap.innerHTML = "";

    if (!Account.isConfigured()) return; // 설정 전이면 버튼 숨김

    if (!Account.isLoggedIn()) {
      const btn = document.createElement("button");
      btn.className = "account-btn login";
      btn.type = "button";
      btn.textContent = "구글로 로그인";
      btn.addEventListener("click", () => {
        // 인앱 브라우저(카카오톡 등)에서는 구글 OAuth가 차단되므로 외부 브라우저로 유도
        if (typeof InAppBrowser !== "undefined" && InAppBrowser.isInApp()) {
          handleInAppLogin();
          return;
        }
        Account.signInWithGoogle();
      });
      wrap.appendChild(btn);
      return;
    }

    // 로그인했지만 프로필(닉네임)이 아직 없으면 설정 모달 띄우기
    if (!Account.hasProfile()) {
      openProfileSetup();
      return;
    }

    // 로그인 + 프로필 있음 → 닉네임 태그(테마 색 테두리) + 마이페이지 진입
    const p = Account.getProfile();
    const tag = document.createElement("button");
    tag.type = "button";
    tag.className = "nick-tag";
    tag.style.setProperty("--theme", lineColor(p.theme_line));
    tag.innerHTML = `<span class="nick-dot"></span><span class="nick-text">${escapeHtml(p.nickname)}</span>`;
    tag.title = "마이페이지 열기";
    tag.addEventListener("click", openMyPage);
    wrap.appendChild(tag);
  }

  /* ---------- 닉네임 태그(랭킹/목록에서 재사용) ---------- */
  function nickTagHTML(nickname, themeLine) {
    const color = lineColor(themeLine);
    return `<span class="nick-tag static" style="--theme:${color}">
      <span class="nick-dot"></span><span class="nick-text">${escapeHtml(nickname)}</span>
    </span>`;
  }

  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ---------- 테마 노선 선택 그리드 ---------- */
  function buildThemePicker(container, selectedId, onPick) {
    container.innerHTML = "";
    for (const line of LINES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "theme-swatch" + (line.id === selectedId ? " selected" : "");
      b.style.setProperty("--c", line.color);
      b.style.setProperty("--t", line.darkText ? "#23262b" : "#fff");
      b.dataset.id = line.id;
      b.innerHTML = `<span class="theme-badge">${line.badge}</span><span class="theme-name">${line.name}</span>`;
      b.addEventListener("click", () => {
        container.querySelectorAll(".theme-swatch").forEach(x => x.classList.remove("selected"));
        b.classList.add("selected");
        onPick(line.id);
      });
      container.appendChild(b);
    }
  }

  /* ---------- 첫 로그인: 프로필 설정 모달 ---------- */
  function openProfileSetup() {
    let chosenTheme = "L1";
    const modal = $("#profile-modal");
    modal.querySelector(".modal-title").textContent = "환영합니다! 프로필을 만들어요";
    const nickInput = $("#profile-nick");
    nickInput.value = "";
    const err = $("#profile-error");
    err.textContent = "";
    buildThemePicker($("#profile-theme-grid"), chosenTheme, id => { chosenTheme = id; });

    const saveBtn = $("#profile-save");
    saveBtn.textContent = "시작하기";
    saveBtn.onclick = async () => {
      err.textContent = "";
      saveBtn.disabled = true;
      const res = await Account.createProfile(nickInput.value, chosenTheme);
      saveBtn.disabled = false;
      if (res.ok) { closeModal("#profile-modal"); renderAccountButton(); }
      else err.textContent = res.message || "오류가 발생했어요.";
    };
    // 프로필 설정은 닫기 버튼 대신 로그아웃만 가능(닉네임 없으면 못 씀)
    $("#profile-cancel").onclick = async () => { await Account.signOut(); closeModal("#profile-modal"); };

    openModal("#profile-modal");
    nickInput.focus();
  }

  /* ---------- 마이페이지 모달 ---------- */
  async function openMyPage() {
    const p = Account.getProfile();
    if (!p) return;
    openModal("#mypage-modal");

    // 헤더: 닉네임 태그 + 이메일
    $("#mypage-nicktag").innerHTML = nickTagHTML(p.nickname, p.theme_line);
    $("#mypage-email").textContent = Account.getEmail() || "";

    // 테마 노선 변경기
    let chosen = p.theme_line;
    buildThemePicker($("#mypage-theme-grid"), chosen, async id => {
      chosen = id;
      const ok = await Account.updateThemeLine(id);
      if (ok) { $("#mypage-nicktag").innerHTML = nickTagHTML(p.nickname, id); renderAccountButton(); }
    });

    // 닉네임 변경
    const nick = $("#mypage-nick");
    nick.value = p.nickname;
    $("#mypage-nick-save").onclick = async () => {
      const res = await Account.updateNickname(nick.value);
      const m = $("#mypage-nick-msg");
      m.textContent = res.ok ? "변경했어요!" : res.message;
      m.className = "field-msg " + (res.ok ? "ok" : "no");
      if (res.ok) { $("#mypage-nicktag").innerHTML = nickTagHTML(nick.value.trim(), chosen); renderAccountButton(); }
    };

    // 최고점 요약 (지역+모드별)
    const best = await Account.myBest();
    const bestLabel = {};
    const bestOrder = [];
    for (const [region, label] of Object.entries(REGION_LABELS)) {
      const hasCore = regionSupportsCore(region);
      if (hasCore) {
        bestLabel[`${region}:core`] = `${label} 1~9호선`;
        bestOrder.push(`${region}:core`);
      }
      for (const mode of ["all", "custom"]) {
        bestLabel[`${region}:${mode}`] = `${label} ${mode === "all" ? "전체" : "커스텀"}`;
        bestOrder.push(`${region}:${mode}`);
      }
    }
    $("#mypage-best").innerHTML = bestOrder
      .filter(k => best[k] !== undefined)
      .map(k => `<div class="best-card"><span class="best-mode">${bestLabel[k] || k}</span><span class="best-score">${best[k]}</span><span class="best-unit">역</span></div>`)
      .join("") || `<p class="muted">아직 기록이 없어요. 1분 도전 모드를 플레이해보세요!</p>`;

    // 플레이 기록 목록
    const plays = await Account.myPlays(50);
    const list = $("#mypage-plays");
    if (plays.length === 0) {
      list.innerHTML = `<p class="muted">시간제한 모드 기록이 여기에 쌓여요.</p>`;
    } else {
      list.innerHTML = plays.map(pl => {
        const d = new Date(pl.created_at);
        const date = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
        return `<div class="play-row">
          <span class="play-score">${pl.score}역</span>
          <span class="play-mode">${escapeHtml(pl.mode_label)}</span>
          <span class="play-date">${date}</span>
        </div>`;
      }).join("");
    }

    $("#mypage-logout").onclick = async () => { await Account.signOut(); closeModal("#mypage-modal"); renderAccountButton(); };
  }

  /* ---------- 랭킹 모달 ---------- */
  let rankRegion = "seoul";  // 랭킹에서 보고 있는 지역
  let rankTab = "core";      // 랭킹에서 보고 있는 노선 범위(core/all)

  async function openRanking() {
    openModal("#ranking-modal");
    $("#ranking-reset").textContent = "⏳ " + Account.nextResetText();
    // 게임에서 현재 선택한 지역으로 시작 (없으면 수도권)
    const cur = (typeof State !== "undefined" && State.region) ? State.region : "seoul";
    setRankRegion(cur);
  }

  function setRankRegion(region) {
    rankRegion = region;
    document.querySelectorAll(".rank-region-tab").forEach(t =>
      t.classList.toggle("active", t.dataset.region === region));

    const hasCore = regionSupportsCore(region);
    const coreTab = document.querySelector('.rank-tab[data-mode="core"]');
    if (coreTab) coreTab.style.display = hasCore ? "" : "none";
    if (!hasCore) rankTab = "all";
    else if (rankTab !== "core" && rankTab !== "all") rankTab = "core";
    setRankTab(rankTab);
  }

  function setRankTab(mode) {
    rankTab = mode;
    document.querySelectorAll(".rank-tab").forEach(t =>
      t.classList.toggle("active", t.dataset.mode === mode));
    loadRanking();
  }

  async function loadRanking() {
    const body = $("#ranking-body");
    body.innerHTML = `<p class="muted">불러오는 중…</p>`;
    if (!Account.isConfigured()) {
      body.innerHTML = `<p class="muted">랭킹을 쓰려면 먼저 Supabase 설정이 필요해요.</p>`;
      return;
    }
    // DB에는 region별 mode를 합쳐 "seoul:core" 같은 키로 저장한다.
    const rankKey = `${rankRegion}:${rankTab}`;
    const rows = await Account.weeklyRanking(rankKey, 50);
    const myId = Account.getProfile()?.id;
    if (rows.length === 0) {
      body.innerHTML = `<p class="muted">이번 주 기록이 아직 없어요. 첫 주자가 되어보세요!</p>`;
      return;
    }
    body.innerHTML = rows.map(r => {
      const medal = r.rank === 1 ? "🥇" : r.rank === 2 ? "🥈" : r.rank === 3 ? "🥉" : `${r.rank}`;
      const mine = myId && r.user_id === myId ? " mine" : "";
      return `<div class="rank-row${mine}">
        <span class="rank-num">${medal}</span>
        <span class="rank-nick">${nickTagHTML(r.nickname, r.theme_line)}</span>
        <span class="rank-score">${r.best_score}<small>역</small></span>
      </div>`;
    }).join("");
  }

  /* ---------- 모달 공통 ---------- */
  function openModal(sel) { $(sel).classList.add("show"); document.body.classList.add("modal-open"); }
  function closeModal(sel) { $(sel).classList.remove("show"); if (!document.querySelector(".modal-backdrop.show")) document.body.classList.remove("modal-open"); }

  /* ---------- game.js가 호출하는 훅 ---------- */
  // 시간제한 모드 한 판이 끝나면 game.js가 이걸 부른다.
  window.onPlayFinished = async ({ score, region, mode, modeLabel, playMode }) => {
    if (playMode !== "timed") return;          // 연속 모드는 저장 안 함
    if (!Account.isLoggedIn() || !Account.hasProfile()) return; // 비로그인은 저장 안 함
    // 랭킹/기록 구분을 위해 region을 함께 저장. rankMode = "지역:모드"
    const rankMode = `${region || "seoul"}:${mode}`;
    await Account.savePlay({ score, region: region || "seoul", mode, rankMode, modeLabel });
  };

  /* ---------- 초기화 ---------- */
  document.addEventListener("DOMContentLoaded", () => {
    // 버튼 연결
    $("#btn-ranking")?.addEventListener("click", openRanking);
    $("#btn-ranking-end")?.addEventListener("click", openRanking);

    document.querySelectorAll(".rank-tab").forEach(t =>
      t.addEventListener("click", () => setRankTab(t.dataset.mode)));
    document.querySelectorAll(".rank-region-tab").forEach(t =>
      t.addEventListener("click", () => setRankRegion(t.dataset.region)));

    // 모달 닫기 버튼 / 배경 클릭
    document.querySelectorAll("[data-close-modal]").forEach(btn =>
      btn.addEventListener("click", () => closeModal("#" + btn.dataset.closeModal)));
    document.querySelectorAll(".modal-backdrop").forEach(bd =>
      bd.addEventListener("click", e => { if (e.target === bd) closeModal("#" + bd.id); }));

    // 인앱 안내 모달: 주소 복사 버튼
    $("#inapp-copy")?.addEventListener("click", async () => {
      const urlBox = $("#inapp-url");
      try {
        await navigator.clipboard.writeText(urlBox.value);
        $("#inapp-copy").textContent = "복사됨!";
        setTimeout(() => { $("#inapp-copy").textContent = "주소 복사"; }, 1500);
      } catch (e) {
        urlBox.select(); document.execCommand("copy");
        $("#inapp-copy").textContent = "복사됨!";
        setTimeout(() => { $("#inapp-copy").textContent = "주소 복사"; }, 1500);
      }
    });
    // 인앱 안내 모달: 외부 브라우저로 열기 다시 시도
    $("#inapp-open")?.addEventListener("click", () => {
      if (typeof InAppBrowser !== "undefined") InAppBrowser.tryEscape(location.href);
    });

    // 인앱 브라우저에서 처음 들어온 경우, 상단에 작은 안내 배너 표시
    if (typeof InAppBrowser !== "undefined" && InAppBrowser.isInApp() && Account.isConfigured()) {
      showInAppBanner();
    }

    // 로그인/프로필 상태가 바뀌면 버튼 다시 그림
    Account.onChange(renderAccountButton);
    Account.init().then(renderAccountButton);
  });

  function showInAppBanner() {
    const banner = $("#inapp-banner");
    if (!banner) return;
    const name = InAppBrowser.label() || "인앱 브라우저";
    const txt = $("#inapp-banner-text");
    if (txt) txt.innerHTML = `${escapeHtml(name)}에서는 구글 로그인이 안 돼요. <u>외부 브라우저로 열기</u>`;
    banner.classList.add("show");
    banner.addEventListener("click", (e) => {
      if (e.target.closest("#inapp-banner-close")) { banner.classList.remove("show"); return; }
      // 배너 본문 클릭 → 외부 브라우저 시도/안내
      handleInAppLogin();
    });
  }

  // 다른 스크립트에서 쓸 수 있게 일부 노출
  window.AccountUI = { renderAccountButton, openRanking, openMyPage };
})();
