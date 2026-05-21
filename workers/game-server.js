// =======================================================================
// GERM.FUN — Multiplayer Game Server
// Cloudflare Durable Objects + WebSocket Hibernation API
// Free tier: 100k requests/day, 13,000 GB-s compute/day
// Room codes: 6-char [A-Z2-9] (excludes 0,O,1,I to avoid confusion)
// Max 8 players per room, auto-expire after 10 min inactivity
// =======================================================================

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 8;
const INACTIVITY_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MSG_PER_SEC = 60;

// Allowed origins for CORS
const ALLOWED_ORIGINS = new Set([
  'https://germ.fun',
  'https://www.germ.fun',
  'https://germ-fun.kennardxia.workers.dev',
]);

// Per-game position/velocity clamp limits (anti-cheat)
const GAME_LIMITS = {
  'skywar2d':     { maxX: 3000, maxY: 2000, maxVel: 15 },
  'skywar3d':     { maxX: 2000, maxY: 2000, maxVel: 20 },
  'neonracer':    { maxX: 3000, maxY: 3000, maxVel: 10 },
  'bulletstorm':  { maxX: 2000, maxY: 2000, maxVel: 8  },
  'gravswitch':   { maxX: 2000, maxY: 1000, maxVel: 12 },
  'asteroidbelt': { maxX: 4000, maxY: 4000, maxVel: 12 },
  'driftking':    { maxX: 3000, maxY: 3000, maxVel: 15 },
  'laserbounce':  { maxX: 2000, maxY: 2000, maxVel: 5  },
  'mecharena':    { maxX: 3000, maxY: 3000, maxVel: 10 },
  'pixelduel':    { maxX: 1000, maxY: 800,  maxVel: 12 },
  'spaceminer':   { maxX: 5000, maxY: 5000, maxVel: 12 },
  'voidrunner':   { maxX: 5000, maxY: 1000, maxVel: 15 },
  'default':      { maxX: 5000, maxY: 5000, maxVel: 25 },
};

// Allowed message keys per game type (input messages)
const ALLOWED_KEYS = {
  'skywar2d':     new Set(['type','vx','vy','x','y','hp','firing','weapon','planeType','alive']),
  'skywar3d':     new Set(['type','x','y','z','vx','vy','vz','pitch','yaw','hp','firing','weapon']),
  'neonracer':    new Set(['type','x','y','angle','speed','steer','nitro','lap','nextWP']),
  'bulletstorm':  new Set(['type','x','y','vx','vy','hp','weapon','score']),
  'gravswitch':   new Set(['type','y','vy','score','gravDir','alive']),
  'asteroidbelt': new Set(['type','x','y','vx','vy','angle','hp','score','alive']),
  'driftking':    new Set(['type','x','y','angle','speed','drift','score','lap']),
  'laserbounce':  new Set(['type','x','y','aimX','aimY','score','level']),
  'mecharena':    new Set(['type','x','y','angle','hp','weapon','score','alive']),
  'pixelduel':    new Set(['type','x','y','vy','facing','hp','action','wins']),
  'spaceminer':   new Set(['type','x','y','vx','vy','angle','hp','ore','score']),
  'voidrunner':   new Set(['type','y','vy','score','sliding','alive']),
};

function generateRoomCode() {
  let code = '';
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  for (let i = 0; i < 6; i++) {
    code += ROOM_CODE_CHARS[arr[i] % ROOM_CODE_CHARS.length];
  }
  return code;
}

