import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPlayerAction,
  createInitialGame,
  getLegalTargets,
  isAllowedSetupPosition,
  isRailEdge,
  isRoadEdge,
  PIECE_INFO,
  projectGame,
  validateSideSetup,
  type GameState,
  type Piece,
  type Side,
} from "../lib/game.ts";

function stateWith(pieces: Piece[], turn: Side = "black"): GameState {
  return {
    rulesVersion: "classic-duel-dark-v1",
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
    noCombatPly: 0,
  };
}

test("board graph has 60 nodes, 133 road edges, and 35 rail edges", () => {
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
});

test("random layouts always satisfy classic setup restrictions", () => {
  for (let run = 0; run < 20; run += 1) {
    const state = createInitialGame();
    assert.equal(validateSideSetup(state.pieces, "black"), true);
    assert.equal(validateSideSetup(state.pieces, "white"), true);
  }
  assert.equal(isAllowedSetupPosition("flag", "black", { row: 11, col: 1 }), true);
  assert.equal(isAllowedSetupPosition("flag", "black", { row: 10, col: 1 }), false);
  assert.equal(isAllowedSetupPosition("mine", "white", { row: 2, col: 0 }), false);
  assert.equal(isAllowedSetupPosition("bomb", "white", { row: 5, col: 0 }), false);
});

test("player and spectator projections never leak hidden identities", () => {
  const state = createInitialGame();
  const black = projectGame(state, "black");
  const spectator = projectGame(state, "spectator");
  assert.equal(black.pieces.filter((piece) => piece.side === "black" && piece.type).length, 25);
  assert.equal(black.pieces.filter((piece) => piece.side === "white" && piece.type).length, 0);
  assert.equal(spectator.pieces.filter((piece) => piece.type).length, 0);
  const typeNames = Object.keys(PIECE_INFO);
  for (const piece of black.pieces.filter((candidate) => candidate.side === "white")) {
    assert.equal(typeNames.some((type) => piece.id.includes(type)), false);
  }
  const spectatorJson = JSON.stringify(spectator);
  assert.equal(typeNames.some((type) => spectatorJson.includes(`"${type}"`)), false);
  const publiclySorted = [...spectator.pieces].sort(
    (first, second) =>
      first.side.localeCompare(second.side) ||
      Number(second.alive) - Number(first.alive) ||
      first.row - second.row ||
      first.col - second.col ||
      first.id.localeCompare(second.id),
  );
  assert.deepEqual(spectator.pieces, publiclySorted);
});

test("ordinary pieces use straight rail while engineers can turn", () => {
  const platoon: Piece = { id: "b-p", side: "black", type: "platoon", row: 1, col: 2, alive: true };
  const engineer: Piece = { ...platoon, id: "b-e", type: "engineer" };
  const straight = stateWith([platoon]);
  assert.equal(getLegalTargets(straight, "black", platoon).some((target) => target.row === 1 && target.col === 4), true);
  assert.equal(getLegalTargets(straight, "black", platoon).some((target) => target.row === 5 && target.col === 0), false);
  const turning = stateWith([engineer]);
  assert.equal(getLegalTargets(turning, "black", engineer).some((target) => target.row === 5 && target.col === 0), true);
});

test("occupied camps are protected and headquarters lock their occupant", () => {
  const attacker: Piece = { id: "b-a", side: "black", type: "platoon", row: 6, col: 1, alive: true };
  const camper: Piece = { id: "w-c", side: "white", type: "platoon", row: 7, col: 1, alive: true };
  const protectedState = stateWith([attacker, camper]);
  assert.equal(getLegalTargets(protectedState, "black", attacker).some((target) => target.row === 7 && target.col === 1), false);
  const locked: Piece = { id: "b-h", side: "black", type: "engineer", row: 11, col: 1, alive: true };
  assert.equal(getLegalTargets(stateWith([locked]), "black", locked).length, 0);
});

test("engineers clear mines and bombs can capture the flag", () => {
  const engineer: Piece = { id: "b-e", side: "black", type: "engineer", row: 6, col: 0, alive: true };
  const mine: Piece = { id: "w-m", side: "white", type: "mine", row: 5, col: 0, alive: true };
  const cleared = applyPlayerAction(stateWith([engineer, mine]), "black", {
    type: "move",
    from: { row: 6, col: 0 },
    to: { row: 5, col: 0 },
  });
  assert.equal(cleared.pieces.find((piece) => piece.id === "b-e")?.alive, true);
  assert.deepEqual(
    { row: cleared.pieces.find((piece) => piece.id === "b-e")?.row, col: cleared.pieces.find((piece) => piece.id === "b-e")?.col },
    { row: 5, col: 0 },
  );
  assert.equal(cleared.pieces.find((piece) => piece.id === "w-m")?.alive, false);

  const bomb: Piece = { id: "b-b", side: "black", type: "bomb", row: 6, col: 2, alive: true };
  const flag: Piece = { id: "w-f", side: "white", type: "flag", row: 5, col: 2, alive: true };
  const captured = applyPlayerAction(stateWith([bomb, flag]), "black", {
    type: "move",
    from: { row: 6, col: 2 },
    to: { row: 5, col: 2 },
  });
  assert.equal(captured.phase, "finished");
  assert.equal(captured.winner, "black");
  assert.equal(captured.finishReason, "flag");
  assert.equal(captured.pieces.every((piece) => !piece.alive), true);
});

test("both ready starts the match and resignation ends it", () => {
  let state = createInitialGame();
  state = applyPlayerAction(state, "black", { type: "ready", value: true });
  state = applyPlayerAction(state, "white", { type: "ready", value: true });
  assert.equal(state.phase, "playing");
  state = applyPlayerAction(state, "black", { type: "resign" });
  assert.equal(state.phase, "finished");
  assert.equal(state.winner, "white");
});
