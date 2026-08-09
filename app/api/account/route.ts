import {
  accountSummary,
  getOrCreatePlatformUser,
  listRecentMatches,
  PlatformError,
  updatePlatformHandle,
} from "../../../db/platform";
import { IdentityError, requireAuthenticatedIdentity } from "../../../lib/identity";
import { RequestBodyTooLargeError, readBoundedJson } from "../../../lib/request";

const responseHeaders = {
  "Cache-Control": "no-store",
  Vary: "oai-authenticated-user-id, oai-authenticated-user-email",
};

function errorResponse(error: unknown, fallback: string) {
  if (error instanceof IdentityError || error instanceof PlatformError) {
    return Response.json({ error: error.code }, { status: error.status, headers: responseHeaders });
  }
  if (error instanceof RequestBodyTooLargeError) {
    return Response.json({ error: error.message }, { status: 413, headers: responseHeaders });
  }
  return Response.json({ error: fallback }, { status: 500, headers: responseHeaders });
}

export async function GET(request: Request) {
  try {
    const identity = requireAuthenticatedIdentity(request);
    const user = await getOrCreatePlatformUser(identity);
    const recentMatches = await listRecentMatches(user.id, 10);
    return Response.json(
      { account: accountSummary(user), recentMatches },
      { headers: responseHeaders },
    );
  } catch (error) {
    return errorResponse(error, "ACCOUNT_READ_FAILED");
  }
}

export async function PATCH(request: Request) {
  try {
    const identity = requireAuthenticatedIdentity(request);
    const user = await getOrCreatePlatformUser(identity);
    const parsed = await readBoundedJson(request, 1_024);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Response.json({ error: "INVALID_REQUEST" }, { status: 400, headers: responseHeaders });
    }
    const body = parsed as Record<string, unknown>;
    if (Object.keys(body).length !== 1 || !("handle" in body)) {
      return Response.json({ error: "INVALID_REQUEST" }, { status: 400, headers: responseHeaders });
    }
    const updated = await updatePlatformHandle(user.id, body.handle);
    const recentMatches = await listRecentMatches(user.id, 10);
    return Response.json(
      { account: accountSummary(updated), recentMatches },
      { headers: responseHeaders },
    );
  } catch (error) {
    return errorResponse(error, "ACCOUNT_UPDATE_FAILED");
  }
}
