// server/index.js
// Express + Socket.IO + MongoDB server for CineRate

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const { nanoid } = require("nanoid");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));
const path = require("path");

const admin = require("./lib/firebaseAdmin");
const Game = require("./models/Game");
const UserStat = require("./models/UserStat");

const app = express();
app.use(express.json());

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:3000",
    credentials: true,
  })
);

app.use("/music", express.static(path.join(__dirname, "music")));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// --- Metrics: online users & OMDb quota (free tier ~1000/day) ---
const onlineUids = new Set();

let omdbUsage = {
  day: new Date().toISOString().slice(0, 10), // YYYY-MM-DD
  count: 0,
  limit: 1000,
};
function resetOmdbIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (omdbUsage.day !== today) {
    omdbUsage = { day: today, count: 0, limit: omdbUsage.limit };
  }
}
function incOmdbCount(n = 1) {
  resetOmdbIfNeeded();
  omdbUsage.count += n;
  if (omdbUsage.count < 0) omdbUsage.count = 0;
  emitMetrics(); // push to clients
}
function getOmdbRemaining() {
  resetOmdbIfNeeded();
  const remaining = Math.max(0, (omdbUsage.limit || 1000) - (omdbUsage.count || 0));
  return remaining;
}
function emitMetrics() {
  io.emit("metrics:update", {
    onlineUsers: onlineUids.size,
    omdbRemaining: getOmdbRemaining(),
  });
}
function userHasGuessedInGame(game, uid) {
  return (game.rounds || []).some((r) => (r.guesses || []).some((g) => g.uid === uid));
}

/* ---------------- Mongo connect + start server (ONLY listen here) ---------------- */
(async () => {
  try {
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error("Missing MONGO_URI");
    if (!/^mongodb(\+srv)?:\/\//.test(uri)) {
      throw new Error(
        'Invalid scheme: MONGO_URI must start with "mongodb://" or "mongodb+srv://"'
      );
    }

    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
      socketTimeoutMS: 20000,
      family: 4,
    });

    console.log("Mongo connected:", mongoose.connection.host);

    const port = process.env.PORT || 4000;
    server.listen(port, () => {
      console.log(`Server on http://localhost:${port}`);
    });
  } catch (e) {
    console.error("❌ Mongo connect failed:", e.message);
    process.exit(1);
  }
})();

mongoose.connection.on("error", (err) => {
  console.error("Mongo connection error:", err?.message || err);
});
mongoose.connection.on("disconnected", () => {
  console.warn("Mongo disconnected");
});

/* ---------------- REST ---------------- */
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// GET /metrics  -> { onlineUsers, omdbRemaining }
app.get("/metrics", (req, res) => {
  res.json({
    onlineUsers: onlineUids.size,
    omdbRemaining: getOmdbRemaining(),
  });
});

// GET /leaderboard?limit=20
// Returns players sorted by best avg delta (requires at least 10 guesses by default)
app.get("/leaderboard", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
    const minGuesses = Math.max(0, Number(req.query.minGuesses) || 10);

    const rows = await UserStat.find({ totalGuesses: { $gte: minGuesses } })
      .select("uid displayName wins losses gamesPlayed totalGuesses sumDelta")
      .lean();

    const enriched = rows.map((r) => ({
      uid: r.uid,
      displayName: r.displayName,
      wins: r.wins || 0,
      losses: r.losses || 0,
      gamesPlayed: r.gamesPlayed || 0,
      totalGuesses: r.totalGuesses || 0,
      avgDelta: r.totalGuesses > 0 ? Number((r.sumDelta / r.totalGuesses).toFixed(2)) : null,
    }));

    const sorted = enriched
      .filter((r) => r.avgDelta !== null)
      .sort((a, b) => a.avgDelta - b.avgDelta)
      .slice(0, limit);

    res.json(sorted);
  } catch (e) {
    console.error("leaderboard error:", e);
    res.status(500).json({ error: "Leaderboard failed" });
  }
});

