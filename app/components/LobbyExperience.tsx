"use client";

import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type FormEvent,
} from "react";

import styles from "./LobbyExperience.module.css";
import {
  INITIAL_LOBBY_SCENE,
  LOBBY_ENTRY_SESSION_KEY,
  markLobbyEntered,
  playerHandleErrorMessage,
  recentWinRateFor,
  reduceLobbyScene,
  shouldShowLobbyEntry,
  type LobbyLane,
  type LobbySceneAction,
} from "./lobbyScene";

export type { LobbyLane } from "./lobbyScene";
export type LobbyGameMode = "classic" | "augment";
export type LobbySpectatorPolicy = "hidden" | "full";

export interface LobbySessionUser {
  displayName: string;
}

export interface LobbyAccountSummary {
  handle: string;
  rating: number;
  rank: {
    label: string;
    progress: number;
  };
  record: {
    games: number;
    rankedGames: number;
    wins: number;
    losses: number;
    draws: number;
    winRate: number;
  };
}

export interface LobbyRecentMatch {
  id: string;
  opponentHandle: string;
  outcome: "win" | "loss" | "draw";
  ratingDelta: number;
  endedReason: string | null;
  completedAt: number;
}

export interface LobbyFriendEntry {
  relationshipId: string;
  player: {
    handle: string;
    rating: number;
    rank: { label: string };
  };
  presence: "online" | "searching" | "in_game" | "offline";
  currentMatchId: string | null;
}

export interface LobbyFriendsEnvelope {
  friends: LobbyFriendEntry[];
  incoming: Array<{ requestId: string; player: { handle: string } }>;
  outgoing: Array<{ requestId: string; player: { handle: string } }>;
}

export interface LobbyMatchmakingEnvelope {
  state: "idle" | "queued" | "matched";
  queuedAt?: number;
  ratingRange?: number;
  match?: {
    id: string;
    side: "black" | "white";
    opponent: { handle: string };
    game: { status: "pending_provisioning" | "ready"; code: string | null };
    setupDeadlineAt?: number | null;
  };
}

export interface LobbyExperienceProps {
  user: LobbySessionUser;
  signOutPath: string;
  account: LobbyAccountSummary | null;
  recentMatches: readonly LobbyRecentMatch[];
  friends: LobbyFriendsEnvelope;
  matchmaking: LobbyMatchmakingEnvelope;
  watchingMatchId: string | null;
  creating: boolean;
  /** Invite, spectate, and room-recovery routes can opt out of the ceremonial gate. */
  skipEntryGate?: boolean;
  entryStorageKey?: string;
  onCreate: (
    mode: LobbyGameMode,
    spectatorPolicy: LobbySpectatorPolicy,
  ) => void | Promise<void>;
  onOpen: (code: string) => void | Promise<void>;
  onMatchmaking: () => void | Promise<void>;
  onCancelMatchmaking: () => void | Promise<void>;
  onFriendRequest: (handle: string) => void | Promise<void>;
  onAcceptFriend: (requestId: string) => void | Promise<void>;
  onWatchFriend: (matchId: string) => void | Promise<void>;
  onUpdateHandle: (handle: string) => void | Promise<void>;
}

const ENTRY_MOTION_MS = 780;
const LANE_OPEN_MOTION_MS = 650;
const LANE_CLOSE_MOTION_MS = 480;

function cleanRoomCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

function displayRoomCode(value: string) {
  const clean = cleanRoomCode(value);
  return clean.length > 4 ? `${clean.slice(0, 4)} ${clean.slice(4)}` : clean;
}

function matchOutcomeLabel(outcome: LobbyRecentMatch["outcome"]) {
  if (outcome === "win") return "胜";
  if (outcome === "loss") return "负";
  return "和";
}

function matchDate(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
  }).format(new Date(timestamp));
}

function presenceLabel(presence: LobbyFriendEntry["presence"]) {
  if (presence === "in_game") return "对局中";
  if (presence === "searching") return "匹配中";
  if (presence === "online") return "在线";
  return "离线";
}

function actionErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return "";
  if ("code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.message : "";
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return reduced;
}

