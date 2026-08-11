import assert from "node:assert/strict";
import test from "node:test";

import {
  AUGMENT_CATALOG,
  beginSecondAugmentDraft,
  LEGACY_AUGMENT_CATALOG_VERSION,
  getAugmentDefinition,
  type AugmentId,
} from "../lib/augments.ts";
import {
  LEGACY_AUGMENT_RULES_VERSION,
  PIECE_INFO,
  applyPlayerAction,
  createInitialGame,
  getLegalTargets,
  isValidRepetitionTrackerForState,
  projectGame,
  seedRepetitionTrackerFromCurrentPosition,
  validateSideSetup,
  type GameState,
  type PieceType,
  type Side,
} from "../lib/game.ts";
import {
  buildCrossTierComparisons,
  buildCrossTierCardSchedule,
  buildCrossTierExperimentSchedule,
  buildCrossTierReport,
  cardEqualComparisonEstimate,
  cardEqualTierEstimate,
  createEmptyCrossTierAggregate,
  createDirectCrossTierGame,
  crossTierPairedSeed,
  crossTierLegs,
  crossTierConfigFingerprint,
  crossTierScheduleFingerprint,
  deterministicMirrorBootstrapInterval,
  playCrossTierScheduledLeg,
  playCrossTierScheduledMirrorGroup,
  recordCrossTierScheduledMirrorGroup,
  roundOrdersForPair,
  selectTierRepresentatives,
  type CrossTierLegResult,
  type CrossTierMirrorSample,
} from "../scripts/balance/cross-tier.ts";
import {
  crossTierMarkdown,
  createCrossTierCheckpoint,
  parseCli as parseCrossTierCli,
  validateCrossTierCheckpoint,
} from "../scripts/augment-cross-tier-calibration.ts";
import { parseCli as parseBalanceCli } from "../scripts/augment-balance-simulation.ts";
import {
  actionKey,
  chooseDraftCard,
  chooseVisibleAction,
  commonRootSimulationSeed,
  commonWorldSeed,
  determinizeFromProjection,
  enumerateVisibleActions,
  evaluateVisibleState,
  pairedActionKey,
  pairedSearchStateKey,
  policyDecisionFingerprint,
  policyDecisionSeed,
  projectedRevealKnowledge,
  SeededRandom,
  selectSearchCandidates,
  visibleStateFingerprint,
  type ScoredAction,
  type SearchOptions,
} from "../scripts/balance/visible-policy.ts";

import {
  buildRoundRobinPairings,
  buildProductStabilityPairings,
  BALANCE_ALGORITHM_VERSION,
  BALANCE_ENGINE_RULES_FINGERPRINT,
  buildBalanceReport,
  createEmptyAggregate,
  createCheckpoint,
  createControlledPairGame,
  constrainActiveDraftToSimulationPool,
  meanConfidenceInterval,
  mirrorLegs,
  pendingPassAugmentId,
  playLeg,
  playMirrorGroup,
  recordMirrorGroup,
  remainingGroups,
  scheduleGroup,
  stratifiedPairSample,
  suggestTuning,
  tournamentConfigFingerprint,
  validateCheckpoint,
  wilsonInterval,
  type TournamentOptions,
} from "../scripts/balance/tournament.ts";
import {
  EXCLUDED_CLOCK_AUGMENT_IDS,
  SIMULATION_CATALOG_SIZE,
  SIMULATION_ELIGIBLE_AUGMENT_IDS,
  SIMULATION_ELIGIBLE_AUGMENTS,
  SIMULATION_ELIGIBLE_COUNT,
} from "../scripts/balance/simulation-pool.ts";
import {
  FORMAL_SOAK_MINIMUM_ACTIVE_MS,
  balanceTournamentOptions,
  balanceWorkerStopDecision,
} from "../scripts/soak/balance-worker.ts";
import { SOAK_SCHEMA_VERSION } from "../scripts/soak/common.ts";
import {
  THREEFOLD_TRACE_CARD_PAIR,
  coveragePairs,
  createClocklessSetupPrivacyState,
  runThreefoldTrace,
  verifyActionSettlement,
  verifyProjectedRuleMetadata,
  verifyProjectionPrivacy,
} from "../scripts/soak/rules-worker.ts";
import { hasCappedBalanceGames } from "../scripts/soak/supervisor.ts";

const SEARCH: SearchOptions = { determinizations: 1, branching: 3, rolloutDepth: 1 };
const OPTIONS: TournamentOptions = {
  seed: 424242,
  maxActions: 4,
  thinkTimeMinMs: 0,
  thinkTimeMaxMs: 0,
  search: SEARCH,
  refreshMargin: 4,
};

const REQUIRED_SOAK_STABILITY_GROUPS = buildProductStabilityPairings().length;

function decideBalanceWorkerStop(
  overrides: Partial<Parameters<typeof balanceWorkerStopDecision>[0]> = {},
) {
  return balanceWorkerStopDecision({
    profile: "soak",
    durationSeconds: FORMAL_SOAK_MINIMUM_ACTIVE_MS / 1_000,
    segmentActiveMs: FORMAL_SOAK_MINIMUM_ACTIVE_MS + 1,
    segmentCompletedGroups: REQUIRED_SOAK_STABILITY_GROUPS,
    requiredScheduleGroups: REQUIRED_SOAK_STABILITY_GROUPS,
    stopRequested: false,
    failed: false,
    ...overrides,
  });
}

test("formal balance soak requires four continuous hours and a complete current-segment stability ring", () => {
  assert.equal(SOAK_SCHEMA_VERSION, 2);
  assert.deepEqual(balanceTournamentOptions("soak", 1234), {
    seed: 1234,
    maxActions: 300,
    thinkTimeMinMs: 0,
    thinkTimeMaxMs: 0,
    search: { determinizations: 1, branching: 3, rolloutDepth: 1 },
    refreshMargin: 4,
  });
  assert.ok(REQUIRED_SOAK_STABILITY_GROUPS > 1);
  assert.equal(
    decideBalanceWorkerStop({
      segmentCompletedGroups: REQUIRED_SOAK_STABILITY_GROUPS - 1,
    }),
    "continue",
  );
  assert.equal(decideBalanceWorkerStop(), "complete");
  assert.equal(
    decideBalanceWorkerStop({ segmentActiveMs: FORMAL_SOAK_MINIMUM_ACTIVE_MS - 1 }),
    "continue",
  );
});

test("every product-stability match entry point defaults to 300 actions and zero-time 1x3x1 search", () => {
  const expectedSearch = { determinizations: 1, branching: 3, rolloutDepth: 1 };
  const cliConfigurations = [
    parseBalanceCli([]).tournament,
    parseBalanceCli(["--mode=soak"]).tournament,
    parseCrossTierCli([]).tournament,
    parseCrossTierCli(["--mode=soak"]).tournament,
    balanceTournamentOptions("smoke", 1234),
    balanceTournamentOptions("soak", 1234),
  ];
  for (const configuration of cliConfigurations) {
    assert.equal(configuration.maxActions, 300);
    assert.equal(configuration.thinkTimeMinMs, 0);
    assert.equal(configuration.thinkTimeMaxMs, 0);
    assert.deepEqual(configuration.search, expectedSearch);
  }
  assert.throws(
    () => parseBalanceCli(["--think-min-ms=1"]),
    /always run at 0 ms/,
  );
  assert.throws(
    () => parseCrossTierCli(["--think-max-ms=1"]),
    /always run at 0 ms/,
  );
});

test("one capped balance game fails both smoke and formal product-stability gates", () => {
  assert.equal(hasCappedBalanceGames(undefined), false);
  assert.equal(hasCappedBalanceGames(0), false);
  assert.equal(hasCappedBalanceGames(1), true);
  assert.equal(hasCappedBalanceGames(100), true);
});

test("balance soak stop policy preserves smoke boundaries and immediate stops", () => {
  assert.equal(
    decideBalanceWorkerStop({
      profile: "smoke",
      durationSeconds: 5,
      segmentActiveMs: 5_001,
      segmentCompletedGroups: 1,
    }),
    "complete",
  );
  assert.equal(
    decideBalanceWorkerStop({
      profile: "smoke",
      durationSeconds: 5,
      segmentActiveMs: 4_999,
      segmentCompletedGroups: REQUIRED_SOAK_STABILITY_GROUPS,
    }),
    "continue",
  );
  assert.equal(
    decideBalanceWorkerStop({
      profile: "smoke",
      durationSeconds: 5,
      segmentActiveMs: 5_001,
      segmentCompletedGroups: 0,
    }),
    "continue",
  );
  assert.equal(
    decideBalanceWorkerStop({
      segmentActiveMs: 0,
      segmentCompletedGroups: 0,
      stopRequested: true,
    }),
    "requested",
  );
  assert.equal(
    decideBalanceWorkerStop({
      segmentActiveMs: 0,
      segmentCompletedGroups: 0,
      stopRequested: true,
      failed: true,
    }),
    "failed",
  );
});

test("simulation pool is the exact v3 non-clock partition and rules soak covers all 63 eligible cards", () => {
  assert.equal(SIMULATION_CATALOG_SIZE, 70);
  assert.equal(AUGMENT_CATALOG.length, 70);
  assert.equal(SIMULATION_ELIGIBLE_COUNT, 63);
  assert.deepEqual(EXCLUDED_CLOCK_AUGMENT_IDS, [
    "club-pocket-time",
    "club-steady-tempo",
    "diamond-drill",
    "diamond-pocket-watch",
    "diamond-time-cache",
    "heart-reserve-clock",
    "spade-strategic-reserve",
  ]);
  assert.ok(
    SIMULATION_ELIGIBLE_AUGMENTS.every(
      (definition) => definition.effect.kind !== "clock",
    ),
  );
  const covered = new Set(coveragePairs().flat());
  assert.deepEqual([...covered].sort(), [...SIMULATION_ELIGIBLE_AUGMENT_IDS].sort());
  assert.equal(covered.size, 63);
  assert.ok(EXCLUDED_CLOCK_AUGMENT_IDS.every((id) => !covered.has(id)));
  assert.deepEqual(THREEFOLD_TRACE_CARD_PAIR, ["club-road-patrol", "club-engineer-oath"]);
  const trace = runThreefoldTrace();
  assert.equal(trace.v2FinishReason, "draw");
  assert.equal(trace.v2DrawReason, "threefold_repetition");
  assert.equal(trace.v2Occurrences.at(-1), 3);
  assert.equal(trace.sampledWorldOccurrences, 1);
  assert.equal(trace.secondOccurrenceSampled, 2);
  assert.equal(trace.sampledWorldUsesFreshEvidence, true);
  assert.equal(trace.legacyPhase, "playing");
  assert.equal(trace.classicPhase, "playing");
  assert.equal(trace.cycle.length, 4);
});

test("rules setup/privacy scenarios constrain both private offers to the non-clock pool", () => {
  for (let gameIndex = 0; gameIndex < 100; gameIndex += 1) {
    const state = createClocklessSetupPrivacyState(
      `20260809:rules:${gameIndex}:setup-privacy`,
    );
    const round = state.augment?.draft.rounds[0];
    assert.ok(round);
    for (const side of ["black", "white"] as const) {
      assert.ok(
        round.players[side].options.every((id) =>
          SIMULATION_ELIGIBLE_AUGMENT_IDS.includes(id)
        ),
        `${side} setup/privacy offer ${gameIndex} contains a clock card`,
      );
    }
  }
});

test("rules privacy audit recognizes v3 sacrifice, durable-mine, and public-promotion provenance", () => {
  const placeBySwap = (
    state: GameState,
    selected: GameState["pieces"][number],
    target: { row: number; col: number },
  ) => {
    const occupant = state.pieces.find(
      (piece) =>
        piece.alive &&
        piece.id !== selected.id &&
        piece.row === target.row &&
        piece.col === target.col,
    );
    const origin = { row: selected.row, col: selected.col };
    selected.row = target.row;
    selected.col = target.col;
    if (occupant) {
      occupant.row = origin.row;
      occupant.col = origin.col;
    }
  };

  let sacrifice = createControlledPairGame(
    "club-bitter-ruse",
    "club-road-patrol",
    "black",
    "privacy-public-sacrifice",
  );
  const sacrificedBomb = sacrifice.pieces.find(
    (piece) => piece.side === "black" && piece.type === "bomb",
  );
  assert.ok(sacrificedBomb);
  const sacrificeAction = enumerateVisibleActions(
    projectGame(sacrifice, "black", 1_000_000),
    "black",
  ).find(
    (action) =>
      action.type === "augment_sacrifice" && action.pieceId === sacrificedBomb.id,
  );
  assert.ok(sacrificeAction);
  sacrifice = applyPlayerAction(sacrifice, "black", sacrificeAction, 1_000_000);
  assert.doesNotThrow(() => verifyProjectionPrivacy(sacrifice, 1_000_000));
  assert.ok(
    sacrifice.augment?.ruleState?.publiclyRevealedPieceIds.includes(sacrificedBomb.id),
  );
  const sacrificedForOpponent = projectGame(sacrifice, "white", 1_000_000).pieces.find(
    (piece) => piece.id === sacrificedBomb.id,
  );
  assert.equal(sacrificedForOpponent?.type, "bomb");
  assert.equal(sacrificedForOpponent?.publiclyRevealed, true);
  assert.equal(
    projectGame(sacrifice, "spectator", 1_000_000, { spectatorPolicy: "hidden" })
      .pieces.find((piece) => piece.id === sacrificedBomb.id)?.type,
    "bomb",
  );
  const privateReconId = sacrifice.augment?.permanentReveals.black[0];
  assert.ok(privateReconId);
  assert.notEqual(
    projectGame(sacrifice, "black", 1_000_000).pieces.find(
      (piece) => piece.id === privateReconId,
    )?.type,
    null,
  );
  assert.equal(
    projectGame(sacrifice, "spectator", 1_000_000, { spectatorPolicy: "hidden" })
      .pieces.find((piece) => piece.id === privateReconId)?.type,
    null,
  );

  let durableMine = createControlledPairGame(
    "spade-rail-dominion",
    "spade-volatile-mines",
    "black",
    "privacy-durable-mine",
  );
  const mine = durableMine.pieces.find(
    (piece) =>
      piece.side === "white" &&
      durableMine.augment?.ruleState?.baseTypes[piece.id] === "mine",
  );
  const mineAttacker = durableMine.pieces.find(
    (piece) =>
      piece.side === "black" &&
      durableMine.augment?.ruleState?.baseTypes[piece.id] === "company",
  );
  assert.ok(mine && mineAttacker);
  placeBySwap(durableMine, mineAttacker, { row: 5, col: 0 });
  placeBySwap(durableMine, mine, { row: 5, col: 1 });
  durableMine = applyPlayerAction(durableMine, "black", {
    type: "move",
    from: { row: 5, col: 0 },
    to: { row: 5, col: 1 },
  }, 1_000_000);
  assert.doesNotThrow(() => verifyProjectionPrivacy(durableMine, 1_000_000));
  assert.equal(durableMine.augment?.ruleState?.mineHits[mine.id], 1);
  const revealedMine = projectGame(durableMine, "black", 1_000_000).pieces.find(
    (piece) => piece.id === mine.id,
  );
  assert.equal(revealedMine?.type, "mine");
  assert.equal(revealedMine?.publiclyRevealed, true);
  assert.equal(revealedMine?.mineHits, 1);

  let promotion = createControlledPairGame(
    "heart-battalion-ascent",
    "heart-rail-turn",
    "black",
    "privacy-public-promotion",
  );
  const battalion = promotion.pieces.find(
    (piece) =>
      piece.side === "black" &&
      promotion.augment?.ruleState?.baseTypes[piece.id] === "battalion",
  );
  const company = promotion.pieces.find(
    (piece) =>
      piece.side === "white" &&
      promotion.augment?.ruleState?.baseTypes[piece.id] === "company",
  );
  assert.ok(battalion && company);
  placeBySwap(promotion, battalion, { row: 5, col: 0 });
  placeBySwap(promotion, company, { row: 5, col: 1 });
  promotion = applyPlayerAction(promotion, "black", {
    type: "move",
    from: { row: 5, col: 0 },
    to: { row: 5, col: 1 },
  }, 1_000_000);
  assert.doesNotThrow(() => verifyProjectionPrivacy(promotion, 1_000_000));
  assert.ok(promotion.augment?.ruleState?.promotedPublicIds.includes(battalion.id));
  const promotedForOpponent = projectGame(promotion, "white", 1_000_000).pieces.find(
    (piece) => piece.id === battalion.id,
  );
  assert.equal(promotedForOpponent?.type, "regiment");
  assert.equal(promotedForOpponent?.promoted, true);
});

