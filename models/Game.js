const mongoose = require("mongoose");

const PlayerSchema = new mongoose.Schema({
  uid: { type: String, required: true },
  displayName: { type: String, required: true },
  score: { type: Number, default: 0 }, // track score in-game
  joinedAt: { type: Date, default: Date.now },
});

const ChatMessageSchema = new mongoose.Schema({
  uid: String,
  displayName: String,
  text: String,
  createdAt: { type: Date, default: Date.now },
});

const GuessSchema = new mongoose.Schema({
  uid: String,
  displayName: String,
  value: Number, // guessed rating (0–100 scale; client slider will enforce)
  createdAt: { type: Date, default: Date.now },
});

const RoundSchema = new mongoose.Schema({
  roundNumber: Number,
  pickerUid: String,
  pickerName: String,

  omdbId: String,         // e.g. "tt1375666"
  title: String,          // movie title
  year: String,           // "2010"
  poster: String,         // url (optional)
  imdbRating: Number,     // 0..100 (we convert from 0..10 * 10)

  genre: String,
  plot: String,
  runtime: String,
  rated: String,
  released: String,
  language: String,
  country: String,
  director: String,
  writer: String,
  actors: String,
  awards: String,
  boxOffice: String,
  production: String,
  imdbVotes: String,


  guesses: { type: [GuessSchema], default: [] },
  winnerUid: String,
  winnerName: String,
  winnerDelta: Number,    // difference from actual
});

const GameSchema = new mongoose.Schema(
  {
    roomId: { type: String, unique: true, index: true },
    hostUid: String,
    hostName: String,

    isPrivate: { type: Boolean, default: false },
    passwordHash: { type: String, default: "" },

    maxPlayers: { type: Number, default: 4, min: 2, max: 10 },
    players: { type: [PlayerSchema], default: [] },
    playAgainUids: { type: [String], default: [] },
    state: {
      type: String,
      enum: ["waiting", "picking", "guessing", "revealing", "finished"],
      default: "waiting",
    },

    usedOmdbIds: { type: [String], default: [] }, // prevent repeats
    rounds: { type: [RoundSchema], default: [] },
    targetScore: { type: Number, default: 5 }, // first to 5

    result: {
      type: {
        winnerUid: String,
        winnerName: String,
        score: Number,
        avgDelta: Number,
        finishedAt: Date,
      },
      default: null,
    },

  },
  { timestamps: true }
);

module.exports = mongoose.model("Game", GameSchema);
