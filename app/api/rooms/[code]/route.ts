import { projectGame } from "../../../../lib/game";
import {
  bearerToken,
  getRoom,
  isExpiredRoom,
  normalizeRoomCode,
  parseRoomState,
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

    const sinceValue = new URL(request.url).searchParams.get("since");
    const since = sinceValue === null ? null : Number(sinceValue);
    if (since !== null && Number.isInteger(since) && since === row.version) {
      return new Response(null, { status: 204, headers: responseHeaders });
    }

    return Response.json(
      {
        code: row.code,
        version: row.version,
        viewer,
        snapshot: projectGame(parseRoomState(row), viewer),
      },
      { headers: responseHeaders },
    );
  } catch {
    return Response.json({ error: "ROOM_READ_FAILED" }, { status: 500, headers: responseHeaders });
  }
}
