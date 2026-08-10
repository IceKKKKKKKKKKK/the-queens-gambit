import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { appendFile, cp, mkdir, readdir, symlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { finished } from "node:stream/promises";

import {
  WorkerJournal,
  emptyCounters,
  parseWorkerArguments,
  stopWasRequested,
  timeEvidence,
  totalFailures,
  type TimeEvidence,
} from "./common.ts";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SUITES = [
  "tests/api.integration.test.mjs",
  "tests/platform-api.integration.test.mjs",
  "tests/room-platform.integration.test.mjs",
] as const;

interface ApiInvocationEvidence {
  segmentId: string;
  cycle: number;
  suite: string;
  startedAt: TimeEvidence;
  finishedAt: TimeEvidence;
  durationMs: number;
  pid: number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  tests: number | null;
  passed: number | null;
  failed: number | null;
  workspace: string;
  logPath: string;
}

interface ApiWorkerState {
  cycle: number;
  suiteRuns: Record<string, number>;
  suiteExitCodes: Record<string, number[]>;
  recentInvocations: ApiInvocationEvidence[];
}

function tapCount(output: string, label: "tests" | "pass" | "fail") {
  const matches = [...output.matchAll(new RegExp(`^(?:#|ℹ) ${label} (\\d+)$`, "gm"))];
  return matches.length ? Number(matches.at(-1)?.[1]) : null;
}

async function linkReadOnlyDependencies(workspace: string) {
  const source = resolve(REPOSITORY_ROOT, "node_modules");
  const destination = resolve(workspace, "node_modules");
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    // Vite, Miniflare, and similar dot-directories are writable caches. They
    // must remain lane-local rather than sharing the live QA server's cache.
    if (entry.name.startsWith(".") && entry.name !== ".bin" && entry.name !== ".package-lock.json") {
      continue;
    }
    const dependencySource = resolve(source, entry.name);
    const dependencyDestination = resolve(destination, entry.name);
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      await symlink(dependencySource, dependencyDestination, "junction");
    } else {
      await cp(dependencySource, dependencyDestination, {
        force: false,
        errorOnExist: true,
      });
    }
  }
}

async function prepareIsolatedWorkspace(runId: string, segmentId: string, lane: string) {
  // The root tsconfig includes every *.ts below the repository. Keep the
  // disposable mirror under the already-excluded /work tree so normal tsc and
  // lint runs never ingest a second copy of the application.
  // Keep the lane deliberately short. Miniflare appends a 64-character D1
  // database filename; embedding the human-readable run/suite path here can
  // cross Windows path limits and surface only as a remote D1 internal error.
  const laneId = createHash("sha256")
    .update(`${runId}\0${segmentId}\0${lane}`)
    .digest("hex")
    .slice(0, 16);
  const workspace = resolve(REPOSITORY_ROOT, "work", "s", laneId);
  await mkdir(workspace, { recursive: true });
  const directories = [
    ".openai",
    "app",
    "build",
    "db",
    "drizzle",
    "lib",
    "public",
    "tests",
    "worker",
  ];
  const files = [
    "drizzle.config.ts",
    "env.d.ts",
    "next-env.d.ts",
    "next.config.ts",
    "package.json",
    "postcss.config.mjs",
    "tsconfig.json",
    "vite.config.ts",
  ];
  for (const directory of directories) {
    await cp(resolve(REPOSITORY_ROOT, directory), resolve(workspace, directory), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }
  for (const file of files) {
    await cp(resolve(REPOSITORY_ROOT, file), resolve(workspace, file), {
      force: false,
      errorOnExist: true,
    });
  }
  await linkReadOnlyDependencies(workspace);
  return workspace;
}

async function runSuite(
  workspace: string,
  workerDir: string,
  segmentId: string,
  cycle: number,
  suite: string,
  timeoutMs: number,
): Promise<ApiInvocationEvidence> {
  const startedAt = timeEvidence();
  const startedMono = performance.now();
  const safeSuite = suite.replaceAll(/[\\/.]/g, "-");
  const logPath = resolve(
    workerDir,
    "logs",
    segmentId,
    `${String(cycle).padStart(6, "0")}-${safeSuite}.tap`,
  );
  await mkdir(dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: "wx" });
  // Observe stream errors immediately so a disk failure cannot sit as an
  // unhandled rejection while the integration child is still running.
  const logFinished = finished(log).then<null, Error>(
    () => null,
    (error) => error instanceof Error ? error : new Error(String(error)),
  );
  const child = spawn(process.execPath, ["--test", "--test-reporter=tap", suite], {
    cwd: workspace,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  const capture = (chunk: Buffer) => {
    if (output.length < 4_000_000) output += chunk.toString("utf8");
    log.write(chunk);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  let timedOut = false;
  let forcedTimer: NodeJS.Timeout | null = null;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    forcedTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  }, timeoutMs);

  let result: { exitCode: number | null; signal: NodeJS.Signals | null } | null = null;
  let processError: unknown = null;
  let logError: Error | null = null;
  try {
    result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolvePromise, rejectPromise) => {
        child.once("error", rejectPromise);
        child.once("close", (exitCode, signal) => resolvePromise({ exitCode, signal }));
      },
    );
  } catch (error) {
    processError = error;
  } finally {
    clearTimeout(timeout);
    if (forcedTimer) clearTimeout(forcedTimer);
    log.end();
    logError = await logFinished;
  }
  if (processError || logError || !result) {
    throw new AggregateError(
      [processError, logError].filter((error) => error !== null),
      `API integration child or TAP evidence stream failed for ${suite}.`,
    );
  }

  return {
    segmentId,
    cycle,
    suite,
    startedAt,
    finishedAt: timeEvidence(),
    durationMs: performance.now() - startedMono,
    pid: child.pid ?? null,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut,
    tests: tapCount(output, "tests"),
    passed: tapCount(output, "pass"),
    failed: tapCount(output, "fail"),
    workspace,
    logPath,
  };
}

