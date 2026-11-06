import { createServer } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { aboutPage, adminPage, homePage, loginPage, unavailablePage, viewerPage } from "../src/ui/pages.ts";
import { routeAuthApi } from "../src/api/auth.ts";
import { routeAnalyticsApi } from "../src/api/analytics.ts";
import { D1PublishingRepository } from "../src/data/repository.ts";
import { D1AssetStore } from "../src/data/assets.ts";
import { D1ViewerRepository } from "../src/data/viewer.ts";
import { PublishingService } from "../src/services/publishing.ts";
import { ViewerService } from "../src/services/viewer.ts";
import type { PreviewEnv } from "../src/types.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const adminScript = readFileSync(`${root}/src/client/admin.js`, "utf8");
const loginScript = readFileSync(`${root}/src/client/login.js`, "utf8");
const viewerScript = readFileSync(`${root}/src/client/viewer.js`, "utf8");
const fflateScript = readFileSync(`${root}/node_modules/fflate/umd/index.js`, "utf8");
const port = Number(process.env.E2E_PORT ?? 43917);
const contentPort = port + 1;
const appOrigin = `http://127.0.0.1:${port}`;
const contentOrigin = `http://localhost:${contentPort}`;

class BoundStatement {
  constructor(private readonly statement: StatementSync, private readonly values: unknown[] = []) {}

  bind(...values: unknown[]): BoundStatement {
    return new BoundStatement(this.statement, values);
  }

  async run() {
    const result = this.statement.run(...(this.values as Parameters<StatementSync["run"]>));
    return { success: true, meta: { changes: Number(result.changes) }, results: [] };
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...(this.values as Parameters<StatementSync["get"]>)) as T | undefined) ?? null;
  }

  async all<T>() {
    return {
      success: true,
      meta: { changes: 0 },
      results: this.statement.all(...(this.values as Parameters<StatementSync["all"]>)) as T[],
    };
  }
}

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    for (const name of readdirSync(`${root}/migrations`).filter((entry) => /^\d{4}_.+\.sql$/u.test(entry)).sort()) {
      this.raw.exec(readFileSync(`${root}/migrations/${name}`, "utf8"));
    }
  }

  prepare(sql: string): BoundStatement {
    return new BoundStatement(this.raw.prepare(sql));
  }

  async batch(statements: BoundStatement[]) {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.raw.exec("COMMIT");
      return results;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }
}

const database = new SqliteD1();
const env: PreviewEnv = {
  DB: database as unknown as D1Database,
  OWNER_PASSWORD: "test-owner-password",
  MCP_BEARER_TOKEN: "test-mcp-bearer-token-with-enough-entropy",
  SHARE_SIGNING_KEY: "browser-owner-analytics-signing-key-at-least-thirty-two-bytes",
  APP_ORIGIN: appOrigin,
  CONTENT_ORIGIN: contentOrigin,
  ENVIRONMENT: "test",
};
const assets = new D1AssetStore(env.DB);
const publishing = new PublishingService(
  new D1PublishingRepository(env.DB),
  assets,
  env.APP_ORIGIN,
  env.SHARE_SIGNING_KEY,
);
const viewer = new ViewerService(new D1ViewerRepository(env.DB), assets, env.SHARE_SIGNING_KEY);

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("cache-control", "no-store");
  if (request.method === "POST" && url.pathname === "/test/analytics-fixtures") {
    const fixture = await createAnalyticsFixture();
    return send(response, JSON.stringify(fixture), "application/json; charset=utf-8", 201);
  }
  const fixtureState = url.pathname.match(/^\/test\/analytics-fixtures\/([^/]+)$/u);
  if (request.method === "GET" && fixtureState?.[1]) {
    return send(
      response,
      JSON.stringify(analyticsState(decodeURIComponent(fixtureState[1]))),
      "application/json; charset=utf-8",
    );
  }
  if (request.method === "POST" && url.pathname.startsWith("/api/auth/")) {
    const routed = await routeAuthApi(await fetchRequest(request, appOrigin), env);
    return relay(response, routed ?? new Response("Not found", { status: 404 }));
  }
  if (request.method === "POST" && url.pathname === "/api/public/measure") {
    const routed = await routeAnalyticsApi(await fetchRequest(request, appOrigin), env);
    return relay(response, routed ?? new Response("Not found", { status: 404 }));
  }
  const share = url.pathname.match(/^\/s\/(.+)$/u);
  if (request.method === "GET" && share?.[1]) {
    const resolved = await viewer.resolveSharedView(share[1]);
    if (resolved.state !== "active" || !resolved.contentId || !resolved.snapshotId) {
      return send(response, unavailablePage(), "text/html; charset=utf-8", resolved.state === "invalid" ? 404 : 410);
    }
    const source = `${contentOrigin}/s/${encodeURIComponent(share[1])}/v/${resolved.snapshotId}/index.html`;
    return send(
      response,
      viewerPage(source, { token: share[1], contentId: resolved.contentId, snapshotId: resolved.snapshotId }),
      "text/html; charset=utf-8",
    );
  }
  if (url.pathname === "/assets/admin.js") return send(response, adminScript, "text/javascript; charset=utf-8");
  if (url.pathname === "/assets/login.js") return send(response, loginScript, "text/javascript; charset=utf-8");
  if (url.pathname === "/assets/viewer.js") return send(response, viewerScript, "text/javascript; charset=utf-8");
  if (url.pathname === "/assets/fflate.js") return send(response, fflateScript, "text/javascript; charset=utf-8");
  if (url.pathname === "/content") {
    const dark = url.searchParams.get("theme") === "dark";
    const palette = dark ? "color-scheme:dark;background:#0b1220;color:#f5f7fa" : "color-scheme:light;background:#fff;color:#101828";
    return send(
      response,
      `<!doctype html><html data-theme="${dark ? "dark" : "light"}"><head><style>html,body{margin:0;min-height:100%;${palette}}main{padding:2rem}</style></head><body><main><h1>Shared prototype</h1><p>${dark ? "Dark" : "Light"} sample</p></main></body></html>`,
      "text/html; charset=utf-8",
    );
  }
  if (url.pathname === "/viewer") {
    const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
    const pdfUrl = url.searchParams.get("pdf") === "1" ? "/s/test-token/pdf" : undefined;
    return send(
      response,
      viewerPage(`http://127.0.0.1:${port}/content?theme=${theme}`, {
        token: "test-token",
        contentId: "550e8400-e29b-41d4-a716-446655440000",
        snapshotId: "snapshot",
        pdfUrl,
      }),
      "text/html; charset=utf-8",
    );
  }
  if (url.pathname === "/unavailable") return send(response, unavailablePage(), "text/html; charset=utf-8", 410);
  if (url.pathname === "/about/") return send(response, aboutPage(), "text/html; charset=utf-8");
  if (url.pathname === "/login") return send(response, loginPage(), "text/html; charset=utf-8");
  if (url.pathname === "/admin" || /^\/admin\/contents\/[^/]+$/u.test(url.pathname)) {
    return send(response, adminPage(), "text/html; charset=utf-8");
  }
  if (url.pathname === "/") return send(response, homePage(), "text/html; charset=utf-8");
  return send(response, "Not found", "text/plain; charset=utf-8", 404);
}).listen(port, "127.0.0.1", () => console.log(`E2E server listening on http://127.0.0.1:${port}`));

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", contentOrigin);
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("cache-control", "no-store");
  if (url.pathname === "/launch") {
    const target = url.searchParams.get("target") ?? "";
    if (!target.startsWith(`${appOrigin}/s/`)) return send(response, "Invalid target", "text/plain; charset=utf-8", 400);
    return send(
      response,
      `<!doctype html><title>External launcher</title><a href="${target.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">Open shared preview</a>`,
      "text/html; charset=utf-8",
    );
  }
  const shared = url.pathname.match(/^\/s\/([^/]+)\/v\/([^/]+)\/(.+)$/u);
  if (request.method === "GET" && shared?.[1] && shared[2] && shared[3]) {
    const asset = await viewer.getSharedAsset(decodeURIComponent(shared[1]), shared[2], shared[3]);
    if (!asset) return send(response, "Not found", "text/plain; charset=utf-8", 404);
    response.statusCode = 200;
    response.setHeader("content-type", asset.mediaType);
    response.setHeader("content-length", String(asset.size));
    response.end(Buffer.from(await new Response(asset.body).arrayBuffer()));
    return;
  }
  return send(response, "Not found", "text/plain; charset=utf-8", 404);
}).listen(contentPort, "localhost", () => console.log(`E2E content server listening on ${contentOrigin}`));

