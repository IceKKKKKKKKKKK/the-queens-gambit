import { env } from "cloudflare:workers";
import {
  AUGMENT_RULES_VERSION,
  DEFAULT_TIME_CONTROL_MINUTES,
  FIFTY_CARD_AUGMENT_RULES_VERSION,
  LEGACY_AUGMENT_RULES_VERSION,
  MAX_TIME_CONTROL_MINUTES,
  MIN_TIME_CONTROL_MINUTES,
  RULES_VERSION,
  isValidAugmentRuleStateForState,
  isValidRepetitionTrackerForState,
  type GameState,
  type Side,
  type Viewer,
} from "../lib/game";
import {
  recordPrivateMatchResult,
  recordRankedMatchResult,
  type MatchEndReason,
} from "./platform";

export interface RoomRow {
  code: string;
  black_token_hash: string;
  white_token_hash: string;
  white_invite_hash: string;
  state_json: string;
  version: number;
  created_at: number;
  updated_at: number;
  expires_at: number;
  room_kind: RoomKind;
  game_mode: GameMode;
  spectator_policy: SpectatorPolicy;
  black_user_id: string;
  white_user_id: string;
  match_id: string;
  result_recorded: number;
}

export type RoomKind = "custom" | "ranked";
export type GameMode = "classic" | "augment";
export type SpectatorPolicy = "hidden" | "full";

export interface RoomOptions {
  roomKind?: RoomKind;
  gameMode?: GameMode;
  spectatorPolicy?: SpectatorPolicy;
  blackUserId?: string;
  whiteUserId?: string;
  matchId?: string;
}

const ROOM_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const ROOM_CREATE_WINDOW_MS = 60 * 60 * 1000;
const ROOM_CREATE_LIMIT = 20;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
let roomsSchemaPromise: Promise<void> | null = null;

function getD1() {
  if (!env.DB) throw new Error("D1 binding DB is unavailable");
  return env.DB;
}

async function initializeRoomsSchema() {
  const db = getD1();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS games (
        code TEXT PRIMARY KEY NOT NULL,
        black_token_hash TEXT NOT NULL,
        white_token_hash TEXT NOT NULL,
        white_invite_hash TEXT NOT NULL,
        state_json TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        room_kind TEXT NOT NULL DEFAULT 'custom',
        game_mode TEXT NOT NULL DEFAULT 'classic',
        spectator_policy TEXT NOT NULL DEFAULT 'hidden',
        black_user_id TEXT NOT NULL DEFAULT '',
        white_user_id TEXT NOT NULL DEFAULT '',
        match_id TEXT NOT NULL DEFAULT '',
        result_recorded INTEGER NOT NULL DEFAULT 0
      )`,
    )
    .run();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS room_creation_limits (
        key_hash TEXT PRIMARY KEY NOT NULL,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 0
      )`,
    )
    .run();
  await db.prepare("CREATE INDEX IF NOT EXISTS games_expires_at_idx ON games(expires_at)").run();
  const columns = await db.prepare("PRAGMA table_info(games)").all<{ name: string }>();
  if (!columns.results.some((column: { name: string }) => column.name === "white_invite_hash")) {
    await db.prepare("ALTER TABLE games ADD COLUMN white_invite_hash TEXT NOT NULL DEFAULT ''").run();
  }
  const columnNames = new Set(columns.results.map((column: { name: string }) => column.name));
  const additions = [
    ["room_kind", "TEXT NOT NULL DEFAULT 'custom'"],
    ["game_mode", "TEXT NOT NULL DEFAULT 'classic'"],
    ["spectator_policy", "TEXT NOT NULL DEFAULT 'hidden'"],
    ["black_user_id", "TEXT NOT NULL DEFAULT ''"],
    ["white_user_id", "TEXT NOT NULL DEFAULT ''"],
    ["match_id", "TEXT NOT NULL DEFAULT ''"],
    ["result_recorded", "INTEGER NOT NULL DEFAULT 0"],
  ] as const;
  for (const [name, definition] of additions) {
    if (!columnNames.has(name)) {
      await db.prepare(`ALTER TABLE games ADD COLUMN ${name} ${definition}`).run();
    }
  }
  await db.prepare("CREATE INDEX IF NOT EXISTS games_match_id_idx ON games(match_id)").run();
}

