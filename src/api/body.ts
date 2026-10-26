export async function readJson<T>(request: Request, maxBytes = 64 * 1024): Promise<T> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Request body is too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("Request body is too large");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}
