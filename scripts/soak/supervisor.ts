import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { finished } from "node:stream/promises";

import { AUGMENT_IDS, type AugmentId } from "../../lib/augments.ts";
import {
  BALANCE_ALGORITHM_VERSION,
  BALANCE_ENGINE_RULES_FINGERPRINT,
  buildProductStabilityPairings,
  type TournamentAggregate,
} from "../balance/tournament.ts";
import {
  EXCLUDED_CLOCK_AUGMENT_IDS,
  SIMULATION_CATALOG_SIZE,
  SIMULATION_ELIGIBLE_AUGMENT_IDS,
  SIMULATION_ELIGIBLE_AUGMENTS,
  SIMULATION_ELIGIBLE_COUNT,
} from "../balance/simulation-pool.ts";
import { balanceTournamentOptions } from "./balance-worker.ts";
import {
  SOAK_SCHEMA_VERSION,
  SOAK_WORKERS,
  allCardsCovered,
  atomicJson,
  counterValidationErrors,
  emptyCounters,
  mergeCounters,
  pathExists,
  readJson,
  sleep,
  timeEvidence,
  totalFailures,
  uncoveredCards,
  workspaceFingerprint,
  type SoakCounters,
  type SoakProfile,
  type SoakWorkerName,
  type TimeEvidence,
  type WorkerCheckpoint,
  type WorkerFinal,
  type WorkspaceFingerprint,
} from "./common.ts";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const AUGMENT_MOTION_PHASES = [
  "dealing",
  "choosing",
  "fading",
  "centering",
  "turning",
  "awaiting-server",
  "awaiting-late-server",
  "docking",
  "recovering",
  "settled",
] as const;
const SUPERVISOR_HEARTBEAT_GAP_LIMIT_MS = 30_000;
const SOURCE_FINGERPRINT_INTERVAL_MS = 5_000;
const BALANCE_STABILITY_SCHEDULE_GROUPS = buildProductStabilityPairings().length;
const REQUIRED_V3_ACTIVE_SIMULATION_IDS = [
  "heart-heavenly-exchange",
  "heart-shadow-redeploy",
  "club-surprise-double-move",
  "club-bitter-ruse",
] as const satisfies readonly AugmentId[];

export function hasCappedBalanceGames(cappedGames: number | undefined) {
  return (cappedGames ?? 0) > 0;
}

type StopReason =
  | "operator_requested"
  | "worker_failed"
  | "source_changed"
  | "continuity_broken"
  | "supervisor_error";

interface SupervisorOptions {
  durationSeconds: number;
  checkpointIntervalSeconds: number;
  workerHangTimeoutSeconds: number;
  outputRoot: string;
  seed: number;
  profile: SoakProfile;
  resumeRunDir: string | null;
  stopRunDir: string | null;
}

interface SegmentEvidence {
  segmentId: string;
  status: "running" | "succeeded" | "failed" | "stopped" | "interrupted";
  startedAt: TimeEvidence;
  lastHeartbeatAt: TimeEvidence;
  finishedAt?: TimeEvidence;
  measuredActiveMs?: number;
  supervisorPid: number;
  workerPids: Partial<Record<SoakWorkerName, number>>;
  workerExitCodes?: Partial<Record<SoakWorkerName, number>>;
}

interface SoakManifest {
  schemaVersion: typeof SOAK_SCHEMA_VERSION;
  algorithmVersion: typeof BALANCE_ALGORITHM_VERSION;
  engineRulesFingerprint: typeof BALANCE_ENGINE_RULES_FINGERPRINT;
  runId: string;
  createdAt: TimeEvidence;
  repositoryRoot: string;
  profile: SoakProfile;
  requiredContinuousSeconds: number;
  checkpointIntervalSeconds: number;
  workerHangTimeoutSeconds: number;
  supervisorHeartbeatGapLimitMs: number;
  sourceFingerprintIntervalMs: number;
  seed: number;
  balanceTournament: ReturnType<typeof balanceTournamentOptions>;
  balanceStabilityScheduleGroups: number;
  source: WorkspaceFingerprint;
  workers: readonly SoakWorkerName[];
  segments: SegmentEvidence[];
}

interface SupervisorCheckpoint {
  schemaVersion: typeof SOAK_SCHEMA_VERSION;
  runId: string;
  segmentId: string;
  status: "running" | "stopping" | "succeeded" | "failed" | "stopped";
  updatedAt: TimeEvidence;
  source: WorkspaceFingerprint;
  workers: Partial<Record<SoakWorkerName, WorkerCheckpoint>>;
  processExitCodes: Partial<Record<SoakWorkerName, number>>;
}

interface WorkerSummary {
  status: WorkerFinal["status"] | "missing_final";
  /** Exit observed by the supervisor for the operating-system process. */
  exitCode: number;
  /** Exit the worker committed inside its own atomic final evidence. */
  reportedExitCode: number | null;
  segmentActiveMs: number | null;
  accumulatedActiveMs: number | null;
  totals: SoakCounters | null;
  segment: SoakCounters | null;
  failureSamples: WorkerFinal["failureSamples"];
  state: unknown;
  finalPath: string;
}

interface ManagedChild extends ChildProcess {
  soakLogsFinished: Promise<Error[]>;
}

function normalizeError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function helpText() {
  return `Junqi four-worker soak supervisor

Usage:
  node --experimental-transform-types scripts/soak/supervisor.ts [options]

  --duration-seconds=14400       Required uninterrupted duration (default: 4 hours)
  --profile=soak|smoke           High-intensity defaults or short validation defaults
  --checkpoint-interval-seconds=5
  --worker-hang-timeout-seconds=300
  --seed=20260809
  --output-root=outputs/soak
  --resume=<absolute-or-relative-run-directory>
  --stop-run=<run-directory>     Request a graceful stop and exit
`;
}

