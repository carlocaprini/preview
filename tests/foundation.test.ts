import { describe, expect, it } from "vitest";
import {
  authenticateMcp,
  authenticateOwner,
  createOwnerPreviewToken,
  createOwnerSession,
  OWNER_SESSION_COOKIE,
  parseOwnerPreviewToken,
  timingSafeEqual,
} from "../src/security/auth.ts";
import { classifyHost } from "../src/security/hosts.ts";
import { normalizeAssetPath } from "../src/security/paths.ts";
import type { PreviewEnv } from "../src/types.ts";

const env = {
  OWNER_PASSWORD: "test-owner-password-with-enough-entropy",
  MCP_BEARER_TOKEN: "test-mcp-bearer-token-with-enough-entropy",
  SHARE_SIGNING_KEY: "test-signing-key-with-enough-entropy",
  APP_ORIGIN: "https://preview.example.com",
  CONTENT_ORIGIN: "https://content.preview.example.com",
  ENVIRONMENT: "test",
} as PreviewEnv;

describe("security foundation", () => {
  it("classifies only configured application and content hosts", () => {
    expect(classifyHost(new Request("https://preview.example.com/"), env)).toBe("app");
    expect(classifyHost(new Request("https://content.preview.example.com/"), env)).toBe("content");
    expect(classifyHost(new Request("https://preview.example.workers.dev/"), env)).toBe("unknown");
  });

  it("requires a valid, unexpired signed owner session", async () => {
    const now = new Date("2026-10-28T10:00:00.000Z");
    const token = await createOwnerSession(env, now, 60);
    const valid = new Request("https://preview.example.com/admin", {
      headers: { cookie: `${OWNER_SESSION_COOKIE}=${token}` },
    });
    expect((await authenticateOwner(valid, env, new Date(now.getTime() + 30_000))).authorized).toBe(true);
    expect((await authenticateOwner(new Request(valid, { headers: { cookie: `${OWNER_SESSION_COOKIE}=${token}x` } }), env, now)).authorized).toBe(false);
    expect((await authenticateOwner(valid, env, new Date(now.getTime() + 61_000))).authorized).toBe(false);
  });

  it("requires the configured Bearer token for MCP", async () => {
    const validRequest = new Request("https://preview.example.com/mcp", {
      headers: { authorization: `Bearer ${env.MCP_BEARER_TOKEN}` },
    });
    expect((await authenticateMcp(new Request("https://preview.example.com/mcp"), env)).authorized).toBe(false);
    expect((await authenticateMcp(validRequest, env)).authorized).toBe(true);
  });

  it("signs short-lived owner preview capabilities", async () => {
    const now = new Date("2026-10-28T10:00:00.000Z");
    const token = await createOwnerPreviewToken("content", "snapshot", env.SHARE_SIGNING_KEY, now, 60);
    expect(await parseOwnerPreviewToken(token, env.SHARE_SIGNING_KEY, new Date(now.getTime() + 30_000))).toEqual({
      contentId: "content",
      snapshotId: "snapshot",
    });
    expect(await parseOwnerPreviewToken(`${token}x`, env.SHARE_SIGNING_KEY, now)).toBeNull();
    expect(await parseOwnerPreviewToken(token, env.SHARE_SIGNING_KEY, new Date(now.getTime() + 61_000))).toBeNull();
  });

  it("compares secrets after hashing them to a fixed length", async () => {
    await expect(timingSafeEqual("same", "same")).resolves.toBe(true);
    await expect(timingSafeEqual("same", "diff")).resolves.toBe(false);
    await expect(timingSafeEqual("short", "much-longer")).resolves.toBe(false);
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
