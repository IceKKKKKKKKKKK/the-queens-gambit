import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  openPort,
  readJsonResponse,
  spawnIntegrationServer,
  waitForJsonApi,
} from "./integration-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let activeServer = null;
let activeStatePath = null;
const OPENING_TEST_EXCLUDED_AUGMENTS = new Set([
  "spade-total-intelligence",
  "spade-supreme-recon",
  "heart-targeted-recon",
  "club-steady-tempo",
  "diamond-drill",
]);

function identityHeaders(subject, email) {
  return {
    "oai-authenticated-user-id": subject,
    "oai-authenticated-user-email": email,
  };
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, init);
  return {
    status: response.status,
    body: await readJsonResponse(response, {
      method: init.method ?? "GET",
      url,
      server: activeServer,
    }),
  };
}

function postJson(url, headers, body) {
  return requestJson(url, {
    method: "POST",
    headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function postAction(origin, code, headers, expectedVersion, action, token = null) {
  return postJson(
    `${origin}/api/rooms/${code}/actions`,
    token ? { ...headers, Authorization: `Bearer ${token}` } : headers,
    { expectedVersion, action },
  );
}

async function joinQueue(origin, headers) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await postJson(`${origin}/api/matchmaking`, headers, { mode: "hex_ranked" });
    if (response.status !== 503) return response;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("matchmaking lock remained busy");
}

function localD1Path() {
  assert.ok(activeStatePath, "integration state path must be assigned before D1 access");
  const directory = path.join(activeStatePath, "v3", "d1", "miniflare-D1DatabaseObject");
  const database = readdirSync(directory).find(
    (name) => name.endsWith(".sqlite") && name !== "metadata.sqlite",
  );
  if (!database) throw new Error("local D1 database was not created");
  return path.join(directory, database);
}

function setPlatformRating(authSubject, rating) {
  const database = new DatabaseSync(localD1Path());
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const updated = database
      .prepare("UPDATE platform_users SET rating = ?, updated_at = ? WHERE auth_user_id = ?")
      .run(rating, Date.now(), authSubject);
    assert.equal(Number(updated.changes), 1);
  } finally {
    database.close();
  }
}

function assertNoRepetitionSecrets(value) {
  const forbiddenKeys = new Set([
    "repetitionTracker",
    "salt",
    "counts",
    "lastCountedDigest",
    "digest",
    "history",
  ]);
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current)) {
      assert.equal(forbiddenKeys.has(key), false, `private repetition field leaked: ${key}`);
      pending.push(child);
    }
  }
}

const REPETITION_TEST_UNSAFE_AUGMENTS = new Set([
  "spade-command-chain",
  // v3: the countdown is part of the strategic digest, while the fortress can
  // make the camp-loop's preselected commander immobile.
  "spade-lightning-doctrine",
  "spade-iron-fortress",
  "spade-total-intelligence",
  "spade-supreme-recon",
  "heart-initiative",
  // v3: a normal move opens a same-turn continuation instead of handing over
  // the turn, so it cannot participate in this one-move-per-side fixture.
  "heart-steady-advance",
  "heart-targeted-recon",
  "heart-wide-recon",
  "club-steady-tempo",
  "club-frontline-scout",
  "club-local-recon",
  "diamond-front-watch",
  "diamond-drill",
]);

const REQUIRED_V3_QUIET_LOOP_EXCLUSIONS = Object.freeze([
  "spade-lightning-doctrine",
  "spade-iron-fortress",
  "heart-steady-advance",
]);

