import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { download } from "../scripts/preview-transfer.mjs";

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("content download helper", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "preview-transfer-test-"));
    process.env.PREVIEW_MCP_TOKEN = "test-token";
    process.env.PREVIEW_MCP_ORIGIN = "https://preview.carlocaprini.com";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.PREVIEW_MCP_TOKEN;
    delete process.env.PREVIEW_MCP_ORIGIN;
    await rm(root, { recursive: true, force: true });
  });

  async function plan(files: Array<{ path: string; bytes: Uint8Array; sha256?: string }>, origin = "https://preview.carlocaprini.com") {
    const path = join(root, "plan.json");
    await writeFile(path, JSON.stringify({
      contentId: "content-id",
      activeVersionId: "version-id",
      transfer: { method: "authenticated-sideband", baseOrigin: origin },
      files: files.map((file) => ({
        path: file.path,
        size: file.bytes.byteLength,
        sha256: file.sha256 ?? digest(file.bytes),
      })),
    }));
    return path;
  }

  it("writes a verified multi-file tree and refuses to overwrite a destination", async () => {
    const html = new TextEncoder().encode("<h1>Current</h1>");
    const image = new Uint8Array([1, 2, 3, 4]);
    const planPath = await plan([{ path: "index.html", bytes: html }, { path: "assets/pixel.png", bytes: image }]);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const payload = url.includes("index.html") ? html : image;
      return new Response(payload.slice().buffer as ArrayBuffer, { headers: { "content-length": String(payload.byteLength) } });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const destination = join(root, "export");

    await download(planPath, destination);

    expect(new Uint8Array(await readFile(join(destination, "index.html")))).toEqual(html);
    expect(new Uint8Array(await readFile(join(destination, "assets/pixel.png")))).toEqual(image);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(download(planPath, destination)).rejects.toThrow("Destination already exists");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects traversal and an attacker-controlled origin before any request", async () => {
    const payload = new Uint8Array([1]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(download(await plan([{ path: "../escape", bytes: payload }]), join(root, "escape")))
      .rejects.toThrow("Unsafe archive path");
    await expect(download(await plan([{ path: "index.html", bytes: payload }], "https://attacker.example"), join(root, "origin")))
      .rejects.toThrow("unexpected origin");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("removes staging output after a bad digest or stale-version response", async () => {
    const payload = new TextEncoder().encode("current");
    const wrongDigest = "0".repeat(64);
    const badPlan = await plan([{ path: "index.html", bytes: payload, sha256: wrongDigest }]);
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(payload.slice().buffer as ArrayBuffer, { headers: { "content-length": String(payload.byteLength) } })));
    const badDestination = join(root, "bad-digest");
    await expect(download(badPlan, badDestination)).rejects.toThrow("digest mismatch");
    await expect(readFile(join(badDestination, "index.html"))).rejects.toMatchObject({ code: "ENOENT" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    const staleDestination = join(root, "stale");
    await expect(download(await plan([{ path: "index.html", bytes: payload }]), staleDestination))
      .rejects.toThrow("Download failed for index.html: 404");
    await expect(readFile(join(staleDestination, "index.html"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
