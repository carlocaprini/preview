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
      "0005_latest_only_retention.sql",
      "0006_pdf_companion.sql",
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
  let repository: D1PublishingRepository;

  beforeEach(() => {
    database = new SqliteD1();
    assets = new D1AssetStore(database as unknown as D1Database);
    repository = new D1PublishingRepository(database as unknown as D1Database);
    service = new PublishingService(
      repository,
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

  it("retains the prior snapshot for 24 hours, then purges only its bytes and metadata", async () => {
    const v1Bytes = new TextEncoder().encode("<h1>Version one</h1>");
    const v1 = await service.createContent({
      title: "Latest only",
      sourceFormat: "html",
      files: [{ path: "index.html", size: v1Bytes.byteLength }],
    });
    await service.uploadAsset(v1.uploadId, "index.html", assetRequest(v1Bytes));
    await service.commit(v1.uploadId, new Date("2026-10-28T00:00:00.000Z"));
    const link = await service.createShareLink({ contentId: v1.contentId, label: "History", validForSeconds: null });
    const expiredLink = await service.createShareLink({ contentId: v1.contentId, label: "Expired", validForSeconds: null });
    const revokedLink = await service.createShareLink({ contentId: v1.contentId, label: "Revoked", validForSeconds: null });
    database.raw.prepare("UPDATE share_link SET expires_at = ? WHERE id = ?").run("2026-10-27T00:00:00.000Z", expiredLink.linkId);
    database.raw.prepare("UPDATE share_link SET revoked_at = ? WHERE id = ?").run("2026-10-27T00:00:00.000Z", revokedLink.linkId);
    database.raw
      .prepare(
        "INSERT INTO daily_aggregate (share_link_id,day,meaningful_views,active_visible_ms,last_view_at) VALUES (?,?,?,?,?)",
      )
      .run(link.linkId, "2026-10-28", 4, 12_000, "2026-10-28T00:05:00.000Z");
    database.raw
      .prepare(
        "INSERT INTO daily_aggregate (share_link_id,day,meaningful_views,active_visible_ms,last_view_at) VALUES (?,?,?,?,?)",
      )
      .run(expiredLink.linkId, "2026-10-27", 2, 3_000, "2026-10-27T00:05:00.000Z");
    database.raw
      .prepare(
        "INSERT INTO daily_aggregate (share_link_id,day,meaningful_views,active_visible_ms,last_view_at) VALUES (?,?,?,?,?)",
      )
      .run(revokedLink.linkId, "2026-10-27", 1, 1_000, "2026-10-27T00:05:00.000Z");

    const v2Bytes = new TextEncoder().encode("<h1>Version two</h1>");
    const v2 = await service.startVersion(
      v1.contentId,
      "html",
      [{ path: "index.html", size: v2Bytes.byteLength }],
      new Date("2026-10-28T01:00:00.000Z"),
    );
    await service.uploadAsset(v2.uploadId, "index.html", assetRequest(v2Bytes), new Date("2026-10-28T01:01:00.000Z"));
    await service.commit(v2.uploadId, new Date("2026-10-28T01:02:00.000Z"));

    expect(await assets.get(v1.versionId, "index.html")).not.toBeNull();
    expect((await repository.cleanup(new Date("2026-10-29T01:01:59.999Z"))).purgedVersions).toBe(0);
    expect(await assets.get(v1.versionId, "index.html")).not.toBeNull();

    const cleaned = await repository.cleanup(new Date("2026-10-29T01:02:00.000Z"));
    expect(cleaned).toEqual({ purgedVersions: 1, purgedStagingVersions: 0 });
    expect(await assets.get(v1.versionId, "index.html")).toBeNull();
    expect(await assets.get(v2.versionId, "index.html")).not.toBeNull();
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM content_version WHERE id = ?").get(v1.versionId)).toEqual({ count: 0 });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM share_link").get()).toEqual({ count: 3 });
    expect(database.raw.prepare("SELECT SUM(meaningful_views) AS meaningful_views,SUM(active_visible_ms) AS active_visible_ms FROM daily_aggregate").get()).toEqual({
      meaningful_views: 7,
      active_visible_ms: 16_000,
    });
    expect(link.url).toContain("/s/");

    const v3Bytes = new TextEncoder().encode("<h1>Version three</h1>");
    const v3 = await service.startVersion(v1.contentId, "html", [{ path: "index.html", size: v3Bytes.byteLength }]);
    expect(database.raw.prepare("SELECT sequence FROM content_version WHERE id = ?").get(v3.versionId)).toEqual({ sequence: 3 });
  });

  it("reclaims expired staging uploads in bounded, retry-safe batches", async () => {
    const activeBytes = new TextEncoder().encode("<h1>Active</h1>");
    const active = await service.createContent({
      title: "Staging cleanup",
      sourceFormat: "html",
      files: [{ path: "index.html", size: activeBytes.byteLength }],
    });
    await service.uploadAsset(active.uploadId, "index.html", assetRequest(activeBytes));
    await service.commit(active.uploadId);

    const abandonedBytes = new TextEncoder().encode("<h1>Abandoned</h1>");
    const abandoned = await service.startVersion(
      active.contentId,
      "html",
      [{ path: "index.html", size: abandonedBytes.byteLength }],
      new Date("2026-10-28T00:00:00.000Z"),
    );
    await service.uploadAsset(
      abandoned.uploadId,
      "index.html",
      assetRequest(abandonedBytes),
      new Date("2026-10-28T00:01:00.000Z"),
    );

    expect((await repository.cleanup(new Date("2026-10-28T00:59:59.999Z"))).purgedStagingVersions).toBe(0);
    expect((await repository.cleanup(new Date("2026-10-28T01:00:00.000Z"), 1)).purgedStagingVersions).toBe(1);
    expect(await assets.get(abandoned.versionId, "index.html")).toBeNull();
    expect(await assets.get(active.versionId, "index.html")).not.toBeNull();
    expect(await repository.cleanup(new Date("2026-10-28T02:00:00.000Z"))).toEqual({
      purgedVersions: 0,
      purgedStagingVersions: 0,
    });
  });

  it("never points content at a version removed between validation and activation", async () => {
    const activeBytes = new TextEncoder().encode("<h1>Still active</h1>");
    const active = await service.createContent({
      title: "Cleanup race",
      sourceFormat: "html",
      files: [{ path: "index.html", size: activeBytes.byteLength }],
    });
    await service.uploadAsset(active.uploadId, "index.html", assetRequest(activeBytes));
    await service.commit(active.uploadId, new Date("2026-10-28T00:00:00.000Z"));

    const replacementBytes = new TextEncoder().encode("<h1>Replacement</h1>");
    const replacement = await service.startVersion(
      active.contentId,
      "html",
      [{ path: "index.html", size: replacementBytes.byteLength }],
      new Date("2026-10-28T01:00:00.000Z"),
    );
    await service.uploadAsset(
      replacement.uploadId,
      "index.html",
      assetRequest(replacementBytes),
      new Date("2026-10-28T01:01:00.000Z"),
    );

    // This is the snapshot commit has after validating the manifest. Cleanup
    // wins the race before activateUpload starts its transactional batch.
    const validatedUpload = await repository.getUpload(replacement.uploadId);
    expect(validatedUpload).not.toBeNull();
    expect((await repository.cleanup(new Date("2026-10-28T02:00:00.000Z"))).purgedStagingVersions).toBe(1);
    expect(await repository.activateUpload(validatedUpload!, new Date("2026-10-28T02:00:00.001Z"))).toBe("stale");

    expect(database.raw.prepare("SELECT active_version_id FROM content WHERE id = ?").get(active.contentId)).toEqual({
      active_version_id: active.versionId,
    });
    expect(await assets.get(active.versionId, "index.html")).not.toBeNull();
    expect(await assets.get(replacement.versionId, "index.html")).toBeNull();
  });
});
