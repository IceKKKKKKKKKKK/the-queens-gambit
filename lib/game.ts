import {
  AugmentRuleError,
  beginSecondAugmentDraft,
  createAugmentDraftState,
  getAugmentDefinition,
  isSecondAugmentDraftDue,
  lockAugmentSelection,
  projectAugmentDraft,
  refreshAugmentOption,
  revealCurrentAugmentRound,
  selectAugment,
  type AugmentDraftState,
  type AugmentId,
  type AugmentSlot,
  type ProjectedAugmentDraft,
} from "./augments.ts";

export const CLASSIC_RULES_VERSION = "classic-duel-dark-v2" as const;
export const AUGMENT_RULES_VERSION = "augment-duel-dark-v1" as const;
export const RULES_VERSION = CLASSIC_RULES_VERSION;
export type RulesVersion = typeof CLASSIC_RULES_VERSION | typeof AUGMENT_RULES_VERSION;
export type GameMode = "classic" | "augment";
export const DEFAULT_TIME_CONTROL_MINUTES = 20;
export const RANKED_TIME_CONTROL_MINUTES = 10;
export const RANKED_INCREMENT_THRESHOLD_MS = 5 * 60 * 1000;
export const RANKED_INCREMENT_MS = 5 * 1000;
export const AUGMENT_DRAFT_TIMEOUT_MS = 45 * 1000;
export const SECOND_AUGMENT_DRAFT_DURATION_MS = AUGMENT_DRAFT_TIMEOUT_MS;
export const MIN_TIME_CONTROL_MINUTES = 1;
export const MAX_TIME_CONTROL_MINUTES = 180;

export type Side = "black" | "white";
export type Viewer = Side | "spectator";

export type PieceType =
  | "commander"
  | "general"
  | "division"
  | "brigade"
  | "regiment"
  | "battalion"
  | "company"
  | "platoon"
  | "engineer"
  | "bomb"
  | "mine"
  | "flag";

export interface Position {
  row: number;
  col: number;
}

export interface Piece extends Position {
  id: string;
  side: Side;
  type: PieceType;
  alive: boolean;
}

export interface PublicPiece extends Position {
  id: string;
  side: Side;
  type: PieceType | null;
  alive: boolean;
  flagRevealed: boolean;
}

export type BattleResult =
  | "move"
  | "attacker_survives"
  | "defender_survives"
  | "both_removed"
  | "flag_captured";

export interface PublicEvent {
  id: number;
  actor: Side;
  from?: Position;
  to?: Position;
  result:
    | BattleResult
    | "ready"
    | "unready"
    | "resigned"
    | "game_started"
    | "timeout"
    | "augment_used"
    | "augment_revealed";
  augmentId?: AugmentId;
}

export interface GameClock {
  initialMs: number;
  remainingMs: Record<Side, number>;
  turnStartedAt: number | null;
  incrementMs?: number;
  incrementThresholdMs?: number;
}

export interface PublicClock {
  initialMs: number;
  remainingMs: Record<Side, number>;
  running: Side | null;
  incrementMs?: number;
  incrementThresholdMs?: number;
}

export interface ReplayMove {
  moveNumber: number;
  actor: Side;
  from: Position;
  to: Position;
  result: BattleResult;
  kind?: "move" | "exchange";
  augmentId?: AugmentId;
  secondaryFrom?: Position;
  secondaryTo?: Position;
}

export interface ReplayArchive {
  baselineMoveNumber: number;
  partial: boolean;
  initialPieces: Piece[];
  moves: ReplayMove[];
}

export interface ReplayFrame {
  moveNumber: number;
  move: ReplayMove | null;
  pieces: PublicPiece[];
}

export interface AugmentRuntimeState {
  draft: AugmentDraftState;
  usedBySide: Record<Side, AugmentId[]>;
  triggerCounts: Record<Side, Partial<Record<AugmentId, number>>>;
  permanentReveals: Record<Side, string[]>;
  temporaryReveals: Record<Side, string[]>;
  pendingRecon: Record<Side, { augmentId: AugmentId; remaining: number } | null>;
  extraMove: Record<Side, { augmentId: AugmentId; excludedPieceId: string } | null>;
  resumeTurn: Side | null;
  draftDeadlineAt: number | null;
}

export interface ProjectedAugmentRuntime {
  draft: ProjectedAugmentDraft;
  usedBySide: Record<Side, AugmentId[]>;
  triggerCounts: Record<Side, Partial<Record<AugmentId, number>>>;
  pendingRecon: { augmentId: AugmentId; remaining: number } | null;
  extraMove: { augmentId: AugmentId; excludedPieceId: string } | null;
  draftDeadlineAt: number | null;
}

export interface GameState {
  rulesVersion: RulesVersion;
  phase: "setup" | "playing" | "augment_draft" | "finished";
  joined: Record<Side, boolean>;
  ready: Record<Side, boolean>;
  firstTurn: Side;
  turn: Side;
  winner: Side | null;
  finishReason: "flag" | "no_moves" | "resign" | "draw" | "timeout" | null;
  revealedFlags: Record<Side, boolean>;
  pieces: Piece[];
  events: PublicEvent[];
  moveNumber: number;
  replay: ReplayArchive | null;
  clock: GameClock | null;
  augment?: AugmentRuntimeState | null;
}

export interface ProjectedGame {
  rulesVersion: RulesVersion;
  phase: GameState["phase"];
  joined: Record<Side, boolean>;
  ready: Record<Side, boolean>;
  turn: Side;
  winner: Side | null;
  finishReason: GameState["finishReason"];
  revealedFlags: Record<Side, boolean>;
  pieces: PublicPiece[];
  events: PublicEvent[];
  moveNumber: number;
  replay: ReplayArchive | null;
  clock: PublicClock | null;
  mode: GameMode;
  augment: ProjectedAugmentRuntime | null;
}

export type MovementAnimationOutcome = "move" | "capture" | "repelled" | "mutual";

export interface MovementAnimationTransition {
  moveNumber: number;
  event: PublicEvent & {
    from: Position;
    to: Position;
    result: BattleResult;
  };
  attacker: PublicPiece;
  defender: PublicPiece | null;
  attackerAliveAfter: boolean;
  defenderAliveAfter: boolean;
  outcome: MovementAnimationOutcome;
}

export type SetupDraft = Record<string, Position | null>;

export interface SetupPlacement extends Position {
  pieceId: string;
}

export type PlayerAction =
  | { type: "randomize" }
  | { type: "swap"; from: Position; to: Position }
  | { type: "ready"; value: boolean; layout?: SetupPlacement[] }
  | { type: "move"; from: Position; to: Position }
  | { type: "set_time_control"; minutes: number }
  | { type: "augment_select"; augmentId: AugmentId }
  | { type: "augment_refresh"; slot: AugmentSlot }
  | { type: "augment_lock" }
  | { type: "augment_move"; augmentId: AugmentId; from: Position; to: Position }
  | { type: "augment_exchange"; augmentId: AugmentId; from: Position; to: Position }
  | { type: "augment_recon"; augmentId: AugmentId; target: Position }
  | { type: "resign" };

export const PIECE_INFO: Record<
  PieceType,
  { label: string; short: string; count: number; strength: number | null; glyph: string }
> = {
  commander: { label: "司令", short: "司", count: 1, strength: 9, glyph: "♚" },
  general: { label: "军长", short: "军", count: 1, strength: 8, glyph: "♛" },
  division: { label: "师长", short: "师", count: 2, strength: 7, glyph: "♜" },
  brigade: { label: "旅长", short: "旅", count: 2, strength: 6, glyph: "♞" },
  regiment: { label: "团长", short: "团", count: 2, strength: 5, glyph: "♝" },
  battalion: { label: "营长", short: "营", count: 2, strength: 4, glyph: "♖" },
  company: { label: "连长", short: "连", count: 3, strength: 3, glyph: "♘" },
  platoon: { label: "排长", short: "排", count: 3, strength: 2, glyph: "♟" },
  engineer: { label: "工兵", short: "工", count: 3, strength: 1, glyph: "♙" },
  bomb: { label: "炸弹", short: "炸", count: 2, strength: null, glyph: "●" },
  mine: { label: "地雷", short: "雷", count: 3, strength: null, glyph: "✦" },
  flag: { label: "军旗", short: "旗", count: 1, strength: null, glyph: "⚑" },
};

export const CAMPS: Position[] = [
  { row: 2, col: 1 },
  { row: 2, col: 3 },
  { row: 3, col: 2 },
  { row: 4, col: 1 },
  { row: 4, col: 3 },
  { row: 7, col: 1 },
  { row: 7, col: 3 },
  { row: 8, col: 2 },
  { row: 9, col: 1 },
  { row: 9, col: 3 },
];

export const HEADQUARTERS: Position[] = [
  { row: 0, col: 1 },
  { row: 0, col: 3 },
  { row: 11, col: 1 },
  { row: 11, col: 3 },
];

const RAIL_ROWS = new Set([1, 5, 6, 10]);
const PIECE_TYPES = Object.keys(PIECE_INFO) as PieceType[];

export class GameRuleError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "GameRuleError";
  }
}

export function otherSide(side: Side): Side {
  return side === "black" ? "white" : "black";
}

export function samePosition(a: Position, b: Position) {
  return a.row === b.row && a.col === b.col;
}

export function positionKey(position: Position) {
  return `${position.row},${position.col}`;
}

export function boardCoordinate(position: Position) {
  return `${String.fromCharCode(65 + position.col)}${position.row + 1}`;
}

export function isInsideBoard(position: Position) {
  return (
    Number.isInteger(position.row) &&
    Number.isInteger(position.col) &&
    position.row >= 0 &&
    position.row < 12 &&
    position.col >= 0 &&
    position.col < 5
  );
}

export function isCamp(position: Position) {
  return CAMPS.some((camp) => samePosition(camp, position));
}

export type CampMotion = {
  station: "enter" | "leave" | null;
  piece: "enter" | "leave" | null;
};

export function latestMovementEvent(events: readonly PublicEvent[]) {
  const event = events.at(-1);
  return event?.from && event.to ? event : undefined;
}

function isBattleResult(result: PublicEvent["result"]): result is BattleResult {
  return (
    result === "move" ||
    result === "attacker_survives" ||
    result === "defender_survives" ||
    result === "both_removed" ||
    result === "flag_captured"
  );
}

function clonePublicPiece(piece: PublicPiece) {
  return { ...piece };
}

