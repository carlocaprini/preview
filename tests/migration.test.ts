import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("initial D1 migration", () => {
  it("applies cleanly and enforces core invariants", () => {
    const database = new DatabaseSync(":memory:");
    for (const name of ["0001_initial.sql", "0002_public_snapshots.sql", "0003_measurement_receipts.sql"]) {
      const migrationPath = fileURLToPath(new URL(`../migrations/${name}`, import.meta.url));
      database.exec(readFileSync(migrationPath, "utf8"));
    }

    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);

    expect(tables).toEqual(
      expect.arrayContaining([
        "content",
        "content_version",
        "daily_aggregate",
        "share_link",
        "upload_session",
        "version_asset",
      ]),
    );

    expect(() =>
      database.prepare("INSERT INTO content (id,title,created_at,updated_at) VALUES (?,?,?,?)").run(
        "content-1",
        "",
        "2026-10-26T00:00:00.000Z",
        "2026-10-26T00:00:00.000Z",
      ),
    ).toThrow();

    const versionColumns = database.prepare("PRAGMA table_info(content_version)").all().map((row) => row.name);
    expect(versionColumns).toContain("public_snapshot_id");
    expect(tables).toContain("measurement_receipt");
  });
});