async function createAnalyticsFixture(): Promise<{ linkUrl: string; linkId: string }> {
  const payload = new TextEncoder().encode("<!doctype html><title>Analytics fixture</title><h1>Analytics fixture</h1>");
  const plan = await publishing.createContent({
    title: "Analytics fixture",
    sourceFormat: "html",
    files: [{ path: "index.html", size: payload.byteLength }],
  });
  await publishing.uploadAsset(
    plan.uploadId,
    "index.html",
    new Request(`${appOrigin}/upload`, {
      method: "PUT",
      headers: { "content-length": String(payload.byteLength) },
      body: payload.slice().buffer as ArrayBuffer,
    }),
  );
  await publishing.commit(plan.uploadId);
  const link = await publishing.createShareLink({ contentId: plan.contentId, label: "Browser analytics", validForSeconds: null });
  const row = database.raw.prepare("SELECT id FROM share_link WHERE content_id = ?").get(plan.contentId) as { id: string };
  return { linkUrl: link.url, linkId: row.id };
}

function analyticsState(linkId: string) {
  const receipts = database.raw
    .prepare("SELECT COUNT(*) AS count FROM measurement_receipt WHERE share_link_id = ?")
    .get(linkId) as { count: number };
  const aggregate = database.raw
    .prepare(
      `SELECT COALESCE(SUM(meaningful_views),0) AS meaningful_views,
              COALESCE(SUM(active_visible_ms),0) AS active_visible_ms,
              MAX(last_view_at) AS last_view_at
         FROM daily_aggregate
        WHERE share_link_id = ?`,
    )
    .get(linkId) as { meaningful_views: number; active_visible_ms: number; last_view_at: string | null };
  return {
    receiptCount: Number(receipts.count),
    meaningfulViews: Number(aggregate.meaningful_views),
    activeVisibleMs: Number(aggregate.active_visible_ms),
    lastViewAt: aggregate.last_view_at,
  };
}

async function fetchRequest(request: import("node:http").IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) headers.set(name, value.join(", "));
    else if (value !== undefined) headers.set(name, value);
  }
  const method = request.method ?? "GET";
  return new Request(new URL(request.url ?? "/", origin), {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
  });
}

async function relay(response: import("node:http").ServerResponse, routed: Response) {
  response.statusCode = routed.status;
  for (const [name, value] of routed.headers) response.setHeader(name, value);
  response.end(Buffer.from(await routed.arrayBuffer()));
}

function send(response: import("node:http").ServerResponse, body: string, mediaType: string, status = 200) {
  response.statusCode = status;
  response.setHeader("content-type", mediaType);
  response.end(body);
}