export function movementAnimationForTransition(
  previous: ProjectedGame,
  next: ProjectedGame,
): MovementAnimationTransition | null {
  if (
    previous.phase !== "playing" ||
    (next.phase !== "playing" && next.phase !== "finished") ||
    next.moveNumber !== previous.moveNumber + 1
  ) {
    return null;
  }

  const event = next.events.at(-1);
  if (
    !event?.from ||
    !event.to ||
    !isBattleResult(event.result) ||
    event.actor !== previous.turn ||
    !isInsideBoard(event.from) ||
    !isInsideBoard(event.to) ||
    samePosition(event.from, event.to)
  ) {
    return null;
  }

  const attacker = previous.pieces.find(
    (piece) =>
      piece.alive &&
      piece.side === event.actor &&
      samePosition(piece, event.from!),
  );
  if (!attacker) return null;

  const defender =
    previous.pieces.find(
      (piece) =>
        piece.alive &&
        piece.side !== event.actor &&
        samePosition(piece, event.to!),
    ) ?? null;
  const attackerAfter = next.pieces.find((piece) => piece.id === attacker.id);
  const defenderAfter = defender
    ? next.pieces.find((piece) => piece.id === defender.id)
    : undefined;
  if (!attackerAfter || (defender && !defenderAfter)) return null;

  let outcome: MovementAnimationOutcome;
  if (event.result === "move") {
    if (defender || !attackerAfter.alive || !samePosition(attackerAfter, event.to)) return null;
    outcome = "move";
  } else {
    if (!defender || !defenderAfter || !samePosition(defenderAfter, event.to)) return null;
    if (event.result === "attacker_survives") {
      if (
        !attackerAfter.alive ||
        !samePosition(attackerAfter, event.to) ||
        defenderAfter.alive
      ) {
        return null;
      }
      outcome = "capture";
    } else if (event.result === "defender_survives") {
      const retreated = event.augmentId === "spade-tactical-retreat";
      if (
        attackerAfter.alive !== retreated ||
        !samePosition(attackerAfter, event.from) ||
        !defenderAfter.alive
      ) {
        return null;
      }
      outcome = "repelled";
    } else if (event.result === "both_removed") {
      if (
        attackerAfter.alive ||
        !samePosition(attackerAfter, event.from) ||
        defenderAfter.alive
      ) {
        return null;
      }
      outcome = "mutual";
    } else {
      if (defenderAfter.alive) return null;
      if (attackerAfter.alive) {
        if (!samePosition(attackerAfter, event.to)) return null;
        outcome = "capture";
      } else {
        if (!samePosition(attackerAfter, event.from)) return null;
        outcome = "mutual";
      }
    }
  }

  return {
    moveNumber: next.moveNumber,
    event: {
      ...event,
      from: { ...event.from },
      to: { ...event.to },
      result: event.result,
    },
    attacker: clonePublicPiece(attacker),
    defender: defender ? clonePublicPiece(defender) : null,
    attackerAliveAfter: attackerAfter.alive,
    defenderAliveAfter: defenderAfter?.alive ?? false,
    outcome,
  };
}

export function latestOpponentMovementEvent(events: readonly PublicEvent[], viewer: Viewer) {
  return [...events]
    .reverse()
    .find(
      (event) =>
        Boolean(event.from && event.to) &&
        (viewer === "spectator" || event.actor !== viewer),
    );
}

export function getCampMotionForPosition(
  event: PublicEvent | undefined,
  position: Position,
  occupant?: Pick<PublicPiece, "alive" | "side"> | null,
): CampMotion {
  if (!event?.from || !event.to) return { station: null, piece: null };

  const attackerAtDestination = Boolean(
    occupant?.alive &&
      occupant.side === event.actor &&
      samePosition(event.to, position) &&
      ["move", "attacker_survives", "flag_captured"].includes(event.result),
  );
  const station =
    isCamp(position) && samePosition(event.to, position) && attackerAtDestination
      ? "enter"
      : isCamp(position) && samePosition(event.from, position)
        ? "leave"
        : null;
  const piece = attackerAtDestination
    ? isCamp(event.to)
      ? "enter"
      : isCamp(event.from)
        ? "leave"
        : null
    : null;

  return { station, piece };
}

export function isHeadquarters(position: Position) {
  return HEADQUARTERS.some((headquarters) => samePosition(headquarters, position));
}

export function isSetupPosition(side: Side, position: Position) {
  return side === "black" ? position.row >= 6 : position.row <= 5;
}

export function setupSlots(side: Side) {
  const rows = side === "black" ? [6, 7, 8, 9, 10, 11] : [0, 1, 2, 3, 4, 5];
  return rows.flatMap((row) =>
    Array.from({ length: 5 }, (_, col) => ({ row, col })).filter(
      (position) => !isCamp(position),
    ),
  );
}

function hasSetupAugment(augmentIds: readonly AugmentId[], mode: "forward_bomb" | "deep_mine") {
  return augmentIds.some((id) => {
    const effect = getAugmentDefinition(id).effect;
    return effect.kind === "setup" && effect.mode === mode;
  });
}

export function isAllowedSetupPosition(
  type: PieceType,
  side: Side,
  position: Position,
  augmentIds: readonly AugmentId[] = [],
) {
  if (!isInsideBoard(position) || !isSetupPosition(side, position) || isCamp(position)) {
    return false;
  }
  if (type === "flag") {
    return isHeadquarters(position) && (side === "black" ? position.row === 11 : position.row === 0);
  }
  if (type === "mine") {
    const classic = side === "black" ? position.row >= 10 : position.row <= 1;
    const thirdRow = side === "black" ? position.row === 9 : position.row === 2;
    return classic || (thirdRow && hasSetupAugment(augmentIds, "deep_mine"));
  }
  if (type === "bomb") {
    const isFrontRow = side === "black" ? position.row === 6 : position.row === 5;
    return !isFrontRow || hasSetupAugment(augmentIds, "forward_bomb");
  }
  return true;
}

export function isRailEdge(a: Position, b: Position) {
  const rowDelta = Math.abs(a.row - b.row);
  const colDelta = Math.abs(a.col - b.col);
  if (rowDelta + colDelta !== 1) return false;
  if (a.row === b.row && RAIL_ROWS.has(a.row)) return true;
  if (
    a.col === b.col &&
    (a.col === 0 || a.col === 4) &&
    Math.min(a.row, b.row) >= 1 &&
    Math.max(a.row, b.row) <= 10
  ) {
    return true;
  }
  return a.col === 2 && b.col === 2 && Math.min(a.row, b.row) === 5 && Math.max(a.row, b.row) === 6;
}

export function isRoadEdge(a: Position, b: Position) {
  if (!isInsideBoard(a) || !isInsideBoard(b)) return false;
  const rowDelta = Math.abs(a.row - b.row);
  const colDelta = Math.abs(a.col - b.col);
  const crossesBorder = Math.min(a.row, b.row) === 5 && Math.max(a.row, b.row) === 6;
  if (rowDelta + colDelta === 1) {
    if (crossesBorder) return a.col === b.col && [0, 2, 4].includes(a.col);
    return true;
  }
  const sameHalf = (a.row <= 5 && b.row <= 5) || (a.row >= 6 && b.row >= 6);
  return rowDelta === 1 && colDelta === 1 && sameHalf && (isCamp(a) || isCamp(b));
}

function randomIndex(length: number) {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] % length;
}

function shuffle<T>(input: T[]) {
  const output = [...input];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1);
    [output[index], output[swapIndex]] = [output[swapIndex], output[index]];
  }
  return output;
}

function makeSidePieces(side: Side): Piece[] {
  const available = setupSlots(side);
  const positions = new Map<PieceType, Position[]>();
  const takePosition = (type: PieceType, predicate: (position: Position) => boolean) => {
    const choices = available.filter(predicate);
    const chosen = choices[randomIndex(choices.length)];
    available.splice(available.findIndex((position) => samePosition(position, chosen)), 1);
    const current = positions.get(type) ?? [];
    current.push(chosen);
    positions.set(type, current);
  };

  takePosition("flag", (position) => isAllowedSetupPosition("flag", side, position));
  for (let index = 0; index < PIECE_INFO.mine.count; index += 1) {
    takePosition("mine", (position) => isAllowedSetupPosition("mine", side, position));
  }
  for (let index = 0; index < PIECE_INFO.bomb.count; index += 1) {
    takePosition("bomb", (position) => isAllowedSetupPosition("bomb", side, position));
  }

  const regularTypes = PIECE_TYPES.filter((type) => !["flag", "mine", "bomb"].includes(type));
  const regularPieces = shuffle(
    regularTypes.flatMap((type) => Array.from({ length: PIECE_INFO[type].count }, () => type)),
  );
  shuffle(available).forEach((position, index) => {
    const type = regularPieces[index];
    const current = positions.get(type) ?? [];
    current.push(position);
    positions.set(type, current);
  });

  return shuffle(
    PIECE_TYPES.flatMap((type) =>
      (positions.get(type) ?? []).map((position) => ({
        id: `${side}-${crypto.randomUUID()}`,
        side,
        type,
        ...position,
        alive: true,
      })),
    ),
  );
}

export function gameModeForState(state: Pick<GameState, "rulesVersion">): GameMode {
  return state.rulesVersion === AUGMENT_RULES_VERSION ? "augment" : "classic";
}

function createAugmentRuntime(): AugmentRuntimeState {
  return {
    draft: createAugmentDraftState(),
    usedBySide: { black: [], white: [] },
    triggerCounts: { black: {}, white: {} },
    permanentReveals: { black: [], white: [] },
    temporaryReveals: { black: [], white: [] },
    pendingRecon: { black: null, white: null },
    extraMove: { black: null, white: null },
    resumeTurn: null,
    draftDeadlineAt: null,
  };
}

export function createInitialGame(): GameState {
  const initialMs = DEFAULT_TIME_CONTROL_MINUTES * 60 * 1000;
  return {
    rulesVersion: RULES_VERSION,
    phase: "setup",
    joined: { black: true, white: false },
    ready: { black: false, white: false },
    firstTurn: "black",
    turn: "black",
    winner: null,
    finishReason: null,
    revealedFlags: { black: false, white: false },
    pieces: [...makeSidePieces("black"), ...makeSidePieces("white")],
    events: [],
    moveNumber: 0,
    replay: null,
    clock: {
      initialMs,
      remainingMs: { black: initialMs, white: initialMs },
      turnStartedAt: null,
    },
  };
}

