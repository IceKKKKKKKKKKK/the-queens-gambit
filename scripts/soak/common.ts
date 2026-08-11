import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";

import { AUGMENT_IDS, type AugmentId } from "../../lib/augments.ts";
import { SIMULATION_ELIGIBLE_AUGMENT_IDS } from "../balance/simulation-pool.ts";

const execFileAsync = promisify(execFile);

export const SOAK_SCHEMA_VERSION = 2 as const;
export const SOAK_WORKERS = ["balance", "rules", "api", "animation"] as const;
export type SoakWorkerName = (typeof SOAK_WORKERS)[number];
export type SoakProfile = "soak" | "smoke";

export interface TimeEvidence {
  utc: string;
  eastern: string;
  epochMs: number;
}

export interface FailureCounters {
  exceptions: number;
  hangs: number;
  replayDivergences: number;
  privacyLeaks: number;
  duplicateSettlements: number;
  childProcessFailures: number;
  invariantFailures: number;
}

export interface SoakCounters {
  loops: number;
  games: number;
  moves: number;
  searchNodes: number;
  cappedGames: number;
  assertions: number;
  cardCoverage: Record<AugmentId, number>;
  failures: FailureCounters;
}

export interface FailureSample {
  at: TimeEvidence;
  category: keyof FailureCounters;
  message: string;
  context?: Record<string, unknown>;
}

export interface WorkerCheckpoint<TState = unknown> {
  schemaVersion: typeof SOAK_SCHEMA_VERSION;
  worker: SoakWorkerName;
  runId: string;
  segmentId: string;
  profile: SoakProfile;
  status: "running" | "succeeded" | "failed" | "stopped";
  originalStartedAt: TimeEvidence;
  segmentStartedAt: TimeEvidence;
  updatedAt: TimeEvidence;
  segmentActiveMs: number;
  accumulatedActiveMs: number;
  totals: SoakCounters;
  segment: SoakCounters;
  failureSamples: FailureSample[];
  state: TState;
}

export interface WorkerFinal<TState = unknown> extends WorkerCheckpoint<TState> {
  finishedAt: TimeEvidence;
  exitCode: number;
}

export interface WorkerArguments {
  runDir: string;
  workerDir: string;
  runId: string;
  segmentId: string;
  durationSeconds: number;
  checkpointIntervalSeconds: number;
  seed: number;
  profile: SoakProfile;
  resume: boolean;
  stopPath: string;
}

export interface WorkspaceFingerprint {
  commit: string;
  dirty: boolean;
  trackedDiffSha256: string;
  workspaceSha256: string;
  untrackedFileCount: number;
  runtimeSha256: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
  architecture: string;
  installedDependencyLockSha256: string;
}

function easternOffsetName(date: Date) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    timeZoneName: "longOffset",
  });
  const zone = formatter.formatToParts(date).find((part) => part.type === "timeZoneName")?.value;
  const match = zone?.match(/^GMT([+-]\d{2}:\d{2})$/);
  if (!match) throw new Error(`Cannot resolve America/New_York offset from ${zone ?? "unknown"}.`);
  return match[1];
}

export function timeEvidence(date = new Date()): TimeEvidence {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const milliseconds = String(date.getUTCMilliseconds()).padStart(3, "0");
  return {
    utc: date.toISOString(),
    eastern:
      `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}` +
      `.${milliseconds}${easternOffsetName(date)}[America/New_York]`,
    epochMs: date.getTime(),
  };
}

export function emptyFailures(): FailureCounters {
  return {
    exceptions: 0,
    hangs: 0,
    replayDivergences: 0,
    privacyLeaks: 0,
    duplicateSettlements: 0,
    childProcessFailures: 0,
    invariantFailures: 0,
  };
}

export function emptyCardCoverage(): Record<AugmentId, number> {
  return Object.fromEntries(AUGMENT_IDS.map((id) => [id, 0])) as Record<AugmentId, number>;
}

