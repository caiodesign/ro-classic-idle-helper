// Read-only companion for Ragnarok Classic Idle.
// The browser extension in ./extension forwards the game's WebSocket frames
// from your normal (already logged in) Brave to this process, which decodes
// them and prints HP, SP, map, character name and buffs.
//
//   node bot.mjs            human-readable output
//   node bot.mjs --json     one JSON object per change (for piping into other tools)
//   node bot.mjs --debug    also log bridge and decoder events
//   node bot.mjs --no-open  do not open the game window
//   node bot.mjs --return-on=CONCENTRATION   press "Retornar para cidade" when that buff ends
//                                            (comma-separated list; any of them triggers it)
//                                            then travel back to the hunting map ("Caçar" > "Viajar para ...")
//                                            once the buff is active again
//   --back-after=1    seconds to wait after the buff is back before travelling (default 1)
//   --no-back         only return to the city, do not travel back
//   --return-now      run the whole city trip once on connect (to test it)
//   --back-now        only do the travel-back clicks once on connect (to test them)
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { GameState, PacketStream } from './game-state.mjs';

const PORT = Number(process.env.RO_BOT_PORT || 9223); // must match extension/background.js
const LAUNCHER = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\chrome_proxy.exe';
const LAUNCH_ARGS = ['--profile-directory=Default', '--app-id=polbminegpnnpbfhgcifolfhoenifmee']; // the installed game app
const JSON_MODE = process.argv.includes('--json');
const DEBUG = process.argv.includes('--debug');

const option = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const RETURN_ON = (option('return-on') ?? '')
  .split(',')
  .map((n) => n.trim().toUpperCase())
  .filter(Boolean);
const GO_BACK = !process.argv.includes('--no-back');
const BACK_AFTER_MS = Number(option('back-after') ?? 1) * 1000; // pause between the buff coming back and travelling

const debug = (...a) => DEBUG && console.error('[debug]', ...a);
const say = (msg) => console.error(`[${new Date().toLocaleTimeString()}] ${msg}`);

// Commands for the extension; they ride back on its next request.
const commands = [];
const RETURN_STEPS = [{ selector: 'button.hb-voltar' }];
// Open the hunting map, then press its travel button. When the hunting map is known the button
// must point at it (data-mapa), so the bot never travels to a different map than the one it left.
const backSteps = (map) => [
  { selector: 'button.hb-cacar', waitMs: 5000 },
  { selector: 'button.hm-btn-go' + (map ? `[data-mapa="${map}"]` : ''), waitMs: 8000 },
];
const click = (steps) => commands.push({ t: 'click', steps });

// City trip: hunting -> (buff ends) -> returning -> (map changes) -> in city -> going back -> hunting
let trip = null; // { phase, from, buff, rebuffed, timeout }
function endTrip(msg) {
  if (!trip) return;
  clearTimeout(trip.timeout);
  trip = null;
  if (msg) say(msg);
}
// `buff` is the buff that must be active again before travelling back (null: do not wait for one).
function startTrip(why, buff = null) {
  if (trip) return;
  say(`${why}: returning to the city`);
  click(RETURN_STEPS);
  if (!GO_BACK) return;
  trip = { phase: 'returning', from: game.state.map, buff, rebuffed: buff === null };
  trip.timeout = setTimeout(() => endTrip('The map did not change after pressing return; giving up on this trip.'), 20000);
}
function travelBackWhenReady() {
  if (!trip || trip.phase !== 'city' || !trip.rebuffed) return;
  trip.phase = 'back';
  say(`${trip.buff ? trip.buff + ' is active again. ' : ''}Travelling back to ${trip.from ?? 'the hunting map'}`);
  trip.timeout = setTimeout(() => {
    click(backSteps(trip.from));
    trip.timeout = setTimeout(() => endTrip('The map did not change after pressing travel; giving up on this trip.'), 30000);
  }, BACK_AFTER_MS);
}
function onBuffStart(name) {
  if (!trip || name !== trip.buff) return;
  trip.rebuffed = true;
  travelBackWhenReady();
}
function onMapChange(map) {
  if (!trip) return;
  if (trip.phase === 'returning') {
    clearTimeout(trip.timeout);
    trip.phase = 'city';
    if (!trip.rebuffed) say(`In ${map}. Waiting for ${trip.buff} before travelling back.`);
    travelBackWhenReady();
  } else if (trip.phase === 'city') {
    endTrip(`You moved to ${map} before ${trip.buff} came back; trip cancelled.`);
  } else if (trip.phase === 'back') {
    endTrip(trip.from && map !== trip.from ? `Arrived at ${map}, but the trip started from ${trip.from}.` : `Back at ${map}.`);
  }
}

// ---- output ---------------------------------------------------------------
const game = new GameState();
let timer = null;
let last = '';

