import assert from "node:assert/strict";
import test from "node:test";
import {
  GameRuleError,
  PIECE_INFO,
  applyPlayerAction,
  applySetupDraftPlacement,
  createSetupDraft,
  createInitialGame,
  getCampMotionForPosition,
  getMoveViolation,
  getSetupDraftPlacementViolation,
  getSetupSwapViolation,
  isAllowedSetupPosition,
  isRailEdge,
  isRoadEdge,
  isValidSetupDraft,
  latestMovementEvent,
  projectGame,
  randomizeSetupDraft,
  setupDraftToLayout,
  validateSideSetup,
  type GameState,
  type Piece,
  type PieceType,
  type PlayerAction,
  type Position,
  type PublicEvent,
  type Side,
} from "../lib/game.ts";

const MOBILE_TYPES = (Object.keys(PIECE_INFO) as PieceType[]).filter(
  (type) => type !== "flag" && type !== "mine",
);

function piece(id: string, side: Side, type: PieceType, row: number, col: number): Piece {
  return { id, side, type, row, col, alive: true };
}

function stateWith(pieces: Piece[], turn: Side = "black"): GameState {
  return {
    rulesVersion: "classic-duel-dark-v2",
    phase: "playing",
    joined: { black: true, white: true },
    ready: { black: true, white: true },
    firstTurn: turn,
    turn,
    winner: null,
    finishReason: null,
    revealedFlags: { black: false, white: false },
    pieces,
    events: [],
    moveNumber: 0,
  };
}

function expectRuleError(state: GameState, side: Side, action: PlayerAction, code: string) {
  assert.throws(
    () => applyPlayerAction(state, side, action),
    (error: unknown) => error instanceof GameRuleError && error.code === code,
  );
}

test("v2 board graph and random layouts satisfy the selected classic rules", () => {
  const nodes = Array.from({ length: 12 }, (_, row) =>
    Array.from({ length: 5 }, (_, col) => ({ row, col })),
  ).flat();
  let roads = 0;
  let rails = 0;
  for (let first = 0; first < nodes.length; first += 1) {
    for (let second = first + 1; second < nodes.length; second += 1) {
      if (isRoadEdge(nodes[first], nodes[second])) roads += 1;
      if (isRailEdge(nodes[first], nodes[second])) rails += 1;
    }
  }
  assert.equal(nodes.length, 60);
  assert.equal(roads, 133);
  assert.equal(rails, 35);

  for (let run = 0; run < 20; run += 1) {
    const state = createInitialGame();
    assert.equal(state.rulesVersion, "classic-duel-dark-v2");
    assert.equal(validateSideSetup(state.pieces, "black"), true);
    assert.equal(validateSideSetup(state.pieces, "white"), true);
  }
  assert.equal(isAllowedSetupPosition("flag", "black", { row: 11, col: 1 }), true);
  assert.equal(isAllowedSetupPosition("flag", "black", { row: 10, col: 1 }), false);
  assert.equal(isAllowedSetupPosition("mine", "white", { row: 2, col: 0 }), false);
  assert.equal(isAllowedSetupPosition("bomb", "white", { row: 5, col: 0 }), false);
});

