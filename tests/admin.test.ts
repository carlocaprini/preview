import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { D1AdminRepository } from "../src/data/admin.ts";

class BoundStatement {
  constructor(private readonly statement: StatementSync, private readonly values: unknown[] = []) {}

  bind(...values: unknown[]): BoundStatement {
    return new BoundStatement(this.statement, values);
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

  constructor() {
    const migrations = fileURLToPath(new URL("../migrations", import.meta.url));
    for (const name of readdirSync(migrations).filter((entry) => /^\d{4}_.+\.sql$/u.test(entry)).sort()) {
      this.raw.exec(readFileSync(`${migrations}/${name}`, "utf8"));
    }
  }

  prepare(sql: string): BoundStatement {
    return new BoundStatement(this.raw.prepare(sql));
  }
}

function addContent(database: SqliteD1, id: string): void {
  database.raw.prepare("INSERT INTO content (id,title,created_at,updated_at) VALUES (?,?,?,?)")
    .run(id, `Content ${id}`, "2025-01-01T00:00:00.000Z", "2026-01-05T00:00:00.000Z");
}

function addLink(database: SqliteD1, id: string, contentId: string, expiresAt: string | null, revokedAt: string | null): void {
  database.raw.prepare(
    "INSERT INTO share_link (id,content_id,label,created_at,expires_at,revoked_at) VALUES (?,?,?,?,?,?)",
  ).run(id, contentId, `Link ${id}`, "2025-01-01T00:00:00.000Z", expiresAt, revokedAt);
}

function addAggregate(
  database: SqliteD1,
  linkId: string,
  day: string,
  meaningfulViews: number,
  activeVisibleMs = 0,
  pdfDownloadsServed = 0,
): void {
  database.raw.prepare(
    `INSERT INTO daily_aggregate
      (share_link_id,day,meaningful_views,active_visible_ms,last_view_at,pdf_downloads_served,last_pdf_download_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(linkId, day, meaningfulViews, activeVisibleMs, `${day}T12:00:00.000Z`, pdfDownloadsServed, null);
}

function repository(database: SqliteD1): D1AdminRepository {
  return new D1AdminRepository(
    database as unknown as D1Database,
    "https://preview.test",
    "admin-history-test-signing-key-at-least-thirty-two-bytes",
  );
}

describe("admin 30-day UTC history", () => {
  it("returns exactly 30 zero-filled UTC calendar days across leap day", async () => {
    const database = new SqliteD1();
    addContent(database, "empty-content");

    const detail = await repository(database).contentDetail(
      "empty-content",
      new Date("2024-03-01T23:59:59.000Z"),
    );

    expect(detail?.aggregates).toHaveLength(30);
    expect(detail?.aggregates[0]).toEqual({
      day: "2024-02-01",
      meaningfulViews: 0,
      activeVisibleMs: 0,
      pdfDownloadsServed: 0,
    });
    expect(detail?.aggregates.at(-1)?.day).toBe("2024-03-01");
    expect(detail?.aggregates.map((entry) => entry.day)).toContain("2024-02-29");
    expect(detail?.aggregateRange).toEqual({ startDay: "2024-02-01", endDay: "2024-03-01", timezone: "UTC" });
  });

  it("sums every link by day, preserves other aggregate fields, and excludes older activity", async () => {
    const database = new SqliteD1();
    addContent(database, "content-1");
    addContent(database, "other-content");
    addLink(database, "active-link", "content-1", null, null);
    addLink(database, "expired-link", "content-1", "2025-12-20T00:00:00.000Z", null);
    addLink(database, "revoked-link", "content-1", null, "2026-01-02T00:00:00.000Z");
    addLink(database, "other-link", "other-content", null, null);

    addAggregate(database, "active-link", "2025-12-06", 99, 9_900, 9);
    addAggregate(database, "active-link", "2025-12-07", 1, 100, 1);
    addAggregate(database, "active-link", "2026-01-04", 3, 300, 1);
    addAggregate(database, "expired-link", "2026-01-04", 4, 400, 2);
    addAggregate(database, "revoked-link", "2026-01-04", 5, 500, 3);
    addAggregate(database, "active-link", "2026-01-05", 2, 200, 0);
    addAggregate(database, "other-link", "2026-01-04", 100, 10_000, 10);

    const detail = await repository(database).contentDetail("content-1", new Date("2026-01-05T23:59:59.999Z"));

    expect(detail?.aggregates).toHaveLength(30);
    expect(detail?.aggregates[0]?.day).toBe("2025-12-07");
    expect(detail?.aggregates.at(-1)?.day).toBe("2026-01-05");
    expect(detail?.aggregates[1]).toEqual({
      day: "2025-12-08",
      meaningfulViews: 0,
      activeVisibleMs: 0,
      pdfDownloadsServed: 0,
    });
    expect(detail?.aggregates.find((entry) => entry.day === "2026-01-04")).toEqual({
      day: "2026-01-04",
      meaningfulViews: 12,
      activeVisibleMs: 1_200,
      pdfDownloadsServed: 6,
    });
    expect(detail?.aggregates.reduce((sum, entry) => sum + entry.meaningfulViews, 0)).toBe(15);
    expect(detail?.links.map((link) => link.state)).toEqual(expect.arrayContaining(["active", "expired", "revoked"]));
  });

  it("uses the UTC date represented by the injected instant and keeps unknown content behavior", async () => {
    const database = new SqliteD1();
    addContent(database, "timezone-content");
    const repo = repository(database);

    const detail = await repo.contentDetail("timezone-content", new Date("2026-01-01T01:00:00+14:00"));

    expect(detail?.aggregateRange.endDay).toBe("2025-12-31");
    expect(await repo.contentDetail("missing", new Date("2026-01-01T00:00:00.000Z"))).toBeNull();
  });
});

describe("bounded MCP content discovery", () => {
  it("searches literal title text and paginates deterministically across equal timestamps", async () => {
    const database = new SqliteD1();
    for (let index = 0; index < 53; index += 1) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      database.raw.prepare("INSERT INTO content (id,title,created_at,updated_at) VALUES (?,?,?,?)")
        .run(id, index === 52 ? "Kumbe 100%_literal" : `Kumbe ${index}`, "2026-01-01T00:00:00.000Z", "2026-10-30T08:00:00.000Z");
    }
    addContent(database, "unrelated");
    const repo = repository(database);
    const first = await repo.listContentsPage({ query: " Kumbe ", limit: 50, now: new Date("2026-10-30T09:00:00.000Z") });
    const second = await repo.listContentsPage({ query: "Kumbe", limit: 50, cursor: first.nextCursor, now: new Date("2026-10-30T09:00:00.000Z") });

    expect(first.contents).toHaveLength(50);
    expect(second.contents).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.contents, ...second.contents].map((item) => item.contentId)).size).toBe(53);
    expect((await repo.listContentsPage({ query: "%_literal" })).contents.map((item) => item.title)).toEqual(["Kumbe 100%_literal"]);
  });

  it("reports unpublished and active states without exposing private payload fields", async () => {
    const database = new SqliteD1();
    addContent(database, "draft-content");
    addContent(database, "ready-content");
    database.raw.prepare(
      `INSERT INTO content_version
        (id,content_id,sequence,status,source_format,manifest_json,total_bytes,created_at,activated_at,public_snapshot_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run("version-1", "ready-content", 1, "ready", "html", '{"files":[],"totalBytes":0}', 0, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "snapshot-1");
    database.raw.prepare("UPDATE content SET active_version_id = ? WHERE id = ?").run("version-1", "ready-content");
    addLink(database, "active-link", "ready-content", null, null);
    addAggregate(database, "active-link", "2026-01-01", 7);

    const page = await repository(database).listContentsPage({ now: new Date("2026-01-02T00:00:00.000Z") });
    expect(page.contents.find((item) => item.contentId === "draft-content")).toMatchObject({
      hasActiveHtml: false,
      sourceFormat: null,
    });
    expect(page.contents.find((item) => item.contentId === "ready-content")).toMatchObject({
      hasActiveHtml: true,
      sourceFormat: "html",
      activeLinkCount: 1,
      meaningfulViews: 7,
    });
    expect(JSON.stringify(page)).not.toMatch(/token|url|manifest/iu);
  });

  it("rejects malformed and query-mismatched cursors", async () => {
    const database = new SqliteD1();
    addContent(database, "content-1");
    addContent(database, "content-2");
    const repo = repository(database);
    await expect(repo.listContentsPage({ cursor: "not-json" })).rejects.toThrow("Invalid cursor");
    const page = await repo.listContentsPage({ query: "Content", limit: 1 });
    await expect(repo.listContentsPage({ query: "Other", cursor: page.nextCursor })).rejects.toThrow("Invalid cursor");
  });
});

