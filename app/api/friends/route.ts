import {
  getOrCreatePlatformUser,
  listFriends,
  PlatformError,
} from "../../../db/platform";
import { IdentityError, requireAuthenticatedIdentity } from "../../../lib/identity";

const responseHeaders = {
  "Cache-Control": "no-store",
  Vary: "oai-authenticated-user-id, oai-authenticated-user-email",
};

export async function GET(request: Request) {
  try {
    const identity = requireAuthenticatedIdentity(request);
    const user = await getOrCreatePlatformUser(identity);
    return Response.json(await listFriends(user), { headers: responseHeaders });
  } catch (error) {
    if (error instanceof IdentityError || error instanceof PlatformError) {
      return Response.json({ error: error.code }, { status: error.status, headers: responseHeaders });
    }
    return Response.json({ error: "FRIENDS_READ_FAILED" }, { status: 500, headers: responseHeaders });
  }
}
