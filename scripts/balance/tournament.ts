import {
  AUGMENT_CATALOG,
  AUGMENT_IDS,
  AUGMENT_SUITS,
  getAugmentDefinition,
  type AugmentId,
  type AugmentSlot,
  type AugmentSuit,
} from "../../lib/augments.ts";
import {
  applyPlayerAction,
  createAugmentGame,
  isInsideBoard,
  projectGame,
  THREEFOLD_REPETITION_RULES_FINGERPRINT,
  validateSideSetup,
  type GameState,
  type Piece,
  type PlayerAction,
  type Position,
  type SetupPlacement,
  type Side,
} from "../../lib/game.ts";
import {
  SeededRandom,
  catalogFingerprint,
  cardsBySuit,
  chooseDraftCard,
  chooseVisibleAction,
  hashSeed,
  policyDecisionSeed,
  stableStringify,
  type DraftStrengthModel,
  type SearchOptions,
} from "./visible-policy.ts";

const SIDES = ["black", "white"] as const;
const SCHEMA_VERSION = 4 as const;
export const BALANCE_ENGINE_RULES_FINGERPRINT =
  THREEFOLD_REPETITION_RULES_FINGERPRINT;
export const BALANCE_ALGORITHM_VERSION =
  "hidden-info-balance-v11-threefold-public-occurrence" as const;

export interface TournamentOptions {
  seed: number;
  maxActions: number;
  thinkTimeMinMs: number;
  thinkTimeMaxMs: number;
  search: SearchOptions;
  refreshMargin: number;
}

export interface MirrorLeg {
  index: 0 | 1 | 2 | 3;
  blackCard: AugmentId;
  whiteCard: AugmentId;
  firstTurn: Side;
}

export interface Pairing {
  suit: AugmentSuit;
  cardA: AugmentId;
  cardB: AugmentId;
  pairKey: string;
}

export interface ScheduledGroup extends Pairing {
  cycle: number;
  replicate: number;
  groupKey: string;
}

export interface DraftChoiceRecord {
  side: Side;
  round: number;
  offered: AugmentId[];
  refreshed: boolean;
  picked: AugmentId;
}

export interface LegResult {
  groupKey: string;
  leg: MirrorLeg;
  seed: number;
  pairedSeed: number;
  winner: Side | null;
  winningCard: AugmentId | null;
  finishReason: GameState["finishReason"];
  drawReason: NonNullable<GameState["drawReason"]> | null;
  finished: boolean;
  capped: boolean;
  stuck: boolean;
  exception: string | null;
  moves: number;
  searchNodes: number;
  passExtraMoveCounts: Record<Side, Partial<Record<AugmentId, number>>>;
  triggerCounts: Record<Side, Partial<Record<AugmentId, number>>>;
  loadouts: Record<Side, AugmentId[]>;
  opportunityAugments: Record<Side, AugmentId[]>;
  firstTriggerMoves: Record<Side, Partial<Record<AugmentId, number>>>;
  draftChoices: DraftChoiceRecord[];
}

export interface CardAggregate {
  games: number;
  wins: number;
  losses: number;
  draws: number;
  threefoldDraws: number;
  unfinished: number;
  triggerGames: number;
  triggers: number;
  opportunityGames: number;
  firstTriggerMoves: number[];
  offered: number;
  picked: number;
  mirrorScores: number[];
  passExtraMoves: number;
}

export interface PairAggregate {
  suit: AugmentSuit;
  cardA: AugmentId;
  cardB: AugmentId;
  groups: number;
  games: number;
  cardAWins: number;
  cardBWins: number;
  draws: number;
  threefoldDraws: number;
  unfinished: number;
  cardAMirrorScores: number[];
  passExtraMoves: number;
}

export interface GlobalAggregate {
  groups: number;
  games: number;
  finished: number;
  unfinished: number;
  exceptions: number;
  stuck: number;
  capped: number;
  moves: number;
  searchNodes: number;
  passExtraMoves: number;
  blackWins: number;
  whiteWins: number;
  firstPlayerWins: number;
  secondPlayerWins: number;
  draws: number;
  threefoldDraws: number;
  finishReasons: Record<string, number>;
  pairedSeeds: Record<string, number>;
}

export interface TournamentAggregate {
  global: GlobalAggregate;
  cards: Record<AugmentId, CardAggregate>;
  pairs: Record<string, PairAggregate>;
  errorSamples: string[];
}

export interface BalanceCheckpoint {
  schemaVersion: typeof SCHEMA_VERSION;
  algorithmVersion: typeof BALANCE_ALGORITHM_VERSION;
  engineRulesFingerprint: typeof BALANCE_ENGINE_RULES_FINGERPRINT;
  catalogFingerprint: string;
  configFingerprint: string;
  scheduleFingerprint: string;
  runId: string;
  seed: number;
  startedAt: string;
  updatedAt: string;
  elapsedActiveMs: number;
  cursor: { cycle: number; pairIndex: number; replicate: number };
  completedGroupKeys: string[];
  aggregate: TournamentAggregate;
}

export interface ConfidenceInterval {
  estimate: number;
  low: number;
  high: number;
  n: number;
}

export interface CardReport extends CardAggregate {
  id: AugmentId;
  name: string;
  suit: AugmentSuit;
  winRate: ConfidenceInterval | null;
  mirrorScore: ConfidenceInterval | null;
  pickRate: number | null;
  triggerRate: number | null;
  heldWithoutOpportunityRate: number | null;
  firstTriggerMoveDistribution: {
    count: number;
    mean: number | null;
    median: number | null;
    p25: number | null;
    p75: number | null;
    histogram: Record<string, number>;
  };
}

export interface PairReport extends PairAggregate {
  cardAName: string;
  cardBName: string;
  cardAScore: ConfidenceInterval | null;
}

export interface TuningSuggestion {
  augmentId: AugmentId;
  suit: AugmentSuit;
  direction: "buff" | "nerf";
  field: string;
  currentValue: number;
  suggestedValue: number;
  confidence: "review" | "strong";
  evidence: string;
}

