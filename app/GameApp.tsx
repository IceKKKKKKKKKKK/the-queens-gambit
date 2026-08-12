"use client";

import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
} from "react";
import {
  CAMPS,
  HEADQUARTERS,
  MAX_TIME_CONTROL_MINUTES,
  MIN_TIME_CONTROL_MINUTES,
  PIECE_INFO,
  applySetupDraftPlacement,
  boardCoordinate,
  buildReplayFrames,
  createSetupDraft,
  getCampMotionForPosition,
  getProjectedLegalTargets,
  getProjectedAugmentExchangeViolation,
  getProjectedAugmentLegalTargets,
  getProjectedAugmentMultiMoveViolation,
  getProjectedAugmentMoveViolation,
  getProjectedAugmentReconTargets,
  getProjectedAugmentRedeployViolation,
  getProjectedAugmentSacrificeViolation,
  getProjectedMoveViolation,
  getSetupDraftPlacementViolation,
  isCamp,
  isHeadquarters,
  isInsideBoard,
  isRailEdge,
  isRoadEdge,
  isValidSetupDraft,
  latestOpponentMovementEvent,
  movementAnimationForTransition,
  otherSide,
  positionKey,
  randomizeSetupDraft,
  samePosition,
  setupDraftToLayout,
  setupSlots,
  type PlayerAction,
  type Position,
  type ProjectedGame,
  type PublicEvent,
  type PublicPiece,
  type ExchangeAnimationTransition,
  type MovementAnimationTransition,
  type StandardMovementAnimationTransition,
  type SetupDraft,
  type Side,
  type Viewer,
} from "../lib/game";
import {
  getAugmentDefinition,
  type AugmentDefinition,
  type AugmentId,
  type AugmentSlot,
} from "../lib/augments";
import AugmentDraft from "./components/AugmentDraft";
import AugmentRail from "./components/AugmentRail";
import LobbyExperience from "./components/LobbyExperience";
import {
  LOBBY_ENTRY_SESSION_KEY,
  markLobbyEntered,
} from "./components/lobbyScene";
import {
  canInteractWithAugment,
  reconcileActiveAugmentAfterProjection,
  shouldKeepActiveReconSelection,
  wasAugmentLockConfirmedAfterConflict,
} from "./components/augmentMotion";
import {
  AUGMENT_EFFECT_ANIMATION_MS,
  animatedAugmentPieceIds,
  augmentBoardEffectsForReplayTransition,
  augmentBoardEffectsForTransition,
  createRedeployDraft,
  redeployChangedCount,
  redeployPlacements,
  redeployTargetPositions,
  renderRedeployPieces,
  swapRedeployPieces,
  type AugmentBoardEffectAnimation,
  type RedeployDraft,
} from "./components/augmentBoardUi";
import {
  INVITE_RETRY_PARAM,
  clearPendingRoomInvite,
  isValidRoomInviteToken,
  readPendingRoomInvite,
  signInPathWithInviteRetry,
  signInPathWithWatchOnly,
  stageRoomInviteForSignIn,
  type SessionStorageLike,
} from "./components/pendingRoomInvite";
import { roomEnvelopeFromTransport } from "./components/roomEnvelope";

interface RoomEnvelope {
  code: string;
  displayCode?: string;
  version: number;
  viewer: Viewer;
  spectatorPerspective?: Side | null;
  snapshot: ProjectedGame;
  roomKind?: "custom" | "ranked";
  gameMode?: "classic" | "augment";
  spectatorPolicy?: "hidden" | "full";
  matchId?: string | null;
  setupDeadlineAt?: number | null;
}

function hasProjectedAugmentTarget(game: ProjectedGame, side: Side, augmentId: AugmentId) {
  const effect = getAugmentDefinition(augmentId).effect;
  if (effect.kind === "movement") {
    return game.pieces.some(
      (piece) => piece.alive && piece.side === side && isInsideBoard(piece) &&
        getProjectedAugmentLegalTargets(game, side, augmentId, piece).length > 0,
    );
  }
  if (effect.kind === "exchange") {
    const friendlyPieces = game.pieces.filter(
      (piece) => piece.alive && piece.side === side && isInsideBoard(piece),
    );
    const secondPieces = effect.mode === "cross_frontline"
      ? game.pieces.filter(
          (piece) => piece.alive && piece.side !== side && isInsideBoard(piece),
        )
      : friendlyPieces;
    for (let first = 0; first < friendlyPieces.length; first += 1) {
      const start = effect.mode === "cross_frontline" ? 0 : first + 1;
      for (let second = start; second < secondPieces.length; second += 1) {
        if (!getProjectedAugmentExchangeViolation(
          game,
          side,
          augmentId,
          friendlyPieces[first],
          secondPieces[second],
        )) return true;
      }
    }
    return false;
  }
  if (effect.kind === "multi_move") {
    return game.pieces.some(
      (piece) =>
        piece.alive &&
        piece.side === side &&
        !getProjectedAugmentMultiMoveViolation(game, side, augmentId, piece.id),
    );
  }
  if (effect.kind === "redeployment") {
    const draft = createRedeployDraft("projection", game, side, augmentId);
    if (!draft) return false;
    const pieceIds = Object.keys(draft.locations);
    const swapped = swapRedeployPieces(draft, pieceIds[0], draft.locations[pieceIds[1]]);
    return Boolean(
      swapped &&
      !getProjectedAugmentRedeployViolation(
        game,
        side,
        augmentId,
        redeployPlacements(swapped),
      ),
    );
  }
  if (effect.kind === "sacrifice_reconnaissance") {
    return game.pieces.some(
      (piece) =>
        piece.alive &&
        piece.side === side &&
        !getProjectedAugmentSacrificeViolation(game, side, augmentId, piece.id),
    );
  }
  if (effect.kind === "reconnaissance" && effect.mode === "choose_enemy") {
    return getProjectedAugmentReconTargets(game, side, augmentId).length > 0;
  }
  return false;
}

interface CreateRoomEnvelope extends RoomEnvelope {
  playerToken: string;
  opponentInviteToken: string;
}

interface ClaimRoomEnvelope extends RoomEnvelope {
  playerToken: string;
}

interface SetupDraftState {
  roomCode: string;
  side: Side;
  locations: SetupDraft;
}

interface AugmentDraftVisualHold {
  roomCode: string;
  round: 1 | 2;
  options: readonly AugmentDefinition[];
  selectedId: AugmentId;
  opponentLocked: boolean;
  refreshUsed: boolean;
  seenCount: number;
  deadlineAt: number | null;
}

interface SessionUser {
  displayName: string;
  email: string;
}

interface AccountSummary {
  handle: string;
  email: string;
  rating: number;
  rank: { label: string; tier: string; division: string | null; progress: number };
  record: { games: number; rankedGames: number; wins: number; losses: number; draws: number; winRate: number };
}

interface RecentMatch {
  id: string;
  opponentHandle: string;
  outcome: "win" | "loss" | "draw";
  ratingDelta: number;
  endedReason: string | null;
  completedAt: number;
}

interface AccountEnvelope {
  account: AccountSummary;
  recentMatches: RecentMatch[];
}

interface FriendEntry {
  relationshipId: string;
  player: { handle: string; rating: number; rank: { label: string } };
  presence: "online" | "searching" | "in_game" | "offline";
  currentMatchId: string | null;
}

interface FriendsEnvelope {
  friends: FriendEntry[];
  incoming: Array<{ requestId: string; player: { handle: string } }>;
  outgoing: Array<{ requestId: string; player: { handle: string } }>;
}

interface MatchmakingEnvelope {
  state: "idle" | "queued" | "matched";
  queuedAt?: number;
  ratingRange?: number;
  match?: {
    id: string;
    side: Side;
    opponent: { handle: string };
    game: { status: "pending_provisioning" | "ready"; code: string | null };
    setupDeadlineAt?: number | null;
  };
}

const PIECE_DRAG_TYPE = "application/x-queens-gambit-piece";
const MOVEMENT_ANIMATION_MS = 320;
const BATTLE_ANIMATION_MS = 640;
const BATTLE_CELL_PERCENT = 100 / 0.9;

class RequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

const ERROR_TEXT: Record<string, string> = {
  ROOM_NOT_FOUND: "没有找到这个房间。请检查房间码。",
  ROOM_EXPIRED: "这个房间已经过期。",
  ROOM_READ_FAILED: "暂时无法读取这个房间。",
  ROOM_CODE_UNAVAILABLE: "暂时没有可用房间码，请稍后再试。",
  INVALID_PLAYER_TOKEN: "这个玩家邀请已经失效。你仍可用观战链接进入。",
  PLAYER_TOKEN_REQUIRED: "只有本局玩家可以执行这个操作。",
  VERSION_CONFLICT: "棋局已由另一端更新，本次操作没有提交。已同步最新局面，请重新操作。",
  INVALID_REQUEST: "操作内容无效，已被服务器拒绝。",
  REQUEST_TOO_LARGE: "操作内容过长，已被服务器拒绝。",
  INVALID_LAYOUT: "这个位置不属于可用的布阵位置。",
  INCOMPLETE_LAYOUT: "请先将棋盒里的 25 枚棋子全部放入棋盘。",
  INVALID_SWAP: "请选择两枚自己的棋子。",
  PIECE_NOT_AVAILABLE: "这枚棋子当前不可用，请重新选择。",
  SAME_POSITION: "起点和终点相同，没有发生移动。",
  NO_STATE_CHANGE: "当前已经是这个状态，无需重复操作。",
  FLAG_MUST_BE_HEADQUARTERS: "军旗只能放在当前军令允许的底线布阵位置。",
  MINE_BACK_TWO_ROWS: "地雷只能放在当前军令允许的后方布阵位置。",
  BOMB_NOT_FRONT_ROW: "炸弹不能放在本方第一排。",
  CAMP_MUST_BE_EMPTY: "行营不能布子，布阵时必须保持为空。",
  LAYOUT_LOCKED: "阵型已经锁定；请先撤销确认再调整。",
  GAME_NOT_STARTED: "对局尚未开始，不能移动棋子。",
  GAME_ALREADY_STARTED: "对局已经开始，不能再调整阵型。",
  GAME_FINISHED: "本局已经结束。",
  HOST_ONLY_TIME_CONTROL: "只有创建房间的黑方可以修改本局限时。",
  TIME_CONTROL_LOCKED: "双方一旦有人锁定阵型，本局限时就不能再修改。",
  INVALID_TIME_CONTROL: `限时必须是 ${MIN_TIME_CONTROL_MINUTES}–${MAX_TIME_CONTROL_MINUTES} 分钟的整数。`,
  NOT_YOUR_TURN: "现在是对手回合，不能移动棋子。",
  POSITION_OUT_OF_BOUNDS: "目标位置不在棋盘内。",
  NO_PIECE_AT_SOURCE: "请先从棋盒或棋盘选择一枚自己的棋子。",
  NOT_YOUR_PIECE: "只能选择自己的棋子。",
  FLAG_CANNOT_MOVE: "军旗不能移动。",
  MINE_CANNOT_MOVE: "地雷不能移动。",
  HEADQUARTERS_LOCKED: "进入大本营的棋子不能再移动。",
  DESTINATION_OCCUPIED_BY_ALLY: "目标位置已有己方棋子。",
  CAMP_PROTECTED: "行营内的棋子受保护，不能被攻击。",
  RAIL_PATH_BLOCKED: "铁路途中有棋子阻挡，不能越过。",
  ENGINEER_ONLY_RAIL_TURN: "只有工兵可以在铁路上转弯。",
  ROAD_ONE_STEP_ONLY: "公路每次只能沿连接线走一格。",
  POSITIONS_NOT_CONNECTED: "起点与目标之间没有可通行路线。",
  ACTION_FAILED: "这一步没有成功，请再试一次。",
  ROOM_CREATE_FAILED: "暂时无法创建房间，请稍后再试。",
  ROOM_CREATE_RATE_LIMITED: "创建得太频繁，请稍后再试。",
  INVALID_INVITE_TOKEN: "这个玩家邀请无效。",
  TOKEN_ALREADY_IN_USE: "这个玩家身份已被另一方使用，请重新打开邀请链接。",
  ROOM_IDENTITY_CONFLICT: "这个旧房间的玩家身份发生冲突，请创建新房间。",
  SEAT_ALREADY_CLAIMED: "玩家席位已经被领取。",
  CLAIM_FAILED: "暂时无法领取玩家席位。",
  AUTH_REQUIRED: "请先使用邮箱登录。",
  AUGMENT_MODE_REQUIRED: "这局不是狂野模式。",
  AUGMENT_SELECTION_REQUIRED: "请先选择并锁定一张军令牌。",
  NO_ACTIVE_DRAFT: "当前没有进行中的军令选择。",
  SELECTION_LOCKED: "这轮军令已经锁定。",
  REFRESH_ALREADY_USED: "本轮已经使用过刷新。",
  AUGMENT_NOT_OFFERED: "这张牌不在本轮候选中。",
  SELECTION_REQUIRED: "请先选择一张军令牌。",
  AUGMENT_NOT_AVAILABLE: "这张军令已经使用或当前不可用。",
  AUGMENT_ACTION_MISMATCH: "这张军令不能执行该操作。",
  AUGMENT_PATH_INVALID: "目标不符合这张军令的移动规则。",
  AUGMENT_REQUIRES_EMPTY_TARGET: "这张军令只能落到空位。",
  AUGMENT_PIECE_INELIGIBLE: "所选棋子不符合这张军令的要求。",
  RECON_SELECTION_REQUIRED: "请先完成军令要求的敌子侦察。",
  RECON_TARGET_INVALID: "请选择一枚存活的敌方棋子。",
  RECON_TARGET_ALREADY_KNOWN: "这枚敌子已经被你识别，请选择另一枚。",
  EXTRA_MOVE_DIFFERENT_PIECE: "追加行动必须使用另一枚棋子。",
  EXTRA_MOVE_NORMAL_ONLY: "追加行动只能进行普通移动。",
  EXTRA_MOVE_NOT_PENDING: "当前没有可以放弃的追加行动。",
  PENDING_ACTION_REQUIRED: "请先完成或放弃当前追加行动。",
  MULTI_MOVE_SAME_PIECE_REQUIRED: "本次连续移动必须继续使用同一枚棋子。",
  MULTI_MOVE_NORMAL_ONLY: "连续移动期间只能进行普通移动。",
  MULTI_MOVE_FIRST_MOVE_REQUIRED: "发动后至少需要完成一次合法移动。",
  NO_LEGAL_MULTI_MOVE: "这枚棋子当前没有可用的连续移动。",
  AUGMENT_REQUIRES_ENEMY_TARGET: "第二个目标必须选择敌方棋子。",
  INVALID_REDEPLOYMENT: "换阵内容不完整，请取消后重新编辑。",
  INCOMPLETE_REDEPLOYMENT: "换阵必须包含当前己方半场内的全部存活非军旗棋子。",
  REDEPLOYMENT_DESTINATIONS_MUST_MATCH: "换阵只能使用这些棋子原先占据的站点。",
  REDEPLOYMENT_REQUIRES_CHANGE: "至少交换两枚棋子后才能确认换阵。",
  FLAG_HEADQUARTERS_LOCKED: "军旗受保护：本次进攻被阻止；先占领另一座大本营后才能夺旗。",
  SCREENED_ATTACK_REQUIRED: "这枚师长进攻时必须与目标之间正好隔一枚棋子。",
  RANKED_TIME_CONTROL_LOCKED: "排位用时固定为 10 分钟，不能修改。",
  RANKED_SETUP_EXPIRED: "布阵时间已到，本局已作废且不计分。你可以立即重新匹配。",
  RANKED_SETUP_CANCELLED: "本次排位已在开局前取消，不计分。",
  RANKED_SETUP_ALREADY_STARTED: "对局已经开始，不能再无损取消。",
  RANKED_SETUP_CONFLICT: "棋局刚刚发生变化，请同步后再试。",
  RANKED_SETUP_CANCEL_FAILED: "暂时无法取消本次排位，请重试。",
};

function cleanCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 8);
}

function displayCode(value: string) {
  const code = cleanCode(value);
  return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

function isPlayer(viewer: Viewer): viewer is Side {
  return viewer === "black" || viewer === "white";
}

function sideName(side: Side) {
  return side === "black" ? "黑方" : "白方";
}

function formatClock(remainingMs: number) {
  const safeMs = Number.isFinite(remainingMs) ? Math.max(0, remainingMs) : 0;
  const totalSeconds = Math.ceil(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function roomTokenKey(code: string) {
  return `yizhen:${code}:player-token`;
}

function inviteTokenKey(code: string) {
  return `yizhen:${code}:opponent-token`;
}

function pendingTokenKey(code: string) {
  return `yizhen:${code}:pending-player-token`;
}

function setupDraftKey(code: string, side: Side) {
  return `yizhen:${code}:${side}:setup-draft`;
}

function readLocalValue(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalValue(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeLocalValue(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // The in-memory identity remains usable for this page session.
  }
}

function browserSessionStorage(): SessionStorageLike | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function clearInviteNavigationArtifacts(url: URL) {
  url.hash = "";
  url.searchParams.delete(INVITE_RETRY_PARAM);
  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
}

function isTerminalInviteError(error: unknown) {
  return error instanceof RequestError && [
    "INVALID_INVITE_TOKEN",
    "SEAT_ALREADY_CLAIMED",
    "ROOM_IDENTITY_CONFLICT",
    "ROOM_NOT_FOUND",
    "ROOM_EXPIRED",
  ].includes(error.code);
}

function restoreSetupDraft(
  raw: string | null,
  pieces: PublicPiece[],
  side: Side,
  requireComplete = false,
  augmentIds: readonly AugmentId[] = [],
) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const candidate: SetupDraft = {};
    for (const [pieceId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === null) {
        candidate[pieceId] = null;
        continue;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const position = value as Record<string, unknown>;
      if (!Number.isInteger(position.row) || !Number.isInteger(position.col)) return null;
      candidate[pieceId] = { row: position.row as number, col: position.col as number };
    }
    return isValidSetupDraft(pieces, side, candidate, requireComplete, augmentIds) ? candidate : null;
  } catch {
    return null;
  }
}

function createClientToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function parseResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new RequestError(response.status, String(payload.error ?? "REQUEST_FAILED"));
  }
  return payload;
}

async function fetchRoom(code: string, token: string | null, since?: number) {
  const params = new URLSearchParams();
  if (Number.isInteger(since)) params.set("since", String(since));
  if (typeof window !== "undefined") {
    const watchMatch = new URL(window.location.href).searchParams.get("match");
    if (watchMatch) params.set("match", watchMatch);
  }
  const suffix = params.size ? `?${params.toString()}` : "";
  const response = await fetch(`/api/rooms/${code}${suffix}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    cache: "no-store",
  });
  return (await parseResponse(response)) as RoomEnvelope | null;
}

async function postAction(code: string, token: string | null, version: number, action: PlayerAction) {
  const response = await fetch(`/api/rooms/${code}/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ expectedVersion: version, action }),
  });
  return (await parseResponse(response)) as RoomEnvelope;
}

