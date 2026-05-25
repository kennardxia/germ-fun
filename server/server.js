// =============================================================================
// GERM.FUN — Node.js Multiplayer Server
// WebSocket room-based relay server (same protocol as Cloudflare DO version)
// Usage: node server.js  (default port 8787, set PORT env to override)
// Rooms: 6-char code, max 8 players, auto-cleanup after 10 min inactivity
// =============================================================================

'use strict';

const http   = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT            = process.env.PORT || 8787;
const MAX_PLAYERS     = 8;
const INACTIVITY_MS   = 10 * 60 * 1000;   // 10 min
const RATE_LIMIT_PER_SEC = 60;
const MAX_MSG_BYTES   = 2048;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Per-game clamp limits (anti-cheat / sanity)
const GAME_LIMITS = {
  skywar2d:     { maxXY: 3000, maxVel: 15 },
  skywar3d:     { maxXY: 2000, maxVel: 20 },
  neonracer:    { maxXY: 3000, maxVel: 10 },
  bulletstorm:  { maxXY: 2000, maxVel: 8  },
  gravswitch:   { maxXY: 2000, maxVel: 12 },
  asteroidbelt: { maxXY: 4000, maxVel: 12 },
  driftking:    { maxXY: 3000, maxVel: 15 },
  laserbounce:  { maxXY: 2000, maxVel: 5  },
  mecharena:    { maxXY: 3000, maxVel: 10 },
  pixelduel:    { maxXY: 1000, maxVel: 12 },
  spaceminer:   { maxXY: 5000, maxVel: 12 },
  voidrunner:   { maxXY: 5000, maxVel: 15 },
  default:      { maxXY: 5000, maxVel: 25 },
};

// Allowed message keys per game (prevents prototype pollution)
const ALLOWED_KEYS = {
  skywar2d:     new Set(['type','vx','vy','x','y','hp','firing','weapon','planeType','alive']),
  skywar3d:     new Set(['type','x','y','z','vx','vy','vz','pitch','yaw','hp','firing','weapon','alive']),
  neonracer:    new Set(['type','x','y','angle','speed','steer','nitro','lap','pos','nextWP']),
  bulletstorm:  new Set(['type','x','y','z','vx','vy','hp','weapon','score','alive']),
  gravswitch:   new Set(['type','y','vy','score','gravDir','alive']),
  asteroidbelt: new Set(['type','x','y','z','vx','vy','angle','hp','score','alive']),
  driftking:    new Set(['type','x','y','z','angle','speed','drift','score','lap','pos']),
  laserbounce:  new Set(['type','x','y','z','aimX','aimY','score','level']),
  mecharena:    new Set(['type','x','y','z','angle','hp','weapon','score','alive']),
  pixelduel:    new Set(['type','x','y','vy','facing','hp','action','wins']),
  spaceminer:   new Set(['type','x','y','vx','vy','angle','hp','ore','score','credits','alive']),
  voidrunner:   new Set(['type','y','vy','lane','score','sliding','alive']),
};

// ─── Room store ───────────────────────────────────────────────────────────────
// Map<code, { gameType, players: Map<playerId, {ws, rateLimit}>, timer }>
const rooms = new Map();

function generateCode() {
  const buf = crypto.randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i++) code += ROOM_CODE_CHARS[buf[i] % ROOM_CODE_CHARS.length];
  return code;
}

function sanitizeState(data, gameType) {
  const allowed = ALLOWED_KEYS[gameType] || ALLOWED_KEYS.bulletstorm;
  const limits  = GAME_LIMITS[gameType]  || GAME_LIMITS.default;
  const out = {};
  for (const key of allowed) {
    if (!(key in data)) continue;
    const val = data[key];
    if (key === 'type') {
      if (typeof val === 'string' && val.length <= 20) out.type = val;
    } else if (typeof val === 'number' && isFinite(val)) {
      if (key === 'x' || key === 'y' || key === 'z') {
        out[key] = Math.max(-limits.maxXY, Math.min(limits.maxXY, val));
      } else if (key.startsWith('v')) {
        out[key] = Math.max(-limits.maxVel, Math.min(limits.maxVel, val));
      } else {
        out[key] = val;
      }
    } else if (typeof val === 'boolean') {
      out[key] = val;
    } else if (typeof val === 'string' && val.length <= 32) {
      out[key] = val;
    }
  }
  return out;
}

function broadcastRoom(room, payload, excludeWs) {
  for (const { ws } of room.players.values()) {
    if (ws === excludeWs) continue;
    if (ws.readyState === ws.OPEN) {
      try { ws.send(payload); } catch (_) { /* disconnected */ }
    }
  }
}

