import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  AUGMENT_SUITS,
  getAugmentDefinition,
  validateAugmentDraftState,
  type AugmentId,
  type AugmentSlot,
} from "../../lib/augments.ts";
import {
  AUGMENT_RULES_VERSION,
  CLASSIC_RULES_VERSION,
  GameRuleError,
  LEGACY_AUGMENT_RULES_VERSION,
  THREEFOLD_REPETITION_THRESHOLD,
  applyPlayerAction,
  buildReplayFrames,
  createAugmentGame,
  isInsideBoard,
  otherSide,
  projectGame,
  type GameState,
  type PlayerAction,
  type PublicPiece,
  type Side,
} from "../../lib/game.ts";
import {
  constrainActiveDraftToSimulationPool,
  createControlledPairGame,
  withDeterministicEngineRandom,
} from "../balance/tournament.ts";
import {
  SIMULATION_ELIGIBLE_AUGMENT_IDS,
  isSimulationEligibleAugment,
  simulationIdsBySuit,
} from "../balance/simulation-pool.ts";
import {
  SeededRandom,
  determinizeFromProjection,
  enumerateVisibleActions,
  stableStringify,
} from "../balance/visible-policy.ts";
import {
  WorkerJournal,
  emptyCounters,
  parseWorkerArguments,
  stopWasRequested,
  totalFailures,
  type FailureCounters,
} from "./common.ts";

interface RulesWorkerState {
  gameIndex: number;
}

class FuzzFailure extends Error {
  constructor(
    readonly category: keyof FailureCounters,
    message: string,
    readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "FuzzFailure";
  }
}

let assertionCount = 0;

function expect(
  condition: unknown,
  category: keyof FailureCounters,
  message: string,
  context: Record<string, unknown> = {},
): asserts condition {
  assertionCount += 1;
  if (!condition) throw new FuzzFailure(category, message, context);
}

function coveragePairs() {
  const bySuit = simulationIdsBySuit();
  const result: Array<[AugmentId, AugmentId]> = [];
  for (const suit of AUGMENT_SUITS) {
    const cards = bySuit[suit];
    for (let index = 0; index < cards.length; index += 2) {
      result.push([cards[index], cards[(index + 1) % cards.length]]);
    }
  }
  return result;
}

const BATTLE_RESULTS = new Set([
  "move",
  "attacker_survives",
  "defender_survives",
  "both_removed",
  "flag_protected",
  "flag_captured",
]);

function samePosition(
  first: { row: number; col: number } | undefined,
  second: { row: number; col: number } | undefined,
) {
  return first === undefined
    ? second === undefined
    : second !== undefined && first.row === second.row && first.col === second.col;
}

function recordAugmentIds(record: { augmentId?: AugmentId; augmentIds?: AugmentId[] }) {
  return record.augmentIds?.length ? [...record.augmentIds] : record.augmentId ? [record.augmentId] : [];
}

function sortedMultiset(values: readonly string[]) {
  return [...values].sort((first, second) => first.localeCompare(second));
}

function triggerKey(side: Side, id: AugmentId) {
  return `${side}:${id}`;
}

function originalPieceTypeForAudit(state: GameState, pieceId: string) {
  const piece = state.pieces.find((candidate) => candidate.id === pieceId);
  return state.augment?.ruleState?.baseTypes[pieceId] ?? piece?.type;
}

function newEventsSince(before: GameState, after: GameState) {
  const previousLastEventId = before.events.at(-1)?.id ?? 0;
  return after.events.filter((event) => event.id > previousLastEventId);
}

function recordCarriesAugment(
  record: { augmentId?: AugmentId; augmentIds?: AugmentId[] },
  id: AugmentId,
) {
  return recordAugmentIds(record).includes(id);
}

function newlyRevealedToLoadout(before: GameState, after: GameState, side: Side, id: AugmentId) {
  return !(before.augment?.draft.loadouts[side] ?? []).includes(id) &&
    (after.augment?.draft.loadouts[side] ?? []).includes(id);
}

function sideOwnsPassiveCombatMode(
  state: GameState,
  side: Side,
  mode: "durable_mines" | "division_defuses_mine",
) {
  return (state.augment?.draft.loadouts[side] ?? []).some((augmentId) => {
    const definition = getAugmentDefinition(augmentId);
    return definition.activation === "passive" &&
      definition.effect.kind === "combat" &&
      definition.effect.mode === mode;
  });
}

/**
 * Passive trigger counters describe semantic rule pulses, not charged-card
 * consumption. Keep this deliberately explicit for the v3 passive modes so a
 * new passive cannot silently inherit the old `augment_used` contract.
 */
function expectedPassiveTriggerDelta(
  before: GameState,
  after: GameState,
  action: PlayerAction,
  side: Side,
  id: AugmentId,
) {
  const definition = getAugmentDefinition(id);
  if (definition.activation !== "passive") return 0;
  const effect = definition.effect;
  const preActionMineCombat = effect.kind === "combat" &&
    (effect.mode === "durable_mines" || effect.mode === "division_defuses_mine");
  if (
    !preActionMineCombat &&
    !(after.augment?.draft.loadouts[side] ?? []).includes(id)
  ) {
    return 0;
  }
  const beforeRule = before.augment?.ruleState;
  const afterRule = after.augment?.ruleState;
  if (!afterRule) return 0;
  const events = newEventsSince(before, after);

  if (effect.kind === "multi_move" && effect.mode === "two_single_edge_moves") {
    const previous = beforeRule?.multiMove[side] ?? null;
    const next = afterRule.multiMove[side];
    return previous === null &&
        next?.augmentId === id &&
        next.pieceId === null &&
        next.movesRemaining === 1 &&
        next.movesCompleted === 1 &&
        next.mayUseDifferentPieces
      ? 1
      : 0;
  }

  if (effect.kind === "combat" && effect.mode === "bomb_death_splash") {
    if (action.type !== "move" && action.type !== "augment_move") return 0;
    return before.pieces.filter((piece) => {
      if (!piece.alive || piece.side !== side || originalPieceTypeForAudit(before, piece.id) !== "bomb") {
        return false;
      }
      return after.pieces.find((candidate) => candidate.id === piece.id)?.alive === false;
    }).length;
  }

  if (effect.kind === "promotion" && effect.mode === "platoon_loss_threshold") {
    return Math.max(
      0,
      afterRule.sacrificePromotionSteps[side] -
        (beforeRule?.sacrificePromotionSteps[side] ?? 0),
    );
  }

  if (effect.kind === "promotion" && effect.mode === "battalion_on_capture") {
    return events.filter(
      (event) =>
        event.result === "piece_promoted" &&
        event.actor === side &&
        event.augmentId === id,
    ).length;
  }

  if (effect.kind === "doctrine" && effect.mode === "lightning_rank_boost") {
    return beforeRule?.lightning[side]?.augmentId !== id &&
        afterRule.lightning[side]?.augmentId === id
      ? 1
      : 0;
  }

  if (effect.kind === "objective" && effect.mode === "last_headquarters") {
    const protectedFlags = events.filter(
      (event) => event.result === "flag_protected" && recordCarriesAugment(event, id),
    ).length;
    const unlockedNow = !beforeRule?.headquartersUnlocked[side] &&
      afterRule.headquartersUnlocked[side];
    const revealedAfterUnlock = newlyRevealedToLoadout(before, after, side, id) &&
      Boolean(beforeRule?.headquartersUnlocked[side]) &&
      afterRule.headquartersUnlocked[side];
    return protectedFlags + Number(unlockedNow || revealedAfterUnlock);
  }

  if (effect.kind === "combat" && effect.mode === "command_fusion") {
    return afterRule.generalFallen[side] &&
        (!beforeRule?.generalFallen[side] || newlyRevealedToLoadout(before, after, side, id))
      ? 1
      : 0;
  }

  if (effect.kind === "combat" && effect.mode === "engineer_mutiny") {
    return afterRule.commanderFallen[side] &&
        (!beforeRule?.commanderFallen[side] || newlyRevealedToLoadout(before, after, side, id))
      ? 1
      : 0;
  }

  if (
    effect.kind === "combat" &&
    (effect.mode === "durable_mines" || effect.mode === "division_defuses_mine") &&
    (action.type === "move" || action.type === "augment_move")
  ) {
    const attacker = before.pieces.find(
      (piece) => piece.alive && samePosition(piece, action.from),
    );
    const defender = before.pieces.find(
      (piece) => piece.alive && samePosition(piece, action.to),
    );
    if (
      !attacker ||
      !defender ||
      attacker.side === defender.side ||
      originalPieceTypeForAudit(before, defender.id) !== "mine" ||
      !(before.augment?.draft.loadouts[side] ?? []).includes(id)
    ) {
      return 0;
    }
    if (effect.mode === "division_defuses_mine") {
      return attacker.side === side &&
          originalPieceTypeForAudit(before, attacker.id) === "division"
        ? 1
        : 0;
    }
    const divisionSapperOverride =
      originalPieceTypeForAudit(before, attacker.id) === "division" &&
      sideOwnsPassiveCombatMode(before, attacker.side, "division_defuses_mine");
    return defender.side === side &&
        originalPieceTypeForAudit(before, attacker.id) !== "bomb" &&
        !divisionSapperOverride
      ? 1
      : 0;
  }

  return 0;
}

