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
  const deadline = Date.now() + 20_000;
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

function ownLayout(snapshot, side) {
  return snapshot.pieces
    .filter((piece) => piece.side === side)
    .map(({ id, type, row, col, alive }) => ({ id, type, row, col, alive }))
    .sort((first, second) => first.id.localeCompare(second.id));
}

test("room API preserves hidden information, identity, concurrency, and limits", { timeout: 60_000 }, async (t) => {
  let origin = "http://localhost:3000";
  let useExistingServer = false;
  try {
    const existing = await fetch(origin);
    useExistingServer = existing.ok && (await existing.text()).includes("The Queen&#x27;s Gambit");
  } catch {
    // Start an isolated server below.
  }
  const logs = { value: "" };
  if (!useExistingServer) {
    const port = await openPort();
    origin = `http://localhost:${port}`;
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
  }

  const create = await requestJson(`${origin}/api/rooms`, {
    method: "POST",
    headers: { "CF-Connecting-IP": uniqueTestIp() },
  });
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
