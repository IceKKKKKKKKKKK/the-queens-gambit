import { spawn } from "node:child_process";
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

async function waitForServer(origin, child, logs, pathname = "/", timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!childIsAlive(child)) {
      throw new Error(`dev server exited early: ${logs.value.slice(-800)}`);
    }
    try {
      const response = await fetch(new URL(pathname, origin));
      if (response.status >= 200) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`dev server did not start: ${logs.value.slice(-800)}`);
}

function spawnIntegrationServer(root, port, logLimit = 8_000) {
  const resolvedRoot = path.resolve(root);
  const cliPath = path.join(resolvedRoot, "node_modules", "vinext", "dist", "cli.js");
  const args = [cliPath, "dev", "--host", "127.0.0.1", "--port", String(port)];
  const child = spawn(process.execPath, args, {
    cwd: resolvedRoot,
    // Each integration lane is strictly serial and receives a fresh dynamic
    // loopback port. Vinext's PID-only dev lock is therefore unnecessary and
    // is unsafe under Windows PID reuse after TerminateProcess-style teardown.
    env: { ...process.env, NO_COLOR: "1", VINEXT_NO_DEV_LOCK: "1" },
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
    })();
    return stopPromise;
  };

  return { child, logs, stop };
}

export { canBindPort, childIsAlive, openPort, spawnIntegrationServer, waitForServer };
