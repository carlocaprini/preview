import { apiError, html, json } from "./http.ts";
import { routePublishingApi } from "./api/publishing.ts";
import { routeOwnerViewerApi } from "./api/viewer.ts";
import { routeAdminApi } from "./api/admin.ts";
import { routeAnalyticsApi } from "./api/analytics.ts";
import { routeAuthApi } from "./api/auth.ts";
import { publicPdfResponse, routePdfAdminApi } from "./api/pdf.ts";
import { clientAsset } from "./client-assets.ts";
import { handleMcp } from "./mcp.ts";
import {
  authenticateMcp,
  authenticateOwner,
  isSameOriginMutation,
  parseOwnerPreviewToken,
} from "./security/auth.ts";
import { appHeaders, applyHeaders, contentHeaders } from "./security/headers.ts";
import { classifyHost } from "./security/hosts.ts";
import type { PreviewEnv, PreviewExecutionContext } from "./types.ts";
import { adminPage, homePage, loginPage, unavailablePage, viewerPage } from "./ui/pages.ts";
import { D1ViewerRepository } from "./data/viewer.ts";
import { D1AssetStore } from "./data/assets.ts";
import { ViewerService } from "./services/viewer.ts";
import { D1PublishingRepository } from "./data/repository.ts";
import { D1PdfRepository } from "./data/pdf.ts";

function structuredLog(level: "info" | "error", event: string, request: Request, detail?: string): void {
  const pathname = new URL(request.url).pathname;
  const path = pathname.startsWith("/s/")
    ? "/s/:token"
    : pathname.startsWith("/preview/")
      ? "/preview/:content/:snapshot/:asset"
      : pathname.startsWith("/api/admin/uploads/")
        ? "/api/admin/uploads/:upload/:operation"
        : pathname.startsWith("/api/admin/contents/")
          ? "/api/admin/contents/:content/:operation"
          : pathname.startsWith("/api/admin/links/")
            ? "/api/admin/links/:link/:operation"
            : ["/", "/health", "/login", "/admin", "/mcp", "/api/auth/login", "/api/auth/logout", "/api/admin/contents", "/api/public/measure"].includes(pathname)
              ? pathname
              : "/other";
  const payload = { level, event, method: request.method, path, detail };
  if (level === "error") console.error(JSON.stringify(payload));
  else console.log(JSON.stringify(payload));
}

async function routeApp(request: Request, env: PreviewEnv, ctx: PreviewExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/") {
    return applyHeaders(html(homePage()), appHeaders(env));
  }

  if (request.method === "GET" && url.pathname === "/health") {
    return applyHeaders(json({ status: "ok" }), appHeaders(env));
  }

  if (request.method === "GET" && url.pathname === "/login") {
    const owner = await authenticateOwner(request, env);
    if (owner.authorized) {
      return applyHeaders(new Response(null, { status: 303, headers: { Location: "/admin" } }), appHeaders(env));
    }
    return applyHeaders(html(loginPage()), appHeaders(env));
  }

  if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
    const asset = clientAsset(url.pathname);
    if (asset) {
      return applyHeaders(new Response(asset.body, { headers: { "content-type": asset.mediaType } }), appHeaders(env));
    }
  }

  if (url.pathname.startsWith("/api/public/")) {
    const response = await routeAnalyticsApi(request, env);
    return applyHeaders(response ?? apiError("not_found", "Not found", 404), appHeaders(env));
  }

  if (url.pathname.startsWith("/api/auth/")) {
    const response = await routeAuthApi(request, env);
    return applyHeaders(response ?? apiError("not_found", "Not found", 404), appHeaders(env));
  }

  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/") || url.pathname.startsWith("/api/admin/")) {
    const owner = await authenticateOwner(request, env);
    const mcp = url.pathname.startsWith("/api/admin/uploads/") ? await authenticateMcp(request, env) : { authorized: false };
    if (!owner.authorized && !mcp.authorized) {
      if (request.method === "GET" && (url.pathname === "/admin" || url.pathname.startsWith("/admin/"))) {
        const next = encodeURIComponent(`${url.pathname}${url.search}`);
        return applyHeaders(new Response(null, { status: 303, headers: { Location: `/login?next=${next}` } }), appHeaders(env));
      }
      return applyHeaders(apiError("authentication_required", "Authentication required", 401), appHeaders(env));
    }
    if (owner.authorized && !mcp.authorized && !isSameOriginMutation(request, env)) {
      return applyHeaders(apiError("origin_required", "Request origin is not allowed", 403), appHeaders(env));
    }
    if (
      request.method === "GET" &&
      (url.pathname === "/admin" || url.pathname === "/admin/" || /^\/admin\/contents\/[^/]+$/u.test(url.pathname))
    ) {
      return applyHeaders(html(adminPage()), appHeaders(env));
    }
    const adminResponse = await routeAdminApi(request, env);
    if (adminResponse) return applyHeaders(adminResponse, appHeaders(env));
    const pdfResponse = await routePdfAdminApi(request, env);
    if (pdfResponse) return applyHeaders(pdfResponse, appHeaders(env));
    const publishingResponse = await routePublishingApi(request, env);
    if (publishingResponse) return applyHeaders(publishingResponse, appHeaders(env));
    const viewerResponse = await routeOwnerViewerApi(request, env);
    if (viewerResponse) return applyHeaders(viewerResponse, appHeaders(env));
    return applyHeaders(apiError("not_found", "Not found", 404), appHeaders(env));
  }

  if (url.pathname === "/mcp") {
    const auth = await authenticateMcp(request, env);
    if (!auth.authorized) return applyHeaders(apiError("authentication_required", "MCP authentication required", 401), appHeaders(env));
    return applyHeaders(await handleMcp(request, env, ctx), appHeaders(env));
  }

  if (url.pathname.startsWith("/s/")) {
    const pdfMatch = url.pathname.match(/^\/s\/([^/]+)\/pdf$/u);
    if (pdfMatch?.[1]) {
      const pdf = await publicPdfResponse(request, env, ctx, pdfMatch[1]);
      return applyHeaders(pdf ?? html(unavailablePage(), 404), appHeaders(env));
    }
    const token = url.pathname.slice(3);
    const resolved = await new ViewerService(
      new D1ViewerRepository(env.DB),
      new D1AssetStore(env.DB),
      env.SHARE_SIGNING_KEY,
    ).resolveSharedView(token);
    if (resolved.state !== "active" || !resolved.snapshotId) {
      const status = resolved.state === "invalid" ? 404 : 410;
      return applyHeaders(html(unavailablePage(), status), appHeaders(env));
    }
    const source = `${env.CONTENT_ORIGIN}/s/${encodeURIComponent(token)}/v/${resolved.snapshotId}/index.html`;
    return applyHeaders(html(viewerPage(source, {
      token,
      snapshotId: resolved.snapshotId,
      pdfUrl: resolved.hasPdf ? `/s/${encodeURIComponent(token)}/pdf` : undefined,
    })), appHeaders(env));
  }

  return applyHeaders(html(unavailablePage(), 404), appHeaders(env));
}

