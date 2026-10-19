// 仕様書 SPEC.md の第1章・第2章に対応するテスト。編集禁止。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMatch, legalActions, applyAction, startNextRound, viewFor } from '../src/engine.js';

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// 盤面を直接組み立てる。手札・山札・位置・手番を上書きする。
function setup(over = {}) {
  const st = structuredClone(createMatch({ rng: seeded(1), firstPlayer: 0 }));
  Object.assign(st, { discard: [], parried: null, lastEvents: [] }, over);
  return st;
}

function act(st, player, action) {
  const r = applyAction(st, player, action);
  assert.equal(r.ok, true, `行動が拒否された: ${JSON.stringify(action)} -> ${r.error}`);
  return r.state;
}

function reject(st, player, action) {
  const before = structuredClone(st);
  const r = applyAction(st, player, action);
  assert.equal(r.ok, false, `不正な行動が通った: ${JSON.stringify(action)}`);
  assert.equal(typeof r.error, 'string');
  assert.deepEqual(st, before, '拒否したのに state が変わった');
}

const sorted = (a) => [...a].sort((x, y) => x - y);
const has = (list, a) => list.some((x) => JSON.stringify(x) === JSON.stringify(a));
const countAll = (st) => [...st.hands[0], ...st.hands[1], ...st.deck, ...st.discard];

test('初期状態: 盤・カード・手札・山札', () => {
  const st = createMatch({ rng: seeded(42), firstPlayer: 1 });
  assert.deepEqual(st.positions, [1, 23]);
  assert.deepEqual(st.scores, [0, 0]);
  assert.equal(st.round, 1);
  assert.equal(st.startPlayer, 1);
  assert.equal(st.turn, 1);
  assert.equal(st.phase, 'action');
  assert.equal(st.hands[0].length, 5);
  assert.equal(st.hands[1].length, 5);
  assert.equal(st.deck.length, 15);
  assert.deepEqual(st.discard, []);
  assert.equal(st.winner, null);
  assert.equal(st.roundResult, null);
  const all = sorted(countAll(st));
  assert.deepEqual(all, [1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5]);
});

test('state は JSON にできる', () => {
  const st = createMatch({ rng: seeded(3) });
  assert.deepEqual(JSON.parse(JSON.stringify(st)), st);
});

test('同じ rng なら同じ配り方になり、違う rng なら（ほぼ確実に）違う', () => {
  const a = createMatch({ rng: seeded(7) });
  const b = createMatch({ rng: seeded(7) });
  const c = createMatch({ rng: seeded(8) });
  assert.deepEqual(a, b);
  assert.notDeepEqual([a.hands, a.deck], [c.hands, c.deck]);
});

test('前進: プレイヤー0は右へ進み、1枚引いて手番が移る', () => {
  const st = setup({ hands: [[3, 1, 1, 2, 5], [1, 2, 3, 4, 5]], deck: [4, 2, 2], positions: [1, 23], turn: 0 });
  const n = act(st, 0, { type: 'move', dir: 'forward', card: 3 });
  assert.deepEqual(n.positions, [4, 23]);
  assert.deepEqual(sorted(n.hands[0]), [1, 1, 2, 4, 5]);
  assert.deepEqual(n.deck, [2, 2]);
  assert.deepEqual(n.discard, [3]);
  assert.equal(n.turn, 1);
  assert.ok(n.lastEvents.some((e) => e.type === 'move' && e.player === 0 && e.from === 1 && e.to === 4 && e.card === 3 && e.dir === 'forward'));
});

test('前進: プレイヤー1は左へ進む。後退は逆向き', () => {
  const st = setup({ hands: [[1, 1, 1, 1, 1], [2, 4, 5, 5, 5]], deck: [3, 3, 3], positions: [5, 20], turn: 1 });
  const a = act(st, 1, { type: 'move', dir: 'forward', card: 4 });
  assert.deepEqual(a.positions, [5, 16]);
  const b = act(st, 1, { type: 'move', dir: 'backward', card: 2 });
  assert.deepEqual(b.positions, [5, 22]);
});

test('盤外への移動はできない', () => {
  const st = setup({ hands: [[1, 2, 3, 4, 5], [1, 2, 3, 4, 5]], deck: [3, 3, 3], positions: [1, 21], turn: 0 });
  reject(st, 0, { type: 'move', dir: 'backward', card: 1 });
  const st1 = { ...st, turn: 1 };
  reject(st1, 1, { type: 'move', dir: 'backward', card: 3 });
  act(st1, 1, { type: 'move', dir: 'backward', card: 2 });
  assert.ok(!legalActions(st, 0).some((a) => a.type === 'move' && a.dir === 'backward'));
});