test("camp motion marks only the moving attacker and its camp station", () => {
  const enter = {
    id: 1,
    actor: "black",
    from: { row: 6, col: 1 },
    to: { row: 7, col: 1 },
    result: "move",
  } satisfies PublicEvent;
  assert.deepEqual(
    getCampMotionForPosition(enter, { row: 7, col: 1 }, { alive: true, side: "black" }),
    { station: "enter", piece: "enter" },
  );
  assert.deepEqual(
    getCampMotionForPosition(enter, { row: 6, col: 1 }, null),
    { station: null, piece: null },
  );

  const leave = {
    id: 2,
    actor: "black",
    from: { row: 7, col: 1 },
    to: { row: 6, col: 1 },
    result: "attacker_survives",
  } satisfies PublicEvent;
  assert.deepEqual(
    getCampMotionForPosition(leave, { row: 7, col: 1 }, null),
    { station: "leave", piece: null },
  );
  assert.deepEqual(
    getCampMotionForPosition(leave, { row: 6, col: 1 }, { alive: true, side: "black" }),
    { station: null, piece: "leave" },
  );

  const attackerLost = { ...leave, id: 3, result: "defender_survives" } satisfies PublicEvent;
  assert.deepEqual(
    getCampMotionForPosition(attackerLost, { row: 6, col: 1 }, { alive: true, side: "white" }),
    { station: null, piece: null },
  );
  assert.deepEqual(
    getCampMotionForPosition(attackerLost, { row: 7, col: 1 }, null),
    { station: "leave", piece: null },
  );

  const invalidCampAttack = {
    ...attackerLost,
    id: 4,
    to: { row: 7, col: 3 },
  } satisfies PublicEvent;
  assert.deepEqual(
    getCampMotionForPosition(invalidCampAttack, { row: 7, col: 3 }, { alive: true, side: "white" }),
    { station: null, piece: null },
  );

  const campToCamp = {
    ...enter,
    id: 5,
    from: { row: 7, col: 1 },
    to: { row: 8, col: 2 },
  } satisfies PublicEvent;
  assert.deepEqual(
    getCampMotionForPosition(campToCamp, { row: 7, col: 1 }, null),
    { station: "leave", piece: null },
  );
  assert.deepEqual(
    getCampMotionForPosition(campToCamp, { row: 8, col: 2 }, { alive: true, side: "black" }),
    { station: "enter", piece: "enter" },
  );

  const ready = { id: 6, actor: "white", result: "ready" } satisfies PublicEvent;
  assert.equal(latestMovementEvent([ready, enter]), enter);
  assert.equal(latestMovementEvent([enter, ready]), undefined);
  assert.equal(latestMovementEvent([ready]), undefined);
});

test("every move violation has a stable, specific rule code", () => {
  const mobile = piece("b-mobile", "black", "platoon", 3, 0);
  const base = stateWith([mobile]);
  const finished = { ...base, phase: "finished", finishReason: "resign", winner: "white" } as GameState;
  const setup = createInitialGame();
  const wrongTurn = { ...base, turn: "white" } as GameState;

  const cases: Array<[string, GameState, Side, Position, Position]> = [
    ["GAME_FINISHED", finished, "black", { row: 3, col: 0 }, { row: 3, col: 1 }],
    ["GAME_NOT_STARTED", setup, "black", { row: 6, col: 0 }, { row: 5, col: 0 }],
    ["NOT_YOUR_TURN", wrongTurn, "black", { row: 3, col: 0 }, { row: 3, col: 1 }],
    ["POSITION_OUT_OF_BOUNDS", base, "black", { row: 3, col: 0 }, { row: 12, col: 0 }],
    ["SAME_POSITION", base, "black", { row: 3, col: 0 }, { row: 3, col: 0 }],
    ["NO_PIECE_AT_SOURCE", base, "black", { row: 2, col: 0 }, { row: 2, col: 1 }],
    [
      "NOT_YOUR_PIECE",
      stateWith([piece("w", "white", "platoon", 3, 0)]),
      "black",
      { row: 3, col: 0 },
      { row: 3, col: 1 },
    ],
    [
      "FLAG_CANNOT_MOVE",
      stateWith([piece("flag", "black", "flag", 6, 0)]),
      "black",
      { row: 6, col: 0 },
      { row: 6, col: 1 },
    ],
    [
      "MINE_CANNOT_MOVE",
      stateWith([piece("mine", "black", "mine", 6, 0)]),
      "black",
      { row: 6, col: 0 },
      { row: 6, col: 1 },
    ],
    [
      "HEADQUARTERS_LOCKED",
      stateWith([piece("hq", "black", "engineer", 11, 1)]),
      "black",
      { row: 11, col: 1 },
      { row: 10, col: 1 },
    ],
    [
      "DESTINATION_OCCUPIED_BY_ALLY",
      stateWith([mobile, piece("ally", "black", "engineer", 3, 1)]),
      "black",
      { row: 3, col: 0 },
      { row: 3, col: 1 },
    ],
    [
      "CAMP_PROTECTED",
      stateWith([
        piece("attacker", "black", "platoon", 6, 1),
        piece("camper", "white", "platoon", 7, 1),
      ]),
      "black",
      { row: 6, col: 1 },
      { row: 7, col: 1 },
    ],
    [
      "RAIL_PATH_BLOCKED",
      stateWith([
        piece("rail", "black", "platoon", 1, 0),
        piece("blocker", "white", "platoon", 1, 2),
      ]),
      "black",
      { row: 1, col: 0 },
      { row: 1, col: 4 },
    ],
    [
      "ENGINEER_ONLY_RAIL_TURN",
      stateWith([piece("rail", "black", "platoon", 1, 2)]),
      "black",
      { row: 1, col: 2 },
      { row: 5, col: 0 },
    ],
    [
      "ROAD_ONE_STEP_ONLY",
      stateWith([piece("isolated", "black", "platoon", 0, 0)]),
      "black",
      { row: 0, col: 0 },
      { row: 0, col: 2 },
    ],
  ];

  for (const [expected, state, side, from, to] of cases) {
    assert.equal(getMoveViolation(state, side, from, to), expected, expected);
  }
  assert.equal(getMoveViolation(base, "black", { row: 3, col: 0 }, { row: 3, col: 1 }), null);
  expectRuleError(
    cases[12][1],
    "black",
    { type: "move", from: cases[12][3], to: cases[12][4] },
    "RAIL_PATH_BLOCKED",
  );
});

