import { projectGame } from "../../../../../lib/game";
import { RequestBodyTooLargeError, readBoundedJson } from "../../../../../lib/request";
import {
  claimWhiteSeat,
  getRoom,
  isExpiredRoom,
  normalizeRoomCode,
} from "../../../../../db/rooms";

const responseHeaders = {
  "Cache-Control": "no-store",
};

export async function POST(
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
    let parsedBody: unknown;
    try {
      parsedBody = await readBoundedJson(request);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return Response.json({ error: error.message }, { status: 413, headers: responseHeaders });
      }
      return Response.json({ error: "INVALID_REQUEST" }, { status: 400, headers: responseHeaders });
    }
    const body =
      parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)
        ? (parsedBody as { inviteToken?: unknown; playerToken?: unknown })
        : null;
    if (
      !body ||
      typeof body.inviteToken !== "string" ||
      typeof body.playerToken !== "string" ||
      !/^[A-Za-z0-9_-]{20,128}$/.test(body.inviteToken) ||
      !/^[A-Za-z0-9_-]{20,128}$/.test(body.playerToken) ||
      body.inviteToken === body.playerToken
    ) {
      return Response.json({ error: "INVALID_INVITE_TOKEN" }, { status: 400, headers: responseHeaders });
    }
    try {
      const claimed = await claimWhiteSeat(row, body.inviteToken, body.playerToken);
      return Response.json(
        {
          code: row.code,
          version: claimed.version,
          viewer: "white",
          snapshot: projectGame(claimed.state, "white"),
          playerToken: claimed.playerToken,
        },
        { headers: responseHeaders },
      );
    } catch (error) {
      const codeValue = error instanceof Error ? error.message : "CLAIM_FAILED";
      if (codeValue === "SEAT_ALREADY_CLAIMED") {
        return Response.json({ error: codeValue }, { status: 409, headers: responseHeaders });
      }
      if (codeValue === "TOKEN_ALREADY_IN_USE") {
        return Response.json({ error: codeValue }, { status: 409, headers: responseHeaders });
      }
      if (codeValue === "ROOM_IDENTITY_CONFLICT") {
        return Response.json({ error: codeValue }, { status: 409, headers: responseHeaders });
      }
      if (codeValue === "INVALID_INVITE_TOKEN") {
        return Response.json({ error: codeValue }, { status: 401, headers: responseHeaders });
      }
      if (codeValue === "VERSION_CONFLICT") {
        return Response.json({ error: codeValue }, { status: 409, headers: responseHeaders });
      }
      throw error;
    }
  } catch {
    return Response.json({ error: "CLAIM_FAILED" }, { status: 500, headers: responseHeaders });
  }
}
