export type LobbyLane = "classic" | "wild" | "personal";

export type LobbyScenePhase =
  | "checking"
  | "entry"
  | "entry-opening"
  | "hub"
  | "lane-opening"
  | "lane"
  | "lane-closing";

export interface LobbySceneState {
  phase: LobbyScenePhase;
  lane: LobbyLane | null;
  lastLane: LobbyLane | null;
}

export type LobbySceneAction =
  | { type: "INITIALIZE"; showEntry: boolean }
  | { type: "ENTER" }
  | { type: "ENTRY_FINISHED" }
  | { type: "OPEN_LANE"; lane: LobbyLane }
  | { type: "LANE_OPENED" }
  | { type: "CLOSE_LANE" }
  | { type: "LANE_CLOSED" };

export const INITIAL_LOBBY_SCENE: LobbySceneState = {
  phase: "checking",
  lane: null,
  lastLane: null,
};

export function reduceLobbyScene(
  state: LobbySceneState,
  action: LobbySceneAction,
): LobbySceneState {
  switch (action.type) {
    case "INITIALIZE":
      if (state.phase !== "checking") return state;
      return { ...state, phase: action.showEntry ? "entry" : "hub" };
    case "ENTER":
      return state.phase === "entry" ? { ...state, phase: "entry-opening" } : state;
    case "ENTRY_FINISHED":
      return state.phase === "entry-opening" ? { ...state, phase: "hub" } : state;
    case "OPEN_LANE":
      return state.phase === "hub"
        ? { phase: "lane-opening", lane: action.lane, lastLane: action.lane }
        : state;
    case "LANE_OPENED":
      return state.phase === "lane-opening" ? { ...state, phase: "lane" } : state;
    case "CLOSE_LANE":
      return state.phase === "lane" || state.phase === "lane-opening"
        ? { ...state, phase: "lane-closing" }
        : state;
    case "LANE_CLOSED":
      return state.phase === "lane-closing"
        ? { ...state, phase: "hub", lane: null }
        : state;
    default:
      return state;
  }
}

export interface LobbySessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const LOBBY_ENTRY_SESSION_KEY = "junqi:lobby-entered:v1";

export function markLobbyEntered(
  storage: LobbySessionStorage | null,
  key = LOBBY_ENTRY_SESSION_KEY,
) {
  try {
    storage?.setItem(key, "1");
  } catch {
    // Direct room navigation still bypasses the ceremony without storage.
  }
}

export function recentWinRateFor(
  outcomes: readonly ("win" | "loss" | "draw")[],
) {
  const recent = outcomes.slice(0, 10);
  return recent.length === 0
    ? null
    : recent.filter((outcome) => outcome === "win").length / recent.length;
}

export function playerHandleErrorMessage(code: string) {
  if (code.includes("HANDLE_TAKEN")) return "这个玩家 ID 已被使用。";
  if (code.includes("INVALID_HANDLE")) return "这个玩家 ID 不符合规则。";
  return "暂时无法更新玩家 ID，请稍后重试。";
}

export function shouldShowLobbyEntry(
  storage: LobbySessionStorage | null,
  key: string,
  skipEntryGate: boolean,
) {
  if (skipEntryGate) {
    markLobbyEntered(storage, key);
    return false;
  }
  try {
    return storage?.getItem(key) !== "1";
  } catch {
    return true;
  }
}
