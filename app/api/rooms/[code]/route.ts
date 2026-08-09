import {
  projectGame,
  settleExpiredAugmentDraft,
  settleExpiredClock,
} from "../../../../lib/game";
import { getOrCreatePlatformUser, PlatformError } from "../../../../db/platform";
import { IdentityError, requireAuthenticatedIdentity } from "../../../../lib/identity";
import {
  bearerToken,
  ensureRoomResultRecorded,
  getRoom,
  isExpiredRoom,
  normalizeRoomCode,
  parseRoomState,
  rankedSpectatorPerspective,
  updateRoomState,
  viewerForAuthenticatedUser,
} from "../../../../db/rooms";

const responseHeaders = {
  "Cache-Control": "no-store",
  Vary: "Authorization, oai-authenticated-user-id, oai-authenticated-user-email",
};

function identityErrorResponse(error: unknown) {
  if (error instanceof IdentityError || error instanceof PlatformError) {
    return Response.json({ error: error.code }, { status: error.status, headers: responseHeaders });
  }
  return null;
}

export async function GET(
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

    const authorizationPresent = request.headers.has("authorization");
    const token = bearerToken(request);
    if (authorizationPresent && !token) {
      return Response.json({ error: "INVALID_PLAYER_TOKEN" }, { status: 401, headers: responseHeaders });
    }

    let viewer;
    try {
      viewer = await viewerForAuthenticatedUser(row, user.id, token);
    } catch (error) {
      const codeValue = error instanceof Error ? error.message : "INVALID_PLAYER_TOKEN";
      return Response.json(
        { error: codeValue === "ROOM_IDENTITY_CONFLICT" ? codeValue : "INVALID_PLAYER_TOKEN" },
        { status: 401, headers: responseHeaders },
      );
    }

    let spectatorPerspective: "black" | "white" | null = null;
    if (viewer === "spectator" && row.room_kind === "ranked") {
      try {
        spectatorPerspective = await rankedSpectatorPerspective(row, user.id);
      } catch {
        return Response.json(
          { error: "RANKED_SPECTATOR_FORBIDDEN" },
          { status: 403, headers: responseHeaders },
        );
      }
    }

    let activeRow = row;
    let state = parseRoomState(activeRow);
    let nowMs = Date.now();
    let clockStateResolved = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stateChanged =
        settleExpiredAugmentDraft(state, nowMs) || settleExpiredClock(state, nowMs);
      if (!stateChanged) {
        clockStateResolved = true;
        break;
      }
      if (await updateRoomState(activeRow, state, activeRow.version)) {
        activeRow = {
          ...activeRow,
          state_json: JSON.stringify(state),
          version: activeRow.version + 1,
        };
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


    if (state.phase === "finished" && !activeRow.result_recorded) {
      try {
        if (await ensureRoomResultRecorded(activeRow, state)) {
          activeRow = { ...activeRow, result_recorded: 1 };
        }
      } catch {
        // The authoritative game is already committed. A later read retries the
        // idempotent platform settlement without withholding the finished game.
      }
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
        spectatorPerspective,
        roomKind: activeRow.room_kind,
        gameMode: activeRow.game_mode,
        spectatorPolicy: activeRow.spectator_policy,
        snapshot: projectGame(state, viewer, nowMs, {
          spectatorPolicy:
            viewer === "spectator"
              ? activeRow.room_kind === "ranked"
                ? "hidden"
                : activeRow.spectator_policy
              : undefined,
          spectatorPerspective,
        }),
      },
      { headers: responseHeaders },
    );
  } catch (error) {
    const identityResponse = identityErrorResponse(error);
    if (identityResponse) return identityResponse;
    return Response.json({ error: "ROOM_READ_FAILED" }, { status: 500, headers: responseHeaders });
  }
}