// GET /stats/history  (Authorization: Bearer <idToken>)
// Returns all guesses in reverse chronological order
app.get("/stats/history", async (req, res) => {
  try {
    const decoded = await verifyBearer(req);
    const uid = decoded.uid;

    const doc = await UserStat.findOne({ uid }).select("history").lean();
    const list = (doc?.history || [])
      .slice()
      .reverse()
      .map((h) => ({
        roomId: h.roomId,
        omdbId: h.omdbId,
        title: h.title,
        actual: h.actual, // decimal 0..10
        guess: h.guess, // decimal 0..10
        delta: h.delta, // decimal
        when: h.createdAt,
      }));

    res.json({ items: list });
  } catch (e) {
    res.status(401).json({ error: "Unauthorized" });
  }
});

// POST /account/reset  (Authorization: Bearer <idToken>)
app.post("/account/reset", async (req, res) => {
  try {
    const decoded = await verifyBearer(req);
    const uid = decoded.uid;

    await UserStat.findOneAndUpdate(
      { uid },
      {
        $set: {
          wins: 0,
          losses: 0,
          gamesPlayed: 0,
          totalGuesses: 0,
          sumDelta: 0,
          history: [],
        },
      },
      { upsert: true }
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(401).json({ error: "Unauthorized" });
  }
});

// POST /account/delete  (Authorization: Bearer <idToken>)
app.post("/account/delete", async (req, res) => {
  try {
    const decoded = await verifyBearer(req);
    const uid = decoded.uid;

    await UserStat.deleteOne({ uid });
    await admin.auth().deleteUser(uid);

    res.json({ ok: true });
  } catch (e) {
    console.error("account delete error:", e?.message || e);
    res.status(400).json({ error: "Delete failed" });
  }
});

// Verify Bearer token for REST
async function verifyBearer(req) {
  const auth = req.headers.authorization || "";
  const [, token] = auth.split(" ");
  if (!token) throw new Error("Missing token");
  const decoded = await admin.auth().verifyIdToken(token);
  return decoded;
}

// OMDb proxy search (keeps API key off client)
app.get("/omdb/search", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    if (!q) return res.json({ results: [] });

    const url = `https://www.omdbapi.com/?apikey=${process.env.OMDB_API_KEY}&type=movie&s=${encodeURIComponent(
      q
    )}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.Response === "False") return res.json({ results: [] });

    incOmdbCount(1); // count a search call

    const results = (data.Search || []).map((r) => ({
      title: r.Title,
      year: r.Year,
      imdbID: r.imdbID,
      poster: r.Poster,
      type: r.Type,
    }));
    res.json({ results });
  } catch (e) {
    console.error("OMDb search error", e);
    res.status(500).json({ error: "Search failed" });
  }
});

// Stats for the current user (decimal scale)
app.get("/stats/me", async (req, res) => {
  try {
    const decoded = await verifyBearer(req);
    const uid = decoded.uid;

    const doc = await UserStat.findOne({ uid }).lean();
    if (!doc) {
      return res.json({
        uid,
        wins: 0,
        losses: 0,
        gamesPlayed: 0,
        totalGuesses: 0,
        avgDelta: null,
        recent: [],
      });
    }
    const avgDelta =
      doc.totalGuesses > 0 ? Number((doc.sumDelta / doc.totalGuesses).toFixed(2)) : null;

    const recent = (doc.history || [])
      .slice(-10)
      .reverse()
      .map((h) => ({
        title: h.title,
        actual: h.actual, // decimal 0..10
        guess: h.guess, // decimal 0..10
        delta: h.delta, // decimal
        when: h.createdAt,
      }));

    res.json({
      uid,
      wins: doc.wins || 0,
      losses: doc.losses || 0,
      gamesPlayed: doc.gamesPlayed || 0,
      totalGuesses: doc.totalGuesses || 0,
      avgDelta,
      recent,
    });
  } catch (e) {
    res.status(401).json({ error: "Unauthorized" });
  }
});

// Public rooms list for dashboard (waiting only)
app.get("/games/public", async (req, res) => {
  const games = await Game.find({ isPrivate: false, state: "waiting" })
    .sort({ createdAt: -1 })
    .select("roomId hostName players maxPlayers createdAt")
    .lean();

  res.json(
    games.map((g) => ({
      roomId: g.roomId,
      hostName: g.hostName,
      players: g.players.length,
      maxPlayers: g.maxPlayers,
      createdAt: g.createdAt,
    }))
  );
});

/* ---------------- In-memory state ---------------- */
const socketState = new Map(); // socket.id -> { uid, displayName, roomId, lastMsgAt }
const timers = {}; // roomId -> { pickTimer, guessTimer, revealTimer, endsAtMs }
const cooldowns = new Map(); // socket.id -> { lastStartAt: 0, lastPickAt: 0 }

/* ---------------- helpers ---------------- */
function ms(n) {
  return n;
}

function nameFromDecoded(decoded) {
  const raw =
    decoded.name ||
    decoded.displayName ||
    (decoded.email ? decoded.email.split("@")[0] : "");
  if (!raw) return `Player_${decoded.uid.slice(0, 6)}`;
  return String(raw).trim().split(/\s+/)[0]; // first token
}

async function broadcastRoom(roomId) {
  const game = await Game.findOne({ roomId }).lean();
  if (!game) return;

  // Compute a game-over summary when finished
  let result = null;
  if (game.state === "finished") {
    // pick highest score (if multiple, first in list wins as tiebreaker)
    const playersSorted = [...(game.players || [])].sort(
      (a, b) => (b.score || 0) - (a.score || 0)
    );
    const top = playersSorted[0];
    if (top) {
      const deltas = [];
      for (const r of game.rounds || []) {
        if (typeof r?.imdbRating === "number" && Array.isArray(r?.guesses)) {
          const g = r.guesses.find((x) => x.uid === top.uid);
          if (g && typeof g.value === "number") {
            deltas.push(Math.abs(r.imdbRating - g.value));
          }
        }
      }
      const avgDelta = deltas.length
        ? Number((deltas.reduce((a, b) => a + b, 0) / deltas.length).toFixed(2))
        : null;
      result = {
        winnerUid: top.uid,
        winnerName: top.displayName,
        score: top.score || 0,
        avgDelta, // winner's average delta in this game
      };
    }
  }

  const t = timers[roomId] || {};
  io.to(roomId).emit("room:update", {
    roomId: game.roomId,
    hostName: game.hostName,
    hostUid: game.hostUid,
    isPrivate: game.isPrivate,
    maxPlayers: game.maxPlayers,
    players: game.players.map((p) => ({
      uid: p.uid,
      displayName: p.displayName,
      score: p.score || 0,
    })),
    state: game.state,
    roundsCount: game.rounds.length,
    currentRound: game.rounds[game.rounds.length - 1] || null,
    targetScore: game.targetScore,
    usedOmdbIds: game.usedOmdbIds || [],
    endsAt: t.endsAtMs || null,
    result, // 👈 NEW: only meaningful when finished
  });
}


// Notify all dashboards to refresh public games
async function emitPublicRefresh() {
  io.emit("games:refresh");
}

function clearTimers(roomId) {
  const t = timers[roomId];
  if (!t) return;
  if (t.pickTimer) clearTimeout(t.pickTimer);
  if (t.guessTimer) clearTimeout(t.guessTimer);
  if (t.revealTimer) clearTimeout(t.revealTimer);
  delete timers[roomId];
}

async function getGame(roomId) {
  return Game.findOne({ roomId });
}

// --- Atomic helpers to avoid VersionError on concurrent updates ---
async function removePlayerAndRehost(roomId, uid) {
  // Pull player atomically; get the updated doc back
  const game = await Game.findOneAndUpdate(
    { roomId },
    { $pull: { players: { uid } } },
    { new: true }
  );
  if (!game) return;

  // If room empty, clean up
  if (game.players.length === 0) {
    clearTimers(roomId);
    await Game.deleteOne({ _id: game._id });
    return;
  }

  // If host left, promote first remaining player
  if (game.hostUid === uid) {
    const next = game.players[0];
    await Game.updateOne(
      { _id: game._id },
      { $set: { hostUid: next.uid, hostName: next.displayName } }
    );
  }

  // If only one player remains during an active game → end and award win
  if (game.players.length === 1 && game.state !== "waiting") {
    const fresh = await Game.findOne({ _id: game._id });
    await awardWinAndFinish(fresh, game.players[0].uid);
    return;
  }

  await broadcastRoom(roomId);
}

async function addPlayerIfRoomOpen(roomId, player) {
  const game = await Game.findOne({ roomId }).lean();
  if (!game) throw new Error("Room not found");
  if (game.state !== "waiting") throw new Error("Game already started");
  if (game.players.length >= game.maxPlayers) throw new Error("Room is full");

  await Game.updateOne(
    { roomId, "players.uid": { $ne: player.uid } },
    {
      $addToSet: {
        players: {
          uid: player.uid,
          displayName: player.displayName,
          score: 0,
        },
      },
    }
  );
}

/* ---------------- Game flow functions ---------------- */
async function startPickingPhase(roomId) {
  clearTimers(roomId);
  const game = await getGame(roomId);
  if (!game) return;
  if (game.players.length < 2) return; // safety

  // Picker rotates with round index
  const idx = game.rounds.length % game.players.length;
  const picker = game.players[idx];

  game.state = "picking";
  game.rounds.push({
    roundNumber: game.rounds.length + 1,
    pickerUid: picker.uid,
    pickerName: picker.displayName,
  });
  await game.save();

  timers[roomId] = {};
  timers[roomId].endsAtMs = Date.now() + ms(60_000);
  timers[roomId].pickTimer = setTimeout(() => forceSkipPicking(roomId), ms(60_000));

  io.to(roomId).emit("round:picking", {
    pickerUid: picker.uid,
    pickerName: picker.displayName,
    endsAt: timers[roomId].endsAtMs,
  });
  await broadcastRoom(roomId);
}

async function forceSkipPicking(roomId) {
  // Time ran out selecting a movie → advance to next picker (do NOT retry same user)
  const game = await getGame(roomId);
  if (!game || game.state !== "picking") return;

  const round = game.rounds[game.rounds.length - 1];
  if (round && !round.omdbId) {
    round.skipped = true;
    await game.save();
  }
  await startPickingPhase(roomId);
}

async function startGuessingPhase(roomId) {
  clearTimers(roomId);
  const game = await getGame(roomId);
  if (!game) return;

  game.state = "guessing";
  await game.save();

  timers[roomId] = {};
  timers[roomId].endsAtMs = Date.now() + ms(30_000);
  timers[roomId].guessTimer = setTimeout(() => revealPhase(roomId), ms(30_000));

  io.to(roomId).emit("round:guessing", { endsAt: timers[roomId].endsAtMs });
  await broadcastRoom(roomId);
}

async function revealPhase(roomId) {
  clearTimers(roomId);
  const game = await getGame(roomId);
  if (!game) return;

  const round = game.rounds[game.rounds.length - 1];
  if (!round) return;

  const actual = Number(round.imdbRating); // decimal (0..10)
  const guessesRaw = round.guesses || [];

  const guesses = guessesRaw.map((g) => {
    const obj = typeof g.toObject === "function" ? g.toObject() : g;
    return { ...obj, value: Number(obj.value) };
  });

  // Debug log for visibility
  console.log("[REVEAL]", {
    roomId,
    title: round.title,
    imdbDec: actual,
    guesses: guesses.map((g) => ({
      name: g.displayName,
      value: g.value,
      type: typeof g.value,
    })),
  });

  if (!isFinite(actual)) return;

  // Valid = closest WITHOUT going over
  const valid = guesses.filter((g) => isFinite(g.value) && g.value <= actual);

  let winner = null;
  let tieWinners = [];
  if (valid.length > 0) {
    // Compute deltas
    const withDelta = valid.map((g) => ({ ...g, delta: Math.abs(actual - g.value) }));
    // Find minimal delta
    const minDelta = Math.min(...withDelta.map((g) => g.delta));
    // Floating-point safe equality check
    const EPS = 1e-9;
    tieWinners = withDelta.filter((g) => Math.abs(g.delta - minDelta) <= EPS);

    if (tieWinners.length === 1) {
      winner = tieWinners[0];
    }
  }

  if (winner) {
    // Single winner → award point
    round.winnerUid = winner.uid;
    round.winnerName = winner.displayName;
    round.winnerDelta = winner.delta ?? Math.abs(actual - winner.value);

    const player = game.players.find((p) => p.uid === winner.uid);
    if (player) player.score = (player.score || 0) + 1;

    round.tie = false;
    round.tiedUids = [];
    round.tiedNames = [];
  } else if (tieWinners.length >= 2) {
    // Tie at the top → NO points awarded
    round.winnerUid = undefined;
    round.winnerName = undefined;
    round.winnerDelta = undefined;
    round.tie = true;
    round.tiedUids = tieWinners.map((t) => t.uid);
    round.tiedNames = tieWinners.map((t) => t.displayName);
    console.log("[REVEAL] Tie at top; no points awarded.", round.tiedNames);
  } else {
    // Nobody valid (everyone over or no guesses)
    round.winnerUid = undefined;
    round.winnerName = undefined;
    round.winnerDelta = undefined;
    round.tie = false;
    round.tiedUids = [];
    round.tiedNames = [];
    console.log("[REVEAL] No winner — everyone went over or no guesses.");
  }

  await game.save();

  // Persist per-user guess stats (decimal)
  await persistUserStatsForRound(game, round, actual);

  game.state = "revealing";
  await game.save();

  await broadcastRoom(roomId);

  timers[roomId] = {};
  timers[roomId].endsAtMs = Date.now() + ms(10_000);
  timers[roomId].revealTimer = setTimeout(() => nextRoundOrFinish(roomId), ms(10_000));
}


async function persistUserStatsForRound(game, round, actual) {
  const roomId = game.roomId;
  for (const g of round.guesses || []) {
    const delta = Number(Math.abs(actual - g.value).toFixed(2));
    await UserStat.findOneAndUpdate(
      { uid: g.uid },
      {
        $setOnInsert: { uid: g.uid, displayName: g.displayName },
        $inc: { totalGuesses: 1, sumDelta: delta },
        $push: {
          history: {
            roomId,
            omdbId: round.omdbId,
            title: round.title,
            actual, // decimal
            guess: g.value, // decimal
            delta,
            createdAt: new Date(),
          },
        },
      },
      { upsert: true, new: true }
    );
  }
}

async function awardWinAndFinish(game, winnerUid) {
  const winner = game.players.find((p) => p.uid === winnerUid);
  if (winner) {
    await UserStat.findOneAndUpdate(
      { uid: winner.uid },
      { $inc: { wins: 1, gamesPlayed: 1 } },
      { upsert: true }
    );
  }
  game.state = "finished";
  await game.save();
  await broadcastRoom(game.roomId);
}

async function nextRoundOrFinish(roomId) {
  clearTimers(roomId);
  const game = await getGame(roomId);
  if (!game) return;

  // If only one player remains mid-game, immediately end and award win.
  if (game.players.length === 1 && game.state !== "waiting") {
    await awardWinAndFinish(game, game.players[0].uid);
    return;
  }

  const winnerReached = game.players.find((p) => (p.score || 0) >= game.targetScore);
  if (winnerReached) {
    await awardWinAndFinish(game, winnerReached.uid);
    return;
  }

  await startPickingPhase(roomId);
}

/* ---------------- Socket.IO ---------------- */
io.on("connection", (socket) => {
  console.log("socket connected", socket.id);

  // Auth with Firebase ID token
  socket.on("auth:hello", async ({ idToken }, cb) => {
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      const displayName = nameFromDecoded(decoded);
      const uid = decoded.uid;
      socketState.set(socket.id, { uid, displayName, roomId: null, lastMsgAt: 0 });

      onlineUids.add(uid);
      emitMetrics(); // push updated online count

      cb?.({ ok: true, uid, displayName });
    } catch (e) {
      cb?.({ ok: false, error: "Invalid auth" });
    }
  });

  // Create a room
  socket.on("room:create", async ({ maxPlayers, isPrivate, password }, cb) => {
    try {
      const s = socketState.get(socket.id);
      if (!s?.uid) throw new Error("Not authenticated");

      const roomId = nanoid(8);
      const game = new Game({
        roomId,
        hostUid: s.uid,
        hostName: s.displayName, // display only
        isPrivate: !!isPrivate,
        maxPlayers: Math.max(2, Math.min(10, Number(maxPlayers) || 4)),
        players: [{ uid: s.uid, displayName: s.displayName, score: 0 }],
        state: "waiting",
        usedOmdbIds: [],
        rounds: [],
      });
      if (isPrivate && password) {
        game.passwordHash = await bcrypt.hash(password, 10);
      }
      await game.save();

      await socket.join(roomId);
      socketState.set(socket.id, { ...s, roomId });
      cb?.({ ok: true, roomId });

      await broadcastRoom(roomId);
      await emitPublicRefresh();
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  // Rejoin (refresh/reconnect)
  socket.on("room:rejoin", async ({ roomId }, cb) => {
    try {
      const s = socketState.get(socket.id);
      if (!s?.uid) throw new Error("Not authenticated");
      if (!roomId) throw new Error("Missing roomId");

      const game = await Game.findOne({ roomId });
      if (!game) throw new Error("Room not found");

      await socket.join(roomId);
      socketState.set(socket.id, { ...s, roomId });

      const recentChat = (game.chat || []).slice(-50);
      socket.emit("chat:history", recentChat);

      await broadcastRoom(roomId);
      cb?.({ ok: true });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  // Join a room (ATOMIC)
  socket.on("room:join", async ({ roomId, password }, cb) => {
    try {
      const s = socketState.get(socket.id);
      if (!s?.uid) throw new Error("Not authenticated");

      const game = await Game.findOne({ roomId });
      if (!game) throw new Error("Room not found");
      if (game.state !== "waiting") throw new Error("Game already started");

      if (game.isPrivate) {
        const ok = await bcrypt.compare(password || "", game.passwordHash || "");
        if (!ok) throw new Error("Invalid room password");
      }

      await addPlayerIfRoomOpen(roomId, { uid: s.uid, displayName: s.displayName });

      await socket.join(roomId);
      socketState.set(socket.id, { ...s, roomId });

      const fresh = await Game.findOne({ roomId }).lean();
      const recentChat = (fresh?.chat || []).slice(-50);
      socket.emit("chat:history", recentChat);

      cb?.({ ok: true });
      await broadcastRoom(roomId);
      await emitPublicRefresh(); // player count changed
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  // Leave a room (ATOMIC)
  socket.on("room:leave", async (_, cb) => {
    try {
      const s = socketState.get(socket.id);
      if (!s?.roomId) return cb?.({ ok: true });

      const { uid, roomId } = s;

      // If leaving mid-game and they already guessed, count a loss
      try {
        const g = await Game.findOne({ roomId }).lean();
        if (g && g.state !== "waiting" && userHasGuessedInGame(g, uid)) {
          await UserStat.findOneAndUpdate(
            { uid },
            { $inc: { losses: 1, gamesPlayed: 1 } },
            { upsert: true }
          );
        }
      } catch (_) { }

      await removePlayerAndRehost(roomId, uid);

      await socket.leave(roomId);
      socketState.set(socket.id, { ...s, roomId: null });

      cb?.({ ok: true });
      await emitPublicRefresh();
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  // Chat anti-spam (1 msg / 2s)
  socket.on("chat:send", async ({ text }, cb) => {
    try {
      const s = socketState.get(socket.id);
      if (!s?.roomId) throw new Error("Not in a room");

      const now = Date.now();
      if (now - (s.lastMsgAt || 0) < 2000) {
        throw new Error("Easy there—try again in a moment.");
      }

      const roomId = s.roomId;
      const game = await Game.findOne({ roomId });
      if (!game) throw new Error("Room not found");
      if (game.state === "finished") throw new Error("Chat closed");

      const msg = {
        uid: s.uid,
        displayName: s.displayName,
        text: (text || "").toString().slice(0, 500),
        createdAt: new Date(),
      };
      game.chat = game.chat || [];
      game.chat.push(msg);
      if (game.chat.length > 200) game.chat = game.chat.slice(-200);
      await game.save();

      s.lastMsgAt = now;
      socketState.set(socket.id, s);

      io.to(roomId).emit("chat:new", msg);
      cb?.({ ok: true });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  // Host starts the game (>= 2 players, host-only) with cooldown
  socket.on("game:start", async (cb) => {
    try {
      const s = socketState.get(socket.id);
      if (!s?.roomId) throw new Error("Not in a room");

      const cd = cooldowns.get(socket.id) || { lastStartAt: 0, lastPickAt: 0 };
      if (Date.now() - cd.lastStartAt < 1000) throw new Error("Slow down.");
      cd.lastStartAt = Date.now();
      cooldowns.set(socket.id, cd);

      if (getOmdbRemaining() < 50) {
        throw new Error("Daily OMDb quota low. Try again later.");
      }

      const game = await getGame(s.roomId);
      if (!game) throw new Error("Room not found");
      if (game.players.length < 2) throw new Error("Need at least 2 players");
      if (game.state !== "waiting") throw new Error("Game already started");
      if (game.hostUid !== s.uid) throw new Error("Only host can start");

      game.players.forEach((p) => (p.score = 0));
      game.usedOmdbIds = [];
      game.rounds = [];
      await game.save();

      await startPickingPhase(game.roomId);
      cb?.({ ok: true });
      await emitPublicRefresh(); // leaves public list
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  // Picker selects a movie by OMDb ID (store decimal rating)
  socket.on("round:pick_movie", async ({ omdbId }, cb) => {
    try {
      const s = socketState.get(socket.id);
      if (!s?.roomId) throw new Error("Not in a room");

      const cd = cooldowns.get(socket.id) || { lastStartAt: 0, lastPickAt: 0 };
      if (Date.now() - cd.lastPickAt < 1000) throw new Error("Slow down.");
      cd.lastPickAt = Date.now();
      cooldowns.set(socket.id, cd);

      const game = await getGame(s.roomId);
      if (!game) throw new Error("Room not found");
      if (game.state !== "picking") throw new Error("Not picking phase");

      const round = game.rounds[game.rounds.length - 1];
      if (!round) throw new Error("No round");
      if (round.pickerUid !== s.uid) throw new Error("Only picker can choose");

      if (round.omdbId) throw new Error("Movie already set for this round");
      if (game.usedOmdbIds.includes(omdbId)) throw new Error("Movie already used");

      const url = `https://www.omdbapi.com/?apikey=${process.env.OMDB_API_KEY}&i=${encodeURIComponent(
        omdbId
      )}`;
      const resp = await fetch(url);
      const data = await resp.json();
      if (data.Response === "False") throw new Error("OMDb not found");

      incOmdbCount(1); // count a detail call
      const imdbDec = Number(data.imdbRating); // decimal like 8.1
      if (isNaN(imdbDec)) throw new Error("No IMDb rating for this title");

      console.log("[PICK]", {
        roomId: game.roomId,
        omdbId,
        title: data.Title,
        omdbRatingRaw: data.imdbRating,
        imdbDec,
      });

      round.omdbId = omdbId;
      round.title = data.Title || "Unknown";
      round.year = data.Year || "";
      round.poster = data.Poster || "";
      round.imdbRating = imdbDec; // store DECIMAL 0..10

      game.usedOmdbIds.push(omdbId);
      await game.save();

      await startGuessingPhase(game.roomId);
      cb?.({ ok: true });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  // Players submit guesses (0..10, step 0.1) — one per player (picker CAN guess)
  socket.on("round:guess", async ({ value }, cb) => {
    try {
      const s = socketState.get(socket.id);
      if (!s?.roomId) throw new Error("Not in a room");
      const game = await getGame(s.roomId);
      if (!game) throw new Error("Room not found");
      if (game.state !== "guessing") throw new Error("Not guessing phase");

      const round = game.rounds[game.rounds.length - 1];
      if (!round?.imdbRating) throw new Error("Movie not set");

      if ((round.guesses || []).some((g) => g.uid === s.uid)) {
        throw new Error("You already submitted a guess");
      }

      const v = Math.max(0, Math.min(10, Number(value)));
      round.guesses = round.guesses || [];
      round.guesses.push({
        uid: s.uid,
        displayName: s.displayName,
        value: Number(v.toFixed(1)),
      });
      await game.save();

      // If all players (INCLUDING picker) have guessed, reveal early
      const guessersCount = game.players.length;
      const uniqueGuessers = new Set(round.guesses.map((g) => g.uid)).size;
      if (uniqueGuessers >= guessersCount) {
        await revealPhase(game.roomId);
      }

      cb?.({ ok: true });
      await broadcastRoom(game.roomId);
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  // Disconnect (ATOMIC leave + metrics)
  socket.on("disconnect", async () => {
    const s = socketState.get(socket.id);
    if (s?.uid) {
      onlineUids.delete(s.uid);
    }
    if (!s) {
      emitMetrics();
      return;
    }

    const { uid, roomId } = s;

    if (roomId) {
      // Loss if they had guessed this game and it's not waiting
      try {
        const g = await Game.findOne({ roomId }).lean();
        if (g && g.state !== "waiting" && userHasGuessedInGame(g, uid)) {
          await UserStat.findOneAndUpdate(
            { uid },
            { $inc: { losses: 1, gamesPlayed: 1 } },
            { upsert: true }
          );
        }
      } catch (_) { }

      await removePlayerAndRehost(roomId, uid);
    }

    socketState.delete(socket.id);
    await emitPublicRefresh();
    emitMetrics(); // push updated online count
  });
});
