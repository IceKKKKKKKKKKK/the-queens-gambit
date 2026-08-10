export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const INVITE_RETRY_PARAM = "invite_retry";

const ROOM_CODE_PATTERN = /^[A-Z2-9]{8}$/;
const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

export function pendingRoomInviteKey(code: string) {
  return `yizhen:${code}:pending-invite`;
}

export function isValidRoomCode(value: string) {
  return ROOM_CODE_PATTERN.test(value);
}

export function isValidRoomInviteToken(value: string) {
  return INVITE_TOKEN_PATTERN.test(value);
}

export function readPendingRoomInvite(storage: SessionStorageLike | null, code: string) {
  if (!storage || !isValidRoomCode(code)) return null;
  try {
    const token = storage.getItem(pendingRoomInviteKey(code));
    if (!token) return null;
    if (!isValidRoomInviteToken(token)) {
      storage.removeItem(pendingRoomInviteKey(code));
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

export function clearPendingRoomInvite(storage: SessionStorageLike | null, code: string) {
  if (!storage || !isValidRoomCode(code)) return;
  try {
    storage.removeItem(pendingRoomInviteKey(code));
  } catch {
    // A blocked session store is equivalent to having no recoverable pending invite.
  }
}

export type InviteStagingStatus =
  | "none"
  | "watch_only"
  | "stored"
  | "invalid"
  | "storage_unavailable";

export interface InviteStagingResult {
  code: string | null;
  status: InviteStagingStatus;
  clearFragment: boolean;
}

export function stageRoomInviteForSignIn(
  href: string,
  storage: SessionStorageLike | null,
): InviteStagingResult {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { code: null, status: "none", clearFragment: false };
  }
  const rawCode = url.searchParams.get("room") ?? "";
  const code = rawCode.toUpperCase();
  if (!isValidRoomCode(code)) {
    return { code: null, status: "none", clearFragment: false };
  }
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  if (url.searchParams.get("watch") === "1") {
    return { code, status: "watch_only", clearFragment: fragment.has("invite") };
  }
  if (!fragment.has("invite")) {
    return { code, status: "none", clearFragment: false };
  }
  const inviteToken = fragment.get("invite") ?? "";
  if (!isValidRoomInviteToken(inviteToken)) {
    clearPendingRoomInvite(storage, code);
    return { code, status: "invalid", clearFragment: true };
  }
  if (!storage) {
    return { code, status: "storage_unavailable", clearFragment: false };
  }
  try {
    storage.setItem(pendingRoomInviteKey(code), inviteToken);
    if (storage.getItem(pendingRoomInviteKey(code)) !== inviteToken) {
      clearPendingRoomInvite(storage, code);
      return { code, status: "storage_unavailable", clearFragment: false };
    }
    return { code, status: "stored", clearFragment: true };
  } catch {
    clearPendingRoomInvite(storage, code);
    return { code, status: "storage_unavailable", clearFragment: false };
  }
}

export function signInPathWithInviteRetry(
  signInPath: string,
  roomCode: string,
  origin: string,
) {
  return signInPathWithRoomReturnParams(signInPath, roomCode, origin, {
    [INVITE_RETRY_PARAM]: "1",
  });
}

export function signInPathWithWatchOnly(
  signInPath: string,
  roomCode: string,
  origin: string,
) {
  return signInPathWithRoomReturnParams(signInPath, roomCode, origin, { watch: "1" });
}

function signInPathWithRoomReturnParams(
  signInPath: string,
  roomCode: string,
  origin: string,
  params: Readonly<Record<string, string>>,
) {
  if (!isValidRoomCode(roomCode)) return signInPath;
  try {
    const authUrl = new URL(signInPath, origin);
    if (authUrl.origin !== origin) return signInPath;
    const returnUrl = new URL(authUrl.searchParams.get("return_to") ?? "/", origin);
    if (returnUrl.origin !== origin) return signInPath;
    returnUrl.searchParams.set("room", roomCode);
    for (const [key, value] of Object.entries(params)) returnUrl.searchParams.set(key, value);
    authUrl.searchParams.set("return_to", `${returnUrl.pathname}${returnUrl.search}`);
    return `${authUrl.pathname}${authUrl.search}`;
  } catch {
    return signInPath;
  }
}
