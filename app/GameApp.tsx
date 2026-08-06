"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CAMPS,
  HEADQUARTERS,
  PIECE_INFO,
  getProjectedLegalTargets,
  getProjectedMoveViolation,
  getProjectedSetupSwapViolation,
  isCamp,
  isHeadquarters,
  isRailEdge,
  isRoadEdge,
  positionKey,
  samePosition,
  type PlayerAction,
  type Position,
  type ProjectedGame,
  type PublicEvent,
  type PublicPiece,
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
  INVALID_SWAP: "请选择两枚自己的棋子。",
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
  NO_PIECE_AT_SOURCE: "请先选择一枚自己的棋子。",
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

function statusText(room: RoomEnvelope) {
  const { snapshot, viewer } = room;
  if (snapshot.phase === "setup") {
    if (viewer === "spectator") return "双方正在秘密布阵";
    if (snapshot.ready[viewer]) return "阵型已锁定，等待对手";
    return "点击两枚棋子交换位置";
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

function PieceModel({ piece }: { piece: PublicPiece }) {
  const known = Boolean(piece.type);
  const info = piece.type ? PIECE_INFO[piece.type] : null;
  return (
    <span
      className={`piece-model side-${piece.side} ${known ? "is-known" : "is-hidden"}`}
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

interface BoardProps {
  game: ProjectedGame;
  viewer: Viewer;
  selected: Position | null;
  targets: Set<string>;
  flipped: boolean;
  busy: boolean;
  onCell: (position: Position) => void;
}

function Board({ game, viewer, selected, targets, flipped, busy, onCell }: BoardProps) {
  const cells = [];
  for (let row = 0; row < 12; row += 1) {
    for (let col = 0; col < 5; col += 1) cells.push({ row, col });
  }
  const alivePieces = game.pieces.filter((piece) => piece.alive);

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
        const right = { row, col: col + 1 };
        const down = { row: row + 1, col };
        const downRight = { row: row + 1, col: col + 1 };
        const downLeft = { row: row + 1, col: col - 1 };
        const hasVertical = row < 11 && isRoadEdge(position, down);
        const pieceLabel = piece?.type ? PIECE_INFO[piece.type].label : piece ? "暗子" : "空位";
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
              className={`station-hit ${selectedHere ? "is-selected" : ""} ${targetHere ? "is-target" : ""} ${targetAttack ? "is-attack" : ""}`}
              type="button"
              onClick={() => onCell(position)}
              disabled={viewer === "spectator" || busy}
              aria-label={`${coordinates(position)}，${pieceLabel}`}
            >
              <span className={`station ${camp ? "camp" : headquarters ? "headquarters" : "post"}`} />
              {targetHere && !piece ? <span className="target-dot" /> : null}
              {piece ? <PieceModel piece={piece} /> : null}
            </button>
          </div>
        );
      })}
    </div>
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
  const [selected, setSelected] = useState<Position | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(hasRoom);
  const [creating, setCreating] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [connection, setConnection] = useState<"live" | "syncing" | "offline">("live");
  const roomRef = useRef<RoomEnvelope | null>(null);
  const roomSessionRef = useRef(0);
  const busyRef = useRef(false);
  const creatingRef = useRef(false);
  const toastTimerRef = useRef<number | null>(null);

  useEffect(() => {
    roomRef.current = room;
  }, [room]);

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
    if (!current || current.code !== next.code || current.version !== next.version) setSelected(null);
    roomRef.current = next;
    setRoom(next);
    return true;
  }

  function clearRoom() {
    roomSessionRef.current += 1;
    busyRef.current = false;
    setBusy(false);
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
      setSelected(null);
    } catch (error) {
      if (session !== roomSessionRef.current || roomRef.current?.code !== current.code) return;
      if (error instanceof RequestError && error.status === 409) {
        setSelected(null);
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
        setSelected(null);
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

  const legalTargets = useMemo(() => {
    if (!room || !selected || !isPlayer(room.viewer)) return [] as Position[];
    if (room.snapshot.phase === "playing") {
      return getProjectedLegalTargets(room.snapshot, room.viewer, selected);
    }
    if (room.snapshot.phase === "setup" && !room.snapshot.ready[room.viewer]) {
      const selectedPiece = room.snapshot.pieces.find((piece) => piece.alive && samePosition(piece, selected));
      if (!selectedPiece?.type) return [];
      return room.snapshot.pieces
        .filter((piece) => piece.alive && piece.side === room.viewer && piece.type)
        .filter((piece) => !getProjectedSetupSwapViolation(room.snapshot, room.viewer as Side, selected, piece))
        .map(({ row, col }) => ({ row, col }));
    }
    return [] as Position[];
  }, [room, selected]);

  const targetKeys = useMemo(() => new Set(legalTargets.map(positionKey)), [legalTargets]);

  function handleCell(position: Position) {
    if (!room || busy || !isPlayer(room.viewer)) return;
    const piece = room.snapshot.pieces.find((candidate) => candidate.alive && samePosition(candidate, position));
    if (room.snapshot.phase === "setup") {
      if (room.snapshot.ready[room.viewer]) {
        showToast(ERROR_TEXT.LAYOUT_LOCKED);
        return;
      }
      if (!selected) {
        if (isCamp(position)) showToast(ERROR_TEXT.CAMP_MUST_BE_EMPTY);
        else if (piece?.side === room.viewer) setSelected(position);
        else showToast(ERROR_TEXT.INVALID_SWAP);
        return;
      }
      if (samePosition(selected, position)) {
        setSelected(null);
        return;
      }
      const violation = getProjectedSetupSwapViolation(room.snapshot, room.viewer, selected, position);
      if (violation) showToast(ERROR_TEXT[violation] ?? ERROR_TEXT.INVALID_LAYOUT);
      else void performAction({ type: "swap", from: selected, to: position });
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
      if (selected && samePosition(selected, position)) {
        setSelected(null);
      } else if (piece.type === "flag") {
        showToast(ERROR_TEXT.FLAG_CANNOT_MOVE);
      } else if (piece.type === "mine") {
        showToast(ERROR_TEXT.MINE_CANNOT_MOVE);
      } else if (isHeadquarters(position)) {
        showToast(ERROR_TEXT.HEADQUARTERS_LOCKED);
      } else {
        setSelected(position);
      }
      return;
    }
    if (!selected) {
      showToast(ERROR_TEXT.NO_PIECE_AT_SOURCE);
      return;
    }
    const violation = getProjectedMoveViolation(room.snapshot, room.viewer, selected, position);
    if (violation) showToast(ERROR_TEXT[violation] ?? ERROR_TEXT.ACTION_FAILED);
    else void performAction({ type: "move", from: selected, to: position });
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
    setSelected(null);
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
        <button className="icon-button" type="button" onClick={() => setFlipped((value) => !value)} aria-label="旋转棋盘">↻</button>
      </header>

      <section className="game-shell">
        <aside className="side-panel setup-panel">
          <h2>{statusText(room)}</h2>
          <div className="seat-list">
            {(["black", "white"] as Side[]).map((side) => (
              <div className={`seat ${game.turn === side && game.phase === "playing" ? "active" : ""}`} key={side}>
                <span className={`seat-stone ${side}`} />
                <div><strong>{sideName(side)}</strong><small>{aliveCount(side)} 枚棋子</small></div>
                <span className="seat-state">{seatState(side)}</span>
              </div>
            ))}
          </div>
          {viewerSide && game.phase === "setup" ? (
            <div className="setup-actions">
              <button className="button secondary" type="button" disabled={busy || game.ready[viewerSide]} onClick={() => void performAction({ type: "randomize" })}>随机布阵</button>
              <button className="button primary" type="button" disabled={busy} onClick={() => void performAction({ type: "ready", value: !game.ready[viewerSide] })}>
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
            <span>{sideName(topSide)}</span><span>{aliveCount(topSide)} / 25</span>
          </div>
          <Board game={game} viewer={room.viewer} selected={selected} targets={targetKeys} flipped={orientationFlipped} busy={busy} onCell={handleCell} />
          <div className={`player-strip ${game.turn === bottomSide && game.phase === "playing" ? "active" : ""}`}>
            <span>{sideName(bottomSide)}</span><span>{aliveCount(bottomSide)} / 25</span>
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
      {toast ? <div className="toast" role="alert" aria-live="assertive">{toast}</div> : null}
    </main>
  );
}