test("setup swaps report every placement violation and reject no-op actions", () => {
  const initial = createInitialGame();
  const blackPieces = initial.pieces.filter((candidate) => candidate.side === "black");
  const anyBlack = blackPieces[0];
  const anyWhite = initial.pieces.find((candidate) => candidate.side === "white")!;
  const flag = blackPieces.find((candidate) => candidate.type === "flag")!;
  const mine = blackPieces.find((candidate) => candidate.type === "mine")!;
  const bomb = blackPieces.find((candidate) => candidate.type === "bomb")!;
  const regular = blackPieces.find(
    (candidate) => !["flag", "mine", "bomb"].includes(candidate.type) && candidate.row >= 7 && candidate.row <= 9,
  )!;
  const front = blackPieces.find((candidate) => candidate.row === 6)!;

  assert.equal(
    getSetupSwapViolation(stateWith([anyBlack]), "black", anyBlack, anyBlack),
    "GAME_ALREADY_STARTED",
  );
  const locked = applyPlayerAction(initial, "black", { type: "ready", value: true });
  assert.equal(getSetupSwapViolation(locked, "black", anyBlack, front), "LAYOUT_LOCKED");
  assert.equal(
    getSetupSwapViolation(initial, "black", anyBlack, { row: 12, col: 0 }),
    "POSITION_OUT_OF_BOUNDS",
  );
  assert.equal(getSetupSwapViolation(initial, "black", anyBlack, anyBlack), "SAME_POSITION");
  assert.equal(
    getSetupSwapViolation(initial, "black", anyBlack, { row: 7, col: 1 }),
    "CAMP_MUST_BE_EMPTY",
  );
  const missingPiece = structuredClone(initial);
  const emptied = missingPiece.pieces.find(
    (candidate) => candidate.side === "black" && candidate.id !== anyBlack.id && candidate.type !== "flag",
  )!;
  emptied.alive = false;
  assert.equal(getSetupSwapViolation(missingPiece, "black", anyBlack, emptied), "INVALID_SWAP");
  assert.equal(getSetupSwapViolation(initial, "black", anyBlack, anyWhite), "NOT_YOUR_PIECE");
  assert.equal(getSetupSwapViolation(initial, "black", flag, regular), "FLAG_MUST_BE_HEADQUARTERS");
  assert.equal(getSetupSwapViolation(initial, "black", mine, regular), "MINE_BACK_TWO_ROWS");
  assert.equal(getSetupSwapViolation(initial, "black", bomb, front), "BOMB_NOT_FRONT_ROW");

  const malformed = structuredClone(initial);
  const campPiece = malformed.pieces.find(
    (candidate) => candidate.side === "black" && !["flag", "mine", "bomb"].includes(candidate.type),
  )!;
  campPiece.row = 7;
  campPiece.col = 1;
  const anotherRegular = malformed.pieces.find(
    (candidate) =>
      candidate.side === "black" &&
      candidate.id !== campPiece.id &&
      !["flag", "mine", "bomb"].includes(candidate.type),
  )!;
  assert.equal(getSetupSwapViolation(malformed, "black", anotherRegular, campPiece), "CAMP_MUST_BE_EMPTY");

  expectRuleError(initial, "black", { type: "ready", value: false }, "NO_STATE_CHANGE");
  expectRuleError(
    initial,
    "black",
    { type: "swap", from: anyBlack, to: anyBlack },
    "SAME_POSITION",
  );
  expectRuleError(locked, "black", { type: "ready", value: true }, "NO_STATE_CHANGE");
});