test('相手のマスに止まる・相手を飛び越える移動はできない', () => {
  const st = setup({ hands: [[2, 3, 4, 1, 1], [1, 2, 3, 4, 5]], deck: [5, 5, 5], positions: [10, 13], turn: 0 });
  reject(st, 0, { type: 'move', dir: 'forward', card: 3 });
  reject(st, 0, { type: 'move', dir: 'forward', card: 4 });
  const n = act(st, 0, { type: 'move', dir: 'forward', card: 2 });
  assert.deepEqual(n.positions, [12, 13]);
  const legal = legalActions(st, 0);
  assert.ok(has(legal, { type: 'move', dir: 'forward', card: 2 }));
  assert.ok(!has(legal, { type: 'move', dir: 'forward', card: 3 }));
  assert.ok(!has(legal, { type: 'move', dir: 'forward', card: 4 }));
});

test('持っていないカード・手番違い・壊れた入力は拒否し、例外を投げない', () => {
  const st = setup({ hands: [[1, 1, 2, 2, 5], [1, 2, 3, 4, 5]], deck: [3, 3, 3], positions: [1, 23], turn: 0 });
  reject(st, 0, { type: 'move', dir: 'forward', card: 3 });
  reject(st, 1, { type: 'move', dir: 'forward', card: 1 });
  reject(st, 0, { type: 'move', dir: 'sideways', card: 1 });
  reject(st, 0, { type: 'move', dir: 'forward', card: '1' });
  reject(st, 0, { type: 'move', dir: 'forward', card: 1.5 });
  reject(st, 0, { type: 'dance' });
  reject(st, 0, null);
  reject(st, 0, { type: 'attack', value: 22, count: 1 });
  reject(st, 0, { type: 'attack', value: 5, count: 0 });
  reject(st, 2, { type: 'move', dir: 'forward', card: 1 });
});

test('攻撃は距離ちょうどの数字だけ。枚数は手持ちまで', () => {
  const st = setup({ hands: [[3, 3, 1, 2, 4], [5, 5, 5, 5, 4]], deck: [1, 1, 1, 2, 2], positions: [10, 13], turn: 0 });
  reject(st, 0, { type: 'attack', value: 2, count: 1 });
  reject(st, 0, { type: 'attack', value: 4, count: 1 });
  reject(st, 0, { type: 'attack', value: 3, count: 3 });
  const legal = legalActions(st, 0);
  assert.ok(has(legal, { type: 'attack', value: 3, count: 1 }));
  assert.ok(has(legal, { type: 'attack', value: 3, count: 2 }));
  assert.ok(!legal.some((a) => a.type === 'attack' && a.value !== 3));
});

test('legalActions に重複がない', () => {
  const st = setup({ hands: [[2, 2, 2, 1, 1], [1, 2, 3, 4, 5]], deck: [3, 3, 3], positions: [8, 15], turn: 0 });
  const legal = legalActions(st, 0).map((a) => JSON.stringify(a));
  assert.equal(new Set(legal).size, legal.length);
  assert.deepEqual(legalActions(st, 1), []);
});

test('パリィできなければ命中して1点、ラウンド終了', () => {
  const st = setup({ hands: [[3, 3, 1, 2, 4], [3, 1, 1, 2, 2]], deck: [5, 5, 5, 5], positions: [10, 13], turn: 0 });
  const n = act(st, 0, { type: 'attack', value: 3, count: 2 });
  assert.deepEqual(n.scores, [1, 0]);
  assert.equal(n.phase, 'roundOver');
  assert.equal(n.roundResult.winner, 0);
  assert.equal(n.roundResult.reason, 'hit');
  assert.ok(n.lastEvents.some((e) => e.type === 'hit' && e.player === 0));
  assert.deepEqual(legalActions(n, 0), []);
  assert.deepEqual(legalActions(n, 1), []);
  reject(n, 1, { type: 'move', dir: 'backward', card: 1 });
});

