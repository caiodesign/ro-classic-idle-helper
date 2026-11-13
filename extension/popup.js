const $ = (id) => document.getElementById(id);
const FIELDS = ['enabled', 'watch', 'hpBelow', 'require', 'mapSearch', 'goBack', 'backAfter'];
let filled = false;
let lastLog = '';

const send = (msg) => chrome.runtime.sendMessage(msg).then(render).catch(() => {});

const watchList = () => $('watch').value.split(',').map((n) => n.trim().toUpperCase()).filter(Boolean);

function saveSettings() {
  send({
    t: 'settings',
    settings: { enabled: $('enabled').checked, watch: watchList().join(', '), require: $('require').value.trim(), map: $('mapSearch').value.trim(), goBack: $('goBack').checked, backAfter: Number($('backAfter').value) || 0, hpBelow: Math.min(100, Math.max(0, Number($('hpBelow').value) || 0)) },
  });
}

function bar(prefix, cur, max) {
  $(prefix).textContent = cur === null && max === null ? '–' : (cur ?? '?') + ' / ' + (max ?? '?');
  $(prefix + 'Fill').style.width = cur !== null && max ? Math.min(100, (cur / max) * 100) + '%' : '0';
}

const duration = (sec) => (sec >= 86400 ? Math.floor(sec / 86400) + 'd' : sec >= 3600 ? Math.floor(sec / 3600) + 'h' : sec >= 60 ? Math.floor(sec / 60) + 'm' : sec + 's');

function render(res) {
  if (!res) return;
  const { settings, state, log, connected, trip, waitingFor, unknownNames } = res;

  if (!filled) {
    $('enabled').checked = settings.enabled;
    $('watch').value = settings.watch;
    $('require').value = settings.require;
    $('mapSearch').value = settings.map;
    $('goBack').checked = settings.goBack;
    $('backAfter').value = settings.backAfter;
    $('hpBelow').value = settings.hpBelow;
    filled = true;
  }

  $('dot').className = 'dot' + (connected ? ' on' : '');
  $('name').textContent = connected ? state.name ?? 'Unknown character' : settings.enabled ? 'Waiting for the game' : 'Disabled';
  $('map').textContent = state.map ?? '';
  bar('hp', state.hp, state.maxHp);
  bar('sp', state.sp, state.maxSp);

  const watching = new Set(settings.watch.split(',').map((n) => n.trim().toUpperCase()));
  $('buffs').replaceChildren(
    ...state.buffs.map((b) => {
      const el = document.createElement('button');
      el.textContent = b.name + (b.remainingSec === null ? '' : ' ' + duration(b.remainingSec));
      el.className = watching.has(b.name) ? 'watched' : b.name.startsWith('STATUS_') ? 'unnamed' : '';
      el.onclick = () => {
        const list = new Set(watchList());
        list.has(b.name) ? list.delete(b.name) : list.add(b.name);
        $('watch').value = [...list].join(', ');
        saveSettings();
      };
      return el;
    }),
  );

  const phases = { returning: 'Returning to the city…', city: 'In the city, waiting for ' + (waitingFor.join(', ') || 'the buffs') + '…', back: 'Travelling back…' };
  $('trip').textContent = phases[trip] ?? '';
  $('unknown').textContent = unknownNames.length ? 'Unknown buff name: ' + unknownNames.join(', ') + '. Use the names shown on the buff chips.' : '';

  const key = log.length + ':' + (log.at(-1)?.at ?? 0);
  if (key !== lastLog) {
    lastLog = key;
    $('logLast').textContent = log.at(-1)?.msg ?? 'No activity yet';
    $('log').replaceChildren(
      ...log.toReversed().map((entry) => {
        const row = document.createElement('div');
        const time = document.createElement('time');
        time.textContent = new Date(entry.at).toLocaleTimeString();
        row.append(time, entry.msg);
        return row;
      }),
    );
  }
}

for (const id of FIELDS) $(id).addEventListener('change', saveSettings);
$('returnNow').onclick = () => send({ t: 'return-now' });
$('backNow').onclick = () => send({ t: 'back-now' });

send({ t: 'state' });
setInterval(() => send({ t: 'state' }), 1000);
