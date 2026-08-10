import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { AUGMENT_IDS, getAugmentDefinition } from "../../lib/augments.ts";
import {
  AUGMENT_DRAFT_MOTION_MS,
  augmentDraftPhaseDuration,
  canInteractWithAugment,
  reduceAugmentDraftMotion,
  shouldAnimateAugmentBurn,
  type AugmentDraftMotionEvent,
  type AugmentDraftMotionPhase,
  type AugmentDraftMotionState,
} from "../../app/components/augmentMotion.ts";
import { SeededRandom } from "../balance/visible-policy.ts";
import {
  WorkerJournal,
  emptyCounters,
  parseWorkerArguments,
  stopWasRequested,
  totalFailures,
} from "./common.ts";

interface AnimationWorkerState {
  batch: number;
  canonicalFlowChecks: number;
  phaseVisits: Record<AugmentDraftMotionPhase, number>;
  segmentId: string;
  segmentCanonicalFlowChecks: number;
  segmentPhaseVisits: Record<AugmentDraftMotionPhase, number>;
}

const PHASES: AugmentDraftMotionPhase[] = [
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
];

const EVENTS: AugmentDraftMotionEvent[] = [
  { type: "DEAL_FINISHED" },
  { type: "LOCK_REQUESTED" },
  { type: "FADE_FINISHED" },
  { type: "CENTER_FINISHED" },
  { type: "TURN_FINISHED" },
  { type: "SERVER_LOCKED" },
  { type: "SERVER_LOCKED_PASSIVE" },
  { type: "SERVER_REJECTED" },
  { type: "SERVER_TIMEOUT" },
  { type: "DOCK_FINISHED" },
  { type: "RECOVERY_FINISHED" },
];

let assertionCount = 0;

function invariant(condition: unknown, message: string): asserts condition {
  assertionCount += 1;
  if (!condition) throw new Error(message);
}

function applySequence(
  events: readonly AugmentDraftMotionEvent[],
  initial: AugmentDraftMotionState = { phase: "choosing", serverAcknowledged: false },
  phaseVisits?: Record<AugmentDraftMotionPhase, number>,
) {
  let state = initial;
  let settledTransitions = 0;
  if (phaseVisits) phaseVisits[state.phase] += 1;
  for (const event of events) {
    const previous = state;
    state = reduceAugmentDraftMotion(state, event);
    if (previous.phase !== "settled" && state.phase === "settled") settledTransitions += 1;
    invariant(!(state.serverAcknowledged && state.serverRejected), "Motion state has conflicting server flags.");
    if (phaseVisits) phaseVisits[state.phase] += 1;
  }
  invariant(settledTransitions <= 1, "One draft lifecycle settled more than once.");
  return state;
}

function verifyCanonicalFlows() {
  const phaseVisits = Object.fromEntries(PHASES.map((phase) => [phase, 0])) as Record<
    AugmentDraftMotionPhase,
    number
  >;
  const dealt = applySequence(
    [{ type: "DEAL_FINISHED" }],
    { phase: "dealing", serverAcknowledged: false },
    phaseVisits,
  );
  invariant(dealt.phase === "choosing", "Deal completion did not enter choosing.");

  const fast = applySequence([
    { type: "LOCK_REQUESTED" },
    { type: "SERVER_LOCKED" },
    { type: "FADE_FINISHED" },
    { type: "CENTER_FINISHED" },
    { type: "TURN_FINISHED" },
    { type: "DOCK_FINISHED" },
  ], undefined, phaseVisits);
  invariant(fast.phase === "settled" && fast.serverAcknowledged, "Fast acknowledgement did not settle.");

  const late = applySequence([
    { type: "LOCK_REQUESTED" },
    { type: "FADE_FINISHED" },
    { type: "CENTER_FINISHED" },
    { type: "TURN_FINISHED" },
    { type: "SERVER_TIMEOUT" },
    { type: "RECOVERY_FINISHED" },
    { type: "SERVER_LOCKED" },
    { type: "DOCK_FINISHED" },
  ], undefined, phaseVisits);
  invariant(late.phase === "settled" && late.serverAcknowledged, "Late acknowledgement did not settle.");

  const rejected = applySequence([
    { type: "LOCK_REQUESTED" },
    { type: "SERVER_REJECTED" },
    { type: "RECOVERY_FINISHED" },
  ], undefined, phaseVisits);
  invariant(rejected.phase === "choosing" && rejected.serverRejected, "Rejection did not release choice.");

  const passive = applySequence([{ type: "SERVER_LOCKED_PASSIVE" }], undefined, phaseVisits);
  invariant(passive.phase === "settled" && passive.serverAcknowledged, "Passive lock did not settle.");
  invariant(
    PHASES.every((phase) => phaseVisits[phase] > 0),
    "Canonical reducer flows did not actually traverse every declared phase.",
  );
  return phaseVisits;
}

