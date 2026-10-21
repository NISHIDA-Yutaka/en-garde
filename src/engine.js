// アンギャルド（En Garde）基本ルールのエンジン。
// state はプレーンなオブジェクトで、どの関数も引数を変更せずに新しい state を返す。
// Node でもブラウザでも動くよう、Node 専用の API は使わない。

export const FIRST_CELL = 1;
export const LAST_CELL = 23;
export const HAND_SIZE = 5;
export const MAX_CARD = 5;
export const WIN_SCORE = 5;

const COPIES = 5;

const distanceOf = (state) => state.positions[1] - state.positions[0];
const countOf = (hand, value) => hand.filter((c) => c === value).length;
const fail = (error) => ({ ok: false, error });

// 各プレイヤーの「前」の向き。プレイヤー0は右（+1）、プレイヤー1は左（-1）
const facing = (player) => (player === 0 ? 1 : -1);

function shuffledDeck(rng) {
  const cards = [];
  for (let v = 1; v <= MAX_CARD; v += 1) for (let i = 0; i < COPIES; i += 1) cards.push(v);
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function freshRound(rng, startPlayer) {
  const cards = shuffledDeck(rng);
  return {
    startPlayer,
    positions: [FIRST_CELL, LAST_CELL],
    hands: [cards.slice(0, HAND_SIZE), cards.slice(HAND_SIZE, HAND_SIZE * 2)],
    deck: cards.slice(HAND_SIZE * 2),
    discard: [],
    turn: startPlayer,
    phase: 'action',
    parried: null,
    roundResult: null,
    lastEvents: [],
  };
}

export function createMatch({ rng = Math.random, firstPlayer = 0 } = {}) {
  return { round: 1, scores: [0, 0], winner: null, ...freshRound(rng, firstPlayer) };
}

export function startNextRound(state, rng = Math.random) {
  if (state.phase !== 'roundOver') return state;
  return {
    round: state.round + 1,
    scores: [...state.scores],
    winner: null,
    ...freshRound(rng, 1 - state.startPlayer),
  };
}

// 移動先のマス。動けないなら null
function moveTarget(state, player, dir, card) {
  const step = (dir === 'forward' ? 1 : -1) * facing(player) * card;
  const to = state.positions[player] + step;
  if (to < FIRST_CELL || to > LAST_CELL) return null;
  const other = state.positions[1 - player];
  // 相手のマスに止まる・飛び越えるのは、相手側へ進むときだけ起こる
  if (player === 0 ? to >= other : to <= other) return null;
  return to;
}

export function legalActions(state, player) {
  if (state.phase !== 'action' || state.turn !== player) return [];
  const hand = state.hands[player];
  const actions = [];
  for (const card of [...new Set(hand)].sort((a, b) => a - b)) {
    for (const dir of ['forward', 'backward']) {
      if (moveTarget(state, player, dir, card) !== null) actions.push({ type: 'move', dir, card });
    }
  }
  const d = distanceOf(state);
  const have = countOf(hand, d);
  for (let count = 1; count <= have; count += 1) actions.push({ type: 'attack', value: d, count });
  return actions;
}

// --- 状態を書き換える小さな手続き（applyAction の中で、コピーした state にだけ使う）

function removeCards(state, player, value, count) {
  const hand = [...state.hands[player]];
  for (let i = 0; i < count; i += 1) hand.splice(hand.indexOf(value), 1);
  state.hands[player] = hand;
  state.discard.push(...Array(count).fill(value));
}

// 手札を5枚まで引く。この補充で山札が尽きたら true
function refill(state, player) {
  const need = HAND_SIZE - state.hands[player].length;
  if (need <= 0 || state.deck.length === 0) return false;
  state.hands[player] = [...state.hands[player], ...state.deck.slice(0, need)];
  state.deck = state.deck.slice(need);
  return state.deck.length === 0;
}

function finishRound(state, winner, reason, events) {
  state.phase = 'roundOver';
  state.parried = null;
  state.roundResult = { winner, reason };
  if (reason === 'deck') state.roundResult.revealedHands = state.hands.map((h) => [...h]);
  if (winner !== null) state.scores[winner] += 1;
  events.push({ type: 'roundEnd', winner, reason });
  if (winner !== null && state.scores[winner] >= WIN_SCORE) {
    state.phase = 'matchOver';
    state.winner = winner;
    events.push({ type: 'matchEnd', winner });
  }
}

// 山札切れの判定: 距離ちょうどの札が多い方 → 前進した距離が長い方 → 引き分け
export function judgeDeckOut(positions, hands) {
  const d = positions[1] - positions[0];
  const counts = hands.map((h) => countOf(h, d));
  if (counts[0] !== counts[1]) return counts[0] > counts[1] ? 0 : 1;
  const advance = [positions[0] - FIRST_CELL, LAST_CELL - positions[1]];
  if (advance[0] !== advance[1]) return advance[0] > advance[1] ? 0 : 1;
  return null;
}

// 手番を相手に渡す。相手が何もできなければ、その時点で相手の負け
function passTurn(state, player, events) {
  state.turn = 1 - player;
  if (legalActions(state, state.turn).length === 0) {
    events.push({ type: 'stuck', player: state.turn });
    finishRound(state, player, 'stuck', events);
  }
}

function copyForUpdate(state) {
  return {
    ...state,
    scores: [...state.scores],
    positions: [...state.positions],
    hands: state.hands.map((h) => [...h]),
    deck: [...state.deck],
    discard: [...state.discard],
  };
}

const isCard = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_CARD;

export function applyAction(state, player, action) {
  if (player !== 0 && player !== 1) return fail('プレイヤーが正しくありません');
  if (state.phase !== 'action') return fail('いまは行動できません');
  if (state.turn !== player) return fail('あなたの手番ではありません');
  if (!action || typeof action !== 'object') return fail('行動の形式が正しくありません');

  const hand = state.hands[player];
  const events = [];
  let s;

  if (action.type === 'move') {
    const { dir, card } = action;
    if (dir !== 'forward' && dir !== 'backward') return fail('移動の向きが正しくありません');
    if (!isCard(card)) return fail('カードの数字が正しくありません');
    if (!hand.includes(card)) return fail('そのカードは持っていません');
    const to = moveTarget(state, player, dir, card);
    if (to === null) return fail('そのマスには移動できません');

    s = copyForUpdate(state);
    events.push({ type: 'move', player, dir, card, from: s.positions[player], to });
    s.positions[player] = to;
    removeCards(s, player, card, 1);
  } else if (action.type === 'attack') {
    const { value, count } = action;
    const d = distanceOf(state);
    if (!isCard(value) || value !== d) return fail(`攻撃には距離と同じ「${d}」のカードが必要です`);
    if (!Number.isInteger(count) || count < 1) return fail('攻撃の枚数が正しくありません');
    if (countOf(hand, value) < count) return fail(`「${value}」が${count}枚ありません`);

    s = copyForUpdate(state);
    events.push({ type: 'attack', player, value, count });
    removeCards(s, player, value, count);
  } else {
    return fail('知らない行動です');
  }

  s.parried = null;
  const deckOut = refill(s, player);
  if (deckOut) events.push({ type: 'deckOut' });

  if (action.type === 'attack') {
    const defender = 1 - player;
    const { value, count } = action;
    if (countOf(s.hands[defender], value) < count) {
      events.push({ type: 'hit', player });
      s.turn = defender;
      finishRound(s, player, 'hit', events);
      s.lastEvents = events;
      return { ok: true, state: s };
    }
    // パリィは自動。防御側は補充せずに次の手番を行う
    removeCards(s, defender, value, count);
    events.push({ type: 'parry', player: defender, value, count });
    if (!deckOut) s.parried = defender;
  }

  if (deckOut) {
    s.turn = 1 - player;
    finishRound(s, judgeDeckOut(s.positions, s.hands), 'deck', events);
  } else {
    passTurn(s, player, events);
  }
  s.lastEvents = events;
  return { ok: true, state: s };
}

export function viewFor(state, player) {
  return {
    you: player,
    round: state.round,
    startPlayer: state.startPlayer,
    scores: [...state.scores],
    positions: [...state.positions],
    turn: state.turn,
    phase: state.phase,
    winner: state.winner,
    myHand: [...state.hands[player]].sort((a, b) => a - b),
    opponentHandCount: state.hands[1 - player].length,
    deckCount: state.deck.length,
    discardTop: state.discard.length ? state.discard[state.discard.length - 1] : null,
    parried: state.parried,
    roundResult: state.roundResult,
    lastEvents: state.lastEvents,
    legal: legalActions(state, player),
  };
}