test("rules privacy audit preserves ordinary hiding, flags, and finished visibility", () => {
  const baseline = createControlledPairGame(
    "spade-rail-dominion",
    "spade-last-headquarters",
    "black",
    "privacy-boundaries",
  );
  const hiddenBomb = baseline.pieces.find(
    (piece) => piece.side === "white" && piece.type === "bomb",
  );
  assert.ok(hiddenBomb);
  assert.equal(
    projectGame(baseline, "black", 1_000_000).pieces.find(
      (piece) => piece.id === hiddenBomb.id,
    )?.type,
    null,
  );
  assert.equal(
    projectGame(baseline, "spectator", 1_000_000, { spectatorPolicy: "hidden" })
      .pieces.find((piece) => piece.id === hiddenBomb.id)?.type,
    null,
  );
  assert.doesNotThrow(() => verifyProjectionPrivacy(baseline, 1_000_000));

  let protectedFlag = structuredClone(baseline);
  const flag = protectedFlag.pieces.find(
    (piece) =>
      piece.side === "white" &&
      protectedFlag.augment?.ruleState?.baseTypes[piece.id] === "flag",
  );
  const attacker = protectedFlag.pieces.find(
    (piece) =>
      piece.side === "black" &&
      protectedFlag.augment?.ruleState?.baseTypes[piece.id] === "company",
  );
  assert.ok(flag && attacker);
  const occupant = protectedFlag.pieces.find(
    (piece) =>
      piece.alive && piece.id !== attacker.id && piece.row === 1 && piece.col === flag.col,
  );
  const attackerOrigin = { row: attacker.row, col: attacker.col };
  attacker.row = 1;
  attacker.col = flag.col;
  if (occupant) {
    occupant.row = attackerOrigin.row;
    occupant.col = attackerOrigin.col;
  }
  protectedFlag = applyPlayerAction(protectedFlag, "black", {
    type: "move",
    from: { row: 1, col: flag.col },
    to: { row: flag.row, col: flag.col },
  }, 1_000_000);
  assert.equal(protectedFlag.events.at(-1)?.result, "flag_protected");
  assert.doesNotThrow(() => verifyProjectionPrivacy(protectedFlag, 1_000_000));
  assert.equal(
    projectGame(protectedFlag, "spectator", 1_000_000, { spectatorPolicy: "hidden" })
      .pieces.find((piece) => piece.id === flag.id)?.type,
    "flag",
  );

  const finished = applyPlayerAction(
    baseline,
    baseline.turn,
    { type: "resign" },
    1_000_000,
  );
  assert.equal(finished.phase, "finished");
  assert.doesNotThrow(() => verifyProjectionPrivacy(finished, 1_000_000));
  assert.ok(
    projectGame(finished, "spectator", 1_000_000, { spectatorPolicy: "hidden" })
      .pieces.every((piece) => piece.type !== null),
  );
});

test("rules privacy metadata assertions reject forged v3 markers and default legacy markers to false", () => {
  const current = createControlledPairGame(
    "club-road-patrol",
    "club-engineer-oath",
    "black",
    "privacy-metadata-contract",
  );
  const projected = projectGame(current, "black", 1_000_000).pieces.find(
    (piece) => piece.side === "white",
  );
  assert.ok(projected);
  assert.doesNotThrow(() => verifyProjectedRuleMetadata(current, projected, "valid"));
  assert.throws(
    () => verifyProjectedRuleMetadata(
      current,
      { ...projected, publiclyRevealed: true },
      "forged-public",
    ),
    /inconsistent public-reveal metadata/,
  );
  assert.throws(
    () => verifyProjectedRuleMetadata(
      current,
      { ...projected, promoted: true },
      "forged-promotion",
    ),
    /inconsistent promotion metadata/,
  );
  assert.throws(
    () => verifyProjectedRuleMetadata(
      current,
      { ...projected, mineHits: 1 },
      "forged-mine-hit",
    ),
    /inconsistent durable-mine hit metadata/,
  );

  const legacy = structuredClone(current);
  legacy.rulesVersion = LEGACY_AUGMENT_RULES_VERSION;
  delete legacy.augment!.ruleState;
  assert.doesNotThrow(() => verifyProjectionPrivacy(legacy, 1_000_000));
  const legacyProjected = projectGame(legacy, "black", 1_000_000).pieces.find(
    (piece) => piece.id === projected.id,
  );
  assert.ok(legacyProjected);
  assert.equal(legacyProjected.publiclyRevealed, undefined);
  assert.equal(legacyProjected.promoted, undefined);
  assert.equal(legacyProjected.mineHits, undefined);

  const classic = createInitialGame();
  classic.phase = "playing";
  classic.joined = { black: true, white: true };
  classic.ready = { black: true, white: true };
  classic.clock = null;
  assert.doesNotThrow(() => verifyProjectionPrivacy(classic, 1_000_000));
  const classicOpponent = projectGame(classic, "black", 1_000_000).pieces.find(
    (piece) => piece.side === "white",
  );
  assert.ok(classicOpponent);
  assert.equal(classicOpponent.publiclyRevealed, undefined);
  assert.equal(classicOpponent.promoted, undefined);
  assert.equal(classicOpponent.mineHits, undefined);
});

test("product-stability ring covers every eligible card without clock cards or Cartesian expansion", () => {
  const pairings = buildProductStabilityPairings();
  const represented = new Set(
    pairings.flatMap((pairing) => [pairing.cardA, pairing.cardB]),
  );
  assert.equal(pairings.length, SIMULATION_ELIGIBLE_COUNT);
  assert.deepEqual(
    [...represented].sort(),
    [...SIMULATION_ELIGIBLE_AUGMENT_IDS].sort(),
  );
  assert.ok(
    pairings.every(
      (pairing) =>
        getAugmentDefinition(pairing.cardA).suit === pairing.suit &&
        getAugmentDefinition(pairing.cardB).suit === pairing.suit,
    ),
  );
  assert.ok(
    EXCLUDED_CLOCK_AUGMENT_IDS.every((id) => !represented.has(id)),
  );
  const appearances = Object.fromEntries(
    SIMULATION_ELIGIBLE_AUGMENT_IDS.map((id) => [
      id,
      pairings.filter((pairing) => pairing.cardA === id || pairing.cardB === id)
        .length,
    ]),
  );
  assert.ok(Object.values(appearances).every((count) => count === 2));
});

test("authoritative and determinized simulations are clockless and round two rejects clock offers", () => {
  const initial = createControlledPairGame(
    "club-road-patrol",
    "club-engineer-oath",
    "black",
    "clockless-authority",
  );
  assert.equal(initial.clock, null);

  const clockedInput = structuredClone(initial);
  clockedInput.clock = {
    initialMs: 600_000,
    remainingMs: { black: 600_000, white: 600_000 },
    turnStartedAt: 1_000_000,
  };
  assert.equal(
    determinizeFromProjection(clockedInput, "black", "clockless-world").clock,
    null,
  );

  const draft = beginSecondAugmentDraft(initial.augment!.draft, {
    suit: "hearts",
    random: () => 0,
  });
  const round = draft.rounds.find((candidate) => candidate.number === 2)!;
  for (const side of ["black", "white"] as const) {
    round.players[side].options = [
      "heart-reserve-clock",
      "heart-rail-turn",
      "heart-initiative",
    ];
    draft.seenBySide[side].push(...round.players[side].options);
  }
  const drafting = structuredClone(initial);
  drafting.phase = "augment_draft";
  drafting.moveNumber = 9;
  drafting.augment!.draft = draft;
  drafting.augment!.resumeTurn = drafting.turn;
  const constrained = constrainActiveDraftToSimulationPool(
    drafting,
    "second-round-no-clock",
  );
  assert.ok(
    constrained.augment!.draft.rounds
      .find((candidate) => candidate.number === 2)!
      .players.black.options.every((id) =>
        SIMULATION_ELIGIBLE_AUGMENT_IDS.includes(id)
      ),
  );
  assert.ok(
    constrained.augment!.draft.rounds
      .find((candidate) => candidate.number === 2)!
      .players.white.options.every((id) =>
        SIMULATION_ELIGIBLE_AUGMENT_IDS.includes(id)
      ),
  );
  assert.ok(
    round.players.black.options.includes("heart-reserve-clock"),
    "the simulation constraint must not mutate its input",
  );
});

test("visible product policy reaches and executes every new active action schema", () => {
  const cases = [
    {
      id: "heart-heavenly-exchange" as const,
      opponent: "heart-rail-turn" as const,
      actionType: "augment_exchange" as const,
    },
    {
      id: "heart-shadow-redeploy" as const,
      opponent: "heart-rail-turn" as const,
      actionType: "augment_redeploy" as const,
    },
    {
      id: "club-surprise-double-move" as const,
      opponent: "club-road-patrol" as const,
      actionType: "augment_begin_multi_move" as const,
    },
    {
      id: "club-bitter-ruse" as const,
      opponent: "club-road-patrol" as const,
      actionType: "augment_sacrifice" as const,
    },
  ];

  for (const scenario of cases) {
    const state = createControlledPairGame(
      scenario.id,
      scenario.opponent,
      "black",
      `active-schema:${scenario.id}`,
    );
    const view = projectGame(state, "black", 1_000_000);
    const actions = enumerateVisibleActions(view, "black");
    const action = actions.find(
      (candidate) =>
        candidate.type === scenario.actionType &&
        "augmentId" in candidate &&
        candidate.augmentId === scenario.id,
    );
    assert.ok(action, `${scenario.id} has no visible ${scenario.actionType} candidate`);
    const decision = chooseVisibleAction(
      state,
      "black",
      `active-decision:${scenario.id}`,
      SEARCH,
    );
    assert.ok(decision.opportunityAugmentIds.includes(scenario.id));
    const next = applyPlayerAction(state, "black", action, 1_000_000);

    if (scenario.id === "club-surprise-double-move") {
      const continuation = enumerateVisibleActions(
        projectGame(next, "black", 1_000_000),
        "black",
      )
        .filter((candidate) => candidate.type === "move")
        .map((candidate) => ({
          candidate,
          after: applyPlayerAction(next, "black", candidate, 1_000_000),
        }))
        .find(
          ({ after }) =>
            pendingPassAugmentId(after, "black") === "club-surprise-double-move",
        );
      assert.ok(continuation, "double-move must expose a legal second-step/pass state");
      const afterFirst = continuation.after;
      assert.equal(
        pendingPassAugmentId(afterFirst, "black"),
        "club-surprise-double-move",
      );
      assert.ok(
        enumerateVisibleActions(
          projectGame(afterFirst, "black", 1_000_000),
          "black",
        ).some((candidate) => candidate.type === "pass_extra_move"),
      );
      const afterPass = applyPlayerAction(
        afterFirst,
        "black",
        { type: "pass_extra_move" },
        1_000_000,
      );
      assert.equal(pendingPassAugmentId(afterPass, "black"), null);
      assert.ok((afterPass.augment?.triggerCounts.black[scenario.id] ?? 0) > 0);
    } else {
      assert.ok((next.augment?.triggerCounts.black[scenario.id] ?? 0) > 0);
    }
  }
});

test("pass attribution supports passive multi-move and legacy extra-turn grants", () => {
  let steady = createControlledPairGame(
    "heart-steady-advance",
    "heart-rail-turn",
    "black",
    "steady-pass-attribution",
  );
  const move = enumerateVisibleActions(
    projectGame(steady, "black", 1_000_000),
    "black",
  ).find((action) => action.type === "move");
  assert.ok(move);
  steady = applyPlayerAction(steady, "black", move, 1_000_000);
  assert.equal(pendingPassAugmentId(steady, "black"), "heart-steady-advance");
  assert.ok(
    enumerateVisibleActions(
      projectGame(steady, "black", 1_000_000),
      "black",
    ).some((action) => action.type === "pass_extra_move"),
  );

  const legacyExtra = createControlledPairGame(
    "spade-relentless-assault",
    "spade-grand-maneuver",
    "black",
    "legacy-pass-attribution",
  );
  legacyExtra.augment!.extraMove.black = {
    augmentId: "spade-relentless-assault",
    excludedPieceId: null,
  };
  assert.equal(
    pendingPassAugmentId(legacyExtra, "black"),
    "spade-relentless-assault",
  );
});

test("rules settlement audit derives durable-mine and division-sapper ownership from the pre-action board", () => {
  const placeBySwap = (
    state: GameState,
    selected: GameState["pieces"][number],
    target: { row: number; col: number },
  ) => {
    const occupant = state.pieces.find(
      (piece) =>
        piece.alive &&
        piece.id !== selected.id &&
        piece.row === target.row &&
        piece.col === target.col,
    );
    const origin = { row: selected.row, col: selected.col };
    selected.row = target.row;
    selected.col = target.col;
    if (occupant) {
      occupant.row = origin.row;
      occupant.col = origin.col;
    }
  };
  const originalType = (state: GameState, piece: GameState["pieces"][number]) =>
    state.augment!.ruleState!.baseTypes[piece.id];
  const selectPiece = (
    state: GameState,
    side: Side,
    type: PieceType,
    index = 0,
  ) => state.pieces.filter(
    (piece) => piece.side === side && originalType(state, piece) === type,
  )[index];
  const triggerCount = (state: GameState, side: Side, id: AugmentId) =>
    state.augment?.triggerCounts[side][id] ?? 0;
  const move = {
    type: "move" as const,
    from: { row: 5, col: 0 },
    to: { row: 5, col: 1 },
  };
  const durableFixture = (attackerType: PieceType, seed: string) => {
    const state = createControlledPairGame(
      "spade-grand-maneuver",
      "spade-volatile-mines",
      "black",
      seed,
    );
    const attacker = selectPiece(state, "black", attackerType);
    const mine = selectPiece(state, "white", "mine");
    assert.ok(attacker && mine);
    placeBySwap(state, attacker, move.from);
    placeBySwap(state, mine, move.to);
    return { state, attacker, mine };
  };

  const firstFixture = durableFixture("company", "durable-first-second-audit");
  const secondAttacker = selectPiece(firstFixture.state, "black", "company", 1);
  assert.ok(secondAttacker);
  placeBySwap(firstFixture.state, secondAttacker, { row: 5, col: 2 });
  const firstHit = applyPlayerAction(firstFixture.state, "black", move, 1_000_000);
  assert.doesNotThrow(() => verifyActionSettlement(firstFixture.state, firstHit, move));
  assert.equal(
    triggerCount(firstHit, "white", "spade-volatile-mines") -
      triggerCount(firstFixture.state, "white", "spade-volatile-mines"),
    1,
  );
  assert.equal(firstHit.augment?.ruleState?.mineHits[firstFixture.mine.id], 1);
  assert.ok(
    firstHit.augment?.ruleState?.publiclyRevealedPieceIds.includes(firstFixture.mine.id),
  );

  const wrongFirstResult = structuredClone(firstHit);
  wrongFirstResult.replay!.moves.at(-1)!.result = "both_removed";
  wrongFirstResult.events.at(-1)!.result = "both_removed";
  assert.throws(
    () => verifyActionSettlement(firstFixture.state, wrongFirstResult, move),
    /first hit lacked exactly one mine_hit event and replay effect/,
  );
  const missingFirstEffect = structuredClone(firstHit);
  missingFirstEffect.events = missingFirstEffect.events.filter(
    (event) => event.result !== "mine_hit",
  );
  missingFirstEffect.replay!.moves.at(-1)!.effects = [];
  assert.throws(
    () => verifyActionSettlement(firstFixture.state, missingFirstEffect, move),
    /first hit lacked exactly one mine_hit event and replay effect/,
  );
  const missingPublicReveal = structuredClone(firstHit);
  missingPublicReveal.augment!.ruleState!.publiclyRevealedPieceIds =
    missingPublicReveal.augment!.ruleState!.publiclyRevealedPieceIds.filter(
      (pieceId) => pieceId !== firstFixture.mine.id,
    );
  assert.throws(
    () => verifyActionSettlement(firstFixture.state, missingPublicReveal, move),
    /did not retain the attacked mine as public knowledge/,
  );
  const missingHitMemory = structuredClone(firstHit);
  delete missingHitMemory.augment!.ruleState!.mineHits[firstFixture.mine.id];
  assert.throws(
    () => verifyActionSettlement(firstFixture.state, missingHitMemory, move),
    /first hit did not preserve the mine with one hit/,
  );

  const beforeSecond = structuredClone(firstHit);
  beforeSecond.turn = "black";
  const secondMove = {
    type: "move" as const,
    from: { row: 5, col: 2 },
    to: { row: 5, col: 1 },
  };
  const secondHit = applyPlayerAction(beforeSecond, "black", secondMove, 1_000_000);
  assert.doesNotThrow(() => verifyActionSettlement(beforeSecond, secondHit, secondMove));
  assert.equal(
    triggerCount(secondHit, "white", "spade-volatile-mines") -
      triggerCount(beforeSecond, "white", "spade-volatile-mines"),
    1,
  );
  assert.equal(secondHit.pieces.find((piece) => piece.id === firstFixture.mine.id)?.alive, false);
  assert.equal(secondHit.augment?.ruleState?.mineHits[firstFixture.mine.id], undefined);
  assert.equal(secondHit.replay?.moves.at(-1)?.result, "both_removed");
  assert.equal(secondHit.replay?.moves.at(-1)?.effects?.length, 0);
  const forgedSecondPulse = structuredClone(secondHit);
  forgedSecondPulse.replay!.moves.at(-1)!.effects = [{
    actor: "black",
    result: "mine_hit",
    augmentId: "spade-volatile-mines",
    pieceIds: [firstFixture.mine.id],
    positions: [{ row: 5, col: 1 }],
  }];
  assert.throws(
    () => verifyActionSettlement(beforeSecond, forgedSecondPulse, secondMove),
    /second hit emitted the wrong result or an extra mine_hit pulse/,
  );

  const engineerFixture = durableFixture("engineer", "durable-engineer-audit");
  const engineerHit = applyPlayerAction(engineerFixture.state, "black", move, 1_000_000);
  assert.doesNotThrow(() => verifyActionSettlement(engineerFixture.state, engineerHit, move));
  assert.equal(
    triggerCount(engineerHit, "white", "spade-volatile-mines") -
      triggerCount(engineerFixture.state, "white", "spade-volatile-mines"),
    1,
  );
  assert.equal(
    engineerHit.pieces.find((piece) => piece.id === engineerFixture.attacker.id)?.alive,
    false,
  );

  const bombFixture = durableFixture("bomb", "durable-bomb-bypass-audit");
  const bombed = applyPlayerAction(bombFixture.state, "black", move, 1_000_000);
  assert.doesNotThrow(() => verifyActionSettlement(bombFixture.state, bombed, move));
  assert.equal(
    triggerCount(bombed, "white", "spade-volatile-mines") -
      triggerCount(bombFixture.state, "white", "spade-volatile-mines"),
    0,
  );

  const reverse = createControlledPairGame(
    "spade-volatile-mines",
    "spade-grand-maneuver",
    "black",
    "durable-reverse-owner-audit",
  );
  const reverseAttacker = selectPiece(reverse, "black", "company");
  const ordinaryEnemyMine = selectPiece(reverse, "white", "mine");
  assert.ok(reverseAttacker && ordinaryEnemyMine);
  placeBySwap(reverse, reverseAttacker, move.from);
  placeBySwap(reverse, ordinaryEnemyMine, move.to);
  const reverseResult = applyPlayerAction(reverse, "black", move, 1_000_000);
  assert.doesNotThrow(() => verifyActionSettlement(reverse, reverseResult, move));
  assert.equal(
    triggerCount(reverseResult, "black", "spade-volatile-mines") -
      triggerCount(reverse, "black", "spade-volatile-mines"),
    0,
  );

  const sapper = createControlledPairGame(
    "club-division-sapper",
    "club-forced-march",
    "black",
    "division-sapper-priority-audit",
  );
  sapper.augment!.draft.loadouts.white.push("spade-volatile-mines");
  const division = selectPiece(sapper, "black", "division");
  const sapperMine = selectPiece(sapper, "white", "mine");
  assert.ok(division && sapperMine);
  placeBySwap(sapper, division, move.from);
  placeBySwap(sapper, sapperMine, move.to);
  const defused = applyPlayerAction(sapper, "black", move, 1_000_000);
  assert.doesNotThrow(() => verifyActionSettlement(sapper, defused, move));
  assert.equal(
    triggerCount(defused, "white", "spade-volatile-mines") -
      triggerCount(sapper, "white", "spade-volatile-mines"),
    0,
  );
  assert.equal(
    triggerCount(defused, "black", "club-division-sapper") -
      triggerCount(sapper, "black", "club-division-sapper"),
    1,
  );

  const chain = createControlledPairGame(
    "spade-cherry-bomb",
    "spade-volatile-mines",
    "black",
    "durable-chain-bypass-audit",
  );
  const chainBomb = selectPiece(chain, "black", "bomb");
  const chainVictim = selectPiece(chain, "white", "company");
  const chainMine = selectPiece(chain, "white", "mine");
  assert.ok(chainBomb && chainVictim && chainMine);
  placeBySwap(chain, chainBomb, move.from);
  placeBySwap(chain, chainVictim, move.to);
  placeBySwap(chain, chainMine, { row: 5, col: 2 });
  const chained = applyPlayerAction(chain, "black", move, 1_000_000);
  assert.doesNotThrow(() => verifyActionSettlement(chain, chained, move));
  assert.equal(
    triggerCount(chained, "white", "spade-volatile-mines") -
      triggerCount(chain, "white", "spade-volatile-mines"),
    0,
  );
  assert.equal(chained.pieces.find((piece) => piece.id === chainMine.id)?.alive, false);

  const sacrifice = createControlledPairGame(
    "club-road-patrol",
    "club-bitter-ruse",
    "white",
    "durable-sacrifice-bypass-audit",
  );
  sacrifice.augment!.draft.loadouts.white.push("spade-volatile-mines");
  const sacrificedMine = selectPiece(sacrifice, "white", "mine");
  assert.ok(sacrificedMine);
  const sacrificeAction = {
    type: "augment_sacrifice" as const,
    augmentId: "club-bitter-ruse" as const,
    pieceId: sacrificedMine.id,
  };
  const sacrificed = applyPlayerAction(sacrifice, "white", sacrificeAction, 1_000_000);
  assert.doesNotThrow(() => verifyActionSettlement(sacrifice, sacrificed, sacrificeAction));
  assert.equal(
    triggerCount(sacrificed, "white", "spade-volatile-mines") -
      triggerCount(sacrifice, "white", "spade-volatile-mines"),
    0,
  );
});

