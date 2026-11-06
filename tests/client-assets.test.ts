import { describe, expect, it } from "vitest";
import { clientAsset } from "../src/client-assets.ts";

describe("browser client assets", () => {
  it("preserves the fflate MIT notice in the delivered copy", () => {
    const asset = clientAsset("/assets/fflate.js");

    expect(asset?.mediaType).toBe("text/javascript; charset=utf-8");
    expect(asset?.body).toContain("fflate 0.8.3");
    expect(asset?.body).toContain("Copyright (c) 2026 Arjun Barrett");
    expect(asset?.body).toContain("Permission is hereby granted");
  });
});