export async function ensureRoomsSchema() {
  roomsSchemaPromise ??= initializeRoomsSchema();
  try {
    await roomsSchemaPromise;
  } catch (error) {
    roomsSchemaPromise = null;
    throw error;
  }
}

export function normalizeRoomCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 8);
}

export function formatRoomCode(value: string) {
  const normalized = normalizeRoomCode(value);
  return normalized.length > 4 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : normalized;
}

export function createOpaqueToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function createRoomCode() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

export async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function enforceRoomCreationLimit(identifier: string) {
  await ensureRoomsSchema();
  const db = getD1();
  const now = Date.now();
  const windowStart = Math.floor(now / ROOM_CREATE_WINDOW_MS) * ROOM_CREATE_WINDOW_MS;
  const keyHash = await hashToken(`room-create:${identifier}`);
  await db
    .prepare(
      `INSERT OR IGNORE INTO room_creation_limits (key_hash, window_start, count)
       VALUES (?1, ?2, 0)`,
    )
    .bind(keyHash, windowStart)
    .run();
  const result = await db
    .prepare(
      `UPDATE room_creation_limits
       SET window_start = CASE WHEN window_start <> ?2 THEN ?2 ELSE window_start END,
           count = CASE WHEN window_start <> ?2 THEN 1 ELSE count + 1 END
       WHERE key_hash = ?1 AND (window_start <> ?2 OR count < ?3)`,
    )
    .bind(keyHash, windowStart, ROOM_CREATE_LIMIT)
    .run();
  if (Number(result.meta.changes ?? 0) !== 1) throw new Error("ROOM_CREATE_RATE_LIMITED");
}

export async function insertRoom(
  code: string,
  blackTokenHash: string,
  whiteInviteHash: string,
  state: GameState,
  options: RoomOptions = {},
) {
  await ensureRoomsSchema();
  const now = Date.now();
  const roomKind = options.roomKind ?? "custom";
  const gameMode = options.gameMode ?? "classic";
  const spectatorPolicy = options.spectatorPolicy ?? "hidden";
  await getD1()
    .prepare(
      `INSERT INTO games (
        code, black_token_hash, white_token_hash, white_invite_hash, state_json, version,
        created_at, updated_at, expires_at, room_kind, game_mode, spectator_policy,
        black_user_id, white_user_id, match_id, result_recorded
      ) VALUES (?1, ?2, '', ?3, ?4, 0, ?5, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0)`,
    )
    .bind(
      code,
      blackTokenHash,
      whiteInviteHash,
      JSON.stringify(state),
      now,
      now + ROOM_LIFETIME_MS,
      roomKind,
      gameMode,
      spectatorPolicy,
      options.blackUserId ?? "",
      options.whiteUserId ?? "",
      options.matchId ?? "",
    )
    .run();
}

export async function deleteExpiredRooms() {
  await ensureRoomsSchema();
  const db = getD1();
  const now = Date.now();
  await db.prepare("DELETE FROM games WHERE expires_at <= ?1").bind(now).run();
  await db
    .prepare("DELETE FROM room_creation_limits WHERE window_start < ?1")
    .bind(now - 24 * ROOM_CREATE_WINDOW_MS)
    .run();
}

export async function getRoom(code: string) {
  await ensureRoomsSchema();
  return getD1()
    .prepare(
      `SELECT code, black_token_hash, white_token_hash, white_invite_hash, state_json, version, created_at, updated_at, expires_at,
              room_kind, game_mode, spectator_policy, black_user_id, white_user_id, match_id, result_recorded
       FROM games WHERE code = ?1`,
    )
    .bind(normalizeRoomCode(code))
    .first<RoomRow>();
}

export function roomSideForUser(row: RoomRow, userId: string | null): Side | null {
  if (!userId) return null;
  if (row.black_user_id && row.black_user_id === userId) return "black";
  if (row.white_user_id && row.white_user_id === userId) return "white";
  return null;
}