test("rules settlement audit separates steady passive pulses from charged events", () => {
  const before = createControlledPairGame(
    "heart-steady-advance",
    "heart-rail-turn",
    "black",
    "steady-settlement-audit",
  );
  const firstAction = enumerateVisibleActions(
    projectGame(before, "black", 1_000_000),
    "black",
  ).find((action) => action.type === "move");
  assert.ok(firstAction);
  const afterFirst = applyPlayerAction(before, "black", firstAction, 1_000_000);
  assert.doesNotThrow(() => verifyActionSettlement(before, afterFirst, firstAction));
  assert.deepEqual(afterFirst.replay?.moves.at(-1)?.augmentIds, ["heart-steady-advance"]);
  assert.deepEqual(afterFirst.events.at(-1)?.augmentIds, ["heart-steady-advance"]);
  assert.equal(
    afterFirst.events.some(
      (event) =>
        event.result === "augment_used" && event.augmentId === "heart-steady-advance",
    ),
    false,
  );

  const missingCount = structuredClone(afterFirst);
  missingCount.augment!.triggerCounts.black["heart-steady-advance"] = 0;
  assert.throws(
    () => verifyActionSettlement(before, missingCount, firstAction),
    /passive trigger delta 0 did not match semantic evidence 1/,
  );
  for (const forgedCount of [2, 3]) {
    const forged = structuredClone(afterFirst);
    forged.augment!.triggerCounts.black["heart-steady-advance"] = forgedCount;
    assert.throws(
      () => verifyActionSettlement(before, forged, firstAction),
      /passive trigger delta .* did not match semantic evidence 1/,
    );
  }

  const missingContinuation = structuredClone(afterFirst);
  missingContinuation.augment!.ruleState!.multiMove.black = null;
  assert.throws(
    () => verifyActionSettlement(before, missingContinuation, firstAction),
    /passive trigger delta 1 did not match semantic evidence 0/,
  );

  const missingAttribution = structuredClone(afterFirst);
  delete missingAttribution.replay!.moves.at(-1)!.augmentId;
  delete missingAttribution.replay!.moves.at(-1)!.augmentIds;
  delete missingAttribution.events.at(-1)!.augmentId;
  delete missingAttribution.events.at(-1)!.augmentIds;
  assert.throws(
    () => verifyActionSettlement(before, missingAttribution, firstAction),
    /opened without movement event\/replay attribution/,
  );

  const secondAction = enumerateVisibleActions(
    projectGame(afterFirst, "black", 1_000_000),
    "black",
  ).find((action) => action.type === "move");
  assert.ok(secondAction);
  const afterSecond = applyPlayerAction(afterFirst, "black", secondAction, 1_000_000);
  assert.doesNotThrow(() => verifyActionSettlement(afterFirst, afterSecond, secondAction));

  const afterPass = applyPlayerAction(
    afterFirst,
    "black",
    { type: "pass_extra_move" },
    1_000_000,
  );
  assert.doesNotThrow(() =>
    verifyActionSettlement(afterFirst, afterPass, { type: "pass_extra_move" })
  );
  const missingPass = structuredClone(afterPass);
  missingPass.events = missingPass.events.filter(
    (event) => event.result !== "extra_move_passed",
  );
  assert.throws(
    () => verifyActionSettlement(afterFirst, missingPass, { type: "pass_extra_move" }),
    /continuation pass lacked one authoritative settlement/,
  );
});

test("rules settlement audit permits begin-multi without replay and audits its continuation", () => {
  const before = createControlledPairGame(
    "club-surprise-double-move",
    "club-road-patrol",
    "black",
    "active-multi-settlement-audit",
  );
  const begin = enumerateVisibleActions(
    projectGame(before, "black", 1_000_000),
    "black",
  ).find((action) => action.type === "augment_begin_multi_move");
  assert.ok(begin);
  const begun = applyPlayerAction(before, "black", begin, 1_000_000);
  assert.equal(begun.replay?.moves.length, before.replay?.moves.length);
  assert.doesNotThrow(() => verifyActionSettlement(before, begun, begin));

  const missingEvent = structuredClone(begun);
  missingEvent.events = missingEvent.events.filter(
    (event) => event.result !== "augment_used",
  );
  assert.throws(
    () => verifyActionSettlement(before, missingEvent, begin),
    /Charged trigger deltas and augment_used events diverged/,
  );
  const duplicateEvent = structuredClone(begun);
  const used = duplicateEvent.events.find((event) => event.result === "augment_used")!;
  duplicateEvent.events.push({ ...used, id: duplicateEvent.events.at(-1)!.id + 1 });
  assert.throws(
    () => verifyActionSettlement(before, duplicateEvent, begin),
    /Charged trigger deltas and augment_used events diverged/,
  );

  const move = enumerateVisibleActions(
    projectGame(begun, "black", 1_000_000),
    "black",
  ).find((action) => action.type === "move");
  assert.ok(move);
  const afterMove = applyPlayerAction(begun, "black", move, 1_000_000);
  assert.doesNotThrow(() => verifyActionSettlement(begun, afterMove, move));
});

test("rules settlement audit permits dual fuse attribution twice and rejects a third copy", () => {
  const before = createControlledPairGame(
    "club-bombardier",
    "club-bombardier",
    "black",
    "dual-fuse-settlement-audit",
  );
  const blackBomb = before.pieces.find(
    (piece) =>
      piece.side === "black" && before.augment!.ruleState!.baseTypes[piece.id] === "bomb",
  )!;
  const whiteBomb = before.pieces.find(
    (piece) =>
      piece.side === "white" && before.augment!.ruleState!.baseTypes[piece.id] === "bomb",
  )!;
  const place = (piece: typeof blackBomb, row: number, col: number) => {
    const occupant = before.pieces.find(
      (candidate) => candidate.alive && candidate.row === row && candidate.col === col,
    );
    if (occupant && occupant.id !== piece.id) {
      [piece.row, occupant.row] = [occupant.row, piece.row];
      [piece.col, occupant.col] = [occupant.col, piece.col];
    } else {
      piece.row = row;
      piece.col = col;
    }
  };
  place(blackBomb, 5, 0);
  place(whiteBomb, 5, 1);
  const action = {
    type: "move" as const,
    from: { row: 5, col: 0 },
    to: { row: 5, col: 1 },
  };
  const after = applyPlayerAction(before, "black", action, 1_000_000);
  assert.deepEqual(after.replay?.moves.at(-1)?.augmentIds, [
    "club-bombardier",
    "club-bombardier",
  ]);
  assert.doesNotThrow(() => verifyActionSettlement(before, after, action));

  const thirdCopy = structuredClone(after);
  thirdCopy.replay!.moves.at(-1)!.augmentIds!.push("club-bombardier");
  thirdCopy.events.at(-1)!.augmentIds!.push("club-bombardier");
  assert.throws(
    () => verifyActionSettlement(before, thirdCopy, action),
    /unsupported or duplicate augment attribution/,
  );
});

test("rules settlement audit accepts a two-step cherry and sacrifice-aura cascade", () => {
  let before = createControlledPairGame(
    "spade-cherry-bomb",
    "spade-grand-maneuver",
    "white",
    "passive-delta-two-audit",
  );
  let secondDraft: ReturnType<typeof beginSecondAugmentDraft> | undefined;
  for (let attempt = 0; attempt < 2_000 && !secondDraft; attempt += 1) {
    const random = new SeededRandom(`passive-delta-two-draft:${attempt}`);
    const candidate = beginSecondAugmentDraft(before.augment!.draft, {
      suit: "hearts",
      random: () => random.next(),
    });
    const round = candidate.rounds.find((entry) => entry.number === 2)!;
    if (
      round.players.black.options.includes("heart-sacrifice-aura") &&
      round.players.white.options.includes("heart-rail-turn")
    ) {
      secondDraft = candidate;
    }
  }
  assert.ok(secondDraft, "failed to find deterministic heart offers for the cascade fixture");
  before.augment!.draft = secondDraft;
  before.augment!.resumeTurn = "white";
  before.augment!.draftDeadlineAt = 1_030_000;
  before.phase = "augment_draft";
  before = applyPlayerAction(
    before,
    "black",
    { type: "augment_select", augmentId: "heart-sacrifice-aura" },
    1_000_000,
  );
  before = applyPlayerAction(before, "black", { type: "augment_lock" }, 1_000_000);
  before = applyPlayerAction(
    before,
    "white",
    { type: "augment_select", augmentId: "heart-rail-turn" },
    1_000_000,
  );
  before = applyPlayerAction(before, "white", { type: "augment_lock" }, 1_000_000);
  assert.equal(before.phase, "playing");

  const originalType = (piece: GameState["pieces"][number]) =>
    before.augment!.ruleState!.baseTypes[piece.id];
  const blackBombs = before.pieces.filter(
    (piece) => piece.side === "black" && originalType(piece) === "bomb",
  );
  const blackVictims = before.pieces.filter(
    (piece) =>
      piece.side === "black" &&
      originalType(piece) !== "bomb" &&
      originalType(piece) !== "flag",
  ).slice(0, 6);
  const whiteActors = before.pieces.filter(
    (piece) =>
      piece.side === "white" &&
      originalType(piece) !== "bomb" &&
      originalType(piece) !== "mine" &&
      originalType(piece) !== "flag",
  ).slice(0, 4);
  assert.equal(blackBombs.length, 2);
  assert.equal(blackVictims.length, 6);
  assert.equal(whiteActors.length, 4);
  const assignments: Array<[
    GameState["pieces"][number],
    { row: number; col: number },
  ]> = [
    [blackBombs[0], { row: 5, col: 2 }],
    [blackBombs[1], { row: 4, col: 1 }],
    ...blackVictims.map((piece, index) => [
      piece,
      [
        { row: 3, col: 0 },
        { row: 3, col: 1 },
        { row: 3, col: 2 },
        { row: 4, col: 0 },
        { row: 4, col: 3 },
        { row: 5, col: 0 },
      ][index],
    ] as [GameState["pieces"][number], { row: number; col: number }]),
    [whiteActors[0], { row: 4, col: 2 }],
    [whiteActors[1], { row: 5, col: 1 }],
    [whiteActors[2], { row: 5, col: 3 }],
    [whiteActors[3], { row: 6, col: 2 }],
  ];
  for (const [piece, target] of assignments) {
    const occupant = before.pieces.find(
      (candidate) =>
        candidate.alive && candidate.row === target.row && candidate.col === target.col,
    );
    if (occupant && occupant.id !== piece.id) {
      [piece.row, occupant.row] = [occupant.row, piece.row];
      [piece.col, occupant.col] = [occupant.col, piece.col];
    } else {
      piece.row = target.row;
      piece.col = target.col;
    }
  }
  for (const [piece, target] of assignments) {
    assert.deepEqual({ row: piece.row, col: piece.col }, target);
  }
  before.turn = "white";
  const action = {
    type: "move" as const,
    from: { row: 4, col: 2 },
    to: { row: 5, col: 2 },
  };
  const after = applyPlayerAction(before, "white", action, 1_000_000);
  assert.equal(after.augment?.triggerCounts.black["spade-cherry-bomb"], 2);
  assert.equal(after.augment?.triggerCounts.black["heart-sacrifice-aura"], 2);
  assert.doesNotThrow(() => verifyActionSettlement(before, after, action));

  for (const [id, count] of [
    ["spade-cherry-bomb", 3],
    ["heart-sacrifice-aura", 4],
  ] as const) {
    const forged = structuredClone(after);
    forged.augment!.triggerCounts.black[id] = count;
    assert.throws(
      () => verifyActionSettlement(before, forged, action),
      /passive trigger delta .* did not match semantic evidence 2/,
    );
  }
});

test("search pruning deduplicates move geometry and prefers the charge-free normal move", () => {
  const ranked: ScoredAction[] = [
    {
      action: {
        type: "augment_move",
        augmentId: "club-forced-march",
        from: { row: 6, col: 2 },
        to: { row: 5, col: 2 },
      },
      score: 100,
    },
    {
      action: {
        type: "augment_move",
        augmentId: "club-line-hop",
        from: { row: 6, col: 1 },
        to: { row: 4, col: 1 },
      },
      score: 90,
    },
    {
      action: {
        type: "move",
        from: { row: 6, col: 2 },
        to: { row: 5, col: 2 },
      },
      score: 10,
    },
  ];
  const candidates = selectSearchCandidates(ranked, 3);
  assert.equal(candidates.length, 2);
  const freeMove = candidates.find(({ action }) => action.type === "move");
  assert.ok(freeMove);
  assert.equal(freeMove.score, 10);
  assert.equal(
    candidates.some(
      ({ action }) =>
        action.type === "augment_move" &&
        action.from.row === 6 &&
        action.from.col === 2 &&
        action.to.row === 5 &&
        action.to.col === 2,
    ),
    false,
  );
  assert.equal(
    new Set(candidates.map(({ action }) => pairedActionKey(action))).size,
    candidates.length,
  );
});

