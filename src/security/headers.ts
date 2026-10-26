import type { PreviewEnv } from "../types.ts";

const BASE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Resource-Policy": "same-site",
};

export function appHeaders(env: PreviewEnv): Headers {
  return new Headers({
    ...BASE_HEADERS,
    "Cache-Control": "no-store, private",
    "Content-Security-Policy": [
      "default-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      `frame-src ${env.CONTENT_ORIGIN}`,
      "img-src 'self' data:",
      "style-src 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
    ].join("; "),
  });
}

export function contentHeaders(env: PreviewEnv, mediaType: string): Headers {
  return new Headers({
    ...BASE_HEADERS,
    "Cache-Control": "no-store, private, max-age=0",
    "Content-Type": mediaType,
    "Access-Control-Allow-Origin": "null",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Content-Security-Policy": [
      "default-src 'self' https: data: blob:",
      "base-uri 'none'",
      "object-src 'none'",
      `frame-ancestors ${env.APP_ORIGIN}`,
      "form-action 'none'",
    ].join("; "),
  });
}

export function applyHeaders(response: Response, headers: Headers): Response {
  const next = new Headers(response.headers);
  headers.forEach((value, key) => next.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: next });
}