test("setup tray supports placement, movement, replacement, and swapping through one rule path", () => {
  const initial = createInitialGame();
  const projected = projectGame(initial, "black");
  const own = projected.pieces.filter((candidate) => candidate.side === "black");
  const engineer = own.find((candidate) => candidate.type === "engineer")!;
  const general = own.find((candidate) => candidate.type === "general")!;
  const platoon = own.find((candidate) => candidate.type === "platoon")!;
  const flag = own.find((candidate) => candidate.type === "flag")!;
  const mine = own.find((candidate) => candidate.type === "mine")!;
  const bomb = own.find((candidate) => candidate.type === "bomb")!;

  let draft = createSetupDraft(projected.pieces, "black");
  assert.equal(Object.keys(draft).length, 25);
  assert.equal(Object.values(draft).every((position) => position === null), true);
  assert.equal(isValidSetupDraft(projected.pieces, "black", draft), true);
  assert.equal(isValidSetupDraft(projected.pieces, "black", draft, true), false);

  draft = applySetupDraftPlacement(projected.pieces, "black", draft, engineer.id, { row: 6, col: 0 });
  draft = applySetupDraftPlacement(projected.pieces, "black", draft, general.id, { row: 6, col: 1 });
  draft = applySetupDraftPlacement(projected.pieces, "black", draft, engineer.id, { row: 6, col: 2 });
  assert.deepEqual(draft[engineer.id], { row: 6, col: 2 });

  draft = applySetupDraftPlacement(projected.pieces, "black", draft, engineer.id, { row: 6, col: 1 });
  assert.deepEqual(draft[engineer.id], { row: 6, col: 1 });
  assert.deepEqual(draft[general.id], { row: 6, col: 2 });

  draft = applySetupDraftPlacement(projected.pieces, "black", draft, platoon.id, { row: 6, col: 1 });
  assert.deepEqual(draft[platoon.id], { row: 6, col: 1 });
  assert.equal(draft[engineer.id], null);
  assert.equal(isValidSetupDraft(projected.pieces, "black", draft), true);

  assert.equal(
    getSetupDraftPlacementViolation(projected.pieces, "black", draft, platoon.id, { row: 6, col: 1 }),
    "SAME_POSITION",
  );
  assert.equal(
    getSetupDraftPlacementViolation(projected.pieces, "black", draft, engineer.id, { row: 7, col: 1 }),
    "CAMP_MUST_BE_EMPTY",
  );
  assert.equal(
    getSetupDraftPlacementViolation(projected.pieces, "black", draft, engineer.id, { row: 5, col: 0 }),
    "INVALID_LAYOUT",
  );
  assert.equal(
    getSetupDraftPlacementViolation(projected.pieces, "black", draft, flag.id, { row: 10, col: 1 }),
    "FLAG_MUST_BE_HEADQUARTERS",
  );
  assert.equal(
    getSetupDraftPlacementViolation(projected.pieces, "black", draft, mine.id, { row: 9, col: 0 }),
    "MINE_BACK_TWO_ROWS",
  );
  assert.equal(
    getSetupDraftPlacementViolation(projected.pieces, "black", draft, bomb.id, { row: 6, col: 4 }),
    "BOMB_NOT_FRONT_ROW",
  );

  let displacement = createSetupDraft(projected.pieces, "black");
  displacement = applySetupDraftPlacement(
    projected.pieces,
    "black",
    displacement,
    bomb.id,
    { row: 7, col: 0 },
  );
  displacement = applySetupDraftPlacement(
    projected.pieces,
    "black",
    displacement,
    platoon.id,
    { row: 6, col: 0 },
  );
  assert.throws(
    () =>
      applySetupDraftPlacement(
        projected.pieces,
        "black",
        displacement,
        platoon.id,
        { row: 7, col: 0 },
      ),
    (error: unknown) => error instanceof GameRuleError && error.code === "BOMB_NOT_FRONT_ROW",
  );
});

