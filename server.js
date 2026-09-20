// Monopoly (Entenhausen-Edition) - Online-Server
// Einfacher, selbst-gehosteter Mehrspieler-Server auf Basis von Express + Socket.IO.
// Regelwerk: siehe src/engine.js (deutsche Hasbro-Edition 2017).

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const engine = require('./src/engine.js');
const { botAct, autoAct } = require('./src/bots.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// index.html wird mit Versionsnummer an den Dateinamen ausgeliefert (?v=Startzeit),
// damit Browser und Zwischen-Caches nach jedem Neustart garantiert frische Dateien laden.
const BUILD_ID = Date.now().toString(36);
function serveIndex(req, res) {
  fs.readFile(path.join(__dirname, 'public', 'index.html'), 'utf8', (err, html) => {
    if (err) return res.status(500).send('index.html fehlt');
    const out = html.replace(/__BUILD__/g, BUILD_ID).replace(/(href|src)="(style\.css|client\.js|board-data\.js)"/g, `$1="$2?v=${BUILD_ID}"`);
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(out);
  });
}
app.get(['/', '/index.html'], serveIndex);

// Dateien immer neu prüfen (ETag), damit nach einem Update nie alter Client-Code aus dem Cache läuft.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// ---------------------------------------------------------------------------
// Konstanten
// ---------------------------------------------------------------------------

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
const MAX_ROOMS = 500; // Sicherheitsventil gegen Speicher-Erschöpfung durch Missbrauch
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne verwechselbare Zeichen
const ROOM_CLEANUP_MS = 3 * 60 * 60 * 1000; // Räume ohne Aktivität nach 3h entsorgen

const DEFAULT_START_MONEY = 1500;

// Spielfiguren (Entenhausen-Vögel). Die Farbe wird auch für Besitz-Markierungen genutzt.
const TOKENS = [
  { emoji: '🦆', color: '#3b82f6' },
  { emoji: '🐤', color: '#eab308' },
  { emoji: '🦉', color: '#a855f7' },
  { emoji: '🦢', color: '#14b8a6' },
  { emoji: '🐧', color: '#ef4444' },
  { emoji: '🦜', color: '#22c55e' },
];

const BOT_PERSONA = { Gustav: 'bold', Klaas: 'careful', Karlo: 'trader', Gundel: 'careful', 'Düsentrieb': 'trader', Panzerknacker: 'bold' };
const BOT_NAME_POOL = ['Gustav', 'Klaas', 'Karlo', 'Gundel', 'Düsentrieb', 'Panzerknacker'];

// Verzögerungen für Bot-Aktionen - über Umgebungsvariablen konfigurierbar,
// damit automatisierte Tests nicht in Echtzeit-Tempo laufen müssen.
const BOT_DELAY_MIN = process.env.BOT_DELAY_MIN_MS !== undefined ? Number(process.env.BOT_DELAY_MIN_MS) : 1500;
const BOT_DELAY_MAX = process.env.BOT_DELAY_MAX_MS !== undefined ? Number(process.env.BOT_DELAY_MAX_MS) : 2300;
// Wie lange ein verbundener Mensch am Zug warten muss, bevor der Host ihn
// überspringen darf, und wie lange ein getrennter Host wartet, bis die
// Host-Rolle weitergereicht wird.
const SKIP_MIN_WAIT_MS = Number(process.env.SKIP_MIN_WAIT_MS) || 20000;
const HOST_HANDOVER_MS = Number(process.env.HOST_HANDOVER_MS) || 20000;

function randomDelay() {
  return BOT_DELAY_MIN + Math.random() * Math.max(0, BOT_DELAY_MAX - BOT_DELAY_MIN);
}

// Bots ziehen im Schnell-Modus und ab der zweiten Runde zügiger.
function botDelay(room) {
  let d = randomDelay();
  if (room.settings.speed === 'fast') d *= 0.5;
  if (room.g && room.g.round >= 2) d *= 0.7;
  return d;
}

function makeRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

function makeId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ---------------------------------------------------------------------------
// Einfaches Rate-Limiting (Schutz vor Missbrauch, da öffentlich erreichbar)
// ---------------------------------------------------------------------------

function getClientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return socket.handshake.address || 'unknown';
}

