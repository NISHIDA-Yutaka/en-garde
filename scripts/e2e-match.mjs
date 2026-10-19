// SPEC.md 第5章 2 の確認用スクリプト。
// サーバーを起動し、ws で2人分のクライアントをつないで1マッチ最後まで対戦させる。
// 実行: node scripts/e2e-match.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const serverPath = fileURLToPath(new URL('../src/server.js', import.meta.url));

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [serverPath], {
      env: { ...process.env, PORT: '0', HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let buf = '';
    const timer = setTimeout(() => reject(new Error('LISTENING が出ない')), 10000);
    proc.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/LISTENING (\d+)/);
      if (m) { clearTimeout(timer); resolve({ proc, port: Number(m[1]) }); }
    });
    proc.on('exit', (code) => reject(new Error(`サーバー終了: ${code}`)));
  });
}

class Client {
  constructor(port, label) {
    this.label = label;
    this.msgs = [];
    this.waiters = [];
    this.errors = [];
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.t === 'error') this.errors.push(msg.message);
      this.msgs.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(msg)) { w.resolve(msg); return false; }
        return true;
      });
    });
  }
  open() { return new Promise((r, j) => { this.ws.once('open', r); this.ws.once('error', j); }); }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  next(pred, label = '') {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`[${this.label}] 待ちタイムアウト: ${label}`)), 5000);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  }
  request(obj, pred, label) { const p = this.next(pred, label); this.send(obj); return p; }
  close() { this.ws.close(); }
}

const isState = (m) => m.t === 'state' && m.view;

async function main() {
  const { proc, port } = await startServer();
  const a = new Client(port, 'A'); const b = new Client(port, 'B');
  try {
    await Promise.all([a.open(), b.open()]);
    const created = await a.request({ t: 'create', name: 'アリス' }, (m) => m.t === 'created', 'created');
    const aState1 = a.next(isState, 'A initial');
    const bState1 = b.next(isState, 'B initial');
    await b.request({ t: 'join', room: created.room, name: 'ボブ' }, (m) => m.t === 'joined', 'joined');
    let views = { a: (await aState1).view, b: (await bState1).view };
    console.log(`部屋 ${created.room} でマッチ開始: 先手 P${views.a.turn}`);

    const clients = { 0: a, 1: b };
    let guard = 0;
    let rounds = 0;
    while (true) {
      if (++guard > 5000) throw new Error('終わらない');
      const v = views.a;
      if (v.phase === 'matchOver') break;
      if (v.phase === 'roundOver') {
        rounds += 1;
        console.log(`  ラウンド${v.round} 終了: 勝者=${v.roundResult.winner ?? '引き分け'} 理由=${v.roundResult.reason} スコア ${v.scores[0]}-${v.scores[1]}`);
        const pa = a.next((m) => isState(m) && m.view.phase !== 'roundOver', 'A next');
        const pb = b.next((m) => isState(m) && m.view.phase !== 'roundOver', 'B next');
        a.send({ t: 'next' }); b.send({ t: 'next' });
        views = { a: (await pa).view, b: (await pb).view };
        continue;
      }
      const p = v.turn;
      const vp = p === 0 ? views.a : views.b;
      const legal = vp.legal;
      const action = legal.find((x) => x.type === 'attack') ?? legal.find((x) => x.dir === 'forward') ?? legal[0];
      const pa = a.next(isState, 'A state'); const pb = b.next(isState, 'B state');
      clients[p].send({ t: 'action', action });
      views = { a: (await pa).view, b: (await pb).view };
    }
    console.log(`マッチ終了: 勝者 ${views.a.winner} スコア ${views.a.scores[0]}-${views.a.scores[1]}（${rounds}ラウンド）`);

    // 再戦
    const ra = a.next((m) => isState(m) && m.view.phase === 'action', 'A rematch');
    const rb = b.next((m) => isState(m) && m.view.phase === 'action', 'B rematch');
    a.send({ t: 'rematch' }); b.send({ t: 'rematch' });
    const rv = (await ra).view;
    if (rv.scores[0] !== 0 || rv.scores[1] !== 0 || rv.round !== 1 || rv.startPlayer !== 1) {
      throw new Error(`再戦の初期状態が不正: ${JSON.stringify(rv)}`);
    }
    await rb;
    console.log('再戦も正常に開始（先手交代を確認）');

    // 相手の手札・山札が漏れていないか
    for (const c of [a, b]) {
      for (const m of c.msgs) {
        const text = JSON.stringify(m);
        if (/"hands"\s*:/.test(text) || /"deck"\s*:/.test(text)) throw new Error('手札/山札が漏れた');
      }
    }
    console.log('情報漏えいなし（hands/deck キーは送られていない）');
    console.log('E2E OK');
  } finally {
    a.close(); b.close();
    proc.kill();
  }
}

main().catch((error) => { console.error('E2E FAILED:', error.message); process.exit(1); });
