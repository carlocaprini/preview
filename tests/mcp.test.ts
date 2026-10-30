import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { handleMcp } from "../src/mcp.ts";
import type { PreviewEnv, PreviewExecutionContext } from "../src/types.ts";

describe("stateless MCP contract", () => {
  it("negotiates Streamable HTTP and exposes the publishing tools plus content discovery", async () => {
    const env = {
      APP_ORIGIN: "https://preview.example.com",
      CONTENT_ORIGIN: "https://content.preview.example.com",
      ENVIRONMENT: "test",
      SHARE_SIGNING_KEY: "mcp-test-key-that-is-at-least-thirty-two-bytes",
      OWNER_PASSWORD: "test-owner-password-with-enough-entropy",
      MCP_BEARER_TOKEN: "test-mcp-bearer-token-with-enough-entropy",
      DB: {} as D1Database,
    } satisfies PreviewEnv;
    const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as PreviewExecutionContext;
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
      "preview_list_contents",
      "preview_list_share_links",
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
});
