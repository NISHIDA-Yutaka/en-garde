// 仕様書 SPEC.md の第3章に対応するテスト。編集禁止。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const serverPath = fileURLToPath(new URL('../src/server.js', import.meta.url));
let proc;
let port;

before(async () => {
  proc = spawn(process.execPath, [serverPath], { env: { ...process.env, PORT: '0', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
  port = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('サーバーが LISTENING を出さない')), 10000);
    proc.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/LISTENING (\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    proc.on('exit', (code) => reject(new Error(`サーバーが終了した: ${code}`)));
  });
});

after(() => { proc?.kill(); });

// メッセージを全部記録し、条件に合うものを待てるクライアント
class Client {
  constructor() {
    this.msgs = [];
    this.raw = [];
    this.waiters = [];
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.on('message', (data) => {
      const text = data.toString();
      this.raw.push(text);
      const msg = JSON.parse(text);
      this.msgs.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(msg)) { w.resolve(msg); return false; }
        return true;
      });
    });
    this.closed = new Promise((r) => this.ws.on('close', r));
  }
  open() { return new Promise((r, j) => { this.ws.once('open', r); this.ws.once('error', j); }); }
  send(obj) { this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }
  // 送信後に届くメッセージから探す
  next(pred, label = '') {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`待っているメッセージが来ない: ${label}`)), 4000);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  }
  async request(obj, pred, label) {
    const p = this.next(pred, label);
    this.send(obj);
    return p;
  }
  close() { this.ws.close(); return this.closed; }
}

async function connect() {
  const c = new Client();
  await c.open();
  return c;
}

const isState = (m) => m.t === 'state' && m.view;

async function makeRoom() {
  const a = await connect();
  const b = await connect();
  const created = await a.request({ t: 'create', name: '  アリス  ' }, (m) => m.t === 'created', 'created');
  const aState = a.next(isState, 'A state');
  const bState = b.next(isState, 'B state');
  const joined = await b.request({ t: 'join', room: created.room, name: 'ボブ' }, (m) => m.t === 'joined', 'joined');
  return { a, b, created, joined, aView: (await aState).view, bView: (await bState).view, aMsg: await aState };
}

test('HTTP: / で HTML を返し、トラバーサルは 404', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /<html/i);
  const css = await fetch(`http://127.0.0.1:${port}/style.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  const js = await fetch(`http://127.0.0.1:${port}/app.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  const bad = await fetch(`http://127.0.0.1:${port}/%2e%2e/package.json`);
  assert.equal(bad.status, 404);
  const bad2 = await fetch(`http://127.0.0.1:${port}/..%2fpackage.json`);
  assert.equal(bad2.status, 404);
});

test('部屋を作って参加すると、両者に自分用の状態が届く', async () => {
  const { a, b, created, joined, aView, bView, aMsg } = await makeRoom();
  assert.match(created.room, /^[A-HJ-NP-Z2-9]{5}$/);
  assert.equal(created.player, 0);
  assert.equal(joined.player, 1);
  assert.equal(joined.room, created.room);
  assert.ok(typeof created.token === 'string' && created.token.length >= 16);
  assert.notEqual(created.token, joined.token);
  assert.deepEqual(aMsg.names, ['アリス', 'ボブ']);
  assert.equal(aView.you, 0);
  assert.equal(bView.you, 1);
  assert.equal(aView.myHand.length, 5);
  assert.equal(aView.opponentHandCount, 5);
  assert.equal(aView.deckCount, 15);
  assert.deepEqual(aView.positions, [1, 23]);
  assert.equal(aView.turn, 0);
  assert.ok(aView.legal.length > 0);
  assert.deepEqual(bView.legal, []);
  await a.close(); await b.close();
});

test('手番違い・不正な行動・壊れた JSON はエラーになり、接続は切れない', async () => {
  const { a, b, aView } = await makeRoom();
  const e1 = await b.request({ t: 'action', action: aView.legal[0] }, (m) => m.t === 'error', 'error 手番違い');
  assert.equal(typeof e1.message, 'string');
  await a.request({ t: 'action', action: { type: 'attack', value: 22, count: 1 } }, (m) => m.t === 'error', 'error 不正');
  await a.request('{これはJSONではない', (m) => m.t === 'error', 'error 壊れたJSON');
  await a.request({ t: 'nonsense' }, (m) => m.t === 'error', 'error 未知');
  // まだ使える
  const aNext = a.next(isState, 'A 次の state');
  const bNext = b.next(isState, 'B 次の state');
  a.send({ t: 'action', action: aView.legal[0] });
  const [va, vb] = [(await aNext).view, (await bNext).view];
  assert.equal(va.turn, 1);
  assert.equal(vb.turn, 1);
  assert.ok(vb.legal.length > 0);
  await a.close(); await b.close();
});