function verifyPassiveCombatPostconditions(
  before: GameState,
  after: GameState,
  action: PlayerAction,
  side: Side,
  id: AugmentId,
) {
  const effect = getAugmentDefinition(id).effect;
  if (
    effect.kind !== "combat" ||
    (effect.mode !== "durable_mines" && effect.mode !== "division_defuses_mine") ||
    (action.type !== "move" && action.type !== "augment_move")
  ) {
    return;
  }
  const attacker = before.pieces.find(
    (piece) => piece.alive && samePosition(piece, action.from),
  );
  const defender = before.pieces.find(
    (piece) => piece.alive && samePosition(piece, action.to),
  );
  expect(
    attacker && defender,
    "invariantFailures",
    `${side}/${id} lost its direct-combat participants during audit.`,
    { action },
  );
  const attackerAfter = after.pieces.find((piece) => piece.id === attacker.id);
  const defenderAfter = after.pieces.find((piece) => piece.id === defender.id);
  const replayMove = after.replay?.moves.at(-1);
  const newEvents = newEventsSince(before, after);
  const mineHitEvents = newEvents.filter((event) => event.result === "mine_hit");
  const replayMineHits = replayMove?.effects?.filter(
    (entry) => entry.result === "mine_hit",
  ) ?? [];
  expect(
    replayMove?.actor === attacker.side &&
      samePosition(replayMove.from, action.from) &&
      samePosition(replayMove.to, action.to),
    "replayDivergences",
    `${side}/${id} combat trigger lacked its matching replay move.`,
    { action, replayMove },
  );

  if (effect.mode === "division_defuses_mine") {
    expect(
      attackerAfter?.alive === true && samePosition(attackerAfter, action.to),
      "invariantFailures",
      `${side}/${id} did not leave the attacking division alive on the mine square.`,
      { action, attackerAfter },
    );
    expect(
      defenderAfter?.alive === false && after.augment?.ruleState?.mineHits[defender.id] === undefined,
      "invariantFailures",
      `${side}/${id} did not remove the mine and its hit memory.`,
      { action, defenderAfter, mineHits: after.augment?.ruleState?.mineHits },
    );
    expect(
      replayMove.result === "attacker_survives" &&
        mineHitEvents.length === 0 &&
        replayMineHits.length === 0,
      "replayDivergences",
      `${side}/${id} emitted the wrong sapper result or a spurious durable-mine pulse.`,
      { action, replayMove, mineHitEvents, replayMineHits },
    );
    return;
  }

  const ruleState = after.augment?.ruleState;
  const alreadyHit = before.augment?.ruleState?.mineHits[defender.id] === 1;
  expect(
    attackerAfter?.alive === false,
    "invariantFailures",
    `${side}/${id} did not remove the non-bomb attacker.`,
    { action, attackerAfter },
  );
  expect(
    ruleState?.publiclyRevealedPieceIds.includes(defender.id),
    "privacyLeaks",
    `${side}/${id} did not retain the attacked mine as public knowledge.`,
    { action, publicIds: ruleState?.publiclyRevealedPieceIds },
  );
  if (!alreadyHit) {
    expect(
      defenderAfter?.alive === true && ruleState?.mineHits[defender.id] === 1,
      "invariantFailures",
      `${side}/${id} first hit did not preserve the mine with one hit.`,
      { action, defenderAfter, mineHits: ruleState?.mineHits },
    );
    expect(
      replayMove.result === "defender_survives" &&
        mineHitEvents.length === 1 &&
        mineHitEvents[0].actor === attacker.side &&
        mineHitEvents[0].augmentId === id &&
        mineHitEvents[0].pieceIds?.includes(defender.id) &&
        replayMineHits.length === 1 &&
        replayMineHits[0].actor === attacker.side &&
        replayMineHits[0].augmentId === id &&
        replayMineHits[0].pieceIds.includes(defender.id),
      "replayDivergences",
      `${side}/${id} first hit lacked exactly one mine_hit event and replay effect.`,
      { action, replayMove, mineHitEvents, replayMineHits },
    );
    return;
  }
  expect(
    defenderAfter?.alive === false && ruleState?.mineHits[defender.id] === undefined,
    "invariantFailures",
    `${side}/${id} second hit did not remove the mine and clear its hit memory.`,
    { action, defenderAfter, mineHits: ruleState?.mineHits },
  );
  expect(
    replayMove.result === "both_removed" &&
      mineHitEvents.length === 0 &&
      replayMineHits.length === 0,
    "replayDivergences",
    `${side}/${id} second hit emitted the wrong result or an extra mine_hit pulse.`,
    { action, replayMove, mineHitEvents, replayMineHits },
  );
}

function replayEventResultMatches(
  event: GameState["events"][number],
  replayMove: NonNullable<GameState["replay"]>["moves"][number],
) {
  if (replayMove.kind === "redeploy") return event.result === "pieces_redeployed";
  if (replayMove.kind === "sacrifice") return event.result === "piece_sacrificed";
  return BATTLE_RESULTS.has(event.result) && event.result === replayMove.result;
}

function validAttributionMultiplicity(ids: readonly AugmentId[]) {
  const counts = new Map<AugmentId, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts].every(([id, count]) => {
    if (count <= 1) return true;
    const effect = getAugmentDefinition(id).effect;
    return count === 2 && effect.kind === "combat" && effect.mode === "bomb_second_fuse";
  });
}

export interface ReferenceRepetitionOracle {
  counts: Map<string, number>;
  lastCountedPosition: string | null;
}

export function createReferenceRepetitionOracle(): ReferenceRepetitionOracle {
  return { counts: new Map<string, number>(), lastCountedPosition: null };
}

function sortedUnique(values: readonly string[] | undefined) {
  return [...new Set(values ?? [])].sort((first, second) => first.localeCompare(second));
}

/**
 * Independent implementation of the published strategic-position contract.
 * It deliberately does not call, inspect, or reproduce the engine's salted
 * digest/tracker. The raw canonical string is sufficient for soak equality.
 */
export function referenceStrategicPositionJson(state: GameState) {
  const augment = state.augment;
  if (!augment) throw new Error("Reference repetition requires augment state.");
  const triggerCounts = (side: Side) =>
    Object.entries(augment.triggerCounts[side])
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([id, count]) => [id, count]);
  const extraMove = (side: Side) => {
    const pending = augment.extraMove[side];
    return pending ? [pending.augmentId, pending.excludedPieceId] : null;
  };
  const ruleState = augment.ruleState;
  const sortedPieceNumberEntries = (values: Record<string, number>) =>
    Object.entries(values).sort(([first], [second]) => first.localeCompare(second));
  return JSON.stringify({
    turn: state.turn,
    pieces: [...state.pieces]
      .sort((first, second) => first.id.localeCompare(second.id))
      .map(({ id, side, type, alive, row, col }) => [id, side, type, alive, row, col]),
    revealedFlags: [state.revealedFlags.black, state.revealedFlags.white],
    movedPieceIds: sortedUnique(state.movedPieceIds),
    augment: {
      catalogVersion: augment.draft.catalogVersion,
      loadouts: [
        [...augment.draft.loadouts.black],
        [...augment.draft.loadouts.white],
      ],
      triggerCounts: [triggerCounts("black"), triggerCounts("white")],
      permanentReveals: [
        sortedUnique(augment.permanentReveals.black),
        sortedUnique(augment.permanentReveals.white),
      ],
      temporaryReveals: [
        sortedUnique(augment.temporaryReveals.black),
        sortedUnique(augment.temporaryReveals.white),
      ],
      extraMove: [extraMove("black"), extraMove("white")],
      ...(ruleState
        ? {
            ruleState: {
              publiclyRevealedPieceIds: sortedUnique(ruleState.publiclyRevealedPieceIds),
              promotedPublicIds: sortedUnique(ruleState.promotedPublicIds),
              headquartersUnlocked: [
                ruleState.headquartersUnlocked.black,
                ruleState.headquartersUnlocked.white,
              ],
              commanderFallen: [ruleState.commanderFallen.black, ruleState.commanderFallen.white],
              generalFallen: [ruleState.generalFallen.black, ruleState.generalFallen.white],
              mineHits: sortedPieceNumberEntries(ruleState.mineHits),
              bombSecondFuse: [
                ruleState.bombSecondFuse.black,
                ruleState.bombSecondFuse.white,
              ],
              casualties: [ruleState.casualties.black, ruleState.casualties.white],
              sacrificePromotionSteps: [
                ruleState.sacrificePromotionSteps.black,
                ruleState.sacrificePromotionSteps.white,
              ],
              lightning: [ruleState.lightning.black, ruleState.lightning.white],
              multiMove: [ruleState.multiMove.black, ruleState.multiMove.white],
            },
          }
        : {}),
    },
  });
}