function HandleEditor({
  accountHandle,
  onUpdateHandle,
}: {
  accountHandle: string | null;
  onUpdateHandle: (handle: string) => void | Promise<void>;
}) {
  const [handle, setHandle] = useState(accountHandle ?? "");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const normalized = handle.trim().normalize("NFKC");
    const characters = Array.from(normalized);
    if (
      characters.length < 3 ||
      characters.length > 16 ||
      !/^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(normalized)
    ) {
      setMessage("玩家 ID 需为 3–16 个字母、数字、下划线或连字符。");
      return;
    }
    if (normalized === accountHandle) {
      setMessage("这已经是你现在的玩家 ID。");
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      await onUpdateHandle(normalized);
      setHandle(normalized);
      setMessage("玩家 ID 已更新。");
    } catch (error) {
      const code = actionErrorCode(error);
      setMessage(playerHandleErrorMessage(code));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className={styles.handleForm} onSubmit={submit}>
      <label htmlFor="player-handle">玩家 ID</label>
      <div>
        <input
          id="player-handle"
          maxLength={16}
          autoComplete="nickname"
          value={handle}
          disabled={accountHandle === null || pending}
          onChange={(event) => {
            setHandle(event.target.value);
            setMessage(null);
          }}
        />
        <button type="submit" disabled={accountHandle === null || pending}>
          {pending ? "保存中…" : "保存"}
        </button>
      </div>
      {message ? <small role="status">{message}</small> : null}
    </form>
  );
}

