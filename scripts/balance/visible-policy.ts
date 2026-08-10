import {
  AUGMENT_CATALOG,
  AUGMENT_IDS,
  LEGACY_AUGMENT_CATALOG_VERSION,
  getAugmentDefinition,
  type AugmentDefinition,
  type AugmentId,
  type AugmentOptions,
  type AugmentSuit,
} from "../../lib/augments.ts";
import {
  AUGMENT_RULES_VERSION,
  PIECE_INFO,
  applyPlayerAction,
  getProjectedAugmentExchangeViolation,
  getProjectedAugmentLegalTargets,
  getProjectedAugmentReconTargets,
  getProjectedLegalTargets,
  isCamp,
  isAllowedSetupPosition,
  isHeadquarters,
  otherSide,
  projectGame,
  seedRepetitionTrackerFromCurrentPosition,
  samePosition,
  THREEFOLD_REPETITION_THRESHOLD,
  type GameState,
  type AugmentRuntimeState,
  type Piece,
  type PieceType,
  type PlayerAction,
  type Position,
  type ProjectedGame,
  type PublicPiece,
  type Side,
} from "../../lib/game.ts";

/**
 * A policy in this file may inspect a GameState only through projectGame().
 * Determinizations are sampled from the public projection and the published
 * army inventory; the real type of an unobserved opposing piece is never read.
 */

export interface SearchOptions {
  determinizations: number;
  branching: number;
  rolloutDepth: number;
}

export interface ScoredAction {
  action: PlayerAction;
  score: number;
}

export interface PolicyDecision {
  action: PlayerAction | null;
  actionKey: string | null;
  candidates: number;
  expectedScore: number | null;
  visibleFingerprint: string;
  nodesEvaluated: number;
  opportunityAugmentIds: AugmentId[];
}

const SIDES = ["black", "white"] as const;
const TERMINAL_SCORE = 1_000_000;

export class SeededRandom {
  private value: number;

  constructor(seed: number | string) {
    this.value = hashSeed(String(seed)) || 0x9e3779b9;
  }

  nextUint32() {
    let value = this.value >>> 0;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.value = value >>> 0;
    return this.value;
  }

  next() {
    return this.nextUint32() / 0x1_0000_0000;
  }

  int(length: number) {
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw new Error(`Invalid random selection length: ${length}.`);
    }
    return this.nextUint32() % length;
  }

  shuffle<T>(values: readonly T[]) {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const replacement = this.int(index + 1);
      [result[index], result[replacement]] = [result[replacement], result[index]];
    }
    return result;
  }
}

function withSeededMathRandom<T>(seed: number | string, task: () => T): T {
  const random = new SeededRandom(seed);
  const original = Math.random;
  Object.defineProperty(Math, "random", { configurable: true, value: () => random.next() });
  try {
    return task();
  } finally {
    Object.defineProperty(Math, "random", { configurable: true, value: original });
  }
}