export function createAugmentGame(options: { ranked?: boolean } = {}): GameState {
  const initialMs = (options.ranked ? RANKED_TIME_CONTROL_MINUTES : DEFAULT_TIME_CONTROL_MINUTES) * 60 * 1000;
  return {
    ...createInitialGame(),
    rulesVersion: AUGMENT_RULES_VERSION,
    clock: {
      initialMs,
      remainingMs: { black: initialMs, white: initialMs },
      turnStartedAt: null,
      ...(options.ranked
        ? {
            incrementMs: RANKED_INCREMENT_MS,
            incrementThresholdMs: RANKED_INCREMENT_THRESHOLD_MS,
          }
        : {}),
    },
    augment: createAugmentRuntime(),
  };
}

export function validateSideSetup(
  pieces: Piece[],
  side: Side,
  augmentIds: readonly AugmentId[] = [],
) {
  const sidePieces = pieces.filter((piece) => piece.side === side && piece.alive);
  if (sidePieces.length !== 25) return false;
  const occupied = new Set(sidePieces.map(positionKey));
  if (occupied.size !== 25) return false;
  for (const type of PIECE_TYPES) {
    if (sidePieces.filter((piece) => piece.type === type).length !== PIECE_INFO[type].count) return false;
  }
  if (!sidePieces.every((piece) => isAllowedSetupPosition(piece.type, side, piece, augmentIds))) {
    return false;
  }
  const frontRow = side === "black" ? 6 : 5;
  const thirdRow = side === "black" ? 9 : 2;
  const frontBombs = sidePieces.filter((piece) => piece.type === "bomb" && piece.row === frontRow).length;
  const deepMines = sidePieces.filter((piece) => piece.type === "mine" && piece.row === thirdRow).length;
  return frontBombs <= (hasSetupAugment(augmentIds, "forward_bomb") ? 1 : 0) &&
    deepMines <= (hasSetupAugment(augmentIds, "deep_mine") ? 1 : 0);
}

function alivePieceAt(state: GameState, position: Position) {
  return state.pieces.find((piece) => piece.alive && samePosition(piece, position));
}

function setupPositionViolation(
  type: PieceType,
  side: Side,
  position: Position,
  augmentIds: readonly AugmentId[] = [],
) {
  if (!isInsideBoard(position) || !isSetupPosition(side, position) || isCamp(position)) {
    return "INVALID_LAYOUT";
  }
  if (type === "flag" && !isAllowedSetupPosition(type, side, position, augmentIds)) {
    return "FLAG_MUST_BE_HEADQUARTERS";
  }
  if (type === "mine" && !isAllowedSetupPosition(type, side, position, augmentIds)) {
    return "MINE_BACK_TWO_ROWS";
  }
  if (type === "bomb" && !isAllowedSetupPosition(type, side, position, augmentIds)) {
    return "BOMB_NOT_FRONT_ROW";
  }
  return null;
}

type SetupPieceLike = Pick<PublicPiece, "id" | "side" | "type" | "row" | "col" | "alive">;

function ownSetupPieces(pieces: readonly SetupPieceLike[], side: Side) {
  return pieces.filter(
    (piece): piece is SetupPieceLike & { type: PieceType } =>
      piece.alive && piece.side === side && Boolean(piece.type),
  );
}

export function createSetupDraft(
  pieces: readonly SetupPieceLike[],
  side: Side,
  useCurrentLayout = false,
  augmentIds: readonly AugmentId[] = [],
): SetupDraft {
  return Object.fromEntries(
    ownSetupPieces(pieces, side).map((piece) => [
      piece.id,
      useCurrentLayout && isAllowedSetupPosition(piece.type, side, piece, augmentIds)
        ? { row: piece.row, col: piece.col }
        : null,
    ]),
  );
}

export function isValidSetupDraft(
  pieces: readonly SetupPieceLike[],
  side: Side,
  draft: SetupDraft,
  requireComplete = false,
  augmentIds: readonly AugmentId[] = [],
) {
  const ownPieces = ownSetupPieces(pieces, side);
  const expectedIds = new Set(ownPieces.map((piece) => piece.id));
  const draftIds = Object.keys(draft);
  if (draftIds.length !== ownPieces.length || draftIds.some((id) => !expectedIds.has(id))) return false;

  const occupied = new Set<string>();
  for (const piece of ownPieces) {
    const position = draft[piece.id];
    if (position === null) {
      if (requireComplete) return false;
      continue;
    }
    if (!position || setupPositionViolation(piece.type, side, position, augmentIds)) return false;
    const key = positionKey(position);
    if (occupied.has(key)) return false;
    occupied.add(key);
  }
  if (setupExceptionQuotaViolation(ownPieces, side, (piece) => draft[piece.id], augmentIds)) {
    return false;
  }
  if (requireComplete) {
    const materialized = ownPieces.map((piece) => ({ ...piece, ...draft[piece.id] })) as Piece[];
    if (!validateSideSetup(materialized, side, augmentIds)) return false;
  }
  return true;
}

export function getSetupDraftPlacementViolation(
  pieces: readonly SetupPieceLike[],
  side: Side,
  draft: SetupDraft,
  pieceId: string,
  to: Position,
  augmentIds: readonly AugmentId[] = [],
): string | null {
  if (!isInsideBoard(to)) return "POSITION_OUT_OF_BOUNDS";
  if (!isSetupPosition(side, to)) return "INVALID_LAYOUT";
  if (isCamp(to)) return "CAMP_MUST_BE_EMPTY";

  const ownPieces = ownSetupPieces(pieces, side);
  const piece = ownPieces.find((candidate) => candidate.id === pieceId);
  if (!piece) return "PIECE_NOT_AVAILABLE";
  const from = draft[piece.id];
  if (from && samePosition(from, to)) return "SAME_POSITION";

  const target = ownPieces.find((candidate) => {
    const position = draft[candidate.id];
    return Boolean(position && samePosition(position, to));
  });
  const activeViolation = setupPositionViolation(piece.type, side, to, augmentIds);
  if (activeViolation) return activeViolation;
  if (from && target) {
    const displacedViolation = setupPositionViolation(target.type, side, from, augmentIds);
    if (displacedViolation) return displacedViolation;
  }
  return setupExceptionQuotaViolation(
    ownPieces,
    side,
    (candidate) => {
      if (candidate.id === piece.id) return to;
      if (target && candidate.id === target.id) return from;
      return draft[candidate.id];
    },
    augmentIds,
  );
}

export function applySetupDraftPlacement(
  pieces: readonly SetupPieceLike[],
  side: Side,
  draft: SetupDraft,
  pieceId: string,
  to: Position,
  augmentIds: readonly AugmentId[] = [],
) {
  const violation = getSetupDraftPlacementViolation(pieces, side, draft, pieceId, to, augmentIds);
  if (violation) throw new GameRuleError(violation);
  const ownPieces = ownSetupPieces(pieces, side);
  const from = draft[pieceId];
  const target = ownPieces.find((candidate) => {
    const position = draft[candidate.id];
    return Boolean(position && samePosition(position, to));
  });
  const next = { ...draft, [pieceId]: { row: to.row, col: to.col } };
  if (target) next[target.id] = from ? { ...from } : null;
  return next;
}

export function randomizeSetupDraft(
  pieces: readonly SetupPieceLike[],
  side: Side,
  augmentIds: readonly AugmentId[] = [],
) {
  const ownPieces = ownSetupPieces(pieces, side);
  if (ownPieces.length !== 25) throw new GameRuleError("INVALID_LAYOUT");
  for (const type of PIECE_TYPES) {
    if (ownPieces.filter((piece) => piece.type === type).length !== PIECE_INFO[type].count) {
      throw new GameRuleError("INVALID_LAYOUT");
    }
  }

  const available = setupSlots(side);
  const draft = createSetupDraft(pieces, side, false, augmentIds);
  let forwardBombsPlaced = 0;
  let deepMinesPlaced = 0;
  const frontRow = side === "black" ? 6 : 5;
  const thirdRow = side === "black" ? 9 : 2;
  const placePiece = (piece: SetupPieceLike & { type: PieceType }) => {
    const choices = available.filter((position) => {
      if (!isAllowedSetupPosition(piece.type, side, position, augmentIds)) return false;
      if (piece.type === "bomb" && position.row === frontRow && forwardBombsPlaced >= 1) {
        return false;
      }
      if (piece.type === "mine" && position.row === thirdRow && deepMinesPlaced >= 1) {
        return false;
      }
      return true;
    });
    if (!choices.length) throw new GameRuleError("INVALID_LAYOUT");
    const chosen = choices[randomIndex(choices.length)];
    available.splice(available.findIndex((position) => samePosition(position, chosen)), 1);
    draft[piece.id] = { ...chosen };
    if (piece.type === "bomb" && chosen.row === frontRow) forwardBombsPlaced += 1;
    if (piece.type === "mine" && chosen.row === thirdRow) deepMinesPlaced += 1;
  };

  for (const type of ["flag", "mine", "bomb"] as PieceType[]) {
    for (const piece of shuffle(ownPieces.filter((candidate) => candidate.type === type))) placePiece(piece);
  }
  const regularPieces = shuffle(
    ownPieces.filter((piece) => !["flag", "mine", "bomb"].includes(piece.type)),
  );
  const regularPositions = shuffle(available);
  regularPieces.forEach((piece, index) => {
    draft[piece.id] = { ...regularPositions[index] };
  });
  return draft;
}

export function setupDraftToLayout(
  pieces: readonly SetupPieceLike[],
  side: Side,
  draft: SetupDraft,
  augmentIds: readonly AugmentId[] = [],
) {
  if (!isValidSetupDraft(pieces, side, draft, true, augmentIds)) {
    const incomplete = ownSetupPieces(pieces, side).some((piece) => draft[piece.id] === null);
    throw new GameRuleError(incomplete ? "INCOMPLETE_LAYOUT" : "INVALID_LAYOUT");
  }
  return ownSetupPieces(pieces, side).map((piece) => ({
    pieceId: piece.id,
    ...draft[piece.id]!,
  }));
}

