const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// inapp-browser.js는 인앱 웹뷰 감지 + 외부 브라우저 탈출을 담당한다. 잘못 감지하면
// 구글 OAuth가 막힌 웹뷰에 사용자를 가두거나, 멀쩡한 브라우저를 불필요하게 리다이렉트한다.
// 지금까지 런타임 커버리지가 0이었다(레드팀 R1). 이 테스트가 그 공백을 메운다.
const source = fs.readFileSync(path.join(__dirname, "..", "js", "inapp-browser.js"), "utf8");

// 주어진 UA로 모듈을 새로 실행하고 { InAppBrowser, location }을 돌려준다.
function load(ua) {
  const location = { href: "https://example.com/game" };
  const sandbox = { navigator: { userAgent: ua }, location };
  vm.createContext(sandbox);
  vm.runInContext(`${source}\nthis.InAppBrowser = InAppBrowser;`, sandbox);
  return { app: sandbox.InAppBrowser, location };
}

const UA = {
  kakao: "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/108 Mobile Safari/537.36 KAKAOTALK 10.4.5",
  line: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1 Mobile/15E148 Line/12.19.1",
  instagram: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1 Mobile Instagram 250.0.0.21.109",
  naverAndroid: "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/110 Mobile Safari/537.36 NAVER(inapp; search; 1234; 12.0.0)",
  facebook: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1 [FBAN/FBIOS;FBAV/400.0]",
  chrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  safariIOS: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1 Version/16.0 Mobile/15E148 Safari/604.1",
};

/* ---------- 감지 ---------- */
assert.equal(load(UA.kakao).app.isInApp(), true, "카카오톡 감지");
assert.equal(load(UA.kakao).app.key(), "kakaotalk");
assert.equal(load(UA.kakao).app.isKakao(), true);
assert.equal(load(UA.line).app.key(), "line");
assert.equal(load(UA.instagram).app.key(), "instagram");
assert.equal(load(UA.naverAndroid).app.key(), "naver");
assert.equal(load(UA.facebook).app.key(), "facebook");

// 일반 브라우저는 인앱이 아니어야 한다 (오탐 방지)
assert.equal(load(UA.chrome).app.isInApp(), false, "데스크톱 크롬은 인앱 아님");
assert.equal(load(UA.chrome).app.key(), null);
assert.equal(load(UA.safariIOS).app.isInApp(), false, "iOS 사파리는 인앱 아님");

/* ---------- 플랫폼 ---------- */
assert.equal(load(UA.line).app.isIOS(), true);
assert.equal(load(UA.naverAndroid).app.isAndroid(), true);
assert.equal(load(UA.chrome).app.isIOS(), false);

/* ---------- 외부 브라우저 탈출 ---------- */
// 카카오톡: 전용 스킴으로 리다이렉트, true 반환
{
  const { app, location } = load(UA.kakao);
  assert.equal(app.tryEscape(), true, "카카오톡 탈출 시도");
  assert.ok(location.href.startsWith("kakaotalk://web/openExternal?url="), "카카오 스킴 리다이렉트");
  assert.ok(location.href.includes(encodeURIComponent("https://example.com/game")));
}
// 라인: openExternalBrowser=1 파라미터 추가
{
  const { app, location } = load(UA.line);
  assert.equal(app.tryEscape(), true, "라인 탈출 시도");
  assert.ok(location.href.includes("openExternalBrowser=1"), "라인 외부 브라우저 파라미터");
}
// 안드로이드 인앱(네이버): intent:// 로 크롬 강제
{
  const { app, location } = load(UA.naverAndroid);
  assert.equal(app.tryEscape(), true, "안드로이드 인텐트 탈출");
  assert.ok(location.href.startsWith("intent://"), "안드로이드 chrome intent");
  assert.ok(location.href.includes("package=com.android.chrome"));
}
// iOS 기타 인앱(인스타/페북): 프로그램적 탈출 불가 → false (안내만)
{
  const { app } = load(UA.instagram);
  assert.equal(app.tryEscape(), false, "iOS 인스타는 자동 탈출 불가");
}

console.log("inapp browser detection tests: ok");