function verifyDurationsAndCards() {
  invariant(
    AUGMENT_DRAFT_MOTION_MS.awaitServerMax === 8_000 &&
      augmentDraftPhaseDuration("awaiting-server", 3, false) === 8_000,
    "Late acknowledgement threshold is no longer exactly eight seconds.",
  );
  for (const phase of PHASES) {
    for (const optionCount of [0, 1, 3, 9]) {
      const regular = augmentDraftPhaseDuration(phase, optionCount, false);
      const reduced = augmentDraftPhaseDuration(phase, optionCount, true);
      invariant(regular === null || (Number.isFinite(regular) && regular >= 0), `Invalid ${phase} duration.`);
      invariant(reduced === null || reduced === 0, `Reduced motion retained a delay in ${phase}.`);
    }
  }
  invariant(shouldAnimateAugmentBurn(1, 0, 1), "One-charge exhaustion did not burn.");
  invariant(!shouldAnimateAugmentBurn(1, 1, 1), "Stable exhausted state replayed burn.");
  invariant(!shouldAnimateAugmentBurn(2, 0, 1), "Multi-charge card burned early.");
  invariant(!shouldAnimateAugmentBurn(1, undefined, 1), "Reconnect state replayed burn.");

  for (const id of AUGMENT_IDS) {
    const definition = getAugmentDefinition(id);
    const ownTurn = canInteractWithAugment(definition, {
      enabled: true,
      isOwnTurn: true,
      pendingReconId: id,
    });
    const disabled = canInteractWithAugment(definition, {
      enabled: false,
      isOwnTurn: true,
      pendingReconId: id,
    });
    const offTurnWithoutRecon = canInteractWithAugment(definition, {
      enabled: true,
      isOwnTurn: false,
      pendingReconId: null,
    });
    invariant(!disabled, `${id} remained interactive while disabled.`);
    invariant(!offTurnWithoutRecon, `${id} remained interactive without turn or recon ownership.`);
    if (definition.activation !== "active") {
      invariant(!ownTurn, `${id} exposed an automatic/setup button.`);
    } else if (definition.effect.kind === "movement" || definition.effect.kind === "exchange") {
      invariant(ownTurn, `${id} active movement control was unavailable on its owner's turn.`);
    } else if (
      definition.effect.kind === "reconnaissance" &&
      definition.effect.mode === "choose_enemy"
    ) {
      invariant(ownTurn, `${id} pending reconnaissance target was not interactive.`);
    }
  }
}

