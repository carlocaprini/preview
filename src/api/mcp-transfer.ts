import { apiError } from "../http.ts";
import { ContentSourceService } from "../services/content-source.ts";
import type { PreviewEnv } from "../types.ts";

export async function routeMcpTransferApi(request: Request, env: PreviewEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/mcp\/contents\/([^/]+)\/versions\/([^/]+)\/files\/(.+)$/u);
  if (request.method !== "GET" || !match?.[1] || !match[2] || !match[3]) return null;
  try {
    const contentId = decodeURIComponent(match[1]);
    const versionId = decodeURIComponent(match[2]);
    const encodedPath = match[3];
    const path = decodeURIComponent(encodedPath);
    if (encodeURIComponent(path) !== encodedPath) throw new Error("File path must use canonical URL encoding");
    const download = await new ContentSourceService(env.DB, env.APP_ORIGIN).download(contentId, versionId, path);
    if (!download) return apiError("content_file_unavailable", "File not found or active version changed", 404);
    return new Response(download.stored.body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.split("/").at(-1) ?? "download")}`,
        "Content-Length": String(download.record.size),
        "Cache-Control": "no-store, private",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        ETag: download.record.etag,
      },
    });
  } catch {
    return apiError("invalid_content_file", "File request is invalid", 400);
  }
}
