import {
  getOrCreatePlatformUser,
  heartbeatPresence,
  ownPresence,
  PlatformError,
} from "../../../db/platform";
import { IdentityError, requireAuthenticatedIdentity } from "../../../lib/identity";
import { hasNonEmptyRequestBody } from "../../../lib/request";

const responseHeaders = {
  "Cache-Control": "no-store",
  Vary: "oai-authenticated-user-id, oai-authenticated-user-email",
};

function errorResponse(error: unknown) {
  if (error instanceof IdentityError || error instanceof PlatformError) {
    return Response.json({ error: error.code }, { status: error.status, headers: responseHeaders });
  }
  return Response.json({ error: "PRESENCE_FAILED" }, { status: 500, headers: responseHeaders });
}

export async function GET(request: Request) {
  try {
    const identity = requireAuthenticatedIdentity(request);
    const user = await getOrCreatePlatformUser(identity);
    return Response.json(await ownPresence(user.id), { headers: responseHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const identity = requireAuthenticatedIdentity(request);
    const user = await getOrCreatePlatformUser(identity);
    if (await hasNonEmptyRequestBody(request)) {
      return Response.json({ error: "INVALID_REQUEST" }, { status: 400, headers: responseHeaders });
    }
    return Response.json(await heartbeatPresence(user.id), { headers: responseHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}