test("a complete local setup is validated and committed atomically without changing piece IDs", () => {
  const initial = createInitialGame();
  const projected = projectGame(initial, "black");
  const draft = randomizeSetupDraft(projected.pieces, "black");
  assert.equal(isValidSetupDraft(projected.pieces, "black", draft, true), true);
  const layout = setupDraftToLayout(projected.pieces, "black", draft);
  assert.equal(layout.length, 25);

  expectRuleError(
    initial,
    "black",
    { type: "ready", value: true, layout: layout.slice(0, 24) },
    "INCOMPLETE_LAYOUT",
  );
  assert.equal(initial.ready.black, false);

  const opponentBefore = initial.pieces
    .filter((candidate) => candidate.side === "white")
    .map(({ id, row, col }) => ({ id, row, col }));
  const submitted = applyPlayerAction(initial, "black", { type: "ready", value: true, layout });
  assert.equal(submitted.ready.black, true);
  assert.equal(validateSideSetup(submitted.pieces, "black"), true);
  for (const placement of layout) {
    const after = submitted.pieces.find((candidate) => candidate.id === placement.pieceId)!;
    assert.deepEqual({ row: after.row, col: after.col }, { row: placement.row, col: placement.col });
  }
  assert.deepEqual(
    submitted.pieces
      .filter((candidate) => candidate.side === "white")
      .map(({ id, row, col }) => ({ id, row, col })),
    opponentBefore,
  );

  const idsBefore = initial.pieces
    .filter((candidate) => candidate.side === "black")
    .map((candidate) => candidate.id)
    .sort();
  const randomized = applyPlayerAction(initial, "black", { type: "randomize" });
  const idsAfter = randomized.pieces
    .filter((candidate) => candidate.side === "black")
    .map((candidate) => candidate.id)
    .sort();
  assert.deepEqual(idsAfter, idsBefore);
  assert.equal(validateSideSetup(randomized.pieces, "black"), true);
});

test("spectators see both armies while each player sees only their own", () => {
  const initial = createInitialGame();
  const spectator = projectGame(initial, "spectator");
  const black = projectGame(initial, "black");
  const white = projectGame(initial, "white");

  assert.equal(spectator.pieces.length, 50);
  assert.equal(spectator.pieces.filter((candidate) => candidate.type).length, 50);
  assert.equal(black.pieces.filter((candidate) => candidate.side === "black" && candidate.type).length, 25);
  assert.equal(black.pieces.filter((candidate) => candidate.side === "white" && candidate.type).length, 0);
  assert.equal(white.pieces.filter((candidate) => candidate.side === "white" && candidate.type).length, 25);
  assert.equal(white.pieces.filter((candidate) => candidate.side === "black" && candidate.type).length, 0);
});

test("opponent setup projections cannot track swapped hidden pieces into the match", () => {
  const initial = createInitialGame();
  const swappable = initial.pieces
    .filter(
      (candidate) => candidate.side === "black" && !["flag", "mine", "bomb"].includes(candidate.type),
    )
    .slice(0, 2);
  assert.equal(swappable.length, 2);

  const before = projectGame(initial, "white").pieces.filter((candidate) => candidate.side === "black");
  const swapped = applyPlayerAction(initial, "black", {
    type: "swap",
    from: swappable[0],
    to: swappable[1],
  });
  const after = projectGame(swapped, "white").pieces.filter((candidate) => candidate.side === "black");
  assert.deepEqual(after, before);
  assert.ok(after.every((candidate) => candidate.id === `black-hidden-${candidate.row}-${candidate.col}`));

  let started = applyPlayerAction(swapped, "black", { type: "ready", value: true });
  started = applyPlayerAction(started, "white", { type: "ready", value: true });
  const playingIds = new Set(
    projectGame(started, "white").pieces
      .filter((candidate) => candidate.side === "black")
      .map((candidate) => candidate.id),
  );
  assert.equal(before.some((candidate) => playingIds.has(candidate.id)), false);
});

