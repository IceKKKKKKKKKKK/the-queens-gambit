import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AUGMENT_DRAFT_MOTION_MS,
  augmentDraftPhaseDuration,
  canInteractWithAugment,
  reconcileActiveAugmentAfterProjection,
  reduceAugmentDraftMotion,
  shouldAnimateAugmentBurn,
  shouldKeepActiveReconSelection,
  wasAugmentLockConfirmedAfterConflict,
  type AugmentDraftMotionState,
} from "../app/components/augmentMotion.ts";
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
import { getAugmentDefinition } from "../lib/augments.ts";

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
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const platformSource = readFileSync(new URL("../db/platform.ts", import.meta.url), "utf8");

  assert.match(
    gameSource,
    /game\.mode === "augment"[\s\S]*?game\.repetition\?\.active[\s\S]*?currentOccurrences === 2/,
  );
  assert.match(gameSource, /className="repetition-notice"[\s\S]*?重复局面[\s\S]*?2\/3/);
  assert.match(gameSource, /本局和棋 · \$\{drawReasonText\(snapshot\.drawReason\)\}/);
  assert.match(gameSource, /同一局面第三次出现 · 本局和棋/);
  assert.match(gameSource, /match\.endedReason === "threefold_repetition"[\s\S]*?和 · 重复局面/);
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
        black: { locked: true },
        white: { locked: true },
      },
    },
    {
      number: 2,
      players: {
        black: { locked: true },
        white: { locked: false },
      },
    },
  ];
  assert.equal(wasAugmentLockConfirmedAfterConflict("black", 2, rounds), true);
  assert.equal(wasAugmentLockConfirmedAfterConflict("white", 2, rounds), false);
  assert.equal(wasAugmentLockConfirmedAfterConflict("black", 3, rounds), false);
  assert.equal(wasAugmentLockConfirmedAfterConflict("spectator", 2, rounds), false);
  assert.equal(wasAugmentLockConfirmedAfterConflict("black", null, rounds), false);
});

test("the action conflict path wires the original draft round into its idempotency check", () => {
  const gameSource = readFileSync(new URL("../app/GameApp.tsx", import.meta.url), "utf8");
  assert.match(gameSource, /const requestedAugmentRound = action\.type === "augment_lock"/);
  assert.match(gameSource, /wasAugmentLockConfirmedAfterConflict\([\s\S]*?requestedAugmentRound/);
  assert.match(gameSource, /相关布阵牌可按牌面写明的 1 或 2 枚额度提供例外/);
  assert.doesNotMatch(gameSource, /两轮强化，20 张牌池/);
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

test("burn transition is exclusive to a one-charge card crossing into exhaustion", () => {
  assert.equal(shouldAnimateAugmentBurn(1, 0, 1), true);
  assert.equal(shouldAnimateAugmentBurn(1, 1, 1), false);
  assert.equal(shouldAnimateAugmentBurn(1, undefined, 1), false);
  assert.equal(shouldAnimateAugmentBurn(2, 0, 1), false);
  assert.equal(shouldAnimateAugmentBurn(2, 1, 2), false);
  assert.equal(shouldAnimateAugmentBurn(1, 1, 0), false);
  assert.equal(shouldAnimateAugmentBurn(1, 1, 2), false);
});

test("rail source records burnt cards and suppresses replay across stale count changes", () => {
  const railSource = readFileSync(new URL("../app/components/AugmentRail.tsx", import.meta.url), "utf8");
  assert.match(railSource, /burntIdsRef\.current\.has\(augmentId\)/);
  assert.match(railSource, /previousCount === undefined/);
  assert.match(railSource, /if \(reducedMotion\)/);
  assert.match(railSource, /burnTimersRef\.current\.values\(\)/);
});

test("rail interaction exposes only valid active augments at their legal moment", () => {
  const movement = getAugmentDefinition("spade-grand-maneuver");
  const chooseEnemy = getAugmentDefinition("spade-total-intelligence");
  const automaticRecon = getAugmentDefinition("club-frontline-scout");

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
