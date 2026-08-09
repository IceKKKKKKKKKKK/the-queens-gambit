import { env } from "cloudflare:workers";
import {
  createDefaultHandle,
  normalizeHandle,
  type AuthenticatedIdentity,
} from "../lib/identity";
import {
  calculateMatchRatings,
  DEFAULT_RATING,
  rankForRating,
} from "../lib/ranking";

export const RANKED_MATCH_MODE = "hex_ranked" as const;
export type PrivateMatchMode = "classic_private" | "hex_private";
export type PlatformMatchMode = typeof RANKED_MATCH_MODE | PrivateMatchMode;
export const RANKED_TIME_CONTROL = {
  initialMs: 10 * 60 * 1000,
  incrementMs: 5 * 1000,
  incrementThresholdMs: 5 * 60 * 1000,
  incrementTiming: "after_legal_move",
  thresholdCheck: "remaining_after_move",
} as const;

const PRESENCE_FRESH_MS = 90_000;
const MATCHMAKING_LOCK_NAME = "ranked-v1";
const MATCHMAKING_LOCK_LEASE_MS = 5_000;
const MATCH_CANDIDATE_LIMIT = 50;

export class PlatformError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 400) {
    super(code);
    this.name = "PlatformError";
    this.code = code;
    this.status = status;
  }
}

export interface PlatformUserRow {
  id: string;
  auth_user_id: string;
  email: string;
  handle: string;
  handle_key: string;
  rating: number;
  ranked_games: number;
  wins: number;
  losses: number;
  draws: number;
  created_at: number;
  updated_at: number;
}

interface FriendshipRow {
  relationship_id: string;
  relationship_status: "pending" | "accepted";
  requested_by: string;
  user_id: string;
  handle: string;
  rating: number;
  presence_status: "online" | "searching" | "in_game" | null;
  current_match_id: string | null;
  last_heartbeat_at: number | null;
  created_at: number;
  updated_at: number;
}

interface QueueRow {
  user_id: string;
  ticket: string;
  mode: typeof RANKED_MATCH_MODE;
  rating: number;
  status: "queued" | "matched" | "cancelled";
  match_id: string | null;
  created_at: number;
  updated_at: number;
}