export function getSubmittedSetupLayoutViolation(
  pieces: readonly Piece[],
  side: Side,
  layout: readonly SetupPlacement[],
  augmentIds: readonly AugmentId[] = [],
) {
  const ownPieces = pieces.filter((piece) => piece.alive && piece.side === side);
  if (layout.length !== ownPieces.length) return "INCOMPLETE_LAYOUT";
  const byId = new Map<string, SetupPlacement>();
  for (const placement of layout) {
    if (byId.has(placement.pieceId)) return "INVALID_LAYOUT";
    byId.set(placement.pieceId, placement);
  }
  const occupied = new Set<string>();
  for (const piece of ownPieces) {
    const placement = byId.get(piece.id);
    if (!placement) return "PIECE_NOT_AVAILABLE";
    const violation = setupPositionViolation(piece.type, side, placement, augmentIds);
    if (violation) return violation;
    const key = positionKey(placement);
    if (occupied.has(key)) return "INVALID_LAYOUT";
    occupied.add(key);
  }
  if (byId.size !== ownPieces.length) return "PIECE_NOT_AVAILABLE";
  const materialized = ownPieces.map((piece) => ({ ...piece, ...byId.get(piece.id)! }));
  return validateSideSetup(materialized, side, augmentIds) ? null : "INVALID_LAYOUT";
}

export function getSetupSwapViolation(
  state: GameState,
  side: Side,
  from: Position,
  to: Position,
): string | null {
  if (state.phase !== "setup") return "GAME_ALREADY_STARTED";
  if (state.ready[side]) return "LAYOUT_LOCKED";
  if (!isInsideBoard(from) || !isInsideBoard(to)) return "POSITION_OUT_OF_BOUNDS";
  if (samePosition(from, to)) return "SAME_POSITION";
  if (isCamp(from) || isCamp(to)) return "CAMP_MUST_BE_EMPTY";
  const first = alivePieceAt(state, from);
  const second = alivePieceAt(state, to);
  if (!first || !second) return "INVALID_SWAP";
  if (first.side !== side || second.side !== side) return "NOT_YOUR_PIECE";
  const augmentIds = selectedSetupAugments(state, side);
  const positionalViolation =
    setupPositionViolation(first.type, side, to, augmentIds) ??
    setupPositionViolation(second.type, side, from, augmentIds);
  if (positionalViolation) return positionalViolation;
  const ownPieces = state.pieces.filter((piece) => piece.alive && piece.side === side);
  return setupExceptionQuotaViolation(
    ownPieces,
    side,
    (candidate) => candidate.id === first.id ? to : candidate.id === second.id ? from : candidate,
    augmentIds,
  );
}

function setupExceptionQuotaViolation(
  pieces: readonly (SetupPieceLike & { type: PieceType })[],
  side: Side,
  positionFor: (piece: SetupPieceLike & { type: PieceType }) => Position | null,
  augmentIds: readonly AugmentId[],
) {
  const frontRow = side === "black" ? 6 : 5;
  const thirdRow = side === "black" ? 9 : 2;
  let frontBombs = 0;
  let deepMines = 0;
  for (const piece of pieces) {
    const position = positionFor(piece);
    if (!position) continue;
    if (piece.type === "bomb" && position.row === frontRow) frontBombs += 1;
    if (piece.type === "mine" && position.row === thirdRow) deepMines += 1;
  }
  if (frontBombs > (hasSetupAugment(augmentIds, "forward_bomb") ? 1 : 0)) {
    return "BOMB_NOT_FRONT_ROW";
  }
  if (deepMines > (hasSetupAugment(augmentIds, "deep_mine") ? 1 : 0)) {
    return "MINE_BACK_TWO_ROWS";
  }
  return null;
}

export function getProjectedSetupSwapViolation(
  game: ProjectedGame,
  side: Side,
  from: Position,
  to: Position,
) {
  return getSetupSwapViolation(projectedAugmentState(game, side), side, from, to);
}

function railNeighbors(position: Position) {
  return [
    { row: position.row - 1, col: position.col },
    { row: position.row + 1, col: position.col },
    { row: position.row, col: position.col - 1 },
    { row: position.row, col: position.col + 1 },
  ].filter((neighbor) => isInsideBoard(neighbor) && isRailEdge(position, neighbor));
}

function railNetworkCanReach(from: Position, to: Position) {
  if (samePosition(from, to)) return false;
  const queue = [from];
  const visited = new Set([positionKey(from)]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const neighbor of railNeighbors(current)) {
      const key = positionKey(neighbor);
      if (visited.has(key)) continue;
      if (samePosition(neighbor, to)) return true;
      visited.add(key);
      queue.push(neighbor);
    }
  }
  return false;
}

function engineerCanReach(state: GameState, from: Position, to: Position) {
  const queue = [from];
  const visited = new Set([positionKey(from)]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const neighbor of railNeighbors(current)) {
      const key = positionKey(neighbor);
      if (visited.has(key)) continue;
      if (samePosition(neighbor, to)) return true;
      if (alivePieceAt(state, neighbor)) continue;
      visited.add(key);
      queue.push(neighbor);
    }
  }
  return false;
}

function straightRailRouteExists(from: Position, to: Position) {
  if (samePosition(from, to) || (from.row !== to.row && from.col !== to.col)) return false;
  const rowStep = Math.sign(to.row - from.row);
  const colStep = Math.sign(to.col - from.col);
  let current = { row: from.row, col: from.col };
  while (!samePosition(current, to)) {
    const next = { row: current.row + rowStep, col: current.col + colStep };
    if (!isRailEdge(current, next)) return false;
    current = next;
  }
  return true;
}

function straightRailCanReach(state: GameState, from: Position, to: Position) {
  if (!straightRailRouteExists(from, to)) return false;
  if (from.row !== to.row && from.col !== to.col) return false;
  const rowStep = Math.sign(to.row - from.row);
  const colStep = Math.sign(to.col - from.col);
  let current = { row: from.row, col: from.col };
  while (!samePosition(current, to)) {
    const next = { row: current.row + rowStep, col: current.col + colStep };
    if (!isRailEdge(current, next)) return false;
    current = next;
    if (!samePosition(current, to) && alivePieceAt(state, current)) return false;
  }
  return true;
}

export function getMoveViolation(
  state: GameState,
  side: Side,
  from: Position,
  to: Position,
): string | null {
  if (state.phase === "finished") return "GAME_FINISHED";
  if (state.phase !== "playing") return "GAME_NOT_STARTED";
  if (state.turn !== side) return "NOT_YOUR_TURN";
  if (!isInsideBoard(from) || !isInsideBoard(to)) return "POSITION_OUT_OF_BOUNDS";
  if (samePosition(from, to)) return "SAME_POSITION";
  const piece = alivePieceAt(state, from);
  if (!piece) return "NO_PIECE_AT_SOURCE";
  if (piece.side !== side) return "NOT_YOUR_PIECE";
  if (state.augment?.pendingRecon[side]) return "RECON_SELECTION_REQUIRED";
  const extraMove = state.augment?.extraMove[side];
  if (extraMove && piece.id === extraMove.excludedPieceId) return "EXTRA_MOVE_DIFFERENT_PIECE";
  if (piece.type === "flag") return "FLAG_CANNOT_MOVE";
  if (piece.type === "mine") return "MINE_CANNOT_MOVE";
  if (isHeadquarters(from)) return "HEADQUARTERS_LOCKED";
  const target = alivePieceAt(state, to);
  if (target?.side === side) return "DESTINATION_OCCUPIED_BY_ALLY";
  if (target && isCamp(to)) return "CAMP_PROTECTED";
  if (isRoadEdge(from, to)) return null;
  if (piece.type === "engineer") {
    if (engineerCanReach(state, from, to)) return null;
    return railNetworkCanReach(from, to) ? "RAIL_PATH_BLOCKED" : "ROAD_ONE_STEP_ONLY";
  }
  if (straightRailCanReach(state, from, to)) return null;
  if (straightRailRouteExists(from, to)) return "RAIL_PATH_BLOCKED";
  if (railNetworkCanReach(from, to)) return "ENGINEER_ONLY_RAIL_TURN";
  return "ROAD_ONE_STEP_ONLY";
}

export function isLegalMove(state: GameState, side: Side, from: Position, to: Position) {
  return getMoveViolation(state, side, from, to) === null;
}

export function getLegalTargets(state: GameState, side: Side, from: Position) {
  const targets: Position[] = [];
  for (let row = 0; row < 12; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      const to = { row, col };
      if (isLegalMove(state, side, from, to)) targets.push(to);
    }
  }
  return targets;
}

function projectedMovementState(game: ProjectedGame): GameState {
  return {
    rulesVersion: game.rulesVersion,
    phase: game.phase,
    joined: { ...game.joined },
    ready: { ...game.ready },
    firstTurn: game.turn,
    turn: game.turn,
    winner: game.winner,
    finishReason: game.finishReason,
    revealedFlags: { ...game.revealedFlags },
    pieces: game.pieces.map((piece) => ({
      ...piece,
      type: piece.type ?? "platoon",
    })),
    events: game.events,
    moveNumber: game.moveNumber,
    replay: null,
    clock: null,
  };
}

export function getProjectedMoveViolation(
  game: ProjectedGame,
  side: Side,
  from: Position,
  to: Position,
) {
  if (game.augment?.pendingRecon) return "RECON_SELECTION_REQUIRED";
  const piece = game.pieces.find(
    (candidate) => candidate.alive && candidate.side === side && samePosition(candidate, from),
  );
  if (game.augment?.extraMove && piece?.id === game.augment.extraMove.excludedPieceId) {
    return "EXTRA_MOVE_DIFFERENT_PIECE";
  }
  return getMoveViolation(projectedMovementState(game), side, from, to);
}

export function getProjectedLegalTargets(game: ProjectedGame, side: Side, from: Position) {
  const targets: Position[] = [];
  for (let row = 0; row < 12; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      const to = { row, col };
      if (getProjectedMoveViolation(game, side, from, to) === null) targets.push(to);
    }
  }
  return targets;
}

function requireAugmentState(state: GameState) {
  if (state.rulesVersion !== AUGMENT_RULES_VERSION || !state.augment) {
    throw new GameRuleError("AUGMENT_MODE_REQUIRED");
  }
  return state.augment;
}

function selectedSetupAugments(state: GameState, side: Side): AugmentId[] {
  if (!state.augment) return [];
  return [...state.augment.draft.loadouts[side]];
}

function ownsAugment(state: GameState, side: Side, augmentId: AugmentId) {
  return Boolean(state.augment?.draft.loadouts[side].includes(augmentId));
}

function augmentUses(state: GameState, side: Side, augmentId: AugmentId) {
  return state.augment?.triggerCounts[side][augmentId] ?? 0;
}

function augmentAvailable(state: GameState, side: Side, augmentId: AugmentId) {
  return ownsAugment(state, side, augmentId) &&
    augmentUses(state, side, augmentId) < getAugmentDefinition(augmentId).charges;
}

