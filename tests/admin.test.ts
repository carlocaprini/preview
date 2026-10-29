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
