const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// settings.js는 사운드 on/off를 관장하고(GameSettings.isSoundEnabled()가 모든 게임 오디오를
// 게이트한다), localStorage를 로드/토글 시 읽고 쓴다. 런타임 커버리지가 0이었다(플릿 R1 QA).
// 특히 프라이빗 모드/저장소 차단 시 throw 경로가 조용히 깨지면 눈에 안 보인다.
const source = fs.readFileSync(path.join(__dirname, "..", "js", "settings.js"), "utf8");

// DOM 없이 로드되도록 최소 stub. localStorage 동작을 주입해 각 시나리오를 재현.
function load(localStorageImpl) {
  const sandbox = {
    localStorage: localStorageImpl,
    document: {
      addEventListener() {},                 // DOMContentLoaded/keydown 등록 — 테스트에선 안 쏨
      querySelector() { return null; },
      body: { classList: { add() {}, remove() {} } },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${source}\nthis.GameSettings = GameSettings;`, sandbox);
  return sandbox.GameSettings;
}

/* ---------- 정상 저장소 ---------- */
{
  const store = new Map();
  const ls = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const S = load(ls);
  assert.equal(S.isSoundEnabled(), true, "기본값 ON");
  let heard = null;
  S.onSoundChange(v => { heard = v; });
  assert.equal(S.setSoundEnabled(false), false, "off로 토글 반환값");
  assert.equal(S.isSoundEnabled(), false, "상태 반영");
  assert.equal(store.get("subwaySoundEnabled"), "false", "localStorage에 기록");
  assert.equal(heard, false, "리스너가 새 상태로 호출됨");
}

/* ---------- 저장된 "false" 로드 ---------- */
{
  const ls = { getItem: () => "false", setItem: () => {} };
  const S = load(ls);
  assert.equal(S.isSoundEnabled(), false, "저장된 false를 로드");
}

/* ---------- 저장소 차단(throw) — 프라이빗 모드/잠금 WebView ---------- */
{
  const ls = {
    getItem() { throw new Error("SecurityError"); },
    setItem() { throw new Error("QuotaExceeded"); },
  };
  // 로드가 throw로 죽지 않아야 한다
  let S;
  assert.doesNotThrow(() => { S = load(ls); }, "throw하는 localStorage에서도 모듈 로드 성공");
  assert.equal(S.isSoundEnabled(), true, "읽기 실패 시 기본 ON");
  let heard = null;
  S.onSoundChange(v => { heard = v; });
  // 쓰기가 throw해도 상태 변경 + 리스너 통지는 정상 동작해야 한다
  assert.doesNotThrow(() => S.setSoundEnabled(false), "쓰기 throw여도 토글은 안 죽음");
  assert.equal(S.isSoundEnabled(), false, "쓰기 실패해도 메모리 상태는 반영");
  assert.equal(heard, false, "쓰기 실패해도 리스너 통지");
}

console.log("settings tests: ok");
