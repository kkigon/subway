const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// backend.js notify()는 로그인/프로필 변경 구독자에게 알린다. R3에서 listeners.slice()
// 스냅샷 순회로 바꾼 이유: 구독자가 콜백 안에서 offChange로 자신을 제거하면(ensureAccountReady의
// one-shot 핸들러) 원본 배열이 iteration 중 splice돼 바로 다음 구독자가 건너뛰어졌다.
// 이 테스트가 그 재진입 수정을 고정한다. (Supabase 미설정 경로에서 init()이 notify()를 1회 호출)
const source = fs.readFileSync(path.join(__dirname, "..", "js", "backend.js"), "utf8");

function loadAccount() {
  // SUPABASE_URL/ANON_KEY 미정의 → configured() false → init()은 notify() 후 조기 반환(네트워크 없음).
  const sandbox = { console: { warn() {}, log() {}, error() {} }, window: {} };
  vm.createContext(sandbox);
  vm.runInContext(`${source}\nthis.Account = Account;`, sandbox);
  return sandbox.Account;
}

(async () => {
  const Account = loadAccount();

  const order = [];
  const h1 = () => { order.push("h1"); Account.offChange(h1); };  // 디스패치 도중 자기 자신 제거
  const h2 = () => { order.push("h2"); };
  Account.onChange(h1);
  Account.onChange(h2);

  await Account.init();   // 미설정 경로 → notify() 1회
  // slice 스냅샷이 아니면 h1의 splice로 h2가 건너뛰어져 order === ["h1"]가 된다.
  assert.deepEqual(order, ["h1", "h2"], "h1이 디스패치 중 자신을 제거해도 h2는 호출된다");

  order.length = 0;
  await Account.init();   // 다시 notify(): h1은 이미 해제됨
  assert.deepEqual(order, ["h2"], "해제된 h1은 더 이상 호출되지 않고 h2만 남는다");

  // 던지는 구독자가 있어도 나머지는 계속 호출(try/catch)
  order.length = 0;
  const boom = () => { order.push("boom"); throw new Error("x"); };
  const h3 = () => { order.push("h3"); };
  Account.onChange(boom);
  Account.onChange(h3);
  await Account.init();
  assert.deepEqual(order, ["h2", "boom", "h3"], "throw하는 구독자가 있어도 뒤 구독자까지 호출");

  console.log("backend notify tests: ok");
})().catch(e => { console.error(e); process.exit(1); });