function render() {
  timer = null;
  const s = game.snapshot();
  if (JSON_MODE) {
    console.log(JSON.stringify(s));
    return;
  }
  const bar = (cur, max) => (cur === null ? '?' : cur) + '/' + (max === null ? '?' : max);
  const buffs = s.buffs.map((b) => (b.remainingSec === null ? b.name : `${b.name}(${b.remainingSec}s)`)).join(', ') || '-';
  const line = `${s.name ?? '?'} @ ${s.map ?? '?'} | HP ${bar(s.hp, s.maxHp)} | SP ${bar(s.sp, s.maxSp)} | buffs: ${buffs}`;
  if (line !== last) console.log(`[${new Date().toLocaleTimeString()}] ${line}`);
  last = line;
}
// Remember who we are between runs, so the bot can join a game that is already running.
const IDENTITY_FILE = new URL('./.identity.json', import.meta.url);
try {
  game.remember(JSON.parse(readFileSync(IDENTITY_FILE, 'utf8')));
} catch {}
game.onIdentity = () => {
  try {
    writeFileSync(IDENTITY_FILE, JSON.stringify([...game.known]));
  } catch (e) {
    debug('could not save identity', e.message);
  }
};

game.onBuffEnd = (name) => RETURN_ON.includes(name) && startTrip(`${name} expired`, name);
game.onBuffStart = onBuffStart;
game.onMap = onMapChange;
game.onChange = () => (timer ??= setTimeout(render, 150));

// ---- packet streams, one pair per game socket -----------------------------
const sockets = new Map();
const unknownIds = new Set();

function socketFor(key) {
  let s = sockets.get(key);
  if (!s) {
    s = {
      gotData: false,
      inbound: new PacketStream(
        (id, p) => game.received(id, p),
        (id) => {
          debug('unknown packet id 0x' + id.toString(16) + ', skipping chunk');
          if (!unknownIds.has(id) && unknownIds.size < 5) {
            unknownIds.add(id);
            if (unknownIds.size === 5) console.error('Several unknown packets: the client was probably updated. Run: node tools/gen-tables.mjs');
          }
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

function handle(ev) {
  if (ev.t === 'log') console.error(`[${new Date().toLocaleTimeString()}] ${ev.msg}`);
  else if (ev.t === 'attach') {
    if (process.argv.includes('--return-now')) startTrip('test');
    if (process.argv.includes('--back-now')) {
      say('test: travelling to the hunting map');
      click(backSteps(null));
    }
    console.error(
      ev.fresh
        ? 'Connected to the game tab.'
        : game.known.size
          ? 'Connected to a game that is already running. Values fill in as the server sends them.'
          : 'Connected to a game that is already running, but this is the first run: press F5 in the game once so the bot can learn your character.',
    );
  } else if (ev.t === 'c') sockets.delete(ev.k);
  else if (ev.t === 's') socketFor(ev.k).outbound.push(Buffer.from(ev.p, 'base64'));
  else if (ev.t === 'r') {
    const s = socketFor(ev.k);
    s.inbound.push(Buffer.from(ev.p, 'base64'));
    s.gotData = true;
  }
}

// ---- local endpoint the extension talks to --------------------------------
let seenExtension = false;
const server = createServer((req, res) => {
  // Only the extension may talk to us, never a web page.
  const origin = req.headers.origin;
  if (origin && !origin.startsWith('chrome-extension://')) return res.writeHead(403).end();

  if (req.url === '/hello') {
    if (!seenExtension) debug('extension is polling');
    seenExtension = true;
    return res.writeHead(200).end('ok');
  }
  if (req.url === '/events' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        for (const ev of JSON.parse(Buffer.concat(chunks).toString())) handle(ev);
        res.writeHead(200).end(JSON.stringify({ commands: commands.splice(0) }));
      } catch (e) {
        debug('bad batch', e.message);
        res.writeHead(400).end();
      }
    });
    return;
  }
  res.writeHead(404).end();
});

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is in use: is the bot already running?` : e.message);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.error('Bot listening. Waiting for the game... (Ctrl+C to stop)');
  if (RETURN_ON.length) console.error(`Will return to the city when any of these ends: ${RETURN_ON.join(', ')}`);
  if (!process.argv.includes('--no-open') && existsSync(LAUNCHER)) {
    spawn(LAUNCHER, LAUNCH_ARGS, { detached: true, stdio: 'ignore' }).unref();
  }
  setTimeout(() => {
    if (!seenExtension) console.error('No sign of the extension yet. Load the "extension" folder in brave://extensions (Developer mode > Load unpacked), then reload the game.');
  }, 45000);
});

if (!JSON_MODE) setInterval(() => Object.keys(game.state.buffs).length && render(), 5000); // refresh buff timers