const REPETITION_CAMPS = [
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

function isRepetitionCamp(position) {
  return REPETITION_CAMPS.some(
    (camp) => camp.row === position.row && camp.col === position.col,
  );
}

function isRepetitionRoadEdge(first, second) {
  const rowDelta = Math.abs(first.row - second.row);
  const colDelta = Math.abs(first.col - second.col);
  const crossesBorder = Math.min(first.row, second.row) === 5 && Math.max(first.row, second.row) === 6;
  if (rowDelta + colDelta === 1) {
    if (crossesBorder) return first.col === second.col && [0, 2, 4].includes(first.col);
    return true;
  }
  const sameHalf =
    (first.row <= 5 && second.row <= 5) || (first.row >= 6 && second.row >= 6);
  return rowDelta === 1 && colDelta === 1 && sameHalf &&
    (isRepetitionCamp(first) || isRepetitionCamp(second));
}

function isRepetitionHeadquarters(position) {
  return (position.row === 0 || position.row === 11) &&
    (position.col === 1 || position.col === 3);
}

function findReversibleCampMove(snapshot, side) {
  const camps = REPETITION_CAMPS.filter((camp) => side === "white" ? camp.row <= 5 : camp.row >= 6);
  const occupied = new Set(
    snapshot.pieces
      .filter((piece) => piece.alive)
      .map((piece) => `${piece.row},${piece.col}`),
  );
  const movable = snapshot.pieces.filter(
    (piece) =>
      piece.alive &&
      piece.side === side &&
      piece.type !== null &&
      piece.type !== "mine" &&
      piece.type !== "flag" &&
      !isRepetitionHeadquarters(piece),
  );
  for (const camp of camps) {
    if (occupied.has(`${camp.row},${camp.col}`)) continue;
    const piece = movable.find((candidate) => isRepetitionRoadEdge(candidate, camp));
    if (piece) {
      return {
        from: { row: piece.row, col: piece.col },
        to: { ...camp },
      };
    }
  }
  throw new Error(`no reversible camp move for ${side}`);
}

async function startRepetitionRoom(origin, code, headersBySide) {
  const initialBySide = Object.fromEntries(
    await Promise.all(
      Object.entries(headersBySide).map(async ([side, headers]) => [
        side,
        await requestJson(`${origin}/api/rooms/${code}`, { headers }),
      ]),
    ),
  );
  let version = initialBySide.black.body.version;
  assert.equal(initialBySide.white.body.version, version);
  for (const side of ["black", "white"]) {
    const headers = headersBySide[side];
    let snapshot = initialBySide[side].body.snapshot;
    let options = snapshot.augment.draft.rounds[0].players[side].options;
    let selectedId = options.find((id) => !REPETITION_TEST_UNSAFE_AUGMENTS.has(id));
    if (!selectedId) {
      const refreshed = await postAction(origin, code, headers, version, {
        type: "augment_refresh",
        slot: 0,
      });
      assert.equal(refreshed.status, 200);
      version = refreshed.body.version;
      snapshot = refreshed.body.snapshot;
      options = snapshot.augment.draft.rounds[0].players[side].options;
      selectedId = options.find((id) => !REPETITION_TEST_UNSAFE_AUGMENTS.has(id));
    }
    assert.ok(selectedId, `a quiet-loop-safe augment must be available for ${side}`);
    const selected = await postAction(origin, code, headers, version, {
      type: "augment_select",
      augmentId: selectedId,
    });
    assert.equal(selected.status, 200);
    version = selected.body.version;
    const locked = await postAction(origin, code, headers, version, { type: "augment_lock" });
    assert.equal(locked.status, 200);
    version = locked.body.version;
    const ready = await postAction(origin, code, headers, version, {
      type: "ready",
      value: true,
    });
    assert.equal(ready.status, 200);
    version = ready.body.version;
  }
  const playing = await requestJson(`${origin}/api/rooms/${code}`, {
    headers: headersBySide.black,
  });
  assert.equal(playing.status, 200);
  assert.equal(playing.body.snapshot.phase, "playing");
  assert.deepEqual(playing.body.snapshot.repetition, {
    threshold: 3,
    currentOccurrences: 0,
    active: false,
  });
  return playing.body;
}

async function activateRepetitionAfterSecondDraft(origin, room, headersBySide) {
  const snapshotsBySide = Object.fromEntries(
    await Promise.all(
      Object.entries(headersBySide).map(async ([side, headers]) => [
        side,
        (await requestJson(`${origin}/api/rooms/${room.code}`, { headers })).body.snapshot,
      ]),
    ),
  );
  const preludeMove = {
    black: findReversibleCampMove(snapshotsBySide.black, "black"),
    white: findReversibleCampMove(snapshotsBySide.white, "white"),
  };
  const movedIntoCamp = { black: false, white: false };
  let current = room;
  for (let ply = 1; ply <= 9; ply += 1) {
    const side = current.snapshot.turn;
    const base = preludeMove[side];
    const action = movedIntoCamp[side]
      ? { type: "move", from: base.to, to: base.from }
      : { type: "move", from: base.from, to: base.to };
    const response = await postAction(
      origin,
      room.code,
      headersBySide[side],
      current.version,
      action,
    );
    assert.equal(response.status, 200, `pre-draft quiet move ${ply} must succeed`);
    movedIntoCamp[side] = !movedIntoCamp[side];
    current = response.body;
  }
  assert.equal(current.snapshot.phase, "augment_draft");
  assert.equal(current.snapshot.moveNumber, 9);
  assert.equal(current.snapshot.repetition.active, false);

  for (const side of ["black", "white"]) {
    const headers = headersBySide[side];
    const projected = await requestJson(`${origin}/api/rooms/${room.code}`, { headers });
    assert.equal(projected.status, 200);
    let options = projected.body.snapshot.augment.draft.rounds[1].players[side].options;
    let selectedId = options.find((id) => !REPETITION_TEST_UNSAFE_AUGMENTS.has(id));
    if (!selectedId) {
      const refreshed = await postAction(origin, room.code, headers, current.version, {
        type: "augment_refresh",
        slot: 0,
      });
      assert.equal(refreshed.status, 200);
      current = refreshed.body;
      options = current.snapshot.augment.draft.rounds[1].players[side].options;
      selectedId = options.find((id) => !REPETITION_TEST_UNSAFE_AUGMENTS.has(id));
    }
    assert.ok(selectedId, `a quiet-loop-safe second augment must be available for ${side}`);
    const selected = await postAction(origin, room.code, headers, current.version, {
      type: "augment_select",
      augmentId: selectedId,
    });
    assert.equal(selected.status, 200);
    current = selected.body;
    const locked = await postAction(origin, room.code, headers, current.version, {
      type: "augment_lock",
    });
    assert.equal(locked.status, 200);
    current = locked.body;
  }
  assert.equal(current.snapshot.phase, "playing");
  assert.deepEqual(current.snapshot.repetition, {
    threshold: 3,
    currentOccurrences: 1,
    active: true,
  });
  return {
    room: current,
    loopMove: {
      black: movedIntoCamp.black
        ? { from: preludeMove.black.to, to: preludeMove.black.from }
        : preludeMove.black,
      white: movedIntoCamp.white
        ? { from: preludeMove.white.to, to: preludeMove.white.from }
        : preludeMove.white,
    },
  };
}

async function playThreefoldCampLoop(origin, active, headersBySide) {
  const { room, loopMove } = active;
  const movedIntoCamp = { black: false, white: false };
  let current = room;
  for (let ply = 1; ply <= 8; ply += 1) {
    const side = current.snapshot.turn;
    const base = loopMove[side];
    const action = movedIntoCamp[side]
      ? { type: "move", from: base.to, to: base.from }
      : { type: "move", from: base.from, to: base.to };
    const response = await postAction(
      origin,
      room.code,
      headersBySide[side],
      current.version,
      action,
    );
    assert.equal(response.status, 200, `quiet repetition move ${ply} must succeed`);
    movedIntoCamp[side] = !movedIntoCamp[side];
    current = response.body;
    if (ply === 4) {
      assert.equal(current.snapshot.phase, "playing");
      assert.deepEqual(current.snapshot.repetition, {
        threshold: 3,
        currentOccurrences: 2,
        active: true,
      });
    }
  }
  assert.equal(current.snapshot.phase, "finished");
  return current;
}

function forceExpiredSecondDraft(code, { preserveBlackSelection = false } = {}) {
  const database = new DatabaseSync(localD1Path());
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const row = database
      .prepare("SELECT state_json, version FROM games WHERE code = ?")
      .get(code);
    assert.ok(row);
    const state = JSON.parse(row.state_json);
    assert.equal(state.phase, "playing");
    assert.equal(state.augment.draft.activeRound, null);
    assert.equal(state.augment.draft.rounds.length, 1);

    const candidates = {
      spades: [
        "spade-grand-maneuver",
        "spade-relentless-assault",
        "spade-tactical-retreat",
        "spade-total-intelligence",
        "spade-strategic-reserve",
      ],
      hearts: [
        "heart-rail-turn",
        "heart-initiative",
        "heart-remote-exchange",
        "heart-bomb-disposal",
        "heart-targeted-recon",
      ],
      clubs: [
        "club-forced-march",
        "club-line-hop",
        "club-field-exchange",
        "club-steady-tempo",
        "club-frontline-scout",
      ],
    };
    const firstSuit = state.augment.draft.rounds[0].suit;
    const [suit, ids] = Object.entries(candidates).find(([candidate]) => candidate !== firstSuit);
    const blackOptions = ids.slice(0, 3);
    const whiteOptions = ids.slice(2, 5);
    const blackSelectedId = preserveBlackSelection ? blackOptions[1] : null;
    state.augment.draft.rounds.push({
      number: 2,
      trigger: "move_10",
      suit,
      revealed: false,
      players: {
        black: {
          options: blackOptions,
          selectedId: blackSelectedId,
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
    });
    state.augment.draft.seenBySide.black.push(...blackOptions);
    state.augment.draft.seenBySide.white.push(...whiteOptions);
    state.augment.draft.activeRound = 2;
    state.augment.resumeTurn = state.turn;
    state.augment.draftDeadlineAt = Date.now() - 1_000;
    state.phase = "augment_draft";
    state.moveNumber = 9;
    state.clock.turnStartedAt = null;
    const updated = database
      .prepare("UPDATE games SET state_json = ?, updated_at = ? WHERE code = ? AND version = ?")
      .run(JSON.stringify(state), Date.now(), code, row.version);
    assert.equal(Number(updated.changes), 1);
    return {
      version: Number(row.version),
      resumeTurn: state.turn,
      attemptedId: blackOptions[2],
      timeoutBlackSelection: blackSelectedId ?? blackOptions[0],
    };
  } finally {
    database.close();
  }
}

function mutatePersistedRoomState(code, mutate) {
  const database = new DatabaseSync(localD1Path());
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const row = database
      .prepare("SELECT state_json, version FROM games WHERE code = ?")
      .get(code);
    assert.ok(row);
    const state = JSON.parse(row.state_json);
    mutate(state);
    const updated = database
      .prepare("UPDATE games SET state_json = ?, updated_at = ? WHERE code = ? AND version = ?")
      .run(JSON.stringify(state), Date.now(), code, row.version);
    assert.equal(Number(updated.changes), 1);
  } finally {
    database.close();
  }
}

function makeOpponentPiecePublic(code, perspective) {
  let publicPiece = null;
  mutatePersistedRoomState(code, (state) => {
    assert.equal(state.phase, "setup");
    const opponent = perspective === "black" ? "white" : "black";
    const piece = state.pieces.find(
      (candidate) => candidate.alive && candidate.side === opponent && candidate.type !== "flag",
    );
    assert.ok(piece);
    assert.equal(state.augment.ruleState.baseTypes[piece.id], piece.type);
    state.augment.ruleState.publiclyRevealedPieceIds.push(piece.id);
    publicPiece = { id: piece.id, setupType: piece.type };
  });
  return publicPiece;
}

function authoritativePublicPieceState(code, pieceId) {
  const database = new DatabaseSync(localD1Path(), { readOnly: true });
  try {
    const row = database.prepare("SELECT state_json FROM games WHERE code = ?").get(code);
    assert.ok(row);
    const state = JSON.parse(row.state_json);
    assert.equal(state.rulesVersion, "augment-duel-dark-v3");
    assert.ok(state.augment?.ruleState);
    const piece = state.pieces.find((candidate) => candidate.id === pieceId);
    assert.ok(piece);
    return {
      type: piece.type,
      baseType: state.augment.ruleState.baseTypes[pieceId],
      publiclyRevealed:
        state.augment.ruleState.publiclyRevealedPieceIds.includes(pieceId),
    };
  } finally {
    database.close();
  }
}

function insertCompletedHistoryFixtures(authSubjectA, authSubjectB, prefix, count = 11) {
  const database = new DatabaseSync(localD1Path());
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const playerA = database
      .prepare("SELECT id FROM platform_users WHERE auth_user_id = ?")
      .get(authSubjectA);
    const playerB = database
      .prepare("SELECT id FROM platform_users WHERE auth_user_id = ?")
      .get(authSubjectB);
    assert.ok(playerA?.id);
    assert.ok(playerB?.id);
    const insert = database.prepare(
      `INSERT INTO platform_matches (
         id, mode, ranked, status, player_a_id, player_b_id, winner_user_id,
         ended_reason, rating_before_a, rating_before_b, rating_delta_a,
         rating_delta_b, game_code, created_at, started_at, completed_at
       ) VALUES (?, 'classic_private', 0, 'completed', ?, ?, ?, 'draw',
                 1200, 1200, 0, 0, NULL, ?, ?, ?)`,
    );
    const baseTime = Date.now() + 1_000;
    const ids = [];
    database.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < count; index += 1) {
        const id = `security-history-${prefix}-${String(index).padStart(2, "0")}`;
        const completedAt = baseTime + index;
        insert.run(id, playerA.id, playerB.id, null, completedAt, completedAt, completedAt);
        ids.push(id);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return ids;
  } finally {
    database.close();
  }
}