export async function viewerForAuthenticatedUser(
  row: RoomRow,
  userId: string,
  token: string | null,
): Promise<Viewer> {
  const identitySide = roomSideForUser(row, userId);
  if (!token) return identitySide ?? "spectator";

  const tokenSide = await viewerForToken(row, token);
  if (!isPlayer(tokenSide)) return identitySide ?? "spectator";
  if (identitySide && identitySide !== tokenSide) {
    throw new Error("ROOM_IDENTITY_CONFLICT");
  }
  const assignedUserId = tokenSide === "black" ? row.black_user_id : row.white_user_id;
  if (assignedUserId && assignedUserId !== userId) {
    throw new Error("ROOM_IDENTITY_CONFLICT");
  }
  if (!assignedUserId && !(await attachRoomUser(row, tokenSide, userId))) {
    throw new Error("ROOM_IDENTITY_CONFLICT");
  }
  return tokenSide;
}

export async function rankedSpectatorPerspective(row: RoomRow, userId: string): Promise<Side> {
  if (row.room_kind !== "ranked" || !row.black_user_id || !row.white_user_id) {
    throw new Error("RANKED_SPECTATOR_FORBIDDEN");
  }
  const relationship = await getD1()
    .prepare(
      `SELECT CASE
         WHEN user_low_id = ?1 THEN user_high_id
         ELSE user_low_id
       END AS friend_user_id
       FROM friendships
       WHERE status = 'accepted'
         AND (user_low_id = ?1 OR user_high_id = ?1)
         AND (user_low_id IN (?2, ?3) OR user_high_id IN (?2, ?3))
       ORDER BY CASE
         WHEN user_low_id = ?1 THEN user_high_id
         ELSE user_low_id
       END ASC
       LIMIT 1`,
    )
    .bind(userId, row.black_user_id, row.white_user_id)
    .first<{ friend_user_id: string }>();
  if (!relationship) throw new Error("RANKED_SPECTATOR_FORBIDDEN");
  if (relationship.friend_user_id === row.black_user_id) return "black";
  if (relationship.friend_user_id === row.white_user_id) return "white";
  throw new Error("RANKED_SPECTATOR_FORBIDDEN");
}

export async function attachRoomUser(row: RoomRow, side: Side, userId: string) {
  const column = side === "black" ? "black_user_id" : "white_user_id";
  const otherColumn = side === "black" ? "white_user_id" : "black_user_id";
  const result = await getD1()
    .prepare(
      `UPDATE games SET ${column} = ?1
       WHERE code = ?2 AND (${column} = '' OR ${column} = ?1) AND ${otherColumn} <> ?1`,
    )
    .bind(userId, row.code)
    .run();
  return Number(result.meta.changes ?? 0) === 1;
}

export async function attachRoomMatch(code: string, matchId: string) {
  const result = await getD1()
    .prepare(
      `UPDATE games SET match_id = ?1
       WHERE code = ?2 AND (match_id = '' OR match_id = ?1)`,
    )
    .bind(matchId, normalizeRoomCode(code))
    .run();
  return Number(result.meta.changes ?? 0) === 1;
}

export async function markRoomResultRecorded(code: string) {
  const result = await getD1()
    .prepare("UPDATE games SET result_recorded = 1 WHERE code = ?1 AND result_recorded = 0")
    .bind(normalizeRoomCode(code))
    .run();
  return Number(result.meta.changes ?? 0) === 1;
}

function platformEndReason(state: GameState): MatchEndReason {
  if (state.finishReason === "resign") return "resignation";
  if (state.finishReason === "timeout") return "timeout";
  if (state.finishReason === "no_moves") return "no_moves";
  if (state.finishReason === "draw" && state.drawReason === "threefold_repetition") {
    return "threefold_repetition";
  }
  if (state.finishReason === "draw" || state.winner === null) return "draw";
  return "flag_captured";
}

