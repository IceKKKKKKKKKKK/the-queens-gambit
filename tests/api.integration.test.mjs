import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function opaqueToken() {
  return randomBytes(32).toString("base64url");
}

function uniqueTestIp() {
  const words = Array.from({ length: 6 }, () => randomBytes(2).toString("hex"));
  return `2001:db8:${words.join(":")}`;
}

async function openPort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      listener.close(() => resolve(address.port));
    });
  });
}

async function waitForServer(origin, child, logs) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dev server exited early: ${logs.value.slice(-600)}`);
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`dev server did not start: ${logs.value.slice(-600)}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const body = response.status === 204 ? null : await response.json();
  return { status: response.status, body };
}

function postJson(url, body, headers = {}) {
  return requestJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function postRaw(url, body, headers = {}) {
  return requestJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

function postAction(origin, code, token, expectedVersion, action) {
  return postJson(
    `${origin}/api/rooms/${code}/actions`,
    { expectedVersion, action },
    { Authorization: `Bearer ${token}` },
  );
}

function createRoom(origin) {
  return requestJson(`${origin}/api/rooms`, {
    method: "POST",
    headers: { "CF-Connecting-IP": uniqueTestIp() },
  });
}

function ownLayout(snapshot, side) {
  return snapshot.pieces
    .filter((piece) => piece.side === side)
    .map(({ id, type, row, col, alive }) => ({ id, type, row, col, alive }))
    .sort((first, second) => first.id.localeCompare(second.id));
}

test("room API preserves hidden information, identity, concurrency, and limits", { timeout: 90_000 }, async (t) => {
  const port = await openPort();
  const origin = `http://localhost:${port}`;
  const logs = { value: "" };
  const child = spawn(
    process.execPath,
    [path.join(root, "node_modules", "vinext", "dist", "cli.js"), "dev", "--host", "127.0.0.1", "--port", String(port)],
    { cwd: root, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      logs.value = `${logs.value}${chunk}`.slice(-4_000);
    });
  }
  t.after(() => stopServer(child));
  await waitForServer(origin, child, logs);

  const create = await createRoom(origin);
  assert.equal(create.status, 201);
  const { code, playerToken: blackToken, opponentInviteToken: inviteToken } = create.body;

  const spectator = await requestJson(`${origin}/api/rooms/${code}`);
  assert.equal(spectator.status, 200);
  assert.equal(spectator.body.viewer, "spectator");
  assert.equal(spectator.body.snapshot.pieces.some((piece) => piece.type), false);

  const black = await requestJson(`${origin}/api/rooms/${code}`, {
    headers: { Authorization: `Bearer ${blackToken}` },
  });
  assert.equal(black.status, 200);
  assert.equal(black.body.snapshot.pieces.filter((piece) => piece.side === "black" && piece.type).length, 25);
  assert.equal(black.body.snapshot.pieces.filter((piece) => piece.side === "white" && piece.type).length, 0);

  const blackTokenClaim = await postJson(`${origin}/api/rooms/${code}/claim`, {
    inviteToken,
    playerToken: blackToken,
  });
  assert.equal(blackTokenClaim.status, 409);
  assert.equal(blackTokenClaim.body.error, "TOKEN_ALREADY_IN_USE");
  const afterBlackTokenClaim = await requestJson(`${origin}/api/rooms/${code}`, {
    headers: { Authorization: `Bearer ${blackToken}` },
  });
  assert.equal(afterBlackTokenClaim.status, 200);
  assert.equal(afterBlackTokenClaim.body.version, black.body.version);
  assert.equal(afterBlackTokenClaim.body.snapshot.joined.white, false);
  assert.deepEqual(ownLayout(afterBlackTokenClaim.body.snapshot, "black"), ownLayout(black.body.snapshot, "black"));

  const inviteAsBearer = await requestJson(`${origin}/api/rooms/${code}`, {
    headers: { Authorization: `Bearer ${inviteToken}` },
  });
  assert.equal(inviteAsBearer.status, 401);
  const selfClaim = await postJson(`${origin}/api/rooms/${code}/claim`, {
    inviteToken,
    playerToken: inviteToken,
  });
  assert.equal(selfClaim.status, 400);
  assert.equal(
    (await requestJson(`${origin}/api/rooms/${code}`, { headers: { Authorization: `Bearer ${inviteToken}` } })).status,
    401,
  );

  const candidates = [opaqueToken(), opaqueToken()];
  const claims = await Promise.all(
    candidates.map((playerToken) => postJson(`${origin}/api/rooms/${code}/claim`, { inviteToken, playerToken })),
  );
  assert.deepEqual(claims.map(({ status }) => status).sort(), [200, 409]);
  const winnerIndex = claims.findIndex(({ status }) => status === 200);
  const winnerToken = candidates[winnerIndex];
  const winnerVersion = claims[winnerIndex].body.version;
  const retry = await postJson(`${origin}/api/rooms/${code}/claim`, { inviteToken, playerToken: winnerToken });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.version, winnerVersion);
  const loserRetry = await postJson(`${origin}/api/rooms/${code}/claim`, {
    inviteToken,
    playerToken: candidates[1 - winnerIndex],
  });
  assert.equal(loserRetry.status, 409);
  const blackAfterClaim = await requestJson(`${origin}/api/rooms/${code}`, {
    headers: { Authorization: `Bearer ${blackToken}` },
  });
  const blackPayload = JSON.stringify(blackAfterClaim.body);
  assert.equal(blackPayload.includes(inviteToken), false);
  assert.equal(blackPayload.includes(candidates[0]), false);
  assert.equal(blackPayload.includes(candidates[1]), false);

  const validationRoom = await createRoom(origin);
  assert.equal(validationRoom.status, 201);
  const validationCode = validationRoom.body.code;
  const validationToken = validationRoom.body.playerToken;
  const validationInvite = validationRoom.body.opponentInviteToken;
  const validationActionUrl = `${origin}/api/rooms/${validationCode}/actions`;
  const validationAuth = { Authorization: `Bearer ${validationToken}` };

  for (const body of ["null", "[]"]) {
    const invalidBody = await postRaw(validationActionUrl, body, validationAuth);
    assert.equal(invalidBody.status, 400);
    assert.equal(invalidBody.body.error, "INVALID_REQUEST");
  }
  const oversizedAction = await postRaw(
    validationActionUrl,
    JSON.stringify({ padding: "x".repeat(9_000) }),
    validationAuth,
  );
  assert.equal(oversizedAction.status, 413);
  assert.equal(oversizedAction.body.error, "REQUEST_TOO_LARGE");
  const oversizedUtf8Action = await postRaw(
    validationActionUrl,
    JSON.stringify({ padding: "军".repeat(3_000) }),
    validationAuth,
  );
  assert.equal(oversizedUtf8Action.status, 413);
  assert.equal(oversizedUtf8Action.body.error, "REQUEST_TOO_LARGE");
  const chunkedBytes = new TextEncoder().encode(JSON.stringify({ padding: "x".repeat(9_000) }));
  let chunkOffset = 0;
  const chunkedBody = new ReadableStream({
    pull(controller) {
      if (chunkOffset >= chunkedBytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunkedBytes.slice(chunkOffset, chunkOffset + 512));
      chunkOffset += 512;
    },
  });
  const oversizedChunkedAction = await requestJson(validationActionUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...validationAuth },
    body: chunkedBody,
    duplex: "half",
  });
  assert.equal(oversizedChunkedAction.status, 413);
  assert.equal(oversizedChunkedAction.body.error, "REQUEST_TOO_LARGE");
  for (const body of ["null", "[]"]) {
    const invalidClaimBody = await postRaw(`${origin}/api/rooms/${validationCode}/claim`, body);
    assert.equal(invalidClaimBody.status, 400);
  }
  const oversizedClaim = await postRaw(
    `${origin}/api/rooms/${validationCode}/claim`,
    JSON.stringify({ inviteToken: validationInvite, playerToken: "x".repeat(9_000) }),
  );
  assert.equal(oversizedClaim.status, 413);
  assert.equal(oversizedClaim.body.error, "REQUEST_TOO_LARGE");

  const unsupportedJoin = await postAction(origin, validationCode, validationToken, 0, { type: "join" });
  assert.equal(unsupportedJoin.status, 400);
  assert.equal(unsupportedJoin.body.error, "INVALID_REQUEST");
  const redundantUnready = await postAction(origin, validationCode, validationToken, 0, {
    type: "ready",
    value: false,
  });
  assert.equal(redundantUnready.status, 422);
  assert.equal(redundantUnready.body.error, "NO_STATE_CHANGE");

  const initialBlackPieces = validationRoom.body.snapshot.pieces.filter(
    (piece) => piece.side === "black" && piece.alive,
  );
  const flag = initialBlackPieces.find((piece) => piece.type === "flag");
  const mine = initialBlackPieces.find((piece) => piece.type === "mine");
  const bomb = initialBlackPieces.find((piece) => piece.type === "bomb");
  const frontPiece = initialBlackPieces.find((piece) => piece.row === 6);
  assert.ok(flag && mine && bomb && frontPiece);
  const submittedLayout = initialBlackPieces.map(({ id, row, col }) => ({ pieceId: id, row, col }));

  const malformedLayout = await postAction(origin, validationCode, validationToken, 0, {
    type: "ready",
    value: true,
    layout: [{ pieceId: "invalid!", row: 6, col: 0 }],
  });
  assert.equal(malformedLayout.status, 400);
  assert.equal(malformedLayout.body.error, "INVALID_REQUEST");
  const incompleteLayout = await postAction(origin, validationCode, validationToken, 0, {
    type: "ready",
    value: true,
    layout: submittedLayout.slice(0, 24),
  });
  assert.equal(incompleteLayout.status, 422);
  assert.equal(incompleteLayout.body.error, "INCOMPLETE_LAYOUT");

  const samePositionSwap = await postAction(origin, validationCode, validationToken, 0, {
    type: "swap",
    from: { row: frontPiece.row, col: frontPiece.col },
    to: { row: frontPiece.row, col: frontPiece.col },
  });
  assert.equal(samePositionSwap.status, 422);
  assert.equal(samePositionSwap.body.error, "SAME_POSITION");
  for (const [piece, error] of [
    [flag, "FLAG_MUST_BE_HEADQUARTERS"],
    [mine, "MINE_BACK_TWO_ROWS"],
    [bomb, "BOMB_NOT_FRONT_ROW"],
  ]) {
    const invalidSwap = await postAction(origin, validationCode, validationToken, 0, {
      type: "swap",
      from: { row: piece.row, col: piece.col },
      to: { row: frontPiece.row, col: frontPiece.col },
    });
    assert.equal(invalidSwap.status, 422);
    assert.equal(invalidSwap.body.error, error);
  }
  const moveBeforeStart = await postAction(origin, validationCode, validationToken, 0, {
    type: "move",
    from: { row: frontPiece.row, col: frontPiece.col },
    to: { row: 5, col: frontPiece.col },
  });
  assert.equal(moveBeforeStart.status, 422);
  assert.equal(moveBeforeStart.body.error, "GAME_NOT_STARTED");

  const firstReady = await postAction(origin, validationCode, validationToken, 0, {
    type: "ready",
    value: true,
    layout: submittedLayout,
  });
  assert.equal(firstReady.status, 200);
  assert.equal(firstReady.body.version, 1);
  const duplicateReady = await postAction(origin, validationCode, validationToken, 1, {
    type: "ready",
    value: true,
  });
  assert.equal(duplicateReady.status, 422);
  assert.equal(duplicateReady.body.error, "NO_STATE_CHANGE");
  const validationAfterRejects = await requestJson(`${origin}/api/rooms/${validationCode}`, {
    headers: validationAuth,
  });
  assert.equal(validationAfterRejects.body.version, 1);
  assert.equal(validationAfterRejects.body.snapshot.events.filter((event) => event.result === "ready").length, 1);

  const raceRoom = await requestJson(`${origin}/api/rooms`, {
    method: "POST",
    headers: { "CF-Connecting-IP": uniqueTestIp() },
  });
  assert.equal(raceRoom.status, 201);
  const raceCandidate = opaqueToken();
  let [actionResult, claimResult] = await Promise.all([
    postJson(
      `${origin}/api/rooms/${raceRoom.body.code}/actions`,
      { expectedVersion: 0, action: { type: "randomize" } },
      { Authorization: `Bearer ${raceRoom.body.playerToken}` },
    ),
    postJson(`${origin}/api/rooms/${raceRoom.body.code}/claim`, {
      inviteToken: raceRoom.body.opponentInviteToken,
      playerToken: raceCandidate,
    }),
  ]);
  if (actionResult.status === 409) {
    const latest = await requestJson(`${origin}/api/rooms/${raceRoom.body.code}`, {
      headers: { Authorization: `Bearer ${raceRoom.body.playerToken}` },
    });
    actionResult = await postJson(
      `${origin}/api/rooms/${raceRoom.body.code}/actions`,
      { expectedVersion: latest.body.version, action: { type: "randomize" } },
      { Authorization: `Bearer ${raceRoom.body.playerToken}` },
    );
  }
  if (claimResult.status === 409) {
    claimResult = await postJson(`${origin}/api/rooms/${raceRoom.body.code}/claim`, {
      inviteToken: raceRoom.body.opponentInviteToken,
      playerToken: raceCandidate,
    });
  }
  assert.equal(actionResult.status, 200);
  assert.equal(claimResult.status, 200);
  const raceFinal = await requestJson(`${origin}/api/rooms/${raceRoom.body.code}`, {
    headers: { Authorization: `Bearer ${raceRoom.body.playerToken}` },
  });
  assert.equal(raceFinal.body.version, 2);
  assert.equal(raceFinal.body.snapshot.joined.white, true);
  assert.deepEqual(ownLayout(raceFinal.body.snapshot, "black"), ownLayout(actionResult.body.snapshot, "black"));
  assert.equal(
    (await requestJson(`${origin}/api/rooms/${raceRoom.body.code}?since=2`)).status,
    204,
  );

  const actionRaceRoom = await createRoom(origin);
  assert.equal(actionRaceRoom.status, 201);
  const concurrentActions = await Promise.all([
    postAction(origin, actionRaceRoom.body.code, actionRaceRoom.body.playerToken, 0, { type: "randomize" }),
    postAction(origin, actionRaceRoom.body.code, actionRaceRoom.body.playerToken, 0, { type: "randomize" }),
  ]);
  assert.deepEqual(concurrentActions.map(({ status }) => status).sort(), [200, 409]);
  const winningAction = concurrentActions.find(({ status }) => status === 200);
  const conflictingAction = concurrentActions.find(({ status }) => status === 409);
  assert.equal(conflictingAction.body.error, "VERSION_CONFLICT");
  const actionRaceFinal = await requestJson(`${origin}/api/rooms/${actionRaceRoom.body.code}`, {
    headers: { Authorization: `Bearer ${actionRaceRoom.body.playerToken}` },
  });
  assert.equal(actionRaceFinal.body.version, 1);
  assert.deepEqual(
    ownLayout(actionRaceFinal.body.snapshot, "black"),
    ownLayout(winningAction.body.snapshot, "black"),
  );

  const ruleRoom = await createRoom(origin);
  assert.equal(ruleRoom.status, 201);
  const ruleWhiteToken = opaqueToken();
  const ruleClaim = await postJson(`${origin}/api/rooms/${ruleRoom.body.code}/claim`, {
    inviteToken: ruleRoom.body.opponentInviteToken,
    playerToken: ruleWhiteToken,
  });
  assert.equal(ruleClaim.status, 200);
  const ruleBlackReady = await postAction(
    origin,
    ruleRoom.body.code,
    ruleRoom.body.playerToken,
    ruleClaim.body.version,
    { type: "ready", value: true },
  );
  assert.equal(ruleBlackReady.status, 200);
  const ruleWhiteReady = await postAction(
    origin,
    ruleRoom.body.code,
    ruleWhiteToken,
    ruleBlackReady.body.version,
    { type: "ready", value: true },
  );
  assert.equal(ruleWhiteReady.status, 200);
  assert.equal(ruleWhiteReady.body.snapshot.phase, "playing");

  const activeSide = ruleWhiteReady.body.snapshot.turn;
  const inactiveSide = activeSide === "black" ? "white" : "black";
  const activeToken = activeSide === "black" ? ruleRoom.body.playerToken : ruleWhiteToken;
  const inactiveToken = inactiveSide === "black" ? ruleRoom.body.playerToken : ruleWhiteToken;
  const activeView = await requestJson(`${origin}/api/rooms/${ruleRoom.body.code}`, {
    headers: { Authorization: `Bearer ${activeToken}` },
  });
  const activePieces = activeView.body.snapshot.pieces.filter(
    (piece) => piece.alive && piece.side === activeSide,
  );
  const inactivePiece = activeView.body.snapshot.pieces.find(
    (piece) => piece.alive && piece.side === inactiveSide,
  );
  const activeFlag = activePieces.find((piece) => piece.type === "flag");
  const activeMine = activePieces.find((piece) => piece.type === "mine");
  const activeMovable = activePieces.find(
    (piece) =>
      piece.type !== "flag" &&
      piece.type !== "mine" &&
      !([0, 11].includes(piece.row) && [1, 3].includes(piece.col)),
  );
  const alliedTarget = activePieces.find((piece) => piece.id !== activeMovable?.id);
  assert.ok(inactivePiece && activeFlag && activeMine && activeMovable && alliedTarget);
  const playingVersion = activeView.body.version;

  const outOfTurn = await postAction(origin, ruleRoom.body.code, inactiveToken, playingVersion, {
    type: "move",
    from: { row: inactivePiece.row, col: inactivePiece.col },
    to: { row: activeFlag.row, col: activeFlag.col },
  });
  assert.equal(outOfTurn.status, 422);
  assert.equal(outOfTurn.body.error, "NOT_YOUR_TURN");
  const playingViolations = [
    [{ row: -1, col: 0 }, { row: 0, col: 0 }, "POSITION_OUT_OF_BOUNDS"],
    [{ row: activeFlag.row, col: activeFlag.col }, { row: 5, col: 2 }, "FLAG_CANNOT_MOVE"],
    [{ row: activeMine.row, col: activeMine.col }, { row: 5, col: 2 }, "MINE_CANNOT_MOVE"],
    [{ row: 2, col: 1 }, { row: 2, col: 2 }, "NO_PIECE_AT_SOURCE"],
    [
      { row: inactivePiece.row, col: inactivePiece.col },
      { row: activeFlag.row, col: activeFlag.col },
      "NOT_YOUR_PIECE",
    ],
    [
      { row: activeMovable.row, col: activeMovable.col },
      { row: alliedTarget.row, col: alliedTarget.col },
      "DESTINATION_OCCUPIED_BY_ALLY",
    ],
  ];
  for (const [from, to, error] of playingViolations) {
    const rejected = await postAction(origin, ruleRoom.body.code, activeToken, playingVersion, {
      type: "move",
      from,
      to,
    });
    assert.equal(rejected.status, 422);
    assert.equal(rejected.body.error, error);
  }
  const ruleAfterRejects = await requestJson(`${origin}/api/rooms/${ruleRoom.body.code}`, {
    headers: { Authorization: `Bearer ${activeToken}` },
  });
  assert.equal(ruleAfterRejects.body.version, playingVersion);

  const rateKey = uniqueTestIp();
  const rateStatuses = [];
  for (let attempt = 0; attempt < 21; attempt += 1) {
    rateStatuses.push(
      (await requestJson(`${origin}/api/rooms`, { method: "POST", headers: { "CF-Connecting-IP": rateKey } })).status,
    );
  }
  assert.equal(rateStatuses.filter((status) => status === 201).length, 20);
  assert.equal(rateStatuses.at(-1), 429);
});
