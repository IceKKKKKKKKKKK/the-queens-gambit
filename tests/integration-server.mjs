import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

function childIsAlive(child) {
  return child.exitCode === null && child.signalCode === null;
}

function waitForChildClose(child, timeoutMs) {
  if (!childIsAlive(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(!childIsAlive(child)), timeoutMs);
    child.once("close", onClose);
  });
}

function canBindPort(port) {
  return new Promise((resolve) => {
    const listener = net.createServer();
    listener.unref();
    listener.once("error", () => resolve(false));
    listener.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      listener.close(() => resolve(true));
    });
  });
}

async function waitForPortRelease(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canBindPort(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`owned dev-server port ${port} was not released`);
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

function responsePreview(value, limit = 240) {
  const normalized = String(value).replaceAll(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}…`;
}

function responseDiagnostic(response, text) {
  const contentType = response.headers.get("content-type") ?? "<missing>";
  const kind =
    response.status === 500 && /^\s*<!doctype\s+html\b/i.test(text)
      ? "VITE_HTML_500"
      : /^application\/json\b/i.test(contentType)
        ? "UNEXPECTED_JSON_RESPONSE"
        : "NON_JSON_RESPONSE";
  return `${kind} status=${response.status} content-type=${contentType} bytes=${Buffer.byteLength(text)} body=${JSON.stringify(responsePreview(text))}`;
}

function assertOwnedStatePath(resolvedRoot, statePath) {
  const allowedRoot = path.join(resolvedRoot, ".wrangler", "i");
  const relativeStatePath = path.relative(allowedRoot, statePath);
  if (
    !relativeStatePath ||
    relativeStatePath.startsWith("..") ||
    path.isAbsolute(relativeStatePath)
  ) {
    throw new Error("integration state path must stay inside its owned root");
  }
}

async function waitForJsonApi(origin, server, timeoutMs = 45_000) {
  const { child, logs } = server;
  const deadline = Date.now() + timeoutMs;
  let lastResponse = "no response";
  while (Date.now() < deadline) {
    if (!childIsAlive(child)) {
      throw new Error(`dev server exited early: ${logs.value.slice(-800)}`);
    }
    try {
      const response = await fetch(new URL("/api/account", origin), {
        cache: "no-store",
        headers: {
          "oai-authenticated-user-id": "integration-readiness-probe",
          "oai-authenticated-user-email": "readiness@example.invalid",
        },
      });
      const text = await response.text();
      const contentType = response.headers.get("content-type") ?? "";
      lastResponse = responseDiagnostic(response, text);
      if (response.status === 200 && /^application\/json\b/i.test(contentType)) {
        try {
          const body = JSON.parse(text);
          if (body?.account && typeof body.account === "object") return;
        } catch {
          // A partial JSON response is not a ready API.
        }
      }
    } catch (error) {
      lastResponse = `fetch failed: ${error instanceof Error ? error.message : String(error)}`;
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `JSON API did not become ready; last=${lastResponse}; dev-server-log=${JSON.stringify(responsePreview(logs.value.slice(-1_200), 1_200))}`,
  );
}

async function readJsonResponse(response, { method = "GET", url = response.url, server = null } = {}) {
  if (response.status === 204) return null;
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  const pathname = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return "<invalid-url>";
    }
  })();
  const context = `${String(method).toUpperCase()} ${pathname}`;
  const serverContext = server
    ? ` child-alive=${childIsAlive(server.child)} dev-server-log=${JSON.stringify(responsePreview(server.logs.value.slice(-1_200), 1_200))}`
    : "";
  if (!/^application\/json\b/i.test(contentType)) {
    throw new Error(`Expected JSON for ${context}; ${responseDiagnostic(response, text)}${serverContext}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid JSON for ${context}; status=${response.status} content-type=${contentType} bytes=${Buffer.byteLength(text)} body=${JSON.stringify(responsePreview(text))}; parse=${message};${serverContext}`,
    );
  }
}

function spawnIntegrationServer(root, port, options = {}) {
  if (typeof options === "number") options = { logLimit: options };
  const {
    cleanupState = true,
    logLimit = 8_000,
    persistState = "filesystem",
    statePath: requestedStatePath = null,
  } = options;
  if (persistState !== "filesystem" && persistState !== "memory") {
    throw new Error("integration persistence must be filesystem or memory");
  }
  if (persistState === "memory" && requestedStatePath !== null) {
    throw new Error("memory-backed integration servers cannot receive a state path");
  }
  const resolvedRoot = path.resolve(root);
  const statePath =
    persistState === "filesystem"
      ? requestedStatePath
        ? path.resolve(requestedStatePath)
        : path.join(resolvedRoot, ".wrangler", "i", randomBytes(8).toString("hex"))
      : null;
  if (statePath) assertOwnedStatePath(resolvedRoot, statePath);
  const cliPath = path.join(resolvedRoot, "node_modules", "vinext", "dist", "cli.js");
  const args = [cliPath, "dev", "--host", "127.0.0.1", "--port", String(port)];
  const child = spawn(process.execPath, args, {
    cwd: resolvedRoot,
    // Each integration lane is strictly serial and receives a fresh dynamic
    // loopback port. Vinext's PID-only dev lock is therefore unnecessary and
    // is unsafe under Windows PID reuse after TerminateProcess-style teardown.
    env: {
      ...process.env,
      NO_COLOR: "1",
      VINEXT_NO_DEV_LOCK: "1",
      JUNQI_INTEGRATION_TEST: "1",
      JUNQI_INTEGRATION_PERSIST_STATE: statePath ?? "memory",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    throw new Error("vinext child did not receive a valid PID");
  }
  const logs = { value: "" };
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      logs.value = `${logs.value}${chunk}`.slice(-logLimit);
    });
  }
  const ownership = {
    child,
    pid: child.pid,
    port,
    root: resolvedRoot,
    cliPath,
    args,
  };
  let stopPromise = null;
  let cleanupPromise = null;

  const cleanup = () => {
    if (childIsAlive(child)) {
      throw new Error("refusing to remove integration state while its server child is alive");
    }
    cleanupPromise ??= statePath
      ? rm(statePath, {
          recursive: true,
          force: true,
          maxRetries: 20,
          retryDelay: 100,
        })
      : Promise.resolve();
    return cleanupPromise;
  };

  const stop = () => {
    stopPromise ??= (async () => {
      const expectedSpawnArgs = [process.execPath, ...args];
      if (
        child.spawnfile !== process.execPath ||
        child.spawnargs.length !== expectedSpawnArgs.length ||
        child.spawnargs.some((argument, index) => argument !== expectedSpawnArgs[index])
      ) {
        throw new Error("refusing to terminate a child whose spawn command is not owned by this test");
      }
      if (childIsAlive(child)) {
        child.kill("SIGTERM");
        if (!(await waitForChildClose(child, 3_000)) && childIsAlive(child)) {
          child.kill("SIGKILL");
          await waitForChildClose(child, 5_000);
        }
      }
      if (childIsAlive(child)) {
        throw new Error(`owned dev-server PID ${ownership.pid} did not exit`);
      }
      await waitForPortRelease(port);
      if (cleanupState) await cleanup();
    })();
    return stopPromise;
  };

  return { child, logs, statePath, stop };
}

export {
  canBindPort,
  childIsAlive,
  openPort,
  readJsonResponse,
  spawnIntegrationServer,
  waitForJsonApi,
};
