// アンギャルド（En Garde）ルールエンジン
// 純粋関数のみ。引数の state は変更せず、新しい state を返す。
// Node でもブラウザでも動く ES Module（Node 専用 API を使わない）。

const BOARD_MIN = 1;
const BOARD_MAX = 23;
const HAND_SIZE = 5;
const CARD_VALUES = 5;
const COPIES = 5;
const WIN_SCORE = 5;

const ok = (state) => ({ ok: true, state });
const err = (error) => ({ ok: false, error });

function clone(value) {
  return structuredClone(value);
}

function distance(state) {
  return Math.abs(state.positions[1] - state.positions[0]);
}

function countIn(hand, value) {
  let n = 0;
  for (const c of hand) if (c === value) n += 1;
  return n;
}

// hand から value を k 枚取り出す。取り出した配列と残りを返す。
function takeCards(hand, value, k) {
  const rest = [];
  const taken = [];
  for (const c of hand) {
    if (c === value && taken.length < k) taken.push(c);
    else rest.push(c);
  }
  return { rest, taken };
}

function buildShuffledDeck(rng) {
  const cards = [];
  for (let v = 1; v <= CARD_VALUES; v += 1) {
    for (let i = 0; i < COPIES; i += 1) cards.push(v);
  }
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = cards[i];
    cards[i] = cards[j];
    cards[j] = tmp;
  }
  return cards;
}

function dealFrom(cards) {
  return {
    hands: [cards.slice(0, HAND_SIZE), cards.slice(HAND_SIZE, HAND_SIZE * 2)],
    deck: cards.slice(HAND_SIZE * 2),
  };
}

export function createMatch({ rng = Math.random, firstPlayer = 0 } = {}) {
  const cards = buildShuffledDeck(rng);
  const { hands, deck } = dealFrom(cards);
  return {
    round: 1,
    startPlayer: firstPlayer,
    scores: [0, 0],
    positions: [1, BOARD_MAX],
    hands,
    deck,
    discard: [],
    turn: firstPlayer,
    phase: 'action',
    parried: null,
    roundResult: null,
    winner: null,
    lastEvents: [],
  };
}

function moveTarget(state, player, dir, card) {
  const from = state.positions[player];
  const sign = player === 0 ? 1 : -1;
  const delta = (dir === 'forward' ? 1 : -1) * sign * card;
  return from + delta;
}

function isLegalMove(state, player, dir, card) {
  const to = moveTarget(state, player, dir, card);
  if (to < BOARD_MIN || to > BOARD_MAX) return false;
  const opponent = state.positions[1 - player];
  if (dir === 'forward') {
    // 相手のマスに止まる・相手を飛び越える移動は不可
    if (player === 0 && to >= opponent) return false;
    if (player === 1 && to <= opponent) return false;
  }
  return true;
}

export function legalActions(state, player) {
  if (player !== 0 && player !== 1) return [];
  if (state.phase !== 'action') return [];
  if (state.turn !== player) return [];

  const actions = [];
  const hand = state.hands[player];

  const seen = new Set();
  for (const card of hand) {
    if (seen.has(card)) continue;
    seen.add(card);
    if (isLegalMove(state, player, 'forward', card)) {
      actions.push({ type: 'move', dir: 'forward', card });
    }
    if (isLegalMove(state, player, 'backward', card)) {
      actions.push({ type: 'move', dir: 'backward', card });
    }
  }

  const d = distance(state);
  const available = countIn(hand, d);
  for (let k = 1; k <= available; k += 1) {
    actions.push({ type: 'attack', value: d, count: k });
  }
  return actions;
}

function replenish(state, player) {
  const need = HAND_SIZE - state.hands[player].length;
  if (need <= 0) return;
  const draw = state.deck.slice(0, need);
  state.deck = state.deck.slice(need);
  state.hands[player] = [...state.hands[player], ...draw];
}

function judgeDeck(state) {
  const d = distance(state);
  const c0 = countIn(state.hands[0], d);
  const c1 = countIn(state.hands[1], d);
  if (c0 > c1) return 0;
  if (c1 > c0) return 1;
  const advance0 = state.positions[0] - BOARD_MIN;
  const advance1 = BOARD_MAX - state.positions[1];
  if (advance0 > advance1) return 0;
  if (advance1 > advance0) return 1;
  return null;
}

function endRound(state, winner, reason, events, revealedHands) {
  const roundResult = { winner, reason };
  if (reason === 'deck' && revealedHands) {
    roundResult.revealedHands = revealedHands.map((h) => h.slice());
  }
  state.roundResult = roundResult;
  state.phase = 'roundOver';
  state.parried = null;
  if (winner !== null) {
    state.scores = [...state.scores];
    state.scores[winner] += 1;
  }
  events.push({ type: 'roundEnd', winner, reason });
  if (winner !== null && state.scores[winner] >= WIN_SCORE) {
    state.winner = winner;
    state.phase = 'matchOver';
    events.push({ type: 'matchEnd', winner });
  }
}

