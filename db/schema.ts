import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const games = sqliteTable(
  "games",
  {
    code: text("code").primaryKey(),
    blackTokenHash: text("black_token_hash").notNull(),
    whiteTokenHash: text("white_token_hash").notNull(),
    whiteInviteHash: text("white_invite_hash").notNull(),
    stateJson: text("state_json").notNull(),
    version: integer("version").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    roomKind: text("room_kind").notNull().default("custom"),
    gameMode: text("game_mode").notNull().default("classic"),
    spectatorPolicy: text("spectator_policy").notNull().default("hidden"),
    blackUserId: text("black_user_id").notNull().default(""),
    whiteUserId: text("white_user_id").notNull().default(""),
    matchId: text("match_id").notNull().default(""),
    resultRecorded: integer("result_recorded").notNull().default(0),
  },
  (table) => [
    index("games_expires_at_idx").on(table.expiresAt),
    index("games_match_id_idx").on(table.matchId),
  ],
);

export const roomCreationLimits = sqliteTable("room_creation_limits", {
  keyHash: text("key_hash").primaryKey(),
  windowStart: integer("window_start").notNull(),
  count: integer("count").notNull().default(0),
});

export const platformUsers = sqliteTable(
  "platform_users",
  {
    id: text("id").primaryKey(),
    authUserId: text("auth_user_id").notNull(),
    email: text("email").notNull(),
    handle: text("handle").notNull(),
    handleKey: text("handle_key").notNull(),
    rating: integer("rating").notNull().default(1200),
    rankedGames: integer("ranked_games").notNull().default(0),
    wins: integer("wins").notNull().default(0),
    losses: integer("losses").notNull().default(0),
    draws: integer("draws").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("platform_users_auth_user_id_idx").on(table.authUserId),
    uniqueIndex("platform_users_handle_key_idx").on(table.handleKey),
  ],
);

export const friendships = sqliteTable(
  "friendships",
  {
    id: text("id").primaryKey(),
    userLowId: text("user_low_id").notNull(),
    userHighId: text("user_high_id").notNull(),
    requestedBy: text("requested_by").notNull(),
    status: text("status").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("friendships_pair_idx").on(table.userLowId, table.userHighId),
    index("friendships_low_status_idx").on(table.userLowId, table.status),
    index("friendships_high_status_idx").on(table.userHighId, table.status),
  ],
);

export const playerPresence = sqliteTable("player_presence", {
  userId: text("user_id").primaryKey(),
  status: text("status").notNull(),
  currentMatchId: text("current_match_id"),
  lastHeartbeatAt: integer("last_heartbeat_at").notNull(),
});

export const platformMatches = sqliteTable(
  "platform_matches",
  {
    id: text("id").primaryKey(),
    mode: text("mode").notNull(),
    ranked: integer("ranked", { mode: "boolean" }).notNull().default(true),
    status: text("status").notNull(),
    playerAId: text("player_a_id").notNull(),
    playerBId: text("player_b_id").notNull(),
    winnerUserId: text("winner_user_id"),
    endedReason: text("ended_reason"),
    ratingBeforeA: integer("rating_before_a").notNull(),
    ratingBeforeB: integer("rating_before_b").notNull(),
    ratingDeltaA: integer("rating_delta_a"),
    ratingDeltaB: integer("rating_delta_b"),
    gameCode: text("game_code"),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
  },
  (table) => [
    index("platform_matches_player_a_completed_idx").on(table.playerAId, table.completedAt),
    index("platform_matches_player_b_completed_idx").on(table.playerBId, table.completedAt),
    index("platform_matches_status_created_idx").on(table.status, table.createdAt),
    uniqueIndex("platform_matches_game_code_idx").on(table.gameCode),
  ],
);

export const matchmakingQueue = sqliteTable(
  "matchmaking_queue",
  {
    userId: text("user_id").primaryKey(),
    ticket: text("ticket").notNull(),
    mode: text("mode").notNull(),
    rating: integer("rating").notNull(),
    status: text("status").notNull(),
    matchId: text("match_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("matchmaking_queue_ticket_idx").on(table.ticket),
    index("matchmaking_queue_mode_status_created_idx").on(
      table.mode,
      table.status,
      table.createdAt,
    ),
  ],
);

export const matchmakingLocks = sqliteTable("matchmaking_locks", {
  name: text("name").primaryKey(),
  ownerToken: text("owner_token").notNull(),
  leaseUntil: integer("lease_until").notNull(),
});
