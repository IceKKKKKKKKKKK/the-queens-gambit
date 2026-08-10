import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  AUGMENT_CATALOG,
  AUGMENT_CATALOG_VERSION,
  AUGMENT_IDS,
  AUGMENT_SUITS,
  LEGACY_AUGMENT_CATALOG_VERSION,
  LEGACY_AUGMENT_IDS,
  beginSecondAugmentDraft,
  chooseAndLockAugment,
  createAugmentDraftState,
  createSeededAugmentRandom,
  getAugmentDefinition,
  getAugmentsBySuit,
  refreshAugmentOption,
  revealCurrentAugmentRound,
  type AugmentDraftState,
  type AugmentId,
  type AugmentOptions,
  type AugmentSuit,
} from "../lib/augments.ts";
import {
  AUGMENT_RULES_VERSION,
  AUGMENT_DRAFT_TIMEOUT_MS,
  CLASSIC_RULES_VERSION,
  LEGACY_AUGMENT_RULES_VERSION,
  THREEFOLD_REPETITION_RULES_FINGERPRINT,
  THREEFOLD_REPETITION_THRESHOLD,
  GameRuleError,
  RANKED_INCREMENT_MS,
  RANKED_INCREMENT_THRESHOLD_MS,
  RANKED_TIME_CONTROL_MINUTES,
  applySetupDraftPlacement,
  applyPlayerAction,
  adjudicateThreefoldRepetition,
  buildReplayFrames,
  createAugmentGame,
  createInitialGame,
  createSetupDraft,
  gameModeForState,
  getAugmentMoveViolation,
  getProjectedAugmentReconTargets,
  getProjectedSetupSwapViolation,
  getSetupDraftPlacementViolation,
  isValidRepetitionTrackerForState,
  isAllowedSetupPosition,
  movementAnimationForTransition,
  projectGame,
  seedRepetitionTrackerFromCurrentPosition,
  settleExpiredAugmentDraft,
  setupDraftToLayout,
  validateSideSetup,
  type GameClock,
  type GameState,
  type Piece,
  type PieceType,
  type PlayerAction,
  type Position,
  type Side,
} from "../lib/game.ts";

const ALL_AUGMENT_IDS = AUGMENT_IDS;
const NEW_AUGMENT_EXECUTION_LEDGER = {
  "spade-rail-dominion": "active_movement",
  "spade-serpentine-offensive": "active_movement",
  "spade-deep-strike": "active_movement",
  "spade-global-redeployment": "active_movement",
  "spade-command-chain": "extra_action",
  "spade-counteroffensive": "extra_action",
  "spade-shadow-retreat": "combat_replacement",
  "spade-supreme-recon": "private_recon",
  "heart-mobile-rail": "active_movement",
  "heart-double-turn": "active_movement",
  "heart-breakthrough": "active_movement",
  "heart-camp-network": "active_movement",
  "heart-victory-momentum": "extra_action",
  "heart-orderly-withdrawal": "combat_replacement",
  "heart-wide-recon": "temporary_recon",
  "heart-reserve-clock": "clock",
  "club-rail-passage": "active_movement",
  "club-rail-switch": "active_movement",
  "club-road-patrol": "active_movement",
  "club-camp-relay": "active_movement",
  "club-local-recon": "temporary_recon",
  "club-pocket-time": "clock",
  "club-engineer-oath": "combat_replacement",
  "diamond-road-step": "active_movement",
  "diamond-camp-relay": "active_movement",
  "diamond-front-watch": "temporary_recon",
  "diamond-pocket-watch": "clock",
  "diamond-drill": "clock",
  "diamond-forward-pair": "setup",
  "diamond-deep-pair": "setup",
} as const satisfies Partial<Record<AugmentId, string>>;

const SAFE_WHITE_SELECTION: Record<AugmentSuit, AugmentId> = {
  spades: "spade-grand-maneuver",
  hearts: "heart-rail-turn",
  clubs: "club-forced-march",
  diamonds: "diamond-camp-transfer",
};

function piece(id: string, side: Side, type: PieceType, row: number, col: number): Piece {
  return { id, side, type, row, col, alive: true };
}

function expectRuleError(state: GameState, side: Side, action: PlayerAction, code: string) {
  assert.throws(
    () => applyPlayerAction(state, side, action, 10_000),
    (error: unknown) => error instanceof GameRuleError && error.code === code,
  );
}

function optionsWith(first: AugmentId, roundNumber: 1 | 2 = 1): AugmentOptions {
  const suit = getAugmentDefinition(first).suit;
  return [
    first,
    ...getAugmentsBySuit(suit)
      .map((augment) => augment.id)
      .filter(
        (id) =>
          id !== first &&
          (roundNumber === 1 || getAugmentDefinition(id).activation !== "setup"),
      )
      .slice(0, 2),
  ] as AugmentOptions;
}

function openingDraft(blackId: AugmentId): AugmentDraftState {
  const suit = getAugmentDefinition(blackId).suit;
  const blackOptions = optionsWith(blackId);
  const whiteOptions = optionsWith(SAFE_WHITE_SELECTION[suit]);
  return {
    catalogVersion: AUGMENT_CATALOG_VERSION,
    activeRound: 1,
    rounds: [
      {
        number: 1,
        trigger: "setup",
        suit,
        revealed: false,
        players: {
          black: {
            options: blackOptions,
            selectedId: null,
            locked: false,
            refreshedSlot: null,
          },
          white: {
            options: whiteOptions,
            selectedId: null,
            locked: false,
            refreshedSlot: null,
          },
        },
      },
    ],
    seenBySide: { black: [...blackOptions], white: [...whiteOptions] },
    loadouts: { black: [], white: [] },
  };
}

function lockOpeningSelections(blackId: AugmentId) {
  const suit = getAugmentDefinition(blackId).suit;
  let state = createAugmentGame();
  state.augment!.draft = openingDraft(blackId);
  state = applyPlayerAction(state, "black", { type: "augment_select", augmentId: blackId });
  state = applyPlayerAction(state, "black", { type: "augment_lock" });
  const whiteId = SAFE_WHITE_SELECTION[suit];
  state = applyPlayerAction(state, "white", { type: "augment_select", augmentId: whiteId });
  state = applyPlayerAction(state, "white", { type: "augment_lock" });
  return state;
}

function startWithOpeningAugment(blackId: AugmentId, nowMs = 1_000) {
  let state = lockOpeningSelections(blackId);
  state = applyPlayerAction(state, "black", { type: "ready", value: true }, nowMs);
  state = applyPlayerAction(state, "white", { type: "ready", value: true }, nowMs);
  return state;
}

function playingState({
  pieces,
  blackAugments = [],
  whiteAugments = [],
  turn = "black",
  moveNumber = 0,
  ranked = false,
  clock = null,
}: {
  pieces: Piece[];
  blackAugments?: AugmentId[];
  whiteAugments?: AugmentId[];
  turn?: Side;
  moveNumber?: number;
  ranked?: boolean;
  clock?: GameClock | null;
}): GameState {
  const state = createAugmentGame({ ranked });
  state.phase = "playing";
  state.joined = { black: true, white: true };
  state.ready = { black: true, white: true };
  state.firstTurn = turn;
  state.turn = turn;
  state.winner = null;
  state.finishReason = null;
  state.pieces = pieces;
  state.events = [];
  state.moveNumber = moveNumber;
  state.replay = null;
  state.clock = clock;
  state.augment!.draft.loadouts = {
    black: [...blackAugments],
    white: [...whiteAugments],
  };
  return state;
}

function setRevealedBlackLoadout(
  state: GameState,
  blackAugments: AugmentId[],
  whiteAugments: AugmentId[] = blackAugments.map(
    (id) => SAFE_WHITE_SELECTION[getAugmentDefinition(id).suit],
  ),
) {
  assert.equal(whiteAugments.length, blackAugments.length);
  const rounds = blackAugments.map((blackId, index) => {
    const suit = getAugmentDefinition(blackId).suit;
    const whiteId = whiteAugments[index];
    assert.equal(getAugmentDefinition(whiteId).suit, suit);
    const roundNumber = (index + 1) as 1 | 2;
    const blackOptions = optionsWith(blackId, roundNumber);
    const whiteOptions = optionsWith(whiteId, roundNumber);
    return {
      number: roundNumber,
      trigger: index === 0 ? "setup" as const : "move_10" as const,
      suit,
      revealed: true,
      players: {
        black: {
          options: blackOptions,
          selectedId: blackId,
          locked: true,
          refreshedSlot: null,
        },
        white: {
          options: whiteOptions,
          selectedId: whiteId,
          locked: true,
          refreshedSlot: null,
        },
      },
    };
  });
  state.augment!.draft = {
    catalogVersion: AUGMENT_CATALOG_VERSION,
    activeRound: null,
    rounds,
    seenBySide: {
      black: rounds.flatMap((round) => round.players.black.options),
      white: rounds.flatMap((round) => round.players.white.options),
    },
    loadouts: {
      black: [...blackAugments],
      white: rounds.map((round) => round.players.white.selectedId),
    },
  };
  return state;
}

const REVERSIBLE_CYCLE = [
  ["black", { row: 3, col: 0 }, { row: 4, col: 0 }],
  ["white", { row: 8, col: 4 }, { row: 7, col: 4 }],
  ["black", { row: 4, col: 0 }, { row: 3, col: 0 }],
  ["white", { row: 7, col: 4 }, { row: 8, col: 4 }],
] as const;

function repetitionReadyState(repetitionSalt = "deterministic-repetition-test-salt") {
  const state = playingState({
    pieces: [
      piece("black-shuttle", "black", "platoon", 3, 0),
      piece("white-shuttle", "white", "platoon", 8, 4),
    ],
    moveNumber: 10,
  });
  state.repetitionTracker = {
    salt: repetitionSalt,
    counts: {},
    lastCountedDigest: null,
    currentOccurrences: 0,
  };
  state.movedPieceIds = ["black-shuttle", "white-shuttle"];
  setRevealedBlackLoadout(
    state,
    ["heart-rail-turn", "club-rail-passage"],
    ["heart-rail-turn", "club-rail-passage"],
  );
  return state;
}

function applyReversibleCycle(state: GameState, startingNowMs = 1_000) {
  let next = state;
  for (const [index, [side, from, to]] of REVERSIBLE_CYCLE.entries()) {
    next = applyPlayerAction(next, side, { type: "move", from, to }, startingNowMs + index);
  }
  return next;
}

function swapPositions(first: Piece, second: Piece) {
  [first.row, second.row] = [second.row, first.row];
  [first.col, second.col] = [second.col, first.col];
}

function enterSecondDraft(nowMs = 1_000) {
  let state = startWithOpeningAugment("heart-rail-turn", nowMs);
  state.turn = "black";
  state.firstTurn = "black";
  state.moveNumber = 8;
  state.pieces = [
    piece("black-mover", "black", "platoon", 3, 0),
    piece("black-support", "black", "engineer", 8, 0),
    piece("white-mover", "white", "platoon", 8, 4),
    piece("white-support", "white", "engineer", 3, 4),
  ];
  state.replay = null;
  state.clock!.turnStartedAt = nowMs;
  state = applyPlayerAction(
    state,
    "black",
    { type: "move", from: { row: 3, col: 0 }, to: { row: 4, col: 0 } },
    nowMs,
  );
  assert.equal(state.phase, "augment_draft");
  return state;
}

function putNonReconOptionFirst(state: GameState, side: Side) {
  const round = state.augment!.draft.rounds[1];
  const index = round.players[side].options.findIndex(
    (id) => getAugmentDefinition(id).effect.kind !== "reconnaissance",
  );
  assert.notEqual(index, -1);
  const [option] = round.players[side].options.splice(index, 1);
  round.players[side].options.unshift(option);
  return option;
}

function forceSecondRoundSpades(state: GameState) {
  const round = state.augment!.draft.rounds[1];
  const previousOptions = {
    black: [...round.players.black.options],
    white: [...round.players.white.options],
  };
  const options: Record<Side, AugmentOptions> = {
    black: [
      "spade-total-intelligence",
      "spade-grand-maneuver",
      "spade-tactical-retreat",
    ],
    white: [
      "spade-grand-maneuver",
      "spade-tactical-retreat",
      "spade-strategic-reserve",
    ],
  };
  round.suit = "spades";
  for (const side of ["black", "white"] as const) {
    state.augment!.draft.seenBySide[side] = state.augment!.draft.seenBySide[side]
      .filter((id) => !previousOptions[side].includes(id));
    round.players[side] = {
      options: options[side],
      selectedId: null,
      locked: false,
      refreshedSlot: null,
    };
    state.augment!.draft.seenBySide[side].push(...options[side]);
  }
  return round;
}

test("the augment engine coverage ledger names every one of the fifty cards", () => {
  assert.deepEqual([...ALL_AUGMENT_IDS].sort(), AUGMENT_CATALOG.map((augment) => augment.id).sort());
});

test("classic remains the default ruleset and rejects every augment-only action", () => {
  const classic = createInitialGame();
  assert.equal(classic.rulesVersion, CLASSIC_RULES_VERSION);
  assert.equal(gameModeForState(classic), "classic");
  assert.equal("augment" in classic, false);
  assert.equal(classic.clock?.incrementMs, undefined);
  assert.equal(validateSideSetup(classic.pieces, "black"), true);
  assert.equal(validateSideSetup(classic.pieces, "white"), true);
  expectRuleError(
    classic,
    "black",
    { type: "augment_select", augmentId: "spade-grand-maneuver" },
    "AUGMENT_MODE_REQUIRED",
  );

  const upgraded = createAugmentGame();
  assert.equal(upgraded.rulesVersion, AUGMENT_RULES_VERSION);
  assert.equal(gameModeForState(upgraded), "augment");
  assert.ok(upgraded.augment);
  assert.ok(upgraded.repetitionTracker);
  assert.equal(upgraded.repetitionTracker?.currentOccurrences, 0);
});

test("the v2 repetition contract is versioned while legacy augment rooms stay executable", () => {
  assert.equal(AUGMENT_RULES_VERSION, "augment-duel-dark-v2");
  assert.equal(LEGACY_AUGMENT_RULES_VERSION, "augment-duel-dark-v1");
  assert.equal(THREEFOLD_REPETITION_THRESHOLD, 3);
  assert.equal(
    THREEFOLD_REPETITION_RULES_FINGERPRINT,
    "augment-duel-dark-v2:threefold-3:strategic-sha256-v1",
  );
  const deterministic = createAugmentGame({ repetitionSalt: "paired-seed-17" });
  assert.equal(deterministic.repetitionTracker?.salt, "paired-seed-17");
  const legacy = JSON.parse(JSON.stringify(deterministic)) as GameState;
  legacy.rulesVersion = LEGACY_AUGMENT_RULES_VERSION;
  delete legacy.repetitionTracker;
  assert.equal(gameModeForState(legacy), "augment");
  assert.equal(isValidRepetitionTrackerForState(legacy), true);
  assert.equal(projectGame(legacy, "black").repetition, null);
});

test("the synchronous strategic digest matches standard SHA-256 over the audited canonical schema", () => {
  const state = repetitionReadyState("sha256-oracle-salt");
  const canonical = JSON.stringify({
    turn: "black",
    pieces: [
      ["black-shuttle", "black", "platoon", true, 3, 0],
      ["white-shuttle", "white", "platoon", true, 8, 4],
    ],
    revealedFlags: [false, false],
    movedPieceIds: ["black-shuttle", "white-shuttle"],
    augment: {
      catalogVersion: AUGMENT_CATALOG_VERSION,
      loadouts: [
        ["heart-rail-turn", "club-rail-passage"],
        ["heart-rail-turn", "club-rail-passage"],
      ],
      triggerCounts: [[], []],
      permanentReveals: [[], []],
      temporaryReveals: [[], []],
      extraMove: [null, null],
    },
  });
  const expected = createHash("sha256")
    .update(`sha256-oracle-salt\0${canonical}`)
    .digest("hex");
  adjudicateThreefoldRepetition(state);
  assert.equal(state.repetitionTracker?.lastCountedDigest, expected);
});

test("legacy augment v1 never adjudicates repetition through one hundred reversible plies", () => {
  let state = repetitionReadyState();
  state.rulesVersion = LEGACY_AUGMENT_RULES_VERSION;
  delete state.repetitionTracker;
  for (let cycle = 0; cycle < 25; cycle += 1) {
    state = applyReversibleCycle(state, 2_000 + cycle * 10);
  }
  assert.equal(state.moveNumber, 110);
  assert.equal(state.phase, "playing");
  assert.equal(state.finishReason, null);
  assert.equal(state.events.some((event) => event.result === "draw_repetition"), false);
  assert.equal(state.replay?.moves.length, 100);
});

test("augment v2 ends on the third fully settled strategic occurrence and preserves replay", () => {
  let state = repetitionReadyState();
  state.clock = {
    initialMs: 600_000,
    remainingMs: { black: 600_000, white: 600_000 },
    turnStartedAt: 1_000,
  };
  state.augment!.draftDeadlineAt = 999_999;
  assert.equal(adjudicateThreefoldRepetition(state), false);
  assert.equal(state.repetitionTracker?.currentOccurrences, 1);
  const firstDigest = state.repetitionTracker?.lastCountedDigest;
  assert.match(firstDigest ?? "", /^[a-f0-9]{64}$/);
  assert.equal(adjudicateThreefoldRepetition(state), false);
  assert.equal(state.repetitionTracker?.currentOccurrences, 1);
  assert.equal(Object.keys(state.repetitionTracker?.counts ?? {}).length, 1);

  state = applyReversibleCycle(state, 2_000);
  assert.equal(state.phase, "playing");
  assert.equal(state.repetitionTracker?.currentOccurrences, 2);
  assert.equal(state.repetitionTracker?.lastCountedDigest, firstDigest);
  state = applyReversibleCycle(state, 3_000);

  assert.equal(state.phase, "finished");
  assert.equal(state.winner, null);
  assert.equal(state.finishReason, "draw");
  assert.equal(state.drawReason, "threefold_repetition");
  assert.equal(state.repetitionTracker?.currentOccurrences, 3);
  assert.equal(state.events.at(-1)?.result, "draw_repetition");
  assert.equal(state.clock?.turnStartedAt, null);
  assert.equal(state.augment?.draftDeadlineAt, null);
  assert.equal(state.replay?.moves.length, 8);
  assert.equal(buildReplayFrames(state.replay).length, 9);
  const projected = projectGame(state, "black", 4_000);
  assert.deepEqual(projected.repetition, {
    threshold: 3,
    currentOccurrences: 3,
    active: false,
  });
  expectRuleError(
    state,
    "black",
    { type: "move", from: { row: 3, col: 0 }, to: { row: 4, col: 0 } },
    "GAME_FINISHED",
  );
});

