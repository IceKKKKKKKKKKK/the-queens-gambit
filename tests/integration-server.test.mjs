import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  canBindPort,
  childIsAlive,
  INTEGRATION_LISTENING_MESSAGE,
  isOwnedListeningMessage,
  openPort,
  readJsonResponse,
  spawnIntegrationServer,
  waitForJsonApi,
} from "./integration-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function withHttpServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function runningServer(actualPort, log = "", requestedPort = actualPort) {
  return {
    child: { pid: 4242, exitCode: null, signalCode: null },
    logs: { value: log },
    actualPort,
    requestedPort,
  };
}

test("JSON readiness ignores HTML errors until the authenticated API sentinel succeeds", async () => {
  let requests = 0;
  await withHttpServer((request, response) => {
    assert.equal(request.url, "/api/account");
    requests += 1;
    if (requests < 3) {
      response.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      response.end("\n<!DOCTYPE html><title>Vite error</title>");
      return;
    }
    assert.equal(request.headers["oai-authenticated-user-id"], "integration-readiness-probe");
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ account: { handle: "ready" } }));
  }, async (origin) => {
    const server = runningServer(null);
    const readiness = waitForJsonApi(server, 1_000);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(requests, 0);
    server.actualPort = Number(new URL(origin).port);
    assert.equal(await readiness, origin);
  });
  assert.equal(requests, 3);

  const stalledPort = await openPort();
  await assert.rejects(
    waitForJsonApi(runningServer(stalledPort, "startup stalled before listening"), 20),
    (error) => {
      assert.match(error.message, /elapsed-ms=\d+/);
      assert.match(error.message, /child-alive=true/);
      assert.match(error.message, /pid=4242/);
      assert.match(error.message, new RegExp(`actual-port=${stalledPort}`));
      assert.match(error.message, /actual-port-bindable=true/);
      assert.match(error.message, /startup stalled before listening/);
      return true;
    },
  );
});

test("non-JSON API responses fail once with request and dev-server evidence", async () => {
  let requests = 0;
  await withHttpServer((_request, response) => {
    requests += 1;
    response.writeHead(500);
    response.end("\n<!DOCTYPE html><title>Internal Server Error</title>");
  }, async (origin) => {
    const url = `${origin}/api/rooms?secret=must-not-appear`;
    const response = await fetch(url, { method: "POST" });
    await assert.rejects(
      readJsonResponse(response, {
        method: "POST",
        url,
        server: runningServer(null, "Internal Server Error from Vite"),
      }),
      (error) => {
        assert.match(error.message, /POST \/api\/rooms/);
        assert.match(error.message, /VITE_HTML_500/);
        assert.match(error.message, /status=500/);
        assert.match(error.message, /content-type=<missing>/);
        assert.match(error.message, /Internal Server Error from Vite/);
        assert.doesNotMatch(error.message, /must-not-appear/);
        return true;
      },
    );
  });
  assert.equal(requests, 1);
});

