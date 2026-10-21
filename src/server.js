// アンギャルド対戦サーバー: public/ の静的ファイルと、WebSocket（/ws）の対戦部屋。
// 勝敗の判定はすべてサーバーで行い、クライアントにはそれぞれの viewFor だけを送る。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomInt } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createMatch, applyAction, startNextRound, viewFor } from './engine.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(ROOT, '../public');

const PORT = process.env.PORT === undefined ? 8080 : Number(process.env.PORT);
const HOST = process.env.HOST || '127.0.0.1';

const envInt = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

// 部屋と荒らし対策の設定（インターネットに公開しているため）
const LIMITS = {
  roomTtlMs: 2 * 60 * 60 * 1000, // 誰もいない部屋を消すまで
  maxRooms: envInt('MAX_ROOMS', 300),
  maxConnections: envInt('MAX_CONNECTIONS', 1000),
  maxConnPerIp: envInt('MAX_CONN_PER_IP', 16),
  createPerWindow: envInt('CREATE_LIMIT', 20), // 1つの IP が10分間に作れる部屋数
  createWindowMs: 10 * 60 * 1000,
  msgRate: envInt('MSG_RATE', 10), // 1接続あたり毎秒（平均）
  msgBurst: envInt('MSG_BURST', 30),
  heartbeatMs: 30 * 1000,
};

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 0 O 1 I を除く
const DEFAULT_NAMES = ['プレイヤー1', 'プレイヤー2'];

// ------------------------------------------------------------------ HTTP

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

async function handleHttp(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : 'ok');
    return;
  }

  let file;
  try {
    const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    file = path.resolve(PUBLIC_DIR, `.${rel}`);
  } catch {
    file = null;
  }
  const type = file && TYPES[path.extname(file)];
  if (!type || !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('見つかりません');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('見つかりません');
  }
}

const server = http.createServer((req, res) => {
  handleHttp(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

// ------------------------------------------------------------------ 部屋

/** @type {Map<string, Room>} */
const rooms = new Map();

/**
 * @typedef {object} Room
 * @property {string} code
 * @property {(string|null)[]} names
 * @property {(string|null)[]} tokens
 * @property {(import('ws').WebSocket|null)[]} sockets
 * @property {object|null} match
 * @property {number} seq  状態が変わるたびに増える番号（クライアントが演出の重複を防ぐのに使う）
 * @property {boolean[]} ready  ラウンド結果やマッチ結果を見終わったか
 * @property {number} firstPlayer
 * @property {number} touchedAt
 */

function newRoomCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 5; i += 1) code += CODE_CHARS[randomInt(CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
}

const newToken = () => randomBytes(24).toString('base64url');

function cleanName(name, seat) {
  const text = typeof name === 'string' ? name.trim().slice(0, 16) : '';
  return text || DEFAULT_NAMES[seat];
}

function send(ws, message) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function broadcastState(room) {
  room.touchedAt = Date.now();
  room.sockets.forEach((ws, seat) => {
    send(ws, {
      t: 'state',
      seq: room.seq,
      view: room.match ? viewFor(room.match, seat) : null,
      names: [...room.names],
      ready: [...room.ready],
    });
  });
}

function broadcastPresence(room) {
  const message = { t: 'presence', connected: room.sockets.map(Boolean) };
  room.sockets.forEach((ws) => send(ws, message));
}

function startMatch(room, firstPlayer) {
  room.firstPlayer = firstPlayer;
  room.match = createMatch({ firstPlayer });
  room.ready = [false, false];
  room.seq += 1;
}

// この接続を、いま座っている席から外す
function leaveSeat(ws) {
  const room = rooms.get(ws.roomCode);
  if (room && room.sockets[ws.seat] === ws) {
    room.sockets[ws.seat] = null;
    room.touchedAt = Date.now();
    broadcastPresence(room);
  }
  ws.roomCode = null;
  ws.seat = null;
}

function sit(ws, room, seat) {
  ws.roomCode = room.code;
  ws.seat = seat;
  const previous = room.sockets[seat];
  room.sockets[seat] = ws;
  // 同じ席に別のタブから戻ってきたら、古いタブは閉じる（4001 で知らせ、再接続させない）
  if (previous && previous !== ws) {
    previous.roomCode = null;
    previous.close(4001, 'superseded');
  }
}

// ------------------------------------------------------------------ 荒らし対策

const connectionsByIp = new Map();
const createsByIp = new Map();

// Caddy 越しなら X-Forwarded-For の最後（Caddy が付けた本当の相手）を使う。
// 直接つないできたのが自分自身（ループバック）のときだけ、このヘッダーを信用する
function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  const forwarded = req.headers['x-forwarded-for'];
  const viaProxy = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote);
  if (viaProxy && typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',').at(-1).trim();
  }
  return remote;
}

function mayCreateRoom(ip) {
  const now = Date.now();
  const recent = (createsByIp.get(ip) || []).filter((t) => now - t < LIMITS.createWindowMs);
  const allowed = recent.length < LIMITS.createPerWindow;
  if (allowed) recent.push(now);
  createsByIp.set(ip, recent);
  return allowed;
}

// 誰もつながっていない部屋のうち、最後の操作から ttl 以上たったものを消す
function sweepRooms(ttl) {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (!room.sockets.some(Boolean) && now - room.touchedAt >= ttl) rooms.delete(code);
  }
}

// ------------------------------------------------------------------ メッセージ

