export const RULES_VERSION = "classic-duel-dark-v2";
export const DEFAULT_TIME_CONTROL_MINUTES = 20;
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
  result: BattleResult | "ready" | "unready" | "resigned" | "game_started" | "timeout";
}

export interface GameClock {
  initialMs: number;
  remainingMs: Record<Side, number>;
  turnStartedAt: number | null;
}

export interface PublicClock {
  initialMs: number;
  remainingMs: Record<Side, number>;
  running: Side | null;
}

export interface ReplayMove {
  moveNumber: number;
  actor: Side;
  from: Position;
  to: Position;
  result: BattleResult;
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

export interface GameState {
  rulesVersion: typeof RULES_VERSION;
  phase: "setup" | "playing" | "finished";
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
}

export interface ProjectedGame {
  rulesVersion: typeof RULES_VERSION;
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
      if (
        attackerAfter.alive ||
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

export function isAllowedSetupPosition(type: PieceType, side: Side, position: Position) {
  if (!isInsideBoard(position) || !isSetupPosition(side, position) || isCamp(position)) {
    return false;
  }
  if (type === "flag") {
    return isHeadquarters(position) && (side === "black" ? position.row === 11 : position.row === 0);
  }
  if (type === "mine") {
    return side === "black" ? position.row >= 10 : position.row <= 1;
  }
  if (type === "bomb") {
    return side === "black" ? position.row !== 6 : position.row !== 5;
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

export function validateSideSetup(pieces: Piece[], side: Side) {
  const sidePieces = pieces.filter((piece) => piece.side === side && piece.alive);
  if (sidePieces.length !== 25) return false;
  const occupied = new Set(sidePieces.map(positionKey));
  if (occupied.size !== 25) return false;
  for (const type of PIECE_TYPES) {
    if (sidePieces.filter((piece) => piece.type === type).length !== PIECE_INFO[type].count) return false;
  }
  return sidePieces.every((piece) => isAllowedSetupPosition(piece.type, side, piece));
}

function alivePieceAt(state: GameState, position: Position) {
  return state.pieces.find((piece) => piece.alive && samePosition(piece, position));
}

function setupPositionViolation(type: PieceType, side: Side, position: Position) {
  if (!isInsideBoard(position) || !isSetupPosition(side, position) || isCamp(position)) {
    return "INVALID_LAYOUT";
  }
  if (type === "flag" && !isAllowedSetupPosition(type, side, position)) {
    return "FLAG_MUST_BE_HEADQUARTERS";
  }
  if (type === "mine" && !isAllowedSetupPosition(type, side, position)) {
    return "MINE_BACK_TWO_ROWS";
  }
  if (type === "bomb" && !isAllowedSetupPosition(type, side, position)) {
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
): SetupDraft {
  return Object.fromEntries(
    ownSetupPieces(pieces, side).map((piece) => [
      piece.id,
      useCurrentLayout && isAllowedSetupPosition(piece.type, side, piece)
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
    if (!position || setupPositionViolation(piece.type, side, position)) return false;
    const key = positionKey(position);
    if (occupied.has(key)) return false;
    occupied.add(key);
  }
  return true;
}

export function getSetupDraftPlacementViolation(
  pieces: readonly SetupPieceLike[],
  side: Side,
  draft: SetupDraft,
  pieceId: string,
  to: Position,
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
  const activeViolation = setupPositionViolation(piece.type, side, to);
  if (activeViolation) return activeViolation;
  if (from && target) {
    const displacedViolation = setupPositionViolation(target.type, side, from);
    if (displacedViolation) return displacedViolation;
  }
  return null;
}

export function applySetupDraftPlacement(
  pieces: readonly SetupPieceLike[],
  side: Side,
  draft: SetupDraft,
  pieceId: string,
  to: Position,
) {
  const violation = getSetupDraftPlacementViolation(pieces, side, draft, pieceId, to);
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

export function randomizeSetupDraft(pieces: readonly SetupPieceLike[], side: Side) {
  const ownPieces = ownSetupPieces(pieces, side);
  if (ownPieces.length !== 25) throw new GameRuleError("INVALID_LAYOUT");
  for (const type of PIECE_TYPES) {
    if (ownPieces.filter((piece) => piece.type === type).length !== PIECE_INFO[type].count) {
      throw new GameRuleError("INVALID_LAYOUT");
    }
  }

  const available = setupSlots(side);
  const draft = createSetupDraft(pieces, side);
  const placePiece = (piece: SetupPieceLike & { type: PieceType }) => {
    const choices = available.filter((position) => isAllowedSetupPosition(piece.type, side, position));
    if (!choices.length) throw new GameRuleError("INVALID_LAYOUT");
    const chosen = choices[randomIndex(choices.length)];
    available.splice(available.findIndex((position) => samePosition(position, chosen)), 1);
    draft[piece.id] = { ...chosen };
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
) {
  if (!isValidSetupDraft(pieces, side, draft, true)) {
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
    const violation = setupPositionViolation(piece.type, side, placement);
    if (violation) return violation;
    const key = positionKey(placement);
    if (occupied.has(key)) return "INVALID_LAYOUT";
    occupied.add(key);
  }
  if (byId.size !== ownPieces.length) return "PIECE_NOT_AVAILABLE";
  return null;
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
  return (
    setupPositionViolation(first.type, side, to) ??
    setupPositionViolation(second.type, side, from)
  );
}

export function getProjectedSetupSwapViolation(
  game: ProjectedGame,
  side: Side,
  from: Position,
  to: Position,
) {
  return getSetupSwapViolation(projectedMovementState(game), side, from, to);
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
  return getMoveViolation(projectedMovementState(game), side, from, to);
}

export function getProjectedLegalTargets(game: ProjectedGame, side: Side, from: Position) {
  const movementState = projectedMovementState(game);
  return getLegalTargets(movementState, side, from);
}

function hasAnyLegalMove(state: GameState, side: Side) {
  const stateForSide = { ...state, turn: side };
  return state.pieces.some(
    (piece) => piece.alive && piece.side === side && getLegalTargets(stateForSide, side, piece).length > 0,
  );
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
    };
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
      attacker.alive = false;
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

function applyMove(state: GameState, side: Side, from: Position, to: Position) {
  const violation = getMoveViolation(state, side, from, to);
  if (violation) throw new GameRuleError(violation);
  const replay = ensureReplayArchive(state);
  const attacker = alivePieceAt(state, from)!;
  const defender = alivePieceAt(state, to);
  const attackedHeadquarters = Boolean(defender && isHeadquarters(to));
  let result: BattleResult = "move";

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
  });
  addEvent(state, { actor: side, from, to, result });
  if (state.phase === "finished") return;

  const nextSide = otherSide(side);
  state.turn = nextSide;
  if (!hasAnyLegalMove(state, nextSide)) {
    state.phase = "finished";
    state.winner = side;
    state.finishReason = "no_moves";
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
    commitRunningClock(state, nowMs);
  }

  if (action.type === "set_time_control") {
    if (side !== "black") throw new GameRuleError("HOST_ONLY_TIME_CONTROL");
    if (state.phase !== "setup") throw new GameRuleError("GAME_ALREADY_STARTED");
    if (state.ready.black || state.ready.white) throw new GameRuleError("TIME_CONTROL_LOCKED");
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
    const draft = randomizeSetupDraft(state.pieces, side);
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
    if (!validateSideSetup(state.pieces, side)) throw new GameRuleError("INVALID_LAYOUT");
    return state;
  }

  if (action.type === "ready") {
    if (state.phase !== "setup") throw new GameRuleError("GAME_ALREADY_STARTED");
    if (state.ready[side] === action.value) throw new GameRuleError("NO_STATE_CHANGE");
    if (action.value && action.layout) {
      const violation = getSubmittedSetupLayoutViolation(state.pieces, side, action.layout);
      if (violation) throw new GameRuleError(violation);
      const placements = new Map(action.layout.map((placement) => [placement.pieceId, placement]));
      for (const piece of state.pieces.filter((candidate) => candidate.alive && candidate.side === side)) {
        const placement = placements.get(piece.id)!;
        piece.row = placement.row;
        piece.col = placement.col;
      }
    }
    if (action.value && !validateSideSetup(state.pieces, side)) throw new GameRuleError("INVALID_LAYOUT");
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
      addEvent(state, { actor: state.firstTurn, result: "game_started" });
    }
    return state;
  }

  if (action.type === "resign") {
    if (state.phase !== "playing") throw new GameRuleError("GAME_NOT_STARTED");
    ensureReplayArchive(state);
    state.phase = "finished";
    state.winner = otherSide(side);
    state.finishReason = "resign";
    stopClock(state);
    addEvent(state, { actor: side, result: "resigned" });
    return state;
  }

  applyMove(state, side, action.from, action.to);
  if (state.phase === "playing") {
    if (state.clock) state.clock.turnStartedAt = nowMs;
  } else {
    stopClock(state);
  }
  return state;
}

export function projectGame(state: GameState, viewer: Viewer, nowMs = Date.now()): ProjectedGame {
  const canSeeReplay = viewer === "spectator" || state.phase === "finished";
  const availableReplay =
    state.phase === "setup" ? null : state.replay ?? createReplayArchive(state);
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
        const canSeeType = viewer === "spectator" || state.phase === "finished" || viewer === piece.side || flagRevealed;
        const hidesSetupIdentity = state.phase === "setup" && viewer !== piece.side;
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
  };
}