async function claimSeat(code: string, inviteToken: string, playerToken: string) {
  const response = await fetch(`/api/rooms/${code}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inviteToken, playerToken }),
  });
  return (await parseResponse(response)) as ClaimRoomEnvelope;
}

function eventAugmentText(event: PublicEvent) {
  const augmentIds = event.augmentIds?.length
    ? event.augmentIds
    : event.augmentId
      ? [event.augmentId]
      : [];
  const names = [...new Set(augmentIds)].map((augmentId) => getAugmentDefinition(augmentId).name);
  return names.length ? ` · 军令「${names.join(" + ")}」` : "";
}

function eventText(event: PublicEvent) {
  const actor = sideName(event.actor);
  if (event.result === "ready") return `${actor}锁定了阵型`;
  if (event.result === "unready") return `${actor}撤销了确认`;
  if (event.result === "game_started") return `${actor}获得先手`;
  if (event.result === "resigned") return `${actor}认输`;
  if (event.result === "timeout") return `${actor}用时耗尽`;
  if (event.result === "augment_revealed") return "双方军令同时公开";
  if (event.result === "extra_move_passed") {
    return `${actor}放弃追加行动${eventAugmentText(event)}`;
  }
  if (event.result === "draw_repetition") {
    return "同一局面第三次出现 · 本局和棋";
  }
  if (event.result === "augment_used") {
    return `${actor}发动「${event.augmentId ? getAugmentDefinition(event.augmentId).name : "军令"}」`;
  }
  if (event.kind === "redeploy") {
    return `${actor}完成暗中换阵 · ${event.relocations?.length ?? event.pieceIds?.length ?? 0} 枚棋子换位${eventAugmentText(event)}`;
  }
  if (event.kind === "sacrifice") {
    return `${actor}弃掉一枚己子并完成侦察${eventAugmentText(event)}`;
  }
  if (event.result === "pieces_redeployed") {
    return `${actor}完成暗中换阵 · ${event.relocations?.length ?? event.pieceIds?.length ?? 0} 枚棋子换位${eventAugmentText(event)}`;
  }
  if (event.result === "piece_sacrificed") {
    return `${actor}弃掉一枚己子并完成侦察${eventAugmentText(event)}`;
  }
  if (event.result === "chain_explosion") {
    return `连锁爆炸 · ${event.pieceIds?.length ?? event.positions?.length ?? 0} 枚相邻棋子退场${eventAugmentText(event)}`;
  }
  if (event.result === "piece_promoted") {
    return `${actor}有棋子晋升${eventAugmentText(event)}`;
  }
  if (event.result === "mine_hit") {
    return `一枚地雷承受首次攻击并公开${eventAugmentText(event)}`;
  }
  if (event.result === "headquarters_unlocked") {
    return `${sideName(otherSide(event.actor))}的大本营门禁已经解除${eventAugmentText(event)}`;
  }
  if (event.result === "flag_destroyed") {
    return `${actor}的军旗因军令时限被消灭${eventAugmentText(event)}`;
  }
  const path = event.from && event.to ? `${boardCoordinate(event.from)} → ${boardCoordinate(event.to)}` : "";
  const augmentText = eventAugmentText(event);
  if (event.kind === "exchange" && event.from && event.to) {
    const secondaryFrom = event.secondaryFrom ?? event.to;
    const secondaryTo = event.secondaryTo ?? event.from;
    const exchangePath = `${boardCoordinate(event.from)} → ${boardCoordinate(event.to)}；${boardCoordinate(secondaryFrom)} → ${boardCoordinate(secondaryTo)}`;
    return `${actor}换防 · ${exchangePath}${augmentText}`;
  }
  if (event.result === "move") return `${actor}移动 · ${path}${augmentText}`;
  if (event.result === "attacker_survives") return `${actor}进攻成功 · ${path}${augmentText}`;
  if (event.result === "defender_survives") return `${actor}进攻失利 · ${path}${augmentText}`;
  if (event.result === "both_removed") return `双方同归于尽 · ${path}${augmentText}`;
  if (event.result === "flag_protected") {
    return `军旗受保护 · ${actor}本次进攻被阻止${path ? ` · ${path}` : ""}${augmentText}`;
  }
  return `${actor}夺得军旗${path ? ` · ${path}` : ""}${augmentText}`;
}

function finishReasonText(reason: ProjectedGame["finishReason"]) {
  if (reason === "flag") return "夺得军旗";
  if (reason === "no_moves") return "对方无棋可走";
  if (reason === "resign") return "认输结束";
  if (reason === "timeout") return "用时耗尽";
  return "和棋";
}

function drawReasonText(reason: ProjectedGame["drawReason"]) {
  if (reason === "threefold_repetition") return "三次重复局面";
  return "和棋";
}

function statusText(room: RoomEnvelope, placedCount?: number) {
  const { snapshot, viewer } = room;
  if (snapshot.phase === "setup") {
    if (viewer === "spectator") return room.spectatorPolicy === "full" ? "双方正在布阵 · 明牌观战" : "双方正在布阵 · 暗牌保护中";
    if (snapshot.ready[viewer]) return "阵型已锁定，等待对手";
    if (placedCount !== undefined && placedCount < 25) return `还需放置 ${25 - placedCount} 枚棋子`;
    return "拖动或点选棋子调整阵型";
  }
  if (snapshot.phase === "augment_draft") {
    if (viewer === "spectator") return "双方正在选择第二项军令";
    const draft = snapshot.augment?.draft.rounds.find(
      (round) => round.number === snapshot.augment?.draft.activeRound,
    );
    return draft?.players[viewer].locked ? "军令已锁定，等待对手" : "请选择第二项军令";
  }
  if (snapshot.phase === "finished") {
    if (!snapshot.winner) {
      return snapshot.drawReason ? `本局和棋 · ${drawReasonText(snapshot.drawReason)}` : "本局和棋";
    }
    const reason = finishReasonText(snapshot.finishReason);
    if (viewer === "spectator") return `${sideName(snapshot.winner)}获胜 · ${reason}`;
    return snapshot.winner === viewer ? `你赢得了这局 · ${reason}` : `对手赢得了这局 · ${reason}`;
  }
  if (viewer === "spectator") return `轮到${sideName(snapshot.turn)}`;
  return snapshot.turn === viewer ? "轮到你" : "等待对手落子";
}

function PieceModel({
  piece,
  inCamp = false,
  campMotion = null,
  className = "",
}: {
  piece: PublicPiece;
  inCamp?: boolean;
  campMotion?: "enter" | "leave" | null;
  className?: string;
}) {
  const known = Boolean(piece.type);
  const info = piece.type ? PIECE_INFO[piece.type] : null;
  return (
    <span
      className={`piece-model side-${piece.side} ${known ? "is-known" : "is-hidden"} ${inCamp ? "is-in-camp" : ""} ${campMotion ? `camp-motion-${campMotion}` : ""} ${className}`}
      data-piece={piece.type ?? "hidden"}
      aria-hidden="true"
    >
      <span className="piece-crest">{info?.glyph ?? "◆"}</span>
      <span className="piece-neck" />
      <span className="piece-base" />
      <span className="piece-name">{info?.short ?? ""}</span>
    </span>
  );
}

type BattleAnimationStyle = CSSProperties & {
  "--battle-x"?: string;
  "--battle-y"?: string;
};

function boardGridRow(position: Position) {
  return position.row < 6 ? position.row + 1 : position.row + 2;
}

function battleTargetStyle(position: Position): BattleAnimationStyle {
  return {
    gridRow: boardGridRow(position),
    gridColumn: position.col + 1,
  };
}

function battleMotionStyle(from: Position, to: Position): BattleAnimationStyle {
  const rowOffset = (from.row - to.row) * BATTLE_CELL_PERCENT;
  const crossesTowardBlack = from.row < 6 && to.row >= 6;
  const crossesTowardWhite = from.row >= 6 && to.row < 6;
  const y = crossesTowardBlack
    ? `calc(${rowOffset}% - var(--front-gap))`
    : crossesTowardWhite
      ? `calc(${rowOffset}% + var(--front-gap))`
      : `${rowOffset}%`;
  return {
    ...battleTargetStyle(to),
    "--battle-x": `${(from.col - to.col) * BATTLE_CELL_PERCENT}%`,
    "--battle-y": y,
  };
}

function opponentHeadquartersClass(position: Position, viewer: Viewer) {
  if (!isHeadquarters(position)) return "";
  if (viewer === "spectator") return "is-headquarters";
  const headquartersSide: Side = position.row < 6 ? "white" : "black";
  return headquartersSide === viewer
    ? "is-headquarters"
    : "is-headquarters is-opponent-headquarters";
}

function BattlePieceVisual({
  piece,
  position,
  viewer,
  campMotion = null,
  motionClass = "battle-animation-visual",
  className = "",
  style,
  ariaHidden,
}: {
  piece: PublicPiece;
  position: Position;
  viewer: Viewer;
  campMotion?: "enter" | "leave" | null;
  motionClass?: string;
  className?: string;
  style?: BattleAnimationStyle;
  ariaHidden?: boolean;
}) {
  const label = piece.type ? PIECE_INFO[piece.type].label : null;
  return (
    <span
      className={`${motionClass} ${label ? "has-piece-label" : ""} ${opponentHeadquartersClass(position, viewer)} ${className}`}
      style={style}
      aria-hidden={ariaHidden}
    >
      <PieceModel piece={piece} inCamp={isCamp(position)} campMotion={campMotion} />
      {label ? (
        <span
          className={`board-piece-label side-${piece.side} ${isCamp(position) ? "is-in-camp" : ""}`}
        >
          {label}
        </span>
      ) : null}
    </span>
  );
}

function BattleAnimationOverlay({
  animation,
  viewer,
}: {
  animation: StandardMovementAnimationTransition;
  viewer: Viewer;
}) {
  const { attacker, defender, event, outcome } = animation;
  const attackerCampMotion = isCamp(event.to)
    ? "enter"
    : isCamp(event.from)
      ? "leave"
      : null;
  return (
    <span
      className={`battle-animation-cell ${animation.attackerAliveAfter ? "" : "is-attacker-removed"}`}
      style={battleMotionStyle(event.from, event.to)}
      data-outcome={outcome}
      aria-hidden="true"
    >
      <BattlePieceVisual
        piece={attacker}
        position={event.to}
        viewer={viewer}
        campMotion={attackerCampMotion}
      />
      {defender ? (
        <BattlePieceVisual
          piece={defender}
          position={event.to}
          viewer={viewer}
          motionClass="battle-defender-ghost"
          className={animation.defenderAliveAfter ? "is-defender-survivor" : ""}
          ariaHidden
        />
      ) : null}
      {defender ? (
        <span className="battle-impact" aria-hidden="true" />
      ) : null}
    </span>
  );
}

function ExchangeAnimationOverlay({
  animation,
  pieces,
  viewer,
}: {
  animation: ExchangeAnimationTransition;
  pieces: readonly PublicPiece[];
  viewer: Viewer;
}) {
  const firstPiece = pieces.find((piece) => piece.alive && piece.id === animation.first.pieceId);
  const secondPiece = pieces.find((piece) => piece.alive && piece.id === animation.second.pieceId);
  if (!firstPiece || !secondPiece) return null;

  const legs = [
    { name: "first", leg: animation.first, piece: firstPiece },
    { name: "second", leg: animation.second, piece: secondPiece },
  ] as const;

  return (
    <>
      {legs.map(({ name, leg, piece }) => {
        const campMotion = isCamp(leg.to)
          ? "enter"
          : isCamp(leg.from)
            ? "leave"
            : null;
        return (
          <span
            className="battle-animation-cell exchange-animation-cell"
            key={`${animation.eventId}:${leg.pieceId}`}
            style={battleMotionStyle(leg.from, leg.to)}
            data-outcome="exchange"
            data-exchange-leg={name}
            data-exchange-piece-id={leg.pieceId}
            aria-hidden="true"
          >
            <BattlePieceVisual
              piece={piece}
              position={leg.to}
              viewer={viewer}
              campMotion={campMotion}
            />
          </span>
        );
      })}
    </>
  );
}

function AugmentEffectAnimationOverlay({
  animations,
  viewer,
}: {
  animations: readonly AugmentBoardEffectAnimation[];
  viewer: Viewer;
}) {
  return (
    <>
      {animations.flatMap((animation) => {
        if (animation.kind === "relocations") {
          return animation.relocations.flatMap((relocation) => {
            const piece = animation.pieces.find(
              (candidate) => candidate.id === relocation.pieceId,
            );
            if (!piece) return [];
            return [
              <span
                className="battle-animation-cell augment-relocation-cell"
                key={`${animation.eventId}:${relocation.pieceId}`}
                style={battleMotionStyle(relocation.from, relocation.to)}
                data-effect-animation="redeploy"
                aria-hidden="true"
              >
                <BattlePieceVisual
                  piece={piece}
                  position={relocation.to}
                  viewer={viewer}
                  motionClass="battle-animation-visual augment-relocation-visual"
                />
              </span>,
            ];
          });
        }
        if (animation.kind === "removals") {
          return animation.entries.map(({ piece, position }, index) => (
            <span
              className="augment-effect-cell is-removal"
              key={`${animation.eventId}:removed:${piece?.id ?? index}`}
              style={battleTargetStyle(position)}
              data-effect-animation={animation.event.result}
              aria-hidden="true"
            >
              {piece ? (
                <BattlePieceVisual
                  piece={piece}
                  position={position}
                  viewer={viewer}
                  motionClass="augment-effect-piece"
                  ariaHidden
                />
              ) : null}
              <span className="augment-effect-ring" />
            </span>
          ));
        }
        return animation.positions.map((position, index) => (
          <span
            className="augment-effect-cell is-pulse"
            key={`${animation.eventId}:pulse:${index}`}
            style={battleTargetStyle(position)}
            data-effect-animation={animation.event.result}
            aria-hidden="true"
          >
            <span className="augment-effect-ring" />
          </span>
        ));
      })}
    </>
  );
}

function animatedPieceIds(animation: MovementAnimationTransition | null | undefined) {
  if (!animation) return [] as string[];
  return animation.kind === "exchange"
    ? [animation.first.pieceId, animation.second.pieceId]
    : [animation.attacker.id, ...(animation.defender ? [animation.defender.id] : [])];
}

interface BoardProps {
  game: ProjectedGame;
  pieces: PublicPiece[];
  viewer: Viewer;
  selected: Position | null;
  targets: Set<string>;
  flipped: boolean;
  busy: boolean;
  readOnly?: boolean;
  movementHighlight?: PublicEvent;
  movementAnimation?: MovementAnimationTransition | null;
  augmentEffectAnimations?: readonly AugmentBoardEffectAnimation[];
  interactionLabel?: string | null;
  nonCombatTargets?: boolean;
  onCell: (position: Position) => void;
  onPieceDragStart: (pieceId: string, position: Position) => boolean;
  onPieceDrop: (pieceId: string, position: Position) => void;
  onPieceDragEnd: () => void;
}

function Board({
  game,
  pieces,
  viewer,
  selected,
  targets,
  flipped,
  busy,
  readOnly = false,
  movementHighlight,
  movementAnimation,
  augmentEffectAnimations = [],
  interactionLabel = null,
  nonCombatTargets = false,
  onCell,
  onPieceDragStart,
  onPieceDrop,
  onPieceDragEnd,
}: BoardProps) {
  const cells = [];
  for (let row = 0; row < 12; row += 1) {
    for (let col = 0; col < 5; col += 1) cells.push({ row, col });
  }
  const alivePieces = pieces.filter((piece) => piece.alive && isInsideBoard(piece));
  const recentMovement = movementAnimation?.kind === "movement"
    ? movementAnimation.event
    : undefined;
  const motionPieceIds = new Set([
    ...animatedPieceIds(movementAnimation),
    ...animatedAugmentPieceIds(augmentEffectAnimations),
  ]);
  const columnLabels = Array.from({ length: 5 }, (_, index) =>
    String.fromCharCode(65 + (flipped ? 4 - index : index)),
  );
  const rowLabels = Array.from({ length: 12 }, (_, index) =>
    flipped ? 12 - index : index + 1,
  );

  return (
    <div className="board-frame">
      <div className="board-axis board-axis-columns" aria-hidden="true">
        {columnLabels.map((label) => <span key={label}>{label}</span>)}
      </div>
      <div className="board-axis board-axis-rows" aria-hidden="true">
        {rowLabels.map((label, index) => (
          <span
            key={label}
            style={{ gridRow: index < 6 ? index + 1 : index + 2 }}
          >
            {label}
          </span>
        ))}
      </div>
      <div
        className={`board-grid ${flipped ? "is-flipped" : ""}`}
        data-animation-outcome={movementAnimation?.outcome}
        aria-label="军棋棋盘"
      >
      <div className="mountain-band" aria-hidden="true">
        <span>界</span>
      </div>
      {cells.map((position) => {
        const { row, col } = position;
        const piece = alivePieces.find((candidate) => samePosition(candidate, position));
        const selectedHere = Boolean(selected && samePosition(selected, position));
        const targetHere = targets.has(positionKey(position));
        const targetAttack = Boolean(
          targetHere && piece && piece.side !== viewer && !nonCombatTargets,
        );
        const lastMoveFrom = Boolean(
          movementHighlight?.from && samePosition(movementHighlight.from, position),
        );
        const lastMoveTo = Boolean(
          movementHighlight?.to && samePosition(movementHighlight.to, position),
        );
        const camp = CAMPS.some((candidate) => samePosition(candidate, position));
        const headquarters = HEADQUARTERS.some((candidate) => samePosition(candidate, position));
        const headquartersSide: Side | null = headquarters ? (row < 6 ? "white" : "black") : null;
        const headquartersHasGate = Boolean(
          headquartersSide &&
          game.augment?.draft.loadouts[headquartersSide]?.includes("spade-last-headquarters"),
        );
        const headquartersGateUnlocked = Boolean(
          headquartersSide && game.augment?.ruleState?.headquartersUnlocked[headquartersSide],
        );
        const headquartersRelation = headquartersSide
          ? viewer === "spectator"
            ? sideName(headquartersSide)
            : headquartersSide === viewer
              ? "本方"
              : "对方"
          : null;
        const headquartersOwnershipClass =
          headquartersSide && viewer !== "spectator"
            ? headquartersSide === viewer
              ? "is-home-headquarters"
              : "is-opponent-headquarters"
            : "";
        const campMotion = getCampMotionForPosition(recentMovement, position, piece);
        const right = { row, col: col + 1 };
        const down = { row: row + 1, col };
        const downRight = { row: row + 1, col: col + 1 };
        const downLeft = { row: row + 1, col: col - 1 };
        const hasVertical = row < 11 && isRoadEdge(position, down);
        const visiblePieceLabel = piece?.type ? PIECE_INFO[piece.type].label : null;
        const hiddenByAnimation = Boolean(
          piece &&
            motionPieceIds.has(piece.id),
        );
        const pieceLabel = visiblePieceLabel ?? (piece ? "身份隐藏" : "空位");
        const headquartersGateLabel = headquartersHasGate
          ? headquartersGateUnlocked
            ? "，军旗门禁已解除"
            : "，军旗门禁未解除"
          : "";
        const stationLabel = camp
          ? "行营"
          : headquarters
            ? headquartersRelation
              ? `${headquartersRelation}大本营`
              : "大本营"
            : "兵站";
        const coverLabel = camp && piece ? "，半隐蔽" : "";
        const targetLabel = targetHere
          ? game.phase === "setup"
            ? piece
              ? "，可交换"
              : "，可放置"
            : interactionLabel
              ? `，${interactionLabel}`
              : piece
                ? "，可攻击"
                : "，可移动"
          : "";
        const draggable = Boolean(
          piece &&
            piece.side === viewer &&
            game.phase !== "finished" &&
            !readOnly &&
            !busy,
        );
        return (
          <div
            className="board-cell"
            key={positionKey(position)}
            style={{ gridRow: row < 6 ? row + 1 : row + 2, gridColumn: col + 1 }}
          >
            {col < 4 && isRoadEdge(position, right) ? (
              <span className={`road road-h ${isRailEdge(position, right) ? "rail" : ""}`} />
            ) : null}
            {hasVertical ? (
              <span
                className={`road road-v ${isRailEdge(position, down) ? "rail" : ""} ${row === 5 ? "bridge" : ""}`}
              />
            ) : null}
            {row < 11 && col < 4 && isRoadEdge(position, downRight) ? (
              <span className="road road-diagonal down-right" />
            ) : null}
            {row < 11 && col > 0 && isRoadEdge(position, downLeft) ? (
              <span className="road road-diagonal down-left" />
            ) : null}
            <button
              className={`station-hit ${selectedHere ? "is-selected" : ""} ${targetHere ? "is-target" : ""} ${targetAttack ? "is-attack" : ""} ${lastMoveFrom ? "is-last-move-from" : ""} ${lastMoveTo ? "is-last-move-to" : ""} ${visiblePieceLabel ? "has-piece-label" : ""} ${headquarters ? "is-headquarters" : ""} ${headquartersHasGate ? headquartersGateUnlocked ? "is-gate-unlocked" : "is-gate-locked" : ""} ${headquartersOwnershipClass}`}
              type="button"
              onClick={() => onCell(position)}
              draggable={draggable}
              onDragStart={(event) => {
                if (!piece || !draggable) {
                  event.preventDefault();
                  return;
                }
                if (!onPieceDragStart(piece.id, position)) {
                  event.preventDefault();
                  return;
                }
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(PIECE_DRAG_TYPE, piece.id);
                event.dataTransfer.setData("text/plain", piece.id);
              }}
              onDragOver={(event) => {
                if (readOnly || viewer === "spectator" || busy) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => {
                if (readOnly || viewer === "spectator" || busy) return;
                event.preventDefault();
                const pieceId =
                  event.dataTransfer.getData(PIECE_DRAG_TYPE) || event.dataTransfer.getData("text/plain");
                if (pieceId) onPieceDrop(pieceId, position);
              }}
              onDragEnd={onPieceDragEnd}
              disabled={readOnly || viewer === "spectator" || busy}
              aria-pressed={piece?.side === viewer ? selectedHere : undefined}
              aria-label={`${boardCoordinate(position)}，${stationLabel}${headquartersGateLabel}，${pieceLabel}${coverLabel}${targetLabel}`}
            >
              <span
                className={`station ${camp ? "camp" : headquarters ? "headquarters" : "post"} ${campMotion.station ? `camp-motion-${campMotion.station}` : ""}`}
                aria-hidden="true"
              >
                {headquarters ? <span className="headquarters-mark">本</span> : null}
              </span>
              {headquartersRelation ? (
                <span className="headquarters-badge" aria-hidden="true">{headquartersRelation}</span>
              ) : null}
              {headquartersHasGate ? (
                <span className="headquarters-gate-badge" aria-hidden="true">
                  {headquartersGateUnlocked ? "已开" : "门禁"}
                </span>
              ) : null}
              {targetHere && !piece ? <span className="target-dot" /> : null}
              {lastMoveFrom ? <span className="last-move-marker is-from" aria-hidden="true">起</span> : null}
              {lastMoveTo ? <span className="last-move-marker is-to" aria-hidden="true">到</span> : null}
              {piece ? (
                <>
                  <PieceModel
                    piece={piece}
                    inCamp={camp}
                    campMotion={campMotion.piece}
                    className={hiddenByAnimation ? "is-arrival-hidden" : ""}
                  />
                  {visiblePieceLabel ? (
                    <span
                      className={`board-piece-label side-${piece.side} ${camp ? "is-in-camp" : ""} ${hiddenByAnimation ? "is-arrival-hidden" : ""}`}
                      aria-hidden="true"
                    >
                      {visiblePieceLabel}
                    </span>
                  ) : null}
                  {piece.promoted ? (
                    <span className="augment-piece-badge is-promoted" aria-label="已晋升">升</span>
                  ) : null}
                  {piece.mineHits === 1 ? (
                    <span className="augment-piece-badge is-damaged-mine" aria-label="地雷已受一次攻击">1/2</span>
                  ) : null}
                </>
              ) : null}
            </button>
          </div>
        );
      })}
      {movementAnimation ? (
        movementAnimation.kind === "exchange" ? (
          <ExchangeAnimationOverlay
            key={`${movementAnimation.moveNumber}:${movementAnimation.eventId}`}
            animation={movementAnimation}
            pieces={alivePieces}
            viewer={viewer}
          />
        ) : (
          <BattleAnimationOverlay
            key={`${movementAnimation.moveNumber}:${movementAnimation.event.id}`}
            animation={movementAnimation}
            viewer={viewer}
          />
        )
      ) : null}
      {augmentEffectAnimations.length ? (
        <AugmentEffectAnimationOverlay
          animations={augmentEffectAnimations}
          viewer={viewer}
        />
      ) : null}
      </div>
    </div>
  );
}

function orderPiecesForBox(pieces: PublicPiece[]) {
  return [...pieces].sort((first, second) => {
    const firstIndex = first.type ? Object.keys(PIECE_INFO).indexOf(first.type) : Number.MAX_SAFE_INTEGER;
    const secondIndex = second.type ? Object.keys(PIECE_INFO).indexOf(second.type) : Number.MAX_SAFE_INTEGER;
    return firstIndex - secondIndex || first.id.localeCompare(second.id);
  });
}

function PieceTray({
  pieces,
  selectedPieceId,
  disabled,
  onSelect,
  onDragStartPiece,
  onDragEnd,
}: {
  pieces: PublicPiece[];
  selectedPieceId: string | null;
  disabled: boolean;
  onSelect: (pieceId: string) => void;
  onDragStartPiece: (pieceId: string) => boolean;
  onDragEnd: () => void;
}) {
  const ordered = orderPiecesForBox(pieces);
  return (
    <section className="piece-box" aria-label={`棋盒，剩余 ${pieces.length} 枚棋子`}>
      <div className="piece-box-title">
        <strong>棋盒</strong>
        <span role="status">{pieces.length}</span>
      </div>
      <div className="piece-tray" role="group" aria-label="待布阵棋子">
        {ordered.map((piece) => (
          <button
            className={`tray-piece ${selectedPieceId === piece.id ? "is-selected" : ""}`}
            type="button"
            key={piece.id}
            disabled={disabled}
            draggable={!disabled}
            aria-pressed={selectedPieceId === piece.id}
            aria-label={`${piece.type ? PIECE_INFO[piece.type].label : "棋子"}，选择后放入棋盘`}
            onClick={() => onSelect(piece.id)}
            onDragStart={(event: DragEvent<HTMLButtonElement>) => {
              if (!onDragStartPiece(piece.id)) {
                event.preventDefault();
                return;
              }
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData(PIECE_DRAG_TYPE, piece.id);
              event.dataTransfer.setData("text/plain", piece.id);
            }}
            onDragEnd={onDragEnd}
          >
            <PieceModel piece={piece} />
            <span className="tray-piece-label" aria-hidden="true">
              {piece.type ? PIECE_INFO[piece.type].label : "棋子"}
            </span>
          </button>
        ))}
      </div>
      <p className="piece-box-hint">拖到棋盘，或先点棋子再点位置</p>
    </section>
  );
}

function CapturedPieceBox({ pieces }: { pieces: PublicPiece[] }) {
  const ordered = orderPiecesForBox(pieces);
  return (
    <section className="piece-box captured-piece-box" aria-label={`己方阵亡棋子，共 ${pieces.length} 枚`}>
      <div className="piece-box-title">
        <strong>棋盒 · 阵亡</strong>
        <span role="status">{pieces.length}</span>
      </div>
      {ordered.length ? (
        <div className="piece-tray" role="list" aria-label="己方阵亡棋子">
          {ordered.map((piece) => (
            <div
              className="tray-piece captured-piece"
              key={piece.id}
              role="listitem"
              aria-label={piece.type ? PIECE_INFO[piece.type].label : "棋子"}
            >
              <PieceModel piece={piece} />
              <span className="tray-piece-label" aria-hidden="true">
                {piece.type ? PIECE_INFO[piece.type].label : "棋子"}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="captured-piece-empty">暂无</p>
      )}
    </section>
  );
}

function AugmentRuleStatusPanel({
  game,
  side,
  ownerLabel,
}: {
  game: ProjectedGame;
  side: Side;
  ownerLabel: string;
}) {
  const augment = game.augment;
  if (!augment) return null;
  const loadout = augment.draft.loadouts[side] ?? [];
  const items: Array<{ label: string; value: string }> = [];
  const lightning = augment.ruleState?.lightning[side] ?? null;
  if (lightning) {
    items.push({ label: "兵贵神速", value: `军旗倒计时 ${lightning.remainingOwnTurns} 回合` });
  }
  if (loadout.includes("spade-last-headquarters")) {
    items.push({
      label: "濒死悟道",
      value: augment.ruleState?.headquartersUnlocked[side]
        ? "另一大本营已失守 · 军旗可被夺取"
        : "另一大本营尚未失守 · 军旗受保护，进攻会被阻止并公开",
    });
  }
  if (loadout.includes("club-bombardier")) {
    const secondFuse = augment.ruleState?.bombSecondFuse?.[side];
    const used = secondFuse?.survivalUsed ||
      (augment.triggerCounts[side]["club-bombardier"] ?? 0) > 0;
    items.push({
      label: "英勇投弹手",
      value: used
        ? "第二引信已使用"
        : secondFuse?.bound
          ? "第二引信已绑定 · 尚未使用"
          : "第二引信待命",
    });
  }
  const damagedMines = game.pieces.filter(
    (piece) => piece.side === side && piece.mineHits === 1,
  ).length;
  if (damagedMines > 0) {
    items.push({ label: "地雷战况", value: `${damagedMines} 枚受损地雷已公开 · 再受一击退场` });
  }
  const promotedPublicIds = new Set(augment.ruleState?.promotedPublicIds ?? []);
  const promoted = game.pieces.filter(
    (piece) =>
      piece.alive &&
      piece.side === side &&
      (piece.promoted || promotedPublicIds.has(piece.id)),
  ).length;
  if (promoted > 0) {
    items.push({ label: "晋升", value: `${promoted} 枚存活棋子已晋升` });
  }
  if (!items.length) return null;
  return (
    <section className="augment-rule-status" aria-label={`${ownerLabel}军令状态`}>
      <div className="panel-title-row"><strong>{ownerLabel}军令状态</strong><span>当前状态</span></div>
      <dl>
        {items.map((item) => (
          <div key={item.label}>
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function SignInLanding({ signInPath }: { signInPath: string }) {
  const [authResolution, setAuthResolution] = useState({
    path: null as string | null,
    note: "登录后才能对局、观战与保存战绩。",
  });

  useEffect(() => {
    const staged = stageRoomInviteForSignIn(
      window.location.href,
      browserSessionStorage(),
    );
    if (staged.clearFragment) {
      try {
        clearInviteNavigationArtifacts(new URL(window.location.href));
      } catch {
        // The sign-in path remains safe even if the cosmetic URL cleanup fails.
      }
    }
    let nextPath = signInPath;
    let nextNote = "登录后才能对局、观战与保存战绩。";
    if (staged.status === "stored") {
      nextNote = "登录后会自动领取这局的玩家席位。";
    } else if (staged.status === "watch_only") {
      if (staged.code) {
        nextPath = signInPathWithWatchOnly(signInPath, staged.code, window.location.origin);
      }
    } else if (staged.status === "invalid") {
      nextNote = "玩家邀请无效。登录后请重新打开一条有效的邀请链接。";
      if (staged.code) {
        nextPath = signInPathWithInviteRetry(signInPath, staged.code, window.location.origin);
      }
    } else if (staged.status === "storage_unavailable") {
      nextNote = "当前浏览器无法暂存邀请。请先登录，再重新打开原玩家邀请链接。";
      if (staged.code) {
        nextPath = signInPathWithInviteRetry(signInPath, staged.code, window.location.origin);
      }
    }
    const timer = window.setTimeout(() => {
      setAuthResolution({ path: nextPath, note: nextNote });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [signInPath]);

  return (
    <main className="landing auth-landing">
      <div className="auth-stage">
        <div className="auth-court-card auth-queen" aria-hidden="true" />
        <section className="landing-core auth-panel">
          <span className="product-kicker">经典 · 狂野 · 对弈</span>
          <h1><span>军令</span><span>陆战棋</span></h1>
          <p>暖白纸牌桌上的双人暗军棋</p>
          {authResolution.path ? (
            <a className="button primary sign-in-button" href={authResolution.path}>使用邮箱登录</a>
          ) : (
            <button className="button primary sign-in-button" type="button" disabled>使用邮箱登录</button>
          )}
          <small className="auth-note" role="status">{authResolution.note}</small>
        </section>
        <div className="auth-court-card auth-king" aria-hidden="true" />
      </div>
    </main>
  );
}

export default function GameApp({
  hasRoom = false,
  user,
  signInPath = "/signin-with-chatgpt?return_to=%2F",
  signOutPath = "/signout-with-chatgpt?return_to=%2F",
}: {
  hasRoom?: boolean;
  user?: SessionUser | null;
  signInPath?: string;
  signOutPath?: string;
}) {
  const [room, setRoom] = useState<RoomEnvelope | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [selectedPieceId, setSelectedPieceId] = useState<string | null>(null);
  const [setupDraftState, setSetupDraftState] = useState<SetupDraftState | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(hasRoom && Boolean(user));
  const [creating, setCreating] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [replayIndex, setReplayIndex] = useState<number | null>(null);
  const [movementAnimation, setMovementAnimation] =
    useState<MovementAnimationTransition | null>(null);
  const [augmentEffectAnimations, setAugmentEffectAnimations] =
    useState<AugmentBoardEffectAnimation[]>([]);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [replayMovementAnimationIndex, setReplayMovementAnimationIndex] =
    useState<number | null>(null);
  const [replayEffectAnimationIndex, setReplayEffectAnimationIndex] =
    useState<number | null>(null);
  const [clockTick, setClockTick] = useState(0);
  const [clockAnchor, setClockAnchor] = useState(0);
  const [connection, setConnection] = useState<"live" | "syncing" | "offline">("live");
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [recentMatches, setRecentMatches] = useState<RecentMatch[]>([]);

  useEffect(() => {
    if (hasRoom) markLobbyEntered(browserSessionStorage(), LOBBY_ENTRY_SESSION_KEY);
  }, [hasRoom]);
  const [friends, setFriends] = useState<FriendsEnvelope>({ friends: [], incoming: [], outgoing: [] });
  const [matchmaking, setMatchmaking] = useState<MatchmakingEnvelope>({ state: "idle" });
  const [watchingMatchId, setWatchingMatchId] = useState<string | null>(null);
  const [activeAugmentId, setActiveAugmentId] = useState<AugmentId | null>(null);
  const [redeployDraft, setRedeployDraft] = useState<RedeployDraft | null>(null);
  const [sacrificeCandidateId, setSacrificeCandidateId] = useState<string | null>(null);
  const [augmentDraftVisualHold, setAugmentDraftVisualHold] =
    useState<AugmentDraftVisualHold | null>(null);
  const roomRef = useRef<RoomEnvelope | null>(null);
  const roomSessionRef = useRef(0);
  const busyRef = useRef(false);
  const creatingRef = useRef(false);
  const watchingMatchRef = useRef<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const replayIndexRef = useRef<number | null>(null);
  const reduceMotionRef = useRef(false);
  const suppressClickUntilRef = useRef(0);
  const dragDroppedRef = useRef(false);
  const rulesDialogRef = useRef<HTMLDialogElement>(null);
  const rulesTitleRef = useRef<HTMLHeadingElement>(null);
  const rulesTriggerRef = useRef<HTMLButtonElement>(null);

  const setupSide = room && isPlayer(room.viewer) ? room.viewer : null;
  const setupSnapshotPieces = useMemo(
    () =>
      room && setupSide
        ? room.snapshot.pieces.filter((piece) => piece.alive && piece.side === setupSide && piece.type)
        : [],
    [room, setupSide],
  );
  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  useEffect(() => {
    replayIndexRef.current = replayIndex;
  }, [replayIndex]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncPreference = () => {
      reduceMotionRef.current = media.matches;
      setReducedMotion(media.matches);
      if (media.matches) {
        setMovementAnimation(null);
        setAugmentEffectAnimations([]);
      }
    };
    syncPreference();
    media.addEventListener("change", syncPreference);
    return () => media.removeEventListener("change", syncPreference);
  }, []);

  useEffect(() => {
    if (!movementAnimation) return;
    const duration =
      movementAnimation.kind === "exchange" || movementAnimation.outcome === "move"
        ? MOVEMENT_ANIMATION_MS
        : BATTLE_ANIMATION_MS;
    const timer = window.setTimeout(() => {
      setMovementAnimation((current) =>
        current === movementAnimation ? null : current,
      );
    }, duration);
    return () => window.clearTimeout(timer);
  }, [movementAnimation]);

  useEffect(() => {
    if (!augmentEffectAnimations.length) return;
    const timer = window.setTimeout(
      () => setAugmentEffectAnimations([]),
      AUGMENT_EFFECT_ANIMATION_MS,
    );
    return () => window.clearTimeout(timer);
  }, [augmentEffectAnimations]);

  useEffect(() => {
    const stopHiddenAnimation = () => {
      if (document.hidden) {
        setMovementAnimation(null);
        setAugmentEffectAnimations([]);
      }
    };
    document.addEventListener("visibilitychange", stopHiddenAnimation);
    return () => document.removeEventListener("visibilitychange", stopHiddenAnimation);
  }, []);

  useEffect(() => {
    if (
      !room?.snapshot.clock?.running ||
      room.snapshot.phase !== "playing"
    ) {
      return;
    }
    const updateClock = () => setClockTick(performance.now());
    updateClock();
    const timer = window.setInterval(updateClock, 250);
    return () => window.clearInterval(timer);
  }, [room?.code, room?.snapshot.clock?.running, room?.snapshot.phase]);

  useEffect(() => {
    if (!setupDraftState) return;
    writeLocalValue(
      setupDraftKey(setupDraftState.roomCode, setupDraftState.side),
      JSON.stringify(setupDraftState.locations),
    );
  }, [setupDraftState]);

  useEffect(() => {
    const cancelSelection = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !rulesDialogRef.current?.open) {
        setSelectedPieceId(null);
        setActiveAugmentId(null);
        setRedeployDraft(null);
        setSacrificeCandidateId(null);
      }
    };
    window.addEventListener("keydown", cancelSelection);
    return () => window.removeEventListener("keydown", cancelSelection);
  }, []);

  useEffect(() => {
    const dialog = rulesDialogRef.current;
    if (!dialog) return;
    if (rulesOpen && !dialog.open) {
      dialog.showModal();
      rulesTitleRef.current?.focus();
    } else if (!rulesOpen && dialog.open) {
      dialog.close();
    }
  }, [rulesOpen]);

  function showToast(message: string) {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 2800);
  }
  async function refreshAccountAndFriends() {
    if (!user) return;
    const [accountResponse, friendsResponse] = await Promise.all([
      fetch("/api/account", { cache: "no-store" }),
      fetch("/api/friends", { cache: "no-store" }),
    ]);
    const accountPayload = (await parseResponse(accountResponse)) as AccountEnvelope;
    const friendsPayload = (await parseResponse(friendsResponse)) as FriendsEnvelope;
    setAccount(accountPayload.account);
    setRecentMatches(accountPayload.recentMatches);
    setFriends(friendsPayload);
  }

  async function updateHandle(handle: string) {
    const response = await fetch("/api/account", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle }),
    });
    const payload = (await parseResponse(response)) as AccountEnvelope;
    setAccount(payload.account);
    setRecentMatches(payload.recentMatches);
    showToast("玩家 ID 已更新。");
  }

  async function enterAuthenticatedRoom(code: string) {
    const normalized = cleanCode(code);
    if (normalized.length !== 8 || roomRef.current?.code === normalized) return;
    clearRoom();
    const session = roomSessionRef.current;
    setToken(null);
    setInviteToken(null);
    setLoading(true);
    setFatalError(null);
    window.history.replaceState(null, "", `/?room=${normalized}`);
    try {
      await loadInitialRoom(normalized, null, session);
    } catch (error) {
      if (session !== roomSessionRef.current) return;
      const errorCode = error instanceof RequestError ? error.code : "ROOM_READ_FAILED";
      setFatalError(ERROR_TEXT[errorCode] ?? "暂时无法进入匹配对局。");
    } finally {
      if (session === roomSessionRef.current) setLoading(false);
    }
  }

  async function refreshMatchmaking() {
    if (!user) return;
    const response = await fetch("/api/matchmaking", { cache: "no-store" });
    const payload = (await parseResponse(response)) as MatchmakingEnvelope;
    setMatchmaking(payload);
    if (payload.state === "matched" && payload.match?.game.status === "ready" && payload.match.game.code) {
      await enterAuthenticatedRoom(payload.match.game.code);
    }
  }

  const syncLobbyData = useEffectEvent(async () => {
    await Promise.all([
      refreshAccountAndFriends(),
      fetch("/api/presence", { method: "POST" }).then(parseResponse),
      refreshMatchmaking(),
    ]);
  });

  useEffect(() => {
    if (!user || room?.code) return;
    let stopped = false;
    const sync = async () => {
      try {
        await syncLobbyData();
      } catch (error) {
        if (!stopped && error instanceof RequestError && error.status === 401) {
          setFatalError("登录状态已失效，请重新登录。");
        }
      }
    };
    void sync();
    const timer = window.setInterval(sync, matchmaking.state === "queued" ? 1600 : 15_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [user, room?.code, matchmaking.state]);

  useEffect(() => {
    if (!user || !room?.code) return;
    let stopped = false;
    const heartbeat = async () => {
      try {
        await parseResponse(await fetch("/api/presence", { method: "POST" }));
      } catch (error) {
        if (!stopped && error instanceof RequestError && error.status === 401) {
          setFatalError("登录状态已失效，请重新登录。");
        }
      }
    };
    void heartbeat();
    const timer = window.setInterval(heartbeat, 30_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [user, room?.code]);

  function acceptRoom(next: RoomEnvelope, allowRoomChange = false) {
    const current = roomRef.current;
    if (current && current.code !== next.code && !allowRoomChange) return false;
    if (current && current.code === next.code && next.version < current.version) return false;
    markLobbyEntered(browserSessionStorage(), LOBBY_ENTRY_SESSION_KEY);
    const preservesInteractionContext = Boolean(
      current && current.code === next.code && current.viewer === next.viewer,
    );
    if (!preservesInteractionContext) {
      setMovementAnimation(null);
      setAugmentEffectAnimations([]);
      setAugmentDraftVisualHold(null);
      setRedeployDraft(null);
      setSacrificeCandidateId(null);
    } else if (current && next.version > current.version) {
      const animationEnabled =
        replayIndexRef.current === null &&
        !reduceMotionRef.current &&
        !document.hidden;
      const animation = animationEnabled
        ? movementAnimationForTransition(current.snapshot, next.snapshot)
        : null;
      setMovementAnimation(animation);
      setAugmentEffectAnimations(
        animationEnabled
          ? augmentBoardEffectsForTransition(current.snapshot, next.snapshot)
          : [],
      );
      setRedeployDraft(null);
      setSacrificeCandidateId(null);
    }
    if (
      !current ||
      current.code !== next.code ||
      current.snapshot.phase !== next.snapshot.phase ||
      (current.snapshot.phase === "setup" &&
        isPlayer(next.viewer) &&
        current.snapshot.ready[next.viewer] !== next.snapshot.ready[next.viewer]) ||
      (next.snapshot.phase !== "setup" && current.version !== next.version)
    ) {
      setSelectedPieceId(null);
    }
    if (isPlayer(next.viewer) && next.snapshot.phase === "setup") {
      const side = next.viewer;
      const selectedOpeningAugment = next.snapshot.augment?.draft.rounds[0]?.players[side].selectedId;
      const setupAugmentIds = selectedOpeningAugment ? [selectedOpeningAugment] : [];
      const hasSetupHistory = next.snapshot.events.some(
        (event) => event.actor === side && (event.result === "ready" || event.result === "unready"),
      );
      setSetupDraftState((draftState) => {
        if (next.snapshot.ready[side]) {
          return {
            roomCode: next.code,
            side,
            locations: createSetupDraft(next.snapshot.pieces, side, true, setupAugmentIds),
          };
        }
        if (
          draftState?.roomCode === next.code &&
          draftState.side === side &&
          isValidSetupDraft(next.snapshot.pieces, side, draftState.locations, false, setupAugmentIds)
        ) {
          return draftState;
        }
        const restored = restoreSetupDraft(
          readLocalValue(setupDraftKey(next.code, side)),
          next.snapshot.pieces,
          side,
          false,
          setupAugmentIds,
        );
        return {
          roomCode: next.code,
          side,
          locations:
            restored ?? createSetupDraft(next.snapshot.pieces, side, hasSetupHistory, setupAugmentIds),
        };
      });
    } else {
      setSetupDraftState(null);
    }
    if (next.snapshot.phase !== "playing") {
      setRedeployDraft(null);
      setSacrificeCandidateId(null);
    }
    const receivedAt = performance.now();
    setClockAnchor(receivedAt);
    setClockTick(receivedAt);
    roomRef.current = next;
    setRoom(next);
    setActiveAugmentId((active) =>
      reconcileActiveAugmentAfterProjection(
        preservesInteractionContext && current?.version === next.version ? active : null,
        isPlayer(next.viewer) ? next.snapshot.augment?.pendingRecon : null,
      ),
    );
    return true;
  }

  function clearRoom() {
    roomSessionRef.current += 1;
    busyRef.current = false;
    setBusy(false);
    setSelectedPieceId(null);
    setActiveAugmentId(null);
    setRedeployDraft(null);
    setSacrificeCandidateId(null);
    setAugmentDraftVisualHold(null);
    setSetupDraftState(null);
    setRulesOpen(false);
    replayIndexRef.current = null;
    setReplayIndex(null);
    setMovementAnimation(null);
    setAugmentEffectAnimations([]);
    setClockAnchor(0);
    setClockTick(0);
    roomRef.current = null;
    setRoom(null);
  }

  function clearBoardInteractionState() {
    setSelectedPieceId(null);
    setActiveAugmentId(null);
    setRedeployDraft(null);
    setSacrificeCandidateId(null);
  }

  async function loadInitialRoom(code: string, activeToken: string | null, session: number) {
    const envelope = await fetchRoom(code, activeToken);
    if (!envelope) throw new Error("EMPTY_ROOM_RESPONSE");
    if (session !== roomSessionRef.current) return;
    acceptRoom(envelope, true);
    setToken(activeToken);
    setInviteToken(readLocalValue(inviteTokenKey(code)));
    setFlipped(false);
    setFatalError(null);
    setConnection("live");
  }

  useEffect(
    () => () => {
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const session = ++roomSessionRef.current;
    if (!user) {
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      let code = "";
      let inviteContext = false;
      let inviteUrl: URL | null = null;
      try {
        const url = new URL(window.location.href);
        inviteUrl = url;
        code = cleanCode(url.searchParams.get("room") ?? "");
        if (code.length !== 8) return;
        const watchOnly = url.searchParams.get("watch") === "1";
        const inviteRetry = url.searchParams.get(INVITE_RETRY_PARAM) === "1";
        const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
        const directInvitePresent = fragment.has("invite");
        const directInviteValue = fragment.get("invite") ?? "";
        const directInviteToken = isValidRoomInviteToken(directInviteValue)
          ? directInviteValue
          : null;
        const inviteStorage = browserSessionStorage();
        const recoveredInvite = !watchOnly && !directInvitePresent
          ? readPendingRoomInvite(inviteStorage, code)
          : null;
        const invitedToken = directInviteToken ?? recoveredInvite;
        inviteContext = directInvitePresent || Boolean(recoveredInvite) || inviteRetry;
        let storedToken = readLocalValue(roomTokenKey(code));
        if (!watchOnly && inviteContext && storedToken) {
          try {
            const existing = await fetchRoom(code, storedToken);
            if (!existing) throw new Error("EMPTY_ROOM_RESPONSE");
            if (cancelled || session !== roomSessionRef.current) return;
            clearPendingRoomInvite(inviteStorage, code);
            clearInviteNavigationArtifacts(url);
            acceptRoom(existing, true);
            setToken(storedToken);
            setInviteToken(readLocalValue(inviteTokenKey(code)));
            setFlipped(false);
            setFatalError(null);
            setConnection("live");
            return;
          } catch (error) {
            if (!(error instanceof RequestError) || error.status !== 401) throw error;
            removeLocalValue(roomTokenKey(code));
            storedToken = null;
          }
        }
        if (watchOnly) {
          if (directInvitePresent || inviteRetry) clearInviteNavigationArtifacts(url);
        } else if (directInvitePresent && !directInviteToken) {
          clearPendingRoomInvite(inviteStorage, code);
          clearInviteNavigationArtifacts(url);
          throw new RequestError(400, "INVALID_INVITE_TOKEN");
        } else if (inviteRetry && !invitedToken) {
          clearInviteNavigationArtifacts(url);
          setFatalError("登录成功，但浏览器未能保留玩家邀请。请重新打开原邀请链接。");
          return;
        } else if (invitedToken) {
          let candidateToken = readLocalValue(pendingTokenKey(code)) ?? createClientToken();
          writeLocalValue(pendingTokenKey(code), candidateToken);
          let claimed: ClaimRoomEnvelope;
          try {
            claimed = await claimSeat(code, invitedToken, candidateToken);
          } catch (error) {
            if (error instanceof RequestError && error.code === "VERSION_CONFLICT") {
              claimed = await claimSeat(code, invitedToken, candidateToken);
            } else if (error instanceof RequestError && error.code === "TOKEN_ALREADY_IN_USE") {
              candidateToken = createClientToken();
              writeLocalValue(pendingTokenKey(code), candidateToken);
              claimed = await claimSeat(code, invitedToken, candidateToken);
            } else {
              throw error;
            }
          }
          if (cancelled || session !== roomSessionRef.current) return;
          const identitySaved = writeLocalValue(roomTokenKey(code), candidateToken);
          removeLocalValue(pendingTokenKey(code));
          clearPendingRoomInvite(inviteStorage, code);
          clearInviteNavigationArtifacts(url);
          acceptRoom(roomEnvelopeFromTransport(claimed), true);
          setToken(candidateToken);
          setInviteToken(null);
          setFlipped(false);
          setFatalError(null);
          setConnection("live");
          if (!identitySaved) showToast("玩家身份只能在当前页面保留，请勿刷新。");
          return;
        }
        let activeToken = watchOnly ? null : storedToken;
        let envelope: RoomEnvelope | null;
        try {
          envelope = await fetchRoom(code, activeToken);
        } catch (error) {
          if (!(error instanceof RequestError) || error.status !== 401 || !activeToken) throw error;
          removeLocalValue(roomTokenKey(code));
          activeToken = null;
          envelope = await fetchRoom(code, null);
          if (!cancelled && session === roomSessionRef.current) {
            showToast("玩家身份已失效，已切换为观战。");
          }
        }
        if (!envelope) throw new Error("EMPTY_ROOM_RESPONSE");
        if (cancelled || session !== roomSessionRef.current) return;
        acceptRoom(envelope, true);
        setToken(activeToken);
        setInviteToken(readLocalValue(inviteTokenKey(code)));
        setFlipped(false);
        setFatalError(null);
        setConnection("live");
      } catch (error) {
        if (!cancelled && session === roomSessionRef.current) {
          const codeValue = error instanceof RequestError ? error.code : "ROOM_READ_FAILED";
          setFatalError(ERROR_TEXT[codeValue] ?? "暂时无法进入这个房间。");
          if (code && inviteContext && isTerminalInviteError(error)) {
            clearPendingRoomInvite(browserSessionStorage(), code);
            if (inviteUrl) clearInviteNavigationArtifacts(inviteUrl);
          }
          if (
            code &&
            error instanceof RequestError &&
            ([400, 401].includes(error.status) || error.code === "SEAT_ALREADY_CLAIMED")
          ) {
            removeLocalValue(pendingTokenKey(code));
          }
        }
      } finally {
        if (!cancelled && session === roomSessionRef.current) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    if (!room?.code) return;
    let stopped = false;
    let timer = 0;
    const session = roomSessionRef.current;
    const poll = async () => {
      const current = roomRef.current;
      if (!current || stopped || session !== roomSessionRef.current) return;
      try {
        const next = await fetchRoom(current.code, token, current.version);
        if (next && next.version >= current.version && !stopped && session === roomSessionRef.current) {
          acceptRoom(next);
        }
        if (!stopped && session === roomSessionRef.current) setConnection("live");
      } catch (error) {
        if (stopped || session !== roomSessionRef.current) return;
        if (error instanceof RequestError && [401, 404, 410].includes(error.status)) {
          stopped = true;
          setFatalError(ERROR_TEXT[error.code] ?? "这个房间已经不可用。");
          removeLocalValue(roomTokenKey(current.code));
          setToken(null);
          clearRoom();
          return;
        }
        if (!stopped) setConnection("offline");
      } finally {
        if (!stopped && session === roomSessionRef.current) {
          const base = roomRef.current?.viewer === "spectator" ? 2400 : 1300;
          const hiddenDelay = document.hidden ? 3 : 1;
          timer = window.setTimeout(poll, (base + Math.random() * 250) * hiddenDelay);
        }
      }
    };
    timer = window.setTimeout(poll, 900);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [room?.code, room?.viewer, token]);

  async function createRoom(
    gameMode: "classic" | "augment" = "classic",
    spectatorPolicy: "hidden" | "full" = "hidden",
  ) {
    if (creatingRef.current) return;
    creatingRef.current = true;
    clearRoom();
    const session = roomSessionRef.current;
    setToken(null);
    setInviteToken(null);
    setCreating(true);
    setFatalError(null);
    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameMode, spectatorPolicy }),
      });
      const created = (await parseResponse(response)) as unknown as CreateRoomEnvelope;
      if (session !== roomSessionRef.current) return;
      const playerSaved = writeLocalValue(roomTokenKey(created.code), created.playerToken);
      const inviteSaved = writeLocalValue(inviteTokenKey(created.code), created.opponentInviteToken);
      window.history.replaceState(null, "", `/?room=${created.code}`);
      setToken(created.playerToken);
      setInviteToken(created.opponentInviteToken);
      acceptRoom(roomEnvelopeFromTransport(created), true);
      setFlipped(false);
      setConnection("live");
      showToast(playerSaved && inviteSaved ? "房间已创建" : "房间已创建；身份只能在当前页面保留，请勿刷新。");
    } catch (error) {
      if (session !== roomSessionRef.current) return;
      const errorCode = error instanceof RequestError ? error.code : "ROOM_CREATE_FAILED";
      setFatalError(ERROR_TEXT[errorCode] ?? ERROR_TEXT.ROOM_CREATE_FAILED);
    } finally {
      creatingRef.current = false;
      setCreating(false);
      if (session === roomSessionRef.current) setLoading(false);
    }
  }

  async function openRoom(code: string) {
    const normalized = cleanCode(code);
    if (normalized.length !== 8) return;
    clearRoom();
    const session = roomSessionRef.current;
    setToken(null);
    setInviteToken(null);
    setLoading(true);
    setFatalError(null);
    window.history.replaceState(null, "", `/?room=${normalized}&watch=1`);
    try {
      await loadInitialRoom(normalized, null, session);
    } catch (error) {
      if (session !== roomSessionRef.current) return;
      const errorCode = error instanceof RequestError ? error.code : "ROOM_READ_FAILED";
      setFatalError(ERROR_TEXT[errorCode] ?? "暂时无法进入这个房间。");
    } finally {
      if (session === roomSessionRef.current) setLoading(false);
    }
  }

  async function startMatchmaking() {
    try {
      const response = await fetch("/api/matchmaking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "hex_ranked" }),
      });
      const payload = (await parseResponse(response)) as MatchmakingEnvelope;
      setMatchmaking(payload);
      showToast(payload.state === "matched" ? "已找到对手，正在创建棋局。" : "已开始匹配。");
      if (payload.state === "matched" && payload.match?.game.status === "ready" && payload.match.game.code) {
        await enterAuthenticatedRoom(payload.match.game.code);
      }
    } catch (error) {
      showToast(error instanceof RequestError && error.code === "MATCHMAKING_BUSY" ? "匹配服务正忙，请稍后重试。" : "暂时无法开始匹配。");
    }
  }

  async function cancelMatchmaking() {
    try {
      const response = await fetch("/api/matchmaking", { method: "DELETE" });
      setMatchmaking((await parseResponse(response)) as MatchmakingEnvelope);
      showToast("已取消匹配。");
    } catch {
      showToast("取消匹配失败，请重试。");
    }
  }

  async function requestFriend(handle: string) {
    try {
      await parseResponse(await fetch("/api/friends/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle }),
      }));
      await refreshAccountAndFriends();
      showToast("好友请求已发送。");
    } catch (error) {
      const code = error instanceof RequestError ? error.code : "";
      const message = code === "PLAYER_NOT_FOUND" ? "没有找到这个玩家 ID。" : code === "ALREADY_FRIENDS" ? "你们已经是好友。" : "好友请求没有发送成功。";
      showToast(message);
    }
  }

  async function acceptFriend(requestId: string) {
    try {
      await parseResponse(await fetch(`/api/friends/requests/${requestId}/accept`, { method: "POST" }));
      await refreshAccountAndFriends();
      showToast("已添加好友。");
    } catch {
      showToast("接受好友请求失败。");
    }
  }

  async function watchFriendMatch(matchId: string) {
    if (watchingMatchRef.current) return;
    watchingMatchRef.current = matchId;
    setWatchingMatchId(matchId);
    let session: number | null = null;
    try {
      const response = await fetch(`/api/friends/matches/${matchId}`, { cache: "no-store" });
      const payload = (await parseResponse(response)) as { game: { status: string; code: string | null } };
      if (payload.game.status !== "ready" || !payload.game.code) {
        showToast("好友对局正在创建，请稍后再试。");
        return;
      }
      clearRoom();
      session = roomSessionRef.current;
      setLoading(true);
      setFatalError(null);
      window.history.replaceState(null, "", `/?room=${payload.game.code}&watch=1&match=${encodeURIComponent(matchId)}`);
      await loadInitialRoom(payload.game.code, null, session);
    } catch (error) {
      if (session !== null && session !== roomSessionRef.current) return;
      if (session !== null) window.history.replaceState(null, "", "/");
      const unavailable = error instanceof RequestError && [403, 404, 409].includes(error.status);
      showToast(unavailable
        ? "这局当前不可观战，或你还不是参赛者的好友。"
        : "暂时无法载入好友对局，请重试。");
    } finally {
      if (session === null || session === roomSessionRef.current) setLoading(false);
      if (watchingMatchRef.current === matchId) watchingMatchRef.current = null;
      setWatchingMatchId((current) => current === matchId ? null : current);
    }
  }

  async function performAction(action: PlayerAction) {
    const current = roomRef.current;
    if (!current || !isPlayer(current.viewer) || busyRef.current) return false;
    const requestedAugmentRound = action.type === "augment_lock" || action.type === "augment_pick"
      ? current.snapshot.augment?.draft.activeRound ?? null
      : null;
    const session = roomSessionRef.current;
    busyRef.current = true;
    setBusy(true);
    setConnection("syncing");
    try {
      const next = await postAction(current.code, token, current.version, action);
      if (session !== roomSessionRef.current || roomRef.current?.code !== current.code) return false;
      acceptRoom(next);
      setConnection("live");
      const forcedMultiMovePieceId = next.snapshot.augment?.multiMove?.pieceId ?? null;
      setSelectedPieceId(
        action.type === "augment_begin_multi_move"
          ? action.pieceId
          : action.type === "move" && forcedMultiMovePieceId
            ? forcedMultiMovePieceId
            : null,
      );
      if (action.type === "augment_recon") {
        if (!shouldKeepActiveReconSelection(
          action.augmentId,
          next.snapshot.augment?.pendingRecon,
        )) {
          setActiveAugmentId(null);
        }
      } else if (
        action.type === "augment_move" ||
        action.type === "augment_exchange" ||
        action.type === "augment_begin_multi_move" ||
        action.type === "augment_redeploy" ||
        action.type === "augment_sacrifice" ||
        action.type === "pass_extra_move"
      ) {
        setActiveAugmentId(null);
      }
      if (action.type === "augment_redeploy") setRedeployDraft(null);
      if (action.type === "augment_sacrifice") setSacrificeCandidateId(null);
      return true;
    } catch (error) {
      if (session !== roomSessionRef.current || roomRef.current?.code !== current.code) return false;
      // A rejected action can make every client-side board choice stale. Return to
      // the neutral board before showing the authoritative server explanation.
      clearBoardInteractionState();
      if (error instanceof RequestError && error.status === 409) {
        try {
          const latest = await fetchRoom(current.code, token);
          if (session !== roomSessionRef.current || roomRef.current?.code !== current.code) return false;
          if (latest) acceptRoom(latest);
          setConnection("live");
          if (
            (action.type === "augment_lock" || action.type === "augment_pick") &&
            latest &&
            wasAugmentLockConfirmedAfterConflict(
              latest.viewer,
              requestedAugmentRound,
              latest.snapshot.augment?.draft.rounds,
              action.type === "augment_pick" ? action.augmentId : null,
            )
          ) {
            return true;
          }
        } catch (syncError) {
          if (session !== roomSessionRef.current || roomRef.current?.code !== current.code) return false;
          if (syncError instanceof RequestError && [401, 404, 410].includes(syncError.status)) {
            setFatalError(ERROR_TEXT[syncError.code] ?? "这个房间已经不可用。");
            removeLocalValue(roomTokenKey(current.code));
            setToken(null);
            clearRoom();
          } else {
            setConnection("offline");
          }
        }
        if (session === roomSessionRef.current && roomRef.current?.code === current.code) {
          showToast(ERROR_TEXT.VERSION_CONFLICT);
        }
      } else if (error instanceof RequestError && [401, 404, 410].includes(error.status)) {
        setFatalError(ERROR_TEXT[error.code] ?? "这个房间已经不可用。");
        removeLocalValue(roomTokenKey(current.code));
        setToken(null);
        clearRoom();
      } else {
        const errorCode = error instanceof RequestError ? error.code : "ACTION_FAILED";
        showToast(ERROR_TEXT[errorCode] ?? ERROR_TEXT.ACTION_FAILED);
        setConnection(error instanceof RequestError ? "live" : "offline");
      }
      return false;
    } finally {
      if (session === roomSessionRef.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  const activeSetupDraft =
    room &&
    setupSide &&
    setupDraftState?.roomCode === room.code &&
    setupDraftState.side === setupSide
      ? setupDraftState.locations
      : null;
  const selectedOpeningAugment =
    room && setupSide
      ? room.snapshot.augment?.draft.rounds[0]?.players[setupSide].selectedId ?? null
      : null;
  const setupAugmentIds = useMemo(
    () => selectedOpeningAugment ? [selectedOpeningAugment] : [],
    [selectedOpeningAugment],
  );
  const renderPieces = useMemo(() => {
    if (!room) return [];
    if (
      room.snapshot.phase === "playing" &&
      redeployDraft?.roomCode === room.code &&
      redeployDraft.side === room.viewer
    ) {
      return renderRedeployPieces(room.snapshot.pieces, redeployDraft);
    }
    if (!setupSide || room.snapshot.phase !== "setup" || !activeSetupDraft) {
      return room.snapshot.pieces;
    }
    return room.snapshot.pieces.flatMap((piece) => {
      if (piece.side !== setupSide) return [piece];
      const position = activeSetupDraft[piece.id];
      return position ? [{ ...piece, ...position }] : [];
    });
  }, [activeSetupDraft, redeployDraft, room, setupSide]);
  const replayFrames = useMemo(
    () => buildReplayFrames(room?.snapshot.replay ?? null),
    [room?.snapshot.replay],
  );
  const replayAnimationMove = replayIndex === null
    ? null
    : replayFrames[Math.min(replayIndex, replayFrames.length - 1)]?.move ?? null;
  const replayAnimationKey = replayAnimationMove
    ? `${replayIndex}:${replayAnimationMove.moveNumber}`
    : null;
  const replayMovementDuration =
    replayAnimationMove?.kind === "exchange" || replayAnimationMove?.result === "move"
      ? MOVEMENT_ANIMATION_MS
      : BATTLE_ANIMATION_MS;

  useEffect(() => {
    let movementTimer: number | null = null;
    let effectTimer: number | null = null;
    const startTimer = window.setTimeout(() => {
      if (replayIndex === null || !replayAnimationKey || reducedMotion) {
        setReplayMovementAnimationIndex(null);
        setReplayEffectAnimationIndex(null);
        return;
      }
      setReplayMovementAnimationIndex(replayIndex);
      setReplayEffectAnimationIndex(replayIndex);
      movementTimer = window.setTimeout(
        () => setReplayMovementAnimationIndex((current) => current === replayIndex ? null : current),
        replayMovementDuration,
      );
      effectTimer = window.setTimeout(
        () => setReplayEffectAnimationIndex((current) => current === replayIndex ? null : current),
        AUGMENT_EFFECT_ANIMATION_MS,
      );
    }, 0);
    return () => {
      window.clearTimeout(startTimer);
      if (movementTimer !== null) window.clearTimeout(movementTimer);
      if (effectTimer !== null) window.clearTimeout(effectTimer);
    };
  }, [reducedMotion, replayAnimationKey, replayIndex, replayMovementDuration]);
  const trayPieces = useMemo(
    () =>
      activeSetupDraft
        ? setupSnapshotPieces.filter((piece) => activeSetupDraft[piece.id] === null)
        : [],
    [activeSetupDraft, setupSnapshotPieces],
  );
  const placedSetupCount = activeSetupDraft
    ? setupSnapshotPieces.filter((piece) => activeSetupDraft[piece.id] !== null).length
    : undefined;
  const selectedPiece = room?.snapshot.pieces.find(
    (piece) => piece.alive && piece.id === selectedPieceId,
  );
  const selectedPosition = (() => {
    if (!selectedPiece || !room) return null;
    if (room.snapshot.phase === "setup" && activeSetupDraft) {
      return activeSetupDraft[selectedPiece.id] ?? null;
    }
    if (room.snapshot.phase === "playing" && redeployDraft?.locations[selectedPiece.id]) {
      return redeployDraft.locations[selectedPiece.id];
    }
    return isInsideBoard(selectedPiece) ? { row: selectedPiece.row, col: selectedPiece.col } : null;
  })();

  const legalTargets = useMemo(() => {
    if (!room || !isPlayer(room.viewer)) return [] as Position[];
    if (room.snapshot.phase === "playing" && activeAugmentId) {
      const effect = getAugmentDefinition(activeAugmentId).effect;
      if (effect.kind === "reconnaissance") {
        return getProjectedAugmentReconTargets(
          room.snapshot,
          room.viewer,
          activeAugmentId,
        );
      }
      if (effect.kind === "multi_move" && !selectedPieceId) {
        return room.snapshot.pieces
          .filter(
            (piece) =>
              piece.alive &&
              piece.side === room.viewer &&
              !getProjectedAugmentMultiMoveViolation(
                room.snapshot,
                room.viewer,
                activeAugmentId,
                piece.id,
              ),
          )
          .map((piece) => ({ row: piece.row, col: piece.col }));
      }
      if (effect.kind === "sacrifice_reconnaissance" && !selectedPieceId) {
        return room.snapshot.pieces
          .filter(
            (piece) =>
              piece.alive &&
              piece.side === room.viewer &&
              !getProjectedAugmentSacrificeViolation(
                room.snapshot,
                room.viewer,
                activeAugmentId,
                piece.id,
              ),
          )
          .map((piece) => ({ row: piece.row, col: piece.col }));
      }
      if (effect.kind === "redeployment" && redeployDraft) {
        return selectedPieceId
          ? redeployTargetPositions(redeployDraft, selectedPieceId)
          : Object.values(redeployDraft.locations);
      }
      if (effect.kind === "exchange" && !selectedPieceId) {
        const targets = effect.mode === "cross_frontline"
          ? room.snapshot.pieces.filter(
              (piece) => piece.alive && piece.side !== room.viewer,
            )
          : room.snapshot.pieces.filter(
              (piece) => piece.alive && piece.side === room.viewer,
            );
        return room.snapshot.pieces
          .filter(
            (piece) =>
              piece.alive &&
              piece.side === room.viewer &&
              targets.some(
                (target) =>
                  target.id !== piece.id &&
                  !getProjectedAugmentExchangeViolation(
                    room.snapshot,
                    room.viewer as Side,
                    activeAugmentId,
                    piece,
                    target,
                  ),
              ),
          )
          .map((piece) => ({ row: piece.row, col: piece.col }));
      }
      if (!selectedPieceId || !selectedPosition) return [] as Position[];
      if (effect.kind === "movement") {
        return getProjectedAugmentLegalTargets(
          room.snapshot,
          room.viewer,
          activeAugmentId,
          selectedPosition,
        );
      }
      if (effect.kind === "exchange") {
        const targetSide = effect.mode === "cross_frontline"
          ? otherSide(room.viewer)
          : room.viewer;
        return room.snapshot.pieces
          .filter((piece) => piece.alive && piece.side === targetSide && piece.id !== selectedPieceId)
          .filter((piece) => !getProjectedAugmentExchangeViolation(
            room.snapshot,
            room.viewer as Side,
            activeAugmentId,
            selectedPosition,
            piece,
          ))
          .map((piece) => ({ row: piece.row, col: piece.col }));
      }
    }
    if (!selectedPieceId) return [] as Position[];
    if (room.snapshot.phase === "playing" && selectedPosition) {
      return getProjectedLegalTargets(room.snapshot, room.viewer, selectedPosition);
    }
    if (room.snapshot.phase === "setup" && !room.snapshot.ready[room.viewer] && activeSetupDraft) {
      return setupSlots(room.viewer).filter(
        (position) =>
          !getSetupDraftPlacementViolation(
            room.snapshot.pieces,
            room.viewer as Side,
            activeSetupDraft,
            selectedPieceId,
            position,
            setupAugmentIds,
          ),
      );
    }
    return [] as Position[];
  }, [activeAugmentId, activeSetupDraft, redeployDraft, room, selectedPieceId, selectedPosition, setupAugmentIds]);

  const targetKeys = useMemo(() => new Set(legalTargets.map(positionKey)), [legalTargets]);

  function placeSetupPiece(pieceId: string, position: Position) {
    if (!room || !setupSide || !activeSetupDraft || busy) return;
    if (room.snapshot.ready[setupSide]) {
      showToast(ERROR_TEXT.LAYOUT_LOCKED);
      return;
    }
    const violation = getSetupDraftPlacementViolation(
      room.snapshot.pieces,
      setupSide,
      activeSetupDraft,
      pieceId,
      position,
      setupAugmentIds,
    );
    if (violation) {
      showToast(ERROR_TEXT[violation] ?? ERROR_TEXT.INVALID_LAYOUT);
      return;
    }
    const locations = applySetupDraftPlacement(
      room.snapshot.pieces,
      setupSide,
      activeSetupDraft,
      pieceId,
      position,
      setupAugmentIds,
    );
    setSetupDraftState({ roomCode: room.code, side: setupSide, locations });
    setSelectedPieceId(null);
  }

  function movePlayingPiece(pieceId: string, position: Position) {
    if (!room || !isPlayer(room.viewer) || room.snapshot.phase !== "playing") return;
    if (room.snapshot.turn !== room.viewer) {
      showToast(ERROR_TEXT.NOT_YOUR_TURN);
      return;
    }
    if (redeployDraft?.roomCode === room.code && redeployDraft.side === room.viewer) {
      const nextDraft = swapRedeployPieces(redeployDraft, pieceId, position);
      if (!nextDraft) showToast("暗度陈仓只能交换编辑范围内的两枚己子。");
      else {
        setRedeployDraft(nextDraft);
        setSelectedPieceId(null);
      }
      return;
    }
    const piece = room.snapshot.pieces.find(
      (candidate) => candidate.alive && candidate.id === pieceId && candidate.side === room.viewer,
    );
    if (!piece || !isInsideBoard(piece)) {
      showToast(ERROR_TEXT.NO_PIECE_AT_SOURCE);
      return;
    }
    const from = { row: piece.row, col: piece.col };
    if (activeAugmentId) {
      const effect = getAugmentDefinition(activeAugmentId).effect;
      if (effect.kind === "movement") {
        const violation = getProjectedAugmentMoveViolation(
          room.snapshot,
          room.viewer,
          activeAugmentId,
          from,
          position,
        );
        if (violation) showToast(ERROR_TEXT[violation] ?? "这个军令不能这样使用。");
        else void performAction({ type: "augment_move", augmentId: activeAugmentId, from, to: position });
        return;
      }
    }
    const violation = getProjectedMoveViolation(room.snapshot, room.viewer, from, position);
    if (violation) showToast(ERROR_TEXT[violation] ?? ERROR_TEXT.ACTION_FAILED);
    else void performAction({ type: "move", from, to: position });
  }

  function selectPlayingPiece(pieceId: string, position: Position) {
    if (!room || !isPlayer(room.viewer) || room.snapshot.phase !== "playing") return false;
    if (room.snapshot.turn !== room.viewer) {
      showToast(ERROR_TEXT.NOT_YOUR_TURN);
      return false;
    }
    const piece = room.snapshot.pieces.find(
      (candidate) => candidate.alive && candidate.id === pieceId && candidate.side === room.viewer,
    );
    if (!piece) {
      showToast(ERROR_TEXT.NOT_YOUR_PIECE);
      return false;
    }
    const requiredPieceId = room.snapshot.augment?.multiMove?.pieceId ?? null;
    if (requiredPieceId && requiredPieceId !== piece.id) {
      showToast("本次追加行动必须继续使用刚才那枚棋子。");
      return false;
    }
    if (piece.type === "flag") {
      showToast(ERROR_TEXT.FLAG_CANNOT_MOVE);
      return false;
    }
    if (piece.type === "mine") {
      showToast(ERROR_TEXT.MINE_CANNOT_MOVE);
      return false;
    }
    if (isHeadquarters(position)) {
      showToast(ERROR_TEXT.HEADQUARTERS_LOCKED);
      return false;
    }
    setSelectedPieceId(piece.id);
    return true;
  }

  function beginTrayPieceDrag(pieceId: string) {
    dragDroppedRef.current = false;
    if (!room || !setupSide || !activeSetupDraft || room.snapshot.phase !== "setup") return false;
    if (room.snapshot.ready[setupSide]) {
      showToast(ERROR_TEXT.LAYOUT_LOCKED);
      return false;
    }
    if (activeSetupDraft[pieceId] !== null) {
      showToast(ERROR_TEXT.PIECE_NOT_AVAILABLE);
      return false;
    }
    setSelectedPieceId(pieceId);
    return true;
  }

  function beginBoardPieceDrag(pieceId: string, position: Position) {
    dragDroppedRef.current = false;
    if (!room || !isPlayer(room.viewer) || movementAnimation || augmentEffectAnimations.length) return false;
    if (activeAugmentId) {
      const effect = getAugmentDefinition(activeAugmentId).effect;
      if (effect.kind === "redeployment" && redeployDraft) {
        if (!redeployDraft.locations[pieceId]) {
          showToast("只能调整己方半场内的存活非军旗棋子。");
          return false;
        }
        setSelectedPieceId(pieceId);
        return true;
      }
      if (
        effect.kind === "exchange" ||
        effect.kind === "reconnaissance" ||
        effect.kind === "sacrifice_reconnaissance" ||
        effect.kind === "multi_move"
      ) return false;
    }
    if (room.snapshot.phase === "setup") {
      if (room.snapshot.ready[room.viewer]) {
        showToast(ERROR_TEXT.LAYOUT_LOCKED);
        return false;
      }
      const draftPosition = activeSetupDraft?.[pieceId];
      if (!draftPosition || !samePosition(draftPosition, position)) {
        showToast(ERROR_TEXT.PIECE_NOT_AVAILABLE);
        return false;
      }
      setSelectedPieceId(pieceId);
      return true;
    }
    return selectPlayingPiece(pieceId, position);
  }

  function handleCell(position: Position) {
    if (Date.now() < suppressClickUntilRef.current) return;
    if (!room || busy || movementAnimation || augmentEffectAnimations.length || !isPlayer(room.viewer)) return;
    const piece = renderPieces.find((candidate) => candidate.alive && samePosition(candidate, position));
    if (room.snapshot.phase === "setup") {
      if (room.snapshot.ready[room.viewer]) {
        showToast(ERROR_TEXT.LAYOUT_LOCKED);
        return;
      }
      if (!selectedPieceId) {
        if (isCamp(position)) showToast(ERROR_TEXT.CAMP_MUST_BE_EMPTY);
        else if (piece?.side === room.viewer) setSelectedPieceId(piece.id);
        else showToast(ERROR_TEXT.NO_PIECE_AT_SOURCE);
        return;
      }
      if (piece?.id === selectedPieceId) {
        setSelectedPieceId(null);
        return;
      }
      placeSetupPiece(selectedPieceId, position);
      return;
    }
    if (room.snapshot.phase === "finished") {
      showToast(ERROR_TEXT.GAME_FINISHED);
      return;
    }
    if (room.snapshot.phase !== "playing") {
      showToast(ERROR_TEXT.GAME_NOT_STARTED);
      return;
    }
    if (activeAugmentId) {
      const effect = getAugmentDefinition(activeAugmentId).effect;
      if (effect.kind === "reconnaissance") {
        if (!piece || piece.side === room.viewer || !targetKeys.has(positionKey(position))) {
          showToast("请选择一枚尚未侦察的敌方棋子。");
        } else {
          void performAction({ type: "augment_recon", augmentId: activeAugmentId, target: position });
        }
        return;
      }
    }
    if (room.snapshot.turn !== room.viewer) {
      showToast(ERROR_TEXT.NOT_YOUR_TURN);
      return;
    }
    const activeEffect = activeAugmentId
      ? getAugmentDefinition(activeAugmentId).effect
      : null;
    if (activeAugmentId && activeEffect?.kind === "redeployment") {
      if (!redeployDraft) {
        showToast("换阵编辑已经失效，请重新发动军令。");
        setActiveAugmentId(null);
        return;
      }
      if (!piece || piece.side !== room.viewer || !redeployDraft.locations[piece.id]) {
        showToast("只能调整己方半场内的存活非军旗棋子。");
        return;
      }
      if (!selectedPieceId) {
        setSelectedPieceId(piece.id);
        return;
      }
      if (piece.id === selectedPieceId) {
        setSelectedPieceId(null);
        return;
      }
      const nextDraft = swapRedeployPieces(redeployDraft, selectedPieceId, position);
      if (!nextDraft) showToast("请选择换阵范围内的另一枚己子。");
      else {
        setRedeployDraft(nextDraft);
        setSelectedPieceId(null);
      }
      return;
    }
    if (activeAugmentId && activeEffect?.kind === "sacrifice_reconnaissance") {
      if (!piece || piece.side !== room.viewer) {
        showToast("请选择一枚己方非军旗棋子作为祭品。");
        return;
      }
      const violation = getProjectedAugmentSacrificeViolation(
        room.snapshot,
        room.viewer,
        activeAugmentId,
        piece.id,
      );
      if (violation) showToast(ERROR_TEXT[violation] ?? "这枚棋子不能作为祭品。");
      else {
        setSacrificeCandidateId(piece.id);
        setSelectedPieceId(piece.id);
      }
      return;
    }
    if (activeAugmentId && activeEffect?.kind === "multi_move") {
      if (!piece || piece.side !== room.viewer) {
        showToast("请选择一枚可移动的己方非工兵棋子。");
        return;
      }
      const violation = getProjectedAugmentMultiMoveViolation(
        room.snapshot,
        room.viewer,
        activeAugmentId,
        piece.id,
      );
      if (violation) showToast(ERROR_TEXT[violation] ?? "这枚棋子不能发动出其不意。");
      else void performAction({
        type: "augment_begin_multi_move",
        augmentId: activeAugmentId,
        pieceId: piece.id,
      });
      return;
    }
    if (activeAugmentId && activeEffect?.kind === "exchange") {
      const crossFrontline = activeEffect.mode === "cross_frontline";
      const fromPiece = selectedPieceId
        ? room.snapshot.pieces.find((candidate) => candidate.id === selectedPieceId)
        : null;
      if (!fromPiece) {
        if (!piece || piece.side !== room.viewer) {
          showToast(crossFrontline
            ? "先选择己方前三排的一枚非军旗棋子。"
            : "先选择一枚可换防的己方棋子。");
          return;
        }
        const possibleTargets = room.snapshot.pieces.filter(
          (candidate) =>
            candidate.alive &&
            candidate.id !== piece.id &&
            candidate.side === (crossFrontline ? otherSide(room.viewer as Side) : room.viewer),
        );
        const hasPair = possibleTargets.some(
          (candidate) => !getProjectedAugmentExchangeViolation(
            room.snapshot,
            room.viewer as Side,
            activeAugmentId,
            piece,
            candidate,
          ),
        );
        if (!hasPair) showToast("这枚棋子当前没有可交换的目标。");
        else setSelectedPieceId(piece.id);
        return;
      }
      if (!piece) {
        showToast(crossFrontline
          ? "第二步请选择敌方前三排任意一枚存活棋子（包括军旗）。"
          : "第二步请选择另一枚己方棋子。");
        return;
      }
      if (piece.id === selectedPieceId) {
        setSelectedPieceId(null);
        return;
      }
      if (piece.side === room.viewer && crossFrontline) {
        setSelectedPieceId(null);
        const possibleTargets = room.snapshot.pieces.filter(
          (candidate) => candidate.alive && candidate.side !== room.viewer,
        );
        const hasPair = possibleTargets.some(
          (candidate) => !getProjectedAugmentExchangeViolation(
            room.snapshot,
            room.viewer as Side,
            activeAugmentId,
            piece,
            candidate,
          ),
        );
        if (!hasPair) showToast("这枚棋子当前没有可交换的敌方目标。");
        else setSelectedPieceId(piece.id);
        return;
      }
      const violation = getProjectedAugmentExchangeViolation(
        room.snapshot,
        room.viewer,
        activeAugmentId,
        fromPiece,
        piece,
      );
      if (violation) showToast(ERROR_TEXT[violation] ?? "这两枚棋子不能执行交换。");
      else void performAction({
        type: "augment_exchange",
        augmentId: activeAugmentId,
        from: { row: fromPiece.row, col: fromPiece.col },
        to: { row: piece.row, col: piece.col },
      });
      return;
    }
    if (piece?.side === room.viewer) {
      if (piece.id === selectedPieceId) {
        setSelectedPieceId(null);
      } else {
        selectPlayingPiece(piece.id, position);
      }
      return;
    }
    if (!selectedPieceId) {
      showToast(ERROR_TEXT.NO_PIECE_AT_SOURCE);
      return;
    }
    movePlayingPiece(selectedPieceId, position);
  }

  function handlePieceDrop(pieceId: string, position: Position) {
    dragDroppedRef.current = true;
    suppressClickUntilRef.current = Date.now() + 350;
    if (!room || movementAnimation || augmentEffectAnimations.length || !isPlayer(room.viewer)) return;
    const origin =
      room.snapshot.phase === "setup"
        ? activeSetupDraft?.[pieceId]
        : redeployDraft?.locations[pieceId] ??
          room.snapshot.pieces.find((piece) => piece.alive && piece.id === pieceId);
    if (origin && samePosition(origin, position)) {
      setSelectedPieceId(null);
      return;
    }
    if (room.snapshot.phase === "setup") placeSetupPiece(pieceId, position);
    else if (room.snapshot.phase === "playing") movePlayingPiece(pieceId, position);
  }

  function handlePieceDragEnd() {
    if (!dragDroppedRef.current) setSelectedPieceId(null);
    dragDroppedRef.current = false;
  }

  function randomizeLocalSetup() {
    if (!room || !setupSide || !activeSetupDraft || busy) return;
    if (room.snapshot.ready[setupSide]) {
      showToast(ERROR_TEXT.LAYOUT_LOCKED);
      return;
    }
    const locations = randomizeSetupDraft(room.snapshot.pieces, setupSide, setupAugmentIds);
    setSetupDraftState({ roomCode: room.code, side: setupSide, locations });
    setSelectedPieceId(null);
  }

  function toggleSetupReady() {
    if (!room || !setupSide || !activeSetupDraft || busy) return;
    if (room.snapshot.ready[setupSide]) {
      void performAction({ type: "ready", value: false });
      return;
    }
    if (!isValidSetupDraft(room.snapshot.pieces, setupSide, activeSetupDraft, true, setupAugmentIds)) {
      showToast(
        placedSetupCount !== undefined && placedSetupCount < 25
          ? `还需放置 ${25 - placedSetupCount} 枚棋子。`
          : ERROR_TEXT.INVALID_LAYOUT,
      );
      return;
    }
    const layout = setupDraftToLayout(room.snapshot.pieces, setupSide, activeSetupDraft, setupAugmentIds);
    void performAction({ type: "ready", value: true, layout });
  }

  function cancelActiveAugment() {
    setActiveAugmentId(null);
    setSelectedPieceId(null);
    setRedeployDraft(null);
    setSacrificeCandidateId(null);
  }

  function confirmRedeploy() {
    if (!room || !isPlayer(room.viewer) || !redeployDraft || busy) return;
    const placements = redeployPlacements(redeployDraft);
    const violation = getProjectedAugmentRedeployViolation(
      room.snapshot,
      room.viewer,
      redeployDraft.augmentId,
      placements,
    );
    if (violation) {
      showToast(ERROR_TEXT[violation] ?? "至少交换两枚棋子后才能完成换阵。");
      return;
    }
    void performAction({
      type: "augment_redeploy",
      augmentId: redeployDraft.augmentId,
      placements,
    });
  }

  function confirmSacrifice() {
    if (
      !room ||
      !isPlayer(room.viewer) ||
      !activeAugmentId ||
      !sacrificeCandidateId ||
      busy
    ) return;
    const effect = getAugmentDefinition(activeAugmentId).effect;
    if (effect.kind !== "sacrifice_reconnaissance") return;
    const violation = getProjectedAugmentSacrificeViolation(
      room.snapshot,
      room.viewer,
      activeAugmentId,
      sacrificeCandidateId,
    );
    if (violation) {
      showToast(ERROR_TEXT[violation] ?? "这枚棋子已经不能作为祭品。");
      return;
    }
    void performAction({
      type: "augment_sacrifice",
      augmentId: activeAugmentId,
      pieceId: sacrificeCandidateId,
    });
  }

  function activateAugment(augmentId: AugmentId) {
    if (!room || !isPlayer(room.viewer)) return;
    const augment = getAugmentDefinition(augmentId);
    const effect = augment.effect;
    const pendingReconId = room.snapshot.augment?.pendingRecon?.augmentId ?? null;
    if (!canInteractWithAugment(augment, {
      enabled: room.snapshot.phase === "playing",
      isOwnTurn: room.snapshot.turn === room.viewer,
      pendingReconId,
    })) {
      if (augment.activation !== "active") {
        showToast("这张军令会在满足条件时自动生效。");
      } else if (effect.kind === "reconnaissance") {
        showToast("这张侦察牌尚未进入选取目标阶段。");
      } else {
        showToast("轮到你行动时才能发动这张军令。");
      }
      return;
    }
    if (
      effect.kind !== "movement" &&
      effect.kind !== "exchange" &&
      effect.kind !== "multi_move" &&
      effect.kind !== "redeployment" &&
      effect.kind !== "sacrifice_reconnaissance" &&
      !(effect.kind === "reconnaissance" && effect.mode === "choose_enemy")
    ) {
      showToast("这张军令会在满足条件时自动生效。");
      return;
    }
    if (!hasProjectedAugmentTarget(room.snapshot, room.viewer, augmentId)) {
      showToast("当前棋面没有可发动的合法目标。");
      return;
    }
    if (activeAugmentId === augmentId) {
      setActiveAugmentId(null);
      setSelectedPieceId(null);
      setRedeployDraft(null);
      setSacrificeCandidateId(null);
      showToast("已取消本次军令选择。");
      return;
    }
    if (effect.kind === "redeployment") {
      const draft = createRedeployDraft(room.code, room.snapshot, room.viewer, augmentId);
      if (!draft) {
        showToast("己方半场内至少需要两枚可换位的非军旗棋子。");
        return;
      }
      setRedeployDraft(draft);
    } else {
      setRedeployDraft(null);
    }
    setSacrificeCandidateId(null);
    setSelectedPieceId(null);
    setActiveAugmentId(augmentId);
    if (effect.kind === "reconnaissance") showToast("请在棋盘上选择一枚未知敌子。");
    else if (effect.kind === "exchange" && effect.mode === "cross_frontline") {
      showToast("先选己方前三排的非军旗棋子，再选敌方前三排任意存活棋子；交换不会额外公开身份。");
    } else if (effect.kind === "exchange") showToast("依次选择两枚可换防的己方棋子。");
    else if (effect.kind === "multi_move") showToast("请选择一枚可移动的己方非工兵棋子。");
    else if (effect.kind === "redeployment") showToast("在棋盘上两两换位，确认后才会提交。");
    else if (effect.kind === "sacrifice_reconnaissance") showToast("选择一枚己方非军旗棋子，再确认弃子。");
    else showToast("先选择己方棋子，再选择高亮目标。");
  }

  function requestResign() {
    if (!room || !isPlayer(room.viewer) || !["playing", "augment_draft"].includes(room.snapshot.phase)) return;
    if (window.confirm("确定认输并结束本局吗？")) void performAction({ type: "resign" });
  }

  async function cancelRankedSetup() {
    const current = roomRef.current;
    if (
      !current ||
      current.roomKind !== "ranked" ||
      current.snapshot.phase !== "setup" ||
      !isPlayer(current.viewer) ||
      busyRef.current
    ) return;
    if (!window.confirm("取消本次排位吗？开局前取消不会改变段位分。")) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const response = await fetch(`/api/rooms/${current.code}`, { method: "DELETE" });
      const payload = (await parseResponse(response)) as MatchmakingEnvelope;
      clearRoom();
      setMatchmaking(payload);
      setFatalError(null);
      setToken(null);
      setInviteToken(null);
      window.history.replaceState(null, "", "/");
      showToast("本次排位已取消，积分不变。");
      void refreshAccountAndFriends().catch(() => undefined);
    } catch (error) {
      showToast(
        error instanceof RequestError
          ? ERROR_TEXT[error.code] ?? "取消排位失败，请重试。"
          : "取消排位失败，请重试。",
      );
    } finally {
      if (roomRef.current?.code === current.code) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  async function copyLink(kind: "player" | "spectator") {
    if (!room) return;
    const base = `${window.location.origin}/?room=${room.code}`;
    const link = kind === "player" && inviteToken ? `${base}#invite=${inviteToken}` : `${base}&watch=1`;
    try {
      await navigator.clipboard.writeText(link);
      showToast(kind === "player"
        ? "玩家邀请已复制"
        : `${room.spectatorPolicy === "full" ? "明牌" : "安全"}观战链接已复制`);
    } catch {
      showToast("复制失败，请允许剪贴板权限后重试。");
    }
  }

  function leaveRoom() {
    clearRoom();
    setFatalError(null);
    setToken(null);
    setInviteToken(null);
    window.history.replaceState(null, "", "/");
  }

  if (loading) {
    return (
      <main className="loading-screen" aria-busy="true">
        <span className="loading-mark" aria-hidden="true">令</span>
        <p role="status" aria-live="polite">正在展开棋盘</p>
      </main>
    );
  }

  if (!room) {
    if (!user) {
      return (
        <>
          <SignInLanding signInPath={signInPath} />
          {fatalError ? <div className="toast error-toast" role="alert" aria-live="assertive">{fatalError}</div> : null}
          {toast ? <div className="toast" role="status" aria-live="polite">{toast}</div> : null}
        </>
      );
    }
    return (
      <>
        <LobbyExperience
          user={user}
          signOutPath={signOutPath}
          account={account}
          recentMatches={recentMatches}
          friends={friends}
          matchmaking={matchmaking}
          watchingMatchId={watchingMatchId}
          onCreate={createRoom}
          creating={creating}
          onOpen={openRoom}
          onMatchmaking={startMatchmaking}
          onCancelMatchmaking={cancelMatchmaking}
          onFriendRequest={requestFriend}
          onAcceptFriend={acceptFriend}
          onWatchFriend={watchFriendMatch}
          onUpdateHandle={updateHandle}
          skipEntryGate={hasRoom}
        />
        {fatalError ? <div className="toast error-toast" role="alert" aria-live="assertive">{fatalError}</div> : null}
        {toast ? <div className="toast" role="status" aria-live="polite">{toast}</div> : null}
      </>
    );
  }

  const game = room.snapshot;
  const viewerSide = isPlayer(room.viewer) ? room.viewer : null;
  const orientationFlipped = viewerSide === "white" ? !flipped : flipped;
  const activeReplayFrame =
    replayIndex === null ? null : replayFrames[Math.min(replayIndex, replayFrames.length - 1)] ?? null;
  const replayMoveEvent: PublicEvent | undefined = activeReplayFrame?.move
    ? {
        id: activeReplayFrame.move.moveNumber,
        actor: activeReplayFrame.move.actor,
        from: activeReplayFrame.move.from,
        to: activeReplayFrame.move.to,
        result: activeReplayFrame.move.result,
        kind: activeReplayFrame.move.kind,
        augmentId: activeReplayFrame.move.augmentId,
        augmentIds: activeReplayFrame.move.augmentIds,
        secondaryFrom: activeReplayFrame.move.secondaryFrom,
        secondaryTo: activeReplayFrame.move.secondaryTo,
        secondaryActor: activeReplayFrame.move.secondaryActor,
        relocations: activeReplayFrame.move.relocations,
        pieceIds: activeReplayFrame.move.pieceChanges?.map((change) => change.pieceId),
        positions: activeReplayFrame.move.pieceChanges?.map(
          (change) => ({ row: change.row, col: change.col }),
        ),
      }
    : undefined;
  const replayEffectEvents: PublicEvent[] = (activeReplayFrame?.move?.effects ?? []).map(
    (effect, index) => ({
      id: activeReplayFrame!.move!.moveNumber * 100 + index + 1,
      actor: effect.actor,
      result: effect.result,
      kind: "effect",
      ...(effect.augmentId ? { augmentId: effect.augmentId } : {}),
      pieceIds: [...effect.pieceIds],
      positions: effect.positions.map((position) => ({ ...position })),
    }),
  );
  const replayPreviousFrame = activeReplayFrame && replayIndex !== null && replayIndex > 0
    ? replayFrames[replayIndex - 1] ?? null
    : null;
  const replayMovementAnimation =
    activeReplayFrame?.move &&
    replayMoveEvent &&
    replayPreviousFrame &&
    replayMovementAnimationIndex === replayIndex &&
    activeReplayFrame.move.kind !== "redeploy" &&
    activeReplayFrame.move.kind !== "sacrifice" &&
    activeReplayFrame.move.kind !== "effect" &&
    !reduceMotionRef.current
      ? movementAnimationForTransition(
          {
            ...game,
            phase: "playing",
            turn: activeReplayFrame.move.actor,
            pieces: replayPreviousFrame.pieces,
            events: [],
            moveNumber: Math.max(0, activeReplayFrame.move.moveNumber - 1),
          },
          {
            ...game,
            phase: "playing",
            turn: activeReplayFrame.move.actor,
            pieces: activeReplayFrame.pieces,
            events: [replayMoveEvent],
            moveNumber: activeReplayFrame.move.moveNumber,
          },
        )
      : null;
  const replayEffectAnimations: AugmentBoardEffectAnimation[] = (() => {
    if (
      !activeReplayFrame?.move ||
      !replayMoveEvent ||
      !replayPreviousFrame ||
      replayEffectAnimationIndex !== replayIndex ||
      reduceMotionRef.current
    ) return [];
    return augmentBoardEffectsForReplayTransition(
      replayPreviousFrame.pieces,
      activeReplayFrame.pieces,
      activeReplayFrame.move,
      animatedPieceIds(replayMovementAnimation),
    );
  })();
  const latestOpponentMove = latestOpponentMovementEvent(game.events, room.viewer);
  const highlightedMove = activeReplayFrame ? replayMoveEvent : latestOpponentMove;
  const displayedPieces = activeReplayFrame?.pieces ?? renderPieces;
  const liveMovementAnimation = activeReplayFrame ? replayMovementAnimation : movementAnimation;
  const displayedGame = activeReplayFrame
    ? { ...game, pieces: activeReplayFrame.pieces, events: replayMoveEvent ? [replayMoveEvent] : [] }
    : game;
  const liveAnimatedPieceIds = new Set(animatedPieceIds(liveMovementAnimation));
  const capturedOwnPieces = viewerSide && game.phase !== "setup"
    ? displayedPieces.filter(
        (piece) =>
          piece.side === viewerSide &&
          !piece.alive &&
          !liveAnimatedPieceIds.has(piece.id),
      )
    : [];
  const replayHasGap = Boolean(
    game.replay && replayFrames.length !== game.replay.moves.length + 1,
  );
  const replayIsPartial = Boolean(game.replay?.partial || replayHasGap);
  const topSide: Side = orientationFlipped ? "black" : "white";
  const bottomSide: Side = topSide === "black" ? "white" : "black";
  const displayedClockRemaining = (side: Side) => {
    if (!game.clock) return null;
    const elapsed =
      game.phase === "playing" && game.clock.running === side
        ? Math.max(0, clockTick - clockAnchor)
        : 0;
    return Math.max(0, game.clock.remainingMs[side] - elapsed);
  };
  const playerClock = (side: Side) => {
    const remaining = displayedClockRemaining(side);
    if (remaining === null) {
      return <span className="player-clock is-untimed" aria-label={`${sideName(side)}不限时`}>不限时</span>;
    }
    const low = game.phase === "playing" && game.clock?.running === side && remaining <= 60_000;
    const text = formatClock(remaining);
    return (
      <time
        className={`player-clock ${low ? "is-low" : ""} ${remaining <= 0 ? "is-expired" : ""}`}
        aria-label={`${sideName(side)}剩余用时 ${text}`}
      >
        {text}
      </time>
    );
  };
  const timeControlMinutes = game.clock ? Math.round(game.clock.initialMs / 60_000) : null;
  const timeControlLocked = game.ready.black || game.ready.white || Boolean(game.clock?.incrementMs);
  const aliveCount = (side: Side) => game.pieces.filter((piece) => piece.alive && piece.side === side).length;
  const replayAliveCount = (side: Side) =>
    displayedPieces.filter((piece) => piece.alive && piece.side === side).length;
  const visiblePieceCount = (side: Side) =>
    game.phase === "setup" && viewerSide === side && placedSetupCount !== undefined
      ? placedSetupCount
      : aliveCount(side);
  const boardPieceCount = (side: Side) => activeReplayFrame ? replayAliveCount(side) : visiblePieceCount(side);
  const seatState = (side: Side) => {
    if (game.phase === "setup") return game.ready[side] ? "已锁定" : game.joined[side] ? "布阵中" : "未进入";
    if (game.phase === "augment_draft") {
      const draft = game.augment?.draft.rounds.find((round) => round.number === game.augment?.draft.activeRound);
      return draft?.players[side].locked ? "已选令" : "选令中";
    }
    if (game.phase === "finished") return !game.winner ? "和棋" : game.winner === side ? "获胜" : "落败";
    return game.turn === side ? "行动" : "等待";
  };
  const lastEvents = [...game.events].reverse().slice(0, 6);
  const battleReportEvents = activeReplayFrame
    ? [replayMoveEvent, ...replayEffectEvents].filter(
        (event): event is PublicEvent => Boolean(event),
      )
    : lastEvents;
  const activeDraftRound = game.augment?.draft.activeRound
    ? game.augment.draft.rounds.find((round) => round.number === game.augment?.draft.activeRound) ?? null
    : null;
  const viewerDraft = viewerSide && activeDraftRound ? activeDraftRound.players[viewerSide] : null;
  const opponentDraft = viewerSide && activeDraftRound
    ? activeDraftRound.players[viewerSide === "black" ? "white" : "black"]
    : null;
  const draftOptions = viewerDraft?.options?.map(getAugmentDefinition) ?? [];
  const showAugmentDraft = Boolean(
    viewerSide &&
      activeDraftRound &&
      viewerDraft?.options &&
      (!viewerDraft.locked || game.phase === "augment_draft"),
  );
  const liveDraftPresentation = showAugmentDraft && activeDraftRound && viewerDraft?.options
    ? {
        round: activeDraftRound.number,
        options: draftOptions,
        selectedId: viewerDraft.selectedId,
        locked: viewerDraft.locked,
        opponentLocked: opponentDraft?.locked ?? false,
        refreshUsed: viewerDraft.refreshed,
        seenCount: game.augment?.draft.seenIds?.length ?? 0,
        deadlineAt: game.augment?.draftDeadlineAt ?? null,
      }
    : null;
  const heldDraftPresentation = augmentDraftVisualHold?.roomCode === room.code
    ? {
        round: augmentDraftVisualHold.round,
        options: augmentDraftVisualHold.options,
        selectedId: augmentDraftVisualHold.selectedId,
        locked: true,
        opponentLocked: augmentDraftVisualHold.opponentLocked,
        refreshUsed: augmentDraftVisualHold.refreshUsed,
        seenCount: augmentDraftVisualHold.seenCount,
        deadlineAt: augmentDraftVisualHold.deadlineAt,
      }
    : null;
  const draftPresentation = liveDraftPresentation ?? heldDraftPresentation;
  const augmentRailItems = (side: Side) =>
    (game.augment?.draft.loadouts[side] ?? []).map((id) => ({
      augment: getAugmentDefinition(id),
      triggerCount: game.augment?.triggerCounts[side][id] ?? 0,
      publiclyRevealed: game.augment?.draft.rounds.some(
        (round) => round.revealed && round.players[side].selectedId === id,
      ) ?? false,
      hasLegalTarget: side === viewerSide && game.phase === "playing" && game.turn === side
        ? hasProjectedAugmentTarget(game, side, id)
        : undefined,
    }));
  const primaryRailSide: Side = viewerSide ?? "black";
  const secondaryRailSide: Side = otherSide(primaryRailSide);
  const canPassExtraMove = Boolean(
    viewerSide &&
      game.phase === "playing" &&
      game.turn === viewerSide &&
      (game.augment?.extraMove || game.augment?.multiMove?.canPass),
  );
  const pendingMultiMove = viewerSide && game.phase === "playing" && game.turn === viewerSide
    ? game.augment?.multiMove ?? null
    : null;
  const activeEffect = activeAugmentId
    ? getAugmentDefinition(activeAugmentId).effect
    : null;
  const redeployChangeCount = redeployDraft ? redeployChangedCount(redeployDraft) : 0;
  const sacrificeCandidate = sacrificeCandidateId
    ? game.pieces.find((piece) => piece.id === sacrificeCandidateId) ?? null
    : null;
  const boardInteractionLabel = activeEffect?.kind === "exchange"
    ? activeEffect.mode === "cross_frontline" && !selectedPieceId
      ? "可选己方前线棋子"
      : "可交换"
    : activeEffect?.kind === "redeployment"
      ? selectedPieceId ? "可换位" : "可选换阵棋子"
      : activeEffect?.kind === "multi_move"
        ? "可发动连续移动"
        : activeEffect?.kind === "sacrifice_reconnaissance"
          ? "可选为祭品"
          : activeEffect?.kind === "reconnaissance"
            ? "可侦察"
            : null;
  const showRepetitionWarning = Boolean(
    game.mode === "augment" &&
      game.phase !== "finished" &&
      game.repetition?.active &&
      game.repetition.currentOccurrences === 2,
  );

  return (
    <main className="room-page">
      <header className="room-header">
        <button className="wordmark wordmark-button" type="button" onClick={leaveRoom}>
          <span className="wordmark-mark">令</span>
          <span>军令 · 陆战棋</span>
        </button>
        <div className="room-identity">
          <span className="room-code">{displayCode(room.code)}</span>
          <span className={`connection ${connection}`}>{connection === "offline" ? "正在重连" : room.viewer === "spectator" ? room.spectatorPolicy === "full" ? "明牌观战" : "安全观战" : sideName(room.viewer)}</span>
        </div>
        <div className="header-actions">
          {replayFrames.length ? (
            <button
              className={`rules-trigger ${activeReplayFrame ? "is-active" : ""}`}
              type="button"
              onClick={() => {
                setSelectedPieceId(null);
                setMovementAnimation(null);
                const nextReplayIndex = replayIndexRef.current === null ? 0 : null;
                replayIndexRef.current = nextReplayIndex;
                setReplayIndex(nextReplayIndex);
              }}
              aria-pressed={Boolean(activeReplayFrame)}
            >
              {activeReplayFrame ? "实时棋盘" : "复盘"}
            </button>
          ) : null}
          <button
            className="rules-trigger"
            type="button"
            ref={rulesTriggerRef}
            onClick={() => setRulesOpen(true)}
            aria-haspopup="dialog"
            aria-controls="game-rules-dialog"
            aria-expanded={rulesOpen}
            aria-label="查看游戏规则"
          >
            规则
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => {
              setMovementAnimation(null);
              setFlipped((value) => !value);
            }}
            aria-label="旋转棋盘"
          >
            ↻
          </button>
        </div>
      </header>

      {draftPresentation ? (
        <div className="augment-draft-overlay" role="dialog" aria-modal="true" aria-label="军令选择">
          <AugmentDraft
            key={`${room.code}-${draftPresentation.round}`}
            round={draftPresentation.round}
            options={draftPresentation.options}
            selectedId={draftPresentation.selectedId}
            locked={draftPresentation.locked}
            opponentLocked={draftPresentation.opponentLocked}
            refreshUsed={draftPresentation.refreshUsed}
            seenCount={draftPresentation.seenCount}
            deadlineAt={draftPresentation.deadlineAt}
            pending={busy}
            onPick={(augmentId) => {
              if (!liveDraftPresentation) return false;
              setAugmentDraftVisualHold({
                roomCode: room.code,
                round: liveDraftPresentation.round,
                options: liveDraftPresentation.options,
                selectedId: augmentId,
                opponentLocked: liveDraftPresentation.opponentLocked,
                refreshUsed: liveDraftPresentation.refreshUsed,
                seenCount: liveDraftPresentation.seenCount,
                deadlineAt: liveDraftPresentation.deadlineAt,
              });
              return performAction({ type: "augment_pick", augmentId });
            }}
            onRefresh={async (slot: AugmentSlot) => {
              const accepted = await performAction({ type: "augment_refresh", slot });
              if (!accepted) setAugmentDraftVisualHold(null);
              return accepted;
            }}
            onResign={
              game.phase === "augment_draft"
                ? requestResign
                : game.phase === "setup" && room.roomKind === "ranked"
                  ? () => void cancelRankedSetup()
                  : undefined
            }
            resignLabel={game.phase === "setup" ? "取消本次排位（不计分）" : "认输"}
            onMotionComplete={() => {
              setAugmentDraftVisualHold((current) =>
                current?.roomCode === room.code && current.round === draftPresentation.round
                  ? null
                  : current,
              );
            }}
          />
        </div>
      ) : null}

      <section
        className={`game-shell ${game.phase === "setup" ? "is-setup" : ""} ${
          game.phase === "setup" && game.augment && viewerSide ? "has-setup-command-dock" : ""
        }`}
      >
        <aside className="side-panel setup-panel command-panel" aria-label="军令与布阵">
          <h2>{statusText(room, placedSetupCount)}</h2>
          {showRepetitionWarning ? (
            <div className="repetition-notice" role="status" aria-live="polite" aria-label="重复局面第二次出现">
              <span aria-hidden="true">♠</span>
              <div><strong>重复局面</strong><small>再次重复即和棋</small></div>
              <b>2/3</b>
            </div>
          ) : null}
          {game.augment ? (
            <div className="command-rails" aria-label="双方军令牌轨">
              <AugmentRail
                key={`${room.code}-${primaryRailSide}`}
                label={viewerSide ? "我的" : sideName(primaryRailSide)}
                items={augmentRailItems(primaryRailSide)}
                activeId={viewerSide === primaryRailSide ? activeAugmentId : null}
                canActivate={Boolean(viewerSide === primaryRailSide && game.phase === "playing")}
                isOwnTurn={Boolean(viewerSide === primaryRailSide && game.turn === viewerSide)}
                pendingReconId={viewerSide === primaryRailSide
                  ? game.augment.pendingRecon?.augmentId ?? null
                  : null}
                pending={busy}
                dockTarget={Boolean(viewerSide === primaryRailSide)}
                onActivate={viewerSide === primaryRailSide ? activateAugment : undefined}
              />
              <AugmentRail
                key={`${room.code}-${secondaryRailSide}`}
                label={sideName(secondaryRailSide)}
                items={augmentRailItems(secondaryRailSide)}
              />
            </div>
          ) : null}
          {viewerSide && game.phase === "setup" ? (
            <PieceTray
              pieces={trayPieces}
              selectedPieceId={selectedPieceId}
              disabled={busy || game.ready[viewerSide]}
              onSelect={(pieceId) =>
                setSelectedPieceId((current) => (current === pieceId ? null : pieceId))
              }
              onDragStartPiece={beginTrayPieceDrag}
              onDragEnd={handlePieceDragEnd}
            />
          ) : null}
        </aside>

        <section className="board-column">
          <div className={`player-strip ${!activeReplayFrame && game.turn === topSide && game.phase === "playing" ? "active" : ""}`}>
            <span>{sideName(topSide)}</span>{playerClock(topSide)}<span>{boardPieceCount(topSide)} / 25</span>
          </div>
          {highlightedMove?.from && highlightedMove.to ? (
            <p className="last-move-summary">
              <strong>{activeReplayFrame ? "复盘" : room.viewer === "spectator" ? "上一手" : "对手上一步"}</strong>
              <span>
                {highlightedMove.kind === "redeploy"
                  ? `${sideName(highlightedMove.actor)} · 批量换阵 ${highlightedMove.relocations?.length ?? 0} 枚`
                  : highlightedMove.kind === "sacrifice"
                    ? `${sideName(highlightedMove.actor)} · 弃子侦察`
                    : <>
                        {sideName(highlightedMove.actor)} · {boardCoordinate(highlightedMove.from)}
                        {highlightedMove.kind === "exchange" ? " ⇄ " : " → "}
                        {boardCoordinate(highlightedMove.to)}
                      </>}
              </span>
            </p>
          ) : activeReplayFrame ? (
            <p className="last-move-summary"><strong>复盘</strong><span>{replayHasGap ? "回放记录不完整" : replayIsPartial ? `从第 ${activeReplayFrame.moveNumber} 手开始` : "开局阵型"}</span></p>
          ) : null}
          {!activeReplayFrame && (activeAugmentId || canPassExtraMove || pendingMultiMove) ? (
            <div className="board-command-strip" aria-live="polite" aria-label="军令行动控制">
              {redeployDraft ? (
                <>
                  <div>
                    <strong>暗度陈仓 · 换阵编辑</strong>
                    <span>依次点选或拖动两枚棋子换位；已改变 {redeployChangeCount} 枚。</span>
                  </div>
                  <div className="board-command-actions">
                    <button type="button" className="is-secondary" disabled={busy} onClick={cancelActiveAugment}>取消</button>
                    <button type="button" disabled={busy || redeployChangeCount < 2} onClick={confirmRedeploy}>确认换阵</button>
                  </div>
                </>
              ) : activeEffect?.kind === "sacrifice_reconnaissance" ? (
                <>
                  <div>
                    <strong>苦肉计 · 选择祭品</strong>
                    <span>
                      {sacrificeCandidate
                        ? `已选择${sacrificeCandidate.type ? PIECE_INFO[sacrificeCandidate.type].label : "己方棋子"}；确认后不可撤回。`
                        : "选择一枚己方非军旗棋子；敌方前线侦察目标由服务器随机决定。"}
                    </span>
                  </div>
                  <div className="board-command-actions">
                    <button type="button" className="is-secondary" disabled={busy} onClick={cancelActiveAugment}>取消</button>
                    <button type="button" disabled={busy || !sacrificeCandidateId} onClick={confirmSacrifice}>确认弃子</button>
                  </div>
                </>
              ) : activeEffect ? (
                <>
                  <div>
                    <strong>{getAugmentDefinition(activeAugmentId!).name}</strong>
                    <span>
                      {activeEffect.kind === "exchange" && activeEffect.mode === "cross_frontline"
                        ? selectedPieceId
                          ? "第二步：选择敌方前三排任意一枚存活棋子（包括军旗，不额外公开身份）。"
                          : "第一步：选择己方前三排的一枚非军旗棋子。"
                        : activeEffect.kind === "multi_move"
                          ? "选择一枚可移动的己方非工兵棋子，随后连续移动。"
                          : activeEffect.kind === "exchange"
                            ? selectedPieceId ? "再选择另一枚可交换的己方棋子。" : "先选择一枚可交换的己方棋子。"
                            : activeEffect.kind === "reconnaissance"
                              ? "选择一枚高亮的未知敌子。"
                              : "选择己方棋子，再选择高亮目标。"}
                    </span>
                  </div>
                  <div className="board-command-actions">
                    <button type="button" className="is-secondary" disabled={busy} onClick={cancelActiveAugment}>取消</button>
                  </div>
                </>
              ) : canPassExtraMove || pendingMultiMove ? (
                <div className="extra-move-pass" aria-label="追加行动待处理">
                  <div>
                    <strong>
                      {game.augment?.multiMove?.pieceId ? "同棋追加行动" : "追加行动"}
                    </strong>
                    <span>
                      {pendingMultiMove
                        ? pendingMultiMove.canPass
                          ? `还可移动 ${pendingMultiMove.movesRemaining} 次；也可主动交回行动权。`
                          : "已锁定这枚棋子；先完成第一次移动，随后可继续或放弃。"
                        : "局面不利时可主动交回行动权。"}
                    </span>
                  </div>
                  {canPassExtraMove ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void performAction({ type: "pass_extra_move" })}
                    >
                      放弃追加行动
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          <Board
            game={displayedGame}
            pieces={displayedPieces}
            viewer={activeReplayFrame ? "spectator" : room.viewer}
            selected={activeReplayFrame ? null : selectedPosition}
            targets={activeReplayFrame ? new Set<string>() : targetKeys}
            flipped={orientationFlipped}
            busy={busy || Boolean(liveMovementAnimation) || augmentEffectAnimations.length > 0}
            readOnly={Boolean(activeReplayFrame)}
            movementHighlight={highlightedMove}
            movementAnimation={liveMovementAnimation}
            augmentEffectAnimations={activeReplayFrame ? replayEffectAnimations : augmentEffectAnimations}
            interactionLabel={activeReplayFrame ? null : boardInteractionLabel}
            nonCombatTargets={Boolean(activeEffect)}
            onCell={handleCell}
            onPieceDragStart={beginBoardPieceDrag}
            onPieceDrop={handlePieceDrop}
            onPieceDragEnd={handlePieceDragEnd}
          />
          <div className={`player-strip board-player-bottom ${!activeReplayFrame && game.turn === bottomSide && game.phase === "playing" ? "active" : ""}`}>
            <span>{sideName(bottomSide)}</span>{playerClock(bottomSide)}<span>{boardPieceCount(bottomSide)} / 25</span>
          </div>
          {activeReplayFrame ? (
            <div className="replay-controls" aria-label="复盘控制">
              <div className="replay-progress">
                <strong>{replayIsPartial ? "部分复盘" : "明棋复盘"}</strong>
                <span>第 {activeReplayFrame.moveNumber} 手 · {Math.max(0, replayFrames.length - 1)} 手已记录 · {game.clock ? game.phase === "playing" ? "棋钟为实时余时" : "棋钟为终局余时" : "本局不限时"}</span>
              </div>
              <div className="replay-buttons">
                <button type="button" onClick={() => setReplayIndex(0)} disabled={replayIndex === 0}>起点</button>
                <button type="button" onClick={() => setReplayIndex((current) => Math.max(0, (current ?? 0) - 1))} disabled={replayIndex === 0}>上一手</button>
                <button type="button" onClick={() => setReplayIndex((current) => Math.min(replayFrames.length - 1, (current ?? 0) + 1))} disabled={replayIndex === replayFrames.length - 1}>下一手</button>
                <button type="button" onClick={() => setReplayIndex(replayFrames.length - 1)} disabled={replayIndex === replayFrames.length - 1}>末手</button>
                <button
                  type="button"
                  onClick={() => {
                    replayIndexRef.current = null;
                    setReplayIndex(null);
                  }}
                >
                  退出
                </button>
              </div>
            </div>
          ) : null}
        </section>

        <aside className="side-panel setup-panel setup-controls-panel" aria-label="对局状态与操作">
          {game.augment && game.phase !== "setup" ? (
            <AugmentRuleStatusPanel
              game={game}
              side={primaryRailSide}
              ownerLabel={viewerSide ? "我的" : sideName(primaryRailSide)}
            />
          ) : null}
          {game.augment && game.phase !== "setup" ? (
            <AugmentRuleStatusPanel
              game={game}
              side={secondaryRailSide}
              ownerLabel={sideName(secondaryRailSide)}
            />
          ) : null}
          {game.phase === "setup" && timeControlMinutes !== null ? (
            <div className="time-control-card">
              {room.viewer === "black" && room.roomKind !== "ranked" ? (
                <form
                  className="time-control-form"
                  key={`${room.code}-${game.clock?.initialMs}`}
                  onSubmit={(event) => {
                    event.preventDefault();
                    const minutes = Number(new FormData(event.currentTarget).get("minutes"));
                    if (!Number.isInteger(minutes)) {
                      showToast(ERROR_TEXT.INVALID_TIME_CONTROL);
                      return;
                    }
                    void performAction({ type: "set_time_control", minutes });
                  }}
                >
                  <label htmlFor="time-control-minutes">每方限时</label>
                  <div className="time-control-input">
                    <input
                      id="time-control-minutes"
                      name="minutes"
                      type="number"
                      min={MIN_TIME_CONTROL_MINUTES}
                      max={MAX_TIME_CONTROL_MINUTES}
                      step="1"
                      defaultValue={timeControlMinutes}
                      disabled={busy || timeControlLocked}
                      inputMode="numeric"
                    />
                    <span>分钟</span>
                  </div>
                  <button type="submit" disabled={busy || timeControlLocked}>应用</button>
                </form>
              ) : (
                <div className="time-control-summary">
                  <span>每方限时</span>
                  <strong>{timeControlMinutes} 分钟</strong>
                </div>
              )}
              <small>{room.roomKind === "ranked" ? "排位标准：合法落子扣时后余时≤5:00，则增加 5 秒" : timeControlLocked ? "限时已锁定" : room.viewer === "black" ? "房主可在确认布阵前修改" : "由房主设置"}</small>
              {room.roomKind === "ranked" && room.setupDeadlineAt ? (
                <small>
                  请在 {new Date(room.setupDeadlineAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} 前完成布阵；开局前任一方均可无损取消。
                </small>
              ) : null}
            </div>
          ) : null}
          {viewerSide && game.phase !== "setup" ? (
            <CapturedPieceBox pieces={capturedOwnPieces} />
          ) : null}
          <div className="seat-list">
            {(["black", "white"] as Side[]).map((side) => (
              <div className={`seat ${game.turn === side && game.phase === "playing" ? "active" : ""}`} key={side}>
                <span className={`seat-stone ${side}`} />
                <div><strong>{sideName(side)}</strong><small>{visiblePieceCount(side)} 枚棋子</small></div>
                <span className="seat-state">{seatState(side)}</span>
              </div>
            ))}
          </div>
          {viewerSide && game.phase === "setup" ? (
            <div className="setup-actions">
              <button className="button secondary" type="button" disabled={busy || game.ready[viewerSide]} onClick={randomizeLocalSetup}>随机布阵</button>
              <button
                className="button primary"
                type="button"
                disabled={busy || Boolean(game.augment && !game.augment.draft.rounds[0]?.players[viewerSide].locked)}
                onClick={toggleSetupReady}
              >
                {game.ready[viewerSide]
                  ? "撤销确认"
                  : game.augment && !game.augment.draft.rounds[0]?.players[viewerSide].locked
                    ? "先选择军令"
                    : "完成布阵"}
              </button>
              {room.roomKind === "ranked" ? (
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => void cancelRankedSetup()}
                >
                  取消本次排位（不计分）
                </button>
              ) : null}
            </div>
          ) : null}
          {viewerSide && (game.phase === "playing" || game.phase === "augment_draft") ? (
            <details className="quiet-menu">
              <summary>本局选项</summary>
              <button type="button" disabled={busy} onClick={requestResign}>认输</button>
            </details>
          ) : null}
        </aside>

        <aside className="side-panel activity-panel" aria-label="战报与邀请">
          <div className="invite-block">
            {room.viewer === "black" && inviteToken && !game.joined.white ? (
              <button className="button primary compact" type="button" onClick={() => void copyLink("player")}>复制玩家邀请</button>
            ) : null}
            <button className="button secondary compact" type="button" onClick={() => void copyLink("spectator")}>复制{room.spectatorPolicy === "full" ? "明牌" : "安全"}观战链接</button>
          </div>
          <div className="activity-block">
            <div className="panel-title-row"><strong>{activeReplayFrame ? "复盘战报" : "战报"}</strong><span>{activeReplayFrame ? activeReplayFrame.moveNumber : game.moveNumber} 手</span></div>
            {battleReportEvents.length ? (
              <ol className="event-list">
                {battleReportEvents.map((event) => <li key={event.id}>{eventText(event)}</li>)}
              </ol>
            ) : <p className="empty-copy">暂无</p>}
          </div>
        </aside>
      </section>
      <p className="rank-order" aria-label="军阶大小规则">
        <strong>大小规则</strong>
        <span>司令 ＞ 军长 ＞ 师长 ＞ 旅长 ＞ 团长 ＞ 营长 ＞ 连长 ＞ 排长 ＞ 工兵</span>
      </p>
      <dialog
        className="rules-dialog"
        id="game-rules-dialog"
        ref={rulesDialogRef}
        aria-labelledby="game-rules-title"
        onClose={() => {
          setRulesOpen(false);
          rulesTriggerRef.current?.focus();
        }}
        >
        <div className="rules-dialog-header">
          <h2 id="game-rules-title" ref={rulesTitleRef} tabIndex={-1}>
            {game.mode === "augment" ? "狂野陆战棋规则" : "经典暗军棋规则"}
          </h2>
          <form method="dialog">
            <button className="rules-close" type="submit">关闭</button>
          </form>
        </div>
        <div className="rules-list">
          <section>
            <h3>本局模式</h3>
            <p>
              {game.mode === "augment"
                ? "本局为狂野模式：经典棋盘与基础规则不变，另外加入两轮公开军令。"
                : "本局为经典模式：完全沿用原版布阵、移动、交战与胜负规则，不生成或使用军令牌。"}
            </p>
          </section>
          <section>
            <h3>目标</h3>
            <p>
              夺取对方军旗、使对方无合法着法、用尽对局时间，或对方认输即可获胜。
              {game.repetition
                ? " 狂野局中，同一完整局面第三次出现时自动和棋；第二次出现会在牌桌旁提示。"
                : " 本局没有自动和棋或回合上限。"}
            </p>
          </section>
          <section>
            <h3>暗棋与观战</h3>
            <p>
              两名玩家看不到对手棋型，规则已公开的身份除外。
              {room.roomKind === "ranked"
                ? " 排位好友观战只显示好友一方本来可见的信息，不会暴露其对手暗子。"
                : room.spectatorPolicy === "full"
                  ? " 本私人房在开局前启用了明牌观战，观众可见双方棋型；该房不计排位。"
                  : " 本私人房使用安全观战，观众在终局前看不到双方暗子。"}
            </p>
          </section>
          <section>
            <h3>布阵</h3>
            <p>默认布阵中，棋子只能放在本方兵站或大本营，行营必须留空；军旗须在大本营，地雷须在最后两排，炸弹不能在第一排。狂野局以牌面为准：「偷梁换柱」可将军旗放在己方底线任意站点，「深呼吸」可将地雷放在己方后三排；其他布阵军令也按牌面额度覆盖默认限制。双方确认后随机决定先手。</p>
          </section>
          <section>
            <h3>军令选择</h3>
            <p>狂野局每轮双方获得同一花色、同一强度的三张候选，但具体牌可以不同。每人每轮可刷新其中一张；本局见过或刷掉的牌不会再次出现。候选与未公开选择仅本人可见。</p>
          </section>
          <section>
            <h3>两轮公开</h3>
            <p>第一项军令在布阵时选择，双方都确认阵型后同时亮出。完成前 9 手后、执行第 10 手前暂停棋钟并选择第二项；双方锁定后同时亮出，再恢复原行动方。已公开军令始终显示在牌桌旁。</p>
          </section>
          <section>
            <h3>军令次数</h3>
            <p>主动军令需从牌桌旁发动，自动军令会在条件满足时结算。牌面显示已触发次数；只有达到总次数才标为“已耗尽”。非法请求、取消或网络失败不会消耗次数。</p>
          </section>
          <section>
            <h3>追加行动</h3>
            <p>获得追加行动后，可以移动牌面要求的棋子，也可以主动放弃并把行动权交给对手。放弃会计算本次思考时间，但不增加手数、不写入落子回放，也不会获得排位的 5 秒落子增益。</p>
          </section>
          <section>
            <h3>移动</h3>
            <p>公路每次沿连接线走一格。铁路可直线行走任意格，但不能越子；只有工兵可以在铁路上转弯。</p>
          </section>
          <section>
            <h3>行营</h3>
            <p>空行营双方均可进入。行营内的棋子不能被攻击，离开后不再受保护。</p>
          </section>
          <section>
            <h3>大本营</h3>
            <p>任何棋子进入大本营后都不能再移动。军旗和地雷始终不能移动。</p>
          </section>
          <section>
            <h3>交战</h3>
            <p>司令、军长、师长、旅长、团长、营长、连长、排长、工兵依次由高到低；高阶获胜，同级同归于尽。炸弹与任何敌棋相遇都会同归于尽。</p>
          </section>
          <section>
            <h3>地雷</h3>
            <p>工兵可以挖雷并存活；其他棋子碰到地雷会被消灭，地雷保留；炸弹与地雷同时移除。</p>
          </section>
          <section>
            <h3>军旗暴露</h3>
            <p>司令阵亡后，己方军旗公开。若被进攻的大本营内不是军旗，另一座大本营中的军旗也会公开。狂野局中，「濒死悟道」尚未解锁时，进攻军旗会消耗行动但被保护阻止，军旗同时永久公开；敌方占领另一座大本营后保护解除。</p>
          </section>
          <section>
            <h3>复盘</h3>
            <p>{room.spectatorPolicy === "full" && room.roomKind !== "ranked" ? "本私人明牌观战房允许观众查看进行中的完整回放。" : "安全观战与排位观战在终局前不提供完整明棋回放。"} 两名玩家需等本局结束后再查看完整复盘，避免暗子身份提前暴露。</p>
          </section>
          <section>
            <h3>用时</h3>
            <p>
              {room.roomKind === "ranked"
                ? "排位每方初始 10 分钟。一次合法落子扣除本步思考时间后，若该方余时不超过 5 分钟，则增加 5 秒。军令选择期间棋钟暂停。"
                : game.clock
                  ? `本私人房每方初始 ${Math.round(game.clock.initialMs / 60_000)} 分钟；房主可在任何一方确认布阵前修改。`
                  : "本私人房不设棋钟。"}
              对局只计算当前行动方时间；余时归零立即判负。
            </p>
          </section>
          <section>
            <h3>排位与认输</h3>
            <p>只有服务器匹配并正式结算的排位局改变分数；经典好友房和狂野好友房均不改变排位分。对局进行中或第二轮军令选择时都可以从“本局选项”认输。</p>
          </section>
        </div>
      </dialog>
      {toast ? <div className="toast" role="alert" aria-live="assertive">{toast}</div> : null}
    </main>
  );
}