test('パリィは「同じ数字を同じ枚数」。合計値が同じだけでは防げない', () => {
  const st = setup({ hands: [[3, 3, 1, 1, 1], [2, 4, 1, 5, 5]], deck: [5, 5, 5, 5], positions: [10, 13], turn: 0 });
  const n = act(st, 0, { type: 'attack', value: 3, count: 2 });
  assert.equal(n.phase, 'roundOver');
  assert.equal(n.roundResult.winner, 0);
});

test('パリィ成功: 同じ枚数だけ使い、補充せずに防御側の手番になる', () => {
  const st = setup({ hands: [[3, 1, 1, 1, 1], [3, 3, 4, 4, 4]], deck: [2, 2, 5, 5, 5, 5], positions: [10, 13], turn: 0 });
  const n = act(st, 0, { type: 'attack', value: 3, count: 1 });
  assert.equal(n.phase, 'action');
  assert.equal(n.turn, 1);
  assert.equal(n.parried, 1);
  assert.deepEqual(sorted(n.hands[0]), [1, 1, 1, 1, 2]);
  assert.deepEqual(sorted(n.hands[1]), [3, 4, 4, 4]);
  assert.deepEqual(n.deck, [2, 5, 5, 5, 5]);
  assert.deepEqual(n.scores, [0, 0]);
  assert.ok(n.lastEvents.some((e) => e.type === 'attack' && e.player === 0 && e.value === 3 && e.count === 1));
  assert.ok(n.lastEvents.some((e) => e.type === 'parry' && e.player === 1 && e.value === 3 && e.count === 1));
  // パリィした側は手番の終わりに5枚まで補充する（4枚から1枚出して3枚 → 2枚引く）
  const m = act(n, 1, { type: 'move', dir: 'backward', card: 4 });
  assert.deepEqual(m.positions, [10, 17]);
  assert.equal(m.hands[1].length, 5);
  assert.deepEqual(m.deck, [5, 5, 5]);
  assert.equal(m.parried, null);
  assert.equal(m.turn, 0);
});

test('パリィ後の反撃でも補充は手番の終わり', () => {
  const st = setup({ hands: [[3, 1, 1, 1, 1], [3, 3, 3, 4, 4]], deck: [2, 2, 2, 5, 5, 5, 5], positions: [10, 13], turn: 0 });
  const n = act(st, 0, { type: 'attack', value: 3, count: 1 }); // 1 は [3,3,4,4] になる
  assert.deepEqual(sorted(n.hands[1]), [3, 3, 4, 4]);
  assert.ok(has(legalActions(n, 1), { type: 'attack', value: 3, count: 2 }));
  const m = act(n, 1, { type: 'attack', value: 3, count: 2 }); // 0 は 3 を持っていない → 命中
  assert.equal(m.phase, 'roundOver');
  assert.equal(m.roundResult.winner, 1);
  assert.deepEqual(m.scores, [0, 1]);
});

test('動けず攻撃もできないプレイヤーは負け', () => {
  const st = setup({ hands: [[1, 5, 5, 5, 5], [2, 2, 3, 4, 5]], deck: [5, 4, 4, 4], positions: [21, 23], turn: 0 });
  const n = act(st, 0, { type: 'move', dir: 'forward', card: 1 });
  assert.deepEqual(n.positions, [22, 23]);
  assert.equal(n.phase, 'roundOver');
  assert.equal(n.roundResult.winner, 0);
  assert.equal(n.roundResult.reason, 'stuck');
  assert.deepEqual(n.scores, [1, 0]);
  assert.ok(n.lastEvents.some((e) => e.type === 'stuck' && e.player === 1));
});

test('山札切れ（移動で最後の1枚）: 距離ちょうどの枚数で判定', () => {
  const st = setup({ hands: [[1, 2, 3, 4, 5], [5, 5, 2, 2, 1]], deck: [4], positions: [5, 15], turn: 0 });
  const n = act(st, 0, { type: 'move', dir: 'forward', card: 5 });
  assert.deepEqual(n.positions, [10, 15]);
  assert.equal(n.deck.length, 0);
  assert.equal(n.phase, 'roundOver');
  assert.equal(n.roundResult.reason, 'deck');
  assert.equal(n.roundResult.winner, 1);
  assert.deepEqual(n.scores, [0, 1]);
  assert.deepEqual(n.roundResult.revealedHands.map(sorted), [[1, 2, 3, 4, 4], [1, 2, 2, 5, 5]]);
  assert.ok(n.lastEvents.some((e) => e.type === 'deckOut'));
});

