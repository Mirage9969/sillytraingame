const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ── Game constants (must match client) ───────────────────────────────────────
const TICK_MS = 33; // ~30 fps
const WIN_SCORE = 5;
const SWITCH_COOL = 1200;
const STAR_RESPAWN_MS = 1800;
const HOOPS = [
  { x: 170, y: 210, r: 120 },
  { x: 340, y: 210, r: 120 },
  { x: 510, y: 210, r: 120 },
];

const rooms = new Map();

// ── Room helpers ─────────────────────────────────────────────────────────────
function makeRoomId() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function makeRoom(p1Id) {
  return {
    id: makeRoomId(),
    sockets: [p1Id, null],
    state: makeInitState(),
    gameInterval: null,
    countdownTimer: null,
  };
}

function makeInitState() {
  return {
    players: [
      { hoop: 0, angle: Math.PI * 0.5,  speed: 0.018, dir:  1, score: 0, lapCount: 0, lastAngle: Math.PI * 0.5,  switchCooldown: 0 },
      { hoop: 2, angle: Math.PI * 1.5,  speed: 0.022, dir: -1, score: 0, lapCount: 0, lastAngle: Math.PI * 1.5,  switchCooldown: 0 },
    ],
    stars: generateStars(),
    gameActive: false,
    winner: null,
    countdown: null,
  };
}

function generateStars() {
  const stars = [];
  for (let h = 0; h < 3; h++) {
    stars.push(
      { hoop: h, angle: Math.random() * Math.PI * 2,              collected: false },
      { hoop: h, angle: Math.random() * Math.PI * 2 + Math.PI,    collected: false }
    );
  }
  return stars;
}

// ── Game logic ────────────────────────────────────────────────────────────────
function hPos(hoop, angle) {
  const h = HOOPS[hoop];
  return { x: h.x + Math.cos(angle) * h.r, y: h.y + Math.sin(angle) * h.r };
}

function doSwitch(state, idx) {
  const p = state.players[idx];
  if (p.switchCooldown > 0) return;

  const pos = hPos(p.hoop, p.angle);
  let best = null, bestDiff = Infinity;

  HOOPS.forEach((h, i) => {
    if (i === p.hoop) return;
    const dx = pos.x - h.x, dy = pos.y - h.y;
    const diff = Math.abs(Math.sqrt(dx * dx + dy * dy) - h.r);
    if (diff < 28 && diff < bestDiff) { bestDiff = diff; best = i; }
  });

  if (best !== null) {
    const h = HOOPS[best];
    p.angle = Math.atan2(pos.y - h.y, pos.x - h.x);
    p.hoop = best;
    p.switchCooldown = SWITCH_COOL;
  }
}

function tickGame(room, dt) {
  const { state } = room;
  if (!state.gameActive) return;

  state.players.forEach((p, i) => {
    p.angle += p.speed * p.dir;
    if (p.switchCooldown > 0) p.switchCooldown = Math.max(0, p.switchCooldown - dt);

    // Lap detection
    const a  = ((p.angle     % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const la = ((p.lastAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    if (p.dir > 0 ? (la > 5.5 && a < 0.8) : (la < 0.8 && a > 5.5)) p.lapCount++;
    p.lastAngle = p.angle;

    // Star collection
    const pos = hPos(p.hoop, p.angle);
    for (const s of state.stars) {
      if (s.collected || s.hoop !== p.hoop) continue;
      const sp = hPos(s.hoop, s.angle);
      const dx = pos.x - sp.x, dy = pos.y - sp.y;
      if (dx * dx + dy * dy < 324) { // 18px radius
        s.collected = true;
        p.score++;
        if (p.score >= WIN_SCORE) { state.gameActive = false; state.winner = i; }
        setTimeout(() => {
          s.hoop = Math.floor(Math.random() * 3);
          s.angle = Math.random() * Math.PI * 2;
          s.collected = false;
        }, STAR_RESPAWN_MS);
      }
    }
  });
}

// ── Room lifecycle ────────────────────────────────────────────────────────────
function stopRoom(room) {
  if (room.gameInterval)  { clearInterval(room.gameInterval);  room.gameInterval  = null; }
  if (room.countdownTimer){ clearInterval(room.countdownTimer); room.countdownTimer = null; }
}

function beginCountdown(room) {
  stopRoom(room);
  room.state.countdown = 3;
  io.to(room.id).emit('state', room.state);

  let n = 3;
  room.countdownTimer = setInterval(() => {
    n--;
    if (n <= 0) {
      clearInterval(room.countdownTimer);
      room.countdownTimer = null;
      room.state.countdown = 0; // triggers "GO!" on client
      io.to(room.id).emit('state', room.state);
      setTimeout(() => {
        room.state.countdown = null;
        room.state.gameActive = true;
        io.to(room.id).emit('state', room.state);
        beginGameLoop(room);
      }, 600);
    } else {
      room.state.countdown = n;
      io.to(room.id).emit('state', room.state);
    }
  }, 1000);
}

function beginGameLoop(room) {
  let last = Date.now();
  room.gameInterval = setInterval(() => {
    const now = Date.now();
    tickGame(room, now - last);
    last = now;
    io.to(room.id).emit('state', room.state);
    if (!room.state.gameActive) {
      clearInterval(room.gameInterval);
      room.gameInterval = null;
    }
  }, TICK_MS);
}

// ── Socket handlers ───────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let myRoom = null;
  let myIdx  = null;

  socket.on('create_room', (cb) => {
    if (typeof cb !== 'function') return;
    const room = makeRoom(socket.id);
    rooms.set(room.id, room);
    myRoom = room;
    myIdx  = 0;
    socket.join(room.id);
    cb({ roomId: room.id, playerIndex: 0 });
  });

  socket.on('join_room', ({ roomId }, cb) => {
    if (typeof cb !== 'function') return;
    const room = rooms.get((roomId || '').trim().toUpperCase());
    if (!room)            { cb({ error: 'Room not found' }); return; }
    if (room.sockets[1])  { cb({ error: 'Room is full'   }); return; }

    room.sockets[1] = socket.id;
    myRoom = room;
    myIdx  = 1;
    socket.join(room.id);
    cb({ roomId: room.id, playerIndex: 1 });

    // Notify P1 and send both players the current (pre-game) state
    const p1 = io.sockets.sockets.get(room.sockets[0]);
    if (p1) {
      p1.emit('peer_joined');
      p1.emit('state', room.state);
    }
    socket.emit('state', room.state);

    setTimeout(() => beginCountdown(room), 400);
  });

  socket.on('switch', () => {
    if (myRoom && myIdx !== null && myRoom.state.gameActive) doSwitch(myRoom.state, myIdx);
  });

  socket.on('restart', () => {
    if (!myRoom || myIdx !== 0) return;
    if (myRoom.state.winner === null) return;
    myRoom.state = makeInitState();
    io.to(myRoom.id).emit('state', myRoom.state);
    setTimeout(() => beginCountdown(myRoom), 400);
  });

  socket.on('disconnect', () => {
    if (!myRoom) return;
    stopRoom(myRoom);
    io.to(myRoom.id).emit('peer_left', { playerIndex: myIdx });
    rooms.delete(myRoom.id);
    myRoom = null;
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Hoop Train Game listening on port ${PORT}`));
