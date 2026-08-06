import { createInitialGame, projectGame } from "../../../lib/game";
import {
  createOpaqueToken,
  createRoomCode,
  deleteExpiredRooms,
  enforceRoomCreationLimit,
  ensureRoomsSchema,
  formatRoomCode,
  hashToken,
  insertRoom,
} from "../../../db/rooms";

const responseHeaders = {
  "Cache-Control": "no-store",
};

export async function POST(request: Request) {
  try {
    await ensureRoomsSchema();
    const requester =
      request.headers.get("oai-authenticated-user-id") ??
      request.headers.get("cf-connecting-ip") ??
      "anonymous";
    try {
      await enforceRoomCreationLimit(requester);
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
    const state = createInitialGame();

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const code = createRoomCode();
      try {
        await insertRoom(code, blackTokenHash, whiteInviteHash, state);
        return Response.json(
          {
            code,
            displayCode: formatRoomCode(code),
            version: 0,
            viewer: "black",
            snapshot: projectGame(state, "black"),
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
  } catch {
    return Response.json({ error: "ROOM_CREATE_FAILED" }, { status: 500, headers: responseHeaders });
  }
}