function parseCli(argv: readonly string[]): SupervisorOptions {
  const values = new Map<string, string>();
  for (const argument of argv) {
    if (argument === "--help") {
      console.log(helpText());
      process.exit(0);
    }
    const match = argument.match(/^--([a-z-]+)=(.+)$/);
    if (!match) throw new Error(`Unknown supervisor argument: ${argument}.`);
    values.set(match[1], match[2]);
  }
  const number = (key: string, fallback: number, minimum: number, integer = false) => {
    const parsed = Number(values.get(key) ?? fallback);
    if (!Number.isFinite(parsed) || parsed < minimum || (integer && !Number.isSafeInteger(parsed))) {
      throw new Error(`Invalid --${key}.`);
    }
    return parsed;
  };
  const profile = values.get("profile") ?? "soak";
  if (profile !== "soak" && profile !== "smoke") throw new Error("Invalid --profile.");
  return {
    durationSeconds: number("duration-seconds", 14_400, 0.1),
    checkpointIntervalSeconds: number("checkpoint-interval-seconds", 5, 0.1),
    workerHangTimeoutSeconds: number("worker-hang-timeout-seconds", 300, 30),
    outputRoot: resolve(REPOSITORY_ROOT, values.get("output-root") ?? "outputs/soak"),
    seed: number("seed", 20260809, 0, true),
    profile,
    resumeRunDir: values.has("resume")
      ? resolve(REPOSITORY_ROOT, values.get("resume") ?? "")
      : null,
    stopRunDir: values.has("stop-run")
      ? resolve(REPOSITORY_ROOT, values.get("stop-run") ?? "")
      : null,
  };
}

function runId() {
  return `soak-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
}

async function gracefulStop(runDir: string) {
  const manifestPath = resolve(runDir, "manifest.json");
  if (!await pathExists(manifestPath)) throw new Error(`${runDir} has no soak manifest.`);
  const manifest = await readJson<SoakManifest>(manifestPath);
  if (manifest.schemaVersion !== SOAK_SCHEMA_VERSION || !manifest.runId) {
    throw new Error("The requested directory is not a compatible soak run.");
  }
  const latestSegment = manifest.segments.at(-1);
  if (!latestSegment || latestSegment.status !== "running") {
    console.log(`Soak ${manifest.runId} is already ${latestSegment?.status ?? "terminal"}.`);
    return;
  }
  const stopPath = resolve(runDir, "stop-request.json");
  const request = {
    schemaVersion: SOAK_SCHEMA_VERSION,
    runId: manifest.runId,
    segmentId: latestSegment.segmentId,
    requestedAt: timeEvidence(),
    reason: "operator_requested",
    reasons: ["operator_requested"],
  } as const;
  try {
    await writeFile(stopPath, `${JSON.stringify(request, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readJson<{ reason?: string }>(stopPath);
    if (existing.reason !== "operator_requested") {
      console.log(
        `Preserved existing ${existing.reason ?? "unknown"} stop evidence for ${manifest.runId}.`,
      );
      return;
    }
  }
  console.log(`Graceful stop requested for ${manifest.runId}.`);
}

function sameFingerprint(first: WorkspaceFingerprint, second: WorkspaceFingerprint) {
  return (
    first.commit === second.commit &&
    first.workspaceSha256 === second.workspaceSha256 &&
    first.runtimeSha256 === second.runtimeSha256
  );
}

function processIsAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function priorFailureEvidence(runDir: string, manifest: SoakManifest) {
  const reasons: string[] = [];
  const lastSegmentId = manifest.segments.at(-1)?.segmentId;
  if (lastSegmentId) {
    const candidateFinalPaths = [
      { path: resolve(runDir, "segments", lastSegmentId, "final.json"), staleAllowed: false },
      { path: resolve(runDir, "final.json"), staleAllowed: true },
    ];
    for (const candidate of candidateFinalPaths) {
      if (!await pathExists(candidate.path)) continue;
      try {
        const final = await readJson<{ runId?: string; segmentId?: string; status?: string }>(
          candidate.path,
        );
        if (candidate.staleAllowed && final.segmentId !== lastSegmentId) continue;
        if (final.runId !== manifest.runId || final.segmentId !== lastSegmentId) {
          reasons.push("supervisor final identity is invalid");
        } else if (final.status === "failed" || final.status === "succeeded") {
          reasons.push(`segment ${lastSegmentId} already has terminal ${final.status} evidence`);
        } else if (final.status !== "stopped") {
          reasons.push(`segment ${lastSegmentId} final status is invalid`);
        }
      } catch {
        reasons.push("supervisor final is unreadable");
      }
    }
  }
  const stopPath = resolve(runDir, "stop-request.json");
  if (await pathExists(stopPath)) {
    try {
      const stop = await readJson<{ runId?: string; reason?: string }>(stopPath);
      if (stop.runId !== manifest.runId) reasons.push("stop request belongs to another run");
      else if (stop.reason !== "operator_requested") {
        reasons.push(`stop reason is ${stop.reason ?? "missing"}`);
      }
    } catch {
      reasons.push("stop request is unreadable");
    }
  }

  const supervisorCheckpointPath = resolve(runDir, "checkpoint.json");
  if (await pathExists(supervisorCheckpointPath)) {
    try {
      const checkpoint = await readJson<SupervisorCheckpoint>(supervisorCheckpointPath);
      if (checkpoint.runId !== manifest.runId) {
        reasons.push("supervisor checkpoint belongs to another run");
      } else {
        for (const [worker, exitCode] of Object.entries(checkpoint.processExitCodes ?? {})) {
          if (exitCode !== 0) reasons.push(`${worker} previously exited ${String(exitCode)}`);
        }
      }
    } catch {
      reasons.push("supervisor checkpoint is unreadable");
    }
  }

  for (const worker of SOAK_WORKERS) {
    const checkpointPath = resolve(runDir, "workers", worker, "checkpoint.json");
    if (await pathExists(checkpointPath)) {
      try {
        const checkpoint = await readJson<WorkerCheckpoint>(checkpointPath);
        const errors = counterValidationErrors(checkpoint.totals);
        if (checkpoint.runId !== manifest.runId || checkpoint.worker !== worker) {
          reasons.push(`${worker} checkpoint identity is invalid`);
        } else if (
          !["running", "succeeded", "failed", "stopped"].includes(checkpoint.status) ||
          !Array.isArray(checkpoint.failureSamples)
        ) {
          reasons.push(`${worker} checkpoint metadata is invalid`);
        } else if (errors.length) {
          reasons.push(`${worker} checkpoint counters are invalid`);
        } else if (
          checkpoint.status === "failed" ||
          totalFailures(checkpoint.totals) > 0 ||
          checkpoint.failureSamples.length > 0
        ) {
          reasons.push(`${worker} checkpoint retains a failure`);
        }
      } catch {
        reasons.push(`${worker} checkpoint is unreadable`);
      }
    }

    const finalPath = resolve(runDir, "workers", worker, "final.json");
    if (await pathExists(finalPath)) {
      try {
        const final = await readJson<WorkerFinal>(finalPath);
        if (final.runId !== manifest.runId || final.worker !== worker) {
          reasons.push(`${worker} final identity is invalid`);
        } else if (final.status === "failed" || final.exitCode !== 0) {
          reasons.push(`${worker} final retains a failed exit`);
        }
      } catch {
        reasons.push(`${worker} final is unreadable`);
      }
    }
  }

  // The API worker deliberately persists an invocation before it mutates its
  // checkpoint. If the host dies in that narrow interval, this append-only
  // journal is the only durable indication that a suite already failed.
  const invocationPath = resolve(runDir, "workers", "api", "invocations.jsonl");
  if (await pathExists(invocationPath)) {
    try {
      const contents = await readFile(invocationPath, "utf8");
      const lines = contents.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line) continue;
        let invocation: {
          segmentId?: unknown;
          cycle?: unknown;
          suite?: unknown;
          exitCode?: unknown;
          timedOut?: unknown;
          tests?: unknown;
          passed?: unknown;
          failed?: unknown;
        };
        try {
          invocation = JSON.parse(line) as typeof invocation;
        } catch {
          reasons.push(`API invocation journal line ${index + 1} is truncated or invalid`);
          continue;
        }
        const validIdentity =
          typeof invocation.segmentId === "string" &&
          invocation.segmentId.length > 0 &&
          Number.isSafeInteger(invocation.cycle) &&
          Number(invocation.cycle) >= 0 &&
          typeof invocation.suite === "string" &&
          invocation.suite.length > 0;
        const successfulTap =
          invocation.exitCode === 0 &&
          invocation.timedOut === false &&
          Number.isSafeInteger(invocation.tests) &&
          Number(invocation.tests) > 0 &&
          invocation.passed === invocation.tests &&
          invocation.failed === 0;
        if (!validIdentity || !successfulTap) {
          reasons.push(`API invocation journal line ${index + 1} retains failing or incomplete evidence`);
        }
      }
    } catch {
      reasons.push("API invocation journal is unreadable");
    }
  }
  return [...new Set(reasons)];
}

