export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("REQUEST_TOO_LARGE");
    this.name = "RequestBodyTooLargeError";
  }
}

export async function hasNonEmptyRequestBody(request: {
  readonly body: ReadableStream<Uint8Array> | null;
}) {
  if (!request.body) return false;
  const reader = request.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) return false;
    if (value.byteLength > 0) {
      try {
        await reader.cancel();
      } catch {
        // Finding one byte is enough to reject a body even if cancellation fails.
      }
      return true;
    }
  }
}

export async function readBoundedJson(request: Request, maxBytes = 8_192): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    throw new RequestBodyTooLargeError();
  }

  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // The size violation is authoritative even if the stream cannot be cancelled.
      }
      throw new RequestBodyTooLargeError();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  return JSON.parse(text) as unknown;
}