function validateState(value: unknown): ApiWorkerState {
  if (!value || typeof value !== "object") throw new Error("Invalid API worker state.");
  const candidate = value as Partial<ApiWorkerState>;
  if (
    !Number.isSafeInteger(candidate.cycle) ||
    !candidate.suiteRuns ||
    !candidate.suiteExitCodes ||
    !Array.isArray(candidate.recentInvocations)
  ) {
    throw new Error("Incomplete API worker state.");
  }
  return candidate as ApiWorkerState;
}

async function run() {
  const args = parseWorkerArguments(process.argv.slice(2));
  const journal = await WorkerJournal.open<ApiWorkerState>(
    "api",
    args,
    () => ({
      cycle: 0,
      suiteRuns: Object.fromEntries(SUITES.map((suite) => [suite, 0])),
      suiteExitCodes: Object.fromEntries(SUITES.map((suite) => [suite, []])),
      recentInvocations: [],
    }),
    validateState,
  );
  const invocationLog = resolve(args.workerDir, "invocations.jsonl");
  const timeoutMs = args.profile === "smoke" ? 120_000 : 180_000;
  const workspaces = Object.fromEntries(
    await Promise.all(
      SUITES.map(async (suite, index) => [
        suite,
        await prepareIsolatedWorkspace(
          args.runId,
          args.segmentId,
          `${String(index + 1).padStart(2, "0")}-${suite.replaceAll(/[\\/.]/g, "-")}`,
        ),
      ]),
    ),
  ) as Record<(typeof SUITES)[number], string>;
  let stopped = false;
  let completedCycle = false;

  while (true) {
    if (await stopWasRequested(args.stopPath)) {
      stopped = true;
      break;
    }
    if (completedCycle && journal.deadlineReached()) {
      break;
    }
    let cycleFailed = false;
    let suitesCompleted = 0;
    for (const suite of SUITES) {
      if (await stopWasRequested(args.stopPath)) {
        stopped = true;
        break;
      }
      let evidence: ApiInvocationEvidence;
      try {
        evidence = await runSuite(
          workspaces[suite],
          args.workerDir,
          args.segmentId,
          journal.state.cycle,
          suite,
          timeoutMs,
        );
      } catch (error) {
        journal.fail("childProcessFailures", error, { suite, cycle: journal.state.cycle });
        cycleFailed = true;
        break;
      }
      await appendFile(invocationLog, `${JSON.stringify(evidence)}\n`, "utf8");
      journal.state.suiteRuns[suite] = (journal.state.suiteRuns[suite] ?? 0) + 1;
      journal.state.suiteExitCodes[suite] ??= [];
      journal.state.suiteExitCodes[suite].push(evidence.exitCode ?? -1);
      if (journal.state.suiteExitCodes[suite].length > 100) {
        journal.state.suiteExitCodes[suite] = journal.state.suiteExitCodes[suite].slice(-100);
      }
      journal.state.recentInvocations.push(evidence);
      journal.state.recentInvocations = journal.state.recentInvocations.slice(-20);
      suitesCompleted += 1;

      const delta = emptyCounters();
      delta.assertions = evidence.passed ?? 0;
      journal.addCounters(delta);
      if (evidence.timedOut) {
        journal.fail("hangs", `Integration suite exceeded ${timeoutMs} ms.`, {
          suite,
          cycle: journal.state.cycle,
          pid: evidence.pid,
        });
        cycleFailed = true;
      } else if (
        evidence.exitCode !== 0 ||
        evidence.tests === null ||
        evidence.tests <= 0 ||
        evidence.passed === null ||
        evidence.passed !== evidence.tests ||
        evidence.failed !== 0
      ) {
        journal.fail("childProcessFailures", "Integration suite returned failing or incomplete TAP evidence.", {
          suite,
          cycle: journal.state.cycle,
          exitCode: evidence.exitCode,
          signal: evidence.signal,
          tests: evidence.tests,
          passed: evidence.passed,
          failed: evidence.failed,
          logPath: evidence.logPath,
        });
        cycleFailed = true;
      }
      await journal.write();
      if (cycleFailed) break;
    }
    if (stopped) break;
    if (suitesCompleted === SUITES.length) {
      const cycleDelta = emptyCounters();
      cycleDelta.loops = 1;
      journal.addCounters(cycleDelta);
      journal.state.cycle += 1;
      completedCycle = true;
    }
    await journal.write();
    if (cycleFailed || totalFailures(journal.segment) > 0) break;
  }

  const failed = totalFailures(journal.segment) > 0;
  const status = failed ? "failed" : stopped ? "stopped" : "succeeded";
  const exitCode = failed ? 1 : 0;
  await journal.finish(status, exitCode);
  process.exitCode = exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}

export { SUITES, tapCount };
