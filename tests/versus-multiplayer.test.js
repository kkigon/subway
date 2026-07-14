const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "js", "versus.js"), "utf8");

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

class RealtimeHub {
  constructor() {
    this.channels = new Set();
    this.presence = new Map();
  }

  add(channel) { this.channels.add(channel); }
  remove(channel) {
    this.channels.delete(channel);
    this.untrack(channel);
  }
  track(channel, payload) {
    if (!this.presence.has(channel.topic)) this.presence.set(channel.topic, new Map());
    this.presence.get(channel.topic).set(channel.key, payload);
    this.emit(channel.topic, "presence", "sync", {});
  }
  untrack(channel) {
    const state = this.presence.get(channel.topic);
    if (state && state.delete(channel.key)) this.emit(channel.topic, "presence", "sync", {});
  }
  state(topic) {
    const result = {};
    for (const [key, payload] of this.presence.get(topic) || []) result[key] = [payload];
    return result;
  }
  emit(topic, type, event, payload) {
    for (const channel of this.channels) {
      if (channel.topic === topic) channel.emit(type, event, payload);
    }
  }
}

class MockChannel {
  constructor(hub, topic, options) {
    this.hub = hub;
    this.topic = topic;
    this.key = options?.config?.presence?.key || topic;
    this.handlers = [];
    hub.add(this);
  }
  on(type, filter, callback) {
    this.handlers.push({ type, event: filter.event, callback });
    return this;
  }
  emit(type, event, payload) {
    for (const handler of this.handlers) {
      if (handler.type === type && handler.event === event) handler.callback(payload);
    }
  }
  subscribe(callback) {
    queueMicrotask(() => callback("SUBSCRIBED"));
    return this;
  }
  async track(payload) { this.hub.track(this, payload); return "ok"; }
  async untrack() { this.hub.untrack(this); return "ok"; }
  presenceState() { return this.hub.state(this.topic); }
  async send(message) {
    this.hub.emit(this.topic, "broadcast", message.event, { payload: message.payload });
    return "ok";
  }
}

function makeClient(db, hub) {
  return {
    failNextTransfer: false,
    channel(topic, options) { return new MockChannel(hub, topic, options); },
    async removeChannel(channel) { hub.remove(channel); return "ok"; },
    from(table) {
      assert.equal(table, "rooms");
      const chain = {
        select() { return chain; },
        eq(_column, code) { chain.code = code; return chain; },
        async maybeSingle() { return { data: db.rooms.get(chain.code) || null, error: null }; },
      };
      return chain;
    },
    async rpc(name, args) {
      if (name === "room_create") {
        const row = {
          code: args.p_code, host_id: args.p_host, host_name: args.p_host_name,
          host_revision: 0, region: args.p_region, mode: "all", duration_sec: 90,
          play_mode: "timed", status: "waiting",
        };
        db.rooms.set(row.code, row);
        return { data: { ...row }, error: null };
      }
      if (name === "room_transfer_host") {
        if (this.failNextTransfer) {
          this.failNextTransfer = false;
          return { data: null, error: { code: "40001", message: "host changed" } };
        }
        const current = db.rooms.get(args.p_room);
        if (!current || current.host_id !== args.p_current_host) {
          return { data: null, error: { code: "40001", message: "host changed" } };
        }
        const row = {
          ...current, host_id: args.p_new_host, host_name: args.p_new_host_name,
          host_revision: current.host_revision + 1,
        };
        db.rooms.set(row.code, row);
        return { data: { ...row }, error: null };
      }
      if (name === "room_delete") {
        const current = db.rooms.get(args.p_room);
        if (current?.host_id === args.p_host) db.rooms.delete(args.p_room);
        return { data: true, error: null };
      }
      if (name === "vs_sync") return { data: null, error: null };
      throw new Error(`unexpected rpc: ${name}`);
    },
  };
}

let uuidCounter = 0;
function makeBrowser(db, hub, name) {
  const client = makeClient(db, hub);
  const sandbox = {
    Account: {
      getClient: () => client,
      getUserId: () => null,
      isLoggedIn: () => false,
      getProfile: () => null,
    },
    State: { region: "seoul" },
    location: { href: "https://example.test/", pathname: "/" },
    localStorage: new MemoryStorage(),
    sessionStorage: new MemoryStorage(),
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    console: { warn: () => {} },
  };
  sandbox.localStorage.setItem("guestName", name);
  sandbox.window = {
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}` },
    VersusGame: {
      resolveLineIds: () => ["L1"],
      buildOrder: () => [0],
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${source}\nthis.__Versus = Versus;`, sandbox, { filename: "versus.js" });
  return { Versus: sandbox.__Versus, client };
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

(async () => {
  const db = { rooms: new Map() };
  const hub = new RealtimeHub();
  const first = makeBrowser(db, hub, "첫째");
  const second = makeBrowser(db, hub, "둘째");

  assert.notEqual(first.Versus.myId(), second.Versus.myId(), "탭마다 참가자 id가 달라야 한다");

  const created = await first.Versus.createRoom();
  assert.equal(created.ok, true);
  const joined = await second.Versus.joinRoom(created.code);
  assert.equal(joined.ok, true);
  await flush();

  assert.equal(Array.from(first.Versus.getPlayers(), p => p.name).join("|"), "첫째|둘째");
  assert.equal(Array.from(second.Versus.getPlayers(), p => p.name).join("|"), "첫째|둘째");

  // 같은 전체 sync가 반복돼도 한 명씩 번갈아 사라지지 않는다.
  hub.emit(`room:${created.code}`, "presence", "sync", {});
  hub.emit(`room:${created.code}`, "presence", "sync", {});
  assert.equal(first.Versus.getPlayers().length, 2);
  assert.equal(second.Versus.getPlayers().length, 2);

  const transfer = await first.Versus.transferHost(second.Versus.myId());
  assert.equal(transfer.ok, true);
  await flush();
  assert.equal(first.Versus.getHostId(), second.Versus.myId());
  assert.equal(second.Versus.getHostId(), second.Versus.myId());

  // 다른 클라이언트가 예전 host_set 이벤트를 위조해도 DB 방장 표시는 바뀌지 않는다.
  hub.emit(`room:${created.code}`, "broadcast", "host_set", {
    payload: { hostId: "spoofed-player", hostName: "가짜 방장" },
  });
  assert.equal(first.Versus.getHostId(), second.Versus.myId());
  assert.equal(second.Versus.getHostId(), second.Versus.myId());

  // RPC가 실패하면 로컬 표시를 먼저 바꾸지 않는다.
  second.client.failNextTransfer = true;
  const failed = await second.Versus.transferHost(first.Versus.myId());
  assert.equal(failed.ok, false);
  assert.equal(second.Versus.getHostId(), second.Versus.myId());

  // 현재 방장이 명시적으로 나가면 남은 참가자에게 먼저 위임된다.
  await second.Versus.leaveRoom();
  await flush();
  assert.equal(first.Versus.getHostId(), first.Versus.myId());
  assert.equal(first.Versus.getPlayers().length, 1);

  console.log("versus multiplayer tests: ok");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
