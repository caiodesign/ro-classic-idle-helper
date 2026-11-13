// RO Classic Idle helper: everything runs here, no external program.
// It attaches the DevTools debugger to the game tab, decodes the game's WebSocket
// traffic (read-only) and, when a watched buff ends, clicks the HUD buttons to
// return to the city and travel back once the buff is active again.
import { GameState, PacketStream, configure } from './game-state.js';

const GAME_URL = 'https://play.roclassicidle.com.br/';
const SELECT = {
  returnToCity: 'button.hb-voltar',
  openHunt: 'button.hb-cacar',
  travel: 'button.hm-btn-go',
  search: 'input.hm-search',
  firstMap: '.hm-list .hm-card',
};

// ---- settings and log ------------------------------------------------------
// watch:   return to the city when any of these buffs ends
// require: travel back only when all of these are active (empty: just the buff that ended)
// map:     text typed in the hunting map search; the first result is the destination
//          (empty: use whatever map the hunting window has selected)
// hpBelow: return to the city when HP falls below this percentage (0: off); when set,
//          every trip also waits for full HP before travelling back
const DEFAULTS = { enabled: true, watch: 'CONCENTRATION', require: '', map: '', goBack: true, backAfter: 1, hpBelow: 0 };
let settings = { ...DEFAULTS };
let statusNames = new Set();
// Friendlier spellings for a few common buffs.
const ALIASES = { BLESS: 'BLESSING', AGI_UP: 'INC_AGI', AGIUP: 'INC_AGI', INCREASE_AGI: 'INC_AGI', AGI: 'INC_AGI' };
const names = (text) =>
  (text || '')
    .split(',')
    .map((n) => n.trim().toUpperCase().split(' ').join('_'))
    .filter(Boolean)
    .map((n) => ALIASES[n] ?? n);
const watched = () => names(settings.watch);
const unknownNames = () => [...names(settings.watch), ...names(settings.require)].filter((n) => !statusNames.has(n) && !n.startsWith('STATUS_'));

const log = [];
function say(msg) {
  log.push({ at: Date.now(), msg });
  if (log.length > 40) log.shift();
  console.log(msg);
}

// ---- game state ------------------------------------------------------------
const game = new GameState();
const sockets = new Map(); // "tabId:requestId" -> { inbound, outbound, gotData }
const unknownIds = new Set();

function socketFor(key) {
  let s = sockets.get(key);
  if (!s) {
    s = {
      gotData: false,
      inbound: new PacketStream(
        (id, p) => game.received(id, p),
        (id) => {
          if (unknownIds.has(id) || unknownIds.size >= 5) return;
          unknownIds.add(id);
          if (unknownIds.size === 5) say('Several unknown packets: the game client was probably updated (run node tools/gen-tables.mjs and reload the extension).');
        },
      ),
      outbound: new PacketStream((id, p) => {
        // The character server answers CH_ENTER with 4 raw bytes before its first packet.
        if (id === 0x65 && !s.gotData) s.inbound.skip = 4;
        game.sent(id, p);
      }),
    };
    sockets.set(key, s);
  }
  return s;
}

const fromBase64 = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

// ---- clicking HUD buttons --------------------------------------------------
// Finds a visible, enabled element by CSS selector and returns the centre of it in
// top-level viewport coordinates. The HUD lives in shadow roots (and possibly a
// same-origin frame), so the search walks into both.
//   first:  take the first match in document order instead of the last
//   select: also focus the element and select its text (for typing over it)
const LOCATE = (step) => `(() => {
  const step = ${JSON.stringify({ selector: step.selector, first: !!step.first, select: !!step.select })};
  const selector = step.selector;
  let found = null;
  const walk = (root, ox, oy) => {
    for (const el of root.querySelectorAll('*')) {
      if (found && step.first) return;
      if (el.shadowRoot) walk(el.shadowRoot, ox, oy);
      if (found && step.first) return;
      if (el.tagName === 'IFRAME') {
        try {
          const r = el.getBoundingClientRect();
          if (el.contentDocument) walk(el.contentDocument, ox + r.left, oy + r.top);
        } catch {}
        continue;
      }
      if (!el.matches(selector)) continue;
      if (el.getAttribute('aria-disabled') === 'true' || el.disabled) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      found = { x: ox + r.left + r.width / 2, y: oy + r.top + r.height / 2, mapa: (el.dataset && el.dataset.mapa) || null };
      if (step.select) {
        el.focus();
        if (el.select) el.select();
      }
    }
  };
  walk(document, 0, 0);
  return found;
})()`;

