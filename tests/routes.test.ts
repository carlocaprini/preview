import { describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/index.ts";
import { OWNER_SESSION_COOKIE } from "../src/security/auth.ts";
import type { PreviewEnv, PreviewExecutionContext } from "../src/types.ts";

const env = {
  OWNER_PASSWORD: "test-owner-password-with-enough-entropy",
  MCP_BEARER_TOKEN: "test-mcp-bearer-token-with-enough-entropy",
  SHARE_SIGNING_KEY: "test-signing-key-with-enough-entropy",
  APP_ORIGIN: "https://app.test",
  CONTENT_ORIGIN: "https://content.test",
  ENVIRONMENT: "test",
} as PreviewEnv;

const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as PreviewExecutionContext;

function anchorHref(page: string, label: string): string {
  const match = page.match(new RegExp(`<a[^>]+href="([^"]+)"[^>]*>${label}</a>`, "u"));
  if (!match?.[1]) throw new Error(`Missing ${label} link`);
  return match[1].replaceAll("&amp;", "&");
}

function expectPublicAttribution(href: string, pathname: string, content: "home" | "about" | "privacy" | "unavailable" | "not_found", hash = "") {
  const url = new URL(href);
  expect(url.pathname).toBe(pathname);
  expect(url.hash).toBe(hash);
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    utm_source: "preview",
    utm_medium: "referral",
    utm_campaign: "public_pages",
    utm_content: content,
  });
}

async function loginCookie(password = env.OWNER_PASSWORD): Promise<string | null> {
  const response = await handleRequest(
    new Request("https://app.test/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: env.APP_ORIGIN },
      body: JSON.stringify({ password }),
    }),
    env,
    context,
  );
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? null;
}

describe("origin and authentication routing", () => {
  it("serves the branded public homepage without exposing content", async () => {
    const response = await handleRequest(new Request("https://app.test/"), env, context);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Ideas, experiments and work worth sharing.");
    expectPublicAttribution(anchorHref(body, "Explore work"), "/work/", "home");
    expectPublicAttribution(anchorHref(body, "Explore thinking"), "/thinking/", "home");
    expectPublicAttribution(anchorHref(body, "Get in touch"), "/", "home", "#contact");
    expect(anchorHref(body, "About Preview")).toBe("/about/");
    expect(anchorHref(body, "Privacy")).toBe("/privacy/");
    expect(body).not.toContain(">Carlo Caprini</a>");
    expect(body).not.toContain("github.com");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("serves an accurate noindex privacy notice without private identifiers", async () => {
    const redirect = await handleRequest(new Request("https://app.test/privacy"), env, context);
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("/privacy/");

    const response = await handleRequest(new Request("https://app.test/privacy/"), env, context);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('name="robots" content="noindex,nofollow,noarchive"');
    expect(body).toContain("for up to 24 hours");
    expect(body).toContain("no automatic time-based deletion");
    expect(body).toContain("Readers do not receive an identity cookie");
    expect(body).toContain("Last updated: 6 November 2026");
    expectPublicAttribution(anchorHref(body, "contact route on Carlo’s site"), "/", "privacy", "#contact");
    expect(body).not.toContain(env.MCP_BEARER_TOKEN);
    expect(body).not.toContain("/s/");
  });

  it("serves the public About page and brand assets without a source link", async () => {
    const redirect = await handleRequest(new Request("https://app.test/about"), env, context);
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("/about/");

    const about = await handleRequest(new Request("https://app.test/about/"), env, context);
    expect(about.status).toBe(200);
    const body = await about.text();
    expect(body).toContain("A small tool for sharing work without flattening it.");
    expect(body).toContain("single-owner utility");
    expectPublicAttribution(anchorHref(body, "Explore Carlo’s work"), "/work/", "about");
    expect(body).toContain('href="/favicon.svg"');
    expect(body).not.toContain("github.com");

    const favicon = await handleRequest(new Request("https://app.test/favicon.svg"), env, context);
    expect(favicon.status).toBe(200);
    expect(favicon.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(await favicon.text()).toContain("<title id=\"title\">Preview</title>");

    const social = await handleRequest(new Request("https://app.test/assets/preview-social.png"), env, context);
    expect(social.status).toBe(200);
    expect(social.headers.get("content-type")).toBe("image/png");
    expect(Array.from(new Uint8Array(await social.arrayBuffer()).slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it("distinguishes unavailable shares from generic public not-found attribution", async () => {
    const unavailable = await handleRequest(new Request("https://app.test/s/not-a-token"), env, context);
    const notFound = await handleRequest(new Request("https://app.test/does-not-exist"), env, context);
    expect(unavailable.status).toBe(404);
    expect(notFound.status).toBe(404);
    expectPublicAttribution(anchorHref(await unavailable.text(), "Explore work"), "/work/", "unavailable");
    expectPublicAttribution(anchorHref(await notFound.text(), "Explore work"), "/work/", "not_found");
  });

  it("redirects an anonymous owner to the local login page", async () => {
    const response = await handleRequest(new Request("https://app.test/admin"), env, context);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login?next=%2Fadmin");
    const login = await handleRequest(new Request("https://app.test/login"), env, context);
    expect(login.status).toBe(200);
    expect(await login.text()).toContain('id="login-form"');
  });

  it("creates a secure session only for the configured owner password", async () => {
    expect(await loginCookie("wrong-password")).toBeNull();
    const cookie = await loginCookie();
    expect(cookie).toMatch(new RegExp(`^${OWNER_SESSION_COOKIE}=`));
    const response = await handleRequest(
      new Request("https://app.test/admin", { headers: { cookie: cookie ?? "" } }),
      env,
      context,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('id="admin-app"');
  });

  it("rejects cross-origin owner mutations", async () => {
    const cookie = await loginCookie();
    const response = await handleRequest(
      new Request("https://app.test/api/admin/links/link/revoke", {
        method: "POST",
        headers: { cookie: cookie ?? "", origin: "https://content.test" },
      }),
      env,
      context,
    );
    expect(response.status).toBe(403);
  });

  it("requires the independent Bearer token for MCP", async () => {
    const anonymous = await handleRequest(new Request("https://app.test/mcp"), env, context);
    expect(anonymous.status).toBe(401);
  });

  it("does not expose application routes from the content origin", async () => {
    const response = await handleRequest(new Request("https://content.test/admin"), env, context);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('id="admin-app"');
  });

  it("rejects alternate hosts such as workers.dev", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await handleRequest(new Request("https://preview.workers.dev/"), env, context);
    expect(response.status).toBe(404);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("redacts bearer tokens and filenames from structured logs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await handleRequest(new Request("https://preview.workers.dev/s/top-secret-token/private-name.html"), env, context);
    const emitted = log.mock.calls.flat().join(" ");
    expect(emitted).toContain("/s/:token");
    expect(emitted).not.toContain("top-secret-token");
    expect(emitted).not.toContain("private-name.html");
    log.mockRestore();
  });
});