function markAugmentUse(
  state: GameState,
  side: Side,
  augmentId: AugmentId,
  movement?: { from: Position; to: Position },
) {
  const augment = requireAugmentState(state);
  augment.triggerCounts[side][augmentId] = augmentUses(state, side, augmentId) + 1;
  if (!augment.usedBySide[side].includes(augmentId)) augment.usedBySide[side].push(augmentId);
  addEvent(state, {
    actor: side,
    result: "augment_used",
    augmentId,
    ...(movement ? { from: { ...movement.from }, to: { ...movement.to } } : {}),
  });
}

function directionKey(from: Position, to: Position) {
  return `${Math.sign(to.row - from.row)},${Math.sign(to.col - from.col)}`;
}

function railTurnCanReach(state: GameState, from: Position, to: Position) {
  const queue: Array<{ position: Position; direction: string | null; turns: number }> = [
    { position: from, direction: null, turns: 0 },
  ];
  const visited = new Set<string>([`${positionKey(from)}:*:0`]);
  while (queue.length) {
    const current = queue.shift()!;
    for (const neighbor of railNeighbors(current.position)) {
      const direction = directionKey(current.position, neighbor);
      const turns = current.direction && current.direction !== direction ? current.turns + 1 : current.turns;
      if (turns > 1) continue;
      if (samePosition(neighbor, to)) return true;
      if (alivePieceAt(state, neighbor)) continue;
      const key = `${positionKey(neighbor)}:${direction}:${turns}`;
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push({ position: neighbor, direction, turns });
    }
  }
  return false;
}

function isFriendlyHalfCamp(side: Side, position: Position) {
  return isCamp(position) && (side === "black" ? position.row >= 6 : position.row <= 5);
}

export function getAugmentMoveViolation(
  state: GameState,
  side: Side,
  augmentId: AugmentId,
  from: Position,
  to: Position,
): string | null {
  if (state.phase !== "playing") return "GAME_NOT_STARTED";
  if (state.turn !== side) return "NOT_YOUR_TURN";
  if (state.augment?.pendingRecon[side]) return "RECON_SELECTION_REQUIRED";
  if (state.augment?.extraMove[side]) return "EXTRA_MOVE_NORMAL_ONLY";
  if (!augmentAvailable(state, side, augmentId)) return "AUGMENT_NOT_AVAILABLE";
  const definition = getAugmentDefinition(augmentId);
  if (definition.effect.kind !== "movement") return "AUGMENT_ACTION_MISMATCH";
  if (!isInsideBoard(from) || !isInsideBoard(to)) return "POSITION_OUT_OF_BOUNDS";
  if (samePosition(from, to)) return "SAME_POSITION";
  const piece = alivePieceAt(state, from);
  if (!piece) return "NO_PIECE_AT_SOURCE";
  if (piece.side !== side) return "NOT_YOUR_PIECE";
  if (piece.type === "flag") return "FLAG_CANNOT_MOVE";
  if (piece.type === "mine") return "MINE_CANNOT_MOVE";
  if (isHeadquarters(from)) return "HEADQUARTERS_LOCKED";
  const target = alivePieceAt(state, to);
  if (target?.side === side) return "DESTINATION_OCCUPIED_BY_ALLY";
  if (target && isCamp(to)) return "CAMP_PROTECTED";

  const mode = definition.effect.mode;
  if (mode === "engineer_rail") {
    return engineerCanReach(state, from, to) ? null : "AUGMENT_PATH_INVALID";
  }
  if (target) return "AUGMENT_REQUIRES_EMPTY_TARGET";
  if (mode === "rail_turn") {
    if (piece.type === "engineer") return "AUGMENT_PIECE_INELIGIBLE";
    return railTurnCanReach(state, from, to) ? null : "AUGMENT_PATH_INVALID";
  }
  if (mode === "road_dash") {
    for (let row = 0; row < 12; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        const middle = { row, col };
        if (isRoadEdge(from, middle) && isRoadEdge(middle, to) && !alivePieceAt(state, middle)) {
          return null;
        }
      }
    }
    return "AUGMENT_PATH_INVALID";
  }
  if (mode === "rail_jump") {
    const rowDelta = to.row - from.row;
    const colDelta = to.col - from.col;
    if (!((Math.abs(rowDelta) === 2 && colDelta === 0) || (Math.abs(colDelta) === 2 && rowDelta === 0))) {
      return "AUGMENT_PATH_INVALID";
    }
    const middle = { row: from.row + rowDelta / 2, col: from.col + colDelta / 2 };
    const jumped = alivePieceAt(state, middle);
    return isRailEdge(from, middle) &&
      isRailEdge(middle, to) &&
      jumped?.side === side
      ? null
      : "AUGMENT_PATH_INVALID";
  }
  if (!isCamp(from) || !isFriendlyHalfCamp(side, to)) return "AUGMENT_PATH_INVALID";
  return null;
}

export function getAugmentExchangeViolation(
  state: GameState,
  side: Side,
  augmentId: AugmentId,
  from: Position,
  to: Position,
) {
  if (state.phase !== "playing") return "GAME_NOT_STARTED";
  if (state.turn !== side) return "NOT_YOUR_TURN";
  if (state.augment?.pendingRecon[side]) return "RECON_SELECTION_REQUIRED";
  if (state.augment?.extraMove[side]) return "EXTRA_MOVE_NORMAL_ONLY";
  if (!augmentAvailable(state, side, augmentId)) return "AUGMENT_NOT_AVAILABLE";
  const definition = getAugmentDefinition(augmentId);
  if (definition.effect.kind !== "exchange") return "AUGMENT_ACTION_MISMATCH";
  const first = alivePieceAt(state, from);
  const second = alivePieceAt(state, to);
  if (!first || !second) return "INVALID_SWAP";
  if (first.side !== side || second.side !== side) return "NOT_YOUR_PIECE";
  if ([first.type, second.type].some((type) => type === "flag" || type === "mine")) {
    return "AUGMENT_PIECE_INELIGIBLE";
  }
  if (isHeadquarters(first) || isHeadquarters(second)) return "HEADQUARTERS_LOCKED";
  if (definition.effect.mode === "same_rank") {
    return first.type === second.type ? null : "AUGMENT_PIECE_INELIGIBLE";
  }
  return isRoadEdge(from, to) ? null : "AUGMENT_PATH_INVALID";
}

function projectedAugmentState(game: ProjectedGame, side: Side): GameState {
  const state = projectedMovementState(game);
  if (!game.augment) return state;
  state.augment = {
    draft: {
      catalogVersion: game.augment.draft.catalogVersion,
      activeRound: null,
      rounds: [],
      seenBySide: { black: [], white: [] },
      loadouts: {
        black: [...game.augment.draft.loadouts.black],
        white: [...game.augment.draft.loadouts.white],
      },
    },
    usedBySide: {
      black: [...game.augment.usedBySide.black],
      white: [...game.augment.usedBySide.white],
    },
    triggerCounts: {
      black: { ...game.augment.triggerCounts.black },
      white: { ...game.augment.triggerCounts.white },
    },
    permanentReveals: { black: [], white: [] },
    temporaryReveals: { black: [], white: [] },
    pendingRecon: { black: null, white: null, [side]: game.augment.pendingRecon },
    extraMove: { black: null, white: null, [side]: game.augment.extraMove },
    resumeTurn: null,
    draftDeadlineAt: game.augment.draftDeadlineAt,
  };
  return state;
}

export function getProjectedAugmentMoveViolation(
  game: ProjectedGame,
  side: Side,
  augmentId: AugmentId,
  from: Position,
  to: Position,
) {
  return getAugmentMoveViolation(projectedAugmentState(game, side), side, augmentId, from, to);
}

export function getProjectedAugmentLegalTargets(
  game: ProjectedGame,
  side: Side,
  augmentId: AugmentId,
  from: Position,
) {
  const state = projectedAugmentState(game, side);
  const targets: Position[] = [];
  for (let row = 0; row < 12; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      const to = { row, col };
      if (getAugmentMoveViolation(state, side, augmentId, from, to) === null) targets.push(to);
    }
  }
  return targets;
}

export function getProjectedAugmentExchangeViolation(
  game: ProjectedGame,
  side: Side,
  augmentId: AugmentId,
  from: Position,
  to: Position,
) {
  return getAugmentExchangeViolation(projectedAugmentState(game, side), side, augmentId, from, to);
}

function hasAnyLegalMove(state: GameState, side: Side) {
  const stateForSide = { ...state, turn: side };
  return state.pieces.some(
    (piece) => piece.alive && piece.side === side && getLegalTargets(stateForSide, side, piece).length > 0,
  );
}