export function emptyCounters(): SoakCounters {
  return {
    loops: 0,
    games: 0,
    moves: 0,
    searchNodes: 0,
    cappedGames: 0,
    assertions: 0,
    cardCoverage: emptyCardCoverage(),
    failures: emptyFailures(),
  };
}

export function cloneCounters(counters: SoakCounters): SoakCounters {
  return structuredClone(counters);
}

export function mergeCounters(target: SoakCounters, addition: SoakCounters) {
  target.loops += addition.loops;
  target.games += addition.games;
  target.moves += addition.moves;
  target.searchNodes += addition.searchNodes;
  target.cappedGames += addition.cappedGames;
  target.assertions += addition.assertions;
  for (const id of AUGMENT_IDS) target.cardCoverage[id] += addition.cardCoverage[id];
  for (const key of Object.keys(target.failures) as Array<keyof FailureCounters>) {
    target.failures[key] += addition.failures[key];
  }
  return target;
}

export function totalFailures(counters: SoakCounters) {
  return Object.values(counters.failures).reduce((sum, count) => sum + count, 0);
}

export function counterValidationErrors(value: unknown) {
  const errors: string[] = [];
  if (!value || typeof value !== "object") return ["counters is not an object"];
  const counters = value as Partial<SoakCounters>;
  for (const key of ["loops", "games", "moves", "searchNodes", "cappedGames", "assertions"] as const) {
    const count = counters[key];
    if (!Number.isSafeInteger(count) || (count ?? -1) < 0) errors.push(`${key} is invalid`);
  }
  if (!counters.cardCoverage || typeof counters.cardCoverage !== "object") {
    errors.push("cardCoverage is invalid");
  } else {
    for (const id of AUGMENT_IDS) {
      const count = counters.cardCoverage[id];
      if (!Number.isSafeInteger(count) || (count ?? -1) < 0) {
        errors.push(`cardCoverage.${id} is invalid`);
      }
    }
  }
  if (!counters.failures || typeof counters.failures !== "object") {
    errors.push("failures is invalid");
  } else {
    for (const key of Object.keys(emptyFailures()) as Array<keyof FailureCounters>) {
      const count = counters.failures[key];
      if (!Number.isSafeInteger(count) || (count ?? -1) < 0) {
        errors.push(`failures.${key} is invalid`);
      }
    }
  }
  return errors;
}

export function recordFailure(
  counters: SoakCounters,
  samples: FailureSample[],
  category: keyof FailureCounters,
  error: unknown,
  context?: Record<string, unknown>,
) {
  counters.failures[category] += 1;
  if (samples.length < 100) {
    samples.push({
      at: timeEvidence(),
      category,
      message: error instanceof Error ? error.message : String(error),
      ...(context ? { context } : {}),
    });
  }
}

export async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, path);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") || attempt >= 20) {
        throw error;
      }
      // Windows can briefly deny replacement while the supervisor has the old
      // checkpoint open for reading. Keep the complete temp file and retry.
      await sleep(10 + attempt * 10);
    }
  }
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function stopWasRequested(stopPath: string) {
  return pathExists(stopPath);
}