test("rail movement blocks jumping, permits engineer turns, and finds alternate routes", () => {
  const ordinary = piece("ordinary", "black", "platoon", 1, 2);
  assert.equal(getMoveViolation(stateWith([ordinary]), "black", ordinary, { row: 1, col: 4 }), null);
  assert.equal(
    getMoveViolation(stateWith([ordinary]), "black", ordinary, { row: 5, col: 0 }),
    "ENGINEER_ONLY_RAIL_TURN",
  );

  const engineer = piece("engineer", "black", "engineer", 1, 2);
  assert.equal(getMoveViolation(stateWith([engineer]), "black", engineer, { row: 5, col: 0 }), null);
  const alternate = stateWith([
    engineer,
    piece("one-blocker", "white", "platoon", 1, 1),
  ]);
  assert.equal(getMoveViolation(alternate, "black", engineer, { row: 5, col: 0 }), null);
  const sealed = stateWith([
    engineer,
    piece("left-blocker", "white", "platoon", 1, 1),
    piece("right-blocker", "white", "platoon", 1, 3),
  ]);
  assert.equal(
    getMoveViolation(sealed, "black", engineer, { row: 5, col: 0 }),
    "RAIL_PATH_BLOCKED",
  );

  const straightBlocked = stateWith([
    piece("mover", "black", "platoon", 1, 0),
    piece("middle", "white", "engineer", 1, 2),
  ]);
  assert.equal(
    getMoveViolation(straightBlocked, "black", { row: 1, col: 0 }, { row: 1, col: 4 }),
    "RAIL_PATH_BLOCKED",
  );
  assert.equal(
    getMoveViolation(straightBlocked, "black", { row: 1, col: 0 }, { row: 1, col: 2 }),
    null,
  );
});

test("the complete combat matrix follows rank, bomb, mine, and flag rules", () => {
  const allTypes = Object.keys(PIECE_INFO) as PieceType[];
  for (const attackerType of MOBILE_TYPES) {
    for (const defenderType of allTypes) {
      const attacker = piece("attacker", "black", attackerType, 3, 0);
      const defender = piece("defender", "white", defenderType, 3, 1);
      const result = applyPlayerAction(stateWith([attacker, defender]), "black", {
        type: "move",
        from: { row: 3, col: 0 },
        to: { row: 3, col: 1 },
      });
      const afterAttacker = result.pieces.find((candidate) => candidate.id === "attacker")!;
      const afterDefender = result.pieces.find((candidate) => candidate.id === "defender")!;

      if (defenderType === "flag") {
        assert.equal(result.finishReason, "flag", `${attackerType} vs flag`);
        assert.equal(result.winner, "black", `${attackerType} vs flag`);
        assert.equal(afterDefender.alive, false, `${attackerType} vs flag`);
        assert.equal(afterAttacker.alive, attackerType !== "bomb", `${attackerType} vs flag`);
      } else if (attackerType === "bomb" || defenderType === "bomb") {
        assert.equal(afterAttacker.alive, false, `${attackerType} vs ${defenderType}`);
        assert.equal(afterDefender.alive, false, `${attackerType} vs ${defenderType}`);
      } else if (defenderType === "mine") {
        assert.equal(afterAttacker.alive, attackerType === "engineer", `${attackerType} vs mine`);
        assert.equal(afterDefender.alive, attackerType !== "engineer", `${attackerType} vs mine`);
      } else {
        const attackerStrength = PIECE_INFO[attackerType].strength!;
        const defenderStrength = PIECE_INFO[defenderType].strength!;
        assert.equal(afterAttacker.alive, attackerStrength > defenderStrength, `${attackerType} vs ${defenderType}`);
        assert.equal(afterDefender.alive, attackerStrength < defenderStrength, `${attackerType} vs ${defenderType}`);
      }

      assert.equal(result.revealedFlags.black, attackerType === "commander" && !afterAttacker.alive);
      assert.equal(
        result.revealedFlags.white,
        defenderType === "flag" || (defenderType === "commander" && !afterDefender.alive),
      );
      assert.equal(result.events.at(-1)?.from?.row, 3);
      assert.equal(result.events.at(-1)?.to?.col, 1);
    }
  }
});