const handlers = {
  create(ws, msg) {
    if (rooms.size >= LIMITS.maxRooms) sweepRooms(0);
    if (rooms.size >= LIMITS.maxRooms) return '混み合っています。しばらくしてから試してください';
    if (!mayCreateRoom(ws.ip)) return '部屋を作りすぎです。しばらくしてから試してください';
    leaveSeat(ws);
    const room = {
      code: newRoomCode(),
      names: [cleanName(msg.name, 0), null],
      tokens: [newToken(), null],
      sockets: [null, null],
      match: null,
      seq: 0,
      ready: [false, false],
      firstPlayer: 0,
      touchedAt: Date.now(),
    };
    rooms.set(room.code, room);
    sit(ws, room, 0);
    send(ws, { t: 'created', room: room.code, token: room.tokens[0], player: 0 });
    broadcastState(room);
    broadcastPresence(room);
    return null;
  },

  join(ws, msg) {
    const room = rooms.get(String(msg.room ?? '').toUpperCase());
    if (!room) return '部屋が見つかりません';
    if (room.tokens[1] !== null) return 'この部屋は満員です';
    leaveSeat(ws);
    room.names[1] = cleanName(msg.name, 1);
    room.tokens[1] = newToken();
    sit(ws, room, 1);
    send(ws, { t: 'joined', room: room.code, token: room.tokens[1], player: 1 });
    startMatch(room, 0);
    broadcastState(room);
    broadcastPresence(room);
    return null;
  },

  resume(ws, msg) {
    const room = rooms.get(String(msg.room ?? ''));
    if (!room) return '部屋が見つかりません';
    const seat = typeof msg.token === 'string' ? room.tokens.indexOf(msg.token) : -1;
    if (seat === -1) return 'この部屋には戻れません';
    if (ws.roomCode !== room.code || ws.seat !== seat) leaveSeat(ws);
    sit(ws, room, seat);
    send(ws, { t: 'joined', room: room.code, token: msg.token, player: seat });
    broadcastState(room);
    broadcastPresence(room);
    return null;
  },

  action(ws, msg) {
    const room = rooms.get(ws.roomCode);
    if (!room?.match) return '対戦が始まっていません';
    const result = applyAction(room.match, ws.seat, msg.action);
    if (!result.ok) return result.error;
    room.match = result.state;
    room.seq += 1;
    broadcastState(room);
    return null;
  },

  next(ws) {
    const room = rooms.get(ws.roomCode);
    if (room?.match?.phase !== 'roundOver') return null;
    room.ready[ws.seat] = true;
    if (room.ready.every(Boolean)) {
      room.match = startNextRound(room.match);
      room.ready = [false, false];
      room.seq += 1;
    }
    broadcastState(room);
    return null;
  },

  rematch(ws) {
    const room = rooms.get(ws.roomCode);
    if (room?.match?.phase !== 'matchOver') return null;
    room.ready[ws.seat] = true;
    if (room.ready.every(Boolean)) startMatch(room, 1 - room.firstPlayer);
    broadcastState(room);
    return null;
  },
};

function handleMessage(ws, data) {
  let msg;
  try {
    msg = JSON.parse(String(data));
  } catch {
    send(ws, { t: 'error', message: 'メッセージを読み取れませんでした' });
    return;
  }
  const handler = msg && typeof msg === 'object' && Object.hasOwn(handlers, msg.t) ? handlers[msg.t] : null;
  if (!handler) {
    send(ws, { t: 'error', message: '知らないメッセージです' });
    return;
  }
  let error;
  try {
    error = handler(ws, msg);
  } catch {
    error = 'サーバーでエラーが起きました';
  }
  if (error) send(ws, { t: 'error', message: error });
}

// ------------------------------------------------------------------ WebSocket

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

wss.on('connection', (ws, req) => {
  ws.on('error', () => {}); // close で後片付けする
  ws.ip = clientIp(req);
  ws.roomCode = null;
  ws.seat = null;

  const fromIp = connectionsByIp.get(ws.ip) || 0;
  if (wss.clients.size > LIMITS.maxConnections || fromIp >= LIMITS.maxConnPerIp) {
    ws.close(1013, 'too many connections');
    return;
  }
  connectionsByIp.set(ws.ip, fromIp + 1);

  ws.alive = true;
  ws.on('pong', () => {
    ws.alive = true;
  });

  // メッセージの連打を制限する（トークンバケット）
  let tokens = LIMITS.msgBurst;
  let lastRefill = Date.now();
  ws.on('message', (data) => {
    const now = Date.now();
    tokens = Math.min(LIMITS.msgBurst, tokens + ((now - lastRefill) / 1000) * LIMITS.msgRate);
    lastRefill = now;
    if (tokens < 1) {
      ws.close(1008, 'too many messages');
      return;
    }
    tokens -= 1;
    handleMessage(ws, data);
  });

  ws.on('close', () => {
    leaveSeat(ws);
    const left = (connectionsByIp.get(ws.ip) || 1) - 1;
    if (left > 0) connectionsByIp.set(ws.ip, left);
    else connectionsByIp.delete(ws.ip);
  });
});

// 回線が切れたまま応答しない接続を切る
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, LIMITS.heartbeatMs).unref();

setInterval(() => {
  sweepRooms(LIMITS.roomTtlMs);
  const now = Date.now();
  for (const [ip, times] of createsByIp) {
    if (times.every((t) => now - t >= LIMITS.createWindowMs)) createsByIp.delete(ip);
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log(`LISTENING ${server.address().port}`);
});