test("clocks, move numbers, replay, events, and private draft bookkeeping do not change the digest", () => {
  const state = repetitionReadyState();
  adjudicateThreefoldRepetition(state);
  const originalTracker = JSON.parse(JSON.stringify(state.repetitionTracker));
  const ignored = JSON.parse(JSON.stringify(state)) as GameState;
  ignored.firstTurn = "white";
  ignored.moveNumber = 9_999;
  ignored.events = [{ id: 800, actor: "white", result: "ready" }];
  ignored.replay = {
    baselineMoveNumber: 8_000,
    partial: true,
    initialPieces: [],
    moves: [],
  };
  ignored.clock = {
    initialMs: 60_000,
    remainingMs: { black: 1, white: 59_999 },
    turnStartedAt: 123_456,
  };
  ignored.augment!.usedBySide.black = ["heart-rail-turn"];
  ignored.augment!.resumeTurn = "white";
  ignored.augment!.draftDeadlineAt = 987_654;
  ignored.augment!.draft.seenBySide.black.reverse();
  ignored.augment!.draft.rounds[0].players.black.options.reverse();
  assert.equal(adjudicateThreefoldRepetition(ignored), false);
  assert.deepEqual(ignored.repetitionTracker, originalTracker);
});

test("turn, pieces, moved identities, loadout order, triggers, reveals, flags, and extra moves split positions", () => {
  const baseline = repetitionReadyState();
  adjudicateThreefoldRepetition(baseline);
  const originalDigest = baseline.repetitionTracker!.lastCountedDigest;
  const cases: Array<[string, (state: GameState) => void]> = [
    ["turn", (state) => { state.turn = "white"; }],
    ["piece", (state) => { state.pieces[0].row += 1; }],
    ["movedPieceIds", (state) => { state.movedPieceIds!.push("new-public-mover"); }],
    ["catalog", (state) => { state.augment!.draft.catalogVersion = LEGACY_AUGMENT_CATALOG_VERSION; }],
    ["loadout order", (state) => { state.augment!.draft.loadouts.black.reverse(); }],
    ["trigger count", (state) => { state.augment!.triggerCounts.black["heart-rail-turn"] = 1; }],
    ["flag reveal", (state) => { state.revealedFlags.white = true; }],
    ["permanent recon", (state) => { state.augment!.permanentReveals.black.push("white-shuttle"); }],
    ["temporary recon", (state) => { state.augment!.temporaryReveals.black.push("white-shuttle"); }],
    [
      "extra move",
      (state) => {
        state.augment!.extraMove.black = {
          augmentId: "heart-initiative",
          excludedPieceId: "black-shuttle",
        };
      },
    ],
  ];
  for (const [label, mutate] of cases) {
    const changed = JSON.parse(JSON.stringify(baseline)) as GameState;
    mutate(changed);
    assert.equal(adjudicateThreefoldRepetition(changed), false, label);
    assert.notEqual(changed.repetitionTracker?.lastCountedDigest, originalDigest, label);
    assert.equal(Object.keys(changed.repetitionTracker?.counts ?? {}).length, 2, label);
    assert.equal(changed.repetitionTracker?.currentOccurrences, 1, label);
  }
});

test("draft and pending reconnaissance phases never count an occurrence", () => {
  const draft = repetitionReadyState();
  draft.phase = "augment_draft";
  draft.augment!.draft.activeRound = 2;
  assert.equal(adjudicateThreefoldRepetition(draft), false);
  assert.equal(draft.repetitionTracker?.currentOccurrences, 0);

  const recon = repetitionReadyState();
  recon.augment!.pendingRecon.black = {
    augmentId: "heart-targeted-recon",
    remaining: 1,
  };
  assert.equal(adjudicateThreefoldRepetition(recon), false);
  assert.equal(recon.repetitionTracker?.currentOccurrences, 0);
  assert.equal(projectGame(recon, "black").repetition?.active, false);
});

test("manual and timed-out second-round reveals establish the first count exactly once", () => {
  let manual = enterSecondDraft(10_000);
  const manualBlack = putNonReconOptionFirst(manual, "black");
  const manualWhite = putNonReconOptionFirst(manual, "white");
  assert.equal(manual.repetitionTracker?.currentOccurrences, 0);
  manual = applyPlayerAction(manual, "black", {
    type: "augment_select",
    augmentId: manualBlack,
  }, 10_100);
  manual = applyPlayerAction(manual, "black", { type: "augment_lock" }, 10_100);
  manual = applyPlayerAction(manual, "white", {
    type: "augment_select",
    augmentId: manualWhite,
  }, 10_200);
  manual = applyPlayerAction(manual, "white", { type: "augment_lock" }, 10_200);
  assert.equal(manual.phase, "playing");
  assert.equal(manual.augment?.draft.activeRound, null);
  assert.equal(manual.augment?.draft.rounds[1].revealed, true);
  assert.equal(manual.repetitionTracker?.currentOccurrences, 1);
  const manualDigest = manual.repetitionTracker?.lastCountedDigest;
  assert.equal(adjudicateThreefoldRepetition(manual), false);
  assert.equal(manual.repetitionTracker?.lastCountedDigest, manualDigest);
  assert.equal(manual.repetitionTracker?.currentOccurrences, 1);

  const timedOut = enterSecondDraft(20_000);
  putNonReconOptionFirst(timedOut, "black");
  putNonReconOptionFirst(timedOut, "white");
  timedOut.augment!.draftDeadlineAt = 20_500;
  assert.equal(settleExpiredAugmentDraft(timedOut, 20_500), true);
  assert.equal(timedOut.phase, "playing");
  assert.equal(timedOut.augment?.draft.activeRound, null);
  assert.equal(timedOut.repetitionTracker?.currentOccurrences, 1);
  const countEntries = Object.entries(timedOut.repetitionTracker?.counts ?? {});
  assert.equal(countEntries.length, 1);
  assert.equal(countEntries[0]?.[1], 1);
});

test("the final mandatory reconnaissance pick is the first eligible count boundary", () => {
  const state = repetitionReadyState();
  setRevealedBlackLoadout(
    state,
    ["club-forced-march", "heart-targeted-recon"],
    ["club-forced-march", "heart-targeted-recon"],
  );
  state.augment!.pendingRecon.black = {
    augmentId: "heart-targeted-recon",
    remaining: 1,
  };
  assert.equal(adjudicateThreefoldRepetition(state), false);
  assert.equal(state.repetitionTracker?.currentOccurrences, 0);
  const resolved = applyPlayerAction(state, "black", {
    type: "augment_recon",
    augmentId: "heart-targeted-recon",
    target: { row: 8, col: 4 },
  });
  assert.equal(resolved.augment?.pendingRecon.black, null);
  assert.deepEqual(resolved.augment?.permanentReveals.black, ["white-shuttle"]);
  assert.equal(resolved.repetitionTracker?.currentOccurrences, 1);
  assert.equal(projectGame(resolved, "black").repetition?.active, true);
});

test("active movement, exchange, and extra-pass actions all invoke the unified adjudicator", () => {
  const movement = playingState({
    pieces: [
      piece("mover", "black", "platoon", 1, 2),
      piece("white", "white", "platoon", 8, 4),
    ],
    moveNumber: 10,
  });
  setRevealedBlackLoadout(
    movement,
    ["spade-grand-maneuver", "heart-rail-turn"],
    ["spade-grand-maneuver", "heart-rail-turn"],
  );
  movement.movedPieceIds = ["mover", "white"];
  adjudicateThreefoldRepetition(movement);
  const moved = applyPlayerAction(movement, "black", {
    type: "augment_move",
    augmentId: "spade-grand-maneuver",
    from: { row: 1, col: 2 },
    to: { row: 5, col: 0 },
  });
  assert.equal(Object.keys(moved.repetitionTracker?.counts ?? {}).length, 2);
  assert.equal(moved.repetitionTracker?.currentOccurrences, 1);

  const exchange = playingState({
    pieces: [
      piece("first", "black", "platoon", 3, 0),
      piece("second", "black", "platoon", 8, 0),
      piece("white", "white", "platoon", 8, 4),
    ],
    moveNumber: 10,
  });
  setRevealedBlackLoadout(
    exchange,
    ["heart-remote-exchange", "club-rail-passage"],
    ["heart-remote-exchange", "club-rail-passage"],
  );
  exchange.movedPieceIds = ["first", "second", "white"];
  adjudicateThreefoldRepetition(exchange);
  const exchanged = applyPlayerAction(exchange, "black", {
    type: "augment_exchange",
    augmentId: "heart-remote-exchange",
    from: { row: 3, col: 0 },
    to: { row: 8, col: 0 },
  });
  assert.equal(Object.keys(exchanged.repetitionTracker?.counts ?? {}).length, 2);
  assert.equal(exchanged.repetitionTracker?.currentOccurrences, 1);

  const extra = repetitionReadyState();
  extra.augment!.extraMove.black = {
    augmentId: "heart-initiative",
    excludedPieceId: "black-shuttle",
  };
  adjudicateThreefoldRepetition(extra);
  const passed = applyPlayerAction(extra, "black", { type: "pass_extra_move" });
  assert.equal(passed.augment?.extraMove.black, null);
  assert.equal(Object.keys(passed.repetitionTracker?.counts ?? {}).length, 2);
  assert.equal(passed.repetitionTracker?.currentOccurrences, 1);
});

test("same injected salt and sampled occurrence produce byte-identical deterministic results", () => {
  const sampled = repetitionReadyState("discarded-source-salt");
  const first = seedRepetitionTrackerFromCurrentPosition(sampled, 2, "paired-seed-99");
  const second = seedRepetitionTrackerFromCurrentPosition(sampled, 2, "paired-seed-99");
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(isValidRepetitionTrackerForState(first), true);
  const [side, from, to] = REVERSIBLE_CYCLE[0];
  const firstResult = applyPlayerAction(first, side, { type: "move", from, to }, 77_000);
  const secondResult = applyPlayerAction(second, side, { type: "move", from, to }, 77_000);
  assert.equal(JSON.stringify(firstResult), JSON.stringify(secondResult));

  const otherSalt = seedRepetitionTrackerFromCurrentPosition(sampled, 2, "paired-seed-100");
  assert.notEqual(
    otherSalt.repetitionTracker?.lastCountedDigest,
    first.repetitionTracker?.lastCountedDigest,
  );
  assert.deepEqual(projectGame(otherSalt, "black"), projectGame(first, "black"));
});

test("sampled tracker seeding preserves strict occurrence ranges in every v2 lifecycle phase", () => {
  const pending = repetitionReadyState("authoritative-pending-salt");
  pending.augment!.pendingRecon.black = {
    augmentId: "heart-targeted-recon",
    remaining: 1,
  };
  const firstPending = seedRepetitionTrackerFromCurrentPosition(
    pending,
    0,
    "sampled-pending-salt",
  );
  const secondPending = seedRepetitionTrackerFromCurrentPosition(
    pending,
    0,
    "sampled-pending-salt",
  );
  assert.equal(JSON.stringify(firstPending), JSON.stringify(secondPending));
  assert.deepEqual(firstPending.repetitionTracker, {
    salt: "sampled-pending-salt",
    counts: {},
    lastCountedDigest: null,
    currentOccurrences: 0,
  });
  assert.equal(isValidRepetitionTrackerForState(firstPending), true);
  assert.throws(
    () => seedRepetitionTrackerFromCurrentPosition(pending, 1, "invalid-pending-salt"),
    (error: unknown) =>
      error instanceof GameRuleError && error.code === "INVALID_REPETITION_OCCURRENCES",
  );

  const active = repetitionReadyState("authoritative-active-salt");
  adjudicateThreefoldRepetition(active);
  assert.throws(
    () => seedRepetitionTrackerFromCurrentPosition(active, 0, "invalid-active-salt"),
    (error: unknown) =>
      error instanceof GameRuleError && error.code === "INVALID_REPETITION_OCCURRENCES",
  );

  const ordinaryTerminal = structuredClone(active);
  ordinaryTerminal.phase = "finished";
  ordinaryTerminal.winner = "black";
  ordinaryTerminal.finishReason = "flag";
  const sampledTerminal = seedRepetitionTrackerFromCurrentPosition(
    ordinaryTerminal,
    1,
    "sampled-terminal-salt",
  );
  assert.equal(isValidRepetitionTrackerForState(sampledTerminal), true);
});

test("JSON recovery retains valid private evidence and malformed v2 trackers fail validation", () => {
  let state = repetitionReadyState();
  adjudicateThreefoldRepetition(state);
  state = applyReversibleCycle(state, 1_000);
  assert.equal(state.repetitionTracker?.currentOccurrences, 2);
  const restored = JSON.parse(JSON.stringify(state)) as GameState;
  assert.equal(isValidRepetitionTrackerForState(restored), true);
  const missing = JSON.parse(JSON.stringify(restored)) as GameState;
  delete missing.repetitionTracker;
  assert.equal(isValidRepetitionTrackerForState(missing), false);
  const malformed = JSON.parse(JSON.stringify(restored)) as GameState;
  malformed.repetitionTracker!.lastCountedDigest = "not-a-sha256-digest";
  assert.equal(isValidRepetitionTrackerForState(malformed), false);

  const finished = applyReversibleCycle(restored, 2_000);
  assert.equal(finished.finishReason, "draw");
  assert.equal(finished.drawReason, "threefold_repetition");
  assert.equal(isValidRepetitionTrackerForState(finished), true);
});

test("v2 recovery rejects impossible threshold and pre-adjudication repetition histories", () => {
  const thresholdPlaying = repetitionReadyState("threshold-recovery-salt");
  adjudicateThreefoldRepetition(thresholdPlaying);
  const thresholdDigest = thresholdPlaying.repetitionTracker!.lastCountedDigest!;
  thresholdPlaying.repetitionTracker!.counts[thresholdDigest] = THREEFOLD_REPETITION_THRESHOLD;
  thresholdPlaying.repetitionTracker!.currentOccurrences = THREEFOLD_REPETITION_THRESHOLD;
  assert.equal(isValidRepetitionTrackerForState(thresholdPlaying), false);
  assert.throws(
    () => adjudicateThreefoldRepetition(thresholdPlaying),
    (error: unknown) =>
      error instanceof GameRuleError && error.code === "INVALID_REPETITION_TRACKER",
  );

  const inactiveStates = [
    createAugmentGame({ repetitionSalt: "setup-recovery-salt" }),
    enterSecondDraft(30_000),
    (() => {
      const pendingRecon = repetitionReadyState("recon-recovery-salt");
      pendingRecon.augment!.pendingRecon.black = {
        augmentId: "heart-targeted-recon",
        remaining: 1,
      };
      return pendingRecon;
    })(),
  ];
  for (const [index, state] of inactiveStates.entries()) {
    const forgedDigest = String(index + 1).repeat(64);
    state.repetitionTracker = {
      salt: `inactive-recovery-${index}`,
      counts: { [forgedDigest]: 1 },
      lastCountedDigest: forgedDigest,
      currentOccurrences: 1,
    };
    assert.equal(isValidRepetitionTrackerForState(state), false, `inactive state ${index}`);
  }
});

test("v2 recovery requires a coherent threefold terminal while preserving ordinary terminals", () => {
  let drawn = repetitionReadyState("draw-recovery-salt");
  adjudicateThreefoldRepetition(drawn);
  drawn = applyReversibleCycle(drawn, 40_000);
  drawn = applyReversibleCycle(drawn, 50_000);
  assert.equal(drawn.finishReason, "draw");
  assert.equal(isValidRepetitionTrackerForState(drawn), true);

  const missingEvent = structuredClone(drawn);
  missingEvent.events = missingEvent.events.filter((event) => event.result !== "draw_repetition");
  assert.equal(isValidRepetitionTrackerForState(missingEvent), false);

  const missingReason = structuredClone(drawn);
  missingReason.drawReason = null;
  assert.equal(isValidRepetitionTrackerForState(missingReason), false);

  const impossibleEarlierThreshold = structuredClone(drawn);
  impossibleEarlierThreshold.repetitionTracker!.counts["e".repeat(64)] =
    THREEFOLD_REPETITION_THRESHOLD;
  assert.equal(isValidRepetitionTrackerForState(impossibleEarlierThreshold), false);

  const ordinaryTerminal = repetitionReadyState("ordinary-terminal-recovery-salt");
  adjudicateThreefoldRepetition(ordinaryTerminal);
  ordinaryTerminal.phase = "finished";
  ordinaryTerminal.winner = "black";
  ordinaryTerminal.finishReason = "flag";
  ordinaryTerminal.drawReason = null;
  assert.equal(ordinaryTerminal.repetitionTracker?.currentOccurrences, 1);
  assert.equal(isValidRepetitionTrackerForState(ordinaryTerminal), true);
});

test("every projection exposes progress but no salt, digest, count map, or history", () => {
  const state = seedRepetitionTrackerFromCurrentPosition(
    repetitionReadyState("private-source-salt"),
    2,
    "private-projection-salt",
  );
  for (const [viewer, options] of [
    ["black", undefined],
    ["white", undefined],
    ["spectator", { spectatorPolicy: "hidden", spectatorPerspective: "black" }],
    ["spectator", { spectatorPolicy: "full" }],
  ] as const) {
    const projected = projectGame(state, viewer, 1_000, options);
    assert.deepEqual(projected.repetition, {
      threshold: 3,
      currentOccurrences: 2,
      active: true,
    });
    const stack: unknown[] = [projected];
    while (stack.length) {
      const current = stack.pop();
      if (!current || typeof current !== "object") continue;
      for (const [key, child] of Object.entries(current)) {
        assert.equal(
          ["repetitionTracker", "salt", "counts", "lastCountedDigest", "digest", "history"].includes(key),
          false,
          `${viewer} leaked ${key}`,
        );
        stack.push(child);
      }
    }
  }
});

test("flag capture and timeout adjudication take precedence over a seeded repetition", () => {
  const candidate = repetitionReadyState();
  candidate.pieces = [
    piece("attacker", "black", "platoon", 6, 0),
    piece("flag", "white", "flag", 6, 1),
  ];
  candidate.movedPieceIds = ["attacker"];
  candidate.clock = {
    initialMs: 60_000,
    remainingMs: { black: 60_000, white: 60_000 },
    turnStartedAt: 1_000,
  };
  const capture = seedRepetitionTrackerFromCurrentPosition(candidate, 2, "priority-capture");
  const captured = applyPlayerAction(capture, "black", {
    type: "move",
    from: { row: 6, col: 0 },
    to: { row: 6, col: 1 },
  }, 1_001);
  assert.equal(captured.phase, "finished");
  assert.equal(captured.winner, "black");
  assert.equal(captured.finishReason, "flag");
  assert.equal(captured.drawReason, null);
  assert.equal(captured.repetitionTracker?.currentOccurrences, 2);
  assert.equal(captured.events.some((event) => event.result === "draw_repetition"), false);
  assert.equal(captured.replay?.moves.length, 1);

  const timeout = seedRepetitionTrackerFromCurrentPosition(
    repetitionReadyState(),
    2,
    "priority-timeout",
  );
  timeout.clock = {
    initialMs: 60_000,
    remainingMs: { black: 1, white: 60_000 },
    turnStartedAt: 10_000,
  };
  const timedOut = applyPlayerAction(timeout, "black", {
    type: "move",
    from: { row: 3, col: 0 },
    to: { row: 4, col: 0 },
  }, 10_001);
  assert.equal(timedOut.winner, "white");
  assert.equal(timedOut.finishReason, "timeout");
  assert.equal(timedOut.drawReason, null);
  assert.equal(timedOut.repetitionTracker?.currentOccurrences, 2);
  assert.equal(timedOut.events.at(-1)?.result, "timeout");
});