const rateLimitHits = new Map();

function isRateLimited(key, limit, windowMs) {
  const now = Date.now();
  const hits = (rateLimitHits.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    rateLimitHits.set(key, hits);
    return true;
  }
  hits.push(now);
  rateLimitHits.set(key, hits);
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of rateLimitHits) {
    const fresh = hits.filter((t) => now - t < 10 * 60 * 1000);
    if (fresh.length) rateLimitHits.set(key, fresh);
    else rateLimitHits.delete(key);
  }
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Raumverwaltung
// ---------------------------------------------------------------------------

const rooms = new Map(); // code -> room

function createRoom() {
  const code = makeRoomCode();
  const room = {
    code,
    hostId: null,
    players: [], // { id, token, name, socketId, connected, isBot, tokenIdx }
    phase: 'lobby', // lobby | playing | gameover
    settings: { startMoney: DEFAULT_START_MONEY, rules: Object.assign({}, engine.RULE_DEFAULTS), turnTimer: 0, limit: 'none', speed: 'normal' },
    g: null,
    logs: [],
    botTimer: null,
    hostTimer: null,
    lastActivity: Date.now(),
    cleanupTimer: null,
  };
  rooms.set(code, room);
  touchRoom(room);
  return room;
}

function destroyRoom(room) {
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  if (room.botTimer) clearTimeout(room.botTimer);
  if (room.hostTimer) clearTimeout(room.hostTimer);
  rooms.delete(room.code);
}

function touchRoom(room) {
  room.lastActivity = Date.now();
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => destroyRoom(room), ROOM_CLEANUP_MS);
}

function log(room, text) {
  room.logs.push({ text, at: Date.now() });
  if (room.logs.length > 300) room.logs.shift();
}

function findPlayer(room, playerId) {
  return room.players.find((p) => p.id === playerId);
}

function freeTokenIdx(room) {
  const used = new Set(room.players.map((p) => p.tokenIdx));
  for (let i = 0; i < TOKENS.length; i++) if (!used.has(i)) return i;
  return 0;
}

function newPlayer(room, name, socket, isBot) {
  const player = {
    id: makeId(),
    token: isBot ? null : makeId(),
    name,
    socketId: socket ? socket.id : null,
    connected: true,
    isBot: !!isBot,
    tokenIdx: freeTokenIdx(room),
  };
  room.players.push(player);
  return player;
}

// true, wenn die Host-Rolle weitergereicht wurde (Aufrufer sendet den Zustand).
function ensureHost(room) {
  const host = findPlayer(room, room.hostId);
  if (host && !host.isBot && host.connected && !host.left) return false;
  const next = room.players.find((p) => !p.isBot && p.connected && !p.left);
  if (!next) return false;
  room.hostId = next.id;
  log(room, `${next.name} ist jetzt Host.`);
  return true;
}

function scheduleHostHandover(room) {
  if (room.hostTimer) clearTimeout(room.hostTimer);
  room.hostTimer = setTimeout(() => {
    room.hostTimer = null;
    if (rooms.has(room.code) && ensureHost(room)) { touchRoom(room); broadcastState(room); }
  }, HOST_HANDOVER_MS);
}

function addBot(room) {
  if (room.players.length >= MAX_PLAYERS) return null;
  const usedNames = new Set(room.players.map((p) => p.name));
  const name = BOT_NAME_POOL.find((n) => !usedNames.has(n)) || `Bot ${room.players.length + 1}`;
  const bot = newPlayer(room, name, null, true);
  bot.persona = BOT_PERSONA[name] || ['careful', 'bold', 'trader'][Math.floor(Math.random() * 3)];
  log(room, `${name} (Bot) wurde hinzugefügt.`);
  return bot;
}

// ---------------------------------------------------------------------------
// Zustand an Clients senden
// ---------------------------------------------------------------------------

