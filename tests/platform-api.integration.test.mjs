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
      const response = await fetch(`${origin}/api/account`);
      if (response.status >= 200) return;
    } catch {
      // The server is still starting.
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
  const body = response.status === 204 ? null : await response.json();
  return { status: response.status, body, headers: response.headers };
}

function postJson(url, headers, body = undefined) {
  return requestJson(url, {
    method: "POST",
    headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function joinQueue(origin, headers) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await postJson(`${origin}/api/matchmaking`, headers, { mode: "hex_ranked" });
    if (response.status !== 503) return response;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("matchmaking lock did not become available");
}

function localD1Path() {
  const directory = path.join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  const database = readdirSync(directory).find(
    (name) => name.endsWith(".sqlite") && name !== "metadata.sqlite",
  );
  if (!database) throw new Error("local D1 database was not created");
  return path.join(directory, database);
}

function insertPendingRankedMatch(authSubjectA, authSubjectB, matchId) {
  const database = new DatabaseSync(localD1Path());
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const playerA = database
      .prepare("SELECT id, rating FROM platform_users WHERE auth_user_id = ?")
      .get(authSubjectA);
    const playerB = database
      .prepare("SELECT id, rating FROM platform_users WHERE auth_user_id = ?")
      .get(authSubjectB);
    assert.ok(playerA?.id);
    assert.ok(playerB?.id);
    const now = Date.now();
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(
          `INSERT INTO platform_matches (
             id, mode, ranked, status, player_a_id, player_b_id,
             rating_before_a, rating_before_b, created_at
           ) VALUES (?, 'hex_ranked', 1, 'matched', ?, ?, ?, ?, ?)`,
        )
        .run(matchId, playerA.id, playerB.id, playerA.rating, playerB.rating, now);
      const queue = database.prepare(
        `INSERT INTO matchmaking_queue (
           user_id, ticket, mode, rating, status, match_id, created_at, updated_at
         ) VALUES (?, ?, 'hex_ranked', ?, 'matched', ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           ticket = excluded.ticket, mode = excluded.mode, rating = excluded.rating,
           status = excluded.status, match_id = excluded.match_id,
           created_at = excluded.created_at, updated_at = excluded.updated_at`,
      );
      queue.run(playerA.id, `pending-${matchId}-a`, playerA.rating, matchId, now, now);
      queue.run(playerB.id, `pending-${matchId}-b`, playerB.rating, matchId, now, now);
      const presence = database.prepare(
        `INSERT INTO player_presence (user_id, status, current_match_id, last_heartbeat_at)
         VALUES (?, 'in_game', ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           status = 'in_game', current_match_id = excluded.current_match_id,
           last_heartbeat_at = excluded.last_heartbeat_at`,
      );
      presence.run(playerA.id, matchId, now);
      presence.run(playerB.id, matchId, now);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

test("platform APIs auto-register accounts and support friends, presence, and safe matching", { timeout: 90_000 }, async (t) => {
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

  const unauthorized = await requestJson(`${origin}/api/account`);
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.body.error, "AUTH_REQUIRED");
  const unauthorizedSurfaces = await Promise.all([
    requestJson(`${origin}/api/friends`),
    postJson(`${origin}/api/friends/requests`, {}, { handle: "nobody" }),
    postJson(
      `${origin}/api/friends/requests/00000000-0000-4000-8000-000000000000/accept`,
      {},
    ),
    requestJson(`${origin}/api/friends/matches/00000000-0000-4000-8000-000000000000`),
    requestJson(`${origin}/api/matchmaking`),
    postJson(`${origin}/api/matchmaking`, {}, { mode: "hex_ranked" }),
    requestJson(`${origin}/api/matchmaking`, { method: "DELETE" }),
    requestJson(`${origin}/api/presence`),
    postJson(`${origin}/api/presence`, {}),
  ]);
  assert.deepEqual(
    unauthorizedSurfaces.map((response) => response.status),
    Array(unauthorizedSurfaces.length).fill(401),
  );
  assert.equal(
    unauthorizedSurfaces.every((response) => response.body.error === "AUTH_REQUIRED"),
    true,
  );
  const lookalikeClientHeaders = await requestJson(`${origin}/api/account`, {
    headers: {
      "x-oai-authenticated-user-id": "forged-user",
      "x-oai-authenticated-user-email": "forged@example.com",
    },
  });
  assert.equal(lookalikeClientHeaders.status, 401);
  const partialIdentity = await requestJson(`${origin}/api/account`, {
    headers: { "oai-authenticated-user-id": "partial-forgery" },
  });
  assert.equal(partialIdentity.status, 400);
  assert.equal(partialIdentity.body.error, "INVALID_AUTH_EMAIL");

  const nonce = randomBytes(5).toString("hex");
  const users = ["a", "b", "c"].map((label) => ({
    headers: identityHeaders(`platform-test-${nonce}-${label}`, `${label}.${nonce}@example.com`),
    handle: `${label}棋手${nonce.slice(0, 7)}`,
  }));

  for (const user of users) {
    const created = await requestJson(`${origin}/api/account`, { headers: user.headers });
    assert.equal(created.status, 200);
    assert.equal(created.body.account.email.endsWith("@example.com"), true);
    assert.equal(created.body.account.record.games, 0);
    assert.deepEqual(created.body.recentMatches, []);
    const renamed = await requestJson(`${origin}/api/account`, {
      method: "PATCH",
      headers: { ...user.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ handle: user.handle }),
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.account.handle, user.handle);
  }

  const invalidRename = await requestJson(`${origin}/api/account`, {
    method: "PATCH",
    headers: { ...users[0].headers, "Content-Type": "application/json" },
    body: JSON.stringify({ handle: "bad handle" }),
  });
  assert.equal(invalidRename.status, 400);
  assert.equal(invalidRename.body.error, "INVALID_HANDLE");

  const sent = await postJson(`${origin}/api/friends/requests`, users[0].headers, {
    handle: users[1].handle,
  });
  assert.equal(sent.status, 201);
  const beforeAccept = await requestJson(`${origin}/api/friends`, { headers: users[1].headers });
  assert.equal(beforeAccept.body.incoming.length, 1);
  assert.equal(beforeAccept.body.incoming[0].requestId, sent.body.request.requestId);
  const crossOriginAccept = await requestJson(
    `${origin}/api/friends/requests/${sent.body.request.requestId}/accept`,
    {
      method: "POST",
      headers: {
        ...users[1].headers,
        Origin: origin,
        "Sec-Fetch-Site": "cross-site",
        "Content-Type": "text/plain",
      },
    },
  );
  assert.equal(crossOriginAccept.status, 403);
  assert.deepEqual(crossOriginAccept.body, { error: "CROSS_ORIGIN_REQUEST" });
  const requesterCannotAccept = await postJson(
    `${origin}/api/friends/requests/${sent.body.request.requestId}/accept`,
    users[0].headers,
  );
  assert.equal(requesterCannotAccept.status, 404);
  const unrelatedCannotAccept = await postJson(
    `${origin}/api/friends/requests/${sent.body.request.requestId}/accept`,
    users[2].headers,
  );
  assert.equal(unrelatedCannotAccept.status, 404);
  assert.deepEqual(unrelatedCannotAccept.body, { error: "FRIEND_REQUEST_NOT_FOUND" });
  const accepted = await postJson(
    `${origin}/api/friends/requests/${sent.body.request.requestId}/accept`,
    users[1].headers,
  );
  assert.equal(accepted.status, 200);
  const acceptedRetry = await postJson(
    `${origin}/api/friends/requests/${sent.body.request.requestId}/accept`,
    users[1].headers,
  );
  assert.equal(acceptedRetry.status, 200);
  assert.deepEqual(acceptedRetry.body, accepted.body);

  const heartbeat = await postJson(`${origin}/api/presence`, users[1].headers);
  assert.equal(heartbeat.status, 200);
  assert.equal(heartbeat.body.status, "online");
  const friendList = await requestJson(`${origin}/api/friends`, { headers: users[0].headers });
  assert.equal(friendList.body.friends.length, 1);
  assert.equal(friendList.body.friends[0].player.handle, users[1].handle);
  assert.equal(friendList.body.friends[0].presence, "online");
  assert.equal(JSON.stringify(friendList.body).includes("@example.com"), false);

  const crossOriginQueue = await requestJson(`${origin}/api/matchmaking`, {
    method: "POST",
    headers: {
      ...users[0].headers,
      Origin: origin,
      "Sec-Fetch-Site": "cross-site",
      "Content-Type": "text/plain",
    },
    body: JSON.stringify({ mode: "hex_ranked" }),
  });
  assert.equal(crossOriginQueue.status, 403);
  assert.equal(
    (await requestJson(`${origin}/api/matchmaking`, { headers: users[0].headers })).body.state,
    "idle",
  );

  const pendingMatchId = `pending-${nonce}`;
  insertPendingRankedMatch(
    users[0].headers["oai-authenticated-user-id"],
    users[1].headers["oai-authenticated-user-id"],
    pendingMatchId,
  );
  const pendingCancel = await requestJson(`${origin}/api/matchmaking`, {
    method: "DELETE",
    headers: users[0].headers,
  });
  assert.equal(pendingCancel.status, 200);
  assert.equal(pendingCancel.body.state, "idle");
  assert.equal(
    (await requestJson(`${origin}/api/matchmaking`, { headers: users[1].headers })).body.state,
    "idle",
  );
  {
    const database = new DatabaseSync(localD1Path());
    try {
      const pending = database
        .prepare("SELECT status, ended_reason FROM platform_matches WHERE id = ?")
        .get(pendingMatchId);
      assert.equal(pending.status, "cancelled");
      assert.equal(pending.ended_reason, "setup_cancelled");
    } finally {
      database.close();
    }
  }

  const [firstJoin, secondJoin] = await Promise.all([
    joinQueue(origin, users[0].headers),
    joinQueue(origin, users[1].headers),
  ]);
  assert.ok([200, 202].includes(firstJoin.status));
  assert.ok([200, 202].includes(secondJoin.status));
  const firstStatus = await requestJson(`${origin}/api/matchmaking`, { headers: users[0].headers });
  const secondStatus = await requestJson(`${origin}/api/matchmaking`, { headers: users[1].headers });
  assert.equal(firstStatus.body.state, "matched");
  assert.equal(secondStatus.body.state, "matched");
  assert.equal(firstStatus.body.match.id, secondStatus.body.match.id);
  assert.notEqual(firstStatus.body.match.side, secondStatus.body.match.side);
  assert.equal(firstStatus.body.match.game.status, "ready");
  assert.equal(secondStatus.body.match.game.status, "ready");
  assert.equal(firstStatus.body.match.game.code, secondStatus.body.match.game.code);
  assert.equal(typeof firstStatus.body.match.game.code, "string");
  assert.deepEqual(firstStatus.body.match.rules.timeControl, {
    initialMs: 600_000,
    incrementMs: 5_000,
    incrementThresholdMs: 300_000,
    incrementTiming: "after_legal_move",
    thresholdCheck: "remaining_after_move",
  });
  const friendSpectatorView = await requestJson(
    `${origin}/api/friends/matches/${firstStatus.body.match.id}`,
    { headers: users[2].headers },
  );
  assert.equal(friendSpectatorView.status, 404);
  const secondFriendSpectatorView = await requestJson(
    `${origin}/api/friends/matches/${firstStatus.body.match.id}`,
    { headers: users[0].headers },
  );
  assert.equal(secondFriendSpectatorView.status, 404);
  const spectatorRequest = await postJson(`${origin}/api/friends/requests`, users[2].headers, {
    handle: users[0].handle,
  });
  assert.equal(spectatorRequest.status, 201);
  const spectatorAccepted = await postJson(
    `${origin}/api/friends/requests/${spectatorRequest.body.request.requestId}/accept`,
    users[0].headers,
  );
  assert.equal(spectatorAccepted.status, 200);
  const authorizedSpectatorView = await requestJson(
    `${origin}/api/friends/matches/${firstStatus.body.match.id}`,
    { headers: users[2].headers },
  );
  assert.equal(authorizedSpectatorView.status, 200);
  assert.equal(authorizedSpectatorView.body.visibility, "ranked_redacted_spectators");
  assert.equal(authorizedSpectatorView.body.game.status, "ready");
  assert.equal(authorizedSpectatorView.body.game.code, firstStatus.body.match.game.code);

  const thirdJoin = await joinQueue(origin, users[2].headers);
  assert.equal(thirdJoin.status, 202);
  assert.equal(thirdJoin.body.state, "queued");
  const cancelled = await requestJson(`${origin}/api/matchmaking`, {
    method: "DELETE",
    headers: users[2].headers,
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.state, "idle");
});