function hasAnyLegalAction(state: GameState, side: Side) {
  const stateForSide = { ...state, turn: side } as GameState;
  if (hasAnyLegalMove(stateForSide, side)) return true;
  if (stateForSide.augment?.pendingRecon[side]) {
    return availableReconTargets(stateForSide, side).length > 0;
  }
  const ownPieces = stateForSide.pieces.filter(
    (piece) => piece.alive && piece.side === side && piece.type !== "flag" && piece.type !== "mine",
  );
  for (const augmentId of stateForSide.augment?.draft.loadouts[side] ?? []) {
    if (!augmentAvailable(stateForSide, side, augmentId)) continue;
    const effect = getAugmentDefinition(augmentId).effect;
    if (effect.kind === "movement") {
      for (const piece of ownPieces) {
        for (let row = 0; row < 12; row += 1) {
          for (let col = 0; col < 5; col += 1) {
            if (!getAugmentMoveViolation(stateForSide, side, augmentId, piece, { row, col })) return true;
          }
        }
      }
    } else if (effect.kind === "exchange") {
      for (let first = 0; first < ownPieces.length; first += 1) {
        for (let second = first + 1; second < ownPieces.length; second += 1) {
          if (!getAugmentExchangeViolation(stateForSide, side, augmentId, ownPieces[first], ownPieces[second])) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

function addEvent(state: GameState, event: Omit<PublicEvent, "id">) {
  state.events.push({ id: (state.events.at(-1)?.id ?? 0) + 1, ...event });
  state.events = state.events.slice(-16);
}

function clockRemainingAt(state: GameState, side: Side, nowMs: number) {
  const clock = state.clock;
  if (!clock) return 0;
  const stored = Math.max(0, clock.remainingMs[side]);
  if (
    state.phase !== "playing" ||
    state.turn !== side ||
    clock.turnStartedAt === null
  ) {
    return stored;
  }
  return Math.max(0, stored - Math.max(0, nowMs - clock.turnStartedAt));
}

function stopClock(state: GameState) {
  if (state.clock) state.clock.turnStartedAt = null;
}

function commitRunningClock(state: GameState, nowMs: number) {
  if (!state.clock || state.phase !== "playing" || state.clock.turnStartedAt === null) return;
  state.clock.remainingMs[state.turn] = clockRemainingAt(state, state.turn, nowMs);
  state.clock.turnStartedAt = nowMs;
}

export function settleExpiredClock(state: GameState, nowMs = Date.now()) {
  if (
    !state.clock ||
    state.phase !== "playing" ||
    state.clock.turnStartedAt === null ||
    clockRemainingAt(state, state.turn, nowMs) > 0
  ) {
    return false;
  }
  const timedOut = state.turn;
  state.clock.remainingMs[timedOut] = 0;
  state.clock.turnStartedAt = null;
  state.phase = "finished";
  state.winner = otherSide(timedOut);
  state.finishReason = "timeout";
  addEvent(state, { actor: timedOut, result: "timeout" });
  return true;
}

function projectClock(state: GameState, nowMs: number): PublicClock | null {
  if (!state.clock) return null;
  return {
    initialMs: state.clock.initialMs,
    remainingMs: {
      black: clockRemainingAt(state, "black", nowMs),
      white: clockRemainingAt(state, "white", nowMs),
    },
    running:
      state.phase === "playing" && state.clock.turnStartedAt !== null ? state.turn : null,
    ...(state.clock.incrementMs ? { incrementMs: state.clock.incrementMs } : {}),
    ...(state.clock.incrementThresholdMs
      ? { incrementThresholdMs: state.clock.incrementThresholdMs }
      : {}),
  };
}

function clonePiece(piece: Piece): Piece {
  return { ...piece };
}

function createReplayArchive(state: GameState): ReplayArchive {
  return {
    baselineMoveNumber: state.moveNumber,
    partial: state.moveNumber > 0,
    initialPieces: state.pieces.map(clonePiece),
    moves: [],
  };
}

function ensureReplayArchive(state: GameState) {
  state.replay ??= createReplayArchive(state);
  return state.replay;
}

function cloneReplayArchive(replay: ReplayArchive): ReplayArchive {
  return {
    baselineMoveNumber: replay.baselineMoveNumber,
    partial: replay.partial,
    initialPieces: replay.initialPieces.map(clonePiece),
    moves: replay.moves.map((move) => ({
      ...move,
      from: { ...move.from },
      to: { ...move.to },
      secondaryFrom: move.secondaryFrom ? { ...move.secondaryFrom } : undefined,
      secondaryTo: move.secondaryTo ? { ...move.secondaryTo } : undefined,
    })),
  };
}

function publicReplayPieces(pieces: readonly Piece[]): PublicPiece[] {
  return pieces.map((piece) => ({
    ...piece,
    type: piece.type,
    flagRevealed: piece.type === "flag",
  }));
}

export function buildReplayFrames(replay: ReplayArchive | null): ReplayFrame[] {
  if (!replay) return [];
  const pieces = replay.initialPieces.map(clonePiece);
  const frames: ReplayFrame[] = [
    {
      moveNumber: replay.baselineMoveNumber,
      move: null,
      pieces: publicReplayPieces(pieces),
    },
  ];

  for (const recordedMove of replay.moves) {
    const move: ReplayMove = {
      ...recordedMove,
      from: { ...recordedMove.from },
      to: { ...recordedMove.to },
      secondaryFrom: recordedMove.secondaryFrom ? { ...recordedMove.secondaryFrom } : undefined,
      secondaryTo: recordedMove.secondaryTo ? { ...recordedMove.secondaryTo } : undefined,
    };
    if (move.kind === "exchange" && move.secondaryFrom && move.secondaryTo) {
      const first = pieces.find(
        (piece) => piece.alive && piece.side === move.actor && samePosition(piece, move.from),
      );
      const second = pieces.find(
        (piece) => piece.alive && piece.side === move.actor && samePosition(piece, move.secondaryFrom!),
      );
      if (!first || !second) break;
      [first.row, second.row] = [second.row, first.row];
      [first.col, second.col] = [second.col, first.col];
      frames.push({ moveNumber: move.moveNumber, move, pieces: publicReplayPieces(pieces) });
      continue;
    }
    const attacker = pieces.find(
      (piece) => piece.alive && piece.side === move.actor && samePosition(piece, move.from),
    );
    const defender = pieces.find(
      (piece) => piece.alive && piece.side !== move.actor && samePosition(piece, move.to),
    );
    if (!attacker) break;

    if (move.result === "move") {
      attacker.row = move.to.row;
      attacker.col = move.to.col;
    } else if (move.result === "attacker_survives") {
      if (defender) defender.alive = false;
      attacker.row = move.to.row;
      attacker.col = move.to.col;
    } else if (move.result === "defender_survives") {
      if (move.augmentId !== "spade-tactical-retreat") attacker.alive = false;
    } else if (move.result === "both_removed") {
      attacker.alive = false;
      if (defender) defender.alive = false;
    } else {
      if (defender) defender.alive = false;
      if (attacker.type === "bomb") attacker.alive = false;
      else {
        attacker.row = move.to.row;
        attacker.col = move.to.col;
      }
    }

    frames.push({
      moveNumber: move.moveNumber,
      move,
      pieces: publicReplayPieces(pieces),
    });
  }
  return frames;
}

function revealFlagWhenCommanderFalls(state: GameState, piece: Piece | undefined) {
  if (piece?.type === "commander" && !piece.alive) state.revealedFlags[piece.side] = true;
}

function randomAliveEnemyInFront(state: GameState, owner: Side) {
  const enemy = otherSide(owner);
  const rows = enemy === "black" ? [6, 7] : [4, 5];
  const candidates = state.pieces.filter(
    (piece) => piece.alive && piece.side === enemy && rows.includes(piece.row),
  );
  return candidates.length ? candidates[randomIndex(candidates.length)] : null;
}

function availableReconTargets(state: GameState, owner: Side) {
  const augment = requireAugmentState(state);
  const known = new Set([
    ...augment.permanentReveals[owner],
    ...augment.temporaryReveals[owner],
  ]);
  return state.pieces.filter(
    (piece) => piece.alive && piece.side !== owner && !known.has(piece.id),
  );
}

function applyAugmentRevealTriggers(state: GameState, roundNumber: 1 | 2) {
  const augment = requireAugmentState(state);
  const round = augment.draft.rounds.find((candidate) => candidate.number === roundNumber);
  if (!round?.revealed) throw new GameRuleError("AUGMENT_ROUND_NOT_REVEALED");
  for (const side of ["black", "white"] as const) {
    const augmentId = round.players[side].selectedId;
    if (!augmentId) continue;
    const definition = getAugmentDefinition(augmentId);
    const effect = definition.effect;
    if (effect.kind === "reconnaissance" && effect.mode === "choose_enemy") {
      const remaining = Math.min(effect.count, availableReconTargets(state, side).length);
      if (remaining > 0) augment.pendingRecon[side] = { augmentId, remaining };
      else markAugmentUse(state, side, augmentId);
    } else if (effect.kind === "reconnaissance" && effect.mode === "frontline_random") {
      const target = randomAliveEnemyInFront(state, side);
      if (target && !augment.temporaryReveals[side].includes(target.id)) {
        augment.temporaryReveals[side].push(target.id);
      }
      markAugmentUse(state, side, augmentId);
    } else if (effect.kind === "clock" && effect.mode === "flat_bonus") {
      if (state.clock) state.clock.remainingMs[side] += effect.bonusMs;
      markAugmentUse(state, side, augmentId);
    } else if (effect.kind === "setup") {
      markAugmentUse(state, side, augmentId);
    }
  }
  addEvent(state, { actor: state.turn, result: "augment_revealed" });
}

function maybeApplyLowTimeRescue(state: GameState, side: Side) {
  if (!state.clock || state.phase !== "playing") return;
  for (const augmentId of state.augment?.draft.loadouts[side] ?? []) {
    const effect = getAugmentDefinition(augmentId).effect;
    if (
      effect.kind === "clock" &&
      effect.mode === "low_time_rescue" &&
      augmentAvailable(state, side, augmentId) &&
      state.clock.remainingMs[side] < effect.thresholdMs
    ) {
      state.clock.remainingMs[side] += effect.bonusMs;
      markAugmentUse(state, side, augmentId);
    }
  }
}

function applyPostMoveClockBonuses(state: GameState, side: Side) {
  if (!state.clock) return;
  if (
    state.clock.incrementMs &&
    state.clock.incrementThresholdMs &&
    state.clock.remainingMs[side] <= state.clock.incrementThresholdMs
  ) {
    state.clock.remainingMs[side] = Math.min(
      state.clock.incrementThresholdMs,
      state.clock.remainingMs[side] + state.clock.incrementMs,
    );
  }
  for (const augmentId of state.augment?.draft.loadouts[side] ?? []) {
    const effect = getAugmentDefinition(augmentId).effect;
    if (
      effect.kind === "clock" &&
      effect.mode === "move_increment" &&
      augmentAvailable(state, side, augmentId)
    ) {
      state.clock.remainingMs[side] += effect.bonusMs;
      markAugmentUse(state, side, augmentId);
    }
  }
}

function resolveTurnAfterSecondDraft(state: GameState) {
  maybeApplyLowTimeRescue(state, state.turn);
  if (hasAnyLegalAction(state, state.turn)) return;
  const stalledSide = state.turn;
  if (state.augment?.extraMove[stalledSide]) {
    state.augment.extraMove[stalledSide] = null;
    state.turn = otherSide(stalledSide);
    maybeApplyLowTimeRescue(state, state.turn);
    if (hasAnyLegalAction(state, state.turn)) return;
    state.phase = "finished";
    state.winner = stalledSide;
    state.finishReason = "no_moves";
    stopClock(state);
    return;
  }
  state.phase = "finished";
  state.winner = otherSide(stalledSide);
  state.finishReason = "no_moves";
  stopClock(state);
}

function finalizeSecondAugmentDraft(state: GameState, nowMs: number) {
  const augment = requireAugmentState(state);
  const activeRound = augment.draft.rounds.find(
    (round) => round.number === augment.draft.activeRound,
  );
  if (!activeRound?.players.black.locked || !activeRound.players.white.locked) return false;
  augment.draft = revealCurrentAugmentRound(augment.draft);
  state.turn = augment.resumeTurn ?? state.turn;
  augment.resumeTurn = null;
  augment.draftDeadlineAt = null;
  state.phase = "playing";
  applyAugmentRevealTriggers(state, 2);
  resolveTurnAfterSecondDraft(state);
  if (state.phase === "playing" && state.clock) state.clock.turnStartedAt = nowMs;
  return true;
}

export function settleExpiredAugmentDraft(state: GameState, nowMs = Date.now()) {
  if (state.phase !== "augment_draft" || !state.augment) return false;
  if (
    typeof state.augment.draftDeadlineAt !== "number" ||
    !Number.isFinite(state.augment.draftDeadlineAt)
  ) {
    state.augment.draftDeadlineAt = nowMs + SECOND_AUGMENT_DRAFT_DURATION_MS;
    return true;
  }
  if (nowMs < state.augment.draftDeadlineAt) return false;
  const round = state.augment.draft.rounds.find(
    (candidate) => candidate.number === state.augment?.draft.activeRound,
  );
  if (!round) throw new GameRuleError("NO_ACTIVE_DRAFT");
  for (const side of ["black", "white"] as const) {
    if (round.players[side].locked) continue;
    if (!round.players[side].selectedId) {
      state.augment.draft = selectAugment(
        state.augment.draft,
        side,
        round.players[side].options[0],
      );
    }
    state.augment.draft = lockAugmentSelection(state.augment.draft, side);
  }
  finalizeSecondAugmentDraft(state, nowMs);
  return true;
}

export const settleAugmentDraftDeadline = settleExpiredAugmentDraft;

function beginSecondDraftIfDue(state: GameState, nowMs: number) {
  if (!state.augment || !isSecondAugmentDraftDue(state.augment.draft, state.moveNumber)) return false;
  state.augment.draft = beginSecondAugmentDraft(state.augment.draft);
  state.augment.resumeTurn = state.turn;
  state.augment.draftDeadlineAt = nowMs + AUGMENT_DRAFT_TIMEOUT_MS;
  state.phase = "augment_draft";
  stopClock(state);
  return true;
}

function applyMove(
  state: GameState,
  side: Side,
  from: Position,
  to: Position,
  augmentId?: AugmentId,
  nowMs = Date.now(),
) {
  const violation = augmentId
    ? getAugmentMoveViolation(state, side, augmentId, from, to)
    : getMoveViolation(state, side, from, to);
  if (violation) throw new GameRuleError(violation);
  const replay = ensureReplayArchive(state);
  const attacker = alivePieceAt(state, from)!;
  const defender = alivePieceAt(state, to);
  const movingPieceId = attacker.id;
  const attackedHeadquarters = Boolean(defender && isHeadquarters(to));
  let result: BattleResult = "move";
  let resolutionAugmentId: AugmentId | undefined;

  if (!defender) {
    attacker.row = to.row;
    attacker.col = to.col;
  } else {
    if (defender.type === "flag") {
      defender.alive = false;
      if (attacker.type === "bomb") attacker.alive = false;
      else {
        attacker.row = to.row;
        attacker.col = to.col;
      }
      state.phase = "finished";
      state.winner = side;
      state.finishReason = "flag";
      state.revealedFlags[defender.side] = true;
      result = "flag_captured";
    } else if (
      attacker.type === "engineer" &&
      defender.type === "bomb" &&
      augmentAvailable(state, side, "heart-bomb-disposal")
    ) {
      defender.alive = false;
      attacker.row = to.row;
      attacker.col = to.col;
      result = "attacker_survives";
      resolutionAugmentId = "heart-bomb-disposal";
      markAugmentUse(state, side, "heart-bomb-disposal");
    } else if (attacker.type === "bomb" || defender.type === "bomb") {
      attacker.alive = false;
      defender.alive = false;
      result = "both_removed";
    } else if (defender.type === "mine") {
      if (attacker.type === "engineer") {
        defender.alive = false;
        attacker.row = to.row;
        attacker.col = to.col;
        result = "attacker_survives";
      } else {
        attacker.alive = false;
        result = "defender_survives";
      }
    } else {
      const attackerStrength = PIECE_INFO[attacker.type].strength ?? -1;
      const defenderStrength = PIECE_INFO[defender.type].strength ?? -1;
      if (attackerStrength > defenderStrength) {
        defender.alive = false;
        attacker.row = to.row;
        attacker.col = to.col;
        result = "attacker_survives";
      } else if (attackerStrength < defenderStrength) {
        attacker.alive = false;
        result = "defender_survives";
      } else {
        attacker.alive = false;
        defender.alive = false;
        result = "both_removed";
      }
    }

    if (
      !attacker.alive &&
      defender.alive &&
      augmentAvailable(state, side, "spade-tactical-retreat")
    ) {
      attacker.alive = true;
      result = "defender_survives";
      resolutionAugmentId = "spade-tactical-retreat";
      markAugmentUse(state, side, "spade-tactical-retreat");
    }
    if (
      attacker.type === "engineer" &&
      !attacker.alive &&
      defender.alive &&
      defender.type !== "mine" &&
      augmentAvailable(state, side, "diamond-engineer-screen")
    ) {
      defender.alive = false;
      result = "both_removed";
      resolutionAugmentId = "diamond-engineer-screen";
      markAugmentUse(state, side, "diamond-engineer-screen");
    } else if (
      defender.type === "engineer" &&
      !defender.alive &&
      attacker.alive &&
      augmentAvailable(state, defender.side, "diamond-engineer-screen")
    ) {
      attacker.alive = false;
      attacker.row = from.row;
      attacker.col = from.col;
      result = "both_removed";
      resolutionAugmentId = "diamond-engineer-screen";
      markAugmentUse(state, defender.side, "diamond-engineer-screen");
    }
    revealFlagWhenCommanderFalls(state, attacker);
    revealFlagWhenCommanderFalls(state, defender);
    if (attackedHeadquarters && defender.type !== "flag") state.revealedFlags[defender.side] = true;
  }

  state.moveNumber += 1;
  replay.moves.push({
    moveNumber: state.moveNumber,
    actor: side,
    from: { ...from },
    to: { ...to },
    result,
    ...(augmentId ?? resolutionAugmentId ? { augmentId: augmentId ?? resolutionAugmentId } : {}),
  });
  if (augmentId) markAugmentUse(state, side, augmentId);
  if (state.augment) {
    for (const revealSide of ["black", "white"] as const) {
      state.augment.temporaryReveals[revealSide] = state.augment.temporaryReveals[revealSide]
        .filter((pieceId) => pieceId !== movingPieceId);
    }
  }
  applyPostMoveClockBonuses(state, side);

  const wasExtraMove = state.augment?.extraMove[side] ?? null;
  if (wasExtraMove) state.augment!.extraMove[side] = null;
  let grantedExtra = false;
  if (!augmentId && !wasExtraMove && state.phase !== "finished") {
    const captured = result === "attacker_survives";
    const candidate = captured ? "spade-relentless-assault" : result === "move" ? "heart-initiative" : null;
    if (candidate && augmentAvailable(state, side, candidate)) {
      markAugmentUse(state, side, candidate);
      state.augment!.extraMove[side] = { augmentId: candidate, excludedPieceId: movingPieceId };
      grantedExtra = true;
    }
  }
  addEvent(state, { actor: side, from, to, result, augmentId: augmentId ?? resolutionAugmentId });
  if (state.phase === "finished") return;

  const nextSide = otherSide(side);
  state.turn = grantedExtra ? side : nextSide;
  if (beginSecondDraftIfDue(state, nowMs)) return;
  maybeApplyLowTimeRescue(state, state.turn);
  if (!hasAnyLegalAction(state, state.turn)) {
    if (grantedExtra && state.augment?.extraMove[side]) {
      state.augment.extraMove[side] = null;
      state.turn = nextSide;
      maybeApplyLowTimeRescue(state, nextSide);
      if (!hasAnyLegalAction(state, nextSide)) {
        state.phase = "finished";
        state.winner = side;
        state.finishReason = "no_moves";
      }
    } else {
      state.phase = "finished";
      state.winner = side;
      state.finishReason = "no_moves";
    }
  }
}

export function applyPlayerAction(
  current: GameState,
  side: Side,
  action: PlayerAction,
  nowMs = Date.now(),
) {
  const state = JSON.parse(JSON.stringify(current)) as GameState;
  if (state.phase === "finished") throw new GameRuleError("GAME_FINISHED");

  if (state.phase === "playing") {
    if (settleExpiredClock(state, nowMs)) return state;
    if (["move", "augment_move", "augment_exchange", "resign"].includes(action.type)) {
      commitRunningClock(state, nowMs);
    }
  }

  if (
    action.type === "augment_select" ||
    action.type === "augment_refresh" ||
    action.type === "augment_lock"
  ) {
    if (state.phase !== "setup" && state.phase !== "augment_draft") {
      throw new GameRuleError("NO_ACTIVE_DRAFT");
    }
    const augment = requireAugmentState(state);
    try {
      if (action.type === "augment_select") {
        augment.draft = selectAugment(augment.draft, side, action.augmentId);
      } else if (action.type === "augment_refresh") {
        augment.draft = refreshAugmentOption(augment.draft, side, action.slot);
      } else {
        augment.draft = lockAugmentSelection(augment.draft, side);
        if (state.phase === "augment_draft") {
          finalizeSecondAugmentDraft(state, nowMs);
        }
      }
      return state;
    } catch (error) {
      if (error instanceof AugmentRuleError) throw new GameRuleError(error.code);
      throw error;
    }
  }

  if (action.type === "set_time_control") {
    if (side !== "black") throw new GameRuleError("HOST_ONLY_TIME_CONTROL");
    if (state.phase !== "setup") throw new GameRuleError("GAME_ALREADY_STARTED");
    if (state.ready.black || state.ready.white) throw new GameRuleError("TIME_CONTROL_LOCKED");
    if (state.clock?.incrementMs) throw new GameRuleError("RANKED_TIME_CONTROL_LOCKED");
    if (
      !Number.isInteger(action.minutes) ||
      action.minutes < MIN_TIME_CONTROL_MINUTES ||
      action.minutes > MAX_TIME_CONTROL_MINUTES
    ) {
      throw new GameRuleError("INVALID_TIME_CONTROL");
    }
    const initialMs = action.minutes * 60 * 1000;
    if (state.clock?.initialMs === initialMs) throw new GameRuleError("NO_STATE_CHANGE");
    state.clock = {
      initialMs,
      remainingMs: { black: initialMs, white: initialMs },
      turnStartedAt: null,
    };
    return state;
  }

  if (action.type === "randomize") {
    if (state.phase !== "setup") throw new GameRuleError("GAME_ALREADY_STARTED");
    if (state.ready[side]) throw new GameRuleError("LAYOUT_LOCKED");
    const draft = randomizeSetupDraft(state.pieces, side, selectedSetupAugments(state, side));
    for (const piece of state.pieces.filter((candidate) => candidate.alive && candidate.side === side)) {
      const position = draft[piece.id];
      if (!position) throw new GameRuleError("INVALID_LAYOUT");
      piece.row = position.row;
      piece.col = position.col;
    }
    return state;
  }

  if (action.type === "swap") {
    const violation = getSetupSwapViolation(state, side, action.from, action.to);
    if (violation) throw new GameRuleError(violation);
    const first = alivePieceAt(state, action.from);
    const second = alivePieceAt(state, action.to);
    if (!first || !second) throw new GameRuleError("INVALID_SWAP");
    [first.row, second.row] = [second.row, first.row];
    [first.col, second.col] = [second.col, first.col];
    if (!validateSideSetup(state.pieces, side, selectedSetupAugments(state, side))) {
      throw new GameRuleError("INVALID_LAYOUT");
    }
    return state;
  }

  if (action.type === "ready") {
    if (state.phase !== "setup") throw new GameRuleError("GAME_ALREADY_STARTED");
    if (state.ready[side] === action.value) throw new GameRuleError("NO_STATE_CHANGE");
    const setupAugments = selectedSetupAugments(state, side);
    if (action.value && state.augment) {
      const firstRound = state.augment.draft.rounds[0];
      if (!firstRound.players[side].locked) throw new GameRuleError("AUGMENT_SELECTION_REQUIRED");
    }
    if (action.value && action.layout) {
      const violation = getSubmittedSetupLayoutViolation(state.pieces, side, action.layout, setupAugments);
      if (violation) throw new GameRuleError(violation);
      const placements = new Map(action.layout.map((placement) => [placement.pieceId, placement]));
      for (const piece of state.pieces.filter((candidate) => candidate.alive && candidate.side === side)) {
        const placement = placements.get(piece.id)!;
        piece.row = placement.row;
        piece.col = placement.col;
      }
    }
    if (action.value && !validateSideSetup(state.pieces, side, setupAugments)) {
      throw new GameRuleError("INVALID_LAYOUT");
    }
    state.joined[side] = true;
    state.ready[side] = action.value;
    addEvent(state, { actor: side, result: action.value ? "ready" : "unready" });
    if (state.ready.black && state.ready.white) {
      state.firstTurn = randomIndex(2) === 0 ? "black" : "white";
      state.phase = "playing";
      state.turn = state.firstTurn;
      state.replay = createReplayArchive(state);
      if (state.clock) {
        state.clock.remainingMs = {
          black: state.clock.initialMs,
          white: state.clock.initialMs,
        };
        state.clock.turnStartedAt = nowMs;
      }
      if (state.augment) {
        try {
          state.augment.draft = revealCurrentAugmentRound(state.augment.draft);
        } catch (error) {
          if (error instanceof AugmentRuleError) throw new GameRuleError(error.code);
          throw error;
        }
        applyAugmentRevealTriggers(state, 1);
        maybeApplyLowTimeRescue(state, state.turn);
      }
      addEvent(state, { actor: state.firstTurn, result: "game_started" });
    }
    return state;
  }

  if (action.type === "augment_recon") {
    if (state.phase !== "playing") throw new GameRuleError("GAME_NOT_STARTED");
    const augment = requireAugmentState(state);
    const pending = augment.pendingRecon[side];
    if (!pending || pending.augmentId !== action.augmentId) {
      throw new GameRuleError("RECON_NOT_PENDING");
    }
    const target = alivePieceAt(state, action.target);
    if (!target || target.side === side) throw new GameRuleError("RECON_TARGET_INVALID");
    if (
      augment.permanentReveals[side].includes(target.id) ||
      augment.temporaryReveals[side].includes(target.id)
    ) {
      throw new GameRuleError("RECON_TARGET_ALREADY_KNOWN");
    }
    augment.permanentReveals[side].push(target.id);
    pending.remaining = Math.min(pending.remaining - 1, availableReconTargets(state, side).length);
    if (pending.remaining <= 0) {
      augment.pendingRecon[side] = null;
      markAugmentUse(state, side, action.augmentId);
      if (side === state.turn && !hasAnyLegalAction(state, side)) {
        state.phase = "finished";
        state.winner = otherSide(side);
        state.finishReason = "no_moves";
        stopClock(state);
      }
    }
    return state;
  }

  if (action.type === "augment_exchange") {
    const violation = getAugmentExchangeViolation(
      state,
      side,
      action.augmentId,
      action.from,
      action.to,
    );
    if (violation) throw new GameRuleError(violation);
    const replay = ensureReplayArchive(state);
    const first = alivePieceAt(state, action.from)!;
    const second = alivePieceAt(state, action.to)!;
    [first.row, second.row] = [second.row, first.row];
    [first.col, second.col] = [second.col, first.col];
    state.moveNumber += 1;
    replay.moves.push({
      moveNumber: state.moveNumber,
      actor: side,
      from: { ...action.from },
      to: { ...action.to },
      secondaryFrom: { ...action.to },
      secondaryTo: { ...action.from },
      result: "move",
      kind: "exchange",
      augmentId: action.augmentId,
    });
    markAugmentUse(state, side, action.augmentId, { from: action.from, to: action.to });
    if (state.augment) {
      for (const revealSide of ["black", "white"] as const) {
        state.augment.temporaryReveals[revealSide] = state.augment.temporaryReveals[revealSide]
          .filter((pieceId) => pieceId !== first.id && pieceId !== second.id);
      }
    }
    applyPostMoveClockBonuses(state, side);
    state.turn = otherSide(side);
    if (!beginSecondDraftIfDue(state, nowMs)) {
      maybeApplyLowTimeRescue(state, state.turn);
      if (!hasAnyLegalAction(state, state.turn)) {
        state.phase = "finished";
        state.winner = side;
        state.finishReason = "no_moves";
      }
    }
    if (state.phase === "playing" && state.clock) state.clock.turnStartedAt = nowMs;
    else stopClock(state);
    return state;
  }

  if (action.type === "augment_move") {
    applyMove(state, side, action.from, action.to, action.augmentId, nowMs);
    if (state.phase === "playing" && state.clock) state.clock.turnStartedAt = nowMs;
    else stopClock(state);
    return state;
  }

  if (action.type === "resign") {
    if (state.phase !== "playing" && state.phase !== "augment_draft") {
      throw new GameRuleError("GAME_NOT_STARTED");
    }
    ensureReplayArchive(state);
    state.phase = "finished";
    state.winner = otherSide(side);
    state.finishReason = "resign";
    if (state.augment) state.augment.draftDeadlineAt = null;
    stopClock(state);
    addEvent(state, { actor: side, result: "resigned" });
    return state;
  }

  applyMove(state, side, action.from, action.to, undefined, nowMs);
  if (state.phase === "playing") {
    if (state.clock) state.clock.turnStartedAt = nowMs;
  } else {
    stopClock(state);
  }
  return state;
}

export interface ProjectionOptions {
  spectatorPolicy?: "full" | "hidden";
  spectatorPerspective?: Side | null;
}

export function projectGame(
  state: GameState,
  viewer: Viewer,
  nowMs = Date.now(),
  options: ProjectionOptions = {},
): ProjectedGame {
  const fullSpectator = viewer === "spectator" && options.spectatorPolicy !== "hidden";
  const knowledgeSide = viewer === "spectator" ? options.spectatorPerspective ?? null : viewer;
  const canSeeReplay = state.phase === "finished" || fullSpectator;
  const availableReplay =
    state.phase === "setup" ? null : state.replay ?? createReplayArchive(state);
  const projectedDraft = state.augment
    ? projectAugmentDraft(state.augment.draft, knowledgeSide ?? "spectator")
    : null;
  return {
    rulesVersion: state.rulesVersion,
    phase: state.phase,
    joined: { ...state.joined },
    ready: { ...state.ready },
    turn: state.turn,
    winner: state.winner,
    finishReason: state.finishReason,
    revealedFlags: { ...state.revealedFlags },
    pieces: state.pieces
      .map((piece) => {
        const flagRevealed = piece.type === "flag" && state.revealedFlags[piece.side];
        const individuallyRevealed = Boolean(
          knowledgeSide &&
            (state.augment?.permanentReveals[knowledgeSide].includes(piece.id) ||
              state.augment?.temporaryReveals[knowledgeSide].includes(piece.id)),
        );
        const canSeeType =
          fullSpectator ||
          state.phase === "finished" ||
          knowledgeSide === piece.side ||
          flagRevealed ||
          individuallyRevealed;
        const hidesSetupIdentity =
          state.phase === "setup" && !fullSpectator && knowledgeSide !== piece.side;
        return {
          id: hidesSetupIdentity
            ? `${piece.side}-hidden-${piece.row}-${piece.col}`
            : piece.id,
          side: piece.side,
          row: piece.row,
          col: piece.col,
          alive: piece.alive,
          type: canSeeType ? piece.type : null,
          flagRevealed,
        };
      })
      .sort(
        (first, second) =>
          first.side.localeCompare(second.side) ||
          Number(second.alive) - Number(first.alive) ||
          first.row - second.row ||
          first.col - second.col ||
          first.id.localeCompare(second.id),
      ),
    events: state.events.map((event) => ({ ...event })),
    moveNumber: state.moveNumber,
    replay: canSeeReplay && availableReplay ? cloneReplayArchive(availableReplay) : null,
    clock: projectClock(state, nowMs),
    mode: gameModeForState(state),
    augment:
      state.augment && projectedDraft
        ? {
            draft: projectedDraft,
            usedBySide: {
              black: state.augment.usedBySide.black.filter((id) => projectedDraft.loadouts.black.includes(id)),
              white: state.augment.usedBySide.white.filter((id) => projectedDraft.loadouts.white.includes(id)),
            },
            triggerCounts: {
              black: Object.fromEntries(
                projectedDraft.loadouts.black.map((id) => [
                  id,
                  state.augment?.triggerCounts.black[id] ?? 0,
                ]),
              ),
              white: Object.fromEntries(
                projectedDraft.loadouts.white.map((id) => [
                  id,
                  state.augment?.triggerCounts.white[id] ?? 0,
                ]),
              ),
            },
            pendingRecon: knowledgeSide ? state.augment.pendingRecon[knowledgeSide] : null,
            extraMove: knowledgeSide ? state.augment.extraMove[knowledgeSide] : null,
            draftDeadlineAt: state.augment.draftDeadlineAt,
          }
        : null,
  };
}