test("persisted v1 and v2 game runtimes round-trip through JSON and keep executable replays", () => {
  for (const scenario of [
    {
      version: LEGACY_AUGMENT_CATALOG_VERSION,
      id: "heart-bomb-disposal" as const,
      defender: "bomb" as const,
      attackerAlive: true,
      defenderAlive: false,
    },
    {
      version: AUGMENT_CATALOG_VERSION,
      id: "club-engineer-oath" as const,
      defender: "commander" as const,
      attackerAlive: false,
      defenderAlive: false,
    },
  ]) {
    const original = startWithOpeningAugment(scenario.id, 1_000);
    original.augment!.draft.catalogVersion = scenario.version;
    original.turn = "black";
    original.firstTurn = "black";
    original.pieces = [
      piece("attacker", "black", "engineer", 3, 0),
      piece("defender", "white", scenario.defender, 3, 1),
      piece("white-support", "white", "platoon", 8, 4),
    ];
    original.replay = null;
    original.clock!.turnStartedAt = 1_000;

    const restored = JSON.parse(JSON.stringify(original)) as GameState;
    assert.equal(projectGame(restored, "black", 1_000).augment?.draft.catalogVersion, scenario.version);
    const resolved = applyPlayerAction(
      restored,
      "black",
      { type: "move", from: { row: 3, col: 0 }, to: { row: 3, col: 1 } },
      1_000,
    );
    assert.equal(resolved.augment?.triggerCounts.black[scenario.id], 1, scenario.id);
    assert.equal(
      resolved.pieces.find((candidate) => candidate.id === "attacker")?.alive,
      scenario.attackerAlive,
      scenario.id,
    );
    assert.equal(
      resolved.pieces.find((candidate) => candidate.id === "defender")?.alive,
      scenario.defenderAlive,
      scenario.id,
    );

    const restoredResolved = JSON.parse(JSON.stringify(resolved)) as GameState;
    assert.deepEqual(restoredResolved.replay?.moves[0].augmentIds, [scenario.id]);
    const replayPieces = buildReplayFrames(restoredResolved.replay).at(-1)?.pieces ?? [];
    assert.equal(
      replayPieces.find((candidate) => candidate.id === "attacker")?.alive,
      scenario.attackerAlive,
      scenario.id,
    );
    assert.equal(
      replayPieces.find((candidate) => candidate.id === "defender")?.alive,
      scenario.defenderAlive,
      scenario.id,
    );
  }
});

test("opening selections stay private until both layouts lock, then reveal together", () => {
  let state = lockOpeningSelections("heart-rail-turn");
  state.augment!.triggerCounts.black["heart-rail-turn"] = 1;
  state.augment!.triggerCounts.white["heart-rail-turn"] = 1;
  assert.equal(state.augment?.draft.rounds[0].revealed, false);
  const privateBlack = projectGame(state, "black");
  const privateWhite = projectGame(state, "white");
  const privateSpectator = projectGame(state, "spectator");
  assert.equal(
    privateWhite.augment?.draft.rounds[0].players.black.selectedId,
    null,
  );
  assert.equal(
    privateSpectator.augment?.draft.rounds[0].players.black.selectedId,
    null,
  );
  assert.equal(privateBlack.augment?.triggerCounts.black["heart-rail-turn"], 1);
  assert.equal(privateBlack.augment?.triggerCounts.white["heart-rail-turn"], undefined);
  assert.equal(privateWhite.augment?.triggerCounts.black["heart-rail-turn"], undefined);
  assert.equal(privateWhite.augment?.triggerCounts.white["heart-rail-turn"], 1);
  assert.equal(privateSpectator.augment?.triggerCounts.black["heart-rail-turn"], undefined);
  assert.equal(privateSpectator.augment?.triggerCounts.white["heart-rail-turn"], undefined);

  state = applyPlayerAction(state, "black", { type: "ready", value: true }, 1_000);
  assert.equal(state.phase, "setup");
  assert.equal(
    projectGame(state, "white").augment?.draft.rounds[0].players.black.selectedId,
    null,
  );

  state = applyPlayerAction(state, "white", { type: "ready", value: true }, 1_000);
  const spectator = projectGame(state, "spectator", 1_000);
  assert.equal(state.phase, "playing");
  assert.equal(spectator.augment?.draft.rounds[0].revealed, true);
  assert.equal(
    spectator.augment?.draft.rounds[0].players.black.selectedId,
    "heart-rail-turn",
  );
  assert.equal(
    spectator.augment?.draft.rounds[0].players.white.selectedId,
    "heart-rail-turn",
  );
  for (const viewer of [
    projectGame(state, "black", 1_000),
    projectGame(state, "white", 1_000),
    projectGame(state, "spectator", 1_000),
    projectGame(state, "spectator", 1_000, { spectatorPolicy: "hidden" }),
  ]) {
    assert.equal(viewer.augment?.triggerCounts.black["heart-rail-turn"], 1);
    assert.equal(viewer.augment?.triggerCounts.white["heart-rail-turn"], 1);
  }
});

test("refresh is one-slot-per-round, clears a replaced selection, and never repeats a seen card", () => {
  let state = createAugmentGame();
  state.augment!.draft = openingDraft("club-forced-march");
  const playerBefore = state.augment!.draft.rounds[0].players.black;
  const replaced = playerBefore.options[1];
  const seenBefore = [...state.augment!.draft.seenBySide.black];
  state = applyPlayerAction(state, "black", { type: "augment_select", augmentId: replaced });
  state = applyPlayerAction(state, "black", { type: "augment_refresh", slot: 1 });
  const playerAfter = state.augment!.draft.rounds[0].players.black;
  assert.equal(playerAfter.selectedId, null);
  assert.equal(playerAfter.refreshedSlot, 1);
  assert.equal(state.augment!.draft.seenBySide.black.length, 4);
  assert.ok(seenBefore.every((id) => state.augment!.draft.seenBySide.black.includes(id)));
  assert.ok(!seenBefore.includes(playerAfter.options[1]));
  expectRuleError(state, "black", { type: "augment_refresh", slot: 0 }, "REFRESH_ALREADY_USED");
});

test("play pauses after nine completed moves, before move ten, for a fresh shared-tier draft", () => {
  let state = startWithOpeningAugment("heart-rail-turn", 1_000);
  const firstRound = state.augment!.draft.rounds[0];
  const firstSeen = {
    black: [...state.augment!.draft.seenBySide.black],
    white: [...state.augment!.draft.seenBySide.white],
  };
  state.turn = "black";
  state.firstTurn = "black";
  state.moveNumber = 8;
  state.pieces = [
    piece("black-mover", "black", "platoon", 3, 0),
    piece("black-support", "black", "engineer", 8, 0),
    piece("white-mover", "white", "platoon", 8, 4),
    piece("white-support", "white", "engineer", 3, 4),
  ];
  state.replay = null;
  state.clock!.turnStartedAt = 1_000;

  state = applyPlayerAction(
    state,
    "black",
    { type: "move", from: { row: 3, col: 0 }, to: { row: 4, col: 0 } },
    1_000,
  );
  assert.equal(state.moveNumber, 9);
  assert.equal(state.phase, "augment_draft");
  assert.equal(state.turn, "white");
  assert.equal(state.clock?.turnStartedAt, null);
  assert.equal(state.augment?.draft.activeRound, 2);
  const secondRound = state.augment!.draft.rounds[1];
  assert.notEqual(secondRound.suit, firstRound.suit);
  assert.equal(secondRound.players.black.refreshedSlot, null);
  assert.equal(secondRound.players.white.refreshedSlot, null);
  assert.ok(secondRound.players.black.options.every((id) => !firstSeen.black.includes(id)));
  assert.ok(secondRound.players.white.options.every((id) => !firstSeen.white.includes(id)));
  expectRuleError(
    state,
    "white",
    { type: "move", from: { row: 8, col: 4 }, to: { row: 9, col: 4 } },
    "GAME_NOT_STARTED",
  );

  const blackPick = secondRound.players.black.options[0];
  const whitePick = secondRound.players.white.options[0];
  state = applyPlayerAction(state, "black", { type: "augment_select", augmentId: blackPick });
  state = applyPlayerAction(state, "black", { type: "augment_lock" });
  state = applyPlayerAction(state, "white", { type: "augment_select", augmentId: whitePick });
  state = applyPlayerAction(state, "white", { type: "augment_lock" }, 2_000);
  assert.equal(state.phase, "playing");
  assert.equal(state.turn, "white");
  assert.equal(state.clock?.turnStartedAt, 2_000);
  assert.equal(state.augment?.draft.rounds[1].revealed, true);
  assert.equal(state.augment?.draft.loadouts.black.length, 2);
  assert.equal(state.augment?.draft.loadouts.white.length, 2);
});

test("the second-draft pause cannot bypass no-moves adjudication when play resumes", () => {
  let state = startWithOpeningAugment("heart-rail-turn", 1_000);
  state.turn = "black";
  state.firstTurn = "black";
  state.moveNumber = 8;
  state.pieces = [
    piece("black-mover", "black", "platoon", 3, 0),
    piece("black-support", "black", "engineer", 8, 0),
    piece("white-flag", "white", "flag", 0, 1),
    piece("white-mine", "white", "mine", 1, 0),
  ];
  state.replay = null;
  state.clock!.turnStartedAt = 1_000;
  state = applyPlayerAction(
    state,
    "black",
    { type: "move", from: { row: 3, col: 0 }, to: { row: 4, col: 0 } },
    1_000,
  );
  assert.equal(state.phase, "augment_draft");
  const round = state.augment!.draft.rounds[1];
  const nonRecon = (side: Side) =>
    round.players[side].options.find(
      (id) => getAugmentDefinition(id).effect.kind !== "reconnaissance",
    )!;
  state = applyPlayerAction(state, "black", {
    type: "augment_select",
    augmentId: nonRecon("black"),
  });
  state = applyPlayerAction(state, "black", { type: "augment_lock" });
  state = applyPlayerAction(state, "white", {
    type: "augment_select",
    augmentId: nonRecon("white"),
  });
  state = applyPlayerAction(state, "white", { type: "augment_lock" }, 2_000);
  assert.equal(state.phase, "finished");
  assert.equal(state.finishReason, "no_moves");
  assert.equal(state.winner, "black");
  assert.equal(state.clock?.turnStartedAt, null);
});

test("an unusable extra move interrupted by the second draft is skipped after reveal", () => {
  let state = startWithOpeningAugment("heart-initiative", 1_000);
  state.turn = "black";
  state.firstTurn = "black";
  state.moveNumber = 8;
  state.pieces = [
    piece("only-mover", "black", "platoon", 3, 0),
    piece("black-flag", "black", "flag", 11, 1),
    piece("black-mine", "black", "mine", 10, 0),
    piece("white-mover", "white", "platoon", 8, 4),
  ];
  state.replay = null;
  state.clock!.turnStartedAt = 1_000;
  state = applyPlayerAction(
    state,
    "black",
    { type: "move", from: { row: 3, col: 0 }, to: { row: 4, col: 0 } },
    1_000,
  );
  assert.equal(state.phase, "augment_draft");
  assert.equal(state.augment?.extraMove.black?.excludedPieceId, "only-mover");
  const round = state.augment!.draft.rounds[1];
  const nonRecon = (side: Side) =>
    round.players[side].options.find(
      (id) => getAugmentDefinition(id).effect.kind !== "reconnaissance",
    )!;
  state = applyPlayerAction(state, "black", {
    type: "augment_select",
    augmentId: nonRecon("black"),
  });
  state = applyPlayerAction(state, "black", { type: "augment_lock" });
  state = applyPlayerAction(state, "white", {
    type: "augment_select",
    augmentId: nonRecon("white"),
  });
  state = applyPlayerAction(state, "white", { type: "augment_lock" }, 2_000);
  assert.equal(state.phase, "playing");
  assert.equal(state.turn, "white");
  assert.equal(state.augment?.extraMove.black, null);
  assert.equal(state.finishReason, null);
});

test("passing an extra move spends thinking time, reveals the decision, and does not create a replay move", () => {
  const initial = playingState({
    blackAugments: ["spade-command-chain"],
    whiteAugments: ["spade-strategic-reserve"],
    ranked: true,
    pieces: [
      piece("mover", "black", "platoon", 3, 0),
      piece("reserve", "black", "engineer", 8, 0),
      piece("white-mover", "white", "platoon", 8, 4),
    ],
    clock: {
      initialMs: 600_000,
      remainingMs: { black: 297_000, white: 50_000 },
      turnStartedAt: 1_000,
      incrementMs: RANKED_INCREMENT_MS,
      incrementThresholdMs: RANKED_INCREMENT_THRESHOLD_MS,
      incrementCapMs: null,
    },
  });
  setRevealedBlackLoadout(
    initial,
    ["spade-command-chain"],
    ["spade-strategic-reserve"],
  );
  const granted = applyPlayerAction(
    initial,
    "black",
    { type: "move", from: { row: 3, col: 0 }, to: { row: 4, col: 0 } },
    3_000,
  );
  assert.equal(granted.augment?.extraMove.black?.augmentId, "spade-command-chain");
  assert.equal(granted.clock?.remainingMs.black, 300_000);
  const replayBeforePass = structuredClone(granted.replay);
  const eventsBeforePass = granted.events.length;

  const passed = applyPlayerAction(granted, "black", { type: "pass_extra_move" }, 5_000);

  assert.equal(passed.turn, "white");
  assert.equal(passed.augment?.extraMove.black, null);
  assert.equal(passed.moveNumber, granted.moveNumber);
  assert.deepEqual(passed.replay, replayBeforePass);
  assert.equal(passed.clock?.remainingMs.black, 298_000);
  assert.equal(passed.clock?.remainingMs.white, 170_000);
  assert.equal(passed.clock?.turnStartedAt, 5_000);
  assert.equal(passed.augment?.triggerCounts.white["spade-strategic-reserve"], 1);
  const passEvent = passed.events
    .slice(eventsBeforePass)
    .find((event) => event.result === "extra_move_passed");
  assert.deepEqual(passEvent, {
    id: passEvent?.id,
    actor: "black",
    result: "extra_move_passed",
    augmentId: "spade-command-chain",
  });
  for (const viewer of ["black", "white", "spectator"] as const) {
    assert.ok(
      projectGame(passed, viewer, 5_000).events.some(
        (event) =>
          event.result === "extra_move_passed" &&
          event.actor === "black" &&
          event.augmentId === "spade-command-chain",
      ),
      `${viewer} must receive the public pass event`,
    );
  }
});

test("passing an extra move enforces ownership and stops the clock on no-moves adjudication", () => {
  const state = playingState({
    blackAugments: ["spade-command-chain"],
    pieces: [
      piece("black-mover", "black", "platoon", 3, 0),
      piece("white-flag", "white", "flag", 0, 1),
      piece("white-mine", "white", "mine", 1, 0),
    ],
    clock: {
      initialMs: 60_000,
      remainingMs: { black: 30_000, white: 30_000 },
      turnStartedAt: 1_000,
    },
  });
  state.augment!.extraMove.black = {
    augmentId: "spade-command-chain",
    excludedPieceId: "previous-mover",
  };

  expectRuleError(state, "white", { type: "pass_extra_move" }, "NOT_YOUR_TURN");
  const noPending = structuredClone(state);
  noPending.augment!.extraMove.black = null;
  expectRuleError(noPending, "black", { type: "pass_extra_move" }, "EXTRA_MOVE_NOT_PENDING");
  const classic = createInitialGame();
  classic.phase = "playing";
  classic.turn = "black";
  expectRuleError(classic, "black", { type: "pass_extra_move" }, "AUGMENT_MODE_REQUIRED");

  const result = applyPlayerAction(state, "black", { type: "pass_extra_move" }, 4_000);
  assert.equal(result.phase, "finished");
  assert.equal(result.winner, "black");
  assert.equal(result.finishReason, "no_moves");
  assert.equal(result.clock?.remainingMs.black, 27_000);
  assert.equal(result.clock?.turnStartedAt, null);
  assert.equal(result.moveNumber, 0);
  assert.equal(result.replay, null);
  assert.ok(result.events.some((event) => event.result === "extra_move_passed"));
});

test("either player may resign during the paused second draft", () => {
  let state = startWithOpeningAugment("heart-rail-turn", 1_000);
  state.turn = "black";
  state.firstTurn = "black";
  state.moveNumber = 8;
  state.pieces = [
    piece("black-mover", "black", "platoon", 3, 0),
    piece("black-support", "black", "engineer", 8, 0),
    piece("white-mover", "white", "platoon", 8, 4),
    piece("white-support", "white", "engineer", 3, 4),
  ];
  state.replay = null;
  state.clock!.turnStartedAt = 1_000;
  state = applyPlayerAction(
    state,
    "black",
    { type: "move", from: { row: 3, col: 0 }, to: { row: 4, col: 0 } },
    1_000,
  );
  assert.equal(state.phase, "augment_draft");
  const result = applyPlayerAction(state, "white", { type: "resign" }, 2_000);
  assert.equal(result.phase, "finished");
  assert.equal(result.finishReason, "resign");
  assert.equal(result.winner, "black");
  assert.equal(result.clock?.turnStartedAt, null);
});