export function referenceRepetitionIsEligible(state: GameState) {
  return Boolean(
    state.rulesVersion === AUGMENT_RULES_VERSION &&
      state.phase === "playing" &&
      state.augment &&
      state.augment.draft.activeRound === null &&
      state.augment.pendingRecon.black === null &&
      state.augment.pendingRecon.white === null &&
      state.augment.extraMove.black === null &&
      state.augment.extraMove.white === null &&
      state.augment.ruleState?.multiMove.black === null &&
      state.augment.ruleState?.multiMove.white === null &&
      state.augment.draft.rounds.some((round) => round.number === 2 && round.revealed),
  );
}

function isThreefoldTerminal(state: GameState) {
  return state.phase === "finished" &&
    state.winner === null &&
    state.finishReason === "draw" &&
    state.drawReason === "threefold_repetition";
}

export function observeReferenceRepetition(
  state: GameState,
  oracle: ReferenceRepetitionOracle,
  nowMs: number,
  context: Record<string, unknown> = {},
) {
  const projection = projectGame(state, "black", nowMs);
  if (state.rulesVersion !== AUGMENT_RULES_VERSION) {
    expect(
      projection.repetition === null && !isThreefoldTerminal(state),
      "invariantFailures",
      "Classic or legacy augment play activated the v2 repetition adjudicator.",
      context,
    );
    return 0;
  }
  const terminal = isThreefoldTerminal(state);
  if (!referenceRepetitionIsEligible(state) && !terminal) return 0;
  const position = referenceStrategicPositionJson(state);
  if (position !== oracle.lastCountedPosition) {
    oracle.counts.set(position, (oracle.counts.get(position) ?? 0) + 1);
    oracle.lastCountedPosition = position;
  }
  const occurrences = oracle.counts.get(position) ?? 0;
  expect(
    projection.repetition?.currentOccurrences === occurrences,
    "invariantFailures",
    "Product repetition occurrence diverged from the independent soak oracle.",
    {
      ...context,
      expectedOccurrences: occurrences,
      actualOccurrences: projection.repetition?.currentOccurrences ?? null,
    },
  );
  if (occurrences >= THREEFOLD_REPETITION_THRESHOLD) {
    expect(
      terminal,
      "invariantFailures",
      "The product engine did not finish immediately on the third strategic occurrence.",
      { ...context, occurrences },
    );
  } else {
    expect(
      !terminal,
      "invariantFailures",
      "The product engine declared a threefold draw before the third occurrence.",
      { ...context, occurrences },
    );
  }
  return occurrences;
}

export function verifyActionSettlement(
  before: GameState,
  after: GameState,
  action: PlayerAction,
) {
  const newEvents = newEventsSince(before, after);
  const eventBackedTriggerDeltas: string[] = [];
  const passiveTriggerDeltas = new Map<string, number>();
  for (const side of ["black", "white"] as const) {
    for (const id of SIMULATION_ELIGIBLE_AUGMENT_IDS) {
      const previousCount = before.augment?.triggerCounts[side][id] ?? 0;
      const nextCount = after.augment?.triggerCounts[side][id] ?? 0;
      const delta = nextCount - previousCount;
      expect(
        delta >= 0,
        "duplicateSettlements",
        `${side}/${id} trigger count moved backwards during ${action.type}.`,
        { action, previousCount, nextCount },
      );
      const definition = getAugmentDefinition(id);
      if (definition.activation === "passive") {
        const expectedDelta = expectedPassiveTriggerDelta(before, after, action, side, id);
        expect(
          delta === expectedDelta,
          "duplicateSettlements",
          `${side}/${id} passive trigger delta ${delta} did not match semantic evidence ${expectedDelta} during ${action.type}.`,
          { action, previousCount, nextCount, expectedDelta },
        );
        if (expectedDelta > 0) {
          verifyPassiveCombatPostconditions(before, after, action, side, id);
        }
        if (delta > 0) {
          passiveTriggerDeltas.set(triggerKey(side, id), delta);
          const effect = definition.effect;
          if (effect.kind === "multi_move" && effect.mode === "two_single_edge_moves") {
            const replayMove = after.replay?.moves.at(-1);
            const movementEvent = newEvents.find(
              (event) =>
                event.from !== undefined &&
                event.to !== undefined &&
                event.actor === side &&
                recordCarriesAugment(event, id),
            );
            expect(
              replayMove?.actor === side &&
                recordCarriesAugment(replayMove, id) &&
                movementEvent !== undefined,
              "replayDivergences",
              `${side}/${id} passive continuation opened without movement event/replay attribution.`,
              { action, replayMove, movementEvent },
            );
          }
          if (effect.kind === "combat" && effect.mode === "bomb_death_splash") {
            expect(
              newEvents.some(
                (event) => event.result === "chain_explosion" && event.augmentId === id,
              ),
              "replayDivergences",
              `${side}/${id} passive bomb chain lacked its authoritative effect event.`,
              { action, delta },
            );
          }
        }
        continue;
      }
      expect(
        delta <= 1,
        "duplicateSettlements",
        `${side}/${id} charged trigger settled ${delta} times during one ${action.type} action.`,
        { action, previousCount, nextCount },
      );
      if (delta === 1) eventBackedTriggerDeltas.push(triggerKey(side, id));
    }
  }

  const newAugmentEvents = newEvents.filter((event) => event.result === "augment_used");
  for (const event of newAugmentEvents) {
    expect(
      event.augmentId,
      "duplicateSettlements",
      `augment_used event ${event.id} omitted its augment id.`,
      { action, event },
    );
  }
  const eventSettlements = newAugmentEvents.map(
    (event) => `${event.actor}:${event.augmentId!}`,
  );
  expect(
    stableStringify(sortedMultiset(eventSettlements)) ===
      stableStringify(sortedMultiset(eventBackedTriggerDeltas)),
    "duplicateSettlements",
    `Charged trigger deltas and augment_used events diverged during ${action.type}.`,
    { action, eventBackedTriggerDeltas, eventSettlements },
  );

  const previousReplayLength = before.replay?.moves.length ?? 0;
  const nextReplayLength = after.replay?.moves.length ?? 0;
  const replayDelta = nextReplayLength - previousReplayLength;
  expect(
    replayDelta >= 0 && replayDelta <= 1,
    "replayDivergences",
    `${action.type} changed the replay by ${replayDelta} moves.`,
    { action, previousReplayLength, nextReplayLength },
  );
  if (replayDelta === 1) {
    const replayMove = after.replay?.moves.at(-1);
    expect(replayMove, "replayDivergences", `${action.type} added no readable replay move.`);
    const movementEvents = newEvents.filter(
      (event) =>
        replayEventResultMatches(event, replayMove) &&
        event.from !== undefined &&
        event.to !== undefined &&
        event.actor === replayMove.actor &&
        samePosition(event.from, replayMove.from) &&
        samePosition(event.to, replayMove.to),
    );
    expect(
      movementEvents.length === 1,
      "replayDivergences",
      `${action.type} produced ${movementEvents.length} authoritative movement events for one replay move.`,
      { action, movementEvents, moveNumber: replayMove.moveNumber },
    );
    const movementEvent = movementEvents[0];
    expect(
      movementEvent.actor === replayMove.actor &&
        samePosition(movementEvent.from, replayMove.from) &&
        samePosition(movementEvent.to, replayMove.to) &&
        replayEventResultMatches(movementEvent, replayMove) &&
        movementEvent.kind === replayMove.kind &&
        samePosition(movementEvent.secondaryFrom, replayMove.secondaryFrom) &&
        samePosition(movementEvent.secondaryTo, replayMove.secondaryTo) &&
        stableStringify(recordAugmentIds(movementEvent)) ===
          stableStringify(recordAugmentIds(replayMove)),
      "replayDivergences",
      `Replay move ${replayMove.moveNumber} diverged from its authoritative movement event.`,
      { action, movementEvent, replayMove },
    );
    const replaySettlements = recordAugmentIds(replayMove);
    const eventAugmentIds = newAugmentEvents.map((event) => event.augmentId!);
    const replayCounts = new Map<AugmentId, number>();
    const eventCounts = new Map<AugmentId, number>();
    for (const id of replaySettlements) replayCounts.set(id, (replayCounts.get(id) ?? 0) + 1);
    for (const id of eventAugmentIds) eventCounts.set(id, (eventCounts.get(id) ?? 0) + 1);
    expect(
      [...eventCounts].every(([id, count]) => (replayCounts.get(id) ?? 0) >= count),
      "replayDivergences",
      `Replay omitted a charged augment_used settlement during ${action.type}.`,
      { action, replaySettlements, eventAugmentIds, moveNumber: replayMove.moveNumber },
    );

    const attributionBudget = new Map<AugmentId, number>(eventCounts);
    for (const [key, delta] of passiveTriggerDeltas) {
      const id = key.slice(key.indexOf(":") + 1) as AugmentId;
      if (delta > 0) attributionBudget.set(id, Math.max(attributionBudget.get(id) ?? 0, 1));
    }
    const pendingMultiId = before.augment?.ruleState?.multiMove[replayMove.actor]?.augmentId;
    if (pendingMultiId) {
      attributionBudget.set(
        pendingMultiId,
        Math.max(attributionBudget.get(pendingMultiId) ?? 0, 1),
      );
    }
    if ("augmentId" in action && action.augmentId) {
      attributionBudget.set(
        action.augmentId,
        Math.max(attributionBudget.get(action.augmentId) ?? 0, 1),
      );
    }
    expect(
      [...replayCounts].every(
        ([id, count]) => count <= (attributionBudget.get(id) ?? 0),
      ),
      "duplicateSettlements",
      `Replay carried an unsupported or duplicate augment attribution during ${action.type}.`,
      { action, replaySettlements, attributionBudget: [...attributionBudget] },
    );
  }

  for (const side of ["black", "white"] as const) {
    const pending = before.augment?.ruleState?.multiMove[side];
    if (!pending) continue;
    if ((action.type === "move" || action.type === "augment_move") && before.turn === side) {
      const replayMove = after.replay?.moves.at(-1);
      expect(
        replayDelta === 1 && replayMove && recordCarriesAugment(replayMove, pending.augmentId),
        "replayDivergences",
        `${side}/${pending.augmentId} continuation move lacked replay attribution.`,
        { action, pending, replayMove },
      );
    }
    if (action.type === "pass_extra_move" && before.turn === side) {
      const passEvents = newEvents.filter(
        (event) =>
          event.result === "extra_move_passed" &&
          event.actor === side &&
          event.augmentId === pending.augmentId,
      );
      expect(
        after.augment?.ruleState?.multiMove[side] === null && passEvents.length === 1,
        "duplicateSettlements",
        `${side}/${pending.augmentId} continuation pass lacked one authoritative settlement.`,
        { action, pending, passEvents },
      );
    }
  }
}