async function loadOrCreateManifest(options: SupervisorOptions) {
  const source = await workspaceFingerprint(REPOSITORY_ROOT);
  if (options.resumeRunDir) {
    const manifestPath = resolve(options.resumeRunDir, "manifest.json");
    const manifest = await readJson<SoakManifest>(manifestPath);
    if (manifest.schemaVersion !== SOAK_SCHEMA_VERSION) throw new Error("Unsupported soak manifest.");
    if (manifest.algorithmVersion !== BALANCE_ALGORITHM_VERSION) {
      throw new Error("Resume balance algorithm differs from the product-stability worker.");
    }
    if (manifest.engineRulesFingerprint !== BALANCE_ENGINE_RULES_FINGERPRINT) {
      throw new Error("Resume engine rules fingerprint is not supported.");
    }
    if (manifest.profile !== options.profile) throw new Error("Resume profile differs from manifest.");
    if (manifest.requiredContinuousSeconds !== options.durationSeconds) {
      throw new Error("Resume duration differs from manifest; a continuous gate cannot change mid-run.");
    }
    if (manifest.checkpointIntervalSeconds !== options.checkpointIntervalSeconds) {
      throw new Error("Resume checkpoint interval differs from manifest.");
    }
    if (manifest.workerHangTimeoutSeconds !== options.workerHangTimeoutSeconds) {
      throw new Error("Resume worker hang timeout differs from manifest.");
    }
    if (manifest.supervisorHeartbeatGapLimitMs !== SUPERVISOR_HEARTBEAT_GAP_LIMIT_MS) {
      throw new Error("Resume supervisor continuity threshold differs from manifest.");
    }
    if (manifest.sourceFingerprintIntervalMs !== SOURCE_FINGERPRINT_INTERVAL_MS) {
      throw new Error("Resume source fingerprint interval differs from manifest.");
    }
    if (manifest.seed !== options.seed) throw new Error("Resume seed differs from manifest.");
    if (
      JSON.stringify(manifest.balanceTournament) !==
      JSON.stringify(balanceTournamentOptions(options.profile, options.seed))
    ) {
      throw new Error("Resume balance workload differs from manifest.");
    }
    if (
      manifest.balanceStabilityScheduleGroups !==
      BALANCE_STABILITY_SCHEDULE_GROUPS
    ) {
      throw new Error("Resume balance catalog schedule differs from manifest.");
    }
    if (!sameFingerprint(manifest.source, source)) {
      throw new Error("Workspace fingerprint changed; fixes or edits require a new four-hour run.");
    }
    const terminal = manifest.segments.at(-1)?.status;
    if (terminal === "succeeded" || terminal === "failed") {
      throw new Error(`Cannot resume a terminal ${terminal} soak run.`);
    }
    const priorFailures = await priorFailureEvidence(options.resumeRunDir, manifest);
    if (priorFailures.length) {
      throw new Error(`Cannot resume a run with prior failure evidence: ${priorFailures.join("; ")}.`);
    }
    const livePriorSupervisors = manifest.segments
      .filter((segment) => segment.status === "running")
      .filter((segment) => processIsAlive(segment.supervisorPid))
      .map((segment) => `${segment.segmentId}:${segment.supervisorPid}`);
    if (livePriorSupervisors.length) {
      throw new Error(
        `Cannot resume while a prior supervisor is alive (${livePriorSupervisors.join(", ")}). ` +
          "Request a graceful stop and wait for terminal evidence first.",
      );
    }
    const livePriorWorkers = manifest.segments
      .filter((segment) => segment.status === "running")
      .flatMap((segment) =>
        Object.entries(segment.workerPids)
          .filter((entry): entry is [SoakWorkerName, number] => typeof entry[1] === "number")
          .filter(([, pid]) => processIsAlive(pid))
          .map(([worker, pid]) => `${worker}:${pid}`)
      );
    if (livePriorWorkers.length) {
      throw new Error(
        `Cannot resume while prior workers are alive (${livePriorWorkers.join(", ")}). ` +
          "Request a graceful stop, wait for them to exit, then resume.",
      );
    }
    for (const segment of manifest.segments) {
      if (segment.status !== "running") continue;
      segment.status = "interrupted";
      segment.finishedAt = segment.lastHeartbeatAt;
      segment.measuredActiveMs = Math.max(
        0,
        segment.lastHeartbeatAt.epochMs - segment.startedAt.epochMs,
      );
    }
    return { manifest, runDir: options.resumeRunDir, source, resume: true };
  }

  const id = runId();
  const runDir = resolve(options.outputRoot, id);
  const manifest: SoakManifest = {
    schemaVersion: SOAK_SCHEMA_VERSION,
    algorithmVersion: BALANCE_ALGORITHM_VERSION,
    engineRulesFingerprint: BALANCE_ENGINE_RULES_FINGERPRINT,
    runId: id,
    createdAt: timeEvidence(),
    repositoryRoot: REPOSITORY_ROOT,
    profile: options.profile,
    requiredContinuousSeconds: options.durationSeconds,
    checkpointIntervalSeconds: options.checkpointIntervalSeconds,
    workerHangTimeoutSeconds: options.workerHangTimeoutSeconds,
    supervisorHeartbeatGapLimitMs: SUPERVISOR_HEARTBEAT_GAP_LIMIT_MS,
    sourceFingerprintIntervalMs: SOURCE_FINGERPRINT_INTERVAL_MS,
    seed: options.seed,
    balanceTournament: balanceTournamentOptions(options.profile, options.seed),
    balanceStabilityScheduleGroups: BALANCE_STABILITY_SCHEDULE_GROUPS,
    source,
    workers: SOAK_WORKERS,
    segments: [],
  };
  return { manifest, runDir, source, resume: false };
}

