import {
  cancelRankedMatchmaking,
  enqueueRankedMatch,
  getOrCreatePlatformUser,
  matchmakingStatus,
  PlatformError,
  provisionRankedMatch,
  RANKED_MATCH_MODE,
} from "../../../db/platform";
import {
  createOpaqueToken,
  getRoom,
  hashToken,
  insertRoom,
} from "../../../db/rooms";
import { createAugmentGame } from "../../../lib/game";
import { IdentityError, requireAuthenticatedIdentity } from "../../../lib/identity";
import {
  hasNonEmptyRequestBody,
  RequestBodyTooLargeError,
  readBoundedJson,
} from "../../../lib/request";
import { rejectCrossOriginMutation } from "../security";

const responseHeaders = {
  "Cache-Control": "no-store",
  Vary: "oai-authenticated-user-id, oai-authenticated-user-email",
};

function errorResponse(error: unknown) {
  if (error instanceof IdentityError || error instanceof PlatformError) {
    const headers =
      error instanceof PlatformError && error.code === "MATCHMAKING_BUSY"
        ? { ...responseHeaders, "Retry-After": "1" }
        : responseHeaders;
    return Response.json({ error: error.code }, { status: error.status, headers });
  }
  if (error instanceof RequestBodyTooLargeError) {
    return Response.json({ error: error.message }, { status: 413, headers: responseHeaders });
  }
  return Response.json({ error: "MATCHMAKING_FAILED" }, { status: 500, headers: responseHeaders });
}

async function authenticatedUser(request: Request) {
  return getOrCreatePlatformUser(requireAuthenticatedIdentity(request));
}

const RANKED_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

async function rankedRoomCode(matchId: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`ranked-room:${matchId}`)),
  );
  return Array.from(bytes.slice(0, 8), (byte) => RANKED_CODE_ALPHABET[byte % RANKED_CODE_ALPHABET.length]).join("");
}

async function provisionMatchedRoom<T extends { state: string; match?: { id: string; game: { status: string } } }>(
  userId: string,
  matchmakingState: T,
) {
  if (
    matchmakingState.state !== "matched" ||
    !matchmakingState.match ||
    matchmakingState.match.game.status !== "pending_provisioning"
  ) {
    return matchmakingState;
  }
  await provisionRankedMatch(matchmakingState.match.id, async (match) => {
    const code = await rankedRoomCode(match.matchId);
    const existing = await getRoom(code);
    if (existing) {
      if (
        existing.room_kind !== "ranked" ||
        existing.game_mode !== "augment" ||
        existing.match_id !== match.matchId ||
        existing.black_user_id !== match.playerAId ||
        existing.white_user_id !== match.playerBId
      ) {
        throw new PlatformError("MATCH_PROVISION_CONFLICT", 409);
      }
      return { gameCode: code };
    }

    const state = createAugmentGame({ ranked: true });
    state.joined.white = true;
    const blackTokenHash = await hashToken(createOpaqueToken());
    const whiteInviteHash = await hashToken(createOpaqueToken());
    try {
      await insertRoom(code, blackTokenHash, whiteInviteHash, state, {
        roomKind: "ranked",
        gameMode: "augment",
        spectatorPolicy: "hidden",
        blackUserId: match.playerAId,
        whiteUserId: match.playerBId,
        matchId: match.matchId,
      });
    } catch (error) {
      const concurrent = await getRoom(code);
      if (!concurrent || concurrent.match_id !== match.matchId) throw error;
    }
    return { gameCode: code };
  });
  return matchmakingStatus(userId);
}

export async function GET(request: Request) {
  try {
    const user = await authenticatedUser(request);
    const state = await matchmakingStatus(user.id);
    return Response.json(await provisionMatchedRoom(user.id, state), { headers: responseHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const originError = rejectCrossOriginMutation(request, responseHeaders);
    if (originError) return originError;
    const user = await authenticatedUser(request);
    if (await hasNonEmptyRequestBody(request.clone())) {
      const parsed = await readBoundedJson(request, 1_024);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return Response.json({ error: "INVALID_REQUEST" }, { status: 400, headers: responseHeaders });
      }
      const body = parsed as Record<string, unknown>;
      if (
        Object.keys(body).some((key) => key !== "mode") ||
        (body.mode !== undefined && body.mode !== RANKED_MATCH_MODE)
      ) {
        return Response.json({ error: "INVALID_REQUEST" }, { status: 400, headers: responseHeaders });
      }
    }
    const state = await enqueueRankedMatch(user);
    const provisioned = await provisionMatchedRoom(user.id, state);
    return Response.json(provisioned, {
      status: provisioned.state === "queued" ? 202 : 200,
      headers: responseHeaders,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const originError = rejectCrossOriginMutation(request, responseHeaders);
    if (originError) return originError;
    const user = await authenticatedUser(request);
    if (await hasNonEmptyRequestBody(request)) {
      return Response.json({ error: "INVALID_REQUEST" }, { status: 400, headers: responseHeaders });
    }
    return Response.json(await cancelRankedMatchmaking(user.id), { headers: responseHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}
