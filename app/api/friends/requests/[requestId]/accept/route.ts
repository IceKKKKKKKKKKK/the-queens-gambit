import {
  acceptFriendRequest,
  getOrCreatePlatformUser,
  PlatformError,
} from "../../../../../../db/platform";
import { IdentityError, requireAuthenticatedIdentity } from "../../../../../../lib/identity";
import { hasNonEmptyRequestBody } from "../../../../../../lib/request";

const responseHeaders = {
  "Cache-Control": "no-store",
  Vary: "oai-authenticated-user-id, oai-authenticated-user-email",
};

export async function POST(
  request: Request,
  context: { params: Promise<{ requestId: string }> },
) {
  try {
    const identity = requireAuthenticatedIdentity(request);
    const user = await getOrCreatePlatformUser(identity);
    if (await hasNonEmptyRequestBody(request)) {
      return Response.json({ error: "INVALID_REQUEST" }, { status: 400, headers: responseHeaders });
    }
    const { requestId } = await context.params;
    const accepted = await acceptFriendRequest(user, requestId);
    return Response.json(accepted, { headers: responseHeaders });
  } catch (error) {
    if (error instanceof IdentityError || error instanceof PlatformError) {
      return Response.json({ error: error.code }, { status: error.status, headers: responseHeaders });
    }
    return Response.json({ error: "FRIEND_ACCEPT_FAILED" }, { status: 500, headers: responseHeaders });
  }
}
