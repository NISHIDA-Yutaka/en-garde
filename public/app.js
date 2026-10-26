// アンギャルド オンライン対戦のクライアント。
// 勝敗はサーバーが決める。ここは届いた状態（view）を描き、lastEvents を演出として再生するだけ。
import { createFencer, createFigure, setFace, mascotSvg } from './mascot.js';

const $ = (id) => document.getElementById(id);
const CELLS = 23;
const CENTER_CELL = 12;
const COLOR = ['オレンジ', 'ブルー'];
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, reduceMotion ? Math.min(ms, 40) : ms));
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const app = {
  ws: null,
  connected: false,
  retry: 0,
  room: null,
  token: null,
  seat: null,
  resuming: false,
  pending: null, // 接続できたら送るメッセージ（作成・参加）
  superseded: false,

  view: null,
  names: ['', ''],
  ready: [false, false],
  peers: [true, true],
  seq: -1,
  selected: [], // 選んだ手札の位置（view.myHand の添え字）
  busy: false, // 行動を送って結果を待っている
  animating: false,
  queue: Promise.resolve(),
  modalKey: null,
  inviteRoom: new URLSearchParams(location.search).get('room')?.toUpperCase() || null,
  demo: null, // 演出の確認用ページのとき 'victory' / 'defeat'（サーバーにはつながない）
};

// ------------------------------------------------------------------ 保存
// 席の情報はタブごと（sessionStorage）。同じブラウザの2つのタブで対戦できるように
const store = {
  get seat() {
    try { return JSON.parse(sessionStorage.getItem('engarde:seat')); } catch { return null; }
  },
  set seat(v) {
    try { v ? sessionStorage.setItem('engarde:seat', JSON.stringify(v)) : sessionStorage.removeItem('engarde:seat'); } catch { /* 保存できなくても遊べる */ }
  },
  get name() {
    try { return localStorage.getItem('engarde:name') || ''; } catch { return ''; }
  },
  set name(v) {
    try { localStorage.setItem('engarde:name', v); } catch { /* 同上 */ }
  },
};

// ------------------------------------------------------------------ 通信

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  app.ws = ws;
  ws.onopen = () => {
    app.connected = true;
    app.retry = 0;
    renderPresence();
    if (app.room && app.token) {
      app.resuming = true;
      send({ t: 'resume', room: app.room, token: app.token });
    } else if (app.pending) {
      send(app.pending);
      app.pending = null;
    }
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    onMessage(msg);
  };
  ws.onclose = (e) => {
    app.connected = false;
    if (app.ws !== ws) return;
    if (e.code === 4001) {
      app.superseded = true;
      showSuperseded();
      return;
    }
    renderPresence();
    const wait = Math.min(1000 * 2 ** app.retry, 8000);
    app.retry += 1;
    setTimeout(connect, wait);
  };
}