function applyAuditedAction(
  state: GameState,
  side: Side,
  action: PlayerAction,
  nowMs: number,
  randomSeed?: string,
  repetitionOracle?: ReferenceRepetitionOracle,
) {
  const next = randomSeed === undefined
    ? applyPlayerAction(state, side, action, nowMs)
    : withDeterministicEngineRandom(randomSeed, () =>
        applyPlayerAction(state, side, action, nowMs)
      );
  verifyActionSettlement(state, next, action);
  if (repetitionOracle) {
    observeReferenceRepetition(next, repetitionOracle, nowMs, {
      action,
      side,
      moveNumber: next.moveNumber,
    });
  }
  return next;
}

function verifyBoardAndAccounting(state: GameState) {
  const occupied = new Set<string>();
  for (const piece of state.pieces) {
    if (!piece.alive) continue;
    expect(isInsideBoard(piece), "invariantFailures", `Alive piece ${piece.id} left the board.`);
    const key = `${piece.row},${piece.col}`;
    expect(!occupied.has(key), "duplicateSettlements", `Two alive pieces occupy ${key}.`);
    occupied.add(key);
  }
  expect(
    Number.isSafeInteger(state.moveNumber) && state.moveNumber >= 0,
    "invariantFailures",
    `Invalid move number ${state.moveNumber}.`,
  );
  if (state.finishReason === "draw") {
    expect(
      state.phase === "finished" &&
        state.winner === null &&
        state.drawReason === "threefold_repetition",
      "invariantFailures",
      "A finished draw is missing its product threefold metadata.",
    );
  } else {
    expect(
      state.drawReason === null || state.drawReason === undefined,
      "invariantFailures",
      "A non-draw state retained a draw reason.",
    );
  }
  if (state.augment) {
    expect(
      validateAugmentDraftState(state.augment.draft),
      "invariantFailures",
      "Augment draft failed its own state validator.",
    );
    for (const side of ["black", "white"] as const) {
      expect(
        new Set(state.augment.usedBySide[side]).size === state.augment.usedBySide[side].length,
        "duplicateSettlements",
        `${side} usedBySide contains a duplicate augment.`,
      );
      for (const [id, count] of Object.entries(state.augment.triggerCounts[side])) {
        const definition = getAugmentDefinition(id as AugmentId);
        expect(
          Number.isSafeInteger(count) &&
            count >= 0 &&
            (definition.activation === "passive" || count <= definition.charges),
          "duplicateSettlements",
          `${side}/${id} trigger count ${String(count)} violates its activation contract.`,
        );
      }
    }
  }

  const eventIds = state.events.map((event) => event.id);
  expect(
    new Set(eventIds).size === eventIds.length,
    "duplicateSettlements",
    "Public event IDs are not unique.",
  );
  for (const event of state.events) {
    if (event.augmentIds) {
      expect(
        validAttributionMultiplicity(event.augmentIds),
        "duplicateSettlements",
        `Event ${event.id} contains unsupported duplicate augment attribution.`,
      );
    }
  }
  if (state.replay) {
    const moveNumbers = state.replay.moves.map((move) => move.moveNumber);
    expect(
      new Set(moveNumbers).size === moveNumbers.length,
      "duplicateSettlements",
      "Replay move numbers are not unique.",
    );
    expect(
      state.replay.moves.length === state.moveNumber - state.replay.baselineMoveNumber,
      "duplicateSettlements",
      "Replay move count differs from authoritative move number.",
    );
    for (const move of state.replay.moves) {
      if (move.augmentIds) {
        expect(
          validAttributionMultiplicity(move.augmentIds),
          "duplicateSettlements",
          `Replay move ${move.moveNumber} contains unsupported duplicate augment attribution.`,
        );
      }
    }
  }
}

