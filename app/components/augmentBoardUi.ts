import {
  isInsideBoard,
  positionKey,
  samePosition,
  type Position,
  type ProjectedGame,
  type PublicEvent,
  type PublicPiece,
  type ReplayMove,
  type SetupPlacement,
  type Side,
} from "../../lib/game.ts";
import type { AugmentId } from "../../lib/augments.ts";

export const AUGMENT_EFFECT_ANIMATION_MS = 320;

export interface RedeployDraft {
  roomCode: string;
  side: Side;
  augmentId: AugmentId;
  original: Record<string, Position>;
  locations: Record<string, Position>;
}

export type AugmentBoardEffectAnimation =
  | {
      kind: "relocations";
      eventId: number;
      event: PublicEvent;
      relocations: NonNullable<PublicEvent["relocations"]>;
      pieces: PublicPiece[];
    }
  | {
      kind: "removals";
      eventId: number;
      event: PublicEvent;
      entries: Array<{ piece: PublicPiece | null; position: Position }>;
    }
  | {
      kind: "pulse";
      eventId: number;
      event: PublicEvent;
      positions: Position[];
    };

export function isHomeHalf(side: Side, position: Position) {
  return side === "black" ? position.row >= 6 : position.row < 6;
}

export function createRedeployDraft(
  roomCode: string,
  game: ProjectedGame,
  side: Side,
  augmentId: AugmentId,
): RedeployDraft | null {
  const entries = game.pieces
    .filter(
      (piece) =>
        piece.alive &&
        piece.side === side &&
        piece.type !== "flag" &&
        isInsideBoard(piece) &&
        isHomeHalf(side, piece),
    )
    .map((piece) => [piece.id, { row: piece.row, col: piece.col }] as const);
  if (entries.length < 2) return null;
  const original = Object.fromEntries(entries);
  return {
    roomCode,
    side,
    augmentId,
    original,
    locations: structuredClone(original),
  };
}

export function redeployPieceIds(draft: RedeployDraft) {
  return Object.keys(draft.original).sort();
}

export function redeployChangedCount(draft: RedeployDraft) {
  return redeployPieceIds(draft).filter(
    (pieceId) => !samePosition(draft.original[pieceId], draft.locations[pieceId]),
  ).length;
}

export function redeployPlacements(draft: RedeployDraft): SetupPlacement[] {
  return redeployPieceIds(draft).map((pieceId) => ({
    pieceId,
    ...draft.locations[pieceId],
  }));
}

export function redeployTargetPositions(draft: RedeployDraft, selectedPieceId: string | null) {
  if (!selectedPieceId || !draft.locations[selectedPieceId]) return [];
  return redeployPieceIds(draft)
    .filter((pieceId) => pieceId !== selectedPieceId)
    .map((pieceId) => draft.locations[pieceId]);
}

export function swapRedeployPieces(
  draft: RedeployDraft,
  firstPieceId: string,
  target: Position,
): RedeployDraft | null {
  const firstPosition = draft.locations[firstPieceId];
  const secondPieceId = redeployPieceIds(draft).find(
    (pieceId) => samePosition(draft.locations[pieceId], target),
  );
  if (!firstPosition || !secondPieceId || secondPieceId === firstPieceId) return null;
  return {
    ...draft,
    locations: {
      ...draft.locations,
      [firstPieceId]: { ...draft.locations[secondPieceId] },
      [secondPieceId]: { ...firstPosition },
    },
  };
}

export function renderRedeployPieces(
  pieces: readonly PublicPiece[],
  draft: RedeployDraft | null,
) {
  if (!draft) return [...pieces];
  return pieces.map((piece) => {
    const position = draft.locations[piece.id];
    return position ? { ...piece, ...position } : piece;
  });
}

