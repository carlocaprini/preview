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

const productionEnv = { ...env, ENVIRONMENT: "production" } as PreviewEnv;
const stagingEnv = { ...env, ENVIRONMENT: "staging" } as PreviewEnv;
const canonicalProductionEnv = {
  ...productionEnv,
  APP_ORIGIN: "https://preview.carlocaprini.com",
  CONTENT_ORIGIN: "https://content.preview.carlocaprini.com",
} as PreviewEnv;
const liveExampleUrl = "https://preview.carlocaprini.com/s/ELERLxWr81LqDeprOoh0eg.zSWIATN3U7rks3G_nmJkEw";

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
    const response = await handleRequest(new Request("https://app.test/"), productionEnv, context);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Some work is better explored than downloaded.");
    expect(body).toContain("Keep the experience intact");
    expect(body).toContain("Manage it in the browser or through MCP");
    expect(body).toContain("Publish and update HTML, manage expiring or revocable links, and inspect engagement from the owner interface or MCP-connected AI clients and agents.");
    expect(body).toContain("Measure without guessing");
    expectPublicAttribution(anchorHref(body, "Explore work"), "/work/", "home");
    expectPublicAttribution(anchorHref(body, "Explore thinking"), "/thinking/", "home");
    expectPublicAttribution(anchorHref(body, "Get in touch"), "/", "home", "#contact");
    expect(anchorHref(body, "About")).toBe("/about/");
    expect(body).not.toContain("See Preview in action");
    expect(body).not.toContain(liveExampleUrl);
    expect(anchorHref(body, "View on GitHub")).toBe("https://github.com/carlocaprini/preview");
    expect(body).toContain('target="_blank" rel="noopener noreferrer">View on GitHub</a>');
    expect(body).toContain("Fork the code and try your own copy. The setup guide is in the repository.");
    expect(body).not.toContain('href="/privacy/"');
    expect(body).not.toContain(">Carlo Caprini</a>");
    expect(body).toContain('name="robots" content="index,follow"');
    const description = "Preview is how I share interactive reports, prototypes and experiments through links I can update, expire or revoke.";
    expect(body).toContain(`<meta name="description" content="${description}">`);
    expect(body).toContain(`<meta property="og:description" content="${description}">`);
    expect(body).toContain(`<meta name="twitter:description" content="${description}">`);
    expect(body).toContain('rel="canonical" href="https://app.test/"');
    expect(body).toContain('property="og:image" content="https://app.test/assets/preview-social.png"');
    expect(response.headers.get("x-robots-tag")).toBeNull();
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("emits the hosted example only for the configured canonical instance", async () => {
    const home = await handleRequest(new Request("https://preview.carlocaprini.com/"), canonicalProductionEnv, context);
    const about = await handleRequest(new Request("https://preview.carlocaprini.com/about/"), canonicalProductionEnv, context);
    expect(anchorHref(await home.text(), "See Preview in action")).toBe(liveExampleUrl);
    expect(anchorHref(await about.text(), "See Preview in action")).toBe(liveExampleUrl);
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
    expect(anchorHref(body, "About")).toBe("/about/");
    expectPublicAttribution(anchorHref(body, "contact route on Carlo’s site"), "/", "privacy", "#contact");
    expect(body).not.toContain("github.com/carlocaprini/preview");
    expect(body).not.toContain(env.MCP_BEARER_TOKEN);
    expect(body).not.toContain("/s/");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
  });

  it("serves the public About page and brand assets with a safe source link", async () => {
    const redirect = await handleRequest(new Request("https://app.test/about"), env, context);
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("/about/");

    const about = await handleRequest(new Request("https://app.test/about/"), productionEnv, context);
    expect(about.status).toBe(200);
    const body = await about.text();
    expect(body).toContain("A small tool for sharing work without flattening it.");
    expect(body).toContain("Built for one owner");
    const htmlSection = body.indexOf("From HTML to a shareable link");
    const mcpSection = body.indexOf("Work through an AI client or agent");
    const signalsSection = body.indexOf("A few useful signals");
    expect(htmlSection).toBeGreaterThanOrEqual(0);
    expect(mcpSection).toBeGreaterThan(htmlSection);
    expect(signalsSection).toBeGreaterThan(mcpSection);
    expect(body).toContain("Preview has an authenticated Model Context Protocol (MCP) interface. It lets compatible AI clients and agents publish or update HTML, create, expire and revoke share links, inspect aggregate engagement, and manage optional PDF companions.");
    expect(body).toContain("These are owner operations. Opening a shared link does not grant access to MCP.");
    expect(body).not.toContain("An MCP interface supports the publishing workflow.");
    expect(body).toContain('href="/about/" aria-current="page"');
    expect(body).not.toContain("See Preview in action");
    expect(body).not.toContain(liveExampleUrl);
    expect(anchorHref(body, "Explore the source on GitHub")).toBe("https://github.com/carlocaprini/preview");
    expect(body).toContain('target="_blank" rel="noopener noreferrer">Explore the source on GitHub</a>');
    expect(anchorHref(body, "self-hosting guide")).toBe("https://github.com/carlocaprini/preview/blob/main/docs/self-hosting.md");
    expect(anchorHref(body, "MCP setup and tool guide")).toBe("https://github.com/carlocaprini/preview/blob/main/docs/mcp.md");
    expect(body).toContain('target="_blank" rel="noopener noreferrer">MCP setup and tool guide</a>');
    expect(body).not.toContain("Explore Carlo’s work");
    expect(anchorHref(body, "Read the privacy notice")).toBe("/privacy/");
    expect(body.match(/href="\/privacy\/"/gu)).toHaveLength(1);
    expect(body).toContain('href="/favicon.svg"');
    expect(body).toContain('name="robots" content="index,follow"');
    const description = "How Preview shares interactive HTML and lets authorized AI clients and agents manage content, links and aggregate analytics through MCP.";
    expect(body).toContain(`<meta name="description" content="${description}">`);
    expect(body).toContain(`<meta property="og:description" content="${description}">`);
    expect(body).toContain(`<meta name="twitter:description" content="${description}">`);
    expect(body).toContain('rel="canonical" href="https://app.test/about/"');
    expect(about.headers.get("x-robots-tag")).toBeNull();

    const favicon = await handleRequest(new Request("https://app.test/favicon.svg"), env, context);
    expect(favicon.status).toBe(200);
    expect(favicon.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(await favicon.text()).toContain("<title id=\"title\">Preview</title>");

    const social = await handleRequest(new Request("https://app.test/assets/preview-social.png"), env, context);
    expect(social.status).toBe(200);
    expect(social.headers.get("content-type")).toBe("image/png");
    expect(Array.from(new Uint8Array(await social.arrayBuffer()).slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it("lets crawlers reach noindex responses and publishes an exact production sitemap", async () => {
    const robots = await handleRequest(new Request("https://app.test/robots.txt"), productionEnv, context);
    expect(robots.status).toBe(200);
    expect(robots.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const robotsBody = await robots.text();
    expect(robotsBody).toContain("Allow: /");
    expect(robotsBody).not.toContain("Disallow:");
    expect(robotsBody).toContain("Sitemap: https://app.test/sitemap.xml");
    expect(robotsBody).not.toContain("token");

    const sitemap = await handleRequest(new Request("https://app.test/sitemap.xml"), productionEnv, context);
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    const sitemapBody = await sitemap.text();
    expect(sitemapBody.match(/<loc>/gu)).toHaveLength(2);
    expect(sitemapBody).toContain("<loc>https://app.test/</loc>");
    expect(sitemapBody).toContain("<loc>https://app.test/about/</loc>");
    expect(sitemapBody).not.toContain("privacy");
    expect(sitemapBody).not.toContain("/s/");

    const contentRobots = await handleRequest(new Request("https://content.test/robots.txt"), env, context);
    expect(await contentRobots.text()).toBe("User-agent: *\nAllow: /\n");
    expect(contentRobots.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
  });

  it("keeps staging informational pages out of search and withholds its sitemap", async () => {
    for (const pathname of ["/", "/about/"]) {
      const response = await handleRequest(new Request(`https://app.test${pathname}`), stagingEnv, context);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
      expect(await response.text()).toContain('name="robots" content="noindex,nofollow,noarchive"');
    }

    const robots = await handleRequest(new Request("https://app.test/robots.txt"), stagingEnv, context);
    expect(await robots.text()).toBe("User-agent: *\nAllow: /\n");
    expect(robots.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");

    const sitemap = await handleRequest(new Request("https://app.test/sitemap.xml"), stagingEnv, context);
    expect(sitemap.status).toBe(404);
    expect(sitemap.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
  });

  it("keeps utility, protected, asset and unavailable responses out of search", async () => {
    const requests = [
      new Request("https://app.test/health"),
      new Request("https://app.test/login"),
      new Request("https://app.test/admin"),
      new Request("https://app.test/mcp"),
      new Request("https://app.test/assets/preview-social.png"),
      new Request("https://app.test/s/not-a-token"),
      new Request("https://content.test/not-found"),
    ];
    for (const request of requests) {
      const response = await handleRequest(request, env, context);
      expect(response.headers.get("x-robots-tag"), new URL(request.url).pathname).toBe("noindex, nofollow, noarchive");
    }
  });

  it("distinguishes unavailable shares from generic public not-found attribution", async () => {
    const unavailable = await handleRequest(new Request("https://app.test/s/not-a-token"), env, context);
    const notFound = await handleRequest(new Request("https://app.test/does-not-exist"), env, context);
    expect(unavailable.status).toBe(404);
    expect(notFound.status).toBe(404);
    const unavailableBody = await unavailable.text();
    const notFoundBody = await notFound.text();
    expectPublicAttribution(anchorHref(unavailableBody, "Explore work"), "/work/", "unavailable");
    expectPublicAttribution(anchorHref(notFoundBody, "Explore work"), "/work/", "not_found");
    expect(unavailableBody).not.toContain("github.com/carlocaprini/preview");
    expect(notFoundBody).not.toContain("github.com/carlocaprini/preview");
  });

  it("redirects an anonymous owner to the local login page", async () => {
    const response = await handleRequest(new Request("https://app.test/admin"), env, context);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login?next=%2Fadmin");
    const login = await handleRequest(new Request("https://app.test/login"), env, context);
    expect(login.status).toBe(200);
    const loginBody = await login.text();
    expect(loginBody).toContain('id="login-form"');
    expect(loginBody).not.toContain("github.com/carlocaprini/preview");
    expect(loginBody).not.toContain('href="/about/"');
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
    const body = await response.text();
    expect(body).toContain('id="admin-app"');
    expect(body).not.toContain('href="/about/"');
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