function verifySetupPrivacyState(state: GameState, nowMs: number, label: string) {
  expect(state.phase === "setup", "privacyLeaks", `${label} fixture left setup.`);
  const authoritativeIds = new Set(state.pieces.map((piece) => piece.id));

  for (const viewer of ["black", "white"] as const) {
    const projection = projectGame(state, viewer, nowMs);
    expect(
      !("repetitionTracker" in projection),
      "privacyLeaks",
      `${viewer} projection exposed the private repetition tracker.`,
    );
    expect(projection.replay === null, "privacyLeaks", `${label}/${viewer} received a setup replay.`);
    expect(
      projection.pieces.length === state.pieces.length,
      "privacyLeaks",
      `${label}/${viewer} received the wrong setup piece count.`,
    );
    for (const authoritative of state.pieces) {
      const expectedId = authoritative.side === viewer
        ? authoritative.id
        : `${authoritative.side}-hidden-${authoritative.row}-${authoritative.col}`;
      const projected = projection.pieces.find((piece) => piece.id === expectedId);
      expect(
        projected,
        "privacyLeaks",
        `${label}/${viewer} did not receive the expected setup identity ${expectedId}.`,
      );
      expect(
        projected.side === authoritative.side &&
          projected.row === authoritative.row &&
          projected.col === authoritative.col &&
          projected.alive === authoritative.alive,
        "privacyLeaks",
        `${label}/${viewer} setup projection moved or replaced ${expectedId}.`,
      );
      expect(
        projected.type === (authoritative.side === viewer ? authoritative.type : null),
        "privacyLeaks",
        `${label}/${viewer} received an invalid setup type for ${expectedId}.`,
      );
      if (authoritative.side !== viewer) {
        expect(
          !authoritativeIds.has(projected.id),
          "privacyLeaks",
          `${label}/${viewer} received a real opponent piece id during setup.`,
          { authoritativeId: authoritative.id, projectedId: projected.id },
        );
      }
    }

    const projectedDraft = projection.augment?.draft;
    const authoritativeDraft = state.augment?.draft;
    expect(projectedDraft && authoritativeDraft, "privacyLeaks", `${label} lost its augment draft.`);
    expect(
      stableStringify(projectedDraft.seenIds) ===
        stableStringify(authoritativeDraft.seenBySide[viewer]),
      "privacyLeaks",
      `${label}/${viewer} received another side's seen-card history.`,
    );
    for (const round of authoritativeDraft.rounds) {
      const projectedRound = projectedDraft.rounds.find(
        (candidate) => candidate.number === round.number,
      );
      expect(projectedRound, "privacyLeaks", `${label}/${viewer} lost draft round ${round.number}.`);
      for (const side of ["black", "white"] as const) {
        const maySee = round.revealed || side === viewer;
        expect(
          stableStringify(projectedRound.players[side].options) ===
            stableStringify(maySee && side === viewer ? round.players[side].options : null),
          "privacyLeaks",
          `${label}/${viewer} received invalid ${side} draft options in round ${round.number}.`,
        );
        expect(
          projectedRound.players[side].selectedId ===
            (maySee ? round.players[side].selectedId : null),
          "privacyLeaks",
          `${label}/${viewer} received invalid ${side} selection in round ${round.number}.`,
        );
      }
    }
    expect(
      stableStringify(projectedDraft.loadouts[viewer]) ===
        stableStringify(authoritativeDraft.loadouts[viewer]) &&
        projectedDraft.loadouts[otherSide(viewer)].length === 0,
      "privacyLeaks",
      `${label}/${viewer} received an invalid private loadout projection.`,
      { projectedLoadouts: projectedDraft.loadouts },
    );
  }

  const spectator = projectGame(state, "spectator", nowMs, { spectatorPolicy: "hidden" });
  expect(spectator.replay === null, "privacyLeaks", `${label}/spectator received a setup replay.`);
  expect(
    spectator.pieces.length === state.pieces.length,
    "privacyLeaks",
    `${label}/spectator received the wrong setup piece count.`,
  );
  for (const authoritative of state.pieces) {
    const expectedId = `${authoritative.side}-hidden-${authoritative.row}-${authoritative.col}`;
    const projected = spectator.pieces.find((piece) => piece.id === expectedId);
    expect(
      projected && projected.type === null,
      "privacyLeaks",
      `${label}/spectator received a real setup identity or type for ${authoritative.id}.`,
      { expectedId, projected },
    );
    expect(
      !authoritativeIds.has(projected.id),
      "privacyLeaks",
      `${label}/spectator received real piece id ${projected.id}.`,
    );
  }
  const spectatorDraft = spectator.augment?.draft;
  expect(spectatorDraft, "privacyLeaks", `${label}/spectator lost the augment draft.`);
  expect(spectatorDraft.seenIds === null, "privacyLeaks", `${label}/spectator received seen-card history.`);
  expect(
    spectatorDraft.loadouts.black.length === 0 && spectatorDraft.loadouts.white.length === 0,
    "privacyLeaks",
    `${label}/spectator received a private setup loadout.`,
    { loadouts: spectatorDraft.loadouts },
  );
  for (const round of spectatorDraft.rounds) {
    if (round.revealed) continue;
    for (const side of ["black", "white"] as const) {
      expect(
        round.players[side].options === null && round.players[side].selectedId === null,
        "privacyLeaks",
        `${label}/spectator received ${side}'s private draft data in round ${round.number}.`,
      );
    }
  }
}

export function createClocklessSetupPrivacyState(seed: string) {
  const state = withDeterministicEngineRandom(`${seed}:create`, () =>
    createAugmentGame({ ranked: true }),
  );
  return constrainActiveDraftToSimulationPool(state, `${seed}:eligible-pool`);
}

function verifySetupPrivacyScenarios(seed: string, nowMs: number) {
  let state = createClocklessSetupPrivacyState(seed);
  verifySetupPrivacyState(state, nowMs, "unready-unselected");
  for (const side of ["black", "white"] as const) {
    const activeRound = state.augment?.draft.activeRound;
    const round = state.augment?.draft.rounds.find(
      (candidate) => candidate.number === activeRound,
    );
    const selection = round?.players[side].options[0];
    expect(selection, "privacyLeaks", `setup privacy fixture has no ${side} offer.`);
    expect(
      round.players[side].options.every(isSimulationEligibleAugment) &&
        isSimulationEligibleAugment(selection),
      "invariantFailures",
      `setup privacy fixture exposed an excluded clock augment to ${side}.`,
      { options: round.players[side].options },
    );
    state = applyAuditedAction(
      state,
      side,
      { type: "augment_select", augmentId: selection },
      nowMs,
      `${seed}:${side}:select`,
    );
    state = applyAuditedAction(
      state,
      side,
      { type: "augment_lock" },
      nowMs,
      `${seed}:${side}:lock`,
    );
    expect(
      (state.augment?.draft.loadouts[side] ?? []).every(isSimulationEligibleAugment),
      "invariantFailures",
      `setup privacy fixture selected an excluded clock augment for ${side}.`,
    );
  }
  verifySetupPrivacyState(state, nowMs, "unready-locked-loadouts");
  state = applyAuditedAction(state, "black", { type: "ready", value: true }, nowMs);
  expect(
    state.ready.black && !state.ready.white,
    "privacyLeaks",
    "setup privacy fixture did not retain one-sided readiness.",
  );
  verifySetupPrivacyState(state, nowMs, "black-ready-only");
}

function publicRuleIdentityIsVisible(state: GameState, pieceId: string) {
  const ruleState = state.augment?.ruleState;
  return Boolean(
    ruleState?.publiclyRevealedPieceIds.includes(pieceId) ||
      ruleState?.promotedPublicIds.includes(pieceId),
  );
}

export function verifyProjectedRuleMetadata(
  state: GameState,
  projected: PublicPiece,
  label: string,
) {
  const ruleState = state.augment?.ruleState;
  const publiclyRevealed = Boolean(
    ruleState?.publiclyRevealedPieceIds.includes(projected.id),
  );
  const promoted = Boolean(ruleState?.promotedPublicIds.includes(projected.id));
  const mineHits = ruleState?.mineHits[projected.id] === 1 ? 1 : 0;
  if (ruleState) {
    expect(
      projected.publiclyRevealed === publiclyRevealed,
      "privacyLeaks",
      `${label} projected inconsistent public-reveal metadata for ${projected.id}.`,
      { expected: publiclyRevealed, actual: projected.publiclyRevealed },
    );
    expect(
      projected.promoted === promoted,
      "privacyLeaks",
      `${label} projected inconsistent promotion metadata for ${projected.id}.`,
      { expected: promoted, actual: projected.promoted },
    );
    expect(
      projected.mineHits === mineHits,
      "privacyLeaks",
      `${label} projected inconsistent durable-mine hit metadata for ${projected.id}.`,
      { expected: mineHits, actual: projected.mineHits },
    );
    return;
  }
  expect(
    (projected.publiclyRevealed ?? false) === false,
    "privacyLeaks",
    `${label} projected v3 public-reveal metadata in a legacy game for ${projected.id}.`,
  );
  expect(
    (projected.promoted ?? false) === false,
    "privacyLeaks",
    `${label} projected v3 promotion metadata in a legacy game for ${projected.id}.`,
  );
  expect(
    (projected.mineHits ?? 0) === 0,
    "privacyLeaks",
    `${label} projected v3 durable-mine metadata in a legacy game for ${projected.id}.`,
  );
}

function verifyProjectionPrivacy(state: GameState, nowMs: number) {
  for (const viewer of ["black", "white"] as const) {
    const projection = projectGame(state, viewer, nowMs);
    const known = new Set([
      ...(state.augment?.permanentReveals[viewer] ?? []),
      ...(state.augment?.temporaryReveals[viewer] ?? []),
    ]);
    for (const projected of projection.pieces) {
      const authoritative = state.pieces.find((piece) => piece.id === projected.id);
      expect(authoritative, "privacyLeaks", `Projection invented piece ${projected.id}.`);
      verifyProjectedRuleMetadata(state, projected, viewer);
      const publicFlag = authoritative.type === "flag" && state.revealedFlags[authoritative.side];
      const maySee =
        state.phase === "finished" ||
        authoritative.side === viewer ||
        publicFlag ||
        publicRuleIdentityIsVisible(state, authoritative.id) ||
        known.has(authoritative.id);
      expect(
        projected.type === (maySee ? authoritative.type : null),
        "privacyLeaks",
        `${viewer} received an invalid identity for ${authoritative.id}.`,
        { expectedVisible: maySee, actualType: projected.type },
      );
    }
    if (state.phase !== "finished") {
      expect(projection.replay === null, "privacyLeaks", `${viewer} received a live replay archive.`);
    }
    for (const round of projection.augment?.draft.rounds ?? []) {
      const opponent = otherSide(viewer);
      if (!round.revealed) {
        expect(
          round.players[opponent].options === null && round.players[opponent].selectedId === null,
          "privacyLeaks",
          `${viewer} received private opponent draft data in round ${round.number}.`,
        );
      }
    }

    const hiddenPerspective = projectGame(state, "spectator", nowMs, {
      spectatorPolicy: "hidden",
      spectatorPerspective: viewer,
    });
    expect(
      hiddenPerspective.pieces.every((piece, index) => piece.type === projection.pieces[index]?.type),
      "privacyLeaks",
      `Hidden spectator perspective diverged from ${viewer}'s piece knowledge.`,
    );
    for (const projected of hiddenPerspective.pieces) {
      verifyProjectedRuleMetadata(state, projected, `Hidden ${viewer} spectator`);
    }
    expect(
      stableStringify(hiddenPerspective.augment?.draft ?? null) ===
        stableStringify(projection.augment?.draft ?? null),
      "privacyLeaks",
      `Hidden spectator perspective diverged from ${viewer}'s private draft knowledge.`,
    );
  }

  const hiddenSpectator = projectGame(state, "spectator", nowMs, {
    spectatorPolicy: "hidden",
  });
  expect(
    !("repetitionTracker" in hiddenSpectator),
    "privacyLeaks",
    "Hidden spectator projection exposed the private repetition tracker.",
  );
  for (const projected of hiddenSpectator.pieces) {
    const authoritative = state.pieces.find((piece) => piece.id === projected.id);
    expect(authoritative, "privacyLeaks", `Hidden spectator received unknown piece ${projected.id}.`);
    verifyProjectedRuleMetadata(state, projected, "Hidden spectator");
    const publicFlag = authoritative.type === "flag" && state.revealedFlags[authoritative.side];
    const maySee =
      state.phase === "finished" ||
      publicFlag ||
      publicRuleIdentityIsVisible(state, authoritative.id);
    expect(
      projected.type === (maySee ? authoritative.type : null),
      "privacyLeaks",
      `Hidden spectator received private identity for ${authoritative.id}.`,
    );
  }
  if (state.phase !== "finished") {
    expect(hiddenSpectator.replay === null, "privacyLeaks", "Hidden spectator received a live replay.");
  }
  for (const round of hiddenSpectator.augment?.draft.rounds ?? []) {
    if (round.revealed) continue;
    for (const side of ["black", "white"] as const) {
      expect(
        round.players[side].options === null && round.players[side].selectedId === null,
        "privacyLeaks",
        `Hidden spectator received ${side}'s private draft data in round ${round.number}.`,
      );
    }
  }
}

