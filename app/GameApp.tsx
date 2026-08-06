"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CAMPS,
  HEADQUARTERS,
  PIECE_INFO,
  getProjectedLegalTargets,
  isAllowedSetupPosition,
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
  INVALID_PLAYER_TOKEN: "这个玩家邀请已经失效。你仍可用观战链接进入。",
  VERSION_CONFLICT: "棋局刚刚更新，正在重新同步。",
  INVALID_LAYOUT: "这个交换不符合布阵规则。",
  INVALID_SWAP: "请选择两枚自己的棋子。",
  ILLEGAL_MOVE: "这一步不符合行棋规则。",
  LAYOUT_LOCKED: "阵型已经锁定。",
  GAME_FINISHED: "本局已经结束。",
  ACTION_FAILED: "这一步没有成功，请再试一次。",
  ROOM_CREATE_FAILED: "暂时无法创建房间，请稍后再试。",
  ROOM_CREATE_RATE_LIMITED: "创建得太频繁，请稍后再试。",
  INVALID_INVITE_TOKEN: "这个玩家邀请无效。",
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
  if (event.result === "game_started") return `${actor}获得先手`;
  if (event.result === "resigned") return `${actor}认输`;
  const path = event.from && event.to ? `${coordinates(event.from)} → ${coordinates(event.to)}` : "";
  if (event.result === "move") return `${actor}移动 · ${path}`;
  if (event.result === "attacker_survives") return `${actor}进攻成功 · ${path}`;
  if (event.result === "defender_survives") return `${actor}进攻失利 · ${path}`;
  if (event.result === "both_removed") return `双方同归于尽 · ${path}`;
  return `${actor}夺得军旗`;
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
    if (viewer === "spectator") return `${sideName(snapshot.winner)}获胜`;
    return snapshot.winner === viewer ? "你赢得了这局" : "对手赢得了这局";
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

  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(null), 2200);
  }

  async function loadInitialRoom(code: string, activeToken: string | null) {
    const envelope = await fetchRoom(code, activeToken);
    if (!envelope) throw new Error("EMPTY_ROOM_RESPONSE");
    setRoom(envelope);
    setToken(activeToken);
    setInviteToken(localStorage.getItem(inviteTokenKey(code)));
    setFlipped(false);
    setFatalError(null);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let code = "";
      try {
        const url = new URL(window.location.href);
        code = cleanCode(url.searchParams.get("room") ?? "");
        if (code.length !== 8) return;
        const watchOnly = url.searchParams.get("watch") === "1";
        const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
        const invitedToken = fragment.get("invite");
        const storedToken = localStorage.getItem(roomTokenKey(code));
        if (invitedToken && !watchOnly && !storedToken) {
          const candidateToken = localStorage.getItem(pendingTokenKey(code)) ?? createClientToken();
          localStorage.setItem(pendingTokenKey(code), candidateToken);
          let claimed: ClaimRoomEnvelope;
          try {
            claimed = await claimSeat(code, invitedToken, candidateToken);
          } catch (error) {
            if (error instanceof RequestError && error.code === "VERSION_CONFLICT") {
              claimed = await claimSeat(code, invitedToken, candidateToken);
            } else {
              throw error;
            }
          }
          if (cancelled) return;
          localStorage.setItem(roomTokenKey(code), candidateToken);
          localStorage.removeItem(pendingTokenKey(code));
          url.hash = "";
          window.history.replaceState(null, "", `${url.pathname}${url.search}`);
          setRoom({ code: claimed.code, version: claimed.version, viewer: claimed.viewer, snapshot: claimed.snapshot });
          setToken(candidateToken);
          setInviteToken(null);
          setFlipped(false);
          setFatalError(null);
          return;
        }
        if (invitedToken) {
          url.hash = "";
          window.history.replaceState(null, "", `${url.pathname}${url.search}`);
        }
        const activeToken = watchOnly ? null : storedToken;
        await loadInitialRoom(code, activeToken);
      } catch (error) {
        if (!cancelled) {
          const codeValue = error instanceof RequestError ? error.code : "ROOM_READ_FAILED";
          setFatalError(ERROR_TEXT[codeValue] ?? "暂时无法进入这个房间。");
          if (
            code &&
            error instanceof RequestError &&
            ([400, 401].includes(error.status) || error.code === "SEAT_ALREADY_CLAIMED")
          ) {
            localStorage.removeItem(pendingTokenKey(code));
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
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
    const poll = async () => {
      const current = roomRef.current;
      if (!current || stopped) return;
      try {
        const next = await fetchRoom(current.code, token, current.version);
        if (next && next.version >= current.version && !stopped) {
          setRoom(next);
        }
        if (!stopped) setConnection("live");
      } catch (error) {
        if (!stopped && error instanceof RequestError && [401, 404, 410].includes(error.status)) {
          stopped = true;
          setFatalError(ERROR_TEXT[error.code] ?? "这个房间已经不可用。");
          setRoom(null);
          return;
        }
        if (!stopped) setConnection("offline");
      } finally {
        if (!stopped) {
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
    setCreating(true);
    setFatalError(null);
    try {
      const response = await fetch("/api/rooms", { method: "POST" });
      const created = (await parseResponse(response)) as unknown as CreateRoomEnvelope;
      localStorage.setItem(roomTokenKey(created.code), created.playerToken);
      localStorage.setItem(inviteTokenKey(created.code), created.opponentInviteToken);
      window.history.replaceState(null, "", `/?room=${created.code}`);
      setToken(created.playerToken);
      setInviteToken(created.opponentInviteToken);
      setRoom({ code: created.code, version: created.version, viewer: created.viewer, snapshot: created.snapshot });
      setFlipped(false);
      showToast("房间已创建");
    } catch (error) {
      const errorCode = error instanceof RequestError ? error.code : "ROOM_CREATE_FAILED";
      setFatalError(ERROR_TEXT[errorCode] ?? ERROR_TEXT.ROOM_CREATE_FAILED);
    } finally {
      setCreating(false);
      setLoading(false);
    }
  }

  async function openRoom(code: string) {
    const normalized = cleanCode(code);
    if (normalized.length !== 8) return;
    setLoading(true);
    setFatalError(null);
    window.history.replaceState(null, "", `/?room=${normalized}&watch=1`);
    try {
      await loadInitialRoom(normalized, null);
    } catch (error) {
      const errorCode = error instanceof RequestError ? error.code : "ROOM_READ_FAILED";
      setFatalError(ERROR_TEXT[errorCode] ?? "暂时无法进入这个房间。");
    } finally {
      setLoading(false);
    }
  }

  async function performAction(action: PlayerAction) {
    const current = roomRef.current;
    if (!current || !token || !isPlayer(current.viewer) || busy) return;
    setBusy(true);
    setConnection("syncing");
    try {
      const next = await postAction(current.code, token, current.version, action);
      setRoom(next);
      setConnection("live");
      setSelected(null);
    } catch (error) {
      if (error instanceof RequestError && error.status === 409) {
        const latest = await fetchRoom(current.code, token);
        if (latest) setRoom(latest);
        setConnection("live");
      } else {
        const errorCode = error instanceof RequestError ? error.code : "ACTION_FAILED";
        showToast(ERROR_TEXT[errorCode] ?? ERROR_TEXT.ACTION_FAILED);
        setConnection(error instanceof RequestError ? "live" : "offline");
      }
    } finally {
      setBusy(false);
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
        .filter(
          (piece) =>
            isAllowedSetupPosition(selectedPiece.type!, room.viewer as Side, piece) &&
            isAllowedSetupPosition(piece.type!, room.viewer as Side, selected),
        )
        .map(({ row, col }) => ({ row, col }));
    }
    return [] as Position[];
  }, [room, selected]);

  const targetKeys = useMemo(() => new Set(legalTargets.map(positionKey)), [legalTargets]);

  function handleCell(position: Position) {
    if (!room || busy || !isPlayer(room.viewer)) return;
    const piece = room.snapshot.pieces.find((candidate) => candidate.alive && samePosition(candidate, position));
    if (room.snapshot.phase === "setup") {
      if (room.snapshot.ready[room.viewer]) return;
      if (!selected) {
        if (piece?.side === room.viewer) setSelected(position);
        return;
      }
      if (samePosition(selected, position)) {
        setSelected(null);
        return;
      }
      if (piece?.side === room.viewer && targetKeys.has(positionKey(position))) {
        void performAction({ type: "swap", from: selected, to: position });
      } else if (piece?.side === room.viewer) {
        setSelected(position);
      } else {
        setSelected(null);
      }
      return;
    }
    if (room.snapshot.phase !== "playing" || room.snapshot.turn !== room.viewer) return;
    if (piece?.side === room.viewer) {
      setSelected(selected && samePosition(selected, position) ? null : position);
      return;
    }
    if (selected && targetKeys.has(positionKey(position))) {
      void performAction({ type: "move", from: selected, to: position });
    } else {
      setSelected(null);
    }
  }

  async function copyLink(kind: "player" | "spectator") {
    if (!room) return;
    const base = `${window.location.origin}/?room=${room.code}`;
    const link = kind === "player" && inviteToken ? `${base}#invite=${inviteToken}` : `${base}&watch=1`;
    await navigator.clipboard.writeText(link);
    showToast(kind === "player" ? "玩家邀请已复制" : "观战链接已复制");
  }

  function leaveRoom() {
    setRoom(null);
    setSelected(null);
    setFatalError(null);
    setToken(null);
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
        {fatalError ? <div className="toast error-toast">{fatalError}</div> : null}
      </>
    );
  }

  const game = room.snapshot;
  const viewerSide = isPlayer(room.viewer) ? room.viewer : null;
  const orientationFlipped = viewerSide === "white" ? !flipped : flipped;
  const topSide: Side = orientationFlipped ? "black" : "white";
  const bottomSide: Side = topSide === "black" ? "white" : "black";
  const aliveCount = (side: Side) => game.pieces.filter((piece) => piece.alive && piece.side === side).length;
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
                <span className="seat-state">{game.phase === "setup" ? (game.ready[side] ? "已锁定" : game.joined[side] ? "布阵中" : "未进入") : game.turn === side ? "行动" : "等待"}</span>
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
              <button type="button" onClick={() => void performAction({ type: "resign" })}>认输</button>
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
      {toast ? <div className="toast">{toast}</div> : null}
    </main>
  );
}
