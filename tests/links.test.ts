import { describe, expect, it } from "vitest";
import { createShareToken, parseShareToken, resolveExpiry } from "../src/domain/links.ts";

const key = "a-secure-test-key-that-is-at-least-thirty-two-bytes";

describe("share bearer tokens", () => {
  it("creates recoverable, authenticated 128-bit identifiers", async () => {
    const created = await createShareToken(key);
    expect(created.id).toHaveLength(22);
    expect(await parseShareToken(created.token, key)).toBe(created.id);
  });

  it("rejects tampering without revealing whether a link exists", async () => {
    const created = await createShareToken(key);
    expect(await parseShareToken(`${created.id}.tampered`, key)).toBeNull();
  });

  it("measures expiry from creation and bounds lifetime", () => {
    const created = new Date("2026-10-26T12:00:00.000Z");
    expect(resolveExpiry(created, null)).toBeNull();
    expect(resolveExpiry(created, 3600)).toBe("2026-10-26T13:00:00.000Z");
    expect(() => resolveExpiry(created, 30)).toThrow();
  });
});