test("search pruning keeps same-geometry actions from distinct augments when no normal move exists", () => {
  const ranked: ScoredAction[] = [
    {
      action: {
        type: "augment_move",
        augmentId: "spade-rail-dominion",
        from: { row: 6, col: 0 },
        to: { row: 5, col: 0 },
      },
      score: 12,
    },
    {
      action: {
        type: "augment_move",
        augmentId: "heart-mobile-rail",
        from: { row: 6, col: 0 },
        to: { row: 5, col: 0 },
      },
      score: 11,
    },
  ];
  assert.deepEqual(selectSearchCandidates(ranked, 2), ranked);
});

test("active-aware search still reserves the highest-ranked normal move", () => {
  const ranked: ScoredAction[] = [
    ...Array.from({ length: 8 }, (_, index) => ({
      action: {
        type: "augment_recon" as const,
        augmentId: "club-local-recon" as const,
        target: { row: index, col: 4 },
      },
      score: 100 - index,
    })),
    ...Array.from({ length: 6 }, (_, index) => ({
      action: {
        type: "move" as const,
        from: { row: index, col: 0 },
        to: { row: index, col: 1 },
      },
      score: 50 - index,
    })),
  ];
  const candidates = selectSearchCandidates(ranked, 8);
  const normalMoves = candidates.filter(({ action }) => action.type === "move");
  assert.equal(candidates.length, 8);
  assert.equal(normalMoves.length, 1);
  assert.deepEqual(normalMoves, ranked.slice(8, 9));
});

test("search pruning always reserves one optional extra-move pass candidate", () => {
  const ranked: ScoredAction[] = [
    ...Array.from({ length: 10 }, (_, index) => ({
      action: {
        type: "move" as const,
        from: { row: index, col: 0 },
        to: { row: index, col: 1 },
      },
      score: 100 - index,
    })),
    { action: { type: "pass_extra_move" as const }, score: -1_000 },
  ];
  const candidates = selectSearchCandidates(ranked, 8);
  assert.equal(candidates.length, 8);
  assert.ok(candidates.some(({ action }) => action.type === "pass_extra_move"));
});

test("search pruning leaves global top-k unchanged when no normal moves exist", () => {
  const ranked: ScoredAction[] = Array.from({ length: 6 }, (_, index) => ({
    action: {
      type: "augment_recon" as const,
      augmentId: "club-local-recon" as const,
      target: { row: index, col: 4 },
    },
    score: 100 - index,
  }));
  assert.deepEqual(selectSearchCandidates(ranked, 3), ranked.slice(0, 3));
});

test("single-branch rollout keeps its historical top-1 action", () => {
  const ranked: ScoredAction[] = [
    {
      action: {
        type: "augment_move",
        augmentId: "club-forced-march",
        from: { row: 6, col: 2 },
        to: { row: 5, col: 2 },
      },
      score: 100,
    },
    {
      action: {
        type: "move",
        from: { row: 6, col: 2 },
        to: { row: 5, col: 2 },
      },
      score: 10,
    },
  ];
  assert.deepEqual(selectSearchCandidates(ranked, 1), [ranked[0]]);
});

function hiddenPermutation(state: GameState, viewer: Side) {
  const clone = structuredClone(state);
  const opponent = viewer === "black" ? "white" : "black";
  const candidates = clone.pieces.filter(
    (piece) =>
      piece.side === opponent &&
      piece.alive &&
      piece.type !== "flag" &&
      piece.type !== "mine",
  );
  const first = candidates.find((piece) => piece.type === "commander") ?? candidates[0];
  const second = candidates.find((piece) => piece.type === "engineer") ?? candidates[1];
  assert.ok(first && second && first.id !== second.id);
  [first.type, second.type] = [second.type, first.type] as [PieceType, PieceType];
  return clone;
}

test("visible policy is invariant when unobserved enemy identities are permuted", () => {
  const state = createControlledPairGame(
    "club-forced-march",
    "club-line-hop",
    "black",
    "information-isolation",
  );
  const permuted = hiddenPermutation(state, "black");
  const first = policyDecisionFingerprint(state, "black", "same-policy-seed", SEARCH);
  const second = policyDecisionFingerprint(permuted, "black", "same-policy-seed", SEARCH);
  assert.equal(first, second);

  const firstWorld = determinizeFromProjection(state, "black", "same-world-seed");
  const secondWorld = determinizeFromProjection(permuted, "black", "same-world-seed");
  assert.deepEqual(firstWorld.pieces, secondWorld.pieces);
});

test("hidden worlds obey public setup permissions and exact inventory for both colors", () => {
  const scenarios = [
    createControlledPairGame(
      "club-forced-march",
      "club-line-hop",
      "black",
      "legal-world-standard",
    ),
    createControlledPairGame(
      "diamond-forward-bomb",
      "diamond-forward-pair",
      "black",
      "legal-world-forward",
    ),
    createControlledPairGame(
      "diamond-deep-mine",
      "diamond-deep-pair",
      "black",
      "legal-world-deep",
    ),
  ];
  for (const [scenarioIndex, state] of scenarios.entries()) {
    assert.equal(state.moveNumber, 0);
    for (const viewer of ["black", "white"] as const) {
      const hiddenSide = viewer === "black" ? "white" : "black";
      for (let seed = 0; seed < 64; seed += 1) {
        const determined = determinizeFromProjection(
          state,
          viewer,
          `legal-setup:${scenarioIndex}:${viewer}:${seed}`,
        );
        assert.equal(
          validateSideSetup(
            determined.pieces,
            hiddenSide,
            determined.augment?.draft.loadouts[hiddenSide] ?? [],
          ),
          true,
        );
        for (const [type, info] of Object.entries(PIECE_INFO) as Array<
          [PieceType, (typeof PIECE_INFO)[PieceType]]
        >) {
          assert.equal(
            determined.pieces.filter((piece) => piece.side === hiddenSide && piece.type === type)
              .length,
            info.count,
          );
        }
      }
    }
  }
});

test("public action-piece IDs prevent exchanged or attacking pieces from becoming mines or flags", () => {
  let state = createControlledPairGame(
    "heart-rail-turn",
    "heart-remote-exchange",
    "white",
    "public-moved-exchange",
  );
  const exchange = enumerateVisibleActions(projectGame(state, "white", 1_000_000), "white")
    .find(
      (action) =>
        action.type === "augment_exchange" &&
        (action.from.row <= 1 || action.to.row <= 1),
    );
  assert.ok(exchange && exchange.type === "augment_exchange");
  const movedIds = [
    state.pieces.find((piece) => piece.alive && piece.row === exchange.from.row && piece.col === exchange.from.col)?.id,
    state.pieces.find((piece) => piece.alive && piece.row === exchange.to.row && piece.col === exchange.to.col)?.id,
  ];
  assert.ok(movedIds.every((id): id is string => Boolean(id)));
  state = applyPlayerAction(state, "white", exchange, 1_000_050);
  const projected = projectGame(state, "black", 1_000_050);
  assert.ok(movedIds.every((id) => projected.movedPieceIds.includes(id)));

  for (let seed = 0; seed < 128; seed += 1) {
    const determined = determinizeFromProjection(
      state,
      "black",
      `public-moved-exchange:${seed}`,
      1_000_050,
    );
    for (const id of movedIds) {
      const type = determined.pieces.find((piece) => piece.id === id)?.type;
      assert.notEqual(type, "mine");
      assert.notEqual(type, "flag");
    }
  }
});

test("unmoved front-row bombs still need setup allowance while a publicly moved bomb remains legal", () => {
  const unmoved = createControlledPairGame(
    "club-forced-march",
    "club-line-hop",
    "black",
    "unmoved-front-bomb",
  );
  unmoved.moveNumber = 4;
  for (let seed = 0; seed < 64; seed += 1) {
    const determined = determinizeFromProjection(unmoved, "black", `unmoved-front:${seed}`);
    assert.equal(
      determined.pieces.some(
        (piece) => piece.side === "white" && piece.row === 5 && piece.type === "bomb",
      ),
      false,
    );
  }

  const moved = structuredClone(unmoved);
  const bomb = moved.pieces.find((piece) => piece.side === "white" && piece.type === "bomb");
  const front = moved.pieces.find(
    (piece) =>
      piece.side === "white" &&
      piece.row === 5 &&
      piece.type !== "flag" &&
      piece.type !== "mine" &&
      piece.type !== "bomb",
  );
  assert.ok(bomb && front);
  [bomb.row, front.row] = [front.row, bomb.row];
  [bomb.col, front.col] = [front.col, bomb.col];
  moved.movedPieceIds = [bomb.id];
  let sampledMovedBomb = false;
  for (let seed = 0; seed < 512 && !sampledMovedBomb; seed += 1) {
    const determined = determinizeFromProjection(moved, "black", `moved-front:${seed}`);
    sampledMovedBomb = determined.pieces.find((piece) => piece.id === bomb.id)?.type === "bomb";
  }
  assert.equal(sampledMovedBomb, true);
});

test("ongoing hidden worlds keep the flag alive and preserve every visible identity", () => {
  for (const viewer of ["black", "white"] as const) {
    const hiddenSide = viewer === "black" ? "white" : "black";
    const state = createControlledPairGame(
      "club-forced-march",
      "club-line-hop",
      viewer,
      `dead-hidden:${viewer}`,
    );
    const visibleCommander = state.pieces.find(
      (piece) => piece.side === hiddenSide && piece.type === "commander",
    );
    assert.ok(visibleCommander);
    state.augment!.permanentReveals[viewer] = [visibleCommander.id];
    for (const piece of state.pieces
      .filter((candidate) => candidate.side === hiddenSide && candidate.type !== "flag")
      .slice(0, 8)) {
      piece.alive = false;
    }
    for (let seed = 0; seed < 64; seed += 1) {
      const determined = determinizeFromProjection(
        state,
        viewer,
        `dead-hidden:${viewer}:${seed}`,
      );
      const flag = determined.pieces.find(
        (piece) => piece.side === hiddenSide && piece.type === "flag",
      );
      assert.ok(flag);
      assert.equal(flag.alive, true);
      assert.equal(flag.row, hiddenSide === "black" ? 11 : 0);
      assert.ok(flag.col === 1 || flag.col === 3);
      assert.equal(
        determined.pieces.find((piece) => piece.id === visibleCommander.id)?.type,
        "commander",
      );
    }
  }
});

test("determinization rejects an ongoing projection with no legal living flag host", () => {
  const state = createControlledPairGame(
    "club-forced-march",
    "club-line-hop",
    "black",
    "missing-flag-host",
  );
  for (const piece of state.pieces) {
    if (piece.side === "white" && piece.row === 0 && (piece.col === 1 || piece.col === 3)) {
      piece.alive = false;
    }
  }
  assert.throws(
    () => determinizeFromProjection(state, "black", "missing-flag-host"),
    /No rules-legal hidden identity assignment/,
  );
});

test("visible policy ignores opponent-only reconnaissance and extra-move knowledge", () => {
  const state = createControlledPairGame(
    "club-forced-march",
    "club-line-hop",
    "black",
    "private-knowledge-isolation",
  );
  const altered = structuredClone(state);
  const blackTargets = altered.pieces
    .filter((piece) => piece.alive && piece.side === "black")
    .slice(0, 3)
    .map((piece) => piece.id);
  const whiteMover = altered.pieces.find(
    (piece) => piece.alive && piece.side === "white" && piece.type !== "flag" && piece.type !== "mine",
  );
  assert.ok(whiteMover);
  altered.augment!.permanentReveals.white = blackTargets.slice(0, 2);
  altered.augment!.temporaryReveals.white = blackTargets.slice(2);
  altered.augment!.extraMove.white = {
    augmentId: "heart-initiative",
    excludedPieceId: whiteMover.id,
  };
  assert.equal(
    policyDecisionFingerprint(state, "black", "private-knowledge-seed", SEARCH),
    policyDecisionFingerprint(altered, "black", "private-knowledge-seed", SEARCH),
  );
});

test("determinization never copies the authoritative repetition salt or digest history", () => {
  const state = createControlledPairGame(
    "club-forced-march",
    "club-line-hop",
    "black",
    "private-repetition-isolation",
  );
  assert.ok(state.repetitionTracker);
  state.repetitionTracker = {
    salt: "PRIVATE-SALT-MUST-NOT-CROSS",
    counts: { ["f".repeat(64)]: 2 },
    lastCountedDigest: "f".repeat(64),
    currentOccurrences: 2,
  };
  const determined = determinizeFromProjection(
    state,
    "black",
    "public-occurrence-only-world",
  );
  const serialized = JSON.stringify(determined);
  assert.doesNotMatch(serialized, /PRIVATE-SALT-MUST-NOT-CROSS/);
  assert.doesNotMatch(serialized, new RegExp("f{64}"));
  assert.ok(determined.repetitionTracker);
  assert.notEqual(determined.repetitionTracker.salt, state.repetitionTracker.salt);
  assert.deepEqual(determined.repetitionTracker.counts, {});
  assert.equal(determined.repetitionTracker.lastCountedDigest, null);
  assert.equal(determined.repetitionTracker.currentOccurrences, 0);
  assert.equal(isValidRepetitionTrackerForState(determined), true);
  assert.deepEqual(
    determinizeFromProjection(state, "black", "public-occurrence-only-world")
      .repetitionTracker,
    determined.repetitionTracker,
  );
});

test("determinization preserves temporary reveal expiry and supports legacy projections", () => {
  const state = createControlledPairGame(
    "club-frontline-scout",
    "club-line-hop",
    "white",
    "temporary-reveal-fidelity",
  );
  state.turn = "white";
  if (state.clock) state.clock.turnStartedAt = 1_000_000;
  const mover = state.pieces.find(
    (piece) =>
      piece.alive &&
      piece.side === "white" &&
      getLegalTargets(state, "white", piece).length > 0,
  );
  assert.ok(mover);
  const to = getLegalTargets(state, "white", mover)[0];
  assert.ok(to);
  state.augment!.permanentReveals.black = [];
  state.augment!.temporaryReveals.black = [mover.id];

  const projected = projectGame(state, "black", 1_000_000);
  assert.deepEqual(projected.augment?.permanentRevealIds, []);
  assert.deepEqual(projected.augment?.temporaryRevealIds, [mover.id]);
  assert.deepEqual(projectedRevealKnowledge(projected, "black"), {
    permanent: [],
    temporary: [mover.id],
  });

  const determined = determinizeFromProjection(
    state,
    "black",
    "temporary-reveal-world",
    1_000_000,
  );
  assert.deepEqual(determined.augment?.permanentReveals.black, []);
  assert.deepEqual(determined.augment?.temporaryReveals.black, [mover.id]);
  const afterMove = applyPlayerAction(
    determined,
    "white",
    { type: "move", from: { row: mover.row, col: mover.col }, to },
    1_000_000,
  );
  assert.equal(
    projectGame(afterMove, "black", 1_000_000).pieces.find((piece) => piece.id === mover.id)?.type,
    null,
  );

  const permanentSource = structuredClone(state);
  permanentSource.augment!.permanentReveals.black = [mover.id];
  permanentSource.augment!.temporaryReveals.black = [];
  const permanentWorld = determinizeFromProjection(
    permanentSource,
    "black",
    "permanent-reveal-world",
    1_000_000,
  );
  assert.deepEqual(permanentWorld.augment?.permanentReveals.black, [mover.id]);
  assert.deepEqual(permanentWorld.augment?.temporaryReveals.black, []);
  const afterPermanentMove = applyPlayerAction(
    permanentWorld,
    "white",
    { type: "move", from: { row: mover.row, col: mover.col }, to },
    1_000_000,
  );
  assert.notEqual(
    projectGame(afterPermanentMove, "black", 1_000_000).pieces.find(
      (piece) => piece.id === mover.id,
    )?.type,
    null,
  );

  const legacyProjection = structuredClone(projected);
  delete legacyProjection.augment!.permanentRevealIds;
  delete legacyProjection.augment!.temporaryRevealIds;
  assert.deepEqual(projectedRevealKnowledge(legacyProjection, "black"), {
    permanent: [mover.id],
    temporary: [],
  });
});

test("revealing any rank changes only the explicit information value at full inventory", () => {
  const state = createControlledPairGame(
    "club-forced-march",
    "club-line-hop",
    "black",
    "posterior-material",
  );
  const baseline = evaluateVisibleState(state, "black", 1_000_000);
  for (const type of Object.keys(PIECE_INFO) as PieceType[]) {
    const target = state.pieces.find((piece) => piece.side === "white" && piece.type === type);
    assert.ok(target);
    const revealed = structuredClone(state);
    revealed.augment!.permanentReveals.black = [target.id];
    const delta = evaluateVisibleState(revealed, "black", 1_000_000) - baseline;
    assert.ok(Math.abs(delta - 2.5) < 1e-9, `${type} changed score by ${delta}`);
  }
});

