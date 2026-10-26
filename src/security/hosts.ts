import type { HostKind, PreviewEnv } from "../types.ts";

function hostname(origin: string): string {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function classifyHost(request: Request, env: PreviewEnv): HostKind {
  const requestHost = new URL(request.url).hostname.toLowerCase();
  if (requestHost === hostname(env.APP_ORIGIN)) return "app";
  if (requestHost === hostname(env.CONTENT_ORIGIN)) return "content";

  if (
    env.ENVIRONMENT === "test" &&
    (requestHost === "localhost" || requestHost === "127.0.0.1" || requestHost === "app.test")
  ) {
    return "app";
  }

  if (env.ENVIRONMENT === "test" && requestHost === "content.test") return "content";
  return "unknown";
}
