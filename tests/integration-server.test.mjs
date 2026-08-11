import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
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

function runningServer(log = "") {
  return {
    child: { exitCode: null, signalCode: null },
    logs: { value: log },
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
    await waitForJsonApi(origin, runningServer(), 1_000);
  });
  assert.equal(requests, 3);
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
        server: runningServer("Internal Server Error from Vite"),
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

test("an explicitly shared integration state survives one server restart and is then removed", { timeout: 60_000 }, async () => {
  const nonce = randomBytes(6).toString("hex");
  const identity = {
    "oai-authenticated-user-id": `restart-host-${nonce}`,
    "oai-authenticated-user-email": `restart.${nonce}@example.invalid`,
  };
  let firstServer = null;
  let secondServer = null;
  let statePath = null;
  try {
    const firstPort = await openPort();
    const firstOrigin = `http://localhost:${firstPort}`;
    firstServer = spawnIntegrationServer(root, firstPort, { cleanupState: false });
    statePath = firstServer.statePath;
    assert.ok(statePath);
    await waitForJsonApi(firstOrigin, firstServer);
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
    assert.equal(existsSync(statePath), true);

    const secondPort = await openPort();
    const secondOrigin = `http://localhost:${secondPort}`;
    secondServer = spawnIntegrationServer(root, secondPort, { statePath });
    await waitForJsonApi(secondOrigin, secondServer);
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
      await secondServer?.stop();
    } finally {
      await firstServer?.stop();
    }
  }
});