test("determinization infers an opponent's mandatory reconnaissance from public state only", () => {
  const state = createControlledPairGame(
    "spade-grand-maneuver",
    "spade-total-intelligence",
    "black",
    "opponent-recon-fidelity",
  );
  assert.deepEqual(state.augment?.pendingRecon.white, {
    augmentId: "spade-total-intelligence",
    remaining: 2,
  });
  const hiddenProgress = structuredClone(state);
  hiddenProgress.augment!.pendingRecon.white = null;
  assert.deepEqual(
    projectGame(state, "black", 1_000_000),
    projectGame(hiddenProgress, "black", 1_000_000),
  );

  const first = determinizeFromProjection(state, "black", "opponent-recon-world", 1_000_000);
  const second = determinizeFromProjection(
    hiddenProgress,
    "black",
    "opponent-recon-world",
    1_000_000,
  );
  assert.deepEqual(first.augment?.pendingRecon.white, {
    augmentId: "spade-total-intelligence",
    remaining: 2,
  });
  assert.deepEqual(second.augment?.pendingRecon.white, first.augment?.pendingRecon.white);

  first.turn = "white";
  if (first.clock) first.clock.turnStartedAt = 1_000_000;
  const actions = enumerateVisibleActions(projectGame(first, "white", 1_000_000), "white");
  assert.ok(actions.length > 0);
  assert.ok(actions.every((action) => action.type === "augment_recon"));

  const exhausted = structuredClone(hiddenProgress);
  exhausted.augment!.usedBySide.white.push("spade-total-intelligence");
  exhausted.augment!.triggerCounts.white["spade-total-intelligence"] = 1;
  assert.equal(
    determinizeFromProjection(exhausted, "black", "opponent-recon-world", 1_000_000)
      .augment?.pendingRecon.white,
    null,
  );
});

test("publicly completed opponent reconnaissance yields stable synthetic private knowledge", () => {
  let state = createControlledPairGame(
    "spade-grand-maneuver",
    "spade-total-intelligence",
    "white",
    "completed-opponent-recon",
  );
  for (let selection = 0; selection < 2; selection += 1) {
    const action = enumerateVisibleActions(projectGame(state, "white", 1_000_000), "white")[0];
    assert.equal(action?.type, "augment_recon");
    state = applyPlayerAction(state, "white", action!, 1_000_000);
  }
  assert.ok(state.augment?.usedBySide.white.includes("spade-total-intelligence"));
  assert.equal(state.augment?.permanentReveals.white.length, 2);

  const differentPrivateTargets = structuredClone(state);
  differentPrivateTargets.augment!.permanentReveals.white = state.pieces
    .filter((piece) => piece.side === "black" && piece.alive)
    .slice(-2)
    .map((piece) => piece.id);
  assert.deepEqual(
    projectGame(state, "black", 1_000_000),
    projectGame(differentPrivateTargets, "black", 1_000_000),
  );

  const first = determinizeFromProjection(state, "black", "completed-opponent-world");
  const second = determinizeFromProjection(
    differentPrivateTargets,
    "black",
    "completed-opponent-world",
  );
  assert.deepEqual(first, second);
  assert.equal(first.augment?.permanentReveals.white.length, 2);
  assert.equal(first.augment?.temporaryReveals.white.length, 0);
  const whiteProjection = projectGame(first, "white", 1_000_000);
  for (const id of first.augment?.permanentReveals.white ?? []) {
    assert.notEqual(whiteProjection.pieces.find((piece) => piece.id === id)?.type, null);
  }
});

test("second-round opponent reconnaissance stays executable in sampled worlds and never synthesizes dead targets", () => {
  const base = createControlledPairGame(
    "heart-rail-turn",
    "heart-mobile-rail",
    "black",
    "second-round-dead-before-recon",
  );
  base.moveNumber = 9;
  for (const target of base.pieces
    .filter((piece) => piece.side === "black" && piece.type !== "flag")
    .slice(0, 10)) {
    target.alive = false;
  }

  let state: GameState | null = null;
  for (let attempt = 0; attempt < 100 && !state; attempt += 1) {
    const random = new SeededRandom(`second-round-offer:${attempt}`);
    const draft = beginSecondAugmentDraft(base.augment!.draft, {
      suit: "spades",
      random: () => random.next(),
    });
    const round = draft.rounds.find((candidate) => candidate.number === 2)!;
    const recon = round.players.white.options.find((augmentId) => {
      const effect = getAugmentDefinition(augmentId).effect;
      return effect.kind === "reconnaissance" && effect.mode === "choose_enemy";
    });
    const blackPick = round.players.black.options.find(
      (augmentId) => getAugmentDefinition(augmentId).effect.kind !== "reconnaissance",
    );
    if (!recon || !blackPick) continue;

    let candidate = structuredClone(base);
    candidate.augment!.draft = draft;
    candidate.augment!.resumeTurn = candidate.turn;
    candidate.augment!.draftDeadlineAt = 1_045_000;
    candidate.phase = "augment_draft";
    candidate = applyPlayerAction(
      candidate,
      "black",
      { type: "augment_select", augmentId: blackPick },
      1_000_000,
    );
    candidate = applyPlayerAction(candidate, "black", { type: "augment_lock" }, 1_000_000);
    candidate = applyPlayerAction(
      candidate,
      "white",
      { type: "augment_select", augmentId: recon },
      1_000_000,
    );
    state = applyPlayerAction(candidate, "white", { type: "augment_lock" }, 1_000_000);
  }
  if (!state?.augment?.pendingRecon.white) assert.fail("Expected second-round reconnaissance.");

  let sampledPending = determinizeFromProjection(
    state,
    "white",
    "second-round-pending-recon-world",
    1_000_000,
  );
  assert.ok(sampledPending.repetitionTracker);
  assert.notEqual(sampledPending.repetitionTracker.salt, state.repetitionTracker?.salt);
  assert.deepEqual(sampledPending.repetitionTracker.counts, {});
  assert.equal(sampledPending.repetitionTracker.lastCountedDigest, null);
  assert.equal(sampledPending.repetitionTracker.currentOccurrences, 0);
  assert.equal(isValidRepetitionTrackerForState(sampledPending), true);
  while (sampledPending.augment?.pendingRecon.white) {
    const pending = sampledPending.augment.pendingRecon.white;
    const target = projectGame(sampledPending, "white", 1_000_000).augment?.pendingRecon
      ?.legalTargets?.[0];
    assert.ok(target);
    sampledPending = applyPlayerAction(
      sampledPending,
      "white",
      { type: "augment_recon", augmentId: pending.augmentId, target },
      1_000_000,
    );
  }
  assert.equal(sampledPending.repetitionTracker?.currentOccurrences, 1);
  assert.equal(isValidRepetitionTrackerForState(sampledPending), true);

  let completedState: GameState = state;

  while (completedState.augment?.pendingRecon.white) {
    const pending = completedState.augment.pendingRecon.white;
    const target = projectGame(completedState, "white", 1_000_000).augment?.pendingRecon?.legalTargets?.[0];
    assert.ok(target);
    completedState = applyPlayerAction(
      completedState,
      "white",
      { type: "augment_recon", augmentId: pending.augmentId, target },
      1_000_000,
    );
  }
  assert.deepEqual(projectGame(completedState, "black", 1_000_000).repetition, {
    threshold: 3,
    currentOccurrences: 1,
    active: true,
  });
  const sampledOccurrenceOne = determinizeFromProjection(
    completedState,
    "black",
    "active-public-occurrence-one",
    1_000_000,
  );
  assert.ok(sampledOccurrenceOne.repetitionTracker?.lastCountedDigest);
  assert.equal(sampledOccurrenceOne.repetitionTracker.currentOccurrences, 1);
  assert.deepEqual(Object.values(sampledOccurrenceOne.repetitionTracker.counts), [1]);
  assert.notEqual(
    sampledOccurrenceOne.repetitionTracker.salt,
    completedState.repetitionTracker?.salt,
  );
  assert.notEqual(
    sampledOccurrenceOne.repetitionTracker.lastCountedDigest,
    completedState.repetitionTracker?.lastCountedDigest,
  );
  assert.equal(isValidRepetitionTrackerForState(sampledOccurrenceOne), true);

  const authoritativeOccurrenceTwo = seedRepetitionTrackerFromCurrentPosition(
    completedState,
    2,
    "PRIVATE-AUTHORITATIVE-OCCURRENCE-TWO",
  );
  const sampledOccurrenceTwo = determinizeFromProjection(
    authoritativeOccurrenceTwo,
    "black",
    "active-public-occurrence-two",
    1_000_000,
  );
  assert.ok(sampledOccurrenceTwo.repetitionTracker?.lastCountedDigest);
  assert.equal(sampledOccurrenceTwo.repetitionTracker.currentOccurrences, 2);
  assert.deepEqual(Object.values(sampledOccurrenceTwo.repetitionTracker.counts), [2]);
  assert.notEqual(
    sampledOccurrenceTwo.repetitionTracker.salt,
    authoritativeOccurrenceTwo.repetitionTracker?.salt,
  );
  assert.notEqual(
    sampledOccurrenceTwo.repetitionTracker.lastCountedDigest,
    authoritativeOccurrenceTwo.repetitionTracker?.lastCountedDigest,
  );
  assert.equal(isValidRepetitionTrackerForState(sampledOccurrenceTwo), true);

  if (!completedState.augment) assert.fail("Expected augment runtime after reconnaissance.");
  const actualTargets = [...completedState.augment.permanentReveals.white];
  assert.ok(actualTargets.length > 0);
  assert.ok(
    actualTargets.every((id) => completedState.pieces.find((piece) => piece.id === id)?.alive),
  );
  const differentPrivateTargets = structuredClone(completedState);
  differentPrivateTargets.augment!.permanentReveals.white = completedState.pieces
    .filter(
      (piece) =>
        piece.side === "black" && piece.alive && !actualTargets.includes(piece.id),
    )
    .slice(0, actualTargets.length)
    .map((piece) => piece.id);
  assert.equal(differentPrivateTargets.augment!.permanentReveals.white.length, actualTargets.length);
  assert.deepEqual(
    projectGame(differentPrivateTargets, "black", 1_000_000),
    projectGame(completedState, "black", 1_000_000),
  );

  for (let seed = 0; seed < 64; seed += 1) {
    const first = determinizeFromProjection(
      completedState,
      "black",
      `second-round-dead-before-recon:${seed}`,
      1_000_000,
    );
    const second = determinizeFromProjection(
      differentPrivateTargets,
      "black",
      `second-round-dead-before-recon:${seed}`,
      1_000_000,
    );
    assert.deepEqual(second, first);
    for (const id of first.augment?.permanentReveals.white ?? []) {
      const target = first.pieces.find((piece) => piece.id === id);
      assert.ok(target?.alive);
      assert.equal(target.side, "black");
    }
  }
});

test("move-zero opponent frontline reconnaissance is synthesized within its public rows", () => {
  const state = createControlledPairGame(
    "heart-rail-turn",
    "heart-wide-recon",
    "black",
    "opponent-frontline-recon",
  );
  const effect = getAugmentDefinition("heart-wide-recon").effect;
  assert.equal(effect.kind, "reconnaissance");
  assert.ok(state.augment?.usedBySide.white.includes("heart-wide-recon"));
  const targetRows =
    effect.kind === "reconnaissance" && effect.mode === "frontline_random"
      ? Array.from({ length: effect.rowsFromFront }, (_, index) => 6 + index)
      : [];
  const differentPrivateTargets = structuredClone(state);
  const actualTargets = state.augment?.temporaryReveals.white ?? [];
  const eligibleIds = state.pieces
    .filter(
      (piece) => piece.side === "black" && piece.alive && targetRows.includes(piece.row),
    )
    .map((piece) => piece.id);
  const alternateTargets = eligibleIds
    .filter((id) => !actualTargets.includes(id))
    .slice(0, effect.kind === "reconnaissance" ? effect.count : 0);
  assert.equal(alternateTargets.length, effect.kind === "reconnaissance" ? effect.count : 0);
  differentPrivateTargets.augment!.temporaryReveals.white = alternateTargets;
  assert.notDeepEqual(differentPrivateTargets.augment!.temporaryReveals.white, actualTargets);
  assert.deepEqual(
    projectGame(state, "black", 1_000_000),
    projectGame(differentPrivateTargets, "black", 1_000_000),
  );

  const determined = determinizeFromProjection(state, "black", "frontline-opponent-world");
  const determinedFromDifferentTargets = determinizeFromProjection(
    differentPrivateTargets,
    "black",
    "frontline-opponent-world",
  );
  assert.deepEqual(determinedFromDifferentTargets, determined);
  const ids = determined.augment?.temporaryReveals.white ?? [];
  assert.equal(ids.length, effect.kind === "reconnaissance" ? effect.count : 0);
  for (const id of ids) {
    const target = determined.pieces.find((piece) => piece.id === id);
    assert.ok(target);
    assert.equal(target.side, "black");
    assert.equal(target.alive, true);
    assert.ok(targetRows.includes(target.row));
  }
});

test("visible policy consumes the server-authoritative legacy reconnaissance targets", () => {
  const state = createControlledPairGame(
    "heart-targeted-recon",
    "heart-rail-turn",
    "black",
    "legacy-recon-targets",
  );
  state.augment!.draft.catalogVersion = LEGACY_AUGMENT_CATALOG_VERSION;
  const openingRound = state.augment!.draft.rounds[0];
  openingRound.suit = "hearts";
  openingRound.players.black.options = [
    "heart-targeted-recon",
    "heart-initiative",
    "heart-rail-turn",
  ];
  openingRound.players.black.selectedId = "heart-targeted-recon";
  openingRound.players.white.options = [
    "heart-rail-turn",
    "heart-remote-exchange",
    "heart-bomb-disposal",
  ];
  openingRound.players.white.selectedId = "heart-rail-turn";
  state.augment!.draft.seenBySide = {
    black: [...openingRound.players.black.options],
    white: [...openingRound.players.white.options],
  };
  state.augment!.draft.loadouts = {
    black: ["heart-targeted-recon"],
    white: ["heart-rail-turn"],
  };
  const publicFlag = state.pieces.find(
    (piece) => piece.alive && piece.side === "white" && piece.type === "flag",
  );
  assert.ok(publicFlag);
  state.revealedFlags.white = true;
  state.augment!.permanentReveals.black = state.pieces
    .filter((piece) => piece.alive && piece.side === "white" && piece.id !== publicFlag.id)
    .map((piece) => piece.id);
  state.augment!.pendingRecon.black = {
    augmentId: "heart-targeted-recon",
    remaining: 1,
  };

  const view = projectGame(state, "black", 1_000_000);
  assert.deepEqual(enumerateVisibleActions(view, "black"), [
    {
      type: "augment_recon",
      augmentId: "heart-targeted-recon",
      target: { row: publicFlag.row, col: publicFlag.col },
    },
  ]);

  const opponentView = structuredClone(state);
  opponentView.augment!.pendingRecon.black = null;
  for (const piece of opponentView.pieces) {
    if (piece.side === "white" && piece.id !== publicFlag.id) piece.alive = false;
  }
  assert.deepEqual(
    determinizeFromProjection(
      opponentView,
      "white",
      "legacy-opponent-recon-world",
      1_000_000,
    ).augment?.pendingRecon.black,
    { augmentId: "heart-targeted-recon", remaining: 1 },
  );

  state.augment!.permanentReveals.black.push(publicFlag.id);
  const fullyKnownView = projectGame(state, "black", 1_000_000);
  assert.deepEqual(fullyKnownView.augment?.pendingRecon?.legalTargets, []);
  assert.deepEqual(enumerateVisibleActions(fullyKnownView, "black"), []);
});

test("common-random streams exclude cards, reveals, events, and action identity", () => {
  const state = createControlledPairGame(
    "club-forced-march",
    "club-line-hop",
    "black",
    "common-random-controls",
  );
  const variants: GameState[] = [];

  const differentCard = createControlledPairGame(
    "club-field-exchange",
    "club-line-hop",
    "black",
    "common-random-controls",
  );
  variants.push(differentCard);

  const differentTriggerCount = structuredClone(state);
  differentTriggerCount.augment!.triggerCounts.black["club-forced-march"] = 1;
  variants.push(differentTriggerCount);

  const differentReveal = structuredClone(state);
  const revealedEnemy = differentReveal.pieces.find(
    (piece) => piece.side === "white" && piece.alive && piece.type !== "flag",
  );
  assert.ok(revealedEnemy);
  differentReveal.augment!.permanentReveals.black.push(revealedEnemy.id);
  variants.push(differentReveal);

  const differentEvents = structuredClone(state);
  differentEvents.events.push({
    id: Math.max(...differentEvents.events.map((event) => event.id)) + 1,
    actor: "black",
    result: "augment_used",
    augmentId: "club-forced-march",
  });
  variants.push(differentEvents);

  const geometryKey = pairedSearchStateKey(state, "black");
  for (const variant of variants) {
    assert.equal(pairedSearchStateKey(variant, "black"), geometryKey);
  }
  for (const variant of variants.slice(0, 3)) {
    assert.notEqual(
      visibleStateFingerprint(variant, "black"),
      visibleStateFingerprint(state, "black"),
    );
  }

  const decisionSeed = policyDecisionSeed(8080, 3);
  assert.equal(decisionSeed, policyDecisionSeed(8080, 3));
  assert.notEqual(decisionSeed, policyDecisionSeed(8080, 4));
  assert.equal(commonWorldSeed(decisionSeed, 2), commonWorldSeed(decisionSeed, 2));
  assert.notEqual(commonWorldSeed(decisionSeed, 2), commonWorldSeed(decisionSeed, 3));
  assert.equal(
    commonRootSimulationSeed(decisionSeed, 2),
    commonRootSimulationSeed(decisionSeed, 2),
  );
});