function fuzzBatch(seed: string, iterations: number) {
  const random = new SeededRandom(seed);
  let state: AugmentDraftMotionState = { phase: "dealing", serverAcknowledged: false };
  let settledTransitions = 0;
  const phaseVisits = Object.fromEntries(PHASES.map((phase) => [phase, 0])) as Record<
    AugmentDraftMotionPhase,
    number
  >;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    if (random.next() < 0.025) {
      state = {
        phase: random.next() < 0.5 ? "dealing" : "choosing",
        serverAcknowledged: false,
        serverRejected: false,
      };
      settledTransitions = 0;
    }
    const event = EVENTS[random.int(EVENTS.length)];
    const previous = state;
    const next = reduceAugmentDraftMotion(previous, event);
    phaseVisits[next.phase] += 1;
    invariant(PHASES.includes(next.phase), `Reducer returned unknown phase ${String(next.phase)}.`);
    invariant(!(next.serverAcknowledged && next.serverRejected), "Reducer returned conflicting flags.");
    if (previous.phase === "settled") {
      invariant(next.phase === "settled", "Settled draft was not absorbing.");
    }
    if (previous.phase !== "settled" && next.phase === "settled") settledTransitions += 1;
    invariant(settledTransitions <= 1, "Random lifecycle settled more than once.");
    if (event.type === "LOCK_REQUESTED" && previous.phase !== "choosing") {
      invariant(next.phase === previous.phase, "Duplicate/out-of-phase lock restarted presentation.");
    }
    state = next;
  }
  return { phaseVisits };
}

async function run() {
  const args = parseWorkerArguments(process.argv.slice(2));
  const journal = await WorkerJournal.open<AnimationWorkerState>(
    "animation",
    args,
    () => ({
      batch: 0,
      canonicalFlowChecks: 0,
      phaseVisits: Object.fromEntries(PHASES.map((phase) => [phase, 0])) as Record<
        AugmentDraftMotionPhase,
        number
      >,
      segmentId: args.segmentId,
      segmentCanonicalFlowChecks: 0,
      segmentPhaseVisits: Object.fromEntries(PHASES.map((phase) => [phase, 0])) as Record<
        AugmentDraftMotionPhase,
        number
      >,
    }),
    (value) => {
      const candidate = value as Partial<AnimationWorkerState>;
      if (
        !Number.isSafeInteger(candidate?.batch) ||
        !Number.isSafeInteger(candidate?.canonicalFlowChecks) ||
        !candidate.phaseVisits ||
        !PHASES.every((phase) => Number.isSafeInteger(candidate.phaseVisits?.[phase])) ||
        typeof candidate.segmentId !== "string" ||
        !Number.isSafeInteger(candidate.segmentCanonicalFlowChecks) ||
        !candidate.segmentPhaseVisits ||
        !PHASES.every((phase) => Number.isSafeInteger(candidate.segmentPhaseVisits?.[phase]))
      ) {
        throw new Error("Invalid animation worker state.");
      }
      return candidate as AnimationWorkerState;
    },
  );
  if (journal.state.segmentId !== args.segmentId) {
    journal.state.segmentId = args.segmentId;
    journal.state.segmentCanonicalFlowChecks = 0;
    journal.state.segmentPhaseVisits = Object.fromEntries(PHASES.map((phase) => [phase, 0])) as Record<
      AugmentDraftMotionPhase,
      number
    >;
  }
  const iterations = args.profile === "smoke" ? 2_000 : 100_000;
  let completedUnit = false;
  let stopped = false;

  while (true) {
    if (completedUnit && (journal.deadlineReached() || await stopWasRequested(args.stopPath))) {
      stopped = await stopWasRequested(args.stopPath);
      break;
    }
    try {
      const assertionsBefore = assertionCount;
      const canonicalVisits = verifyCanonicalFlows();
      verifyDurationsAndCards();
      const result = fuzzBatch(`${args.seed}:animation:${journal.state.batch}`, iterations);
      journal.state.canonicalFlowChecks += 5;
      journal.state.segmentCanonicalFlowChecks += 5;
      for (const phase of PHASES) {
        journal.state.phaseVisits[phase] += result.phaseVisits[phase] + canonicalVisits[phase];
        journal.state.segmentPhaseVisits[phase] +=
          result.phaseVisits[phase] + canonicalVisits[phase];
      }
      const delta = emptyCounters();
      delta.loops = 1;
      delta.assertions = assertionCount - assertionsBefore;
      for (const id of AUGMENT_IDS) delta.cardCoverage[id] += 1;
      journal.addCounters(delta);
    } catch (error) {
      journal.fail("invariantFailures", error, { batch: journal.state.batch });
    }
    journal.state.batch += 1;
    completedUnit = true;
    await journal.write();
    if (totalFailures(journal.segment) > 0) break;
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
