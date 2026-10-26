import { apiError, html, json } from "./http.ts";
import { authenticateOwner } from "./security/auth.ts";
import { appHeaders, applyHeaders, contentHeaders } from "./security/headers.ts";
import { classifyHost } from "./security/hosts.ts";
import type { PreviewEnv, PreviewExecutionContext } from "./types.ts";
import { adminFoundationPage, homePage, unavailablePage } from "./ui/pages.ts";

function structuredLog(level: "info" | "error", event: string, request: Request, detail?: string): void {
  const payload = { level, event, method: request.method, path: new URL(request.url).pathname, detail };
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

  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/") || url.pathname.startsWith("/api/admin/")) {
    const auth = await authenticateOwner(env, ctx);
    if (!auth.authorized) return applyHeaders(apiError("access_required", "Owner access required", 403), appHeaders(env));
    if (request.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
      return applyHeaders(html(adminFoundationPage()), appHeaders(env));
    }
    return applyHeaders(apiError("not_found", "Not found", 404), appHeaders(env));
  }

  if (url.pathname === "/mcp") {
    return applyHeaders(apiError("not_ready", "MCP publishing is not available in this stack layer", 503), appHeaders(env));
  }

  if (url.pathname.startsWith("/s/")) {
    return applyHeaders(html(unavailablePage(), 404), appHeaders(env));
  }

  return applyHeaders(html(unavailablePage(), 404), appHeaders(env));
}

function routeContent(request: Request, env: PreviewEnv): Response {
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
    structuredLog("error", "request_failed", request, error instanceof Error ? error.message : "unknown");
    return apiError("internal_error", "Internal server error", 500);
  }
}

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx as PreviewExecutionContext);
  },
} satisfies ExportedHandler<PreviewEnv>;