test("paired search keys track geometry while paired action keys ignore augment treatment", () => {
  const state = createControlledPairGame(
    "club-forced-march",
    "club-line-hop",
    "black",
    "paired-search-geometry",
  );
  const differentTurn = structuredClone(state);
  differentTurn.turn = "white";
  assert.notEqual(
    pairedSearchStateKey(differentTurn, "black"),
    pairedSearchStateKey(state, "black"),
  );

  const differentGeometry = structuredClone(state);
  differentGeometry.pieces[0].row += 1;
  assert.notEqual(
    pairedSearchStateKey(differentGeometry, "black"),
    pairedSearchStateKey(state, "black"),
  );

  const move = {
    type: "move" as const,
    from: { row: 6, col: 2 },
    to: { row: 5, col: 2 },
  };
  const augmentedMove = {
    ...move,
    type: "augment_move" as const,
    augmentId: "club-forced-march" as const,
  };
  const otherAugmentedMove = {
    ...augmentedMove,
    augmentId: "club-line-hop" as const,
  };
  assert.equal(pairedActionKey(move), pairedActionKey(augmentedMove));
  assert.equal(pairedActionKey(augmentedMove), pairedActionKey(otherAugmentedMove));
  assert.notEqual(actionKey(move), actionKey(augmentedMove));
  assert.notEqual(actionKey(augmentedMove), actionKey(otherAugmentedMove));

  assert.equal(
    pairedActionKey({
      type: "augment_recon",
      augmentId: "club-local-recon",
      target: { row: 2, col: 3 },
    }),
    "recon:2,3",
  );
  assert.equal(pairedActionKey({ type: "pass_extra_move" }), "pass_extra_move");
});

test("search node accounting counts every root determinization", () => {
  const state = createControlledPairGame(
    "club-forced-march",
    "club-line-hop",
    "black",
    "node-accounting",
  );
  const decision = chooseVisibleAction(
    state,
    "black",
    "node-accounting-policy",
    { determinizations: 2, branching: 3, rolloutDepth: 1 },
  );
  assert.equal(decision.candidates, 3);
  assert.equal(decision.nodesEvaluated, 6);
});

function extraMoveChoiceState(kind: "forced_loss" | "capture_flag") {
  const state = createControlledPairGame(
    "spade-command-chain",
    "spade-counteroffensive",
    "black",
    `extra-move-${kind}`,
  );
  for (const candidate of state.pieces) candidate.alive = false;
  state.phase = "playing";
  state.turn = "black";
  state.firstTurn = "black";
  state.winner = null;
  state.finishReason = null;
  state.events = [];
  state.replay = null;
  state.clock = null;
  state.augment!.pendingRecon = { black: null, white: null };
  state.augment!.permanentReveals = { black: [], white: [] };
  state.augment!.temporaryReveals = { black: [], white: [] };
  const blackFlag = state.pieces.find(
    (candidate) => candidate.side === "black" && candidate.type === "flag",
  );
  const whiteFlag = state.pieces.find(
    (candidate) => candidate.side === "white" && candidate.type === "flag",
  );
  assert.ok(blackFlag && whiteFlag);
  Object.assign(blackFlag, { alive: true, row: 11, col: 3 });
  Object.assign(whiteFlag, { alive: true, row: 0, col: 3 });

  const previousMover = state.pieces.find(
    (candidate) => candidate.side === "black" && candidate.type === "platoon",
  );
  assert.ok(previousMover);
  state.augment!.extraMove.black = {
    augmentId: "spade-command-chain",
    excludedPieceId: previousMover.id,
  };

  if (kind === "forced_loss") {
    const engineer = state.pieces.find(
      (candidate) => candidate.side === "black" && candidate.type === "engineer",
    );
    const commander = state.pieces.find(
      (candidate) => candidate.side === "white" && candidate.type === "commander",
    );
    const general = state.pieces.find(
      (candidate) => candidate.side === "white" && candidate.type === "general",
    );
    assert.ok(engineer && commander && general);
    Object.assign(engineer, { alive: true, row: 0, col: 0 });
    Object.assign(commander, { alive: true, row: 0, col: 1 });
    Object.assign(general, { alive: true, row: 1, col: 0 });
    state.augment!.permanentReveals.black = [commander.id, general.id];
  } else {
    const commander = state.pieces.find(
      (candidate) => candidate.side === "black" && candidate.type === "commander",
    );
    const flag = whiteFlag;
    assert.ok(commander);
    Object.assign(commander, { alive: true, row: 0, col: 0 });
    Object.assign(flag, { alive: true, row: 0, col: 1 });
    state.revealedFlags.white = true;
  }
  return state;
}

test("visible policy passes a harmful extra move but still captures an exposed flag", () => {
  const forcedLoss = extraMoveChoiceState("forced_loss");
  const lossActions = enumerateVisibleActions(
    projectGame(forcedLoss, "black", 1_000_000),
    "black",
  );
  assert.ok(lossActions.some((action) => action.type === "pass_extra_move"));
  assert.ok(lossActions.some((action) => action.type === "move"));
  const passDecision = chooseVisibleAction(
    forcedLoss,
    "black",
    "extra-move-pass-policy",
    { determinizations: 2, branching: 8, rolloutDepth: 1 },
  );
  assert.deepEqual(passDecision.action, { type: "pass_extra_move" });

  const exposedFlag = extraMoveChoiceState("capture_flag");
  const captureDecision = chooseVisibleAction(
    exposedFlag,
    "black",
    "extra-move-flag-policy",
    { determinizations: 2, branching: 8, rolloutDepth: 1 },
  );
  assert.notEqual(captureDecision.action?.type, "pass_extra_move");
  assert.deepEqual(captureDecision.action, {
    type: "move",
    from: { row: 0, col: 0 },
    to: { row: 0, col: 1 },
  });
});

test("same seed and settings reproduce a complete four-leg mirror group", () => {
  const pairing = buildRoundRobinPairings().find(
    (candidate) =>
      candidate.cardA === "club-forced-march" && candidate.cardB === "club-line-hop",
  );
  assert.ok(pairing);
  const group = scheduleGroup(pairing, 0, 0);
  const first = playMirrorGroup(group, OPTIONS);
  const second = playMirrorGroup(group, OPTIONS);
  assert.deepEqual(first, second);
  assert.equal(new Set(first.map((result) => result.pairedSeed)).size, 1);
  assert.ok(first.every((result) => result.searchNodes > 0));
});

test("v3 stability UUIDs and the aura/redeploy refresh path are deterministic and finish all four legs", () => {
  const firstSetup = createControlledPairGame(
    "heart-sacrifice-aura",
    "heart-shadow-redeploy",
    "black",
    "deterministic-v3-piece-ids",
  );
  const secondSetup = createControlledPairGame(
    "heart-sacrifice-aura",
    "heart-shadow-redeploy",
    "black",
    "deterministic-v3-piece-ids",
  );
  assert.deepEqual(
    firstSetup.pieces.map(({ id, side, type, row, col }) => ({ id, side, type, row, col })),
    secondSetup.pieces.map(({ id, side, type, row, col }) => ({ id, side, type, row, col })),
  );

  const pairing = buildProductStabilityPairings().find(
    (candidate) =>
      candidate.cardA === "heart-sacrifice-aura" &&
      candidate.cardB === "heart-shadow-redeploy",
  );
  assert.ok(pairing);
  const fullGameOptions: TournamentOptions = {
    seed: 20260809,
    maxActions: 300,
    thinkTimeMinMs: 0,
    thinkTimeMaxMs: 0,
    search: { determinizations: 1, branching: 3, rolloutDepth: 1 },
    refreshMargin: 4,
  };
  for (const cycle of [0, 2]) {
    const results = playMirrorGroup(
      scheduleGroup(pairing, cycle, 0),
      fullGameOptions,
    );
    assert.equal(results.length, 4);
    assert.ok(
      results.every(
        (result) =>
          result.finished &&
          !result.capped &&
          !result.stuck &&
          result.exception === null &&
          result.moves > 9,
      ),
      `cycle ${cycle} failed: ${JSON.stringify(
        results.map(({ moves, capped, stuck, exception }) => ({
          moves,
          capped,
          stuck,
          exception,
        })),
      )}`,
    );
  }
});

test("a mid-game simulation exception preserves its real diagnostic ledger", () => {
  const pairing = buildProductStabilityPairings().find(
    (candidate) =>
      candidate.cardA === "heart-sacrifice-aura" &&
      candidate.cardB === "heart-shadow-redeploy",
  );
  assert.ok(pairing);
  const result = playLeg(
    scheduleGroup(pairing, 0, 0),
    mirrorLegs(pairing.cardA, pairing.cardB)[0],
    {
      seed: 20260809,
      maxActions: 300,
      thinkTimeMinMs: 0,
      thinkTimeMaxMs: 0,
      search: { determinizations: 1, branching: 3, rolloutDepth: 1 },
      refreshMargin: 4,
    },
    {
      ratings: new Proxy({}, {
        get() {
          throw new Error("diagnostic-ledger-probe");
        },
      }),
    },
  );
  assert.equal(result.exception, "diagnostic-ledger-probe");
  assert.equal(result.moves, 9);
  assert.ok(result.searchNodes > 0);
  assert.deepEqual(result.loadouts, {
    black: ["heart-sacrifice-aura"],
    white: ["heart-shadow-redeploy"],
  });
  assert.equal(result.finished, false);
  assert.equal(result.capped, false);
  assert.equal(result.stuck, false);
});

test("mirror schedule swaps both color and first player exactly once per assignment", () => {
  const cardA = "heart-rail-turn" as AugmentId;
  const cardB = "heart-initiative" as AugmentId;
  assert.deepEqual(mirrorLegs(cardA, cardB), [
    { index: 0, blackCard: cardA, whiteCard: cardB, firstTurn: "black" },
    { index: 1, blackCard: cardB, whiteCard: cardA, firstTurn: "black" },
    { index: 2, blackCard: cardA, whiteCard: cardB, firstTurn: "white" },
    { index: 3, blackCard: cardB, whiteCard: cardA, firstTurn: "white" },
  ]);
});

test("stratified runtime pilot samples every tier deterministically", () => {
  const pairings = buildRoundRobinPairings();
  const first = stratifiedPairSample(pairings, 2);
  const second = stratifiedPairSample(pairings, 2);
  assert.deepEqual(first, second);
  assert.equal(first.length, 8);
  assert.deepEqual(
    [...new Set(first.map((pairing) => pairing.suit))].sort(),
    ["clubs", "diamonds", "hearts", "spades"],
  );
  for (const suit of ["spades", "hearts", "clubs", "diamonds"] as const) {
    assert.equal(first.filter((pairing) => pairing.suit === suit).length, 2);
  }
});

test("confidence interval helpers return stable bounded statistics", () => {
  const wilson = wilsonInterval(50, 100);
  assert.ok(wilson);
  assert.equal(wilson.estimate, 0.5);
  assert.ok(Math.abs(wilson.low - 0.4038315304) < 1e-8);
  assert.ok(Math.abs(wilson.high - 0.5961684696) < 1e-8);
  assert.equal(wilsonInterval(0, 0), null);

  const clustered = meanConfidenceInterval([0.25, 0.5, 0.75]);
  assert.ok(clustered);
  assert.equal(clustered.estimate, 0.5);
  assert.equal(clustered.n, 3);
  assert.ok(clustered.low >= 0 && clustered.high <= 1);
});

test("checkpoint validation and remaining schedule make resume idempotent", () => {
  const pairings = buildRoundRobinPairings().slice(0, 2);
  const checkpoint = createCheckpoint(OPTIONS, new Date("2026-08-09T12:00:00.000Z"), pairings);
  const schedule = pairings.map((pairing) => scheduleGroup(pairing, 0, 0));
  checkpoint.completedGroupKeys.push(schedule[0].groupKey);
  const restored = JSON.parse(JSON.stringify(checkpoint));
  validateCheckpoint(restored, OPTIONS, pairings);
  assert.equal(restored.schemaVersion, 5);
  assert.deepEqual(remainingGroups(schedule, restored.completedGroupKeys), [schedule[1]]);
  assert.equal(restored.configFingerprint, tournamentConfigFingerprint(OPTIONS));
  assert.equal(restored.algorithmVersion, BALANCE_ALGORITHM_VERSION);
  assert.equal(
    BALANCE_ALGORITHM_VERSION,
    "product-stability-v13-v3-no-clock-zero-time-deterministic-ids",
  );
  assert.equal(restored.engineRulesFingerprint, BALANCE_ENGINE_RULES_FINGERPRINT);
  assert.equal(
    BALANCE_ENGINE_RULES_FINGERPRINT,
    "augment-duel-dark-v3:threefold-3:strategic-sha256-v2",
  );
  assert.notEqual(
    tournamentConfigFingerprint(OPTIONS),
    tournamentConfigFingerprint(OPTIONS, "future-balance-algorithm"),
  );
  assert.notEqual(
    tournamentConfigFingerprint(OPTIONS),
    tournamentConfigFingerprint(OPTIONS, BALANCE_ALGORITHM_VERSION, "future-engine-rules"),
  );

  const legacy = JSON.parse(JSON.stringify(checkpoint));
  delete legacy.algorithmVersion;
  assert.throws(() => validateCheckpoint(legacy, OPTIONS, pairings), /algorithm/i);

  const oldSchema = JSON.parse(JSON.stringify(checkpoint));
  oldSchema.schemaVersion = 4;
  assert.throws(() => validateCheckpoint(oldSchema, OPTIONS, pairings), /schema/i);

  const earlyV12 = JSON.parse(JSON.stringify(checkpoint));
  earlyV12.algorithmVersion = "product-stability-v12-v3-no-clock-zero-time";
  assert.throws(() => validateCheckpoint(earlyV12, OPTIONS, pairings), /algorithm/i);

  const v6 = JSON.parse(JSON.stringify(checkpoint));
  v6.algorithmVersion = "hidden-info-balance-v6-full-threshold-increment";
  assert.throws(() => validateCheckpoint(v6, OPTIONS, pairings), /algorithm/i);

  const v7 = JSON.parse(JSON.stringify(checkpoint));
  v7.algorithmVersion = "hidden-info-balance-v7-recon-state-fidelity";
  assert.throws(() => validateCheckpoint(v7, OPTIONS, pairings), /algorithm/i);

  const v8 = JSON.parse(JSON.stringify(checkpoint));
  v8.algorithmVersion = "hidden-info-balance-v8-legal-world-posterior";
  assert.throws(() => validateCheckpoint(v8, OPTIONS, pairings), /algorithm/i);

  const v9 = JSON.parse(JSON.stringify(checkpoint));
  v9.algorithmVersion = "hidden-info-balance-v9-public-history-fidelity";
  assert.throws(() => validateCheckpoint(v9, OPTIONS, pairings), /algorithm/i);

  const v10 = JSON.parse(JSON.stringify(checkpoint));
  v10.algorithmVersion = "hidden-info-balance-v10-production-timing-stratified";
  assert.throws(() => validateCheckpoint(v10, OPTIONS, pairings), /algorithm/i);

  const wrongRules = JSON.parse(JSON.stringify(checkpoint));
  wrongRules.engineRulesFingerprint = "older-engine-rules";
  assert.throws(() => validateCheckpoint(wrongRules, OPTIONS, pairings), /engine rules/i);

  const staleMetrics = JSON.parse(JSON.stringify(checkpoint));
  delete staleMetrics.aggregate.global.passExtraMoves;
  assert.throws(() => validateCheckpoint(staleMetrics, OPTIONS, pairings), /pass-extra-move/i);

  const staleDrawMetrics = JSON.parse(JSON.stringify(checkpoint));
  delete staleDrawMetrics.aggregate.global.threefoldDraws;
  assert.throws(() => validateCheckpoint(staleDrawMetrics, OPTIONS, pairings), /threefold-draw/i);

  restored.completedGroupKeys.push(schedule[0].groupKey);
  assert.throws(() => validateCheckpoint(restored, OPTIONS, pairings), /duplicate/i);
});

test("draft strategy consumes empirical counter values without mutating the offer", () => {
  const offer = ["heart-rail-turn", "heart-initiative", "heart-remote-exchange"] as const;
  const snapshot = [...offer];
  const decision = chooseDraftCard(offer, ["spade-grand-maneuver"], {
    counters: {
      "heart-remote-exchange": { "spade-grand-maneuver": 500 },
    },
  });
  assert.equal(decision.id, "heart-remote-exchange");
  assert.deepEqual(offer, snapshot);
});

test("tuning adviser emits review-only numeric candidates and never edits the catalog", () => {
  const aggregate = createEmptyAggregate();
  aggregate.cards["spade-total-intelligence"].mirrorScores = Array(8).fill(1);
  aggregate.cards["spade-grand-maneuver"].mirrorScores = Array(8).fill(0);
  aggregate.cards["spade-relentless-assault"].mirrorScores = Array(8).fill(0.5);
  const suggestions = suggestTuning(aggregate);
  assert.ok(
    suggestions.some(
      (suggestion) =>
        suggestion.augmentId === "spade-total-intelligence" &&
        suggestion.direction === "nerf" &&
        suggestion.field === "effect.count",
    ),
  );
  assert.ok(
    suggestions.some(
      (suggestion) =>
        suggestion.augmentId === "spade-grand-maneuver" &&
        suggestion.direction === "buff" &&
        suggestion.field === "charges",
    ),
  );
});

