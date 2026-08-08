import { projectGame, settleExpiredClock } from "../../../../lib/game";
import {
  bearerToken,
  getRoom,
  isExpiredRoom,
  normalizeRoomCode,
  parseRoomState,
  updateRoomState,
  viewerForToken,
} from "../../../../db/rooms";

const responseHeaders = {
  "Cache-Control": "no-store",
  Vary: "Authorization",
};

export async function GET(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  try {
    const { code: rawCode } = await context.params;
    const code = normalizeRoomCode(rawCode);
    const row = await getRoom(code);
    if (!row) return Response.json({ error: "ROOM_NOT_FOUND" }, { status: 404, headers: responseHeaders });
    if (isExpiredRoom(row)) {
      return Response.json({ error: "ROOM_EXPIRED" }, { status: 410, headers: responseHeaders });
    }

    const authorizationPresent = request.headers.has("authorization");
    const token = bearerToken(request);
    if (authorizationPresent && !token) {
      return Response.json({ error: "INVALID_PLAYER_TOKEN" }, { status: 401, headers: responseHeaders });
    }

    let viewer;
    try {
      viewer = await viewerForToken(row, token);
    } catch {
      return Response.json({ error: "INVALID_PLAYER_TOKEN" }, { status: 401, headers: responseHeaders });
    }

    let activeRow = row;
    let state = parseRoomState(activeRow);
    let nowMs = Date.now();
    let clockStateResolved = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!settleExpiredClock(state, nowMs)) {
        clockStateResolved = true;
        break;
      }
      if (await updateRoomState(activeRow, state, activeRow.version)) {
        activeRow = { ...activeRow, version: activeRow.version + 1 };
        clockStateResolved = true;
        break;
      }
      const refreshed = await getRoom(code);
      if (!refreshed || isExpiredRoom(refreshed)) {
        return Response.json(
          { error: refreshed ? "ROOM_EXPIRED" : "ROOM_NOT_FOUND" },
          { status: refreshed ? 410 : 404, headers: responseHeaders },
        );
      }
      activeRow = refreshed;
      state = parseRoomState(activeRow);
      nowMs = Date.now();
    }
    if (!clockStateResolved) {
      return Response.json(
        { error: "VERSION_CONFLICT" },
        { status: 409, headers: responseHeaders },
      );
    }

    const sinceValue = new URL(request.url).searchParams.get("since");
    const since = sinceValue === null ? null : Number(sinceValue);
    if (
      state.phase !== "playing" &&
      since !== null &&
      Number.isInteger(since) &&
      since === activeRow.version
    ) {
      return new Response(null, { status: 204, headers: responseHeaders });
    }

    return Response.json(
      {
        code: activeRow.code,
        version: activeRow.version,
        viewer,
        snapshot: projectGame(state, viewer, nowMs),
      },
      { headers: responseHeaders },
    );
  } catch {
    return Response.json({ error: "ROOM_READ_FAILED" }, { status: 500, headers: responseHeaders });
  }
}