// Menschen, die gerade am Zug sind und auf die gewartet wird (für "Überspringen").
function waitInfo(room) {
  const g = room.g;
  if (room.phase !== 'playing' || !g) { room._wait = null; return null; }
  const actor = engine.pendingActors(room).find((a) => {
    const p = findPlayer(room, a.id);
    return p && !p.isBot && p.connected && a.kind !== 'trade';
  });
  if (!actor) { room._wait = null; return null; }
  const key = [g.turnCount, g.phase, g.rollSeq, g.moveSeq, g.auction ? g.auction.highBid + ':' + g.auction.idx : '', g.debts.length].join('|');
  if (!room._wait || room._wait.key !== key) room._wait = { key, since: Date.now() };
  return { ids: [actor.id], elapsedMs: Date.now() - room._wait.since };
}

function publicState(room) {
  const game = room.g && room.phase !== 'lobby' ? engine.snapshot(room) : null;
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    settings: room.settings,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      isHost: p.id === room.hostId,
      isBot: p.isBot,
      persona: p.persona || null,
      left: !!p.left,
      emoji: TOKENS[p.tokenIdx].emoji,
      color: TOKENS[p.tokenIdx].color,
    })),
    game,
    logs: room.logs.slice(-60),
    now: Date.now(),
    wait: waitInfo(room),
    timer: room.timerInfo ? { actorId: room.timerInfo.actorId, remainingMs: Math.max(0, room.timerInfo.deadline - Date.now()), total: room.timerInfo.total } : null,
  };
}

// Die Clients zeigen Würfeln, Laufen, Karten und Knast-Animation nacheinander.
// Damit niemand (auch kein Bot) handelt, bevor die Figur angekommen ist, sperrt
// der Server Aktionen für die geschätzte Dauer dieser Animationen.
const ANIM_SCALE = process.env.ANIM_SCALE !== undefined ? Number(process.env.ANIM_SCALE) : 1;

function updateAnimLock(room) {
  const g = room.g;
  if (!g || ANIM_SCALE <= 0) return;
  if (room.animSeen === undefined) room.animSeen = { move: 0, roll: 0 };
  const seen = room.animSeen;
  let ms = 0;
  if (g.rollSeq !== seen.roll) ms += 1300;
  (g.moves || []).filter((m) => m.seq > seen.move).forEach((m) => {
    if (g.lastCard && m.card === g.lastCard.seq && m.card !== seen.card && m.kind === 'jail') ms += 2600;
    else if (g.lastCard && m.card === g.lastCard.seq && m.card !== seen.card) ms += 1900;
    if (m.kind === 'jail') { ms += 2800; return; }
    const dist = m.kind === 'back' ? (m.from - m.to + 40) % 40 : (m.to - m.from + 40) % 40;
    ms += dist === 0 || dist > 16 ? 250 : dist * 230 + 350;
  });
  seen.roll = g.rollSeq;
  seen.move = g.moves && g.moves.length ? g.moves[g.moves.length - 1].seq : seen.move;
  seen.card = g.lastCard ? g.lastCard.seq : seen.card;
  const speed = room.settings.speed === 'fast' ? 0.55 : 1;
  if (ms > 0) room.animUntil = Math.max(Date.now(), room.animUntil || 0) + (ms * speed + 300) * ANIM_SCALE;
}

const TIMER_SCALE = process.env.TIMER_SCALE !== undefined ? Number(process.env.TIMER_SCALE) : 1;

// Zug-Timer (Lobby-Regel): Wer zu lange braucht, wird einmalig automatisch gespielt.
function timerActor(room) {
  if (!room.settings.turnTimer || room.phase !== 'playing' || !room.g || room.g.phase === 'over') return null;
  return engine.pendingActors(room).find((a) => {
    const p = findPlayer(room, a.id);
    return p && !p.isBot && p.connected && !p.left;
  }) || null;
}

function timerSig(room, actor) {
  const g = room.g;
  return [g.turnCount, g.phase, actor.id, actor.kind, g.rollSeq, g.auction ? g.auction.bids.length + ':' + g.auction.idx : '', g.debts.length, g.trade ? g.trade.id : ''].join('|');
}

