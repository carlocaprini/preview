import { readJson } from "./body.ts";
import { apiError, html, json } from "../http.ts";
import { D1ViewerRepository } from "../data/viewer.ts";
import { D1AssetStore } from "../data/assets.ts";
import { ViewerService } from "../services/viewer.ts";
import type { PreviewEnv } from "../types.ts";
import { viewerPage } from "../ui/pages.ts";
import { createOwnerPreviewToken } from "../security/auth.ts";

function viewer(env: PreviewEnv): ViewerService {
  return new ViewerService(new D1ViewerRepository(env.DB), new D1AssetStore(env.DB), env.SHARE_SIGNING_KEY);
}

export async function routeOwnerViewerApi(request: Request, env: PreviewEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const previewMatch = url.pathname.match(/^\/api\/admin\/contents\/([^/]+)\/preview$/u);
  if (request.method === "GET" && previewMatch?.[1]) {
    const resolved = await viewer(env).getOwnerPreview(previewMatch[1]);
    if (!resolved) return apiError("preview_unavailable", "No active version is available", 404);
    const token = await createOwnerPreviewToken(
      resolved.contentId,
      resolved.snapshotId,
      env.SHARE_SIGNING_KEY,
    );
    const source = `${env.CONTENT_ORIGIN}/preview/${encodeURIComponent(token)}/v/${resolved.snapshotId}/index.html`;
    return html(viewerPage(source));
  }

  const linkMatch = url.pathname.match(/^\/api\/admin\/links\/([^/]+)$/u);
  if (request.method === "PATCH" && linkMatch?.[1]) {
    try {
      const body = await readJson<{ expiresAt: string | null }>(request);
      let expiresAt: string | null = null;
      if (body.expiresAt !== null) {
        const parsed = new Date(body.expiresAt);
        if (Number.isNaN(parsed.getTime())) throw new Error("Expiry must be an ISO date or null");
        expiresAt = parsed.toISOString();
      }
      const updated = await new D1ViewerRepository(env.DB).updateLinkExpiryState(linkMatch[1], expiresAt);
      return updated ? json(updated) : apiError("not_found", "Link not found", 404);
    } catch (error) {
      return apiError("invalid_expiry", error instanceof Error ? error.message : "Invalid expiry", 400);
    }
  }

  const revokeMatch = url.pathname.match(/^\/api\/admin\/links\/([^/]+)\/revoke$/u);
  if (request.method === "POST" && revokeMatch?.[1]) {
    const revoked = await new D1ViewerRepository(env.DB).revokeLinkState(revokeMatch[1], new Date());
    return revoked ? json(revoked) : apiError("not_found", "Link not found", 404);
  }

  return null;
}