export async function ensureRoomResultRecorded(row: RoomRow, state: GameState) {
  if (row.result_recorded || state.phase !== "finished" || !row.match_id) return false;
  const winnerUserId =
    state.winner === "black"
      ? row.black_user_id || null
      : state.winner === "white"
        ? row.white_user_id || null
        : null;
  if (state.winner && !winnerUserId) return false;
  const input = {
    matchId: row.match_id,
    winnerUserId,
    reason: platformEndReason(state),
  };
  if (row.room_kind === "ranked") await recordRankedMatchResult(input);
  else await recordPrivateMatchResult(input);
  await markRoomResultRecorded(row.code);
  return true;
}

export function parseRoomState(row: RoomRow) {
  const state = JSON.parse(row.state_json) as GameState & {
    noCombatPly?: number;
    replay?: GameState["replay"];
    clock?: GameState["clock"];
  };
  // Preserve the version that authored this room. Only truly legacy rows that
  // predate versioning are assigned the classic baseline.
  if (state.rulesVersion === undefined) {
    state.rulesVersion = RULES_VERSION;
  }
  if (
    typeof state.rulesVersion !== "string" ||
    (state.rulesVersion !== RULES_VERSION &&
      state.rulesVersion !== LEGACY_AUGMENT_RULES_VERSION &&
      state.rulesVersion !== FIFTY_CARD_AUGMENT_RULES_VERSION &&
      state.rulesVersion !== AUGMENT_RULES_VERSION)
  ) {
    throw new Error("INVALID_RULES_VERSION");
  }
  state.replay ??= null;
  if (state.clock === undefined) {
    if (state.phase === "setup") {
      const initialMs = DEFAULT_TIME_CONTROL_MINUTES * 60 * 1000;
      state.clock = {
        initialMs,
        remainingMs: { black: initialMs, white: initialMs },
        turnStartedAt: null,
      };
    } else {
      // Games already in progress before clocks were introduced remain untimed.
      state.clock = null;
    }
  } else if (state.clock) {
    const minimumMs = MIN_TIME_CONTROL_MINUTES * 60 * 1000;
    const maximumMs = MAX_TIME_CONTROL_MINUTES * 60 * 1000;
    const initialMs = Number.isFinite(state.clock.initialMs)
      ? Math.min(maximumMs, Math.max(minimumMs, Math.round(state.clock.initialMs)))
      : DEFAULT_TIME_CONTROL_MINUTES * 60 * 1000;
    state.clock.initialMs = initialMs;
    const normalizedRemaining = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value)
        ? Math.min(initialMs + 10 * 60 * 1000, Math.max(0, value))
        : initialMs;
    state.clock.remainingMs = {
      black: normalizedRemaining(state.clock.remainingMs?.black),
      white: normalizedRemaining(state.clock.remainingMs?.white),
    };
    state.clock.turnStartedAt = Number.isFinite(state.clock.turnStartedAt)
      ? state.clock.turnStartedAt
      : null;
    // Ranked rooms persisted before uncapped threshold increments did not carry
    // an explicit cap. Preserve their in-progress time control, while new rooms
    // serialize `null` to opt into the current full +5-second rule.
    if (
      typeof state.clock.incrementMs === "number" &&
      typeof state.clock.incrementThresholdMs === "number" &&
      state.clock.incrementCapMs === undefined
    ) {
      state.clock.incrementCapMs = state.clock.incrementThresholdMs;
    }
    if (state.phase !== "playing") state.clock.turnStartedAt = null;
  }
  if (state.augment) {
    state.augment.draftDeadlineAt =
      state.phase === "augment_draft" &&
      typeof state.augment.draftDeadlineAt === "number" &&
      Number.isFinite(state.augment.draftDeadlineAt)
        ? state.augment.draftDeadlineAt
        : null;
  }
  if (
    state.rulesVersion === FIFTY_CARD_AUGMENT_RULES_VERSION ||
    state.rulesVersion === AUGMENT_RULES_VERSION
  ) {
    if (
      state.drawReason !== undefined &&
      state.drawReason !== null &&
      state.drawReason !== "threefold_repetition"
    ) {
      throw new Error("INVALID_REPETITION_TRACKER");
    }
    state.drawReason ??= null;
    if (
      state.drawReason === "threefold_repetition" &&
      (state.phase !== "finished" || state.finishReason !== "draw" || state.winner !== null)
    ) {
      throw new Error("INVALID_REPETITION_TRACKER");
    }
    if (!isValidRepetitionTrackerForState(state)) {
      throw new Error("INVALID_REPETITION_TRACKER");
    }
  } else {
    state.drawReason = null;
    delete state.repetitionTracker;
  }
  if (!isValidAugmentRuleStateForState(state)) {
    throw new Error("INVALID_AUGMENT_RULE_STATE");
  }
  delete state.noCombatPly;
  return state as GameState;
}

