// 公開用の荒らし対策（部屋数・接続数・連打の制限、/healthz）のテスト
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const serverPath = fileURLToPath(new URL('../src/server.js', import.meta.url));
let proc;
let port;

before(async () => {
  const env = {
    ...process.env, PORT: '0', HOST: '127.0.0.1',
    MAX_ROOMS: '3', MAX_CONN_PER_IP: '6', CREATE_LIMIT: '100', MSG_RATE: '5', MSG_BURST: '10',
  };
  proc = spawn(process.execPath, [serverPath], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  port = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('サーバーが LISTENING を出さない')), 10000);
    proc.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/LISTENING (\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
  });
});

after(() => { proc?.kill(); });

function connect(headers = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
  const closed = new Promise((r) => ws.on('close', (code) => r(code)));
  const opened = new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  return { ws, msgs, closed, opened };
}

const waitFor = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('タイムアウト');
};

test('/healthz は 200 ok を返す', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('部屋数が上限に達すると、つながっている部屋があれば作れない', async () => {
  const cs = [];
  for (let i = 0; i < 4; i += 1) {
    const c = connect({ 'x-forwarded-for': `10.0.0.${i + 1}` });
    await c.opened;
    c.ws.send(JSON.stringify({ t: 'create', name: `p${i}` }));
    cs.push(c);
  }
  for (let i = 0; i < 3; i += 1) await waitFor(() => cs[i].msgs.find((m) => m.t === 'created'));
  const err = await waitFor(() => cs[3].msgs.find((m) => m.t === 'error'));
  assert.match(err.message, /混み合って/);

  // 1部屋の持ち主が抜けると、その部屋を片付けて作れるようになる
  cs[0].ws.close();
  await cs[0].closed;
  await new Promise((r) => setTimeout(r, 50));
  cs[3].ws.send(JSON.stringify({ t: 'create', name: 'p3' }));
  await waitFor(() => cs[3].msgs.find((m) => m.t === 'created'));
  for (const c of cs) c.ws.close();
  await Promise.all(cs.map((c) => c.closed));
});

test('同じ IP からの接続は上限を超えると切られる', async () => {
  const cs = [];
  for (let i = 0; i < 6; i += 1) {
    const c = connect({ 'x-forwarded-for': '203.0.113.9' });
    await c.opened;
    cs.push(c);
  }
  const extra = connect({ 'x-forwarded-for': '203.0.113.9' });
  assert.equal(await extra.closed, 1013);
  // 別の IP からはつながる
  const other = connect({ 'x-forwarded-for': '203.0.113.10' });
  await other.opened;
  other.ws.close();
  // 1本切れば、また1本つなげる
  cs[0].ws.close();
  await cs[0].closed;
  await new Promise((r) => setTimeout(r, 50));
  const again = connect({ 'x-forwarded-for': '203.0.113.9' });
  await again.opened;
  again.ws.close();
  for (const c of cs.slice(1)) c.ws.close();
});

test('メッセージを連打すると切られる', async () => {
  const c = connect({ 'x-forwarded-for': '198.51.100.7' });
  await c.opened;
  for (let i = 0; i < 40; i += 1) c.ws.send(JSON.stringify({ t: 'noop' }));
  assert.equal(await c.closed, 1008);
});