function send(msg) {
  if (app.ws && app.ws.readyState === WebSocket.OPEN) {
    app.ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

function sendOrQueue(msg) {
  if (!send(msg)) app.pending = msg;
}

function onMessage(msg) {
  switch (msg.t) {
    case 'created':
    case 'joined':
      app.room = msg.room;
      app.token = msg.token;
      app.seat = msg.player;
      app.resuming = false;
      store.seat = { room: msg.room, token: msg.token };
      document.body.classList.toggle('me-blue', app.seat === 1);
      break;
    case 'state':
      app.queue = app.queue.then(() => onState(msg)).catch((err) => console.error(err));
      break;
    case 'presence':
      app.peers = msg.connected;
      renderPresence();
      break;
    case 'error':
      onError(msg.message);
      break;
    default:
  }
}

function onError(message) {
  if (app.resuming) {
    // 部屋が消えた・席がない。最初の画面に戻す
    app.resuming = false;
    app.room = null;
    app.token = null;
    store.seat = null;
    showLobby();
    toast(`${message}。最初の画面に戻りました`);
    return;
  }
  if (app.busy) {
    app.busy = false;
    render();
  }
  const lobbyVisible = !$('screen-lobby').hidden;
  if (lobbyVisible) {
    const box = $('lobby-invited').hidden ? $('lobby-error') : $('invited-error');
    box.textContent = message;
    box.hidden = false;
  } else {
    toast(message);
  }
}

// ------------------------------------------------------------------ 状態の受け取り

async function onState(msg) {
  app.names = msg.names.map((n, i) => n ?? (i === 0 ? 'プレイヤー1' : 'プレイヤー2'));
  app.ready = msg.ready;
  const v = msg.view;

  if (!v) {
    showWait();
    return;
  }
  const prev = app.view;
  const fresh = msg.seq > app.seq;
  if (!fresh && prev) {
    // 準備完了の変化だけ
    renderModalButtons();
    return;
  }
  const consecutive = prev && msg.seq === app.seq + 1;
  app.seq = msg.seq;
  showScreen('game');

  const newMatch = !prev || (v.round === 1 && prev.round !== 1) || (v.round === 1 && prev.phase === 'matchOver');
  const newRound = prev && v.round !== prev.round;

  if (newMatch) clearLog();
  if (newRound || !prev) {
    logSeparator(`第${v.round}ラウンド ・ 先手 ${nameOf(v.startPlayer)}`);
  }

  if (consecutive && !newRound && v.lastEvents.length) {
    logEvents(v.lastEvents);
    app.animating = true; // 演出の間は操作できない
    app.selected = [];
    render();
    try {
      await playEvents(prev, v);
    } finally {
      app.animating = false;
    }
  }

  app.view = v;
  app.busy = false;
  app.selected = [];
  render({ handFrom: prev?.round === v.round ? prev.myHand : null, scoresFrom: prev?.scores });

  if (newRound || (newMatch && prev)) roundIntro(v);
  if (v.phase === 'roundOver') showRoundModal(v);
  else if (v.phase === 'matchOver') showMatchModal(v);
  else if (app.modalKey && app.modalKey !== 'rules' && app.modalKey !== 'superseded') closeModal();
}

// ------------------------------------------------------------------ 画面の切り替え

function showScreen(name) {
  for (const id of ['lobby', 'wait', 'game']) $(`screen-${id}`).hidden = id !== name;
  renderPresence();
}

function showLobby() {
  showScreen('lobby');
  const invited = app.inviteRoom && /^[A-HJ-NP-Z2-9]{5}$/.test(app.inviteRoom);
  $('lobby-invited').hidden = !invited;
  $('lobby-create').hidden = !!invited;
  if (invited) {
    $('invited-code').textContent = app.inviteRoom;
    $('invited-name').value = store.name;
  } else {
    $('name-input').value = store.name;
  }
}

function showWait() {
  showScreen('wait');
  $('wait-code').textContent = app.room || '-----';
  $('invite-url').value = app.room ? `${location.origin}/?room=${app.room}` : '';
  $('share-btn').hidden = !navigator.share;
}

// ------------------------------------------------------------------ 試合場の組み立て

const fencers = [createFencer(0), createFencer(1)];
const lane = document.createElement('div');

function buildPiste() {
  lane.className = 'lane';
  $('piste').insertBefore(lane, $('tiles'));
  lane.append(...fencers);
  for (let c = 1; c <= CELLS; c += 1) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = `tile${c === CENTER_CELL ? ' center' : ''}`;
    tile.dataset.cell = c;
    tile.tabIndex = -1;
    tile.setAttribute('aria-label', `${c}マス目`);
    tile.addEventListener('click', () => onTile(c));
    $('tiles').append(tile);
    const num = document.createElement('span');
    num.textContent = c;
    if (c === CENTER_CELL) num.className = 'center';
    $('numbers').append(num);
  }
  $('brand-mascot').innerHTML = mascotSvg();
  $('brand-mascot').classList.add('p0');
  $('title-duel').append(createFigure(0), createFigure(1));
  const ghost = document.createElement('div');
  ghost.className = 'ghost';
  ghost.textContent = '?';
  $('wait-duel').append(createFigure(0), ghost);
}

const cellPct = (cell) => `${((cell - 0.5) / CELLS) * 100}%`;
const cellPx = () => $('tiles').clientWidth / CELLS;
const tileEl = (cell) => $('tiles').children[cell - 1];

function placeFencers(positions) {
  fencers.forEach((f, p) => { f.style.left = cellPct(positions[p]); });
  const [a, b] = positions;
  const bracket = $('bracket');
  bracket.style.left = cellPct(a);
  bracket.style.width = `${((b - a) / CELLS) * 100}%`;
  $('bracket-pill').textContent = `距離 ${b - a}`;
}

// ------------------------------------------------------------------ 描画

const nameOf = (p) => app.names[p] || (p === 0 ? 'プレイヤー1' : 'プレイヤー2');
const whoHtml = (p) => `<span class="who${p}">${escapeHtml(nameOf(p))}</span>`;
const distanceOf = (v) => v.positions[1] - v.positions[0];

function selection(v = app.view) {
  if (!v || app.selected.length === 0) return null;
  return { value: v.myHand[app.selected[0]], count: app.selected.length };
}

function render(opts = {}) {
  const v = app.view;
  if (!v) return;
  renderStatic(v, opts);
}

function renderStatic(v, { handFrom = null, scoresFrom = null } = {}) {
  const me = app.seat;
  const myTurn = v.phase === 'action' && v.turn === me && !app.busy && !app.animating;
  const screen = $('screen-game');
  screen.classList.toggle('me-blue', me === 1);
  screen.classList.toggle('their-turn', !myTurn);

  // 点数
  for (const p of [0, 1]) {
    $(`name-${p}`).innerHTML = `${escapeHtml(nameOf(p))}${p === me ? '<span class="you-tag">あなた</span>' : ''}`;
    const pips = $(`pips-${p}`);
    pips.innerHTML = '';
    for (let i = 0; i < 5; i += 1) {
      const pip = document.createElement('span');
      pip.className = 'pip';
      if (i < v.scores[p]) pip.classList.add('on');
      if (scoresFrom && i >= scoresFrom[p] && i < v.scores[p]) pip.classList.add('new');
      pips.append(pip);
    }
  }
  $('round-badge').textContent = v.round;

  if (!app.animating) renderHeadline(v, myTurn);

  // 試合場
  if (!app.animating) placeFencers(v.positions);
  const d = distanceOf(v);
  const canAttack = myTurn && v.legal.some((a) => a.type === 'attack');
  $('bracket').classList.toggle('attackable', canAttack);
  fencers.forEach((f, p) => {
    f.classList.toggle('active', v.phase === 'action' && v.turn === p);
    f.querySelector('.thinking')?.remove();
    if (!app.animating && v.phase === 'action' && v.turn === p && p !== me) {
      const t = document.createElement('div');
      t.className = 'thinking';
      t.innerHTML = '<i>.</i><i>.</i><i>.</i>';
      f.append(t);
    }
    if (!app.animating && v.phase === 'action') {
      f.classList.remove('hurt');
      if (f.dataset.face !== 'blink') setFace(f, 'normal');
    }
  });

  const sel = myTurn ? selection(v) : null;
  for (const tile of $('tiles').children) {
    tile.classList.remove('target');
    delete tile.dataset.dir;
    tile.tabIndex = -1;
  }
  if (sel && sel.count === 1) {
    for (const a of v.legal) {
      if (a.type !== 'move' || a.card !== sel.value) continue;
      const to = moveTo(v, me, a.dir, a.card);
      const tile = tileEl(to);
      tile.classList.add('target');
      tile.dataset.dir = a.dir === 'forward' ? '前進' : '後退';
      tile.tabIndex = 0;
    }
  }

  renderHands(v, myTurn, handFrom);

  // 山札・捨て札
  $('deck-count').textContent = v.deckCount;
  $('deck-count').classList.toggle('low', v.deckCount > 0 && v.deckCount <= 3);
  $('deck-card').style.visibility = v.deckCount > 0 ? 'visible' : 'hidden';
  const discard = $('discard-card');
  discard.innerHTML = '';
  discard.append(v.discardTop ? cardFace(v.discardTop, 'div') : Object.assign(document.createElement('div'), { className: 'slot' }));

  renderActions(v, myTurn, sel, d);
}

function renderHeadline(v, myTurn) {
  const me = app.seat;
  const opp = 1 - me;
  const title = $('turn-title');
  const sub = $('turn-sub');
  const d = distanceOf(v);
  const hl = me === 1 ? 'hl-blue' : 'hl';

  if (v.phase === 'roundOver') {
    title.textContent = 'ラウンド終了';
    sub.textContent = '';
    return;
  }
  if (v.phase === 'matchOver') {
    title.textContent = '試合終了';
    sub.textContent = '';
    return;
  }
  if (v.turn !== me) {
    title.textContent = `${nameOf(opp)}の番`;
    sub.innerHTML = v.parried === opp
      ? `${whoHtml(opp)}が受け流して反撃の番です（補充はこの手番の終わり）`
      : `相手が考えています… いまの距離は <span class="${hl}">${d}</span>`;
    return;
  }
  title.textContent = 'あなたの番';
  const sel = selection(v);
  const attackCount = v.legal.filter((a) => a.type === 'attack').length; // 手持ちの距離ちょうどの札の枚数
  const lead = v.parried === me ? `<span class="${hl}">受け流した！</span> 反撃のチャンス。` : '';
  if (!sel) {
    sub.innerHTML = attackCount
      ? `${lead}距離 <span class="${hl}">${d}</span>。「${d}」のカードで<span class="${hl}">攻撃できます！</span>`
      : `${lead}カードを選んでください。いまの距離は <span class="${hl}">${d}</span>`;
    return;
  }
  if (sel.value === d) {
    if (sel.count < attackCount) {
      sub.innerHTML = `「${d}」×${sel.count}で攻撃できます。同じ「${d}」をもう1枚選ぶと<span class="${hl}">×${sel.count + 1}</span>に強くなります`;
    } else if (sel.count > 1) {
      sub.innerHTML = `<span class="${hl}">「${d}」×${sel.count}</span>で攻撃！ 相手は「${d}」を${sel.count}枚出さないと防げません`;
    } else {
      sub.innerHTML = `<span class="${hl}">「${d}」で攻撃</span>できます。光ったマスを押せば移動もできます`;
    }
    return;
  }
  const moves = v.legal.filter((a) => a.type === 'move' && a.card === sel.value);
  sub.innerHTML = moves.length
    ? `「${sel.value}」で <span class="${hl}">${sel.value}マス</span>動けます。光ったマスかボタンを押してください`
    : `「${sel.value}」ではどこにも動けません`;
}

function moveTo(v, player, dir, card) {
  const facing = player === 0 ? 1 : -1;
  return v.positions[player] + (dir === 'forward' ? 1 : -1) * facing * card;
}

// 手札。どの札も「1枚の実物」として扱い、選んだ札だけを持ち上げる
function renderHands(v, myTurn, handFrom) {
  const me = app.seat;
  const opp = 1 - me;
  const usable = new Set();
  for (const a of v.legal) usable.add(a.type === 'move' ? a.card : a.value);

  const mine = $(`hand-${me}`);
  const theirs = $(`hand-${opp}`);
  $(`zone-${me}`).className = 'hand-zone mine';
  $(`zone-${opp}`).className = 'hand-zone opp';
  mine.className = 'hand';
  theirs.className = 'hand opp';
  $(`label-${me}`).className = `zone-label p${me}`;
  $(`label-${me}`).textContent = `${COLOR[me]}の手札（あなた）`;
  $(`label-${opp}`).className = `zone-label p${opp}`;
  $(`label-${opp}`).textContent = `${nameOf(opp)}の手札`;

  // 新しく引いた札に印をつける
  const fresh = new Array(v.myHand.length).fill(false);
  if (handFrom) {
    const left = [...handFrom];
    v.myHand.forEach((c, i) => {
      const k = left.indexOf(c);
      if (k === -1) fresh[i] = true;
      else left.splice(k, 1);
    });
  }

  mine.innerHTML = '';
  v.myHand.forEach((value, i) => {
    const card = cardFace(value, 'button');
    card.style.setProperty('--tilt', `${((i * 37) % 7 - 3) * 0.7}deg`);
    const order = app.selected.indexOf(i);
    if (order !== -1 && myTurn) {
      card.classList.add('selected');
      if (app.selected.length > 1) card.dataset.order = order + 1;
    }
    if (myTurn && !usable.has(value)) card.classList.add('dim');
    if (fresh[i]) card.classList.add('arriving');
    card.disabled = !myTurn || !usable.has(value);
    card.setAttribute('aria-pressed', String(order !== -1));
    card.setAttribute('aria-label', `「${value}」のカード`);
    card.addEventListener('click', () => toggleCard(i));
    mine.append(card);
  });
  if (!v.myHand.length) mine.append(Object.assign(document.createElement('div'), { className: 'slot' }));

  theirs.innerHTML = '';
  for (let i = 0; i < v.opponentHandCount; i += 1) {
    const back = document.createElement('div');
    back.className = 'card back';
    back.style.setProperty('--tilt', `${((i * 53) % 5 - 2) * 1.2}deg`);
    theirs.append(back);
  }
  if (!v.opponentHandCount) theirs.append(Object.assign(document.createElement('div'), { className: 'slot' }));
}

function cardFace(value, tag = 'div') {
  const card = document.createElement(tag);
  if (tag === 'button') card.type = 'button';
  card.className = 'card';
  card.innerHTML = `<span class="corner tl">${value}</span><span class="num">${value}</span>`
    + `<span class="dots-row">${'◆'.repeat(value)}</span><span class="corner br">${value}</span>`;
  return card;
}

function miniCard(value, cls = '') {
  return `<span class="mini ${cls}">${value}</span>`;
}

function renderActions(v, myTurn, sel, d) {
  const me = app.seat;
  // 画面の左右どちらへ動くか。オレンジは右が前、ブルーは左が前
  const leftDir = me === 0 ? 'backward' : 'forward';
  const rightDir = me === 0 ? 'forward' : 'backward';
  const label = { forward: '前進', backward: '後退' };
  const can = (dir) => myTurn && sel && sel.count === 1
    && v.legal.some((a) => a.type === 'move' && a.dir === dir && a.card === sel.value);

  const left = $('move-left');
  const right = $('move-right');
  const steps = sel && sel.count === 1 ? `<span class="sub">${sel.value}マス</span>` : '';
  left.innerHTML = `← ${label[leftDir]}${can(leftDir) ? steps : ''}`;
  right.innerHTML = `${label[rightDir]} →${can(rightDir) ? steps : ''}`;
  left.disabled = !can(leftDir);
  right.disabled = !can(rightDir);
  left.onclick = () => doMove(leftDir);
  right.onclick = () => doMove(rightDir);

  const atk = $('attack-btn');
  const attackOk = myTurn && sel && sel.value === d
    && v.legal.some((a) => a.type === 'attack' && a.count === sel.count);
  atk.disabled = !attackOk;
  atk.innerHTML = attackOk ? `⚔ 攻撃 ×${sel.count}<span class="sub">「${d}」を${sel.count}枚</span>` : '⚔ 攻撃';
}

function renderPresence() {
  const box = $('presence');
  if ($('screen-game').hidden && $('screen-wait').hidden) {
    box.hidden = true;
    return;
  }
  if (app.demo) {
    box.hidden = true;
  } else if (!app.connected && !app.superseded) {
    box.textContent = '接続が切れました。つなぎ直しています…';
    box.hidden = false;
  } else if (app.seat !== null && app.view && !app.peers[1 - app.seat]) {
    box.textContent = '相手の接続が切れました（戻ってくるのを待っています）';
    box.hidden = false;
  } else {
    box.hidden = true;
  }
}

// ------------------------------------------------------------------ 操作

function toggleCard(i) {
  const v = app.view;
  if (!v || app.busy || app.animating) return;
  const value = v.myHand[i];
  const at = app.selected.indexOf(i);
  if (at !== -1) {
    app.selected.splice(at, 1);
  } else if (app.selected.length && v.myHand[app.selected[0]] === value && value === distanceOf(v)) {
    app.selected.push(i); // 距離ちょうどの札は重ねて強い攻撃にできる
  } else {
    app.selected = [i];
  }
  render();
}

function doMove(dir) {
  const v = app.view;
  const sel = selection();
  if (!v || !sel || sel.count !== 1 || app.busy || app.animating) return;
  app.busy = true;
  send({ t: 'action', action: { type: 'move', dir, card: sel.value } });
  render();
}

function doAttack() {
  const v = app.view;
  const sel = selection();
  if (!v || !sel || app.busy || app.animating) return;
  app.busy = true;
  send({ t: 'action', action: { type: 'attack', value: distanceOf(v), count: sel.count } });
  render();
}

function onTile(cell) {
  const v = app.view;
  const sel = selection();
  if (!v || !sel || sel.count !== 1) return;
  for (const dir of ['forward', 'backward']) {
    if (moveTo(v, app.seat, dir, sel.value) === cell && v.legal.some((a) => a.type === 'move' && a.dir === dir && a.card === sel.value)) {
      doMove(dir);
      return;
    }
  }
}

// ------------------------------------------------------------------ 演出

function fxAt(cell, html, cls, { bottom = null } = {}) {
  const el = document.createElement('div');
  el.className = `fx-item ${cls}`;
  el.style.left = cellPct(cell);
  if (bottom !== null) el.style.bottom = bottom;
  el.innerHTML = html;
  lane.append(el);
  return el;
}

function removeLater(el, ms) {
  setTimeout(() => el.remove(), reduceMotion ? 60 : ms);
}

function caption(player, cell, cardsHtml, pillHtml, pillCls) {
  const el = fxAt(cell, `<div class="mini-cards">${cardsHtml}</div><span class="pill ${pillCls}">${pillHtml}</span>`, 'caption');
  removeLater(el, 1500);
}

function spark(cell, offsetCells = 0) {
  const rays = Array.from({ length: 10 }, (_, i) => `<i style="--a:${i * 36 + Math.random() * 14}deg"></i>`).join('');
  const el = fxAt(cell + offsetCells, `${rays}<b></b>`, 'spark', { bottom: '55%' });
  removeLater(el, 600);
}

// 剣士の背中側・頭の高さに出す（上に出る説明と重ならないように）
function badge(player, cell, text, cls = '') {
  const back = player === 0 ? -1.6 : 1.6;
  const el = fxAt(Math.min(Math.max(cell + back, 2.2), CELLS - 1.2), text, `badge ${cls}`, { bottom: '40%' });
  removeLater(el, 1600);
}

function shake() {
  const stage = $('stage');
  stage.classList.remove('shake');
  void stage.offsetWidth;
  stage.classList.add('shake');
}

async function hopTo(player, from, to) {
  const f = fencers[player];
  const hop = f.querySelector('.hop');
  const step = to > from ? 1 : -1;
  const per = 170;
  const trail = [];
  for (let c = from, k = 1; c !== to; c += step, k += 1) {
    const next = c + step;
    if (!reduceMotion) {
      f.animate([{ left: cellPct(c) }, { left: cellPct(next) }], { duration: per, easing: 'ease-in-out' });
      hop.animate([
        { transform: 'translateY(0)' },
        { transform: 'translateY(-26%)', offset: 0.45 },
        { transform: 'translateY(0)' },
      ], { duration: per, easing: 'ease-out' });
    }
    f.style.left = cellPct(next);
    const tile = tileEl(next);
    tile.classList.add('trail');
    if (player === 1) tile.classList.add('b');
    tile.innerHTML = `<span class="trail-no">${k}</span>`;
    trail.push(tile);
    await sleep(per);
  }
  setTimeout(() => {
    for (const t of trail) {
      t.classList.remove('trail', 'b');
      t.innerHTML = '';
    }
  }, reduceMotion ? 50 : 700);
}

function lunge(player, distanceCells) {
  const f = fencers[player];
  const dir = player === 0 ? 1 : -1;
  const px = Math.min(distanceCells * 0.35, 1.2) * cellPx() * dir;
  f.classList.add('glint');
  setTimeout(() => f.classList.remove('glint'), 700);
  if (reduceMotion) return;
  f.querySelector('.hop').animate([
    { transform: 'translateX(0)' },
    { transform: `translateX(${-px * 0.25}px)`, offset: 0.25 },
    { transform: `translateX(${px}px)`, offset: 0.5 },
    { transform: `translateX(${px}px)`, offset: 0.75 },
    { transform: 'translateX(0)' },
  ], { duration: 900, easing: 'ease-in-out' });
}

async function playEvents(prev, v) {
  const pos = [...prev.positions];
  placeFencers(pos);
  fencers.forEach((f) => f.querySelector('.thinking')?.remove());

  for (let i = 0; i < v.lastEvents.length; i += 1) {
    const ev = v.lastEvents[i];
    const nextEv = v.lastEvents[i + 1];
    switch (ev.type) {
      case 'move': {
        const word = ev.dir === 'forward' ? '前進' : '後退';
        const arrow = (ev.to > ev.from) ? '→' : '←';
        caption(ev.player, ev.from, miniCard(ev.card), `${arrow} ${ev.card}マス${word}`, '');
        await sleep(350);
        await hopTo(ev.player, ev.from, ev.to);
        pos[ev.player] = ev.to;
        placeFencers(pos);
        await sleep(200);
        break;
      }
      case 'attack': {
        const d = pos[1] - pos[0];
        setFace(fencers[ev.player], 'angry');
        caption(ev.player, pos[ev.player], miniCard(ev.value).repeat(ev.count), `⚔ 攻撃！ ${ev.value}×${ev.count}`, ev.player === 0 ? 'orange' : 'blue');
        await sleep(450);
        lunge(ev.player, d);
        await sleep(430);
        break;
      }
      case 'parry': {
        const attacker = 1 - ev.player;
        const mid = (pos[0] + pos[1]) / 2;
        lunge(ev.player, 1.2);
        spark(mid);
        badge(ev.player, pos[ev.player], 'PARRY!', 'parry');
        caption(ev.player, pos[ev.player], miniCard(ev.value).repeat(ev.count), `受け流し ${ev.value}×${ev.count}`, ev.player === 0 ? 'orange' : 'blue');
        await sleep(900);
        setFace(fencers[attacker], 'normal');
        break;
      }
      case 'hit': {
        const defender = 1 - ev.player;
        const toward = defender === 0 ? 0.55 : -0.55;
        spark(pos[defender], toward);
        badge(defender, pos[defender], 'TOUCHÉ!');
        setFace(fencers[defender], 'hurt');
        fencers[defender].classList.add('hurt');
        shake();
        await sleep(1100);
        break;
      }
      case 'deckOut': {
        const el = fxAt(CENTER_CELL, '<span class="pill gold">山札が尽きた！</span>', 'caption');
        removeLater(el, 1500);
        if (nextEv?.type !== 'parry') await sleep(800);
        break;
      }
      case 'stuck': {
        setFace(fencers[ev.player], 'sad');
        badge(ev.player, pos[ev.player], '動けない…', 'stuck');
        await sleep(1100);
        break;
      }
      case 'roundEnd': {
        if (ev.winner !== null) {
          setFace(fencers[ev.winner], 'happy');
          if (ev.reason === 'deck') setFace(fencers[1 - ev.winner], 'sad');
          if (nextEv?.type !== 'matchEnd') confetti(ev.winner, 40); // 試合が決まったときは勝利演出で打ち上げる
        }
        await sleep(ev.reason === 'deck' ? 700 : 500);
        break;
      }
      case 'matchEnd':
        await sleep(500);
        await celebrate(ev.winner, v.scores);
        break;
      default:
    }
  }
}

function confetti(winner, n) {
  if (reduceMotion) return;
  const colors = winner === 0
    ? ['#D9714E', '#F2B53A', '#E8906F', '#4F9A6A', '#5B93D0']
    : ['#5B93D0', '#F2B53A', '#8DB6E2', '#4F9A6A', '#D9714E'];
  const layer = document.createElement('div');
  layer.className = 'confetti';
  for (let i = 0; i < n; i += 1) {
    const piece = document.createElement('i');
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[i % colors.length];
    piece.style.setProperty('--d', `${1.8 + Math.random() * 1.6}s`);
    piece.style.setProperty('--delay', `${Math.random() * 0.5}s`);
    piece.style.setProperty('--dx', `${(Math.random() - 0.5) * 160}px`);
    piece.style.setProperty('--rot', `${(Math.random() - 0.5) * 1080}deg`);
    if (i % 3 === 0) piece.style.borderRadius = '50%';
    layer.append(piece);
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 4200);
}

// 試合の勝利演出。画面を暗くし、勝った側の剣士が笑顔で跳ね、下の両はしから紙吹雪を打ち上げる。
// 押すと早めに終わる
function celebrate(winner, scores) {
  return new Promise((resolve) => {
    const layer = document.createElement('div');
    layer.className = `victory p${winner}`;
    const who = winner === app.seat ? 'あなた' : escapeHtml(nameOf(winner));
    layer.innerHTML = `<div class="victory-stage">
        <p class="victory-word">VICTOIRE!</p>
        <div class="victory-hero"><span class="victory-shadow"></span></div>
        <p class="victory-name"><span class="result-pill p${winner}">${who}の勝利！</span></p>
        <p class="victory-score"><span class="p0">${scores[0]}</span><i>–</i><span class="p1">${scores[1]}</span></p>
      </div>`;
    layer.querySelector('.victory-hero').prepend(createFigure(winner, 'happy'));
    document.body.append(layer);

    const timers = [];
    if (!reduceMotion) timers.push(setTimeout(() => confettiCannons(winner), 250));
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      layer.classList.add('leaving');
      setTimeout(() => layer.remove(), reduceMotion ? 0 : 350);
      resolve();
    };
    timers.push(setTimeout(finish, reduceMotion ? 1500 : 4600));
    layer.addEventListener('click', finish);
  });
}

