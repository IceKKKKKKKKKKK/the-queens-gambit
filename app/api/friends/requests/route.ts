import {
  createFriendRequest,
  getOrCreatePlatformUser,
  PlatformError,
} from "../../../../db/platform";
import { IdentityError, requireAuthenticatedIdentity } from "../../../../lib/identity";
import { RequestBodyTooLargeError, readBoundedJson } from "../../../../lib/request";

const responseHeaders = {
  "Cache-Control": "no-store",
  Vary: "oai-authenticated-user-id, oai-authenticated-user-email",
};

export async function POST(request: Request) {
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
    const friendRequest = await createFriendRequest(user, body.handle);
    return Response.json({ request: friendRequest }, { status: 201, headers: responseHeaders });
  } catch (error) {
    if (error instanceof IdentityError || error instanceof PlatformError) {
      return Response.json({ error: error.code }, { status: error.status, headers: responseHeaders });
    }
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json({ error: error.message }, { status: 413, headers: responseHeaders });
    }
    return Response.json({ error: "FRIEND_REQUEST_FAILED" }, { status: 500, headers: responseHeaders });
  }
}