const attached = new Set(); // tabIds
const dismissed = new Set(); // tabs where the user closed the debugging banner
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Clicks a sequence of buttons. Each step waits up to `waitMs` for its button to
// show up; the sequence stops at the first miss. Resolves true when all were clicked.
async function click(steps) {
  if (!attached.size) {
    say('Not connected to a game tab.');
    return false;
  }
  let ok = true;
  for (const tabId of attached) {
    const target = { tabId };
    try {
      for (const step of steps) {
        const deadline = Date.now() + (step.waitMs ?? 0);
        let at = null;
        for (;;) {
          const { result } = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression: LOCATE({ ...step, select: false }), returnByValue: true });
          at = result?.value;
          if (at || Date.now() >= deadline) break;
          await pause(300);
        }
        if (!at) {
          say(`Button ${step.selector} not found on screen.`);
          ok = false;
          break;
        }
        const mouse = (type) => chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
        await mouse('mouseMoved');
        await mouse('mousePressed');
        await mouse('mouseReleased');
        if (step.type !== undefined) {
          // Replace whatever the field holds with the new text, as real typing would.
          await chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression: LOCATE({ ...step, select: true }), returnByValue: true });
          await chrome.debugger.sendCommand(target, 'Input.insertText', { text: step.type });
        }
        if (step.note && at.mapa) say(`${step.note} ${at.mapa}.`);
        await pause(step.settleMs ?? 400); // let the UI react before the next step
      }
    } catch (e) {
      say(`Click failed: ${e.message}`);
      ok = false;
    }
  }
  return ok;
}

const RETURN_STEPS = [{ selector: SELECT.returnToCity }];
// Open the hunting map and press its travel button.
// - With a map set in the options: search for it and pick the first result first.
// - Otherwise the travel button must point at the map we left (data-mapa), so we never
//   travel to a different map than the one we came from.
function backSteps(from) {
  const open = { selector: SELECT.openHunt, waitMs: 5000 };
  const search = settings.map.trim();
  if (search) {
    return [
      open,
      { selector: SELECT.search, waitMs: 5000, type: search, settleMs: 1200 },
      { selector: SELECT.firstMap, first: true, waitMs: 3000, note: 'Selected map' },
      { selector: SELECT.travel, waitMs: 5000 },
    ];
  }
  return [open, { selector: SELECT.travel + (from ? `[data-mapa="${from}"]` : ''), waitMs: 8000 }];
}

// ---- city trip -------------------------------------------------------------
// hunting -> (buff ends) -> returning -> (map changes) -> city -> (buff back) -> back -> hunting
let trip = null; // { phase, from, city, needs, needHp, timeout }
let hpLow = false; // set when low HP started a return; cleared once HP is back above the threshold

const hpLimit = () => Math.min(100, Math.max(0, Number(settings.hpBelow) || 0));
const hpPercent = () => {
  const { hp, maxHp } = game.state;
  return hp === null || !maxHp ? null : (hp / maxHp) * 100;
};

// What is still missing before we may travel back: buffs, and full HP when the HP option is on.
const missing = () => {
  if (!trip) return [];
  const active = new Set(Object.values(game.state.buffs).map((b) => b.name));
  const out = trip.needs.filter((n) => !active.has(n));
  if (trip.needHp && !(hpPercent() >= 100)) out.push('full HP');
  return out;
};

function endTrip(msg) {
  if (!trip) return;
  clearTimeout(trip.timeout);
  trip = null;
  if (msg) say(msg);
}

// `buff` is the buff that ended; `hp` is true when low HP started the trip.
// Neither (manual test): travel back without waiting.
// After a buff ends we need every buff in the "require" list, or just `buff` if that list is empty.
// With the HP option on, any automatic trip also waits for full HP.
function startTrip(why, { buff = null, hp = false } = {}) {
  if (trip) return;
  say(`${why}: returning to the city.`);
  click(RETURN_STEPS);
  if (!settings.goBack) return;
  const required = names(settings.require);
  trip = {
    phase: 'returning',
    from: game.state.map,
    needs: buff === null ? [] : required.length ? required : [buff],
    needHp: (buff !== null || hp) && hpLimit() > 0,
  };
  trip.timeout = setTimeout(() => {
    endTrip('The map did not change after pressing return; trip abandoned.');
    hpLow = false; // if HP is still low, the next HP update tries again
  }, 20000);
}

function travelBackWhenReady() {
  if (!trip || trip.phase !== 'city' || missing().length) return;
  trip.phase = 'back';
  const from = trip.from;
  const where = settings.map.trim() ? `"${settings.map.trim()}"` : from ?? 'the hunting map';
  const ready = [...(trip.needs.length ? [trip.needs.join(', ') + ' active'] : []), ...(trip.needHp ? ['HP full'] : [])];
  say(`${ready.length ? ready.join(', ') + '. ' : ''}Travelling to ${where}.`);
  trip.timeout = setTimeout(() => {
    click(backSteps(from));
    trip.timeout = setTimeout(() => endTrip('The map did not change after pressing travel; trip abandoned.'), 40000);
  }, Math.max(0, Number(settings.backAfter) || 0) * 1000);
}