test("a 45-second second-draft deadline preserves one locked choice and deterministically fills the timeout", () => {
  const enteredAt = 10_000;
  let state = enterSecondDraft(enteredAt);
  assert.equal(AUGMENT_DRAFT_TIMEOUT_MS, 45_000);
  assert.equal(state.augment?.draftDeadlineAt, enteredAt + AUGMENT_DRAFT_TIMEOUT_MS);
  const round = state.augment!.draft.rounds[1];
  const blackPick = putNonReconOptionFirst(state, "black");
  const whiteAutoPick = putNonReconOptionFirst(state, "white");
  state = applyPlayerAction(state, "black", {
    type: "augment_select",
    augmentId: blackPick,
  });
  state = applyPlayerAction(state, "black", { type: "augment_lock" });
  const replayBefore = structuredClone(state.replay);
  const seenBefore = structuredClone(state.augment!.draft.seenBySide);
  const deadline = state.augment!.draftDeadlineAt!;

  assert.equal(settleExpiredAugmentDraft(state, deadline - 1), false);
  assert.equal(state.phase, "augment_draft");
  assert.equal(round.players.white.locked, false);

  assert.equal(settleExpiredAugmentDraft(state, deadline), true);
  assert.equal(state.phase, "playing");
  assert.equal(state.turn, "white");
  assert.equal(state.augment?.draftDeadlineAt, null);
  assert.equal(state.augment?.draft.activeRound, null);
  assert.equal(state.augment?.draft.rounds[1].revealed, true);
  assert.equal(state.augment?.draft.rounds[1].players.black.selectedId, blackPick);
  assert.equal(state.augment?.draft.rounds[1].players.white.selectedId, whiteAutoPick);
  assert.equal(state.augment?.draft.rounds[1].players.black.locked, true);
  assert.equal(state.augment?.draft.rounds[1].players.white.locked, true);
  assert.deepEqual(state.augment?.draft.seenBySide, seenBefore);
  assert.deepEqual(state.replay, replayBefore);
  assert.equal(state.clock?.turnStartedAt, deadline);
  assert.equal(state.events.at(-1)?.result, "augment_revealed");

  const publicView = projectGame(state, "spectator", deadline);
  assert.equal(publicView.augment?.draftDeadlineAt, null);
  assert.equal(publicView.augment?.draft.rounds[1].players.black.selectedId, blackPick);
  assert.equal(publicView.augment?.draft.rounds[1].players.white.selectedId, whiteAutoPick);
  assert.equal(publicView.replay?.moves.at(-1)?.moveNumber, 9);
  assert.equal(buildReplayFrames(publicView.replay).at(-1)?.moveNumber, 9);
  assert.equal(
    projectGame(state, "white", deadline + 5_000).clock?.remainingMs.white,
    state.clock!.remainingMs.white - 5_000,
  );
  assert.equal(settleExpiredAugmentDraft(state, deadline + 10_000), false);
});

test("when neither side locks, timeout keeps a pending selection and auto-picks only the missing choice", () => {
  const enteredAt = 30_000;
  let state = enterSecondDraft(enteredAt);
  const blackAutoPick = putNonReconOptionFirst(state, "black");
  putNonReconOptionFirst(state, "white");
  const whiteSelected = state.augment!.draft.rounds[1].players.white.options[2];
  state = applyPlayerAction(state, "white", {
    type: "augment_select",
    augmentId: whiteSelected,
  });
  const seenBefore = structuredClone(state.augment!.draft.seenBySide);
  const deadline = state.augment!.draftDeadlineAt!;
  assert.equal(settleExpiredAugmentDraft(state, deadline), true);

  const round = state.augment!.draft.rounds[1];
  assert.equal(round.revealed, true);
  assert.equal(round.players.black.selectedId, blackAutoPick);
  assert.equal(round.players.white.selectedId, whiteSelected);
  assert.equal(round.players.black.locked, true);
  assert.equal(round.players.white.locked, true);
  assert.deepEqual(state.augment?.draft.seenBySide, seenBefore);
  assert.deepEqual(state.augment?.draft.loadouts.black, ["heart-rail-turn", blackAutoPick]);
  assert.deepEqual(state.augment?.draft.loadouts.white, ["heart-rail-turn", whiteSelected]);
  assert.equal(state.phase, "playing");
  assert.equal(state.turn, "white");
  assert.equal(state.clock?.turnStartedAt, deadline);
});

test("a persisted second draft without the new deadline field receives a fresh full window", () => {
  const nowMs = 90_000;
  const state = enterSecondDraft(1_000);
  delete (state.augment as { draftDeadlineAt?: number | null }).draftDeadlineAt;
  assert.equal(settleExpiredAugmentDraft(state, nowMs), true);
  assert.equal(state.phase, "augment_draft");
  assert.equal(state.augment?.draftDeadlineAt, nowMs + AUGMENT_DRAFT_TIMEOUT_MS);
  assert.equal(state.augment?.draft.rounds[1].players.black.locked, false);
  assert.equal(state.augment?.draft.rounds[1].players.white.locked, false);
});

test("all five active movement cards execute their distinct movement rule and consume one charge", () => {
  const cases: Array<{
    id: AugmentId;
    pieces: Piece[];
    from: Position;
    to: Position;
  }> = [
    {
      id: "spade-grand-maneuver",
      pieces: [piece("mover", "black", "platoon", 1, 2), piece("white", "white", "platoon", 8, 4)],
      from: { row: 1, col: 2 },
      to: { row: 5, col: 0 },
    },
    {
      id: "heart-rail-turn",
      pieces: [piece("mover", "black", "platoon", 1, 2), piece("white", "white", "platoon", 8, 4)],
      from: { row: 1, col: 2 },
      to: { row: 5, col: 0 },
    },
    {
      id: "club-forced-march",
      pieces: [piece("mover", "black", "platoon", 6, 2), piece("white", "white", "platoon", 8, 4)],
      from: { row: 6, col: 2 },
      to: { row: 4, col: 2 },
    },
    {
      id: "club-line-hop",
      pieces: [
        piece("mover", "black", "platoon", 1, 0),
        piece("screen", "black", "mine", 1, 1),
        piece("white", "white", "platoon", 8, 4),
      ],
      from: { row: 1, col: 0 },
      to: { row: 1, col: 2 },
    },
    {
      id: "diamond-camp-transfer",
      pieces: [piece("mover", "black", "platoon", 7, 1), piece("white", "white", "platoon", 8, 4)],
      from: { row: 7, col: 1 },
      to: { row: 9, col: 3 },
    },
  ];

  for (const scenario of cases) {
    const before = playingState({ pieces: scenario.pieces, blackAugments: [scenario.id] });
    assert.equal(getAugmentMoveViolation(before, "black", scenario.id, scenario.from, scenario.to), null);
    const after = applyPlayerAction(before, "black", {
      type: "augment_move",
      augmentId: scenario.id,
      from: scenario.from,
      to: scenario.to,
    });
    const mover = after.pieces.find((candidate) => candidate.id === "mover")!;
    assert.deepEqual({ row: mover.row, col: mover.col }, scenario.to, scenario.id);
    assert.equal(after.augment?.triggerCounts.black[scenario.id], 1, scenario.id);
    assert.equal(after.turn, "white", scenario.id);
    const retry: GameState = { ...after, turn: "black" };
    expectRuleError(
      retry,
      "black",
      { type: "augment_move", augmentId: scenario.id, from: scenario.to, to: scenario.from },
      "AUGMENT_NOT_AVAILABLE",
    );
  }
});

test("parameterized movement variants enforce turn count, distance, attack, and junior eligibility", () => {
  const twoTurns = playingState({
    blackAugments: ["heart-double-turn"],
    pieces: [
      piece("mover", "black", "platoon", 1, 2),
      piece("white-support", "white", "platoon", 8, 4),
    ],
  });
  assert.equal(
    getAugmentMoveViolation(
      twoTurns,
      "black",
      "heart-double-turn",
      { row: 1, col: 2 },
      { row: 5, col: 2 },
    ),
    null,
  );
  const oneTurn = playingState({
    blackAugments: ["heart-rail-turn"],
    pieces: [
      piece("mover", "black", "platoon", 1, 2),
      piece("white-support", "white", "platoon", 8, 4),
    ],
  });
  assert.equal(
    getAugmentMoveViolation(
      oneTurn,
      "black",
      "heart-rail-turn",
      { row: 1, col: 2 },
      { row: 5, col: 2 },
    ),
    "AUGMENT_PATH_INVALID",
  );

  const offensive = playingState({
    blackAugments: ["spade-serpentine-offensive"],
    pieces: [
      piece("mover", "black", "commander", 1, 2),
      piece("target", "white", "platoon", 5, 2),
      piece("white-support", "white", "platoon", 8, 4),
    ],
  });
  assert.equal(
    getAugmentMoveViolation(
      offensive,
      "black",
      "spade-serpentine-offensive",
      { row: 1, col: 2 },
      { row: 5, col: 2 },
    ),
    null,
  );

  const threeEdges = playingState({
    blackAugments: ["heart-breakthrough"],
    pieces: [
      piece("mover", "black", "commander", 3, 0),
      piece("white-support", "white", "platoon", 8, 4),
    ],
  });
  assert.equal(
    getAugmentMoveViolation(
      threeEdges,
      "black",
      "heart-breakthrough",
      { row: 3, col: 0 },
      { row: 6, col: 0 },
    ),
    null,
  );
  const twoEdges = playingState({
    blackAugments: ["club-road-patrol"],
    pieces: [
      piece("mover", "black", "commander", 3, 0),
      piece("white-support", "white", "platoon", 8, 4),
    ],
  });
  assert.equal(
    getAugmentMoveViolation(
      twoEdges,
      "black",
      "club-road-patrol",
      { row: 3, col: 0 },
      { row: 6, col: 0 },
    ),
    "AUGMENT_PATH_INVALID",
  );

  for (const scenario of [
    { id: "club-rail-switch" as const, from: { row: 1, col: 2 }, to: { row: 5, col: 0 } },
    { id: "diamond-road-step" as const, from: { row: 3, col: 0 }, to: { row: 5, col: 0 } },
    { id: "diamond-camp-relay" as const, from: { row: 7, col: 1 }, to: { row: 9, col: 3 } },
  ]) {
    const state = playingState({
      blackAugments: [scenario.id],
      pieces: [
        piece("mover", "black", "commander", scenario.from.row, scenario.from.col),
        piece("white-support", "white", "platoon", 8, 4),
      ],
    });
    assert.equal(
      getAugmentMoveViolation(state, "black", scenario.id, scenario.from, scenario.to),
      "AUGMENT_PIECE_INELIGIBLE",
      scenario.id,
    );
  }
});

test("line hop requires the single friendly screen to be adjacent, as its card text promises", () => {
  const state = playingState({
    blackAugments: ["club-line-hop"],
    pieces: [
      piece("mover", "black", "platoon", 1, 0),
      piece("non-adjacent-screen", "black", "mine", 1, 2),
      piece("white", "white", "platoon", 8, 4),
    ],
  });
  assert.equal(
    getAugmentMoveViolation(
      state,
      "black",
      "club-line-hop",
      { row: 1, col: 0 },
      { row: 1, col: 3 },
    ),
    "AUGMENT_PATH_INVALID",
  );
});

test("remote and field exchanges enforce their different eligibility rules and replay exactly", () => {
  const remote = playingState({
    blackAugments: ["heart-remote-exchange"],
    pieces: [
      piece("first", "black", "platoon", 3, 0),
      piece("second", "black", "platoon", 8, 4),
      piece("white", "white", "engineer", 4, 4),
    ],
  });
  expectRuleError(
    remote,
    "black",
    {
      type: "augment_exchange",
      augmentId: "heart-remote-exchange",
      from: { row: 3, col: 0 },
      to: { row: 3, col: 0 },
    },
    "SAME_POSITION",
  );
  const remoteAfter = applyPlayerAction(remote, "black", {
    type: "augment_exchange",
    augmentId: "heart-remote-exchange",
    from: { row: 3, col: 0 },
    to: { row: 8, col: 4 },
  });
  assert.deepEqual(
    remoteAfter.pieces.filter((candidate) => candidate.side === "black").map(({ id, row, col }) => ({ id, row, col })),
    [
      { id: "first", row: 8, col: 4 },
      { id: "second", row: 3, col: 0 },
    ],
  );
  assert.deepEqual(
    buildReplayFrames(remoteAfter.replay).at(-1)?.pieces
      .filter((candidate) => candidate.side === "black")
      .map(({ id, row, col }) => ({ id, row, col })),
    [
      { id: "first", row: 8, col: 4 },
      { id: "second", row: 3, col: 0 },
    ],
  );
  assert.deepEqual(remoteAfter.events.at(-1)?.from, { row: 3, col: 0 });
  assert.deepEqual(remoteAfter.events.at(-1)?.to, { row: 8, col: 4 });
  assert.equal(remoteAfter.events.at(-1)?.augmentId, "heart-remote-exchange");

  const field = playingState({
    blackAugments: ["club-field-exchange"],
    pieces: [
      piece("first", "black", "commander", 3, 0),
      piece("second", "black", "engineer", 3, 1),
      piece("white", "white", "platoon", 8, 4),
    ],
  });
  const fieldAfter = applyPlayerAction(field, "black", {
    type: "augment_exchange",
    augmentId: "club-field-exchange",
    from: { row: 3, col: 0 },
    to: { row: 3, col: 1 },
  });
  assert.equal(fieldAfter.pieces.find((candidate) => candidate.id === "first")?.col, 1);
  assert.equal(fieldAfter.pieces.find((candidate) => candidate.id === "second")?.col, 0);
});

test("exchange emits a dual-track transition even when a later clock event is last", () => {
  const state = playingState({
    blackAugments: ["heart-remote-exchange", "diamond-drill"],
    whiteAugments: ["heart-reserve-clock", "diamond-camp-transfer"],
    clock: {
      initialMs: 600_000,
      remainingMs: { black: 100_000, white: 59_000 },
      turnStartedAt: 0,
    },
    pieces: [
      piece("first", "black", "platoon", 3, 0),
      piece("second", "black", "platoon", 8, 0),
      piece("white-support", "white", "platoon", 8, 4),
    ],
  });
  setRevealedBlackLoadout(
    state,
    ["heart-remote-exchange", "diamond-drill"],
    ["heart-reserve-clock", "diamond-camp-transfer"],
  );
  const previous = projectGame(state, "spectator", 0);
  const result = applyPlayerAction(
    state,
    "black",
    {
      type: "augment_exchange",
      augmentId: "heart-remote-exchange",
      from: { row: 3, col: 0 },
      to: { row: 8, col: 0 },
    },
    0,
  );
  assert.equal(result.events.at(-1)?.result, "augment_used");
  assert.equal(result.events.at(-1)?.augmentId, "heart-reserve-clock");
  assert.deepEqual(result.replay?.moves[0].augmentIds, [
    "heart-remote-exchange",
    "diamond-drill",
  ]);
  const exchangeEvent = result.events.find((event) => event.kind === "exchange");
  assert.deepEqual(exchangeEvent?.augmentIds, [
    "heart-remote-exchange",
    "diamond-drill",
  ]);
  const animation = movementAnimationForTransition(
    previous,
    projectGame(result, "spectator", 0),
  );
  assert.equal(animation?.kind, "exchange");
  if (!animation || animation.kind !== "exchange") return;
  assert.deepEqual(animation.first, {
    pieceId: "first",
    from: { row: 3, col: 0 },
    to: { row: 8, col: 0 },
  });
  assert.deepEqual(animation.second, {
    pieceId: "second",
    from: { row: 8, col: 0 },
    to: { row: 3, col: 0 },
  });
  assert.deepEqual(animation.augmentIds, [
    "heart-remote-exchange",
    "diamond-drill",
  ]);
});

test("the three combat cards produce retreat, bomb disposal, and engineer last stand", () => {
  const retreat = playingState({
    blackAugments: ["spade-tactical-retreat"],
    pieces: [
      piece("attacker", "black", "platoon", 3, 0),
      piece("defender", "white", "commander", 3, 1),
      piece("white-support", "white", "engineer", 8, 4),
    ],
  });
  const retreated = applyPlayerAction(retreat, "black", {
    type: "move",
    from: { row: 3, col: 0 },
    to: { row: 3, col: 1 },
  });
  const retreatedAttacker = retreated.pieces.find((candidate) => candidate.id === "attacker")!;
  assert.equal(retreatedAttacker.alive, true);
  assert.deepEqual({ row: retreatedAttacker.row, col: retreatedAttacker.col }, { row: 3, col: 0 });
  assert.equal(retreated.pieces.find((candidate) => candidate.id === "defender")?.alive, true);
  assert.equal(retreated.augment?.triggerCounts.black["spade-tactical-retreat"], 1);

  const disposal = playingState({
    blackAugments: ["heart-bomb-disposal"],
    pieces: [
      piece("attacker", "black", "engineer", 3, 0),
      piece("defender", "white", "bomb", 3, 1),
      piece("white-support", "white", "platoon", 8, 4),
    ],
  });
  const disposed = applyPlayerAction(disposal, "black", {
    type: "move",
    from: { row: 3, col: 0 },
    to: { row: 3, col: 1 },
  });
  assert.equal(disposed.pieces.find((candidate) => candidate.id === "attacker")?.alive, true);
  assert.equal(disposed.pieces.find((candidate) => candidate.id === "defender")?.alive, false);
  assert.equal(disposed.events.at(-1)?.result, "attacker_survives");

  for (const engineerSide of ["black", "white"] as const) {
    const screen = playingState({
      blackAugments: engineerSide === "black" ? ["diamond-engineer-screen"] : [],
      whiteAugments: engineerSide === "white" ? ["diamond-engineer-screen"] : [],
      pieces: engineerSide === "black"
        ? [
            piece("attacker", "black", "engineer", 3, 0),
            piece("defender", "white", "commander", 3, 1),
            piece("white-support", "white", "platoon", 8, 4),
          ]
        : [
            piece("attacker", "black", "commander", 3, 0),
            piece("defender", "white", "engineer", 3, 1),
            piece("white-support", "white", "platoon", 8, 4),
          ],
    });
    const screened = applyPlayerAction(screen, "black", {
      type: "move",
      from: { row: 3, col: 0 },
      to: { row: 3, col: 1 },
    });
    assert.equal(screened.pieces.find((candidate) => candidate.id === "attacker")?.alive, false);
    assert.equal(screened.pieces.find((candidate) => candidate.id === "defender")?.alive, false);
    assert.equal(screened.events.at(-1)?.result, "both_removed");
    assert.equal(screened.augment?.triggerCounts[engineerSide]["diamond-engineer-screen"], 1);
  }
});

test("tactical retreat survives replay reconstruction instead of becoming a phantom casualty", () => {
  const state = playingState({
    blackAugments: ["spade-tactical-retreat"],
    pieces: [
      piece("attacker", "black", "platoon", 3, 0),
      piece("defender", "white", "commander", 3, 1),
      piece("white-support", "white", "engineer", 8, 4),
    ],
  });
  const result = applyPlayerAction(state, "black", {
    type: "move",
    from: { row: 3, col: 0 },
    to: { row: 3, col: 1 },
  });
  const replayAttacker = buildReplayFrames(result.replay)
    .at(-1)?.pieces.find((candidate) => candidate.id === "attacker");
  assert.equal(result.pieces.find((candidate) => candidate.id === "attacker")?.alive, true);
  assert.equal(replayAttacker?.alive, true);
  assert.deepEqual(
    replayAttacker && { row: replayAttacker.row, col: replayAttacker.col },
    { row: 3, col: 0 },
  );
});

