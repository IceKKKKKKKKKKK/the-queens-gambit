import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  buildPrivateSettlementStatements,
  buildRankedSettlementStatements,
  type SettlementStatement,
} from "../lib/platform-settlement.ts";
import { calculateMatchRatings } from "../lib/ranking.ts";

function createSettlementDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE platform_users (
      id TEXT PRIMARY KEY,
      rating INTEGER NOT NULL,
      ranked_games INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      draws INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE platform_matches (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      ranked INTEGER NOT NULL,
      status TEXT NOT NULL,
      player_a_id TEXT NOT NULL,
      player_b_id TEXT NOT NULL,
      winner_user_id TEXT,
      ended_reason TEXT,
      rating_delta_a INTEGER,
      rating_delta_b INTEGER,
      completed_at INTEGER
    );
  `);
  return database;
}

function executeSettlement(database: DatabaseSync, statements: readonly SettlementStatement[]) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const changes = statements.map((statement) =>
      Number(database.prepare(statement.sql).run(...statement.bindings).changes),
    );
    database.exec("COMMIT");
    return changes;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

test("an expired lock cannot let two stale ranked draw workers settle Elo twice", () => {
  const database = createSettlementDatabase();
  try {
    database.prepare(
      "INSERT INTO platform_users (id, rating, updated_at) VALUES (?, ?, 0), (?, ?, 0)",
    ).run("a", 1250, "b", 1150);
    database.prepare(
      `INSERT INTO platform_matches (
        id, mode, ranked, status, player_a_id, player_b_id
      ) VALUES (?, 'hex_ranked', 1, 'active', ?, ?)`,
    ).run("ranked-draw", "a", "b");
    const ratings = calculateMatchRatings({
      ratingA: 1250,
      ratingB: 1150,
      rankedGamesA: 0,
      rankedGamesB: 0,
      scoreA: 0.5,
    });
    const staleWorkerPlan = buildRankedSettlementStatements({
      matchId: "ranked-draw",
      playerAId: "a",
      playerBId: "b",
      winnerUserId: null,
      reason: "threefold_repetition",
      ratingA: ratings.ratingA,
      ratingB: ratings.ratingB,
      ratingDeltaA: ratings.ratingA - 1250,
      ratingDeltaB: ratings.ratingB - 1150,
      scoreA: 0.5,
      completedAt: 10_000,
    });

    assert.deepEqual(executeSettlement(database, staleWorkerPlan), [1, 1, 1]);
    assert.deepEqual(executeSettlement(database, staleWorkerPlan), [0, 0, 0]);

    const users = database
      .prepare("SELECT id, rating, ranked_games, wins, losses, draws FROM platform_users ORDER BY id")
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(users, [
      { id: "a", rating: ratings.ratingA, ranked_games: 1, wins: 0, losses: 0, draws: 1 },
      { id: "b", rating: ratings.ratingB, ranked_games: 1, wins: 0, losses: 0, draws: 1 },
    ]);
    assert.deepEqual(
      {
        ...database.prepare(
          `SELECT status, winner_user_id, ended_reason, rating_delta_a, rating_delta_b
           FROM platform_matches WHERE id = ?`,
        ).get("ranked-draw"),
      },
      {
        status: "completed",
        winner_user_id: null,
        ended_reason: "threefold_repetition",
        rating_delta_a: ratings.ratingA - 1250,
        rating_delta_b: ratings.ratingB - 1150,
      },
    );
  } finally {
    database.close();
  }
});

test("an expired lock cannot double-count a private draw or change either rating", () => {
  const database = createSettlementDatabase();
  try {
    database.prepare(
      "INSERT INTO platform_users (id, rating, updated_at) VALUES (?, ?, 0), (?, ?, 0)",
    ).run("a", 1337, "b", 977);
    database.prepare(
      `INSERT INTO platform_matches (
        id, mode, ranked, status, player_a_id, player_b_id
      ) VALUES (?, 'hex_private', 0, 'active', ?, ?)`,
    ).run("private-draw", "a", "b");
    const staleWorkerPlan = buildPrivateSettlementStatements({
      matchId: "private-draw",
      playerAId: "a",
      playerBId: "b",
      winnerUserId: null,
      reason: "threefold_repetition",
      completedAt: 20_000,
    });

    assert.deepEqual(executeSettlement(database, staleWorkerPlan), [1, 1, 1]);
    assert.deepEqual(executeSettlement(database, staleWorkerPlan), [0, 0, 0]);
    assert.deepEqual(
      database
        .prepare("SELECT id, rating, ranked_games, wins, losses, draws FROM platform_users ORDER BY id")
        .all()
        .map((row) => ({ ...row })),
      [
        { id: "a", rating: 1337, ranked_games: 0, wins: 0, losses: 0, draws: 1 },
        { id: "b", rating: 977, ranked_games: 0, wins: 0, losses: 0, draws: 1 },
      ],
    );
  } finally {
    database.close();
  }
});