export default function LobbyExperience({
  signOutPath,
  account,
  recentMatches,
  friends,
  matchmaking,
  watchingMatchId,
  creating,
  skipEntryGate = false,
  entryStorageKey = LOBBY_ENTRY_SESSION_KEY,
  onCreate,
  onOpen,
  onMatchmaking,
  onCancelMatchmaking,
  onFriendRequest,
  onAcceptFriend,
  onWatchFriend,
  onUpdateHandle,
}: LobbyExperienceProps) {
  const [scene, dispatch] = useReducer(reduceLobbyScene, INITIAL_LOBBY_SCENE);
  const [roomCode, setRoomCode] = useState("");
  const [classicSpectators, setClassicSpectators] =
    useState<LobbySpectatorPolicy>("hidden");
  const [wildSpectators, setWildSpectators] =
    useState<LobbySpectatorPolicy>("hidden");
  const [friendHandle, setFriendHandle] = useState("");
  const [friendSubmitting, setFriendSubmitting] = useState(false);
  const reducedMotion = useReducedMotion();
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const enteredFromGateRef = useRef(false);
  const laneButtonRefs = useRef<Record<LobbyLane, HTMLButtonElement | null>>({
    classic: null,
    wild: null,
    personal: null,
  });

  const recentTen = useMemo(() => recentMatches.slice(0, 10), [recentMatches]);
  const recentWinRate = useMemo(
    () => recentWinRateFor(recentMatches.map((match) => match.outcome)),
    [recentMatches],
  );
  const onlineFriends = friends.friends.filter((friend) => friend.presence !== "offline").length;
  const searching = matchmaking.state === "queued";

  useEffect(() => {
    dispatch({
      type: "INITIALIZE",
      showEntry: shouldShowLobbyEntry(window.sessionStorage, entryStorageKey, skipEntryGate),
    });
  }, [entryStorageKey, skipEntryGate]);

  useEffect(() => {
    let delay: number | null = null;
    let action: LobbySceneAction | null = null;
    if (scene.phase === "entry-opening") {
      delay = reducedMotion ? 0 : ENTRY_MOTION_MS;
      action = { type: "ENTRY_FINISHED" };
    } else if (scene.phase === "lane-opening") {
      delay = reducedMotion ? 0 : LANE_OPEN_MOTION_MS;
      action = { type: "LANE_OPENED" };
    } else if (scene.phase === "lane-closing") {
      delay = reducedMotion ? 0 : LANE_CLOSE_MOTION_MS;
      action = { type: "LANE_CLOSED" };
    }
    if (delay === null || !action) return;
    const timer = window.setTimeout(() => dispatch(action!), delay);
    return () => window.clearTimeout(timer);
  }, [reducedMotion, scene.phase]);

  useEffect(() => {
    if (scene.phase === "lane") backButtonRef.current?.focus();
    if (scene.phase === "hub" && scene.lastLane) {
      laneButtonRefs.current[scene.lastLane]?.focus();
    } else if (scene.phase === "hub" && enteredFromGateRef.current) {
      enteredFromGateRef.current = false;
      laneButtonRefs.current.classic?.focus();
    }
  }, [scene.lastLane, scene.phase]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (scene.phase !== "lane" && scene.phase !== "lane-opening") return;
      event.preventDefault();
      dispatch({ type: "CLOSE_LANE" });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [scene.phase]);

  function enterLobby() {
    markLobbyEntered(window.sessionStorage, entryStorageKey);
    enteredFromGateRef.current = true;
    dispatch({ type: "ENTER" });
  }

  function openLane(lane: LobbyLane) {
    dispatch({ type: "OPEN_LANE", lane });
  }

  function submitRoomCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = cleanRoomCode(roomCode);
    if (code.length === 8) void onOpen(code);
  }

  async function submitFriend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const requestedHandle = friendHandle.trim();
    if (!requestedHandle || friendSubmitting) return;
    setFriendSubmitting(true);
    try {
      await onFriendRequest(requestedHandle);
      setFriendHandle("");
    } finally {
      setFriendSubmitting(false);
    }
  }

  const laneVisible = scene.lane !== null && ["lane-opening", "lane", "lane-closing"].includes(scene.phase);

  return (
    <main
      className={styles.shell}
      data-phase={scene.phase}
      data-reduced-motion={reducedMotion ? "true" : "false"}
    >
      <div className={styles.paperTexture} aria-hidden="true" />

      <header className={styles.header}>
        <div className={styles.wordmark} aria-label="军令陆战棋">
          <span className={styles.wordmarkSeal} aria-hidden="true">令</span>
          <span>军令 · 陆战棋</span>
        </div>
        <div className={styles.accountSummary}>
          <span>{account?.handle ?? "棋手"}</span>
          <small>{account?.rank.label ?? "战绩同步中"}</small>
        </div>
      </header>

      <section
        className={styles.hub}
        aria-hidden={scene.phase !== "hub" ? "true" : undefined}
        inert={scene.phase !== "hub"}
      >
        <div className={styles.hubHeading}>
          <span>选择你的战局</span>
          <h1>三道军门</h1>
        </div>

        <div className={styles.compassStage}>
          <div className={styles.compass} aria-hidden="true">
            <span className={styles.compassOuter} />
            <span className={styles.compassInner} />
            <span className={styles.compassNeedle} />
          </div>
          <div className={styles.tuckBox} aria-hidden="true">
            <span className={styles.tuckFlap} />
            <span className={styles.tuckFace}><i>令</i></span>
          </div>

          <button
            ref={(node) => { laneButtonRefs.current.classic = node; }}
            className={`${styles.laneButton} ${styles.laneClassic}`}
            type="button"
            onClick={() => openLane("classic")}
          >
            <span>经典</span>
          </button>
          <button
            ref={(node) => { laneButtonRefs.current.wild = node; }}
            className={`${styles.laneButton} ${styles.laneWild}`}
            type="button"
            onClick={() => openLane("wild")}
          >
            <span>狂野</span>
          </button>
          <button
            ref={(node) => { laneButtonRefs.current.personal = node; }}
            className={`${styles.laneButton} ${styles.lanePersonal}`}
            type="button"
            onClick={() => openLane("personal")}
          >
            <span>个人</span>
          </button>
        </div>

        <form className={styles.roomCodeForm} onSubmit={submitRoomCode}>
          <label htmlFor="lobby-room-code">已有房间码</label>
          <div>
            <input
              id="lobby-room-code"
              autoComplete="off"
              inputMode="text"
              maxLength={9}
              placeholder="八位房间码"
              value={displayRoomCode(roomCode)}
              onChange={(event) => setRoomCode(cleanRoomCode(event.target.value))}
            />
            <button type="submit" disabled={cleanRoomCode(roomCode).length !== 8}>进入</button>
          </div>
        </form>
      </section>

      {laneVisible ? (
        <section
          className={`${styles.laneScene} ${
            scene.phase === "lane-opening"
              ? styles.laneSceneOpening
              : scene.phase === "lane-closing"
                ? styles.laneSceneClosing
                : styles.laneSceneOpen
          }`}
          aria-label={scene.lane === "classic" ? "经典" : scene.lane === "wild" ? "狂野" : "个人"}
          aria-busy={scene.phase !== "lane"}
          inert={scene.phase !== "lane"}
        >
          <button
            ref={backButtonRef}
            className={styles.backButton}
            type="button"
            aria-label="返回三道军门"
            onClick={() => dispatch({ type: "CLOSE_LANE" })}
          >
            <span aria-hidden="true">←</span>
            返回
          </button>

          {scene.lane === "classic" ? (
            <div className={styles.laneContent}>
              <div className={styles.laneTitle}>
                <span>原版规则 · 好友对局</span>
                <h2>经典</h2>
                <p>没有额外军令，只有布阵、判断与耐心。</p>
              </div>
              <div className={styles.playCard}>
                <span className={styles.cardSuit} aria-hidden="true">♠</span>
                <h3>建立好友房</h3>
                <p>创建后把房间码或邀请链接交给对手。好友房不改变排位分。</p>
                <label className={styles.field}>
                  <span>观战权限</span>
                  <select
                    value={classicSpectators}
                    onChange={(event) => setClassicSpectators(event.target.value as LobbySpectatorPolicy)}
                  >
                    <option value="hidden">隐藏双方暗牌</option>
                    <option value="full">允许明牌观战</option>
                  </select>
                </label>
                <button
                  className={styles.primaryAction}
                  type="button"
                  disabled={creating}
                  onClick={() => void onCreate("classic", classicSpectators)}
                >
                  {creating ? "正在开门…" : "创建经典好友房"}
                </button>
              </div>
            </div>
          ) : null}

          {scene.lane === "wild" ? (
            <div className={styles.laneContent}>
              <div className={styles.laneTitle}>
                <span>公平三选一 · 七十张军令</span>
                <h2>狂野</h2>
                <p>布阵前与第十手前各选一张军令，同等级、不同抉择。</p>
              </div>
              <div className={styles.wildGrid}>
                <article className={styles.playCard}>
                  <span className={styles.cardSuit} aria-hidden="true">♣</span>
                  <h3>排位匹配</h3>
                  <p>十分钟基础用时；落子后余时不超过五分钟，每步增加五秒。</p>
                  <div className={styles.rankLine}>
                    <span>{account?.rank.label ?? "—"}</span>
                    <strong>{account?.rating ?? "—"} 分</strong>
                  </div>
                  <button
                    className={styles.primaryAction}
                    type="button"
                    disabled={matchmaking.state === "matched"}
                    onClick={() => void (searching ? onCancelMatchmaking() : onMatchmaking())}
                  >
                    {matchmaking.state === "matched"
                      ? "正在进入棋局…"
                      : searching
                        ? `取消匹配 · ±${matchmaking.ratingRange ?? 100}`
                        : "开始排位匹配"}
                  </button>
                </article>
                <article className={styles.playCard}>
                  <span className={styles.cardSuit} aria-hidden="true">♦</span>
                  <h3>狂野好友房</h3>
                  <p>与熟人体验完整军令牌池，不记录排位分。</p>
                  <label className={styles.field}>
                    <span>观战权限</span>
                    <select
                      value={wildSpectators}
                      onChange={(event) => setWildSpectators(event.target.value as LobbySpectatorPolicy)}
                    >
                      <option value="hidden">隐藏双方暗牌</option>
                      <option value="full">允许明牌观战</option>
                    </select>
                  </label>
                  <button
                    className={styles.secondaryAction}
                    type="button"
                    disabled={creating}
                    onClick={() => void onCreate("augment", wildSpectators)}
                  >
                    {creating ? "正在开门…" : "创建狂野好友房"}
                  </button>
                </article>
              </div>
              <details className={styles.rulesNote}>
                <summary>狂野如何开局</summary>
                <p>每轮从三张同等级军令中选择一张；选择立即锁定。牌面只在规则允许的时刻公开，暗棋身份仍受保护。</p>
              </details>
            </div>
          ) : null}

          {scene.lane === "personal" ? (
            <div className={`${styles.laneContent} ${styles.personalContent}`}>
              <div className={styles.laneTitle}>
                <span>{account?.rank.label ?? "资料同步中"} · {account?.rating ?? "—"} 分</span>
                <h2>个人</h2>
                <p>你的战绩、同行者与正在发生的棋局。</p>
              </div>

              <div className={styles.personalGrid}>
                <section className={styles.profilePanel} aria-labelledby="profile-title">
                  <div className={styles.panelHeading}>
                    <h3 id="profile-title">玩家资料</h3>
                    <span>{account?.record.games ?? 0} 局</span>
                  </div>
                  <HandleEditor
                    key={account?.handle ?? "loading"}
                    accountHandle={account?.handle ?? null}
                    onUpdateHandle={onUpdateHandle}
                  />
                  <div className={styles.stats}>
                    <div>
                      <span>累计胜率</span>
                      <strong>{account ? `${Math.round(account.record.winRate * 100)}%` : "—"}</strong>
                    </div>
                    <div>
                      <span>最近十局</span>
                      <strong>{recentWinRate === null ? "—" : `${Math.round(recentWinRate * 100)}%`}</strong>
                    </div>
                    <div>
                      <span>排位局</span>
                      <strong>{account?.record.rankedGames ?? "—"}</strong>
                    </div>
                  </div>
                  <div className={styles.rankProgress} aria-label={`段位进度 ${Math.round((account?.rank.progress ?? 0) * 100)}%`}>
                    <span style={{ width: `${Math.round((account?.rank.progress ?? 0) * 100)}%` }} />
                  </div>
                  <a className={styles.signOutLink} href={signOutPath}>退出当前账号</a>
                </section>

                <section className={styles.historyPanel} aria-labelledby="history-title">
                  <div className={styles.panelHeading}>
                    <h3 id="history-title">最近战绩</h3>
                    <span>近十局</span>
                  </div>
                  <ol className={styles.historyList}>
                    {recentTen.length ? recentTen.map((match) => (
                      <li key={match.id}>
                        <span className={styles.outcome}>{matchOutcomeLabel(match.outcome)}</span>
                        <span>
                          <strong>{match.opponentHandle}</strong>
                          <small>{match.outcome === "draw" && match.endedReason === "threefold_repetition" ? "重复局面" : matchDate(match.completedAt)}</small>
                        </span>
                        <em>{match.ratingDelta > 0 ? "+" : ""}{match.ratingDelta}</em>
                      </li>
                    )) : <li className={styles.emptyRow}>完成第一局后，这里会出现你的战绩。</li>}
                  </ol>
                </section>

                <section className={styles.friendsPanel} aria-labelledby="friends-title">
                  <div className={styles.panelHeading}>
                    <h3 id="friends-title">好友</h3>
                    <span>{onlineFriends} 人在线</span>
                  </div>
                  <form className={styles.friendForm} onSubmit={submitFriend}>
                    <label htmlFor="friend-handle">添加好友</label>
                    <div>
                      <input
                        id="friend-handle"
                        value={friendHandle}
                        placeholder="输入玩家 ID"
                        disabled={friendSubmitting}
                        onChange={(event) => setFriendHandle(event.target.value)}
                      />
                      <button type="submit" disabled={!friendHandle.trim() || friendSubmitting}>
                        {friendSubmitting ? "发送中…" : "发送"}
                      </button>
                    </div>
                  </form>

                  {friends.incoming.length ? (
                    <div className={styles.requests}>
                      <h4>收到的请求</h4>
                      {friends.incoming.map((request) => (
                        <div key={request.requestId}>
                          <span>{request.player.handle}</span>
                          <button type="button" onClick={() => void onAcceptFriend(request.requestId)}>接受</button>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {friends.outgoing.length ? (
                    <div className={styles.outgoing}>
                      <h4>等待回应</h4>
                      <p>{friends.outgoing.map((request) => request.player.handle).join("、")}</p>
                    </div>
                  ) : null}

                  <ul className={styles.friendList}>
                    {friends.friends.length ? friends.friends.map((friend) => (
                      <li key={friend.relationshipId}>
                        <span className={styles.presence} data-presence={friend.presence} aria-hidden="true" />
                        <span>
                          <strong>{friend.player.handle}</strong>
                          <small>{friend.player.rank.label} · {presenceLabel(friend.presence)}</small>
                        </span>
                        {friend.presence === "in_game" && friend.currentMatchId ? (
                          <button
                            type="button"
                            disabled={watchingMatchId !== null}
                            aria-busy={watchingMatchId === friend.currentMatchId}
                            onClick={() => void onWatchFriend(friend.currentMatchId!)}
                          >
                            {watchingMatchId === friend.currentMatchId ? "进入中…" : "观战"}
                          </button>
                        ) : null}
                      </li>
                    )) : <li className={styles.emptyRow}>添加好友后，可以看到对方是否在线。</li>}
                  </ul>
                </section>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {scene.phase === "checking" || scene.phase === "entry" || scene.phase === "entry-opening" ? (
        <section
          className={`${styles.entryGate} ${scene.phase === "entry-opening" ? styles.entryGateOpening : ""}`}
          aria-label="开始游戏"
          aria-busy={scene.phase === "checking"}
        >
          <div className={`${styles.courtDoor} ${styles.queenDoor}`} aria-hidden="true" />
          <div className={`${styles.courtDoor} ${styles.kingDoor}`} aria-hidden="true" />
          {scene.phase !== "checking" ? (
            <div className={styles.entryInvitation}>
              <span>欢迎归阵，{account?.handle ?? "棋手"}</span>
              <h1>军令陆战棋</h1>
              <p>经典谋略与七十张军令，皆在门后。</p>
              <button type="button" onClick={enterLobby}>开始游戏</button>
            </div>
          ) : <span className={styles.loadingMark} aria-label="正在准备大厅">令</span>}
        </section>
      ) : null}

      <p className={styles.liveRegion} aria-live="polite">
        {scene.phase === "lane-opening" ? "正在开启" : scene.phase === "lane-closing" ? "正在返回大厅" : ""}
      </p>
    </main>
  );
}