// 画面の下の左右から、紙吹雪を斜め上へ打ち上げる。頂上で止まり、ひらひら落ちる
function confettiCannons(winner) {
  const colors = winner === 0
    ? ['#D9714E', '#F2B53A', '#E8906F', '#4F9A6A', '#5B93D0', '#FFFFFF']
    : ['#5B93D0', '#F2B53A', '#8DB6E2', '#4F9A6A', '#D9714E', '#FFFFFF'];
  const W = window.innerWidth;
  const H = window.innerHeight;
  const layer = document.createElement('div');
  layer.className = 'confetti';
  for (const [x0, lean] of [[W * 0.04, 1], [W * 0.96, -1]]) {
    const flash = document.createElement('b');
    flash.className = 'cannon-flash';
    flash.style.left = `${x0}px`;
    flash.style.setProperty('--lean', `${lean * 24}deg`);
    layer.append(flash);
    for (let i = 0; i < 80; i += 1) {
      const angle = (lean * (12 + Math.random() * 30) * Math.PI) / 180; // 真上から内側へ傾ける
      const rise = H * (0.5 + Math.random() * 0.45);
      const x1 = x0 + Math.tan(angle) * rise;
      const y1 = -rise;
      const up = 520 + Math.random() * 380;
      const fallMs = 2200 + Math.random() * 1600;
      const sway = 18 + Math.random() * 36;
      const drift = (Math.random() - 0.5) * 120;
      const piece = document.createElement('span');
      piece.className = 'piece';
      const paper = document.createElement('i');
      const kind = i % 4;
      if (kind === 0) paper.style.borderRadius = '50%';
      if (kind === 1) { paper.style.width = '5px'; paper.style.height = '18px'; }
      paper.style.background = colors[i % colors.length];
      paper.style.setProperty('--flip', `${0.5 + Math.random() * 0.7}s`);
      piece.append(paper);
      piece.style.left = `${x0}px`;
      layer.append(piece);
      const spin = (Math.random() - 0.5) * 1440;
      const at = (t, dx, dy, r) => ({ offset: t, transform: `translate(${dx}px, ${dy}px) rotate(${r}deg)` });
      const total = up + fallMs;
      const tUp = up / total;
      const frames = [{ ...at(0, 0, 0, 0), easing: 'cubic-bezier(.1,.75,.3,1)' }, at(tUp, x1 - x0, y1, spin * 0.4)];
      // 落ちるときは左右に揺れる
      for (let k = 1; k <= 4; k += 1) {
        const t = tUp + ((1 - tUp) * k) / 4;
        frames.push(at(t, x1 - x0 + drift * (k / 4) + (k % 2 ? sway : -sway), y1 + (rise + 60) * (k / 4), spin * (0.4 + 0.15 * k)));
      }
      frames.forEach((f, k) => { if (k > 0) f.easing = k === 1 ? 'ease-in' : 'ease-in-out'; });
      piece.animate(frames, { duration: total, delay: Math.random() * 90, fill: 'both' });
    }
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 4300);
}