test("both commanders falling reveals exactly both flags while play continues", () => {
  const state = stateWith([
    piece("black-commander", "black", "commander", 3, 0),
    piece("white-commander", "white", "commander", 3, 1),
    piece("black-flag", "black", "flag", 11, 1),
    piece("white-flag", "white", "flag", 0, 1),
    piece("black-engineer", "black", "engineer", 10, 0),
    piece("white-engineer", "white", "engineer", 1, 0),
  ]);
  const result = applyPlayerAction(state, "black", {
    type: "move",
    from: { row: 3, col: 0 },
    to: { row: 3, col: 1 },
  });
  assert.equal(result.phase, "playing");
  assert.deepEqual(result.revealedFlags, { black: true, white: true });
  const spectator = projectGame(result, "spectator");
  assert.equal(spectator.pieces.every((candidate) => candidate.type !== null), true);
  assert.equal(
    projectGame(result, "black").pieces.filter((candidate) => candidate.side === "white" && candidate.type).length,
    1,
  );
  assert.equal(
    projectGame(result, "white").pieces.filter((candidate) => candidate.side === "black" && candidate.type).length,
    1,
  );
});

test("combat keeps a survivor hidden from the opponent while spectators retain full visibility", () => {
  const state = stateWith([
    piece("attacker", "black", "commander", 3, 0),
    piece("defender", "white", "platoon", 3, 1),
    piece("black-support", "black", "engineer", 9, 4),
    piece("white-support", "white", "engineer", 8, 4),
  ]);
  const result = applyPlayerAction(state, "black", {
    type: "move",
    from: { row: 3, col: 0 },
    to: { row: 3, col: 1 },
  });

  assert.equal(result.phase, "playing");
  assert.equal(result.events.at(-1)?.result, "attacker_survives");
  assert.equal(projectGame(result, "black").pieces.find((candidate) => candidate.id === "attacker")?.type, "commander");
  assert.equal(projectGame(result, "white").pieces.find((candidate) => candidate.id === "attacker")?.type, null);
  assert.equal(projectGame(result, "spectator").pieces.find((candidate) => candidate.id === "attacker")?.type, "commander");
});

test("v2 has no automatic 70-ply draw", () => {
  let state = stateWith([
    piece("black", "black", "platoon", 3, 0),
    piece("white", "white", "platoon", 8, 4),
  ]);
  for (let ply = 1; ply <= 100; ply += 1) {
    const blackTurn = ply % 2 === 1;
    const side: Side = blackTurn ? "black" : "white";
    const col = blackTurn ? 0 : 4;
    const near = blackTurn ? 3 : 8;
    const far = blackTurn ? 4 : 9;
    const fromRow = Math.floor((ply - 1) / 2) % 2 === 0 ? near : far;
    const toRow = fromRow === near ? far : near;
    state = applyPlayerAction(state, side, {
      type: "move",
      from: { row: fromRow, col },
      to: { row: toRow, col },
    });
  }
  assert.equal(state.phase, "playing");
  assert.equal(state.finishReason, null);
  assert.equal(state.moveNumber, 100);
  assert.equal(state.events.length, 16);
  assert.equal(state.events.at(-1)?.id, 100);
});

test("ready transitions are explicit and resignation ends a started match", () => {
  let state = createInitialGame();
  state = applyPlayerAction(state, "black", { type: "ready", value: true });
  state = applyPlayerAction(state, "black", { type: "ready", value: false });
  assert.deepEqual(state.events.map((event) => event.result), ["ready", "unready"]);
  state = applyPlayerAction(state, "black", { type: "ready", value: true });
  state = applyPlayerAction(state, "white", { type: "ready", value: true });
  assert.equal(state.phase, "playing");
  assert.ok(state.turn === "black" || state.turn === "white");
  state = applyPlayerAction(state, "black", { type: "resign" });
  assert.equal(state.phase, "finished");
  assert.equal(state.winner, "white");
  assert.equal(state.finishReason, "resign");
});
