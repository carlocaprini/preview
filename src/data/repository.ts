import type { SourceFormat, VersionManifest } from "../domain/manifest.ts";
import { UPLOAD_TTL_MS } from "../domain/limits.ts";
import { uuid } from "../domain/ids.ts";

export interface ContentRecord {
  id: string;
  title: string;
  activeVersionId: string | null;
}

export interface UploadRecord {
  id: string;
  contentId: string;
  versionId: string;
  state: "open" | "committed" | "failed" | "expired";
  expiresAt: string;
  expectedActiveVersionId: string | null;
  activeVersionId: string | null;
  versionStatus: "staging" | "ready" | "failed";
}

export interface AssetRecord {
  path: string;
  mediaType: string;
  expectedBytes: number;
  uploadedBytes: number | null;
  etag: string | null;
}

export interface StartVersionResult {
  uploadId: string;
  versionId: string;
  expiresAt: string;
}

export interface PublishingRepository {
  createContent(title: string, now: Date): Promise<ContentRecord>;
  deleteContentIfEmpty(contentId: string): Promise<void>;
  getContent(contentId: string): Promise<ContentRecord | null>;
  startVersion(contentId: string, sourceFormat: SourceFormat, manifest: VersionManifest, now: Date): Promise<StartVersionResult>;
  getUpload(uploadId: string): Promise<UploadRecord | null>;
  getAsset(versionId: string, path: string): Promise<AssetRecord | null>;
  listAssets(versionId: string): Promise<AssetRecord[]>;
  markAssetUploaded(versionId: string, path: string, bytes: number, etag: string, now: Date): Promise<void>;
  markUploadExpired(uploadId: string): Promise<void>;
  activateUpload(upload: UploadRecord, now: Date): Promise<"activated" | "already_active" | "stale">;
  createShareLink(input: { id: string; contentId: string; label: string; createdAt: string; expiresAt: string | null }): Promise<void>;
}

type D1Row = Record<string, string | number | null>;

function contentFromRow(row: D1Row): ContentRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    activeVersionId: row.active_version_id === null ? null : String(row.active_version_id),
  };
}

export class D1PublishingRepository implements PublishingRepository {
  constructor(private readonly db: D1Database) {}

  async createContent(title: string, now: Date): Promise<ContentRecord> {
    const id = uuid();
    const timestamp = now.toISOString();
    await this.db
      .prepare("INSERT INTO content (id,title,created_at,updated_at) VALUES (?,?,?,?)")
      .bind(id, title, timestamp, timestamp)
      .run();
    return { id, title, activeVersionId: null };
  }

  async deleteContentIfEmpty(contentId: string): Promise<void> {
    await this.db.prepare("DELETE FROM content WHERE id = ? AND active_version_id IS NULL").bind(contentId).run();
  }

  async getContent(contentId: string): Promise<ContentRecord | null> {
    const row = await this.db
      .prepare("SELECT id,title,active_version_id FROM content WHERE id = ?")
      .bind(contentId)
      .first<D1Row>();
    return row ? contentFromRow(row) : null;
  }