export interface BalanceReport {
  schemaVersion: typeof SCHEMA_VERSION;
  algorithmVersion: typeof BALANCE_ALGORITHM_VERSION;
  engineRulesFingerprint: typeof BALANCE_ENGINE_RULES_FINGERPRINT;
  generatedAt: string;
  runId: string;
  catalogFingerprint: string;
  catalogSize: number;
  configFingerprint: string;
  scheduleFingerprint: string;
  seed: number;
  elapsedActiveMs: number;
  cursor: BalanceCheckpoint["cursor"];
  global: GlobalAggregate & {
    firstPlayerWinRate: ConfidenceInterval | null;
    blackWinRate: ConfidenceInterval | null;
  };
  cards: CardReport[];
  pairs: PairReport[];
  bestResponses: Array<{
    card: AugmentId;
    bestTarget: AugmentId | null;
    bestTargetScore: number | null;
    hardestCounter: AugmentId | null;
    hardestCounterScore: number | null;
  }>;
  tuningSuggestions: TuningSuggestion[];
  unsupportedActiveEffects: Array<{ id: AugmentId; effectKind: string }>;
  limitations: string[];
  errorSamples: string[];
}

function blankCard(): CardAggregate {
  return {
    games: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    threefoldDraws: 0,
    unfinished: 0,
    triggerGames: 0,
    triggers: 0,
    opportunityGames: 0,
    firstTriggerMoves: [],
    offered: 0,
    picked: 0,
    mirrorScores: [],
    passExtraMoves: 0,
  };
}

export function createEmptyAggregate(): TournamentAggregate {
  return {
    global: {
      groups: 0,
      games: 0,
      finished: 0,
      unfinished: 0,
      exceptions: 0,
      stuck: 0,
      capped: 0,
      moves: 0,
      searchNodes: 0,
      passExtraMoves: 0,
      blackWins: 0,
      whiteWins: 0,
      firstPlayerWins: 0,
      secondPlayerWins: 0,
      draws: 0,
      threefoldDraws: 0,
      finishReasons: {},
      pairedSeeds: {},
    },
    cards: Object.fromEntries(AUGMENT_IDS.map((id) => [id, blankCard()])) as Record<
      AugmentId,
      CardAggregate
    >,
    pairs: {},
    errorSamples: [],
  };
}

export function mirrorLegs(cardA: AugmentId, cardB: AugmentId): MirrorLeg[] {
  return [
    { index: 0, blackCard: cardA, whiteCard: cardB, firstTurn: "black" },
    { index: 1, blackCard: cardB, whiteCard: cardA, firstTurn: "black" },
    { index: 2, blackCard: cardA, whiteCard: cardB, firstTurn: "white" },
    { index: 3, blackCard: cardB, whiteCard: cardA, firstTurn: "white" },
  ];
}

export function buildRoundRobinPairings(): Pairing[] {
  const grouped = cardsBySuit();
  const result: Pairing[] = [];
  for (const suit of AUGMENT_SUITS) {
    const cards = [...grouped[suit]].sort();
    for (let first = 0; first < cards.length; first += 1) {
      for (let second = first + 1; second < cards.length; second += 1) {
        result.push({
          suit,
          cardA: cards[first],
          cardB: cards[second],
          pairKey: `${suit}:${cards[first]}::${cards[second]}`,
        });
      }
    }
  }
  return result;
}

export function stratifiedPairSample(
  pairings: readonly Pairing[],
  pairsPerSuit: number,
) {
  if (!Number.isSafeInteger(pairsPerSuit) || pairsPerSuit < 1) {
    throw new Error("pairsPerSuit must be a positive integer.");
  }
  const sampled: Pairing[] = [];
  for (const suit of AUGMENT_SUITS) {
    const tierPairs = pairings.filter((pairing) => pairing.suit === suit);
    if (!tierPairs.length) continue;
    if (pairsPerSuit >= tierPairs.length) {
      sampled.push(...tierPairs);
      continue;
    }
    const indices = new Set<number>();
    if (pairsPerSuit === 1) {
      indices.add(Math.floor((tierPairs.length - 1) / 2));
    } else {
      for (let index = 0; index < pairsPerSuit; index += 1) {
        indices.add(Math.round((index * (tierPairs.length - 1)) / (pairsPerSuit - 1)));
      }
    }
    sampled.push(...[...indices].sort((left, right) => left - right).map((index) => tierPairs[index]));
  }
  return sampled;
}

export function scheduleGroup(pairing: Pairing, cycle: number, replicate: number): ScheduledGroup {
  return {
    ...pairing,
    cycle,
    replicate,
    groupKey: `${cycle}:${replicate}:${pairing.pairKey}`,
  };
}

export function remainingGroups<T extends { groupKey: string }>(
  schedule: readonly T[],
  completedGroupKeys: readonly string[],
) {
  const completed = new Set(completedGroupKeys);
  return schedule.filter((group) => !completed.has(group.groupKey));
}

export function wilsonInterval(successes: number, trials: number, z = 1.959963984540054) {
  if (!(trials > 0) || successes < 0 || successes > trials) return null;
  const probability = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const center = (probability + z2 / (2 * trials)) / denominator;
  const margin =
    (z / denominator) *
    Math.sqrt((probability * (1 - probability)) / trials + z2 / (4 * trials * trials));
  return {
    estimate: probability,
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
    n: trials,
  } satisfies ConfidenceInterval;
}

export function meanConfidenceInterval(values: readonly number[], z = 1.959963984540054) {
  if (!values.length) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length === 1) {
    return { estimate: mean, low: 0, high: 1, n: 1 } satisfies ConfidenceInterval;
  }
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const margin = z * Math.sqrt(variance / values.length);
  return {
    estimate: mean,
    low: Math.max(0, mean - margin),
    high: Math.min(1, mean + margin),
    n: values.length,
  } satisfies ConfidenceInterval;
}

export function tournamentConfigFingerprint(
  options: TournamentOptions,
  algorithmVersion: string = BALANCE_ALGORITHM_VERSION,
  engineRulesFingerprint: string = BALANCE_ENGINE_RULES_FINGERPRINT,
) {
  return String(
    hashSeed(stableStringify({ algorithmVersion, engineRulesFingerprint, options })),
  );
}

function pairingFingerprint(pairings: readonly Pairing[]) {
  return String(hashSeed(stableStringify(pairings)));
}