export function hashSeed(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function actionKey(action: PlayerAction) {
  if (action.type === "move" || action.type === "augment_move" || action.type === "augment_exchange") {
    const augment = "augmentId" in action ? `:${action.augmentId}` : "";
    return `${action.type}${augment}:${action.from.row},${action.from.col}>${action.to.row},${action.to.col}`;
  }
  if (action.type === "augment_recon") {
    return `${action.type}:${action.augmentId}:${action.target.row},${action.target.col}`;
  }
  if (action.type === "augment_select") return `${action.type}:${action.augmentId}`;
  if (action.type === "augment_refresh") return `${action.type}:${action.slot}`;
  return action.type;
}

/**
 * Treatment-neutral action identity used only to couple pseudo-random streams.
 * A normal move and an augment move with the same geometry intentionally share
 * one key; the readable actionKey above remains unique for reports and ties.
 */
export function pairedActionKey(action: PlayerAction) {
  if (action.type === "move" || action.type === "augment_move") {
    return `move:${action.from.row},${action.from.col}>${action.to.row},${action.to.col}`;
  }
  if (action.type === "augment_exchange") {
    return `exchange:${action.from.row},${action.from.col}>${action.to.row},${action.to.col}`;
  }
  if (action.type === "augment_recon") {
    return `recon:${action.target.row},${action.target.col}`;
  }
  if (action.type === "augment_select") return "augment_select";
  if (action.type === "augment_refresh") return `augment_refresh:${action.slot}`;
  return action.type;
}

export function policyDecisionSeed(
  pairedSeed: number | string,
  decisionOrdinal: number,
) {
  if (!Number.isSafeInteger(decisionOrdinal) || decisionOrdinal < 0) {
    throw new Error(`Invalid decision ordinal: ${decisionOrdinal}.`);
  }
  return `${pairedSeed}:decision:${decisionOrdinal}`;
}

export function commonWorldSeed(seed: number | string, sample: number) {
  return `${seed}:world:${sample}`;
}

export function commonRootSimulationSeed(seed: number | string, sample: number) {
  return `${seed}:simulation:${sample}`;
}

function knownPieceValue(type: PieceType) {
  if (type === "flag") return 75;
  if (type === "mine") return 8;
  if (type === "bomb") return 18;
  const strength = PIECE_INFO[type].strength ?? 0;
  return 4 + strength * 3.5;
}

function expectedUnknownValue() {
  const entries = Object.entries(PIECE_INFO) as Array<
    [PieceType, (typeof PIECE_INFO)[PieceType]]
  >;
  const total = entries.reduce((sum, [, info]) => sum + info.count, 0);
  return entries.reduce((sum, [type, info]) => sum + knownPieceValue(type) * info.count, 0) / total;
}

const UNKNOWN_PIECE_VALUE = expectedUnknownValue();

function enemyHeadquarters(side: Side) {
  return side === "black"
    ? [{ row: 0, col: 1 }, { row: 0, col: 3 }]
    : [{ row: 11, col: 1 }, { row: 11, col: 3 }];
}

function manhattan(first: Position, second: Position) {
  return Math.abs(first.row - second.row) + Math.abs(first.col - second.col);
}

function distanceToEnemyHeadquarters(side: Side, position: Position) {
  return Math.min(...enemyHeadquarters(side).map((target) => manhattan(position, target)));
}

function publicPieceAt(view: ProjectedGame, position: Position) {
  return view.pieces.find((piece) => piece.alive && samePosition(piece, position));
}

function publicAugmentRemaining(view: ProjectedGame, side: Side, augmentId: AugmentId) {
  if (!view.augment?.draft.loadouts[side].includes(augmentId)) return 0;
  return Math.max(
    0,
    getAugmentDefinition(augmentId).charges - (view.augment.triggerCounts[side][augmentId] ?? 0),
  );
}

function canonicalProjection(view: ProjectedGame, side: Side) {
  const excludedPiece = view.augment?.extraMove
    ? view.pieces.find((piece) => piece.id === view.augment?.extraMove?.excludedPieceId)
    : null;
  return {
    phase: view.phase,
    turn: view.turn,
    winner: view.winner,
    finishReason: view.finishReason,
    drawReason: view.drawReason,
    moveNumber: view.moveNumber,
    repetition: view.repetition,
    movedPieceIds: [...view.movedPieceIds].sort(),
    pieces: view.pieces
      .map((piece) => ({
        side: piece.side,
        type: piece.type,
        alive: piece.alive,
        row: piece.row,
        col: piece.col,
        flagRevealed: piece.flagRevealed,
      }))
      .sort(
        (first, second) =>
          first.side.localeCompare(second.side) ||
          Number(second.alive) - Number(first.alive) ||
          first.row - second.row ||
          first.col - second.col ||
          String(first.type).localeCompare(String(second.type)),
      ),
    clock: view.clock,
    loadouts: view.augment?.draft.loadouts ?? null,
    usedBySide: view.augment?.usedBySide ?? null,
    triggerCounts: view.augment?.triggerCounts ?? null,
    permanentRevealPositions: projectedRevealPositions(
      view,
      view.augment?.permanentRevealIds,
    ),
    temporaryRevealPositions: projectedRevealPositions(
      view,
      view.augment?.temporaryRevealIds,
    ),
    pendingRecon: view.augment?.pendingRecon ?? null,
    extraMove: view.augment?.extraMove
      ? {
          augmentId: view.augment.extraMove.augmentId,
          excludedPosition: excludedPiece
            ? { row: excludedPiece.row, col: excludedPiece.col }
            : null,
        }
      : null,
    viewer: side,
  };
}

function projectedRevealPositions(
  view: ProjectedGame,
  revealIds: readonly string[] | undefined,
) {
  if (!revealIds) return null;
  const ids = new Set(revealIds);
  return view.pieces
    .filter((piece) => ids.has(piece.id))
    .map(({ row, col }) => ({ row, col }))
    .sort((first, second) => first.row - second.row || first.col - second.col);
}

export function visibleStateFingerprint(state: GameState, side: Side, nowMs = 1_000_000) {
  return String(hashSeed(stableStringify(canonicalProjection(projectGame(state, side, nowMs), side))));
}

function normalizeForViewer(position: Position, viewer: Side) {
  return viewer === "black"
    ? position
    : { row: 11 - position.row, col: 4 - position.col };
}

/**
 * Audit-only key for the treatment-neutral search geometry. It deliberately
 * excludes identities, augments, charges, clocks and reveal state, and is not
 * used to seed the policy. White views are rotated 180 degrees so mirrored
 * positions have the same representation.
 */
export function pairedSearchStateKey(state: GameState, side: Side, nowMs = 1_000_000) {
  const view = projectGame(state, side, nowMs);
  const relativeSide = (pieceSide: Side) => (pieceSide === side ? "self" : "opponent");
  const pieces = view.pieces
    .map((piece) => {
      const position = normalizeForViewer(piece, side);
      return {
        side: relativeSide(piece.side),
        alive: piece.alive,
        row: position.row,
        col: position.col,
      };
    })
    .sort(
      (first, second) =>
        first.side.localeCompare(second.side) ||
        Number(second.alive) - Number(first.alive) ||
        first.row - second.row ||
        first.col - second.col,
    );
  return String(
    hashSeed(
      stableStringify({
        phase: view.phase,
        turn: view.turn === side ? "self" : "opponent",
        winner:
          view.winner === null ? null : view.winner === side ? "self" : "opponent",
        finishReason: view.finishReason,
        drawReason: view.drawReason,
        repetition: view.repetition,
        moveNumber: view.moveNumber,
        pieces,
      }),
    ),
  );
}

function inferredTypePool(view: ProjectedGame, hiddenSide: Side) {
  const counts = new Map<PieceType, number>();
  for (const [type, info] of Object.entries(PIECE_INFO) as Array<
    [PieceType, (typeof PIECE_INFO)[PieceType]]
  >) {
    counts.set(type, info.count);
  }
  for (const piece of view.pieces) {
    if (piece.side !== hiddenSide || piece.type === null) continue;
    const remaining = (counts.get(piece.type) ?? 0) - 1;
    if (remaining < 0) {
      throw new Error(`Projection contains too many known ${hiddenSide} ${piece.type} pieces.`);
    }
    counts.set(piece.type, remaining);
  }
  return [...counts].flatMap(([type, count]) => Array.from({ length: count }, () => type));
}

function setupAllowance(
  view: ProjectedGame,
  side: Side,
  mode: "forward_bomb" | "deep_mine",
) {
  return (view.augment?.draft.loadouts[side] ?? []).reduce((total, augmentId) => {
    const effect = getAugmentDefinition(augmentId).effect;
    return effect.kind === "setup" && effect.mode === mode ? total + effect.allowance : total;
  }, 0);
}

function isThirdSetupRow(side: Side, piece: Pick<PublicPiece, "row">) {
  return piece.row === (side === "black" ? 9 : 2);
}

function isFrontSetupRow(side: Side, piece: Pick<PublicPiece, "row">) {
  return piece.row === (side === "black" ? 6 : 5);
}

function typeCanOccupyPublicPosition(
  view: ProjectedGame,
  type: PieceType,
  side: Side,
  piece: PublicPiece,
) {
  const moved = view.movedPieceIds.includes(piece.id);
  if (type === "flag") {
    return (
      !moved &&
      (piece.alive || view.phase === "finished") &&
      isHeadquarters(piece) &&
      piece.row === (side === "black" ? 11 : 0)
    );
  }
  if (type === "mine") {
    if (moved) return false;
    return isAllowedSetupPosition(
      type,
      side,
      piece,
      view.augment?.draft.loadouts[side] ?? [],
    );
  }
  if (type === "bomb" && !moved && isFrontSetupRow(side, piece)) {
    return isAllowedSetupPosition(
      type,
      side,
      piece,
      view.augment?.draft.loadouts[side] ?? [],
    );
  }
  return true;
}

function assignHiddenTypes(view: ProjectedGame, viewer: Side, random: SeededRandom) {
  const hiddenSide = otherSide(viewer);
  const unknown = view.pieces.filter((piece) => piece.side === hiddenSide && piece.type === null);
  const remaining = inferredTypePool(view, hiddenSide);
  if (remaining.length !== unknown.length) {
    throw new Error(
      `Projection inventory mismatch for ${hiddenSide}: ${remaining.length} types for ${unknown.length} pieces.`,
    );
  }

  const available = [...unknown].sort(
    (first, second) => {
      const firstPosition = normalizeForViewer(first, viewer);
      const secondPosition = normalizeForViewer(second, viewer);
      return (
        Number(first.alive) - Number(second.alive) ||
        firstPosition.row - secondPosition.row ||
        firstPosition.col - secondPosition.col ||
        first.id.replace(/^(black|white)-/, "").localeCompare(
          second.id.replace(/^(black|white)-/, ""),
        )
      );
    },
  );
  const assignments = new Map<string, PieceType>();
  const movedIds = new Set(view.movedPieceIds);
  const known = view.pieces.filter((piece) => piece.side === hiddenSide && piece.type !== null);
  const deepMineAllowance = setupAllowance(view, hiddenSide, "deep_mine");
  const forwardBombAllowance = setupAllowance(view, hiddenSide, "forward_bomb");
  let deepMines = known.filter(
    (piece) => piece.type === "mine" && isThirdSetupRow(hiddenSide, piece),
  ).length;
  let frontBombs = known.filter(
    (piece) =>
      piece.type === "bomb" &&
      !movedIds.has(piece.id) &&
      isFrontSetupRow(hiddenSide, piece),
  ).length;

  for (const piece of known) {
    if (!typeCanOccupyPublicPosition(view, piece.type!, hiddenSide, piece)) {
      throw new Error(`Known ${hiddenSide} ${piece.type} occupies an impossible public position.`);
    }
  }
  if (deepMines > deepMineAllowance || frontBombs > forwardBombAllowance) {
    throw new Error(`Known ${hiddenSide} setup pieces exceed their public augment allowance.`);
  }

  const isConstrainedType = (type: PieceType) =>
    type === "flag" || type === "mine" || type === "bomb";
  const constraintPriority = (type: PieceType) =>
    type === "flag" ? 0 : type === "mine" ? 1 : 2;
  const constrainedTypes = remaining
    .filter(isConstrainedType)
    .sort((first, second) => constraintPriority(first) - constraintPriority(second));
  const unconstrainedTypes = remaining.filter((type) => !isConstrainedType(type));

  const search = (index: number): boolean => {
    if (index >= constrainedTypes.length) return true;
    const type = constrainedTypes[index];
    const candidates = random.shuffle(
      available.filter((piece) => {
        if (!typeCanOccupyPublicPosition(view, type, hiddenSide, piece)) return false;
        if (type === "mine" && isThirdSetupRow(hiddenSide, piece)) {
          return deepMines < deepMineAllowance;
        }
        if (
          type === "bomb" &&
          !movedIds.has(piece.id) &&
          isFrontSetupRow(hiddenSide, piece)
        ) {
          return frontBombs < forwardBombAllowance;
        }
        return true;
      }),
    );
    for (const piece of candidates) {
      const availableIndex = available.findIndex((candidate) => candidate.id === piece.id);
      available.splice(availableIndex, 1);
      assignments.set(piece.id, type);
      const addedDeepMine = type === "mine" && isThirdSetupRow(hiddenSide, piece);
      const addedFrontBomb =
        type === "bomb" &&
        !movedIds.has(piece.id) &&
        isFrontSetupRow(hiddenSide, piece);
      if (addedDeepMine) deepMines += 1;
      if (addedFrontBomb) frontBombs += 1;
      if (search(index + 1)) return true;
      if (addedDeepMine) deepMines -= 1;
      if (addedFrontBomb) frontBombs -= 1;
      assignments.delete(piece.id);
      available.splice(availableIndex, 0, piece);
    }
    return false;
  };
  if (!search(0)) {
    throw new Error(`No rules-legal hidden identity assignment exists for ${hiddenSide}.`);
  }

  const shuffledTypes = random.shuffle(unconstrainedTypes);
  const shuffledPieces = random.shuffle(available);
  if (shuffledTypes.length !== shuffledPieces.length) {
    throw new Error(`Hidden assignment remainder mismatch for ${hiddenSide}.`);
  }
  for (let index = 0; index < shuffledTypes.length; index += 1) {
    assignments.set(shuffledPieces[index].id, shuffledTypes[index]);
  }

  const completeCounts = new Map<PieceType, number>();
  for (const piece of view.pieces.filter((candidate) => candidate.side === hiddenSide)) {
    const type = piece.type ?? assignments.get(piece.id);
    if (!type) throw new Error(`Hidden assignment omitted ${piece.id}.`);
    completeCounts.set(type, (completeCounts.get(type) ?? 0) + 1);
  }
  for (const [type, info] of Object.entries(PIECE_INFO) as Array<
    [PieceType, (typeof PIECE_INFO)[PieceType]]
  >) {
    if (completeCounts.get(type) !== info.count) {
      throw new Error(`Hidden assignment produced an invalid ${hiddenSide} ${type} inventory.`);
    }
  }
  return assignments;
}

function syntheticRoundOptions(
  suit: AugmentSuit,
  roundNumber: number,
  selectedId: AugmentId | null,
  seed: number | string,
) {
  const eligible = AUGMENT_CATALOG.filter(
    (card) => card.suit === suit && (roundNumber === 1 || card.activation !== "setup"),
  )
    .map((card) => card.id)
    .filter((id) => id !== selectedId);
  const shuffled = new SeededRandom(seed).shuffle(eligible);
  const values = [...(selectedId ? [selectedId] : []), ...shuffled].slice(0, 3);
  if (values.length !== 3) throw new Error(`Cannot synthesize a ${suit} round-${roundNumber} offer.`);
  return values as AugmentOptions;
}

export function projectedRevealKnowledge(
  view: ProjectedGame,
  viewer: Side,
) {
  if (!view.augment) {
    return { permanent: [] as string[], temporary: [] as string[] };
  }
  const opponent = otherSide(viewer);
  const visibleKnownIds = view.pieces
    .filter(
      (piece) =>
        piece.side === opponent &&
        piece.type !== null &&
        !(piece.type === "flag" && piece.flagRevealed),
    )
    .map((piece) => piece.id);
  const hasProvenance =
    Array.isArray(view.augment.permanentRevealIds) &&
    Array.isArray(view.augment.temporaryRevealIds);
  if (!hasProvenance) {
    // Compatibility for old or hand-authored projections that predate reveal
    // provenance. Their visible identities remain usable as durable knowledge.
    return { permanent: visibleKnownIds, temporary: [] as string[] };
  }

  const permanentIds = new Set(view.augment.permanentRevealIds);
  const temporaryIds = new Set(view.augment.temporaryRevealIds);
  const permanent: string[] = [];
  const temporary: string[] = [];
  for (const id of visibleKnownIds) {
    if (temporaryIds.has(id) && !permanentIds.has(id)) temporary.push(id);
    else permanent.push(id);
  }
  return { permanent, temporary };
}

function inferredOpponentPendingRecon(view: ProjectedGame, viewer: Side) {
  if (!view.augment || view.phase !== "playing") return null;
  const opponent = otherSide(viewer);
  const unresolved = view.augment.draft.loadouts[opponent].find((augmentId) => {
    const effect = getAugmentDefinition(augmentId).effect;
    return (
      effect.kind === "reconnaissance" &&
      effect.mode === "choose_enemy" &&
      !view.augment!.usedBySide[opponent].includes(augmentId)
    );
  });
  if (!unresolved) return null;
  const effect = getAugmentDefinition(unresolved).effect;
  if (effect.kind !== "reconnaissance" || effect.mode !== "choose_enemy") return null;
  const legacyPublicFlagTarget =
    view.augment.draft.catalogVersion === LEGACY_AUGMENT_CATALOG_VERSION &&
    unresolved === "heart-targeted-recon";
  const available = view.pieces.filter(
    (piece) =>
      piece.alive &&
      piece.side === viewer &&
      (legacyPublicFlagTarget || !(piece.type === "flag" && piece.flagRevealed)),
  ).length;
  const remaining = Math.min(effect.count, available);
  return remaining > 0 ? { augmentId: unresolved, remaining } : null;
}

function stableRevealCandidates(pieces: readonly PublicPiece[], viewer: Side) {
  return [...pieces].sort((first, second) => {
    const firstPosition = normalizeForViewer(first, viewer);
    const secondPosition = normalizeForViewer(second, viewer);
    return (
      Number(first.alive) - Number(second.alive) ||
      firstPosition.row - secondPosition.row ||
      firstPosition.col - secondPosition.col ||
      first.id.replace(/^(black|white)-/, "").localeCompare(
        second.id.replace(/^(black|white)-/, ""),
      )
    );
  });
}

/**
 * The opponent's concrete reconnaissance targets are private.  Rollouts still
 * need a rules-consistent belief about information that public trigger counts
 * prove the opponent obtained, so sample target IDs from the public geometry
 * instead of copying the authoritative private arrays. Without a public
 * trigger-time target snapshot, choose-enemy reconnaissance conservatively
 * samples only current living targets: this is a feasible private history and
 * cannot invent a piece that was already dead when a later round revealed.
 */
function syntheticOpponentRevealKnowledge(
  view: ProjectedGame,
  viewer: Side,
  seed: number | string,
) {
  if (!view.augment) return { permanent: [] as string[], temporary: [] as string[] };
  const opponent = otherSide(viewer);
  const random = new SeededRandom(`${seed}:opponent-reveal-knowledge`);
  const permanent: string[] = [];
  const temporary: string[] = [];
  const known = new Set<string>();
  for (const augmentId of view.augment.draft.loadouts[opponent]) {
    const effect = getAugmentDefinition(augmentId).effect;
    if (effect.kind !== "reconnaissance") continue;
    const publicUses = Math.max(
      view.augment.triggerCounts[opponent][augmentId] ?? 0,
      view.augment.usedBySide[opponent].includes(augmentId) ? 1 : 0,
    );
    if (publicUses <= 0) continue;
    const legacy = view.augment.draft.catalogVersion === LEGACY_AUGMENT_CATALOG_VERSION;
    if (effect.mode === "choose_enemy") {
      const legacyPublicFlagTarget = legacy && augmentId === "heart-targeted-recon";
      const candidates = stableRevealCandidates(
        view.pieces.filter(
          (piece) =>
            piece.side === viewer &&
            piece.alive &&
            !known.has(piece.id) &&
            (legacyPublicFlagTarget || !piece.flagRevealed),
        ),
        viewer,
      );
      for (const target of random.shuffle(candidates).slice(0, effect.count * publicUses)) {
        permanent.push(target.id);
        known.add(target.id);
      }
      continue;
    }

    const targetRows = Array.from(
      { length: effect.rowsFromFront },
      (_, index) => (viewer === "black" ? 6 + index : 5 - index),
    );
    const legacyMayRepeatKnown = legacy && augmentId === "club-frontline-scout";
    const candidates = stableRevealCandidates(
      view.pieces.filter(
        (piece) =>
          piece.side === viewer &&
          piece.alive &&
          targetRows.includes(piece.row) &&
          (legacyMayRepeatKnown || (!known.has(piece.id) && !piece.flagRevealed)),
      ),
      viewer,
    );
    for (const target of random.shuffle(candidates).slice(0, effect.count * publicUses)) {
      if (!temporary.includes(target.id)) temporary.push(target.id);
      known.add(target.id);
    }
  }
  return { permanent, temporary };
}

function sanitizedAugmentRuntime(
  view: ProjectedGame,
  viewer: Side,
  seed: number | string,
): AugmentRuntimeState | null | undefined {
  if (!view.augment) return null;
  const opponent = otherSide(viewer);
  const rounds = view.augment.draft.rounds.map((round) => {
    const players = Object.fromEntries(
      SIDES.map((side) => {
        const projected = round.players[side];
        const synthetic =
          projected.options ??
          syntheticRoundOptions(
            round.suit,
            round.number,
            projected.selectedId,
            `${seed}:private-offer:${round.number}:${side}`,
          );
        const selectedId =
          projected.selectedId ?? (projected.locked ? synthetic[0] : null);
        return [
          side,
          {
            options: synthetic,
            selectedId,
            locked: projected.locked,
            refreshedSlot: projected.refreshedSlot ?? (projected.refreshed ? 0 : null),
          },
        ];
      }),
    ) as AugmentRuntimeState["draft"]["rounds"][number]["players"];
    return {
      number: round.number,
      trigger: round.trigger,
      suit: round.suit,
      revealed: round.revealed,
      players,
    };
  });
  const seenFor = (side: Side) => {
    if (side === viewer && view.augment?.draft.seenIds) {
      return [...view.augment.draft.seenIds];
    }
    const seen = rounds.flatMap((round) => [...round.players[side].options]);
    return [...new Set(seen)];
  };
  const viewerKnowledge = projectedRevealKnowledge(view, viewer);
  const opponentKnowledge = syntheticOpponentRevealKnowledge(view, viewer, seed);
  return {
    draft: {
      catalogVersion: view.augment.draft.catalogVersion,
      activeRound: view.augment.draft.activeRound,
      rounds,
      seenBySide: {
        [viewer]: seenFor(viewer),
        [opponent]: seenFor(opponent),
      } as Record<Side, AugmentId[]>,
      loadouts: {
        black: [...view.augment.draft.loadouts.black],
        white: [...view.augment.draft.loadouts.white],
      },
    },
    usedBySide: {
      black: [...view.augment.usedBySide.black],
      white: [...view.augment.usedBySide.white],
    },
    triggerCounts: {
      black: { ...view.augment.triggerCounts.black },
      white: { ...view.augment.triggerCounts.white },
    },
    permanentReveals: {
      [viewer]: viewerKnowledge.permanent,
      [opponent]: opponentKnowledge.permanent,
    } as Record<Side, string[]>,
    temporaryReveals: {
      [viewer]: viewerKnowledge.temporary,
      [opponent]: opponentKnowledge.temporary,
    } as Record<Side, string[]>,
    pendingRecon: {
      [viewer]: view.augment.pendingRecon
        ? {
            augmentId: view.augment.pendingRecon.augmentId,
            remaining: view.augment.pendingRecon.remaining,
          }
        : null,
      [opponent]: inferredOpponentPendingRecon(view, viewer),
    } as AugmentRuntimeState["pendingRecon"],
    extraMove: {
      [viewer]: view.augment.extraMove ? { ...view.augment.extraMove } : null,
      [opponent]: null,
    } as AugmentRuntimeState["extraMove"],
    resumeTurn: null,
    draftDeadlineAt: view.augment.draftDeadlineAt,
  };
}

export function determinizeFromProjection(
  state: GameState,
  viewer: Side,
  seed: number | string,
  nowMs = 1_000_000,
): GameState {
  const view = projectGame(state, viewer, nowMs);
  const random = new SeededRandom(seed);
  const hiddenAssignments = assignHiddenTypes(view, viewer, random);
  const projectedById = new Map(view.pieces.map((piece) => [piece.id, piece]));
  const sanitizedPieces: Piece[] = view.pieces.map((piece) => {
    const type = piece.type ?? hiddenAssignments.get(piece.id);
    if (!type) throw new Error(`No public or sampled identity for ${piece.id}.`);
    return {
      id: piece.id,
      side: piece.side,
      type,
      alive: piece.alive,
      row: piece.row,
      col: piece.col,
    };
  });
  if (projectedById.size !== sanitizedPieces.length) {
    throw new Error("Projected piece IDs are not unique.");
  }
  const sampledState = {
    rulesVersion: view.rulesVersion,
    phase: view.phase,
    joined: { ...view.joined },
    ready: { ...view.ready },
    // firstTurn has no post-setup strategic effect; using the public current
    // turn keeps the sampled world independent of non-projected authority.
    firstTurn: view.turn,
    turn: view.turn,
    winner: view.winner,
    finishReason: view.finishReason,
    drawReason: view.drawReason,
    revealedFlags: { ...view.revealedFlags },
    pieces: sanitizedPieces,
    events: structuredClone(view.events),
    moveNumber: view.moveNumber,
    replay: null,
    movedPieceIds: [...view.movedPieceIds],
    clock: view.clock
      ? {
          initialMs: view.clock.initialMs,
          remainingMs: { ...view.clock.remainingMs },
          turnStartedAt: view.clock.running === null ? null : nowMs,
          ...(view.clock.incrementMs === undefined
            ? {}
            : { incrementMs: view.clock.incrementMs }),
          ...(view.clock.incrementThresholdMs === undefined
            ? {}
            : { incrementThresholdMs: view.clock.incrementThresholdMs }),
          ...(view.clock.incrementCapMs === undefined
            ? {}
            : { incrementCapMs: view.clock.incrementCapMs }),
        }
      : null,
    augment: sanitizedAugmentRuntime(view, viewer, seed),
  } satisfies GameState;
  if (view.rulesVersion !== AUGMENT_RULES_VERSION) return sampledState;
  if (!view.repetition) {
    throw new Error("Augment v2 projection is missing public repetition status.");
  }
  const publicOccurrences = view.repetition.currentOccurrences;
  if (
    view.repetition.active &&
    (!Number.isInteger(publicOccurrences) ||
      publicOccurrences < 1 ||
      publicOccurrences >= THREEFOLD_REPETITION_THRESHOLD)
  ) {
    throw new Error("Active public repetition occurrence is outside the playable range.");
  }

  // Draft/setup/pending-recon positions are not countable. A sampled world must
  // therefore start them with empty synthetic evidence even if an untrusted
  // in-memory projection carries an occurrence from an earlier settled state.
  // Finished worlds retain their public terminal count; active worlds safely
  // rebind public occurrence 1/2 to the sampled private position.
  const sampledOccurrences =
    view.repetition.active || view.phase === "finished" ? publicOccurrences : 0;
  return seedRepetitionTrackerFromCurrentPosition(
    sampledState,
    sampledOccurrences,
    `balance-sampled:${String(seed)}:public-occurrence`,
  );
}

function battleExpectation(attacker: PublicPiece, defender: PublicPiece) {
  if (defender.type === null) return 18;
  if (defender.type === "flag") return 20_000;
  if (attacker.type === null) return 0;
  if (attacker.type === "bomb" || defender.type === "bomb") return 8;
  if (defender.type === "mine") return attacker.type === "engineer" ? 85 : -45;
  const attackerStrength = PIECE_INFO[attacker.type].strength ?? -1;
  const defenderStrength = PIECE_INFO[defender.type].strength ?? -1;
  if (attackerStrength > defenderStrength) return 60 + knownPieceValue(defender.type);
  if (attackerStrength === defenderStrength) return 8;
  return -30 - knownPieceValue(attacker.type) * 0.35;
}

function scoreVisibleAction(view: ProjectedGame, side: Side, action: PlayerAction) {
  if (action.type === "pass_extra_move") return 0;
  if (action.type === "augment_recon") {
    const target = publicPieceAt(view, action.target);
    const advanced = side === "black" ? 11 - action.target.row : action.target.row;
    return 105 + advanced * 1.5 + (target?.type === null ? 25 : -50);
  }
  if (action.type === "augment_exchange") {
    const first = publicPieceAt(view, action.from);
    const second = publicPieceAt(view, action.to);
    if (!first || !second) return -1_000;
    const firstValue = first.type ? knownPieceValue(first.type) : UNKNOWN_PIECE_VALUE;
    const secondValue = second.type ? knownPieceValue(second.type) : UNKNOWN_PIECE_VALUE;
    const before =
      firstValue * -distanceToEnemyHeadquarters(side, first) +
      secondValue * -distanceToEnemyHeadquarters(side, second);
    const after =
      firstValue * -distanceToEnemyHeadquarters(side, second) +
      secondValue * -distanceToEnemyHeadquarters(side, first);
    return 15 + (after - before) * 0.08;
  }
  if (action.type !== "move" && action.type !== "augment_move") return -10_000;
  const attacker = publicPieceAt(view, action.from);
  if (!attacker) return -10_000;
  const defender = publicPieceAt(view, action.to);
  const progress =
    distanceToEnemyHeadquarters(side, action.from) - distanceToEnemyHeadquarters(side, action.to);
  let score = progress * 5;
  if (isCamp(action.to)) score += 4;
  if (defender && defender.side !== side) score += battleExpectation(attacker, defender);
  if (action.type === "augment_move") {
    // Preserve active cards unless they generate a concrete positional gain.
    score -= 8;
    score += Math.max(0, progress) * 3;
  }
  const previous = [...view.events]
    .reverse()
    .find((event) => event.actor === side && event.from && event.to);
  if (previous?.from && previous.to && samePosition(previous.from, action.to) && samePosition(previous.to, action.from)) {
    score -= 24;
  }
  return score;
}

export function enumerateVisibleActions(view: ProjectedGame, side: Side) {
  if (view.phase !== "playing" || view.turn !== side) return [];
  const pending = view.augment?.pendingRecon;
  if (pending) {
    return getProjectedAugmentReconTargets(view, side, pending.augmentId)
      .map((target) => ({
        type: "augment_recon" as const,
        augmentId: pending.augmentId,
        target,
      }));
  }

  const actions: PlayerAction[] = [];
  if (view.augment?.extraMove) actions.push({ type: "pass_extra_move" });
  const ownPieces = view.pieces.filter((piece) => piece.alive && piece.side === side);
  for (const piece of ownPieces) {
    const from = { row: piece.row, col: piece.col };
    for (const to of getProjectedLegalTargets(view, side, from)) {
      actions.push({ type: "move", from, to });
    }
  }
  for (const augmentId of view.augment?.draft.loadouts[side] ?? []) {
    if (publicAugmentRemaining(view, side, augmentId) <= 0) continue;
    const definition = getAugmentDefinition(augmentId);
    if (definition.effect.kind === "movement") {
      for (const piece of ownPieces) {
        const from = { row: piece.row, col: piece.col };
        for (const to of getProjectedAugmentLegalTargets(view, side, augmentId, from)) {
          actions.push({ type: "augment_move", augmentId, from, to });
        }
      }
    } else if (definition.effect.kind === "exchange") {
      for (let first = 0; first < ownPieces.length; first += 1) {
        for (let second = first + 1; second < ownPieces.length; second += 1) {
          const from = { row: ownPieces[first].row, col: ownPieces[first].col };
          const to = { row: ownPieces[second].row, col: ownPieces[second].col };
          if (getProjectedAugmentExchangeViolation(view, side, augmentId, from, to) === null) {
            actions.push({ type: "augment_exchange", augmentId, from, to });
          }
        }
      }
    }
  }
  return actions;
}

export function selectSearchCandidates(
  ranked: readonly ScoredAction[],
  branching: number,
) {
  if (branching <= 0) return [];
  // One-ply rollouts intentionally keep their historical greedy top-1 policy.
  if (branching === 1) return ranked.slice(0, 1);

  const normalMoveGeometry = new Set(
    ranked
      .filter(({ action }) => action.type === "move")
      .map(({ action }) => pairedActionKey(action)),
  );
  const deduplicated = ranked.filter(
    ({ action }) =>
      action.type !== "augment_move" ||
      !normalMoveGeometry.has(pairedActionKey(action)),
  );

  const limit = Math.min(branching, deduplicated.length);
  const reserved = new Set<ScoredAction>();
  const normalMoves = deduplicated.filter(({ action }) => action.type === "move");
  const hasOtherActions = deduplicated.some(({ action }) => action.type !== "move");
  if (branching >= 3 && normalMoves.length > 0 && hasOtherActions) {
    const normalMoveSlots = Math.max(1, Math.floor(branching / 2));
    for (const candidate of normalMoves.slice(0, normalMoveSlots)) reserved.add(candidate);
  }

  const pass = deduplicated.find(({ action }) => action.type === "pass_extra_move");
  if (pass) reserved.add(pass);

  const selected = new Set<ScoredAction>(reserved);
  for (const candidate of deduplicated) {
    if (selected.size >= limit) break;
    selected.add(candidate);
  }
  return deduplicated.filter((candidate) => selected.has(candidate)).slice(0, limit);
}

function rankVisibleActionSet(
  view: ProjectedGame,
  side: Side,
  branching: number,
  actions: readonly PlayerAction[],
) {
  const ranked = actions
    .map((action) => ({
      action,
      score: scoreVisibleAction(view, side, action),
    }))
    .sort(
      (first, second) =>
        second.score - first.score ||
        pairedActionKey(first.action).localeCompare(pairedActionKey(second.action)) ||
        actionKey(first.action).localeCompare(actionKey(second.action)),
    );
  return selectSearchCandidates(ranked, branching);
}

function posteriorUnknownPieceValue(view: ProjectedGame, side: Side) {
  const remaining = new Map<PieceType, number>();
  for (const [type, info] of Object.entries(PIECE_INFO) as Array<
    [PieceType, (typeof PIECE_INFO)[PieceType]]
  >) {
    remaining.set(type, info.count);
  }
  for (const piece of view.pieces) {
    if (piece.side !== side || piece.type === null) continue;
    const count = (remaining.get(piece.type) ?? 0) - 1;
    if (count < 0) throw new Error(`Visible ${side} ${piece.type} inventory is impossible.`);
    remaining.set(piece.type, count);
  }
  const unknownCount = view.pieces.filter((piece) => piece.side === side && piece.type === null).length;
  const remainingCount = [...remaining.values()].reduce((sum, count) => sum + count, 0);
  if (remainingCount !== unknownCount) {
    throw new Error(`Visible ${side} posterior inventory does not match its unknown pieces.`);
  }
  if (unknownCount === 0) return 0;
  return [...remaining].reduce(
    (sum, [type, count]) => sum + knownPieceValue(type) * count,
    0,
  ) / unknownCount;
}

function visibleInformationScore(view: ProjectedGame, root: Side) {
  return view.pieces.filter(
    (piece) => piece.side !== root && piece.type !== null,
  ).length * 2.5;
}

function projectedMaterialScore(view: ProjectedGame, root: Side) {
  const posteriorValues = {
    black: posteriorUnknownPieceValue(view, "black"),
    white: posteriorUnknownPieceValue(view, "white"),
  };
  let score = 0;
  for (const piece of view.pieces) {
    if (!piece.alive) continue;
    const value = piece.type ? knownPieceValue(piece.type) : posteriorValues[piece.side];
    const sign = piece.side === root ? 1 : -1;
    score += sign * value;
    if (piece.side === root && piece.type !== "flag" && piece.type !== "mine") {
      score += (12 - distanceToEnemyHeadquarters(root, piece)) * 0.6;
    }
  }
  return score + visibleInformationScore(view, root);
}

function sampledMaterialScore(state: GameState, view: ProjectedGame, root: Side) {
  let score = 0;
  for (const piece of state.pieces) {
    if (!piece.alive) continue;
    const sign = piece.side === root ? 1 : -1;
    score += sign * knownPieceValue(piece.type);
    if (piece.side === root && piece.type !== "flag" && piece.type !== "mine") {
      score += (12 - distanceToEnemyHeadquarters(root, piece)) * 0.6;
    }
  }
  return score + visibleInformationScore(view, root);
}

function finishVisibleEvaluation(
  view: ProjectedGame,
  root: Side,
  materialScore: number,
) {
  let score = materialScore;
  if (view.clock) {
    score += (view.clock.remainingMs[root] - view.clock.remainingMs[otherSide(root)]) / 20_000;
  }
  for (const side of SIDES) {
    const sign = side === root ? 1 : -1;
    for (const augmentId of view.augment?.draft.loadouts[side] ?? []) {
      score += sign * publicAugmentRemaining(view, side, augmentId) * staticAugmentPrior(augmentId) * 0.08;
    }
  }
  return score;
}

export function evaluateVisibleState(state: GameState, root: Side, nowMs = 1_000_000) {
  const view = projectGame(state, root, nowMs);
  if (view.phase === "finished") {
    if (view.winner === root) return TERMINAL_SCORE - view.moveNumber;
    if (view.winner === null) return 0;
    return -TERMINAL_SCORE + view.moveNumber;
  }
  return finishVisibleEvaluation(view, root, projectedMaterialScore(view, root));
}

function evaluateDeterminedState(state: GameState, root: Side, nowMs: number) {
  const view = projectGame(state, root, nowMs);
  if (view.phase === "finished") {
    if (view.winner === root) return TERMINAL_SCORE - view.moveNumber;
    if (view.winner === null) return 0;
    return -TERMINAL_SCORE + view.moveNumber;
  }
  return finishVisibleEvaluation(view, root, sampledMaterialScore(state, view, root));
}

function applyVisibleRollout(
  initial: GameState,
  root: Side,
  depth: number,
  nowMs: number,
): { score: number; nodes: number } {
  let state = initial;
  let clock = nowMs;
  let nodes = 0;
  for (let ply = 0; ply < depth && state.phase === "playing"; ply += 1) {
    const side = state.turn;
    const view = projectGame(state, side, clock);
    const [candidate] = rankVisibleActionSet(
      view,
      side,
      1,
      enumerateVisibleActions(view, side),
    );
    if (!candidate) break;
    try {
      clock += 50;
      state = applyPlayerAction(state, side, candidate.action, clock);
      nodes += 1;
    } catch {
      break;
    }
    if (state.phase === "augment_draft") break;
  }
  return { score: evaluateDeterminedState(state, root, clock), nodes };
}

function actionAugmentId(action: PlayerAction): AugmentId | null {
  return action.type === "augment_move" ||
    action.type === "augment_exchange" ||
    action.type === "augment_recon"
    ? action.augmentId
    : null;
}

export function chooseVisibleAction(
  state: GameState,
  side: Side,
  seed: number | string,
  options: SearchOptions,
  nowMs = 1_000_000,
): PolicyDecision {
  const view = projectGame(state, side, nowMs);
  const fingerprint = String(hashSeed(stableStringify(canonicalProjection(view, side))));
  const visibleActions = enumerateVisibleActions(view, side);
  const opportunityAugmentIds = [
    ...new Set(visibleActions.map(actionAugmentId).filter((id): id is AugmentId => id !== null)),
  ].sort();
  const candidates = rankVisibleActionSet(
    view,
    side,
    options.branching,
    visibleActions,
  );
  if (!candidates.length) {
    return {
      action: null,
      actionKey: null,
      candidates: 0,
      expectedScore: null,
      visibleFingerprint: fingerprint,
      nodesEvaluated: 0,
      opportunityAugmentIds,
    };
  }

  let best: ScoredAction | null = null;
  let nodesEvaluated = 0;
  for (const candidate of candidates) {
    let total = 0;
    let samples = 0;
    for (let sample = 0; sample < options.determinizations; sample += 1) {
      const worldSeed = commonWorldSeed(seed, sample);
      const simulationSeed = commonRootSimulationSeed(seed, sample);
      const sampledScore = withSeededMathRandom(`${simulationSeed}:engine`, () => {
        let determined = determinizeFromProjection(state, side, worldSeed, nowMs);
        nodesEvaluated += 1;
        try {
          determined = applyPlayerAction(determined, side, candidate.action, nowMs + 50);
        } catch {
          return -TERMINAL_SCORE;
        }
        const rollout = applyVisibleRollout(
          determined,
          side,
          Math.max(0, options.rolloutDepth - 1),
          nowMs + 50,
        );
        nodesEvaluated += rollout.nodes;
        return rollout.score;
      });
      total += sampledScore;
      samples += 1;
    }
    const expected = samples ? total / samples : -TERMINAL_SCORE;
    const scored = { action: candidate.action, score: expected + candidate.score * 0.02 };
    if (
      !best ||
      scored.score > best.score ||
      (scored.score === best.score && actionKey(scored.action) < actionKey(best.action))
    ) {
      best = scored;
    }
  }
  return {
    action: best?.action ?? null,
    actionKey: best ? actionKey(best.action) : null,
    candidates: candidates.length,
    expectedScore: best?.score ?? null,
    visibleFingerprint: fingerprint,
    nodesEvaluated,
    opportunityAugmentIds,
  };
}

export function policyDecisionFingerprint(
  state: GameState,
  side: Side,
  seed: number | string,
  options: SearchOptions,
  nowMs = 1_000_000,
) {
  const decision = chooseVisibleAction(state, side, seed, options, nowMs);
  return `${decision.visibleFingerprint}:${decision.actionKey ?? "none"}:${decision.expectedScore?.toFixed(6) ?? "none"}`;
}

export function staticAugmentPrior(id: AugmentId) {
  const definition = getAugmentDefinition(id);
  const effect = definition.effect;
  let score = definition.charges * 8;
  switch (effect.kind) {
    case "movement":
      score += effect.destination === "empty_or_enemy" ? 38 : 25;
      break;
    case "extra_turn":
      score += 40 * effect.maxExtraMoves;
      break;
    case "combat":
      score += 34;
      break;
    case "reconnaissance":
      score += effect.count * (effect.reveal === "permanent" ? 23 : 12);
      break;
    case "clock":
      score += "bonusMs" in effect ? effect.bonusMs / 3_000 : 10;
      break;
    case "exchange":
      score += effect.mode === "same_rank" ? 24 : 15;
      break;
    case "setup":
      score += 18 * effect.allowance;
      break;
  }
  return score;
}

export interface DraftStrengthModel {
  ratings?: Partial<Record<AugmentId, number>>;
  counters?: Partial<Record<AugmentId, Partial<Record<AugmentId, number>>>>;
}

export function chooseDraftCard(
  options: readonly AugmentId[],
  opponentCards: readonly AugmentId[],
  model: DraftStrengthModel = {},
) {
  if (!options.length) throw new Error("Cannot choose from an empty augment offer.");
  const scored = options.map((id) => {
    const rating = model.ratings?.[id] ?? 0;
    const matchup = opponentCards.length
      ? opponentCards.reduce((sum, opponent) => sum + (model.counters?.[id]?.[opponent] ?? 0), 0) /
        opponentCards.length
      : 0;
    return { id, score: staticAugmentPrior(id) + rating + matchup };
  });
  scored.sort((first, second) => second.score - first.score || first.id.localeCompare(second.id));
  return scored[0];
}

export function catalogFingerprint(catalog: readonly AugmentDefinition[] = AUGMENT_CATALOG) {
  return String(
    hashSeed(
      stableStringify(
        catalog.map(({ id, suit, charges, effect }) => ({ id, suit, charges, effect })),
      ),
    ),
  );
}

export function cardsBySuit(catalog: readonly AugmentDefinition[] = AUGMENT_CATALOG) {
  return Object.fromEntries(
    (["spades", "hearts", "clubs", "diamonds"] as const).map((suit) => [
      suit,
      catalog.filter((card) => card.suit === suit).map((card) => card.id),
    ]),
  ) as Record<AugmentSuit, AugmentId[]>;
}

export function unknownActiveEffectKinds(catalog: readonly AugmentDefinition[] = AUGMENT_CATALOG) {
  return catalog
    .filter(
      (card) =>
        card.activation === "active" &&
        !["movement", "exchange", "reconnaissance"].includes(card.effect.kind),
    )
    .map((card) => ({ id: card.id, effectKind: card.effect.kind }));
}

export function catalogIds() {
  return [...AUGMENT_IDS];
}