test("one move records every active and automatic augment for replay and animation", () => {
  const retreat = playingState({
    blackAugments: ["spade-grand-maneuver", "heart-orderly-withdrawal"],
    pieces: [
      piece("attacker", "black", "company", 1, 2),
      piece("defender", "white", "commander", 5, 4),
      piece("white-support", "white", "platoon", 8, 4),
    ],
  });
  setRevealedBlackLoadout(retreat, ["spade-grand-maneuver", "heart-orderly-withdrawal"]);
  const retreated = applyPlayerAction(retreat, "black", {
    type: "augment_move",
    augmentId: "spade-grand-maneuver",
    from: { row: 1, col: 2 },
    to: { row: 5, col: 4 },
  });
  assert.deepEqual(retreated.replay?.moves.at(-1)?.augmentIds, [
    "spade-grand-maneuver",
    "heart-orderly-withdrawal",
  ]);
  assert.deepEqual(retreated.events.at(-1)?.augmentIds, [
    "spade-grand-maneuver",
    "heart-orderly-withdrawal",
  ]);
  assert.equal(
    buildReplayFrames(retreated.replay).at(-1)?.pieces.find((candidate) => candidate.id === "attacker")?.alive,
    true,
  );
  assert.equal(
    movementAnimationForTransition(
      projectGame(retreat, "spectator", 1_000),
      projectGame(retreated, "spectator", 1_000),
    )?.outcome,
    "repelled",
  );

  const disposal = playingState({
    blackAugments: ["spade-grand-maneuver", "heart-bomb-disposal"],
    pieces: [
      piece("attacker", "black", "engineer", 1, 2),
      piece("defender", "white", "bomb", 5, 4),
      piece("white-support", "white", "platoon", 8, 4),
    ],
  });
  const disposed = applyPlayerAction(disposal, "black", {
    type: "augment_move",
    augmentId: "spade-grand-maneuver",
    from: { row: 1, col: 2 },
    to: { row: 5, col: 4 },
  });
  assert.deepEqual(disposed.replay?.moves.at(-1)?.augmentIds, [
    "spade-grand-maneuver",
    "heart-bomb-disposal",
  ]);

  const lastStand = playingState({
    blackAugments: ["spade-grand-maneuver"],
    whiteAugments: ["club-engineer-oath"],
    pieces: [
      piece("attacker", "black", "commander", 1, 2),
      piece("defender", "white", "engineer", 5, 4),
      piece("white-support", "white", "platoon", 8, 0),
    ],
  });
  const mutual = applyPlayerAction(lastStand, "black", {
    type: "augment_move",
    augmentId: "spade-grand-maneuver",
    from: { row: 1, col: 2 },
    to: { row: 5, col: 4 },
  });
  assert.deepEqual(mutual.replay?.moves.at(-1)?.augmentIds, [
    "spade-grand-maneuver",
    "club-engineer-oath",
  ]);

  const legacyReplay = structuredClone(retreated.replay)!;
  delete legacyReplay.moves[0].augmentIds;
  legacyReplay.moves[0].augmentId = "heart-orderly-withdrawal";
  assert.equal(
    buildReplayFrames(legacyReplay).at(-1)?.pieces.find((candidate) => candidate.id === "attacker")?.alive,
    true,
  );
});

test("same-trigger automatic augments use stable loadout priority and fall through after exhaustion", () => {
  const makeState = (loadout: AugmentId[]) => playingState({
    blackAugments: loadout,
    pieces: [
      piece("attacker", "black", "company", 3, 0),
      piece("defender", "white", "commander", 3, 1),
      piece("white-support", "white", "platoon", 8, 4),
    ],
  });
  const heartFirst = applyPlayerAction(
    makeState(["heart-orderly-withdrawal", "spade-shadow-retreat"]),
    "black",
    { type: "move", from: { row: 3, col: 0 }, to: { row: 3, col: 1 } },
  );
  assert.equal(heartFirst.augment?.triggerCounts.black["heart-orderly-withdrawal"], 1);
  assert.equal(heartFirst.augment?.triggerCounts.black["spade-shadow-retreat"], undefined);

  const spadeFirst = makeState(["spade-shadow-retreat", "heart-orderly-withdrawal"]);
  spadeFirst.augment!.triggerCounts.black["spade-shadow-retreat"] = 3;
  const fallenThrough = applyPlayerAction(
    spadeFirst,
    "black",
    { type: "move", from: { row: 3, col: 0 }, to: { row: 3, col: 1 } },
  );
  assert.equal(fallenThrough.augment?.triggerCounts.black["spade-shadow-retreat"], 3);
  assert.equal(fallenThrough.augment?.triggerCounts.black["heart-orderly-withdrawal"], 1);

  const makeCaptureState = (loadout: AugmentId[]) => playingState({
    blackAugments: loadout,
    pieces: [
      piece("capturer", "black", "commander", 3, 0),
      piece("reserve", "black", "platoon", 8, 0),
      piece("victim", "white", "platoon", 3, 1),
      piece("white-support", "white", "platoon", 8, 4),
    ],
  });
  const heartCapture = applyPlayerAction(
    makeCaptureState(["heart-victory-momentum", "spade-counteroffensive"]),
    "black",
    { type: "move", from: { row: 3, col: 0 }, to: { row: 3, col: 1 } },
  );
  assert.equal(heartCapture.augment?.extraMove.black?.augmentId, "heart-victory-momentum");
  assert.equal(heartCapture.augment?.triggerCounts.black["heart-victory-momentum"], 1);
  assert.equal(heartCapture.augment?.triggerCounts.black["spade-counteroffensive"], undefined);

  const exhaustedCapture = makeCaptureState([
    "spade-counteroffensive",
    "heart-victory-momentum",
  ]);
  exhaustedCapture.augment!.triggerCounts.black["spade-counteroffensive"] = 3;
  const captureFallback = applyPlayerAction(
    exhaustedCapture,
    "black",
    { type: "move", from: { row: 3, col: 0 }, to: { row: 3, col: 1 } },
  );
  assert.equal(captureFallback.augment?.extraMove.black?.augmentId, "heart-victory-momentum");
  assert.equal(captureFallback.augment?.triggerCounts.black["spade-counteroffensive"], 3);
  assert.equal(captureFallback.augment?.triggerCounts.black["heart-victory-momentum"], 1);

  const makeLastStandState = (loadout: AugmentId[]) => playingState({
    blackAugments: loadout,
    pieces: [
      piece("engineer", "black", "engineer", 3, 0),
      piece("defender", "white", "commander", 3, 1),
      piece("white-support", "white", "platoon", 8, 4),
    ],
  });
  const clubLastStand = applyPlayerAction(
    makeLastStandState(["club-engineer-oath", "diamond-engineer-screen"]),
    "black",
    { type: "move", from: { row: 3, col: 0 }, to: { row: 3, col: 1 } },
  );
  assert.equal(clubLastStand.augment?.triggerCounts.black["club-engineer-oath"], 1);
  assert.equal(clubLastStand.augment?.triggerCounts.black["diamond-engineer-screen"], undefined);

  const exhaustedLastStand = makeLastStandState([
    "club-engineer-oath",
    "diamond-engineer-screen",
  ]);
  exhaustedLastStand.augment!.triggerCounts.black["club-engineer-oath"] = 2;
  const lastStandFallback = applyPlayerAction(
    exhaustedLastStand,
    "black",
    { type: "move", from: { row: 3, col: 0 }, to: { row: 3, col: 1 } },
  );
  assert.equal(lastStandFallback.augment?.triggerCounts.black["club-engineer-oath"], 2);
  assert.equal(lastStandFallback.augment?.triggerCounts.black["diamond-engineer-screen"], 1);
});

test("stackable automatic clocks all trigger while mutually exclusive rescues use loadout priority", () => {
  const increments = playingState({
    blackAugments: ["club-steady-tempo", "diamond-drill"],
    clock: {
      initialMs: 600_000,
      remainingMs: { black: 100_000, white: 100_000 },
      turnStartedAt: 0,
    },
    pieces: [
      piece("black", "black", "platoon", 3, 0),
      piece("white", "white", "platoon", 8, 4),
    ],
  });
  const incremented = applyPlayerAction(
    increments,
    "black",
    { type: "move", from: { row: 3, col: 0 }, to: { row: 4, col: 0 } },
    0,
  );
  assert.equal(incremented.clock?.remainingMs.black, 107_000);
  assert.equal(incremented.augment?.triggerCounts.black["club-steady-tempo"], 1);
  assert.equal(incremented.augment?.triggerCounts.black["diamond-drill"], 1);
  assert.deepEqual(incremented.replay?.moves[0].augmentIds, [
    "club-steady-tempo",
    "diamond-drill",
  ]);

  const rescueAfterWhiteMove = (loadout: AugmentId[]) => applyPlayerAction(
    playingState({
      turn: "white",
      blackAugments: loadout,
      clock: {
        initialMs: 600_000,
        remainingMs: { black: 59_000, white: 100_000 },
        turnStartedAt: 0,
      },
      pieces: [
        piece("black", "black", "platoon", 3, 0),
        piece("white", "white", "platoon", 8, 4),
      ],
    }),
    "white",
    { type: "move", from: { row: 8, col: 4 }, to: { row: 9, col: 4 } },
    0,
  );
  const heartFirst = rescueAfterWhiteMove([
    "heart-reserve-clock",
    "spade-strategic-reserve",
  ]);
  assert.equal(heartFirst.clock?.remainingMs.black, 149_000);
  assert.equal(heartFirst.augment?.triggerCounts.black["heart-reserve-clock"], 1);
  assert.equal(heartFirst.augment?.triggerCounts.black["spade-strategic-reserve"], undefined);

  const spadeFirst = rescueAfterWhiteMove([
    "spade-strategic-reserve",
    "heart-reserve-clock",
  ]);
  assert.equal(spadeFirst.clock?.remainingMs.black, 179_000);
  assert.equal(spadeFirst.augment?.triggerCounts.black["spade-strategic-reserve"], 1);
  assert.equal(spadeFirst.augment?.triggerCounts.black["heart-reserve-clock"], undefined);

  const animationState = playingState({
    turn: "white",
    blackAugments: ["spade-strategic-reserve"],
    clock: {
      initialMs: 600_000,
      remainingMs: { black: 59_000, white: 100_000 },
      turnStartedAt: 0,
    },
    pieces: [
      piece("black", "black", "platoon", 3, 0),
      piece("white", "white", "platoon", 8, 4),
    ],
  });
  setRevealedBlackLoadout(animationState, ["spade-strategic-reserve"]);
  const animationResult = applyPlayerAction(
    animationState,
    "white",
    { type: "move", from: { row: 8, col: 4 }, to: { row: 9, col: 4 } },
    0,
  );
  assert.equal(animationResult.events.at(-1)?.result, "augment_used");
  assert.equal(
    movementAnimationForTransition(
      projectGame(animationState, "spectator", 0),
      projectGame(animationResult, "spectator", 0),
    )?.outcome,
    "move",
  );
});

test("capture and quiet-move extra actions require a different piece and cannot chain", () => {
  const capture = playingState({
    blackAugments: ["spade-relentless-assault"],
    pieces: [
      piece("mover", "black", "commander", 3, 0),
      piece("reserve", "black", "platoon", 8, 0),
      piece("victim", "white", "platoon", 3, 1),
      piece("white-support", "white", "engineer", 8, 4),
    ],
  });
  let after = applyPlayerAction(capture, "black", {
    type: "move",
    from: { row: 3, col: 0 },
    to: { row: 3, col: 1 },
  });
  assert.equal(after.turn, "black");
  assert.equal(after.augment?.extraMove.black?.excludedPieceId, "mover");
  expectRuleError(
    after,
    "black",
    { type: "move", from: { row: 3, col: 1 }, to: { row: 3, col: 2 } },
    "EXTRA_MOVE_DIFFERENT_PIECE",
  );
  after = applyPlayerAction(after, "black", {
    type: "move",
    from: { row: 8, col: 0 },
    to: { row: 9, col: 0 },
  });
  assert.equal(after.turn, "white");
  assert.equal(after.augment?.extraMove.black, null);
  assert.equal(after.augment?.triggerCounts.black["spade-relentless-assault"], 1);

  const initiative = playingState({
    blackAugments: ["heart-initiative"],
    pieces: [
      piece("mover", "black", "platoon", 3, 0),
      piece("reserve", "black", "engineer", 8, 0),
      piece("white-support", "white", "platoon", 8, 4),
    ],
  });
  after = applyPlayerAction(initiative, "black", {
    type: "move",
    from: { row: 3, col: 0 },
    to: { row: 4, col: 0 },
  });
  assert.equal(after.turn, "black");
  after = applyPlayerAction(after, "black", {
    type: "move",
    from: { row: 8, col: 0 },
    to: { row: 9, col: 0 },
  });
  assert.equal(after.turn, "white");
  assert.equal(after.augment?.triggerCounts.black["heart-initiative"], 1);
});

test("an unavailable extra move passes the turn and never awards a false no-moves win", () => {
  const state = playingState({
    blackAugments: ["heart-initiative"],
    pieces: [
      piece("only-mover", "black", "platoon", 3, 0),
      piece("black-flag", "black", "flag", 11, 1),
      piece("black-mine", "black", "mine", 10, 0),
      piece("white-mover", "white", "platoon", 8, 4),
    ],
  });
  const result = applyPlayerAction(state, "black", {
    type: "move",
    from: { row: 3, col: 0 },
    to: { row: 4, col: 0 },
  });
  assert.equal(result.phase, "playing");
  assert.equal(result.finishReason, null);
  assert.equal(result.turn, "white");
});

test("no-moves detection counts a legal active augment action", () => {
  const state = playingState({
    turn: "white",
    blackAugments: ["club-line-hop"],
    pieces: [
      piece("trapped-mover", "black", "platoon", 1, 0),
      piece("rail-screen", "black", "mine", 1, 1),
      piece("road-block", "black", "mine", 0, 0),
      piece("vertical-block", "black", "mine", 2, 0),
      piece("white-mover", "white", "platoon", 8, 4),
    ],
  });
  assert.equal(
    getAugmentMoveViolation(
      { ...state, turn: "black" },
      "black",
      "club-line-hop",
      { row: 1, col: 0 },
      { row: 1, col: 2 },
    ),
    null,
  );
  const result = applyPlayerAction(state, "white", {
    type: "move",
    from: { row: 8, col: 4 },
    to: { row: 9, col: 4 },
  });
  assert.equal(result.phase, "playing");
  assert.equal(result.finishReason, null);
  assert.equal(result.turn, "black");
});

test("an active augment with no legal target cannot postpone no-moves defeat", () => {
  const state = playingState({
    turn: "white",
    blackAugments: ["heart-camp-network"],
    pieces: [
      piece("trapped-mover", "black", "platoon", 0, 0),
      piece("right-block", "black", "mine", 0, 1),
      piece("down-block", "black", "mine", 1, 0),
      piece("white-mover", "white", "platoon", 8, 4),
    ],
  });
  const result = applyPlayerAction(state, "white", {
    type: "move",
    from: { row: 8, col: 4 },
    to: { row: 9, col: 4 },
  });
  assert.equal(result.phase, "finished");
  assert.equal(result.finishReason, "no_moves");
  assert.equal(result.winner, "white");
  assert.equal(result.augment?.triggerCounts.black["heart-camp-network"], undefined);
});

test("targeted reconnaissance blocks normal movement until all chosen identities are recorded", () => {
  for (const scenario of [
    { id: "heart-targeted-recon" as const, count: 1 },
    { id: "spade-total-intelligence" as const, count: 2 },
  ]) {
    let state = startWithOpeningAugment(scenario.id, 1_000);
    state.turn = "black";
    state.clock!.turnStartedAt = 1_000;
    assert.equal(state.augment?.pendingRecon.black?.remaining, scenario.count);
    const ownMover = state.pieces.find(
      (candidate) =>
        candidate.side === "black" &&
        candidate.alive &&
        candidate.type !== "mine" &&
        candidate.type !== "flag" &&
        ![11].includes(candidate.row),
    );
    if (ownMover) {
      expectRuleError(
        state,
        "black",
        {
          type: "move",
          from: ownMover,
          to: { row: ownMover.row, col: ownMover.col === 4 ? 3 : ownMover.col + 1 },
        },
        "RECON_SELECTION_REQUIRED",
      );
    }
    const targets = state.pieces.filter((candidate) => candidate.side === "white").slice(0, scenario.count);
    for (const target of targets) {
      state = applyPlayerAction(state, "black", {
        type: "augment_recon",
        augmentId: scenario.id,
        target,
      }, 1_000);
    }
    assert.equal(state.augment?.pendingRecon.black, null);
    assert.equal(state.augment?.triggerCounts.black[scenario.id], 1);
    const blackView = projectGame(state, "black", 1_000);
    assert.ok(
      targets.every(
        (target) => blackView.pieces.find((candidate) => candidate.id === target.id)?.type === target.type,
      ),
    );
  }
});

test("finishing mandatory reconnaissance immediately resolves a true no-moves position", () => {
  const state = playingState({
    blackAugments: ["heart-targeted-recon"],
    pieces: [
      piece("black-flag", "black", "flag", 11, 1),
      piece("black-mine", "black", "mine", 10, 0),
      piece("white-target", "white", "platoon", 8, 4),
    ],
  });
  state.augment!.pendingRecon.black = {
    augmentId: "heart-targeted-recon",
    remaining: 1,
  };
  const result = applyPlayerAction(state, "black", {
    type: "augment_recon",
    augmentId: "heart-targeted-recon",
    target: { row: 8, col: 4 },
  });
  assert.equal(result.augment?.pendingRecon.black, null);
  assert.equal(result.phase, "finished");
  assert.equal(result.finishReason, "no_moves");
  assert.equal(result.winner, "white");
});

test("reconnaissance clamps its required picks to the remaining unknown living enemies", () => {
  let state = enterSecondDraft(1_000);
  state.pieces = [
    piece("black-mover", "black", "platoon", 4, 0),
    piece("white-only-target", "white", "platoon", 8, 4),
  ];
  forceSecondRoundSpades(state);
  state = applyPlayerAction(state, "black", {
    type: "augment_select",
    augmentId: "spade-total-intelligence",
  });
  state = applyPlayerAction(state, "black", { type: "augment_lock" });
  state = applyPlayerAction(state, "white", {
    type: "augment_select",
    augmentId: "spade-grand-maneuver",
  });
  state = applyPlayerAction(state, "white", { type: "augment_lock" }, 2_000);
  assert.equal(state.phase, "playing");
  assert.deepEqual(state.augment?.pendingRecon.black, {
    augmentId: "spade-total-intelligence",
    remaining: 1,
  });

  state = applyPlayerAction(state, "black", {
    type: "augment_recon",
    augmentId: "spade-total-intelligence",
    target: { row: 8, col: 4 },
  }, 2_000);
  assert.equal(state.augment?.pendingRecon.black, null);
  assert.equal(state.augment?.triggerCounts.black["spade-total-intelligence"], 1);
  assert.equal(
    projectGame(state, "black", 2_000).pieces.find(
      (candidate) => candidate.id === "white-only-target",
    )?.type,
    "platoon",
  );
});

