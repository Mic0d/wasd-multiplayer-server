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

const WORLD_WIDTH = 800;
const WORLD_HEIGHT = 600;
const PLAYER_RADIUS = 16;

const COLORS = ["#ff595e", "#ffca3a", "#8ac926", "#1982c4", "#6a4c93", "#ff924c"];
let colorIndex = 0;

// All connected players, keyed by socket id
const players = {};

app.get("/", (req, res) => {
  res.send(`WASD multiplayer server is running. ${Object.keys(players).length} player(s) online.`);
});

io.on("connection", (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // Spawn the new player at a random position
  players[socket.id] = {
    x: Math.floor(Math.random() * (WORLD_WIDTH - 100)) + 50,
    y: Math.floor(Math.random() * (WORLD_HEIGHT - 100)) + 50,
    color: COLORS[colorIndex % COLORS.length],
  };
  colorIndex++;

  // Tell the new player who they are and who else is already online
  socket.emit("init", {
    id: socket.id,
    players,
    world: { width: WORLD_WIDTH, height: WORLD_HEIGHT, radius: PLAYER_RADIUS },
  });

  // Tell everyone else a new player joined
  socket.broadcast.emit("playerJoined", {
    id: socket.id,
    player: players[socket.id],
  });

  // A player moved — clamp to world bounds, then relay to everyone else
  socket.on("move", (pos) => {
    const player = players[socket.id];
    if (!player) return;

    player.x = Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH - PLAYER_RADIUS, pos.x));
    player.y = Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, pos.y));

    socket.broadcast.emit("playerMoved", {
      id: socket.id,
      x: player.x,
      y: player.y,
    });
  });

  socket.on("disconnect", () => {
    console.log(`Player disconnected: ${socket.id}`);
    delete players[socket.id];
    io.emit("playerLeft", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