export function createCheckpoint(
  options: TournamentOptions,
  now = new Date(),
  pairings: readonly Pairing[] = buildRoundRobinPairings(),
): BalanceCheckpoint {
  return {
    schemaVersion: SCHEMA_VERSION,
    algorithmVersion: BALANCE_ALGORITHM_VERSION,
    engineRulesFingerprint: BALANCE_ENGINE_RULES_FINGERPRINT,
    catalogFingerprint: catalogFingerprint(),
    configFingerprint: tournamentConfigFingerprint(options),
    scheduleFingerprint: pairingFingerprint(pairings),
    runId: `balance-${options.seed}-${now.toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`,
    seed: options.seed,
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    elapsedActiveMs: 0,
    cursor: { cycle: 0, pairIndex: 0, replicate: 0 },
    completedGroupKeys: [],
    aggregate: createEmptyAggregate(),
  };
}

export function validateCheckpoint(
  checkpoint: BalanceCheckpoint,
  options: TournamentOptions,
  pairings: readonly Pairing[] = buildRoundRobinPairings(),
) {
  if (checkpoint.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Checkpoint schema ${checkpoint.schemaVersion} is not supported.`);
  }
  if (checkpoint.algorithmVersion !== BALANCE_ALGORITHM_VERSION) {
    throw new Error(
      `Checkpoint balance algorithm ${String(checkpoint.algorithmVersion)} is not supported.`,
    );
  }
  if (checkpoint.engineRulesFingerprint !== BALANCE_ENGINE_RULES_FINGERPRINT) {
    throw new Error("Checkpoint engine rules fingerprint is not supported.");
  }
  if (checkpoint.catalogFingerprint !== catalogFingerprint()) {
    throw new Error("Checkpoint catalog differs from the current augment catalog.");
  }
  if (checkpoint.configFingerprint !== tournamentConfigFingerprint(options)) {
    throw new Error("Checkpoint options differ from the requested tournament options.");
  }
  if (checkpoint.scheduleFingerprint !== pairingFingerprint(pairings)) {
    throw new Error("Checkpoint pairing schedule differs from the requested schedule.");
  }
  if (new Set(checkpoint.completedGroupKeys).size !== checkpoint.completedGroupKeys.length) {
    throw new Error("Checkpoint contains duplicate completed group keys.");
  }
  for (const id of AUGMENT_IDS) {
    if (!checkpoint.aggregate.cards[id]) throw new Error(`Checkpoint is missing card ${id}.`);
    if (
      !Number.isSafeInteger(checkpoint.aggregate.cards[id].passExtraMoves) ||
      checkpoint.aggregate.cards[id].passExtraMoves < 0
    ) {
      throw new Error(`Checkpoint is missing pass-extra-move metrics for card ${id}.`);
    }
    if (
      !Number.isSafeInteger(checkpoint.aggregate.cards[id].threefoldDraws) ||
      checkpoint.aggregate.cards[id].threefoldDraws < 0 ||
      checkpoint.aggregate.cards[id].threefoldDraws > checkpoint.aggregate.cards[id].draws
    ) {
      throw new Error(`Checkpoint is missing threefold-draw metrics for card ${id}.`);
    }
  }
  if (
    !Number.isSafeInteger(checkpoint.aggregate.global.passExtraMoves) ||
    checkpoint.aggregate.global.passExtraMoves < 0
  ) {
    throw new Error("Checkpoint is missing the global pass-extra-move metric.");
  }
  if (
    !Number.isSafeInteger(checkpoint.aggregate.global.threefoldDraws) ||
    checkpoint.aggregate.global.threefoldDraws < 0 ||
    checkpoint.aggregate.global.threefoldDraws > checkpoint.aggregate.global.draws
  ) {
    throw new Error("Checkpoint is missing the global threefold-draw metric.");
  }
  for (const pair of Object.values(checkpoint.aggregate.pairs)) {
    if (!Number.isSafeInteger(pair.passExtraMoves) || pair.passExtraMoves < 0) {
      throw new Error("Checkpoint is missing pair pass-extra-move metrics.");
    }
    if (
      !Number.isSafeInteger(pair.threefoldDraws) ||
      pair.threefoldDraws < 0 ||
      pair.threefoldDraws > pair.draws
    ) {
      throw new Error("Checkpoint is missing pair threefold-draw metrics.");
    }
  }
  return checkpoint;
}

export function withDeterministicEngineRandom<T>(seed: number | string, task: () => T): T {
  const random = new SeededRandom(seed);
  const originalMathRandom = Math.random;
  const originalGetRandomValues = globalThis.crypto.getRandomValues;
  Object.defineProperty(Math, "random", { configurable: true, value: () => random.next() });
  Object.defineProperty(globalThis.crypto, "getRandomValues", {
    configurable: true,
    value: <TArray extends ArrayBufferView | null>(array: TArray): TArray => {
      if (array === null) throw new TypeError("Expected an ArrayBufferView.");
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = random.nextUint32() & 0xff;
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

function optionsForForcedPick(suit: AugmentSuit, pick: AugmentId) {
  const candidates = AUGMENT_CATALOG.filter((card) => card.suit === suit)
    .map((card) => card.id)
    .filter((id) => id !== pick)
    .sort();
  if (candidates.length < 2) throw new Error(`${suit} needs at least three cards for a legal offer.`);
  return [pick, candidates[0], candidates[1]] as [AugmentId, AugmentId, AugmentId];
}

function forceOpeningOffers(state: GameState, blackCard: AugmentId, whiteCard: AugmentId) {
  if (!state.augment) throw new Error("Controlled game has no augment runtime.");
  const blackDefinition = getAugmentDefinition(blackCard);
  const whiteDefinition = getAugmentDefinition(whiteCard);
  if (blackDefinition.suit !== whiteDefinition.suit) {
    throw new Error("A controlled pair must belong to one suit/tier.");
  }
  const round = state.augment.draft.rounds[0];
  round.suit = blackDefinition.suit;
  round.players.black = {
    options: optionsForForcedPick(round.suit, blackCard),
    selectedId: null,
    locked: false,
    refreshedSlot: null,
  };
  round.players.white = {
    options: optionsForForcedPick(round.suit, whiteCard),
    selectedId: null,
    locked: false,
    refreshedSlot: null,
  };
  state.augment.draft.seenBySide = {
    black: [...round.players.black.options],
    white: [...round.players.white.options],
  };
  return state;
}

function swapPositions(first: Piece, second: Piece) {
  [first.row, second.row] = [second.row, first.row];
  [first.col, second.col] = [second.col, first.col];
}

function setupBenefitLayout(state: GameState, side: Side) {
  const own = state.pieces.filter((piece) => piece.alive && piece.side === side);
  const cards = state.augment?.draft.loadouts[side] ?? [];
  for (const id of cards) {
    const effect = getAugmentDefinition(id).effect;
    if (effect.kind !== "setup") continue;
    if (effect.mode === "forward_bomb") {
      const row = side === "black" ? 6 : 5;
      while (own.filter((piece) => piece.type === "bomb" && piece.row === row).length < effect.allowance) {
        const bomb = own.find((piece) => piece.type === "bomb" && piece.row !== row);
        const occupant = own.find(
          (piece) => piece.row === row && piece.type !== "bomb" && piece.type !== "mine" && piece.type !== "flag",
        );
        if (bomb && occupant) swapPositions(bomb, occupant);
        else break;
      }
    } else if (effect.mode === "deep_mine") {
      const row = side === "black" ? 9 : 2;
      while (own.filter((piece) => piece.type === "mine" && piece.row === row).length < effect.allowance) {
        const mine = own.find((piece) => piece.type === "mine" && piece.row !== row);
        const occupant = own.find(
          (piece) => piece.row === row && piece.type !== "mine" && piece.type !== "flag",
        );
        if (mine && occupant) swapPositions(mine, occupant);
        else break;
      }
    }
  }
  if (!validateSideSetup(state.pieces, side, cards)) {
    throw new Error(`The setup-benefit layout for ${side} is invalid.`);
  }
  return own.map((piece) => ({ pieceId: piece.id, row: piece.row, col: piece.col }));
}

export function createControlledPairGame(
  blackCard: AugmentId,
  whiteCard: AugmentId,
  firstTurn: Side,
  seed: number | string,
  nowMs = 1_000_000,
) {
  return withDeterministicEngineRandom(seed, () => {
    let state = createAugmentGame({
      ranked: true,
      repetitionSalt: `balance:${String(seed)}:authoritative`,
    });
    state = forceOpeningOffers(state, blackCard, whiteCard);
    state = applyPlayerAction(state, "black", { type: "augment_select", augmentId: blackCard }, nowMs);
    state = applyPlayerAction(state, "black", { type: "augment_lock" }, nowMs);
    state = applyPlayerAction(state, "white", { type: "augment_select", augmentId: whiteCard }, nowMs);
    state = applyPlayerAction(state, "white", { type: "augment_lock" }, nowMs);
    state = applyPlayerAction(state, "black", { type: "randomize" }, nowMs);
    state = applyPlayerAction(state, "white", { type: "randomize" }, nowMs);
    const blackLayout = setupBenefitLayout(state, "black");
    const whiteLayout = setupBenefitLayout(state, "white");
    state = applyPlayerAction(
      state,
      "black",
      { type: "ready", value: true, layout: blackLayout },
      nowMs,
    );
    state = applyPlayerAction(
      state,
      "white",
      { type: "ready", value: true, layout: whiteLayout },
      nowMs,
    );
    // Readiness uses a fair random coin in production. A mirror leg explicitly
    // controls that coin so every card/color assignment is tested with both openers.
    state.firstTurn = firstTurn;
    state.turn = firstTurn;
    if (state.clock) state.clock.turnStartedAt = nowMs;
    const startEvent = [...state.events].reverse().find((event) => event.result === "game_started");
    if (startEvent) startEvent.actor = firstTurn;
    return state;
  });
}

function modelCardScore(
  id: AugmentId,
  opponentCards: readonly AugmentId[],
  model: DraftStrengthModel,
) {
  return chooseDraftCard([id], opponentCards, model).score;
}

function completeActiveDraft(
  initial: GameState,
  model: DraftStrengthModel,
  refreshMargin: number,
  nowMs: number,
) {
  let state = initial;
  const records: DraftChoiceRecord[] = [];
  const activeRound = state.augment?.draft.activeRound;
  if (!activeRound) throw new Error("No active draft to complete.");
  for (const side of SIDES) {
    let view = projectGame(state, side, nowMs);
    let round = view.augment?.draft.rounds.find((candidate) => candidate.number === activeRound);
    let options = round?.players[side].options;
    if (!round || !options) throw new Error(`${side} cannot see its own active offer.`);
    const offered = [...options];
    let refreshed = false;
    const opponentCards = view.augment?.draft.loadouts[side === "black" ? "white" : "black"] ?? [];
    if (!round.players[side].refreshed && view.augment?.draft.seenIds) {
      const scored = options.map((id, slot) => ({
        id,
        slot: slot as AugmentSlot,
        score: modelCardScore(id, opponentCards, model),
      }));
      scored.sort((first, second) => first.score - second.score || first.id.localeCompare(second.id));
      const unseen = AUGMENT_CATALOG.filter(
        (card) =>
          card.suit === round!.suit &&
          !view.augment!.draft.seenIds!.includes(card.id) &&
          !view.augment!.draft.loadouts[side].includes(card.id),
      );
      const expected = unseen.length
        ? unseen.reduce((sum, card) => sum + modelCardScore(card.id, opponentCards, model), 0) /
          unseen.length
        : -Infinity;
      if (expected > scored[0].score + refreshMargin) {
        state = applyPlayerAction(
          state,
          side,
          { type: "augment_refresh", slot: scored[0].slot },
          nowMs,
        );
        refreshed = true;
        view = projectGame(state, side, nowMs);
        round = view.augment?.draft.rounds.find((candidate) => candidate.number === activeRound);
        options = round?.players[side].options;
        if (!options) throw new Error(`${side} lost its offer after refresh.`);
        offered.push(...options.filter((id) => !offered.includes(id)));
      }
    }
    const picked = chooseDraftCard(options, opponentCards, model).id;
    state = applyPlayerAction(state, side, { type: "augment_select", augmentId: picked }, nowMs);
    state = applyPlayerAction(state, side, { type: "augment_lock" }, nowMs);
    records.push({ side, round: activeRound, offered, refreshed, picked });
  }
  return { state, records };
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
  if (!Number.isSafeInteger(state.moveNumber) || state.moveNumber < 0) {
    throw new Error(`Invalid move number ${state.moveNumber}.`);
  }
  if (state.phase === "finished" && state.finishReason !== "draw" && state.winner === null) {
    throw new Error("Decisive finished game has no winner.");
  }
  if (
    state.phase === "finished" &&
    state.finishReason === "draw" &&
    (state.winner !== null || state.drawReason !== "threefold_repetition")
  ) {
    throw new Error("Finished draw is missing its threefold repetition reason.");
  }
  if (state.finishReason !== "draw" && state.drawReason !== null) {
    throw new Error("Non-draw state retained a draw reason.");
  }
  for (const side of SIDES) {
    const remaining = state.clock?.remainingMs[side];
    if (remaining !== undefined && (!Number.isFinite(remaining) || remaining < 0)) {
      throw new Error(`Invalid ${side} clock ${remaining}.`);
    }
  }
}

export function playLeg(
  group: ScheduledGroup,
  leg: MirrorLeg,
  options: TournamentOptions,
  model: DraftStrengthModel = {},
): LegResult {
  const pairedSeed = groupSeed(options, group);
  const gameSeed = pairedSeed;
  try {
    return withDeterministicEngineRandom(gameSeed, () => {
      let nowMs = 1_000_000;
      let state = createControlledPairGame(
        leg.blackCard,
        leg.whiteCard,
        leg.firstTurn,
        `${gameSeed}:setup`,
        nowMs,
      );
      const random = new SeededRandom(`${gameSeed}:clock`);
      const draftChoices: DraftChoiceRecord[] = [];
      const opportunitySets: Record<Side, Set<AugmentId>> = {
        black: new Set<AugmentId>(),
        white: new Set<AugmentId>(),
      };
      const firstTriggerMoves: Record<Side, Partial<Record<AugmentId, number>>> = {
        black: {},
        white: {},
      };
      const passExtraMoveCounts: Record<Side, Partial<Record<AugmentId, number>>> = {
        black: {},
        white: {},
      };
      let searchNodes = 0;
      let decisionOrdinal = 0;
      let stuck = false;
      const captureTriggerChanges = (
        previous: Record<Side, Partial<Record<AugmentId, number>>> | null,
        next: GameState,
      ) => {
        for (const triggerSide of SIDES) {
          for (const augmentId of next.augment?.draft.loadouts[triggerSide] ?? []) {
            const before = previous?.[triggerSide][augmentId] ?? 0;
            const after = next.augment?.triggerCounts[triggerSide][augmentId] ?? 0;
            if (after > before) {
              opportunitySets[triggerSide].add(augmentId);
              firstTriggerMoves[triggerSide][augmentId] ??= next.moveNumber;
            }
          }
        }
      };
      for (const setupSide of SIDES) {
        for (const augmentId of state.augment?.draft.loadouts[setupSide] ?? []) {
          if (getAugmentDefinition(augmentId).activation === "setup") {
            opportunitySets[setupSide].add(augmentId);
          }
        }
      }
      captureTriggerChanges(null, state);
      assertStateInvariants(state);
      while (state.phase !== "finished" && state.moveNumber < options.maxActions) {
        if (state.phase === "augment_draft") {
          const beforeTriggers = structuredClone(
            state.augment?.triggerCounts ?? { black: {}, white: {} },
          );
          const completed = completeActiveDraft(state, model, options.refreshMargin, nowMs);
          state = completed.state;
          draftChoices.push(...completed.records);
          captureTriggerChanges(beforeTriggers, state);
          assertStateInvariants(state);
          continue;
        }
        if (state.phase !== "playing") {
          stuck = true;
          break;
        }
        const side = state.turn;
        const searchSeed = policyDecisionSeed(gameSeed, decisionOrdinal);
        decisionOrdinal += 1;
        const decision = chooseVisibleAction(
          state,
          side,
          searchSeed,
          options.search,
          nowMs,
        );
        searchNodes += decision.nodesEvaluated;
        for (const augmentId of decision.opportunityAugmentIds) {
          opportunitySets[side].add(augmentId);
        }
        if (!decision.action) {
          stuck = true;
          break;
        }
        const spread = options.thinkTimeMaxMs - options.thinkTimeMinMs + 1;
        nowMs += options.thinkTimeMinMs + (spread > 1 ? random.int(spread) : 0);
        const beforeTriggers = structuredClone(
          state.augment?.triggerCounts ?? { black: {}, white: {} },
        );
        if (decision.action.type === "pass_extra_move") {
          const augmentId = state.augment?.extraMove[side]?.augmentId;
          if (!augmentId) throw new Error(`${side} passed an extra move without a granting augment.`);
          passExtraMoveCounts[side][augmentId] =
            (passExtraMoveCounts[side][augmentId] ?? 0) + 1;
        }
        state = applyPlayerAction(state, side, decision.action, nowMs);
        captureTriggerChanges(beforeTriggers, state);
        assertStateInvariants(state);
      }
      const winningCard =
        state.winner === "black"
          ? leg.blackCard
          : state.winner === "white"
            ? leg.whiteCard
            : null;
      return {
        groupKey: group.groupKey,
        leg,
        seed: gameSeed,
        pairedSeed,
        winner: state.winner,
        winningCard,
        finishReason: state.finishReason,
        drawReason: state.drawReason ?? null,
        finished: state.phase === "finished",
        capped: state.phase !== "finished" && state.moveNumber >= options.maxActions,
        stuck,
        exception: null,
        moves: state.moveNumber,
        searchNodes,
        passExtraMoveCounts,
        triggerCounts: structuredClone(state.augment?.triggerCounts ?? { black: {}, white: {} }),
        loadouts: structuredClone(state.augment?.draft.loadouts ?? { black: [], white: [] }),
        opportunityAugments: {
          black: [...opportunitySets.black].sort(),
          white: [...opportunitySets.white].sort(),
        },
        firstTriggerMoves,
        draftChoices,
      };
    });
  } catch (error) {
    return {
      groupKey: group.groupKey,
      leg,
      seed: gameSeed,
      pairedSeed,
      winner: null,
      winningCard: null,
      finishReason: null,
      drawReason: null,
      finished: false,
      capped: false,
      stuck: false,
      exception: error instanceof Error ? error.message : String(error),
      moves: 0,
      searchNodes: 0,
      passExtraMoveCounts: { black: {}, white: {} },
      triggerCounts: { black: {}, white: {} },
      loadouts: { black: [leg.blackCard], white: [leg.whiteCard] },
      opportunityAugments: { black: [], white: [] },
      firstTriggerMoves: { black: {}, white: {} },
      draftChoices: [],
    };
  }
}

export function playMirrorGroup(
  group: ScheduledGroup,
  options: TournamentOptions,
  model: DraftStrengthModel = {},
) {
  return mirrorLegs(group.cardA, group.cardB).map((leg) => playLeg(group, leg, options, model));
}

function pairAggregate(aggregate: TournamentAggregate, group: ScheduledGroup) {
  return (aggregate.pairs[group.pairKey] ??= {
    suit: group.suit,
    cardA: group.cardA,
    cardB: group.cardB,
    groups: 0,
    games: 0,
    cardAWins: 0,
    cardBWins: 0,
    draws: 0,
    threefoldDraws: 0,
    unfinished: 0,
    cardAMirrorScores: [],
    passExtraMoves: 0,
  });
}

function recordCardSelection(card: CardAggregate, outcome: "win" | "loss" | "draw" | "unfinished", triggers: number) {
  card.games += 1;
  card.triggers += triggers;
  if (triggers > 0) card.triggerGames += 1;
  if (outcome === "win") card.wins += 1;
  else if (outcome === "loss") card.losses += 1;
  else if (outcome === "draw") card.draws += 1;
  else card.unfinished += 1;
}

export function recordMirrorGroup(
  aggregate: TournamentAggregate,
  group: ScheduledGroup,
  results: readonly LegResult[],
) {
  if (results.length !== 4) throw new Error("A mirror group must contain exactly four legs.");
  if (results.some((result, index) => result.leg.index !== index || result.groupKey !== group.groupKey)) {
    throw new Error("Mirror group legs are incomplete or out of order.");
  }
  const pairedSeeds = new Set(results.map((result) => result.pairedSeed));
  if (pairedSeeds.size !== 1) throw new Error("Mirror group legs do not share one paired seed.");
  const pairedSeed = results[0].pairedSeed;
  const previousPairedSeed = aggregate.global.pairedSeeds[group.groupKey];
  if (previousPairedSeed !== undefined && previousPairedSeed !== pairedSeed) {
    throw new Error("A completed mirror group changed its paired seed.");
  }
  aggregate.global.pairedSeeds[group.groupKey] = pairedSeed;
  aggregate.global.groups += 1;
  const pair = pairAggregate(aggregate, group);
  pair.groups += 1;
  let cardAPoints = 0;
  let scoredGames = 0;
  for (const result of results) {
    const stopped = Number(result.capped) + Number(result.stuck) + Number(result.exception !== null);
    if (result.finished && (result.finishReason === null || stopped !== 0)) {
      throw new Error("A finished tournament leg cannot also be capped, stuck, or exceptional.");
    }
    if (
      result.finished &&
      result.finishReason === "draw" &&
      (result.winner !== null || result.winningCard !== null ||
        result.drawReason !== "threefold_repetition")
    ) {
      throw new Error("A finished tournament draw has inconsistent threefold metadata.");
    }
    if (result.finishReason !== "draw" && result.drawReason !== null) {
      throw new Error("A non-draw tournament leg retained a draw reason.");
    }
    if (
      result.finished &&
      result.finishReason !== "draw" &&
      (result.winner === null || result.winningCard === null)
    ) {
      throw new Error("A decisive tournament leg is missing its winner metadata.");
    }
    if (
      !result.finished &&
      (result.finishReason !== null ||
        result.drawReason !== null ||
        result.winner !== null ||
        result.winningCard !== null ||
        stopped !== 1)
    ) {
      throw new Error("An unfinished tournament leg must have exactly one stop status.");
    }
    aggregate.global.games += 1;
    aggregate.global.moves += result.moves;
    aggregate.global.searchNodes += result.searchNodes;
    const resultPassExtraMoves = SIDES.reduce(
      (total, side) =>
        total + Object.values(result.passExtraMoveCounts[side]).reduce((sum, count) => sum + (count ?? 0), 0),
      0,
    );
    aggregate.global.passExtraMoves += resultPassExtraMoves;
    pair.passExtraMoves += resultPassExtraMoves;
    pair.games += 1;
    if (result.exception) {
      aggregate.global.exceptions += 1;
      aggregate.global.unfinished += 1;
      pair.unfinished += 1;
      if (aggregate.errorSamples.length < 20) {
        aggregate.errorSamples.push(`${group.groupKey}/leg-${result.leg.index}: ${result.exception}`);
      }
    } else if (!result.finished) {
      aggregate.global.unfinished += 1;
      pair.unfinished += 1;
      if (result.capped) aggregate.global.capped += 1;
      if (result.stuck) aggregate.global.stuck += 1;
    } else {
      aggregate.global.finished += 1;
      const reason = result.finishReason ?? "unknown";
      aggregate.global.finishReasons[reason] = (aggregate.global.finishReasons[reason] ?? 0) + 1;
      if (result.winner === null) {
        aggregate.global.draws += 1;
        pair.draws += 1;
        if (result.drawReason === "threefold_repetition") {
          aggregate.global.threefoldDraws += 1;
          pair.threefoldDraws += 1;
        }
        cardAPoints += 0.5;
      } else {
        if (result.winner === "black") aggregate.global.blackWins += 1;
        else aggregate.global.whiteWins += 1;
        if (result.winner === result.leg.firstTurn) aggregate.global.firstPlayerWins += 1;
        else aggregate.global.secondPlayerWins += 1;
        if (result.winningCard === group.cardA) {
          pair.cardAWins += 1;
          cardAPoints += 1;
        } else {
          pair.cardBWins += 1;
        }
      }
      scoredGames += 1;
    }

    for (const side of SIDES) {
      const focal = side === "black" ? result.leg.blackCard : result.leg.whiteCard;
      const outcome =
        !result.finished || result.exception
          ? "unfinished"
          : result.winner === null
            ? "draw"
            : result.winner === side
              ? "win"
              : "loss";
      const loadout = new Set(result.loadouts[side]);
      loadout.add(focal);
      for (const augmentId of loadout) {
        const card = aggregate.cards[augmentId];
        recordCardSelection(
          card,
          outcome,
          result.triggerCounts[side][augmentId] ?? 0,
        );
        if (outcome === "draw" && result.drawReason === "threefold_repetition") {
          card.threefoldDraws += 1;
        }
        card.passExtraMoves += result.passExtraMoveCounts[side][augmentId] ?? 0;
        if (result.opportunityAugments[side].includes(augmentId)) card.opportunityGames += 1;
        const firstTriggerMove = result.firstTriggerMoves[side][augmentId];
        if (firstTriggerMove !== undefined) card.firstTriggerMoves.push(firstTriggerMove);
      }
    }
    for (const choice of result.draftChoices) {
      for (const offered of choice.offered) aggregate.cards[offered].offered += 1;
      aggregate.cards[choice.picked].picked += 1;
    }
  }
  // A strength sample exists only when the complete four-leg mirror closes;
  // partial groups remain visible in raw outcomes but cannot bias paired score.
  if (scoredGames === 4) {
    const score = cardAPoints / scoredGames;
    pair.cardAMirrorScores.push(score);
    aggregate.cards[group.cardA].mirrorScores.push(score);
    aggregate.cards[group.cardB].mirrorScores.push(1 - score);
  }
}

export function strengthModelFromAggregate(aggregate: TournamentAggregate): DraftStrengthModel {
  const ratings: Partial<Record<AugmentId, number>> = {};
  const counters: Partial<Record<AugmentId, Partial<Record<AugmentId, number>>>> = {};
  for (const id of AUGMENT_IDS) {
    const interval = meanConfidenceInterval(aggregate.cards[id].mirrorScores);
    if (interval) ratings[id] = (interval.estimate - 0.5) * 80;
  }
  for (const pair of Object.values(aggregate.pairs)) {
    const interval = meanConfidenceInterval(pair.cardAMirrorScores);
    if (!interval) continue;
    (counters[pair.cardA] ??= {})[pair.cardB] = (interval.estimate - 0.5) * 60;
    (counters[pair.cardB] ??= {})[pair.cardA] = (0.5 - interval.estimate) * 60;
  }
  return { ratings, counters };
}

function bestResponseRows(aggregate: TournamentAggregate) {
  return AUGMENT_IDS.map((card) => {
    const matchups = Object.values(aggregate.pairs)
      .filter((pair) => pair.cardA === card || pair.cardB === card)
      .map((pair) => {
        const interval = meanConfidenceInterval(pair.cardAMirrorScores);
        if (!interval) return null;
        return pair.cardA === card
          ? { opponent: pair.cardB, score: interval.estimate }
          : { opponent: pair.cardA, score: 1 - interval.estimate };
      })
      .filter((value): value is { opponent: AugmentId; score: number } => value !== null)
      .sort((first, second) => first.score - second.score || first.opponent.localeCompare(second.opponent));
    return {
      card,
      bestTarget: matchups.at(-1)?.opponent ?? null,
      bestTargetScore: matchups.at(-1)?.score ?? null,
      hardestCounter: matchups[0]?.opponent ?? null,
      hardestCounterScore: matchups[0]?.score ?? null,
    };
  });
}

function percentile(sorted: readonly number[], fraction: number) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function firstTriggerMoveDistribution(values: readonly number[]) {
  const sorted = [...values].sort((first, second) => first - second);
  const histogram: Record<string, number> = {
    "setup/reveal": 0,
    "1-9": 0,
    "10-29": 0,
    "30-59": 0,
    "60-119": 0,
    "120+": 0,
  };
  for (const value of sorted) {
    const bucket =
      value <= 0
        ? "setup/reveal"
        : value <= 9
          ? "1-9"
          : value <= 29
            ? "10-29"
            : value <= 59
              ? "30-59"
              : value <= 119
                ? "60-119"
                : "120+";
    histogram[bucket] += 1;
  }
  return {
    count: sorted.length,
    mean: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null,
    median: percentile(sorted, 0.5),
    p25: percentile(sorted, 0.25),
    p75: percentile(sorted, 0.75),
    histogram,
  };
}

function numericEffectCandidates(id: AugmentId) {
  const definition = getAugmentDefinition(id);
  const effect = definition.effect as unknown as Record<string, unknown>;
  const preferred = [
    "bonusMs",
    "count",
    "maxExtraMoves",
    "maxTriggers",
    "rowsFromFront",
    "maxTurns",
    "exactEdges",
    "allowance",
  ];
  return preferred
    .filter((field) => typeof effect[field] === "number")
    .map((field) => ({ field: `effect.${field}`, value: effect[field] as number }));
}

function adjustedNumericValue(value: number, direction: "buff" | "nerf") {
  if (value >= 10_000) {
    const step = Math.max(5_000, Math.round(value * 0.1 / 5_000) * 5_000);
    return Math.max(0, value + (direction === "buff" ? step : -step));
  }
  const step = Math.max(1, Math.round(value * 0.1));
  return Math.max(0, value + (direction === "buff" ? step : -step));
}

export function suggestTuning(aggregate: TournamentAggregate): TuningSuggestion[] {
  const suggestions: TuningSuggestion[] = [];
  for (const suit of AUGMENT_SUITS) {
    const reports = AUGMENT_CATALOG.filter((card) => card.suit === suit)
      .map((card) => ({ card, interval: meanConfidenceInterval(aggregate.cards[card.id].mirrorScores) }))
      .filter(
        (entry): entry is { card: (typeof AUGMENT_CATALOG)[number]; interval: ConfidenceInterval } =>
          Boolean(entry.interval && entry.interval.n >= 8),
      );
    if (reports.length < 3) continue;
    const tierMean = reports.reduce((sum, report) => sum + report.interval.estimate, 0) / reports.length;
    for (const { card, interval } of reports) {
      const delta = interval.estimate - tierMean;
      if (Math.abs(delta) < 0.06) continue;
      const direction = delta > 0 ? "nerf" : "buff";
      const strong =
        direction === "nerf" ? interval.low > tierMean + 0.02 : interval.high < tierMean - 0.02;
      const numeric = numericEffectCandidates(card.id)[0];
      if (card.charges > 1 || (!numeric && direction === "buff")) {
        const current = card.charges;
        const suggested = Math.max(1, current + (direction === "buff" ? 1 : -1));
        if (suggested === current) continue;
        suggestions.push({
          augmentId: card.id,
          suit,
          direction,
          field: "charges",
          currentValue: current,
          suggestedValue: suggested,
          confidence: strong ? "strong" : "review",
          evidence: `mirror score ${(interval.estimate * 100).toFixed(1)}% (95% CI ${(interval.low * 100).toFixed(1)}–${(interval.high * 100).toFixed(1)}%, n=${interval.n}) versus ${suit} mean ${(tierMean * 100).toFixed(1)}%`,
        });
      } else if (numeric) {
        suggestions.push({
          augmentId: card.id,
          suit,
          direction,
          field: numeric.field,
          currentValue: numeric.value,
          suggestedValue: adjustedNumericValue(numeric.value, direction),
          confidence: strong ? "strong" : "review",
          evidence: `mirror score ${(interval.estimate * 100).toFixed(1)}% (95% CI ${(interval.low * 100).toFixed(1)}–${(interval.high * 100).toFixed(1)}%, n=${interval.n}) versus ${suit} mean ${(tierMean * 100).toFixed(1)}%`,
        });
      }
    }
  }
  return suggestions;
}

export function buildBalanceReport(
  checkpoint: BalanceCheckpoint,
  unsupportedActiveEffects: BalanceReport["unsupportedActiveEffects"] = [],
): BalanceReport {
  const aggregate = checkpoint.aggregate;
  const decisive = aggregate.global.blackWins + aggregate.global.whiteWins;
  const firstDecisive = aggregate.global.firstPlayerWins + aggregate.global.secondPlayerWins;
  const cards = AUGMENT_CATALOG.map((definition) => {
    const stats = aggregate.cards[definition.id];
    const decided = stats.wins + stats.losses;
    return {
      id: definition.id,
      name: definition.name,
      suit: definition.suit,
      ...stats,
      winRate: wilsonInterval(stats.wins, decided),
      mirrorScore: meanConfidenceInterval(stats.mirrorScores),
      pickRate: stats.offered ? stats.picked / stats.offered : null,
      triggerRate: stats.games ? stats.triggerGames / stats.games : null,
      heldWithoutOpportunityRate: stats.games
        ? (stats.games - stats.opportunityGames) / stats.games
        : null,
      firstTriggerMoveDistribution: firstTriggerMoveDistribution(stats.firstTriggerMoves),
    } satisfies CardReport;
  });
  const pairs = Object.values(aggregate.pairs)
    .map((pair) => ({
      ...pair,
      cardAName: getAugmentDefinition(pair.cardA).name,
      cardBName: getAugmentDefinition(pair.cardB).name,
      cardAScore: meanConfidenceInterval(pair.cardAMirrorScores),
    }))
    .sort((first, second) => `${first.suit}:${first.cardA}:${first.cardB}`.localeCompare(`${second.suit}:${second.cardA}:${second.cardB}`));
  return {
    schemaVersion: SCHEMA_VERSION,
    algorithmVersion: BALANCE_ALGORITHM_VERSION,
    engineRulesFingerprint: BALANCE_ENGINE_RULES_FINGERPRINT,
    generatedAt: new Date().toISOString(),
    runId: checkpoint.runId,
    catalogFingerprint: checkpoint.catalogFingerprint,
    catalogSize: AUGMENT_CATALOG.length,
    configFingerprint: checkpoint.configFingerprint,
    scheduleFingerprint: checkpoint.scheduleFingerprint,
    seed: checkpoint.seed,
    elapsedActiveMs: checkpoint.elapsedActiveMs,
    cursor: checkpoint.cursor,
    global: {
      ...aggregate.global,
      firstPlayerWinRate: wilsonInterval(aggregate.global.firstPlayerWins, firstDecisive),
      blackWinRate: wilsonInterval(aggregate.global.blackWins, decisive),
    },
    cards,
    pairs,
    bestResponses: bestResponseRows(aggregate),
    tuningSuggestions: suggestTuning(aggregate),
    unsupportedActiveEffects,
    limitations: [
      "The policy searches sampled hidden-information worlds and never reads a hidden opposing piece type, but its belief model is an approximation of human inference.",
      "Mirror groups control card color and first move; games within a group are correlated, so mirror-group confidence intervals are preferred over raw per-game intervals.",
      "Finite-depth rollout and empirical best-response selection do not prove a globally optimal strategy or equilibrium.",
      "Only the v2 product engine's adjudicated threefold repetition is scored as a finished 0.5 draw; action-limit exits remain unfinished capped evidence.",
      "Automated win rates are balance signals, not a substitute for blind human playtests and telemetry.",
    ],
    errorSamples: [...aggregate.errorSamples],
  };
}

export function summarizeReport(report: BalanceReport) {
  const format = (value: number | null) => (value === null ? "—" : `${(value * 100).toFixed(1)}%`);
  const first = report.global.firstPlayerWinRate;
  const black = report.global.blackWinRate;
  const lines = [
    `catalog=${report.catalogSize} games=${report.global.games} groups=${report.global.groups} finished=${report.global.finished} unfinished=${report.global.unfinished}`,
    `moves=${report.global.moves} searchNodes=${report.global.searchNodes} passExtraMoves=${report.global.passExtraMoves} exceptions=${report.global.exceptions} stuck=${report.global.stuck} capped=${report.global.capped} threefoldDraws=${report.global.threefoldDraws}`,
    `first-player=${format(first?.estimate ?? null)} [${format(first?.low ?? null)}, ${format(first?.high ?? null)}] black=${format(black?.estimate ?? null)}`,
    "suit card games mirror-score[95% CI] pick-rate trigger-rate no-opportunity",
  ];
  for (const card of report.cards) {
    lines.push(
      `${card.suit.padEnd(8)} ${card.name.padEnd(8)} ${String(card.games).padEnd(5)} ` +
        `${format(card.mirrorScore?.estimate ?? null)}[${format(card.mirrorScore?.low ?? null)},${format(card.mirrorScore?.high ?? null)}] ` +
        `${format(card.pickRate)} ${format(card.triggerRate)} ${format(card.heldWithoutOpportunityRate)}`,
    );
  }
  lines.push(`reviewable tuning suggestions=${report.tuningSuggestions.length}`);
  return lines.join("\n");
}

export function assertCatalogReadyForTournament() {
  const ids = new Set(AUGMENT_CATALOG.map((card) => card.id));
  if (ids.size !== AUGMENT_CATALOG.length || ids.size !== AUGMENT_IDS.length) {
    throw new Error("Augment catalog IDs are duplicated or inconsistent.");
  }
  for (const suit of AUGMENT_SUITS) {
    if (AUGMENT_CATALOG.filter((card) => card.suit === suit).length < 3) {
      throw new Error(`${suit} must contain at least three cards.`);
    }
  }
}

export function groupSeed(options: TournamentOptions, group: ScheduledGroup) {
  return hashSeed(`${options.seed}:${group.groupKey}`);
}

export function positionKey(position: Position) {
  return `${position.row},${position.col}`;
}

export function placementsAreUnique(placements: readonly SetupPlacement[]) {
  return new Set(placements.map(positionKey)).size === placements.length;
}

export function actionIsCoordinateOnly(action: PlayerAction) {
  return stableStringify(action).includes('"type"');
}