test("card aggregation separates opportunity and first-trigger timing from raw non-use", () => {
  const pairing = buildRoundRobinPairings().find(
    (candidate) =>
      candidate.cardA === "club-forced-march" && candidate.cardB === "club-line-hop",
  );
  assert.ok(pairing);
  const group = scheduleGroup(pairing, 0, 0);
  const results = playMirrorGroup(group, OPTIONS).map((result) => ({
    ...result,
    finished: true,
    capped: false,
    winner: "black" as const,
    winningCard: result.leg.blackCard,
    finishReason: "flag" as const,
    loadouts: {
      black: [result.leg.blackCard],
      white: [result.leg.whiteCard],
    },
    opportunityAugments: {
      black: [result.leg.blackCard],
      white: [result.leg.whiteCard],
    },
    triggerCounts: {
      black: { [result.leg.blackCard]: 1 },
      white: { [result.leg.whiteCard]: 1 },
    },
    firstTriggerMoves: {
      black: { [result.leg.blackCard]: 5 },
      white: { [result.leg.whiteCard]: 7 },
    },
    passExtraMoveCounts:
      result.leg.blackCard === "club-forced-march"
        ? { black: { "club-forced-march": 1 }, white: {} }
        : { black: {}, white: { "club-forced-march": 1 } },
  }));
  const aggregate = createEmptyAggregate();
  recordMirrorGroup(aggregate, group, results);
  assert.equal(aggregate.cards["club-forced-march"].opportunityGames, 4);
  assert.deepEqual(aggregate.cards["club-forced-march"].firstTriggerMoves.sort(), [5, 5, 7, 7]);
  assert.equal(aggregate.global.passExtraMoves, 4);
  assert.equal(aggregate.cards["club-forced-march"].passExtraMoves, 4);
  assert.equal(aggregate.pairs[group.pairKey].passExtraMoves, 4);
  const checkpoint = createCheckpoint(OPTIONS, new Date("2026-08-09T12:00:00.000Z"), [pairing]);
  checkpoint.aggregate = aggregate;
  const report = buildBalanceReport(checkpoint);
  assert.equal(report.purpose, "product_stability");
  assert.equal(report.catalogSize, 70);
  assert.equal(report.simulationEligibleSize, 63);
  assert.deepEqual(report.excludedClockAugmentIds, EXCLUDED_CLOCK_AUGMENT_IDS);
  assert.equal(report.simulationCoverage.total, 63);
  assert.deepEqual(report.tuningSuggestions, []);
  assert.ok(
    report.cards.every((card) =>
      SIMULATION_ELIGIBLE_AUGMENT_IDS.includes(card.id)
    ),
  );
  assert.equal(report.global.passExtraMoves, 4);
  assert.equal(
    report.cards.find((card) => card.id === "club-forced-march")?.passExtraMoves,
    4,
  );
});

test("same-tier v13 scores adjudicated threefold draws as 0.5 without hiding action caps", () => {
  const pairing = buildRoundRobinPairings()[0];
  const group = scheduleGroup(pairing, 0, 0);
  const results = playMirrorGroup(group, OPTIONS).map((result) => ({
    ...result,
    finished: true,
    winner: null,
    winningCard: null,
    finishReason: "draw" as const,
    drawReason: "threefold_repetition" as const,
    capped: false,
    stuck: false,
    exception: null,
  }));
  const aggregate = createEmptyAggregate();
  recordMirrorGroup(aggregate, group, results);
  assert.equal(aggregate.global.finished, 4);
  assert.equal(aggregate.global.draws, 4);
  assert.equal(aggregate.global.threefoldDraws, 4);
  assert.equal(aggregate.global.capped, 0);
  assert.deepEqual(aggregate.pairs[group.pairKey].cardAMirrorScores, [0.5]);
  assert.equal(aggregate.cards[group.cardA].threefoldDraws, 4);
});

test("v13 cross-tier diagnostic schedule balances legal round order and isolates setup cards", () => {
  const representatives = selectTierRepresentatives();
  assert.equal(representatives.length, 4);
  assert.equal(buildCrossTierComparisons().length, 6);
  const pairs = buildCrossTierCardSchedule(0);
  assert.equal(pairs.length, 100);
  assert.equal(
    new Set(pairs.flatMap((pair) => [pair.higherCard, pair.lowerCard])).size,
    SIMULATION_ELIGIBLE_COUNT,
  );
  assert.ok(
    pairs.every(
      (pair) =>
        !EXCLUDED_CLOCK_AUGMENT_IDS.includes(pair.higherCard) &&
        !EXCLUDED_CLOCK_AUGMENT_IDS.includes(pair.lowerCard),
    ),
  );

  const schedule = buildCrossTierExperimentSchedule(0);
  assert.ok(schedule.length > pairs.length);
  for (const pair of pairs) {
    const groups = schedule.filter((group) => group.pairKey === pair.pairKey);
    const setupCards = [pair.higherCard, pair.lowerCard].filter(
      (id) => getAugmentDefinition(id).activation === "setup",
    );
    if (setupCards.length) {
      assert.equal(groups.length, 1);
      assert.equal(groups[0].stratum, "setup");
      const setupProfile = setupCards[0] === pair.higherCard ? "higher" : "lower";
      assert.equal(groups[0].roundOrder, `${setupProfile}_first`);
      assert.deepEqual(roundOrdersForPair(pair), [groups[0].roundOrder]);
    } else {
      assert.equal(groups.length, 2);
      assert.deepEqual(
        groups.map((group) => group.roundOrder),
        ["higher_first", "lower_first"],
      );
      assert.ok(groups.every((group) => group.stratum === "round_order"));
    }
  }
  assert.ok(
    schedule
      .filter((group) => group.stratum === "round_order")
      .every(
        (group) =>
          getAugmentDefinition(group.higherCard).activation !== "setup" &&
          getAugmentDefinition(group.lowerCard).activation !== "setup",
      ),
  );
  const nonSetupCards = SIMULATION_ELIGIBLE_AUGMENTS.filter(
    (card) => card.activation !== "setup",
  );
  const setupCards = SIMULATION_ELIGIBLE_AUGMENTS.filter(
    (card) => card.activation === "setup",
  );
  assert.equal(nonSetupCards.length, 57);
  assert.equal(setupCards.length, 6);
  for (const card of nonSetupCards) {
    const cardGroups = schedule.filter(
      (group) => group.higherCard === card.id || group.lowerCard === card.id,
    );
    assert.ok(cardGroups.some((group) => group.roundOrder === "higher_first"));
    assert.ok(cardGroups.some((group) => group.roundOrder === "lower_first"));
  }
  for (const card of setupCards) {
    const cardGroups = schedule.filter(
      (group) => group.higherCard === card.id || group.lowerCard === card.id,
    );
    assert.ok(cardGroups.length > 0);
    assert.ok(cardGroups.every((group) => group.stratum === "setup"));
    assert.ok(
      cardGroups.every((group) =>
        card.id === group.higherCard
          ? group.roundOrder === "higher_first"
          : group.roundOrder === "lower_first",
      ),
    );
  }
  const setupGroup = schedule.find((group) => group.stratum === "setup");
  assert.ok(setupGroup);
  const setupLeg = crossTierLegs()[0];
  const setupState = createDirectCrossTierGame(
    setupGroup,
    setupLeg,
    98765,
    1_000_000,
    setupGroup.roundOrder,
  );
  const setupSide =
    getAugmentDefinition(setupGroup.higherCard).activation === "setup" ? "black" : "white";
  const setupFocal = setupSide === "black" ? setupGroup.higherCard : setupGroup.lowerCard;
  assert.equal(setupState.augment?.draft.rounds.length, 1);
  assert.ok(setupState.augment?.draft.loadouts[setupSide].includes(setupFocal));
});

test("v13 second focal is absent at move zero and selected in the formal move-10 draft", () => {
  const group = buildCrossTierExperimentSchedule(0).find(
    (candidate) =>
      candidate.stratum === "round_order" && candidate.roundOrder === "higher_first",
  );
  assert.ok(group);
  const leg = crossTierLegs()[0];
  const initial = createDirectCrossTierGame(group, leg, 12345, 1_000_000, group.roundOrder);
  assert.equal(initial.moveNumber, 0);
  assert.equal(initial.augment?.draft.rounds.length, 1);
  assert.ok(!initial.augment?.draft.loadouts.white.includes(group.lowerCard));

  const result = playCrossTierScheduledLeg(group, leg, {
    ...OPTIONS,
    maxActions: 12,
  });
  assert.equal(result.exception, null);
  assert.equal(result.secondDraftStartedAtMove, 9);
  assert.equal(result.secondDraftRevealed, true);
  assert.ok(result.moves >= 9);
  assert.equal(result.focal.black.round, 1);
  assert.equal(result.focal.white.round, 2);
  assert.equal(result.focal.white.augmentId, group.lowerCard);
  assert.equal(result.focal.white.selected, true);
});

test("v13 common random seed excludes card IDs and one four-leg mirror shares it", () => {
  const group = buildCrossTierExperimentSchedule(0).find(
    (candidate) => candidate.stratum === "round_order",
  );
  assert.ok(group);
  const altered = {
    ...group,
    higherCard: "spade-grand-maneuver" as AugmentId,
    lowerCard: "heart-rail-turn" as AugmentId,
    pairKey: "intentionally-different-card-identities",
  };
  assert.equal(crossTierPairedSeed(OPTIONS, group), crossTierPairedSeed(OPTIONS, altered));
  assert.notEqual(
    crossTierPairedSeed(OPTIONS, group),
    crossTierPairedSeed(OPTIONS, { ...group, roundOrder: "lower_first" }),
  );
  const results = playCrossTierScheduledMirrorGroup(group, { ...OPTIONS, maxActions: 10 });
  assert.equal(results.length, 4);
  assert.equal(new Set(results.map((result) => result.pairedSeed)).size, 1);
  assert.ok(results.every((result) => result.secondDraftStartedAtMove === 9));
  assert.ok(results.every((result) => result.secondDraftRevealed));
});

test("v13 leg ledger and report preserve finish, focal trigger, opportunity and stop status", () => {
  const group = buildCrossTierExperimentSchedule(0).find(
    (candidate) => candidate.stratum === "round_order",
  );
  assert.ok(group);
  const real = playCrossTierScheduledMirrorGroup(group, { ...OPTIONS, maxActions: 10 });
  const results: CrossTierLegResult[] = real.map((result, index) => ({
    ...result,
    finished: true,
    winner: index % 2 === 0 ? ("black" as const) : ("white" as const),
    winningProfile:
      index % 2 === 0 ? result.leg.blackProfile : result.leg.whiteProfile,
    finishReason: index < 2 ? ("flag" as const) : ("no_moves" as const),
    finalClockMs: null,
    capped: false,
    stuck: false,
    exception: null,
    focal: {
      black: {
        ...result.focal.black,
        triggers: 1,
        opportunity: true,
        firstTriggerMove:
          result.focal.black.firstTriggerMove ?? (result.focal.black.round === 2 ? 9 : 1),
      },
      white: {
        ...result.focal.white,
        triggers: 1,
        opportunity: true,
        firstTriggerMove:
          result.focal.white.firstTriggerMove ?? (result.focal.white.round === 2 ? 9 : 1),
      },
    },
  }));
  const aggregate = createEmptyCrossTierAggregate();
  recordCrossTierScheduledMirrorGroup(aggregate, group, results, { ...OPTIONS, maxActions: 10 });
  const reportOptions = { ...OPTIONS, maxActions: 10 };
  const report = buildCrossTierReport(aggregate, reportOptions);
  assert.equal(report.purpose, "diagnostic_only");
  assert.equal(report.catalogSize, 70);
  assert.equal(report.simulationEligibleSize, 63);
  assert.deepEqual(report.excludedClockAugmentIds, EXCLUDED_CLOCK_AUGMENT_IDS);
  assert.equal(report.coverage.eligibleCards, 63);
  const row = report.comparisons.find(
    (candidate) => candidate.higher === group.higher && candidate.lower === group.lower,
  );
  assert.ok(row);
  assert.equal(report.global.executedGroups, 1);
  assert.equal(report.global.completeMirrorGroups, 1);
  assert.equal(report.configFingerprint, crossTierConfigFingerprint(reportOptions));
  assert.equal(report.scheduleFingerprint, crossTierScheduleFingerprint());
  assert.equal(report.seed, reportOptions.seed);
  assert.deepEqual(report.options, reportOptions);
  assert.equal(report.legs.length, 4);
  assert.ok(report.legs.every((legResult) => legResult.roundOrder === group.roundOrder));
  assert.ok(report.legs.every((legResult) => legResult.finalClockMs === null));
  assert.deepEqual(row.finishReasons, { flag: 2, no_moves: 2 });
  assert.equal(row.exceptions, 0);
  assert.equal(row.stuck, 0);
  assert.equal(row.capped, 0);
  assert.equal(row.focal.higher.assignedGames, 4);
  assert.equal(row.focal.lower.assignedGames, 4);
  assert.equal(row.focal.higher.selectedGames, 4);
  assert.equal(row.focal.lower.selectedGames, 4);
  assert.ok(row.focal.higher.triggers > 0);
  assert.ok(row.focal.lower.opportunities > 0);
  assert.equal(row.averageFinalClockMs.higher, null);
  assert.equal(row.averageFinalClockMs.lower, null);
  const rendered = crossTierMarkdown(report);
  assert.match(rendered, /证据配置：seed 424242；maxActions 10/);
  assert.match(rendered, /已执行镜像组 1；完整镜像组 1/);
  assert.match(rendered, /setup 专层（不计入纯档位结论）/);
  assert.doesNotMatch(rendered, /Wilson|95%确认/);
  assert.deepEqual(report.global.draftTiming, {
    reachedLegs: 4,
    revealedLegs: 4,
    roundTwoFocalSelections: 4,
    timingViolations: 0,
  });

  const invalidTimingResults = [
    (candidate: typeof results) => {
      candidate[0].secondDraftStartedAtMove = 0;
    },
    (candidate: typeof results) => {
      candidate[0].secondDraftRevealed = false;
    },
    (candidate: typeof results) => {
      const side = candidate[0].focal.black.round === 2 ? "black" : "white";
      candidate[0].focal[side] = {
        ...candidate[0].focal[side],
        selected: false,
        triggers: 0,
        opportunity: false,
        firstTriggerMove: null,
      };
    },
  ];
  for (const mutate of invalidTimingResults) {
    const candidate = structuredClone(results);
    mutate(candidate);
    const rejected = createEmptyCrossTierAggregate();
    assert.throws(
      () =>
        recordCrossTierScheduledMirrorGroup(rejected, group, candidate, {
          ...OPTIONS,
          maxActions: 10,
        }),
      /production timing/i,
    );
    assert.equal(rejected.groups, 0);
    assert.equal(rejected.legResults.length, 0);
  }
  const nonCanonical = structuredClone(results);
  for (const result of nonCanonical) {
    result.leg.blackProfile = "higher";
    result.leg.whiteProfile = "lower";
    result.leg.firstTurn = "black";
  }
  assert.throws(
    () =>
      recordCrossTierScheduledMirrorGroup(aggregate, group, nonCanonical, {
        ...OPTIONS,
        maxActions: 10,
      }),
    /canonical color\/first-turn/i,
  );
});

test("cross-tier v13 preserves drawReason and scores each product threefold draw as 0.5", () => {
  const options = { ...OPTIONS, maxActions: 10 };
  const group = buildCrossTierExperimentSchedule(0).find(
    (candidate) => candidate.stratum === "round_order",
  );
  assert.ok(group);
  const results = playCrossTierScheduledMirrorGroup(group, options).map((result) => ({
    ...result,
    finished: true,
    winner: null,
    winningProfile: null,
    finishReason: "draw" as const,
    drawReason: "threefold_repetition" as const,
    capped: false,
    stuck: false,
    exception: null,
  }));
  const aggregate = createEmptyCrossTierAggregate();
  recordCrossTierScheduledMirrorGroup(aggregate, group, results, options);
  const report = buildCrossTierReport(aggregate, options);
  const row = report.comparisons.find(
    (candidate) => candidate.higher === group.higher && candidate.lower === group.lower,
  );
  assert.equal(report.global.finished, 4);
  assert.equal(report.global.threefoldDraws, 4);
  assert.equal(report.global.capped, 0);
  assert.ok(report.legs.every((leg) => leg.drawReason === "threefold_repetition"));
  assert.equal(row?.threefoldDraws, 4);
  assert.equal(row?.higherScore?.estimate, 0.5);
});