describe("MCP content metadata", () => {
  it("returns a narrow unpublished state without link URLs or aggregate history", async () => {
    const database = new SqliteD1();
    addContent(database, "draft-content");
    addLink(database, "expired-link", "draft-content", "2026-01-01T00:00:00.000Z", null);

    const metadata = await repository(database).contentMetadata("draft-content", new Date("2026-02-01T00:00:00.000Z"));

    expect(metadata).toMatchObject({
      contentId: "draft-content",
      publication: { state: "unpublished", activeVersionId: null, fileCount: 0, totalBytes: 0 },
      sharing: { totalLinkCount: 1, activeLinkCount: 0 },
      pdfCompanion: { state: "none" },
    });
    expect(JSON.stringify(metadata)).not.toMatch(/url|aggregates|versions/iu);
  });

  it("returns only the current ready version and authoritative PDF approval state", async () => {
    const database = new SqliteD1();
    addContent(database, "ready-content");
    database.raw.prepare(
      `INSERT INTO content_version
        (id,content_id,sequence,status,source_format,manifest_json,total_bytes,created_at,activated_at,public_snapshot_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run("version-current", "ready-content", 1, "ready", "zip", '{"files":[],"totalBytes":12}', 12, "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "snapshot-current");
    database.raw.prepare("INSERT INTO version_asset (version_id,path,media_type,expected_bytes,uploaded_bytes) VALUES (?,?,?,?,?)")
      .run("version-current", "index.html", "text/html; charset=utf-8", 12, 12);
    database.raw.prepare(
      "INSERT INTO pdf_companion (id,content_id,safe_filename,total_bytes,status,created_at,ready_at) VALUES (?,?,?,?,?,?,?)",
    ).run("pdf-current", "ready-content", "report.pdf", 100, "ready", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    database.raw.prepare(
      "UPDATE content SET active_version_id = ?,current_pdf_id = ?,pdf_approved_html_version_id = ? WHERE id = ?",
    ).run("version-current", "pdf-current", null, "ready-content");

    const metadata = await repository(database).contentMetadata("ready-content");

    expect(metadata).toMatchObject({
      publication: {
        state: "ready",
        activeVersionId: "version-current",
        sourceFormat: "zip",
        fileCount: 1,
        totalBytes: 12,
      },
      pdfCompanion: { state: "outdated", pdfId: "pdf-current", fileName: "report.pdf", approvedVersionId: null },
    });
    expect(await repository(database).contentMetadata("missing-content")).toBeNull();
  });
});
