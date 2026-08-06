import {
  applyPlayerAction,
  GameRuleError,
  projectGame,
  type PlayerAction,
  type Position,
  type SetupPlacement,
} from "../../../../../lib/game";
import { RequestBodyTooLargeError, readBoundedJson } from "../../../../../lib/request";
import {
  bearerToken,
  getRoom,
  isExpiredRoom,
  isPlayer,
  normalizeRoomCode,
  parseRoomState,
  updateRoomState,
  viewerForToken,
} from "../../../../../db/rooms";

const responseHeaders = {
  "Cache-Control": "no-store",
  Vary: "Authorization",
};

function isPosition(value: unknown): value is Position {
  if (!value || typeof value !== "object") return false;
  const position = value as Record<string, unknown>;
  return Number.isInteger(position.row) && Number.isInteger(position.col);
}

function isSetupPlacement(value: unknown): value is SetupPlacement {
  if (!isPosition(value)) return false;
  const pieceId = (value as Position & { pieceId?: unknown }).pieceId;
  return (
    typeof pieceId === "string" &&
    pieceId.length >= 1 &&
    pieceId.length <= 96 &&
    /^[A-Za-z0-9_-]+$/.test(pieceId)
  );
}

function parseAction(value: unknown): PlayerAction | null {
  if (!value || typeof value !== "object") return null;
  const action = value as Record<string, unknown>;
  if (action.type === "randomize" || action.type === "resign") {
    return { type: action.type };
  }
  if (action.type === "ready" && typeof action.value === "boolean") {
    if (action.layout === undefined) return { type: "ready", value: action.value };
    if (!action.value || !Array.isArray(action.layout) || action.layout.length > 25) return null;
    if (!action.layout.every(isSetupPlacement)) return null;
    return { type: "ready", value: true, layout: action.layout };
  }
  if ((action.type === "swap" || action.type === "move") && isPosition(action.from) && isPosition(action.to)) {
    return { type: action.type, from: action.from, to: action.to };
  }
  return null;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  try {
    const token = bearerToken(request);
    if (!token) {
      return Response.json({ error: "PLAYER_TOKEN_REQUIRED" }, { status: 401, headers: responseHeaders });
    }

    const { code: rawCode } = await context.params;
    const code = normalizeRoomCode(rawCode);
    const row = await getRoom(code);
    if (!row) return Response.json({ error: "ROOM_NOT_FOUND" }, { status: 404, headers: responseHeaders });
    if (isExpiredRoom(row)) {
      return Response.json({ error: "ROOM_EXPIRED" }, { status: 410, headers: responseHeaders });
    }

    let viewer;
    try {
      viewer = await viewerForToken(row, token);
    } catch {
      return Response.json({ error: "INVALID_PLAYER_TOKEN" }, { status: 401, headers: responseHeaders });
    }
    if (!isPlayer(viewer)) {
      return Response.json({ error: "PLAYER_TOKEN_REQUIRED" }, { status: 401, headers: responseHeaders });
    }

    let body: Record<string, unknown>;
    try {
      const parsed = await readBoundedJson(request);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return Response.json({ error: "INVALID_REQUEST" }, { status: 400, headers: responseHeaders });
      }
      body = parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return Response.json({ error: error.message }, { status: 413, headers: responseHeaders });
      }
      return Response.json({ error: "INVALID_REQUEST" }, { status: 400, headers: responseHeaders });
    }
    const expectedVersion = body.expectedVersion;
    const action = parseAction(body.action);
    if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 0 || !action) {
      return Response.json({ error: "INVALID_REQUEST" }, { status: 400, headers: responseHeaders });
    }
    if (row.version !== expectedVersion) {
      return Response.json({ error: "VERSION_CONFLICT" }, { status: 409, headers: responseHeaders });
    }

    let nextState;
    try {
      nextState = applyPlayerAction(parseRoomState(row), viewer, action);
    } catch (error) {
      if (error instanceof GameRuleError) {
        return Response.json({ error: error.code }, { status: 422, headers: responseHeaders });
      }
      throw error;
    }

    const updated = await updateRoomState(row, nextState, expectedVersion as number);
    if (!updated) {
      return Response.json({ error: "VERSION_CONFLICT" }, { status: 409, headers: responseHeaders });
    }
    return Response.json(
      {
        code: row.code,
        version: (expectedVersion as number) + 1,
        viewer,
        snapshot: projectGame(nextState, viewer),
      },
      { headers: responseHeaders },
    );
  } catch {
    return Response.json({ error: "ACTION_FAILED" }, { status: 500, headers: responseHeaders });
  }
}