function uniquePositions(positions: readonly Position[]) {
  const seen = new Set<string>();
  return positions.filter((position) => {
    const key = positionKey(position);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function positionsForEvent(
  event: PublicEvent,
  previous: ProjectedGame,
  next: ProjectedGame,
) {
  const explicit = event.positions ?? [];
  const fromIds = (event.pieceIds ?? []).flatMap((pieceId) => {
    const piece = next.pieces.find((candidate) => candidate.id === pieceId) ??
      previous.pieces.find((candidate) => candidate.id === pieceId);
    return piece && isInsideBoard(piece) ? [{ row: piece.row, col: piece.col }] : [];
  });
  return uniquePositions([...explicit, ...fromIds]);
}

export function augmentBoardEffectsForTransition(
  previous: ProjectedGame,
  next: ProjectedGame,
) {
  const previousEventId = previous.events.at(-1)?.id ?? 0;
  const newEvents = next.events.filter((event) => event.id > previousEventId);
  const animations: AugmentBoardEffectAnimation[] = [];

  for (const event of newEvents) {
    if (event.result === "pieces_redeployed" && event.relocations?.length) {
      animations.push({
        kind: "relocations",
        eventId: event.id,
        event,
        relocations: event.relocations,
        pieces: next.pieces.filter((piece) =>
          event.relocations?.some((relocation) => relocation.pieceId === piece.id),
        ),
      });
      continue;
    }
    if (["piece_sacrificed", "chain_explosion", "flag_destroyed"].includes(event.result)) {
      const positions = positionsForEvent(event, previous, next);
      const entries = positions.map((position, index) => {
        const pieceId = event.pieceIds?.[index];
        const piece = pieceId
          ? previous.pieces.find((candidate) => candidate.id === pieceId) ?? null
          : previous.pieces.find(
              (candidate) => candidate.alive && samePosition(candidate, position),
            ) ?? null;
        return { piece, position };
      });
      if (entries.length) {
        animations.push({ kind: "removals", eventId: event.id, event, entries });
      }
      continue;
    }
    if (["piece_promoted", "mine_hit", "headquarters_unlocked"].includes(event.result)) {
      const positions = positionsForEvent(event, previous, next);
      if (positions.length) {
        animations.push({ kind: "pulse", eventId: event.id, event, positions });
      }
    }
  }

  return animations;
}

function replayEffectEvent(
  move: ReplayMove,
  result: PublicEvent["result"],
  index: number,
  actor: Side = move.actor,
  augmentId: AugmentId | undefined = move.augmentId,
  pieceIds: string[] = [],
  positions: Position[] = [],
): PublicEvent {
  return {
    id: move.moveNumber * 100 + index + 1,
    actor,
    result,
    kind: result === "piece_sacrificed" ? "sacrifice" : "effect",
    ...(augmentId ? { augmentId } : {}),
    pieceIds: [...pieceIds],
    positions: positions.map((position) => ({ ...position })),
  };
}

/**
 * Builds replay-only board motion from the archive's public geometry. Piece
 * changes remain authoritative for the frame; effects add only visible pulses.
 */
export function augmentBoardEffectsForReplayTransition(
  previousPieces: readonly PublicPiece[],
  nextPieces: readonly PublicPiece[],
  move: ReplayMove,
  movementPieceIds: readonly string[] = [],
) {
  const animations: AugmentBoardEffectAnimation[] = [];
  if (move.kind === "redeploy" && move.relocations?.length) {
    const event = replayEffectEvent(
      move,
      "pieces_redeployed",
      0,
      move.actor,
      move.augmentId,
      move.relocations.map((relocation) => relocation.pieceId),
      move.relocations.map((relocation) => relocation.to),
    );
    animations.push({
      kind: "relocations",
      eventId: event.id,
      event,
      relocations: move.relocations,
      pieces: nextPieces.filter((piece) =>
        move.relocations?.some((relocation) => relocation.pieceId === piece.id),
      ),
    });
  }

  if (move.kind === "sacrifice") {
    const removed = (move.pieceChanges ?? []).filter((change) => !change.alive);
    if (removed.length) {
      const event = replayEffectEvent(
        move,
        "piece_sacrificed",
        1,
        move.actor,
        move.augmentId,
        removed.map((change) => change.pieceId),
        removed.map(({ row, col }) => ({ row, col })),
      );
      animations.push({
        kind: "removals",
        eventId: event.id,
        event,
        entries: removed.map((change) => ({
          piece: previousPieces.find((piece) => piece.id === change.pieceId) ?? null,
          position: { row: change.row, col: change.col },
        })),
      });
    }
  }

  const effectResults = new Set(move.effects?.map((effect) => effect.result) ?? []);
  for (const [index, effect] of (move.effects ?? []).entries()) {
    const pairs = effect.positions.flatMap((position, pairIndex) =>
      isInsideBoard(position) && effect.pieceIds[pairIndex]
        ? [{ pieceId: effect.pieceIds[pairIndex], position: { ...position } }]
        : [],
    );
    if (!pairs.length) continue;
    const event = replayEffectEvent(
      move,
      effect.result,
      index + 2,
      effect.actor,
      effect.augmentId,
      pairs.map((pair) => pair.pieceId),
      pairs.map((pair) => pair.position),
    );
    if (effect.result === "chain_explosion" || effect.result === "flag_destroyed") {
      animations.push({
        kind: "removals",
        eventId: event.id,
        event,
        entries: pairs.map(({ pieceId, position }) => ({
          piece: previousPieces.find((piece) => piece.id === pieceId) ?? null,
          position,
        })),
      });
    } else {
      animations.push({
        kind: "pulse",
        eventId: event.id,
        event,
        positions: pairs.map((pair) => pair.position),
      });
    }
  }

  // Transitional v3 archives may contain pieceChanges but predate ReplayEffect.
  // Preserve their visible removals/promotions without guessing any identity.
  if (!move.effects?.length && move.kind !== "sacrifice") {
    const movementIds = new Set(movementPieceIds);
    const removed = (move.pieceChanges ?? []).filter(
      (change) => !change.alive && !movementIds.has(change.pieceId),
    );
    if (removed.length) {
      const event = replayEffectEvent(
        move,
        "chain_explosion",
        90,
        move.actor,
        move.augmentId,
        removed.map((change) => change.pieceId),
        removed.map(({ row, col }) => ({ row, col })),
      );
      animations.push({
        kind: "removals",
        eventId: event.id,
        event,
        entries: removed.map((change) => ({
          piece: previousPieces.find((piece) => piece.id === change.pieceId) ?? null,
          position: { row: change.row, col: change.col },
        })),
      });
    }
    if (!effectResults.has("piece_promoted")) {
      const promoted = (move.pieceChanges ?? []).filter((change) => {
        const previous = previousPieces.find((piece) => piece.id === change.pieceId);
        return change.alive && previous?.type != null && previous.type !== change.type;
      });
      if (promoted.length) {
        const event = replayEffectEvent(
          move,
          "piece_promoted",
          91,
          move.actor,
          move.augmentId,
          promoted.map((change) => change.pieceId),
          promoted.map(({ row, col }) => ({ row, col })),
        );
        animations.push({
          kind: "pulse",
          eventId: event.id,
          event,
          positions: promoted.map(({ row, col }) => ({ row, col })),
        });
      }
    }
  }

  return animations;
}

export function animatedAugmentPieceIds(
  animations: readonly AugmentBoardEffectAnimation[],
) {
  return animations.flatMap((animation) =>
    animation.kind === "relocations"
      ? animation.relocations.map((relocation) => relocation.pieceId)
      : [],
  );
}
