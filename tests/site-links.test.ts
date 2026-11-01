import { describe, expect, it } from "vitest";
import { siteReferralUrl } from "../src/domain/site-links.ts";

describe("canonical site referral URLs", () => {
  it("preserves destination paths, existing parameters, and fragments for public pages", () => {
    const url = new URL(siteReferralUrl("/thinking/?view=all#latest", { page: "home" }));
    expect(url.origin).toBe("https://carlocaprini.com");
    expect(url.pathname).toBe("/thinking/");
    expect(url.searchParams.get("view")).toBe("all");
    expect(url.searchParams.get("utm_source")).toBe("preview");
    expect(url.searchParams.get("utm_medium")).toBe("referral");
    expect(url.searchParams.get("utm_campaign")).toBe("public_pages");
    expect(url.searchParams.get("utm_content")).toBe("home");
    expect(url.hash).toBe("#latest");
  });

  it("normalizes only canonical content UUIDs into bounded document attribution", () => {
    const url = new URL(siteReferralUrl("/work/", { contentId: "550E8400-E29B-41D4-A716-446655440000" }));
    expect(url.searchParams.get("utm_campaign")).toBe("shared_content");
    expect(url.searchParams.get("utm_content")).toBe("doc_550e8400e29b41d4a716446655440000");
    expect(() => siteReferralUrl("/", { contentId: "share-token-or-title" })).toThrow("canonical content UUID");
  });

  it("refuses noncanonical origins and emits exactly the four supported UTM keys", () => {
    expect(() => siteReferralUrl("https://example.com/work/", { page: "home" })).toThrow("canonical site origin");
    const url = new URL(siteReferralUrl("/?utm_source=other&utm_source=duplicate&utm_term=legacy", { page: "not_found" }));
    expect(url.searchParams.getAll("utm_source")).toEqual(["preview"]);
    expect(url.searchParams.get("utm_content")).toBe("not_found");
    expect(url.searchParams.get("utm_term")).toBeNull();
  });
});
