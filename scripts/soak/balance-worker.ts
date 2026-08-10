import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { AUGMENT_IDS } from "../../lib/augments.ts";
import {
  buildRoundRobinPairings,
  createEmptyAggregate,
  playMirrorGroup,
  recordMirrorGroup,
  scheduleGroup,
  strengthModelFromAggregate,
  type Pairing,
  type TournamentAggregate,
  type TournamentOptions,
} from "../balance/tournament.ts";
import {
  WorkerJournal,
  emptyCounters,
  parseWorkerArguments,
  stopWasRequested,
  totalFailures,
} from "./common.ts";

interface BalanceWorkerState {
  cycle: number;
  pairIndex: number;
  aggregate: TournamentAggregate;
  tournament: TournamentOptions;
}

export const FORMAL_SOAK_MINIMUM_ACTIVE_MS = 14_400_000;

export type BalanceWorkerStopReason = "continue" | "complete" | "requested" | "failed";

export function balanceWorkerStopDecision(input: {
  profile: "soak" | "smoke";
  durationSeconds: number;
  segmentActiveMs: number;
  segmentCompletedGroups: number;
  requiredRoundRobinGroups: number;
  stopRequested: boolean;
  failed: boolean;
}): BalanceWorkerStopReason {
  if (input.failed) return "failed";
  if (input.stopRequested) return "requested";

  const requiredActiveMs = input.durationSeconds * 1_000;
  if (input.segmentActiveMs < requiredActiveMs) return "continue";

  const formalSoak = input.profile === "soak" && requiredActiveMs >= FORMAL_SOAK_MINIMUM_ACTIVE_MS;
  const requiredGroups = formalSoak ? input.requiredRoundRobinGroups : 1;
  return input.segmentCompletedGroups >= requiredGroups ? "complete" : "continue";
}

function orderedPairingsForEarlyCoverage() {
  const remaining = buildRoundRobinPairings().sort((first, second) =>
    first.pairKey.localeCompare(second.pairKey)
  );
  const ordered: Pairing[] = [];
  const uncovered = new Set(AUGMENT_IDS);
  while (remaining.length && uncovered.size) {
    let bestIndex = 0;
    let bestScore = -1;
    for (let index = 0; index < remaining.length; index += 1) {
      const pairing = remaining[index];
      const score = Number(uncovered.has(pairing.cardA)) + Number(uncovered.has(pairing.cardB));
      if (score > bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    }
    const [selected] = remaining.splice(bestIndex, 1);
    ordered.push(selected);
    uncovered.delete(selected.cardA);
    uncovered.delete(selected.cardB);
  }
  return [...ordered, ...remaining];
}

export function balanceTournamentOptions(
  profile: "soak" | "smoke",
  seed: number,
): TournamentOptions {
  return profile === "smoke"
    ? {
        seed,
        maxActions: 20,
        thinkTimeMinMs: 250,
        thinkTimeMaxMs: 1_000,
        search: { determinizations: 1, branching: 3, rolloutDepth: 1 },
        refreshMargin: 4,
      }
    : {
        seed,
        maxActions: 180,
        thinkTimeMinMs: 2_500,
        thinkTimeMaxMs: 6_500,
        search: { determinizations: 4, branching: 8, rolloutDepth: 3 },
        refreshMargin: 4,
      };
}

function validateState(value: unknown): BalanceWorkerState {
  if (!value || typeof value !== "object") throw new Error("Invalid balance worker state.");
  const candidate = value as Partial<BalanceWorkerState>;
  if (
    !Number.isSafeInteger(candidate.cycle) ||
    !Number.isSafeInteger(candidate.pairIndex) ||
    !candidate.aggregate ||
    !candidate.tournament
  ) {
    throw new Error("Incomplete balance worker state.");
  }
  return candidate as BalanceWorkerState;
}

async function run() {
  const args = parseWorkerArguments(process.argv.slice(2));
  const pairings = orderedPairingsForEarlyCoverage();
  const tournament = balanceTournamentOptions(args.profile, args.seed);
  const journal = await WorkerJournal.open<BalanceWorkerState>(
    "balance",
    args,
    () => ({
      cycle: 0,
      pairIndex: 0,
      aggregate: createEmptyAggregate(),
      tournament,
    }),
    validateState,
  );
  if (JSON.stringify(journal.state.tournament) !== JSON.stringify(tournament)) {
    throw new Error("Balance search configuration changed across resume.");
  }
  let stopped = false;

  while (true) {
    const stopDecision = balanceWorkerStopDecision({
      profile: args.profile,
      durationSeconds: args.durationSeconds,
      segmentActiveMs: journal.segmentActiveMs(),
      segmentCompletedGroups: journal.segment.loops,
      requiredRoundRobinGroups: pairings.length,
      stopRequested: await stopWasRequested(args.stopPath),
      failed: totalFailures(journal.segment) > 0,
    });
    if (stopDecision !== "continue") {
      stopped = stopDecision === "requested";
      break;
    }
    const pairing = pairings[journal.state.pairIndex];
    const group = scheduleGroup(pairing, journal.state.cycle, 0);
    const results = playMirrorGroup(
      group,
      journal.state.tournament,
      strengthModelFromAggregate(journal.state.aggregate),
    );
    recordMirrorGroup(journal.state.aggregate, group, results);

    const delta = emptyCounters();
    delta.loops = 1;
    delta.games = results.length;
    for (const result of results) {
      delta.moves += result.moves;
      delta.searchNodes += result.searchNodes;
      if (result.capped) delta.cappedGames += 1;
      for (const id of new Set([...result.loadouts.black, ...result.loadouts.white])) {
        delta.cardCoverage[id] += 1;
      }
    }
    journal.addCounters(delta);
    for (const result of results) {
      if (result.exception) {
        journal.fail("exceptions", result.exception, {
          groupKey: group.groupKey,
          leg: result.leg.index,
        });
      }
      if (result.stuck) {
        journal.fail("hangs", "Visible policy produced no action before the game finished.", {
          groupKey: group.groupKey,
          leg: result.leg.index,
          moves: result.moves,
        });
      }
    }

    journal.state.pairIndex += 1;
    if (journal.state.pairIndex >= pairings.length) {
      journal.state.pairIndex = 0;
      journal.state.cycle += 1;
    }
    await journal.write();
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
