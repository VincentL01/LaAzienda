export type BoundedJsonResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: 400 | 413 | 415; error: string };

export async function readBoundedJsonObject(request: Request, maxBytes: number): Promise<BoundedJsonResult> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") return { ok: false, status: 415, error: "Expected application/json" };
  const statedLength = request.headers.get("content-length");
  if (statedLength) {
    const length = Number(statedLength);
    if (!Number.isSafeInteger(length) || length < 0) return { ok: false, status: 400, error: "Invalid content length" };
    if (length > maxBytes) return { ok: false, status: 413, error: "Request body is too large" };
  }
  if (!request.body) return { ok: false, status: 400, error: "A JSON object is required" };

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
        await reader.cancel();
        return { ok: false, status: 413, error: "Request body is too large" };
      }
      chunks.push(value);
    }
  } catch {
    for (const chunk of chunks) chunk.fill(0);
    return { ok: false, status: 400, error: "Request body could not be read" };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(decoded) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, status: 400, error: "A JSON object is required" };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, status: 400, error: "Request body is not valid JSON" };
  } finally {
    bytes.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}
