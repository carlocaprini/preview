import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { handleMcp } from "../src/mcp.ts";
import { handleRequest } from "../src/index.ts";
import { D1PublishingRepository } from "../src/data/repository.ts";
import { D1AssetStore } from "../src/data/assets.ts";
import { PublishingService } from "../src/services/publishing.ts";
import type { PreviewEnv, PreviewExecutionContext } from "../src/types.ts";
import { SqliteD1 } from "./support/sqlite-d1.ts";

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
      "preview_create_content",
      "preview_create_share_link",
      "preview_get_analytics",
      "preview_get_content",
      "preview_get_content_files",
      "preview_list_contents",
      "preview_list_share_links",
      "preview_read_content_file",
      "preview_revoke_share_link",
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
});
