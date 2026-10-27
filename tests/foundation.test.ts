import { describe, expect, it } from "vitest";
import { authenticateMcp, authenticateOwner, timingSafeEqual } from "../src/security/auth.ts";
import { classifyHost } from "../src/security/hosts.ts";
import { normalizeAssetPath } from "../src/security/paths.ts";
import type { PreviewEnv, PreviewExecutionContext } from "../src/types.ts";

const env = {
  OWNER_EMAIL: "owner@example.com",
  MCP_ACCESS_CLIENT_ID: "mcp-client",
  SHARE_SIGNING_KEY: "test-signing-key",
  APP_ORIGIN: "https://preview.example.com",
  CONTENT_ORIGIN: "https://content.preview.example.com",
  ENVIRONMENT: "test",
} as PreviewEnv;

function context(email?: string): PreviewExecutionContext {
  return {
    access: email ? { getIdentity: async () => ({ email }) } : undefined,
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as PreviewExecutionContext;
}

describe("security foundation", () => {
  it("classifies only configured application and content hosts", () => {
    expect(classifyHost(new Request("https://preview.example.com/"), env)).toBe("app");
    expect(classifyHost(new Request("https://content.preview.example.com/"), env)).toBe("content");
    expect(classifyHost(new Request("https://preview.example.workers.dev/"), env)).toBe("unknown");
  });

  it("requires the configured Access identity for owner routes", async () => {
    expect((await authenticateOwner(env, context())).authorized).toBe(false);
    expect((await authenticateOwner(env, context("attacker@example.com"))).authorized).toBe(false);
    expect((await authenticateOwner(env, context("OWNER@example.com"))).authorized).toBe(true);
  });

  it("requires both Access and the expected service client id for MCP", async () => {
    const validRequest = new Request("https://preview.example.com/mcp", {
      headers: { "cf-access-client-id": "mcp-client" },
    });
    expect((await authenticateMcp(validRequest, env, context())).authorized).toBe(false);
    expect((await authenticateMcp(validRequest, env, context("service@example.com"))).authorized).toBe(true);
  });

  it("compares secrets without an early exit", () => {
    expect(timingSafeEqual("same", "same")).toBe(true);
    expect(timingSafeEqual("same", "diff")).toBe(false);
    expect(timingSafeEqual("short", "much-longer")).toBe(false);
  });
});

describe("asset path normalization", () => {
  it("keeps safe nested paths under an immutable version prefix", () => {
    expect(normalizeAssetPath("assets/app.js")).toBe("assets/app.js");
  });

  it.each(["../secret", "assets/../secret", "/root", "assets\\app.js", "assets//app.js", "%2e%2e/secret"])(
    "rejects unsafe path %s",
    (path) => expect(() => normalizeAssetPath(path)).toThrow(),
  );
});