async function routeContent(
  request: Request,
  env: PreviewEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const service = new ViewerService(new D1ViewerRepository(env.DB), new D1AssetStore(env.DB), env.SHARE_SIGNING_KEY);
  const shared = url.pathname.match(/^\/s\/([^/]+)\/v\/([^/]+)\/(.+)$/u);
  if (request.method === "GET" && shared?.[1] && shared[2] && shared[3]) {
    const asset = await service.getSharedAsset(decodeURIComponent(shared[1]), shared[2], shared[3]);
    if (asset) {
      const headers = contentHeaders(env, asset.mediaType);
      headers.set("Content-Length", String(asset.size));
      if (asset.etag) headers.set("ETag", asset.etag);
      return applyHeaders(new Response(asset.body), headers);
    }
    return applyHeaders(html(unavailablePage(), 404), contentHeaders(env, "text/html; charset=utf-8"));
  }

  const owner = url.pathname.match(/^\/preview\/([^/]+)\/v\/([^/]+)\/(.+)$/u);
  if (request.method === "GET" && owner?.[1] && owner[2] && owner[3]) {
    const authorized = await parseOwnerPreviewToken(owner[1], env.SHARE_SIGNING_KEY);
    if (!authorized || authorized.snapshotId !== owner[2]) {
      return applyHeaders(html(unavailablePage(), 404), contentHeaders(env, "text/html; charset=utf-8"));
    }
    const asset = await service.getOwnerAsset(authorized.contentId, owner[2], owner[3]);
    if (asset) return applyHeaders(new Response(asset.body), contentHeaders(env, asset.mediaType));
  }

  return applyHeaders(html(unavailablePage(), 404), contentHeaders(env, "text/html; charset=utf-8"));
}

export async function handleRequest(
  request: Request,
  env: PreviewEnv,
  ctx: PreviewExecutionContext,
): Promise<Response> {
  try {
    const host = classifyHost(request, env);
    if (host === "unknown") {
      structuredLog("info", "host_rejected", request);
      return apiError("host_not_allowed", "Not found", 404);
    }
    return host === "content" ? routeContent(request, env) : routeApp(request, env, ctx);
  } catch (error) {
    structuredLog("error", "request_failed", request, error instanceof Error ? error.name : "unknown");
    return apiError("internal_error", "Internal server error", 500);
  }
}

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx as PreviewExecutionContext);
  },
  scheduled(controller, env, ctx) {
    const scheduledAt = new Date(controller.scheduledTime);
    ctx.waitUntil(
      Promise.all([
        new D1PublishingRepository(env.DB).cleanup(scheduledAt),
        new D1PdfRepository(env.DB).cleanup(scheduledAt),
      ]).then(() => undefined),
    );
  },
} satisfies ExportedHandler<PreviewEnv>;
