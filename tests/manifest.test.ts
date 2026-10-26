import { describe, expect, it } from "vitest";
import { validateManifest } from "../src/domain/manifest.ts";

describe("upload manifest", () => {
  it("accepts a small root HTML bundle and computes safe media types", () => {
    expect(
      validateManifest([
        { path: "index.html", size: 120 },
        { path: "assets/app.js", size: 90 },
        { path: "assets/data.json", size: 20 },
      ]),
    ).toEqual({
      totalBytes: 230,
      files: [
        { path: "index.html", size: 120, mediaType: "text/html; charset=utf-8" },
        { path: "assets/app.js", size: 90, mediaType: "text/javascript; charset=utf-8" },
        { path: "assets/data.json", size: 20, mediaType: "application/json; charset=utf-8" },
      ],
    });
  });

  it("requires root index.html", () => {
    expect(() => validateManifest([{ path: "site/index.html", size: 10 }])).toThrow("root index.html");
    expect(() => validateManifest([{ path: "INDEX.HTML", size: 10 }])).toThrow("root index.html");
  });

  it("rejects duplicate normalized paths", () => {
    expect(() => validateManifest([{ path: "index.html", size: 10 }, { path: "INDEX.HTML", size: 10 }])).toThrow("Duplicate");
  });

  it("rejects unsupported and oversized assets", () => {
    expect(() => validateManifest([{ path: "index.html", size: 10 }, { path: "run.exe", size: 10 }])).toThrow("Unsupported");
    expect(() => validateManifest([{ path: "index.html", size: 11 * 1024 * 1024 }])).toThrow("Invalid size");
  });
});
