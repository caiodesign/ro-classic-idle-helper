// Decodes the Ragnarok packet stream the game client exchanges with the server
// and keeps a read-only picture of the player's character.
// Plain JS (no Node or browser APIs) so it runs in the extension and in tests.

const CHAR_BLOCK = 175; // CHARACTER_INFO size for packetver >= 20211103
const CHAR_NAME_OFFSET = 108;
const VAR = { 5: 'hp', 6: 'maxHp', 7: 'sp', 8: 'maxSp', 11: 'baseLevel' };

let LENGTHS = {};
let STATUS_NAMES = {};
/** Must be called once with the contents of packet-lengths.json and status-names.json. */
export function configure(lengths, statusNames) {
  LENGTHS = lengths;
  STATUS_NAMES = statusNames;
}

const u16 = (b, at) => b[at] | (b[at + 1] << 8);
const u32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const i32 = (b, at) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24);
const i16 = (b, at) => (u16(b, at) << 16) >> 16;
const i64 = (b, at) => i32(b, at + 4) * 4294967296 + u32(b, at);
const text = (b, start, len) => {
  let out = '';
  for (let i = start; i < start + len && i < b.length && b[i] !== 0; i++) out += String.fromCharCode(b[i]);
  return out;
};

/** Reassembles packets from arbitrary stream chunks (one instance per socket direction). */
export class PacketStream {
  constructor(onPacket, onDesync) {
    this.pending = new Uint8Array(0);
    this.skip = 0;
    this.onPacket = onPacket;
    this.onDesync = onDesync;
  }

  push(chunk) {
    let buf = chunk;
    if (this.pending.length) {
      buf = new Uint8Array(this.pending.length + chunk.length);
      buf.set(this.pending, 0);
      buf.set(chunk, this.pending.length);
    }
    if (this.skip) {
      const n = Math.min(this.skip, buf.length);
      this.skip -= n;
      buf = buf.subarray(n);
    }
    let pos = 0;
    while (buf.length - pos >= 2) {
      const id = u16(buf, pos);
      let len = LENGTHS[id];
      if (len === undefined) {
        // Unknown id: same as the client, give up on the rest of this chunk.
        this.onDesync?.(id);
        pos = buf.length;
        break;
      }
      if (len < 0) {
        if (buf.length - pos < 4) break;
        len = u16(buf, pos + 2);
        if (len < 4) {
          this.onDesync?.(id);
          pos = buf.length;
          break;
        }
      }
      if (buf.length - pos < len) break;
      this.onPacket(id, buf.subarray(pos, pos + len));
      pos += len;
    }
    this.pending = buf.slice(pos);
  }
}

export class GameState {
  constructor() {
    this.accountId = null;
    this.characters = new Map(); // GID -> name
    this.state = { name: null, map: null, hp: null, maxHp: null, sp: null, maxSp: null, baseLevel: null, buffs: {} };
    this.known = new Map(); // accountId -> last character name, remembered from earlier logins
    this.onChange = null;
    this.onMap = null; // (map) => void
    this.onBuffStart = null; // (name) => void
    this.onBuffEnd = null; // (name) => void, fired when the server removes one of our buffs
    this.onIdentity = null; // (accountId, name) => void, fired when a login is observed
  }

  /** Identities seen in earlier sessions, so we can join a game that is already running. */
  remember(known) {
    this.known = new Map(known);
    if (this.accountId === null && this.known.size === 1) this.adopt(this.known.keys().next().value);
  }

  adopt(aid) {
    this.accountId = aid;
    this.state.name ??= this.known.get(aid) ?? null;
  }

  /** Buffs with their remaining time recomputed for "now". */
  snapshot() {
    const now = Date.now();
    const buffs = Object.values(this.state.buffs).map((b) => ({
      id: b.id,
      name: b.name,
      remainingSec: b.expiresAt === null ? null : Math.max(0, Math.round((b.expiresAt - now) / 1000)),
    }));
    return { ...this.state, buffs };
  }

  setMap(raw) {
    this.state.map = raw.replace(/\.gat$/i, '');
    this.onMap?.(this.state.map);
    this.onChange?.();
  }

  setBuff(aid, id, on, remainMs) {
    if (this.accountId === null && this.known.has(aid)) this.adopt(aid);
    if (this.accountId === null || aid !== this.accountId) return;
    const name = STATUS_NAMES[id] ?? `STATUS_${id}`;
    if (!on) {
      delete this.state.buffs[id];
      this.onBuffEnd?.(name);
    } else {
      // 0 or 0xffffffff-ish values mean "no timer"
      const timed = remainMs > 0 && remainMs < 0x7fffffff;
      this.state.buffs[id] = { id, name, expiresAt: timed ? Date.now() + remainMs : null };
      this.onBuffStart?.(name);
    }
    this.onChange?.();
  }

  /** Packets the client sends. Only used to learn which account is ours. */
  sent(id, p) {
    if (id === 0x65 && p.length >= 6) this.accountId = u32(p, 2); // CH_ENTER
  }

  /** Packets the server sends. */
  received(id, p) {
    const s = this.state;
    switch (id) {
      case 0x69: // AC_ACCEPT_LOGIN
      case 0xac4:
        this.accountId = u32(p, 8);
        break;

      case 0x6b: // character list (several variants, all end with N fixed-size blocks)
      case 0x99d:
      case 0xb72: {
        const body = p.length - 4;
        for (let at = 4 + (body % CHAR_BLOCK); at + CHAR_BLOCK <= p.length; at += CHAR_BLOCK) {
          this.characters.set(u32(p, at), text(p, at + CHAR_NAME_OFFSET, 24));
        }
        break;
      }

      case 0x71: // HC_NOTIFY_ZONESVR: the character was picked, entering the world
      case 0xac5:
        Object.assign(s, { hp: null, maxHp: null, sp: null, maxSp: null, baseLevel: null, buffs: {} });
        s.name = this.characters.get(u32(p, 2)) ?? s.name;
        if (this.accountId !== null && s.name) {
          this.known.set(this.accountId, s.name);
          this.onIdentity?.(this.accountId, s.name);
        }
        this.setMap(text(p, 6, 16));
        break;

      case 0x91: // ZC_NPCACK_MAPMOVE
      case 0x92: // ZC_NPCACK_SERVERMOVE
      case 0xac7:
        this.setMap(text(p, 2, 16));
        break;

      case 0xb0: // ZC_PAR_CHANGE
      case 0xb1: // ZC_LONGPAR_CHANGE
      case 0xacb: { // ZC_LONGLONGPAR_CHANGE
        const key = VAR[u16(p, 2)];
        if (!key) break;
        s[key] = id === 0xacb ? i64(p, 4) : i32(p, 4);
        this.onChange?.();
        break;
      }

      // Status icons. Layouts differ per packet id.
      case 0x196: // index, AID, state
        this.setBuff(u32(p, 4), i16(p, 2), p[8] !== 0, 0);
        break;
      case 0x43f: // index, AID, state, remain, val[3]
        this.setBuff(u32(p, 4), i16(p, 2), p[8] !== 0, u32(p, 9));
        break;
      case 0x983: // index, AID, state, total, remain, val[3]
        this.setBuff(u32(p, 4), i16(p, 2), p[8] !== 0, u32(p, 13));
        break;
      case 0x8ff: // AID, index, remain, val[3]
        this.setBuff(u32(p, 2), i16(p, 6), true, u32(p, 8));
        break;
      case 0x984: // AID, index, total, remain, val[3]
        this.setBuff(u32(p, 2), i16(p, 6), true, u32(p, 12));
        break;
    }
  }
}