test('山札切れ: 枚数が同じなら前進した距離で判定', () => {
  const st = setup({ hands: [[2, 2, 3, 3, 4], [2, 3, 3, 4, 4]], deck: [1], positions: [5, 15], turn: 0 });
  const n = act(st, 0, { type: 'move', dir: 'forward', card: 2 });
  // 距離8: 誰も持っていない。前進距離は 0 が 6、1 が 8
  assert.equal(n.roundResult.reason, 'deck');
  assert.equal(n.roundResult.winner, 1);
  assert.deepEqual(n.scores, [0, 1]);
});

test('山札切れ: 枚数も前進距離も同じなら引き分けで点は動かない', () => {
  const st = setup({ hands: [[2, 2, 3, 3, 4], [2, 3, 3, 4, 4]], deck: [1], positions: [3, 19], turn: 0, scores: [2, 3] });
  const n = act(st, 0, { type: 'move', dir: 'forward', card: 2 });
  assert.deepEqual(n.positions, [5, 19]);
  assert.equal(n.phase, 'roundOver');
  assert.equal(n.roundResult.reason, 'deck');
  assert.equal(n.roundResult.winner, null);
  assert.deepEqual(n.scores, [2, 3]);
});

test('山札切れ（攻撃の補充で最後の1枚）: 防げなければ命中', () => {
  const st = setup({ hands: [[3, 1, 1, 1, 1], [2, 2, 2, 4, 4]], deck: [5], positions: [10, 13], turn: 0 });
  const n = act(st, 0, { type: 'attack', value: 3, count: 1 });
  assert.equal(n.roundResult.reason, 'hit');
  assert.equal(n.roundResult.winner, 0);
});

test('山札切れ（攻撃の補充で最後の1枚）: パリィしたら反撃せずにすぐ判定', () => {
  const st = setup({ hands: [[3, 1, 1, 1, 1], [3, 3, 2, 2, 2]], deck: [5], positions: [10, 13], turn: 0 });
  const n = act(st, 0, { type: 'attack', value: 3, count: 1 });
  assert.equal(n.phase, 'roundOver');
  assert.equal(n.roundResult.reason, 'deck');
  // 距離3: 0 は 3 を持たない（[1,1,1,1,5]）、1 は 1 枚（[3,2,2,2]）
  assert.equal(n.roundResult.winner, 1);
  assert.deepEqual(n.scores, [0, 1]);
  assert.ok(n.lastEvents.some((e) => e.type === 'parry' && e.player === 1));
});

test('5点目でマッチ終了', () => {
  const st = setup({ hands: [[3, 1, 1, 1, 1], [2, 2, 2, 4, 4]], deck: [5, 5, 5], positions: [10, 13], turn: 0, scores: [4, 2] });
  const n = act(st, 0, { type: 'attack', value: 3, count: 1 });
  assert.deepEqual(n.scores, [5, 2]);
  assert.equal(n.phase, 'matchOver');
  assert.equal(n.winner, 0);
  assert.ok(n.lastEvents.some((e) => e.type === 'matchEnd' && e.winner === 0));
  assert.equal(startNextRound(n, seeded(1)), n);
});

test('次のラウンド: 先手交代・位置と札のリセット・点数は維持', () => {
  const st = setup({ hands: [[3, 1, 1, 1, 1], [2, 2, 2, 4, 4]], deck: [5, 5, 5], positions: [10, 13], turn: 0, scores: [1, 1] });
  const n = act(st, 0, { type: 'attack', value: 3, count: 1 });
  const r = startNextRound(n, seeded(9));
  assert.equal(r.round, n.round + 1);
  assert.equal(r.startPlayer, 1 - n.startPlayer);
  assert.equal(r.turn, r.startPlayer);
  assert.equal(r.phase, 'action');
  assert.deepEqual(r.positions, [1, 23]);
  assert.deepEqual(r.scores, [2, 1]);
  assert.equal(r.hands[0].length, 5);
  assert.equal(r.hands[1].length, 5);
  assert.equal(r.deck.length, 15);
  assert.deepEqual(r.discard, []);
  assert.equal(r.roundResult, null);
  assert.equal(r.parried, null);
  assert.equal(sorted(countAll(r)).join(), '1,1,1,1,1,2,2,2,2,2,3,3,3,3,3,4,4,4,4,4,5,5,5,5,5');
  const again = startNextRound(r, seeded(9));
  assert.equal(again, r, 'ラウンド中に startNextRound しても変わらない');
});

