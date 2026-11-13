// Runs the extension's background logic in Node with a fake `chrome`, feeding it synthetic frames.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const listeners = {};
const ev = (name) => ({ addListener: (fn) => (listeners[name] = fn) });
const clicks = [];
const typed = [];
let page = new Set(); // selectors currently "on screen"
const store = {};
globalThis.chrome = {
  runtime: { getURL: (f) => f, onMessage: ev('message'), onStartup: ev('startup'), onInstalled: ev('installed') },
  storage: { local: { get: async () => store, set: async (o) => Object.assign(store, o) } },
  alarms: { create() {}, onAlarm: ev('alarm') },
  tabs: { query: async () => [{ id: 7, status: 'loading' }], onUpdated: ev('updated'), onRemoved: ev('removed') },
  debugger: {
    attach: async () => {},
    detach: async () => {},
    onEvent: ev('event'),
    onDetach: ev('detach'),
    sendCommand: async (target, method, params) => {
      if (method === 'Runtime.evaluate') {
        const sel = JSON.parse(/const step = (.*);/.exec(params.expression)[1]).selector;
        return { result: { value: page.has(sel) ? { x: 10, y: 20 } : null } };
      }
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') clicks.push(pending);
      if (method === 'Input.insertText') typed.push(params.text);
      return {};
    },
  },
};
let pending = null;
const realSend = chrome.debugger.sendCommand;
chrome.debugger.sendCommand = async (t, m, p) => {
  if (m === 'Runtime.evaluate') pending = JSON.parse(/const step = (.*);/.exec(p.expression)[1]).selector;
  return realSend(t, m, p);
};
globalThis.fetch = async (file) => ({ json: async () => JSON.parse(readFileSync(new URL('../extension/' + file, import.meta.url), 'utf8')) });

