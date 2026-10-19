// En Garde クライアント
const $ = (id) => document.getElementById(id);
const CELL_COUNT = 23;

const state = {
  ws: null,
  connected: false,
  manualClose: false,
  room: null,
  token: null,
  player: null,
  names: ['プレイヤー1', 'プレイヤー2'],
  ready: [false, false],
  presence: [true, true],
  view: null,
  selectedValue: null,
  attackCount: 1,
  processEvents: false,
  modalKey: null,
  busy: false,
  awaitingResume: false,
  lastSeq: null,
  replaced: false,
};

// ------------------------------------------------------------ 永続化
// token は sessionStorage（タブごと・リロードでは残る）。名前は localStorage。
function saveIdentity() {
  if (!state.room) return;
  localStorage.setItem('engarde.name', $('name-input').value.trim().slice(0, 16));
  sessionStorage.setItem('engarde.lastRoom', state.room);
  if (state.token) sessionStorage.setItem(`engarde.token.${state.room}`, state.token);
}
function loadToken(room) { return sessionStorage.getItem(`engarde.token.${room}`); }
function forgetIdentity(room) {
  if (room) sessionStorage.removeItem(`engarde.token.${room}`);
  sessionStorage.removeItem('engarde.lastRoom');
}

// ------------------------------------------------------------ 通信
function send(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj));
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => {
    state.connected = true;
    renderPresence();
    if (state.room && state.token) {
      state.awaitingResume = true;
      send({ t: 'resume', room: state.room, token: state.token });
    }
  };
  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handleMessage(msg);
  };
  ws.onclose = (event) => {
    state.connected = false;
    renderPresence();
    if (state.replaced) return;
    if (event && event.code === 4001) { handleSuperseded(); return; }
    if (!state.manualClose) setTimeout(connect, 1500);
  };
  ws.onerror = () => { /* close ハンドラで処理 */ };
}

// 別タブで同じ席に resume されたため切断された
function handleSuperseded() {
  state.replaced = true;
  state.manualClose = true;
  state.awaitingResume = false;
  forgetIdentity(state.room);
  state.room = null;
  state.token = null;
  $('replaced-overlay').classList.remove('hidden');
}

function fillWaiting(room) {
  $('waiting-code').textContent = room;
  $('invite-url').value = `${location.origin}/?room=${room}`;
}