export async function viewerForToken(row: RoomRow, token: string | null): Promise<Viewer> {
  if (!token) return "spectator";
  const tokenHash = await hashToken(token);
  if (tokenHash === row.black_token_hash) return "black";
  if (row.white_token_hash && tokenHash === row.white_token_hash) return "white";
  throw new Error("INVALID_PLAYER_TOKEN");
}

export function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+([A-Za-z0-9_-]{20,128})$/i);
  return match?.[1] ?? null;
}

export async function updateRoomState(
  row: RoomRow,
  nextState: GameState,
  expectedVersion: number,
) {
  const now = Date.now();
  const result = await getD1()
    .prepare(
      `UPDATE games
       SET state_json = ?1, version = version + 1, updated_at = ?2, expires_at = ?3
       WHERE code = ?4 AND version = ?5 AND expires_at > ?2`,
    )
    .bind(JSON.stringify(nextState), now, now + ROOM_LIFETIME_MS, row.code, expectedVersion)
    .run();
  return Number(result.meta.changes ?? 0) === 1;
}

export async function claimWhiteSeat(
  row: RoomRow,
  inviteToken: string,
  playerToken: string,
  whiteUserId: string,
) {
  if (inviteToken === playerToken) throw new Error("INVALID_INVITE_TOKEN");
  if (!whiteUserId || row.black_user_id === whiteUserId) {
    throw new Error("ROOM_IDENTITY_CONFLICT");
  }
  const playerTokenHash = await hashToken(playerToken);
  if (row.white_token_hash && row.white_token_hash === row.black_token_hash) {
    throw new Error("ROOM_IDENTITY_CONFLICT");
  }
  if (row.white_token_hash) {
    if (row.white_token_hash === playerTokenHash) {
      if (row.white_user_id && row.white_user_id !== whiteUserId) {
        throw new Error("ROOM_IDENTITY_CONFLICT");
      }
      if (!row.white_user_id && !(await attachRoomUser(row, "white", whiteUserId))) {
        throw new Error("ROOM_IDENTITY_CONFLICT");
      }
      return { playerToken, state: parseRoomState(row), version: row.version };
    }
    throw new Error("SEAT_ALREADY_CLAIMED");
  }
  const inviteHash = await hashToken(inviteToken);
  if (!row.white_invite_hash || inviteHash !== row.white_invite_hash) {
    throw new Error("INVALID_INVITE_TOKEN");
  }
  if (playerTokenHash === row.black_token_hash) throw new Error("TOKEN_ALREADY_IN_USE");
  const state = parseRoomState(row);
  state.joined.white = true;
  const now = Date.now();
  const result = await getD1()
    .prepare(
      `UPDATE games
       SET white_token_hash = ?1, white_invite_hash = '', white_user_id = ?2, state_json = ?3,
           version = version + 1, updated_at = ?4, expires_at = ?5
       WHERE code = ?6 AND version = ?7 AND white_token_hash = '' AND white_invite_hash = ?8
         AND (white_user_id = '' OR white_user_id = ?2) AND black_user_id <> ?2
         AND expires_at > ?4`,
    )
    .bind(
      playerTokenHash,
      whiteUserId,
      JSON.stringify(state),
      now,
      now + ROOM_LIFETIME_MS,
      row.code,
      row.version,
      row.white_invite_hash,
    )
    .run();
  if (Number(result.meta.changes ?? 0) !== 1) throw new Error("VERSION_CONFLICT");
  return { playerToken, state, version: row.version + 1 };
}

export function isExpiredRoom(row: RoomRow) {
  return row.expires_at <= Date.now();
}

export function isPlayer(viewer: Viewer): viewer is Side {
  return viewer === "black" || viewer === "white";
}