function roundIntro(v) {
  const el = fxAt(CENTER_CELL, `<span class="pill ${v.startPlayer === 0 ? 'orange' : 'blue'}">第${v.round}ラウンド ・ ${escapeHtml(nameOf(v.startPlayer))}から</span>`, 'caption');
  removeLater(el, 1600);
}

// ------------------------------------------------------------------ 行動ログ

function logLine(html, cls = '') {
  const li = document.createElement('li');
  li.innerHTML = html;
  if (cls) li.className = cls;
  $('log').prepend(li);
  while ($('log').children.length > 120) $('log').lastElementChild.remove();
}

function logSeparator(text) {
  logLine(escapeHtml(text), 'sep');
}

function clearLog() {
  $('log').innerHTML = '';
}

function logEvents(events) {
  for (const ev of events) {
    switch (ev.type) {
      case 'move': logLine(`${whoHtml(ev.player)}が「${ev.card}」で${ev.card}マス${ev.dir === 'forward' ? '前進' : '後退'}`); break;
      case 'attack': logLine(`${whoHtml(ev.player)}が「${ev.value}」×${ev.count}で攻撃`); break;
      case 'parry': logLine(`${whoHtml(ev.player)}が「${ev.value}」×${ev.count}で受け流した`); break;
      case 'hit': logLine(`${whoHtml(ev.player)}の攻撃が命中！`); break;
      case 'stuck': logLine(`${whoHtml(ev.player)}は動けなくなった`); break;
      case 'deckOut': logLine('山札が尽きた'); break;
      case 'roundEnd': logLine(ev.winner === null ? 'このラウンドは引き分け' : `${whoHtml(ev.winner)}がラウンドを取った`); break;
      case 'matchEnd': logLine(`${whoHtml(ev.winner)}の勝利！`); break;
      default:
    }
  }
}

