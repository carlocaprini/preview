import { readJson } from "./body.ts";
import { apiError, json } from "../http.ts";
import {
  clearOwnerSessionCookie,
  createOwnerSession,
  isSameOriginMutation,
  ownerSessionCookie,
  verifyOwnerPassword,
} from "../security/auth.ts";
import type { PreviewEnv } from "../types.ts";

export async function routeAuthApi(request: Request, env: PreviewEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    if (!isSameOriginMutation(request, env)) return apiError("origin_required", "Request origin is not allowed", 403);
    try {
      const body = await readJson<{ password?: unknown }>(request, 4 * 1024);
      if (typeof body.password !== "string" || body.password.length > 512) {
        return apiError("invalid_credentials", "Invalid credentials", 401);
      }
      if (!(await verifyOwnerPassword(body.password, env))) {
        return apiError("invalid_credentials", "Invalid credentials", 401);
      }
      const token = await createOwnerSession(env);
      return json({ authenticated: true }, 200, { "Set-Cookie": ownerSessionCookie(token) });
    } catch {
      return apiError("invalid_credentials", "Invalid credentials", 401);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    if (!isSameOriginMutation(request, env)) return apiError("origin_required", "Request origin is not allowed", 403);
    return json({ authenticated: false }, 200, { "Set-Cookie": clearOwnerSessionCookie() });
  }

  return null;
}
