"use client";

import Link from "next/link";
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
  getProjectedAugmentMoveViolation,
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
  type MovementAnimationTransition,
  type SetupDraft,
  type Side,
  type Viewer,
} from "../lib/game";
import {
  getAugmentDefinition,
  type AugmentId,
  type AugmentSlot,
} from "../lib/augments";
import AugmentDraft from "./components/AugmentDraft";
import AugmentRail from "./components/AugmentRail";

interface RoomEnvelope {
  code: string;
  version: number;
  viewer: Viewer;
  snapshot: ProjectedGame;
  roomKind?: "custom" | "ranked";
  gameMode?: "classic" | "augment";
  spectatorPolicy?: "hidden" | "full";
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
  FLAG_MUST_BE_HEADQUARTERS: "军旗只能放在本方两个大本营之一。",
  MINE_BACK_TWO_ROWS: "地雷只能放在本方最后两排。",
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
  AUGMENT_MODE_REQUIRED: "这局不是军令强化模式。",
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
  RANKED_TIME_CONTROL_LOCKED: "排位用时固定为 10 分钟，不能修改。",
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

function eventText(event: PublicEvent) {
  const actor = sideName(event.actor);
  if (event.result === "ready") return `${actor}锁定了阵型`;
  if (event.result === "unready") return `${actor}撤销了确认`;
  if (event.result === "game_started") return `${actor}获得先手`;
  if (event.result === "resigned") return `${actor}认输`;
  if (event.result === "timeout") return `${actor}用时耗尽`;
  if (event.result === "augment_revealed") return "双方军令同时公开";
  if (event.result === "augment_used") {
    return `${actor}发动「${event.augmentId ? getAugmentDefinition(event.augmentId).name : "军令"}」`;
  }
  const path = event.from && event.to ? `${boardCoordinate(event.from)} → ${boardCoordinate(event.to)}` : "";
  if (event.result === "move") return `${actor}移动 · ${path}`;
  if (event.result === "attacker_survives") return `${actor}进攻成功 · ${path}`;
  if (event.result === "defender_survives") return `${actor}进攻失利 · ${path}`;
  if (event.result === "both_removed") return `双方同归于尽 · ${path}`;
  return `${actor}夺得军旗`;
}

function finishReasonText(reason: ProjectedGame["finishReason"]) {
  if (reason === "flag") return "夺得军旗";
  if (reason === "no_moves") return "对方无棋可走";
  if (reason === "resign") return "认输结束";
  if (reason === "timeout") return "用时耗尽";
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
    if (!snapshot.winner) return "本局和棋";
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
  motionClass?: "battle-animation-visual" | "battle-defender-ghost";
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
  animation: MovementAnimationTransition;
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
  const recentMovement = movementAnimation?.event;
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
        const targetAttack = Boolean(targetHere && piece && piece.side !== viewer);
        const lastMoveFrom = Boolean(
          movementHighlight?.from && samePosition(movementHighlight.from, position),
        );
        const lastMoveTo = Boolean(
          movementHighlight?.to && samePosition(movementHighlight.to, position),
        );
        const camp = CAMPS.some((candidate) => samePosition(candidate, position));
        const headquarters = HEADQUARTERS.some((candidate) => samePosition(candidate, position));
        const headquartersSide: Side | null = headquarters ? (row < 6 ? "white" : "black") : null;
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
            movementAnimation &&
            (piece.id === movementAnimation.attacker.id ||
              piece.id === movementAnimation.defender?.id),
        );
        const pieceLabel = visiblePieceLabel ?? (piece ? "身份隐藏" : "空位");
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
              className={`station-hit ${selectedHere ? "is-selected" : ""} ${targetHere ? "is-target" : ""} ${targetAttack ? "is-attack" : ""} ${lastMoveFrom ? "is-last-move-from" : ""} ${lastMoveTo ? "is-last-move-to" : ""} ${visiblePieceLabel ? "has-piece-label" : ""} ${headquarters ? "is-headquarters" : ""} ${headquartersOwnershipClass}`}
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
              aria-label={`${boardCoordinate(position)}，${stationLabel}，${pieceLabel}${coverLabel}${targetLabel}`}
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
                </>
              ) : null}
            </button>
          </div>
        );
      })}
      {movementAnimation ? (
        <BattleAnimationOverlay
          key={`${movementAnimation.moveNumber}:${movementAnimation.event.id}`}
          animation={movementAnimation}
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

function SignInLanding({ signInPath }: { signInPath: string }) {
  return (
    <main className="landing auth-landing">
      <div className="auth-stage">
        <div className="auth-court-card auth-queen" aria-hidden="true" />
        <section className="landing-core auth-panel">
          <span className="product-kicker">经典规则 · 军令强化</span>
          <h1><span>军令</span><span>陆战棋</span></h1>
          <p>邮件账号 · 在线匹配 · 公平三选一</p>
          <a className="button primary sign-in-button" href={signInPath}>使用邮箱登录</a>
          <small className="auth-note">登录后才能对局、观战与保存战绩。</small>
        </section>
        <div className="auth-court-card auth-king" aria-hidden="true" />
      </div>
    </main>
  );
}

function Landing({
  user,
  signOutPath,
  account,
  recentMatches,
  friends,
  matchmaking,
  watchingMatchId,
  onCreate,
  creating,
  onOpen,
  onMatchmaking,
  onCancelMatchmaking,
  onFriendRequest,
  onAcceptFriend,
  onWatchFriend,
}: {
  user: SessionUser;
  signOutPath: string;
  account: AccountSummary | null;
  recentMatches: RecentMatch[];
  friends: FriendsEnvelope;
  matchmaking: MatchmakingEnvelope;
  watchingMatchId: string | null;
  onCreate: (mode: "classic" | "augment", spectatorPolicy: "hidden" | "full") => void;
  creating: boolean;
  onOpen: (code: string) => void;
  onMatchmaking: () => void;
  onCancelMatchmaking: () => void;
  onFriendRequest: (handle: string) => void;
  onAcceptFriend: (requestId: string) => void;
  onWatchFriend: (matchId: string) => void;
}) {
  const [code, setCode] = useState("");
  const [mode, setMode] = useState<"classic" | "augment">("classic");
  const [spectatorPolicy, setSpectatorPolicy] = useState<"hidden" | "full">("hidden");
  const [friendHandle, setFriendHandle] = useState("");
  const searching = matchmaking.state === "queued";
  return (
    <main className="lobby-shell">
      <header className="lobby-header">
        <Link className="wordmark" href="/" aria-label="军令首页">
          <span className="wordmark-mark">令</span><span>军令 · 陆战棋</span>
        </Link>
        <div className="account-chip">
          <span>{account?.handle ?? user.displayName}</span>
          <small>{account?.rank.label ?? "正在载入段位"}</small>
          <a href={signOutPath}>退出</a>
        </div>
      </header>

      <section className="lobby-hero">
        <div>
          <span className="product-kicker">保留经典，也允许每局不同</span>
          <h1>今天下哪一种军棋？</h1>
          <p>经典模式完整保留原规则；军令强化模式在布阵和第 10 手前各进行一次同等级三选一。</p>
        </div>
        <div className="rank-card">
          <span>当前段位</span>
          <strong>{account?.rank.label ?? "—"}</strong>
          <small>{account ? `${account.rating} 分 · ${Math.round(account.record.winRate * 100)}% 胜率` : "正在同步战绩"}</small>
          <div className="rank-progress" aria-hidden="true"><span style={{ width: `${Math.round((account?.rank.progress ?? 0) * 100)}%` }} /></div>
        </div>
      </section>

      <div className="lobby-grid">
        <section className="lobby-panel play-panel">
          <div className="panel-title-row"><strong>开始对局</strong><span>好友房不改变排位分</span></div>
          <div className="mode-picker" role="radiogroup" aria-label="房间模式">
            <button className={mode === "classic" ? "is-selected" : ""} type="button" role="radio" aria-checked={mode === "classic"} onClick={() => setMode("classic")}>
              <strong>经典暗军棋</strong><small>原版规则，完全不变</small>
            </button>
            <button className={mode === "augment" ? "is-selected" : ""} type="button" role="radio" aria-checked={mode === "augment"} onClick={() => setMode("augment")}>
              <strong>军令强化</strong><small>两轮强化，20 张牌池</small>
            </button>
          </div>
          <label className="spectator-setting">
            <span>好友房观战</span>
            <select value={spectatorPolicy} onChange={(event) => setSpectatorPolicy(event.target.value as "hidden" | "full")}>
              <option value="hidden">隐藏双方暗牌</option>
              <option value="full">允许明牌观战</option>
            </select>
          </label>
          <button className="button primary" type="button" onClick={() => onCreate(mode, spectatorPolicy)} disabled={creating}>
            {creating ? "正在创建…" : `创建${mode === "classic" ? "经典" : "军令"}好友房`}
          </button>
          <div className="ranked-callout">
            <div><strong>军令排位</strong><small>10:00 · 落子扣时后余时≤5:00，则 +5 秒</small></div>
            <button className="button secondary compact" type="button" onClick={searching ? onCancelMatchmaking : onMatchmaking}>
              {searching ? `取消匹配 · ±${matchmaking.ratingRange ?? 100}` : "寻找实力相近的对手"}
            </button>
          </div>
          <form
            className="join-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (cleanCode(code).length === 8) onOpen(cleanCode(code));
            }}
          >
            <input
              aria-label="房间码"
              value={displayCode(code)}
              onChange={(event) => setCode(cleanCode(event.target.value))}
              placeholder="房间码"
              maxLength={9}
            />
            <button type="submit" aria-label="进入房间" disabled={cleanCode(code).length !== 8}>→</button>
          </form>
        </section>

        <section className="lobby-panel stats-panel">
          <div className="panel-title-row"><strong>最近 10 局</strong><span>{account?.record.games ?? 0} 局总战绩</span></div>
          <div className="stat-strip">
            <span><strong>{account?.record.wins ?? 0}</strong><small>胜</small></span>
            <span><strong>{account?.record.losses ?? 0}</strong><small>负</small></span>
            <span><strong>{account?.record.draws ?? 0}</strong><small>和</small></span>
          </div>
          <ol className="history-list">
            {recentMatches.length ? recentMatches.map((match) => (
              <li key={match.id}>
                <span className={`outcome outcome-${match.outcome}`}>{match.outcome === "win" ? "胜" : match.outcome === "loss" ? "负" : "和"}</span>
                <strong>{match.opponentHandle}</strong>
                <small>{match.ratingDelta > 0 ? "+" : ""}{match.ratingDelta} · {new Date(match.completedAt).toLocaleDateString("zh-CN")}</small>
              </li>
            )) : <li className="empty-row">完成第一局后，这里会显示最近战绩。</li>}
          </ol>
        </section>

        <section className="lobby-panel friends-panel">
          <div className="panel-title-row"><strong>好友</strong><span>{friends.friends.filter((friend) => friend.presence !== "offline").length} 人在线</span></div>
          <form className="friend-form" onSubmit={(event) => { event.preventDefault(); if (friendHandle.trim()) { onFriendRequest(friendHandle.trim()); setFriendHandle(""); } }}>
            <input aria-label="好友昵称" placeholder="输入玩家昵称" value={friendHandle} onChange={(event) => setFriendHandle(event.target.value)} />
            <button type="submit">添加</button>
          </form>
          {friends.incoming.map((request) => (
            <div className="friend-request" key={request.requestId}><span>{request.player.handle} 请求加你为好友</span><button type="button" onClick={() => onAcceptFriend(request.requestId)}>接受</button></div>
          ))}
          <ul className="friend-list">
            {friends.friends.length ? friends.friends.map((friend) => (
              <li key={friend.relationshipId}>
                <span className={`presence-dot presence-${friend.presence}`} aria-hidden="true" />
                <div><strong>{friend.player.handle}</strong><small>{friend.player.rank.label}</small></div>
                {friend.presence === "in_game" && friend.currentMatchId ? (
                  <button
                    type="button"
                    disabled={watchingMatchId !== null}
                    aria-busy={watchingMatchId === friend.currentMatchId}
                    onClick={() => onWatchFriend(friend.currentMatchId!)}
                  >
                    {watchingMatchId === friend.currentMatchId ? "进入中…" : "观战"}
                  </button>
                ) : <small>{friend.presence === "offline" ? "离线" : friend.presence === "searching" ? "匹配中" : "在线"}</small>}
              </li>
            )) : <li className="empty-row">添加好友后，可以看到在线状态并安全观战。</li>}
          </ul>
        </section>
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
  const [clockTick, setClockTick] = useState(0);
  const [clockAnchor, setClockAnchor] = useState(0);
  const [connection, setConnection] = useState<"live" | "syncing" | "offline">("live");
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [recentMatches, setRecentMatches] = useState<RecentMatch[]>([]);
  const [friends, setFriends] = useState<FriendsEnvelope>({ friends: [], incoming: [], outgoing: [] });
  const [matchmaking, setMatchmaking] = useState<MatchmakingEnvelope>({ state: "idle" });
  const [watchingMatchId, setWatchingMatchId] = useState<string | null>(null);
  const [activeAugmentId, setActiveAugmentId] = useState<AugmentId | null>(null);
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
      if (media.matches) setMovementAnimation(null);
    };
    syncPreference();
    media.addEventListener("change", syncPreference);
    return () => media.removeEventListener("change", syncPreference);
  }, []);

  useEffect(() => {
    if (!movementAnimation) return;
    const duration =
      movementAnimation.outcome === "move"
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
    const stopHiddenAnimation = () => {
      if (document.hidden) setMovementAnimation(null);
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

  function acceptRoom(next: RoomEnvelope, allowRoomChange = false) {
    const current = roomRef.current;
    if (current && current.code !== next.code && !allowRoomChange) return false;
    if (current && current.code === next.code && next.version < current.version) return false;
    if (!current || current.code !== next.code || current.viewer !== next.viewer) {
      setMovementAnimation(null);
    } else if (next.version > current.version) {
      const animation =
        replayIndexRef.current === null &&
        !reduceMotionRef.current &&
        !document.hidden
          ? movementAnimationForTransition(current.snapshot, next.snapshot)
          : null;
      setMovementAnimation(animation);
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
    const receivedAt = performance.now();
    setClockAnchor(receivedAt);
    setClockTick(receivedAt);
    roomRef.current = next;
    setRoom(next);
    if (isPlayer(next.viewer) && next.snapshot.augment?.pendingRecon) {
      setActiveAugmentId(next.snapshot.augment.pendingRecon.augmentId);
    }
    return true;
  }

  function clearRoom() {
    roomSessionRef.current += 1;
    busyRef.current = false;
    setBusy(false);
    setSelectedPieceId(null);
    setActiveAugmentId(null);
    setSetupDraftState(null);
    setRulesOpen(false);
    replayIndexRef.current = null;
    setReplayIndex(null);
    setMovementAnimation(null);
    setClockAnchor(0);
    setClockTick(0);
    roomRef.current = null;
    setRoom(null);
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
      try {
        const url = new URL(window.location.href);
        code = cleanCode(url.searchParams.get("room") ?? "");
        if (code.length !== 8) return;
        const watchOnly = url.searchParams.get("watch") === "1";
        const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
        const invitedToken = fragment.get("invite");
        let storedToken = readLocalValue(roomTokenKey(code));
        if (invitedToken && !watchOnly) {
          if (storedToken) {
            try {
              const existing = await fetchRoom(code, storedToken);
              if (!existing) throw new Error("EMPTY_ROOM_RESPONSE");
              if (cancelled || session !== roomSessionRef.current) return;
              acceptRoom(existing, true);
              setToken(storedToken);
              setInviteToken(readLocalValue(inviteTokenKey(code)));
              setFlipped(false);
              setFatalError(null);
              setConnection("live");
              url.hash = "";
              window.history.replaceState(null, "", `${url.pathname}${url.search}`);
              return;
            } catch (error) {
              if (!(error instanceof RequestError) || error.status !== 401) throw error;
              removeLocalValue(roomTokenKey(code));
              storedToken = null;
            }
          }
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
          url.hash = "";
          window.history.replaceState(null, "", `${url.pathname}${url.search}`);
          acceptRoom(
            { code: claimed.code, version: claimed.version, viewer: claimed.viewer, snapshot: claimed.snapshot },
            true,
          );
          setToken(candidateToken);
          setInviteToken(null);
          setFlipped(false);
          setFatalError(null);
          setConnection("live");
          if (!identitySaved) showToast("玩家身份只能在当前页面保留，请勿刷新。");
          return;
        }
        if (invitedToken) {
          url.hash = "";
          window.history.replaceState(null, "", `${url.pathname}${url.search}`);
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
      acceptRoom(
        { code: created.code, version: created.version, viewer: created.viewer, snapshot: created.snapshot },
        true,
      );
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
      const message = code === "PLAYER_NOT_FOUND" ? "没有找到这个玩家昵称。" : code === "ALREADY_FRIENDS" ? "你们已经是好友。" : "好友请求没有发送成功。";
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
    if (!current || !isPlayer(current.viewer) || busyRef.current) return;
    const session = roomSessionRef.current;
    busyRef.current = true;
    setBusy(true);
    setConnection("syncing");
    try {
      const next = await postAction(current.code, token, current.version, action);
      if (session !== roomSessionRef.current || roomRef.current?.code !== current.code) return;
      acceptRoom(next);
      setConnection("live");
      setSelectedPieceId(null);
      if (["augment_move", "augment_exchange", "augment_recon"].includes(action.type)) {
        setActiveAugmentId(null);
      }
    } catch (error) {
      if (session !== roomSessionRef.current || roomRef.current?.code !== current.code) return;
      if (error instanceof RequestError && error.status === 409) {
        setSelectedPieceId(null);
        showToast(ERROR_TEXT.VERSION_CONFLICT);
        try {
          const latest = await fetchRoom(current.code, token);
          if (session !== roomSessionRef.current || roomRef.current?.code !== current.code) return;
          if (latest) acceptRoom(latest);
          setConnection("live");
        } catch (syncError) {
          if (session !== roomSessionRef.current || roomRef.current?.code !== current.code) return;
          if (syncError instanceof RequestError && [401, 404, 410].includes(syncError.status)) {
            setFatalError(ERROR_TEXT[syncError.code] ?? "这个房间已经不可用。");
            removeLocalValue(roomTokenKey(current.code));
            setToken(null);
            clearRoom();
          } else {
            setConnection("offline");
          }
        }
      } else if (error instanceof RequestError && [401, 404, 410].includes(error.status)) {
        setFatalError(ERROR_TEXT[error.code] ?? "这个房间已经不可用。");
        removeLocalValue(roomTokenKey(current.code));
        setToken(null);
        setSelectedPieceId(null);
        clearRoom();
      } else {
        const errorCode = error instanceof RequestError ? error.code : "ACTION_FAILED";
        showToast(ERROR_TEXT[errorCode] ?? ERROR_TEXT.ACTION_FAILED);
        setConnection(error instanceof RequestError ? "live" : "offline");
      }
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
    if (!room || !setupSide || room.snapshot.phase !== "setup" || !activeSetupDraft) {
      return room?.snapshot.pieces ?? [];
    }
    return room.snapshot.pieces.flatMap((piece) => {
      if (piece.side !== setupSide) return [piece];
      const position = activeSetupDraft[piece.id];
      return position ? [{ ...piece, ...position }] : [];
    });
  }, [activeSetupDraft, room, setupSide]);
  const replayFrames = useMemo(
    () => buildReplayFrames(room?.snapshot.replay ?? null),
    [room?.snapshot.replay],
  );
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
    return isInsideBoard(selectedPiece) ? { row: selectedPiece.row, col: selectedPiece.col } : null;
  })();

  const legalTargets = useMemo(() => {
    if (!room || !isPlayer(room.viewer)) return [] as Position[];
    if (room.snapshot.phase === "playing" && activeAugmentId) {
      const effect = getAugmentDefinition(activeAugmentId).effect;
      if (effect.kind === "reconnaissance") {
        return room.snapshot.pieces
          .filter((piece) => piece.alive && piece.side !== room.viewer && piece.type === null)
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
        return room.snapshot.pieces
          .filter((piece) => piece.alive && piece.side === room.viewer && piece.id !== selectedPieceId)
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
  }, [activeAugmentId, activeSetupDraft, room, selectedPieceId, selectedPosition, setupAugmentIds]);

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
    if (!room || !isPlayer(room.viewer) || movementAnimation) return false;
    if (activeAugmentId) {
      const effect = getAugmentDefinition(activeAugmentId).effect;
      if (effect.kind === "exchange" || effect.kind === "reconnaissance") return false;
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
    if (!room || busy || movementAnimation || !isPlayer(room.viewer)) return;
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
    if (piece?.side === room.viewer) {
      if (
        activeAugmentId &&
        selectedPieceId &&
        piece.id !== selectedPieceId &&
        getAugmentDefinition(activeAugmentId).effect.kind === "exchange"
      ) {
        const fromPiece = room.snapshot.pieces.find((candidate) => candidate.id === selectedPieceId);
        if (!fromPiece) {
          setSelectedPieceId(piece.id);
          return;
        }
        const violation = getProjectedAugmentExchangeViolation(
          room.snapshot,
          room.viewer,
          activeAugmentId,
          fromPiece,
          position,
        );
        if (violation) showToast(ERROR_TEXT[violation] ?? "这两枚棋子不能执行换防。");
        else void performAction({
          type: "augment_exchange",
          augmentId: activeAugmentId,
          from: { row: fromPiece.row, col: fromPiece.col },
          to: position,
        });
        return;
      }
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
    if (!room || movementAnimation || !isPlayer(room.viewer)) return;
    const origin =
      room.snapshot.phase === "setup"
        ? activeSetupDraft?.[pieceId]
        : room.snapshot.pieces.find((piece) => piece.alive && piece.id === pieceId);
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

  function activateAugment(augmentId: AugmentId) {
    const effect = getAugmentDefinition(augmentId).effect;
    if (!["movement", "exchange", "reconnaissance"].includes(effect.kind)) {
      showToast("这张强化会在满足条件时自动生效。");
      return;
    }
    setSelectedPieceId(null);
    setActiveAugmentId((current) => current === augmentId ? null : augmentId);
    if (effect.kind === "reconnaissance") showToast("请在棋盘上选择一枚未知敌子。");
    else if (effect.kind === "exchange") showToast("依次选择两枚可换防的己方棋子。");
    else showToast("先选择己方棋子，再选择高亮目标。");
  }

  function requestResign() {
    if (!room || !isPlayer(room.viewer) || !["playing", "augment_draft"].includes(room.snapshot.phase)) return;
    if (window.confirm("确定认输并结束本局吗？")) void performAction({ type: "resign" });
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
        </>
      );
    }
    return (
      <>
        <Landing
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
        />
        {fatalError ? <div className="toast error-toast" role="alert" aria-live="assertive">{fatalError}</div> : null}
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
        augmentId: activeReplayFrame.move.augmentId,
      }
    : undefined;
  const latestOpponentMove = latestOpponentMovementEvent(game.events, room.viewer);
  const highlightedMove = activeReplayFrame ? replayMoveEvent : latestOpponentMove;
  const displayedPieces = activeReplayFrame?.pieces ?? renderPieces;
  const liveMovementAnimation = activeReplayFrame ? null : movementAnimation;
  const displayedGame = activeReplayFrame
    ? { ...game, pieces: activeReplayFrame.pieces, events: replayMoveEvent ? [replayMoveEvent] : [] }
    : game;
  const capturedOwnPieces = viewerSide && game.phase !== "setup"
    ? displayedPieces.filter(
        (piece) =>
          piece.side === viewerSide &&
          !piece.alive &&
          piece.id !== liveMovementAnimation?.attacker.id &&
          piece.id !== liveMovementAnimation?.defender?.id,
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
  const augmentRailItems = (side: Side) =>
    (game.augment?.draft.loadouts[side] ?? []).map((id) => ({
      augment: getAugmentDefinition(id),
      triggerCount: game.augment?.triggerCounts[side][id] ?? 0,
    }));
  const primaryRailSide: Side = viewerSide ?? "black";
  const secondaryRailSide: Side = otherSide(primaryRailSide);

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

      {showAugmentDraft && activeDraftRound && viewerDraft ? (
        <div className="augment-draft-overlay" role="dialog" aria-modal="true" aria-label="强化选择">
          <AugmentDraft
            round={activeDraftRound.number}
            options={draftOptions}
            selectedId={viewerDraft.selectedId}
            locked={viewerDraft.locked}
            opponentLocked={opponentDraft?.locked ?? false}
            refreshUsed={viewerDraft.refreshed}
            seenCount={game.augment?.draft.seenIds?.length ?? 0}
            deadlineAt={game.augment?.draftDeadlineAt ?? null}
            pending={busy}
            onSelect={(augmentId) => void performAction({ type: "augment_select", augmentId })}
            onRefresh={(slot: AugmentSlot) => void performAction({ type: "augment_refresh", slot })}
            onConfirm={() => void performAction({ type: "augment_lock" })}
            onResign={game.phase === "augment_draft" ? requestResign : undefined}
          />
        </div>
      ) : null}

      <section className={`game-shell ${game.phase === "setup" ? "is-setup" : ""}`}>
        <aside className="side-panel setup-panel">
          <h2>{statusText(room, placedSetupCount)}</h2>
          {game.augment ? (
            <AugmentRail
              label={viewerSide ? "我的" : sideName(primaryRailSide)}
              items={augmentRailItems(primaryRailSide)}
              activeId={viewerSide === primaryRailSide ? activeAugmentId : null}
              canActivate={Boolean(viewerSide === primaryRailSide && game.phase === "playing")}
              pending={busy}
              onActivate={viewerSide === primaryRailSide ? activateAugment : undefined}
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
                    ? "先锁定强化"
                    : "完成布阵"}
              </button>
            </div>
          ) : null}
          {viewerSide && (game.phase === "playing" || game.phase === "augment_draft") ? (
            <details className="quiet-menu">
              <summary>本局选项</summary>
              <button type="button" disabled={busy} onClick={requestResign}>认输</button>
            </details>
          ) : null}
        </aside>

        <section className="board-column">
          <div className={`player-strip ${!activeReplayFrame && game.turn === topSide && game.phase === "playing" ? "active" : ""}`}>
            <span>{sideName(topSide)}</span>{playerClock(topSide)}<span>{boardPieceCount(topSide)} / 25</span>
          </div>
          {highlightedMove?.from && highlightedMove.to ? (
            <p className="last-move-summary">
              <strong>{activeReplayFrame ? "复盘" : room.viewer === "spectator" ? "上一手" : "对手上一步"}</strong>
              <span>{sideName(highlightedMove.actor)} · {boardCoordinate(highlightedMove.from)} → {boardCoordinate(highlightedMove.to)}</span>
            </p>
          ) : activeReplayFrame ? (
            <p className="last-move-summary"><strong>复盘</strong><span>{replayHasGap ? "回放记录不完整" : replayIsPartial ? `从第 ${activeReplayFrame.moveNumber} 手开始` : "开局阵型"}</span></p>
          ) : null}
          <Board
            game={displayedGame}
            pieces={displayedPieces}
            viewer={activeReplayFrame ? "spectator" : room.viewer}
            selected={activeReplayFrame ? null : selectedPosition}
            targets={activeReplayFrame ? new Set<string>() : targetKeys}
            flipped={orientationFlipped}
            busy={busy || Boolean(liveMovementAnimation)}
            readOnly={Boolean(activeReplayFrame)}
            movementHighlight={highlightedMove}
            movementAnimation={liveMovementAnimation}
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

        <aside className="side-panel activity-panel">
          {game.augment ? (
            <AugmentRail
              label={sideName(secondaryRailSide)}
              items={augmentRailItems(secondaryRailSide)}
            />
          ) : null}
          <div className="invite-block">
            {room.viewer === "black" && inviteToken && !game.joined.white ? (
              <button className="button primary compact" type="button" onClick={() => void copyLink("player")}>复制玩家邀请</button>
            ) : null}
            <button className="button secondary compact" type="button" onClick={() => void copyLink("spectator")}>复制{room.spectatorPolicy === "full" ? "明牌" : "安全"}观战链接</button>
          </div>
          <div className="activity-block">
            <div className="panel-title-row"><strong>战报</strong><span>{game.moveNumber} 手</span></div>
            {lastEvents.length ? (
              <ol className="event-list">
                {lastEvents.map((event) => <li key={event.id}>{eventText(event)}</li>)}
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
            {game.mode === "augment" ? "强化陆战棋规则" : "经典暗军棋规则"}
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
                ? "本局为强化模式：经典棋盘与基础规则不变，另外加入两轮公开强化。"
                : "本局为经典模式：完全沿用原版布阵、移动、交战与胜负规则，不生成或使用强化。"}
            </p>
          </section>
          <section>
            <h3>目标</h3>
            <p>夺取对方军旗、使对方无合法着法、用尽对局时间，或对方认输即可获胜。没有自动和棋或回合上限。</p>
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
            <p>棋子只能放在本方兵站或大本营，行营必须留空。军旗只能在大本营；地雷只能在最后两排；炸弹不能在第一排。强化局中，仅已选择的“前置炸弹”或“纵深布雷”可以提供牌面写明的单枚例外。双方确认后随机决定先手。</p>
          </section>
          <section>
            <h3>强化选择</h3>
            <p>强化局每轮双方获得同一花色、同一强度的三张候选，但具体牌可以不同。每人每轮可刷新其中一张；本局见过或刷掉的牌不会再次出现。候选与未公开选择仅本人可见。</p>
          </section>
          <section>
            <h3>两轮公开</h3>
            <p>第一项强化在布阵时选择，双方都确认阵型后同时亮出。完成前 9 手后、执行第 10 手前暂停棋钟并选择第二项；双方锁定后同时亮出，再恢复原行动方。已公开强化始终显示在牌桌旁。</p>
          </section>
          <section>
            <h3>强化次数</h3>
            <p>主动强化需从牌桌旁启用，自动强化会在条件满足时结算。牌面显示已触发次数；只有达到总次数才标为“已耗尽”。非法请求、取消或网络失败不会消耗次数。</p>
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
            <p>司令阵亡后，己方军旗公开。若被进攻的大本营内不是军旗，另一座大本营中的军旗也会公开。</p>
          </section>
          <section>
            <h3>复盘</h3>
            <p>{room.spectatorPolicy === "full" && room.roomKind !== "ranked" ? "本私人明牌观战房允许观众查看进行中的完整回放。" : "安全观战与排位观战在终局前不提供完整明棋回放。"} 两名玩家需等本局结束后再查看完整复盘，避免暗子身份提前暴露。</p>
          </section>
          <section>
            <h3>用时</h3>
            <p>
              {room.roomKind === "ranked"
                ? "排位每方初始 10 分钟。一次合法落子扣除本步思考时间后，若该方余时不超过 5 分钟，则增加 5 秒。强化选择期间棋钟暂停。"
                : game.clock
                  ? `本私人房每方初始 ${Math.round(game.clock.initialMs / 60_000)} 分钟；房主可在任何一方确认布阵前修改。`
                  : "本私人房不设棋钟。"}
              对局只计算当前行动方时间；余时归零立即判负。
            </p>
          </section>
          <section>
            <h3>排位与认输</h3>
            <p>只有服务器匹配并正式结算的排位局改变分数；经典好友房和强化好友房均不改变排位分。对局进行中或第二轮强化选择时都可以从“本局选项”认输。</p>
          </section>
        </div>
      </dialog>
      {toast ? <div className="toast" role="alert" aria-live="assertive">{toast}</div> : null}
    </main>
  );
}
