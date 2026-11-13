// Regenerates packet-lengths.json from the game's public client bundle.
// Run again after a client update if the bot starts reporting desyncs:
//   node tools/gen-tables.mjs
import { writeFileSync } from 'node:fs';

const ORIGIN = 'https://play.roclassicidle.com.br';
const get = async (path) => (await fetch(`${ORIGIN}/${path}`, { cache: 'no-store' })).text();

const src = await get('Online.js');
const cfg = await get('Config.local.js');
const packetver = Number(/packetver:\s*(\d+)/.exec(cfg)?.[1]);
if (!packetver) throw new Error('packetver not found in Config.local.js');

const year = Math.min(2025, Math.max(2003, Math.floor(packetver / 10000)));
const ID = '[A-Za-z0-9_$]+';
const esc = (s) => s.replace(/\$/g, '\\$');

function extractFunction(text, name) {
  const start = text.indexOf('function ' + name + '(');
  if (start < 0) return null;
  let i = text.indexOf('{', start);
  let depth = 0;
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) break;
  }
  return text.slice(start, i + 1);
}

function findInit(text, moduleVar) {
  // The bundler may wrap the module: X=e({default:()=>Y}), Y={init:fn}
  const wrapped = new RegExp('[,; ]' + esc(moduleVar) + '=' + ID + '\\(\\{default:\\(\\)=>(' + ID + ')\\}\\)').exec(text);
  if (wrapped) moduleVar = wrapped[1];
  const m = new RegExp('[,; ]' + esc(moduleVar) + '=\\{init:(' + ID + ')\\}').exec(text);
  return m ? { text, initName: m[1] } : null;
}

// The length module is either defined in Online.js or imported from a chunk.
const modVar = new RegExp('packets' + year + '_len_main\\.js":(' + ID + ')').exec(src)?.[1];
if (!modVar) throw new Error('length module not found');

let found = findInit(src, modVar);
if (!found) {
  for (const m of src.matchAll(/import\{([^}]+)\}from"\.\/(pedacos\/[^"]+)"/g)) {
    const pair = m[1].split(',').map((p) => p.split(' as ')).find((p) => (p[1] || p[0]) === modVar);
    if (!pair) continue;
    const chunk = await get(m[2]);
    const exportsBlock = chunk.slice(chunk.lastIndexOf('export{'));
    const local = new RegExp('(' + ID + ') as ' + esc(pair[0]) + '[,}]').exec(exportsBlock)?.[1] || pair[0];
    found = findInit(chunk, local);
    break;
  }
}
const fnSrc = found && extractFunction(found.text, found.initName);
if (!fnSrc) throw new Error('length init function not found');

// The function fills an array declared outside it (e.g. `T=[]`); declare it here.
const outer = new RegExp('[{,; ](' + ID + ')\\[\\d+\\]=').exec(fnSrc)?.[1];
const prelude = outer ? 'var ' + outer + '=[];' : '';
const table = new Function(prelude + fnSrc + '; return ' + found.initName + '(' + packetver + ');')();
table[2431] = table[2431] || -1; // same patches the client applies after init
table[2432] = table[2432] || 7;

const lengths = {};
table.forEach((len, id) => {
  if (len) lengths[id] = len;
});
writeFileSync(new URL('../packet-lengths.json', import.meta.url), JSON.stringify({ packetver, lengths }));
writeFileSync(new URL('../extension/packet-lengths.json', import.meta.url), JSON.stringify({ packetver, lengths }));
console.log('packetver ' + packetver + ': ' + Object.keys(lengths).length + ' packet lengths written');

// Status (buff) id -> name, from the client's status constant table.
const sources = [src];
for (const m of src.matchAll(/from"\.\/(pedacos\/[^"]+)"/g)) sources.push(await get(m[1]));
const statusNames = {};
for (const text of sources) {
  const block = /\{BLANK:-1,PROVOKE:0,[^}]*\}/.exec(text)?.[0];
  if (!block) continue;
  for (const m of block.matchAll(/([A-Za-z0-9_]+):(\d+)/g)) statusNames[m[2]] ??= m[1];
  break;
}
writeFileSync(new URL('../status-names.json', import.meta.url), JSON.stringify(statusNames));
writeFileSync(new URL('../extension/status-names.json', import.meta.url), JSON.stringify(statusNames));
console.log(Object.keys(statusNames).length + ' status names written');