  async startVersion(
    contentId: string,
    sourceFormat: SourceFormat,
    manifest: VersionManifest,
    now: Date,
  ): Promise<StartVersionResult> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const content = await this.getContent(contentId);
      if (!content) throw new Error("Content not found");
      const sequenceRow = await this.db
        .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM content_version WHERE content_id = ?")
        .bind(contentId)
        .first<{ sequence: number }>();
      const sequence = Number(sequenceRow?.sequence ?? 1);
      const versionId = uuid();
      const uploadId = uuid();
      const createdAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + UPLOAD_TTL_MS).toISOString();

      const statements = [
        this.db
          .prepare("INSERT INTO content_version (id,content_id,sequence,status,source_format,manifest_json,total_bytes,created_at) VALUES (?,?,?,'staging',?,?,?,?)")
          .bind(versionId, contentId, sequence, sourceFormat, JSON.stringify(manifest), manifest.totalBytes, createdAt),
        this.db
          .prepare("INSERT INTO upload_session (id,content_id,version_id,expected_active_version_id,state,expires_at,created_at) VALUES (?,?,?,?,'open',?,?)")
          .bind(uploadId, contentId, versionId, content.activeVersionId, expiresAt, createdAt),
        ...manifest.files.map((file) =>
          this.db
            .prepare("INSERT INTO version_asset (version_id,path,media_type,expected_bytes) VALUES (?,?,?,?)")
            .bind(versionId, file.path, file.mediaType, file.size),
        ),
      ];

      try {
        await this.db.batch(statements);
        return { uploadId, versionId, expiresAt };
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
    throw new Error("Could not allocate a version sequence");
  }

  async getUpload(uploadId: string): Promise<UploadRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT us.id,us.content_id,us.version_id,us.state,us.expires_at,us.expected_active_version_id,
                c.active_version_id,cv.status AS version_status
           FROM upload_session us
           JOIN content c ON c.id = us.content_id
           JOIN content_version cv ON cv.id = us.version_id
          WHERE us.id = ?`,
      )
      .bind(uploadId)
      .first<D1Row>();
    if (!row) return null;
    return {
      id: String(row.id),
      contentId: String(row.content_id),
      versionId: String(row.version_id),
      state: String(row.state) as UploadRecord["state"],
      expiresAt: String(row.expires_at),
      expectedActiveVersionId: row.expected_active_version_id === null ? null : String(row.expected_active_version_id),
      activeVersionId: row.active_version_id === null ? null : String(row.active_version_id),
      versionStatus: String(row.version_status) as UploadRecord["versionStatus"],
    };
  }

  async getAsset(versionId: string, path: string): Promise<AssetRecord | null> {
    const row = await this.db
      .prepare("SELECT path,media_type,expected_bytes,uploaded_bytes,etag FROM version_asset WHERE version_id = ? AND path = ?")
      .bind(versionId, path)
      .first<D1Row>();
    return row ? this.assetFromRow(row) : null;
  }

  async listAssets(versionId: string): Promise<AssetRecord[]> {
    const result = await this.db
      .prepare("SELECT path,media_type,expected_bytes,uploaded_bytes,etag FROM version_asset WHERE version_id = ? ORDER BY path")
      .bind(versionId)
      .all<D1Row>();
    return result.results.map((row) => this.assetFromRow(row));
  }

  private assetFromRow(row: D1Row): AssetRecord {
    return {
      path: String(row.path),
      mediaType: String(row.media_type),
      expectedBytes: Number(row.expected_bytes),
      uploadedBytes: row.uploaded_bytes === null ? null : Number(row.uploaded_bytes),
      etag: row.etag === null ? null : String(row.etag),
    };
  }

  async markAssetUploaded(versionId: string, path: string, bytes: number, etag: string, now: Date): Promise<void> {
    await this.db
      .prepare("UPDATE version_asset SET uploaded_bytes = ?,etag = ?,uploaded_at = ? WHERE version_id = ? AND path = ?")
      .bind(bytes, etag, now.toISOString(), versionId, path)
      .run();
  }

  async markUploadExpired(uploadId: string): Promise<void> {
    await this.db.prepare("UPDATE upload_session SET state = 'expired' WHERE id = ? AND state = 'open'").bind(uploadId).run();
  }

  async activateUpload(upload: UploadRecord, now: Date): Promise<"activated" | "already_active" | "stale"> {
    const timestamp = now.toISOString();
    if (upload.activeVersionId === upload.versionId) {
      await this.db
        .prepare("UPDATE upload_session SET state = 'committed',committed_at = COALESCE(committed_at,?) WHERE id = ?")
        .bind(timestamp, upload.id)
        .run();
      return "already_active";
    }

    const results = await this.db.batch([
      this.db
        .prepare("UPDATE content_version SET status = 'ready',activated_at = COALESCE(activated_at,?) WHERE id = ? AND status = 'staging'")
        .bind(timestamp, upload.versionId),
      this.db
        .prepare(
          `UPDATE content SET active_version_id = ?,updated_at = ?
            WHERE id = ? AND ((active_version_id IS NULL AND ? IS NULL) OR active_version_id = ?)`,
        )
        .bind(upload.versionId, timestamp, upload.contentId, upload.expectedActiveVersionId, upload.expectedActiveVersionId),
    ]);

    if ((results[1]?.meta.changes ?? 0) !== 1) {
      const current = await this.getContent(upload.contentId);
      if (current?.activeVersionId === upload.versionId) {
        await this.db
          .prepare("UPDATE upload_session SET state = 'committed',committed_at = COALESCE(committed_at,?) WHERE id = ?")
          .bind(timestamp, upload.id)
          .run();
        return "already_active";
      }
      await this.db.batch([
        this.db.prepare("UPDATE content_version SET status = 'failed' WHERE id = ?").bind(upload.versionId),
        this.db.prepare("UPDATE upload_session SET state = 'failed' WHERE id = ? AND state = 'open'").bind(upload.id),
      ]);
      return "stale";
    }

    await this.db
      .prepare("UPDATE upload_session SET state = 'committed',committed_at = ? WHERE id = ?")
      .bind(timestamp, upload.id)
      .run();
    return "activated";
  }

  async createShareLink(input: {
    id: string;
    contentId: string;
    label: string;
    createdAt: string;
    expiresAt: string | null;
  }): Promise<void> {
    await this.db
      .prepare("INSERT INTO share_link (id,content_id,label,created_at,expires_at) VALUES (?,?,?,?,?)")
      .bind(input.id, input.contentId, input.label, input.createdAt, input.expiresAt)
      .run();
  }
}
