import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("initial D1 migration", () => {
  it("applies cleanly and enforces core invariants", () => {
    const database = new DatabaseSync(":memory:");
    for (const name of [
      "0001_initial.sql",
      "0002_public_snapshots.sql",
      "0003_measurement_receipts.sql",
      "0004_d1_asset_storage.sql",
      "0005_latest_only_retention.sql",
    ]) {
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
        "asset_chunk",
        "asset_payload",
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
    expect(versionColumns).toContain("purge_after");
    const contentColumns = database.prepare("PRAGMA table_info(content)").all().map((row) => row.name);
    expect(contentColumns).toContain("next_version_sequence");
    expect(tables).toContain("measurement_receipt");
  });

  it("gives pre-existing superseded ready versions a grace deadline without touching active or open versions", () => {
    const database = new DatabaseSync(":memory:");
    for (const name of [
      "0001_initial.sql",
      "0002_public_snapshots.sql",
      "0003_measurement_receipts.sql",
      "0004_d1_asset_storage.sql",
    ]) {
      const migrationPath = fileURLToPath(new URL(`../migrations/${name}`, import.meta.url));
      database.exec(readFileSync(migrationPath, "utf8"));
    }

    const timestamp = "2026-10-20T00:00:00.000Z";
    database.prepare("INSERT INTO content (id,title,active_version_id,created_at,updated_at) VALUES (?,?,?,?,?)")
      .run("content-1", "Existing content", null, timestamp, timestamp);
    const insertVersion = database.prepare(
      `INSERT INTO content_version
        (id,content_id,sequence,status,source_format,manifest_json,total_bytes,created_at,activated_at,public_snapshot_id)
       VALUES (?,?,? ,?,'html','{"entry":"index.html","files":[],"totalBytes":0}',0,?,?,?)`,
    );
    insertVersion.run("version-1", "content-1", 1, "ready", timestamp, timestamp, "snapshot-1");
    insertVersion.run("version-2", "content-1", 2, "ready", timestamp, timestamp, "snapshot-2");
    insertVersion.run("version-3", "content-1", 3, "staging", timestamp, null, "snapshot-3");
    database.prepare("UPDATE content SET active_version_id = ? WHERE id = ?").run("version-2", "content-1");
    database.prepare(
      `INSERT INTO upload_session
        (id,content_id,version_id,expected_active_version_id,state,expires_at,created_at)
       VALUES (?,?,?,?, 'open',?,?)`,
    ).run("upload-3", "content-1", "version-3", "version-2", "2026-10-30T00:00:00.000Z", timestamp);

    const migrationPath = fileURLToPath(new URL("../migrations/0005_latest_only_retention.sql", import.meta.url));
    database.exec(readFileSync(migrationPath, "utf8"));

    const rows = database.prepare("SELECT id,purge_after FROM content_version ORDER BY sequence").all();
    expect(rows[0]?.purge_after).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(rows[1]?.purge_after).toBeNull();
    expect(rows[2]?.purge_after).toBeNull();
    expect(database.prepare("SELECT next_version_sequence FROM content WHERE id = ?").get("content-1")).toEqual({
      next_version_sequence: 4,
    });
  });
});
