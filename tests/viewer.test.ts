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
import { ContentSourceService } from "../src/services/content-source.ts";
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
  private batchTail: Promise<void> = Promise.resolve();

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
    const previous = this.batchTail;
    let release: () => void = () => {};
    this.batchTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.raw.exec("COMMIT");
      return results;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    } finally {
      release();
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

function anchorHref(page: string, label: string): string {
  const match = page.match(new RegExp(`<a[^>]+href="([^"]+)"[^>]*>${label}</a>`, "u"));
  if (!match?.[1]) throw new Error(`Missing ${label} link`);
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

  async function stagePdf(contentId: string, activeVersionId: string, payload: Uint8Array, fileName = "companion.pdf") {
    const repository = new D1PdfRepository(env.DB);
    const plan = await repository.startUpload({
      contentId,
      fileName,
      size: payload.byteLength,
      expectedActiveVersionId: activeVersionId,
      now: new Date(),
      appOrigin: env.APP_ORIGIN,
    });
    await repository.uploadData(plan.uploadId, new Response(payload.slice().buffer as ArrayBuffer).body);
    return { repository, plan };
  }

  function trackedContext() {
    const pending: Promise<unknown>[] = [];
    const context = {
      waitUntil(promise: Promise<unknown>) { pending.push(promise); },
      passThroughOnException() {},
      props: {},
    } as unknown as PreviewExecutionContext;
    return { context, pending };
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
    expect(page).toContain("Preview built by&nbsp;");
    const builder = new URL(anchorHref(page, "Carlo Caprini"));
    const work = new URL(anchorHref(page, "Explore work"));
    for (const siteUrl of [builder, work]) {
      expect(siteUrl.searchParams.get("utm_source")).toBe("preview");
      expect(siteUrl.searchParams.get("utm_medium")).toBe("referral");
      expect(siteUrl.searchParams.get("utm_campaign")).toBe("shared_content");
      expect(siteUrl.searchParams.get("utm_content")).toBe(`doc_${plan.contentId.replaceAll("-", "")}`);
      expect(siteUrl.href).not.toContain(new URL(link.url).pathname.slice(3));
      expect(siteUrl.href).not.toContain("Board");
      expect(siteUrl.href).not.toContain(plan.versionId);
    }
    expect(builder.pathname).toBe("/");
    expect(work.pathname).toBe("/work/");
    expect(page).toContain('target="_blank" rel="noopener noreferrer">Carlo Caprini</a>');
    expect(page).toContain('target="_blank" rel="noopener noreferrer">Explore work</a>');
    expect(page).not.toContain("Shared by&nbsp;");
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
    const oldPage = await oldShell.text();
    const oldSource = iframeSource(oldPage);
    const oldReferral = anchorHref(oldPage, "Explore work");

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
    const freshPage = await freshShell.text();
    const freshSource = iframeSource(freshPage);
    expect(freshSource).not.toBe(oldSource);
    expect(anchorHref(freshPage, "Explore work")).toBe(oldReferral);
    expect(await (await handleRequest(new Request(freshSource), env, anonymous)).text()).toBe("<h1>Second</h1>");
  });

  it("keeps document attribution stable across share links and distinct across content", async () => {
    const first = await publish("First", "<h1>First</h1>");
    const firstLink = await publishing.createShareLink({ contentId: first.contentId, label: "One", validForSeconds: null });
    const secondLink = await publishing.createShareLink({ contentId: first.contentId, label: "Two", validForSeconds: null });
    const second = await publish("Second", "<h1>Second</h1>");
    const otherLink = await publishing.createShareLink({ contentId: second.contentId, label: "Other", validForSeconds: null });

    const hrefs = await Promise.all([firstLink, secondLink, otherLink].map(async (share) =>
      anchorHref(await (await handleRequest(new Request(share.url), env, anonymous)).text(), "Explore work"),
    ));
    expect(hrefs[1]).toBe(hrefs[0]);
    expect(hrefs[2]).not.toBe(hrefs[0]);
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
    const page = await shell.text();
    const source = iframeSource(page);
    expect(shell.status).toBe(200);
    expect(page).not.toContain("utm_source");
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
    const link = await publishing.createShareLink({ contentId: first.contentId, label: "Validation", validForSeconds: null });

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
    expect(new Uint8Array(await (await handleRequest(new Request(`${link.url}/pdf`), env, anonymous)).arrayBuffer())).toEqual(original);

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

  it("keeps duplicate commits idempotent and resolves opposing replacement races without harming the live PDF", async () => {
    const first = await publish("Concurrent PDF", "<h1>Concurrent</h1>");
    const link = await publishing.createShareLink({ contentId: first.contentId, label: "Race", validForSeconds: null });
    const initialBytes = bytes("%PDF-1.7\ninitial");
    const initial = await stagePdf(first.contentId, first.versionId, initialBytes, "initial.pdf");

    const duplicate = await Promise.all([
      initial.repository.commit(initial.plan.uploadId),
      initial.repository.commit(initial.plan.uploadId),
    ]);
    expect(duplicate).toEqual([{ state: "current", id: initial.plan.pdfId, fileName: "initial.pdf", size: initialBytes.byteLength, uploadedAt: expect.any(String), approvedVersionId: first.versionId }, { state: "current", id: initial.plan.pdfId, fileName: "initial.pdf", size: initialBytes.byteLength, uploadedAt: expect.any(String), approvedVersionId: first.versionId }]);
    expect(database.raw.prepare("SELECT status FROM pdf_companion WHERE id = ?").get(initial.plan.pdfId)).toEqual({ status: "ready" });
    database.raw.prepare("UPDATE pdf_companion SET created_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", initial.plan.pdfId);

    const bytesA = bytes("%PDF-1.7\nreplacement A");
    const bytesB = bytes("%PDF-1.7\nreplacement B");
    const replacementA = await stagePdf(first.contentId, first.versionId, bytesA, "a.pdf");
    const replacementB = await stagePdf(first.contentId, first.versionId, bytesB, "b.pdf");
    const raced = await Promise.allSettled([
      replacementA.repository.commit(replacementA.plan.uploadId),
      replacementB.repository.commit(replacementB.plan.uploadId),
    ]);
    expect(raced.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(raced.filter((item) => item.status === "rejected")).toHaveLength(1);

    const live = database.raw.prepare("SELECT current_pdf_id FROM content WHERE id = ?").get(first.contentId) as { current_pdf_id: string };
    expect(live.current_pdf_id).toBe(replacementA.plan.pdfId);
    expect(database.raw.prepare("SELECT status,orphaned_at FROM pdf_companion WHERE id = ?").get(live.current_pdf_id)).toEqual({ status: "ready", orphaned_at: null });
    const served = await handleRequest(new Request(`${link.url}/pdf`), env, anonymous);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytesA);

    const detached = database.raw.prepare(
      "SELECT id,status,orphaned_at FROM pdf_companion WHERE id != ? ORDER BY id",
    ).all(live.current_pdf_id) as Array<{ id: string; status: string; orphaned_at: string | null }>;
    expect(detached).toHaveLength(2);
    expect(detached.every((row) => row.orphaned_at !== null)).toBe(true);
    const detachedAt = Math.max(...detached.map((row) => Date.parse(row.orphaned_at ?? "")));
    expect(await replacementA.repository.cleanup(new Date(detachedAt + 23 * 60 * 60 * 1_000))).toBe(0);
    expect(await replacementA.repository.cleanup(new Date(detachedAt + 25 * 60 * 60 * 1_000))).toBe(2);
    expect(database.raw.prepare("SELECT status FROM pdf_companion WHERE id = ?").get(live.current_pdf_id)).toEqual({ status: "ready" });
  });

  it("keeps delivery counts independent by link and rejects invalid, expired, and revoked PDF requests", async () => {
    const first = await publish("Link PDF", "<h1>Links</h1>");
    const payload = bytes("%PDF-1.7\nlinks");
    await attachPdf(first.contentId, first.versionId, payload, 'Résumé 2026?.pdf');
    const firstLink = await publishing.createShareLink({ contentId: first.contentId, label: "First", validForSeconds: null });
    const secondLink = await publishing.createShareLink({ contentId: first.contentId, label: "Second", validForSeconds: null });

    const complete = async (url: string, request?: Request) => {
      const tracked = trackedContext();
      const response = await handleRequest(request ?? new Request(url), env, tracked.context);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(payload);
      await Promise.all(tracked.pending);
      return response;
    };
    const firstResponse = await complete(`${firstLink.url}/pdf`);
    expect(firstResponse.headers.get("content-disposition")).toContain("filename*=UTF-8''R%C3%A9sum%C3%A9%202026_.pdf");
    await complete(`${secondLink.url}/pdf`);
    await complete(
      `${firstLink.url}/pdf`,
      new Request(`${firstLink.url}/pdf`, { headers: { cookie: `${OWNER_SESSION_COOKIE}=forged.invalid` } }),
    );
    await complete(`${firstLink.url}/pdf`, await ownerRequest(env, `${firstLink.url}/pdf`));

    const counts = database.raw.prepare(
      `SELECT sl.label,COALESCE(SUM(da.pdf_downloads_served),0) AS downloads
         FROM share_link sl LEFT JOIN daily_aggregate da ON da.share_link_id = sl.id
        GROUP BY sl.id ORDER BY sl.label`,
    ).all() as Array<{ label: string; downloads: number }>;
    expect(counts).toEqual([{ label: "First", downloads: 2 }, { label: "Second", downloads: 1 }]);

    const linkRows = database.raw.prepare("SELECT id,label FROM share_link ORDER BY label").all() as Array<{ id: string; label: string }>;
    const firstId = linkRows.find((row) => row.label === "First")?.id;
    const secondId = linkRows.find((row) => row.label === "Second")?.id;
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    database.raw.prepare("UPDATE share_link SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", firstId!);
    database.raw.prepare("UPDATE share_link SET revoked_at = ? WHERE id = ?").run(new Date().toISOString(), secondId!);
    expect((await handleRequest(new Request(`${firstLink.url}/pdf`), env, anonymous)).status).toBe(404);
    expect((await handleRequest(new Request(`${secondLink.url}/pdf`), env, anonymous)).status).toBe(404);
    expect((await handleRequest(new Request("https://app.test/s/not-a-token/pdf"), env, anonymous)).status).toBe(404);
    expect(database.raw.prepare("SELECT SUM(pdf_downloads_served) AS downloads FROM daily_aggregate").get()).toEqual({ downloads: 3 });
  });

  it("does not count partial or failed PDF streams and rejects corrupt storage and invalid sizes", async () => {
    const first = await publish("Stream PDF", "<h1>Stream</h1>");
    const payload = new Uint8Array(600 * 1024);
    payload.set(bytes("%PDF-1.7\n"));
    await attachPdf(first.contentId, first.versionId, payload, "stream.pdf");
    const link = await publishing.createShareLink({ contentId: first.contentId, label: "Stream", validForSeconds: null });
    const pdfId = (database.raw.prepare("SELECT current_pdf_id FROM content WHERE id = ?").get(first.contentId) as { current_pdf_id: string }).current_pdf_id;

    const canceledTracking = trackedContext();
    const canceled = await handleRequest(new Request(`${link.url}/pdf`), env, canceledTracking.context);
    const canceledReader = canceled.body?.getReader();
    expect((await canceledReader?.read())?.value?.byteLength).toBe(512 * 1024);
    await canceledReader?.cancel("stop after first chunk");
    await Promise.all(canceledTracking.pending);
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM daily_aggregate").get()).toEqual({ count: 0 });

    const failedTracking = trackedContext();
    database.raw.prepare("UPDATE pdf_companion_chunk SET bytes = randomblob(length(bytes)) WHERE pdf_id = ? AND chunk_index = 1").run(pdfId);
    const failed = await handleRequest(new Request(`${link.url}/pdf`), env, failedTracking.context);
    const failedReader = failed.body?.getReader();
    expect((await failedReader?.read())?.value?.byteLength).toBe(512 * 1024);
    await expect(failedReader?.read()).rejects.toThrow("PDF chunk is corrupt");
    await Promise.all(failedTracking.pending);
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM daily_aggregate").get()).toEqual({ count: 0 });
    const corruptAgain = await handleRequest(new Request(`${link.url}/pdf`), env, anonymous);
    await expect(corruptAgain.arrayBuffer()).rejects.toThrow("PDF chunk is corrupt");

    const tail = payload.slice(512 * 1024);
    const tailHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", tail)))
      .map((value) => value.toString(16).padStart(2, "0")).join("");
    database.raw.prepare("UPDATE pdf_companion_chunk SET bytes = ?,sha256 = ? WHERE pdf_id = ? AND chunk_index = 1").run(tail, tailHash, pdfId);
    database.raw.prepare("DELETE FROM pdf_companion_chunk WHERE pdf_id = ? AND chunk_index = 1").run(pdfId);
    expect((await handleRequest(new Request(`${link.url}/pdf`), env, anonymous)).status).toBe(404);
    database.raw.prepare("INSERT INTO pdf_companion_chunk (pdf_id,chunk_index,bytes,sha256) VALUES (?,?,?,?)").run(pdfId, 1, tail, tailHash);
    database.raw.prepare("UPDATE pdf_companion SET total_bytes = total_bytes + 1 WHERE id = ?").run(pdfId);
    expect((await handleRequest(new Request(`${link.url}/pdf`), env, anonymous)).status).toBe(404);

    const repository = new D1PdfRepository(env.DB);
    await expect(repository.startUpload({ contentId: first.contentId, fileName: "zero.pdf", size: 0, expectedActiveVersionId: first.versionId, now: new Date(), appOrigin: env.APP_ORIGIN })).rejects.toThrow("PDF size");
    await expect(repository.startUpload({ contentId: first.contentId, fileName: "large.pdf", size: 10 * 1024 * 1024 + 1, expectedActiveVersionId: first.versionId, now: new Date(), appOrigin: env.APP_ORIGIN })).rejects.toThrow("PDF size");
    await expect(repository.startUpload({ contentId: first.contentId, fileName: "../escape.pdf", size: 5, expectedActiveVersionId: first.versionId, now: new Date(), appOrigin: env.APP_ORIGIN })).rejects.toThrow("Choose a .pdf file");
    const short = bytes("%PDF-short");
    const wrongSize = await repository.startUpload({ contentId: first.contentId, fileName: "short.pdf", size: short.byteLength + 1, expectedActiveVersionId: first.versionId, now: new Date(), appOrigin: env.APP_ORIGIN });
    await expect(repository.uploadData(wrongSize.uploadId, new Response(short.buffer as ArrayBuffer).body)).rejects.toThrow(`Expected ${short.byteLength + 1} PDF bytes`);
  });

  it("rejects stale PDF confirmation after another HTML activation or removal", async () => {
    const first = await publish("Confirm race", "<h1>One</h1>");
    const pdfBytes = bytes("%PDF-1.7\nconfirm");
    const pdf = await attachPdf(first.contentId, first.versionId, pdfBytes);
    const secondBytes = bytes("<h1>Two</h1>");
    const second = await publishing.startVersion(first.contentId, "html", [{ path: "index.html", size: secondBytes.byteLength }]);
    await publishing.uploadAsset(second.uploadId, "index.html", uploadRequest(secondBytes));
    await publishing.commit(second.uploadId);
    const thirdBytes = bytes("<h1>Three</h1>");
    const third = await publishing.startVersion(first.contentId, "html", [{ path: "index.html", size: thirdBytes.byteLength }]);
    await publishing.uploadAsset(third.uploadId, "index.html", uploadRequest(thirdBytes));
    await publishing.commit(third.uploadId);

    const stale = await handleRequest(
      await ownerRequest(env, `https://app.test/api/admin/contents/${first.contentId}/pdf/confirm`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ pdfId: pdf.pdfId, expectedActiveVersionId: second.versionId }),
      }), env, anonymous,
    );
    expect(stale.status).toBe(409);
    expect((await handleRequest(await ownerRequest(env, `https://app.test/api/admin/contents/${first.contentId}/pdf`, { method: "DELETE" }), env, anonymous)).status).toBe(200);
    const removed = await handleRequest(
      await ownerRequest(env, `https://app.test/api/admin/contents/${first.contentId}/pdf/confirm`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ pdfId: pdf.pdfId, expectedActiveVersionId: third.versionId }),
      }), env, anonymous,
    );
    expect(removed.status).toBe(409);
  });

  it("retrieves only current private source files through the MCP Bearer sideband", async () => {
    const htmlBytes = bytes("<h1>Kumbe</h1>");
    const imageBytes = new Uint8Array([1, 2, 3, 4]);
    const plan = await publishing.createContent({
      title: "Source export",
      sourceFormat: "zip",
      files: [
        { path: "index.html", size: htmlBytes.byteLength },
        { path: "assets/pixel.png", size: imageBytes.byteLength },
      ],
    });
    await publishing.uploadAsset(plan.uploadId, "index.html", uploadRequest(htmlBytes));
    await publishing.uploadAsset(plan.uploadId, "assets/pixel.png", uploadRequest(imageBytes));
    await publishing.commit(plan.uploadId);

    const service = new ContentSourceService(env.DB, env.APP_ORIGIN);
    const manifest = await service.manifest(plan.contentId);
    expect(manifest).toMatchObject({
      contentId: plan.contentId,
      activeVersionId: plan.versionId,
      sourceFormat: "zip",
      transfer: { method: "authenticated-sideband", baseOrigin: env.APP_ORIGIN },
    });
    expect(manifest.files.map((file) => file.path)).toEqual(["assets/pixel.png", "index.html"]);
    expect(await service.readText(plan.contentId, plan.versionId, "index.html")).toMatchObject({
      kind: "text",
      text: "<h1>Kumbe</h1>",
    });
    expect(await service.readText(plan.contentId, plan.versionId, "assets/pixel.png")).toMatchObject({
      kind: "download",
      reason: "binary",
    });

    const url = `https://app.test/api/mcp/contents/${plan.contentId}/versions/${plan.versionId}/files/assets%2Fpixel.png`;
    expect((await handleRequest(new Request(url), env, anonymous)).status).toBe(401);
    expect((await handleRequest(await ownerRequest(env, url), env, anonymous)).status).toBe(401);
    const downloaded = await handleRequest(
      new Request(url, { headers: { Authorization: `Bearer ${env.MCP_BEARER_TOKEN}` } }),
      env,
      anonymous,
    );
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-type")).toBe("application/octet-stream");
    expect(downloaded.headers.get("content-disposition")).toContain("attachment");
    expect(downloaded.headers.get("cache-control")).toContain("no-store");
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(imageBytes);

    const stale = url.replace(plan.versionId, "00000000-0000-4000-8000-000000000000");
    expect((await handleRequest(new Request(stale, { headers: { Authorization: `Bearer ${env.MCP_BEARER_TOKEN}` } }), env, anonymous)).status)
      .toBe(404);
    database.raw.prepare("UPDATE asset_chunk SET bytes = ? WHERE version_id = ? AND path = ? AND chunk_index = 0")
      .run(bytes("<h1>Other</h1>"), plan.versionId, "index.html");
    await expect(service.readText(plan.contentId, plan.versionId, "index.html"))
      .rejects.toThrow("Stored file digest does not match its manifest");
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM daily_aggregate").get()).toEqual({ count: 0 });
  });

  it("manages guarded PDF replacement and removal through narrow MCP transfer routes", async () => {
    const published = await publish("Machine PDF", "<h1>PDF</h1>");
    const repository = new D1PdfRepository(env.DB);
    const firstBytes = bytes("%PDF-1.7\nfirst");
    const first = await repository.startUpload({
      contentId: published.contentId,
      fileName: "first.pdf",
      size: firstBytes.byteLength,
      expectedActiveVersionId: published.versionId,
      now: new Date(),
      appOrigin: env.APP_ORIGIN,
      transferBasePath: "/api/mcp/pdf/uploads",
    });
    expect(first).toMatchObject({ size: firstBytes.byteLength });
    expect(first.uploadUrl).toContain("/api/mcp/pdf/uploads/");
    expect((await handleRequest(await ownerRequest(env, first.uploadUrl, { method: "PUT", body: firstBytes.slice().buffer as ArrayBuffer }), env, anonymous)).status)
      .toBe(401);

    const machineHeaders = { Authorization: `Bearer ${env.MCP_BEARER_TOKEN}` };
    expect((await handleRequest(new Request(first.uploadUrl, { method: "PUT", headers: machineHeaders, body: firstBytes.slice().buffer as ArrayBuffer }), env, anonymous)).status)
      .toBe(204);
    const firstCommit = await handleRequest(new Request(first.commitUrl, { method: "POST", headers: machineHeaders }), env, anonymous);
    expect(firstCommit.status).toBe(200);
    expect(await repository.stateForContent(published.contentId)).toMatchObject({ state: "current", id: first.pdfId });

    const secondBytes = bytes("%PDF-1.7\nsecond");
    const second = await repository.startUpload({
      contentId: published.contentId,
      fileName: "second.pdf",
      size: secondBytes.byteLength,
      expectedActiveVersionId: published.versionId,
      now: new Date(),
      appOrigin: env.APP_ORIGIN,
      transferBasePath: "/api/mcp/pdf/uploads",
    });
    expect((await handleRequest(new Request(second.uploadUrl, { method: "PUT", headers: machineHeaders, body: secondBytes.slice().buffer as ArrayBuffer }), env, anonymous)).status)
      .toBe(204);
    expect(await repository.stateForContent(published.contentId)).toMatchObject({ id: first.pdfId });
    expect((await handleRequest(new Request(second.commitUrl, { method: "POST", headers: machineHeaders }), env, anonymous)).status)
      .toBe(200);
    expect(await repository.stateForContent(published.contentId)).toMatchObject({ state: "current", id: second.pdfId });

    await expect(repository.removeExpected(published.contentId, first.pdfId)).rejects.toThrow("PDF companion changed");
    expect(await repository.removeExpected(published.contentId, second.pdfId)).toEqual({
      state: "none",
      removed: true,
      pdfId: second.pdfId,
    });
    expect(await repository.removeExpected(published.contentId, second.pdfId)).toMatchObject({ removed: true });
    expect(await repository.stateForContent(published.contentId)).toEqual({ state: "none" });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM daily_aggregate").get()).toEqual({ count: 0 });
  });
});