function workerScript(worker: SoakWorkerName) {
  return resolve(dirname(fileURLToPath(import.meta.url)), `${worker}-worker.ts`);
}

function spawnWorker(
  worker: SoakWorkerName,
  runDir: string,
  manifest: SoakManifest,
  segmentId: string,
  options: SupervisorOptions,
  resume: boolean,
): ManagedChild {
  const workerDir = resolve(runDir, "workers", worker);
  const commonArguments = [
    "--experimental-transform-types",
    workerScript(worker),
    `--run-dir=${runDir}`,
    `--worker-dir=${workerDir}`,
    `--run-id=${manifest.runId}`,
    `--segment-id=${segmentId}`,
    `--duration-seconds=${options.durationSeconds}`,
    `--checkpoint-interval-seconds=${options.checkpointIntervalSeconds}`,
    `--seed=${options.seed}`,
    `--profile=${options.profile}`,
    `--stop-path=${resolve(runDir, "stop-request.json")}`,
    ...(resume ? ["--resume"] : []),
  ];
  const child = spawn(process.execPath, commonArguments, {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = createWriteStream(resolve(workerDir, `${segmentId}.stdout.log`), { flags: "a" });
  const stderr = createWriteStream(resolve(workerDir, `${segmentId}.stderr.log`), { flags: "a" });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  child.once("error", () => {
    stdout.end();
    stderr.end();
  });
  // Attach rejection handlers immediately. A write failure hours before the
  // supervisor joins these promises must never become an unhandled rejection.
  const stdoutFinished = finished(stdout).then<null, Error>(
    () => null,
    (error) => normalizeError(error),
  );
  const stderrFinished = finished(stderr).then<null, Error>(
    () => null,
    (error) => normalizeError(error),
  );
  const soakLogsFinished = Promise.all([stdoutFinished, stderrFinished]).then(
    (outcomes) => outcomes.filter((error): error is Error => error !== null),
  );
  return Object.assign(child, { soakLogsFinished });
}

async function readWorkerCheckpoints(runDir: string, segmentId: string) {
  const result: Partial<Record<SoakWorkerName, WorkerCheckpoint>> = {};
  for (const worker of SOAK_WORKERS) {
    const path = resolve(runDir, "workers", worker, "checkpoint.json");
    if (!await pathExists(path)) continue;
    try {
      const checkpoint = await readJson<WorkerCheckpoint>(path);
      if (checkpoint.segmentId === segmentId) result[worker] = checkpoint;
    } catch {
      // A worker may be between atomic replacement operations; retry next heartbeat.
    }
  }
  return result;
}

function exitCodeForProcess(child: ChildProcess) {
  if (child.exitCode !== null) return child.exitCode;
  if (child.signalCode !== null) return -1;
  return -1;
}

function childIsAlive(child: ChildProcess) {
  return child.exitCode === null && child.signalCode === null;
}

async function settleChildrenAfterSupervisorFailure(
  children: ReadonlyMap<SoakWorkerName, ChildProcess>,
  gracefulWaitMs: number,
) {
  const deadline = performance.now() + gracefulWaitMs;
  while (
    [...children.values()].some(childIsAlive) &&
    performance.now() < deadline
  ) {
    await sleep(100);
  }
  if (![...children.values()].some(childIsAlive)) return;
  for (const child of children.values()) {
    if (childIsAlive(child)) child.kill("SIGTERM");
  }
  await sleep(5_000);
  for (const child of children.values()) {
    if (childIsAlive(child)) child.kill("SIGKILL");
  }
  await sleep(250);
}

function summarizeWorkerFinal(final: WorkerFinal | null, processExitCode: number, path: string): WorkerSummary {
  return final
    ? {
        status: final.status,
        exitCode: processExitCode,
        reportedExitCode: final.exitCode,
        segmentActiveMs: final.segmentActiveMs,
        accumulatedActiveMs: final.accumulatedActiveMs,
        totals: final.totals,
        segment: final.segment,
        failureSamples: final.failureSamples,
        state: final.state,
        finalPath: path,
      }
    : {
        status: "missing_final",
        exitCode: processExitCode,
        reportedExitCode: null,
        segmentActiveMs: null,
        accumulatedActiveMs: null,
        totals: null,
        segment: null,
        failureSamples: [],
        state: null,
        finalPath: path,
      };
}

async function run() {
  const options = parseCli(process.argv.slice(2));
  if (options.stopRunDir) {
    await gracefulStop(options.stopRunDir);
    return;
  }
  const prepared = await loadOrCreateManifest(options);
  const { manifest, runDir, source, resume } = prepared;
  await mkdir(runDir, { recursive: true });
  await rm(resolve(runDir, "stop-request.json"), { force: true });
  const segmentId = `segment-${String(manifest.segments.length + 1).padStart(3, "0")}`;
  const segment: SegmentEvidence = {
    segmentId,
    status: "running",
    startedAt: timeEvidence(),
    lastHeartbeatAt: timeEvidence(),
    supervisorPid: process.pid,
    workerPids: {},
  };
  manifest.segments.push(segment);
  await atomicJson(resolve(runDir, "manifest.json"), manifest);
  await atomicJson(resolve(options.outputRoot, "latest-run.json"), {
    schemaVersion: SOAK_SCHEMA_VERSION,
    runId: manifest.runId,
    runDir,
    segmentId,
    updatedAt: timeEvidence(),
  });

  const children = new Map<SoakWorkerName, ManagedChild>();
  const exitCodes: Partial<Record<SoakWorkerName, number>> = {};
  const workerObservedAtMono = Object.fromEntries(
    SOAK_WORKERS.map((worker) => [worker, performance.now()]),
  ) as Record<SoakWorkerName, number>;
  const workerCheckpointIdentity = {} as Partial<Record<SoakWorkerName, string>>;
  const watchdogFailures: SoakWorkerName[] = [];
  let operatorStop = false;
  let failureStop = false;
  let sourceMutationDetectedAt: TimeEvidence | null = null;
  let continuityBreakDetectedAt: TimeEvidence | null = null;
  let maximumSupervisorMonotonicGapMs = 0;
  let maximumSupervisorWallGapMs = 0;
  let wallClockMovedBackward = false;
  let stopRequestReadError = false;
  let supervisorFailure: { at: TimeEvidence; message: string } | null = null;
  const workerLogFailures: Array<{ worker: SoakWorkerName; messages: string[] }> = [];
  let lastSourceCheckMs = Date.now();
  let lastSupervisorHeartbeatMono = performance.now();
  let lastSupervisorHeartbeatWallMs = Date.now();
  const stopReasons = new Set<StopReason>();
  let stopWriteRequested = false;
  let stopWrite = Promise.resolve();
  const requestStop = (reason: StopReason) => {
    if (reason === "operator_requested") operatorStop = true;
    else failureStop = true;
    stopReasons.add(reason);
    const reasons = [...stopReasons];
    const primaryReason = reasons.find((candidate) => candidate !== "operator_requested") ?? reason;
    stopWriteRequested = true;
    stopWrite = stopWrite
      .catch(() => undefined)
      .then(() => atomicJson(resolve(runDir, "stop-request.json"), {
        schemaVersion: SOAK_SCHEMA_VERSION,
        runId: manifest.runId,
        segmentId,
        requestedAt: timeEvidence(),
        reason: primaryReason,
        reasons,
      }));
    return stopWrite;
  };
  const requestOperatorStop = () => {
    void requestStop("operator_requested").catch((error) => {
      failureStop = true;
      supervisorFailure ??= {
        at: timeEvidence(),
        message: error instanceof Error ? error.message : String(error),
      };
    });
  };
  process.once("SIGINT", requestOperatorStop);
  process.once("SIGTERM", requestOperatorStop);

  try {
    for (const worker of SOAK_WORKERS) {
    const workerDir = resolve(runDir, "workers", worker);
    await mkdir(workerDir, { recursive: true });
    const child = spawnWorker(worker, runDir, manifest, segmentId, options, resume);
    children.set(worker, child);
    if (child.pid) segment.workerPids[worker] = child.pid;
    child.once("exit", (code, signal) => {
      exitCodes[worker] = code ?? (signal ? -1 : 0);
      if ((exitCodes[worker] ?? -1) !== 0) {
        void requestStop("worker_failed").catch((error) => {
          supervisorFailure ??= {
            at: timeEvidence(),
            message: error instanceof Error ? error.message : String(error),
          };
        });
      }
    });
    child.once("error", () => {
      exitCodes[worker] = -1;
      void requestStop("worker_failed").catch((error) => {
        supervisorFailure ??= {
          at: timeEvidence(),
          message: error instanceof Error ? error.message : String(error),
        };
      });
    });
    }
    await atomicJson(resolve(runDir, "manifest.json"), manifest);

    while (Object.keys(exitCodes).length < SOAK_WORKERS.length) {
    await sleep(Math.min(1_000, options.checkpointIntervalSeconds * 1_000));
    const heartbeatMono = performance.now();
    const heartbeatWallMs = Date.now();
    const monotonicGapMs = heartbeatMono - lastSupervisorHeartbeatMono;
    const wallGapMs = heartbeatWallMs - lastSupervisorHeartbeatWallMs;
    lastSupervisorHeartbeatMono = heartbeatMono;
    lastSupervisorHeartbeatWallMs = heartbeatWallMs;
    maximumSupervisorMonotonicGapMs = Math.max(
      maximumSupervisorMonotonicGapMs,
      monotonicGapMs,
    );
    maximumSupervisorWallGapMs = Math.max(maximumSupervisorWallGapMs, wallGapMs);
    if (
      monotonicGapMs > SUPERVISOR_HEARTBEAT_GAP_LIMIT_MS ||
      wallGapMs > SUPERVISOR_HEARTBEAT_GAP_LIMIT_MS ||
      wallGapMs < 0
    ) {
      if (wallGapMs < 0) wallClockMovedBackward = true;
      continuityBreakDetectedAt ??= timeEvidence();
      await requestStop("continuity_broken");
    }
    const externalStopPath = resolve(runDir, "stop-request.json");
    if (await pathExists(externalStopPath)) {
      try {
        const externalStop = await readJson<{ reason?: string }>(externalStopPath);
        if (externalStop.reason === "operator_requested") operatorStop = true;
        else if (
          externalStop.reason === "worker_failed" ||
          externalStop.reason === "source_changed" ||
          externalStop.reason === "continuity_broken" ||
          externalStop.reason === "supervisor_error"
        ) {
          failureStop = true;
        }
      } catch {
        // The writer uses atomic replacement. If antivirus briefly obscures the
        // file, workers still observe it and the next heartbeat will retry.
      }
    }
    if (Date.now() - lastSourceCheckMs >= SOURCE_FINGERPRINT_INTERVAL_MS) {
      lastSourceCheckMs = Date.now();
      const observedSource = await workspaceFingerprint(REPOSITORY_ROOT);
      if (!sameFingerprint(source, observedSource)) {
        sourceMutationDetectedAt ??= timeEvidence();
        await requestStop("source_changed");
      }
    }
    const checkpoints = await readWorkerCheckpoints(runDir, segmentId);
    for (const worker of SOAK_WORKERS) {
      const checkpoint = checkpoints[worker];
      if (checkpoint) {
        const identity = `${checkpoint.updatedAt.epochMs}:${checkpoint.segmentActiveMs}:${checkpoint.status}`;
        if (workerCheckpointIdentity[worker] !== identity) {
          workerCheckpointIdentity[worker] = identity;
          workerObservedAtMono[worker] = heartbeatMono;
        }
      }
      const child = children.get(worker);
      if (
        exitCodes[worker] === undefined &&
        child &&
        heartbeatMono - workerObservedAtMono[worker] > options.workerHangTimeoutSeconds * 1_000 &&
        !watchdogFailures.includes(worker)
      ) {
        watchdogFailures.push(worker);
        await requestStop("worker_failed");
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 5_000);
      }
    }
    segment.lastHeartbeatAt = timeEvidence();
    await atomicJson(resolve(runDir, "checkpoint.json"), {
      schemaVersion: SOAK_SCHEMA_VERSION,
      runId: manifest.runId,
      segmentId,
      status: operatorStop || failureStop ? "stopping" : "running",
      updatedAt: segment.lastHeartbeatAt,
      source,
      workers: checkpoints,
      processExitCodes: exitCodes,
    } satisfies SupervisorCheckpoint);
    await atomicJson(resolve(runDir, "manifest.json"), manifest);
    }
    const finalStopPath = resolve(runDir, "stop-request.json");
    if (await pathExists(finalStopPath)) {
    try {
      const finalStop = await readJson<{ reason?: string }>(finalStopPath);
      if (finalStop.reason === "operator_requested") operatorStop = true;
      else if (
        finalStop.reason === "worker_failed" ||
        finalStop.reason === "source_changed" ||
        finalStop.reason === "continuity_broken" ||
        finalStop.reason === "supervisor_error"
      ) {
        failureStop = true;
      } else {
        stopRequestReadError = true;
        failureStop = true;
      }
    } catch {
      stopRequestReadError = true;
      failureStop = true;
    }
    }
    if (stopWriteRequested) await stopWrite;
  } catch (error) {
    failureStop = true;
    supervisorFailure ??= {
      at: timeEvidence(),
      message: error instanceof Error ? error.message : String(error),
    };
    let gracefulStopPersisted = false;
    try {
      await requestStop("supervisor_error");
      gracefulStopPersisted = true;
    } catch {
      // If the stop evidence itself cannot be written, terminate only the
      // exact child PIDs created by this supervisor.
    }
    await settleChildrenAfterSupervisorFailure(
      children,
      gracefulStopPersisted ? options.workerHangTimeoutSeconds * 1_000 + 10_000 : 0,
    );
    for (const worker of SOAK_WORKERS) {
      const child = children.get(worker);
      if (exitCodes[worker] === undefined) {
        exitCodes[worker] = child ? exitCodeForProcess(child) : -1;
      }
    }
  }

  for (const [worker, child] of children) {
    const logErrors = await child.soakLogsFinished;
    if (logErrors.length) {
      workerLogFailures.push({
        worker,
        messages: logErrors.map((error) => error.message),
      });
    }
  }
  if (workerLogFailures.length) {
    failureStop = true;
    supervisorFailure ??= {
      at: timeEvidence(),
      message: "One or more worker stdout/stderr evidence streams failed.",
    };
    try {
      await requestStop("supervisor_error");
    } catch {
      // The final evidence below still records the stream and stop failures.
    }
  }

  const finishedAt = timeEvidence();
  let endingSource = source;
  let sourceUnchanged = false;
  try {
    endingSource = await workspaceFingerprint(REPOSITORY_ROOT);
    sourceUnchanged =
      sourceMutationDetectedAt === null && sameFingerprint(source, endingSource);
  } catch (error) {
    failureStop = true;
    supervisorFailure ??= {
      at: timeEvidence(),
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const workerSummaries = {} as Record<SoakWorkerName, WorkerSummary>;
  const aggregate = emptyCounters();
  const currentCoverage = {} as Record<SoakWorkerName, Record<AugmentId, number>>;
  const missingFinals: SoakWorkerName[] = [];
  let historicalRecordedFailureCount = 0;
  const counterValidationFailures: Array<{
    worker: SoakWorkerName;
    scope: "segment" | "totals";
    errors: string[];
  }> = [];
  for (const worker of SOAK_WORKERS) {
    const finalPath = resolve(runDir, "workers", worker, "final.json");
    let workerFinal: WorkerFinal | null = null;
    if (await pathExists(finalPath)) {
      try {
        const candidate = await readJson<WorkerFinal>(finalPath);
        const validMetadata =
          candidate.schemaVersion === SOAK_SCHEMA_VERSION &&
          ["succeeded", "failed", "stopped"].includes(candidate.status) &&
          Number.isSafeInteger(candidate.exitCode) &&
          Number.isFinite(candidate.segmentActiveMs) &&
          candidate.segmentActiveMs >= 0 &&
          Number.isFinite(candidate.accumulatedActiveMs) &&
          candidate.accumulatedActiveMs >= candidate.segmentActiveMs;
        if (
          validMetadata &&
          candidate.segmentId === segmentId &&
          candidate.runId === manifest.runId &&
          candidate.worker === worker &&
          candidate.profile === options.profile
        ) {
          workerFinal = candidate;
        }
      } catch {
        workerFinal = null;
      }
    }
    if (!workerFinal) missingFinals.push(worker);
    const processExitCode = exitCodes[worker] ?? exitCodeForProcess(children.get(worker)!);
    const summary = summarizeWorkerFinal(workerFinal, processExitCode, finalPath);
    workerSummaries[worker] = summary;
    if (summary.segment) {
      const segmentErrors = counterValidationErrors(summary.segment);
      const totalErrors = counterValidationErrors(summary.totals);
      if (segmentErrors.length) {
        counterValidationFailures.push({ worker, scope: "segment", errors: segmentErrors });
      }
      if (totalErrors.length) {
        counterValidationFailures.push({ worker, scope: "totals", errors: totalErrors });
      } else if (summary.totals) {
        const failureHistoryErrors = Object.keys(summary.segment.failures)
          .filter((key) =>
            summary.totals!.failures[key as keyof typeof summary.segment.failures] <
              summary.segment!.failures[key as keyof typeof summary.segment.failures]
          )
          .map((key) => `totals.failures.${key} is below the current segment`);
        if (failureHistoryErrors.length) {
          counterValidationFailures.push({
            worker,
            scope: "totals",
            errors: failureHistoryErrors,
          });
        } else {
          historicalRecordedFailureCount +=
            totalFailures(summary.totals) - totalFailures(summary.segment);
        }
      }
      if (!segmentErrors.length) {
        mergeCounters(aggregate, summary.segment);
        currentCoverage[worker] = summary.segment.cardCoverage;
      } else {
        currentCoverage[worker] = Object.fromEntries(AUGMENT_IDS.map((id) => [id, 0])) as Record<
          AugmentId,
          number
        >;
      }
    } else {
      currentCoverage[worker] = Object.fromEntries(AUGMENT_IDS.map((id) => [id, 0])) as Record<
        AugmentId,
        number
      >;
    }
  }

  const workerFailures = SOAK_WORKERS.filter((worker) => {
    const summary = workerSummaries[worker];
    return (
      summary.exitCode !== 0 ||
      summary.reportedExitCode !== 0 ||
      summary.status !== "succeeded" ||
      !summary.segment
    );
  });
  const hardWorkerFailures = SOAK_WORKERS.filter((worker) => {
    const summary = workerSummaries[worker];
    return (
      summary.exitCode !== 0 ||
      summary.reportedExitCode !== 0 ||
      summary.status === "failed" ||
      summary.status === "missing_final" ||
      !summary.segment
    );
  });
  const durationFailures = SOAK_WORKERS.filter(
    (worker) => (workerSummaries[worker].segmentActiveMs ?? 0) < options.durationSeconds * 1_000,
  );
  const strictFourHourRun = options.profile === "soak" && options.durationSeconds >= 14_400;
  const strictCoverageFailures = strictFourHourRun
    ? (["balance", "rules", "animation"] as const).filter(
        (worker) => !allCardsCovered(currentCoverage[worker]),
      )
    : [];
  const balanceAggregate = (
    workerSummaries.balance.state as { aggregate?: TournamentAggregate } | null
  )?.aggregate;
  const balanceCardActivity = Object.fromEntries(
    SIMULATION_ELIGIBLE_AUGMENT_IDS.map((id) => {
      const stats = balanceAggregate?.cards[id];
      return [
        id,
        {
          games: stats?.games ?? 0,
          opportunityGames: stats?.opportunityGames ?? 0,
          triggerGames: stats?.triggerGames ?? 0,
          triggers: stats?.triggers ?? 0,
        },
      ];
    }),
  ) as Record<
    AugmentId,
    { games: number; opportunityGames: number; triggerGames: number; triggers: number }
  >;
  const requiredActiveOpportunityMissing = strictFourHourRun
    ? REQUIRED_V3_ACTIVE_SIMULATION_IDS.filter(
        (id) => balanceCardActivity[id].opportunityGames <= 0,
      )
    : [];
  const requiredActiveUseMissing = strictFourHourRun
    ? REQUIRED_V3_ACTIVE_SIMULATION_IDS.filter(
        (id) => balanceCardActivity[id].triggers <= 0,
      )
    : [];
  const animationState = workerSummaries.animation.state as {
    segmentCanonicalFlowChecks?: number;
    segmentPhaseVisits?: Record<string, number>;
  } | null;
  const animationPhaseCoverageMissing = strictFourHourRun
    ? AUGMENT_MOTION_PHASES.filter(
        (phase) => (animationState?.segmentPhaseVisits?.[phase] ?? 0) <= 0,
      )
    : [];
  const animationFlowMissing = strictFourHourRun &&
    (animationState?.segmentCanonicalFlowChecks ?? 0) <= 0;
  const balanceStabilityScheduleIncomplete = strictFourHourRun &&
    (workerSummaries.balance.segment?.loops ?? 0) <
      BALANCE_STABILITY_SCHEDULE_GROUPS;
  const balanceGameAccountingInvalid = strictFourHourRun &&
    (workerSummaries.balance.segment?.games ?? 0) !==
      (workerSummaries.balance.segment?.loops ?? 0) * 4;
  const balanceCappedGames = hasCappedBalanceGames(
    workerSummaries.balance.segment?.cappedGames,
  );
  const noRecordedFailures = totalFailures(aggregate) === 0;
  const technicalIntegrity =
    !failureStop &&
    sourceUnchanged &&
    missingFinals.length === 0 &&
    counterValidationFailures.length === 0 &&
    hardWorkerFailures.length === 0 &&
    noRecordedFailures &&
    historicalRecordedFailureCount === 0;
  const technicalSuccess =
    technicalIntegrity &&
    !operatorStop &&
    workerFailures.length === 0 &&
    durationFailures.length === 0;
  const runSucceeded =
    technicalSuccess &&
    strictCoverageFailures.length === 0 &&
    requiredActiveOpportunityMissing.length === 0 &&
    requiredActiveUseMissing.length === 0 &&
    animationPhaseCoverageMissing.length === 0 &&
    !animationFlowMissing &&
    !balanceStabilityScheduleIncomplete &&
    !balanceGameAccountingInvalid &&
    !balanceCappedGames;
  const continuousGatePassed = strictFourHourRun && runSucceeded;
  const finalStatus = !technicalIntegrity
    ? "failed"
    : operatorStop
      ? "stopped"
      : runSucceeded
        ? "succeeded"
        : "failed";

  segment.status = finalStatus;
  segment.finishedAt = finishedAt;
  segment.measuredActiveMs = Math.max(0, finishedAt.epochMs - segment.startedAt.epochMs);
  segment.workerExitCodes = exitCodes;
  const segmentFinalPath = resolve(runDir, "segments", segmentId, "final.json");
  const finalEvidence = {
    purpose: "product_stability" as const,
    schemaVersion: SOAK_SCHEMA_VERSION,
    algorithmVersion: BALANCE_ALGORITHM_VERSION,
    engineRulesFingerprint: BALANCE_ENGINE_RULES_FINGERPRINT,
    runId: manifest.runId,
    segmentId,
    status: finalStatus,
    profile: options.profile,
    startedAt: segment.startedAt,
    finishedAt,
    measuredSupervisorActiveMs: segment.measuredActiveMs,
    requiredContinuousSeconds: options.durationSeconds,
    configuration: {
      checkpointIntervalSeconds: options.checkpointIntervalSeconds,
      workerHangTimeoutSeconds: options.workerHangTimeoutSeconds,
      supervisorHeartbeatGapLimitMs: SUPERVISOR_HEARTBEAT_GAP_LIMIT_MS,
      sourceFingerprintIntervalMs: SOURCE_FINGERPRINT_INTERVAL_MS,
      seed: options.seed,
      balanceTournament: manifest.balanceTournament,
      balanceStabilityScheduleGroups: BALANCE_STABILITY_SCHEDULE_GROUPS,
    },
    source: {
      start: source,
      end: endingSource,
      unchanged: sourceUnchanged,
      mutationDetectedAt: sourceMutationDetectedAt,
    },
    processExitCodes: exitCodes,
    continuity: {
      maximumSupervisorMonotonicGapMs,
      maximumSupervisorWallGapMs,
      allowedGapMs: SUPERVISOR_HEARTBEAT_GAP_LIMIT_MS,
      wallClockMovedBackward,
      breakDetectedAt: continuityBreakDetectedAt,
    },
    workers: workerSummaries,
    aggregate,
    coverage: {
      catalogSize: SIMULATION_CATALOG_SIZE,
      simulationEligibleSize: SIMULATION_ELIGIBLE_COUNT,
      excludedClockCount: EXCLUDED_CLOCK_AUGMENT_IDS.length,
      excludedClockAugmentIds: [...EXCLUDED_CLOCK_AUGMENT_IDS],
      byWorker: currentCoverage,
      overallAllCards: allCardsCovered(aggregate.cardCoverage),
      missingOverall: uncoveredCards(aggregate.cardCoverage),
      strictWorkersMissing: Object.fromEntries(
        (["balance", "rules", "animation"] as const).map((worker) => [
          worker,
          uncoveredCards(currentCoverage[worker]),
        ]),
      ),
    },
    simulationActivity: {
      activeEligibleAugmentIds: SIMULATION_ELIGIBLE_AUGMENTS.filter(
        (definition) => definition.activation === "active",
      ).map((definition) => definition.id),
      requiredV3ActiveAugmentIds: [...REQUIRED_V3_ACTIVE_SIMULATION_IDS],
      requiredActiveOpportunityMissing,
      requiredActiveUseMissing,
      byEligibleAugment: balanceCardActivity,
    },
    acceptance: {
      strictFourHourRun,
      continuousGatePassed,
      interruptionTimeCounted: false,
      resumeSegmentsCountedTowardContinuousGate: false,
      reasons: {
        operatorStop,
        failureStop,
        stopRequestReadError,
        supervisorFailure,
        workerLogFailures,
        sourceChanged: !sourceUnchanged,
        continuityBroken: continuityBreakDetectedAt !== null,
        missingFinals,
        counterValidationFailures,
        workerFailures,
        hardWorkerFailures,
        durationFailures,
        strictCoverageFailures,
        requiredActiveOpportunityMissing,
        requiredActiveUseMissing,
        animationPhaseCoverageMissing,
        animationFlowMissing,
        balanceStabilityScheduleIncomplete,
        balanceGameAccountingInvalid,
        balanceCappedGames,
        watchdogFailures,
        recordedFailureCount: totalFailures(aggregate),
        historicalRecordedFailureCount,
      },
    },
    evidencePaths: {
      manifest: resolve(runDir, "manifest.json"),
      checkpoint: resolve(runDir, "checkpoint.json"),
      segmentFinal: segmentFinalPath,
      workerRoot: resolve(runDir, "workers"),
    },
  };
  await atomicJson(segmentFinalPath, finalEvidence);
  await atomicJson(resolve(runDir, "final.json"), finalEvidence);
  await atomicJson(resolve(runDir, "checkpoint.json"), {
    schemaVersion: SOAK_SCHEMA_VERSION,
    runId: manifest.runId,
    segmentId,
    status: finalStatus,
    updatedAt: finishedAt,
    source: endingSource,
    workers: await readWorkerCheckpoints(runDir, segmentId),
    processExitCodes: exitCodes,
  } satisfies SupervisorCheckpoint);
  await atomicJson(resolve(runDir, "manifest.json"), manifest);
  await atomicJson(resolve(options.outputRoot, "latest-run.json"), {
    schemaVersion: SOAK_SCHEMA_VERSION,
    runId: manifest.runId,
    runDir,
    segmentId,
    status: finalStatus,
    updatedAt: finishedAt,
  });
  console.log(
    `soak status=${finalStatus} segment=${segmentId} activeMs=${segment.measuredActiveMs} ` +
      `games=${aggregate.games} moves=${aggregate.moves} nodes=${aggregate.searchNodes} ` +
      `currentFailures=${totalFailures(aggregate)} historicalFailures=${historicalRecordedFailureCount} ` +
      `evidence=${resolve(runDir, "final.json")}`,
  );
  process.exitCode = finalStatus === "succeeded" ? 0 : finalStatus === "stopped" ? 130 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}

export { parseCli };
