// En Garde Web サーバー: 静的ファイル配信 + WebSocket ルーム管理
// サーバーが唯一の正（クライアントの判定は信用しない）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createMatch, applyAction, startNextRound, viewFor } from './engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ENGINE_PATH = path.join(__dirname, 'engine.js');

const PORT = process.env.PORT === undefined ? 8080 : Number(process.env.PORT);
const HOST = process.env.HOST || '127.0.0.1';

const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 0 O 1 I を除く

// 荒らし対策（インターネットに公開するため）。環境変数で変えられる
const envInt = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
const MAX_ROOMS = envInt('MAX_ROOMS', 300); // サーバー全体の部屋数
const MAX_CONNECTIONS = envInt('MAX_CONNECTIONS', 1000); // サーバー全体の同時接続数
const MAX_CONN_PER_IP = envInt('MAX_CONN_PER_IP', 16); // 1つの IP からの同時接続数
const CREATE_LIMIT = envInt('CREATE_LIMIT', 20); // 1つの IP が CREATE_WINDOW_MS の間に作れる部屋数
const CREATE_WINDOW_MS = 10 * 60 * 1000;
const MSG_RATE = envInt('MSG_RATE', 10); // 1接続あたり毎秒のメッセージ数（平均）
const MSG_BURST = envInt('MSG_BURST', 30); // 一度に送れるメッセージ数
const HEARTBEAT_MS = 30 * 1000; // 応答のない接続を切る間隔

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------- HTTP

function sendNotFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
}

function serveFile(res, filePath, contentType, headOnly) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendNotFound(res);
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    res.end(headOnly ? undefined : data);
  });
}

function contentTypeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendNotFound(res);
    return;
  }
  const rawPath = (req.url || '/').split('?')[0];
  const headOnly = req.method === 'HEAD';

  if (rawPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(headOnly ? undefined : 'ok');
    return;
  }

  if (rawPath === '/engine.js') {
    serveFile(res, ENGINE_PATH, MIME['.js'], headOnly);
    return;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    sendNotFound(res);
    return;
  }

  if (decoded === '/' || decoded === '') decoded = '/index.html';

  const resolved = path.normalize(path.join(PUBLIC_DIR, decoded));
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    sendNotFound(res);
    return;
  }
  serveFile(res, resolved, contentTypeFor(resolved), headOnly);
});

// ------------------------------------------------------------- room state

/** @type {Map<string, object>} */
const rooms = new Map();

/** IP ごとの同時接続数 @type {Map<string, number>} */
const connectionsByIp = new Map();
/** IP ごとの部屋作成時刻 @type {Map<string, number[]>} */
const createsByIp = new Map();

// Caddy などの逆プロキシ越しなら X-Forwarded-For の最後（プロキシが付けた値）を使う。
// 直接つながっているのが自分（ループバック）のときだけ信用する
function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const forwarded = req.headers['x-forwarded-for'];
  if (loopback && typeof forwarded === 'string' && forwarded.trim()) {
    const parts = forwarded.split(',');
    return parts[parts.length - 1].trim();
  }
  return remote;
}

function allowCreate(ip) {
  const now = Date.now();
  const recent = (createsByIp.get(ip) || []).filter((t) => now - t < CREATE_WINDOW_MS);
  if (recent.length >= CREATE_LIMIT) {
    createsByIp.set(ip, recent);
    return false;
  }
  recent.push(now);
  createsByIp.set(ip, recent);
  return true;
}

function randomCode(length) {
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

function makeUniqueRoomCode() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = randomCode(5);
    if (!rooms.has(code)) return code;
  }
  return randomCode(8);
}

function makeToken() {
  return randomBytes(24).toString('base64url');
}

function cleanName(name, fallback) {
  const text = typeof name === 'string' ? name.trim() : '';
  return text.slice(0, 16) || fallback;
}

function touch(room) {
  room.lastActivity = Date.now();
}

function send(ws, message) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function broadcastState(room) {
  for (let player = 0; player < 2; player += 1) {
    const ws = room.sockets[player];
    if (!ws) continue;
    send(ws, {
      t: 'state',
      seq: room.seq,
      view: room.match ? viewFor(room.match, player) : null,
      names: [room.names[0], room.names[1]],
      ready: [...room.ready],
    });
  }
}

