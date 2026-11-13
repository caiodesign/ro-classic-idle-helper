// Offline check of the decoder with synthetic packets, split at awkward boundaries.
import assert from 'node:assert/strict';
import { GameState, PacketStream } from '../game-state.mjs';

const game = new GameState();
const inbound = new PacketStream((id, p) => game.received(id, p), (id) => assert.fail('desync on 0x' + id.toString(16)));
const outbound = new PacketStream((id, p) => {
  if (id === 0x65) inbound.skip = 4;
  game.sent(id, p);
});

const AID = 2000123;
const GID = 150042;
const pkt = (id, size, fill) => {
  const b = Buffer.alloc(size);
  b.writeUInt16LE(id, 0);
  fill?.(b);
  return b;
};

// client -> char server: CH_ENTER
outbound.push(pkt(0x65, 17, (b) => b.writeUInt32LE(AID, 2)));

// char server: 4 raw bytes, then the character list (2 characters), then zone notify
const raw = Buffer.alloc(4);
raw.writeUInt32LE(AID);
const list = pkt(0xb72, 4 + 175 * 2, (b) => {
  b.writeUInt16LE(b.length, 2);
  b.writeUInt32LE(999, 4);
  b.write('Other', 4 + 108, 'latin1');
  b.writeUInt32LE(GID, 4 + 175);
  b.write('Tester', 4 + 175 + 108, 'latin1');
});
const zone = pkt(0xac5, 156, (b) => {
  b.writeUInt32LE(GID, 2);
  b.write('prontera.gat', 6, 'latin1');
});
const par = (varId, value) => pkt(0xb0, 8, (b) => (b.writeUInt16LE(varId, 2), b.writeInt32LE(value, 4)));
const buffOn = pkt(0x983, 29, (b) => (b.writeInt16LE(10, 2), b.writeUInt32LE(AID, 4), (b[8] = 1), b.writeUInt32LE(240000, 9), b.writeUInt32LE(120000, 13)));
const otherBuff = pkt(0x983, 29, (b) => (b.writeInt16LE(12, 2), b.writeUInt32LE(AID + 1, 4), (b[8] = 1)));
const enterBuff = pkt(0x984, 28, (b) => (b.writeUInt32LE(AID, 2), b.writeInt16LE(12, 6), b.writeUInt32LE(60000, 12)));
const move = pkt(0x91, 22, (b) => b.write('prt_fild08.gat', 2, 'latin1'));

const stream = Buffer.concat([raw, list, zone, par(6, 5000), par(5, 4321), par(8, 300), par(7, 150), buffOn, otherBuff, enterBuff, move]);
for (let i = 0; i < stream.length; i += 7) inbound.push(stream.subarray(i, i + 7)); // 7-byte chunks

let s = game.snapshot();
assert.equal(s.name, 'Tester');
assert.equal(s.map, 'prt_fild08');
assert.deepEqual([s.hp, s.maxHp, s.sp, s.maxSp], [4321, 5000, 150, 300]);
assert.deepEqual(s.buffs.map((b) => b.name).sort(), ['BLESSING', 'INC_AGI']);
assert.ok(s.buffs.find((b) => b.name === 'BLESSING').remainingSec >= 119);

inbound.push(pkt(0x196, 9, (b) => (b.writeInt16LE(10, 2), b.writeUInt32LE(AID, 4), (b[8] = 0))));
s = game.snapshot();
assert.deepEqual(s.buffs.map((b) => b.name), ['INC_AGI']);

console.log('selftest ok', JSON.stringify(s));