function verifyReplay(state: GameState) {
  if (!state.replay) return;
  for (const [index, move] of state.replay.moves.entries()) {
    const expectedMoveNumber = state.replay.baselineMoveNumber + index + 1;
    expect(
      move.moveNumber === expectedMoveNumber,
      "replayDivergences",
      `Replay move ${index} is numbered ${move.moveNumber}, expected ${expectedMoveNumber}.`,
      {
        baselineMoveNumber: state.replay.baselineMoveNumber,
        replayLength: state.replay.moves.length,
      },
    );
  }

  assertionCount += 1;
  let frames: ReturnType<typeof buildReplayFrames>;
  try {
    frames = buildReplayFrames(state.replay);
  } catch (error) {
    throw new FuzzFailure(
      "replayDivergences",
      error instanceof Error ? error.message : String(error),
      { moveNumber: state.moveNumber, replayMoves: state.replay.moves.length },
    );
  }
  expect(
    frames.length === state.replay.moves.length + 1,
    "replayDivergences",
    "Replay reconstruction stopped before all recorded moves.",
  );
  const last = frames.at(-1);
  expect(last, "replayDivergences", "Replay reconstruction returned no frames.");
  const replayById = new Map(last.pieces.map((piece) => [piece.id, piece]));
  for (const authoritative of state.pieces) {
    const replayPiece = replayById.get(authoritative.id);
    expect(replayPiece, "replayDivergences", `Replay lost piece ${authoritative.id}.`);
    expect(
      replayPiece.alive === authoritative.alive &&
        replayPiece.row === authoritative.row &&
        replayPiece.col === authoritative.col &&
        replayPiece.type === authoritative.type,
      "replayDivergences",
      `Replay diverged for piece ${authoritative.id}.`,
      {
        authoritative: {
          alive: authoritative.alive,
          row: authoritative.row,
          col: authoritative.col,
          type: authoritative.type,
        },
        replay: {
          alive: replayPiece.alive,
          row: replayPiece.row,
          col: replayPiece.col,
          type: replayPiece.type,
        },
      },
    );
  }
}

function completeDraft(
  state: GameState,
  nowMs: number,
  seed: string,
  repetitionOracle?: ReferenceRepetitionOracle,
) {
  let next = constrainActiveDraftToSimulationPool(state, `${seed}:initial`);
  const roundNumber = next.augment?.draft.activeRound;
  expect(roundNumber, "invariantFailures", "Draft phase has no active round.");
  for (const side of ["black", "white"] as const) {
    const round = projectGame(next, side, nowMs).augment?.draft.rounds.find(
      (candidate) => candidate.number === roundNumber,
    );
    expect(round, "invariantFailures", `${side} cannot project active round ${roundNumber}.`);
    if (round.players[side].locked) continue;
    const authoritativeRound = next.augment?.draft.rounds.find(
      (candidate) => candidate.number === roundNumber,
    );
    expect(authoritativeRound, "invariantFailures", `Missing authoritative round ${roundNumber}.`);
    if (authoritativeRound.players[side].refreshedSlot === null) {
      const slot = ((roundNumber + (side === "black" ? 0 : 1)) % 3) as AugmentSlot;
      const previousOptions = [...authoritativeRound.players[side].options];
      const previousSeenIds = [...(next.augment?.draft.seenBySide[side] ?? [])];
      const previousSeen = new Set(previousSeenIds);
      const removedId = previousOptions[slot];
      const productRefreshed = applyAuditedAction(
        next,
        side,
        { type: "augment_refresh", slot },
        nowMs,
        `${seed}:${side}:refresh`,
        repetitionOracle,
      );
      const productDraft = productRefreshed.augment?.draft;
      const productRound = productDraft?.rounds.find(
        (candidate) => candidate.number === roundNumber,
      );
      expect(productDraft && productRound, "invariantFailures", "Product refresh lost the active draft.");
      const productOptions = [...productRound.players[side].options];
      const productReplacementId = productOptions[slot];
      expect(
        productRound.players[side].refreshedSlot === slot,
        "invariantFailures",
        `${side} product refresh did not persist its slot.`,
      );
      expect(
        productReplacementId !== removedId && !previousSeen.has(productReplacementId),
        "duplicateSettlements",
        `${side} product refresh repeated an encountered card.`,
        { removedId, replacementId: productReplacementId, roundNumber },
      );
      expect(
        previousOptions.every(
          (id, index) => index === slot || productOptions[index] === id,
        ),
        "duplicateSettlements",
        `${side} product refresh moved an untouched offer slot.`,
        { previousOptions, productOptions, slot, roundNumber },
      );
      expect(
        stableStringify(productDraft.seenBySide[side].slice(0, previousSeenIds.length)) ===
          stableStringify(previousSeenIds) &&
          productDraft.seenBySide[side][previousSeenIds.length] === productReplacementId &&
          productDraft.seenBySide[side].length === previousSeenIds.length + 1 &&
          new Set(productDraft.seenBySide[side]).size === productDraft.seenBySide[side].length,
        "invariantFailures",
        `${side} product refresh did not append exactly one encounter.`,
      );

      next = constrainActiveDraftToSimulationPool(
        productRefreshed,
        `${seed}:${side}:post-refresh`,
      );
      const refreshedDraft = next.augment?.draft;
      const refreshedRound = refreshedDraft?.rounds.find(
        (candidate) => candidate.number === roundNumber,
      );
      expect(refreshedDraft && refreshedRound, "invariantFailures", "Refresh lost the active draft.");
      const replacementId = refreshedRound.players[side].options[slot];
      expect(
        refreshedRound.players[side].refreshedSlot === slot,
        "invariantFailures",
        `${side} refresh did not persist its slot.`,
      );
      expect(
        refreshedRound.players[side].options.every(isSimulationEligibleAugment) &&
          !previousSeen.has(replacementId) &&
          (isSimulationEligibleAugment(productReplacementId)
            ? replacementId === productReplacementId
            : replacementId !== productReplacementId),
        "duplicateSettlements",
        `${side} simulation refresh filter did not preserve or locally replace the product result.`,
        { productReplacementId, replacementId, roundNumber },
      );
      expect(
        productOptions.every(
          (id, index) => index === slot || refreshedRound.players[side].options[index] === id,
        ) && refreshedRound.players[side].refreshedSlot === productRound.players[side].refreshedSlot,
        "duplicateSettlements",
        `${side} simulation refresh filter moved an untouched offer slot.`,
        {
          productOptions,
          filteredOptions: refreshedRound.players[side].options,
          slot,
          roundNumber,
        },
      );
      expect(
        [...previousSeen]
          .filter(isSimulationEligibleAugment)
          .every((id) => refreshedDraft.seenBySide[side].includes(id)) &&
          refreshedDraft.seenBySide[side].includes(replacementId) &&
          refreshedDraft.seenBySide[side].every(isSimulationEligibleAugment),
        "invariantFailures",
        `${side} simulation refresh filter corrupted eligible encounter history.`,
      );

      const afterFirstRefresh = stableStringify(next);
      let secondRefreshRejected = false;
      try {
        applyPlayerAction(
          next,
          side,
          { type: "augment_refresh", slot: ((slot + 1) % 3) as AugmentSlot },
          nowMs,
        );
      } catch (error) {
        secondRefreshRejected =
          error instanceof GameRuleError && error.code === "REFRESH_ALREADY_USED";
      }
      expect(
        secondRefreshRejected,
        "duplicateSettlements",
        `${side} received more than one refresh in round ${roundNumber}.`,
      );
      expect(
        stableStringify(next) === afterFirstRefresh,
        "duplicateSettlements",
        "A rejected second refresh mutated authoritative state.",
      );
      verifyProjectionPrivacy(next, nowMs);
    }
    const refreshedProjection = projectGame(next, side, nowMs).augment?.draft.rounds.find(
      (candidate) => candidate.number === roundNumber,
    );
    expect(
      refreshedProjection,
      "invariantFailures",
      `${side} cannot project refreshed round ${roundNumber}.`,
    );
    const selected = refreshedProjection.players[side].options?.[0];
    expect(selected, "invariantFailures", `${side} has no private draft options.`);
    next = applyAuditedAction(
      next,
      side,
      { type: "augment_select", augmentId: selected },
      nowMs,
      `${seed}:${side}:select`,
      repetitionOracle,
    );
    verifyProjectionPrivacy(next, nowMs);
    next = applyAuditedAction(
      next,
      side,
      { type: "augment_lock" },
      nowMs,
      `${seed}:${side}:lock`,
      repetitionOracle,
    );
    verifyProjectionPrivacy(next, nowMs);
  }
  return next;
}

