"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  CAMPS,
  HEADQUARTERS,
  PIECE_INFO,
  applySetupDraftPlacement,
  createSetupDraft,
  getCampMotionForPosition,
  getProjectedLegalTargets,
  getProjectedMoveViolation,
  getSetupDraftPlacementViolation,
  isCamp,
  isHeadquarters,
  isInsideBoard,
  isRailEdge,
  isRoadEdge,
  isValidSetupDraft,
  latestMovementEvent,
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
  type SetupDraft,
  type Side,
  type Viewer,
} from "../lib/game";

interface RoomEnvelope {
  code: string;
  version: number;
  viewer: Viewer;
  snapshot: ProjectedGame;
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

const PIECE_DRAG_TYPE = "application/x-queens-gambit-piece";

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
    return isValidSetupDraft(pieces, side, candidate, requireComplete) ? candidate : null;
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
  const suffix = Number.isInteger(since) ? `?since=${since}` : "";
  const response = await fetch(`/api/rooms/${code}${suffix}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    cache: "no-store",
  });
  return (await parseResponse(response)) as RoomEnvelope | null;
}

async function postAction(code: string, token: string, version: number, action: PlayerAction) {
  const response = await fetch(`/api/rooms/${code}/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
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

function coordinates(position: Position) {
  return `${String.fromCharCode(65 + position.row)}${position.col + 1}`;
}

function eventText(event: PublicEvent) {
  const actor = sideName(event.actor);
  if (event.result === "ready") return `${actor}锁定了阵型`;
  if (event.result === "unready") return `${actor}撤销了确认`;
  if (event.result === "game_started") return `${actor}获得先手`;
  if (event.result === "resigned") return `${actor}认输`;
  const path = event.from && event.to ? `${coordinates(event.from)} → ${coordinates(event.to)}` : "";
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
  return "和棋";
}

function statusText(room: RoomEnvelope, placedCount?: number) {
  const { snapshot, viewer } = room;
  if (snapshot.phase === "setup") {
    if (viewer === "spectator") return "双方正在秘密布阵";
    if (snapshot.ready[viewer]) return "阵型已锁定，等待对手";
    if (placedCount !== undefined && placedCount < 25) return `还需放置 ${25 - placedCount} 枚棋子`;
    return "拖动或点选棋子调整阵型";
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
}: {
  piece: PublicPiece;
  inCamp?: boolean;
  campMotion?: "enter" | "leave" | null;
}) {
  const known = Boolean(piece.type);
  const info = piece.type ? PIECE_INFO[piece.type] : null;
  return (
    <span
      className={`piece-model side-${piece.side} ${known ? "is-known" : "is-hidden"} ${inCamp ? "is-in-camp" : ""} ${campMotion ? `camp-motion-${campMotion}` : ""}`}
      data-piece={piece.type ?? "hidden"}
      aria-hidden="true"
    >
      <span className="piece-crest">{info?.glyph ?? "□"}</span>
      <span className="piece-neck" />
      <span className="piece-base" />
      <span className="piece-name">{info?.short ?? ""}</span>
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
  const recentMovement = game.phase === "setup" ? undefined : latestMovementEvent(game.events);

  return (
    <div className={`board-grid ${flipped ? "is-flipped" : ""}`} aria-label="军棋棋盘">
      <div className="mountain-band" aria-hidden="true">
        <span>界</span>
      </div>
      {cells.map((position) => {
        const { row, col } = position;
        const piece = alivePieces.find((candidate) => samePosition(candidate, position));
        const selectedHere = Boolean(selected && samePosition(selected, position));
        const targetHere = targets.has(positionKey(position));
        const targetAttack = Boolean(targetHere && piece && piece.side !== viewer);
        const camp = CAMPS.some((candidate) => samePosition(candidate, position));
        const headquarters = HEADQUARTERS.some((candidate) => samePosition(candidate, position));
        const headquartersSide: Side | null = headquarters ? (row < 6 ? "white" : "black") : null;
        const headquartersRelation = headquartersSide
          ? viewer === "spectator"
            ? `${sideName(headquartersSide)}方`
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
              className={`station-hit ${selectedHere ? "is-selected" : ""} ${targetHere ? "is-target" : ""} ${targetAttack ? "is-attack" : ""} ${visiblePieceLabel ? "has-piece-label" : ""} ${headquarters ? "is-headquarters" : ""} ${headquartersOwnershipClass}`}
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
                if (viewer === "spectator" || busy) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => {
                if (viewer === "spectator" || busy) return;
                event.preventDefault();
                const pieceId =
                  event.dataTransfer.getData(PIECE_DRAG_TYPE) || event.dataTransfer.getData("text/plain");
                if (pieceId) onPieceDrop(pieceId, position);
              }}
              onDragEnd={onPieceDragEnd}
              disabled={viewer === "spectator" || busy}
              aria-pressed={piece?.side === viewer ? selectedHere : undefined}
              aria-label={`${coordinates(position)}，${stationLabel}，${pieceLabel}${coverLabel}${targetLabel}`}
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
              {piece ? (
                <>
                  <PieceModel piece={piece} inCamp={camp} campMotion={campMotion.piece} />
                  {visiblePieceLabel ? (
                    <span
                      className={`board-piece-label side-${piece.side} ${camp ? "is-in-camp" : ""}`}
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
    </div>
  );
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
  const ordered = [...pieces].sort((first, second) => {
    const firstIndex = first.type ? Object.keys(PIECE_INFO).indexOf(first.type) : Number.MAX_SAFE_INTEGER;
    const secondIndex = second.type ? Object.keys(PIECE_INFO).indexOf(second.type) : Number.MAX_SAFE_INTEGER;
    return firstIndex - secondIndex || first.id.localeCompare(second.id);
  });
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

function Landing({ onCreate, creating, onOpen }: { onCreate: () => void; creating: boolean; onOpen: (code: string) => void }) {
  const [code, setCode] = useState("");
  return (
    <main className="landing">
      <section className="landing-core">
        <h1>
          <span>The Queen&apos;s</span>
          <span>Gambit</span>
        </h1>
        <p>暗军棋</p>
        <div className="landing-actions">
          <button className="button primary" type="button" onClick={onCreate} disabled={creating}>
            {creating ? "正在创建…" : "创建棋局"}
          </button>
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
        </div>
      </section>
    </main>
  );
}

export default function GameApp({ hasRoom = false }: { hasRoom?: boolean }) {
  const [room, setRoom] = useState<RoomEnvelope | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [selectedPieceId, setSelectedPieceId] = useState<string | null>(null);
  const [setupDraftState, setSetupDraftState] = useState<SetupDraftState | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(hasRoom);
  const [creating, setCreating] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [connection, setConnection] = useState<"live" | "syncing" | "offline">("live");
  const roomRef = useRef<RoomEnvelope | null>(null);
  const roomSessionRef = useRef(0);
  const busyRef = useRef(false);
  const creatingRef = useRef(false);
  const toastTimerRef = useRef<number | null>(null);
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
    if (!setupDraftState) return;
    writeLocalValue(
      setupDraftKey(setupDraftState.roomCode, setupDraftState.side),
      JSON.stringify(setupDraftState.locations),
    );
  }, [setupDraftState]);

  useEffect(() => {
    const cancelSelection = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !rulesDialogRef.current?.open) setSelectedPieceId(null);
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

  function acceptRoom(next: RoomEnvelope, allowRoomChange = false) {
    const current = roomRef.current;
    if (current && current.code !== next.code && !allowRoomChange) return false;
    if (current && current.code === next.code && next.version < current.version) return false;
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
      const hasSetupHistory = next.snapshot.events.some(
        (event) => event.actor === side && (event.result === "ready" || event.result === "unready"),
      );
      setSetupDraftState((draftState) => {
        if (next.snapshot.ready[side]) {
          return {
            roomCode: next.code,
            side,
            locations: createSetupDraft(next.snapshot.pieces, side, true),
          };
        }
        if (
          draftState?.roomCode === next.code &&
          draftState.side === side &&
          isValidSetupDraft(next.snapshot.pieces, side, draftState.locations)
        ) {
          return draftState;
        }
        const restored = restoreSetupDraft(
          readLocalValue(setupDraftKey(next.code, side)),
          next.snapshot.pieces,
          side,
        );
        return {
          roomCode: next.code,
          side,
          locations:
            restored ?? createSetupDraft(next.snapshot.pieces, side, hasSetupHistory),
        };
      });
    } else {
      setSetupDraftState(null);
    }
    roomRef.current = next;
    setRoom(next);
    return true;
  }

  function clearRoom() {
    roomSessionRef.current += 1;
    busyRef.current = false;
    setBusy(false);
    setSelectedPieceId(null);
    setSetupDraftState(null);
    setRulesOpen(false);
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
  }, []);

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

  async function createRoom() {
    if (creatingRef.current) return;
    creatingRef.current = true;
    clearRoom();
    const session = roomSessionRef.current;
    setToken(null);
    setInviteToken(null);
    setCreating(true);
    setFatalError(null);
    try {
      const response = await fetch("/api/rooms", { method: "POST" });
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

  async function performAction(action: PlayerAction) {
    const current = roomRef.current;
    if (!current || !token || !isPlayer(current.viewer) || busyRef.current) return;
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
    if (!room || !selectedPieceId || !isPlayer(room.viewer)) return [] as Position[];
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
          ),
      );
    }
    return [] as Position[];
  }, [activeSetupDraft, room, selectedPieceId, selectedPosition]);

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
    if (!room || !isPlayer(room.viewer)) return false;
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
    if (!room || busy || !isPlayer(room.viewer)) return;
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
    if (room.snapshot.turn !== room.viewer) {
      showToast(ERROR_TEXT.NOT_YOUR_TURN);
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
    if (!room || !isPlayer(room.viewer)) return;
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
    const locations = randomizeSetupDraft(room.snapshot.pieces, setupSide);
    setSetupDraftState({ roomCode: room.code, side: setupSide, locations });
    setSelectedPieceId(null);
  }

  function toggleSetupReady() {
    if (!room || !setupSide || !activeSetupDraft || busy) return;
    if (room.snapshot.ready[setupSide]) {
      void performAction({ type: "ready", value: false });
      return;
    }
    if (!isValidSetupDraft(room.snapshot.pieces, setupSide, activeSetupDraft, true)) {
      showToast(
        placedSetupCount !== undefined && placedSetupCount < 25
          ? `还需放置 ${25 - placedSetupCount} 枚棋子。`
          : ERROR_TEXT.INVALID_LAYOUT,
      );
      return;
    }
    const layout = setupDraftToLayout(room.snapshot.pieces, setupSide, activeSetupDraft);
    void performAction({ type: "ready", value: true, layout });
  }

  async function copyLink(kind: "player" | "spectator") {
    if (!room) return;
    const base = `${window.location.origin}/?room=${room.code}`;
    const link = kind === "player" && inviteToken ? `${base}#invite=${inviteToken}` : `${base}&watch=1`;
    try {
      await navigator.clipboard.writeText(link);
      showToast(kind === "player" ? "玩家邀请已复制" : "观战链接已复制");
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
      <main className="loading-screen">
        <span className="loading-mark">Q</span>
        <p>正在展开棋盘</p>
      </main>
    );
  }

  if (!room) {
    return (
      <>
        <Landing onCreate={createRoom} creating={creating} onOpen={openRoom} />
        {fatalError ? <div className="toast error-toast" role="alert" aria-live="assertive">{fatalError}</div> : null}
      </>
    );
  }

  const game = room.snapshot;
  const viewerSide = isPlayer(room.viewer) ? room.viewer : null;
  const orientationFlipped = viewerSide === "white" ? !flipped : flipped;
  const topSide: Side = orientationFlipped ? "black" : "white";
  const bottomSide: Side = topSide === "black" ? "white" : "black";
  const aliveCount = (side: Side) => game.pieces.filter((piece) => piece.alive && piece.side === side).length;
  const visiblePieceCount = (side: Side) =>
    game.phase === "setup" && viewerSide === side && placedSetupCount !== undefined
      ? placedSetupCount
      : aliveCount(side);
  const seatState = (side: Side) => {
    if (game.phase === "setup") return game.ready[side] ? "已锁定" : game.joined[side] ? "布阵中" : "未进入";
    if (game.phase === "finished") return !game.winner ? "和棋" : game.winner === side ? "获胜" : "落败";
    return game.turn === side ? "行动" : "等待";
  };
  const lastEvents = [...game.events].reverse().slice(0, 6);

  return (
    <main className="room-page">
      <header className="room-header">
        <button className="wordmark wordmark-button" type="button" onClick={leaveRoom}>
          <span className="wordmark-mark">Q</span>
          <span>The Queen&apos;s Gambit</span>
        </button>
        <div className="room-identity">
          <span className="room-code">{displayCode(room.code)}</span>
          <span className={`connection ${connection}`}>{connection === "offline" ? "正在重连" : room.viewer === "spectator" ? "观战模式" : sideName(room.viewer)}</span>
        </div>
        <div className="header-actions">
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
          <button className="icon-button" type="button" onClick={() => setFlipped((value) => !value)} aria-label="旋转棋盘">↻</button>
        </div>
      </header>

      <section className={`game-shell ${game.phase === "setup" ? "is-setup" : ""}`}>
        <aside className="side-panel setup-panel">
          <h2>{statusText(room, placedSetupCount)}</h2>
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
              <button className="button primary" type="button" disabled={busy} onClick={toggleSetupReady}>
                {game.ready[viewerSide] ? "撤销确认" : "完成布阵"}
              </button>
            </div>
          ) : null}
          {viewerSide && game.phase === "playing" ? (
            <details className="quiet-menu">
              <summary>本局选项</summary>
               <button
                 type="button"
                 onClick={() => {
                   if (window.confirm("确定认输并结束本局吗？")) void performAction({ type: "resign" });
                 }}
               >
                 认输
               </button>
            </details>
          ) : null}
        </aside>

        <section className="board-column">
          <div className={`player-strip ${game.turn === topSide && game.phase === "playing" ? "active" : ""}`}>
            <span>{sideName(topSide)}</span><span>{visiblePieceCount(topSide)} / 25</span>
          </div>
          <Board
            game={game}
            pieces={renderPieces}
            viewer={room.viewer}
            selected={selectedPosition}
            targets={targetKeys}
            flipped={orientationFlipped}
            busy={busy}
            onCell={handleCell}
            onPieceDragStart={beginBoardPieceDrag}
            onPieceDrop={handlePieceDrop}
            onPieceDragEnd={handlePieceDragEnd}
          />
          <div className={`player-strip ${game.turn === bottomSide && game.phase === "playing" ? "active" : ""}`}>
            <span>{sideName(bottomSide)}</span><span>{visiblePieceCount(bottomSide)} / 25</span>
          </div>
        </section>

        <aside className="side-panel activity-panel">
          <div className="invite-block">
            {room.viewer === "black" && inviteToken && !game.joined.white ? (
              <button className="button primary compact" type="button" onClick={() => void copyLink("player")}>复制玩家邀请</button>
            ) : null}
            <button className="button secondary compact" type="button" onClick={() => void copyLink("spectator")}>复制观战链接</button>
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
          <h2 id="game-rules-title" ref={rulesTitleRef} tabIndex={-1}>暗军棋规则</h2>
          <form method="dialog">
            <button className="rules-close" type="submit">关闭</button>
          </form>
        </div>
        <div className="rules-list">
          <section>
            <h3>目标</h3>
            <p>夺取对方军旗、使对方无合法着法，或对方认输即可获胜。没有自动和棋或回合上限。</p>
          </section>
          <section>
            <h3>暗棋</h3>
            <p>对手棋型在本局结束前保持隐藏，已经暴露的军旗除外。</p>
          </section>
          <section>
            <h3>布阵</h3>
            <p>棋子只能放在本方兵站或大本营，行营必须留空。军旗只能在大本营；地雷只能在最后两排；炸弹不能在第一排。双方确认后随机决定先手。</p>
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
        </div>
      </dialog>
      {toast ? <div className="toast" role="alert" aria-live="assertive">{toast}</div> : null}
    </main>
  );
}