interface MatchRow {
  id: string;
  mode: PlatformMatchMode;
  ranked: number;
  status: "matched" | "active" | "completed" | "cancelled";
  player_a_id: string;
  player_b_id: string;
  winner_user_id: string | null;
  ended_reason: string | null;
  rating_before_a: number;
  rating_before_b: number;
  rating_delta_a: number | null;
  rating_delta_b: number | null;
  game_code: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

interface RecentMatchRow {
  id: string;
  mode: string;
  opponent_handle: string;
  outcome: "win" | "loss" | "draw";
  rating_delta: number | null;
  ended_reason: string | null;
  completed_at: number;
}

interface MatchWithOpponentRow extends MatchRow {
  opponent_handle: string;
  opponent_rating: number;
}

export interface MatchGameProvisionRequest {
  matchId: string;
  mode: typeof RANKED_MATCH_MODE;
  playerAId: string;
  playerBId: string;
  visibility: "ranked_redacted_spectators";
  timeControl: typeof RANKED_TIME_CONTROL;
}

export interface MatchGameProvisionResult {
  gameCode: string;
}

export type MatchGameProvisioner = (
  request: MatchGameProvisionRequest,
) => Promise<MatchGameProvisionResult>;

function getD1() {
  if (!env.DB) throw new Error("D1 binding DB is unavailable");
  return env.DB;
}

let schemaPromise: Promise<void> | null = null;

async function initializePlatformSchema() {
  const db = getD1();
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS platform_users (
        id TEXT PRIMARY KEY NOT NULL,
        auth_user_id TEXT NOT NULL,
        email TEXT NOT NULL,
        handle TEXT NOT NULL,
        handle_key TEXT NOT NULL,
        rating INTEGER NOT NULL DEFAULT 1200,
        ranked_games INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        draws INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS friendships (
        id TEXT PRIMARY KEY NOT NULL,
        user_low_id TEXT NOT NULL,
        user_high_id TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS player_presence (
        user_id TEXT PRIMARY KEY NOT NULL,
        status TEXT NOT NULL,
        current_match_id TEXT,
        last_heartbeat_at INTEGER NOT NULL
      )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS platform_matches (
        id TEXT PRIMARY KEY NOT NULL,
        mode TEXT NOT NULL,
        ranked INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        player_a_id TEXT NOT NULL,
        player_b_id TEXT NOT NULL,
        winner_user_id TEXT,
        ended_reason TEXT,
        rating_before_a INTEGER NOT NULL,
        rating_before_b INTEGER NOT NULL,
        rating_delta_a INTEGER,
        rating_delta_b INTEGER,
        game_code TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER
      )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS matchmaking_queue (
        user_id TEXT PRIMARY KEY NOT NULL,
        ticket TEXT NOT NULL,
        mode TEXT NOT NULL,
        rating INTEGER NOT NULL,
        status TEXT NOT NULL,
        match_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS matchmaking_locks (
        name TEXT PRIMARY KEY NOT NULL,
        owner_token TEXT NOT NULL,
        lease_until INTEGER NOT NULL
      )`,
    ),
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS platform_users_auth_user_id_idx ON platform_users(auth_user_id)",
    ),
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS platform_users_handle_key_idx ON platform_users(handle_key)",
    ),
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS friendships_pair_idx ON friendships(user_low_id, user_high_id)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS friendships_low_status_idx ON friendships(user_low_id, status)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS friendships_high_status_idx ON friendships(user_high_id, status)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS platform_matches_player_a_completed_idx ON platform_matches(player_a_id, completed_at)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS platform_matches_player_b_completed_idx ON platform_matches(player_b_id, completed_at)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS platform_matches_status_created_idx ON platform_matches(status, created_at)",
    ),
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS platform_matches_game_code_idx ON platform_matches(game_code)",
    ),
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS matchmaking_queue_ticket_idx ON matchmaking_queue(ticket)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS matchmaking_queue_mode_status_created_idx ON matchmaking_queue(mode, status, created_at)",
    ),
    db.prepare(
      `INSERT OR IGNORE INTO matchmaking_locks (name, owner_token, lease_until)
       VALUES ('ranked-v1', '', 0)`,
    ),
    db.prepare("PRAGMA optimize"),
  ]);
}

export async function ensurePlatformSchema() {
  schemaPromise ??= initializePlatformSchema();
  try {
    await schemaPromise;
  } catch (error) {
    schemaPromise = null;
    throw error;
  }
}

function platformUserSelect() {
  return `SELECT id, auth_user_id, email, handle, handle_key, rating,
                 ranked_games, wins, losses, draws, created_at, updated_at
          FROM platform_users`;
}

async function userByAuthId(authUserId: string) {
  return getD1()
    .prepare(`${platformUserSelect()} WHERE auth_user_id = ?1`)
    .bind(authUserId)
    .first<PlatformUserRow>();
}

export async function userById(userId: string) {
  return getD1()
    .prepare(`${platformUserSelect()} WHERE id = ?1`)
    .bind(userId)
    .first<PlatformUserRow>();
}

export async function getOrCreatePlatformUser(identity: AuthenticatedIdentity) {
  await ensurePlatformSchema();
  const existing = await userByAuthId(identity.authUserId);
  if (existing) {
    if (existing.email !== identity.email) {
      const updatedAt = Date.now();
      await getD1()
        .prepare("UPDATE platform_users SET email = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(identity.email, updatedAt, existing.id)
        .run();
      return { ...existing, email: identity.email, updated_at: updatedAt };
    }
    return existing;
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const handle = await createDefaultHandle(identity, attempt === 0 ? "" : String(attempt));
    const now = Date.now();
    await getD1()
      .prepare(
        `INSERT OR IGNORE INTO platform_users (
          id, auth_user_id, email, handle, handle_key, rating,
          ranked_games, wins, losses, draws, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, 0, 0, ?7, ?7)`,
      )
      .bind(
        crypto.randomUUID(),
        identity.authUserId,
        identity.email,
        handle.handle,
        handle.handleKey,
        DEFAULT_RATING,
        now,
      )
      .run();
    const created = await userByAuthId(identity.authUserId);
    if (created) return created;
  }
  throw new PlatformError("ACCOUNT_CREATE_CONFLICT", 409);
}

export function accountSummary(user: PlatformUserRow) {
  const games = user.wins + user.losses + user.draws;
  const winRate = games === 0 ? 0 : user.wins / games;
  return {
    handle: user.handle,
    email: user.email,
    rating: user.rating,
    rank: rankForRating(user.rating),
    record: {
      games,
      rankedGames: user.ranked_games,
      wins: user.wins,
      losses: user.losses,
      draws: user.draws,
      winRate,
      winRatePercent: Math.round(winRate * 1_000) / 10,
    },
    createdAt: user.created_at,
  };
}

export async function updatePlatformHandle(userId: string, rawHandle: unknown) {
  const { handle, handleKey } = normalizeHandle(rawHandle);
  const now = Date.now();
  try {
    const result = await getD1()
      .prepare(
        `UPDATE platform_users
         SET handle = ?1, handle_key = ?2, updated_at = ?3
         WHERE id = ?4 AND (handle <> ?1 OR handle_key <> ?2)`,
      )
      .bind(handle, handleKey, now, userId)
      .run();
    if (Number(result.meta.changes ?? 0) === 0) {
      const unchanged = await userById(userId);
      if (!unchanged) throw new PlatformError("ACCOUNT_NOT_FOUND", 404);
      return unchanged;
    }
  } catch (error) {
    if (String(error).toLocaleLowerCase("en-US").includes("unique")) {
      throw new PlatformError("HANDLE_TAKEN", 409);
    }
    throw error;
  }
  const updated = await userById(userId);
  if (!updated) throw new PlatformError("ACCOUNT_NOT_FOUND", 404);
  return updated;
}

export async function listRecentMatches(userId: string, limit = 10) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
    throw new PlatformError("INVALID_HISTORY_LIMIT");
  }
  const result = await getD1()
    .prepare(
      `SELECT m.id, m.mode,
              CASE WHEN m.player_a_id = ?1 THEN player_b.handle ELSE player_a.handle END AS opponent_handle,
              CASE
                WHEN m.winner_user_id IS NULL THEN 'draw'
                WHEN m.winner_user_id = ?1 THEN 'win'
                ELSE 'loss'
              END AS outcome,
              CASE WHEN m.player_a_id = ?1 THEN m.rating_delta_a ELSE m.rating_delta_b END AS rating_delta,
              m.ended_reason, m.completed_at
       FROM platform_matches m
       JOIN platform_users player_a ON player_a.id = m.player_a_id
       JOIN platform_users player_b ON player_b.id = m.player_b_id
       WHERE m.status = 'completed'
         AND (m.player_a_id = ?1 OR m.player_b_id = ?1)
       ORDER BY m.completed_at DESC, m.id DESC
       LIMIT ?2`,
    )
    .bind(userId, limit)
    .all<RecentMatchRow>();
  return result.results.map((match: RecentMatchRow) => ({
    id: match.id,
    mode: match.mode,
    opponentHandle: match.opponent_handle,
    outcome: match.outcome,
    ratingDelta: match.rating_delta,
    endedReason: match.ended_reason,
    completedAt: match.completed_at,
  }));
}

function canonicalPair(firstUserId: string, secondUserId: string) {
  return firstUserId < secondUserId
    ? ([firstUserId, secondUserId] as const)
    : ([secondUserId, firstUserId] as const);
}

async function friendshipByPair(userLowId: string, userHighId: string) {
  return getD1()
    .prepare(
      `SELECT id, user_low_id, user_high_id, requested_by, status, created_at, updated_at
       FROM friendships WHERE user_low_id = ?1 AND user_high_id = ?2`,
    )
    .bind(userLowId, userHighId)
    .first<{
      id: string;
      user_low_id: string;
      user_high_id: string;
      requested_by: string;
      status: "pending" | "accepted";
      created_at: number;
      updated_at: number;
    }>();
}

export async function createFriendRequest(user: PlatformUserRow, rawTargetHandle: unknown) {
  const { handleKey } = normalizeHandle(rawTargetHandle);
  const target = await getD1()
    .prepare(`${platformUserSelect()} WHERE handle_key = ?1`)
    .bind(handleKey)
    .first<PlatformUserRow>();
  if (!target) throw new PlatformError("PLAYER_NOT_FOUND", 404);
  if (target.id === user.id) throw new PlatformError("CANNOT_FRIEND_SELF");

  const [userLowId, userHighId] = canonicalPair(user.id, target.id);
  const existing = await friendshipByPair(userLowId, userHighId);
  if (existing?.status === "accepted") throw new PlatformError("ALREADY_FRIENDS", 409);
  if (existing?.requested_by === user.id) throw new PlatformError("FRIEND_REQUEST_PENDING", 409);
  if (existing) throw new PlatformError("INCOMING_FRIEND_REQUEST_EXISTS", 409);

  const requestId = crypto.randomUUID();
  const now = Date.now();
  await getD1()
    .prepare(
      `INSERT OR IGNORE INTO friendships (
        id, user_low_id, user_high_id, requested_by, status, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?5)`,
    )
    .bind(requestId, userLowId, userHighId, user.id, now)
    .run();
  const inserted = await friendshipByPair(userLowId, userHighId);
  if (!inserted || inserted.requested_by !== user.id) {
    throw new PlatformError("FRIEND_REQUEST_CONFLICT", 409);
  }
  return {
    requestId: inserted.id,
    target: { handle: target.handle, rating: target.rating, rank: rankForRating(target.rating) },
    status: inserted.status,
    createdAt: inserted.created_at,
  };
}

export async function acceptFriendRequest(user: PlatformUserRow, requestId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    throw new PlatformError("FRIEND_REQUEST_NOT_FOUND", 404);
  }
  const now = Date.now();
  const result = await getD1()
    .prepare(
      `UPDATE friendships
       SET status = 'accepted', updated_at = ?1
       WHERE id = ?2 AND status = 'pending' AND requested_by <> ?3
         AND (user_low_id = ?3 OR user_high_id = ?3)`,
    )
    .bind(now, requestId, user.id)
    .run();
  if (Number(result.meta.changes ?? 0) !== 1) {
    throw new PlatformError("FRIEND_REQUEST_NOT_FOUND", 404);
  }
  return { requestId, status: "accepted" as const, acceptedAt: now };
}

export async function listFriends(user: PlatformUserRow, now = Date.now()) {
  const rows = await getD1()
    .prepare(
      `SELECT f.id AS relationship_id, f.status AS relationship_status, f.requested_by,
              other.id AS user_id, other.handle, other.rating,
              p.status AS presence_status, p.current_match_id, p.last_heartbeat_at,
              f.created_at, f.updated_at
       FROM friendships f
       JOIN platform_users other
         ON other.id = CASE WHEN f.user_low_id = ?1 THEN f.user_high_id ELSE f.user_low_id END
       LEFT JOIN player_presence p ON p.user_id = other.id
       WHERE f.user_low_id = ?1 OR f.user_high_id = ?1
       ORDER BY f.updated_at DESC, f.id ASC`,
    )
    .bind(user.id)
    .all<FriendshipRow>();

  const payload = { friends: [] as unknown[], incoming: [] as unknown[], outgoing: [] as unknown[] };
  for (const row of rows.results) {
    const isFresh = row.last_heartbeat_at !== null && now - row.last_heartbeat_at <= PRESENCE_FRESH_MS;
    const presence = isFresh ? (row.presence_status ?? "online") : "offline";
    const player = {
      handle: row.handle,
      rating: row.rating,
      rank: rankForRating(row.rating),
    };
    if (row.relationship_status === "accepted") {
      payload.friends.push({
        relationshipId: row.relationship_id,
        player,
        presence,
        currentMatchId: presence === "in_game" ? row.current_match_id : null,
        lastSeenAt: row.last_heartbeat_at,
        friendsSince: row.updated_at,
      });
    } else if (row.requested_by === user.id) {
      payload.outgoing.push({
        requestId: row.relationship_id,
        player,
        createdAt: row.created_at,
      });
    } else {
      payload.incoming.push({
        requestId: row.relationship_id,
        player,
        createdAt: row.created_at,
      });
    }
  }
  return payload;
}

export async function friendMatchForSpectator(user: PlatformUserRow, matchId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(matchId)) {
    throw new PlatformError("FRIEND_MATCH_NOT_FOUND", 404);
  }
  const match = await getD1()
    .prepare(
      `SELECT id, mode, ranked, status, player_a_id, player_b_id, winner_user_id,
              ended_reason, rating_before_a, rating_before_b, rating_delta_a,
              rating_delta_b, game_code, created_at, started_at, completed_at
       FROM platform_matches
       WHERE id = ?1 AND ranked = 1 AND status IN ('matched', 'active')
         AND player_a_id <> ?2 AND player_b_id <> ?2`,
    )
    .bind(matchId, user.id)
    .first<MatchRow>();
  if (!match) throw new PlatformError("FRIEND_MATCH_NOT_FOUND", 404);

  const friend = await getD1()
    .prepare(
      `SELECT friend.id, friend.handle, friend.rating
       FROM friendships relationship
       JOIN platform_users friend
         ON friend.id = CASE
           WHEN relationship.user_low_id = ?1 THEN relationship.user_high_id
           ELSE relationship.user_low_id
         END
       WHERE relationship.status = 'accepted'
         AND (relationship.user_low_id = ?1 OR relationship.user_high_id = ?1)
         AND friend.id IN (?2, ?3)
       ORDER BY friend.id ASC
       LIMIT 1`,
    )
    .bind(user.id, match.player_a_id, match.player_b_id)
    .first<{ id: string; handle: string; rating: number }>();
  if (!friend) throw new PlatformError("FRIEND_MATCH_NOT_FOUND", 404);
  const opponentId = friend.id === match.player_a_id ? match.player_b_id : match.player_a_id;
  const opponent = await userById(opponentId);
  if (!opponent) throw new PlatformError("FRIEND_MATCH_NOT_FOUND", 404);

  return {
    matchId: match.id,
    mode: match.mode,
    status: match.status,
    friend: { handle: friend.handle, rating: friend.rating, rank: rankForRating(friend.rating) },
    opponent: {
      handle: opponent.handle,
      rating: opponent.rating,
      rank: rankForRating(opponent.rating),
    },
    game:
      match.game_code === null
        ? { status: "pending_provisioning" as const, code: null }
        : { status: "ready" as const, code: match.game_code },
    visibility: "ranked_redacted_spectators" as const,
  };
}

export async function heartbeatPresence(userId: string, now = Date.now()) {
  await getD1()
    .prepare(
      `INSERT INTO player_presence (user_id, status, current_match_id, last_heartbeat_at)
       VALUES (?1, 'online', NULL, ?2)
       ON CONFLICT(user_id) DO UPDATE SET
         status = CASE
           WHEN player_presence.status IN ('searching', 'in_game') THEN player_presence.status
           ELSE 'online'
         END,
         last_heartbeat_at = excluded.last_heartbeat_at`,
    )
    .bind(userId, now)
    .run();
  return ownPresence(userId, now);
}

export async function ownPresence(userId: string, now = Date.now()) {
  const row = await getD1()
    .prepare(
      `SELECT status, current_match_id, last_heartbeat_at
       FROM player_presence WHERE user_id = ?1`,
    )
    .bind(userId)
    .first<{
      status: "online" | "searching" | "in_game";
      current_match_id: string | null;
      last_heartbeat_at: number;
    }>();
  const fresh = Boolean(row && now - row.last_heartbeat_at <= PRESENCE_FRESH_MS);
  return {
    status: fresh ? row?.status ?? "online" : "offline",
    currentMatchId: fresh && row?.status === "in_game" ? row.current_match_id : null,
    lastHeartbeatAt: row?.last_heartbeat_at ?? null,
    heartbeatIntervalMs: 30_000,
    staleAfterMs: PRESENCE_FRESH_MS,
  };
}

async function acquireMatchmakingLock(ownerToken: string, now: number) {
  const result = await getD1()
    .prepare(
      `UPDATE matchmaking_locks
       SET owner_token = ?1, lease_until = ?2
       WHERE name = ?3 AND lease_until <= ?4`,
    )
    .bind(ownerToken, now + MATCHMAKING_LOCK_LEASE_MS, MATCHMAKING_LOCK_NAME, now)
    .run();
  return Number(result.meta.changes ?? 0) === 1;
}

async function releaseMatchmakingLock(ownerToken: string) {
  await getD1()
    .prepare(
      `UPDATE matchmaking_locks SET owner_token = '', lease_until = 0
       WHERE name = ?1 AND owner_token = ?2`,
    )
    .bind(MATCHMAKING_LOCK_NAME, ownerToken)
    .run();
}

async function withMatchmakingLock<T>(operation: () => Promise<T>) {
  const ownerToken = crypto.randomUUID();
  const acquired = await acquireMatchmakingLock(ownerToken, Date.now());
  if (!acquired) throw new PlatformError("MATCHMAKING_BUSY", 503);
  try {
    return await operation();
  } finally {
    await releaseMatchmakingLock(ownerToken);
  }
}

async function queueRow(userId: string) {
  return getD1()
    .prepare(
      `SELECT user_id, ticket, mode, rating, status, match_id, created_at, updated_at
       FROM matchmaking_queue WHERE user_id = ?1`,
    )
    .bind(userId)
    .first<QueueRow>();
}

function matchmakingRatingRange(waitMs: number) {
  return Math.min(800, 100 + Math.floor(Math.max(0, waitMs) / 30_000) * 50);
}

async function matchWithOpponent(matchId: string, userId: string) {
  return getD1()
    .prepare(
      `SELECT m.id, m.mode, m.ranked, m.status, m.player_a_id, m.player_b_id,
              m.winner_user_id, m.ended_reason, m.rating_before_a, m.rating_before_b,
              m.rating_delta_a, m.rating_delta_b, m.game_code, m.created_at,
              m.started_at, m.completed_at, opponent.handle AS opponent_handle,
              opponent.rating AS opponent_rating
       FROM platform_matches m
       JOIN platform_users opponent
         ON opponent.id = CASE WHEN m.player_a_id = ?2 THEN m.player_b_id ELSE m.player_a_id END
       WHERE m.id = ?1 AND (m.player_a_id = ?2 OR m.player_b_id = ?2)`,
    )
    .bind(matchId, userId)
    .first<MatchWithOpponentRow>();
}

function matchPayload(match: MatchWithOpponentRow, userId: string) {
  return {
    id: match.id,
    mode: match.mode,
    ranked: Boolean(match.ranked),
    status: match.status,
    side: match.player_a_id === userId ? "black" : "white",
    opponent: {
      handle: match.opponent_handle,
      rating: match.opponent_rating,
      rank: rankForRating(match.opponent_rating),
    },
    game:
      match.game_code === null
        ? { status: "pending_provisioning" as const, code: null }
        : { status: "ready" as const, code: match.game_code },
    rules: {
      visibility: "ranked_redacted_spectators" as const,
      timeControl: RANKED_TIME_CONTROL,
    },
    createdAt: match.created_at,
    startedAt: match.started_at,
    completedAt: match.completed_at,
  };
}

export async function matchmakingStatus(userId: string) {
  const queue = await queueRow(userId);
  if (!queue || queue.status === "cancelled") return { state: "idle" as const };
  if (queue.status === "queued") {
    const now = Date.now();
    return {
      state: "queued" as const,
      mode: queue.mode,
      queuedAt: queue.created_at,
      ratingRange: matchmakingRatingRange(now - queue.created_at),
    };
  }
  if (!queue.match_id) throw new PlatformError("MATCHMAKING_STATE_INVALID", 500);
  const match = await matchWithOpponent(queue.match_id, userId);
  if (!match) throw new PlatformError("MATCH_NOT_FOUND", 404);
  return { state: "matched" as const, match: matchPayload(match, userId) };
}

export async function enqueueRankedMatch(user: PlatformUserRow) {
  await ensurePlatformSchema();
  return withMatchmakingLock(async () => {
    const existing = await queueRow(user.id);
    if (existing?.status === "matched") return matchmakingStatus(user.id);

    const now = Date.now();
    let current = existing;
    if (!current || current.status === "cancelled") {
      const ticket = crypto.randomUUID();
      await getD1()
        .prepare(
          `INSERT INTO matchmaking_queue (
            user_id, ticket, mode, rating, status, match_id, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, 'queued', NULL, ?5, ?5)
          ON CONFLICT(user_id) DO UPDATE SET
            ticket = excluded.ticket,
            mode = excluded.mode,
            rating = excluded.rating,
            status = 'queued',
            match_id = NULL,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at`,
        )
        .bind(user.id, ticket, RANKED_MATCH_MODE, user.rating, now)
        .run();
      current = await queueRow(user.id);
    }
    if (!current || current.status !== "queued") {
      throw new PlatformError("MATCHMAKING_STATE_INVALID", 500);
    }

    await getD1()
      .prepare(
        `INSERT INTO player_presence (user_id, status, current_match_id, last_heartbeat_at)
         VALUES (?1, 'searching', NULL, ?2)
         ON CONFLICT(user_id) DO UPDATE SET
           status = 'searching', current_match_id = NULL, last_heartbeat_at = excluded.last_heartbeat_at`,
      )
      .bind(user.id, now)
      .run();

    const candidates = await getD1()
      .prepare(
        `SELECT q.user_id, q.ticket, q.mode, q.rating, q.status, q.match_id,
                q.created_at, q.updated_at
         FROM matchmaking_queue q
         JOIN player_presence p ON p.user_id = q.user_id
         WHERE q.mode = ?1 AND q.status = 'queued' AND q.user_id <> ?2
           AND p.status = 'searching' AND p.last_heartbeat_at >= ?3
         ORDER BY q.created_at ASC
         LIMIT ?4`,
      )
      .bind(RANKED_MATCH_MODE, user.id, now - PRESENCE_FRESH_MS, MATCH_CANDIDATE_LIMIT)
      .all<QueueRow>();
    const compatible = candidates.results
      .filter((candidate: QueueRow) => {
        const allowedRange = Math.max(
          matchmakingRatingRange(now - current.created_at),
          matchmakingRatingRange(now - candidate.created_at),
        );
        return Math.abs(current.rating - candidate.rating) <= allowedRange;
      })
      .sort(
        (first: QueueRow, second: QueueRow) =>
          Math.abs(current.rating - first.rating) - Math.abs(current.rating - second.rating) ||
          first.created_at - second.created_at,
      )[0];

    if (!compatible) return matchmakingStatus(user.id);

    const currentFirst = crypto.getRandomValues(new Uint8Array(1))[0] % 2 === 0;
    const playerA = currentFirst ? current : compatible;
    const playerB = currentFirst ? compatible : current;
    const matchId = crypto.randomUUID();
    const results = await getD1().batch([
      getD1()
        .prepare(
          `INSERT INTO platform_matches (
            id, mode, ranked, status, player_a_id, player_b_id,
            rating_before_a, rating_before_b, created_at
          ) VALUES (?1, ?2, 1, 'matched', ?3, ?4, ?5, ?6, ?7)`,
        )
        .bind(matchId, RANKED_MATCH_MODE, playerA.user_id, playerB.user_id, playerA.rating, playerB.rating, now),
      getD1()
        .prepare(
          `UPDATE matchmaking_queue SET status = 'matched', match_id = ?1, updated_at = ?2
           WHERE user_id = ?3 AND status = 'queued'`,
        )
        .bind(matchId, now, current.user_id),
      getD1()
        .prepare(
          `UPDATE matchmaking_queue SET status = 'matched', match_id = ?1, updated_at = ?2
           WHERE user_id = ?3 AND status = 'queued'`,
        )
        .bind(matchId, now, compatible.user_id),
      getD1()
        .prepare(
          `INSERT INTO player_presence (user_id, status, current_match_id, last_heartbeat_at)
           VALUES (?1, 'in_game', ?2, ?3)
           ON CONFLICT(user_id) DO UPDATE SET
             status = 'in_game', current_match_id = excluded.current_match_id,
             last_heartbeat_at = excluded.last_heartbeat_at`,
        )
        .bind(current.user_id, matchId, now),
      getD1()
        .prepare(
          `INSERT INTO player_presence (user_id, status, current_match_id, last_heartbeat_at)
           VALUES (?1, 'in_game', ?2, ?3)
           ON CONFLICT(user_id) DO UPDATE SET
             status = 'in_game', current_match_id = excluded.current_match_id,
             last_heartbeat_at = excluded.last_heartbeat_at`,
        )
        .bind(compatible.user_id, matchId, now),
    ]);
    if (
      Number(results[1].meta.changes ?? 0) !== 1 ||
      Number(results[2].meta.changes ?? 0) !== 1
    ) {
      throw new PlatformError("MATCHMAKING_CONFLICT", 409);
    }
    return matchmakingStatus(user.id);
  });
}

export async function cancelRankedMatchmaking(userId: string) {
  await ensurePlatformSchema();
  return withMatchmakingLock(async () => {
    const current = await queueRow(userId);
    if (!current || current.status === "cancelled") return { state: "idle" as const };
    if (current.status === "matched") throw new PlatformError("MATCH_ALREADY_FOUND", 409);
    const now = Date.now();
    await getD1().batch([
      getD1()
        .prepare(
          `UPDATE matchmaking_queue SET status = 'cancelled', match_id = NULL, updated_at = ?1
           WHERE user_id = ?2 AND status = 'queued'`,
        )
        .bind(now, userId),
      getD1()
        .prepare(
          `INSERT INTO player_presence (user_id, status, current_match_id, last_heartbeat_at)
           VALUES (?1, 'online', NULL, ?2)
           ON CONFLICT(user_id) DO UPDATE SET
             status = 'online', current_match_id = NULL,
             last_heartbeat_at = excluded.last_heartbeat_at`,
        )
        .bind(userId, now),
    ]);
    return { state: "idle" as const };
  });
}

function validGameCode(value: string) {
  return value.length >= 4 && value.length <= 64 && /^[A-Za-z0-9_-]+$/.test(value);
}

export async function createPrivateMatchRecord(input: {
  mode: PrivateMatchMode;
  blackUserId: string;
  whiteUserId: string;
  gameCode: string;
}) {
  await ensurePlatformSchema();
  if (!validGameCode(input.gameCode) || input.blackUserId === input.whiteUserId) {
    throw new PlatformError("INVALID_PRIVATE_MATCH");
  }
  const [black, white] = await Promise.all([
    userById(input.blackUserId),
    userById(input.whiteUserId),
  ]);
  if (!black || !white) throw new PlatformError("MATCH_PLAYER_NOT_FOUND", 404);
  const existing = await getD1()
    .prepare(
      `SELECT id, mode, ranked, status, player_a_id, player_b_id, winner_user_id,
              ended_reason, rating_before_a, rating_before_b, rating_delta_a,
              rating_delta_b, game_code, created_at, started_at, completed_at
       FROM platform_matches WHERE game_code = ?1`,
    )
    .bind(input.gameCode)
    .first<MatchRow>();
  if (existing) {
    if (
      existing.ranked ||
      existing.mode !== input.mode ||
      existing.player_a_id !== black.id ||
      existing.player_b_id !== white.id
    ) {
      throw new PlatformError("PRIVATE_MATCH_CONFLICT", 409);
    }
    return existing;
  }

  const matchId = crypto.randomUUID();
  const now = Date.now();
  try {
    await getD1()
      .prepare(
        `INSERT INTO platform_matches (
          id, mode, ranked, status, player_a_id, player_b_id,
          rating_before_a, rating_before_b, game_code, created_at, started_at
        ) VALUES (?1, ?2, 0, 'active', ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
      )
      .bind(
        matchId,
        input.mode,
        black.id,
        white.id,
        black.rating,
        white.rating,
        input.gameCode,
        now,
      )
      .run();
  } catch (error) {
    if (String(error).toLocaleLowerCase("en-US").includes("unique")) {
      throw new PlatformError("PRIVATE_MATCH_CONFLICT", 409);
    }
    throw error;
  }
  return {
    id: matchId,
    mode: input.mode,
    ranked: 0,
    status: "active" as const,
    player_a_id: black.id,
    player_b_id: white.id,
    game_code: input.gameCode,
    created_at: now,
    started_at: now,
  };
}

export async function provisionRankedMatch(
  matchId: string,
  provisioner: MatchGameProvisioner,
) {
  await ensurePlatformSchema();
  const match = await getD1()
    .prepare(
      `SELECT id, mode, ranked, status, player_a_id, player_b_id, winner_user_id,
              ended_reason, rating_before_a, rating_before_b, rating_delta_a,
              rating_delta_b, game_code, created_at, started_at, completed_at
       FROM platform_matches WHERE id = ?1`,
    )
    .bind(matchId)
    .first<MatchRow>();
  if (!match) throw new PlatformError("MATCH_NOT_FOUND", 404);
  if (match.game_code) return { gameCode: match.game_code };
  if (match.status !== "matched") throw new PlatformError("MATCH_NOT_PROVISIONABLE", 409);

  const result = await provisioner({
    matchId: match.id,
    mode: RANKED_MATCH_MODE,
    playerAId: match.player_a_id,
    playerBId: match.player_b_id,
    visibility: "ranked_redacted_spectators",
    timeControl: RANKED_TIME_CONTROL,
  });
  if (!validGameCode(result.gameCode)) throw new PlatformError("INVALID_PROVISIONED_GAME", 502);
  const now = Date.now();
  const update = await getD1()
    .prepare(
      `UPDATE platform_matches
       SET game_code = ?1, status = 'active', started_at = ?2
       WHERE id = ?3 AND status = 'matched' AND game_code IS NULL`,
    )
    .bind(result.gameCode, now, match.id)
    .run();
  if (Number(update.meta.changes ?? 0) !== 1) {
    const current = await getD1()
      .prepare("SELECT game_code FROM platform_matches WHERE id = ?1")
      .bind(match.id)
      .first<{ game_code: string | null }>();
    if (!current?.game_code) throw new PlatformError("MATCH_PROVISION_CONFLICT", 409);
    return { gameCode: current.game_code };
  }
  return result;
}

export type MatchEndReason = "flag_captured" | "no_moves" | "resignation" | "timeout" | "draw";

export async function recordRankedMatchResult(input: {
  matchId: string;
  winnerUserId: string | null;
  reason: MatchEndReason;
}) {
  await ensurePlatformSchema();
  return withMatchmakingLock(async () => {
    const match = await getD1()
      .prepare(
        `SELECT id, mode, ranked, status, player_a_id, player_b_id, winner_user_id,
                ended_reason, rating_before_a, rating_before_b, rating_delta_a,
                rating_delta_b, game_code, created_at, started_at, completed_at
         FROM platform_matches WHERE id = ?1`,
      )
      .bind(input.matchId)
      .first<MatchRow>();
    if (!match) throw new PlatformError("MATCH_NOT_FOUND", 404);
    if (match.status === "completed") return match;
    if (match.status !== "active" && match.status !== "matched") {
      throw new PlatformError("MATCH_NOT_COMPLETABLE", 409);
    }
    if (
      input.winnerUserId !== null &&
      input.winnerUserId !== match.player_a_id &&
      input.winnerUserId !== match.player_b_id
    ) {
      throw new PlatformError("INVALID_MATCH_WINNER");
    }
    if ((input.reason === "draw") !== (input.winnerUserId === null)) {
      throw new PlatformError("INVALID_MATCH_RESULT");
    }

    const [playerA, playerB] = await Promise.all([
      userById(match.player_a_id),
      userById(match.player_b_id),
    ]);
    if (!playerA || !playerB) throw new PlatformError("MATCH_PLAYER_NOT_FOUND", 500);
    const scoreA: 0 | 0.5 | 1 =
      input.winnerUserId === null ? 0.5 : input.winnerUserId === playerA.id ? 1 : 0;
    const ratings = calculateMatchRatings({
      ratingA: playerA.rating,
      ratingB: playerB.rating,
      rankedGamesA: playerA.ranked_games,
      rankedGamesB: playerB.ranked_games,
      scoreA,
    });
    const now = Date.now();
    await getD1().batch([
      getD1()
        .prepare(
          `UPDATE platform_users
           SET rating = ?1, ranked_games = ranked_games + 1,
               wins = wins + ?2, losses = losses + ?3, draws = draws + ?4,
               updated_at = ?5
           WHERE id = ?6`,
        )
        .bind(
          ratings.ratingA,
          scoreA === 1 ? 1 : 0,
          scoreA === 0 ? 1 : 0,
          scoreA === 0.5 ? 1 : 0,
          now,
          playerA.id,
        ),
      getD1()
        .prepare(
          `UPDATE platform_users
           SET rating = ?1, ranked_games = ranked_games + 1,
               wins = wins + ?2, losses = losses + ?3, draws = draws + ?4,
               updated_at = ?5
           WHERE id = ?6`,
        )
        .bind(
          ratings.ratingB,
          scoreA === 0 ? 1 : 0,
          scoreA === 1 ? 1 : 0,
          scoreA === 0.5 ? 1 : 0,
          now,
          playerB.id,
        ),
      getD1()
        .prepare(
          `UPDATE platform_matches
           SET status = 'completed', winner_user_id = ?1, ended_reason = ?2,
               rating_delta_a = ?3, rating_delta_b = ?4, completed_at = ?5
           WHERE id = ?6 AND status IN ('matched', 'active')`,
        )
        .bind(
          input.winnerUserId,
          input.reason,
          ratings.ratingA - playerA.rating,
          ratings.ratingB - playerB.rating,
          now,
          match.id,
        ),
      getD1()
        .prepare(
          `UPDATE matchmaking_queue
           SET status = 'cancelled', match_id = NULL, updated_at = ?1
           WHERE user_id IN (?2, ?3) AND match_id = ?4`,
        )
        .bind(now, playerA.id, playerB.id, match.id),
      getD1()
        .prepare(
          `UPDATE player_presence
           SET status = 'online', current_match_id = NULL, last_heartbeat_at = ?1
           WHERE user_id IN (?2, ?3) AND current_match_id = ?4`,
        )
        .bind(now, playerA.id, playerB.id, match.id),
    ]);
    return {
      matchId: match.id,
      winnerUserId: input.winnerUserId,
      ratingDeltaA: ratings.ratingA - playerA.rating,
      ratingDeltaB: ratings.ratingB - playerB.rating,
      completedAt: now,
    };
  });
}

export async function recordPrivateMatchResult(input: {
  matchId: string;
  winnerUserId: string | null;
  reason: MatchEndReason;
}) {
  await ensurePlatformSchema();
  return withMatchmakingLock(async () => {
    const match = await getD1()
      .prepare(
        `SELECT id, mode, ranked, status, player_a_id, player_b_id, winner_user_id,
                ended_reason, rating_before_a, rating_before_b, rating_delta_a,
                rating_delta_b, game_code, created_at, started_at, completed_at
         FROM platform_matches WHERE id = ?1`,
      )
      .bind(input.matchId)
      .first<MatchRow>();
    if (!match) throw new PlatformError("MATCH_NOT_FOUND", 404);
    if (match.ranked) throw new PlatformError("MATCH_REQUIRES_RANKED_SETTLEMENT", 409);
    if (match.status === "completed") return match;
    if (match.status !== "active") throw new PlatformError("MATCH_NOT_COMPLETABLE", 409);
    if (
      input.winnerUserId !== null &&
      input.winnerUserId !== match.player_a_id &&
      input.winnerUserId !== match.player_b_id
    ) {
      throw new PlatformError("INVALID_MATCH_WINNER");
    }
    if ((input.reason === "draw") !== (input.winnerUserId === null)) {
      throw new PlatformError("INVALID_MATCH_RESULT");
    }

    const blackWon = input.winnerUserId === match.player_a_id;
    const whiteWon = input.winnerUserId === match.player_b_id;
    const draw = input.winnerUserId === null;
    const now = Date.now();
    const results = await getD1().batch([
      getD1()
        .prepare(
          `UPDATE platform_users
           SET wins = wins + ?1, losses = losses + ?2, draws = draws + ?3, updated_at = ?4
           WHERE id = ?5`,
        )
        .bind(blackWon ? 1 : 0, whiteWon ? 1 : 0, draw ? 1 : 0, now, match.player_a_id),
      getD1()
        .prepare(
          `UPDATE platform_users
           SET wins = wins + ?1, losses = losses + ?2, draws = draws + ?3, updated_at = ?4
           WHERE id = ?5`,
        )
        .bind(whiteWon ? 1 : 0, blackWon ? 1 : 0, draw ? 1 : 0, now, match.player_b_id),
      getD1()
        .prepare(
          `UPDATE platform_matches
           SET status = 'completed', winner_user_id = ?1, ended_reason = ?2,
               rating_delta_a = 0, rating_delta_b = 0, completed_at = ?3
           WHERE id = ?4 AND status = 'active' AND ranked = 0`,
        )
        .bind(input.winnerUserId, input.reason, now, match.id),
    ]);
    if (
      Number(results[0].meta.changes ?? 0) !== 1 ||
      Number(results[1].meta.changes ?? 0) !== 1 ||
      Number(results[2].meta.changes ?? 0) !== 1
    ) {
      throw new PlatformError("MATCH_SETTLEMENT_CONFLICT", 409);
    }
    return {
      matchId: match.id,
      winnerUserId: input.winnerUserId,
      ratingDeltaA: 0,
      ratingDeltaB: 0,
      completedAt: now,
    };
  });
}
