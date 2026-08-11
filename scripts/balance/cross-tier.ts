import {
  AUGMENT_SUITS,
  getAugmentDefinition,
  type AugmentId,
  type AugmentSuit,
} from "../../lib/augments.ts";
import {
  applyPlayerAction,
  projectGame,
  type GameState,
  type Side,
} from "../../lib/game.ts";
import {
  BALANCE_ALGORITHM_VERSION,
  BALANCE_ENGINE_RULES_FINGERPRINT,
  constrainActiveDraftToSimulationPool,
  createControlledPairGame,
  normalizeTournamentOptions,
  pendingPassAugmentId,
  withDeterministicEngineRandom,
  type ConfidenceInterval,
  type TournamentOptions,
} from "./tournament.ts";
import {
  EXCLUDED_CLOCK_AUGMENT_IDS,
  SIMULATION_CATALOG_SIZE,
  SIMULATION_ELIGIBLE_AUGMENT_IDS,
  SIMULATION_ELIGIBLE_AUGMENTS,
  SIMULATION_ELIGIBLE_COUNT,
} from "./simulation-pool.ts";
import {
  catalogFingerprint,
  chooseVisibleAction,
  hashSeed,
  policyDecisionSeed,
  SeededRandom,
  stableStringify,
} from "./visible-policy.ts";

const TIER_ORDER = ["spades", "hearts", "clubs", "diamonds"] as const;
const SIDES = ["black", "white"] as const;
const BOOTSTRAP_SAMPLES = 2_048;

export type CrossTierRoundOrder = "higher_first" | "lower_first";
export type CrossTierStratum = "round_order" | "setup";

export interface TierRepresentative {
  suit: AugmentSuit;
  focal: AugmentId;
  neutral: AugmentId;
}

export interface CrossTierComparison {
  higher: AugmentSuit;
  lower: AugmentSuit;
  key: string;
}

export interface CrossTierCardPair extends CrossTierComparison {
  higherCard: AugmentId;
  lowerCard: AugmentId;
  pairKey: string;
  scheduleOrdinal: number;
}

export interface CrossTierScheduledGroup extends CrossTierCardPair {
  cycle: number;
  roundOrder: CrossTierRoundOrder;
  stratum: CrossTierStratum;
  groupKey: string;
}

export interface CrossTierLeg {
  index: 0 | 1 | 2 | 3;
  blackProfile: "higher" | "lower";
  whiteProfile: "higher" | "lower";
  firstTurn: Side;
}

export interface FocalLegMetric {
  augmentId: AugmentId;
  profile: "higher" | "lower";
  round: 1 | 2;
  selected: boolean;
  triggers: number;
  opportunity: boolean;
  firstTriggerMove: number | null;
}

export interface CrossTierLegResult {
  comparisonKey: string;
  pairKey: string;
  groupKey: string;
  scheduleOrdinal: number;
  stratum: CrossTierStratum;
  roundOrder: CrossTierRoundOrder;
  leg: CrossTierLeg;
  pairedSeed: number;
  winner: Side | null;
  winningProfile: "higher" | "lower" | null;
  finished: boolean;
  finishReason: GameState["finishReason"];
  drawReason: NonNullable<GameState["drawReason"]> | null;
  finalClockMs: Record<Side, number> | null;
  secondDraftStartedAtMove: number | null;
  secondDraftRevealed: boolean;
  focal: Record<Side, FocalLegMetric>;
  moves: number;
  searchNodes: number;
  passExtraMoveCounts: Record<Side, Partial<Record<AugmentId, number>>>;
  capped: boolean;
  stuck: boolean;
  exception: string | null;
}

export interface CrossTierMirrorSample {
  groupKey: string;
  higherCard: AugmentId;
  lowerCard: AugmentId;
  roundOrder: CrossTierRoundOrder;
  higherScore: number;
}

interface FocalAggregate {
  assignedGames: number;
  selectedGames: number;
  triggerGames: number;
  triggers: number;
  opportunities: number;
}

interface ClockAggregate {
  samples: number;
  totalMs: number;
}

interface DraftTimingAggregate {
  reachedLegs: number;
  revealedLegs: number;
  roundTwoFocalSelections: number;
  timingViolations: number;
}

interface CrossTierComparisonAggregate {
  higher: AugmentSuit;
  lower: AugmentSuit;
  scheduledGroups: number;
  completeMirrorGroups: number;
  games: number;
  higherWins: number;
  lowerWins: number;
  draws: number;
  threefoldDraws: number;
  unfinished: number;
  exceptions: number;
  stuck: number;
  capped: number;
  passExtraMoves: number;
  higherPassExtraMoves: number;
  lowerPassExtraMoves: number;
  finishReasons: Record<string, number>;
  roundOrders: Record<
    CrossTierRoundOrder,
    { scheduledGroups: number; completeMirrorGroups: number }
  >;
  focal: Record<"higher" | "lower", FocalAggregate>;
  terminalClock: Record<"higher" | "lower", ClockAggregate>;
  draftTiming: DraftTimingAggregate;
  mirrorSamples: CrossTierMirrorSample[];
}

export interface CrossTierAggregate {
  groups: number;
  completeGroups: number;
  games: number;
  finished: number;
  threefoldDraws: number;
  unfinished: number;
  exceptions: number;
  stuck: number;
  capped: number;
  moves: number;
  searchNodes: number;
  passExtraMoves: number;
  finishReasons: Record<string, number>;
  pairedSeeds: Record<string, number>;
  comparisons: Record<string, CrossTierComparisonAggregate>;
  setupComparisons: Record<string, CrossTierComparisonAggregate>;
  cardScores: Partial<Record<AugmentId, number[]>>;
  setupCardScores: Partial<Record<AugmentId, number[]>>;
  cardGroups: Partial<Record<AugmentId, number>>;
  cardPassExtraMoves: Partial<Record<AugmentId, number>>;
  focal: Record<"higher" | "lower", FocalAggregate>;
  terminalClock: Record<"higher" | "lower", ClockAggregate>;
  draftTiming: DraftTimingAggregate;
  strata: Record<CrossTierStratum, { scheduledGroups: number; completeMirrorGroups: number }>;
  legResults: CrossTierLegResult[];
  errorSamples: string[];
}

interface FocalSummary extends FocalAggregate {
  triggerRate: number | null;
  opportunityRate: number | null;
}

interface ComparisonReportRow {
  higher: AugmentSuit;
  lower: AugmentSuit;
  stratum: CrossTierStratum;
  executedGroups: number;
  completeMirrorGroups: number;
  higherScore: ConfidenceInterval | null;
  byRoundOrder: Record<CrossTierRoundOrder, ConfidenceInterval | null>;
  sampleSufficient: boolean;
  direction: "higher" | "tie" | "lower" | "insufficient";
  intervalExcludesParity: boolean;
  games: number;
  threefoldDraws: number;
  unfinished: number;
  exceptions: number;
  stuck: number;
  capped: number;
  finishReasons: Record<string, number>;
  averageFinalClockMs: Record<"higher" | "lower", number | null>;
  focal: Record<"higher" | "lower", FocalSummary>;
  draftTiming: DraftTimingAggregate;
  passExtraMoves: number;
  higherPassExtraMoves: number;
  lowerPassExtraMoves: number;
}

export interface CrossTierReport {
  purpose: "diagnostic_only";
  schemaVersion: 5;
  algorithmVersion: typeof BALANCE_ALGORITHM_VERSION;
  engineRulesFingerprint: typeof BALANCE_ENGINE_RULES_FINGERPRINT;
  generatedAt: string;
  catalogFingerprint: string;
  configFingerprint: string;
  scheduleFingerprint: string;
  seed: number;
  options: TournamentOptions;
  catalogSize: number;
  simulationEligibleSize: number;
  excludedClockAugmentIds: AugmentId[];
  intervalMethod: "deterministic mirror-group percentile bootstrap";
  acceptancePass: boolean;
  global: {
    plannedGroups: number | null;
    executedGroups: number;
    completeMirrorGroups: number;
    games: number;
    finished: number;
    threefoldDraws: number;
    unfinished: number;
    exceptions: number;
    stuck: number;
    capped: number;
    moves: number;
    searchNodes: number;
    passExtraMoves: number;
    finishReasons: Record<string, number>;
    pairedSeeds: Record<string, number>;
    averageFinalClockMs: Record<"higher" | "lower", number | null>;
    focal: Record<"higher" | "lower", FocalSummary>;
    draftTiming: DraftTimingAggregate;
  };
  strata: Record<CrossTierStratum, { executedGroups: number; completeMirrorGroups: number }>;
  comparisons: ComparisonReportRow[];
  setupComparisons: ComparisonReportRow[];
  cards: Array<{
    id: AugmentId;
    suit: AugmentSuit;
    role: "focal";
    executedGroups: number;
    roundOrderCompleteMirrorGroups: number;
    setupCompleteMirrorGroups: number;
    roundOrderScore: ConfidenceInterval | null;
    setupScore: ConfidenceInterval | null;
    passExtraMoves: number;
  }>;
  tiers: Array<{
    suit: AugmentSuit;
    expectedRank: number;
    cardsRepresented: number;
    correctionScore: ConfidenceInterval | null;
  }>;
  ordering: {
    expected: "spades > hearts > clubs > diamonds";
    pointEstimatePass: boolean;
    tierPointEstimatePass: boolean;
    sampleSufficient: boolean;
    intervalsAllAboveParity: boolean;
  };
  coverage: {
    eligibleCards: number;
    executedCards: number;
    roundOrderCompleteCards: number;
    setupCompleteCards: number;
    requiredNonSetupCards: number;
    nonSetupBothOrdersCompleteCards: number;
    requiredSetupCards: number;
    setupFocalCompleteCards: number;
    missingCards: AugmentId[];
  };
  legs: CrossTierLegResult[];
  limitations: string[];
  errorSamples: string[];
}