test("JSON response parsing preserves ordinary error bodies and handles empty success", async () => {
  const denied = new Response(JSON.stringify({ error: "AUTH_REQUIRED" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
  assert.deepEqual(
    await readJsonResponse(denied, { method: "GET", url: "http://local/api/account" }),
    { error: "AUTH_REQUIRED" },
  );
  const empty = new Response(null, { status: 204 });
  assert.equal(
    await readJsonResponse(empty, { method: "DELETE", url: "http://local/api/matchmaking" }),
    null,
  );
});

test("an explicitly shared integration state survives one server restart and is then removed", { timeout: 210_000 }, async () => {
  const nonce = randomBytes(6).toString("hex");
  const identity = {
    "oai-authenticated-user-id": `restart-host-${nonce}`,
    "oai-authenticated-user-email": `restart.${nonce}@example.invalid`,
  };
  let firstServer = null;
  let secondServer = null;
  let blocker = null;
  let statePath = null;
  try {
    let blockerRequests = 0;
    blocker = http.createServer((_request, response) => {
      blockerRequests += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ account: { handle: "not-the-owned-server" } }));
    });
    await new Promise((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", resolve);
    });
    const blockerAddress = blocker.address();
    assert.ok(blockerAddress && typeof blockerAddress === "object");
    const firstPort = blockerAddress.port;
    firstServer = spawnIntegrationServer(root, firstPort, { cleanupState: false });
    statePath = firstServer.statePath;
    assert.ok(statePath);
    assert.match(firstServer.nonce, /^[0-9a-f]{32}$/);
    assert.deepEqual(firstServer.args.slice(1), [
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(firstPort),
    ]);
    assert.equal(firstServer.args.includes("--host"), false);
    assert.equal(
      isOwnedListeningMessage(
        {
          type: INTEGRATION_LISTENING_MESSAGE,
          nonce: `${firstServer.nonce}bad`,
          pid: firstServer.child.pid,
          port: firstPort,
        },
        firstServer,
      ),
      false,
    );
    for (const invalidPort of [0, 65_536, 1.5, "56406"]) {
      assert.equal(
        isOwnedListeningMessage(
          {
            type: INTEGRATION_LISTENING_MESSAGE,
            nonce: firstServer.nonce,
            pid: firstServer.child.pid,
            port: invalidPort,
          },
          firstServer,
        ),
        false,
      );
    }
    assert.equal(
      isOwnedListeningMessage(
        {
          type: INTEGRATION_LISTENING_MESSAGE,
          nonce: firstServer.nonce,
          pid: firstServer.child.pid + 1,
          port: firstPort,
        },
        firstServer,
      ),
      false,
    );
    const firstOrigin = await waitForJsonApi(firstServer);
    assert.equal(blockerRequests, 0);
    assert.notEqual(firstServer.actualPort, firstPort);
    assert.equal(firstOrigin, `http://127.0.0.1:${firstServer.actualPort}`);
    const createdResponse = await fetch(`${firstOrigin}/api/rooms`, {
      method: "POST",
      headers: { ...identity, "Content-Type": "application/json" },
      body: JSON.stringify({ gameMode: "classic", spectatorPolicy: "hidden" }),
    });
    const created = await readJsonResponse(createdResponse, {
      method: "POST",
      url: `${firstOrigin}/api/rooms`,
      server: firstServer,
    });
    assert.equal(createdResponse.status, 201);
    assert.ok(created.code);
    assert.ok(created.playerToken);
    await firstServer.stop();
    assert.equal(await canBindPort(firstServer.actualPort), true);
    assert.equal(blocker.listening, true);
    assert.equal(await canBindPort(firstPort), false);
    assert.equal(blockerRequests, 0);
    assert.equal(existsSync(statePath), true);

    await new Promise((resolve, reject) => {
      blocker.close((error) => (error ? reject(error) : resolve()));
    });
    blocker = null;

    const secondPort = await openPort();
    secondServer = spawnIntegrationServer(root, secondPort, { statePath });
    const secondOrigin = await waitForJsonApi(secondServer);
    const recoveredResponse = await fetch(`${secondOrigin}/api/rooms/${created.code}`, {
      headers: { ...identity, Authorization: `Bearer ${created.playerToken}` },
    });
    const recovered = await readJsonResponse(recoveredResponse, {
      method: "GET",
      url: `${secondOrigin}/api/rooms/${created.code}`,
      server: secondServer,
    });
    assert.equal(recoveredResponse.status, 200);
    assert.equal(recovered.code, created.code);
    assert.equal(recovered.viewer, "black");
    await secondServer.stop();
    assert.equal(existsSync(statePath), false);
  } finally {
    try {
      if (secondServer) {
        await secondServer.stop();
      }
    } finally {
      try {
        if (firstServer) {
          await firstServer.stop();
        }
      } finally {
        try {
          if (blocker?.listening) {
            await new Promise((resolve) => blocker.close(resolve));
          }
        } finally {
          const allServersExited =
            (!firstServer || !childIsAlive(firstServer.child)) &&
            (!secondServer || !childIsAlive(secondServer.child));
          if (firstServer && allServersExited) {
            await firstServer.cleanup();
          }
        }
      }
    }
  }
});
