// Decodes the Ragnarok packet stream the game client exchanges with the server
// and keeps a read-only picture of the player's character.
import { readFileSync } from 'node:fs';

const load = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const { lengths: LENGTHS } = load('./packet-lengths.json');
const STATUS_NAMES = load('./status-names.json');

const CHAR_BLOCK = 175; // CHARACTER_INFO size for packetver >= 20211103
const CHAR_NAME_OFFSET = 108;
const VAR = { 5: 'hp', 6: 'maxHp', 7: 'sp', 8: 'maxSp', 11: 'baseLevel' };

const text = (buf, start, len) => {
  const end = buf.indexOf(0, start);
  return buf.toString('latin1', start, end < 0 || end > start + len ? start + len : end);
};

/** Reassembles packets from arbitrary stream chunks (one instance per socket direction). */
export class PacketStream {
  constructor(onPacket, onDesync) {
    this.pending = Buffer.alloc(0);
    this.skip = 0;
    this.onPacket = onPacket;
    this.onDesync = onDesync;
  }

  push(chunk) {
    let buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    if (this.skip) {
      const n = Math.min(this.skip, buf.length);
      this.skip -= n;
      buf = buf.subarray(n);
    }
    let pos = 0;
    while (buf.length - pos >= 2) {
      const id = buf.readUInt16LE(pos);
      let len = LENGTHS[id];
      if (len === undefined) {
        // Unknown id: same as the client, give up on the rest of this chunk.
        this.onDesync?.(id);
        pos = buf.length;
        break;
      }
      if (len < 0) {
        if (buf.length - pos < 4) break;
        len = buf.readUInt16LE(pos + 2);
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
    this.pending = Buffer.from(buf.subarray(pos));
  }
}

export class GameState {
  constructor() {
    this.accountId = null;
    this.characters = new Map(); // GID -> name
    this.state = { name: null, map: null, hp: null, maxHp: null, sp: null, maxSp: null, baseLevel: null, buffs: {} };
    this.onChange = null;
    this.onBuffEnd = null; // (name) => void, fired when the server removes one of our buffs
    this.onIdentity = null; // (accountId, name) => void, fired when a login is observed
    this.known = new Map(); // accountId -> last character name, remembered from earlier logins
  }

  /** Identities seen in earlier runs, so the bot can join a session that is already in game. */
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

  changed() {
    this.onChange?.();
  }

  setMap(raw) {
    this.state.map = raw.replace(/\.gat$/i, '');
    this.onMap?.(this.state.map);
    this.changed();
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
      this.onBuffStart?.(name);
      this.state.buffs[id] = { id, name, expiresAt: timed ? Date.now() + remainMs : null };
    }
    this.changed();
  }

  /** Packets the client sends. Only used to learn which account is ours. */
  sent(id, p) {
    if (id === 0x65 && p.length >= 6) this.accountId = p.readUInt32LE(2); // CH_ENTER
  }

  /** Packets the server sends. */
  received(id, p) {
    const s = this.state;
    switch (id) {
      case 0x69: // AC_ACCEPT_LOGIN
      case 0xac4:
        this.accountId = p.readUInt32LE(8);
        break;

      case 0x6b: // character list (several variants, all end with N fixed-size blocks)
      case 0x99d:
      case 0xb72: {
        const body = p.length - 4;
        for (let at = 4 + (body % CHAR_BLOCK); at + CHAR_BLOCK <= p.length; at += CHAR_BLOCK) {
          this.characters.set(p.readUInt32LE(at), text(p, at + CHAR_NAME_OFFSET, 24));
        }
        break;
      }

      case 0x71: // HC_NOTIFY_ZONESVR: the character was picked, entering the world
      case 0xac5:
        Object.assign(s, { hp: null, maxHp: null, sp: null, maxSp: null, baseLevel: null, buffs: {} });
        s.name = this.characters.get(p.readUInt32LE(2)) ?? s.name;
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
        const key = VAR[p.readUInt16LE(2)];
        if (!key) break;
        s[key] = id === 0xacb ? Number(p.readBigInt64LE(4)) : p.readInt32LE(4);
        this.changed();
        break;
      }

      // Status icons. Layouts differ per packet id.
      case 0x196: // index, AID, state
        this.setBuff(p.readUInt32LE(4), p.readInt16LE(2), p[8] !== 0, 0);
        break;
      case 0x43f: // index, AID, state, remain, val[3]
        this.setBuff(p.readUInt32LE(4), p.readInt16LE(2), p[8] !== 0, p.readUInt32LE(9));
        break;
      case 0x983: // index, AID, state, total, remain, val[3]
        this.setBuff(p.readUInt32LE(4), p.readInt16LE(2), p[8] !== 0, p.readUInt32LE(13));
        break;
      case 0x8ff: // AID, index, remain, val[3]
        this.setBuff(p.readUInt32LE(2), p.readInt16LE(6), true, p.readUInt32LE(8));
        break;
      case 0x984: // AID, index, total, remain, val[3]
        this.setBuff(p.readUInt32LE(2), p.readInt16LE(6), true, p.readUInt32LE(12));
        break;
    }
  }
}