function sanitizeMessage(data, gameType) {
  // Only allow known keys to prevent prototype pollution / injection
  const allowed = ALLOWED_KEYS[gameType] || ALLOWED_KEYS['skywar2d'];
  const limits = GAME_LIMITS[gameType] || GAME_LIMITS['default'];
  const out = {};

  for (const key of allowed) {
    if (!(key in data)) continue;
    const val = data[key];
    if (key === 'type') {
      // type must be a short string
      if (typeof val === 'string' && val.length <= 20) out.type = val;
      continue;
    }
    if (typeof val === 'number' && isFinite(val)) {
      // Clamp position/velocity values
      if (key === 'x' || key === 'y' || key === 'z') {
        out[key] = Math.max(-limits.maxX, Math.min(limits.maxX, val));
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

// ===== DURABLE OBJECT =====
export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.gameType = null;
    this.playerCount = 0;
    // Rate limit tracking: playerId -> {count, resetAt}
    this.rateLimits = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname.endsWith('/ping')) {
      return new Response('pong', { status: 200 });
    }

    // WebSocket upgrade
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    // Check room capacity
    const sessions = this.state.getWebSockets();
    if (sessions.length >= MAX_PLAYERS) {
      return new Response('Room full', { status: 503 });
    }

    const gameType = url.searchParams.get('game') || 'default';
    if (!this.gameType) this.gameType = gameType;

    // Create WebSocket pair
    const { 0: client, 1: server } = new WebSocketPair();

    // Accept and hibernate (no duration charges while idle)
    this.state.acceptWebSocket(server);

    // Attach player metadata
    const playerId = crypto.randomUUID().slice(0, 8);
    server.serializeAttachment({ playerId, gameType, joinedAt: Date.now() });

    this.playerCount++;

    // Reset inactivity alarm
    await this.state.storage.setAlarm(Date.now() + INACTIVITY_MS);

    // Notify existing players of new joiner
    this._broadcast({ type: 'join', id: playerId, count: sessions.length + 1 }, server);

    // Send welcome to new player with their ID and current count
    server.send(JSON.stringify({ type: 'welcome', id: playerId, count: sessions.length + 1 }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, rawMessage) {
    const meta = ws.deserializeAttachment();
    if (!meta) { ws.close(1008, 'No session'); return; }

    const { playerId, gameType } = meta;

    // Rate limiting
    const now = Date.now();
    let rl = this.rateLimits.get(playerId);
    if (!rl || now > rl.resetAt) {
      rl = { count: 0, resetAt: now + 1000 };
      this.rateLimits.set(playerId, rl);
    }
    rl.count++;
    if (rl.count > RATE_LIMIT_MSG_PER_SEC) return; // silently drop

    // Parse JSON safely
    let data;
    try { data = JSON.parse(rawMessage); }
    catch { return; } // ignore malformed

    if (typeof data !== 'object' || data === null) return;

    // Sanitize
    const safe = sanitizeMessage(data, gameType);
    if (Object.keys(safe).length === 0) return;

    // Add sender ID and broadcast to all other peers
    safe.from = playerId;
    const payload = JSON.stringify(safe);

    const sessions = this.state.getWebSockets();
    for (const peer of sessions) {
      if (peer === ws) continue;
      try { peer.send(payload); } catch { /* peer disconnected */ }
    }

    // Reset inactivity alarm on activity
    await this.state.storage.setAlarm(Date.now() + INACTIVITY_MS);
  }

  async webSocketClose(ws, code, reason) {
    const meta = ws.deserializeAttachment();
    if (!meta) return;
    const { playerId } = meta;
    this.playerCount = Math.max(0, this.playerCount - 1);
    this.rateLimits.delete(playerId);

    // Notify remaining players
    this._broadcast({ type: 'leave', id: playerId, count: this.state.getWebSockets().length - 1 }, ws);
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws, 1006, 'error');
  }

  async alarm() {
    // Room expired from inactivity — close all connections
    const sessions = this.state.getWebSockets();
    for (const ws of sessions) {
      try { ws.close(1001, 'Room expired'); } catch { /* already closed */ }
    }
  }

  _broadcast(data, exclude) {
    const payload = JSON.stringify(data);
    const sessions = this.state.getWebSockets();
    for (const ws of sessions) {
      if (ws === exclude) continue;
      try { ws.send(payload); } catch { /* disconnected */ }
    }
  }
}

// ===== WORKER ENTRYPOINT =====
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers — allow both production domain and workers.dev subdomain
    const origin = request.headers.get('Origin') || '';
    const corsOrigin = ALLOWED_ORIGINS.has(origin) ? origin : 'https://germ.fun';
    const corsHeaders = {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // POST /room/create?game=skywar2d — create a new room
    if (request.method === 'POST' && path === '/room/create') {
      const gameType = url.searchParams.get('game') || 'skywar2d';
      // Validate game type
      const validGames = new Set([...Object.keys(GAME_LIMITS), 'default']);
      if (!validGames.has(gameType)) {
        return new Response('Invalid game type', { status: 400, headers: corsHeaders });
      }

      const code = generateRoomCode();
      // Use room code as DO name so same code always routes to same DO
      const id = env.GAME_ROOM.idFromName(code);
      const stub = env.GAME_ROOM.get(id);

      // Ping to initialize
      await stub.fetch(new Request(`https://internal/ping`));

      return new Response(JSON.stringify({ code, gameType }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // GET /room/:code/ws?game=skywar2d — WebSocket join
    const wsMatch = path.match(/^\/room\/([A-Z2-9]{6})\/ws$/);
    if (wsMatch) {
      const code = wsMatch[1];
      const gameType = url.searchParams.get('game') || 'skywar2d';

      if (!env.GAME_ROOM) {
        return new Response('GAME_ROOM binding missing', { status: 500 });
      }

      const id = env.GAME_ROOM.idFromName(code);
      const stub = env.GAME_ROOM.get(id);

      // Forward WebSocket upgrade to the Durable Object
      return stub.fetch(new Request(
        `https://internal/ws?game=${encodeURIComponent(gameType)}`,
        { headers: request.headers }
      ));
    }

    // Serve static assets (handled by Cloudflare Pages assets binding)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  }
};
