import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { D1PublishingRepository } from "../src/data/repository.ts";
import { D1AssetStore } from "../src/data/assets.ts";
import { PublishingService } from "../src/services/publishing.ts";

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly database: SqliteD1,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): BoundStatement {
    return new BoundStatement(this.statement, this.database, values);
  }

  async run() {
    const result = this.statement.run(...(this.values as Parameters<StatementSync["run"]>));
    return { success: true, meta: { changes: Number(result.changes) }, results: [] };
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...(this.values as Parameters<StatementSync["get"]>)) as T | undefined) ?? null;
  }

  async all<T>() {
    return {
      success: true,
      meta: { changes: 0 },
      results: this.statement.all(...(this.values as Parameters<StatementSync["all"]>)) as T[],
    };
  }
}

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");
  prepareCalls = 0;

  constructor() {
    for (const name of [
      "0001_initial.sql",
      "0002_public_snapshots.sql",
      "0003_measurement_receipts.sql",
      "0004_d1_asset_storage.sql",
    ]) {
      const migration = fileURLToPath(new URL(`../migrations/${name}`, import.meta.url));
      this.raw.exec(readFileSync(migration, "utf8"));
    }
  }

  prepare(sql: string): BoundStatement {
    this.prepareCalls += 1;
    return new BoundStatement(this.raw.prepare(sql), this);
  }

  async batch(statements: BoundStatement[]) {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.raw.exec("COMMIT");
      return results;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }
}

const signingKey = "integration-test-key-that-is-at-least-thirty-two-bytes";

function assetRequest(bytes: Uint8Array): Request {
  return new Request("https://preview.example/upload", {
    method: "PUT",
    headers: { "Content-Length": String(bytes.byteLength) },
    body: bytes.slice().buffer as ArrayBuffer,
  });
}

describe("staged publishing", () => {
  let database: SqliteD1;
  let service: PublishingService;
  let assets: D1AssetStore;

  beforeEach(() => {
    database = new SqliteD1();
    assets = new D1AssetStore(database as unknown as D1Database);
    service = new PublishingService(
      new D1PublishingRepository(database as unknown as D1Database),
      assets,
      "https://preview.example",
      signingKey,
    );
  });

  it("creates, uploads, atomically activates, retries, and shares HTML", async () => {
    const bytes = new TextEncoder().encode("<!doctype html><h1>Hello</h1>");
    const plan = await service.createContent({
      title: "Hello",
      sourceFormat: "html",
      files: [{ path: "index.html", size: bytes.byteLength }],
    });

    await service.uploadAsset(plan.uploadId, "index.html", assetRequest(bytes));
    const first = await service.commit(plan.uploadId);
    expect(first.status).toBe("activated");
    expect((await service.commit(plan.uploadId)).status).toBe("already_active");

    const link = await service.createShareLink({ contentId: plan.contentId, label: "Client context", validForSeconds: 3600 });
    expect(link.url).toMatch(/^https:\/\/preview\.example\/s\/[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/u);
    expect(link.expiresAt).not.toBeNull();
  });

  it("keeps the previous active version when a later upload is incomplete", async () => {
    const original = new TextEncoder().encode("<h1>Original</h1>");
    const initial = await service.createContent({
      title: "Atomic",
      sourceFormat: "html",
      files: [{ path: "index.html", size: original.byteLength }],
    });
    await service.uploadAsset(initial.uploadId, "index.html", assetRequest(original));
    await service.commit(initial.uploadId);

    const nextHtml = new TextEncoder().encode("<h1>Next</h1><script src='app.js'></script>");
    const next = await service.startVersion(initial.contentId, "zip", [
      { path: "index.html", size: nextHtml.byteLength },
      { path: "app.js", size: 20 },
    ]);
    await service.uploadAsset(next.uploadId, "index.html", assetRequest(nextHtml));
    await expect(service.commit(next.uploadId)).rejects.toThrow("Missing asset: app.js");

    const row = database.raw.prepare("SELECT active_version_id FROM content WHERE id = ?").get(initial.contentId) as {
      active_version_id: string;
    };
    expect(row.active_version_id).toBe(initial.versionId);
  });

  it("resolves concurrent uploads deterministically without an older pointer overwrite", async () => {
    const baseBytes = new TextEncoder().encode("<h1>Base</h1>");
    const base = await service.createContent({
      title: "Concurrent",
      sourceFormat: "html",
      files: [{ path: "index.html", size: baseBytes.byteLength }],
    });
    await service.uploadAsset(base.uploadId, "index.html", assetRequest(baseBytes));
    await service.commit(base.uploadId);

    const aBytes = new TextEncoder().encode("<h1>A</h1>");
    const bBytes = new TextEncoder().encode("<h1>B</h1>");
    const a = await service.startVersion(base.contentId, "html", [{ path: "index.html", size: aBytes.byteLength }]);
    const b = await service.startVersion(base.contentId, "html", [{ path: "index.html", size: bBytes.byteLength }]);
    await service.uploadAsset(a.uploadId, "index.html", assetRequest(aBytes));
    await service.uploadAsset(b.uploadId, "index.html", assetRequest(bBytes));

    await service.commit(a.uploadId);
    await expect(service.commit(b.uploadId)).rejects.toThrow("newer version");
    const row = database.raw.prepare("SELECT active_version_id FROM content WHERE id = ?").get(base.contentId) as {
      active_version_id: string;
    };
    expect(row.active_version_id).toBe(a.versionId);
  });

  it("rejects incorrect byte counts before writing storage", async () => {
    const plan = await service.createContent({
      title: "Bytes",
      sourceFormat: "html",
      files: [{ path: "index.html", size: 10 }],
    });
    await expect(service.uploadAsset(plan.uploadId, "index.html", assetRequest(new Uint8Array(9)))).rejects.toThrow(
      "Expected 10 bytes",
    );
  });

  it("stores bounded D1 chunks and reconstructs an asset byte-for-byte", async () => {
    const payload = new Uint8Array(1_200_000);
    for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;
    const plan = await service.createContent({
      title: "Chunked",
      sourceFormat: "html",
      files: [{ path: "index.html", size: payload.byteLength }],
    });
    await service.uploadAsset(plan.uploadId, "index.html", assetRequest(payload));
    await service.commit(plan.uploadId);

    const chunks = database.raw
      .prepare("SELECT COUNT(*) AS count,MAX(length(bytes)) AS largest FROM asset_chunk WHERE version_id = ?")
      .get(plan.versionId) as { count: number; largest: number };
    expect(chunks.count).toBe(3);
    expect(chunks.largest).toBeLessThanOrEqual(512 * 1024);

    const stored = await assets.get(plan.versionId, "index.html");
    expect(stored?.etag).toMatch(/^"sha256-[a-f0-9]{64}"$/u);
    expect(new Uint8Array(await new Response(stored?.body).arrayBuffer())).toEqual(payload);
  });

  it("verifies a maximum-size manifest without one D1 query per asset", async () => {
    const payload = new Uint8Array([42]);
    const files = [
      { path: "index.html", size: 1 },
      ...Array.from({ length: 49 }, (_, index) => ({ path: `assets/${index}.txt`, size: 1 })),
    ];
    const plan = await service.createContent({ title: "Query budget", sourceFormat: "zip", files });
    for (const file of files) await service.uploadAsset(plan.uploadId, file.path, assetRequest(payload));

    database.prepareCalls = 0;
    await service.commit(plan.uploadId);
    expect(database.prepareCalls).toBeLessThanOrEqual(10);
  });
});
