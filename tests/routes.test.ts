import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/index.ts";
import type { PreviewEnv, PreviewExecutionContext } from "../src/types.ts";

const env = {
  OWNER_EMAIL: "owner@example.com",
  MCP_ACCESS_CLIENT_ID: "mcp-client",
  SHARE_SIGNING_KEY: "test-key",
  APP_ORIGIN: "https://app.test",
  CONTENT_ORIGIN: "https://content.test",
  ENVIRONMENT: "test",
} as PreviewEnv;

const anonymous = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as PreviewExecutionContext;
const owner = {
  ...anonymous,
  access: { getIdentity: async () => ({ email: "owner@example.com" }) },
} as PreviewExecutionContext;

describe("origin and access routing", () => {
  it("serves the branded public homepage without exposing content", async () => {
    const response = await handleRequest(new Request("https://app.test/"), env, anonymous);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Ideas, experiments and work worth sharing.");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("fails closed for unauthenticated admin access", async () => {
    const response = await handleRequest(new Request("https://app.test/admin"), env, anonymous);
    expect(response.status).toBe(403);
  });

  it("allows the configured owner into the admin shell", async () => {
    const response = await handleRequest(new Request("https://app.test/admin"), env, owner);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Library foundation ready.");
  });

  it("does not expose application routes from the content origin", async () => {
    const response = await handleRequest(new Request("https://content.test/admin"), env, owner);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Library foundation ready.");
  });

  it("rejects alternate hosts such as workers.dev", async () => {
    const response = await handleRequest(new Request("https://preview.workers.dev/"), env, anonymous);
    expect(response.status).toBe(404);
  });
});
