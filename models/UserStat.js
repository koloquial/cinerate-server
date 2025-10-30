// Per-user lifetime stats across games
const mongoose = require("mongoose");

const GuessHistorySchema = new mongoose.Schema({
  roomId: String,
  omdbId: String,
  title: String,
  actual: Number, // 0..100
  guess: Number,  // 0..100
  delta: Number,  // abs(actual - guess)
  createdAt: { type: Date, default: Date.now },
});

const UserStatSchema = new mongoose.Schema(
  {
    uid: { type: String, unique: true, index: true },
    displayName: String,

    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },

    gamesPlayed: { type: Number, default: 0 },
    totalGuesses: { type: Number, default: 0 },
    sumDelta: { type: Number, default: 0 }, // for average delta
    history: { type: [GuessHistorySchema], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model("UserStat", UserStatSchema);
