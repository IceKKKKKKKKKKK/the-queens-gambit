import { performance } from "node:perf_hooks";

import {
  AUGMENT_CATALOG,
  AUGMENT_IDS,
  getAugmentDefinition,
  type AugmentId,
  type AugmentSlot,
  type AugmentSuit,
} from "../lib/augments.ts";
import {
  PIECE_INFO,
  applyPlayerAction,
  createAugmentGame,
  getAugmentExchangeViolation,
  getAugmentMoveViolation,
  getLegalTargets,
  isCamp,
  isInsideBoard,
  otherSide,
  samePosition,
  type GameState,
  type Piece,
  type PlayerAction,
  type Position,
  type Side,
} from "../lib/game.ts";

interface SimulationOptions {
  seed: number;
  randomGames: number;
  maxTargetedAttempts: number;
  maxActions: number;
  shortCap: number;
  thinkTimeMs: number;
}

interface CardStats {
  selected: number;
  triggeredGames: number;
  triggers: number;
  wins: number;
  losses: number;
  draws: number;
  unfinished: number;
}

interface RunStats {
  games: number;
  finished: number;
  unfinished: number;
  actionCap: number;
  stuck: number;
  exceptions: number;
  blackFirst: number;
  whiteFirst: number;
  blackWins: number;
  whiteWins: number;
  firstPlayerWins: number;
  secondPlayerWins: number;
  draws: number;
  moves: number;
  finishReasons: Record<string, number>;
  cards: Record<AugmentId, CardStats>;
  errorSamples: string[];
}

interface GamePlan {
  seed: number;
  label: string;
  target: AugmentId | null;
  maxActions: number;
  refreshOpening: boolean;
}

interface GameResult {
  state: GameState;
  capped: boolean;
  stuck: boolean;
}

interface CandidateAction {
  action: PlayerAction;
  score: number;
}

class DeterministicRandom {
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
    if (!Number.isInteger(length) || length <= 0) throw new Error(`Invalid random length: ${length}`);
    return this.nextUint32() % length;
  }

  pick<T>(values: readonly T[]): T {
    if (!values.length) throw new Error("Cannot choose from an empty collection.");
    return values[this.int(values.length)];
  }
}

function hashSeed(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function withDeterministicEngineRandom<T>(seed: number, task: () => T): T {
  const engineRandom = new DeterministicRandom(seed);
  const originalMathRandom = Math.random;
  const originalGetRandomValues = globalThis.crypto.getRandomValues;
  Object.defineProperty(Math, "random", {
    configurable: true,
    value: () => engineRandom.next(),
  });
  Object.defineProperty(globalThis.crypto, "getRandomValues", {
    configurable: true,
    value: <TArray extends ArrayBufferView | null>(array: TArray): TArray => {
      if (array === null) throw new TypeError("Expected an ArrayBufferView.");
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = engineRandom.nextUint32() & 0xff;
      }
      return array;
    },
  });
  try {
    return task();
  } finally {
    Object.defineProperty(Math, "random", { configurable: true, value: originalMathRandom });
    Object.defineProperty(globalThis.crypto, "getRandomValues", {
      configurable: true,
      value: originalGetRandomValues,
    });
  }
}