function chooseAction(state: GameState, random: SeededRandom, nowMs: number) {
  const actions = enumerateVisibleActions(projectGame(state, state.turn, nowMs), state.turn);
  if (!actions.length) return null;
  const augmentActions = actions.filter((action) => action.type.startsWith("augment_"));
  const pool = augmentActions.length && random.next() < 0.7 ? augmentActions : actions;
  return pool[random.int(pool.length)];
}

function verifyRejectedActionDoesNotMutate(state: GameState, nowMs: number) {
  const before = stableStringify(state);
  let rejected = false;
  try {
    applyPlayerAction(
      state,
      state.turn,
      { type: "move", from: { row: -1, col: -1 }, to: { row: 99, col: 99 } },
      nowMs,
    );
  } catch (error) {
    rejected = error instanceof GameRuleError;
  }
  expect(rejected, "invariantFailures", "An out-of-board fuzz move was unexpectedly accepted.");
  expect(
    stableStringify(state) === before,
    "duplicateSettlements",
    "A rejected action mutated the authoritative input state.",
  );
}

export const THREEFOLD_TRACE_SEED = "rules-v14-v3-no-clock-threefold-trace";
export const THREEFOLD_TRACE_CARD_PAIR = [
  "club-road-patrol",
  "club-engineer-oath",
] as const satisfies readonly [AugmentId, AugmentId];

function isEmptyDestination(state: GameState, action: PlayerAction) {
  if (action.type !== "move") return false;
  return !state.pieces.some(
    (piece) => piece.alive && piece.row === action.to.row && piece.col === action.to.col,
  );
}

function ordinaryNonCaptureActions(state: GameState, nowMs: number) {
  return enumerateVisibleActions(projectGame(state, state.turn, nowMs), state.turn).filter(
    (action): action is Extract<PlayerAction, { type: "move" }> =>
      action.type === "move" && isEmptyDestination(state, action),
  );
}

function samePositionValue(
  first: { row: number; col: number },
  second: { row: number; col: number },
) {
  return first.row === second.row && first.col === second.col;
}

function findFourPlyReturnCycle(state: GameState, nowMs: number) {
  const baseline = referenceStrategicPositionJson(state);
  for (const first of ordinaryNonCaptureActions(state, nowMs)) {
    const afterFirst = applyPlayerAction(state, state.turn, first, nowMs + 1);
    if (afterFirst.phase !== "playing") continue;
    for (const second of ordinaryNonCaptureActions(afterFirst, nowMs + 1)) {
      const afterSecond = applyPlayerAction(
        afterFirst,
        afterFirst.turn,
        second,
        nowMs + 2,
      );
      if (afterSecond.phase !== "playing") continue;
      const reverseFirst = ordinaryNonCaptureActions(afterSecond, nowMs + 2).find(
        (candidate) =>
          samePositionValue(candidate.from, first.to) &&
          samePositionValue(candidate.to, first.from),
      );
      if (!reverseFirst) continue;
      const afterReverseFirst = applyPlayerAction(
        afterSecond,
        afterSecond.turn,
        reverseFirst,
        nowMs + 3,
      );
      if (afterReverseFirst.phase !== "playing") continue;
      const reverseSecond = ordinaryNonCaptureActions(afterReverseFirst, nowMs + 3).find(
        (candidate) =>
          samePositionValue(candidate.from, second.to) &&
          samePositionValue(candidate.to, second.from),
      );
      if (!reverseSecond) continue;
      const returned = applyPlayerAction(
        afterReverseFirst,
        afterReverseFirst.turn,
        reverseSecond,
        nowMs + 4,
      );
      if (
        returned.phase === "playing" &&
        referenceStrategicPositionJson(returned) === baseline
      ) {
        return [first, second, reverseFirst, reverseSecond] as const;
      }
    }
  }
  throw new Error("Known threefold trace could not find its legal four-ply return cycle.");
}

function applyTraceCycle(
  initial: GameState,
  actions: readonly PlayerAction[],
  repetitions: number,
  nowMs: number,
  oracle: ReferenceRepetitionOracle,
  label: string,
) {
  let state = initial;
  const occurrences: number[] = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    for (const [index, action] of actions.entries()) {
      state = applyAuditedAction(
        state,
        state.turn,
        action,
        nowMs,
        `${THREEFOLD_TRACE_SEED}:${label}:${repetition}:${index}`,
        oracle,
      );
      occurrences.push(projectGame(state, "black", nowMs).repetition?.currentOccurrences ?? 0);
    }
  }
  return { state, nowMs, occurrences };
}