function sendPresence(room) {
  const message = { t: 'presence', connected: [!!room.sockets[0], !!room.sockets[1]] };
  send(room.sockets[0], message);
  send(room.sockets[1], message);
}

function createRoom(name, ws) {
  const code = makeUniqueRoomCode();
  const room = {
    code,
    names: [name, null],
    tokens: [makeToken(), null],
    sockets: [ws, null],
    match: null,
    seq: 0,
    ready: [false, false],
    rematch: [false, false],
    firstPlayer: 0,
    lastActivity: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function detach(ws) {
  const room = rooms.get(ws._room);
  if (!room) return;
  const player = ws._player;
  if (player != null && room.sockets[player] === ws) {
    room.sockets[player] = null;
    touch(room);
    sendPresence(room);
  }
}

function startMatch(room, firstPlayer) {
  room.firstPlayer = firstPlayer;
  room.match = createMatch({ firstPlayer });
  room.seq += 1;
  room.ready = [false, false];
  room.rematch = [false, false];
}

// ------------------------------------------------------- message handling

function handleCreate(ws, msg) {
  if (rooms.size >= MAX_ROOMS) sweepRooms(0);
  if (rooms.size >= MAX_ROOMS) {
    send(ws, { t: 'error', message: 'サーバーが混み合っています。しばらくしてから試してください' });
    return;
  }
  if (!allowCreate(ws._ip)) {
    send(ws, { t: 'error', message: '部屋を作りすぎです。しばらくしてから試してください' });
    return;
  }
  detach(ws);
  const name = cleanName(msg.name, 'プレイヤー1');
  const room = createRoom(name, ws);
  ws._room = room.code;
  ws._player = 0;
  ws._token = room.tokens[0];
  send(ws, { t: 'created', room: room.code, token: room.tokens[0], player: 0 });
  broadcastState(room);
  sendPresence(room);
}

function handleJoin(ws, msg) {
  const room = rooms.get(msg.room);
  if (!room) {
    send(ws, { t: 'error', message: '部屋が見つかりません' });
    return;
  }
  if (room.tokens[1] !== null) {
    send(ws, { t: 'error', message: 'この部屋は満員です' });
    return;
  }
  detach(ws);
  const name = cleanName(msg.name, 'プレイヤー2');
  const token = makeToken();
  room.names[1] = name;
  room.tokens[1] = token;
  room.sockets[1] = ws;
  ws._room = room.code;
  ws._player = 1;
  ws._token = token;
  touch(room);
  send(ws, { t: 'joined', room: room.code, token, player: 1 });
  if (!room.match) startMatch(room, 0);
  broadcastState(room);
  sendPresence(room);
}

function handleResume(ws, msg) {
  const room = rooms.get(msg.room);
  if (!room) {
    send(ws, { t: 'error', message: '部屋が見つかりません' });
    return;
  }
  const player = room.tokens.indexOf(msg.token);
  if (player === -1) {
    send(ws, { t: 'error', message: 'この部屋に復帰できません' });
    return;
  }
  detach(ws);
  const old = room.sockets[player];
  room.sockets[player] = ws;
  ws._room = room.code;
  ws._player = player;
  ws._token = msg.token;
  touch(room);
  send(ws, { t: 'joined', room: room.code, token: msg.token, player });
  if (old && old !== ws) {
    old._superseded = true;
    try {
      old.close(4001, 'superseded by another tab');
    } catch {
      /* ignore */
    }
  }
  broadcastState(room);
  sendPresence(room);
}

function handleAction(ws, msg) {
  const room = rooms.get(ws._room);
  if (!room || !room.match) {
    send(ws, { t: 'error', message: 'ゲームが始まっていません' });
    return;
  }
  const result = applyAction(room.match, ws._player, msg.action);
  if (!result.ok) {
    send(ws, { t: 'error', message: result.error });
    return;
  }
  room.match = result.state;
  room.seq += 1;
  touch(room);
  broadcastState(room);
}

function handleNext(ws) {
  const room = rooms.get(ws._room);
  if (!room || !room.match) return;
  if (room.match.phase !== 'roundOver') return;
  room.ready[ws._player] = true;
  touch(room);
  if (room.ready[0] && room.ready[1]) {
    room.match = startNextRound(room.match, Math.random);
    room.seq += 1;
    room.ready = [false, false];
  }
  broadcastState(room);
}

function handleRematch(ws) {
  const room = rooms.get(ws._room);
  if (!room || !room.match) return;
  if (room.match.phase !== 'matchOver') return;
  room.rematch[ws._player] = true;
  room.ready[ws._player] = true;
  touch(room);
  if (room.rematch[0] && room.rematch[1]) {
    startMatch(room, 1 - room.firstPlayer);
  }
  broadcastState(room);
}

function handleMessage(ws, msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    send(ws, { t: 'error', message: 'メッセージの形式が不正です' });
    return;
  }
  switch (msg.t) {
    case 'create':
      handleCreate(ws, msg);
      break;
    case 'join':
      handleJoin(ws, msg);
      break;
    case 'resume':
      handleResume(ws, msg);
      break;
    case 'action':
      handleAction(ws, msg);
      break;
    case 'next':
      handleNext(ws);
      break;
    case 'rematch':
      handleRematch(ws);
      break;
    default:
      send(ws, { t: 'error', message: '不明なメッセージです' });
  }
}

// ------------------------------------------------------------ websocket

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

wss.on('connection', (ws, req) => {
  ws._room = null;
  ws._player = null;
  ws._superseded = false;
  ws._ip = clientIp(req);
  ws.on('error', () => {
    /* ソケットエラーは無視（close で処理する） */
  });

  const count = connectionsByIp.get(ws._ip) || 0;
  if (wss.clients.size > MAX_CONNECTIONS || count >= MAX_CONN_PER_IP) {
    ws.close(1013, 'too many connections');
    return;
  }
  connectionsByIp.set(ws._ip, count + 1);

  ws._alive = true;
  ws.on('pong', () => {
    ws._alive = true;
  });

  // メッセージの連打を制限する（トークンバケット）
  let tokens = MSG_BURST;
  let refilledAt = Date.now();

  ws.on('message', (data) => {
    const now = Date.now();
    tokens = Math.min(MSG_BURST, tokens + ((now - refilledAt) / 1000) * MSG_RATE);
    refilledAt = now;
    if (tokens < 1) {
      ws.close(1008, 'too many messages');
      return;
    }
    tokens -= 1;

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      send(ws, { t: 'error', message: 'メッセージを解析できません' });
      return;
    }
    try {
      handleMessage(ws, msg);
    } catch {
      send(ws, { t: 'error', message: 'サーバー内部エラー' });
    }
  });

  ws.on('close', () => {
    detach(ws);
    const left = (connectionsByIp.get(ws._ip) || 1) - 1;
    if (left > 0) connectionsByIp.set(ws._ip, left);
    else connectionsByIp.delete(ws._ip);
  });
});

// 応答のない接続（回線が切れたままのもの）を切る
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws._alive) {
      ws.terminate();
      continue;
    }
    ws._alive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);
heartbeat.unref?.();

// 誰もつながっていない部屋を、最後の操作から ttl ミリ秒たったら消す
function sweepRooms(ttl) {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const connected = room.sockets[0] || room.sockets[1];
    if (!connected && now - room.lastActivity >= ttl) {
      rooms.delete(code);
    }
  }
}

// 2 時間アクセスのない部屋と、古い部屋作成の記録を掃除する
const cleaner = setInterval(() => {
  sweepRooms(ROOM_TTL_MS);
  const now = Date.now();
  for (const [ip, times] of createsByIp) {
    if (times.every((t) => now - t >= CREATE_WINDOW_MS)) createsByIp.delete(ip);
  }
}, 10 * 60 * 1000);
cleaner.unref?.();

server.listen(PORT, HOST, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : PORT;
  console.log(`LISTENING ${actualPort}`);
});

export { server, wss };