test("reconnaissance with no unknown target resolves immediately instead of opening an empty picker", () => {
  let state = enterSecondDraft(1_000);
  state.pieces = [
    piece("black-mover", "black", "platoon", 4, 0),
    piece("white-known-target", "white", "platoon", 8, 4),
  ];
  state.augment!.permanentReveals.black.push("white-known-target");
  forceSecondRoundSpades(state);
  state = applyPlayerAction(state, "black", {
    type: "augment_select",
    augmentId: "spade-total-intelligence",
  });
  state = applyPlayerAction(state, "black", { type: "augment_lock" });
  state = applyPlayerAction(state, "white", {
    type: "augment_select",
    augmentId: "spade-grand-maneuver",
  });
  state = applyPlayerAction(state, "white", { type: "augment_lock" }, 2_000);
  assert.equal(state.phase, "playing");
  assert.equal(state.augment?.pendingRecon.black, null);
  assert.equal(state.augment?.triggerCounts.black["spade-total-intelligence"], 1);
  assert.equal(state.augment?.usedBySide.black.includes("spade-total-intelligence"), true);
});

test("reconnaissance cannot spend a pick on an enemy flag whose identity is already public", () => {
  const state = startWithOpeningAugment("spade-supreme-recon", 1_000);
  state.revealedFlags.white = true;
  const publicFlag = state.pieces.find(
    (candidate) => candidate.alive && candidate.side === "white" && candidate.type === "flag",
  );
  assert.ok(publicFlag);
  assert.equal(projectGame(state, "black", 1_000).pieces.find(
    (candidate) => candidate.id === publicFlag.id,
  )?.type, "flag");
  expectRuleError(
    state,
    "black",
    {
      type: "augment_recon",
      augmentId: "spade-supreme-recon",
      target: publicFlag,
    },
    "RECON_TARGET_ALREADY_KNOWN",
  );
});

test("legacy targeted reconnaissance excludes tracked knowledge but still offers a merely public flag", () => {
  const startWithOnlyPublicFlagAvailable = (
    catalogVersion: typeof LEGACY_AUGMENT_CATALOG_VERSION | typeof AUGMENT_CATALOG_VERSION,
  ) => {
    let state = lockOpeningSelections("heart-targeted-recon");
    state.augment!.draft.catalogVersion = catalogVersion;
    state.augment!.permanentReveals.black = state.pieces
      .filter((candidate) => candidate.side === "white" && candidate.type !== "flag")
      .map((candidate) => candidate.id);
    state.revealedFlags.white = true;
    state = applyPlayerAction(state, "black", { type: "ready", value: true }, 1_000);
    return applyPlayerAction(state, "white", { type: "ready", value: true }, 1_000);
  };

  const legacy = startWithOnlyPublicFlagAvailable(LEGACY_AUGMENT_CATALOG_VERSION);
  assert.deepEqual(legacy.augment?.pendingRecon.black, {
    augmentId: "heart-targeted-recon",
    remaining: 1,
  });
  const publicFlag = legacy.pieces.find(
    (candidate) => candidate.side === "white" && candidate.type === "flag",
  )!;
  const legacyView = projectGame(legacy, "black", 1_000);
  assert.deepEqual(legacyView.augment?.pendingRecon?.legalTargets, [
    { row: publicFlag.row, col: publicFlag.col },
  ]);
  assert.deepEqual(
    getProjectedAugmentReconTargets(legacyView, "black", "heart-targeted-recon"),
    [{ row: publicFlag.row, col: publicFlag.col }],
  );

  const current = startWithOnlyPublicFlagAvailable(AUGMENT_CATALOG_VERSION);
  assert.equal(current.augment?.pendingRecon.black, null);
  assert.equal(current.augment?.triggerCounts.black["heart-targeted-recon"], 1);

  const allTracked = lockOpeningSelections("heart-targeted-recon");
  allTracked.augment!.draft.catalogVersion = LEGACY_AUGMENT_CATALOG_VERSION;
  allTracked.augment!.permanentReveals.black = allTracked.pieces
    .filter((candidate) => candidate.side === "white")
    .map((candidate) => candidate.id);
  allTracked.revealedFlags.white = true;
  const blackReady = applyPlayerAction(allTracked, "black", { type: "ready", value: true }, 1_000);
  const started = applyPlayerAction(blackReady, "white", { type: "ready", value: true }, 1_000);
  assert.equal(started.augment?.pendingRecon.black, null);
  assert.equal(projectGame(started, "black", 1_000).augment?.pendingRecon, null);
});

test("legacy targeted reconnaissance rejects tracked knowledge, allows a public flag, and v2 rejects both", () => {
  const makeState = (
    catalogVersion: typeof LEGACY_AUGMENT_CATALOG_VERSION | typeof AUGMENT_CATALOG_VERSION,
    target: "known" | "flag",
  ) => {
    const state = playingState({
      blackAugments: ["heart-targeted-recon"],
      pieces: [
        piece("black-mover", "black", "platoon", 4, 0),
        piece("known-enemy", "white", "division", 8, 4),
        piece("public-flag", "white", "flag", 0, 1),
      ],
    });
    state.augment!.draft.catalogVersion = catalogVersion;
    state.augment!.pendingRecon.black = {
      augmentId: "heart-targeted-recon",
      remaining: 1,
    };
    if (target === "known") state.augment!.permanentReveals.black.push("known-enemy");
    else state.revealedFlags.white = true;
    return state;
  };

  expectRuleError(
    makeState(LEGACY_AUGMENT_CATALOG_VERSION, "known"),
    "black",
    {
      type: "augment_recon",
      augmentId: "heart-targeted-recon",
      target: { row: 8, col: 4 },
    },
    "RECON_TARGET_ALREADY_KNOWN",
  );

  const legacyFlag = applyPlayerAction(
    makeState(LEGACY_AUGMENT_CATALOG_VERSION, "flag"),
    "black",
    {
      type: "augment_recon",
      augmentId: "heart-targeted-recon",
      target: { row: 0, col: 1 },
    },
  );
  assert.equal(legacyFlag.augment?.pendingRecon.black, null);
  assert.equal(legacyFlag.augment?.triggerCounts.black["heart-targeted-recon"], 1);

  for (const target of ["known", "flag"] as const) {
    expectRuleError(
      makeState(AUGMENT_CATALOG_VERSION, target),
      "black",
      {
        type: "augment_recon",
        augmentId: "heart-targeted-recon",
        target: target === "known" ? { row: 8, col: 4 } : { row: 0, col: 1 },
      },
      "RECON_TARGET_ALREADY_KNOWN",
    );
  }
});

test("legacy frontline scout may randomly draw a known piece in its original row window", () => {
  const startWithKnownFrontline = (
    catalogVersion: typeof LEGACY_AUGMENT_CATALOG_VERSION | typeof AUGMENT_CATALOG_VERSION,
  ) => {
    let state = lockOpeningSelections("club-frontline-scout");
    state.augment!.draft.catalogVersion = catalogVersion;
    const eligibleIds = state.pieces
      .filter(
        (candidate) =>
          candidate.side === "white" && candidate.alive && [4, 5].includes(candidate.row),
      )
      .map((candidate) => candidate.id);
    assert.ok(eligibleIds.length > 0);
    state.augment!.permanentReveals.black.push(...eligibleIds);
    state = applyPlayerAction(state, "black", { type: "ready", value: true }, 1_000);
    state = applyPlayerAction(state, "white", { type: "ready", value: true }, 1_000);
    return { state, eligibleIds };
  };

  const legacy = startWithKnownFrontline(LEGACY_AUGMENT_CATALOG_VERSION);
  assert.equal(legacy.state.augment?.temporaryReveals.black.length, 1);
  assert.ok(
    legacy.eligibleIds.includes(legacy.state.augment!.temporaryReveals.black[0]),
  );

  const current = startWithKnownFrontline(AUGMENT_CATALOG_VERSION);
  assert.deepEqual(current.state.augment?.temporaryReveals.black, []);

  const startWithPublicFrontlineFlag = (
    catalogVersion: typeof LEGACY_AUGMENT_CATALOG_VERSION | typeof AUGMENT_CATALOG_VERSION,
  ) => {
    let state = enterSecondDraft(1_000);
    state.augment!.draft.catalogVersion = catalogVersion;
    state.pieces = [
      piece("black-mover", "black", "platoon", 4, 0),
      piece("public-front-flag", "white", "flag", 5, 4),
      piece("white-mover", "white", "platoon", 2, 4),
    ];
    state.revealedFlags.white = true;
    const round = state.augment!.draft.rounds[1];
    const previousOptions = {
      black: [...round.players.black.options],
      white: [...round.players.white.options],
    };
    const options: Record<Side, AugmentOptions> = {
      black: ["club-frontline-scout", "club-forced-march", "club-line-hop"],
      white: ["club-forced-march", "club-line-hop", "club-field-exchange"],
    };
    round.suit = "clubs";
    for (const side of ["black", "white"] as const) {
      state.augment!.draft.seenBySide[side] = state.augment!.draft.seenBySide[side]
        .filter((id) => !previousOptions[side].includes(id));
      round.players[side] = {
        options: options[side],
        selectedId: null,
        locked: false,
        refreshedSlot: null,
      };
      state.augment!.draft.seenBySide[side].push(...options[side]);
    }
    state = applyPlayerAction(state, "black", {
      type: "augment_select",
      augmentId: "club-frontline-scout",
    });
    state = applyPlayerAction(state, "black", { type: "augment_lock" });
    state = applyPlayerAction(state, "white", {
      type: "augment_select",
      augmentId: "club-forced-march",
    });
    return applyPlayerAction(state, "white", { type: "augment_lock" }, 2_000);
  };

  const legacyFlag = startWithPublicFrontlineFlag(LEGACY_AUGMENT_CATALOG_VERSION);
  assert.deepEqual(legacyFlag.augment?.temporaryReveals.black, ["public-front-flag"]);
  const currentFlag = startWithPublicFrontlineFlag(AUGMENT_CATALOG_VERSION);
  assert.deepEqual(currentFlag.augment?.temporaryReveals.black, []);
});

test("frontline scout reveals one eligible enemy only until that exact piece moves", () => {
  let state = startWithOpeningAugment("club-frontline-scout", 1_000);
  const [targetId] = state.augment!.temporaryReveals.black;
  assert.ok(targetId);
  const target = state.pieces.find((candidate) => candidate.id === targetId)!;
  assert.equal(target.side, "white");
  assert.ok([4, 5].includes(target.row));
  assert.equal(projectGame(state, "black", 1_000).pieces.find((candidate) => candidate.id === targetId)?.type, target.type);

  state.turn = "white";
  state.pieces = [
    { ...target, row: 8, col: 4 },
    piece("black-support", "black", "platoon", 3, 0),
  ];
  state.replay = null;
  state.clock!.turnStartedAt = 1_000;
  state = applyPlayerAction(
    state,
    "white",
    { type: "move", from: { row: 8, col: 4 }, to: { row: 9, col: 4 } },
    1_000,
  );
  assert.equal(state.augment?.temporaryReveals.black.includes(targetId), false);
  assert.equal(projectGame(state, "black", 1_000).pieces.find((candidate) => candidate.id === targetId)?.type, null);
});

test("every random reconnaissance card enforces its configured enemy-front row window", () => {
  for (const scenario of [
    { id: "heart-wide-recon" as const, count: 2, rows: [3, 4, 5] },
    { id: "club-frontline-scout" as const, count: 1, rows: [4, 5] },
    { id: "club-local-recon" as const, count: 1, rows: [3, 4, 5] },
    { id: "diamond-front-watch" as const, count: 1, rows: [5] },
  ]) {
    const state = startWithOpeningAugment(scenario.id, 1_000);
    const revealedIds = state.augment?.temporaryReveals.black ?? [];
    assert.equal(revealedIds.length, scenario.count, scenario.id);
    for (const pieceId of revealedIds) {
      const target = state.pieces.find((candidate) => candidate.id === pieceId);
      assert.equal(target?.side, "white", scenario.id);
      assert.ok(target && scenario.rows.includes(target.row), `${scenario.id}:${target?.row}`);
    }
  }
});

test("setup cards allow exactly one forward bomb or deep mine without changing classic placement", () => {
  assert.equal(isAllowedSetupPosition("bomb", "black", { row: 6, col: 0 }), false);
  assert.equal(
    isAllowedSetupPosition(
      "bomb",
      "black",
      { row: 6, col: 0 },
      ["diamond-forward-bomb"],
    ),
    true,
  );
  assert.equal(isAllowedSetupPosition("mine", "black", { row: 9, col: 0 }), false);
  assert.equal(
    isAllowedSetupPosition(
      "mine",
      "black",
      { row: 9, col: 0 },
      ["diamond-deep-mine"],
    ),
    true,
  );

  const forward = createInitialGame();
  const forwardBombs = forward.pieces.filter(
    (candidate) => candidate.side === "black" && candidate.type === "bomb",
  );
  const frontTargets = forward.pieces.filter(
    (candidate) => candidate.side === "black" && candidate.row === 6,
  );
  swapPositions(forwardBombs[0], frontTargets[0]);
  assert.equal(validateSideSetup(forward.pieces, "black"), false);
  assert.equal(validateSideSetup(forward.pieces, "black", ["diamond-forward-bomb"]), true);
  swapPositions(forwardBombs[1], frontTargets[1]);
  assert.equal(validateSideSetup(forward.pieces, "black", ["diamond-forward-bomb"]), false);

  const deep = createInitialGame();
  const mines = deep.pieces.filter(
    (candidate) => candidate.side === "black" && candidate.type === "mine",
  );
  const deepTargets = deep.pieces.filter(
    (candidate) => candidate.side === "black" && candidate.row === 9,
  );
  swapPositions(mines[0], deepTargets[0]);
  assert.equal(validateSideSetup(deep.pieces, "black"), false);
  assert.equal(validateSideSetup(deep.pieces, "black", ["diamond-deep-mine"]), true);
  swapPositions(mines[1], deepTargets[1]);
  assert.equal(validateSideSetup(deep.pieces, "black", ["diamond-deep-mine"]), false);

  const interactiveForward = createInitialGame();
  const interactiveBombs = interactiveForward.pieces.filter(
    (candidate) => candidate.side === "black" && candidate.type === "bomb",
  );
  const interactiveFrontTargets = interactiveForward.pieces.filter(
    (candidate) => candidate.side === "black" && candidate.row === 6,
  );
  let forwardDraft = createSetupDraft(
    interactiveForward.pieces,
    "black",
    true,
    ["diamond-forward-bomb"],
  );
  forwardDraft = applySetupDraftPlacement(
    interactiveForward.pieces,
    "black",
    forwardDraft,
    interactiveBombs[0].id,
    interactiveFrontTargets[0],
    ["diamond-forward-bomb"],
  );
  assert.equal(
    getSetupDraftPlacementViolation(
      interactiveForward.pieces,
      "black",
      forwardDraft,
      interactiveBombs[1].id,
      interactiveFrontTargets[1],
      ["diamond-forward-bomb"],
    ),
    "BOMB_NOT_FRONT_ROW",
  );

  const interactiveDeep = createInitialGame();
  const interactiveMines = interactiveDeep.pieces.filter(
    (candidate) => candidate.side === "black" && candidate.type === "mine",
  );
  const interactiveDeepTargets = interactiveDeep.pieces.filter(
    (candidate) => candidate.side === "black" && candidate.row === 9,
  );
  let deepDraft = createSetupDraft(
    interactiveDeep.pieces,
    "black",
    true,
    ["diamond-deep-mine"],
  );
  deepDraft = applySetupDraftPlacement(
    interactiveDeep.pieces,
    "black",
    deepDraft,
    interactiveMines[0].id,
    interactiveDeepTargets[0],
    ["diamond-deep-mine"],
  );
  assert.equal(
    getSetupDraftPlacementViolation(
      interactiveDeep.pieces,
      "black",
      deepDraft,
      interactiveMines[1].id,
      interactiveDeepTargets[1],
      ["diamond-deep-mine"],
    ),
    "MINE_BACK_TWO_ROWS",
  );

  const classicProjected = createInitialGame();
  const classicBomb = classicProjected.pieces.find(
    (candidate) => candidate.side === "black" && candidate.type === "bomb",
  )!;
  const classicFrontTarget = classicProjected.pieces.find(
    (candidate) => candidate.side === "black" && candidate.row === 6,
  )!;
  assert.equal(
    getProjectedSetupSwapViolation(
      projectGame(classicProjected, "black"),
      "black",
      classicBomb,
      classicFrontTarget,
    ),
    "BOMB_NOT_FRONT_ROW",
  );

  let projectedForward = lockOpeningSelections("diamond-forward-bomb");
  const projectedFirstBomb = projectedForward.pieces.find(
    (candidate) => candidate.side === "black" && candidate.type === "bomb",
  )!;
  const projectedFirstTarget = projectedForward.pieces.find(
    (candidate) => candidate.side === "black" && candidate.row === 6,
  )!;
  assert.equal(
    getProjectedSetupSwapViolation(
      projectGame(projectedForward, "black"),
      "black",
      projectedFirstBomb,
      projectedFirstTarget,
    ),
    null,
  );
  projectedForward = applyPlayerAction(projectedForward, "black", {
    type: "swap",
    from: projectedFirstBomb,
    to: projectedFirstTarget,
  });
  const projectedSecondBomb = projectedForward.pieces.find(
    (candidate) => candidate.side === "black" && candidate.type === "bomb" && candidate.row !== 6,
  )!;
  const projectedSecondTarget = projectedForward.pieces.find(
    (candidate) => candidate.side === "black" && candidate.row === 6 && candidate.type !== "bomb",
  )!;
  assert.equal(
    getProjectedSetupSwapViolation(
      projectGame(projectedForward, "black"),
      "black",
      projectedSecondBomb,
      projectedSecondTarget,
    ),
    "BOMB_NOT_FRONT_ROW",
  );

  let projectedDeep = lockOpeningSelections("diamond-deep-mine");
  const projectedFirstMine = projectedDeep.pieces.find(
    (candidate) => candidate.side === "black" && candidate.type === "mine",
  )!;
  const projectedDeepTarget = projectedDeep.pieces.find(
    (candidate) => candidate.side === "black" && candidate.row === 9,
  )!;
  assert.equal(
    getProjectedSetupSwapViolation(
      projectGame(projectedDeep, "black"),
      "black",
      projectedFirstMine,
      projectedDeepTarget,
    ),
    null,
  );
  projectedDeep = applyPlayerAction(projectedDeep, "black", {
    type: "swap",
    from: projectedFirstMine,
    to: projectedDeepTarget,
  });
  const projectedSecondMine = projectedDeep.pieces.find(
    (candidate) => candidate.side === "black" && candidate.type === "mine" && candidate.row !== 9,
  )!;
  const projectedSecondDeepTarget = projectedDeep.pieces.find(
    (candidate) => candidate.side === "black" && candidate.row === 9 && candidate.type !== "mine",
  )!;
  assert.equal(
    getProjectedSetupSwapViolation(
      projectGame(projectedDeep, "black"),
      "black",
      projectedSecondMine,
      projectedSecondDeepTarget,
    ),
    "MINE_BACK_TWO_ROWS",
  );
});