test('相手に自分の手札や山札の並びが一切送られない（1マッチ通しで確認）', async () => {
  const { a, b, aView, bView } = await makeRoom();
  const views = [aView, bView];
  const clients = [a, b];
  let guard = 0;
  while (true) {
    assert.ok(++guard < 3000, '終わらない');
    const v = views[0];
    if (v.phase === 'matchOver') break;
    if (v.phase === 'roundOver') {
      const pa = a.next((m) => isState(m) && m.view.phase !== 'roundOver', 'A 次ラウンド');
      const pb = b.next((m) => isState(m) && m.view.phase !== 'roundOver', 'B 次ラウンド');
      a.send({ t: 'next' });
      // 片方だけでは始まらない
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(a.msgs.filter((m) => isState(m)).at(-1).view.phase, 'roundOver');
      b.send({ t: 'next' });
      views[0] = (await pa).view; views[1] = (await pb).view;
      continue;
    }
    const p = v.turn;
    const legal = views[p].legal;
    // 攻撃できるなら攻撃し、なければ前進を優先（試合を早く進める）
    const action = legal.find((x) => x.type === 'attack') ?? legal.find((x) => x.dir === 'forward') ?? legal[0];
    const pa = a.next(isState, 'A state'); const pb = b.next(isState, 'B state');
    clients[p].send({ t: 'action', action });
    views[0] = (await pa).view; views[1] = (await pb).view;
  }
  assert.equal(views[1].phase, 'matchOver');
  assert.ok(views[0].winner === 0 || views[0].winner === 1);
  for (const c of [a, b]) {
    for (const text of c.raw) {
      assert.ok(!/"hands"\s*:/.test(text), `hands が送られた: ${text.slice(0, 200)}`);
      assert.ok(!/"deck"\s*:/.test(text), `deck が送られた: ${text.slice(0, 200)}`);
    }
  }
  // 再戦
  const ra = a.next((m) => isState(m) && m.view.phase === 'action', 'A 再戦');
  const rb = b.next((m) => isState(m) && m.view.phase === 'action', 'B 再戦');
  a.send({ t: 'rematch' }); b.send({ t: 'rematch' });
  const [na, nb] = [(await ra).view, (await rb).view];
  assert.deepEqual(na.scores, [0, 0]);
  assert.equal(na.round, 1);
  assert.equal(na.startPlayer, 1);
  assert.equal(nb.turn, 1);
  await a.close(); await b.close();
});

test('満員・存在しない部屋はエラー', async () => {
  const { a, b, created } = await makeRoom();
  const c = await connect();
  await c.request({ t: 'join', room: created.room, name: '三人目' }, (m) => m.t === 'error', '満員');
  await c.request({ t: 'join', room: 'ZZZZZ', name: 'x' }, (m) => m.t === 'error', '存在しない部屋');
  await c.request({ t: 'resume', room: created.room, token: 'でたらめ' }, (m) => m.t === 'error', '不正な token');
  await a.close(); await b.close(); await c.close();
});

test('切断と復帰: 相手に通知され、token で元の席に戻れる', async () => {
  const { a, b, created, joined } = await makeRoom();
  const gone = a.next((m) => m.t === 'presence' && m.connected[1] === false, 'presence 切断');
  await b.close();
  await gone;
  const b2 = await connect();
  const back = a.next((m) => m.t === 'presence' && m.connected[1] === true, 'presence 復帰');
  const st = b2.next(isState, 'b2 state');
  const res = await b2.request({ t: 'resume', room: created.room, token: joined.token }, (m) => m.t === 'joined', 'resume');
  assert.equal(res.player, 1);
  assert.equal((await st).view.you, 1);
  await back;
  // 同じ token で二重接続したら古い接続は閉じられる
  const b3 = await connect();
  await b3.request({ t: 'resume', room: created.room, token: joined.token }, (m) => m.t === 'joined', 'resume 2');
  await b2.closed;
  await a.close(); await b3.close();
});

test('名前は 16 文字に切られ、空なら既定の名前', async () => {
  const a = await connect();
  const b = await connect();
  const created = await a.request({ t: 'create', name: 'あ'.repeat(30) }, (m) => m.t === 'created');
  const st = a.next(isState);
  await b.request({ t: 'join', room: created.room, name: '   ' }, (m) => m.t === 'joined');
  const { names } = await st;
  assert.equal(names[0], 'あ'.repeat(16));
  assert.equal(names[1], 'プレイヤー2');
  await a.close(); await b.close();
});
