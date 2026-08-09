import { createAugmentGame, createInitialGame, projectGame } from "../../../lib/game";
import {
  getOrCreatePlatformUser,
  PlatformError,
} from "../../../db/platform";
import { IdentityError, requireAuthenticatedIdentity } from "../../../lib/identity";
import {
  hasNonEmptyRequestBody,
  RequestBodyTooLargeError,
  readBoundedJson,
} from "../../../lib/request";
import {
  createOpaqueToken,
  createRoomCode,
  deleteExpiredRooms,
  enforceRoomCreationLimit,
  ensureRoomsSchema,
  formatRoomCode,
  hashToken,
  insertRoom,
  type GameMode,
  type SpectatorPolicy,
} from "../../../db/rooms";

const responseHeaders = {
  "Cache-Control": "no-store",
  Vary: "oai-authenticated-user-id, oai-authenticated-user-email",
};

function createError(error: unknown) {
  if (error instanceof IdentityError || error instanceof PlatformError) {
    return Response.json({ error: error.code }, { status: error.status, headers: responseHeaders });
  }
  if (error instanceof RequestBodyTooLargeError) {
    return Response.json({ error: error.message }, { status: 413, headers: responseHeaders });
  }
  return Response.json({ error: "ROOM_CREATE_FAILED" }, { status: 500, headers: responseHeaders });
}

export async function POST(request: Request) {
  try {
    await ensureRoomsSchema();
    const user = await getOrCreatePlatformUser(requireAuthenticatedIdentity(request));
    let gameMode: GameMode = "classic";
    let spectatorPolicy: SpectatorPolicy = "hidden";
    if (await hasNonEmptyRequestBody(request.clone())) {
      let parsed: unknown;
      try {
        parsed = await readBoundedJson(request, 1_024);
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) throw error;
        return Response.json({ error: "INVALID_REQUEST" }, { status: 400, headers: responseHeaders });
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return Response.json({ error: "INVALID_REQUEST" }, { status: 400, headers: responseHeaders });
      }
      const body = parsed as Record<string, unknown>;
      if (Object.keys(body).some((key) => key !== "gameMode" && key !== "spectatorPolicy")) {
        return Response.json({ error: "INVALID_REQUEST" }, { status: 400, headers: responseHeaders });
      }
      if (body.gameMode !== undefined && body.gameMode !== "classic" && body.gameMode !== "augment") {
        return Response.json({ error: "INVALID_GAME_MODE" }, { status: 400, headers: responseHeaders });
      }
      if (
        body.spectatorPolicy !== undefined &&
        body.spectatorPolicy !== "hidden" &&
        body.spectatorPolicy !== "full"
      ) {
        return Response.json(
          { error: "INVALID_SPECTATOR_POLICY" },
          { status: 400, headers: responseHeaders },
        );
      }
      gameMode = (body.gameMode ?? gameMode) as GameMode;
      spectatorPolicy = (body.spectatorPolicy ?? spectatorPolicy) as SpectatorPolicy;
    }
    try {
      await enforceRoomCreationLimit(user.id);
    } catch (error) {
      if (error instanceof Error && error.message === "ROOM_CREATE_RATE_LIMITED") {
        return Response.json(
          { error: error.message },
          { status: 429, headers: { ...responseHeaders, "Retry-After": "3600" } },
        );
      }
      throw error;
    }
    await deleteExpiredRooms();
    const blackToken = createOpaqueToken();
    const whiteInviteToken = createOpaqueToken();
    const blackTokenHash = await hashToken(blackToken);
    const whiteInviteHash = await hashToken(whiteInviteToken);
    const state = gameMode === "augment" ? createAugmentGame() : createInitialGame();

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const code = createRoomCode();
      try {
        await insertRoom(code, blackTokenHash, whiteInviteHash, state, {
          roomKind: "custom",
          gameMode,
          spectatorPolicy,
          blackUserId: user.id,
        });
        return Response.json(
          {
            code,
            displayCode: formatRoomCode(code),
            version: 0,
            viewer: "black",
            snapshot: projectGame(state, "black"),
            roomKind: "custom",
            gameMode,
            spectatorPolicy,
            playerToken: blackToken,
            opponentInviteToken: whiteInviteToken,
          },
          { status: 201, headers: responseHeaders },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (!message.toLowerCase().includes("unique")) throw error;
      }
    }
    return Response.json({ error: "ROOM_CODE_UNAVAILABLE" }, { status: 503, headers: responseHeaders });
  } catch (error) {
    return createError(error);
  }
}