function selectClockIncrementProbeMove(state) {
  const side = state?.turn;
  if (side !== "black" && side !== "white") return null;
  if (!Array.isArray(state.pieces)) return null;
  const loadout = state.augment?.draft?.loadouts?.[side];
  const baseTypes = state.augment?.ruleState?.baseTypes;
  if (!Array.isArray(loadout) || !baseTypes || typeof baseTypes !== "object") return null;
  if (state.augment?.pendingRecon?.[side]) return null;

  const excludedPieceId = state.augment?.extraMove?.[side]?.excludedPieceId ?? null;
  const requiredPieceId = state.augment?.ruleState?.multiMove?.[side]?.pieceId ?? null;
  const supportedBaseType = (piece, { combat }) => {
    if (!piece || piece.id === excludedPieceId) return null;
    if (requiredPieceId && piece.id !== requiredPieceId) return null;
    const baseType = baseTypes[piece.id];
    if (typeof baseType !== "string" || baseType === "mine" || baseType === "flag") return null;
    if (baseType === "commander" && loadout.includes("spade-iron-fortress")) return null;
    if (combat && baseType === "division" && loadout.includes("club-screened-strike")) {
      return null;
    }
    return baseType;
  };

  const frontRow = side === "black" ? 6 : 5;
  const targetRow = side === "black" ? 5 : 6;
  for (const col of [0, 2, 4]) {
    const piece = state.pieces.find(
      (candidate) =>
        candidate.alive &&
        candidate.side === side &&
        candidate.row === frontRow &&
        candidate.col === col,
    );
    const target = state.pieces.find(
      (candidate) => candidate.alive && candidate.row === targetRow && candidate.col === col,
    );
    if (!piece || !target || target.side === side) continue;
    const baseType = supportedBaseType(piece, { combat: true });
    if (!baseType) continue;
    return {
      kind: "central_combat",
      targetEmpty: false,
      turn: side,
      from: { row: frontRow, col },
      to: { row: targetRow, col },
      baseType,
      loadout: [...loadout],
    };
  }

  const occupied = new Set(
    state.pieces
      .filter((piece) => piece.alive)
      .map((piece) => `${piece.row},${piece.col}`),
  );
  const camps = REPETITION_CAMPS.filter((camp) =>
    side === "white" ? camp.row <= 5 : camp.row >= 6,
  );
  for (const camp of camps) {
    if (occupied.has(`${camp.row},${camp.col}`)) continue;
    const piece = state.pieces.find(
      (candidate) =>
        candidate.alive &&
        candidate.side === side &&
        !isRepetitionHeadquarters(candidate) &&
        isRepetitionRoadEdge(candidate, camp) &&
        Boolean(supportedBaseType(candidate, { combat: false })),
    );
    if (!piece) continue;
    return {
      kind: "camp_quiet",
      targetEmpty: true,
      turn: side,
      from: { row: piece.row, col: piece.col },
      to: { ...camp },
      baseType: baseTypes[piece.id],
      loadout: [...loadout],
    };
  }
  return null;
}

function assertClockIncrementCombatMoveSelectorRegressions() {
  const makeState = (side, loadout, firstBaseType, safeBaseType) => {
    const opponent = side === "black" ? "white" : "black";
    const frontRow = side === "black" ? 6 : 5;
    const targetRow = side === "black" ? 5 : 6;
    return {
      turn: side,
      pieces: [
        { id: "old-candidate", side, type: firstBaseType, row: frontRow, col: 0, alive: true },
        { id: "safe-candidate", side, type: safeBaseType, row: frontRow, col: 2, alive: true },
        { id: "old-target", side: opponent, type: "company", row: targetRow, col: 0, alive: true },
        { id: "safe-target", side: opponent, type: "company", row: targetRow, col: 2, alive: true },
      ],
      augment: {
        draft: { loadouts: { [side]: loadout, [opponent]: [] } },
        ruleState: {
          baseTypes: {
            "old-candidate": firstBaseType,
            "safe-candidate": safeBaseType,
            "old-target": "company",
            "safe-target": "company",
          },
        },
      },
    };
  };

  const fortressMove = selectClockIncrementProbeMove(
    makeState("black", ["spade-iron-fortress"], "commander", "engineer"),
  );
  assert.equal(fortressMove?.kind, "central_combat");
  assert.deepEqual(fortressMove?.from, { row: 6, col: 2 });
  assert.equal(fortressMove?.baseType, "engineer");

  const screenedMove = selectClockIncrementProbeMove(
    makeState("white", ["club-screened-strike"], "division", "brigade"),
  );
  assert.equal(screenedMove?.kind, "central_combat");
  assert.deepEqual(screenedMove?.from, { row: 5, col: 2 });
  assert.deepEqual(screenedMove?.to, { row: 6, col: 2 });
  assert.equal(screenedMove?.baseType, "brigade");

  for (const side of ["black", "white"]) {
    const opponent = side === "black" ? "white" : "black";
    const frontRow = side === "black" ? 6 : 5;
    const targetRow = side === "black" ? 5 : 6;
    const campRow = side === "black" ? 7 : 4;
    const fallbackState = {
      turn: side,
      pieces: [
        { id: "open-bridge", side, type: "company", row: frontRow, col: 0, alive: true },
        { id: "division-two", side, type: "division", row: frontRow, col: 2, alive: true },
        { id: "division-four", side, type: "division", row: frontRow, col: 4, alive: true },
        { id: "target-two", side: opponent, type: "company", row: targetRow, col: 2, alive: true },
        { id: "target-four", side: opponent, type: "company", row: targetRow, col: 4, alive: true },
      ],
      augment: {
        draft: { loadouts: { [side]: ["club-screened-strike"], [opponent]: [] } },
        pendingRecon: { [side]: null, [opponent]: null },
        extraMove: { [side]: null, [opponent]: null },
        ruleState: {
          baseTypes: {
            "open-bridge": "company",
            "division-two": "division",
            "division-four": "division",
            "target-two": "company",
            "target-four": "company",
          },
          multiMove: { [side]: null, [opponent]: null },
        },
      },
    };
    const fallbackMove = selectClockIncrementProbeMove(fallbackState);
    assert.equal(fallbackMove?.kind, "camp_quiet");
    assert.equal(fallbackMove?.targetEmpty, true);
    assert.deepEqual(fallbackMove?.from, { row: frontRow, col: 0 });
    assert.deepEqual(fallbackMove?.to, { row: campRow, col: 1 });
    assert.equal(fallbackMove?.baseType, "company");
  }
}

function clockIncrementFailureDiagnostic(response, move) {
  const body =
    response.body && typeof response.body === "object" && !Array.isArray(response.body)
      ? { error: typeof response.body.error === "string" ? response.body.error : null }
      : response.body ?? null;
  return JSON.stringify({
    status: response.status,
    body,
    kind: move.kind,
    targetEmpty: move.targetEmpty,
    loadout: move.loadout,
    baseType: move.baseType,
    from: move.from,
    to: move.to,
  });
}

function forceRunningClockAtIncrementThreshold(code, { legacy = false } = {}) {
  const database = new DatabaseSync(localD1Path());
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const row = database
      .prepare("SELECT state_json, version FROM games WHERE code = ?")
      .get(code);
    assert.ok(row);
    const state = JSON.parse(row.state_json);
    assert.equal(state.phase, "playing");
    assert.equal(state.clock.incrementMs, 5_000);
    assert.equal(state.clock.incrementThresholdMs, 300_000);
    if (legacy) delete state.clock.incrementCapMs;
    else assert.equal(state.clock.incrementCapMs, null);
    state.clock.remainingMs[state.turn] = 300_000;
    state.clock.turnStartedAt = Date.now() + 60_000;
    const move = selectClockIncrementProbeMove(state);
    assert.ok(move, "clock increment fixture could not find a supported clock-probe move");
    const updated = database
      .prepare("UPDATE games SET state_json = ?, updated_at = ? WHERE code = ? AND version = ?")
      .run(JSON.stringify(state), Date.now(), code, row.version);
    assert.equal(Number(updated.changes), 1);
    return {
      version: Number(row.version),
      ...move,
    };
  } finally {
    database.close();
  }
}

function forceExpiredRankedSetup(matchId) {
  const database = new DatabaseSync(localD1Path());
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const createdAt = Date.now() - 10 * 60 * 1000 - 1_000;
    const result = database
      .prepare(
        "UPDATE platform_matches SET created_at = ? WHERE id = ? AND status IN ('matched', 'active')",
      )
      .run(createdAt, matchId);
    assert.equal(Number(result.changes), 1);
    return createdAt + 10 * 60 * 1000;
  } finally {
    database.close();
  }
}

function stalePresence(authSubject) {
  const database = new DatabaseSync(localD1Path());
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const result = database
      .prepare(
        `UPDATE player_presence
         SET last_heartbeat_at = ?
         WHERE user_id = (SELECT id FROM platform_users WHERE auth_user_id = ?)`,
      )
      .run(Date.now() - 91_000, authSubject);
    assert.equal(Number(result.changes), 1);
  } finally {
    database.close();
  }
}

function spectatorKnownOpponentPieceIds(code, perspective) {
  const database = new DatabaseSync(localD1Path());
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const row = database.prepare("SELECT state_json FROM games WHERE code = ?").get(code);
    assert.ok(row);
    const state = JSON.parse(row.state_json);
    return new Set([
      ...(state.augment?.permanentReveals[perspective] ?? []),
      ...(state.augment?.temporaryReveals[perspective] ?? []),
      ...(state.augment?.ruleState?.publiclyRevealedPieceIds ?? []),
      ...(state.augment?.ruleState?.promotedPublicIds ?? []),
      ...Object.keys(state.augment?.ruleState?.mineHits ?? {}),
    ]);
  } finally {
    database.close();
  }
}

