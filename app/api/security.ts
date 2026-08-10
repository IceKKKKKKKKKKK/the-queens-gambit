const CROSS_ORIGIN_ERROR = "CROSS_ORIGIN_REQUEST";

/**
 * Browsers can send a "simple" text/plain POST cross-origin without a CORS
 * preflight. Reads remain protected by CORS, but a signed-in visitor's request
 * could still mutate their account unless every write verifies its origin.
 *
 * Requests without browser origin metadata remain valid for trusted worker and
 * integration callers; they still need the Sites-authenticated identity.
 */
export function rejectCrossOriginMutation(
  request: Request,
  responseHeaders: HeadersInit,
): Response | null {
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return Response.json(
      { error: CROSS_ORIGIN_ERROR },
      { status: 403, headers: responseHeaders },
    );
  }

  const rawOrigin = request.headers.get("origin");
  if (!rawOrigin) return null;
  try {
    if (new URL(rawOrigin).origin === new URL(request.url).origin) return null;
  } catch {
    // Opaque, malformed, and `null` origins are not authorized to mutate.
  }
  return Response.json(
    { error: CROSS_ORIGIN_ERROR },
    { status: 403, headers: responseHeaders },
  );
}