/** A bounded, deterministic product trace used by tests and every rules worker. */
export function runThreefoldTrace() {
  const nowMs = 1_000_000;
  const oracle = createReferenceRepetitionOracle();
  let state = createControlledPairGame(
    THREEFOLD_TRACE_CARD_PAIR[0],
    THREEFOLD_TRACE_CARD_PAIR[1],
    "black",
    THREEFOLD_TRACE_SEED,
    nowMs,
  );
  for (let move = 0; move < 9; move += 1) {
    const action = ordinaryNonCaptureActions(state, nowMs)[0];
    expect(
      action,
      "hangs",
      `Known threefold trace has no non-capturing setup move at ply ${move + 1}.`,
    );
    state = applyAuditedAction(
      state,
      state.turn,
      action,
      nowMs,
      `${THREEFOLD_TRACE_SEED}:opening:${move}`,
      oracle,
    );
  }
  expect(
    state.phase === "augment_draft" && state.augment?.draft.activeRound === 2,
    "invariantFailures",
    "Known threefold trace did not enter the production second draft at move 9.",
  );
  state = constrainActiveDraftToSimulationPool(
    state,
    `${THREEFOLD_TRACE_SEED}:round-two`,
  );
  for (const side of ["black", "white"] as const) {
    const round = projectGame(state, side, nowMs).augment?.draft.rounds.find(
      (candidate) => candidate.number === 2,
    );
    const selection = round?.players[side].options?.[0];
    expect(selection, "invariantFailures", `Known trace has no ${side} round-two offer.`);
    state = applyAuditedAction(
      state,
      side,
      { type: "augment_select", augmentId: selection },
      nowMs,
      `${THREEFOLD_TRACE_SEED}:${side}:select`,
      oracle,
    );
    state = applyAuditedAction(
      state,
      side,
      { type: "augment_lock" },
      nowMs,
      `${THREEFOLD_TRACE_SEED}:${side}:lock`,
      oracle,
    );
  }
  expect(
    [
      ...(state.augment?.draft.loadouts.black ?? []),
      ...(state.augment?.draft.loadouts.white ?? []),
    ].every(isSimulationEligibleAugment),
    "invariantFailures",
    "Known trace selected an excluded clock augment.",
  );
  expect(
    state.phase === "playing" &&
      projectGame(state, "black", nowMs).repetition?.currentOccurrences === 1,
    "invariantFailures",
    "Known trace did not seed the first eligible v2 occurrence after round-two reveal.",
  );
  const eligibleBaseline = state;
  const sampledWorld = determinizeFromProjection(
    eligibleBaseline,
    "black",
    `${THREEFOLD_TRACE_SEED}:sampled-world`,
    nowMs,
  );
  expect(
    sampledWorld.repetitionTracker?.currentOccurrences === 1 &&
      sampledWorld.repetitionTracker.salt !== eligibleBaseline.repetitionTracker?.salt &&
      !Object.keys(sampledWorld.repetitionTracker.counts).some((digest) =>
        Object.hasOwn(eligibleBaseline.repetitionTracker?.counts ?? {}, digest)
      ),
    "privacyLeaks",
    "Balance determinization copied private repetition evidence instead of seeding a public-occurrence baseline.",
  );
  const cycle = findFourPlyReturnCycle(eligibleBaseline, nowMs);
  const v2FirstCycle = applyTraceCycle(
    eligibleBaseline,
    cycle,
    1,
    nowMs,
    oracle,
    "v2-first-cycle",
  );
  const secondOccurrenceWorld = determinizeFromProjection(
    v2FirstCycle.state,
    "black",
    `${THREEFOLD_TRACE_SEED}:second-occurrence-world`,
    v2FirstCycle.nowMs,
  );
  expect(
    secondOccurrenceWorld.repetitionTracker?.currentOccurrences === 2 &&
      secondOccurrenceWorld.repetitionTracker.salt !==
        v2FirstCycle.state.repetitionTracker?.salt,
    "privacyLeaks",
    "Balance determinization did not preserve the public second occurrence with fresh evidence.",
  );
  const v2FinalCycle = applyTraceCycle(
    v2FirstCycle.state,
    cycle,
    1,
    v2FirstCycle.nowMs,
    oracle,
    "v2-final-cycle",
  );
  const v2 = {
    ...v2FinalCycle,
    occurrences: [...v2FirstCycle.occurrences, ...v2FinalCycle.occurrences],
  };
  expect(
    isThreefoldTerminal(v2.state) &&
      v2.occurrences.at(-1) === THREEFOLD_REPETITION_THRESHOLD &&
      v2.state.events.at(-1)?.result === "draw_repetition",
    "invariantFailures",
    "Known v2 trace did not end naturally on the third strategic occurrence.",
  );

  const legacy = structuredClone(eligibleBaseline);
  legacy.rulesVersion = LEGACY_AUGMENT_RULES_VERSION;
  legacy.drawReason = null;
  delete legacy.repetitionTracker;
  const legacyResult = applyTraceCycle(
    legacy,
    cycle,
    2,
    nowMs,
    createReferenceRepetitionOracle(),
    "legacy-v1",
  );
  expect(
    legacyResult.state.phase === "playing",
    "invariantFailures",
    "Legacy augment v1 incorrectly adopted the v2 threefold adjudicator.",
  );

  const classic = structuredClone(eligibleBaseline);
  classic.rulesVersion = CLASSIC_RULES_VERSION;
  classic.drawReason = null;
  classic.augment = null;
  delete classic.repetitionTracker;
  const classicResult = applyTraceCycle(
    classic,
    cycle,
    2,
    nowMs,
    createReferenceRepetitionOracle(),
    "classic",
  );
  expect(
    classicResult.state.phase === "playing",
    "invariantFailures",
    "Classic mode incorrectly adopted the v2 threefold adjudicator.",
  );

  return {
    seed: THREEFOLD_TRACE_SEED,
    cardPair: [...THREEFOLD_TRACE_CARD_PAIR],
    cycle: structuredClone(cycle),
    v2Occurrences: v2.occurrences,
    v2FinishReason: v2.state.finishReason,
    v2DrawReason: v2.state.drawReason ?? null,
    sampledWorldOccurrences: sampledWorld.repetitionTracker?.currentOccurrences ?? null,
    secondOccurrenceSampled:
      secondOccurrenceWorld.repetitionTracker?.currentOccurrences ?? null,
    sampledWorldUsesFreshEvidence:
      sampledWorld.repetitionTracker?.salt !== eligibleBaseline.repetitionTracker?.salt,
    legacyPhase: legacyResult.state.phase,
    classicPhase: classicResult.state.phase,
  };
}

function runGame(
  blackCard: AugmentId,
  whiteCard: AugmentId,
  gameIndex: number,
  seed: number,
  maxMoves: number,
) {
  const assertionsBefore = assertionCount;
  const random = new SeededRandom(`${seed}:rules:${gameIndex}`);
  const repetitionOracle = createReferenceRepetitionOracle();
  const nowMs = 1_000_000;
  verifySetupPrivacyScenarios(`${seed}:rules:${gameIndex}:setup-privacy`, nowMs);
  let state = createControlledPairGame(
    blackCard,
    whiteCard,
    gameIndex % 2 === 0 ? "black" : "white",
    `${seed}:rules:${gameIndex}:setup`,
    nowMs,
  );
  let actionsApplied = 0;
  verifyBoardAndAccounting(state);
  verifyProjectionPrivacy(state, nowMs);
  verifyReplay(state);

  while (state.phase !== "finished" && state.moveNumber < maxMoves) {
    if (actionsApplied % 7 === 0) verifyRejectedActionDoesNotMutate(state, nowMs);
    if (state.phase === "augment_draft") {
      state = completeDraft(
        state,
        nowMs,
        `${seed}:rules:${gameIndex}:${actionsApplied}`,
        repetitionOracle,
      );
    } else {
      expect(state.phase === "playing", "hangs", `Unexpected phase ${state.phase}.`);
      const action = chooseAction(state, random, nowMs);
      expect(action, "hangs", "No visible action exists while the game remains active.");
      state = applyAuditedAction(
        state,
        state.turn,
        action as PlayerAction,
        nowMs,
        `${seed}:rules:${gameIndex}:action:${actionsApplied}`,
        repetitionOracle,
      );
      actionsApplied += 1;
    }
    verifyBoardAndAccounting(state);
    expect(
      [
        ...(state.augment?.draft.loadouts.black ?? []),
        ...(state.augment?.draft.loadouts.white ?? []),
      ].every(isSimulationEligibleAugment),
      "invariantFailures",
      "Rules simulation selected an excluded clock augment.",
    );
    verifyProjectionPrivacy(state, nowMs);
    verifyReplay(state);
  }

  const capped = state.phase !== "finished";
  if (capped) {
    state = applyAuditedAction(
      state,
      state.turn,
      { type: "resign" },
      nowMs,
      undefined,
      repetitionOracle,
    );
    verifyBoardAndAccounting(state);
    verifyProjectionPrivacy(state, nowMs);
    verifyReplay(state);
  }
  return { state, actionsApplied, capped, assertions: assertionCount - assertionsBefore };
}

async function run() {
  const args = parseWorkerArguments(process.argv.slice(2));
  const pairs = coveragePairs();
  const journal = await WorkerJournal.open<RulesWorkerState>(
    "rules",
    args,
    () => ({ gameIndex: 0 }),
    (value) => {
      const candidate = value as Partial<RulesWorkerState>;
      if (!Number.isSafeInteger(candidate?.gameIndex)) throw new Error("Invalid rules worker state.");
      return candidate as RulesWorkerState;
    },
  );
  let completedUnit = false;
  let stopped = false;
  const maxMoves = args.profile === "smoke" ? 18 : 300;
  const traceAssertionsBefore = assertionCount;
  let traceAssertions = 0;
  try {
    runThreefoldTrace();
    traceAssertions = assertionCount - traceAssertionsBefore;
  } catch (error) {
    if (error instanceof FuzzFailure) journal.fail(error.category, error, error.context);
    else journal.fail("invariantFailures", error, { trace: THREEFOLD_TRACE_SEED });
  }

  while (totalFailures(journal.segment) === 0) {
    if (completedUnit && (journal.deadlineReached() || await stopWasRequested(args.stopPath))) {
      stopped = await stopWasRequested(args.stopPath);
      break;
    }
    const [blackCard, whiteCard] = pairs[journal.state.gameIndex % pairs.length];
    try {
      const result = runGame(
        blackCard,
        whiteCard,
        journal.state.gameIndex,
        args.seed,
        maxMoves,
      );
      const delta = emptyCounters();
      delta.loops = 1;
      delta.games = 1;
      delta.moves = result.state.moveNumber;
      delta.cappedGames = Number(result.capped);
      delta.assertions = result.assertions + traceAssertions;
      traceAssertions = 0;
      for (const id of new Set([
        ...(result.state.augment?.draft.loadouts.black ?? [blackCard]),
        ...(result.state.augment?.draft.loadouts.white ?? [whiteCard]),
      ])) {
        delta.cardCoverage[id] += 1;
      }
      journal.addCounters(delta);
    } catch (error) {
      if (error instanceof FuzzFailure) journal.fail(error.category, error, error.context);
      else journal.fail("exceptions", error, { gameIndex: journal.state.gameIndex });
    }
    journal.state.gameIndex += 1;
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

export { coveragePairs, verifyProjectionPrivacy };