export function sleep(milliseconds: number) {
  return new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function parseArgumentMap(argv: readonly string[]) {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (const argument of argv) {
    if (argument === "--resume") {
      flags.add("resume");
      continue;
    }
    const match = argument.match(/^--([a-z-]+)=(.+)$/);
    if (!match) throw new Error(`Unknown soak worker argument: ${argument}.`);
    values.set(match[1], match[2]);
  }
  return { flags, values };
}

export function parseWorkerArguments(argv: readonly string[]): WorkerArguments {
  const { flags, values } = parseArgumentMap(argv);
  const required = (key: string) => {
    const value = values.get(key);
    if (!value) throw new Error(`Missing --${key}.`);
    return value;
  };
  const number = (key: string, minimum: number) => {
    const value = Number(required(key));
    if (!Number.isFinite(value) || value < minimum) throw new Error(`Invalid --${key}.`);
    return value;
  };
  const integer = (key: string, minimum: number) => {
    const value = number(key, minimum);
    if (!Number.isSafeInteger(value)) throw new Error(`--${key} must be an integer.`);
    return value;
  };
  const profile = required("profile");
  if (profile !== "soak" && profile !== "smoke") throw new Error("Invalid --profile.");
  return {
    runDir: resolve(required("run-dir")),
    workerDir: resolve(required("worker-dir")),
    runId: required("run-id"),
    segmentId: required("segment-id"),
    durationSeconds: number("duration-seconds", 0.1),
    checkpointIntervalSeconds: number("checkpoint-interval-seconds", 0.1),
    seed: integer("seed", 0),
    profile,
    resume: flags.has("resume"),
    stopPath: resolve(required("stop-path")),
  };
}

export class WorkerJournal<TState> {
  readonly checkpointPath: string;
  readonly finalPath: string;
  readonly segmentStartedAt = timeEvidence();
  readonly segmentStartedMono = performance.now();
  readonly totals: SoakCounters;
  readonly segment = emptyCounters();
  readonly failureSamples: FailureSample[];
  readonly originalStartedAt: TimeEvidence;
  state: TState;
  private priorAccumulatedActiveMs: number;
  private lastCheckpointMono = 0;

  private constructor(
    readonly worker: SoakWorkerName,
    readonly args: WorkerArguments,
    state: TState,
    previous: WorkerCheckpoint<TState> | null,
  ) {
    this.checkpointPath = resolve(args.workerDir, "checkpoint.json");
    this.finalPath = resolve(args.workerDir, "final.json");
    this.state = state;
    this.totals = previous ? cloneCounters(previous.totals) : emptyCounters();
    this.failureSamples = previous ? [...previous.failureSamples] : [];
    this.originalStartedAt = previous?.originalStartedAt ?? this.segmentStartedAt;
    this.priorAccumulatedActiveMs = previous?.accumulatedActiveMs ?? 0;
  }

  static async open<TState>(
    worker: SoakWorkerName,
    args: WorkerArguments,
    initialState: () => TState,
    validateState?: (state: unknown) => TState,
  ) {
    await mkdir(args.workerDir, { recursive: true });
    const checkpointPath = resolve(args.workerDir, "checkpoint.json");
    let previous: WorkerCheckpoint<TState> | null = null;
    if (args.resume && await pathExists(checkpointPath)) {
      previous = await readJson<WorkerCheckpoint<TState>>(checkpointPath);
      if (
        previous.schemaVersion !== SOAK_SCHEMA_VERSION ||
        previous.worker !== worker ||
        previous.runId !== args.runId ||
        previous.profile !== args.profile ||
        !Number.isFinite(previous.accumulatedActiveMs) ||
        previous.accumulatedActiveMs < 0 ||
        !Array.isArray(previous.failureSamples)
      ) {
        throw new Error(`Cannot resume incompatible ${worker} checkpoint.`);
      }
      const counterErrors = counterValidationErrors(previous.totals);
      if (counterErrors.length) {
        throw new Error(`Cannot resume invalid ${worker} counters: ${counterErrors.join(", ")}.`);
      }
    }
    const state = previous
      ? validateState
        ? validateState(previous.state)
        : previous.state
      : initialState();
    const journal = new WorkerJournal(worker, args, state, previous);
    await journal.write("running");
    return journal;
  }

  segmentActiveMs() {
    return performance.now() - this.segmentStartedMono;
  }

  deadlineReached() {
    return this.segmentActiveMs() >= this.args.durationSeconds * 1_000;
  }

  addCounters(delta: SoakCounters) {
    mergeCounters(this.totals, delta);
    mergeCounters(this.segment, delta);
  }

  fail(
    category: keyof FailureCounters,
    error: unknown,
    context?: Record<string, unknown>,
  ) {
    recordFailure(this.totals, this.failureSamples, category, error, context);
    this.segment.failures[category] += 1;
  }

  private checkpoint(status: WorkerCheckpoint<TState>["status"]): WorkerCheckpoint<TState> {
    const active = this.segmentActiveMs();
    return {
      schemaVersion: SOAK_SCHEMA_VERSION,
      worker: this.worker,
      runId: this.args.runId,
      segmentId: this.args.segmentId,
      profile: this.args.profile,
      status,
      originalStartedAt: this.originalStartedAt,
      segmentStartedAt: this.segmentStartedAt,
      updatedAt: timeEvidence(),
      segmentActiveMs: active,
      accumulatedActiveMs: this.priorAccumulatedActiveMs + active,
      totals: cloneCounters(this.totals),
      segment: cloneCounters(this.segment),
      failureSamples: [...this.failureSamples],
      state: structuredClone(this.state),
    };
  }

  async write(status: WorkerCheckpoint<TState>["status"] = "running", force = false) {
    const now = performance.now();
    if (
      !force &&
      status === "running" &&
      now - this.lastCheckpointMono < this.args.checkpointIntervalSeconds * 1_000
    ) {
      return;
    }
    this.lastCheckpointMono = now;
    await atomicJson(this.checkpointPath, this.checkpoint(status));
  }

  async finish(status: "succeeded" | "failed" | "stopped", exitCode: number) {
    const checkpoint = this.checkpoint(status);
    const final: WorkerFinal<TState> = {
      ...checkpoint,
      finishedAt: timeEvidence(),
      exitCode,
    };
    await atomicJson(this.checkpointPath, checkpoint);
    await atomicJson(
      resolve(this.args.workerDir, "segments", this.args.segmentId, "final.json"),
      final,
    );
    await atomicJson(this.finalPath, final);
    return final;
  }
}

async function gitOutput(repositoryRoot: string, args: string[], encoding: BufferEncoding = "utf8") {
  const result = await execFileAsync("git", args, {
    cwd: repositoryRoot,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return result.stdout;
}

export async function workspaceFingerprint(repositoryRoot: string): Promise<WorkspaceFingerprint> {
  const root = resolve(repositoryRoot);
  const commit = String(await gitOutput(root, ["rev-parse", "HEAD"])).trim();
  const diff = String(await gitOutput(root, ["diff", "--binary", "HEAD", "--", "."]));
  const untrackedOutput = String(
    await gitOutput(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  );
  const untracked = untrackedOutput.split("\0").filter(Boolean).sort();
  const trackedDiffSha256 = createHash("sha256").update(diff).digest("hex");
  const hash = createHash("sha256").update(commit).update("\0").update(diff).update("\0");
  for (const relativePath of untracked) {
    const absolutePath = resolve(root, relativePath);
    if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) {
      throw new Error(`Untracked path escaped repository root: ${relativePath}.`);
    }
    hash.update(relativePath).update("\0").update(await readFile(absolutePath)).update("\0");
  }
  const installedLockPath = resolve(root, "node_modules", ".package-lock.json");
  const installedDependencyLockSha256 = await pathExists(installedLockPath)
    ? createHash("sha256").update(await readFile(installedLockPath)).digest("hex")
    : "missing";
  const runtimeSha256 = createHash("sha256")
    .update(process.version)
    .update("\0")
    .update(process.platform)
    .update("\0")
    .update(process.arch)
    .update("\0")
    .update(installedDependencyLockSha256)
    .digest("hex");
  return {
    commit,
    dirty: diff.length > 0 || untracked.length > 0,
    trackedDiffSha256,
    workspaceSha256: hash.digest("hex"),
    untrackedFileCount: untracked.length,
    runtimeSha256,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    installedDependencyLockSha256,
  };
}

export function allCardsCovered(coverage: Record<AugmentId, number>) {
  return SIMULATION_ELIGIBLE_AUGMENT_IDS.every((id) => coverage[id] > 0);
}

export function uncoveredCards(coverage: Record<AugmentId, number>) {
  return SIMULATION_ELIGIBLE_AUGMENT_IDS.filter((id) => coverage[id] <= 0);
}
