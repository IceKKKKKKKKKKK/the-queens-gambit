export const RULES_VERSION = "classic-duel-dark-v1";

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
  result: BattleResult | "ready" | "resigned" | "game_started";
}

export interface GameState {
  rulesVersion: typeof RULES_VERSION;
  phase: "setup" | "playing" | "finished";
  joined: Record<Side, boolean>;
  ready: Record<Side, boolean>;
  firstTurn: Side;
  turn: Side;
  winner: Side | null;
  finishReason: "flag" | "no_moves" | "resign" | "draw" | null;
  revealedFlags: Record<Side, boolean>;
  pieces: Piece[];
  events: PublicEvent[];
  moveNumber: number;
  noCombatPly: number;
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
}

export type PlayerAction =
  | { type: "join" }
  | { type: "randomize" }
  | { type: "swap"; from: Position; to: Position }
  | { type: "ready"; value: boolean }
  | { type: "move"; from: Position; to: Position }
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
  const firstTurn: Side = randomIndex(2) === 0 ? "black" : "white";
  return {
    rulesVersion: RULES_VERSION,
    phase: "setup",
    joined: { black: true, white: false },
    ready: { black: false, white: false },
    firstTurn,
    turn: firstTurn,
    winner: null,
    finishReason: null,
    revealedFlags: { black: false, white: false },
    pieces: [...makeSidePieces("black"), ...makeSidePieces("white")],
    events: [],
    moveNumber: 0,
    noCombatPly: 0,
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

function railNeighbors(position: Position) {
  return [
    { row: position.row - 1, col: position.col },
    { row: position.row + 1, col: position.col },
    { row: position.row, col: position.col - 1 },
    { row: position.row, col: position.col + 1 },
  ].filter((neighbor) => isInsideBoard(neighbor) && isRailEdge(position, neighbor));
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

function straightRailCanReach(state: GameState, from: Position, to: Position) {
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

export function isLegalMove(state: GameState, side: Side, from: Position, to: Position) {
  if (state.phase !== "playing" || state.turn !== side || !isInsideBoard(from) || !isInsideBoard(to)) {
    return false;
  }
  const piece = alivePieceAt(state, from);
  if (!piece || piece.side !== side || piece.type === "flag" || piece.type === "mine") return false;
  if (isHeadquarters(from)) return false;
  const target = alivePieceAt(state, to);
  if (target?.side === side) return false;
  if (target && isCamp(to)) return false;
  if (isRoadEdge(from, to)) return true;
  return piece.type === "engineer"
    ? engineerCanReach(state, from, to)
    : straightRailCanReach(state, from, to);
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

export function getProjectedLegalTargets(game: ProjectedGame, side: Side, from: Position) {
  const movementState: GameState = {
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
    noCombatPly: 0,
  };
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

function revealFlagWhenCommanderFalls(state: GameState, piece: Piece | undefined) {
  if (piece?.type === "commander" && !piece.alive) state.revealedFlags[piece.side] = true;
}

function applyMove(state: GameState, side: Side, from: Position, to: Position) {
  if (!isLegalMove(state, side, from, to)) throw new GameRuleError("ILLEGAL_MOVE");
  const attacker = alivePieceAt(state, from)!;
  const defender = alivePieceAt(state, to);
  const attackedHeadquarters = Boolean(defender && isHeadquarters(to));
  let result: BattleResult = "move";

  if (!defender) {
    attacker.row = to.row;
    attacker.col = to.col;
    state.noCombatPly += 1;
  } else {
    state.noCombatPly = 0;
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
  addEvent(state, { actor: side, from, to, result });
  if (state.phase === "finished") return;

  const nextSide = otherSide(side);
  state.turn = nextSide;
  if (!hasAnyLegalMove(state, nextSide)) {
    state.phase = "finished";
    state.winner = side;
    state.finishReason = "no_moves";
  } else if (state.noCombatPly >= 70) {
    state.phase = "finished";
    state.winner = null;
    state.finishReason = "draw";
  }
}

export function applyPlayerAction(current: GameState, side: Side, action: PlayerAction) {
  const state = JSON.parse(JSON.stringify(current)) as GameState;
  if (state.phase === "finished") throw new GameRuleError("GAME_FINISHED");

  if (action.type === "join") {
    if (state.phase !== "setup") throw new GameRuleError("GAME_ALREADY_STARTED");
    state.joined[side] = true;
    return state;
  }

  if (action.type === "randomize") {
    if (state.phase !== "setup" || state.ready[side]) throw new GameRuleError("LAYOUT_LOCKED");
    state.pieces = [...state.pieces.filter((piece) => piece.side !== side), ...makeSidePieces(side)];
    return state;
  }

  if (action.type === "swap") {
    if (state.phase !== "setup" || state.ready[side]) throw new GameRuleError("LAYOUT_LOCKED");
    const first = alivePieceAt(state, action.from);
    const second = alivePieceAt(state, action.to);
    if (!first || !second || first.side !== side || second.side !== side) {
      throw new GameRuleError("INVALID_SWAP");
    }
    [first.row, second.row] = [second.row, first.row];
    [first.col, second.col] = [second.col, first.col];
    if (!validateSideSetup(state.pieces, side)) throw new GameRuleError("INVALID_LAYOUT");
    return state;
  }

  if (action.type === "ready") {
    if (state.phase !== "setup") throw new GameRuleError("GAME_ALREADY_STARTED");
    if (action.value && !validateSideSetup(state.pieces, side)) throw new GameRuleError("INVALID_LAYOUT");
    state.joined[side] = true;
    state.ready[side] = action.value;
    if (action.value) addEvent(state, { actor: side, result: "ready" });
    if (state.ready.black && state.ready.white) {
      state.phase = "playing";
      state.turn = state.firstTurn;
      addEvent(state, { actor: state.firstTurn, result: "game_started" });
    }
    return state;
  }

  if (action.type === "resign") {
    if (state.phase !== "playing") throw new GameRuleError("GAME_NOT_STARTED");
    state.phase = "finished";
    state.winner = otherSide(side);
    state.finishReason = "resign";
    addEvent(state, { actor: side, result: "resigned" });
    return state;
  }

  applyMove(state, side, action.from, action.to);
  return state;
}

export function projectGame(state: GameState, viewer: Viewer): ProjectedGame {
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
        const canSeeType = state.phase === "finished" || viewer === piece.side || flagRevealed;
        return {
          id: piece.id,
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
  };
}