test("double setup allowances admit exactly two exceptions for either side", () => {
  for (const side of ["black", "white"] as const) {
    for (const scenario of [
      {
        type: "bomb" as const,
        row: side === "black" ? 6 : 5,
        singleId: "diamond-forward-bomb" as const,
        pairId: "diamond-forward-pair" as const,
      },
      {
        type: "mine" as const,
        row: side === "black" ? 9 : 2,
        singleId: "diamond-deep-mine" as const,
        pairId: "diamond-deep-pair" as const,
      },
    ]) {
      const state = createInitialGame();
      const exceptions = state.pieces.filter(
        (candidate) => candidate.side === side && candidate.type === scenario.type,
      );
      const targets = state.pieces.filter(
        (candidate) =>
          candidate.side === side &&
          candidate.row === scenario.row &&
          candidate.type !== scenario.type &&
          candidate.type !== "flag",
      );
      assert.ok(exceptions.length >= 2 && targets.length >= 2);
      swapPositions(exceptions[0], targets[0]);
      swapPositions(exceptions[1], targets[1]);
      assert.equal(validateSideSetup(state.pieces, side), false, `${side}:${scenario.pairId}`);
      assert.equal(
        validateSideSetup(state.pieces, side, [scenario.singleId]),
        false,
        `${side}:${scenario.singleId}`,
      );
      assert.equal(
        validateSideSetup(state.pieces, side, [scenario.pairId]),
        true,
        `${side}:${scenario.pairId}`,
      );
    }
  }
});

test("random setup never exceeds either single or double setup-card allowances", () => {
  let classic = createInitialGame();
  for (let attempt = 0; attempt < 500; attempt += 1) {
    classic = applyPlayerAction(classic, "black", { type: "randomize" });
    assert.equal(validateSideSetup(classic.pieces, "black"), true);
    assert.equal(
      classic.pieces.filter(
        (candidate) =>
          candidate.side === "black" &&
          ((candidate.type === "bomb" && candidate.row === 6) ||
            (candidate.type === "mine" && candidate.row === 9)),
      ).length,
      0,
    );
  }

  for (const { augmentId, max } of [
    { augmentId: "diamond-forward-bomb" as const, max: 1 },
    { augmentId: "diamond-deep-mine" as const, max: 1 },
    { augmentId: "diamond-forward-pair" as const, max: 2 },
    { augmentId: "diamond-deep-pair" as const, max: 2 },
  ]) {
    let state = lockOpeningSelections(augmentId);
    for (let attempt = 0; attempt < 500; attempt += 1) {
      state = applyPlayerAction(state, "black", { type: "randomize" });
      assert.equal(validateSideSetup(state.pieces, "black", [augmentId]), true);
      const exceptionalPieces = state.pieces.filter((candidate) =>
        candidate.side === "black" &&
        (augmentId === "diamond-forward-bomb" || augmentId === "diamond-forward-pair"
          ? candidate.type === "bomb" && candidate.row === 6
          : candidate.type === "mine" && candidate.row === 9)
      );
      assert.ok(exceptionalPieces.length <= max);
    }
  }
});

test("clock cards apply flat, low-time, and five-action bonuses exactly once per charge", () => {
  const cached = startWithOpeningAugment("diamond-time-cache", 1_000);
  assert.equal(cached.clock?.remainingMs.black, cached.clock!.initialMs + 20_000);
  assert.equal(cached.augment?.triggerCounts.black["diamond-time-cache"], 1);

  const reserveClock: GameClock = {
    initialMs: 600_000,
    remainingMs: { black: 59_000, white: 500_000 },
    turnStartedAt: 1_000,
  };
  const reserve = playingState({
    turn: "white",
    blackAugments: ["spade-strategic-reserve"],
    clock: reserveClock,
    pieces: [
      piece("black", "black", "platoon", 3, 0),
      piece("white", "white", "platoon", 8, 4),
    ],
  });
  const rescued = applyPlayerAction(
    reserve,
    "white",
    { type: "move", from: { row: 8, col: 4 }, to: { row: 9, col: 4 } },
    1_000,
  );
  assert.equal(rescued.clock?.remainingMs.black, 179_000);
  assert.equal(rescued.augment?.triggerCounts.black["spade-strategic-reserve"], 1);

  let tempo = playingState({
    blackAugments: ["club-steady-tempo"],
    clock: {
      initialMs: 600_000,
      remainingMs: { black: 100_000, white: 100_000 },
      turnStartedAt: 0,
    },
    pieces: [
      piece("black", "black", "platoon", 3, 0),
      piece("white", "white", "platoon", 8, 4),
    ],
  });
  for (let blackMove = 0; blackMove < 6; blackMove += 1) {
    const blackFrom = blackMove % 2 === 0 ? 3 : 4;
    const blackTo = blackFrom === 3 ? 4 : 3;
    tempo = applyPlayerAction(
      tempo,
      "black",
      { type: "move", from: { row: blackFrom, col: 0 }, to: { row: blackTo, col: 0 } },
      0,
    );
    if (blackMove === 5) break;
    const whiteFrom = blackMove % 2 === 0 ? 8 : 9;
    const whiteTo = whiteFrom === 8 ? 9 : 8;
    tempo = applyPlayerAction(
      tempo,
      "white",
      { type: "move", from: { row: whiteFrom, col: 4 }, to: { row: whiteTo, col: 4 } },
      0,
    );
  }
  assert.equal(tempo.clock?.remainingMs.black, 125_000);
  assert.equal(tempo.augment?.triggerCounts.black["club-steady-tempo"], 5);
});

test("a clock-card increment never deletes time previously granted by another card", () => {
  const state = playingState({
    blackAugments: ["diamond-time-cache", "club-steady-tempo"],
    clock: {
      initialMs: 600_000,
      remainingMs: { black: 620_000, white: 600_000 },
      turnStartedAt: 0,
    },
    pieces: [
      piece("black", "black", "platoon", 3, 0),
      piece("white", "white", "platoon", 8, 4),
    ],
  });
  state.augment!.triggerCounts.black["diamond-time-cache"] = 1;
  state.augment!.usedBySide.black.push("diamond-time-cache");
  const result = applyPlayerAction(
    state,
    "black",
    { type: "move", from: { row: 3, col: 0 }, to: { row: 4, col: 0 } },
    0,
  );
  assert.equal(result.clock?.remainingMs.black, 625_000);
  assert.equal(result.augment?.triggerCounts.black["club-steady-tempo"], 1);
});

test("ranked clock is fixed at ten minutes and grants five seconds only at or below five minutes", () => {
  const ranked = createAugmentGame({ ranked: true });
  assert.equal(ranked.clock?.initialMs, RANKED_TIME_CONTROL_MINUTES * 60_000);
  assert.equal(ranked.clock?.incrementThresholdMs, RANKED_INCREMENT_THRESHOLD_MS);
  assert.equal(ranked.clock?.incrementMs, RANKED_INCREMENT_MS);
  assert.equal(ranked.clock?.incrementCapMs, null);
  expectRuleError(ranked, "black", { type: "set_time_control", minutes: 20 }, "RANKED_TIME_CONTROL_LOCKED");

  const makeClockState = (remainingMs: number) =>
    playingState({
      ranked: true,
      clock: {
        initialMs: 600_000,
        remainingMs: { black: remainingMs, white: 600_000 },
        turnStartedAt: 0,
        incrementMs: RANKED_INCREMENT_MS,
        incrementThresholdMs: RANKED_INCREMENT_THRESHOLD_MS,
        incrementCapMs: null,
      },
      pieces: [
        piece("black", "black", "platoon", 3, 0),
        piece("white", "white", "platoon", 8, 4),
      ],
    });

  const above = applyPlayerAction(
    makeClockState(RANKED_INCREMENT_THRESHOLD_MS + 1),
    "black",
    { type: "move", from: { row: 3, col: 0 }, to: { row: 4, col: 0 } },
    0,
  );
  assert.equal(above.clock?.remainingMs.black, RANKED_INCREMENT_THRESHOLD_MS + 1);

  const exact = applyPlayerAction(
    makeClockState(RANKED_INCREMENT_THRESHOLD_MS),
    "black",
    { type: "move", from: { row: 3, col: 0 }, to: { row: 4, col: 0 } },
    0,
  );
  assert.equal(exact.clock?.remainingMs.black, RANKED_INCREMENT_THRESHOLD_MS + 5_000);

  const oneSecondBelow = applyPlayerAction(
    makeClockState(RANKED_INCREMENT_THRESHOLD_MS - 1_000),
    "black",
    { type: "move", from: { row: 3, col: 0 }, to: { row: 4, col: 0 } },
    0,
  );
  assert.equal(oneSecondBelow.clock?.remainingMs.black, RANKED_INCREMENT_THRESHOLD_MS + 4_000);

  const below = applyPlayerAction(
    makeClockState(RANKED_INCREMENT_THRESHOLD_MS - 6_000),
    "black",
    { type: "move", from: { row: 3, col: 0 }, to: { row: 4, col: 0 } },
    0,
  );
  assert.equal(below.clock?.remainingMs.black, RANKED_INCREMENT_THRESHOLD_MS - 1_000);

  const crossing = applyPlayerAction(
    makeClockState(RANKED_INCREMENT_THRESHOLD_MS + 5_000),
    "black",
    { type: "move", from: { row: 3, col: 0 }, to: { row: 4, col: 0 } },
    10_000,
  );
  assert.equal(crossing.clock?.remainingMs.black, RANKED_INCREMENT_THRESHOLD_MS);

  const stacked = makeClockState(RANKED_INCREMENT_THRESHOLD_MS - 1_000);
  stacked.augment!.draft.loadouts.black = ["club-steady-tempo"];
  const stackedResult = applyPlayerAction(
    stacked,
    "black",
    { type: "move", from: { row: 3, col: 0 }, to: { row: 4, col: 0 } },
    0,
  );
  assert.equal(stackedResult.clock?.remainingMs.black, RANKED_INCREMENT_THRESHOLD_MS + 9_000);
  assert.equal(stackedResult.augment?.triggerCounts.black["club-steady-tempo"], 1);

  const legacyCapped = makeClockState(RANKED_INCREMENT_THRESHOLD_MS);
  legacyCapped.clock!.incrementCapMs = RANKED_INCREMENT_THRESHOLD_MS;
  const legacyResult = applyPlayerAction(
    legacyCapped,
    "black",
    { type: "move", from: { row: 3, col: 0 }, to: { row: 4, col: 0 } },
    0,
  );
  assert.equal(legacyResult.clock?.remainingMs.black, RANKED_INCREMENT_THRESHOLD_MS);
});

test("hidden friend spectators inherit only the friend's knowledge while custom full view sees both armies", () => {
  const state = startWithOpeningAugment("heart-rail-turn", 1_000);
  const hidden = projectGame(state, "spectator", 1_000, {
    spectatorPolicy: "hidden",
    spectatorPerspective: "black",
  });
  assert.equal(hidden.pieces.filter((candidate) => candidate.side === "black" && candidate.type).length, 25);
  assert.equal(hidden.pieces.filter((candidate) => candidate.side === "white" && candidate.type).length, 0);
  assert.equal(hidden.replay, null);
  assert.equal(hidden.augment?.draft.loadouts.black[0], "heart-rail-turn");
  assert.equal(hidden.augment?.draft.loadouts.white[0], "heart-rail-turn");

  const anonymousHidden = projectGame(state, "spectator", 1_000, {
    spectatorPolicy: "hidden",
  });
  assert.equal(anonymousHidden.pieces.filter((candidate) => candidate.type).length, 0);

  const full = projectGame(state, "spectator", 1_000, { spectatorPolicy: "full" });
  assert.equal(full.pieces.filter((candidate) => candidate.type).length, 50);
  assert.ok(full.replay);
});

test("reveal provenance is private to the knowledge side and its safe friend perspective", () => {
  const state = startWithOpeningAugment("heart-targeted-recon", 1_000);
  const whiteTargets = state.pieces.filter((candidate) => candidate.side === "white").slice(0, 2);
  const blackTargets = state.pieces.filter((candidate) => candidate.side === "black").slice(0, 2);
  state.augment!.permanentReveals.black = [whiteTargets[0].id];
  state.augment!.temporaryReveals.black = [whiteTargets[1].id];
  state.augment!.permanentReveals.white = [blackTargets[0].id];
  state.augment!.temporaryReveals.white = [blackTargets[1].id];

  const black = projectGame(state, "black", 1_000);
  assert.deepEqual(black.augment?.permanentRevealIds, [whiteTargets[0].id]);
  assert.deepEqual(black.augment?.temporaryRevealIds, [whiteTargets[1].id]);
  assert.equal(black.augment?.permanentRevealIds?.includes(blackTargets[0].id), false);
  assert.equal(black.augment?.temporaryRevealIds?.includes(blackTargets[1].id), false);

  const white = projectGame(state, "white", 1_000);
  assert.deepEqual(white.augment?.permanentRevealIds, [blackTargets[0].id]);
  assert.deepEqual(white.augment?.temporaryRevealIds, [blackTargets[1].id]);

  const friend = projectGame(state, "spectator", 1_000, {
    spectatorPolicy: "hidden",
    spectatorPerspective: "black",
  });
  assert.deepEqual(friend.augment?.permanentRevealIds, black.augment?.permanentRevealIds);
  assert.deepEqual(friend.augment?.temporaryRevealIds, black.augment?.temporaryRevealIds);

  for (const spectator of [
    projectGame(state, "spectator", 1_000, { spectatorPolicy: "hidden" }),
    projectGame(state, "spectator", 1_000, { spectatorPolicy: "full" }),
  ]) {
    assert.ok(spectator.augment);
    assert.equal("permanentRevealIds" in spectator.augment, false);
    assert.equal("temporaryRevealIds" in spectator.augment, false);
  }
});

