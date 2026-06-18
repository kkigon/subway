/* ============================================================
   inapp-browser.js — 인앱 브라우저(카카오톡 등) 감지 & 외부 브라우저 탈출
   ------------------------------------------------------------
   구글 OAuth는 카카오톡·네이버·인스타 등 "앱 내장 웹뷰"에서 차단된다
   (403 disallowed_useragent). 이 유틸은 인앱 브라우저를 감지해서:
     - 카카오톡: 외부 브라우저로 현재 페이지를 강제로 다시 연다
     - 그 외:   "크롬/사파리로 열어주세요" 안내를 돕는다
   ============================================================ */

const InAppBrowser = (() => {
  const ua = (navigator.userAgent || "").toLowerCase();

  // 주요 인앱 브라우저 식별자
  const matchers = [
    { key: "kakaotalk", label: "카카오톡", test: /kakaotalk/ },
    { key: "naver",     label: "네이버 앱", test: /naver\(inapp|inapp.*naver|naver/ },
    { key: "line",      label: "라인",     test: /\bline\//ig },
    { key: "instagram", label: "인스타그램", test: /instagram/ },
    { key: "facebook",  label: "페이스북",   test: /fban|fbav|fb_iab/ },
    { key: "band",      label: "밴드",     test: /\bband\b/ },
    { key: "everytime", label: "에브리타임", test: /everytime/ },
    { key: "daum",      label: "다음 앱",   test: /daumapps/ },
    { key: "kakaostory",label: "카카오스토리", test: /kakaostory/ },
  ];

  let matched = null;
  for (const m of matchers) {
    if (m.test.test(ua)) { matched = m; break; }
  }

  function isInApp() { return !!matched; }
  function key() { return matched ? matched.key : null; }
  function label() { return matched ? matched.label : null; }
  function isKakao() { return matched && matched.key === "kakaotalk"; }
  function isIOS() { return /iphone|ipad|ipod/.test(ua); }
  function isAndroid() { return /android/.test(ua); }

  // 외부 브라우저로 현재(또는 지정) URL을 다시 연다.
  // 반환값 true = 탈출 시도함(주로 카카오톡), false = 직접 탈출 불가(안내 필요)
  function tryEscape(targetUrl) {
    const url = targetUrl || location.href;

    // 카카오톡: 전용 스킴으로 외부 브라우저(기본 브라우저) 강제 오픈
    if (isKakao()) {
      location.href = "kakaotalk://web/openExternal?url=" + encodeURIComponent(url);
      return true;
    }

    // 라인: 외부 브라우저 파라미터
    if (key() === "line") {
      const sep = url.indexOf("?") === -1 ? "?" : "&";
      location.href = url + sep + "openExternalBrowser=1";
      return true;
    }

    // 안드로이드 크롬 인텐트 (네이버·기타 안드로이드 인앱에서 종종 동작)
    if (isAndroid()) {
      const noScheme = url.replace(/^https?:\/\//, "");
      location.href = "intent://" + noScheme +
        "#Intent;scheme=https;package=com.android.chrome;end";
      return true;
    }

    // iOS의 기타 인앱 브라우저는 프로그램적 강제 탈출이 막혀 있음 → 안내만 가능
    return false;
  }

  return { isInApp, key, label, isKakao, isIOS, isAndroid, tryEscape };
})();
