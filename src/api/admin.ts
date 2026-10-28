import { apiError, json } from "../http.ts";
import { D1AdminRepository } from "../data/admin.ts";
import type { PreviewEnv } from "../types.ts";

export async function routeAdminApi(request: Request, env: PreviewEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const repository = new D1AdminRepository(env.DB, env.APP_ORIGIN, env.SHARE_SIGNING_KEY);
  if (request.method === "GET" && url.pathname === "/api/admin/contents") {
    return json({ contents: await repository.listContents() });
  }
  const detail = url.pathname.match(/^\/api\/admin\/contents\/([^/]+)$/u);
  if (request.method === "GET" && detail?.[1]) {
    const content = await repository.contentDetail(detail[1]);
    return content ? json(content) : apiError("not_found", "Content not found", 404);
  }
  return null;
}