test("v13 setup results remain outside pure round-order tier estimates", () => {
  const group = buildCrossTierExperimentSchedule(0).find(
    (candidate) => candidate.stratum === "setup",
  );
  assert.ok(group);
  const results = playCrossTierScheduledMirrorGroup(group, { ...OPTIONS, maxActions: 10 }).map(
    (result) => ({
      ...result,
      finished: true,
      winner: "black" as const,
      winningProfile: result.leg.blackProfile,
      finishReason: "flag" as const,
      capped: false,
      stuck: false,
      exception: null,
    }),
  );
  const aggregate = createEmptyCrossTierAggregate();
  recordCrossTierScheduledMirrorGroup(aggregate, group, results, { ...OPTIONS, maxActions: 10 });
  const report = buildCrossTierReport(aggregate, { ...OPTIONS, maxActions: 10 });
  assert.deepEqual(report.strata.round_order, {
    executedGroups: 0,
    completeMirrorGroups: 0,
  });
  assert.deepEqual(report.strata.setup, {
    executedGroups: 1,
    completeMirrorGroups: 1,
  });
  assert.ok(report.comparisons.every((comparison) => comparison.executedGroups === 0));
  assert.equal(report.setupComparisons.length, 1);
  assert.ok(report.tiers.every((tier) => tier.cardsRepresented === 0));
  const setupCard = [group.higherCard, group.lowerCard].find(
    (id) => getAugmentDefinition(id).activation === "setup",
  );
  assert.ok(setupCard);
  const card = report.cards.find((candidate) => candidate.id === setupCard);
  assert.equal(card?.roundOrderCompleteMirrorGroups, 0);
  assert.equal(card?.setupCompleteMirrorGroups, 1);
});

test("v13 cross-tier estimates are card-equal and use deterministic mirror-group bootstrap", () => {
  const samples: CrossTierMirrorSample[] = [
    {
      groupKey: "g0",
      higherCard: "spade-command-chain",
      lowerCard: "heart-bomb-disposal",
      roundOrder: "higher_first",
      higherScore: 1,
    },
    {
      groupKey: "g1",
      higherCard: "spade-command-chain",
      lowerCard: "heart-bomb-disposal",
      roundOrder: "lower_first",
      higherScore: 1,
    },
    {
      groupKey: "g2",
      higherCard: "spade-command-chain",
      lowerCard: "heart-bomb-disposal",
      roundOrder: "higher_first",
      higherScore: 1,
    },
    {
      groupKey: "g3",
      higherCard: "spade-grand-maneuver",
      lowerCard: "heart-rail-turn",
      roundOrder: "lower_first",
      higherScore: 0,
    },
  ];
  assert.equal(samples.reduce((sum, sample) => sum + sample.higherScore, 0) / samples.length, 0.75);
  assert.equal(cardEqualComparisonEstimate(samples), 0.5);
  assert.equal(cardEqualTierEstimate(samples, "spades"), 0.5);
  assert.equal(cardEqualTierEstimate(samples, "hearts"), 0.5);
  const first = deterministicMirrorBootstrapInterval(
    samples.map((sample) => sample.higherScore),
    "deterministic-test",
  );
  const second = deterministicMirrorBootstrapInterval(
    samples.map((sample) => sample.higherScore),
    "deterministic-test",
  );
  assert.deepEqual(first, second);
  assert.equal(first?.n, 4);
  assert.ok(first && first.low >= 0 && first.high <= 1);
});

test("v13 technical acceptance rejects an incomplete favorable sample without gating on ordering", () => {
  const tournament = { ...OPTIONS, maxActions: 10 };
  const groups = buildCrossTierComparisons().map((comparison) => {
    const group = buildCrossTierExperimentSchedule(0).find(
      (candidate) =>
        candidate.key === comparison.key &&
        candidate.stratum === "round_order" &&
        candidate.roundOrder === "higher_first",
    );
    assert.ok(group);
    return group;
  });
  const aggregate = createEmptyCrossTierAggregate();
  for (const group of groups) {
    const results = playCrossTierScheduledMirrorGroup(group, tournament).map((result) => {
      const winner = result.leg.blackProfile === "higher" ? ("black" as const) : ("white" as const);
      return {
        ...result,
        winner,
        winningProfile: "higher" as const,
        finished: true,
        finishReason: "flag" as const,
        capped: false,
        stuck: false,
        exception: null,
      };
    });
    recordCrossTierScheduledMirrorGroup(aggregate, group, results, tournament);
  }
  const report = buildCrossTierReport(aggregate, tournament, groups.length);
  assert.equal(report.ordering.pointEstimatePass, true);
  assert.equal(report.ordering.tierPointEstimatePass, true);
  assert.equal(report.ordering.sampleSufficient, false);
  assert.equal(report.acceptancePass, false);
  assert.match(crossTierMarkdown(report), /技术完整性门槛：不通过/);
  assert.match(crossTierMarkdown(report), /永不作为 gate/);
});

test("cross-tier checkpoints bind the balance algorithm and reject legacy evidence", () => {
  const checkpoint = createCrossTierCheckpoint(OPTIONS);
  assert.doesNotThrow(() => validateCrossTierCheckpoint(checkpoint, OPTIONS));
  assert.equal(checkpoint.schemaVersion, 5);
  assert.deepEqual(checkpoint.cursor, { cycle: 0, groupIndex: 0 });
  assert.deepEqual(checkpoint.options, OPTIONS);
  assert.equal(checkpoint.algorithmVersion, BALANCE_ALGORITHM_VERSION);
  assert.equal(checkpoint.engineRulesFingerprint, BALANCE_ENGINE_RULES_FINGERPRINT);
  const normalizedClockless = createCrossTierCheckpoint({
    ...OPTIONS,
    thinkTimeMinMs: 123,
    thinkTimeMaxMs: 456,
  });
  assert.equal(normalizedClockless.options.thinkTimeMinMs, 0);
  assert.equal(normalizedClockless.options.thinkTimeMaxMs, 0);
  assert.doesNotThrow(() =>
    validateCrossTierCheckpoint(normalizedClockless, {
      ...OPTIONS,
      thinkTimeMinMs: 123,
      thinkTimeMaxMs: 456,
    })
  );
  assert.notEqual(
    crossTierConfigFingerprint(OPTIONS),
    crossTierConfigFingerprint(OPTIONS, "future-balance-algorithm"),
  );
  assert.notEqual(
    crossTierConfigFingerprint(OPTIONS),
    crossTierConfigFingerprint(OPTIONS, BALANCE_ALGORITHM_VERSION, "future-engine-rules"),
  );

  const legacy = JSON.parse(JSON.stringify(checkpoint));
  delete legacy.algorithmVersion;
  assert.throws(() => validateCrossTierCheckpoint(legacy, OPTIONS), /algorithm/i);

  const oldSchema = JSON.parse(JSON.stringify(checkpoint));
  oldSchema.schemaVersion = 4;
  assert.throws(() => validateCrossTierCheckpoint(oldSchema, OPTIONS), /schema/i);

  const earlyV12 = JSON.parse(JSON.stringify(checkpoint));
  earlyV12.algorithmVersion = "product-stability-v12-v3-no-clock-zero-time";
  assert.throws(
    () => validateCrossTierCheckpoint(earlyV12, OPTIONS),
    /algorithm/i,
  );

  const v6 = JSON.parse(JSON.stringify(checkpoint));
  v6.algorithmVersion = "hidden-info-balance-v6-full-threshold-increment";
  assert.throws(() => validateCrossTierCheckpoint(v6, OPTIONS), /algorithm/i);

  const v7 = JSON.parse(JSON.stringify(checkpoint));
  v7.algorithmVersion = "hidden-info-balance-v7-recon-state-fidelity";
  assert.throws(() => validateCrossTierCheckpoint(v7, OPTIONS), /algorithm/i);

  const v8 = JSON.parse(JSON.stringify(checkpoint));
  v8.algorithmVersion = "hidden-info-balance-v8-legal-world-posterior";
  assert.throws(() => validateCrossTierCheckpoint(v8, OPTIONS), /algorithm/i);

  const v9 = JSON.parse(JSON.stringify(checkpoint));
  v9.algorithmVersion = "hidden-info-balance-v9-public-history-fidelity";
  assert.throws(() => validateCrossTierCheckpoint(v9, OPTIONS), /algorithm/i);

  const v10 = JSON.parse(JSON.stringify(checkpoint));
  v10.algorithmVersion = "hidden-info-balance-v10-production-timing-stratified";
  assert.throws(() => validateCrossTierCheckpoint(v10, OPTIONS), /algorithm/i);

  const wrongRules = JSON.parse(JSON.stringify(checkpoint));
  wrongRules.engineRulesFingerprint = "older-engine-rules";
  assert.throws(() => validateCrossTierCheckpoint(wrongRules, OPTIONS), /engine rules/i);

  const missingOptions = JSON.parse(JSON.stringify(checkpoint));
  delete missingOptions.options;
  assert.throws(() => validateCrossTierCheckpoint(missingOptions, OPTIONS), /options/i);

  const forgedOptions = JSON.parse(JSON.stringify(checkpoint));
  forgedOptions.options.maxActions += 1;
  assert.throws(() => validateCrossTierCheckpoint(forgedOptions, OPTIONS), /options/i);

  const schedule = buildCrossTierExperimentSchedule(0);
  const inconsistent = JSON.parse(JSON.stringify(checkpoint));
  inconsistent.completedGroupKeys.push(schedule[0].groupKey);
  inconsistent.cursor.groupIndex = 1;
  assert.throws(() => validateCrossTierCheckpoint(inconsistent, OPTIONS), /aggregate|ledger/i);

  const recorded = createCrossTierCheckpoint(OPTIONS);
  recordCrossTierScheduledMirrorGroup(
    recorded.aggregate,
    schedule[0],
    playCrossTierScheduledMirrorGroup(schedule[0], OPTIONS),
    OPTIONS,
  );
  recorded.completedGroupKeys.push(schedule[0].groupKey);
  recorded.cursor.groupIndex = 1;
  const restored = JSON.parse(JSON.stringify(recorded));
  assert.doesNotThrow(() => validateCrossTierCheckpoint(restored, OPTIONS));
  assert.equal(
    schedule.filter((group) => !new Set(restored.completedGroupKeys).has(group.groupKey))[0].groupKey,
    schedule[1].groupKey,
  );

  const duplicate = JSON.parse(JSON.stringify(restored));
  duplicate.completedGroupKeys.push(schedule[0].groupKey);
  assert.throws(() => validateCrossTierCheckpoint(duplicate, OPTIONS), /duplicate/i);

  const missingLeg = JSON.parse(JSON.stringify(restored));
  missingLeg.aggregate.legResults.pop();
  assert.throws(() => validateCrossTierCheckpoint(missingLeg, OPTIONS), /aggregate|four-leg|raw-leg/i);

  const extraLeg = JSON.parse(JSON.stringify(restored));
  extraLeg.aggregate.legResults.push(structuredClone(extraLeg.aggregate.legResults[0]));
  assert.throws(() => validateCrossTierCheckpoint(extraLeg, OPTIONS), /raw-leg/i);

  for (const removeField of [
    (leg: Record<string, unknown>) => delete leg.finalClockMs,
    (leg: Record<string, unknown>) => delete leg.finishReason,
    (leg: Record<string, unknown>) => delete leg.drawReason,
    (leg: Record<string, unknown>) => {
      const focal = leg.focal as { black: Record<string, unknown> };
      return delete focal.black.triggers;
    },
    (leg: Record<string, unknown>) => {
      const focal = leg.focal as { black: Record<string, unknown> };
      return delete focal.black.opportunity;
    },
    (leg: Record<string, unknown>) => delete leg.capped,
    (leg: Record<string, unknown>) => delete leg.secondDraftStartedAtMove,
  ]) {
    const missingRawField = JSON.parse(JSON.stringify(restored));
    removeField(missingRawField.aggregate.legResults[0]);
    assert.throws(
      () => validateCrossTierCheckpoint(missingRawField, OPTIONS),
      /missing or unexpected fields/i,
    );
  }

  const forgedCompleteGroups = JSON.parse(JSON.stringify(restored));
  forgedCompleteGroups.aggregate.completeGroups = 999;
  assert.throws(() => validateCrossTierCheckpoint(forgedCompleteGroups, OPTIONS), /rebuild/i);

  const forgedCardScores = JSON.parse(JSON.stringify(restored));
  forgedCardScores.aggregate.cardScores[schedule[0].higherCard] = [1];
  assert.throws(() => validateCrossTierCheckpoint(forgedCardScores, OPTIONS), /rebuild/i);

  for (const mutateMetadata of [
    (leg: CrossTierLegResult) => {
      leg.comparisonKey = "forged-comparison";
    },
    (leg: CrossTierLegResult) => {
      leg.pairKey = "forged-pair";
    },
    (leg: CrossTierLegResult) => {
      leg.scheduleOrdinal += 1;
    },
  ]) {
    const forgedMetadata = structuredClone(restored);
    mutateMetadata(forgedMetadata.aggregate.legResults[0]);
    assert.throws(() => validateCrossTierCheckpoint(forgedMetadata, OPTIONS), /scheduled group/i);
  }

  for (const mutateFocal of [
    (leg: CrossTierLegResult) => {
      leg.focal.black.augmentId =
        leg.focal.black.augmentId === schedule[0].higherCard
          ? schedule[0].lowerCard
          : schedule[0].higherCard;
    },
    (leg: CrossTierLegResult) => {
      leg.focal.black.profile = leg.focal.black.profile === "higher" ? "lower" : "higher";
    },
    (leg: CrossTierLegResult) => {
      leg.focal.black.round = leg.focal.black.round === 1 ? 2 : 1;
    },
  ]) {
    const forgedFocal = structuredClone(restored);
    mutateFocal(forgedFocal.aggregate.legResults[0]);
    assert.throws(() => validateCrossTierCheckpoint(forgedFocal, OPTIONS), /scheduled treatment/i);
  }

  const clockedLegacyRaw = structuredClone(restored);
  clockedLegacyRaw.aggregate.legResults[0].finalClockMs = { black: 1, white: 1 };
  assert.throws(
    () => validateCrossTierCheckpoint(clockedLegacyRaw, OPTIONS),
    /must not retain a simulation clock/i,
  );

  const forgedCheckpointSeed = structuredClone(restored);
  forgedCheckpointSeed.seed += 1;
  assert.throws(() => validateCrossTierCheckpoint(forgedCheckpointSeed, OPTIONS), /checkpoint seed/i);

  const mismatchedSeed = JSON.parse(JSON.stringify(restored));
  mismatchedSeed.aggregate.legResults[0].pairedSeed += 1;
  assert.throws(() => validateCrossTierCheckpoint(mismatchedSeed, OPTIONS), /seed/i);

  const forgedSeedLedger = JSON.parse(JSON.stringify(restored));
  const forgedSeed = forgedSeedLedger.aggregate.legResults[0].pairedSeed + 1;
  for (const leg of forgedSeedLedger.aggregate.legResults) leg.pairedSeed = forgedSeed;
  forgedSeedLedger.aggregate.pairedSeeds[schedule[0].groupKey] = forgedSeed;
  assert.throws(() => validateCrossTierCheckpoint(forgedSeedLedger, OPTIONS), /schedule seed/i);

  const contradictoryStop = JSON.parse(JSON.stringify(restored));
  const contradictoryLeg = contradictoryStop.aggregate.legResults[0];
  contradictoryLeg.finished = true;
  contradictoryLeg.finishReason = "flag";
  contradictoryLeg.winner = "black";
  contradictoryLeg.winningProfile = contradictoryLeg.leg.blackProfile;
  contradictoryLeg.capped = true;
  assert.throws(() => validateCrossTierCheckpoint(contradictoryStop, OPTIONS), /cannot also be capped/i);

  const forgedCanonicalLegs = JSON.parse(JSON.stringify(restored));
  for (const leg of forgedCanonicalLegs.aggregate.legResults) {
    leg.leg.blackProfile = "higher";
    leg.leg.whiteProfile = "lower";
    leg.leg.firstTurn = "black";
  }
  assert.throws(() => validateCrossTierCheckpoint(forgedCanonicalLegs, OPTIONS), /canonical color/i);

  const recordedTwo = createCrossTierCheckpoint(OPTIONS);
  for (const group of schedule.slice(0, 2)) {
    recordCrossTierScheduledMirrorGroup(
      recordedTwo.aggregate,
      group,
      playCrossTierScheduledMirrorGroup(group, OPTIONS),
      OPTIONS,
    );
    recordedTwo.completedGroupKeys.push(group.groupKey);
    recordedTwo.cursor.groupIndex += 1;
  }
  assert.doesNotThrow(() => validateCrossTierCheckpoint(recordedTwo, OPTIONS));
  const duplicateRawGroup = structuredClone(recordedTwo);
  duplicateRawGroup.aggregate.legResults.splice(
    4,
    4,
    ...structuredClone(duplicateRawGroup.aggregate.legResults.slice(0, 4)),
  );
  assert.throws(() => validateCrossTierCheckpoint(duplicateRawGroup, OPTIONS), /scheduled group/i);

  const staleTiming = JSON.parse(JSON.stringify(restored));
  staleTiming.aggregate.legResults[0].secondDraftStartedAtMove = 0;
  assert.throws(() => validateCrossTierCheckpoint(staleTiming, OPTIONS), /timing/i);

  const badCursor = JSON.parse(JSON.stringify(checkpoint));
  badCursor.cursor.groupIndex = -1;
  assert.throws(() => validateCrossTierCheckpoint(badCursor, OPTIONS), /cursor/i);

  const staleMetrics = JSON.parse(JSON.stringify(checkpoint));
  delete staleMetrics.aggregate.passExtraMoves;
  assert.throws(() => validateCrossTierCheckpoint(staleMetrics, OPTIONS), /rebuild/i);
});