await import('../extension/background.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(100);

const pkt = (id, size, fill) => {
  const b = Buffer.alloc(size);
  b.writeUInt16LE(id, 0);
  fill?.(b);
  return b;
};
const frame = (dir, buf) => listeners.event({ tabId: 7 }, 'Network.webSocketFrame' + dir, { requestId: 'r1', response: { opcode: 2, payloadData: buf.toString('base64') } });
const ask = (msg) => new Promise((resolve) => listeners.message(msg, {}, resolve));
const AID = 77;
const map = (m) => frame('Received', pkt(0x91, 22, (b) => b.write(m + '.gat', 2, 'latin1')));
const buff = (on) => frame('Received', pkt(0x983, 29, (b) => (b.writeInt16LE(3, 2), b.writeUInt32LE(AID, 4), (b[8] = on), b.writeUInt32LE(240000, 13))));

frame('Sent', pkt(0x65, 17, (b) => b.writeUInt32LE(AID, 2)));
frame('Received', Buffer.concat([Buffer.alloc(4), pkt(0xb72, 179, (b) => (b.writeUInt16LE(179, 2), b.writeUInt32LE(5, 4), b.write('chics', 112, 'latin1'))), pkt(0xac5, 156, (b) => (b.writeUInt32LE(5, 2), b.write('gl_dun01.gat', 6, 'latin1')))]));
frame('Received', pkt(0xb0, 8, (b) => (b.writeUInt16LE(5, 2), b.writeInt32LE(900, 4))));
buff(1);

let res = await ask({ t: 'state' });
assert.equal(res.state.name, 'chics');
assert.equal(res.state.map, 'gl_dun01');
assert.equal(res.state.hp, 900);
assert.deepEqual(res.state.buffs.map((b) => b.name), ['CONCENTRATION']);
assert.equal(res.connected, true);
assert.deepEqual(store.known, [[AID, 'chics']]);

const buffId = (id, on) => frame('Received', pkt(0x983, 29, (b) => (b.writeInt16LE(id, 2), b.writeUInt32LE(AID, 4), (b[8] = on), b.writeUInt32LE(240000, 13))));

// --- trip 1: defaults (wait for the buff that ended, travel to the map we left) ---
page = new Set(['button.hb-voltar']);
buff(0); // expires -> return click
await sleep(700);
assert.deepEqual(clicks, ['button.hb-voltar']);
map('morocc');
map('morocc'); // the server announces the arrival twice
await sleep(300);
assert.equal((await ask({ t: 'state' })).trip, 'city');
assert.equal(clicks.length, 1, 'must wait for the buff');

page = new Set(['button.hb-cacar', 'button.hm-btn-go[data-mapa="gl_dun01"]']);
buff(1); // buff back -> travel after backAfter (1s)
await sleep(2500);
assert.deepEqual(clicks.slice(1), ['button.hb-cacar', 'button.hm-btn-go[data-mapa="gl_dun01"]']);
map('gl_dun01');
res = await ask({ t: 'state' });
assert.equal(res.trip, null);

// --- trip 2: required buff list with aliases, and a preset map searched by name ---
res = await ask({ t: 'settings', settings: { require: 'bless, CONCENTRATION, agi_up, NOPE', map: 'sting', backAfter: 0 } });
assert.deepEqual(res.unknownNames, ['NOPE']);
await ask({ t: 'settings', settings: { require: 'bless, CONCENTRATION, agi_up' } });
clicks.length = 0;
typed.length = 0;
page = new Set(['button.hb-voltar']);
buff(0);
await sleep(700);
map('morocc');
page = new Set(['button.hb-cacar', 'input.hm-search', '.hm-list .hm-card', 'button.hm-btn-go']);
buff(1); // CONCENTRATION back, still missing BLESSING and INC_AGI
buffId(10, 1); // BLESSING
await sleep(300);
res = await ask({ t: 'state' });
assert.equal(res.trip, 'city');
assert.deepEqual(res.waitingFor, ['INC_AGI']);
assert.equal(clicks.length, 1);
buffId(12, 1); // INC_AGI -> all three active
await sleep(4500);
assert.deepEqual(clicks.slice(1), ['button.hb-cacar', 'input.hm-search', '.hm-list .hm-card', 'button.hm-btn-go']);
assert.deepEqual(typed, ['sting']);
map('gl_dun01');
res = await ask({ t: 'state' });
assert.equal(res.trip, null);

// --- trip 3: HP below the threshold, back when HP is full again ---
const par = (varId, v) => frame('Received', pkt(0xb0, 8, (b) => (b.writeUInt16LE(varId, 2), b.writeInt32LE(v, 4))));
await ask({ t: 'settings', settings: { hpBelow: 40 } });
clicks.length = 0;
typed.length = 0;
page = new Set(['button.hb-voltar']);
par(6, 1000); // max HP
par(5, 500); // 50%: fine
await sleep(300);
assert.equal(clicks.length, 0);
par(5, 300); // 30% -> return
par(5, 250); // still low: must not press return again
await sleep(700);
assert.deepEqual(clicks, ['button.hb-voltar']);
map('prontera');
await sleep(300);
res = await ask({ t: 'state' });
assert.equal(res.trip, 'city');
assert.deepEqual(res.waitingFor, ['full HP']);
page = new Set(['button.hb-cacar', 'input.hm-search', '.hm-list .hm-card', 'button.hm-btn-go']);
par(5, 900);
await sleep(300);
assert.equal(clicks.length, 1, 'must wait for full HP');
par(5, 1000);
await sleep(4500);
assert.deepEqual(clicks.slice(1), ['button.hb-cacar', 'input.hm-search', '.hm-list .hm-card', 'button.hm-btn-go']);
map('gl_dun01');
res = await ask({ t: 'state' });
assert.equal(res.trip, null);
page = new Set(['button.hb-voltar']);
par(5, 300); // low again on the next hunt -> returns again
await sleep(700);
assert.equal(clicks.at(-1), 'button.hb-voltar');
assert.equal(clicks.length, 6);

console.log('extension selftest ok');
console.log(res.log.map((l) => '  ' + l.msg).join('\n'));
process.exit(0);