function scheduleRoomCleanup(code) {
  const room = rooms.get(code);
  if (!room) return;
  clearTimeout(room.timer);
  room.timer = setTimeout(() => {
    const r = rooms.get(code);
    if (!r) return;
    for (const { ws } of r.players.values()) {
      try { ws.close(1001, 'Room expired'); } catch (_) {}
    }
    rooms.delete(code);
    console.log(`[room] ${code} expired (inactivity)`);
  }, INACTIVITY_MS);
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost`);

  // Health check
  if (url.pathname === '/ping') {
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'text/plain' });
    res.end('pong');
    return;
  }

  // POST /room/create?game=asteroidbelt
  if (req.method === 'POST' && url.pathname === '/room/create') {
    const rawGame  = url.searchParams.get('game') || 'default';
    const gameType = ALLOWED_KEYS[rawGame] ? rawGame : 'default';
    let code;
    // Avoid code collision (extremely unlikely but defensive)
    do { code = generateCode(); } while (rooms.has(code));
    rooms.set(code, { gameType, players: new Map(), timer: null });
    scheduleRoomCleanup(code);
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code, gameType }));
    console.log(`[room] created ${code} (${gameType})`);
    return;
  }

  res.writeHead(404, corsHeaders);
  res.end('Not found');
});

// ─── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url   = new URL(request.url, `http://localhost`);
  const match = url.pathname.match(/^\/room\/([A-Z2-9]{6})\/ws$/);
  if (!match) { socket.destroy(); return; }

  const code     = match[1];
  const rawGame  = url.searchParams.get('game') || 'default';
  const gameType = ALLOWED_KEYS[rawGame] ? rawGame : 'default';

  // Auto-create room if it doesn't exist (player joined via code share)
  if (!rooms.has(code)) {
    rooms.set(code, { gameType, players: new Map(), timer: null });
  }
  const room = rooms.get(code);

  if (room.players.size >= MAX_PLAYERS) {
    socket.write('HTTP/1.1 503 Room Full\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    const playerId = crypto.randomBytes(4).toString('hex');
    const rateLimit = { count: 0, resetAt: Date.now() + 1000 };
    room.players.set(playerId, { ws, rateLimit });
    scheduleRoomCleanup(code);

    console.log(`[join] ${playerId} → room ${code} (${room.players.size} players)`);

    // Notify existing players
    broadcastRoom(
      room,
      JSON.stringify({ type: 'join', id: playerId, count: room.players.size }),
      ws
    );

    // Welcome the new player
    ws.send(JSON.stringify({ type: 'welcome', id: playerId, count: room.players.size }));

    // ── Message handler ──
    ws.on('message', (rawMsg) => {
      // Size guard
      if (Buffer.byteLength(rawMsg) > MAX_MSG_BYTES) return;

      // Rate limit
      const player = room.players.get(playerId);
      if (!player) return;
      const now = Date.now();
      if (now > player.rateLimit.resetAt) {
        player.rateLimit = { count: 0, resetAt: now + 1000 };
      }
      player.rateLimit.count++;
      if (player.rateLimit.count > RATE_LIMIT_PER_SEC) return;

      // Parse
      let data;
      try { data = JSON.parse(rawMsg); } catch { return; }
      if (!data || typeof data !== 'object') return;
      if (data.type !== 'state') return; // only relay state msgs

      const safe = sanitizeState(data, gameType);
      if (Object.keys(safe).length === 0) return;

      safe.from = playerId;
      const payload = JSON.stringify(safe);
      broadcastRoom(room, payload, ws);

      // Reset inactivity timer
      scheduleRoomCleanup(code);
    });

    // ── Close / Error ──
    ws.on('close', () => {
      room.players.delete(playerId);
      console.log(`[leave] ${playerId} ← room ${code} (${room.players.size} remaining)`);
      broadcastRoom(
        room,
        JSON.stringify({ type: 'leave', id: playerId, count: room.players.size })
      );
      if (room.players.size === 0) {
        // Keep room alive briefly so the last player can rejoin
        scheduleRoomCleanup(code);
      }
    });

    ws.on('error', (err) => {
      console.error(`[ws error] ${playerId}:`, err.message);
      ws.close();
    });
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`✓ germ.fun multiplayer server running on port ${PORT}`);
  console.log(`  REST : http://localhost:${PORT}/room/create?game=asteroidbelt`);
  console.log(`  WS   : ws://localhost:${PORT}/room/<CODE>/ws?game=asteroidbelt`);
});

process.on('SIGTERM', () => {
  console.log('Shutting down…');
  server.close(() => process.exit(0));
});
