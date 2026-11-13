# RO Classic Idle helper

A browser extension for [Ragnarok Classic Idle](https://play.roclassicidle.com.br/). It shows your character's HP, SP, map and buffs, sends you back to the city when a buff ends or your HP gets low, and travels back to the hunting map once you are ready again.

It works by reading the game's network traffic in your own browser tab and clicking the same buttons you would click. It does not cast skills, send anything to the server on its own, or touch your login.

## Install

The extension is not on the Chrome Web Store, so it is loaded by hand. This works in Brave, Chrome and Edge.

1. Download this repository: **Code → Download ZIP**, then unzip it somewhere you won't delete (for example `Documents`). Removing the folder later removes the extension.
2. Open `brave://extensions` (or `chrome://extensions`).
3. Turn on **Developer mode** in the top right.
4. Click **Load unpacked** and choose the `extension` folder (the one that contains `manifest.json`).
5. Open the game. Click the extension icon and make sure the switch in the top right of the popup is on.

When the helper connects, the browser shows a bar saying *"RO Classic Idle helper" started debugging this browser*. That is expected: leave it open. Clicking **Cancel** on it pauses the helper for that tab until you reload the page.

If the game was already open when you installed the extension, press F5 in the game once so the helper can learn which character is yours.

### Updating

Download the new version, replace your folder with it, and click the reload icon on the extension's card in `brave://extensions`.

## Using it

Click the extension icon to open the popup.

**Top section** — your character name, current map, HP and SP, and the buffs the helper has seen. Click a buff to add it to (or remove it from) the watched list. Watched buffs are shown in gold.

**Return to the city**

| Option | What it does |
| --- | --- |
| When any of these buffs ends | Comma-separated buff names. When one of them expires, the helper clicks the return-to-city button. |
| When HP falls below | A percentage. Below it, the helper returns to the city. `0` turns this off. |

**Travel back afterwards** (switch it off to only return and stay in the city)

| Option | What it does |
| --- | --- |
| Once all of these buffs are active | Buffs that must all be active before travelling back. Empty: only the buff that ended. |
| Map | Text typed into the hunting window's search box; the first result is used. Empty: the map you left. |
| Wait (seconds) | Delay between being ready and travelling. |

**Try it now** — *Return to city* and *Travel to map* run each half of the trip on demand, so you can check your settings without waiting for a buff to expire.

**Activity line** at the bottom shows the last thing the helper did. Click it to see the history.

### Example

A hunter that needs Blessing and Increase AGI from a friend standing in the city:

- When any of these buffs ends: `BLESS`
- When HP falls below: `40`
- Once all of these buffs are active: `BLESS, AGI_UP`
- Map: `sting`

When Blessing expires, or HP drops below 40%, the character returns to the city, waits until both buffs are active and HP is full, then searches for "sting" in the hunting window and travels to the first result.

### Things to know

- **Buff names** are the game's internal names, as shown on the buff chips (`BLESSING`, `INC_AGI`, `CONCENTRATION`, …). `BLESS` and `AGI_UP` are accepted as shortcuts. The popup warns about a name it does not recognise.
- **The helper does not cast buffs or heal.** Someone, or something in the city, has to do that.
- **With the HP option on, every automatic trip waits for full HP** before travelling back, including trips started by a buff ending.
- **Buffs applied before the helper connected** are only known once the server sends them again. After reloading the extension, it may wait for a buff you already have until it is recast.
- **First search result wins.** Use search text specific enough that your map is on top. The activity log shows `Selected map <id>`.
- **One game tab at a time.** Two game tabs open in the same browser would mix their data.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Popup says **Disabled** | The switch in the top right of the popup is off. |
| Popup says **Waiting for the game** | No game tab is open, or the debugging bar was cancelled. Reload the game tab. |
| Name shows **Unknown character** | Press F5 in the game once. |
| "Button … not found on screen" in the activity log | The game's interface changed or the button is hidden. Open an issue. |
| Values are wrong or stop updating after a game update | The packet tables are out of date: see below. |

## Development

No build step: the `extension` folder is loaded as is.

```
node tools/gen-tables.mjs          # regenerate packet and buff tables from the live client
node tools/selftest-extension.mjs  # run the extension logic against simulated game traffic
```

Run `gen-tables.mjs` after a game update if the helper starts misreading values, then reload the extension.

- `extension/game-state.js` — decodes the game's packets into HP, SP, map and buffs
- `extension/background.js` — attaches to the game tab, runs the city trip, clicks the buttons
- `extension/popup.html`, `popup.js` — the popup
- `bot.mjs`, `game-state.mjs` — an older Node script version, kept for reference

## Disclaimer

This is an unofficial fan project, not affiliated with Ragnarok Classic Idle or Gravity. Automating gameplay may be against the game's rules; check them and use this at your own risk.

Made by chics.
