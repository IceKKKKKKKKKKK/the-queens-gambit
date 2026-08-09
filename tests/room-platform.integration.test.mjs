import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
    if (child.exitCode !== null) throw new Error(`dev server exited early: ${logs.value.slice(-800)}`);
    try {
      if ((await fetch(`${origin}/api/account`)).status >= 200) return;
    } catch {
      // The dev server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`dev server did not start: ${logs.value.slice(-800)}`);
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
    body: response.status === 204 ? null : await response.json(),
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
  const directory = path.join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  const database = readdirSync(directory).find(
    (name) => name.endsWith(".sqlite") && name !== "metadata.sqlite",
  );
  if (!database) throw new Error("local D1 database was not created");
  return path.join(directory, database);
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

test("authenticated rooms, identity seats, spectator policy, provisioning, and settlement", { timeout: 120_000 }, async (t) => {
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
      logs.value = `${logs.value}${chunk}`.slice(-8_000);
    });
  }
  t.after(() => stopServer(child));
  await waitForServer(origin, child, logs);

  assert.equal((await requestJson(`${origin}/api/rooms`, { method: "POST" })).status, 401);

  const nonce = randomBytes(6).toString("hex");
  const [userA, userB, friend, stranger] = ["a", "b", "friend", "stranger"].map((label) => ({
    headers: identityHeaders(`room-platform-${nonce}-${label}`, `${label}.${nonce}@example.com`),
    handle: `${label}${nonce.slice(0, 8)}`,
  }));
  for (const user of [userA, userB, friend, stranger]) {
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
  const privateFinish = await postAction(origin, code, userA.headers, version, { type: "resign" });
  assert.equal(privateFinish.status, 200);
  assert.equal(privateFinish.body.snapshot.phase, "finished");
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
  assert.equal(hiddenSpectator.body.snapshot.rulesVersion, "augment-duel-dark-v1");
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
        (id) => id !== "spade-total-intelligence" && id !== "heart-targeted-recon",
      ),
      white: claimedRoom.body.snapshot.augment.draft.rounds[0].players.white.options.find(
        (id) => id !== "spade-total-intelligence" && id !== "heart-targeted-recon",
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
  const rankedCode = statusA.body.match.game.code;

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

  const bySide = {
    [rankedA.body.viewer]: { headers: userA.headers, view: rankedA },
    [rankedB.body.viewer]: { headers: userB.headers, view: rankedB },
  };
  version = Math.max(rankedA.body.version, rankedB.body.version);
  for (const side of ["black", "white"]) {
    const player = bySide[side];
    const ownRound = player.view.body.snapshot.augment.draft.rounds[0].players[side];
    const selected = await postAction(origin, rankedCode, player.headers, version, {
      type: "augment_select",
      augmentId: ownRound.options[0],
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
  const rankedFinish = await postAction(
    origin,
    rankedCode,
    bySide.black.headers,
    version,
    { type: "resign" },
  );
  assert.equal(rankedFinish.status, 200);
  assert.equal(rankedFinish.body.snapshot.phase, "finished");

  await Promise.all([
    requestJson(`${origin}/api/rooms/${rankedCode}`, { headers: userA.headers }),
    requestJson(`${origin}/api/rooms/${rankedCode}`, { headers: userB.headers }),
    requestJson(`${origin}/api/rooms/${rankedCode}`, { headers: friend.headers }),
  ]);
  const [accountA, accountB] = await Promise.all([
    requestJson(`${origin}/api/account`, { headers: userA.headers }),
    requestJson(`${origin}/api/account`, { headers: userB.headers }),
  ]);
  assert.equal(accountA.body.account.record.rankedGames, 1);
  assert.equal(accountB.body.account.record.rankedGames, 1);
  assert.notEqual(accountA.body.account.rating, 1200);
  assert.notEqual(accountB.body.account.rating, 1200);
});