// ------------------------------------------------------------------ モーダル

function openModal(key, title, bodyHtml, actions) {
  app.modalKey = key;
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = bodyHtml;
  const box = $('modal-actions');
  box.innerHTML = '';
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn ${a.cls || 'btn-primary'} btn-block`;
    b.textContent = a.label;
    if (a.id) b.id = a.id;
    b.addEventListener('click', a.onClick);
    box.append(b);
  }
  $('modal-root').hidden = false;
  box.querySelector('button')?.focus({ preventScroll: true });
}

function closeModal() {
  app.modalKey = null;
  $('modal-root').hidden = true;
}

function scoreRow(scores) {
  const side = (p) => `<div class="score-side p${p}"><span class="pips">${
    Array.from({ length: 5 }, (_, i) => `<span class="pip${i < scores[p] ? ' on' : ''}"></span>`).join('')
  }</span></div>`;
  return `<div class="result-score">${side(0)}<span class="score-vs">${scores[0]} – ${scores[1]}</span>${side(1)}</div>`;
}

function resultDuel(winner) {
  return `<div class="result-duel" data-winner="${winner ?? ''}"></div>`;
}

function fillDuel(winner, loserFace) {
  const box = $('modal-body').querySelector('.result-duel');
  if (!box) return;
  for (const p of [0, 1]) {
    const face = winner === null ? 'normal' : p === winner ? 'happy' : loserFace;
    const fig = createFigure(p, face);
    if (winner !== null) fig.classList.add(p === winner ? 'winner' : 'loser');
    box.append(fig);
  }
}

function reasonText(r) {
  if (r.reason === 'hit') return `${whoHtml(r.winner)}の攻撃が命中しました。`;
  if (r.reason === 'stuck') return `${whoHtml(1 - r.winner)}が動けなくなりました。`;
  return '山札が尽きたので、手札で判定しました。';
}

// 山札切れの判定の中身: 距離ちょうどの札の枚数 → 前進した距離
function judgeHtml(v) {
  const r = v.roundResult;
  if (!r || r.reason !== 'deck' || !r.revealedHands) return '';
  const d = distanceOf(v);
  const counts = r.revealedHands.map((h) => h.filter((c) => c === d).length);
  const advance = [v.positions[0] - 1, CELLS - v.positions[1]];
  const row = (p) => `<div class="judge-row">
      <span class="judge-name p${p}">${escapeHtml(nameOf(p))}${p === app.seat ? '（あなた）' : ''}</span>
      <span class="judge-count">「${d}」×${counts[p]} ・ ${advance[p]}マス前進</span>
      <div class="judge-cards">${[...r.revealedHands[p]].sort((a, b) => a - b).map((c) => miniCard(c, c === d ? `match${p === 1 ? ' b' : ''}` : '')).join('')}</div>
    </div>`;
  const op = (a, b) => (a > b ? '&gt;' : a < b ? '&lt;' : '=');
  const byCount = counts[0] !== counts[1];
  const compare = byCount
    ? `「${d}」の枚数 ${counts[0]}<span class="op">${op(counts[0], counts[1])}</span>${counts[1]}`
    : `枚数は同じ → 前進 ${advance[0]}<span class="op">${op(advance[0], advance[1])}</span>${advance[1]}`;
  return `<div class="judge">
      <div class="judge-title">いまの距離は ${d}。手札の「${d}」が多い方の勝ち</div>
      ${row(0)}
      <div class="judge-vs">${compare}</div>
      ${row(1)}
      <p class="judge-note">同じ枚数なら、スタートから多く前進した方の勝ち</p>
    </div>`;
}

function showRoundModal(v) {
  const key = `round-${app.seq}`;
  if (app.modalKey === key) {
    renderModalButtons();
    return;
  }
  const r = v.roundResult;
  const winner = r.winner;
  const pill = winner === null
    ? '<span class="result-pill">引き分け</span>'
    : `<span class="result-pill p${winner}">${winner === app.seat ? 'あなた' : escapeHtml(nameOf(winner))}の勝ち！</span>`;
  const body = `${pill}${resultDuel(winner)}<p class="result-reason">${reasonText(r)}</p>${judgeHtml(v)}${scoreRow(v.scores)}<p class="ready-note" id="ready-note"></p>`;
  openModal(key, `第${v.round}ラウンドの結果`, body, [{
    id: 'next-btn',
    label: '次のラウンドへ',
    onClick: () => {
      send({ t: 'next' });
      app.ready[app.seat] = true;
      renderModalButtons();
    },
  }]);
  fillDuel(winner, r.reason === 'hit' ? 'hurt' : 'sad');
  renderModalButtons();
}

function showMatchModal(v) {
  const key = `match-${app.seq}`;
  if (app.modalKey === key) {
    renderModalButtons();
    return;
  }
  const w = v.winner;
  const pill = `<span class="result-pill p${w}">${w === app.seat ? 'あなた' : escapeHtml(nameOf(w))}の勝利！</span>`;
  const last = v.roundResult ? `<p class="result-reason">最後のラウンド：${reasonText(v.roundResult)}</p>${judgeHtml(v)}` : '';
  openModal(key, '試合終了', `${pill}${resultDuel(w)}${scoreRow(v.scores)}${last}<p class="ready-note" id="ready-note"></p>`, [{
    id: 'next-btn',
    label: 'もう一度対戦',
    onClick: () => {
      if (app.demo) {
        playDemo();
        return;
      }
      send({ t: 'rematch' });
      app.ready[app.seat] = true;
      renderModalButtons();
    },
  }]);
  fillDuel(w, 'sad');
  renderModalButtons();
}

function renderModalButtons() {
  const btn = $('next-btn');
  const note = $('ready-note');
  if (!btn || !app.view || app.seat === null) return;
  const mine = app.ready[app.seat];
  const theirs = app.ready[1 - app.seat];
  const rematch = app.view.phase === 'matchOver';
  btn.disabled = mine;
  btn.textContent = mine ? '相手を待っています…' : rematch ? (app.demo ? 'もう一度見る' : 'もう一度対戦') : '次のラウンドへ';
  note.textContent = theirs && !mine ? `${nameOf(1 - app.seat)}は準備できています` : '';
}

function showRules() {
  const prevKey = app.modalKey;
  const body = `<div class="rules-grid">
      <div class="rule-card"><h3><i>🏆</i>目的</h3><p>攻撃を当てると1ポイント。先に<b>5ポイント</b>取った人の勝ち。</p></div>
      <div class="rule-card"><h3><i>🃏</i>準備</h3><p>23マスの両はしから。カードは1〜5が5枚ずつ。手札は<b>5枚</b>で、先手はラウンドごとに交代。</p></div>
      <div class="rule-card"><h3><i>⇄</i>移動</h3><p>カード1枚の数だけ<b>ちょうど</b>前進か後退。相手と同じマス・追い越し・コースの外はダメ。</p></div>
      <div class="rule-card"><h3><i>⚔</i>攻撃</h3><p>相手との距離と<b>同じ数字</b>のカードで攻撃。同じ数字を何枚重ねてもよく、多いほど強い。</p></div>
      <div class="rule-card"><h3><i>🛡</i>防御</h3><p><b>同じ数字を同じ枚数</b>持っていれば自動で受け流し（パリー）。受け流した人は補充せずに反撃の番。</p></div>
      <div class="rule-card"><h3><i>⚑</i>終了</h3><p>命中／動けなくなる／山札切れ。山札切れなら、距離と同じ数字を<b>多く持つ人</b>、同じなら多く前進した人の勝ち。</p></div>
    </div>
    <p class="rules-howto">遊び方：カードを押すと、そのカードで行けるマスが光ります。光ったマスかボタンで移動。距離と同じ数字のカードは、同じ数字をもう1枚押すと ×2 の強い攻撃になります。</p>`;
  const returnTo = prevKey && prevKey !== 'rules' ? prevKey : null;
  openModal('rules', 'ルール（基本ルール）', body, [{
    label: '閉じる',
    cls: 'btn-secondary',
    onClick: () => {
      closeModal();
      if (returnTo && app.view) {
        if (app.view.phase === 'roundOver') showRoundModal(app.view);
        else if (app.view.phase === 'matchOver') showMatchModal(app.view);
      }
    },
  }]);
}

function showSuperseded() {
  openModal('superseded', 'ほかのタブで開かれました', '<p class="result-reason">この対戦は、別のタブ（または別の画面）で開かれたため、こちらは止めました。</p>', [{
    label: 'このタブで続ける',
    onClick: () => {
      closeModal();
      app.superseded = false;
      app.seq = -1;
      app.view = null;
      connect();
    },
  }]);
}

let toastTimer = null;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

// ------------------------------------------------------------------ ロビー

function readName(input) {
  const name = input.value.trim().slice(0, 16);
  store.name = name;
  return name;
}

function createRoom() {
  $('lobby-error').hidden = true;
  sendOrQueue({ t: 'create', name: readName($('name-input')) });
}

function joinRoom(code, nameInput, errorBox) {
  const room = code.trim().toUpperCase();
  errorBox.hidden = true;
  if (!/^[A-HJ-NP-Z2-9]{5}$/.test(room)) {
    errorBox.textContent = '部屋コードは5文字です（例：K7QX3）';
    errorBox.hidden = false;
    return;
  }
  sendOrQueue({ t: 'join', room, name: readName(nameInput) });
}

async function copyInvite() {
  const url = $('invite-url').value;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    $('invite-url').select();
    document.execCommand('copy');
  }
  const btn = $('copy-btn');
  btn.textContent = 'コピーしました';
  setTimeout(() => { btn.textContent = 'URLをコピー'; }, 1800);
}

function wire() {
  $('create-btn').addEventListener('click', createRoom);
  $('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') createRoom(); });
  $('join-btn').addEventListener('click', () => joinRoom($('room-input').value, $('name-input'), $('lobby-error')));
  $('room-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('join-btn').click(); });
  $('invited-join-btn').addEventListener('click', () => joinRoom(app.inviteRoom, $('invited-name'), $('invited-error')));
  $('invited-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('invited-join-btn').click(); });
  $('invited-cancel').addEventListener('click', () => {
    app.inviteRoom = null;
    history.replaceState(null, '', '/');
    showLobby();
  });
  $('copy-btn').addEventListener('click', copyInvite);
  $('share-btn').addEventListener('click', () => {
    navigator.share?.({ title: 'アン・ギャルドで対戦しよう', url: $('invite-url').value }).catch(() => {});
  });
  $('attack-btn').addEventListener('click', doAttack);
  for (const b of document.querySelectorAll('[data-open-rules]')) b.addEventListener('click', showRules);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (app.modalKey === 'rules') $('modal-actions').querySelector('button')?.click();
      else if (app.selected.length) {
        app.selected = [];
        render();
      }
    }
  });
  window.addEventListener('resize', () => { if (app.view && !app.animating) placeFencers(app.view.positions); });
}

// ------------------------------------------------------------------ 演出の確認用ページ
// /?demo=victory は自分が勝つ側、/?demo=defeat は負ける側の画面。最後の一撃から勝利演出・結果までを流す

function demoViews() {
  const winner = app.demo === 'defeat' ? 1 : 0;
  const before = {
    you: 0, round: 8, startPlayer: 1, scores: winner === 0 ? [4, 3] : [3, 4], positions: [9, 13],
    turn: winner, phase: 'action', winner: null, myHand: [1, 2, 4, 4, 5], opponentHandCount: 5,
    deckCount: 4, discardTop: 2, parried: null, roundResult: null, lastEvents: [], legal: [],
  };
  const after = {
    ...before,
    scores: winner === 0 ? [5, 3] : [3, 5],
    phase: 'matchOver',
    winner,
    myHand: winner === 0 ? [1, 2, 3, 5, 5] : [1, 2, 4, 4, 5],
    opponentHandCount: winner === 0 ? 5 : 3,
    roundResult: { winner, reason: 'hit' },
    lastEvents: [
      { type: 'attack', player: winner, value: 4, count: 2 },
      { type: 'hit', player: winner },
      { type: 'roundEnd', winner, reason: 'hit' },
      { type: 'matchEnd', winner },
    ],
  };
  return [before, after];
}

async function playDemo() {
  if (app.animating) return;
  closeModal();
  const [before, after] = demoViews();
  app.view = before;
  app.seq = 0;
  app.ready = [false, false];
  clearLog();
  logSeparator(`第${before.round}ラウンド ・ 先手 ${nameOf(before.startPlayer)}`);
  render();
  await sleep(1000);
  logEvents(after.lastEvents);
  app.animating = true;
  render();
  try {
    await playEvents(before, after);
  } finally {
    app.animating = false;
  }
  app.view = after;
  app.seq = 1;
  render({ scoresFrom: before.scores });
  showMatchModal(after);
}

function startDemo(kind) {
  app.demo = kind;
  app.seat = 0;
  app.names = ['アリス', 'ボブ'];
  showScreen('game');
  toast('演出の確認用の画面です（対戦にはつながっていません）');
  playDemo();
}

// ------------------------------------------------------------------ 起動

function init() {
  buildPiste();
  wire();
  const demo = new URLSearchParams(location.search).get('demo');
  if (demo === 'victory' || demo === 'defeat') {
    startDemo(demo);
    return;
  }
  const saved = store.seat;
  // 招待URLで別の部屋を開いたときは、前の席には戻らない
  if (saved && (!app.inviteRoom || app.inviteRoom === saved.room)) {
    app.room = saved.room;
    app.token = saved.token;
  } else {
    showLobby();
  }
  connect();
}

init();