test('applyAction と startNextRound は引数の state を変更しない', () => {
  const st = setup({ hands: [[3, 1, 1, 1, 1], [3, 3, 4, 4, 4]], deck: [2, 2, 5, 5, 5, 5], positions: [10, 13], turn: 0 });
  const before = structuredClone(st);
  const n = act(st, 0, { type: 'attack', value: 3, count: 1 });
  assert.deepEqual(st, before);
  const n2 = structuredClone(n);
  act(n, 1, { type: 'move', dir: 'backward', card: 4 });
  assert.deepEqual(n, n2);
  const over = act(setup({ hands: [[3, 1, 1, 1, 1], [2, 2, 2, 4, 4]], deck: [5, 5], positions: [10, 13], turn: 0 }), 0, { type: 'attack', value: 3, count: 1 });
  const o2 = structuredClone(over);
  startNextRound(over, seeded(2));
  assert.deepEqual(over, o2);
});

test('viewFor: 自分の手札だけが見え、相手の手札と山札の並びは含まない', () => {
  const st = setup({ hands: [[1, 1, 2, 2, 5], [3, 3, 4, 4, 4]], deck: [5, 5, 5, 2], positions: [1, 23], turn: 0 });
  const v = viewFor(st, 0);
  assert.equal(v.you, 0);
  assert.deepEqual(sorted(v.myHand), [1, 1, 2, 2, 5]);
  assert.equal(v.opponentHandCount, 5);
  assert.equal(v.deckCount, 4);
  assert.deepEqual(v.positions, [1, 23]);
  assert.equal(v.turn, 0);
  assert.equal(v.phase, 'action');
  assert.deepEqual(v.legal, legalActions(st, 0));
  assert.deepEqual(viewFor(st, 1).legal, []);
  const json = JSON.stringify(v);
  assert.ok(!('hands' in v) && !('deck' in v));
  assert.ok(!/"hands"|"deck"/.test(json), 'hands/deck キーが入っている');
  assert.deepEqual(JSON.parse(json), v);
  const v1 = viewFor(st, 1);
  assert.deepEqual(sorted(v1.myHand), [3, 3, 4, 4, 4]);
});

test('viewFor: 山札切れ判定のときだけ公開手札が見える', () => {
  const st = setup({ hands: [[1, 2, 3, 4, 5], [5, 5, 2, 2, 1]], deck: [4], positions: [5, 15], turn: 0 });
  const n = act(st, 0, { type: 'move', dir: 'forward', card: 5 });
  assert.equal(viewFor(n, 1).roundResult.revealedHands.length, 2);
  const hit = act(setup({ hands: [[3, 1, 1, 1, 1], [2, 2, 2, 4, 4]], deck: [5, 5], positions: [10, 13], turn: 0 }), 0, { type: 'attack', value: 3, count: 1 });
  assert.equal(viewFor(hit, 1).roundResult.revealedHands, undefined);
});

test('ランダム対戦 300 マッチ: 不変条件が崩れず、必ず決着する', () => {
  const rng = seeded(2024);
  for (let m = 0; m < 300; m++) {
    let st = createMatch({ rng, firstPlayer: m % 2 });
    let steps = 0;
    while (st.phase !== 'matchOver') {
      assert.ok(++steps < 5000, '終わらない');
      if (st.phase === 'roundOver') {
        st = startNextRound(st, rng);
        continue;
      }
      const p = st.turn;
      assert.deepEqual(legalActions(st, 1 - p), []);
      const legal = legalActions(st, p);
      assert.ok(legal.length > 0, '手番なのに行動が0（負け判定されていない）');
      const a = legal[Math.floor(rng() * legal.length)];
      st = act(st, p, a);
      assert.equal(sorted(countAll(st)).join(), '1,1,1,1,1,2,2,2,2,2,3,3,3,3,3,4,4,4,4,4,5,5,5,5,5');
      assert.ok(1 <= st.positions[0] && st.positions[0] < st.positions[1] && st.positions[1] <= 23);
      assert.ok(st.hands[0].length <= 5 && st.hands[1].length <= 5);
      if (st.phase === 'action' && st.parried === null) {
        assert.ok(st.deck.length > 0, '山札0なのにラウンドが続いている');
        assert.equal(st.hands[0].length, 5);
        assert.equal(st.hands[1].length, 5);
      }
    }
    assert.ok(st.scores[st.winner] === 5 && st.scores[1 - st.winner] < 5);
  }
});