function handleMessage(msg) {
  switch (msg.t) {
    case 'created':
      state.room = msg.room; state.token = msg.token; state.player = 0;
      saveIdentity();
      fillWaiting(msg.room);
      showScreen('waiting');
      break;
    case 'joined':
      state.awaitingResume = false;
      state.room = msg.room; state.token = msg.token; state.player = msg.player;
      saveIdentity();
      if (!state.view) { fillWaiting(msg.room); showScreen('waiting'); }
      break;
    case 'state': {
      state.names = msg.names || state.names;
      state.ready = msg.ready || [false, false];
      const seq = typeof msg.seq === 'number' ? msg.seq : null;
      const first = state.lastSeq === null;
      state.processEvents = seq !== null && !first && seq > state.lastSeq;
      state.lastSeq = seq;
      applyState(msg.view);
      break;
    }
    case 'presence':
      state.presence = msg.connected;
      renderPresence();
      break;
    case 'error':
      showToast(msg.message);
      state.busy = false;
      if (state.view) render(state.view);
      if (state.awaitingResume) {
        state.awaitingResume = false;
        forgetIdentity(state.room);
        state.room = null; state.token = null; state.view = null; state.lastSeq = null;
        showScreen('lobby');
      }
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------ 画面切替
function showScreen(name) {
  for (const id of ['lobby', 'waiting', 'game']) $(id).classList.toggle('hidden', id !== name);
}

function applyState(view) {
  state.view = view;
  if (!view) {
    state.processEvents = false;
    if (!state.room) showScreen('lobby');
    else { fillWaiting(state.room); showScreen('waiting'); }
    return;
  }
  state.busy = false;
  if (view.phase === 'action') closeModal();
  showScreen('game');
  render(view);
}

// ------------------------------------------------------------ 描画
function pct(pos) { return `${((pos - 0.5) / CELL_COUNT) * 100}%`; }

function buildCells() {
  const container = $('cells');
  container.innerHTML = '';
  for (let i = 1; i <= CELL_COUNT; i += 1) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.style.left = `${((i - 1) / CELL_COUNT) * 100}%`;
    if (i === 12) cell.classList.add('center-line');
    if (i % 5 === 0 || i === 1 || i === 23) cell.textContent = String(i);
    container.appendChild(cell);
  }
}

function nameOf(player) { return state.names[player] || `プレイヤー${player + 1}`; }

function render(view) {
  $('name0').textContent = nameOf(0);
  $('name1').textContent = nameOf(1);
  $('score0').textContent = view.scores[0];
  $('score1').textContent = view.scores[1];
  $('round-chip').textContent = `第${view.round}ラウンド`;
  const distance = Math.abs(view.positions[1] - view.positions[0]);
  $('distance-chip').textContent = `間合い ${distance}`;
  $('deck-chip').textContent = `山札 ${view.deckCount}`;
  $('discard-chip').textContent = `捨て札 ${view.discardTop == null ? '–' : view.discardTop}`;

  $('tag0').classList.toggle('active', view.turn === 0 && view.phase === 'action');
  $('tag1').classList.toggle('active', view.turn === 1 && view.phase === 'action');

  const events = view.lastEvents || [];
  const isNew = state.processEvents;
  state.processEvents = false;
  const moveEvents = {};
  if (isNew && events.length) {
    for (const ev of events) {
      if (ev.type === 'move') {
        moveEvents[ev.player] = ev;
        addLog(logForEvent(ev, view), ev.player);
      } else {
        addLog(logForEvent(ev, view), ev.player != null ? ev.player : 'system');
      }
    }
    state.selectedValue = null;
    state.attackCount = 1;
    triggerEffects(events);
  }

  renderBoard(view, moveEvents);
  renderHand(view);
  renderActions(view);
  renderTurn(view);
  renderModal(view);
}

function logForEvent(ev, view) {
  const who = (p) => (p === view.you ? 'あなた' : '相手');
  switch (ev.type) {
    case 'move': return `${who(ev.player)}が「${ev.card}」で${ev.dir === 'forward' ? '前進' : '後退'}（${ev.from}→${ev.to}）`;
    case 'attack': return `${who(ev.player)}が「${ev.value}」×${ev.count} で攻撃！`;
    case 'parry': return `${who(ev.player)}が「${ev.value}」×${ev.count} で受け流した`;
    case 'hit': return `${who(ev.player)}の攻撃が命中！`;
    case 'stuck': return `${who(ev.player)}は動けなくなった`;
    case 'deckOut': return '山札が尽きた';
    case 'roundEnd': return `ラウンド終了：${ev.winner == null ? '引き分け' : `${who(ev.winner)}の勝ち`}`;
    case 'matchEnd': return `試合終了：${who(ev.winner)}の勝利！`;
    default: return ev.type;
  }
}

function addLog(text, player) {
  const log = $('log');
  const entry = document.createElement('div');
  const cls = player === 0 ? 'p0' : player === 1 ? 'p1' : 'system';
  entry.className = `log-entry ${cls}`;
  entry.textContent = text;
  log.prepend(entry);
  while (log.children.length > 40) log.removeChild(log.lastChild);
}

function renderBoard(view, moveEvents) {
  for (const p of [0, 1]) {
    const el = p === 0 ? $('fencer0') : $('fencer1');
    if (moveEvents[p]) {
      el.style.transition = 'none';
      el.style.left = pct(moveEvents[p].from);
      void el.offsetWidth;
      el.style.transition = '';
      el.style.left = pct(moveEvents[p].to);
    } else {
      el.style.transition = 'none';
      el.style.left = pct(view.positions[p]);
      void el.offsetWidth;
      el.style.transition = '';
    }
    el.classList.toggle('thinking', view.phase === 'action' && view.turn === p);
  }

  const cells = [...$('cells').children];
  for (const cell of cells) cell.classList.remove('target');

  const my = view.you;
  const val = state.selectedValue;
  if (view.phase === 'action' && view.turn === my && val != null) {
    const sign = my === 0 ? 1 : -1;
    for (const a of view.legal) {
      if (a.type !== 'move' || a.card !== val) continue;
      const from = view.positions[my];
      const to = from + (a.dir === 'forward' ? 1 : -1) * sign * val;
      if (to >= 1 && to <= CELL_COUNT) cells[to - 1]?.classList.add('target');
    }
  }
}

function renderHand(view) {
  const mine = $('my-hand');
  mine.innerHTML = '';
  const isMyTurn = view.phase === 'action' && view.turn === view.you;
  const usable = new Set();
  if (isMyTurn) {
    for (const a of view.legal) {
      if (a.type === 'move') usable.add(a.card);
      else if (a.type === 'attack') usable.add(a.value);
    }
  }
  for (const value of [...view.myHand].sort((a, b) => a - b)) {
    const card = makeCard(value);
    if (view.phase === 'action' && view.turn === view.you && usable.has(value)) {
      if (state.selectedValue === value) card.classList.add('selected');
      card.addEventListener('click', () => selectCard(value));
    } else {
      card.classList.add('disabled');
    }
    mine.appendChild(card);
  }
  if (view.myHand.length === 0) mine.appendChild(emptySlot());

  const opp = $('opp-hand');
  opp.innerHTML = '';
  for (let i = 0; i < view.opponentHandCount; i += 1) opp.appendChild(backCard());
  if (view.opponentHandCount === 0) opp.appendChild(emptySlot());
}

function makeCard(value) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <span class="suit">♠</span>
    <span class="corner tl">${value}</span>
    <span class="pips">${value}</span>
    <span class="corner bl">${value}</span>`;
  return card;
}
function backCard() {
  const card = document.createElement('div');
  card.className = 'card back';
  return card;
}
function emptySlot() {
  const card = document.createElement('div');
  card.className = 'card empty-slot';
  return card;
}

function selectCard(value) {
  if (state.busy) return;
  if (state.selectedValue === value) {
    state.selectedValue = null;
  } else {
    state.selectedValue = value;
    state.attackCount = 1;
  }
  render(state.view);
}

function renderActions(view) {
  const isMyTurn = view.phase === 'action' && view.turn === view.you && !state.busy;
  const val = state.selectedValue;
  const fwd = $('move-forward');
  const bwd = $('move-backward');
  const atk = $('attack-btn');
  const stepper = $('count-stepper');

  const legalMove = (dir) => isMyTurn && val != null && view.legal.some((a) => a.type === 'move' && a.dir === dir && a.card === val);
  const forwardOk = legalMove('forward');
  const backwardOk = legalMove('backward');
  fwd.disabled = !forwardOk;
  bwd.disabled = !backwardOk;

  const distance = Math.abs(view.positions[1] - view.positions[0]);
  const attacks = isMyTurn && val === distance ? view.legal.filter((a) => a.type === 'attack') : [];
  const maxCount = attacks.length ? Math.max(...attacks.map((a) => a.count)) : 0;
  atk.disabled = maxCount < 1;
  if (maxCount > 1) {
    stepper.classList.remove('hidden');
    if (state.attackCount > maxCount) state.attackCount = maxCount;
    if (state.attackCount < 1) state.attackCount = 1;
    $('count-value').textContent = `×${state.attackCount}`;
  } else {
    stepper.classList.add('hidden');
    state.attackCount = 1;
  }

  let hint;
  if (view.phase === 'action' && view.turn !== view.you) hint = '相手の手番です…';
  else if (view.phase !== 'action') hint = 'ラウンドは終了しました';
  else if (state.busy) hint = '送信中…';
  else if (val == null) hint = 'カードを選んでください';
  else hint = `「${val}」を選択中 — 前進・後退、または攻撃`;
  $('action-hint').textContent = hint;
}

function renderTurn(view) {
  const banner = $('turn-banner');
  banner.classList.remove('mine', 'theirs');
  if (view.phase === 'matchOver') { banner.textContent = '試合終了'; return; }
  if (view.phase === 'roundOver') { banner.textContent = 'ラウンド終了'; return; }
  if (view.turn === view.you) { banner.textContent = 'あなたの番'; banner.classList.add('mine'); }
  else { banner.textContent = '相手の番'; banner.classList.add('theirs'); }
}

function renderPresence() {
  const banner = $('presence-banner');
  const opp = state.player == null ? null : 1 - state.player;
  const oppGone = opp != null && state.view && state.presence[opp] === false;
  banner.classList.toggle('hidden', !oppGone && state.connected);
  if (oppGone) banner.textContent = '相手の接続が切れました（再接続を待っています）';
  else if (!state.connected) banner.textContent = 'サーバーに接続しています…';
}

// ------------------------------------------------------------ 演出
function triggerEffects(events) {
  const board = $('board');
  let boardClass = null;
  let shake = false;
  for (const ev of events) {
    if (ev.type === 'attack') {
      pulse($(`fencer${ev.player}`), 'attacking');
      boardClass = boardClass || 'attack-flash';
    } else if (ev.type === 'parry') {
      pulse($(`fencer${ev.player}`), 'parrying');
      boardClass = 'parry-flash';
    } else if (ev.type === 'hit') {
      pulse($(`fencer${1 - ev.player}`), 'hit');
      boardClass = 'hit-flash';
      shake = true;
    }
  }
  if (boardClass) {
    board.classList.remove('attack-flash', 'parry-flash', 'hit-flash');
    void board.offsetWidth;
    board.classList.add(boardClass);
    setTimeout(() => board.classList.remove(boardClass), 700);
  }
  if (shake) {
    board.classList.remove('shake');
    void board.offsetWidth;
    board.classList.add('shake');
    setTimeout(() => board.classList.remove('shake'), 600);
  }
}

function pulse(el, cls) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), 650);
}

// ------------------------------------------------------------ モーダル
// 外部由来（相手が入力できる名前など）を innerHTML に入れる前にエスケープする
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function openModal(title, bodyHtml, actions) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = bodyHtml;
  const box = $('modal-actions');
  box.innerHTML = '';
  for (const action of actions) {
    const btn = document.createElement('button');
    btn.className = `btn ${action.cls || 'btn-secondary'}`;
    btn.textContent = action.label;
    btn.disabled = !!action.disabled;
    btn.addEventListener('click', action.onClick);
    box.appendChild(btn);
  }
  $('modal-root').classList.remove('hidden');
}
function closeModal() { $('modal-root').classList.add('hidden'); }

function roundOutcomeText(r, view) {
  if (r.winner == null) return '引き分け';
  return `${escapeHtml(nameOf(r.winner))} の勝ち`;
}

function reasonText(r, view) {
  if (r.reason === 'hit') {
    const attacker = escapeHtml(nameOf(r.winner));
    return r.winner === view.you ? 'あなたの攻撃が命中しました。' : `${attacker}の攻撃が命中しました。`;
  }
  if (r.reason === 'stuck') {
    const stuckPlayer = r.winner == null ? null : 1 - r.winner;
    return stuckPlayer === view.you
      ? 'あなたは動くことも攻撃することもできず、このラウンドは負けました。'
      : '相手は動くことも攻撃することもできず、このラウンドは負けました。';
  }
  if (r.reason === 'deck') return '山札が尽きたため、公開手札による判定を行いました。';
  return '';
}

function deckJudgeHtml(r, view) {
  if (r.reason !== 'deck' || !r.revealedHands) return '';
  const distance = Math.abs(view.positions[1] - view.positions[0]);
  const advance = [view.positions[0] - 1, 23 - view.positions[1]];
  let html = `<p class="modal-body-text">判定に使った間合い：<strong>${distance}</strong></p>`;
  html += '<div class="deck-judge">';
  for (const p of [0, 1]) {
    const count = r.revealedHands[p].filter((c) => c === distance).length;
    const me = p === view.you ? 'あなた' : '相手';
    html += `<div class="deck-judge-row"><span class="dj-name">${escapeHtml(nameOf(p))}（${me}）</span>`
      + `<span class="dj-count">間合いのカード ×${count}</span>`
      + `<span class="dj-advance">前進 ${advance[p]}</span></div>`;
  }
  html += '</div>';
  html += '<p class="modal-body-text">間合いのカードが多い方の勝ち。同数なら前進している方の勝ちです。</p>';
  html += '<div class="reveal-row">';
  for (const p of [0, 1]) {
    html += `<div class="reveal-hand"><div class="reveal-name">${escapeHtml(nameOf(p))}</div>`;
    for (const c of [...r.revealedHands[p]].sort((a, b) => a - b)) html += `<span class="mini-card">${c}</span>`;
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function showRoundModal(view) {
  const r = view.roundResult || {};
  let body = `<div class="round-result-banner">${roundOutcomeText(r, view)}</div>`;
  body += `<p class="modal-body-text">${reasonText(r, view)}</p>`;
  body += deckJudgeHtml(r, view);
  body += `<p class="modal-body-text">スコア ${view.scores[0]} – ${view.scores[1]}</p>`;
  openModal('ラウンド終了', body, [{
    label: '次のラウンドへ', cls: 'btn-primary',
    onClick: () => { state.busy = true; send({ t: 'next' }); renderRoundModalReady(view); },
  }]);
  renderRoundModalReady(view);
}

function renderRoundModalReady(view) {
  const btn = $('modal-actions').querySelector('button');
  if (!btn) return;
  const iReady = state.ready[view.you];
  const oppReady = state.ready[1 - view.you];
  if (iReady && !oppReady) { btn.disabled = true; btn.textContent = '相手の返答を待っています…'; }
  else if (iReady && oppReady) { btn.disabled = true; btn.textContent = '開始します…'; }
  else { btn.disabled = false; btn.textContent = '次のラウンドへ'; }
}

function showMatchModal(view) {
  const winnerName = escapeHtml(nameOf(view.winner));
  const body = `
    <p class="modal-body-text" style="text-align:center;font-size:1.15rem">
      🏆 <strong>${winnerName}</strong> の勝利！
    </p>
    <p class="modal-body-text" style="text-align:center">最終スコア ${view.scores[0]} – ${view.scores[1]}</p>`;
  openModal('試合終了', body, [{
    label: 'もう一度対戦', cls: 'btn-primary',
    onClick: () => { state.busy = true; send({ t: 'rematch' }); renderMatchModalReady(view); },
  }]);
  renderMatchModalReady(view);
}

function renderMatchModalReady(view) {
  const btn = $('modal-actions').querySelector('button');
  if (!btn) return;
  if (state.ready[view.you] && !state.ready[1 - view.you]) { btn.disabled = true; btn.textContent = '相手の返答を待っています…'; }
  else { btn.disabled = false; btn.textContent = 'もう一度対戦'; }
}

function renderModal(view) {
  if (view.phase === 'roundOver') {
    const key = `ro-${view.round}-${view.roundResult?.reason}-${view.roundResult?.winner}`;
    if (state.modalKey !== key) { state.modalKey = key; showRoundModal(view); }
    else renderRoundModalReady(view);
  } else if (view.phase === 'matchOver') {
    const key = `mo-${view.winner}-${view.scores.join('-')}`;
    if (state.modalKey !== key) { state.modalKey = key; showMatchModal(view); }
    else renderMatchModalReady(view);
  } else if (state.modalKey) {
    state.modalKey = null;
    closeModal();
  }
}

function showRules() {
  const body = `
    <p class="modal-body-text">ライナー・クニツィア「En Garde」の基本ルール。</p>
    <ul class="rules-list">
      <li>盤は1〜23の23マス。相手との間合いを読み合います。</li>
      <li>手番では <strong>移動</strong> か <strong>攻撃</strong> のどちらか1つ。</li>
      <li><strong>移動</strong>：カードを1枚出し、その数だけ前進／後退。盤外・相手と重なる・飛び越す移動は不可。手札は5枚まで補充。</li>
      <li><strong>攻撃</strong>：間合いと<strong>ちょうど同じ数字</strong>のカードを1枚以上出す。同じ数字を多く出せば強化攻撃。</li>
      <li><strong>パリィ</strong>：同じ数字を同じ枚数出せば防げる。防げるなら自動で防御。合計値が同じでも数字が違えば防げません。</li>
      <li>防いだ側は補充せずにそのまま自分の手番を行います。</li>
      <li>動くことも攻撃もできないと、そのラウンドは負け。</li>
      <li><strong>山札切れ</strong>：最後の1枚が引かれたらその手番でラウンド終了。間合いのカードを多く持つ方が勝ち、同数ならより前進した方の勝ち、それも同じなら引き分け。</li>
      <li>5ラウンド先取で試合の勝ち。ラウンドごとに先手が交代します。</li>
    </ul>`;
  openModal('遊び方', body, [{ label: '閉じる', cls: 'btn-ghost', onClick: () => closeModal() }]);
}

// ------------------------------------------------------------ トースト
let toastTimer = null;
function showToast(text) {
  const toast = $('toast');
  toast.textContent = text;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2600);
}

// ------------------------------------------------------------ 操作
function wireActions() {
  $('move-forward').addEventListener('click', () => submitMove('forward'));
  $('move-backward').addEventListener('click', () => submitMove('backward'));
  $('attack-btn').addEventListener('click', submitAttack);
  $('count-minus').addEventListener('click', () => {
    state.attackCount = Math.max(1, state.attackCount - 1); render(state.view);
  });
  $('count-plus').addEventListener('click', () => {
    const distance = Math.abs(state.view.positions[1] - state.view.positions[0]);
    const max = Math.max(...state.view.legal.filter((a) => a.type === 'attack' && a.value === distance).map((a) => a.count), 1);
    state.attackCount = Math.min(max, state.attackCount + 1); render(state.view);
  });
  $('rules-btn').addEventListener('click', showRules);
  $('rules-btn-lobby').addEventListener('click', showRules);
  $('create-btn').addEventListener('click', () => {
    saveIdentity();
    send({ t: 'create', name: $('name-input').value });
  });
  $('join-btn').addEventListener('click', () => {
    const room = $('room-input').value.trim().toUpperCase();
    if (room.length !== 5) { $('lobby-error').textContent = '部屋コードは5文字です'; $('lobby-error').hidden = false; return; }
    $('lobby-error').hidden = true;
    saveIdentity();
    state.room = room;
    send({ t: 'join', room, name: $('name-input').value });
  });
  $('replaced-ok').addEventListener('click', () => {
    $('replaced-overlay').classList.add('hidden');
    state.replaced = false;
    state.manualClose = false;
    state.view = null;
    state.lastSeq = null;
    state.room = null;
    state.token = null;
    showScreen('lobby');
    connect();
  });
  $('copy-btn').addEventListener('click', async () => {
    const url = $('invite-url').value;
    try { await navigator.clipboard.writeText(url); }
    catch {
      $('invite-url').select(); document.execCommand('copy');
    }
    $('copy-done').hidden = false;
    setTimeout(() => { $('copy-done').hidden = true; }, 1800);
  });
}

function submitMove(dir) {
  const view = state.view;
  if (!view || state.busy || state.selectedValue == null) return;
  state.busy = true;
  render(view);
  send({ t: 'action', action: { type: 'move', dir, card: state.selectedValue } });
}
function submitAttack() {
  const view = state.view;
  if (!view || state.busy || state.selectedValue == null) return;
  const distance = Math.abs(view.positions[1] - view.positions[0]);
  state.busy = true;
  render(view);
  send({ t: 'action', action: { type: 'attack', value: distance, count: state.attackCount } });
}

// ------------------------------------------------------------ 起動
function init() {
  buildCells();
  wireActions();
  $('name-input').value = localStorage.getItem('engarde.name') || '';

  const params = new URLSearchParams(location.search);
  const roomParam = (params.get('room') || '').toUpperCase();
  if (roomParam) $('room-input').value = roomParam;

  const lastRoom = sessionStorage.getItem('engarde.lastRoom');

  connect();

  // 自動復帰
  const resumeRoom = roomParam || lastRoom;
  if (resumeRoom) {
    const token = loadToken(resumeRoom);
    if (token) {
      state.room = resumeRoom;
      state.token = token;
      state.awaitingResume = true;
      // connect() の onopen で resume を送る
    } else if (roomParam) {
      // 招待URLを開いただけ（まだ席がない）
      showScreen('lobby');
    }
  } else {
    showScreen('lobby');
  }

  // サーバー未接続でも復帰を試みるため、open を待つ
  if (state.ws.readyState === WebSocket.OPEN && state.room && state.token) {
    state.awaitingResume = true;
    send({ t: 'resume', room: state.room, token: state.token });
  }
}

init();