function finishByDeck(state, events) {
  const winner = judgeDeck(state);
  endRound(state, winner, 'deck', events, [state.hands[0], state.hands[1]]);
}

function checkStuck(state, events) {
  const player = state.turn;
  if (legalActions(state, player).length === 0) {
    events.push({ type: 'stuck', player });
    endRound(state, 1 - player, 'stuck', events);
  }
}

function applyMove(state, player, action) {
  const { dir, card } = action;
  if (dir !== 'forward' && dir !== 'backward') return err('移動方向が不正です');
  if (!Number.isInteger(card) || card < 1 || card > CARD_VALUES) {
    return err('カードの値が不正です');
  }
  if (!state.hands[player].includes(card)) return err('そのカードを持っていません');
  if (!isLegalMove(state, player, dir, card)) {
    return err('そこへは移動できません');
  }

  const s = clone(state);
  s.parried = null;
  const from = s.positions[player];
  const to = moveTarget(s, player, dir, card);

  const { rest, taken } = takeCards(s.hands[player], card, 1);
  s.hands = [...s.hands];
  s.hands[player] = rest;
  s.discard = [...s.discard, ...taken];
  s.positions = [...s.positions];
  s.positions[player] = to;

  const events = [{ type: 'move', player, dir, card, from, to }];
  const deckBefore = s.deck.length;
  replenish(s, player);
  const deckOut = deckBefore > 0 && s.deck.length === 0;
  if (deckOut) events.push({ type: 'deckOut' });

  s.turn = 1 - player;
  if (deckOut) {
    finishByDeck(s, events);
  } else {
    checkStuck(s, events);
  }
  s.lastEvents = events;
  return ok(s);
}

function applyAttack(state, player, action) {
  const { value, count } = action;
  const d = distance(state);
  if (!Number.isInteger(value) || value < 1 || value > CARD_VALUES || value !== d) {
    return err('攻撃は現在の距離とちょうどの数字のカードで行います');
  }
  if (!Number.isInteger(count) || count < 1) return err('攻撃の枚数が不正です');
  if (countIn(state.hands[player], d) < count) {
    return err('その数字のカードが足りません');
  }

  const s = clone(state);
  s.parried = null;

  const { rest, taken } = takeCards(s.hands[player], d, count);
  s.hands = [...s.hands];
  s.hands[player] = rest;
  s.discard = [...s.discard, ...taken];

  const events = [{ type: 'attack', player, value: d, count }];
  const deckBefore = s.deck.length;
  replenish(s, player);
  const deckOut = deckBefore > 0 && s.deck.length === 0;
  if (deckOut) events.push({ type: 'deckOut' });

  const opponent = 1 - player;
  const canParry = countIn(s.hands[opponent], d) >= count;

  if (canParry) {
    const parsed = takeCards(s.hands[opponent], d, count);
    s.hands[opponent] = parsed.rest;
    s.discard = [...s.discard, ...parsed.taken];
    events.push({ type: 'parry', player: opponent, value: d, count });
    s.turn = opponent;
    if (deckOut) {
      // パリィ後の手番は行わず、そのまま山札切れ判定へ
      finishByDeck(s, events);
    } else {
      s.parried = opponent;
      checkStuck(s, events);
    }
  } else {
    events.push({ type: 'hit', player });
    s.turn = opponent;
    endRound(s, player, 'hit', events);
  }

  s.lastEvents = events;
  return ok(s);
}

export function applyAction(state, player, action) {
  if (state.phase !== 'action') return err('今は行動できません');
  if (player !== 0 && player !== 1) return err('プレイヤーが不正です');
  if (state.turn !== player) return err('あなたの手番ではありません');
  if (action === null || typeof action !== 'object' || Array.isArray(action)) {
    return err('行動の形式が不正です');
  }
  if (action.type === 'move') return applyMove(state, player, action);
  if (action.type === 'attack') return applyAttack(state, player, action);
  return err('不明な行動です');
}

export function startNextRound(state, rng = Math.random) {
  if (state.phase !== 'roundOver') return state;
  const cards = buildShuffledDeck(rng);
  const { hands, deck } = dealFrom(cards);
  const firstPlayer = 1 - state.startPlayer;
  return {
    round: state.round + 1,
    startPlayer: firstPlayer,
    scores: [...state.scores],
    positions: [1, BOARD_MAX],
    hands,
    deck,
    discard: [],
    turn: firstPlayer,
    phase: 'action',
    parried: null,
    roundResult: null,
    winner: null,
    lastEvents: [],
  };
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
    myHand: [...state.hands[player]],
    opponentHandCount: state.hands[1 - player].length,
    deckCount: state.deck.length,
    discardTop: state.discard.length ? state.discard[state.discard.length - 1] : null,
    roundResult: state.roundResult,
    lastEvents: state.lastEvents,
    legal: legalActions(state, player),
  };
}
