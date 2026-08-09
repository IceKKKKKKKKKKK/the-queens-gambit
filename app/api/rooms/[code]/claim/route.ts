import { projectGame } from "../../../../../lib/game";
import {
  createPrivateMatchRecord,
  getOrCreatePlatformUser,
  PlatformError,
} from "../../../../../db/platform";
import { IdentityError, requireAuthenticatedIdentity } from "../../../../../lib/identity";
import { RequestBodyTooLargeError, readBoundedJson } from "../../../../../lib/request";
import {
  attachRoomMatch,
  claimWhiteSeat,
  getRoom,
  isExpiredRoom,
  normalizeRoomCode,
} from "../../../../../db/rooms";

const responseHeaders = {
  "Cache-Control": "no-store",
  Vary: "oai-authenticated-user-id, oai-authenticated-user-email",
};

export async function POST(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  try {
    const user = await getOrCreatePlatformUser(requireAuthenticatedIdentity(request));
    const { code: rawCode } = await context.params;
    const code = normalizeRoomCode(rawCode);
    const row = await getRoom(code);
    if (!row) return Response.json({ error: "ROOM_NOT_FOUND" }, { status: 404, headers: responseHeaders });
    if (isExpiredRoom(row)) {
      return Response.json({ error: "ROOM_EXPIRED" }, { status: 410, headers: responseHeaders });
    }
    if (row.room_kind === "ranked") {
      return Response.json({ error: "RANKED_ROOM_CLAIM_FORBIDDEN" }, { status: 409, headers: responseHeaders });
    }
    if (row.black_user_id === user.id) {
      return Response.json({ error: "ROOM_IDENTITY_CONFLICT" }, { status: 409, headers: responseHeaders });
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
      const claimed = await claimWhiteSeat(row, body.inviteToken, body.playerToken, user.id);
      let matchId = row.match_id;
      if (!matchId && row.black_user_id) {
        const match = await createPrivateMatchRecord({
          mode: row.game_mode === "augment" ? "hex_private" : "classic_private",
          blackUserId: row.black_user_id,
          whiteUserId: user.id,
          gameCode: row.code,
        });
        matchId = match.id;
        if (!(await attachRoomMatch(row.code, matchId))) {
          throw new PlatformError("PRIVATE_MATCH_CONFLICT", 409);
        }
      }
      return Response.json(
        {
          code: row.code,
          version: claimed.version,
          viewer: "white",
          snapshot: projectGame(claimed.state, "white"),
          roomKind: row.room_kind,
          gameMode: row.game_mode,
          spectatorPolicy: row.spectator_policy,
          matchId: matchId || null,
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
  } catch (error) {
    if (error instanceof IdentityError || error instanceof PlatformError) {
      return Response.json({ error: error.code }, { status: error.status, headers: responseHeaders });
    }
    return Response.json({ error: "CLAIM_FAILED" }, { status: 500, headers: responseHeaders });
  }
}
