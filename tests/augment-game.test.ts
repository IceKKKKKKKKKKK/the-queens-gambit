import assert from "node:assert/strict";
import test from "node:test";
import {
  AUGMENT_CATALOG,
  AUGMENT_CATALOG_VERSION,
  AUGMENT_SUITS,
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
  GameRuleError,
  RANKED_INCREMENT_MS,
  RANKED_INCREMENT_THRESHOLD_MS,
  RANKED_TIME_CONTROL_MINUTES,
  applySetupDraftPlacement,
  applyPlayerAction,
  buildReplayFrames,
  createAugmentGame,
  createInitialGame,
  createSetupDraft,
  gameModeForState,
  getAugmentMoveViolation,
  getProjectedSetupSwapViolation,
  getSetupDraftPlacementViolation,
  isAllowedSetupPosition,
  projectGame,
  settleExpiredAugmentDraft,
  validateSideSetup,
  type GameClock,
  type GameState,
  type Piece,
  type PieceType,
  type PlayerAction,
  type Position,
  type Side,
} from "../lib/game.ts";

const ALL_AUGMENT_IDS = [
  "spade-grand-maneuver",
  "spade-relentless-assault",
  "spade-tactical-retreat",
  "spade-total-intelligence",
  "spade-strategic-reserve",
  "heart-rail-turn",
  "heart-initiative",
  "heart-remote-exchange",
  "heart-bomb-disposal",
  "heart-targeted-recon",
  "club-forced-march",
  "club-line-hop",
  "club-field-exchange",
  "club-steady-tempo",
  "club-frontline-scout",
  "diamond-camp-transfer",
  "diamond-forward-bomb",
  "diamond-deep-mine",
  "diamond-engineer-screen",
  "diamond-time-cache",
] as const satisfies readonly AugmentId[];

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

function optionsWith(first: AugmentId): AugmentOptions {
  const suit = getAugmentDefinition(first).suit;
  return [
    first,
    ...getAugmentsBySuit(suit)
      .map((augment) => augment.id)
      .filter((id) => id !== first)
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

test("the augment engine coverage ledger names every one of the twenty cards", () => {
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

test("random setup never spends a setup-card exception more than once", () => {
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

  for (const augmentId of ["diamond-forward-bomb", "diamond-deep-mine"] as const) {
    let state = lockOpeningSelections(augmentId);
    for (let attempt = 0; attempt < 500; attempt += 1) {
      state = applyPlayerAction(state, "black", { type: "randomize" });
      assert.equal(validateSideSetup(state.pieces, "black", [augmentId]), true);
      const exceptionalPieces = state.pieces.filter((candidate) =>
        candidate.side === "black" &&
        (augmentId === "diamond-forward-bomb"
          ? candidate.type === "bomb" && candidate.row === 6
          : candidate.type === "mine" && candidate.row === 9)
      );
      assert.ok(exceptionalPieces.length <= 1);
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

test("one hundred thousand seeded drafts have reproducible suit and card exposure fairness", { timeout: 120_000 }, (t) => {
  const runs = 100_000;
  const random = createSeededAugmentRandom("junqi-augment-fairness-v1-100000");
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
    if (secondSuit === firstSuit || secondSuit === "diamonds") suitMismatchCount += 1;

    for (const [sideIndex, side] of sides.entries()) {
      const roundBefore = draft.rounds[1];
      if (roundBefore.players[side].options.some((id) => getAugmentDefinition(id).suit !== secondSuit)) {
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
      if (roundAfter.players[side].options.some((id) => getAugmentDefinition(id).suit !== secondSuit)) {
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
    (["spades", "hearts", "clubs"] as const).map((suit) => secondSuitCounts[suit]),
    runs / 3,
  );
  assert.ok(firstSuitChiSquare < 16.27, `first-round suit chi-square ${firstSuitChiSquare}`);
  assert.ok(secondSuitChiSquare < 13.82, `second-round suit chi-square ${secondSuitChiSquare}`);
  assert.equal(secondSuitCounts.diamonds, 0);

  for (const id of ALL_AUGMENT_IDS) {
    const firstRates = sides.map((side) => exposure.first[side][id] / runs);
    const secondRates = sides.map((side) => exposure.second[side][id] / runs);
    for (const rate of firstRates) {
      assert.ok(Math.abs(rate - 0.2) < 0.01, `${id} first-round exposure ${rate}`);
    }
    const expectedSecondRate = getAugmentDefinition(id).suit === "diamonds" ? 0 : 4 / 15;
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
    `花色 χ²：首轮=${firstSuitChiSquare.toFixed(3)}（4花色），次轮=${secondSuitChiSquare.toFixed(3)}（3花色）`,
  );
  t.diagnostic("本模拟只验证固定种子的抽取与曝光公平，不代表真实对局胜率或强化强度平衡。");
});
