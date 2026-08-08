import { env } from "cloudflare:workers";
import {
  DEFAULT_TIME_CONTROL_MINUTES,
  MAX_TIME_CONTROL_MINUTES,
  MIN_TIME_CONTROL_MINUTES,
  RULES_VERSION,
  type GameState,
  type Side,
  type Viewer,
} from "../lib/game";

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
}

const ROOM_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const ROOM_CREATE_WINDOW_MS = 60 * 60 * 1000;
const ROOM_CREATE_LIMIT = 20;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function getD1() {
  if (!env.DB) throw new Error("D1 binding DB is unavailable");
  return env.DB;
}

export async function ensureRoomsSchema() {
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
        expires_at INTEGER NOT NULL
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
) {
  const now = Date.now();
  await getD1()
    .prepare(
      `INSERT INTO games (
        code, black_token_hash, white_token_hash, white_invite_hash, state_json, version, created_at, updated_at, expires_at
      ) VALUES (?1, ?2, '', ?3, ?4, 0, ?5, ?5, ?6)`,
    )
    .bind(code, blackTokenHash, whiteInviteHash, JSON.stringify(state), now, now + ROOM_LIFETIME_MS)
    .run();
}

export async function deleteExpiredRooms() {
  const db = getD1();
  const now = Date.now();
  await db.prepare("DELETE FROM games WHERE expires_at <= ?1").bind(now).run();
  await db
    .prepare("DELETE FROM room_creation_limits WHERE window_start < ?1")
    .bind(now - 24 * ROOM_CREATE_WINDOW_MS)
    .run();
}

export async function getRoom(code: string) {
  return getD1()
    .prepare(
      `SELECT code, black_token_hash, white_token_hash, white_invite_hash, state_json, version, created_at, updated_at, expires_at
       FROM games WHERE code = ?1`,
    )
    .bind(normalizeRoomCode(code))
    .first<RoomRow>();
}

export function parseRoomState(row: RoomRow) {
  const state = JSON.parse(row.state_json) as GameState & {
    noCombatPly?: number;
    replay?: GameState["replay"];
    clock?: GameState["clock"];
  };
  state.rulesVersion = RULES_VERSION;
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
        ? Math.min(initialMs, Math.max(0, value))
        : initialMs;
    state.clock.remainingMs = {
      black: normalizedRemaining(state.clock.remainingMs?.black),
      white: normalizedRemaining(state.clock.remainingMs?.white),
    };
    state.clock.turnStartedAt = Number.isFinite(state.clock.turnStartedAt)
      ? state.clock.turnStartedAt
      : null;
    if (state.phase !== "playing") state.clock.turnStartedAt = null;
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

export async function claimWhiteSeat(row: RoomRow, inviteToken: string, playerToken: string) {
  if (inviteToken === playerToken) throw new Error("INVALID_INVITE_TOKEN");
  const playerTokenHash = await hashToken(playerToken);
  if (row.white_token_hash && row.white_token_hash === row.black_token_hash) {
    throw new Error("ROOM_IDENTITY_CONFLICT");
  }
  if (row.white_token_hash) {
    if (row.white_token_hash === playerTokenHash) {
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
       SET white_token_hash = ?1, white_invite_hash = '', state_json = ?2,
           version = version + 1, updated_at = ?3, expires_at = ?4
       WHERE code = ?5 AND version = ?6 AND white_token_hash = '' AND white_invite_hash = ?7
         AND expires_at > ?3`,
    )
    .bind(
      playerTokenHash,
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