export function selectTierRepresentatives(): TierRepresentative[] {
  return TIER_ORDER.map((suit) => {
    const candidates = SIMULATION_ELIGIBLE_AUGMENTS.filter(
      (card) =>
        card.suit === suit && card.activation === "active" && card.effect.kind === "movement",
    ).map((card) => card.id);
    if (candidates.length < 2) {
      throw new Error(`${suit} needs two active movement cards for synthetic calibration.`);
    }
    return { suit, focal: candidates[0], neutral: candidates[1] };
  });
}

export function buildCrossTierComparisons(): CrossTierComparison[] {
  const comparisons: CrossTierComparison[] = [];
  for (let higher = 0; higher < TIER_ORDER.length; higher += 1) {
    for (let lower = higher + 1; lower < TIER_ORDER.length; lower += 1) {
      comparisons.push({
        higher: TIER_ORDER[higher],
        lower: TIER_ORDER[lower],
        key: `${TIER_ORDER[higher]}>${TIER_ORDER[lower]}`,
      });
    }
  }
  return comparisons;
}

export function buildCrossTierCardSchedule(cycle = 0): CrossTierCardPair[] {
  if (!Number.isSafeInteger(cycle) || cycle < 0) throw new Error("Cross-tier cycle must be non-negative.");
  return buildCrossTierComparisons().flatMap((comparison) => {
    const higherCards = SIMULATION_ELIGIBLE_AUGMENTS.filter((card) => card.suit === comparison.higher)
      .map((card) => card.id)
      .sort();
    const lowerCards = SIMULATION_ELIGIBLE_AUGMENTS.filter((card) => card.suit === comparison.lower)
      .map((card) => card.id)
      .sort();
    const length = Math.max(higherCards.length, lowerCards.length);
    const lowerOffset = cycle % lowerCards.length;
    return Array.from({ length }, (_, scheduleOrdinal) => {
      const higherCard = higherCards[scheduleOrdinal % higherCards.length];
      const lowerCard = lowerCards[(scheduleOrdinal + lowerOffset) % lowerCards.length];
      return {
        ...comparison,
        higherCard,
        lowerCard,
        scheduleOrdinal,
        pairKey: `${comparison.key}:${higherCard}::${lowerCard}`,
      };
    });
  });
}

export function roundOrdersForPair(pair: CrossTierCardPair): CrossTierRoundOrder[] {
  const higherSetup = getAugmentDefinition(pair.higherCard).activation === "setup";
  const lowerSetup = getAugmentDefinition(pair.lowerCard).activation === "setup";
  if (higherSetup && lowerSetup) {
    throw new Error("Two setup-only focal cards cannot both be selected in a legal cross-tier game.");
  }
  if (higherSetup) return ["higher_first"];
  if (lowerSetup) return ["lower_first"];
  return ["higher_first", "lower_first"];
}

function scheduledGroup(pair: CrossTierCardPair, cycle: number, roundOrder: CrossTierRoundOrder) {
  const stratum: CrossTierStratum =
    getAugmentDefinition(pair.higherCard).activation === "setup" ||
    getAugmentDefinition(pair.lowerCard).activation === "setup"
      ? "setup"
      : "round_order";
  if (!roundOrdersForPair(pair).includes(roundOrder)) {
    throw new Error(`${pair.pairKey} cannot legally use ${roundOrder}.`);
  }
  return {
    ...pair,
    cycle,
    roundOrder,
    stratum,
    groupKey: `${cycle}:${pair.key}:${pair.scheduleOrdinal}:${roundOrder}:${pair.pairKey}`,
  } satisfies CrossTierScheduledGroup;
}

export function buildCrossTierExperimentSchedule(cycle = 0): CrossTierScheduledGroup[] {
  return buildCrossTierCardSchedule(cycle).flatMap((pair) =>
    roundOrdersForPair(pair).map((roundOrder) => scheduledGroup(pair, cycle, roundOrder)),
  );
}

export function crossTierScheduleFingerprint() {
  return String(
    hashSeed(
      stableStringify({
        algorithm: "diagnostic-cross-tier-v17-v3-no-clock-zero-time-deterministic-ids-slot-stable-drafts-relocation-aware-private-draft-worlds",
        engineRulesFingerprint: BALANCE_ENGINE_RULES_FINGERPRINT,
        cycleZero: buildCrossTierExperimentSchedule(0),
      }),
    ),
  );
}

export function crossTierLegs(): CrossTierLeg[] {
  return [
    { index: 0, blackProfile: "higher", whiteProfile: "lower", firstTurn: "black" },
    { index: 1, blackProfile: "lower", whiteProfile: "higher", firstTurn: "black" },
    { index: 2, blackProfile: "higher", whiteProfile: "lower", firstTurn: "white" },
    { index: 3, blackProfile: "lower", whiteProfile: "higher", firstTurn: "white" },
  ];
}

function representativeMap(representatives: readonly TierRepresentative[]) {
  return Object.fromEntries(representatives.map((entry) => [entry.suit, entry])) as Record<
    AugmentSuit,
    TierRepresentative
  >;
}

function dummyCard(suit: AugmentSuit, focal: AugmentId) {
  const dummy = SIMULATION_ELIGIBLE_AUGMENTS.find(
    (card) =>
      card.suit === suit &&
      card.id !== focal &&
      card.activation === "active" &&
      card.effect.kind === "movement",
  );
  if (!dummy) throw new Error(`No side-effect-free dummy card exists for ${suit}.`);
  return dummy.id;
}

function focalForSide(group: CrossTierScheduledGroup, leg: CrossTierLeg, side: Side) {
  const profile = side === "black" ? leg.blackProfile : leg.whiteProfile;
  return {
    profile,
    augmentId: profile === "higher" ? group.higherCard : group.lowerCard,
  } as const;
}

function roundForProfile(group: CrossTierScheduledGroup, profile: "higher" | "lower") {
  return (group.roundOrder === `${profile}_first` ? 1 : 2) as 1 | 2;
}

function suitForRound(group: CrossTierScheduledGroup, round: 1 | 2) {
  const higherFirst = group.roundOrder === "higher_first";
  if (round === 1) return higherFirst ? group.higher : group.lower;
  return higherFirst ? group.lower : group.higher;
}

function selectedForRound(
  group: CrossTierScheduledGroup,
  leg: CrossTierLeg,
  side: Side,
  round: 1 | 2,
) {
  const focal = focalForSide(group, leg, side).augmentId;
  const suit = suitForRound(group, round);
  return getAugmentDefinition(focal).suit === suit ? focal : dummyCard(suit, focal);
}

function exhaustSchemaOnlyNeutral(state: GameState, side: Side, augmentId: AugmentId) {
  if (!state.augment) throw new Error("Synthetic neutral exhaustion requires augment state.");
  state.augment.triggerCounts[side][augmentId] = getAugmentDefinition(augmentId).charges;
  if (!state.augment.usedBySide[side].includes(augmentId)) {
    state.augment.usedBySide[side].push(augmentId);
  }
}

function createInitialCrossTierGame(
  group: CrossTierScheduledGroup,
  leg: CrossTierLeg,
  pairedSeed: number,
  nowMs: number,
) {
  const blackOpening = selectedForRound(group, leg, "black", 1);
  const whiteOpening = selectedForRound(group, leg, "white", 1);
  const state = createControlledPairGame(
    blackOpening,
    whiteOpening,
    leg.firstTurn,
    `${pairedSeed}:opening-setup`,
    nowMs,
  );
  if (!state.augment) throw new Error("Synthetic cross-tier game has no augment state.");
  for (const side of SIDES) {
    const opening = side === "black" ? blackOpening : whiteOpening;
    if (opening !== focalForSide(group, leg, side).augmentId) {
      exhaustSchemaOnlyNeutral(state, side, opening);
    }
  }
  if (state.moveNumber !== 0 || state.augment.draft.rounds.length !== 1) {
    throw new Error("Cross-tier game must begin at move 0 with only the revealed opening round.");
  }
  projectGame(state, "black", nowMs);
  projectGame(state, "white", nowMs);
  return state;
}

