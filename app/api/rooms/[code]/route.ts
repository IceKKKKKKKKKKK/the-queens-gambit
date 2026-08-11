import {
  projectGame,
  settleExpiredAugmentDraft,
  settleExpiredClock,
  type GameState,
  type ProjectedGame,
  type Side,
} from "../../../../lib/game";
import {
  cancelRankedSetup,
  getOrCreatePlatformUser,
  PlatformError,
  resolveRankedSetupTimeout,
  type RankedSetupGate,
} from "../../../../db/platform";
import { IdentityError, requireAuthenticatedIdentity } from "../../../../lib/identity";
import { hasNonEmptyRequestBody } from "../../../../lib/request";
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
import { rejectCrossOriginMutation } from "../../security";

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

function rankedSetupExpiredResponse(gate: RankedSetupGate) {
  if (!gate.cancelled) return null;
  return Response.json(
    {
      error: gate.reason === "setup_timeout"
        ? "RANKED_SETUP_EXPIRED"
        : "RANKED_SETUP_CANCELLED",
    },
    { status: 410, headers: responseHeaders },
  );
}

/**
 * Ranked spectators inherit only the knowledge of the friend they are
 * watching. The core projection intentionally reveals a completed board and
 * replay for ordinary games, so the ranked API must preserve its stronger
 * anti-ghosting boundary even after resignation, timeout, or capture.
 */
function redactRankedSpectatorSnapshot(
  snapshot: ProjectedGame,
  state: GameState,
  perspective: Side,
): ProjectedGame {
  const knownOpponentPieceIds = new Set([
    ...(state.augment?.permanentReveals[perspective] ?? []),
    ...(state.augment?.temporaryReveals[perspective] ?? []),
    ...(state.augment?.ruleState?.publiclyRevealedPieceIds ?? []),
    ...(state.augment?.ruleState?.promotedPublicIds ?? []),
    ...Object.keys(state.augment?.ruleState?.mineHits ?? {}),
  ]);
  return {
    ...snapshot,
    pieces: snapshot.pieces.map((piece) => {
      const { originalType, ...publicPiece } = piece;
      return {
        ...publicPiece,
        type:
          piece.side === perspective ||
          piece.flagRevealed ||
          knownOpponentPieceIds.has(piece.id)
            ? piece.type
            : null,
        ...(piece.side === perspective && originalType ? { originalType } : {}),
      };
    }),
    replay: null,
  };
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
    } catch {
      return Response.json(
        { error: "INVALID_PLAYER_TOKEN" },
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

    const rankedSetup = row.room_kind === "ranked" && row.match_id
      ? await resolveRankedSetupTimeout(row.match_id)
      : { setupDeadlineAt: null, cancelled: false, reason: null };
    const setupExpired = rankedSetupExpiredResponse(rankedSetup);
    if (setupExpired) return setupExpired;

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

    const projected = projectGame(state, viewer, nowMs, {
      spectatorPolicy:
        viewer === "spectator"
          ? activeRow.room_kind === "ranked"
            ? "hidden"
            : activeRow.spectator_policy
          : undefined,
      spectatorPerspective,
    });
    const snapshot =
      viewer === "spectator" &&
      activeRow.room_kind === "ranked" &&
      spectatorPerspective
        ? redactRankedSpectatorSnapshot(projected, state, spectatorPerspective)
        : projected;

    return Response.json(
      {
        code: activeRow.code,
        version: activeRow.version,
        viewer,
        spectatorPerspective,
        roomKind: activeRow.room_kind,
        gameMode: activeRow.game_mode,
        spectatorPolicy: activeRow.spectator_policy,
        setupDeadlineAt: state.phase === "setup" ? rankedSetup.setupDeadlineAt : null,
        snapshot,
      },
      { headers: responseHeaders },
    );
  } catch (error) {
    const identityResponse = identityErrorResponse(error);
    if (identityResponse) return identityResponse;
    return Response.json({ error: "ROOM_READ_FAILED" }, { status: 500, headers: responseHeaders });
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  try {
    const originError = rejectCrossOriginMutation(request, responseHeaders);
    if (originError) return originError;
    const user = await getOrCreatePlatformUser(requireAuthenticatedIdentity(request));
    if (await hasNonEmptyRequestBody(request)) {
      return Response.json({ error: "INVALID_REQUEST" }, { status: 400, headers: responseHeaders });
    }
    const { code: rawCode } = await context.params;
    const row = await getRoom(normalizeRoomCode(rawCode));
    if (
      !row ||
      row.room_kind !== "ranked" ||
      !row.match_id ||
      (row.black_user_id !== user.id && row.white_user_id !== user.id)
    ) {
      return Response.json({ error: "ROOM_NOT_FOUND" }, { status: 404, headers: responseHeaders });
    }
    const result = await cancelRankedSetup({ matchId: row.match_id, userId: user.id });
    return Response.json(
      {
        state: "idle",
        cancelled: result.cancelled,
        reason: result.reason,
        setupDeadlineAt: result.setupDeadlineAt,
      },
      { headers: responseHeaders },
    );
  } catch (error) {
    const identityResponse = identityErrorResponse(error);
    if (identityResponse) return identityResponse;
    return Response.json(
      { error: "RANKED_SETUP_CANCEL_FAILED" },
      { status: 500, headers: responseHeaders },
    );
  }
}
