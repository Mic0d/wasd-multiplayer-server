const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// ⚠️ In production, replace "*" with your actual GitHub Pages URL,
// e.g. "https://yourusername.github.io"
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// ------------------------------------------------------------------
// TUNING CONSTANTS — tweak these to change how the game feels
// ------------------------------------------------------------------
const WORLD_WIDTH = 2400;
const WORLD_HEIGHT = 1800;
const TICK_MS = 50; // 20 ticks/sec
const SPEED = 3.2; // px moved forward per tick
const TURN_RATE = 0.15; // max radians a snake can turn per tick

const BASE_RADIUS = 9;
const MAX_RADIUS = 40;
const RADIUS_PER_SCORE = 0.05;

const BASE_SEGMENTS = 20;
const MAX_SEGMENTS = 150;
const SEGMENTS_PER_SCORE = 0.4;

const FOOD_COUNT = 180; // ambient food kept on the map at all times
const FOOD_VALUE = 5;
const FOOD_RADIUS = 4;

const DEATH_FOOD_STEP = 4; // drop food every Nth body segment on death
const DEATH_FOOD_VALUE = 10;
const DEATH_FOOD_RADIUS = 7;

const COLORS = ["#ff595e", "#ffca3a", "#8ac926", "#1982c4", "#6a4c93", "#ff924c", "#52d1dc"];
let colorIndex = 0;
let foodIdCounter = 0;

const players = {}; // socket.id -> snake state (alive players only)
let food = [];

// ------------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------------
function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function nextColor() {
  const c = COLORS[colorIndex % COLORS.length];
  colorIndex++;
  return c;
}

function radiusFor(score) {
  return Math.min(MAX_RADIUS, BASE_RADIUS + score * RADIUS_PER_SCORE);
}

function segmentsFor(score) {
  return Math.min(MAX_SEGMENTS, Math.round(BASE_SEGMENTS + score * SEGMENTS_PER_SCORE));
}

function spawnFood() {
  return {
    id: `f${foodIdCounter++}`,
    x: rand(40, WORLD_WIDTH - 40),
    y: rand(40, WORLD_HEIGHT - 40),
    value: FOOD_VALUE,
    radius: FOOD_RADIUS,
    color: "#f4f1de",
  };
}

function ensureFoodStocked() {
  while (food.length < FOOD_COUNT) {
    food.push(spawnFood());
  }
}

function spawnPlayer(id) {
  const x = rand(200, WORLD_WIDTH - 200);
  const y = rand(200, WORLD_HEIGHT - 200);
  const angle = rand(0, Math.PI * 2);
  return {
    id,
    color: nextColor(),
    alive: true,
    score: 0,
    x,
    y,
    angle,
    targetAngle: angle,
    trail: Array.from({ length: BASE_SEGMENTS }, () => ({ x, y })),
  };
}

function killPlayer(player) {
  // Drop some of the snake's body as food for others to eat
  for (let i = 0; i < player.trail.length; i += DEATH_FOOD_STEP) {
    const p = player.trail[i];
    food.push({
      id: `f${foodIdCounter++}`,
      x: p.x,
      y: p.y,
      value: DEATH_FOOD_VALUE,
      radius: DEATH_FOOD_RADIUS,
      color: player.color,
    });
  }

  player.alive = false;
  io.to(player.id).emit("youDied", { score: Math.round(player.score) });
  delete players[player.id];
}

// ------------------------------------------------------------------
// SOCKET EVENTS
// ------------------------------------------------------------------
app.get("/", (req, res) => {
  res.send(`Snake server running. ${Object.keys(players).length} player(s) online.`);
});

io.on("connection", (socket) => {
  players[socket.id] = spawnPlayer(socket.id);

  socket.emit("init", {
    id: socket.id,
    world: { width: WORLD_WIDTH, height: WORLD_HEIGHT },
  });

  socket.on("steer", (angle) => {
    const player = players[socket.id];
    if (player && player.alive && typeof angle === "number") {
      player.targetAngle = angle;
    }
  });

  socket.on("respawn", () => {
    if (!players[socket.id]) {
      players[socket.id] = spawnPlayer(socket.id);
    }
  });

  socket.on("disconnect", () => {
    delete players[socket.id];
  });
});

// ------------------------------------------------------------------
// GAME LOOP
// ------------------------------------------------------------------
function tick() {
  ensureFoodStocked();

  const ids = Object.keys(players);

  // 1. Move every alive snake
  for (const id of ids) {
    const player = players[id];
    if (!player.alive) continue;

    // Turn toward targetAngle at a limited rate
    let diff = player.targetAngle - player.angle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    diff = Math.max(-TURN_RATE, Math.min(TURN_RATE, diff));
    player.angle += diff;

    const newX = player.x + Math.cos(player.angle) * SPEED;
    const newY = player.y + Math.sin(player.angle) * SPEED;

    // Walls are deadly, like classic Snake
    if (newX < 0 || newX > WORLD_WIDTH || newY < 0 || newY > WORLD_HEIGHT) {
      killPlayer(player);
      continue;
    }

    player.x = newX;
    player.y = newY;
    player.trail.unshift({ x: newX, y: newY });
    const desired = segmentsFor(player.score);
    if (player.trail.length > desired) {
      player.trail.length = desired;
    }
  }

  // 2. Food consumption
  for (const id of ids) {
    const player = players[id];
    if (!player.alive) continue;
    const r = radiusFor(player.score);

    for (let i = food.length - 1; i >= 0; i--) {
      const f = food[i];
      const dx = player.x - f.x;
      const dy = player.y - f.y;
      if (Math.sqrt(dx * dx + dy * dy) < r + f.radius) {
        player.score += f.value;
        food.splice(i, 1);
      }
    }
  }

  // 3. Snake-vs-snake collisions (touching another snake's body kills you)
  const toKill = [];
  for (const idA of ids) {
    const a = players[idA];
    if (!a.alive) continue;
    const rA = radiusFor(a.score);

    for (const idB of ids) {
      if (idA === idB) continue;
      const b = players[idB];
      if (!b.alive) continue;
      const rB = radiusFor(b.score);

      for (const seg of b.trail) {
        const dx = a.x - seg.x;
        const dy = a.y - seg.y;
        if (Math.sqrt(dx * dx + dy * dy) < rA * 0.5 + rB) {
          toKill.push(a);
          break;
        }
      }
      if (toKill.includes(a)) break;
    }
  }
  toKill.forEach(killPlayer);

  // 4. Broadcast the world state
  const playerState = {};
  for (const id of Object.keys(players)) {
    const p = players[id];
    playerState[id] = {
      x: p.x,
      y: p.y,
      angle: p.angle,
      color: p.color,
      score: Math.round(p.score),
      radius: radiusFor(p.score),
      trail: p.trail,
    };
  }

  io.emit("state", { players: playerState, food });
}

setInterval(tick, TICK_MS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
