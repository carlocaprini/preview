import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleMcp } from "../src/mcp.ts";
import { handleRequest } from "../src/index.ts";
import { D1PublishingRepository } from "../src/data/repository.ts";
import { D1AssetStore } from "../src/data/assets.ts";
import { PublishingService } from "../src/services/publishing.ts";
import type { PreviewEnv, PreviewExecutionContext } from "../src/types.ts";
import { SqliteD1 } from "./support/sqlite-d1.ts";
import { createOwnerSession, OWNER_SESSION_COOKIE } from "../src/security/auth.ts";
import { pdfUpload } from "../scripts/preview-transfer.mjs";

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as PreviewExecutionContext;

function testEnv(db: D1Database): PreviewEnv {
  return {
    APP_ORIGIN: "https://preview.example.com",
    CONTENT_ORIGIN: "https://content.preview.example.com",
    ENVIRONMENT: "test",
    SHARE_SIGNING_KEY: "mcp-test-key-that-is-at-least-thirty-two-bytes",
    OWNER_PASSWORD: "test-owner-password-with-enough-entropy",
    MCP_BEARER_TOKEN: "test-mcp-bearer-token-with-enough-entropy",
    DB: db,
  };
}

async function mcpClient(env: PreviewEnv): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${env.APP_ORIGIN}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${env.MCP_BEARER_TOKEN}` } },
    fetch: async (input, init) => {
      const original = input instanceof Request ? input : new Request(input, init);
      const headers = new Headers(original.headers);
      headers.set("host", new URL(env.APP_ORIGIN).host);
      headers.set("authorization", `Bearer ${env.MCP_BEARER_TOKEN}`);
      return handleRequest(new Request(original, { headers }), env, ctx);
    },
  });
  const client = new Client({ name: "preview-contract-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe("stateless MCP contract", () => {
  it("negotiates Streamable HTTP and exposes the publishing tools plus content discovery", async () => {
    const env = testEnv({} as D1Database);
    const transport = new StreamableHTTPClientTransport(new URL("https://preview.example.com/mcp"), {
      fetch: async (input, init) => {
        const original = input instanceof Request ? input : new Request(input, init);
        const headers = new Headers(original.headers);
        headers.set("host", "preview.example.com");
        const request = new Request(original, { headers });
        return handleMcp(request, env, ctx);
      },
    });
    const client = new Client({ name: "preview-contract-test", version: "1.0.0" });

    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "preview_confirm_pdf_reuse",
      "preview_create_content",
      "preview_create_share_link",
      "preview_get_analytics",
      "preview_get_content",
      "preview_get_content_files",
      "preview_list_contents",
      "preview_list_share_links",
      "preview_read_content_file",
      "preview_remove_pdf",
      "preview_revoke_share_link",
      "preview_start_pdf_upload",
      "preview_update_share_link_expiry",
      "preview_upload_version",
    ]);
    expect(listed.tools.find((tool) => tool.name === "preview_list_contents")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(listed.tools.find((tool) => tool.name === "preview_revoke_share_link")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(listed.tools.find((tool) => tool.name === "preview_remove_pdf")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    await client.close();
  });

  it("discovers a real opaque link ID, updates expiry, and revokes it through authenticated MCP calls", async () => {
    const database = new SqliteD1();
    const env = testEnv(database as unknown as D1Database);
    const publishing = new PublishingService(
      new D1PublishingRepository(env.DB),
      new D1AssetStore(env.DB),
      env.APP_ORIGIN,
      env.SHARE_SIGNING_KEY,
    );
    const html = bytes("<h1>Managed link</h1>");
    const plan = await publishing.createContent({
      title: "Managed link",
      sourceFormat: "html",
      files: [{ path: "index.html", size: html.byteLength }],
    });
    await publishing.uploadAsset(
      plan.uploadId,
      "index.html",
      new Request("https://upload.test", {
        method: "PUT",
        headers: { "content-length": String(html.byteLength) },
        body: html.slice().buffer as ArrayBuffer,
      }),
    );
    await publishing.commit(plan.uploadId);
    const created = await publishing.createShareLink({ contentId: plan.contentId, label: "Review", validForSeconds: null });
    const client = await mcpClient(env);

    const listed = await client.callTool({
      name: "preview_list_share_links",
      arguments: { contentId: plan.contentId },
    });
    const listedContent = listed.structuredContent as { links: Array<{ linkId: string; url: string }> };
    expect(listedContent.links).toEqual([
      expect.objectContaining({ linkId: created.linkId, url: created.url }),
    ]);
    expect(created.linkId).toMatch(/^[A-Za-z0-9_-]{22}$/u);

    const expiry = await client.callTool({
      name: "preview_update_share_link_expiry",
      arguments: { linkId: created.linkId, expiresAt: "2000-01-01T00:00:00.000Z" },
    });
    expect(expiry.structuredContent).toMatchObject({ linkId: created.linkId, state: "expired" });

    const revoked = await client.callTool({ name: "preview_revoke_share_link", arguments: { linkId: created.linkId } });
    const retried = await client.callTool({ name: "preview_revoke_share_link", arguments: { linkId: created.linkId } });
    expect(retried.structuredContent).toEqual(revoked.structuredContent);
    expect((await handleRequest(new Request(created.url), env, ctx)).status).toBe(410);

    const malformed = await client.callTool({ name: "preview_revoke_share_link", arguments: { linkId: "not-a-real-link-id" } });
    expect(malformed.isError).toBe(true);
    await client.close();
  });

  it("runs the complete MCP and local-helper PDF lifecycle with guarded IDs", async () => {
    const database = new SqliteD1();
    const env = testEnv(database as unknown as D1Database);
    const publishing = new PublishingService(
      new D1PublishingRepository(env.DB),
      new D1AssetStore(env.DB),
      env.APP_ORIGIN,
      env.SHARE_SIGNING_KEY,
    );
    const firstHtml = bytes("<h1>Version one</h1>");
    const firstVersion = await publishing.createContent({
      title: "PDF lifecycle",
      sourceFormat: "html",
      files: [{ path: "index.html", size: firstHtml.byteLength }],
    });
    await publishing.uploadAsset(
      firstVersion.uploadId,
      "index.html",
      new Request("https://upload.test", {
        method: "PUT",
        headers: { "content-length": String(firstHtml.byteLength) },
        body: firstHtml.slice().buffer as ArrayBuffer,
      }),
    );
    await publishing.commit(firstVersion.uploadId);
    const link = await publishing.createShareLink({ contentId: firstVersion.contentId, label: "PDF review", validForSeconds: null });
    const client = await mcpClient(env);
    const root = await mkdtemp(join(tmpdir(), "preview-mcp-pdf-"));
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.PREVIEW_MCP_TOKEN;
    const originalOrigin = process.env.PREVIEW_MCP_ORIGIN;
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.env.PREVIEW_MCP_TOKEN = env.MCP_BEARER_TOKEN;
    process.env.PREVIEW_MCP_ORIGIN = env.APP_ORIGIN;

    async function startPdf(fileName: string, payload: Uint8Array, activeVersionId: string) {
      const started = await client.callTool({
        name: "preview_start_pdf_upload",
        arguments: { contentId: firstVersion.contentId, fileName, size: payload.byteLength, expectedActiveVersionId: activeVersionId },
      });
      expect(started.isError).not.toBe(true);
      return started.structuredContent as {
        uploadId: string;
        pdfId: string;
        size: number;
        uploadUrl: string;
        commitUrl: string;
      };
    }

    try {
      const firstPdf = bytes("%PDF-1.7\nfirst companion");
      const firstPlan = await startPdf("first.pdf", firstPdf, firstVersion.versionId);
      const firstPdfPath = join(root, "first.pdf");
      const firstPlanPath = join(root, "first-plan.json");
      await writeFile(firstPdfPath, firstPdf);
      await writeFile(firstPlanPath, JSON.stringify(firstPlan));

      const unauthorized = await handleRequest(new Request(firstPlan.uploadUrl, { method: "PUT", body: firstPdf.slice().buffer as ArrayBuffer }), env, ctx);
      expect(unauthorized.status).toBe(401);
      const ownerCookie = await createOwnerSession(env);
      const ownerOnly = await handleRequest(
        new Request(firstPlan.uploadUrl, {
          method: "PUT",
          headers: { cookie: `${OWNER_SESSION_COOKIE}=${ownerCookie}` },
          body: firstPdf.slice().buffer as ArrayBuffer,
        }),
        env,
        ctx,
      );
      expect(ownerOnly.status).toBe(401);

      const exfiltration = { ...firstPlan, uploadUrl: "https://attacker.example/steal" };
      const exfiltrationPath = join(root, "exfiltration.json");
      await writeFile(exfiltrationPath, JSON.stringify(exfiltration));
      const blockedFetch = vi.fn();
      globalThis.fetch = blockedFetch as typeof fetch;
      await expect(pdfUpload(firstPdfPath, exfiltrationPath)).rejects.toThrow("unexpected destination");
      expect(blockedFetch).not.toHaveBeenCalled();

      globalThis.fetch = async (input, init) => {
        const original = input instanceof Request ? input : new Request(input, init);
        const headers = new Headers(original.headers);
        headers.set("host", new URL(env.APP_ORIGIN).host);
        return handleRequest(new Request(original, { headers }), env, ctx);
      };
      await pdfUpload(firstPdfPath, firstPlanPath);
      expect((await handleRequest(new Request(`${link.url}/pdf`, { method: "HEAD" }), env, ctx)).status).toBe(200);

      const secondHtml = bytes("<h1>Version two</h1>");
      const secondVersion = await publishing.startVersion(firstVersion.contentId, "html", [
        { path: "index.html", size: secondHtml.byteLength },
      ]);
      await publishing.uploadAsset(
        secondVersion.uploadId,
        "index.html",
        new Request("https://upload.test", {
          method: "PUT",
          headers: { "content-length": String(secondHtml.byteLength) },
          body: secondHtml.slice().buffer as ArrayBuffer,
        }),
      );
      await publishing.commit(secondVersion.uploadId);
      const outdated = await client.callTool({ name: "preview_get_content", arguments: { contentId: firstVersion.contentId } });
      expect(outdated.structuredContent).toMatchObject({ pdfCompanion: { state: "outdated", pdfId: firstPlan.pdfId } });
      expect((await handleRequest(new Request(`${link.url}/pdf`, { method: "HEAD" }), env, ctx)).status).toBe(404);

      const confirmed = await client.callTool({
        name: "preview_confirm_pdf_reuse",
        arguments: { contentId: firstVersion.contentId, pdfId: firstPlan.pdfId, expectedActiveVersionId: secondVersion.versionId },
      });
      expect(confirmed.structuredContent).toMatchObject({ state: "current", pdfId: firstPlan.pdfId });
      expect((await handleRequest(new Request(`${link.url}/pdf`, { method: "HEAD" }), env, ctx)).status).toBe(200);

      const replacementBytes = bytes("%PDF-1.7\nreplacement");
      const replacement = await startPdf("replacement.pdf", replacementBytes, secondVersion.versionId);
      const replacementPath = join(root, "replacement.pdf");
      const replacementPlanPath = join(root, "replacement-plan.json");
      await writeFile(replacementPath, replacementBytes);
      await writeFile(replacementPlanPath, JSON.stringify(replacement));
      await pdfUpload(replacementPath, replacementPlanPath);

      const staleRemoval = await client.callTool({
        name: "preview_remove_pdf",
        arguments: { contentId: firstVersion.contentId, expectedPdfId: firstPlan.pdfId },
      });
      expect(staleRemoval.isError).toBe(true);
      const removed = await client.callTool({
        name: "preview_remove_pdf",
        arguments: { contentId: firstVersion.contentId, expectedPdfId: replacement.pdfId },
      });
      expect(removed.structuredContent).toMatchObject({ state: "none", removed: true, pdfId: replacement.pdfId });
      expect((await handleRequest(new Request(`${link.url}/pdf`, { method: "HEAD" }), env, ctx)).status).toBe(404);
      expect(database.raw.prepare("SELECT COUNT(*) AS count FROM daily_aggregate").get()).toEqual({ count: 0 });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) delete process.env.PREVIEW_MCP_TOKEN;
      else process.env.PREVIEW_MCP_TOKEN = originalToken;
      if (originalOrigin === undefined) delete process.env.PREVIEW_MCP_ORIGIN;
      else process.env.PREVIEW_MCP_ORIGIN = originalOrigin;
      output.mockRestore();
      await client.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