function updateTurnTimer(room) {
  const actor = timerActor(room);
  if (!actor) {
    if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
    room.timerInfo = null;
    room.timerSig = null;
    return;
  }
  const sig = timerSig(room, actor);
  if (sig === room.timerSig) return;
  room.timerSig = sig;
  if (room.turnTimer) clearTimeout(room.turnTimer);
  const total = room.settings.turnTimer * 1000 * TIMER_SCALE;
  const deadline = Math.max(Date.now(), room.animUntil || 0) + total;
  room.timerInfo = { actorId: actor.id, deadline, total };
  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    if (!rooms.has(room.code)) return;
    const a = timerActor(room);
    if (!a || timerSig(room, a) !== sig) return;
    const p = findPlayer(room, a.id);
    log(room, `⏱ Zeit abgelaufen – ${p ? p.name : 'Spieler'} wird automatisch gespielt.`);
    try {
      autoAct(room, a);
    } catch (err) { console.error('Timer-Fehler:', err); }
    touchRoom(room);
    room.timerSig = null; // nächste Entscheidung bekommt frische Zeit
    broadcastState(room);
  }, Math.max(1000, deadline - Date.now()));
  if (room.turnTimer.unref) room.turnTimer.unref();
}

function broadcastState(room) {
  updateAnimLock(room);
  updateTurnTimer(room);
  io.to(room.code).emit('gameState', publicState(room));
  scheduleBots(room);
}

// ---------------------------------------------------------------------------
// Bots (und getrennte Menschen) spielen automatisch
// ---------------------------------------------------------------------------

function pickBotActor(room) {
  return engine.pendingActors(room).find((a) => {
    const p = findPlayer(room, a.id);
    return p && (p.isBot || !p.connected || p.left);
  });
}

function scheduleBots(room) {
  if (room.botTimer) return;
  if (room.phase !== 'playing' || !room.g || room.g.phase === 'over') return;
  // Ohne anwesende Menschen pausiert das Spiel, statt endlos weiterzulaufen.
  if (!room.players.some((p) => !p.isBot && p.connected && !p.left)) return;
  if (!pickBotActor(room)) return;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (!rooms.has(room.code)) return;
    const actor = pickBotActor(room);
    if (actor) {
      try { botAct(room, actor); } catch (err) { console.error('Bot-Fehler:', err); }
      touchRoom(room);
    }
    broadcastState(room);
  }, Math.max(botDelay(room), (room.animUntil || 0) - Date.now()));
  if (room.botTimer.unref) room.botTimer.unref();
}

