export interface AuthenticatedIdentity {
  authUserId: string;
  email: string;
}

export class IdentityError extends Error {
  readonly code: "AUTH_REQUIRED" | "INVALID_AUTH_ID" | "INVALID_AUTH_EMAIL" | "INVALID_HANDLE";
  readonly status: number;

  constructor(
    code: IdentityError["code"],
    status = code === "AUTH_REQUIRED" ? 401 : 400,
  ) {
    super(code);
    this.name = "IdentityError";
    this.code = code;
    this.status = status;
  }
}

function containsUnsafeHeaderCharacters(value: string) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

export function normalizeEmail(value: string) {
  const email = value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
  const at = email.lastIndexOf("@");
  if (
    email.length < 3 ||
    email.length > 254 ||
    at <= 0 ||
    at === email.length - 1 ||
    at > 64 ||
    containsUnsafeHeaderCharacters(email) ||
    /\s/u.test(email) ||
    email.indexOf("@") !== at
  ) {
    throw new IdentityError("INVALID_AUTH_EMAIL");
  }
  return email;
}

export function getAuthenticatedIdentity(request: Request): AuthenticatedIdentity | null {
  const rawId = request.headers.get("oai-authenticated-user-id");
  const rawEmail = request.headers.get("oai-authenticated-user-email");
  if (!rawId && !rawEmail) return null;
  if (!rawId || !rawEmail) throw new IdentityError(!rawId ? "INVALID_AUTH_ID" : "INVALID_AUTH_EMAIL");

  const authUserId = rawId.trim();
  if (
    authUserId.length < 1 ||
    authUserId.length > 255 ||
    containsUnsafeHeaderCharacters(authUserId)
  ) {
    throw new IdentityError("INVALID_AUTH_ID");
  }
  return { authUserId, email: normalizeEmail(rawEmail) };
}

export function requireAuthenticatedIdentity(request: Request) {
  const identity = getAuthenticatedIdentity(request);
  if (!identity) throw new IdentityError("AUTH_REQUIRED");
  return identity;
}

export function normalizeHandle(value: unknown) {
  if (typeof value !== "string" || value.length > 64) {
    throw new IdentityError("INVALID_HANDLE");
  }
  const handle = value.trim().normalize("NFKC");
  const characters = Array.from(handle);
  if (
    characters.length < 3 ||
    characters.length > 16 ||
    !/^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(handle)
  ) {
    throw new IdentityError("INVALID_HANDLE");
  }
  return {
    handle,
    handleKey: handle.toLocaleLowerCase("en-US"),
  };
}

export async function createDefaultHandle(identity: AuthenticatedIdentity, salt = "") {
  const bytes = new TextEncoder().encode(`${identity.authUserId}:${salt}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const suffix = Array.from(new Uint8Array(digest).slice(0, 3), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return normalizeHandle(`棋手_${suffix}`);
}
