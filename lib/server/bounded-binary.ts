export type BoundedBinaryResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; status: 400 | 413 | 415; error: string };

function requestMediaType(request: Request) {
  return request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
}

export async function readBoundedBinary(
  request: Request,
  maxBytes: number,
  acceptedMediaType: string,
): Promise<BoundedBinaryResult> {
  if (requestMediaType(request) !== acceptedMediaType) {
    return { ok: false, status: 415, error: `Expected ${acceptedMediaType}` };
  }

  const statedLength = request.headers.get("content-length");
  let declaredLength: number | null = null;
  if (statedLength !== null) {
    declaredLength = Number(statedLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      return { ok: false, status: 400, error: "Invalid content length" };
    }
    if (declaredLength > maxBytes) {
      return { ok: false, status: 413, error: "Request body is too large" };
    }
  }
  if (!request.body) return { ok: false, status: 400, error: "A binary request body is required" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        value.fill(0);
        for (const chunk of chunks) chunk.fill(0);
        await reader.cancel().catch(() => undefined);
        return { ok: false, status: 413, error: "Request body is too large" };
      }
      chunks.push(value);
    }
  } catch {
    for (const chunk of chunks) chunk.fill(0);
    return { ok: false, status: 400, error: "Request body could not be read" };
  }

  if (total === 0) {
    for (const chunk of chunks) chunk.fill(0);
    return { ok: false, status: 400, error: "A binary request body is required" };
  }
  if (declaredLength !== null && total !== declaredLength) {
    for (const chunk of chunks) chunk.fill(0);
    return { ok: false, status: 400, error: "Request body size did not match its content length" };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
    chunk.fill(0);
  }
  return { ok: true, bytes };
}