// ---------------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------------

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function roomOf(socket) {
  return rooms.get(socket.data.roomCode);
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name }, cb) => {
    try {
      if (isRateLimited(`createRoom:${getClientIp(socket)}`, 8, 60 * 1000)) {
        return cb({ ok: false, error: 'Zu viele neue Räume in kurzer Zeit. Bitte kurz warten und erneut versuchen.' });
      }
      if (rooms.size >= MAX_ROOMS) {
        return cb({ ok: false, error: 'Gerade sind zu viele Räume aktiv. Bitte versuche es in ein paar Minuten erneut.' });
      }
      name = (name || '').trim().slice(0, 20) || 'Spieler';
      const room = createRoom();
      const player = newPlayer(room, name, socket, false);
      room.hostId = player.id;
      socket.join(room.code);
      socket.data.roomCode = room.code;
      socket.data.playerId = player.id;
      log(room, `${name} hat den Raum erstellt.`);
      touchRoom(room);
      cb({ ok: true, code: room.code, playerId: player.id, token: player.token });
      broadcastState(room);
    } catch (err) {
      cb({ ok: false, error: 'Raum konnte nicht erstellt werden.' });
    }
  });

  socket.on('joinRoom', ({ code, name, token }, cb) => {
    if (isRateLimited(`joinRoom:${getClientIp(socket)}`, 20, 60 * 1000)) {
      return cb({ ok: false, error: 'Zu viele Versuche in kurzer Zeit. Bitte kurz warten und erneut versuchen.' });
    }
    code = (code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'Diesen Raum gibt es nicht.' });

    if (token) {
      const existing = room.players.find((p) => p.token === token && !p.left);
      if (existing) {
        existing.socketId = socket.id;
        existing.connected = true;
        if (room.hostId === existing.id && room.hostTimer) { clearTimeout(room.hostTimer); room.hostTimer = null; }
        socket.join(room.code);
        socket.data.roomCode = room.code;
        socket.data.playerId = existing.id;
        touchRoom(room);
        log(room, `${existing.name} ist wieder verbunden.`);
        cb({ ok: true, code: room.code, playerId: existing.id, token: existing.token, rejoined: true });
        broadcastState(room);
        return;
      }
    }

    if (room.phase !== 'lobby') {
      return cb({ ok: false, error: 'Das Spiel läuft bereits. Bitte warte auf die nächste Partie.' });
    }
    if (room.players.length >= MAX_PLAYERS) {
      return cb({ ok: false, error: `Der Raum ist bereits voll (max. ${MAX_PLAYERS} Spieler).` });
    }
    name = (name || '').trim().slice(0, 20) || 'Spieler';
    if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return cb({ ok: false, error: 'Dieser Name ist im Raum bereits vergeben.' });
    }
    const player = newPlayer(room, name, socket, false);
    if (!room.hostId) room.hostId = player.id;
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    touchRoom(room);
    log(room, `${name} ist dem Raum beigetreten.`);
    cb({ ok: true, code: room.code, playerId: player.id, token: player.token });
    broadcastState(room);
  });

  socket.on('leaveRoom', () => {
    const room = roomOf(socket);
    if (!room) return;
    const player = findPlayer(room, socket.data.playerId);
    if (!player) return;

    if (room.phase === 'lobby') {
      room.players = room.players.filter((p) => p.id !== player.id);
      if (room.hostId === player.id) {
        room.hostId = room.players.length ? room.players[0].id : null;
        ensureHost(room);
      }
      log(room, `${player.name} hat den Raum verlassen.`);
    } else {
      player.connected = false;
      player.left = true;
      player.socketId = null;
      log(room, `${player.name} hat das Spiel verlassen.`);
      if (room.phase === 'playing' && room.g && !room.g.bankrupt[player.id]) {
        // Wer geht, gibt auf (Besitz geht an die Bank). Läuft gerade eine Auktion,
        // spielt bis dahin der Bot für die Person weiter.
        engine.act(room, player.id, { type: 'resign' });
      }
      ensureHost(room);
    }

    socket.leave(room.code);
    socket.data.roomCode = null;
    socket.data.playerId = null;
    touchRoom(room);
    const humansLeft = room.players.some((p) => !p.isBot && !p.left);
    if (room.players.length === 0 || !humansLeft) {
      destroyRoom(room);
    } else {
      broadcastState(room);
    }
  });

  socket.on('kickPlayer', ({ playerId }) => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    if (playerId === room.hostId) return;
    room.players = room.players.filter((p) => p.id !== playerId);
    touchRoom(room);
    broadcastState(room);
  });

  socket.on('addBot', () => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    addBot(room);
    touchRoom(room);
    broadcastState(room);
  });

  socket.on('removeBot', ({ botId }) => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    const bot = findPlayer(room, botId);
    if (!bot || !bot.isBot) return;
    room.players = room.players.filter((p) => p.id !== botId);
    touchRoom(room);
    broadcastState(room);
  });

  socket.on('fillBots', () => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    while (room.players.length < MIN_PLAYERS) addBot(room);
    touchRoom(room);
    broadcastState(room);
  });

  socket.on('setSettings', (settings) => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    const s = settings || {};
    room.settings.startMoney = clampInt(s.startMoney, 200, 100000, room.settings.startMoney);
    if (s.turnTimer !== undefined) room.settings.turnTimer = [0, 30, 45, 60, 90, 120].includes(Number(s.turnTimer)) ? Number(s.turnTimer) : 0;
    if (s.limit !== undefined) room.settings.limit = /^(none|m(30|45|60|90|120)|r(15|20|30|40|60))$/.test(String(s.limit)) ? String(s.limit) : 'none';
    if (s.speed !== undefined) room.settings.speed = s.speed === 'fast' ? 'fast' : 'normal';
    if (s.rules && typeof s.rules === 'object') {
      Object.keys(engine.RULE_DEFAULTS).forEach((k) => {
        if (typeof s.rules[k] === 'boolean') room.settings.rules[k] = s.rules[k];
      });
    }
    broadcastState(room);
  });

  socket.on('startGame', () => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    if (room.players.length < MIN_PLAYERS || room.players.length > MAX_PLAYERS) return;
    room.phase = 'playing';
    room.animSeen = undefined; room.animUntil = 0; room.timerSig = null; room.timerInfo = null; if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
    room.logs = [];
    engine.initGame(room);
    touchRoom(room);
    broadcastState(room);
  });

  // Alle Spielaktionen (würfeln, kaufen, bieten, bauen, handeln, ...) laufen über ein Event.
  socket.on('act', (action, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    const room = roomOf(socket);
    if (!room || room.phase !== 'playing') return reply({ ok: false, error: 'Es läuft gerade kein Spiel.' });
    if (isRateLimited(`act:${socket.id}`, 60, 10 * 1000)) return reply({ ok: false, error: 'Bitte langsamer.' });
    if (room.animUntil && Date.now() < room.animUntil && (action || {}).type !== 'resign') {
      return reply({ ok: false, error: 'Einen Moment – die Figur ist noch unterwegs.' });
    }
    let res;
    try {
      res = engine.act(room, socket.data.playerId, action || {});
    } catch (err) {
      console.error('Aktionsfehler:', err);
      res = { ok: false, error: 'Interner Fehler.' };
    }
    touchRoom(room);
    if (res.ok) broadcastState(room);
    reply(res);
  });

  socket.on('resetGame', () => {
    const room = roomOf(socket);
    if (!room) return;
    if (socket.data.playerId !== room.hostId) return;
    if (room.botTimer) { clearTimeout(room.botTimer); room.botTimer = null; }
    room.phase = 'lobby';
    room.g = null;
    room.animSeen = undefined; room.animUntil = 0; room.timerSig = null; room.timerInfo = null; if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
    room.logs = [];
    // Wer die Partie verlassen hat, verschwindet aus der Lobby.
    room.players = room.players.filter((p) => !p.left);
    room.players.forEach((p) => { if (!p.isBot && !p.connected) p.connected = false; });
    log(room, 'Zurück zur Lobby. Bereit für eine neue Partie.');
    touchRoom(room);
    broadcastState(room);
  });

  socket.on('skipTurn', () => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'playing') return;
    const info = waitInfo(room);
    if (!info || info.elapsedMs < SKIP_MIN_WAIT_MS) return;
    const isHost = socket.data.playerId === room.hostId;
    if (!isHost && !info.ids.includes(room.hostId)) return;
    if (info.ids.includes(socket.data.playerId)) return;
    const actor = engine.pendingActors(room).find((a) => info.ids.includes(a.id) && a.kind !== 'trade');
    if (!actor) return;
    log(room, `${engine.nameOf(room, actor.id)} wurde übersprungen.`);
    try { botAct(room, actor); } catch (err) { console.error('Skip-Fehler:', err); }
    touchRoom(room);
    broadcastState(room);
  });

  socket.on('disconnect', () => {
    const room = roomOf(socket);
    if (!room) return;
    const player = findPlayer(room, socket.data.playerId);
    if (!player) return;
    // Bei einem Reconnect übernimmt ein neuer Socket bereits player.socketId,
    // bevor das 'disconnect'-Event des alten Sockets eintrifft (Reihenfolge nicht
    // garantiert). Ohne diese Prüfung würde das verspätete Event die Person
    // fälschlich als getrennt markieren, obwohl sie längst wieder verbunden ist.
    if (player.socketId !== socket.id) return;
    player.connected = false;
    log(room, `${player.name} hat die Verbindung verloren.`);
    if (room.hostId === player.id) scheduleHostHandover(room);
    touchRoom(room);
    broadcastState(room);
  });
});

server.listen(PORT, () => {
  console.log(`Monopoly (Entenhausen) läuft auf Port ${PORT}`);
  console.log(`Lokal öffnen unter: http://localhost:${PORT}`);
});

module.exports = { TOKENS };