export function createDirectCrossTierGame(
  pair: CrossTierCardPair,
  leg: CrossTierLeg,
  pairedSeed: number,
  nowMs = 1_000_000,
  roundOrder: CrossTierRoundOrder = roundOrdersForPair(pair)[0],
) {
  return createInitialCrossTierGame(scheduledGroup(pair, 0, roundOrder), leg, pairedSeed, nowMs);
}

export function createSyntheticCrossTierGame(
  comparison: CrossTierComparison,
  leg: CrossTierLeg,
  pairedSeed: number,
  representatives: readonly TierRepresentative[] = selectTierRepresentatives(),
  nowMs = 1_000_000,
) {
  const bySuit = representativeMap(representatives);
  return createDirectCrossTierGame(
    {
      ...comparison,
      higherCard: bySuit[comparison.higher].focal,
      lowerCard: bySuit[comparison.lower].focal,
      scheduleOrdinal: 0,
      pairKey: `${comparison.key}:representatives`,
    },
    leg,
    pairedSeed,
    nowMs,
    "higher_first",
  );
}

export function crossTierPairedSeed(
  options: Pick<TournamentOptions, "seed">,
  group: Pick<
    CrossTierScheduledGroup,
    "cycle" | "key" | "scheduleOrdinal" | "roundOrder"
  >,
) {
  return hashSeed(
    `${options.seed}:cross-tier-v17:${BALANCE_ENGINE_RULES_FINGERPRINT}:${group.cycle}:${group.key}:${group.scheduleOrdinal}:${group.roundOrder}`,
  );
}

function forceSecondRoundOffers(
  state: GameState,
  group: CrossTierScheduledGroup,
  leg: CrossTierLeg,
) {
  if (state.phase !== "augment_draft" || !state.augment) {
    throw new Error("Second-round offers may be forced only inside the engine augment_draft phase.");
  }
  if (state.moveNumber !== 9 || state.augment.draft.activeRound !== 2) {
    throw new Error("The second augment draft did not begin immediately after nine completed moves.");
  }
  const round = state.augment.draft.rounds.find((candidate) => candidate.number === 2);
  if (!round || round.revealed || round.suit !== suitForRound(group, 2)) {
    throw new Error("The engine opened an unexpected second-round suit.");
  }
  for (const side of SIDES) {
    const selected = selectedForRound(group, leg, side, 2);
    const original = [...round.players[side].options];
    const existing = original.filter((id) => id !== selected);
    if (existing.length < 2) throw new Error(`${side} has fewer than two legal second-round fillers.`);
    const controlled = [selected, existing[0], existing[1]] as const;
    round.players[side].options = [...controlled];
    const removedBeforeExposure = new Set(original.filter((id) => !controlled.includes(id)));
    state.augment.draft.seenBySide[side] = state.augment.draft.seenBySide[side].filter(
      (id) => !removedBeforeExposure.has(id),
    );
    state.augment.draft.seenBySide[side].push(
      ...controlled.filter((id) => !state.augment!.draft.seenBySide[side].includes(id)),
    );
  }
  projectGame(state, "black");
  projectGame(state, "white");
}

function seedForDesiredSecondSuit(
  group: CrossTierScheduledGroup,
  pairedSeed: number,
) {
  const openingSuit = suitForRound(group, 1);
  const desiredSuit = suitForRound(group, 2);
  const eligible = AUGMENT_SUITS.filter(
    (suit) =>
      suit !== openingSuit &&
      SIMULATION_ELIGIBLE_AUGMENTS.filter(
        (card) => card.suit === suit && card.activation !== "setup",
      ).length >= 3,
  );
  const desiredIndex = eligible.indexOf(desiredSuit);
  if (desiredIndex < 0) throw new Error(`${desiredSuit} is not a legal second-round suit.`);
  for (let nonce = 0; nonce < 10_000; nonce += 1) {
    const candidate = `${pairedSeed}:formal-round-two:${group.key}:${group.roundOrder}:${nonce}`;
    if (Math.floor(new SeededRandom(candidate).next() * eligible.length) === desiredIndex) {
      return candidate;
    }
  }
  throw new Error("Could not derive a deterministic second-round suit seed.");
}

function completeForcedSecondDraft(
  initial: GameState,
  group: CrossTierScheduledGroup,
  leg: CrossTierLeg,
  nowMs: number,
) {
  let state = constrainActiveDraftToSimulationPool(
    initial,
    `${group.groupKey}:forced-second-draft`,
  );
  forceSecondRoundOffers(state, group, leg);
  for (const side of SIDES) {
    const selected = selectedForRound(group, leg, side, 2);
    state = applyPlayerAction(state, side, { type: "augment_select", augmentId: selected }, nowMs);
    state = applyPlayerAction(state, side, { type: "augment_lock" }, nowMs);
  }
  if (state.phase !== "playing" || !state.augment?.draft.rounds[1]?.revealed) {
    throw new Error("The formal second augment draft did not reveal after both locks.");
  }
  for (const side of SIDES) {
    const selected = selectedForRound(group, leg, side, 2);
    if (selected !== focalForSide(group, leg, side).augmentId) {
      exhaustSchemaOnlyNeutral(state, side, selected);
    }
  }
  return state;
}

function blankFocalMetric(
  group: CrossTierScheduledGroup,
  leg: CrossTierLeg,
  side: Side,
): FocalLegMetric {
  const focal = focalForSide(group, leg, side);
  return {
    ...focal,
    round: roundForProfile(group, focal.profile),
    selected: false,
    triggers: 0,
    opportunity: false,
    firstTriggerMove: null,
  };
}

function focalMetricsForState(
  group: CrossTierScheduledGroup,
  leg: CrossTierLeg,
  state: GameState | null,
  opportunities: Record<Side, Set<AugmentId>>,
  firstTriggerMoves: Record<Side, Partial<Record<AugmentId, number>>>,
) {
  return Object.fromEntries(
    SIDES.map((side) => {
      const metric = blankFocalMetric(group, leg, side);
      metric.selected = Boolean(state?.augment?.draft.loadouts[side].includes(metric.augmentId));
      metric.triggers = state?.augment?.triggerCounts[side][metric.augmentId] ?? 0;
      metric.opportunity = opportunities[side].has(metric.augmentId);
      metric.firstTriggerMove = firstTriggerMoves[side][metric.augmentId] ?? null;
      return [side, metric];
    }),
  ) as Record<Side, FocalLegMetric>;
}