function parseOptions(argv: readonly string[]): SimulationOptions {
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = argument.match(/^--([a-z-]+)=(\d+)$/);
    if (!match) {
      throw new Error(
        `Unknown argument ${argument}. Use --seed, --random-games, --targeted-attempts, --max-actions, --short-cap, or --think-ms.`,
      );
    }
    values.set(match[1], match[2]);
  }
  const positive = (key: string, fallback: number, allowZero = false) => {
    const parsed = Number(values.get(key) ?? fallback);
    if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
      throw new Error(`--${key} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
    }
    return parsed;
  };
  return {
    seed: positive("seed", 20260809, true),
    randomGames: positive("random-games", 80, true),
    maxTargetedAttempts: positive("targeted-attempts", 8),
    maxActions: positive("max-actions", 180),
    shortCap: positive("short-cap", 6),
    thinkTimeMs: positive("think-ms", 250),
  };
}

function emptyCardStats(): CardStats {
  return {
    selected: 0,
    triggeredGames: 0,
    triggers: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    unfinished: 0,
  };
}

function emptyRunStats(): RunStats {
  return {
    games: 0,
    finished: 0,
    unfinished: 0,
    actionCap: 0,
    stuck: 0,
    exceptions: 0,
    blackFirst: 0,
    whiteFirst: 0,
    blackWins: 0,
    whiteWins: 0,
    firstPlayerWins: 0,
    secondPlayerWins: 0,
    draws: 0,
    moves: 0,
    finishReasons: {},
    cards: Object.fromEntries(AUGMENT_IDS.map((id) => [id, emptyCardStats()])) as Record<
      AugmentId,
      CardStats
    >,
    errorSamples: [],
  };
}

function createGameForSeed(seed: number) {
  return withDeterministicEngineRandom(seed, () => createAugmentGame());
}

function targetIsOfferedToBoth(seed: number, target: AugmentId) {
  const state = createGameForSeed(seed);
  const round = state.augment?.draft.rounds[0];
  return Boolean(
    round?.players.black.options.includes(target) && round.players.white.options.includes(target),
  );
}

function findSymmetricTargetSeed(baseSeed: number, target: AugmentId, ordinal: number) {
  const start = hashSeed(`${baseSeed}:${target}:${ordinal}`);
  for (let offset = 0; offset < 20_000; offset += 1) {
    const seed = (start + Math.imul(offset, 2654435761)) >>> 0;
    if (targetIsOfferedToBoth(seed, target)) return seed;
  }
  throw new Error(`Could not find a symmetric opening offer for ${target}.`);
}

function chooseDrafts(
  state: GameState,
  target: AugmentId | null,
  random: DeterministicRandom,
  nowMs: number,
  allowRefresh: boolean,
) {
  const roundNumber = state.augment?.draft.activeRound;
  const round = state.augment?.draft.rounds.find((candidate) => candidate.number === roundNumber);
  if (!round) throw new Error(`Missing active draft round in phase ${state.phase}.`);

  for (const side of ["black", "white"] as const) {
    let activeRound = state.augment?.draft.rounds.find((candidate) => candidate.number === roundNumber);
    if (!activeRound) throw new Error("Active draft disappeared during selection.");
    const player = activeRound.players[side];
    if (player.locked) continue;
    const targetAvailable = target !== null && player.options.includes(target);
    if (allowRefresh && !targetAvailable && random.next() < 0.5) {
      const slot = random.int(3) as AugmentSlot;
      state = applyPlayerAction(state, side, { type: "augment_refresh", slot }, nowMs);
      activeRound = state.augment?.draft.rounds.find((candidate) => candidate.number === roundNumber);
      if (!activeRound) throw new Error("Active draft disappeared after refresh.");
    }
    const options = activeRound.players[side].options;
    const augmentId = target !== null && options.includes(target) ? target : random.pick(options);
    state = applyPlayerAction(state, side, { type: "augment_select", augmentId }, nowMs);
    state = applyPlayerAction(state, side, { type: "augment_lock" }, nowMs);
  }
  return state;
}

function targetedLayout(state: GameState, side: Side, target: AugmentId) {
  const ownPieces = state.pieces.filter((piece) => piece.alive && piece.side === side);
  const positions = new Map(
    ownPieces.map((piece) => [piece.id, { row: piece.row, col: piece.col }]),
  );
  const pieceAtPlacement = (position: Position) =>
    ownPieces.find((piece) => samePosition(positions.get(piece.id)!, position));
  const place = (type: Piece["type"], position: Position) => {
    const piece = ownPieces.find((candidate) => candidate.type === type);
    const occupant = pieceAtPlacement(position);
    if (!piece || !occupant) throw new Error(`Cannot place ${side} ${type} at ${position.row},${position.col}.`);
    const previous = positions.get(piece.id)!;
    positions.set(piece.id, { ...position });
    positions.set(occupant.id, { ...previous });
  };

  if (target === "diamond-forward-bomb") {
    place("bomb", { row: side === "black" ? 6 : 5, col: 0 });
  } else if (target === "diamond-deep-mine") {
    place("mine", { row: side === "black" ? 9 : 2, col: 0 });
  }
  return ownPieces.map((piece) => ({ pieceId: piece.id, ...positions.get(piece.id)! }));
}

function prepareGame(plan: GamePlan, random: DeterministicRandom) {
  const nowMs = 1_000_000;
  let state = createAugmentGame();
  state = applyPlayerAction(state, "black", { type: "set_time_control", minutes: 1 }, nowMs);
  state = chooseDrafts(state, plan.target, random, nowMs, plan.refreshOpening);
  const usesTargetLayout =
    plan.target === "diamond-forward-bomb" || plan.target === "diamond-deep-mine";
  if (!usesTargetLayout) {
    state = applyPlayerAction(state, "black", { type: "randomize" }, nowMs);
    state = applyPlayerAction(state, "white", { type: "randomize" }, nowMs);
  }
  const blackLayout = plan.target && usesTargetLayout ? targetedLayout(state, "black", plan.target) : undefined;
  const whiteLayout = plan.target && usesTargetLayout ? targetedLayout(state, "white", plan.target) : undefined;
  state = applyPlayerAction(
    state,
    "black",
    { type: "ready", value: true, ...(blackLayout ? { layout: blackLayout } : {}) },
    nowMs,
  );
  state = applyPlayerAction(
    state,
    "white",
    { type: "ready", value: true, ...(whiteLayout ? { layout: whiteLayout } : {}) },
    nowMs,
  );
  return { state, nowMs };
}

function unresolvedReconTarget(state: GameState, side: Side, random: DeterministicRandom) {
  const known = new Set([
    ...(state.augment?.permanentReveals[side] ?? []),
    ...(state.augment?.temporaryReveals[side] ?? []),
  ]);
  const targets = state.pieces.filter(
    (piece) => piece.alive && piece.side !== side && !known.has(piece.id),
  );
  return targets.length ? random.pick(targets) : null;
}

function pendingReconSide(state: GameState): Side | null {
  if (state.augment?.pendingRecon[state.turn]) return state.turn;
  const opponent = otherSide(state.turn);
  return state.augment?.pendingRecon[opponent] ? opponent : null;
}

function pieceAt(state: GameState, position: Position) {
  return state.pieces.find((piece) => piece.alive && samePosition(piece, position));
}

function strength(piece: Piece) {
  return PIECE_INFO[piece.type].strength ?? -1;
}

function distance(first: Position, second: Position) {
  return Math.abs(first.row - second.row) + Math.abs(first.col - second.col);
}

function nearestDistance(from: Position, pieces: readonly Piece[]) {
  return pieces.length ? Math.min(...pieces.map((piece) => distance(from, piece))) : 0;
}

function augmentUnused(state: GameState, side: Side, augmentId: AugmentId) {
  const uses = state.augment?.triggerCounts[side][augmentId] ?? 0;
  return state.augment?.draft.loadouts[side].includes(augmentId) &&
    uses < getAugmentDefinition(augmentId).charges;
}

function predictedLosingAttack(attacker: Piece, defender: Piece) {
  if (defender.type === "flag") return false;
  if (attacker.type === "bomb" || defender.type === "bomb") return false;
  if (defender.type === "mine") return attacker.type !== "engineer";
  return strength(attacker) < strength(defender);
}

function tacticalTargets(state: GameState, side: Side, piece: Piece, target: AugmentId | null) {
  const enemies = state.pieces.filter((candidate) => candidate.alive && candidate.side !== side);
  if (target === "heart-bomb-disposal" && piece.type === "engineer") {
    return enemies.filter((candidate) => candidate.type === "bomb");
  }
  if (target === "diamond-engineer-screen" && piece.type === "engineer") {
    return enemies.filter(
      (candidate) => candidate.type !== "mine" && candidate.type !== "bomb" && strength(candidate) > strength(piece),
    );
  }
  if (target === "spade-tactical-retreat") {
    return enemies.filter((candidate) => predictedLosingAttack(piece, candidate));
  }
  return [];
}

function scoreNormalMove(
  state: GameState,
  side: Side,
  from: Position,
  to: Position,
  target: AugmentId | null,
  random: DeterministicRandom,
) {
  const attacker = pieceAt(state, from)!;
  const defender = pieceAt(state, to);
  const enemyFlag = state.pieces.find(
    (piece) => piece.alive && piece.side !== side && piece.type === "flag",
  );
  let score = random.next() * 5;
  const forward = side === "black" ? from.row - to.row : to.row - from.row;
  score += forward * 1.5;
  if (enemyFlag) score += (distance(from, enemyFlag) - distance(to, enemyFlag)) * 7;

  const specialTargets = tacticalTargets(state, side, attacker, target);
  if (specialTargets.length) {
    score += (nearestDistance(from, specialTargets) - nearestDistance(to, specialTargets)) * 22;
  }

  if (!defender) {
    score += 4;
    if (target === "heart-initiative" && augmentUnused(state, side, target)) score += 800;
    if (target === "diamond-camp-transfer" && augmentUnused(state, side, target) && isCamp(to)) {
      score += 900;
    }
  } else {
    score += 50;
    if (defender.type === "flag") score += 10_000;
    else if (attacker.type === "bomb" || defender.type === "bomb") score += 12;
    else if (defender.type === "mine") score += attacker.type === "engineer" ? 80 : -18;
    else score += strength(attacker) >= strength(defender) ? 55 : -12;

    if (
      target === "spade-relentless-assault" &&
      augmentUnused(state, side, target) &&
      attacker.type !== "bomb" &&
      defender.type !== "bomb" &&
      (defender.type === "mine" ? attacker.type === "engineer" : strength(attacker) > strength(defender))
    ) {
      score += 1_500;
    }
    if (
      target === "spade-tactical-retreat" &&
      augmentUnused(state, side, target) &&
      predictedLosingAttack(attacker, defender)
    ) {
      score += 2_000;
    }
    if (
      target === "heart-bomb-disposal" &&
      augmentUnused(state, side, target) &&
      attacker.type === "engineer" &&
      defender.type === "bomb"
    ) {
      score += 3_000;
    }
    if (
      target === "diamond-engineer-screen" &&
      augmentUnused(state, side, target) &&
      attacker.type === "engineer" &&
      defender.type !== "mine" &&
      defender.type !== "bomb" &&
      strength(attacker) < strength(defender)
    ) {
      score += 3_000;
    }
  }

  const previous = [...state.events]
    .reverse()
    .find((event) => event.actor === side && event.from && event.to);
  if (previous?.from && previous.to && samePosition(previous.from, to) && samePosition(previous.to, from)) {
    score -= 35;
  }
  return score;
}

function enumerateNormalActions(
  state: GameState,
  side: Side,
  target: AugmentId | null,
  random: DeterministicRandom,
) {
  const candidates: CandidateAction[] = [];
  for (const piece of state.pieces) {
    if (!piece.alive || piece.side !== side) continue;
    const from = { row: piece.row, col: piece.col };
    for (const to of getLegalTargets(state, side, from)) {
      candidates.push({
        action: { type: "move", from, to },
        score: scoreNormalMove(state, side, from, to, target, random),
      });
    }
  }
  return candidates;
}

function enumerateAugmentMovementActions(
  state: GameState,
  side: Side,
  augmentId: AugmentId,
  priority: boolean,
  random: DeterministicRandom,
) {
  const candidates: CandidateAction[] = [];
  for (const piece of state.pieces) {
    if (!piece.alive || piece.side !== side) continue;
    const from = { row: piece.row, col: piece.col };
    for (let row = 0; row < 12; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        const to = { row, col };
        if (getAugmentMoveViolation(state, side, augmentId, from, to) !== null) continue;
        const enemyFlag = state.pieces.find(
          (candidate) => candidate.alive && candidate.side !== side && candidate.type === "flag",
        );
        const targetPiece = pieceAt(state, to);
        let score = (priority ? 1_500 : 180) + random.next() * 5;
        if (targetPiece && targetPiece.side !== side) {
          score += targetPiece.type === "flag" ? 10_000 : 80;
        }
        if (enemyFlag) score += (distance(from, enemyFlag) - distance(to, enemyFlag)) * 7;
        candidates.push({ action: { type: "augment_move", augmentId, from, to }, score });
      }
    }
  }
  return candidates;
}

function enumerateAugmentExchangeActions(
  state: GameState,
  side: Side,
  augmentId: AugmentId,
  priority: boolean,
  random: DeterministicRandom,
) {
  const pieces = state.pieces.filter((piece) => piece.alive && piece.side === side);
  const candidates: CandidateAction[] = [];
  for (let firstIndex = 0; firstIndex < pieces.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < pieces.length; secondIndex += 1) {
      const first = pieces[firstIndex];
      const second = pieces[secondIndex];
      const from = { row: first.row, col: first.col };
      const to = { row: second.row, col: second.col };
      if (getAugmentExchangeViolation(state, side, augmentId, from, to) !== null) continue;
      const forwardDelta = side === "black" ? second.row - first.row : first.row - second.row;
      candidates.push({
        action: { type: "augment_exchange", augmentId, from, to },
        score: (priority ? 1_500 : 180) + Math.abs(forwardDelta) * 2 + random.next() * 5,
      });
    }
  }
  return candidates;
}

function chooseAction(
  state: GameState,
  side: Side,
  target: AugmentId | null,
  random: DeterministicRandom,
) {
  const candidates = enumerateNormalActions(state, side, target, random);
  for (const augmentId of state.augment?.draft.loadouts[side] ?? []) {
    if (!augmentUnused(state, side, augmentId)) continue;
    const definition = getAugmentDefinition(augmentId);
    const priority = augmentId === target;
    if (definition.effect.kind === "movement") {
      candidates.push(
        ...enumerateAugmentMovementActions(state, side, augmentId, priority, random),
      );
    } else if (definition.effect.kind === "exchange") {
      candidates.push(
        ...enumerateAugmentExchangeActions(state, side, augmentId, priority, random),
      );
    }
  }
  if (!candidates.length) return null;
  candidates.sort((first, second) => second.score - first.score);
  const shortlist = candidates.slice(0, Math.min(4, candidates.length));
  return random.pick(shortlist).action;
}

function assertStateInvariants(state: GameState) {
  const occupied = new Set<string>();
  for (const piece of state.pieces) {
    if (!piece.alive) continue;
    if (!isInsideBoard(piece)) throw new Error(`Alive piece ${piece.id} left the board.`);
    const key = `${piece.row},${piece.col}`;
    if (occupied.has(key)) throw new Error(`Two alive pieces occupy ${key}.`);
    occupied.add(key);
  }
  if (state.moveNumber < 0 || !Number.isInteger(state.moveNumber)) {
    throw new Error(`Invalid move number ${state.moveNumber}.`);
  }
  if (state.phase === "finished" && state.finishReason !== "draw" && state.winner === null) {
    throw new Error("A decisive finished game has no winner.");
  }
  for (const side of ["black", "white"] as const) {
    const remaining = state.clock?.remainingMs[side];
    if (remaining !== undefined && (!Number.isFinite(remaining) || remaining < 0)) {
      throw new Error(`Invalid ${side} clock value ${remaining}.`);
    }
  }
}

function playGame(plan: GamePlan, options: SimulationOptions): GameResult {
  return withDeterministicEngineRandom(plan.seed, () => {
    const random = new DeterministicRandom(`${plan.seed}:bot`);
    let { state, nowMs } = prepareGame(plan, random);
    let stuck = false;
    assertStateInvariants(state);

    while (state.phase !== "finished" && state.moveNumber < plan.maxActions) {
      if (state.phase === "augment_draft") {
        state = chooseDrafts(state, null, random, nowMs, true);
        assertStateInvariants(state);
        continue;
      }

      const reconSide = pendingReconSide(state);
      if (reconSide) {
        const pending = state.augment?.pendingRecon[reconSide];
        const target = unresolvedReconTarget(state, reconSide, random);
        if (!pending || !target) throw new Error(`Recon for ${reconSide} has no legal target.`);
        state = applyPlayerAction(
          state,
          reconSide,
          {
            type: "augment_recon",
            augmentId: pending.augmentId,
            target: { row: target.row, col: target.col },
          },
          nowMs,
        );
        assertStateInvariants(state);
        continue;
      }

      const action = chooseAction(state, state.turn, plan.target, random);
      if (!action) {
        stuck = true;
        break;
      }
      nowMs += options.thinkTimeMs;
      state = applyPlayerAction(state, state.turn, action, nowMs);
      assertStateInvariants(state);
    }
    return {
      state,
      capped: state.phase !== "finished" && state.moveNumber >= plan.maxActions,
      stuck,
    };
  });
}

function recordGame(stats: RunStats, result: GameResult) {
  const state = result.state;
  stats.games += 1;
  stats.moves += state.moveNumber;
  if (state.firstTurn === "black") stats.blackFirst += 1;
  else stats.whiteFirst += 1;
  if (result.stuck) stats.stuck += 1;
  if (result.capped) stats.actionCap += 1;
  if (state.phase === "finished") {
    stats.finished += 1;
    const reason = state.finishReason ?? "unknown";
    stats.finishReasons[reason] = (stats.finishReasons[reason] ?? 0) + 1;
    if (state.winner === "black") stats.blackWins += 1;
    else if (state.winner === "white") stats.whiteWins += 1;
    else stats.draws += 1;
    if (state.winner !== null) {
      if (state.winner === state.firstTurn) stats.firstPlayerWins += 1;
      else stats.secondPlayerWins += 1;
    }
  } else {
    stats.unfinished += 1;
  }

  for (const side of ["black", "white"] as const) {
    for (const augmentId of state.augment?.draft.loadouts[side] ?? []) {
      const card = stats.cards[augmentId];
      const triggers = state.augment?.triggerCounts[side][augmentId] ?? 0;
      card.selected += 1;
      card.triggers += triggers;
      if (triggers > 0) card.triggeredGames += 1;
      if (state.phase !== "finished") card.unfinished += 1;
      else if (state.winner === null) card.draws += 1;
      else if (state.winner === side) card.wins += 1;
      else card.losses += 1;
    }
  }
}

function recordException(stats: RunStats, plan: GamePlan, error: unknown) {
  stats.games += 1;
  stats.exceptions += 1;
  if (stats.errorSamples.length < 8) {
    stats.errorSamples.push(
      `${plan.label} seed=${plan.seed}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function needsTargetedLongGame(stats: RunStats, target: AugmentId) {
  const card = stats.cards[target];
  return card.triggeredGames === 0 || card.wins === 0 || card.losses === 0;
}

function runPlan(stats: readonly RunStats[], plan: GamePlan, options: SimulationOptions) {
  try {
    const result = playGame(plan, options);
    for (const accumulator of stats) recordGame(accumulator, result);
  } catch (error) {
    for (const accumulator of stats) recordException(accumulator, plan, error);
  }
}

function rate(numerator: number, denominator: number) {
  return denominator ? `${((numerator / denominator) * 100).toFixed(1)}%` : "—";
}

function pad(value: string | number, width: number) {
  return String(value).padEnd(width, " ");
}

function suitSummary(stats: RunStats, suit: AugmentSuit) {
  const cards = AUGMENT_CATALOG.filter((card) => card.suit === suit).map((card) => stats.cards[card.id]);
  return cards.reduce(
    (total, card) => ({
      selected: total.selected + card.selected,
      triggeredGames: total.triggeredGames + card.triggeredGames,
      wins: total.wins + card.wins,
      losses: total.losses + card.losses,
      unfinished: total.unfinished + card.unfinished,
    }),
    { selected: 0, triggeredGames: 0, wins: 0, losses: 0, unfinished: 0 },
  );
}

function printCardTable(stats: RunStats) {
  console.log("花色 卡名       选择 触发局/次数 胜-负-和 未终局 胜率");
  for (const definition of AUGMENT_CATALOG) {
    const card = stats.cards[definition.id];
    console.log(
      `${definition.suitSymbol}   ${pad(definition.shortName, 10)} ${pad(card.selected, 4)} ` +
        `${pad(`${card.triggeredGames}/${card.triggers}`, 11)} ` +
        `${pad(`${card.wins}-${card.losses}-${card.draws}`, 8)} ${pad(card.unfinished, 6)} ` +
        `${rate(card.wins, card.wins + card.losses)}`,
    );
  }
}

function printReport(
  stats: RunStats,
  randomStats: RunStats,
  options: SimulationOptions,
  elapsedMs: number,
) {
  const decisive = stats.blackWins + stats.whiteWins;
  console.log("军令强化状态机模拟（固定种子随机机器人）");
  console.log(
    `seed=${options.seed} games=${stats.games} finished=${stats.finished} unfinished=${stats.unfinished} ` +
      `moves=${stats.moves} elapsed=${(elapsedMs / 1000).toFixed(2)}s`,
  );
  console.log(
      `blackFirst=${stats.blackFirst} whiteFirst=${stats.whiteFirst} ` +
      `blackWins=${stats.blackWins} whiteWins=${stats.whiteWins} ` +
      `blackWinRate=${rate(stats.blackWins, decisive)} ` +
      `firstPlayerWinRate=${rate(stats.firstPlayerWins, stats.firstPlayerWins + stats.secondPlayerWins)}`,
  );
  console.log(
    `actionCap=${stats.actionCap} stuck=${stats.stuck} exceptions=${stats.exceptions} ` +
      `finishReasons=${JSON.stringify(stats.finishReasons)}`,
  );

  console.log(
    `\n随机选择队列：games=${randomStats.games} finished=${randomStats.finished} ` +
      `unfinished=${randomStats.unfinished} blackWins=${randomStats.blackWins} ` +
      `whiteWins=${randomStats.whiteWins} blackFirst=${randomStats.blackFirst} ` +
      `whiteFirst=${randomStats.whiteFirst} ` +
      `firstPlayerWinRate=${rate(
        randomStats.firstPlayerWins,
        randomStats.firstPlayerWins + randomStats.secondPlayerWins,
      )}`,
  );
  console.log("花色汇总（仅随机选择队列；选择为一名玩家的一张卡；胜率仅以已分胜负选择为分母）");
  console.log("花色  选择  触发局  胜  负  未终局  胜率");
  for (const suit of ["spades", "hearts", "clubs", "diamonds"] as const) {
    const summary = suitSummary(randomStats, suit);
    const label = { spades: "黑桃", hearts: "红桃", clubs: "梅花", diamonds: "方块" }[suit];
    console.log(
      `${pad(label, 4)} ${pad(summary.selected, 5)} ${pad(summary.triggeredGames, 7)} ` +
        `${pad(summary.wins, 3)} ${pad(summary.losses, 3)} ${pad(summary.unfinished, 7)} ` +
        `${rate(summary.wins, summary.wins + summary.losses)}`,
    );
  }

  console.log("\n单卡粗略结果（仅随机选择队列）");
  printCardTable(randomStats);

  console.log("\n执行覆盖审计（随机队列 + 对称定向覆盖局；不可用于比较胜率）");
  printCardTable(stats);

  const coverageGaps = AUGMENT_CATALOG.flatMap((definition) => {
    const card = stats.cards[definition.id];
    const missing = [
      card.selected === 0 ? "未选择" : null,
      card.triggeredGames === 0 ? "未触发" : null,
      card.wins === 0 ? "无胜局" : null,
      card.losses === 0 ? "无负局" : null,
      card.unfinished === 0 ? "无未终局" : null,
    ].filter(Boolean);
    return missing.length ? [`${definition.id}: ${missing.join("、")}`] : [];
  });
  console.log(`\n20卡覆盖缺口: ${coverageGaps.length ? coverageGaps.join("; ") : "无"}`);
  if (stats.errorSamples.length) console.log(`异常样本: ${stats.errorSamples.join(" | ")}`);
  console.log(
    "\n局限：机器人读取完整棋子身份、按短视启发式走子，并刻意促发目标强化；" +
      "这些数据适合发现状态机卡死、不可执行卡和极端信号，不能证明真人环境的平衡性，也不是胜率预测。",
  );
}

function main() {
  const options = parseOptions(process.argv.slice(2));
  const stats = emptyRunStats();
  const coverageStats = emptyRunStats();
  const randomStats = emptyRunStats();
  const startedAt = performance.now();

  for (const target of AUGMENT_IDS) {
    const shortSeed = findSymmetricTargetSeed(options.seed, target, 0);
    runPlan(
      [stats, coverageStats],
      {
        seed: shortSeed,
        label: `coverage-short:${target}`,
        target,
        maxActions: options.shortCap,
        refreshOpening: false,
      },
      options,
    );
    for (let attempt = 1; attempt <= options.maxTargetedAttempts; attempt += 1) {
      if (!needsTargetedLongGame(coverageStats, target)) break;
      const seed = findSymmetricTargetSeed(options.seed, target, attempt);
      runPlan(
        [stats, coverageStats],
        {
          seed,
          label: `coverage-long:${target}:${attempt}`,
          target,
          maxActions: options.maxActions,
          refreshOpening: false,
        },
        options,
      );
    }
  }

  for (let index = 0; index < options.randomGames; index += 1) {
    const seed = hashSeed(`${options.seed}:random:${index}`);
    runPlan(
      [stats, randomStats],
      {
        seed,
        label: `random:${index}`,
        target: null,
        maxActions: options.maxActions,
        refreshOpening: true,
      },
      options,
    );
  }

  printReport(stats, randomStats, options, performance.now() - startedAt);
  if (stats.exceptions > 0 || stats.stuck > 0) process.exitCode = 1;
}

main();
