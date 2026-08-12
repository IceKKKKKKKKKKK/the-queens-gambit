import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AUGMENT_DRAFT_MOTION_MS,
  AUGMENT_REFRESH_MOTION_MS,
  augmentRefreshPhaseAfterAsh,
  augmentDraftPhaseDuration,
  canInteractWithAugment,
  didAugmentRefreshReplaceCard,
  reconcileActiveAugmentAfterProjection,
  reduceAugmentDraftMotion,
  shouldAnimateAugmentBurn,
  shouldKeepActiveReconSelection,
  wasAugmentLockConfirmedAfterConflict,
  type AugmentDraftMotionState,
} from "../app/components/augmentMotion.ts";
import {
  AUGMENT_EFFECT_ANIMATION_MS,
  augmentBoardEffectsForReplayTransition,
  augmentBoardEffectsForTransition,
  createRedeployDraft,
  redeployChangedCount,
  redeployPlacements,
  swapRedeployPieces,
} from "../app/components/augmentBoardUi.ts";
import {
  clearPendingRoomInvite,
  pendingRoomInviteKey,
  readPendingRoomInvite,
  signInPathWithInviteRetry,
  signInPathWithWatchOnly,
  stageRoomInviteForSignIn,
  type SessionStorageLike,
} from "../app/components/pendingRoomInvite.ts";
import { roomEnvelopeFromTransport } from "../app/components/roomEnvelope.ts";
import {
  INITIAL_LOBBY_SCENE,
  markLobbyEntered,
  playerHandleErrorMessage,
  recentWinRateFor,
  reduceLobbyScene,
  shouldShowLobbyEntry,
} from "../app/components/lobbyScene.ts";
import { getAugmentDefinition } from "../lib/augments.ts";
import {
  movementAnimationForTransition,
  type ProjectedGame,
  type ReplayMove,
} from "../lib/game.ts";

