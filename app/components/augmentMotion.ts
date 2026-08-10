import {
  getAugmentDefinition,
  type AugmentDefinition,
  type AugmentId,
} from "../../lib/augments.ts";

export const AUGMENT_DRAFT_MOTION_MS = {
  dealCard: 560,
  dealStagger: 110,
  dealSettle: 90,
  fadeAlternatives: 260,
  centerSelection: 420,
  turnSelection: 1_360,
  awaitServerMax: 8_000,
  dockSelection: 640,
  recoverSelection: 320,
} as const;

export const AUGMENT_BURN_MOTION_MS = 1_280;

export function shouldAnimateAugmentBurn(
  charges: number,
  previousCount: number | undefined,
  nextCount: number,
) {
  return charges === 1
    && previousCount !== undefined
    && previousCount < 1
    && nextCount >= 1;
}

export interface AugmentInteractionContext {
  enabled: boolean;
  isOwnTurn: boolean;
  pendingReconId: AugmentId | null;
}

export function canInteractWithAugment(
  augment: AugmentDefinition,
  context: AugmentInteractionContext,
) {
  if (!context.enabled || augment.activation !== "active") return false;
  if (augment.effect.kind === "movement" || augment.effect.kind === "exchange") {
    return context.isOwnTurn;
  }
  return augment.effect.kind === "reconnaissance"
    && augment.effect.mode === "choose_enemy"
    && context.pendingReconId === augment.id;
}

export function shouldKeepActiveReconSelection(
  augmentId: AugmentId,
  pendingRecon: { augmentId: AugmentId; remaining: number } | null | undefined,
) {
  return pendingRecon?.augmentId === augmentId && pendingRecon.remaining > 0;
}

export function reconcileActiveAugmentAfterProjection(
  activeAugmentId: AugmentId | null,
  pendingRecon: { augmentId: AugmentId; remaining: number } | null | undefined,
) {
  if (pendingRecon && pendingRecon.remaining > 0) return pendingRecon.augmentId;
  if (!activeAugmentId) return null;
  return getAugmentDefinition(activeAugmentId).effect.kind === "reconnaissance"
    ? null
    : activeAugmentId;
}

export interface AugmentRoundLockProjection {
  number: number;
  players: {
    black: { locked: boolean };
    white: { locked: boolean };
  };
}

export function wasAugmentLockConfirmedAfterConflict(
  viewer: "black" | "white" | "spectator" | null | undefined,
  requestedRound: number | null | undefined,
  rounds: readonly AugmentRoundLockProjection[] | null | undefined,
) {
  if ((viewer !== "black" && viewer !== "white") || requestedRound == null) return false;
  return rounds?.find((round) => round.number === requestedRound)?.players[viewer].locked === true;
}

export type AugmentDraftMotionPhase =
  | "dealing"
  | "choosing"
  | "fading"
  | "centering"
  | "turning"
  | "awaiting-server"
  | "awaiting-late-server"
  | "docking"
  | "recovering"
  | "settled";

export interface AugmentDraftMotionState {
  phase: AugmentDraftMotionPhase;
  serverAcknowledged: boolean;
  serverRejected?: boolean;
}

export type AugmentDraftMotionEvent =
  | { type: "DEAL_FINISHED" }
  | { type: "LOCK_REQUESTED" }
  | { type: "FADE_FINISHED" }
  | { type: "CENTER_FINISHED" }
  | { type: "TURN_FINISHED" }
  | { type: "SERVER_LOCKED" }
  | { type: "SERVER_LOCKED_PASSIVE" }
  | { type: "SERVER_REJECTED" }
  | { type: "SERVER_TIMEOUT" }
  | { type: "DOCK_FINISHED" }
  | { type: "RECOVERY_FINISHED" };

export function reduceAugmentDraftMotion(
  state: AugmentDraftMotionState,
  event: AugmentDraftMotionEvent,
): AugmentDraftMotionState {
  if (event.type === "SERVER_LOCKED_PASSIVE") {
    return { phase: "settled", serverAcknowledged: true, serverRejected: false };
  }

  if (event.type === "SERVER_LOCKED") {
    return {
      phase: ["awaiting-server", "awaiting-late-server", "choosing"].includes(state.phase)
        ? "docking"
        : state.phase,
      serverAcknowledged: true,
      serverRejected: false,
    };
  }

  if (event.type === "SERVER_REJECTED") {
    if (["fading", "centering", "turning", "awaiting-server"].includes(state.phase)) {
      return { phase: "recovering", serverAcknowledged: false, serverRejected: true };
    }
    if (state.phase === "recovering") {
      return { ...state, serverAcknowledged: false, serverRejected: true };
    }
    if (state.phase === "awaiting-late-server") {
      return { phase: "choosing", serverAcknowledged: false, serverRejected: true };
    }
    return state;
  }

  if (event.type === "SERVER_TIMEOUT") {
    if (state.phase === "awaiting-server") {
      return { phase: "recovering", serverAcknowledged: false, serverRejected: false };
    }
    return state;
  }

  switch (state.phase) {
    case "dealing":
      return event.type === "DEAL_FINISHED"
        ? { ...state, phase: "choosing" }
        : state;
    case "choosing":
      return event.type === "LOCK_REQUESTED"
        ? { phase: "fading", serverAcknowledged: false, serverRejected: false }
        : state;
    case "fading":
      return event.type === "FADE_FINISHED"
        ? { ...state, phase: "centering" }
        : state;
    case "centering":
      return event.type === "CENTER_FINISHED"
        ? { ...state, phase: "turning" }
        : state;
    case "turning":
      return event.type === "TURN_FINISHED"
        ? {
            ...state,
            phase: state.serverAcknowledged ? "docking" : "awaiting-server",
          }
        : state;
    case "awaiting-server":
      return state;
    case "awaiting-late-server":
      return state;
    case "docking":
      return event.type === "DOCK_FINISHED"
        ? { ...state, phase: "settled" }
        : state;
    case "recovering":
      if (event.type !== "RECOVERY_FINISHED") return state;
      if (state.serverAcknowledged) {
        return { phase: "docking", serverAcknowledged: true, serverRejected: false };
      }
      if (state.serverRejected) {
        return { phase: "choosing", serverAcknowledged: false, serverRejected: true };
      }
      return {
        phase: "awaiting-late-server",
        serverAcknowledged: false,
        serverRejected: false,
      };
    case "settled":
      return state;
  }
}

export function augmentDraftPhaseDuration(
  phase: AugmentDraftMotionPhase,
  optionCount: number,
  reducedMotion: boolean,
) {
  if (reducedMotion) return 0;
  switch (phase) {
    case "dealing":
      return AUGMENT_DRAFT_MOTION_MS.dealCard
        + AUGMENT_DRAFT_MOTION_MS.dealStagger * Math.max(0, optionCount - 1)
        + AUGMENT_DRAFT_MOTION_MS.dealSettle;
    case "fading":
      return AUGMENT_DRAFT_MOTION_MS.fadeAlternatives;
    case "centering":
      return AUGMENT_DRAFT_MOTION_MS.centerSelection;
    case "turning":
      return AUGMENT_DRAFT_MOTION_MS.turnSelection;
    case "awaiting-server":
      return AUGMENT_DRAFT_MOTION_MS.awaitServerMax;
    case "awaiting-late-server":
      return null;
    case "docking":
      return AUGMENT_DRAFT_MOTION_MS.dockSelection;
    case "recovering":
      return AUGMENT_DRAFT_MOTION_MS.recoverSelection;
    case "choosing":
    case "settled":
      return null;
  }
}