test("authenticated rooms, identity seats, spectator policy, provisioning, and settlement", { timeout: 120_000 }, async (t) => {
  assertClockIncrementCombatMoveSelectorRegressions();
  assert.deepEqual(
    REQUIRED_V3_QUIET_LOOP_EXCLUSIONS.filter((id) => REPETITION_TEST_UNSAFE_AUGMENTS.has(id)),
    REQUIRED_V3_QUIET_LOOP_EXCLUSIONS,
  );
  const port = await openPort();
  const origin = `http://localhost:${port}`;
  const server = spawnIntegrationServer(root, port);
  activeServer = server;
  activeStatePath = server.statePath;
  t.after(async () => {
    try {
      await server.stop();
    } finally {
      activeServer = null;
      activeStatePath = null;
    }
  });
  await waitForJsonApi(origin, server);

  assert.equal((await requestJson(`${origin}/api/rooms`, { method: "POST" })).status, 401);

  const nonce = randomBytes(6).toString("hex");
  const [userA, userB, friend, stranger, cancelA, cancelB, timeoutA, timeoutB, drawA, drawB] = [
    "a",
    "b",
    "friend",
    "stranger",
    "cancel-a",
    "cancel-b",
    "timeout-a",
    "timeout-b",
    "draw-a",
    "draw-b",
  ].map((label) => ({
    headers: identityHeaders(`room-platform-${nonce}-${label}`, `${label}.${nonce}@example.com`),
    handle: `${label.replaceAll("-", "")}${nonce.slice(0, 8)}`,
  }));
  for (const user of [
    userA,
    userB,
    friend,
    stranger,
    cancelA,
    cancelB,
    timeoutA,
    timeoutB,
    drawA,
    drawB,
  ]) {
    assert.equal((await requestJson(`${origin}/api/account`, { headers: user.headers })).status, 200);
    assert.equal(
      (
        await requestJson(`${origin}/api/account`, {
          method: "PATCH",
          headers: { ...user.headers, "Content-Type": "application/json" },
          body: JSON.stringify({ handle: user.handle }),
        })
      ).status,
      200,
    );
  }

  for (const corruptRulesVersion of ["corrupt-rules-version", { unexpected: true }]) {
    const unknownVersionRoom = await postJson(`${origin}/api/rooms`, userA.headers, {
      gameMode: "classic",
      spectatorPolicy: "hidden",
    });
    assert.equal(unknownVersionRoom.status, 201);
    mutatePersistedRoomState(unknownVersionRoom.body.code, (state) => {
      state.rulesVersion = corruptRulesVersion;
    });
    const unknownVersionRecovery = await requestJson(
      `${origin}/api/rooms/${unknownVersionRoom.body.code}`,
      { headers: userA.headers },
    );
    assert.equal(unknownVersionRecovery.status, 500);
    assert.equal(unknownVersionRecovery.body.error, "ROOM_READ_FAILED");
  }

  const unversionedClassicRoom = await postJson(`${origin}/api/rooms`, userA.headers, {
    gameMode: "classic",
    spectatorPolicy: "hidden",
  });
  assert.equal(unversionedClassicRoom.status, 201);
  mutatePersistedRoomState(unversionedClassicRoom.body.code, (state) => {
    delete state.rulesVersion;
  });
  const unversionedClassicRecovery = await requestJson(
    `${origin}/api/rooms/${unversionedClassicRoom.body.code}`,
    { headers: userA.headers },
  );
  assert.equal(unversionedClassicRecovery.status, 200);
  assert.equal(unversionedClassicRecovery.body.snapshot.rulesVersion, "classic-duel-dark-v2");
  assert.equal(unversionedClassicRecovery.body.snapshot.repetition, null);

  const legacyAugmentRoom = await postJson(`${origin}/api/rooms`, userA.headers, {
    gameMode: "augment",
    spectatorPolicy: "hidden",
  });
  assert.equal(legacyAugmentRoom.status, 201);
  mutatePersistedRoomState(legacyAugmentRoom.body.code, (state) => {
    state.rulesVersion = "augment-duel-dark-v1";
    delete state.repetitionTracker;
    delete state.augment.ruleState;
    state.augment.draft = {
      catalogVersion: "junqi-augments-v1",
      activeRound: 1,
      rounds: [
        {
          number: 1,
          trigger: "setup",
          suit: "spades",
          revealed: false,
          players: {
            black: {
              options: [
                "spade-grand-maneuver",
                "spade-relentless-assault",
                "spade-tactical-retreat",
              ],
              selectedId: null,
              locked: false,
              refreshedSlot: null,
            },
            white: {
              options: [
                "spade-tactical-retreat",
                "spade-total-intelligence",
                "spade-strategic-reserve",
              ],
              selectedId: null,
              locked: false,
              refreshedSlot: null,
            },
          },
        },
      ],
      seenBySide: {
        black: [
          "spade-grand-maneuver",
          "spade-relentless-assault",
          "spade-tactical-retreat",
        ],
        white: [
          "spade-tactical-retreat",
          "spade-total-intelligence",
          "spade-strategic-reserve",
        ],
      },
      loadouts: { black: [], white: [] },
    };
  });
  const legacyAugmentRecovery = await requestJson(
    `${origin}/api/rooms/${legacyAugmentRoom.body.code}`,
    { headers: userA.headers },
  );
  assert.equal(legacyAugmentRecovery.status, 200);
  assert.equal(legacyAugmentRecovery.body.snapshot.rulesVersion, "augment-duel-dark-v1");
  assert.equal(legacyAugmentRecovery.body.snapshot.repetition, null);

  const forgedTrackerRoom = await postJson(`${origin}/api/rooms`, userA.headers, {
    gameMode: "augment",
    spectatorPolicy: "hidden",
  });
  assert.equal(forgedTrackerRoom.status, 201);
  mutatePersistedRoomState(forgedTrackerRoom.body.code, (state) => {
    const forgedDigest = "a".repeat(64);
    state.repetitionTracker.counts = { [forgedDigest]: 1 };
    state.repetitionTracker.lastCountedDigest = forgedDigest;
    state.repetitionTracker.currentOccurrences = 1;
  });
  const forgedTrackerRecovery = await requestJson(
    `${origin}/api/rooms/${forgedTrackerRoom.body.code}`,
    { headers: userA.headers },
  );
  assert.equal(forgedTrackerRecovery.status, 500);
  assert.equal(forgedTrackerRecovery.body.error, "ROOM_READ_FAILED");

  const hiddenFlagAfterCommanderFallRoom = await postJson(
    `${origin}/api/rooms`,
    userA.headers,
    {
      gameMode: "augment",
      spectatorPolicy: "hidden",
    },
  );
  assert.equal(hiddenFlagAfterCommanderFallRoom.status, 201);
  mutatePersistedRoomState(hiddenFlagAfterCommanderFallRoom.body.code, (state) => {
    const commander = state.pieces.find(
      (piece) =>
        piece.side === "white" &&
        state.augment.ruleState.baseTypes[piece.id] === "commander",
    );
    assert.ok(commander);
    commander.alive = false;
    state.augment.ruleState.commanderFallen.white = true;
    state.augment.ruleState.casualties.white += 1;
    assert.equal(state.revealedFlags.white, false);
  });
  const hiddenFlagAfterCommanderFallRecovery = await requestJson(
    `${origin}/api/rooms/${hiddenFlagAfterCommanderFallRoom.body.code}`,
    { headers: userA.headers },
  );
  assert.equal(hiddenFlagAfterCommanderFallRecovery.status, 500);
  assert.equal(hiddenFlagAfterCommanderFallRecovery.body.error, "ROOM_READ_FAILED");

  const classic = await postJson(`${origin}/api/rooms`, userA.headers, {
    gameMode: "classic",
    spectatorPolicy: "full",
  });
  assert.equal(classic.status, 201);
  assert.equal(classic.body.gameMode, "classic");
  assert.equal(classic.body.snapshot.mode, "classic");
  assert.equal(classic.body.snapshot.rulesVersion, "classic-duel-dark-v2");
  const code = classic.body.code;

  assert.equal((await requestJson(`${origin}/api/rooms/${code}`)).status, 401);
  const identityOnly = await requestJson(`${origin}/api/rooms/${code}`, { headers: userA.headers });
  assert.equal(identityOnly.status, 200);
  assert.equal(identityOnly.body.viewer, "black");
  const tokenCompatible = await requestJson(`${origin}/api/rooms/${code}`, {
    headers: { ...userA.headers, Authorization: `Bearer ${classic.body.playerToken}` },
  });
  assert.equal(tokenCompatible.status, 200);
  assert.equal(tokenCompatible.body.viewer, "black");

  const randomized = await postAction(origin, code, userA.headers, 0, { type: "randomize" });
  assert.equal(randomized.status, 200);
  const whiteToken = randomBytes(32).toString("base64url");
  const claimed = await postJson(`${origin}/api/rooms/${code}/claim`, userB.headers, {
    inviteToken: classic.body.opponentInviteToken,
    playerToken: whiteToken,
  });
  assert.equal(claimed.status, 200);
  assert.ok(claimed.body.matchId);
  const idempotentClaim = await postJson(`${origin}/api/rooms/${code}/claim`, userB.headers, {
    inviteToken: randomBytes(32).toString("base64url"),
    playerToken: whiteToken,
  });
  assert.equal(idempotentClaim.status, 200);
  assert.equal(idempotentClaim.body.matchId, claimed.body.matchId);
  const crossAccountClaim = await postJson(
    `${origin}/api/rooms/${code}/claim`,
    stranger.headers,
    {
      inviteToken: randomBytes(32).toString("base64url"),
      playerToken: whiteToken,
    },
  );
  assert.equal(crossAccountClaim.status, 409);
  assert.equal(crossAccountClaim.body.error, "ROOM_IDENTITY_CONFLICT");
  const crossSeatAction = await postAction(
    origin,
    code,
    userA.headers,
    claimed.body.version,
    { type: "randomize" },
    whiteToken,
  );
  assert.equal(crossSeatAction.status, 401);
  assert.equal(crossSeatAction.body.error, "INVALID_PLAYER_TOKEN");
  const whiteCrossDevice = await requestJson(`${origin}/api/rooms/${code}`, { headers: userB.headers });
  assert.equal(whiteCrossDevice.body.viewer, "white");

  const fullSpectator = await requestJson(`${origin}/api/rooms/${code}`, { headers: friend.headers });
  assert.equal(fullSpectator.status, 200);
  assert.equal(fullSpectator.body.viewer, "spectator");
  assert.equal(fullSpectator.body.snapshot.pieces.filter((piece) => piece.type).length, 50);

  let version = whiteCrossDevice.body.version;
  assert.equal((await postAction(origin, code, userA.headers, version, { type: "ready", value: true })).status, 200);
  version += 1;
  assert.equal((await postAction(origin, code, userB.headers, version, { type: "ready", value: true })).status, 200);
  version += 1;
  const crossOriginResign = await requestJson(`${origin}/api/rooms/${code}/actions`, {
    method: "POST",
    headers: {
      ...userA.headers,
      Origin: origin,
      "Sec-Fetch-Site": "cross-site",
      "Content-Type": "text/plain",
    },
    body: JSON.stringify({ expectedVersion: version, action: { type: "resign" } }),
  });
  assert.equal(crossOriginResign.status, 403);
  assert.deepEqual(crossOriginResign.body, { error: "CROSS_ORIGIN_REQUEST" });
  const afterCrossOriginResign = await requestJson(`${origin}/api/rooms/${code}`, {
    headers: userA.headers,
  });
  assert.equal(afterCrossOriginResign.body.version, version);
  assert.equal(afterCrossOriginResign.body.snapshot.phase, "playing");
  const privateFinish = await postAction(origin, code, userA.headers, version, { type: "resign" });
  assert.equal(privateFinish.status, 200);
  assert.equal(privateFinish.body.snapshot.phase, "finished");
  const privateFullAfterFinish = await requestJson(`${origin}/api/rooms/${code}`, {
    headers: friend.headers,
  });
  assert.equal(privateFullAfterFinish.status, 200);
  assert.equal(
    privateFullAfterFinish.body.snapshot.pieces.filter((piece) => piece.type).length,
    50,
  );
  assert.notEqual(privateFullAfterFinish.body.snapshot.replay, null);
  const privateAccount = await requestJson(`${origin}/api/account`, { headers: userA.headers });
  assert.equal(privateAccount.body.account.rating, 1200);
  assert.equal(privateAccount.body.account.record.games, 1);
  assert.equal(privateAccount.body.account.record.rankedGames, 0);

  const hidden = await postJson(`${origin}/api/rooms`, userA.headers, {
    gameMode: "augment",
    spectatorPolicy: "hidden",
  });
  assert.equal(hidden.status, 201);
  const hiddenSpectator = await requestJson(`${origin}/api/rooms/${hidden.body.code}`, {
    headers: friend.headers,
  });
  assert.equal(hiddenSpectator.status, 200);
  assert.equal(hiddenSpectator.body.snapshot.mode, "augment");
  assert.equal(hiddenSpectator.body.snapshot.rulesVersion, "augment-duel-dark-v3");
  assert.equal(hiddenSpectator.body.snapshot.pieces.filter((piece) => piece.type).length, 0);

  async function prepareSecondDraftRoom() {
    const created = await postJson(`${origin}/api/rooms`, userA.headers, {
      gameMode: "augment",
      spectatorPolicy: "hidden",
    });
    assert.equal(created.status, 201);
    const claimedRoom = await postJson(`${origin}/api/rooms/${created.body.code}/claim`, userB.headers, {
      inviteToken: created.body.opponentInviteToken,
      playerToken: randomBytes(32).toString("base64url"),
    });
    assert.equal(claimedRoom.status, 200);
    let roomVersion = claimedRoom.body.version;
    const optionBySide = {
      black: created.body.snapshot.augment.draft.rounds[0].players.black.options.find(
        (id) => !OPENING_TEST_EXCLUDED_AUGMENTS.has(id),
      ),
      white: claimedRoom.body.snapshot.augment.draft.rounds[0].players.white.options.find(
        (id) => !OPENING_TEST_EXCLUDED_AUGMENTS.has(id),
      ),
    };
    for (const [side, headers] of [
      ["black", userA.headers],
      ["white", userB.headers],
    ]) {
      const selected = await postAction(origin, created.body.code, headers, roomVersion, {
        type: "augment_select",
        augmentId: optionBySide[side],
      });
      assert.equal(selected.status, 200);
      roomVersion = selected.body.version;
      const locked = await postAction(origin, created.body.code, headers, roomVersion, {
        type: "augment_lock",
      });
      assert.equal(locked.status, 200);
      roomVersion = locked.body.version;
      const ready = await postAction(origin, created.body.code, headers, roomVersion, {
        type: "ready",
        value: true,
      });
      assert.equal(ready.status, 200);
      roomVersion = ready.body.version;
    }
    const playing = await requestJson(`${origin}/api/rooms/${created.body.code}`, {
      headers: userA.headers,
    });
    assert.equal(playing.body.snapshot.phase, "playing");
    assert.equal(playing.body.version, roomVersion);
    return created.body.code;
  }

  const getDeadlineCode = await prepareSecondDraftRoom();
  const getDeadline = forceExpiredSecondDraft(getDeadlineCode, { preserveBlackSelection: true });
  const settledByGet = await requestJson(`${origin}/api/rooms/${getDeadlineCode}`, {
    headers: userA.headers,
  });
  assert.equal(settledByGet.status, 200);
  assert.equal(settledByGet.body.version, getDeadline.version + 1);
  assert.equal(settledByGet.body.snapshot.phase, "playing");
  assert.equal(settledByGet.body.snapshot.clock.running, getDeadline.resumeTurn);
  assert.equal(settledByGet.body.snapshot.augment.draftDeadlineAt, null);
  assert.equal(settledByGet.body.snapshot.augment.draft.activeRound, null);
  const getSecondRound = settledByGet.body.snapshot.augment.draft.rounds[1];
  assert.equal(getSecondRound.revealed, true);
  assert.equal(getSecondRound.players.black.selectedId, getDeadline.timeoutBlackSelection);
  assert.ok(getSecondRound.players.white.selectedId);
  assert.equal(settledByGet.body.snapshot.augment.draft.loadouts.black.length, 2);
  assert.equal(settledByGet.body.snapshot.augment.draft.loadouts.white.length, 2);

  const postDeadlineCode = await prepareSecondDraftRoom();
  const postDeadline = forceExpiredSecondDraft(postDeadlineCode);
  const staleSelection = await postAction(
    origin,
    postDeadlineCode,
    userA.headers,
    postDeadline.version,
    { type: "augment_select", augmentId: postDeadline.attemptedId },
  );
  assert.equal(staleSelection.status, 409);
  assert.equal(staleSelection.body.error, "VERSION_CONFLICT");
  const afterStaleSelection = await requestJson(`${origin}/api/rooms/${postDeadlineCode}`, {
    headers: userA.headers,
  });
  assert.equal(afterStaleSelection.body.version, postDeadline.version + 1);
  assert.equal(afterStaleSelection.body.snapshot.phase, "playing");
  const postSecondRound = afterStaleSelection.body.snapshot.augment.draft.rounds[1];
  assert.equal(postSecondRound.revealed, true);
  assert.equal(postSecondRound.players.black.selectedId, postDeadline.timeoutBlackSelection);
  assert.notEqual(postSecondRound.players.black.selectedId, postDeadline.attemptedId);

  const friendRequest = await postJson(`${origin}/api/friends/requests`, friend.headers, {
    handle: userA.handle,
  });
  assert.equal(friendRequest.status, 201);
  assert.equal(
    (
      await postJson(
        `${origin}/api/friends/requests/${friendRequest.body.request.requestId}/accept`,
        userA.headers,
      )
    ).status,
    200,
  );

  const [cancelQueueA, cancelQueueB] = await Promise.all([
    joinQueue(origin, cancelA.headers),
    joinQueue(origin, cancelB.headers),
  ]);
  assert.ok([200, 202].includes(cancelQueueA.status));
  assert.ok([200, 202].includes(cancelQueueB.status));
  const [cancelStatusA, cancelStatusB] = await Promise.all([
    requestJson(`${origin}/api/matchmaking`, { headers: cancelA.headers }),
    requestJson(`${origin}/api/matchmaking`, { headers: cancelB.headers }),
  ]);
  assert.equal(cancelStatusA.body.state, "matched");
  assert.equal(cancelStatusB.body.state, "matched");
  assert.equal(cancelStatusA.body.match.id, cancelStatusB.body.match.id);
  assert.equal(cancelStatusA.body.match.game.status, "ready");
  assert.equal(cancelStatusA.body.match.setupDeadlineAt, cancelStatusB.body.match.setupDeadlineAt);
  assert.ok(cancelStatusA.body.match.setupDeadlineAt - Date.now() > 9 * 60 * 1000);
  const cancelCode = cancelStatusA.body.match.game.code;
  const cancelRoom = await requestJson(`${origin}/api/rooms/${cancelCode}`, {
    headers: cancelA.headers,
  });
  assert.equal(cancelRoom.status, 200);
  assert.equal(cancelRoom.body.snapshot.phase, "setup");
  assert.equal(cancelRoom.body.setupDeadlineAt, cancelStatusA.body.match.setupDeadlineAt);
  const strangerCancel = await requestJson(`${origin}/api/rooms/${cancelCode}`, {
    method: "DELETE",
    headers: stranger.headers,
  });
  assert.equal(strangerCancel.status, 404);
  assert.deepEqual(strangerCancel.body, { error: "ROOM_NOT_FOUND" });
  const customCancel = await requestJson(`${origin}/api/rooms/${code}`, {
    method: "DELETE",
    headers: userA.headers,
  });
  assert.equal(customCancel.status, 404);
  assert.deepEqual(customCancel.body, { error: "ROOM_NOT_FOUND" });
  const anonymousCancel = await requestJson(`${origin}/api/rooms/${cancelCode}`, {
    method: "DELETE",
  });
  assert.equal(anonymousCancel.status, 401);
  const crossOriginCancel = await requestJson(`${origin}/api/rooms/${cancelCode}`, {
    method: "DELETE",
    headers: {
      ...cancelA.headers,
      Origin: origin,
      "Sec-Fetch-Site": "cross-site",
    },
  });
  assert.equal(crossOriginCancel.status, 403);
  assert.deepEqual(crossOriginCancel.body, { error: "CROSS_ORIGIN_REQUEST" });

  const concurrentCancels = await Promise.all([
    requestJson(`${origin}/api/rooms/${cancelCode}`, {
      method: "DELETE",
      headers: cancelA.headers,
    }),
    requestJson(`${origin}/api/rooms/${cancelCode}`, {
      method: "DELETE",
      headers: cancelB.headers,
    }),
  ]);
  assert.deepEqual(concurrentCancels.map((response) => response.status), [200, 200]);
  assert.equal(concurrentCancels.every((response) => response.body.state === "idle"), true);
  assert.equal(concurrentCancels.every((response) => response.body.reason === "setup_cancelled"), true);
  const repeatedCancel = await requestJson(`${origin}/api/rooms/${cancelCode}`, {
    method: "DELETE",
    headers: cancelA.headers,
  });
  assert.equal(repeatedCancel.status, 200);
  assert.equal(repeatedCancel.body.reason, "setup_cancelled");
  const cancelledRoom = await requestJson(`${origin}/api/rooms/${cancelCode}`, {
    headers: cancelA.headers,
  });
  assert.equal(cancelledRoom.status, 410);
  assert.equal(cancelledRoom.body.error, "RANKED_SETUP_CANCELLED");
  const cancelledAction = await postAction(
    origin,
    cancelCode,
    cancelB.headers,
    cancelRoom.body.version,
    { type: "randomize" },
  );
  assert.equal(cancelledAction.status, 410);
  assert.equal(cancelledAction.body.error, "RANKED_SETUP_CANCELLED");
  for (const player of [cancelA, cancelB]) {
    const account = await requestJson(`${origin}/api/account`, { headers: player.headers });
    assert.equal(account.body.account.rating, 1200);
    assert.deepEqual(account.body.account.record, {
      games: 0,
      rankedGames: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      winRate: 0,
      winRatePercent: 0,
    });
    assert.deepEqual(account.body.recentMatches, []);
    assert.equal((await requestJson(`${origin}/api/matchmaking`, { headers: player.headers })).body.state, "idle");
  }
  const requeueCancelA = await joinQueue(origin, cancelA.headers);
  const requeueCancelB = await joinQueue(origin, cancelB.headers);
  assert.ok(["queued", "matched"].includes(requeueCancelA.body.state));
  assert.equal(requeueCancelB.body.state, "matched");
  assert.equal(
    (
      await requestJson(`${origin}/api/matchmaking`, {
        method: "DELETE",
        headers: cancelA.headers,
      })
    ).body.state,
    "idle",
  );
  assert.equal(
    (await requestJson(`${origin}/api/matchmaking`, { headers: cancelB.headers })).body.state,
    "idle",
  );

  await Promise.all([joinQueue(origin, timeoutA.headers), joinQueue(origin, timeoutB.headers)]);
  const timeoutStatus = await requestJson(`${origin}/api/matchmaking`, { headers: timeoutA.headers });
  assert.equal(timeoutStatus.body.state, "matched");
  const timeoutMatchId = timeoutStatus.body.match.id;
  const timeoutCode = timeoutStatus.body.match.game.code;
  const forcedDeadlineAt = forceExpiredRankedSetup(timeoutMatchId);
  const timeoutResults = await Promise.all([
    requestJson(`${origin}/api/rooms/${timeoutCode}`, { headers: timeoutA.headers }),
    requestJson(`${origin}/api/matchmaking`, { headers: timeoutB.headers }),
  ]);
  assert.equal(timeoutResults[0].status, 410);
  assert.equal(timeoutResults[0].body.error, "RANKED_SETUP_EXPIRED");
  assert.equal(timeoutResults[1].status, 200);
  assert.equal(timeoutResults[1].body.state, "idle");
  const repeatedTimeout = await requestJson(`${origin}/api/rooms/${timeoutCode}`, {
    headers: timeoutB.headers,
  });
  assert.equal(repeatedTimeout.status, 410);
  assert.equal(repeatedTimeout.body.error, "RANKED_SETUP_EXPIRED");
  for (const player of [timeoutA, timeoutB]) {
    const account = await requestJson(`${origin}/api/account`, { headers: player.headers });
    assert.equal(account.body.account.rating, 1200);
    assert.equal(account.body.account.record.games, 0);
    assert.equal(account.body.account.record.rankedGames, 0);
    assert.deepEqual(account.body.recentMatches, []);
  }
  {
    const database = new DatabaseSync(localD1Path());
    try {
      database.exec("PRAGMA busy_timeout = 5000");
      const cancelled = database
        .prepare(
          `SELECT status, ended_reason, rating_delta_a, rating_delta_b, completed_at
           FROM platform_matches WHERE id = ?`,
        )
        .get(timeoutMatchId);
      assert.deepEqual(
        {
          status: cancelled.status,
          reason: cancelled.ended_reason,
          deltaA: cancelled.rating_delta_a,
          deltaB: cancelled.rating_delta_b,
        },
        { status: "cancelled", reason: "setup_timeout", deltaA: 0, deltaB: 0 },
      );
      assert.ok(cancelled.completed_at >= forcedDeadlineAt);
    } finally {
      database.close();
    }
  }

  const [firstQueue, secondQueue] = await Promise.all([
    joinQueue(origin, userA.headers),
    joinQueue(origin, userB.headers),
  ]);
  assert.ok([200, 202].includes(firstQueue.status));
  assert.ok([200, 202].includes(secondQueue.status));
  const [statusA, statusB] = await Promise.all([
    requestJson(`${origin}/api/matchmaking`, { headers: userA.headers }),
    requestJson(`${origin}/api/matchmaking`, { headers: userB.headers }),
  ]);
  assert.equal(statusA.body.state, "matched");
  assert.equal(statusB.body.state, "matched");
  assert.equal(statusA.body.match.game.status, "ready");
  assert.equal(statusA.body.match.game.code, statusB.body.match.game.code);
  assert.ok(statusA.body.match.setupDeadlineAt > Date.now());
  const duplicateQueueCalls = await Promise.all([
    ...Array.from({ length: 6 }, () => joinQueue(origin, userA.headers)),
    ...Array.from({ length: 6 }, () => joinQueue(origin, userB.headers)),
  ]);
  assert.equal(
    duplicateQueueCalls.every(
      (response) =>
        response.status === 200 &&
        response.body.state === "matched" &&
        response.body.match.id === statusA.body.match.id,
    ),
    true,
  );
  {
    const database = new DatabaseSync(localD1Path());
    try {
      database.exec("PRAGMA busy_timeout = 5000");
      const activeRanked = database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM platform_matches m
           JOIN platform_users player
             ON player.id IN (m.player_a_id, m.player_b_id)
           WHERE player.auth_user_id = ? AND m.ranked = 1
             AND m.status IN ('matched', 'active')`,
        )
        .get(userA.headers["oai-authenticated-user-id"]);
      assert.equal(Number(activeRanked.count), 1);
    } finally {
      database.close();
    }
  }
  const rankedCode = statusA.body.match.game.code;

  stalePresence(userA.headers["oai-authenticated-user-id"]);
  const staleFriendList = await requestJson(`${origin}/api/friends`, { headers: friend.headers });
  const staleFriend = staleFriendList.body.friends.find((entry) => entry.player.handle === userA.handle);
  assert.equal(staleFriend.presence, "offline");
  assert.equal(staleFriend.currentMatchId, null);
  const inRoomHeartbeat = await postJson(`${origin}/api/presence`, userA.headers);
  assert.equal(inRoomHeartbeat.status, 200);
  assert.equal(inRoomHeartbeat.body.status, "in_game");
  assert.equal(inRoomHeartbeat.body.currentMatchId, statusA.body.match.id);
  const revivedFriendList = await requestJson(`${origin}/api/friends`, { headers: friend.headers });
  const revivedFriend = revivedFriendList.body.friends.find((entry) => entry.player.handle === userA.handle);
  assert.equal(revivedFriend.presence, "in_game");
  assert.equal(revivedFriend.currentMatchId, statusA.body.match.id);

  const [rankedA, rankedB] = await Promise.all([
    requestJson(`${origin}/api/rooms/${rankedCode}`, { headers: userA.headers }),
    requestJson(`${origin}/api/rooms/${rankedCode}`, { headers: userB.headers }),
  ]);
  assert.equal(rankedA.status, 200);
  assert.equal(rankedB.status, 200);
  assert.equal(rankedA.body.roomKind, "ranked");
  assert.equal(rankedA.body.gameMode, "augment");
  assert.equal(rankedA.body.snapshot.clock.initialMs, 600_000);
  assert.equal(rankedA.body.snapshot.clock.incrementMs, 5_000);
  assert.equal(rankedA.body.snapshot.clock.incrementThresholdMs, 300_000);
  assert.equal(rankedA.body.snapshot.clock.incrementCapMs, null);
  assert.equal(rankedA.body.snapshot.pieces.filter((piece) => piece.type).length, 25);

  const rankedStranger = await requestJson(`${origin}/api/rooms/${rankedCode}`, {
    headers: stranger.headers,
  });
  assert.equal(rankedStranger.status, 403);
  const rankedFriend = await requestJson(`${origin}/api/rooms/${rankedCode}`, {
    headers: friend.headers,
  });
  assert.equal(rankedFriend.status, 200);
  assert.equal(rankedFriend.body.viewer, "spectator");
  assert.equal(rankedFriend.body.spectatorPerspective, statusA.body.match.side);
  assert.equal(rankedFriend.body.snapshot.pieces.filter((piece) => piece.type).length, 25);
  assert.equal(rankedFriend.body.snapshot.replay, null);
  const watchedSide = rankedFriend.body.spectatorPerspective;
  const opponentSide = watchedSide === "black" ? "white" : "black";
  const publiclyRevealedOpponent = makeOpponentPiecePublic(rankedCode, watchedSide);
  assert.ok(publiclyRevealedOpponent);
  const watchedDraft = rankedFriend.body.snapshot.augment.draft.rounds[0].players;
  assert.equal(Array.isArray(watchedDraft[watchedSide].options), true);
  assert.equal(watchedDraft[watchedSide].options.length, 3);
  assert.equal(watchedDraft[opponentSide].options, null);

  const bySide = {
    [rankedA.body.viewer]: { headers: userA.headers, view: rankedA },
    [rankedB.body.viewer]: { headers: userB.headers, view: rankedB },
  };
  version = Math.max(rankedA.body.version, rankedB.body.version);
  for (const side of ["black", "white"]) {
    const player = bySide[side];
    const ownRound = player.view.body.snapshot.augment.draft.rounds[0].players[side];
    const openingAugment = ownRound.options.find(
      (id) => !OPENING_TEST_EXCLUDED_AUGMENTS.has(id),
    );
    assert.ok(openingAugment);
    const selected = await postAction(origin, rankedCode, player.headers, version, {
      type: "augment_select",
      augmentId: openingAugment,
    });
    assert.equal(selected.status, 200);
    version += 1;
    assert.equal(
      (await postAction(origin, rankedCode, player.headers, version, { type: "augment_lock" })).status,
      200,
    );
    version += 1;
    assert.equal(
      (await postAction(origin, rankedCode, player.headers, version, { type: "ready", value: true })).status,
      200,
    );
    version += 1;
  }
  const rankedPlaying = await requestJson(`${origin}/api/rooms/${rankedCode}`, {
    headers: bySide.black.headers,
  });
  assert.equal(rankedPlaying.status, 200);
  assert.equal(rankedPlaying.body.snapshot.phase, "playing");
  assert.equal(rankedPlaying.body.setupDeadlineAt, null);
  const rankedFriendPlaying = await requestJson(`${origin}/api/rooms/${rankedCode}`, {
    headers: friend.headers,
  });
  assert.equal(rankedFriendPlaying.status, 200);
  assert.equal(rankedFriendPlaying.body.snapshot.phase, "playing");
  assert.equal(rankedFriendPlaying.body.snapshot.replay, null);
  const authoritativePlayingPiece = authoritativePublicPieceState(
    rankedCode,
    publiclyRevealedOpponent.id,
  );
  assert.equal(authoritativePlayingPiece.baseType, publiclyRevealedOpponent.setupType);
  assert.equal(authoritativePlayingPiece.publiclyRevealed, true);
  assert.equal(
    rankedFriendPlaying.body.snapshot.pieces.find(
      (piece) => piece.id === publiclyRevealedOpponent.id,
    )?.type,
    authoritativePlayingPiece.type,
  );
  assert.equal(
    rankedFriendPlaying.body.snapshot.pieces
      .filter((piece) => piece.side === opponentSide)
      .every((piece) => !("originalType" in piece)),
    true,
  );
  assert.equal(JSON.stringify(rankedFriendPlaying.body.snapshot).includes('"baseTypes"'), false);
  const startedCancel = await requestJson(`${origin}/api/rooms/${rankedCode}`, {
    method: "DELETE",
    headers: bySide.black.headers,
  });
  assert.equal(startedCancel.status, 409);
  assert.equal(startedCancel.body.error, "RANKED_SETUP_ALREADY_STARTED");
  const afterStartedCancel = await requestJson(`${origin}/api/rooms/${rankedCode}`, {
    headers: bySide.black.headers,
  });
  assert.equal(afterStartedCancel.body.version, rankedPlaying.body.version);
  assert.equal(afterStartedCancel.body.snapshot.phase, "playing");
  const thresholdClock = forceRunningClockAtIncrementThreshold(rankedCode);
  assert.equal(thresholdClock.version, version);
  const incrementMove = await postAction(
    origin,
    rankedCode,
    bySide[thresholdClock.turn].headers,
    version,
    { type: "move", from: thresholdClock.from, to: thresholdClock.to },
  );
  assert.equal(
    incrementMove.status,
    200,
    clockIncrementFailureDiagnostic(incrementMove, thresholdClock),
  );
  assert.equal(incrementMove.body.snapshot.clock.remainingMs[thresholdClock.turn], 305_000);
  assert.equal(incrementMove.body.snapshot.clock.incrementCapMs, null);
  version = incrementMove.body.version;

  const legacyThresholdClock = forceRunningClockAtIncrementThreshold(rankedCode, {
    legacy: true,
  });
  assert.equal(legacyThresholdClock.version, version);
  const legacyIncrementMove = await postAction(
    origin,
    rankedCode,
    bySide[legacyThresholdClock.turn].headers,
    version,
    { type: "move", from: legacyThresholdClock.from, to: legacyThresholdClock.to },
  );
  assert.equal(
    legacyIncrementMove.status,
    200,
    clockIncrementFailureDiagnostic(legacyIncrementMove, legacyThresholdClock),
  );
  assert.equal(
    legacyIncrementMove.body.snapshot.clock.remainingMs[legacyThresholdClock.turn],
    300_000,
  );
  assert.equal(legacyIncrementMove.body.snapshot.clock.incrementCapMs, 300_000);
  version = legacyIncrementMove.body.version;
  const rankedFinish = await postAction(
    origin,
    rankedCode,
    bySide.black.headers,
    version,
    { type: "resign" },
  );
  assert.equal(rankedFinish.status, 200);
  assert.equal(rankedFinish.body.snapshot.phase, "finished");

  const [, , rankedFriendAfterFinish] = await Promise.all([
    requestJson(`${origin}/api/rooms/${rankedCode}`, { headers: userA.headers }),
    requestJson(`${origin}/api/rooms/${rankedCode}`, { headers: userB.headers }),
    requestJson(`${origin}/api/rooms/${rankedCode}`, { headers: friend.headers }),
  ]);
  assert.equal(rankedFriendAfterFinish.status, 200);
  assert.equal(rankedFriendAfterFinish.body.snapshot.phase, "finished");
  assert.equal(rankedFriendAfterFinish.body.snapshot.replay, null);
  assertNoRepetitionSecrets(rankedFriendAfterFinish.body.snapshot);
  assert.equal(rankedFriendAfterFinish.body.snapshot.events.length > 0, true);
  const authoritativeFinishedPiece = authoritativePublicPieceState(
    rankedCode,
    publiclyRevealedOpponent.id,
  );
  assert.equal(authoritativeFinishedPiece.baseType, publiclyRevealedOpponent.setupType);
  assert.equal(authoritativeFinishedPiece.publiclyRevealed, true);
  assert.equal(
    rankedFriendAfterFinish.body.snapshot.pieces.find(
      (piece) => piece.id === publiclyRevealedOpponent.id,
    )?.type,
    authoritativeFinishedPiece.type,
  );
  assert.equal(
    rankedFriendAfterFinish.body.snapshot.pieces
      .filter((piece) => piece.side === opponentSide)
      .every((piece) => !("originalType" in piece)),
    true,
  );
  assert.equal(JSON.stringify(rankedFriendAfterFinish.body.snapshot).includes('"baseTypes"'), false);
  assert.equal(
    rankedFriendAfterFinish.body.snapshot.pieces
      .filter((piece) => piece.side === watchedSide)
      .every((piece) => piece.type !== null),
    true,
  );
  const knownOpponentPieceIds = spectatorKnownOpponentPieceIds(rankedCode, watchedSide);
  assert.equal(
    rankedFriendAfterFinish.body.snapshot.pieces
      .filter((piece) => piece.side === opponentSide)
      .every(
        (piece) =>
          (piece.type !== null) ===
          (piece.flagRevealed || knownOpponentPieceIds.has(piece.id)),
      ),
    true,
  );
  const completedFriendLookup = await requestJson(
    `${origin}/api/friends/matches/${statusA.body.match.id}`,
    { headers: friend.headers },
  );
  assert.equal(completedFriendLookup.status, 404);
  assert.deepEqual(completedFriendLookup.body, { error: "FRIEND_MATCH_NOT_FOUND" });
  const [accountA, accountB] = await Promise.all([
    requestJson(`${origin}/api/account`, { headers: userA.headers }),
    requestJson(`${origin}/api/account`, { headers: userB.headers }),
  ]);
  assert.equal(accountA.body.account.record.rankedGames, 1);
  assert.equal(accountB.body.account.record.rankedGames, 1);
  assert.equal(accountA.body.account.record.games, 2);
  assert.equal(accountB.body.account.record.games, 2);
  assert.notEqual(accountA.body.account.rating, 1200);
  assert.notEqual(accountB.body.account.rating, 1200);
  const rankedHistoryA = accountA.body.recentMatches.filter(
    (match) => match.id === statusA.body.match.id,
  );
  const rankedHistoryB = accountB.body.recentMatches.filter(
    (match) => match.id === statusB.body.match.id,
  );
  assert.equal(rankedHistoryA.length, 1);
  assert.equal(rankedHistoryB.length, 1);
  assert.equal(rankedHistoryA[0].ratingDelta, accountA.body.account.rating - 1200);
  assert.equal(rankedHistoryB[0].ratingDelta, accountB.body.account.rating - 1200);
  assert.equal(
    rankedHistoryA[0].outcome,
    statusA.body.match.side === "black" ? "loss" : "win",
  );
  assert.equal(
    rankedHistoryB[0].outcome,
    statusB.body.match.side === "black" ? "loss" : "win",
  );

  const historyIds = insertCompletedHistoryFixtures(
    userA.headers["oai-authenticated-user-id"],
    userB.headers["oai-authenticated-user-id"],
    nonce,
  );
  const boundedHistory = await requestJson(`${origin}/api/account`, { headers: userA.headers });
  assert.equal(boundedHistory.status, 200);
  assert.equal(boundedHistory.body.recentMatches.length, 10);
  assert.deepEqual(
    boundedHistory.body.recentMatches.map((match) => match.id),
    historyIds.slice(1).reverse(),
  );

  setPlatformRating(drawA.headers["oai-authenticated-user-id"], 1250);
  setPlatformRating(drawB.headers["oai-authenticated-user-id"], 1150);
  const [drawJoinA, drawJoinB] = await Promise.all([
    joinQueue(origin, drawA.headers),
    joinQueue(origin, drawB.headers),
  ]);
  assert.ok([200, 202].includes(drawJoinA.status));
  assert.ok([200, 202].includes(drawJoinB.status));
  const [drawStatusA, drawStatusB] = await Promise.all([
    requestJson(`${origin}/api/matchmaking`, { headers: drawA.headers }),
    requestJson(`${origin}/api/matchmaking`, { headers: drawB.headers }),
  ]);
  assert.equal(drawStatusA.body.state, "matched");
  assert.equal(drawStatusB.body.state, "matched");
  assert.equal(drawStatusA.body.match.id, drawStatusB.body.match.id);
  const rankedDrawMatchId = drawStatusA.body.match.id;
  const rankedDrawCode = drawStatusA.body.match.game.code;
  const rankedDrawHeadersBySide = {
    [drawStatusA.body.match.side]: drawA.headers,
    [drawStatusB.body.match.side]: drawB.headers,
  };
  const rankedDrawPlaying = await startRepetitionRoom(
    origin,
    rankedDrawCode,
    rankedDrawHeadersBySide,
  );
  const rankedRepetitionActive = await activateRepetitionAfterSecondDraft(
    origin,
    rankedDrawPlaying,
    rankedDrawHeadersBySide,
  );
  await playThreefoldCampLoop(origin, rankedRepetitionActive, rankedDrawHeadersBySide);
  const [rankedDrawA, rankedDrawB] = await Promise.all([
    requestJson(`${origin}/api/rooms/${rankedDrawCode}`, { headers: drawA.headers }),
    requestJson(`${origin}/api/rooms/${rankedDrawCode}`, { headers: drawB.headers }),
  ]);
  for (const response of [rankedDrawA, rankedDrawB]) {
    assert.equal(response.status, 200);
    assert.equal(response.body.snapshot.phase, "finished");
    assert.equal(response.body.snapshot.winner, null);
    assert.equal(response.body.snapshot.finishReason, "draw");
    assert.equal(response.body.snapshot.drawReason, "threefold_repetition");
    assert.deepEqual(response.body.snapshot.repetition, {
      threshold: 3,
      currentOccurrences: 3,
      active: false,
    });
    assertNoRepetitionSecrets(response.body.snapshot);
  }

  const [rankedDrawAccountA, rankedDrawAccountB] = await Promise.all([
    requestJson(`${origin}/api/account`, { headers: drawA.headers }),
    requestJson(`${origin}/api/account`, { headers: drawB.headers }),
  ]);
  assert.equal(rankedDrawAccountA.body.account.record.games, 1);
  assert.equal(rankedDrawAccountB.body.account.record.games, 1);
  assert.equal(rankedDrawAccountA.body.account.record.rankedGames, 1);
  assert.equal(rankedDrawAccountB.body.account.record.rankedGames, 1);
  assert.equal(rankedDrawAccountA.body.account.record.draws, 1);
  assert.equal(rankedDrawAccountB.body.account.record.draws, 1);
  assert.ok(rankedDrawAccountA.body.account.rating < 1250);
  assert.ok(rankedDrawAccountB.body.account.rating > 1150);
  assert.equal(
    rankedDrawAccountA.body.account.rating + rankedDrawAccountB.body.account.rating,
    2400,
  );
  const rankedDrawHistoryA = rankedDrawAccountA.body.recentMatches.find(
    (match) => match.id === rankedDrawMatchId,
  );
  const rankedDrawHistoryB = rankedDrawAccountB.body.recentMatches.find(
    (match) => match.id === rankedDrawMatchId,
  );
  assert.ok(rankedDrawHistoryA);
  assert.ok(rankedDrawHistoryB);
  assert.equal(rankedDrawHistoryA.outcome, "draw");
  assert.equal(rankedDrawHistoryB.outcome, "draw");
  assert.equal(rankedDrawHistoryA.endedReason, "threefold_repetition");
  assert.equal(rankedDrawHistoryB.endedReason, "threefold_repetition");
  assert.equal(rankedDrawHistoryA.ratingDelta, rankedDrawAccountA.body.account.rating - 1250);
  assert.equal(rankedDrawHistoryB.ratingDelta, rankedDrawAccountB.body.account.rating - 1150);

  const privateDraw = await postJson(`${origin}/api/rooms`, drawA.headers, {
    gameMode: "augment",
    spectatorPolicy: "full",
  });
  assert.equal(privateDraw.status, 201);
  const privateDrawClaim = await postJson(
    `${origin}/api/rooms/${privateDraw.body.code}/claim`,
    drawB.headers,
    {
      inviteToken: privateDraw.body.opponentInviteToken,
      playerToken: randomBytes(32).toString("base64url"),
    },
  );
  assert.equal(privateDrawClaim.status, 200);
  const privateDrawHeadersBySide = { black: drawA.headers, white: drawB.headers };
  const privateDrawPlaying = await startRepetitionRoom(
    origin,
    privateDraw.body.code,
    privateDrawHeadersBySide,
  );
  const privateRepetitionActive = await activateRepetitionAfterSecondDraft(
    origin,
    privateDrawPlaying,
    privateDrawHeadersBySide,
  );
  await playThreefoldCampLoop(origin, privateRepetitionActive, privateDrawHeadersBySide);
  const [privateDrawPlayer, privateDrawSpectator] = await Promise.all([
    requestJson(`${origin}/api/rooms/${privateDraw.body.code}`, { headers: drawA.headers }),
    requestJson(`${origin}/api/rooms/${privateDraw.body.code}`, { headers: stranger.headers }),
  ]);
  for (const response of [privateDrawPlayer, privateDrawSpectator]) {
    assert.equal(response.status, 200);
    assert.equal(response.body.snapshot.winner, null);
    assert.equal(response.body.snapshot.finishReason, "draw");
    assert.equal(response.body.snapshot.drawReason, "threefold_repetition");
    assertNoRepetitionSecrets(response.body.snapshot);
  }
  const [privateDrawAccountA, privateDrawAccountB] = await Promise.all([
    requestJson(`${origin}/api/account`, { headers: drawA.headers }),
    requestJson(`${origin}/api/account`, { headers: drawB.headers }),
  ]);
  assert.equal(privateDrawAccountA.body.account.rating, rankedDrawAccountA.body.account.rating);
  assert.equal(privateDrawAccountB.body.account.rating, rankedDrawAccountB.body.account.rating);
  for (const account of [privateDrawAccountA, privateDrawAccountB]) {
    assert.equal(account.body.account.record.games, 2);
    assert.equal(account.body.account.record.rankedGames, 1);
    assert.equal(account.body.account.record.draws, 2);
    const history = account.body.recentMatches.find(
      (match) => match.id === privateDrawClaim.body.matchId,
    );
    assert.ok(history);
    assert.equal(history.outcome, "draw");
    assert.equal(history.endedReason, "threefold_repetition");
    assert.equal(history.ratingDelta, 0);
  }

  await Promise.all([
    requestJson(`${origin}/api/rooms/${rankedDrawCode}`, { headers: drawA.headers }),
    requestJson(`${origin}/api/rooms/${privateDraw.body.code}`, { headers: drawB.headers }),
  ]);
  const idempotentDrawAccount = await requestJson(`${origin}/api/account`, {
    headers: drawA.headers,
  });
  assert.equal(idempotentDrawAccount.body.account.record.games, 2);
  assert.equal(idempotentDrawAccount.body.account.record.rankedGames, 1);
  assert.equal(idempotentDrawAccount.body.account.record.draws, 2);
  {
    const database = new DatabaseSync(localD1Path());
    try {
      const rankedSettlement = database
        .prepare(
          `SELECT status, winner_user_id, ended_reason, rating_delta_a, rating_delta_b
           FROM platform_matches WHERE id = ?`,
        )
        .get(rankedDrawMatchId);
      assert.equal(rankedSettlement.status, "completed");
      assert.equal(rankedSettlement.winner_user_id, null);
      assert.equal(rankedSettlement.ended_reason, "threefold_repetition");
      assert.notEqual(rankedSettlement.rating_delta_a, 0);
      assert.notEqual(rankedSettlement.rating_delta_b, 0);
    } finally {
      database.close();
    }
  }
});
