// ブラウザなしで public/app.js を実行し、DOM 操作とマッチ進行が例外を出さないか確認する。
// 最小限の DOM / WebSocket シムを用意し、本物の app.js を読み込んで 1 マッチ駆動する。
import { createMatch, applyAction, startNextRound, viewFor, legalActions } from '../src/engine.js';

// --------------------------------------------------------- DOM シム
function makeEl(tag = 'div') {
  const el = {
    tagName: tag,
    children: [],
    _listeners: {},
    _classes: new Set(),
    _html: '',
    value: '',
    disabled: false,
    hidden: false,
    textContent: '',
    offsetWidth: 1,
    style: new Proxy({}, { set: (t, k, v) => { t[k] = v; return true; }, get: (t, k) => t[k] || '' }),
    set innerHTML(v) { this._html = v; if (v === '') this.children = []; },
    get innerHTML() { return this._html; },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    prepend(c) { this.children.unshift(c); return c; },
    get lastChild() { return this.children[this.children.length - 1] || null; },
    querySelector() { this._qs = this._qs || makeEl('button'); return this._qs; },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    trigger(type) { (this._listeners[type] || []).forEach((fn) => fn({})); },
    select() {}, focus() {}, remove() {},
  };
  Object.defineProperty(el, 'classList', {
    get() {
      const self = this;
      return {
        add: (...c) => c.forEach((x) => self._classes.add(x)),
        remove: (...c) => c.forEach((x) => self._classes.delete(x)),
        toggle: (c, force) => { const on = force === undefined ? !self._classes.has(c) : force; if (on) self._classes.add(c); else self._classes.delete(c); return on; },
        contains: (c) => self._classes.has(c),
      };
    },
  });
  return el;
}

const registry = new Map();
globalThis.document = {
  getElementById: (id) => { if (!registry.has(id)) registry.set(id, makeEl()); return registry.get(id); },
  createElement: (tag) => makeEl(tag),
  execCommand: () => true,
};
const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
const sessionStore = {};
globalThis.sessionStorage = {
  getItem: (k) => (k in sessionStore ? sessionStore[k] : null),
  setItem: (k, v) => { sessionStore[k] = String(v); },
  removeItem: (k) => { delete sessionStore[k]; },
};
globalThis.location = { origin: 'http://localhost', host: 'localhost', protocol: 'http:', search: '' };
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true });

let match = createMatch({ firstPlayer: 0 });
let sent = [];
let errors = [];
let ws;

globalThis.WebSocket = class {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this._listeners = {};
    ws = this;
  }
  send(data) {
    const msg = JSON.parse(data);
    sent.push(msg);
    handleClientSend(this, msg);
  }
  close() { this.readyState = 3; }
  addEventListener() {}
};
globalThis.WebSocket.OPEN = 1;

function emitOn(target, type, arg) {
  const fn = target[`on${type}`];
  if (typeof fn === 'function') fn(arg);
}

let seq = 0;
function feed(msg) { emitOn(ws, 'message', { data: JSON.stringify(msg) }); }
function feedState() {
  seq += 1; // マッチの state が変わるたびに増やす（本番サーバーと同じ）
  feed({ t: 'state', seq, view: viewFor(match, 0), names: ['アリス', 'ボブ'], ready: [false, false] });
}

function handleClientSend(sock, msg) {
  try {
    if (msg.t === 'action') {
      const r = applyAction(match, 0, msg.action);
      if (!r.ok) { errors.push(r.error); return; }
      match = r.state;
      feedState();
    } else if (msg.t === 'next') {
      match = startNextRound(match, Math.random);
      feedState();
    } else if (msg.t === 'rematch') {
      match = createMatch({ firstPlayer: 1 });
      feedState();
    } else if (msg.t === 'create') {
      feed({ t: 'created', room: 'ABCDE', token: 'x'.repeat(24), player: 0 });
    }
  } catch (error) {
    errors.push(`handler: ${error.message}`);
  }
}

// --------------------------------------------------------- app.js 読み込み
await import('../public/app.js');

ws.readyState = 1;
emitOn(ws, 'open');

// ロビー → 部屋作成 → 待機 → 対戦開始
registry.get('create-btn').trigger('click'); // created + state(null)
feedState(); // 対戦開始の state

const view = () => viewFor(match, 0);
function selectCard(value) {
  const v = view();
  const sorted = [...v.myHand].sort((a, b) => a - b);
  const idx = sorted.indexOf(value);
  const child = registry.get('my-hand').children[idx];
  if (!child) throw new Error(`手札に ${value} の要素がない`);
  child.trigger('click');
}

let steps = 0;
while (match.phase !== 'matchOver') {
  if (++steps > 5000) throw new Error('終わらない');
  if (match.phase === 'roundOver') {
    const btn = registry.get('modal-actions').children[0];
    if (!btn) throw new Error('次のラウンドボタンがない');
    btn.trigger('click');
    continue;
  }
  const turn = match.turn;
  const legal = legalActions(match, turn);
  const attack = legal.find((a) => a.type === 'attack' && a.count === 1) || legal.find((a) => a.type === 'attack');
  const move = legal.find((a) => a.type === 'move' && a.dir === 'forward') || legal.find((a) => a.type === 'move');
  if (turn === 0) {
    if (attack) {
      selectCard(attack.value);
      for (let i = 1; i < attack.count; i += 1) registry.get('count-plus').trigger('click');
      registry.get('attack-btn').trigger('click');
    } else {
      selectCard(move.card);
      registry.get(move.dir === 'forward' ? 'move-forward' : 'move-backward').trigger('click');
    }
  } else {
    const action = attack || move || legal[0];
    match = applyAction(match, turn, action).state;
    feedState();
  }
}

if (match.phase !== 'matchOver' || !(match.winner === 0 || match.winner === 1)) {
  throw new Error('マッチが正常に終わらない');
}
if (errors.length) throw new Error(`クライアントが送った行動でエラー: ${errors.join(' / ')}`);
if (match.scores[match.winner] !== 5) {
  throw new Error(`5点先取になっていない: 勝者 P${match.winner} スコア ${match.scores[0]}-${match.scores[1]}`);
}

// 再戦に進む前に、マッチ終了時点の本当の結果を控えておく
const winner = match.winner;
const finalScores = [...match.scores];
const finalRound = match.round;
const logCount = registry.get('log').children.length;
if (logCount === 0) throw new Error('行動ログが1件も出ていない');

// マッチ終了モーダルの再戦
registry.get('modal-actions').children[0].trigger('click');
if (match.scores[0] !== 0 || match.scores[1] !== 0 || match.round !== 1) {
  throw new Error('再戦が初期化されていない');
}

console.log(`クライアントスモーク OK（${steps} ステップ, 勝者 P${winner}, 最終スコア ${finalScores[0]}-${finalScores[1]}, ${finalRound}ラウンド）`);
console.log(`ログ件数: ${logCount}`);
