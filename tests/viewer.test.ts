import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { D1PublishingRepository } from "../src/data/repository.ts";
import { D1AssetStore } from "../src/data/assets.ts";
import { handleRequest } from "../src/index.ts";
import { PublishingService } from "../src/services/publishing.ts";
import { createOwnerSession, OWNER_SESSION_COOKIE } from "../src/security/auth.ts";
import { D1PdfRepository } from "../src/data/pdf.ts";
import type { PreviewEnv, PreviewExecutionContext } from "../src/types.ts";

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
    for (const name of [
      "0001_initial.sql",
      "0002_public_snapshots.sql",
      "0003_measurement_receipts.sql",
      "0004_d1_asset_storage.sql",
      "0005_latest_only_retention.sql",
      "0006_pdf_companion.sql",
    ]) {
      const path = fileURLToPath(new URL(`../migrations/${name}`, import.meta.url));
      this.raw.exec(readFileSync(path, "utf8"));
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

const anonymous = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as PreviewExecutionContext;

async function ownerRequest(env: PreviewEnv, url: string, init: RequestInit = {}): Promise<Request> {
  const token = await createOwnerSession(env);
  const headers = new Headers(init.headers);
  headers.set("cookie", `${OWNER_SESSION_COOKIE}=${token}`);
  if (!["GET", "HEAD", "OPTIONS"].includes((init.method ?? "GET").toUpperCase())) {
    headers.set("origin", env.APP_ORIGIN);
  }
  return new Request(url, { ...init, headers });
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function uploadRequest(value: Uint8Array): Request {
  return new Request("https://app.test/upload", {
    method: "PUT",
    headers: { "Content-Length": String(value.byteLength) },
    body: value.slice().buffer as ArrayBuffer,
  });
}

function iframeSource(page: string): string {
  const match = page.match(/<iframe[^>]+src="([^"]+)"/u);
  if (!match?.[1]) throw new Error("Viewer iframe source missing");
  return match[1].replaceAll("&amp;", "&");
}

describe("public and owner viewing", () => {
  let database: SqliteD1;
  let env: PreviewEnv;
  let publishing: PublishingService;

  beforeEach(() => {
    database = new SqliteD1();
    env = {
      DB: database as unknown as D1Database,
      OWNER_PASSWORD: "test-owner-password-with-enough-entropy",
      MCP_BEARER_TOKEN: "test-mcp-bearer-token-with-enough-entropy",
      SHARE_SIGNING_KEY: "viewer-test-signing-key-at-least-thirty-two-bytes",
      APP_ORIGIN: "https://app.test",
      CONTENT_ORIGIN: "https://content.test",
      ENVIRONMENT: "test",
    };
    publishing = new PublishingService(
      new D1PublishingRepository(env.DB),
      new D1AssetStore(database as unknown as D1Database),
      env.APP_ORIGIN,
      env.SHARE_SIGNING_KEY,
    );
  });

  async function publish(title: string, html: string) {
    const payload = bytes(html);
    const plan = await publishing.createContent({
      title,
      sourceFormat: "html",
      files: [{ path: "index.html", size: payload.byteLength }],
    });
    await publishing.uploadAsset(plan.uploadId, "index.html", uploadRequest(payload));
    await publishing.commit(plan.uploadId);
    return plan;
  }

  async function attachPdf(contentId: string, activeVersionId: string, payload: Uint8Array, fileName = "companion.pdf") {
    const start = await handleRequest(
      await ownerRequest(env, `https://app.test/api/admin/contents/${contentId}/pdf/uploads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileName, size: payload.byteLength, expectedActiveVersionId: activeVersionId }),
      }),
      env,
      anonymous,
    );
    expect(start.status).toBe(201);
    const plan = await start.json() as { uploadUrl: string; commitUrl: string; pdfId: string };
    const uploaded = await handleRequest(
      await ownerRequest(env, plan.uploadUrl, {
        method: "PUT",
        headers: { "content-type": "application/pdf" },
        body: payload.slice().buffer as ArrayBuffer,
      }),
      env,
      anonymous,
    );
    expect(uploaded.status).toBe(204);
    const committed = await handleRequest(await ownerRequest(env, plan.commitUrl, { method: "POST" }), env, anonymous);
    expect(committed.status).toBe(200);
    return plan;
  }

  it("serves a deliberately generic shell and gates every shared asset", async () => {
    const plan = await publish("Confidential roadmap", "<h1>First</h1>");
    const link = await publishing.createShareLink({ contentId: plan.contentId, label: "Board", validForSeconds: null });

    const shell = await handleRequest(new Request(link.url), env, anonymous);
    const page = await shell.text();
    expect(shell.status).toBe(200);
    expect(page).toContain("Shared preview");
    expect(page).not.toContain("Confidential roadmap");
    expect(page).not.toContain("Board");
    expect(page).not.toMatch(/Version\s+1/iu);
    expect(page).toContain('sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"');
    expect(page).not.toContain("allow-top-navigation");
    expect(shell.headers.get("cache-control")).toContain("no-store");
    expect(shell.headers.get("referrer-policy")).toBe("no-referrer");

    const content = await handleRequest(new Request(iframeSource(page)), env, anonymous);
    expect(content.status).toBe(200);
    expect(await content.text()).toBe("<h1>First</h1>");
    expect(content.headers.get("content-security-policy")).toContain(`frame-ancestors ${env.APP_ORIGIN}`);
    expect(content.headers.get("content-security-policy")).toContain(
      "style-src 'self' 'unsafe-inline' https: data: blob:",
    );
    expect(content.headers.get("content-security-policy")).toContain(
      "script-src 'self' 'unsafe-inline' https: data: blob:",
    );
    expect(content.headers.get("referrer-policy")).toBe("no-referrer");

    const tampered = new URL(iframeSource(page));
    tampered.pathname = tampered.pathname.replace("index.html", "private.txt");
    expect((await handleRequest(new Request(tampered), env, anonymous)).status).toBe(404);
  });

  it("keeps an open view version-consistent and moves new navigation to the latest version", async () => {
    const first = await publish("Versioned", "<h1>First</h1>");
    const link = await publishing.createShareLink({ contentId: first.contentId, label: "Stable", validForSeconds: null });
    const oldShell = await handleRequest(new Request(link.url), env, anonymous);
    const oldSource = iframeSource(await oldShell.text());

    const nextBytes = bytes("<h1>Second</h1>");
    const next = await publishing.startVersion(first.contentId, "html", [{ path: "index.html", size: nextBytes.byteLength }]);
    await publishing.uploadAsset(next.uploadId, "index.html", uploadRequest(nextBytes));
    await publishing.commit(next.uploadId);

    const pinned = await handleRequest(new Request(oldSource), env, anonymous);
    expect(await pinned.text()).toBe("<h1>First</h1>");

    database.raw
      .prepare("UPDATE content_version SET purge_after = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", first.versionId);
    expect((await handleRequest(new Request(oldSource), env, anonymous)).status).toBe(404);

    const freshShell = await handleRequest(new Request(link.url), env, anonymous);
    const freshSource = iframeSource(await freshShell.text());
    expect(freshSource).not.toBe(oldSource);
    expect(await (await handleRequest(new Request(freshSource), env, anonymous)).text()).toBe("<h1>Second</h1>");
  });

  it("invalidates the shell and its pinned assets immediately after revocation", async () => {
    const plan = await publish("Revocable", "<h1>Private</h1>");
    const link = await publishing.createShareLink({ contentId: plan.contentId, label: "Review", validForSeconds: null });
    const initial = await handleRequest(new Request(link.url), env, anonymous);
    const source = iframeSource(await initial.text());
    const linkId = database.raw.prepare("SELECT id FROM share_link").get() as { id: string };

    const revoked = await handleRequest(
      await ownerRequest(env, `https://app.test/api/admin/links/${linkId.id}/revoke`, { method: "POST" }),
      env,
      anonymous,
    );
    expect(revoked.status).toBe(200);
    expect((await handleRequest(new Request(link.url), env, anonymous)).status).toBe(410);
    expect((await handleRequest(new Request(source), env, anonymous)).status).toBe(404);
  });

  it("edits expiry without changing the URL and blocks expired links", async () => {
    const plan = await publish("Expiring", "<h1>Brief</h1>");
    const link = await publishing.createShareLink({ contentId: plan.contentId, label: "Temporary", validForSeconds: null });
    const linkId = database.raw.prepare("SELECT id FROM share_link").get() as { id: string };
    const edited = await handleRequest(
      await ownerRequest(env, `https://app.test/api/admin/links/${linkId.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expiresAt: "2000-01-01T00:00:00.000Z" }),
      }),
      env,
      anonymous,
    );
    expect(edited.status).toBe(200);
    expect((await handleRequest(new Request(link.url), env, anonymous)).status).toBe(410);
    expect(link.url).toMatch(/^https:\/\/app\.test\/s\/[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/u);
  });

  it("supports owner preview before sharing and refuses anonymous content-origin preview", async () => {
    const plan = await publish("Owner only", "<h1>Unshared</h1>");
    const shell = await handleRequest(
      await ownerRequest(env, `https://app.test/api/admin/contents/${plan.contentId}/preview`),
      env,
      anonymous,
    );
    const source = iframeSource(await shell.text());
    expect(shell.status).toBe(200);
    expect(await (await handleRequest(new Request(source), env, anonymous)).text()).toBe("<h1>Unshared</h1>");
    const tampered = new URL(source);
    tampered.pathname = tampered.pathname.replace("/preview/", "/preview/x");
    expect((await handleRequest(new Request(tampered), env, anonymous)).status).toBe(404);
  });

  it("uses one branded unavailable response for missing and malformed links", async () => {
    const missing = await handleRequest(new Request("https://app.test/s/AAAAAAAAAAAAAAAAAAAAAA.bad"), env, anonymous);
    const malformed = await handleRequest(new Request("https://app.test/s/not-a-token"), env, anonymous);
    expect(missing.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(await missing.text()).toBe(await malformed.text());
  });

  it("records only aggregate, replay-protected meaningful views and visible time", async () => {
    const plan = await publish("Measured", "<h1>Measured</h1>");
    const link = await publishing.createShareLink({ contentId: plan.contentId, label: "Analytics", validForSeconds: null });
    const shell = await handleRequest(new Request(link.url), env, anonymous);
    const source = new URL(iframeSource(await shell.text()));
    const snapshotId = source.pathname.split("/")[4];
    const token = new URL(link.url).pathname.slice(3);
    expect(snapshotId).toBeTruthy();

    const measure = (receiptId: string, kind: "view" | "visible", visibleMs = 0) =>
      handleRequest(
        new Request("https://app.test/api/public/measure", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, snapshotId, receiptId, kind, visibleMs }),
        }),
        env,
        anonymous,
      );

    expect((await measure("11111111-1111-4111-8111-111111111111", "view")).status).toBe(200);
    expect((await measure("11111111-1111-4111-8111-111111111111", "view")).status).toBe(200);
    expect((await measure("22222222-2222-4222-8222-222222222222", "visible", 15_000)).status).toBe(200);
    const aggregate = database.raw.prepare("SELECT meaningful_views,active_visible_ms FROM daily_aggregate").get() as {
      meaningful_views: number;
      active_visible_ms: number;
    };
    expect(aggregate).toEqual({ meaningful_views: 1, active_visible_ms: 15_000 });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM measurement_receipt").get()).toEqual({ count: 2 });
  });

  it("excludes each authenticated owner measurement without changing public link behavior or analytics", async () => {
    const plan = await publish("Owner measured", "<h1>Owner measured</h1>");
    const link = await publishing.createShareLink({ contentId: plan.contentId, label: "Owner check", validForSeconds: null });
    const ownerToken = await createOwnerSession(env);
    const ownerCookie = `${OWNER_SESSION_COOKIE}=${ownerToken}`;
    const shell = await handleRequest(new Request(link.url, { headers: { cookie: ownerCookie } }), env, anonymous);
    const snapshotId = new URL(iframeSource(await shell.text())).pathname.split("/")[4];
    const token = new URL(link.url).pathname.slice(3);
    expect(shell.status).toBe(200);
    expect(snapshotId).toBeTruthy();

    const measure = (receiptId: string, kind: "view" | "visible", cookie?: string, visibleMs = 0) => {
      const headers = new Headers({ "content-type": "application/json" });
      if (cookie) headers.set("cookie", cookie);
      return handleRequest(
        new Request("https://app.test/api/public/measure", {
          method: "POST",
          headers,
          body: JSON.stringify({ token, snapshotId, receiptId, kind, visibleMs }),
        }),
        env,
        anonymous,
      );
    };

    expect(await (await measure("owner-view-000000000001", "view", ownerCookie)).json()).toEqual({ recorded: false });
    expect(await (await measure("owner-visible-00000001", "visible", ownerCookie, 5_000)).json()).toEqual({ recorded: false });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM measurement_receipt").get()).toEqual({ count: 0 });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM daily_aggregate").get()).toEqual({ count: 0 });

    expect(await (await measure("logged-out-view-0000001", "view")).json()).toEqual({ recorded: true });
    const afterLogout = database.raw
      .prepare("SELECT meaningful_views,active_visible_ms,last_view_at FROM daily_aggregate")
      .get() as { meaningful_views: number; active_visible_ms: number; last_view_at: string };
    expect(afterLogout.meaningful_views).toBe(1);
    expect(afterLogout.active_visible_ms).toBe(0);
    expect(afterLogout.last_view_at).toBeTruthy();

    expect(await (await measure("owner-view-000000000002", "view", ownerCookie)).json()).toEqual({ recorded: false });
    expect(await (await measure("owner-visible-00000002", "visible", ownerCookie, 7_000)).json()).toEqual({ recorded: false });
    expect(database.raw.prepare("SELECT meaningful_views,active_visible_ms,last_view_at FROM daily_aggregate").get()).toEqual(
      afterLogout,
    );
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM measurement_receipt").get()).toEqual({ count: 1 });
  });

  it("counts forged and expired owner sessions and ignores client-provided owner claims", async () => {
    const plan = await publish("Claimed owner", "<h1>Claimed owner</h1>");
    const link = await publishing.createShareLink({ contentId: plan.contentId, label: "Claims", validForSeconds: null });
    const shell = await handleRequest(new Request(link.url), env, anonymous);
    const snapshotId = new URL(iframeSource(await shell.text())).pathname.split("/")[4];
    const token = new URL(link.url).pathname.slice(3);
    const validToken = await createOwnerSession(env);
    const expiredToken = await createOwnerSession(env, new Date(Date.now() - 60_000), 1);

    const measure = (receiptId: string, cookie: string, kind: "view" | "visible" = "view", visibleMs = 0) =>
      handleRequest(
        new Request("https://app.test/api/public/measure", {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ token, snapshotId, receiptId, kind, visibleMs, owner: true, isAdmin: true }),
        }),
        env,
        anonymous,
      );

    expect(await (await measure("forged-owner-000000001", `${OWNER_SESSION_COOKIE}=${validToken}x`)).json()).toEqual({
      recorded: true,
    });
    expect(await (await measure("expired-owner-00000001", `${OWNER_SESSION_COOKIE}=${expiredToken}`)).json()).toEqual({
      recorded: true,
    });
    expect(await (await measure("claimed-owner-00000001", "unrelated=value", "visible", 3_000)).json()).toEqual({
      recorded: true,
    });
    expect(database.raw.prepare("SELECT meaningful_views,active_visible_ms FROM daily_aggregate").get()).toEqual({
      meaningful_views: 2,
      active_visible_ms: 3_000,
    });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM measurement_receipt").get()).toEqual({ count: 3 });
  });

  it("returns an owner-only two-screen workspace with reconstructed stable links", async () => {
    const plan = await publish("Admin item", "<h1>Admin</h1>");
    const link = await publishing.createShareLink({ contentId: plan.contentId, label: "Client", validForSeconds: null });
    const library = await handleRequest(await ownerRequest(env, "https://app.test/api/admin/contents"), env, anonymous);
    expect(library.status).toBe(200);
    expect(await library.json()).toMatchObject({
      contents: [{ id: plan.contentId, title: "Admin item", activeVersion: 1, activeLinkCount: 1 }],
    });

    const detail = await handleRequest(
      await ownerRequest(env, `https://app.test/api/admin/contents/${plan.contentId}`),
      env,
      anonymous,
    );
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      id: plan.contentId,
      versions: [{ sequence: 1, status: "ready" }],
      links: [{ label: "Client", url: link.url, state: "active" }],
    });
    expect((await handleRequest(new Request("https://app.test/api/admin/contents"), env, anonymous)).status).toBe(401);
  });

  it("uploads, guards, reuses, measures, and removes a PDF companion", async () => {
    const first = await publish("PDF lifecycle", "<h1>First</h1>");
    const link = await publishing.createShareLink({ contentId: first.contentId, label: "Recipient", validForSeconds: null });
    expect(await (await handleRequest(new Request(link.url), env, anonymous)).text()).not.toContain("Download PDF");

    const pdfBytes = bytes("%PDF-1.7\ncompanion A");
    const pdf = await attachPdf(first.contentId, first.versionId, pdfBytes, "Board pack.pdf");
    const shell = await handleRequest(new Request(link.url), env, anonymous);
    expect(await shell.text()).toContain("Download PDF");

    const pending: Promise<unknown>[] = [];
    const tracked = { waitUntil(promise: Promise<unknown>) { pending.push(promise); }, passThroughOnException() {}, props: {} } as unknown as PreviewExecutionContext;
    const download = await handleRequest(new Request(`${link.url}/pdf`), env, tracked);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/pdf");
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(pdfBytes);
    await Promise.all(pending);
    expect(database.raw.prepare("SELECT pdf_downloads_served,meaningful_views FROM daily_aggregate").get()).toEqual({
      pdf_downloads_served: 1,
      meaningful_views: 0,
    });

    const ownerDownload = await handleRequest(await ownerRequest(env, `${link.url}/pdf`), env, tracked);
    expect(new Uint8Array(await ownerDownload.arrayBuffer())).toEqual(pdfBytes);
    const head = await handleRequest(new Request(`${link.url}/pdf`, { method: "HEAD" }), env, tracked);
    expect(head.status).toBe(200);
    expect(database.raw.prepare("SELECT pdf_downloads_served FROM daily_aggregate").get()).toEqual({ pdf_downloads_served: 1 });

    const canceled = await handleRequest(new Request(`${link.url}/pdf`), env, tracked);
    await canceled.body?.cancel("recipient canceled");
    await Promise.all(pending);
    expect(database.raw.prepare("SELECT pdf_downloads_served FROM daily_aggregate").get()).toEqual({ pdf_downloads_served: 1 });

    const nextBytes = bytes("<h1>Second</h1>");
    const next = await publishing.startVersion(first.contentId, "html", [{ path: "index.html", size: nextBytes.byteLength }]);
    await publishing.uploadAsset(next.uploadId, "index.html", uploadRequest(nextBytes));
    expect(await (await handleRequest(new Request(link.url), env, anonymous)).text()).toContain("Download PDF");
    await publishing.commit(next.uploadId);
    expect(await (await handleRequest(new Request(link.url), env, anonymous)).text()).not.toContain("Download PDF");
    expect((await handleRequest(new Request(`${link.url}/pdf`), env, anonymous)).status).toBe(404);

    const confirmed = await handleRequest(
      await ownerRequest(env, `https://app.test/api/admin/contents/${first.contentId}/pdf/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pdfId: pdf.pdfId, expectedActiveVersionId: next.versionId }),
      }),
      env,
      anonymous,
    );
    expect(confirmed.status).toBe(200);
    expect(await (await handleRequest(new Request(link.url), env, anonymous)).text()).toContain("Download PDF");

    const removed = await handleRequest(
      await ownerRequest(env, `https://app.test/api/admin/contents/${first.contentId}/pdf`, { method: "DELETE" }),
      env,
      anonymous,
    );
    expect(removed.status).toBe(200);
    expect((await handleRequest(new Request(`${link.url}/pdf`), env, anonymous)).status).toBe(404);
    expect(database.raw.prepare("SELECT pdf_downloads_served FROM daily_aggregate").get()).toEqual({ pdf_downloads_served: 1 });
    expect(await new D1PdfRepository(env.DB).cleanup(new Date(Date.now() + 25 * 60 * 60 * 1_000))).toBe(1);
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM pdf_companion").get()).toEqual({ count: 0 });
    expect(database.raw.prepare("SELECT pdf_downloads_served FROM daily_aggregate").get()).toEqual({ pdf_downloads_served: 1 });
  });

  it("rejects invalid PDF data and stale commits without replacing an approved companion", async () => {
    const first = await publish("PDF validation", "<h1>First</h1>");
    const original = bytes("%PDF-1.7\noriginal");
    await attachPdf(first.contentId, first.versionId, original);

    const start = await handleRequest(
      await ownerRequest(env, `https://app.test/api/admin/contents/${first.contentId}/pdf/uploads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileName: "bad.pdf", size: 5, expectedActiveVersionId: first.versionId }),
      }), env, anonymous,
    );
    const plan = await start.json() as { uploadUrl: string; commitUrl: string };
    const bad = await handleRequest(
      await ownerRequest(env, plan.uploadUrl, { method: "PUT", body: bytes("hello").buffer as ArrayBuffer }),
      env, anonymous,
    );
    expect(bad.status).toBe(400);

    const replacement = bytes("%PDF-1.7\nreplacement");
    const replacementStart = await handleRequest(
      await ownerRequest(env, `https://app.test/api/admin/contents/${first.contentId}/pdf/uploads`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileName: "new.pdf", size: replacement.byteLength, expectedActiveVersionId: first.versionId }),
      }), env, anonymous,
    );
    const replacementPlan = await replacementStart.json() as { uploadUrl: string; commitUrl: string };
    expect((await handleRequest(await ownerRequest(env, replacementPlan.uploadUrl, { method: "PUT", body: replacement.buffer as ArrayBuffer }), env, anonymous)).status).toBe(204);

    const nextBytes = bytes("<h1>Second</h1>");
    const next = await publishing.startVersion(first.contentId, "html", [{ path: "index.html", size: nextBytes.byteLength }]);
    await publishing.uploadAsset(next.uploadId, "index.html", uploadRequest(nextBytes));
    await publishing.commit(next.uploadId);
    expect((await handleRequest(await ownerRequest(env, replacementPlan.commitUrl, { method: "POST" }), env, anonymous)).status).toBe(409);
    const detail = await handleRequest(await ownerRequest(env, `https://app.test/api/admin/contents/${first.contentId}`), env, anonymous);
    expect(await detail.json()).toMatchObject({ pdfCompanion: { state: "outdated", fileName: "companion.pdf" } });
  });
});