class MemorySessionStorage implements SessionStorageLike {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

test("the lobby ceremony runs once per session and direct room links bypass it", () => {
  const storage = new MemorySessionStorage();
  const key = "junqi:lobby-entered:test";
  assert.equal(shouldShowLobbyEntry(storage, key, false), true);
  storage.setItem(key, "1");
  assert.equal(shouldShowLobbyEntry(storage, key, false), false);

  const directStorage = new MemorySessionStorage();
  assert.equal(shouldShowLobbyEntry(directStorage, key, true), false);
  assert.equal(directStorage.getItem(key), "1");
  assert.equal(shouldShowLobbyEntry(null, key, true), false);
  const acceptedRoomStorage = new MemorySessionStorage();
  markLobbyEntered(acceptedRoomStorage, key);
  assert.equal(shouldShowLobbyEntry(acceptedRoomStorage, key, false), false);
  const gameSource = readFileSync(new URL("../app/GameApp.tsx", import.meta.url), "utf8");
  assert.match(gameSource, /if \(hasRoom\) markLobbyEntered\(browserSessionStorage\(\), LOBBY_ENTRY_SESSION_KEY\)/);
  assert.match(gameSource, /function acceptRoom[\s\S]*?markLobbyEntered\(browserSessionStorage\(\), LOBBY_ENTRY_SESSION_KEY\)/);
});

test("the personal scene derives recent-ten results and safe handle errors", () => {
  assert.equal(
    recentWinRateFor(["win", "loss", "draw", "win", "win", "loss", "win", "loss", "win", "loss", "win"]),
    0.5,
  );
  assert.equal(recentWinRateFor([]), null);
  assert.equal(playerHandleErrorMessage("HANDLE_TAKEN"), "这个玩家 ID 已被使用。");
  assert.equal(playerHandleErrorMessage("INVALID_HANDLE"), "这个玩家 ID 不符合规则。");
  assert.equal(playerHandleErrorMessage("NETWORK"), "暂时无法更新玩家 ID，请稍后重试。");
});

test("lobby scenes return through a cancellable reducer while preserving focus provenance", () => {
  const entry = reduceLobbyScene(INITIAL_LOBBY_SCENE, { type: "INITIALIZE", showEntry: true });
  const opening = reduceLobbyScene(entry, { type: "ENTER" });
  const hub = reduceLobbyScene(opening, { type: "ENTRY_FINISHED" });
  const laneOpening = reduceLobbyScene(hub, { type: "OPEN_LANE", lane: "wild" });
  const interrupted = reduceLobbyScene(laneOpening, { type: "CLOSE_LANE" });
  const returned = reduceLobbyScene(interrupted, { type: "LANE_CLOSED" });
  assert.deepEqual(returned, { phase: "hub", lane: null, lastLane: "wild" });
  assert.equal(reduceLobbyScene(returned, { type: "LANE_OPENED" }), returned);
});

function projectedGameFixture(
  pieces: ProjectedGame["pieces"],
  events: ProjectedGame["events"] = [],
): ProjectedGame {
  return {
    rulesVersion: "augment-duel-dark-v3",
    phase: "playing",
    joined: { black: true, white: true },
    ready: { black: true, white: true },
    turn: "black",
    winner: null,
    finishReason: null,
    drawReason: null,
    revealedFlags: { black: false, white: false },
    pieces,
    events,
    moveNumber: 1,
    replay: null,
    movedPieceIds: [],
    clock: null,
    mode: "augment",
    augment: null,
    repetition: null,
  };
}

test("player invite survives sign-in only in same-tab session storage and is consumed safely", () => {
  const storage = new MemorySessionStorage();
  const code = "ABCD2345";
  const invite = "safe_player_invite_token_1234567890";
  const staged = stageRoomInviteForSignIn(
    `https://game.example/?room=${code}#invite=${invite}`,
    storage,
  );
  assert.deepEqual(staged, { code, status: "stored", clearFragment: true });
  assert.equal(storage.getItem(pendingRoomInviteKey(code)), invite);

  const recoveredForClaim = readPendingRoomInvite(storage, code);
  assert.equal(recoveredForClaim, invite);
  clearPendingRoomInvite(storage, code);
  assert.equal(readPendingRoomInvite(storage, code), null);

  storage.setItem(pendingRoomInviteKey(code), invite);
  const watched = stageRoomInviteForSignIn(
    `https://game.example/?room=${code}&watch=1#invite=another_safe_invite_token_987654321`,
    storage,
  );
  assert.equal(watched.status, "watch_only");
  assert.equal(storage.getItem(pendingRoomInviteKey(code)), invite, "watch mode must not consume or replace an invite");
  const watchSignInPath = signInPathWithWatchOnly(
    "/signin-with-chatgpt?return_to=%2F%3Froom%3DABCD2345",
    code,
    "https://game.example",
  );
  assert.match(watchSignInPath, /watch%3D1/, "watch intent must survive the authentication redirect");

  const invalid = stageRoomInviteForSignIn(
    `https://game.example/?room=${code}#invite=short`,
    storage,
  );
  assert.equal(invalid.status, "invalid");
  assert.equal(readPendingRoomInvite(storage, code), null, "terminal invalid invites must clear pending state");
});

test("invite-storage fallback returns through a secret-free retry marker instead of silent spectating", () => {
  const code = "ABCD2345";
  const invite = "safe_player_invite_token_1234567890";
  const unavailable = stageRoomInviteForSignIn(
    `https://game.example/?room=${code}#invite=${invite}`,
    null,
  );
  assert.equal(unavailable.status, "storage_unavailable");
  const signInPath = signInPathWithInviteRetry(
    "/signin-with-chatgpt?return_to=%2F%3Froom%3DABCD2345",
    code,
    "https://game.example",
  );
  assert.match(signInPath, /invite_retry%3D1/);
  assert.doesNotMatch(signInPath, new RegExp(invite));

  const gameSource = readFileSync(new URL("../app/GameApp.tsx", import.meta.url), "utf8");
  assert.match(gameSource, /readPendingRoomInvite\(inviteStorage, code\)/);
  assert.match(gameSource, /claimSeat\(code, invitedToken, candidateToken\)/);
  assert.match(gameSource, /clearPendingRoomInvite\(inviteStorage, code\)/);
  assert.match(gameSource, /watchOnly[\s\S]*?clearInviteNavigationArtifacts/);
  assert.doesNotMatch(gameSource, /signInPath[^\n]*invite(?:d)?Token/);
});

test("create and claim responses preserve immediate room metadata without retaining credentials", () => {
  const custom = roomEnvelopeFromTransport({
    code: "FULLROOM",
    version: 0,
    viewer: "black" as const,
    snapshot: { phase: "setup" },
    roomKind: "custom" as const,
    gameMode: "augment" as const,
    spectatorPolicy: "full" as const,
    matchId: "private-match",
    setupDeadlineAt: null,
    playerToken: "black-secret",
    opponentInviteToken: "white-secret",
  });
  assert.equal(custom.spectatorPolicy, "full");
  assert.equal(custom.gameMode, "augment");
  assert.equal(custom.matchId, "private-match");
  assert.equal("playerToken" in custom, false);
  assert.equal("opponentInviteToken" in custom, false);

  const ranked = roomEnvelopeFromTransport({
    code: "RANKROOM",
    version: 4,
    viewer: "white" as const,
    spectatorPerspective: null,
    snapshot: { phase: "setup" },
    roomKind: "ranked" as const,
    gameMode: "augment" as const,
    spectatorPolicy: "hidden" as const,
    matchId: "ranked-match",
    setupDeadlineAt: 1_800_000_000_000,
    playerToken: "white-secret",
  });
  assert.equal(ranked.roomKind, "ranked");
  assert.equal(ranked.spectatorPolicy, "hidden");
  assert.equal(ranked.matchId, "ranked-match");
  assert.equal(ranked.setupDeadlineAt, 1_800_000_000_000);
});

test("GameApp accepts the complete create and claim room envelopes immediately", () => {
  const gameSource = readFileSync(new URL("../app/GameApp.tsx", import.meta.url), "utf8");
  assert.match(gameSource, /acceptRoom\(roomEnvelopeFromTransport\(created\), true\)/);
  assert.match(gameSource, /acceptRoom\(roomEnvelopeFromTransport\(claimed\), true\)/);
  assert.match(gameSource, /room\.spectatorPolicy === "full"[\s\S]*?观战链接已复制/);
  assert.doesNotMatch(
    gameSource,
    /acceptRoom\(\s*\{\s*code:\s*(?:created|claimed)\.code,[\s\S]*?snapshot:\s*(?:created|claimed)\.snapshot\s*\}/,
  );
});

test("threefold repetition is presented as a public poker-style warning without private evidence", () => {
  const gameSource = readFileSync(new URL("../app/GameApp.tsx", import.meta.url), "utf8");
  const lobbySource = readFileSync(new URL("../app/components/LobbyExperience.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const platformSource = readFileSync(new URL("../db/platform.ts", import.meta.url), "utf8");

  assert.match(
    gameSource,
    /game\.mode === "augment"[\s\S]*?game\.repetition\?\.active[\s\S]*?currentOccurrences === 2/,
  );
  assert.match(gameSource, /className="repetition-notice"[\s\S]*?重复局面[\s\S]*?2\/3/);
  assert.match(gameSource, /本局和棋 · \$\{drawReasonText\(snapshot\.drawReason\)\}/);
  assert.match(gameSource, /同一局面第三次出现 · 本局和棋/);
  assert.match(lobbySource, /match\.endedReason === "threefold_repetition"[\s\S]*?重复局面/);
  assert.match(css, /\.repetition-notice\s*\{[\s\S]*?border:\s*1px solid var\(--black\)/);
  assert.doesNotMatch(gameSource, /repetitionTracker|lastCountedDigest|\.salt\b|\.counts\b/);
  assert.match(platformSource, /reason === "draw" \|\| reason === "threefold_repetition"/);
});

test("GameApp uses the server-authoritative reconnaissance target projection", () => {
  const gameSource = readFileSync(new URL("../app/GameApp.tsx", import.meta.url), "utf8");
  assert.ok(
    gameSource.split("getProjectedAugmentReconTargets(").length - 1 >= 2,
    "availability and board highlighting must share the projected target helper",
  );
  assert.doesNotMatch(
    gameSource,
    /effect\.kind === "reconnaissance"\)[\s\S]{0,220}?piece\.type === null/,
  );
});

test("room polling clears only stale reconnaissance activation", () => {
  assert.equal(
    reconcileActiveAugmentAfterProjection("heart-targeted-recon", null),
    null,
  );
  assert.equal(
    reconcileActiveAugmentAfterProjection("spade-supreme-recon", {
      augmentId: "spade-supreme-recon",
      remaining: 0,
    }),
    null,
  );
  assert.equal(
    reconcileActiveAugmentAfterProjection("heart-rail-turn", null),
    "heart-rail-turn",
  );
  assert.equal(
    reconcileActiveAugmentAfterProjection("heart-remote-exchange", null),
    "heart-remote-exchange",
  );
  assert.equal(
    reconcileActiveAugmentAfterProjection("heart-rail-turn", {
      augmentId: "spade-supreme-recon",
      remaining: 2,
    }),
    "spade-supreme-recon",
  );
});

test("draft motion completes two-turn presentation before docking an acknowledged card", () => {
  let state: AugmentDraftMotionState = { phase: "choosing", serverAcknowledged: false };
  state = reduceAugmentDraftMotion(state, { type: "LOCK_REQUESTED" });
  assert.equal(state.phase, "fading");
  state = reduceAugmentDraftMotion(state, { type: "FADE_FINISHED" });
  state = reduceAugmentDraftMotion(state, { type: "CENTER_FINISHED" });
  assert.equal(state.phase, "turning");

  state = reduceAugmentDraftMotion(state, { type: "SERVER_LOCKED" });
  assert.equal(state.phase, "turning");
  assert.equal(state.serverAcknowledged, true);
  state = reduceAugmentDraftMotion(state, { type: "TURN_FINISHED" });
  assert.equal(state.phase, "docking");
  state = reduceAugmentDraftMotion(state, { type: "DOCK_FINISHED" });
  assert.equal(state.phase, "settled");
});

test("draft motion has bounded server wait and a recoverable rejection path", () => {
  const waiting: AugmentDraftMotionState = {
    phase: "awaiting-server",
    serverAcknowledged: false,
  };
  const recovering = reduceAugmentDraftMotion(waiting, { type: "SERVER_TIMEOUT" });
  assert.equal(recovering.phase, "recovering");
  assert.equal(
    augmentDraftPhaseDuration("awaiting-server", 3, false),
    AUGMENT_DRAFT_MOTION_MS.awaitServerMax,
  );
  const waitingLate = reduceAugmentDraftMotion(recovering, { type: "RECOVERY_FINISHED" });
  assert.equal(waitingLate.phase, "awaiting-late-server");
  assert.equal(augmentDraftPhaseDuration("turning", 3, true), 0);
  assert.equal(
    reduceAugmentDraftMotion(waitingLate, { type: "SERVER_LOCKED" }).phase,
    "docking",
  );
  assert.deepEqual(
    reduceAugmentDraftMotion(
      { phase: "choosing", serverAcknowledged: false },
      { type: "SERVER_LOCKED_PASSIVE" },
    ),
    { phase: "settled", serverAcknowledged: true, serverRejected: false },
  );
});

test("a rejection is explicit even when a pending render was never observed", () => {
  let state: AugmentDraftMotionState = { phase: "choosing", serverAcknowledged: false };
  state = reduceAugmentDraftMotion(state, { type: "LOCK_REQUESTED" });
  assert.equal(state.phase, "fading");
  state = reduceAugmentDraftMotion(state, { type: "SERVER_REJECTED" });
  assert.equal(state.phase, "recovering");
  assert.equal(state.serverRejected, true);
  state = reduceAugmentDraftMotion(state, { type: "RECOVERY_FINISHED" });
  assert.equal(state.phase, "choosing");
});

test("a 409 resync treats an already-locked requested round as idempotent success", () => {
  const rounds = [
    {
      number: 1,
      players: {
        black: { locked: true, selectedId: "spade-grand-maneuver" as const },
        white: { locked: true, selectedId: "spade-deep-strike" as const },
      },
    },
    {
      number: 2,
      players: {
        black: { locked: true, selectedId: "heart-rail-turn" as const },
        white: { locked: false },
      },
    },
  ];
  assert.equal(wasAugmentLockConfirmedAfterConflict("black", 2, rounds), true);
  assert.equal(
    wasAugmentLockConfirmedAfterConflict("black", 2, rounds, "heart-rail-turn"),
    true,
  );
  assert.equal(
    wasAugmentLockConfirmedAfterConflict("black", 2, rounds, "heart-targeted-recon"),
    false,
  );
  assert.equal(wasAugmentLockConfirmedAfterConflict("white", 2, rounds), false);
  assert.equal(wasAugmentLockConfirmedAfterConflict("black", 3, rounds), false);
  assert.equal(wasAugmentLockConfirmedAfterConflict("spectator", 2, rounds), false);
  assert.equal(wasAugmentLockConfirmedAfterConflict("black", null, rounds), false);
});

test("the action conflict path wires the original draft round into its idempotency check", () => {
  const gameSource = readFileSync(new URL("../app/GameApp.tsx", import.meta.url), "utf8");
  assert.match(gameSource, /const requestedAugmentRound = action\.type === "augment_lock" \|\| action\.type === "augment_pick"/);
  assert.match(gameSource, /wasAugmentLockConfirmedAfterConflict\([\s\S]*?requestedAugmentRound/);
  assert.match(
    gameSource,
    /狂野局以牌面为准：「偷梁换柱」可将军旗放在己方底线任意站点，「深呼吸」可将地雷放在己方后三排/,
  );
  assert.doesNotMatch(gameSource, /军旗只能在大本营；地雷只能在最后两排/);
  assert.doesNotMatch(gameSource, /(?:20|50) 张牌池/);
  const lobbySource = readFileSync(new URL("../app/components/LobbyExperience.tsx", import.meta.url), "utf8");
  assert.match(lobbySource, /七十张军令/);
});

test("an authenticated room keeps presence fresh for friend spectating", () => {
  const gameSource = readFileSync(new URL("../app/GameApp.tsx", import.meta.url), "utf8");
  assert.match(
    gameSource,
    /if \(!user \|\| !room\?\.code\) return;[\s\S]*?const heartbeat = async \(\) =>/,
  );
  assert.match(
    gameSource,
    /fetch\("\/api\/presence", \{ method: "POST" \}\)/,
  );
  assert.match(gameSource, /window\.setInterval\(heartbeat, 30_000\)/);
  assert.match(gameSource, /window\.clearInterval\(timer\)/);
});

test("exchange augments render two deterministic board-motion legs", () => {
  const gameSource = readFileSync(new URL("../app/GameApp.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(gameSource, /function ExchangeAnimationOverlay/);
  assert.match(gameSource, /data-exchange-leg=\{name\}/);
  assert.match(gameSource, /animation\.first\.pieceId, animation\.second\.pieceId/);
  assert.match(gameSource, /movementAnimation\.kind === "exchange"/);
  assert.match(css, /data-animation-outcome="exchange"/);
  assert.match(css, /\.exchange-animation-cell \.battle-animation-visual/);
});

test("a success arriving after the eight-second wait still docks the selected card", () => {
  let state: AugmentDraftMotionState = { phase: "choosing", serverAcknowledged: false };
  for (const event of [
    { type: "LOCK_REQUESTED" },
    { type: "FADE_FINISHED" },
    { type: "CENTER_FINISHED" },
    { type: "TURN_FINISHED" },
    { type: "SERVER_TIMEOUT" },
    { type: "RECOVERY_FINISHED" },
  ] as const) {
    state = reduceAugmentDraftMotion(state, event);
  }
  assert.equal(state.phase, "awaiting-late-server");
  state = reduceAugmentDraftMotion(state, { type: "SERVER_LOCKED" });
  assert.equal(state.phase, "docking");
  state = reduceAugmentDraftMotion(state, { type: "DOCK_FINISHED" });
  assert.equal(state.phase, "settled");
});

test("a late rejection releases the recovered choice without replaying the deal", () => {
  const waitingLate: AugmentDraftMotionState = {
    phase: "awaiting-late-server",
    serverAcknowledged: false,
    serverRejected: false,
  };
  const released = reduceAugmentDraftMotion(waitingLate, { type: "SERVER_REJECTED" });
  assert.equal(released.phase, "choosing");
  assert.equal(released.serverRejected, true);
});

test("passive locks from reconnect or second-round auto-pick settle without replay", () => {
  for (const phase of ["dealing", "choosing", "awaiting-server"] as const) {
    const settled = reduceAugmentDraftMotion(
      { phase, serverAcknowledged: false },
      { type: "SERVER_LOCKED_PASSIVE" },
    );
    assert.equal(settled.phase, "settled");
    assert.equal(settled.serverAcknowledged, true);
  }
});

test("a rapid second lock request cannot restart the presentation", () => {
  const fading = reduceAugmentDraftMotion(
    { phase: "choosing", serverAcknowledged: false },
    { type: "LOCK_REQUESTED" },
  );
  assert.strictEqual(
    reduceAugmentDraftMotion(fading, { type: "LOCK_REQUESTED" }),
    fading,
  );
});

test("reduced-motion uses zero-delay transitions and still reaches settled", () => {
  for (const phase of ["dealing", "fading", "centering", "turning", "docking", "recovering"] as const) {
    assert.equal(augmentDraftPhaseDuration(phase, 3, true), 0);
  }
  let state: AugmentDraftMotionState = { phase: "choosing", serverAcknowledged: false };
  state = reduceAugmentDraftMotion(state, { type: "LOCK_REQUESTED" });
  state = reduceAugmentDraftMotion(state, { type: "SERVER_LOCKED" });
  state = reduceAugmentDraftMotion(state, { type: "FADE_FINISHED" });
  state = reduceAugmentDraftMotion(state, { type: "CENTER_FINISHED" });
  state = reduceAugmentDraftMotion(state, { type: "TURN_FINISHED" });
  state = reduceAugmentDraftMotion(state, { type: "DOCK_FINISHED" });
  assert.equal(state.phase, "settled");
});

test("animation DOM hooks and visual invariants remain inspectable", () => {
  const draftSource = readFileSync(new URL("../app/components/AugmentDraft.tsx", import.meta.url), "utf8");
  const railSource = readFileSync(new URL("../app/components/AugmentRail.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../app/components/Augments.module.css", import.meta.url), "utf8");

  assert.match(draftSource, /data-animation-phase=/);
  assert.match(draftSource, /data-card-motion-index=/);
  assert.match(railSource, /shouldAnimateAugmentBurn/);
  assert.match(railSource, /publiclyRevealed/);
  assert.match(railSource, /张已锁定 · 待公开/);
  assert.match(railSource, /label === "我的" \? "我的" : `\$\{label\}的`/);
  assert.match(railSource, /hasLegalTarget !== false/);
  assert.match(railSource, /暂无目标/);
  assert.match(css, /rotateY\(720deg\)/);
  assert.match(css, /selected-card-double-turn/);
  assert.match(css, /card-burn-away/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(
    css,
    /\.draft:not\(\[data-animation-phase="dealing"\]\) \.draftOption\s*\{[\s\S]*?animation:\s*none/,
    "the deal animation must release transform before the selected card centers",
  );
  assert.doesNotMatch(draftSource, /animationend/i);
  assert.match(draftSource, /mountedRef\.current/);
  assert.match(draftSource, /clearTimeout/);
  assert.match(draftSource, /clearInterval/);
  assert.match(draftSource, /removeEventListener\("change"/);
});

test("direct draft pick keeps keyboard navigation focus-only and removes confirmation", () => {
  const draftSource = readFileSync(new URL("../app/components/AugmentDraft.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../app/components/Augments.module.css", import.meta.url), "utf8");

  assert.match(draftSource, /onPick: \(augmentId: AugmentId\)/);
  assert.match(draftSource, /onSelect=\{\(\) => requestPick\(augmentId, index\)\}/);
  assert.match(
    draftSource,
    /event\.key === "Enter" \|\| event\.key === " "[\s\S]*?event\.preventDefault\(\);[\s\S]*?event\.repeat[\s\S]*?requestPick\(option\.id, currentIndex\)/,
  );
  assert.match(draftSource, /setFocusedIndex\(targetIndex\);[\s\S]*?optionRefs\.current\[targetIndex\]\?\.focus\(\)/);
  assert.match(draftSource, /const motionBusy = motion\.phase === "dealing"/);
  assert.match(draftSource, /disabled=\{locked \|\| pending \|\| refreshMotion !== null \|\| motionBusy\}/);
  assert.match(draftSource, /refreshUsed \|\|[\s\S]*?motionBusy/);
  assert.doesNotMatch(draftSource, /onConfirm|confirmButton|锁定强化/);
  assert.match(css, /\.card\s*\{[\s\S]*?aspect-ratio:\s*5\s*\/\s*8/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?grid-auto-flow:\s*column[\s\S]*?scroll-snap-type:\s*x mandatory/);
});

test("refresh replacement uses ash, flicker, rejection recovery, and reduced motion", () => {
  const draftSource = readFileSync(new URL("../app/components/AugmentDraft.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../app/components/Augments.module.css", import.meta.url), "utf8");

  assert.equal(AUGMENT_REFRESH_MOTION_MS.ash, 520);
  assert.equal(AUGMENT_REFRESH_MOTION_MS.reveal, 280);
  assert.equal(didAugmentRefreshReplaceCard("spade-grand-maneuver", "heart-steady-advance"), true);
  assert.equal(didAugmentRefreshReplaceCard("spade-grand-maneuver", "spade-grand-maneuver"), false);
  assert.equal(didAugmentRefreshReplaceCard("spade-grand-maneuver", null), false);
  assert.equal(
    augmentRefreshPhaseAfterAsh("spade-grand-maneuver", "heart-steady-advance", false),
    "revealing",
  );
  assert.equal(
    augmentRefreshPhaseAfterAsh("spade-grand-maneuver", "spade-grand-maneuver", false),
    "awaiting-replacement",
  );
  assert.equal(
    augmentRefreshPhaseAfterAsh("spade-grand-maneuver", "heart-steady-advance", true),
    null,
  );
  assert.match(draftSource, /rejectRefresh/);
  assert.match(draftSource, /phase: "restoring"/);
  assert.match(draftSource, /data-refresh-phase=/);
  assert.match(draftSource, /outgoing: AugmentDefinition/);
  assert.match(draftSource, /slotRefresh\.phase !== "revealing"[\s\S]*?slotRefresh\.outgoing/);
  assert.match(
    draftSource,
    /window\.setTimeout\(\(\) => \{[\s\S]*?augmentRefreshPhaseAfterAsh\(outgoing\.id, incomingId, false\)[\s\S]*?AUGMENT_REFRESH_MOTION_MS\.ash/,
  );
  assert.match(css, /refresh-card-ash/);
  assert.match(css, /refresh-card-flicker/);
  assert.doesNotMatch(css, /clip-path|filter/);
  assert.match(css, /\.draft\s*\{[\s\S]*?--augment-paper:\s*var\(--paper, #fffdf7\)/);
  assert.match(css, /\.rail\s*\{[\s\S]*?--augment-paper:\s*var\(--paper, #fffdf7\)/);
  assert.match(css, /\.inspectOverlay\s*\{[\s\S]*?--augment-paper:\s*var\(--paper, #fffdf7\)/);
});

test("rail inspection is private, modal, focus-contained, and explicitly activated", () => {
  const railSource = readFileSync(new URL("../app/components/AugmentRail.tsx", import.meta.url), "utf8");
  const dialogSource = readFileSync(new URL("../app/components/AugmentInspectDialog.tsx", import.meta.url), "utf8");

  assert.match(railSource, /inspectable = Boolean\(augmentId && presentation\.augment && !presentation\.hidden\)/);
  assert.match(railSource, /data-augment-preview="true"/);
  assert.match(railSource, /<AugmentInspectDialog/);
  assert.doesNotMatch(railSource, /onSelect=\{[^}]*onActivate/);
  assert.match(dialogSource, /role="dialog"/);
  assert.match(dialogSource, /aria-modal="true"/);
  assert.match(dialogSource, /event\.key === "Escape"/);
  assert.match(dialogSource, /element\.setAttribute\("inert", ""\)/);
  assert.match(dialogSource, /returnFocusRef\.current/);
  assert.match(dialogSource, /pending \? "行动处理中…" : "发动军令"/);
});

test("rail hover preview portals above the board on an opaque paper surface", () => {
  const railSource = readFileSync(new URL("../app/components/AugmentRail.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../app/components/Augments.module.css", import.meta.url), "utf8");
  const globalCss = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const previewRule = css.slice(css.indexOf(".railPreview {"), css.indexOf(".railPreviewLabel"));
  const previewKeyframes = css.slice(
    css.indexOf("@keyframes inspect-preview-in"),
    css.indexOf("@keyframes inspect-overlay-in"),
  );

  assert.match(railSource, /import \{ createPortal \} from "react-dom"/);
  assert.match(railSource, /createPortal\([\s\S]*?data-augment-preview="true"[\s\S]*?document\.body/);
  assert.match(railSource, /previewAnchorX/);
  assert.match(railSource, /boundary\.left - 137/);
  assert.match(railSource, /previewBoundarySelector/);
  assert.match(railSource, /getBoundingClientRect\(\)/);
  assert.match(railSource, /--augment-preview-x/);
  assert.match(previewRule, /--augment-paper:\s*var\(--paper, #fffdf7\)/);
  assert.match(previewRule, /left:\s*var\(--augment-preview-x, 50%\)/);
  assert.match(previewRule, /background:\s*var\(--augment-paper, #fffdf7\)/);
  assert.match(previewRule, /z-index:\s*60/);
  assert.match(globalCss, /\.augment-draft-overlay\s*\{[\s\S]*?z-index:\s*80/);
  assert.match(previewRule, /opacity:\s*1/);
  assert.match(css, /@media \(max-width:\s*780px\)[\s\S]*?\.railPreview\s*\{\s*display:\s*none/);
  assert.doesNotMatch(previewKeyframes, /opacity:/);
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.railPreview\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?translate\(-50%, -50%\) scale\(1\)/,
  );
});

test("desktop setup docks the command rails beside the piece box and mobile keeps local scrolling", () => {
  const gameSource = readFileSync(new URL("../app/GameApp.tsx", import.meta.url), "utf8");
  const globalCss = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const railsIndex = gameSource.indexOf('<div className="command-rails"');
  const trayIndex = gameSource.indexOf("<PieceTray", railsIndex);
  const boardIndex = gameSource.indexOf('className="board-column"', railsIndex);

  assert.ok(railsIndex >= 0 && trayIndex > railsIndex, "the setup piece box follows the command rails");
  assert.ok(
    boardIndex > trayIndex,
    "the DOM follows command rails, setup piece box, then board for a coherent keyboard flow",
  );
  assert.match(gameSource, /game\.phase === "setup" && game\.augment && viewerSide \? "has-setup-command-dock"/);
  assert.match(
    globalCss,
    /@media \(min-width: 900px\)[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(200px, 232px\)\) minmax\(340px, 440px\)/,
  );
  assert.match(globalCss, /\.command-panel > \.command-rails\s*\{[\s\S]*?grid-column:\s*1/);
  assert.match(globalCss, /\.command-panel > \.piece-box\s*\{[\s\S]*?grid-column:\s*2/);
  assert.match(globalCss, /\.game-shell\.has-setup-command-dock \.setup-controls-panel\s*\{[\s\S]*?min-width:\s*0[\s\S]*?grid-column:\s*1 \/ 3/);
  assert.match(globalCss, /\.game-shell > \.command-panel,[\s\S]*?\.game-shell > \.setup-controls-panel\s*\{[\s\S]*?position:\s*static/);
  assert.match(
    globalCss,
    /@media \(min-width: 900px\) and \(max-width: 1180px\)[\s\S]*?\.activity-panel\s*\{[\s\S]*?grid-column:\s*1 \/ 4/,
  );
  assert.match(
    globalCss,
    /@media \(min-width: 1181px\)[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(200px, 232px\)\) minmax\(360px, 440px\) minmax\(230px, 280px\)/,
  );
  assert.match(globalCss, /@media \(max-width: 780px\)[\s\S]*?\.command-panel\s*\{\s*order:\s*1/);
  assert.match(globalCss, /@media \(max-width: 780px\)[\s\S]*?\.setup-controls-panel\s*\{\s*order:\s*3/);
  assert.match(globalCss, /@media \(max-width: 780px\)[\s\S]*?\.game-shell\.has-setup-command-dock \.command-panel\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(globalCss, /@media \(max-width: 780px\)[\s\S]*?\.game-shell\.has-setup-command-dock \.command-rails > \*\s*\{[\s\S]*?flex-basis:\s*100%/);
  assert.match(globalCss, /@media \(max-width: 780px\)[\s\S]*?\.command-rails\s*\{[\s\S]*?overflow-x:\s*auto/);
});

test("the mobile draft neither covers its third card nor exposes background controls", () => {
  const draftSource = readFileSync(new URL("../app/components/AugmentDraft.tsx", import.meta.url), "utf8");
  const augmentCss = readFileSync(new URL("../app/components/Augments.module.css", import.meta.url), "utf8");
  const globalCss = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(draftSource, /backgroundSiblings/);
  assert.match(draftSource, /setAttribute\("inert", ""\)/);
  assert.match(draftSource, /removeAttribute\("inert"\)/);
  assert.match(augmentCss, /@media \(max-width: 720px\)[\s\S]*?\.draftFooter\s*\{[\s\S]*?position:\s*static/);
  assert.doesNotMatch(augmentCss, /\.draftFooter\s*\{\s*position:\s*sticky/);
  assert.match(globalCss, /html:has\(\.augment-draft-overlay\)[\s\S]*?overflow:\s*hidden/);
  assert.match(globalCss, /\.friend-form button,[\s\S]*?min-height:\s*44px/);
  assert.match(globalCss, /\.wordmark-button\s*\{[\s\S]*?min-height:\s*44px/);
  assert.match(globalCss, /\.icon-button\s*\{[\s\S]*?height:\s*44px/);
  assert.match(globalCss, /\.rules-trigger,[\s\S]*?min-height:\s*44px/);
  assert.match(globalCss, /\.button\.compact\s*\{[\s\S]*?min-height:\s*44px/);
  assert.match(globalCss, /\.quiet-menu button\s*\{[\s\S]*?min-height:\s*44px/);
  assert.match(globalCss, /@media \(max-width: 780px\)[\s\S]*?\.station-hit\s*\{[\s\S]*?min-height:\s*44px/);
  assert.match(globalCss, /\.time-control-form button\s*\{[\s\S]*?min-height:\s*44px/);
  assert.match(globalCss, /@media \(max-width: 780px\)[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(globalCss, /\.board-column,\s*\n\s*\.side-panel\s*\{\s*min-width:\s*0/);
  assert.match(globalCss, /\.command-panel\s*\{\s*order:\s*1/);
  assert.match(globalCss, /\.setup-controls-panel\s*\{\s*order:\s*3/);
});

test("a pending extra move exposes a monochrome touch-safe pass control and clear rules", () => {
  const gameSource = readFileSync(new URL("../app/GameApp.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const actionsRoute = readFileSync(
    new URL("../app/api/rooms/[code]/actions/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(gameSource, /const canPassExtraMove = Boolean\([\s\S]*?game\.augment\?\.extraMove/);
  assert.match(gameSource, /performAction\(\{ type: "pass_extra_move" \}\)/);
  assert.match(gameSource, />\s*放弃追加行动\s*<\/button>/);
  assert.match(gameSource, /放弃会计算本次思考时间，但不增加手数、不写入落子回放/);
  assert.match(css, /\.extra-move-pass button\s*\{[\s\S]*?min-height:\s*46px/);
  assert.match(css, /\.extra-move-pass\s*\{[\s\S]*?background:\s*var\(--paper\)/);
  assert.doesNotMatch(
    css.slice(css.indexOf(".extra-move-pass"), css.indexOf(".board-column")),
    /#[0-9a-f]{3,8}/i,
  );
  assert.match(actionsRoute, /action\.type === "pass_extra_move"/);
});

test("augment cards, timers, and burn effects remain strictly grayscale", () => {
  const css = readFileSync(new URL("../app/components/Augments.module.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /#852222|#8d241f/i);
  assert.match(
    css,
    /\.card\[data-suit="hearts"\],[\s\S]*?\.card\[data-suit="diamonds"\][\s\S]*?--augment-ink:\s*#17140f/,
  );
});

test("burn transition occurs only when a consumable card crosses final exhaustion", () => {
  assert.equal(shouldAnimateAugmentBurn("active", 1, 0, 1), true);
  assert.equal(shouldAnimateAugmentBurn("active", 1, 1, 1), false);
  assert.equal(shouldAnimateAugmentBurn("active", 1, undefined, 1), false);
  assert.equal(shouldAnimateAugmentBurn("active", 2, 0, 1), false);
  assert.equal(shouldAnimateAugmentBurn("active", 2, 1, 2), true);
  assert.equal(shouldAnimateAugmentBurn("automatic", 3, 2, 3), true);
  assert.equal(shouldAnimateAugmentBurn("passive", 1, 0, 1), false);
  assert.equal(shouldAnimateAugmentBurn("setup", 1, 0, 1), false);
  assert.equal(shouldAnimateAugmentBurn("active", 1, 1, 0), false);
  assert.equal(shouldAnimateAugmentBurn("active", 1, 1, 2), false);
});

test("rail source records burnt cards and suppresses replay across stale count changes", () => {
  const railSource = readFileSync(new URL("../app/components/AugmentRail.tsx", import.meta.url), "utf8");
  assert.match(railSource, /burntIdsRef\.current\.has\(augmentId\)/);
  assert.match(railSource, /previousCount === undefined/);
  assert.match(railSource, /activation !== "passive"/);
  assert.match(railSource, /nextCount >= item\.augment\.charges/);
  assert.match(railSource, /if \(reducedMotion\)/);
  assert.match(railSource, /burnTimersRef\.current\.values\(\)/);
});

test("rail interaction exposes only valid active augments at their legal moment", () => {
  const movement = getAugmentDefinition("spade-grand-maneuver");
  const chooseEnemy = getAugmentDefinition("spade-total-intelligence");
  const automaticRecon = getAugmentDefinition("club-frontline-scout");
  const crossExchange = getAugmentDefinition("heart-heavenly-exchange");
  const multiMove = getAugmentDefinition("club-surprise-double-move");
  const redeployment = getAugmentDefinition("heart-shadow-redeploy");
  const sacrifice = getAugmentDefinition("club-bitter-ruse");
  const passive = getAugmentDefinition("heart-steady-advance");

  assert.equal(canInteractWithAugment(movement, {
    enabled: true,
    isOwnTurn: true,
    pendingReconId: null,
  }), true);
  assert.equal(canInteractWithAugment(movement, {
    enabled: true,
    isOwnTurn: false,
    pendingReconId: null,
  }), false);
  assert.equal(canInteractWithAugment(chooseEnemy, {
    enabled: true,
    isOwnTurn: false,
    pendingReconId: chooseEnemy.id,
  }), true);
  assert.equal(canInteractWithAugment(chooseEnemy, {
    enabled: true,
    isOwnTurn: true,
    pendingReconId: null,
  }), false);
  assert.equal(canInteractWithAugment(automaticRecon, {
    enabled: true,
    isOwnTurn: true,
    pendingReconId: automaticRecon.id,
  }), false);
  for (const augment of [crossExchange, multiMove, redeployment, sacrifice]) {
    assert.equal(canInteractWithAugment(augment, {
      enabled: true,
      isOwnTurn: true,
      pendingReconId: null,
    }), true, augment.id);
    assert.equal(canInteractWithAugment(augment, {
      enabled: true,
      isOwnTurn: false,
      pendingReconId: null,
    }), false, augment.id);
  }
  assert.equal(canInteractWithAugment(passive, {
    enabled: true,
    isOwnTurn: true,
    pendingReconId: null,
  }), false);
});

test("multi-target reconnaissance stays selected until its matching pending work is empty", () => {
  const augmentId = "spade-total-intelligence" as const;
  assert.equal(shouldKeepActiveReconSelection(augmentId, { augmentId, remaining: 2 }), true);
  assert.equal(shouldKeepActiveReconSelection(augmentId, { augmentId, remaining: 1 }), true);
  assert.equal(shouldKeepActiveReconSelection(augmentId, { augmentId, remaining: 0 }), false);
  assert.equal(shouldKeepActiveReconSelection(augmentId, null), false);
  assert.equal(shouldKeepActiveReconSelection(augmentId, {
    augmentId: "heart-targeted-recon",
    remaining: 1,
  }), false);
});

test("redeploy editor permutes only the original occupied set and emits a complete layout", () => {
  const game = projectedGameFixture([
    { id: "b-a", side: "black", type: "battalion", alive: true, row: 8, col: 0, flagRevealed: false },
    { id: "b-b", side: "black", type: "mine", alive: true, row: 10, col: 2, flagRevealed: false },
    { id: "b-flag", side: "black", type: "flag", alive: true, row: 11, col: 1, flagRevealed: false },
    { id: "b-away", side: "black", type: "company", alive: true, row: 4, col: 0, flagRevealed: false },
    { id: "w-a", side: "white", type: null, alive: true, row: 3, col: 1, flagRevealed: false },
  ]);
  const draft = createRedeployDraft(
    "ROOM70",
    game,
    "black",
    "heart-shadow-redeploy",
  );
  assert.ok(draft);
  assert.deepEqual(Object.keys(draft.original).sort(), ["b-a", "b-b"]);
  const swapped = swapRedeployPieces(draft, "b-a", { row: 10, col: 2 });
  assert.ok(swapped);
  assert.equal(redeployChangedCount(swapped), 2);
  assert.deepEqual(redeployPlacements(swapped), [
    { pieceId: "b-a", row: 10, col: 2 },
    { pieceId: "b-b", row: 8, col: 0 },
  ]);
  assert.equal(swapRedeployPieces(swapped, "b-a", { row: 9, col: 4 }), null);
});

test("new public effect events produce bounded type-safe board animations", () => {
  const previous = projectedGameFixture([
    { id: "b-a", side: "black", type: "battalion", alive: true, row: 8, col: 0, flagRevealed: false },
    { id: "w-hidden", side: "white", type: null, alive: true, row: 4, col: 1, flagRevealed: false },
  ], [{ id: 9, actor: "white", result: "move", from: { row: 3, col: 1 }, to: { row: 4, col: 1 } }]);
  const next = projectedGameFixture([
    { id: "b-a", side: "black", type: "division", alive: true, row: 8, col: 2, flagRevealed: false, promoted: true },
    { id: "w-hidden", side: "white", type: null, alive: false, row: 4, col: 1, flagRevealed: false },
  ], [
    ...previous.events,
    {
      id: 10,
      actor: "black",
      result: "pieces_redeployed",
      kind: "redeploy",
      relocations: [{ pieceId: "b-a", from: { row: 8, col: 0 }, to: { row: 8, col: 2 } }],
    },
    {
      id: 11,
      actor: "black",
      result: "chain_explosion",
      kind: "effect",
      pieceIds: ["w-hidden"],
      positions: [{ row: 4, col: 1 }],
    },
    {
      id: 12,
      actor: "black",
      result: "piece_promoted",
      kind: "effect",
      pieceIds: ["b-a"],
    },
  ]);
  const animations = augmentBoardEffectsForTransition(previous, next);
  assert.deepEqual(animations.map((animation) => animation.kind), [
    "relocations",
    "removals",
    "pulse",
  ]);
  assert.equal(AUGMENT_EFFECT_ANIMATION_MS, 320);
  const removed = animations[1];
  assert.equal(removed.kind, "removals");
  if (removed.kind === "removals") assert.equal(removed.entries[0].piece?.type, null);
});

test("replay effect metadata restores public pulses while piece changes stay authoritative", () => {
  const previous = projectedGameFixture([
    { id: "b-mover", side: "black", type: "battalion", alive: true, row: 8, col: 0, flagRevealed: false },
    { id: "b-promoted", side: "black", type: "company", alive: true, row: 9, col: 0, flagRevealed: false },
    { id: "b-mine", side: "black", type: "mine", alive: true, row: 9, col: 2, flagRevealed: false },
    { id: "b-flag", side: "black", type: "flag", alive: true, row: 11, col: 1, flagRevealed: true },
    { id: "w-chain", side: "white", type: "platoon", alive: true, row: 7, col: 1, flagRevealed: false },
  ]);
  const next = projectedGameFixture([
    { id: "b-mover", side: "black", type: "battalion", alive: true, row: 7, col: 0, flagRevealed: false },
    { id: "b-promoted", side: "black", type: "platoon", alive: true, row: 9, col: 0, flagRevealed: false, promoted: true },
    { id: "b-mine", side: "black", type: "mine", alive: true, row: 9, col: 2, flagRevealed: false, mineHits: 1 },
    { id: "b-flag", side: "black", type: "flag", alive: false, row: 11, col: 1, flagRevealed: true },
    { id: "w-chain", side: "white", type: "platoon", alive: false, row: 7, col: 1, flagRevealed: false },
  ]);
  const move = {
    moveNumber: 8,
    actor: "black",
    from: { row: 8, col: 0 },
    to: { row: 7, col: 0 },
    result: "move",
    kind: "move",
    pieceChanges: [
      { pieceId: "b-mover", type: "battalion", alive: true, row: 7, col: 0 },
      { pieceId: "b-promoted", type: "platoon", alive: true, row: 9, col: 0 },
      { pieceId: "w-chain", type: "platoon", alive: false, row: 7, col: 1 },
      { pieceId: "b-flag", type: "flag", alive: false, row: 11, col: 1 },
    ],
    effects: [
      { actor: "black", result: "piece_promoted", pieceIds: ["b-promoted"], positions: [{ row: 9, col: 0 }] },
      { actor: "white", result: "mine_hit", pieceIds: ["b-mine"], positions: [{ row: 9, col: 2 }] },
      { actor: "white", result: "headquarters_unlocked", pieceIds: ["w-chain"], positions: [{ row: 11, col: 3 }] },
      { actor: "black", result: "chain_explosion", pieceIds: ["w-chain"], positions: [{ row: 7, col: 1 }] },
      { actor: "black", result: "flag_destroyed", pieceIds: ["b-flag"], positions: [{ row: 11, col: 1 }] },
    ],
  } satisfies ReplayMove;

  const animations = augmentBoardEffectsForReplayTransition(
    previous.pieces,
    next.pieces,
    move,
    ["b-mover"],
  );
  assert.deepEqual(animations.map((animation) => animation.event.result), [
    "piece_promoted",
    "mine_hit",
    "headquarters_unlocked",
    "chain_explosion",
    "flag_destroyed",
  ]);
  assert.deepEqual(animations.map((animation) => animation.kind), [
    "pulse",
    "pulse",
    "pulse",
    "removals",
    "removals",
  ]);

  const legacyMove = {
    moveNumber: 1,
    actor: "white",
    from: { row: 3, col: 0 },
    to: { row: 4, col: 0 },
    result: "move",
  } satisfies ReplayMove;
  assert.deepEqual(
    augmentBoardEffectsForReplayTransition(previous.pieces, next.pieces, legacyMove),
    [],
  );
});

test("a protected flag replays as a surviving collision before its public reveal", () => {
  const previous = projectedGameFixture([
    { id: "attacker", side: "black", type: "company", alive: true, row: 4, col: 1, flagRevealed: false },
    { id: "protected-flag", side: "white", type: null, alive: true, row: 3, col: 1, flagRevealed: false },
  ]);
  const next = {
    ...projectedGameFixture([
      { id: "attacker", side: "black", type: "company", alive: true, row: 4, col: 1, flagRevealed: false },
      { id: "protected-flag", side: "white", type: "flag", alive: true, row: 3, col: 1, flagRevealed: true, publiclyRevealed: true },
    ], [{
      id: 1,
      actor: "black",
      from: { row: 4, col: 1 },
      to: { row: 3, col: 1 },
      result: "flag_protected",
      augmentId: "spade-last-headquarters",
    }]),
    moveNumber: 2,
    turn: "white" as const,
    revealedFlags: { black: false, white: true },
  } satisfies ProjectedGame;

  const animation = movementAnimationForTransition(previous, next);
  assert.ok(animation && animation.kind === "movement");
  assert.equal(animation.outcome, "repelled");
  assert.equal(animation.attackerAliveAfter, true);
  assert.equal(animation.defenderAliveAfter, true);
  assert.equal(animation.defender?.type, null);
  assert.equal(next.pieces.find((piece) => piece.id === "protected-flag")?.type, "flag");
});

test("new active actions are parsed with exact shapes and the UI never reads private base types", () => {
  const gameSource = readFileSync(new URL("../app/GameApp.tsx", import.meta.url), "utf8");
  const actionsRoute = readFileSync(
    new URL("../app/api/rooms/[code]/actions/route.ts", import.meta.url),
    "utf8",
  );
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

  for (const actionType of [
    "augment_begin_multi_move",
    "augment_redeploy",
    "augment_sacrifice",
    "augment_exchange",
    "pass_extra_move",
  ]) {
    assert.match(actionsRoute, new RegExp(`action\\.type === "${actionType}"`));
  }
  assert.match(actionsRoute, /hasOnlyKeys\(action, \["type", "augmentId", "pieceId"\]\)/);
  assert.match(actionsRoute, /new Set\(pieceIds\)\.size !== pieceIds\.length/);
  assert.match(gameSource, /getProjectedAugmentRedeployViolation/);
  assert.match(gameSource, /getProjectedAugmentSacrificeViolation/);
  assert.match(gameSource, /getProjectedAugmentMultiMoveViolation/);
  assert.match(gameSource, /AUGMENT_REQUIRES_ENEMY_TARGET:\s*"第二个目标必须选择敌方棋子。"/);
  assert.match(gameSource, /FLAG_MUST_BE_HEADQUARTERS:\s*"军旗只能放在当前军令允许的底线布阵位置。"/);
  assert.match(gameSource, /MINE_BACK_TWO_ROWS:\s*"地雷只能放在当前军令允许的后方布阵位置。"/);
  assert.doesNotMatch(gameSource, /军旗只能放在本方两个大本营之一|地雷只能放在本方最后两排/);
  assert.match(gameSource, /event\.result === "flag_protected"/);
  assert.match(gameSource, /军旗受保护 · \$\{actor\}本次进攻被阻止/);
  assert.match(gameSource, /军旗受保护，进攻会被阻止并公开/);
  assert.doesNotMatch(gameSource, /敌方前三排[^。\n]*非军旗/);
  assert.match(gameSource, /敌方前三排任意一枚存活棋子（包括军旗，不额外公开身份）/);
  assert.match(gameSource, /默认布阵中[\s\S]*?「偷梁换柱」[\s\S]*?「深呼吸」/);
  assert.match(gameSource, /「濒死悟道」尚未解锁时，进攻军旗会消耗行动但被保护阻止/);
  assert.match(
    gameSource,
    /catch \(error\)[\s\S]*?clearBoardInteractionState\(\);[\s\S]*?error\.status === 409/,
  );
  assert.match(
    gameSource,
    /function clearBoardInteractionState\(\)[\s\S]*?setSelectedPieceId\(null\);[\s\S]*?setActiveAugmentId\(null\);[\s\S]*?setRedeployDraft\(null\);[\s\S]*?setSacrificeCandidateId\(null\);/,
  );
  assert.match(
    gameSource,
    /preservesInteractionContext && current\?\.version === next\.version \? active : null/,
  );
  assert.match(gameSource, /remainingOwnTurns/);
  assert.match(gameSource, /headquartersUnlocked/);
  assert.match(gameSource, /mineHits === 1/);
  assert.match(gameSource, /piece\.promoted/);
  assert.doesNotMatch(gameSource, /baseTypes/);
  assert.match(css, /\.board-command-actions button[\s\S]*?min-height:\s*46px/);
  assert.match(css, /@media \(max-width: 420px\)[\s\S]*?touch-action:\s*manipulation/);
  assert.match(css, /\.is-flipped \.headquarters-gate-badge/);
  assert.match(css, /\.is-flipped \.augment-piece-badge/);
  assert.match(gameSource, /event\.key === "Escape"/);
  assert.match(css, /AUGMENT_EFFECT_ANIMATION_MS|augment-effect-ring|augment-piece-vanish/);
  assert.match(gameSource, /setReplayEffectAnimationIndex[\s\S]*?AUGMENT_EFFECT_ANIMATION_MS/);
  assert.match(gameSource, /activeReplayFrame\.move\.kind !== "redeploy"/);
  assert.match(gameSource, /phase: "playing",[\s\S]*?turn: activeReplayFrame\.move\.actor/);
  assert.match(
    gameSource,
    /const pendingMultiMove = viewerSide && game\.phase === "playing" && game\.turn === viewerSide/,
  );
});