test("the thirty-card v2 execution ledger exercises server rules, events, replay, privacy, setup, clocks, and no-moves", () => {
  const executed = new Set<AugmentId>();
  const movementCases: Array<{
    id: AugmentId;
    moverType: PieceType;
    from: Position;
    to: Position;
    defender?: Piece;
  }> = [
    { id: "spade-rail-dominion", moverType: "platoon", from: { row: 1, col: 2 }, to: { row: 5, col: 4 } },
    { id: "spade-serpentine-offensive", moverType: "platoon", from: { row: 1, col: 2 }, to: { row: 5, col: 4 } },
    {
      id: "spade-deep-strike",
      moverType: "commander",
      from: { row: 3, col: 0 },
      to: { row: 6, col: 0 },
      defender: piece("target", "white", "platoon", 6, 0),
    },
    { id: "spade-global-redeployment", moverType: "platoon", from: { row: 7, col: 1 }, to: { row: 2, col: 1 } },
    { id: "heart-mobile-rail", moverType: "platoon", from: { row: 1, col: 2 }, to: { row: 5, col: 4 } },
    { id: "heart-double-turn", moverType: "platoon", from: { row: 1, col: 2 }, to: { row: 5, col: 4 } },
    { id: "heart-breakthrough", moverType: "platoon", from: { row: 3, col: 0 }, to: { row: 6, col: 0 } },
    { id: "heart-camp-network", moverType: "platoon", from: { row: 7, col: 1 }, to: { row: 2, col: 1 } },
    { id: "club-rail-passage", moverType: "platoon", from: { row: 1, col: 2 }, to: { row: 5, col: 0 } },
    { id: "club-rail-switch", moverType: "company", from: { row: 1, col: 2 }, to: { row: 5, col: 0 } },
    { id: "club-road-patrol", moverType: "platoon", from: { row: 3, col: 0 }, to: { row: 5, col: 0 } },
    { id: "club-camp-relay", moverType: "platoon", from: { row: 7, col: 1 }, to: { row: 9, col: 3 } },
    { id: "diamond-road-step", moverType: "company", from: { row: 3, col: 0 }, to: { row: 5, col: 0 } },
    { id: "diamond-camp-relay", moverType: "platoon", from: { row: 7, col: 1 }, to: { row: 9, col: 3 } },
  ];

  for (const scenario of movementCases) {
    const state = playingState({
      blackAugments: [scenario.id],
      pieces: [
        piece("mover", "black", scenario.moverType, scenario.from.row, scenario.from.col),
        ...(scenario.defender ? [scenario.defender] : []),
        piece("white-support", "white", "engineer", 8, 4),
      ],
    });
    assert.equal(
      getAugmentMoveViolation(state, "black", scenario.id, scenario.from, scenario.to),
      null,
      scenario.id,
    );
    const result = applyPlayerAction(state, "black", {
      type: "augment_move",
      augmentId: scenario.id,
      from: scenario.from,
      to: scenario.to,
    });
    assert.equal(result.augment?.triggerCounts.black[scenario.id], 1, scenario.id);
    assert.equal(result.replay?.moves.at(-1)?.augmentId, scenario.id, scenario.id);
    assert.ok(
      result.events.some(
        (event) => event.result === "augment_used" && event.augmentId === scenario.id,
      ),
      scenario.id,
    );
    executed.add(scenario.id);
  }

  const emptyOnly = playingState({
    blackAugments: ["heart-mobile-rail"],
    pieces: [
      piece("mover", "black", "platoon", 1, 2),
      piece("enemy", "white", "platoon", 5, 0),
    ],
  });
  assert.equal(
    getAugmentMoveViolation(
      emptyOnly,
      "black",
      "heart-mobile-rail",
      { row: 1, col: 2 },
      { row: 5, col: 0 },
    ),
    "AUGMENT_REQUIRES_EMPTY_TARGET",
  );
  const juniorOnly = playingState({
    blackAugments: ["diamond-road-step"],
    pieces: [
      piece("mover", "black", "commander", 3, 0),
      piece("white", "white", "platoon", 8, 4),
    ],
  });
  assert.equal(
    getAugmentMoveViolation(
      juniorOnly,
      "black",
      "diamond-road-step",
      { row: 3, col: 0 },
      { row: 5, col: 0 },
    ),
    "AUGMENT_PIECE_INELIGIBLE",
  );

  for (const scenario of [
    { id: "spade-command-chain" as const, capture: false },
    { id: "spade-counteroffensive" as const, capture: true },
    { id: "heart-victory-momentum" as const, capture: true },
  ]) {
    const state = playingState({
      blackAugments: [scenario.id],
      pieces: [
        piece("mover", "black", scenario.capture ? "commander" : "platoon", 3, 0),
        piece("reserve", "black", "platoon", 8, 0),
        ...(scenario.capture ? [piece("victim", "white", "platoon", 3, 1)] : []),
        piece("white-support", "white", "engineer", 8, 4),
      ],
    });
    const result = applyPlayerAction(state, "black", {
      type: "move",
      from: { row: 3, col: 0 },
      to: scenario.capture ? { row: 3, col: 1 } : { row: 4, col: 0 },
    });
    assert.equal(result.turn, "black", scenario.id);
    assert.equal(result.augment?.extraMove.black?.augmentId, scenario.id, scenario.id);
    assert.equal(result.augment?.triggerCounts.black[scenario.id], 1, scenario.id);
    assert.ok(result.events.some((event) => event.augmentId === scenario.id), scenario.id);
    if (scenario.id === "heart-victory-momentum") {
      const samePieceFollowup = applyPlayerAction(result, "black", {
        type: "move",
        from: scenario.capture ? { row: 3, col: 1 } : { row: 4, col: 0 },
        to: scenario.capture ? { row: 3, col: 2 } : { row: 5, col: 0 },
      });
      assert.equal(samePieceFollowup.turn, "white");
    } else {
      expectRuleError(
        result,
        "black",
        {
          type: "move",
          from: scenario.capture ? { row: 3, col: 1 } : { row: 4, col: 0 },
          to: scenario.capture ? { row: 3, col: 2 } : { row: 5, col: 0 },
        },
        "EXTRA_MOVE_DIFFERENT_PIECE",
      );
      const otherPieceFollowup = applyPlayerAction(result, "black", {
        type: "move",
        from: { row: 8, col: 0 },
        to: { row: 7, col: 0 },
      });
      assert.equal(otherPieceFollowup.turn, "white");
    }
    executed.add(scenario.id);
  }

  for (const scenario of [
    { id: "spade-shadow-retreat" as const, attacker: "platoon" as const, expectedAlive: true },
    { id: "heart-orderly-withdrawal" as const, attacker: "platoon" as const, expectedAlive: true },
    { id: "club-engineer-oath" as const, attacker: "engineer" as const, expectedAlive: false },
  ]) {
    const state = playingState({
      blackAugments: [scenario.id],
      pieces: [
        piece("attacker", "black", scenario.attacker, 3, 0),
        piece("defender", "white", "commander", 3, 1),
        piece("white-support", "white", "platoon", 8, 4),
      ],
    });
    const result = applyPlayerAction(state, "black", {
      type: "move",
      from: { row: 3, col: 0 },
      to: { row: 3, col: 1 },
    });
    assert.equal(
      result.pieces.find((candidate) => candidate.id === "attacker")?.alive,
      scenario.expectedAlive,
      scenario.id,
    );
    assert.equal(result.augment?.triggerCounts.black[scenario.id], 1, scenario.id);
    assert.equal(result.replay?.moves.at(-1)?.augmentId, scenario.id, scenario.id);
    executed.add(scenario.id);
  }
  const highRankWithdrawal = playingState({
    blackAugments: ["heart-orderly-withdrawal"],
    pieces: [
      piece("attacker", "black", "general", 3, 0),
      piece("defender", "white", "commander", 3, 1),
      piece("white-support", "white", "platoon", 8, 4),
    ],
  });
  const highRankResult = applyPlayerAction(highRankWithdrawal, "black", {
    type: "move",
    from: { row: 3, col: 0 },
    to: { row: 3, col: 1 },
  });
  assert.equal(highRankResult.pieces.find((candidate) => candidate.id === "attacker")?.alive, false);
  assert.equal(highRankResult.augment?.triggerCounts.black["heart-orderly-withdrawal"], undefined);

  let supreme = startWithOpeningAugment("spade-supreme-recon", 1_000);
  assert.equal(supreme.augment?.pendingRecon.black?.remaining, 3);
  assert.equal(projectGame(supreme, "white", 1_000).augment?.pendingRecon, null);
  const supremePending = projectGame(supreme, "black", 1_000).augment?.pendingRecon;
  assert.equal(supremePending?.augmentId, "spade-supreme-recon");
  assert.equal(supremePending?.remaining, 3);
  assert.equal(supremePending?.legalTargets?.length, 25);
  for (const target of supreme.pieces.filter((candidate) => candidate.side === "white").slice(0, 3)) {
    supreme = applyPlayerAction(supreme, "black", {
      type: "augment_recon",
      augmentId: "spade-supreme-recon",
      target,
    }, 1_000);
  }
  assert.equal(supreme.augment?.pendingRecon.black, null);
  assert.equal(supreme.augment?.triggerCounts.black["spade-supreme-recon"], 1);
  executed.add("spade-supreme-recon");

  for (const scenario of [
    { id: "heart-wide-recon" as const, count: 2 },
    { id: "club-local-recon" as const, count: 1 },
    { id: "diamond-front-watch" as const, count: 1 },
  ]) {
    const state = startWithOpeningAugment(scenario.id, 1_000);
    assert.equal(state.augment?.temporaryReveals.black.length, scenario.count, scenario.id);
    assert.equal(state.augment?.triggerCounts.black[scenario.id], 1, scenario.id);
    executed.add(scenario.id);
  }

  const initialMs = 20 * 60_000;
  for (const scenario of [
    { id: "club-pocket-time" as const, bonusMs: 45_000 },
    { id: "diamond-pocket-watch" as const, bonusMs: 10_000 },
  ]) {
    const state = startWithOpeningAugment(scenario.id, 1_000);
    assert.equal(state.clock?.remainingMs.black, initialMs + scenario.bonusMs, scenario.id);
    assert.equal(state.augment?.triggerCounts.black[scenario.id], 1, scenario.id);
    executed.add(scenario.id);
  }
  const reserve = playingState({
    turn: "white",
    blackAugments: ["heart-reserve-clock"],
    clock: {
      initialMs: 600_000,
      remainingMs: { black: 59_000, white: 500_000 },
      turnStartedAt: 1_000,
    },
    pieces: [
      piece("black", "black", "platoon", 3, 0),
      piece("white", "white", "platoon", 8, 4),
    ],
  });
  const reserveResult = applyPlayerAction(
    reserve,
    "white",
    { type: "move", from: { row: 8, col: 4 }, to: { row: 9, col: 4 } },
    1_000,
  );
  assert.equal(reserveResult.clock?.remainingMs.black, 149_000);
  assert.equal(reserveResult.augment?.triggerCounts.black["heart-reserve-clock"], 1);
  executed.add("heart-reserve-clock");

  const drill = playingState({
    blackAugments: ["diamond-drill"],
    clock: {
      initialMs: 600_000,
      remainingMs: { black: 100_000, white: 100_000 },
      turnStartedAt: 0,
    },
    pieces: [
      piece("black", "black", "platoon", 3, 0),
      piece("white", "white", "platoon", 8, 4),
    ],
  });
  const drillResult = applyPlayerAction(
    drill,
    "black",
    { type: "move", from: { row: 3, col: 0 }, to: { row: 4, col: 0 } },
    0,
  );
  assert.equal(drillResult.clock?.remainingMs.black, 102_000);
  assert.equal(drillResult.augment?.triggerCounts.black["diamond-drill"], 1);
  executed.add("diamond-drill");

  for (const scenario of [
    { id: "diamond-forward-pair" as const, type: "bomb" as const, row: 6 },
    { id: "diamond-deep-pair" as const, type: "mine" as const, row: 9 },
  ]) {
    let state = lockOpeningSelections(scenario.id);
    let draft = createSetupDraft(state.pieces, "black", true, [scenario.id]);
    const exceptions = state.pieces.filter(
      (candidate) => candidate.side === "black" && candidate.type === scenario.type,
    );
    const targets = state.pieces.filter(
      (candidate) =>
        candidate.side === "black" &&
        candidate.row === scenario.row &&
        candidate.type !== scenario.type &&
        candidate.type !== "flag",
    );
    assert.ok(exceptions.length >= 2 && targets.length >= 2, scenario.id);
    for (let index = 0; index < 2; index += 1) {
      draft = applySetupDraftPlacement(
        state.pieces,
        "black",
        draft,
        exceptions[index].id,
        targets[index],
        [scenario.id],
      );
    }
    if (scenario.type === "mine") {
      assert.equal(
        getSetupDraftPlacementViolation(
          state.pieces,
          "black",
          draft,
          exceptions[2].id,
          targets[2],
          [scenario.id],
        ),
        "MINE_BACK_TWO_ROWS",
      );
    }
    const layout = setupDraftToLayout(state.pieces, "black", draft, [scenario.id]);
    state = applyPlayerAction(state, "black", { type: "ready", value: true, layout }, 1_000);
    state = applyPlayerAction(state, "white", { type: "ready", value: true }, 1_000);
    assert.equal(state.augment?.triggerCounts.black[scenario.id], 1, scenario.id);
    assert.equal(
      state.pieces.filter(
        (candidate) =>
          candidate.side === "black" &&
          candidate.type === scenario.type &&
          candidate.row === scenario.row,
      ).length,
      2,
      scenario.id,
    );
    executed.add(scenario.id);
  }

  const stalled = playingState({
    turn: "white",
    blackAugments: ["diamond-camp-relay"],
    pieces: [
      piece("camp-mover", "black", "platoon", 7, 1),
      ...[
        [6, 0], [6, 1], [6, 2], [7, 0], [7, 2], [8, 0], [8, 1], [8, 2],
      ].map(([row, col], index) => piece(`block-${index}`, "black", "mine", row, col)),
      piece("white", "white", "platoon", 8, 4),
    ],
  });
  const stalledResult = applyPlayerAction(stalled, "white", {
    type: "move",
    from: { row: 8, col: 4 },
    to: { row: 9, col: 4 },
  });
  assert.equal(stalledResult.phase, "playing");
  assert.equal(stalledResult.turn, "black");
  assert.equal(stalledResult.finishReason, null);

  const legacyIds = new Set<AugmentId>(LEGACY_AUGMENT_IDS);
  const expectedNewIds = AUGMENT_IDS.filter((id) => !legacyIds.has(id)).sort();
  assert.deepEqual(Object.keys(NEW_AUGMENT_EXECUTION_LEDGER).sort(), expectedNewIds);
  assert.deepEqual([...executed].sort(), expectedNewIds);
});

test("one million seeded drafts have reproducible suit and card exposure fairness", { timeout: 180_000 }, (t) => {
  const runs = 1_000_000;
  const random = createSeededAugmentRandom("junqi-augment-fairness-v2-1000000");
  const sides = ["black", "white"] as const;
  const firstSuitCounts = Object.fromEntries(AUGMENT_SUITS.map((suit) => [suit, 0])) as Record<AugmentSuit, number>;
  const secondSuitCounts = Object.fromEntries(AUGMENT_SUITS.map((suit) => [suit, 0])) as Record<AugmentSuit, number>;
  const exposure = {
    first: {
      black: Object.fromEntries(ALL_AUGMENT_IDS.map((id) => [id, 0])) as Record<AugmentId, number>,
      white: Object.fromEntries(ALL_AUGMENT_IDS.map((id) => [id, 0])) as Record<AugmentId, number>,
    },
    second: {
      black: Object.fromEntries(ALL_AUGMENT_IDS.map((id) => [id, 0])) as Record<AugmentId, number>,
      white: Object.fromEntries(ALL_AUGMENT_IDS.map((id) => [id, 0])) as Record<AugmentId, number>,
    },
  };
  let suitMismatchCount = 0;
  let repeatedSeenCount = 0;
  let refreshedCardReappearedCount = 0;

  for (let run = 0; run < runs; run += 1) {
    let draft = createAugmentDraftState({ random });
    const firstSuit = draft.rounds[0].suit;
    firstSuitCounts[firstSuit] += 1;
    const firstSeen: Record<Side, AugmentId[]> = { black: [], white: [] };
    const refreshedAway: Record<Side, AugmentId[]> = { black: [], white: [] };

    for (const [sideIndex, side] of sides.entries()) {
      const roundBefore = draft.rounds[0];
      if (roundBefore.players[side].options.some((id) => getAugmentDefinition(id).suit !== firstSuit)) {
        suitMismatchCount += 1;
      }
      const slot = ((run + sideIndex) % 3) as 0 | 1 | 2;
      const oldOptions = [...roundBefore.players[side].options];
      const removedId = oldOptions[slot];
      draft = refreshAugmentOption(draft, side, slot, random);
      const roundAfter = draft.rounds[0];
      const replacement = roundAfter.players[side].options[slot];
      refreshedAway[side].push(removedId);
      if (
        oldOptions.includes(replacement) ||
        roundAfter.players[side].options.includes(removedId)
      ) {
        refreshedCardReappearedCount += 1;
      }
      if (roundAfter.players[side].options.some((id) => getAugmentDefinition(id).suit !== firstSuit)) {
        suitMismatchCount += 1;
      }
      firstSeen[side] = [...draft.seenBySide[side]];
      if (new Set(firstSeen[side]).size !== firstSeen[side].length) repeatedSeenCount += 1;
      for (const id of firstSeen[side]) exposure.first[side][id] += 1;
    }

    for (const [sideIndex, side] of sides.entries()) {
      const options = draft.rounds[0].players[side].options;
      draft = chooseAndLockAugment(draft, side, options[(run + sideIndex) % options.length]);
    }
    draft = revealCurrentAugmentRound(draft);
    draft = beginSecondAugmentDraft(draft, { random });
    const secondSuit = draft.rounds[1].suit;
    secondSuitCounts[secondSuit] += 1;
    if (secondSuit === firstSuit) suitMismatchCount += 1;

    for (const [sideIndex, side] of sides.entries()) {
      const roundBefore = draft.rounds[1];
      if (
        roundBefore.players[side].options.some(
          (id) =>
            getAugmentDefinition(id).suit !== secondSuit ||
            getAugmentDefinition(id).activation === "setup",
        )
      ) {
        suitMismatchCount += 1;
      }
      const seenBeforeSecondRefresh = new Set(draft.seenBySide[side]);
      const slot = ((run + sideIndex + 1) % 3) as 0 | 1 | 2;
      const oldOptions = [...roundBefore.players[side].options];
      const removedId = oldOptions[slot];
      const previouslyRefreshedAway = new Set(refreshedAway[side]);
      draft = refreshAugmentOption(draft, side, slot, random);
      const roundAfter = draft.rounds[1];
      const replacement = roundAfter.players[side].options[slot];
      refreshedAway[side].push(removedId);
      if (
        seenBeforeSecondRefresh.has(replacement) ||
        roundAfter.players[side].options.includes(removedId)
      ) {
        refreshedCardReappearedCount += 1;
      }
      if (
        roundAfter.players[side].options.some(
          (id) =>
            getAugmentDefinition(id).suit !== secondSuit ||
            getAugmentDefinition(id).activation === "setup",
        )
      ) {
        suitMismatchCount += 1;
      }
      const newlySeen = draft.seenBySide[side].filter((id) => !firstSeen[side].includes(id));
      if (
        newlySeen.length !== 4 ||
        newlySeen.some((id) => firstSeen[side].includes(id)) ||
        [...previouslyRefreshedAway].some((id) => newlySeen.includes(id))
      ) {
        repeatedSeenCount += 1;
      }
      for (const id of newlySeen) exposure.second[side][id] += 1;
    }

    for (const [sideIndex, side] of sides.entries()) {
      const options = draft.rounds[1].players[side].options;
      draft = chooseAndLockAugment(draft, side, options[(run + sideIndex) % options.length]);
      if (new Set(draft.seenBySide[side]).size !== draft.seenBySide[side].length) {
        repeatedSeenCount += 1;
      }
    }
    draft = revealCurrentAugmentRound(draft);
    if (draft.loadouts.black.length !== 2 || draft.loadouts.white.length !== 2) {
      repeatedSeenCount += 1;
    }
  }

  assert.equal(suitMismatchCount, 0);
  assert.equal(repeatedSeenCount, 0);
  assert.equal(refreshedCardReappearedCount, 0);

  const chiSquare = (counts: number[], expected: number) =>
    counts.reduce((total, observed) => total + ((observed - expected) ** 2) / expected, 0);
  const firstSuitChiSquare = chiSquare(
    AUGMENT_SUITS.map((suit) => firstSuitCounts[suit]),
    runs / 4,
  );
  const secondSuitChiSquare = chiSquare(
    AUGMENT_SUITS.map((suit) => secondSuitCounts[suit]),
    runs / 4,
  );
  assert.ok(firstSuitChiSquare < 16.27, `first-round suit chi-square ${firstSuitChiSquare}`);
  assert.ok(secondSuitChiSquare < 16.27, `second-round suit chi-square ${secondSuitChiSquare}`);
  assert.ok(secondSuitCounts.diamonds > 0);

  for (const id of ALL_AUGMENT_IDS) {
    const firstRates = sides.map((side) => exposure.first[side][id] / runs);
    const secondRates = sides.map((side) => exposure.second[side][id] / runs);
    for (const rate of firstRates) {
      const suitSize = getAugmentsBySuit(getAugmentDefinition(id).suit).length;
      assert.ok(Math.abs(rate - 1 / suitSize) < 0.01, `${id} first-round exposure ${rate}`);
    }
    const definition = getAugmentDefinition(id);
    const eligibleInSuit = getAugmentsBySuit(definition.suit)
      .filter((candidate) => candidate.activation !== "setup").length;
    const expectedSecondRate = definition.activation === "setup" ? 0 : 1 / eligibleInSuit;
    for (const rate of secondRates) {
      assert.ok(
        Math.abs(rate - expectedSecondRate) < 0.01,
        `${id} second-round exposure ${rate}`,
      );
    }
    const percentRange = (rates: number[]) =>
      `${(Math.min(...rates) * 100).toFixed(3)}%–${(Math.max(...rates) * 100).toFixed(3)}%`;
    t.diagnostic(
      `${id}: 首轮 ${percentRange(firstRates)}；次轮 ${percentRange(secondRates)}`,
    );
  }
  t.diagnostic(
    `花色 χ²：首轮=${firstSuitChiSquare.toFixed(3)}（4花色），次轮=${secondSuitChiSquare.toFixed(3)}（4花色）`,
  );
  t.diagnostic("本模拟只验证固定种子的抽取与曝光公平，不代表真实对局胜率或强化强度平衡。");
});