export function playCrossTierScheduledLeg(
  group: CrossTierScheduledGroup,
  leg: CrossTierLeg,
  options: TournamentOptions,
): CrossTierLegResult {
  options = normalizeTournamentOptions(options);
  const pairedSeed = crossTierPairedSeed(options, group);
  const opportunities: Record<Side, Set<AugmentId>> = {
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
  const nowMs = 1_000_000;
  let diagnosticState: GameState | null = null;
  let searchNodes = 0;
  let stuck = false;
  let secondDraftStartedAtMove: number | null = null;
  let secondDraftRevealed = false;
  try {
    return withDeterministicEngineRandom(pairedSeed, () => {
      let state = createInitialCrossTierGame(group, leg, pairedSeed, nowMs);
      diagnosticState = state;
      const captureTriggerChanges = (
        previous: Record<Side, Partial<Record<AugmentId, number>>> | null,
        next: GameState,
      ) => {
        for (const side of SIDES) {
          const focal = focalForSide(group, leg, side).augmentId;
          const before = previous?.[side][focal] ?? 0;
          const after = next.augment?.triggerCounts[side][focal] ?? 0;
          if (after > before) {
            opportunities[side].add(focal);
            firstTriggerMoves[side][focal] ??= next.moveNumber;
          }
        }
      };
      for (const side of SIDES) {
        const focal = focalForSide(group, leg, side).augmentId;
        if (
          roundForProfile(group, focalForSide(group, leg, side).profile) === 1 &&
          getAugmentDefinition(focal).activation === "setup"
        ) {
          opportunities[side].add(focal);
        }
      }
      captureTriggerChanges(null, state);
      let decisionOrdinal = 0;
      const secondRoundSeed = seedForDesiredSecondSuit(group, pairedSeed);
      while (
        state.phase !== "finished" &&
        (state.phase === "augment_draft" || state.moveNumber < options.maxActions)
      ) {
        if (state.phase === "augment_draft") {
          secondDraftStartedAtMove ??= state.moveNumber;
          const beforeTriggers = structuredClone(
            state.augment?.triggerCounts ?? { black: {}, white: {} },
          );
          state = completeForcedSecondDraft(state, group, leg, nowMs);
          diagnosticState = state;
          secondDraftRevealed = true;
          captureTriggerChanges(beforeTriggers, state);
          continue;
        }
        if (state.phase !== "playing") {
          stuck = true;
          break;
        }
        const side = state.turn;
        const searchSeed = policyDecisionSeed(pairedSeed, decisionOrdinal);
        decisionOrdinal += 1;
        const decision = chooseVisibleAction(state, side, searchSeed, options.search, nowMs);
        searchNodes += decision.nodesEvaluated;
        for (const augmentId of decision.opportunityAugmentIds) {
          if (augmentId === focalForSide(group, leg, side).augmentId) {
            opportunities[side].add(augmentId);
          }
        }
        if (!decision.action) {
          stuck = true;
          break;
        }
        const beforeTriggers = structuredClone(
          state.augment?.triggerCounts ?? { black: {}, white: {} },
        );
        if (decision.action.type === "pass_extra_move") {
          const augmentId = pendingPassAugmentId(state, side);
          if (!augmentId) throw new Error(`${side} passed an extra move without a granting augment.`);
          passExtraMoveCounts[side][augmentId] =
            (passExtraMoveCounts[side][augmentId] ?? 0) + 1;
        }
        state =
          state.moveNumber === 8
            ? withDeterministicEngineRandom(secondRoundSeed, () =>
                applyPlayerAction(state, side, decision.action!, nowMs),
              )
            : applyPlayerAction(state, side, decision.action, nowMs);
        diagnosticState = state;
        captureTriggerChanges(beforeTriggers, state);
      }
      const focal = focalMetricsForState(
        group,
        leg,
        state,
        opportunities,
        firstTriggerMoves,
      );
      return {
        comparisonKey: group.key,
        pairKey: group.pairKey,
        groupKey: group.groupKey,
        scheduleOrdinal: group.scheduleOrdinal,
        stratum: group.stratum,
        roundOrder: group.roundOrder,
        leg,
        pairedSeed,
        winner: state.winner,
        winningProfile:
          state.winner === "black"
            ? leg.blackProfile
            : state.winner === "white"
              ? leg.whiteProfile
              : null,
        finished: state.phase === "finished",
        finishReason: state.finishReason,
        drawReason: state.drawReason ?? null,
        finalClockMs: state.clock ? { ...state.clock.remainingMs } : null,
        secondDraftStartedAtMove,
        secondDraftRevealed,
        focal,
        moves: state.moveNumber,
        searchNodes,
        passExtraMoveCounts,
        capped: state.phase !== "finished" && state.moveNumber >= options.maxActions,
        stuck,
        exception: null,
      };
    });
  } catch (error) {
    const failedState = diagnosticState as GameState | null;
    const focal = focalMetricsForState(
      group,
      leg,
      failedState,
      opportunities,
      firstTriggerMoves,
    );
    return {
      comparisonKey: group.key,
      pairKey: group.pairKey,
      groupKey: group.groupKey,
      scheduleOrdinal: group.scheduleOrdinal,
      stratum: group.stratum,
      roundOrder: group.roundOrder,
      leg,
      pairedSeed,
      winner: null,
      winningProfile: null,
      finished: false,
      finishReason: null,
      drawReason: null,
      finalClockMs: failedState?.clock
        ? { ...failedState.clock.remainingMs }
        : null,
      secondDraftStartedAtMove,
      secondDraftRevealed,
      focal,
      moves: failedState?.moveNumber ?? 0,
      searchNodes,
      passExtraMoveCounts,
      capped: false,
      stuck: false,
      exception: error instanceof Error ? error.message : String(error),
    };
  }
}

export function playCrossTierScheduledMirrorGroup(
  group: CrossTierScheduledGroup,
  options: TournamentOptions,
) {
  return crossTierLegs().map((leg) => playCrossTierScheduledLeg(group, leg, options));
}

export function playCrossTierCardLeg(
  pair: CrossTierCardPair,
  leg: CrossTierLeg,
  cycle: number,
  options: TournamentOptions,
  roundOrder: CrossTierRoundOrder = roundOrdersForPair(pair)[0],
) {
  return playCrossTierScheduledLeg(scheduledGroup(pair, cycle, roundOrder), leg, options);
}

export function playCrossTierCardMirrorGroup(
  pair: CrossTierCardPair,
  cycle: number,
  options: TournamentOptions,
  roundOrder: CrossTierRoundOrder = roundOrdersForPair(pair)[0],
) {
  return playCrossTierScheduledMirrorGroup(scheduledGroup(pair, cycle, roundOrder), options);
}

export function playCrossTierLeg(
  comparison: CrossTierComparison,
  leg: CrossTierLeg,
  cycle: number,
  options: TournamentOptions,
  representatives: readonly TierRepresentative[] = selectTierRepresentatives(),
  roundOrder: CrossTierRoundOrder = "higher_first",
) {
  const bySuit = representativeMap(representatives);
  return playCrossTierCardLeg(
    {
      ...comparison,
      higherCard: bySuit[comparison.higher].focal,
      lowerCard: bySuit[comparison.lower].focal,
      scheduleOrdinal: 0,
      pairKey: `${comparison.key}:representatives`,
    },
    leg,
    cycle,
    options,
    roundOrder,
  );
}

export function playCrossTierMirrorGroup(
  comparison: CrossTierComparison,
  cycle: number,
  options: TournamentOptions,
  representatives: readonly TierRepresentative[] = selectTierRepresentatives(),
  roundOrder: CrossTierRoundOrder = "higher_first",
) {
  return crossTierLegs().map((leg) =>
    playCrossTierLeg(comparison, leg, cycle, options, representatives, roundOrder),
  );
}

function blankFocalAggregate(): FocalAggregate {
  return {
    assignedGames: 0,
    selectedGames: 0,
    triggerGames: 0,
    triggers: 0,
    opportunities: 0,
  };
}

function blankClockAggregate(): ClockAggregate {
  return { samples: 0, totalMs: 0 };
}

function blankDraftTiming(): DraftTimingAggregate {
  return {
    reachedLegs: 0,
    revealedLegs: 0,
    roundTwoFocalSelections: 0,
    timingViolations: 0,
  };
}

function blankComparison(higher: AugmentSuit, lower: AugmentSuit): CrossTierComparisonAggregate {
  return {
    higher,
    lower,
    scheduledGroups: 0,
    completeMirrorGroups: 0,
    games: 0,
    higherWins: 0,
    lowerWins: 0,
    draws: 0,
    threefoldDraws: 0,
    unfinished: 0,
    exceptions: 0,
    stuck: 0,
    capped: 0,
    passExtraMoves: 0,
    higherPassExtraMoves: 0,
    lowerPassExtraMoves: 0,
    finishReasons: {},
    roundOrders: {
      higher_first: { scheduledGroups: 0, completeMirrorGroups: 0 },
      lower_first: { scheduledGroups: 0, completeMirrorGroups: 0 },
    },
    focal: { higher: blankFocalAggregate(), lower: blankFocalAggregate() },
    terminalClock: { higher: blankClockAggregate(), lower: blankClockAggregate() },
    draftTiming: blankDraftTiming(),
    mirrorSamples: [],
  };
}

export function createEmptyCrossTierAggregate(): CrossTierAggregate {
  return {
    groups: 0,
    completeGroups: 0,
    games: 0,
    finished: 0,
    threefoldDraws: 0,
    unfinished: 0,
    exceptions: 0,
    stuck: 0,
    capped: 0,
    moves: 0,
    searchNodes: 0,
    passExtraMoves: 0,
    finishReasons: {},
    pairedSeeds: {},
    comparisons: {},
    setupComparisons: {},
    cardScores: {},
    setupCardScores: {},
    cardGroups: {},
    cardPassExtraMoves: {},
    focal: { higher: blankFocalAggregate(), lower: blankFocalAggregate() },
    terminalClock: { higher: blankClockAggregate(), lower: blankClockAggregate() },
    draftTiming: blankDraftTiming(),
    strata: {
      round_order: { scheduledGroups: 0, completeMirrorGroups: 0 },
      setup: { scheduledGroups: 0, completeMirrorGroups: 0 },
    },
    legResults: [],
    errorSamples: [],
  };
}

function addFocal(target: FocalAggregate, metric: FocalLegMetric) {
  target.assignedGames += 1;
  if (metric.selected) target.selectedGames += 1;
  if (metric.triggers > 0) target.triggerGames += 1;
  target.triggers += metric.triggers;
  if (metric.opportunity) target.opportunities += 1;
}

function addClock(target: ClockAggregate, value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return;
  target.samples += 1;
  target.totalMs += value;
}

export function crossTierTimingViolation(result: CrossTierLegResult) {
  if (result.exception) return null;
  const roundTwo = SIDES.map((side) => result.focal[side]).filter(
    (metric) => metric.round === 2,
  );
  const roundOne = SIDES.map((side) => result.focal[side]).filter(
    (metric) => metric.round === 1,
  );
  if (roundOne.some((metric) => !metric.selected)) {
    return "opening focal was not selected";
  }
  if (result.secondDraftStartedAtMove === null) {
    if (result.secondDraftRevealed) return "second draft revealed without starting";
    if (roundTwo.some((metric) => metric.selected)) {
      return "round-two focal was selected before the second draft";
    }
    if (!result.exception && !result.finished && result.moves >= 9) {
      return "play advanced beyond move 9 without the second draft";
    }
    return null;
  }
  if (result.secondDraftStartedAtMove !== 9) {
    return `second draft started at move ${result.secondDraftStartedAtMove}`;
  }
  if (!result.secondDraftRevealed) return "second draft started but was not revealed";
  if (roundTwo.length !== 1 || roundTwo.some((metric) => !metric.selected)) {
    return "round-two focal was not selected after reveal";
  }
  return null;
}

function strictRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has missing or unexpected fields.`);
  }
  return value as Record<string, unknown>;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function finiteNonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function validateCrossTierLegResult(
  group: CrossTierScheduledGroup,
  result: CrossTierLegResult,
  expectedLeg: CrossTierLeg,
  options: TournamentOptions,
) {
  strictRecord(
    result,
    [
      "comparisonKey",
      "pairKey",
      "groupKey",
      "scheduleOrdinal",
      "stratum",
      "roundOrder",
      "leg",
      "pairedSeed",
      "winner",
      "winningProfile",
      "finished",
      "finishReason",
      "drawReason",
      "finalClockMs",
      "secondDraftStartedAtMove",
      "secondDraftRevealed",
      "focal",
      "moves",
      "searchNodes",
      "passExtraMoveCounts",
      "capped",
      "stuck",
      "exception",
    ],
    "Cross-tier leg result",
  );
  if (
    result.comparisonKey !== group.key ||
    result.pairKey !== group.pairKey ||
    result.groupKey !== group.groupKey ||
    result.scheduleOrdinal !== group.scheduleOrdinal ||
    result.stratum !== group.stratum ||
    result.roundOrder !== group.roundOrder
  ) {
    throw new Error("Cross-tier leg metadata does not match its scheduled group.");
  }
  strictRecord(
    result.leg,
    ["index", "blackProfile", "whiteProfile", "firstTurn"],
    "Cross-tier mirror leg",
  );
  if (
    result.leg.index !== expectedLeg.index ||
    result.leg.blackProfile !== expectedLeg.blackProfile ||
    result.leg.whiteProfile !== expectedLeg.whiteProfile ||
    result.leg.firstTurn !== expectedLeg.firstTurn
  ) {
    throw new Error("Cross-tier mirror leg does not match the canonical color/first-turn template.");
  }
  if (
    !finiteNonNegativeInteger(result.pairedSeed) ||
    result.pairedSeed !== crossTierPairedSeed(options, group)
  ) {
    throw new Error("Cross-tier leg paired seed does not match the treatment-neutral schedule seed.");
  }
  if (!finiteNonNegativeInteger(result.moves) || result.moves > options.maxActions) {
    throw new Error("Cross-tier leg has an invalid move count.");
  }
  if (!finiteNonNegativeInteger(result.searchNodes)) {
    throw new Error("Cross-tier leg has an invalid search-node count.");
  }
  for (const field of ["finished", "secondDraftRevealed", "capped", "stuck"] as const) {
    if (typeof result[field] !== "boolean") throw new Error(`Cross-tier leg ${field} must be boolean.`);
  }
  if (
    result.secondDraftStartedAtMove !== null &&
    !finiteNonNegativeInteger(result.secondDraftStartedAtMove)
  ) {
    throw new Error("Cross-tier leg has an invalid second-draft move.");
  }
  if (
    result.secondDraftStartedAtMove !== null &&
    result.secondDraftStartedAtMove > result.moves
  ) {
    throw new Error("Cross-tier second-draft timing exceeds the recorded move count.");
  }
  if (result.exception !== null && (typeof result.exception !== "string" || !result.exception.trim())) {
    throw new Error("Cross-tier leg exception must be null or a non-empty string.");
  }
  if (result.winner !== null && result.winner !== "black" && result.winner !== "white") {
    throw new Error("Cross-tier leg winner is invalid.");
  }
  if (
    result.winningProfile !== null &&
    result.winningProfile !== "higher" &&
    result.winningProfile !== "lower"
  ) {
    throw new Error("Cross-tier leg winning profile is invalid.");
  }
  if (
    result.finishReason !== null &&
    !["flag", "no_moves", "resign", "draw", "timeout"].includes(result.finishReason)
  ) {
    throw new Error("Cross-tier leg finish reason is invalid.");
  }
  if (result.drawReason !== null && result.drawReason !== "threefold_repetition") {
    throw new Error("Cross-tier leg draw reason is invalid.");
  }
  const stopCount = Number(result.capped) + Number(result.stuck) + Number(result.exception !== null);
  if (result.finished) {
    if (result.finishReason === null || stopCount !== 0) {
      throw new Error("A finished cross-tier leg cannot also be capped, stuck, or exceptional.");
    }
    if (result.finishReason === "draw") {
      if (
        result.winner !== null ||
        result.winningProfile !== null ||
        result.drawReason !== "threefold_repetition"
      ) {
        throw new Error(
          "A drawn cross-tier leg must be an adjudicated threefold draw without a winner.",
        );
      }
    } else {
      if (result.drawReason !== null) {
        throw new Error("A decisive cross-tier leg cannot retain a draw reason.");
      }
      const expectedProfile =
        result.winner === "black"
          ? result.leg.blackProfile
          : result.winner === "white"
            ? result.leg.whiteProfile
            : null;
      if (expectedProfile === null || result.winningProfile !== expectedProfile) {
        throw new Error("A decisive cross-tier leg has inconsistent winner metadata.");
      }
    }
  } else {
    if (
      result.finishReason !== null ||
      result.drawReason !== null ||
      result.winner !== null ||
      result.winningProfile !== null ||
      stopCount !== 1
    ) {
      throw new Error("An unfinished cross-tier leg must have exactly one stop status.");
    }
    if (result.exception === null) {
      if (result.capped !== (result.moves === options.maxActions)) {
        throw new Error("Cross-tier capped status does not match the action limit.");
      }
      if (result.stuck && result.moves >= options.maxActions) {
        throw new Error("A stuck cross-tier leg cannot also be at the action cap.");
      }
    }
  }
  if (result.finalClockMs !== null) {
    throw new Error("A product-stability cross-tier leg must not retain a simulation clock.");
  }
  strictRecord(result.focal, SIDES, "Cross-tier focal metrics");
  for (const side of SIDES) {
    const metric = result.focal[side];
    strictRecord(
      metric,
      [
        "augmentId",
        "profile",
        "round",
        "selected",
        "triggers",
        "opportunity",
        "firstTriggerMove",
      ],
      `Cross-tier ${side} focal metric`,
    );
    const expectedFocal = focalForSide(group, expectedLeg, side);
    if (
      metric.augmentId !== expectedFocal.augmentId ||
      metric.profile !== expectedFocal.profile ||
      metric.round !== roundForProfile(group, expectedFocal.profile)
    ) {
      throw new Error(`Cross-tier ${side} focal metric does not match the scheduled treatment.`);
    }
    if (typeof metric.selected !== "boolean" || typeof metric.opportunity !== "boolean") {
      throw new Error(`Cross-tier ${side} focal flags must be boolean.`);
    }
    const focalDefinition = getAugmentDefinition(metric.augmentId);
    if (
      !finiteNonNegativeInteger(metric.triggers) ||
      (focalDefinition.activation !== "passive" &&
        metric.triggers > focalDefinition.charges)
    ) {
      throw new Error(`Cross-tier ${side} focal trigger count is invalid.`);
    }
    if (
      metric.firstTriggerMove !== null &&
      (!finiteNonNegativeInteger(metric.firstTriggerMove) || metric.firstTriggerMove > result.moves)
    ) {
      throw new Error(`Cross-tier ${side} first-trigger move is invalid.`);
    }
    if (metric.round === 2 && metric.firstTriggerMove !== null && metric.firstTriggerMove < 9) {
      throw new Error(`Cross-tier ${side} round-two trigger predates the formal second draft.`);
    }
    if (
      (!metric.selected &&
        (metric.triggers !== 0 || metric.opportunity || metric.firstTriggerMove !== null)) ||
      (metric.triggers > 0 && (!metric.opportunity || metric.firstTriggerMove === null)) ||
      (metric.triggers === 0 && metric.firstTriggerMove !== null)
    ) {
      throw new Error(`Cross-tier ${side} focal trigger/opportunity fields are inconsistent.`);
    }
  }
  strictRecord(result.passExtraMoveCounts, SIDES, "Cross-tier pass-extra-move counts");
  const catalogIds = new Set(SIMULATION_ELIGIBLE_AUGMENT_IDS);
  for (const side of SIDES) {
    const counts = plainRecord(
      result.passExtraMoveCounts[side],
      `Cross-tier ${side} pass-extra-move counts`,
    );
    for (const [augmentId, count] of Object.entries(counts)) {
      if (!catalogIds.has(augmentId as AugmentId) || !finiteNonNegativeInteger(count) || count === 0) {
        throw new Error(`Cross-tier ${side} pass-extra-move count is invalid.`);
      }
    }
  }
  const timingIssue = crossTierTimingViolation(result);
  if (timingIssue) throw new Error(`Cross-tier production timing violation: ${timingIssue}.`);
  return result;
}

export function validateCrossTierScheduledMirrorGroup(
  group: CrossTierScheduledGroup,
  results: readonly CrossTierLegResult[],
  options: TournamentOptions,
) {
  if (results.length !== crossTierLegs().length) {
    throw new Error("Cross-tier mirror group must contain four canonical ordered legs.");
  }
  const expectedLegs = crossTierLegs();
  for (let index = 0; index < expectedLegs.length; index += 1) {
    validateCrossTierLegResult(group, results[index], expectedLegs[index], options);
  }
  return results;
}

function addDraftTiming(target: DraftTimingAggregate, result: CrossTierLegResult) {
  if (result.secondDraftStartedAtMove !== null) target.reachedLegs += 1;
  if (result.secondDraftRevealed) target.revealedLegs += 1;
  target.roundTwoFocalSelections += SIDES.filter(
    (side) => result.focal[side].round === 2 && result.focal[side].selected,
  ).length;
}

export function recordCrossTierScheduledMirrorGroup(
  aggregate: CrossTierAggregate,
  group: CrossTierScheduledGroup,
  results: readonly CrossTierLegResult[],
  options: TournamentOptions,
) {
  validateCrossTierScheduledMirrorGroup(group, results, options);
  const previousSeed = aggregate.pairedSeeds[group.groupKey];
  if (previousSeed !== undefined && previousSeed !== results[0].pairedSeed) {
    throw new Error("A completed cross-tier group changed its paired seed.");
  }
  aggregate.pairedSeeds[group.groupKey] = results[0].pairedSeed;
  aggregate.groups += 1;
  aggregate.strata[group.stratum].scheduledGroups += 1;
  aggregate.cardGroups[group.higherCard] = (aggregate.cardGroups[group.higherCard] ?? 0) + 1;
  aggregate.cardGroups[group.lowerCard] = (aggregate.cardGroups[group.lowerCard] ?? 0) + 1;
  const table = group.stratum === "round_order" ? aggregate.comparisons : aggregate.setupComparisons;
  const row = (table[group.key] ??= blankComparison(group.higher, group.lower));
  row.scheduledGroups += 1;
  row.roundOrders[group.roundOrder].scheduledGroups += 1;
  let higherPoints = 0;
  let finished = 0;
  for (const result of results) {
    aggregate.legResults.push(structuredClone(result));
    addDraftTiming(aggregate.draftTiming, result);
    addDraftTiming(row.draftTiming, result);
    aggregate.games += 1;
    aggregate.moves += result.moves;
    aggregate.searchNodes += result.searchNodes;
    row.games += 1;
    for (const side of SIDES) {
      const profile = side === "black" ? result.leg.blackProfile : result.leg.whiteProfile;
      const metric = result.focal[side];
      addFocal(aggregate.focal[profile], metric);
      addFocal(row.focal[profile], metric);
      addClock(aggregate.terminalClock[profile], result.finalClockMs?.[side]);
      addClock(row.terminalClock[profile], result.finalClockMs?.[side]);
      for (const [augmentId, count = 0] of Object.entries(result.passExtraMoveCounts[side])) {
        aggregate.passExtraMoves += count;
        row.passExtraMoves += count;
        if (profile === "higher") row.higherPassExtraMoves += count;
        else row.lowerPassExtraMoves += count;
        const typedId = augmentId as AugmentId;
        aggregate.cardPassExtraMoves[typedId] =
          (aggregate.cardPassExtraMoves[typedId] ?? 0) + count;
      }
    }
    if (result.exception) {
      aggregate.exceptions += 1;
      aggregate.unfinished += 1;
      row.exceptions += 1;
      row.unfinished += 1;
      if (aggregate.errorSamples.length < 20) {
        aggregate.errorSamples.push(`${group.groupKey}/leg-${result.leg.index}: ${result.exception}`);
      }
    } else if (!result.finished) {
      aggregate.unfinished += 1;
      row.unfinished += 1;
      if (result.stuck) {
        aggregate.stuck += 1;
        row.stuck += 1;
      }
      if (result.capped) {
        aggregate.capped += 1;
        row.capped += 1;
      }
    } else {
      aggregate.finished += 1;
      finished += 1;
      const reason = result.finishReason ?? "unknown";
      aggregate.finishReasons[reason] = (aggregate.finishReasons[reason] ?? 0) + 1;
      row.finishReasons[reason] = (row.finishReasons[reason] ?? 0) + 1;
      if (result.winningProfile === "higher") {
        row.higherWins += 1;
        higherPoints += 1;
      } else if (result.winningProfile === "lower") {
        row.lowerWins += 1;
      } else {
        row.draws += 1;
        if (result.drawReason === "threefold_repetition") {
          aggregate.threefoldDraws += 1;
          row.threefoldDraws += 1;
        }
        higherPoints += 0.5;
      }
    }
  }
  const allFocalsObserved = results.every(
    (result) =>
      result.finished &&
      result.secondDraftStartedAtMove === 9 &&
      result.secondDraftRevealed &&
      SIDES.every((side) => result.focal[side].selected),
  );
  if (finished !== 4 || !allFocalsObserved) return;
  const score = higherPoints / 4;
  const sample: CrossTierMirrorSample = {
    groupKey: group.groupKey,
    higherCard: group.higherCard,
    lowerCard: group.lowerCard,
    roundOrder: group.roundOrder,
    higherScore: score,
  };
  aggregate.completeGroups += 1;
  aggregate.strata[group.stratum].completeMirrorGroups += 1;
  row.completeMirrorGroups += 1;
  row.roundOrders[group.roundOrder].completeMirrorGroups += 1;
  row.mirrorSamples.push(sample);
  const targetScores = group.stratum === "round_order" ? aggregate.cardScores : aggregate.setupCardScores;
  (targetScores[group.higherCard] ??= []).push(score);
  (targetScores[group.lowerCard] ??= []).push(1 - score);
}

export function recordCrossTierCardMirrorGroup(
  aggregate: CrossTierAggregate,
  pair: CrossTierCardPair,
  cycle: number,
  results: readonly CrossTierLegResult[],
  options: TournamentOptions,
  roundOrder: CrossTierRoundOrder = results[0]?.roundOrder ?? roundOrdersForPair(pair)[0],
) {
  return recordCrossTierScheduledMirrorGroup(
    aggregate,
    scheduledGroup(pair, cycle, roundOrder),
    results,
    options,
  );
}

export function recordCrossTierMirrorGroup(
  aggregate: CrossTierAggregate,
  comparison: CrossTierComparison,
  cycle: number,
  results: readonly CrossTierLegResult[],
  options: TournamentOptions,
  representatives: readonly TierRepresentative[] = selectTierRepresentatives(),
  roundOrder: CrossTierRoundOrder = results[0]?.roundOrder ?? "higher_first",
) {
  const bySuit = representativeMap(representatives);
  return recordCrossTierCardMirrorGroup(
    aggregate,
    {
      ...comparison,
      higherCard: bySuit[comparison.higher].focal,
      lowerCard: bySuit[comparison.lower].focal,
      scheduleOrdinal: 0,
      pairKey: `${comparison.key}:representatives`,
    },
    cycle,
    results,
    options,
    roundOrder,
  );
}

export function crossTierConfigFingerprint(
  options: TournamentOptions,
  algorithmVersion: string = BALANCE_ALGORITHM_VERSION,
  engineRulesFingerprint: string = BALANCE_ENGINE_RULES_FINGERPRINT,
) {
  const normalizedOptions = normalizeTournamentOptions(options);
  return String(
    hashSeed(
      stableStringify({
        algorithmVersion,
        engineRulesFingerprint,
        options: normalizedOptions,
        simulationEligibleAugmentIds: SIMULATION_ELIGIBLE_AUGMENT_IDS,
        excludedClockAugmentIds: EXCLUDED_CLOCK_AUGMENT_IDS,
      }),
    ),
  );
}

function mean(values: readonly number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: readonly number[], fraction: number) {
  if (!values.length) throw new Error("Cannot calculate a percentile of an empty sample.");
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function deterministicBootstrapInterval<T>(
  units: readonly T[],
  estimator: (sample: readonly T[]) => number,
  seed: string,
) {
  if (!units.length) return null;
  const estimate = estimator(units);
  if (units.length === 1) {
    return { estimate, low: 0, high: 1, n: 1 } satisfies ConfidenceInterval;
  }
  const random = new SeededRandom(`${BALANCE_ALGORITHM_VERSION}:bootstrap:${seed}`);
  const estimates: number[] = [];
  for (let replicate = 0; replicate < BOOTSTRAP_SAMPLES; replicate += 1) {
    const resample = Array.from({ length: units.length }, () => units[random.int(units.length)]);
    estimates.push(estimator(resample));
  }
  return {
    estimate,
    low: Math.max(0, percentile(estimates, 0.025)),
    high: Math.min(1, percentile(estimates, 0.975)),
    n: units.length,
  } satisfies ConfidenceInterval;
}

export function deterministicMirrorBootstrapInterval(
  values: readonly number[],
  seed = "numeric-mirror-groups",
) {
  return deterministicBootstrapInterval(values, (sample) => mean(sample), seed);
}

function meanByCard(
  samples: readonly CrossTierMirrorSample[],
  field: "higherCard" | "lowerCard",
) {
  const values = new Map<AugmentId, number[]>();
  for (const sample of samples) {
    (values.get(sample[field]) ?? (() => {
      const created: number[] = [];
      values.set(sample[field], created);
      return created;
    })()).push(sample.higherScore);
  }
  return [...values.values()].map((scores) => mean(scores));
}

export function cardEqualComparisonEstimate(samples: readonly CrossTierMirrorSample[]) {
  if (!samples.length) throw new Error("A comparison estimate requires mirror groups.");
  const higherCardMeans = meanByCard(samples, "higherCard");
  const lowerCardMeans = meanByCard(samples, "lowerCard");
  return (mean(higherCardMeans) + mean(lowerCardMeans)) / 2;
}

function ownCardObservations(
  samples: readonly CrossTierMirrorSample[],
  suit: AugmentSuit,
) {
  const observations = new Map<AugmentId, number[]>();
  for (const sample of samples) {
    const higherSuit = getAugmentDefinition(sample.higherCard).suit;
    const lowerSuit = getAugmentDefinition(sample.lowerCard).suit;
    if (higherSuit === suit) {
      (observations.get(sample.higherCard) ?? (() => {
        const created: number[] = [];
        observations.set(sample.higherCard, created);
        return created;
      })()).push(sample.higherScore);
    }
    if (lowerSuit === suit) {
      (observations.get(sample.lowerCard) ?? (() => {
        const created: number[] = [];
        observations.set(sample.lowerCard, created);
        return created;
      })()).push(1 - sample.higherScore);
    }
  }
  return observations;
}

export function cardEqualTierEstimate(
  samples: readonly CrossTierMirrorSample[],
  suit: AugmentSuit,
) {
  const observations = ownCardObservations(samples, suit);
  if (!observations.size) throw new Error(`${suit} has no round-order mirror samples.`);
  return mean([...observations.values()].map((scores) => mean(scores)));
}

function focalSummary(value: FocalAggregate): FocalSummary {
  return {
    ...value,
    triggerRate: value.selectedGames ? value.triggerGames / value.selectedGames : null,
    opportunityRate: value.selectedGames ? value.opportunities / value.selectedGames : null,
  };
}

function averageClock(value: ClockAggregate) {
  return value.samples ? value.totalMs / value.samples : null;
}

function comparisonReport(
  comparison: CrossTierComparison,
  row: CrossTierComparisonAggregate | undefined,
  stratum: CrossTierStratum,
): ComparisonReportRow {
  const samples = row?.mirrorSamples ?? [];
  const interval = deterministicBootstrapInterval(
    samples,
    cardEqualComparisonEstimate,
    `${stratum}:${comparison.key}:card-equal`,
  );
  const byRoundOrder = Object.fromEntries(
    (["higher_first", "lower_first"] as const).map((roundOrder) => {
      const ordered = samples.filter((sample) => sample.roundOrder === roundOrder);
      return [
        roundOrder,
        deterministicBootstrapInterval(
          ordered,
          cardEqualComparisonEstimate,
          `${stratum}:${comparison.key}:${roundOrder}:card-equal`,
        ),
      ];
    }),
  ) as Record<CrossTierRoundOrder, ConfidenceInterval | null>;
  const sampleSufficient =
    samples.length >= 8 &&
    (stratum === "setup" ||
      ((byRoundOrder.higher_first?.n ?? 0) >= 4 &&
        (byRoundOrder.lower_first?.n ?? 0) >= 4));
  return {
    higher: comparison.higher,
    lower: comparison.lower,
    stratum,
    executedGroups: row?.scheduledGroups ?? 0,
    completeMirrorGroups: row?.completeMirrorGroups ?? 0,
    higherScore: interval,
    byRoundOrder,
    sampleSufficient,
    direction:
      !sampleSufficient || interval === null
        ? "insufficient"
        : interval.estimate > 0.5
          ? "higher"
          : interval.estimate < 0.5
            ? "lower"
            : "tie",
    intervalExcludesParity: Boolean(interval && (interval.low > 0.5 || interval.high < 0.5)),
    games: row?.games ?? 0,
    threefoldDraws: row?.threefoldDraws ?? 0,
    unfinished: row?.unfinished ?? 0,
    exceptions: row?.exceptions ?? 0,
    stuck: row?.stuck ?? 0,
    capped: row?.capped ?? 0,
    finishReasons: { ...(row?.finishReasons ?? {}) },
    averageFinalClockMs: {
      higher: row ? averageClock(row.terminalClock.higher) : null,
      lower: row ? averageClock(row.terminalClock.lower) : null,
    },
    focal: {
      higher: focalSummary(row?.focal.higher ?? blankFocalAggregate()),
      lower: focalSummary(row?.focal.lower ?? blankFocalAggregate()),
    },
    draftTiming: structuredClone(row?.draftTiming ?? blankDraftTiming()),
    passExtraMoves: row?.passExtraMoves ?? 0,
    higherPassExtraMoves: row?.higherPassExtraMoves ?? 0,
    lowerPassExtraMoves: row?.lowerPassExtraMoves ?? 0,
  };
}

export function buildCrossTierReport(
  aggregate: CrossTierAggregate,
  options: TournamentOptions,
  plannedGroups: number | null = null,
): CrossTierReport {
  const pureSamples = Object.values(aggregate.comparisons).flatMap((row) => row.mirrorSamples);
  const setupSamples = Object.values(aggregate.setupComparisons).flatMap(
    (row) => row.mirrorSamples,
  );
  const comparisons = buildCrossTierComparisons().map((comparison) =>
    comparisonReport(comparison, aggregate.comparisons[comparison.key], "round_order"),
  );
  const setupComparisons = buildCrossTierComparisons()
    .filter((comparison) => aggregate.setupComparisons[comparison.key])
    .map((comparison) =>
      comparisonReport(comparison, aggregate.setupComparisons[comparison.key], "setup"),
    );
  const tiers = TIER_ORDER.map((suit, expectedRank) => {
    const cardsRepresented = ownCardObservations(pureSamples, suit).size;
    return {
      suit,
      expectedRank: expectedRank + 1,
      cardsRepresented,
      correctionScore: cardsRepresented
        ? deterministicBootstrapInterval(
            pureSamples.filter(
              (sample) =>
                getAugmentDefinition(sample.higherCard).suit === suit ||
                getAugmentDefinition(sample.lowerCard).suit === suit,
            ),
            (sample) => cardEqualTierEstimate(sample, suit),
            `tier:${suit}:card-equal`,
          )
        : null,
    };
  });
  const pointEstimatePass = comparisons.every(
    (comparison) => comparison.higherScore && comparison.higherScore.estimate > 0.5,
  );
  const tierEstimates = tiers.map((tier) => tier.correctionScore?.estimate ?? null);
  const tierPointEstimatePass = tierEstimates.every(
    (estimate, index) =>
      estimate !== null && (index === 0 || (tierEstimates[index - 1] ?? -Infinity) > estimate),
  );
  const nonSetupCards = SIMULATION_ELIGIBLE_AUGMENTS.filter(
    (card) => card.activation !== "setup",
  );
  const setupCards = SIMULATION_ELIGIBLE_AUGMENTS.filter(
    (card) => card.activation === "setup",
  );
  const sampleContainsCard = (sample: CrossTierMirrorSample, id: AugmentId) =>
    sample.higherCard === id || sample.lowerCard === id;
  const executedCards = SIMULATION_ELIGIBLE_AUGMENTS.filter(
    (card) => (aggregate.cardGroups[card.id] ?? 0) > 0,
  )
    .length;
  const roundOrderCompleteCards = SIMULATION_ELIGIBLE_AUGMENTS.filter(
    (card) => (aggregate.cardScores[card.id]?.length ?? 0) > 0,
  ).length;
  const setupCompleteCards = SIMULATION_ELIGIBLE_AUGMENTS.filter(
    (card) => (aggregate.setupCardScores[card.id]?.length ?? 0) > 0,
  ).length;
  const nonSetupBothOrdersCompleteCards = nonSetupCards.filter((card) =>
    (["higher_first", "lower_first"] as const).every((roundOrder) =>
      pureSamples.some(
        (sample) => sample.roundOrder === roundOrder && sampleContainsCard(sample, card.id),
      ),
    ),
  ).length;
  const setupFocalCompleteCards = setupCards.filter((card) =>
    setupSamples.some((sample) => sampleContainsCard(sample, card.id)),
  ).length;
  const missingCards = SIMULATION_ELIGIBLE_AUGMENTS.filter(
    (card) => !(aggregate.cardGroups[card.id] ?? 0),
  ).map((card) => card.id);
  const sampleSufficient = comparisons.every((comparison) => comparison.sampleSufficient);
  const plannedAndComplete =
    plannedGroups !== null &&
    aggregate.groups === plannedGroups &&
    aggregate.completeGroups === plannedGroups &&
    aggregate.games === plannedGroups * 4 &&
    aggregate.finished === aggregate.games;
  const acceptancePass =
    plannedAndComplete &&
    aggregate.unfinished === 0 &&
    aggregate.exceptions === 0 &&
    aggregate.stuck === 0 &&
    aggregate.capped === 0 &&
    aggregate.draftTiming.timingViolations === 0 &&
    aggregate.draftTiming.reachedLegs === aggregate.games &&
    aggregate.draftTiming.revealedLegs === aggregate.games &&
    aggregate.draftTiming.roundTwoFocalSelections === aggregate.games &&
    executedCards === SIMULATION_ELIGIBLE_COUNT &&
    missingCards.length === 0 &&
    nonSetupBothOrdersCompleteCards === nonSetupCards.length &&
    setupFocalCompleteCards === setupCards.length &&
    aggregate.strata.round_order.scheduledGroups ===
      aggregate.strata.round_order.completeMirrorGroups &&
    aggregate.strata.setup.scheduledGroups === aggregate.strata.setup.completeMirrorGroups &&
    comparisons.length === buildCrossTierComparisons().length;
  return {
    purpose: "diagnostic_only",
    schemaVersion: 5,
    algorithmVersion: BALANCE_ALGORITHM_VERSION,
    engineRulesFingerprint: BALANCE_ENGINE_RULES_FINGERPRINT,
    generatedAt: new Date().toISOString(),
    catalogFingerprint: catalogFingerprint(),
    configFingerprint: crossTierConfigFingerprint(options),
    scheduleFingerprint: crossTierScheduleFingerprint(),
    seed: options.seed,
    options: normalizeTournamentOptions(options),
    catalogSize: SIMULATION_CATALOG_SIZE,
    simulationEligibleSize: SIMULATION_ELIGIBLE_COUNT,
    excludedClockAugmentIds: [...EXCLUDED_CLOCK_AUGMENT_IDS],
    intervalMethod: "deterministic mirror-group percentile bootstrap",
    acceptancePass,
    global: {
      plannedGroups,
      executedGroups: aggregate.groups,
      completeMirrorGroups: aggregate.completeGroups,
      games: aggregate.games,
      finished: aggregate.finished,
      threefoldDraws: aggregate.threefoldDraws,
      unfinished: aggregate.unfinished,
      exceptions: aggregate.exceptions,
      stuck: aggregate.stuck,
      capped: aggregate.capped,
      moves: aggregate.moves,
      searchNodes: aggregate.searchNodes,
      passExtraMoves: aggregate.passExtraMoves,
      finishReasons: { ...aggregate.finishReasons },
      pairedSeeds: { ...aggregate.pairedSeeds },
      averageFinalClockMs: {
        higher: averageClock(aggregate.terminalClock.higher),
        lower: averageClock(aggregate.terminalClock.lower),
      },
      focal: {
        higher: focalSummary(aggregate.focal.higher),
        lower: focalSummary(aggregate.focal.lower),
      },
      draftTiming: structuredClone(aggregate.draftTiming),
    },
    strata: {
      round_order: {
        executedGroups: aggregate.strata.round_order.scheduledGroups,
        completeMirrorGroups: aggregate.strata.round_order.completeMirrorGroups,
      },
      setup: {
        executedGroups: aggregate.strata.setup.scheduledGroups,
        completeMirrorGroups: aggregate.strata.setup.completeMirrorGroups,
      },
    },
    comparisons,
    setupComparisons,
    cards: SIMULATION_ELIGIBLE_AUGMENTS.map((definition) => ({
      id: definition.id,
      suit: definition.suit,
      role: "focal" as const,
      executedGroups: aggregate.cardGroups[definition.id] ?? 0,
      roundOrderCompleteMirrorGroups: aggregate.cardScores[definition.id]?.length ?? 0,
      setupCompleteMirrorGroups: aggregate.setupCardScores[definition.id]?.length ?? 0,
      roundOrderScore: deterministicMirrorBootstrapInterval(
        aggregate.cardScores[definition.id] ?? [],
        `card:${definition.id}:round-order`,
      ),
      setupScore: deterministicMirrorBootstrapInterval(
        aggregate.setupCardScores[definition.id] ?? [],
        `card:${definition.id}:setup`,
      ),
      passExtraMoves: aggregate.cardPassExtraMoves[definition.id] ?? 0,
    })),
    tiers,
    ordering: {
      expected: "spades > hearts > clubs > diamonds",
      pointEstimatePass,
      tierPointEstimatePass,
      sampleSufficient,
      intervalsAllAboveParity: comparisons.every(
        (comparison) => comparison.higherScore && comparison.higherScore.low > 0.5,
      ),
    },
    coverage: {
      eligibleCards: SIMULATION_ELIGIBLE_COUNT,
      executedCards,
      roundOrderCompleteCards,
      setupCompleteCards,
      requiredNonSetupCards: nonSetupCards.length,
      nonSetupBothOrdersCompleteCards,
      requiredSetupCards: setupCards.length,
      setupFocalCompleteCards,
      missingCards,
    },
    legs: structuredClone(aggregate.legResults),
    limitations: [
      "Cross-tier estimates are optional diagnostics only; neither ordering nor parity confidence is an acceptance gate or an automatic tuning signal.",
      "Clock augments are excluded from matches and from every coverage denominator; focused product tests retain clock-rule coverage.",
      "Non-setup focal cards are tested in both higher-first and lower-first orders. The engine plays nine legal moves before the formal move-10 draft selects and reveals the second focal card.",
      "Setup-only focal cards are legal only in round one and are reported in a separate setup stratum; they are excluded from pure tier-order estimates.",
      "Tier point estimates weight represented cards equally. Intervals use deterministic mirror-group percentile bootstrap resampling rather than per-game normal approximations.",
      "Latin-style rotating opponents avoid a full Cartesian explosion, so estimates remain schedule-dependent until multiple cycles rotate every matchup.",
      "Finite-depth hidden-information search is a diagnostic and cannot prove global optimality, equilibrium, or human-play balance.",
      "Product-engine threefold repetition is a normal finished 0.5 draw. The maxActions boundary remains an unfinished cap and can never be reclassified as a draw.",
    ],
    errorSamples: [...aggregate.errorSamples],
  };
}

export function validateCrossTierRepresentatives(
  representatives: readonly TierRepresentative[] = selectTierRepresentatives(),
) {
  if (representatives.length !== TIER_ORDER.length) throw new Error("Expected one representative per tier.");
  for (const representative of representatives) {
    for (const id of [representative.focal, representative.neutral]) {
      const definition = getAugmentDefinition(id);
      if (
        definition.suit !== representative.suit ||
        definition.activation !== "active" ||
        definition.effect.kind !== "movement"
      ) {
        throw new Error(`${id} is not an active movement representative for ${representative.suit}.`);
      }
    }
    if (representative.focal === representative.neutral) throw new Error("Focal and neutral must differ.");
  }
  return representatives;
}

export { TIER_ORDER };