game.onBuffEnd = (name) => {
  if (settings.enabled && watched().includes(name)) startTrip(`${name} expired`, { buff: name });
};
game.onBuffStart = () => travelBackWhenReady();
game.onChange = () => {
  const pct = hpPercent();
  if (pct === null) return;
  const limit = hpLimit();
  if (pct >= limit) hpLow = false;
  else if (settings.enabled && limit > 0 && !hpLow && !trip) {
    hpLow = true; // don't press return again on every HP change while it stays low
    startTrip(`HP at ${Math.floor(pct)}% (below ${limit}%)`, { hp: true });
  }
  if (trip?.needHp) travelBackWhenReady();
};
game.onMap = (map) => {
  if (!trip) return;
  if (trip.phase === 'returning') {
    // The server repeats the arrival announcement of the map we are still on; that is not the city.
    if (map === trip.from) return;
    clearTimeout(trip.timeout);
    trip.phase = 'city';
    trip.city = map;
    if (missing().length) say(`In ${map}. Waiting for ${missing().join(', ')} before travelling back.`);
    travelBackWhenReady();
  } else if (map === trip.city) {
    // The server announces the same map more than once on arrival; not a move.
  } else if (trip.phase === 'city') {
    endTrip(`You moved to ${map} before the buffs came back; trip cancelled.`);
  } else if (trip.phase === 'back') {
    hpLow = false;
    endTrip(!settings.map.trim() && trip.from && map !== trip.from ? `Arrived at ${map}, but the trip started from ${trip.from}.` : `Arrived at ${map}.`);
  }
};
game.onIdentity = () => chrome.storage.local.set({ known: [...game.known] });

// ---- attaching to the game tab ---------------------------------------------
async function detachAll() {
  for (const tabId of [...attached]) {
    attached.delete(tabId);
    try {
      await chrome.debugger.detach({ tabId });
    } catch {}
  }
  sockets.clear();
  endTrip();
}

async function sync() {
  await ready;
  if (!settings.enabled) return detachAll();
  for (const tab of await chrome.tabs.query({ url: GAME_URL + '*' })) {
    if (attached.has(tab.id) || dismissed.has(tab.id)) continue;
    try {
      await chrome.debugger.attach({ tabId: tab.id }, '1.3');
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Network.enable');
      attached.add(tab.id);
      if (tab.status === 'loading') say('Connected to the game tab.');
      else if (game.known.size) say('Connected to a game that is already running. Values fill in as the server sends them.');
      else say('Connected to a game that is already running. Press F5 in the game once so the helper can learn your character.');
    } catch (e) {
      say(`Could not attach to the game tab: ${e.message}`);
    }
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const key = source.tabId + ':' + params.requestId;
  if (method === 'Network.webSocketFrameReceived' || method === 'Network.webSocketFrameSent') {
    if (params.response.opcode !== 2) return; // binary frames only
    const s = socketFor(key);
    const data = fromBase64(params.response.payloadData);
    if (method.endsWith('Sent')) s.outbound.push(data);
    else {
      s.inbound.push(data);
      s.gotData = true;
    }
  } else if (method === 'Network.webSocketClosed') sockets.delete(key);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  attached.delete(source.tabId);
  if (reason === 'canceled_by_user') {
    dismissed.add(source.tabId);
    say('Debugging banner was cancelled: paused for this tab until the game is reloaded.');
  }
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status !== 'loading' || !tab.url?.startsWith(GAME_URL)) return;
  dismissed.delete(tabId);
  sync();
});
chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  dismissed.delete(tabId);
});

// ---- popup -----------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    await ready;
    if (msg.t === 'settings') {
      settings = { ...settings, ...msg.settings };
      await chrome.storage.local.set({ settings });
      await sync();
    } else if (msg.t === 'return-now') startTrip('Manual test');
    else if (msg.t === 'back-now') {
      say('Manual test: travelling to the hunting map.');
      click(backSteps(null));
    }
    reply({ settings, state: game.snapshot(), log, connected: attached.size > 0, trip: trip?.phase ?? null, waitingFor: missing(), unknownNames: unknownNames() });
  })();
  return true; // async reply
});

// ---- startup ---------------------------------------------------------------
const ready = (async () => {
  const load = async (file) => (await fetch(chrome.runtime.getURL(file))).json();
  const [{ lengths }, statusTable, stored] = await Promise.all([load('packet-lengths.json'), load('status-names.json'), chrome.storage.local.get(['settings', 'known'])]);
  configure(lengths, statusTable);
  statusNames = new Set(Object.values(statusTable));
  settings = { ...DEFAULTS, ...stored.settings };
  if (stored.known) game.remember(stored.known);
})();

chrome.alarms.create('sync', { periodInMinutes: 0.5 }); // notices a game opened while the worker slept
chrome.alarms.onAlarm.addListener(sync);
chrome.runtime.onStartup.addListener(sync);
chrome.runtime.onInstalled.addListener(sync);
sync();
