export type LinkState = "active" | "expired" | "revoked" | "unavailable";

export interface ShareResolution {
  state: LinkState;
  linkId: string;
  contentId?: string;
  versionId?: string;
  snapshotId?: string;
}

export interface ResolvedAsset {
  linkId?: string;
  contentId: string;
  versionId: string;
  snapshotId: string;
  path: string;
  mediaType: string;
  bytes: number;
}

type Row = Record<string, string | number | null>;

export class D1ViewerRepository {
  constructor(private readonly db: D1Database) {}

  async resolveShare(linkId: string, now: Date): Promise<ShareResolution | null> {
    const row = await this.db
      .prepare(
        `SELECT sl.id AS link_id,sl.content_id,sl.expires_at,sl.revoked_at,
                cv.id AS version_id,cv.public_snapshot_id,cv.status AS version_status
           FROM share_link sl
           JOIN content c ON c.id = sl.content_id
      LEFT JOIN content_version cv ON cv.id = c.active_version_id
          WHERE sl.id = ?`,
      )
      .bind(linkId)
      .first<Row>();
    if (!row) return null;
    if (row.revoked_at !== null) return { state: "revoked", linkId };
    if (row.expires_at !== null && Date.parse(String(row.expires_at)) <= now.getTime()) {
      return { state: "expired", linkId };
    }
    if (!row.version_id || row.version_status !== "ready" || !row.public_snapshot_id) {
      return { state: "unavailable", linkId };
    }
    return {
      state: "active",
      linkId,
      contentId: String(row.content_id),
      versionId: String(row.version_id),
      snapshotId: String(row.public_snapshot_id),
    };
  }

  async resolveSharedAsset(linkId: string, snapshotId: string, path: string, now: Date): Promise<ResolvedAsset | null> {
    const row = await this.db
      .prepare(
        `SELECT sl.id AS link_id,sl.content_id,sl.expires_at,sl.revoked_at,
                cv.id AS version_id,cv.public_snapshot_id,va.path,va.media_type,va.expected_bytes
           FROM share_link sl
           JOIN content_version cv ON cv.content_id = sl.content_id AND cv.public_snapshot_id = ? AND cv.status = 'ready'
           JOIN version_asset va ON va.version_id = cv.id AND va.path = ? AND va.uploaded_bytes = va.expected_bytes
          WHERE sl.id = ?`,
      )
      .bind(snapshotId, path, linkId)
      .first<Row>();
    if (!row || row.revoked_at !== null) return null;
    if (row.expires_at !== null && Date.parse(String(row.expires_at)) <= now.getTime()) return null;
    return this.assetFromRow(row);
  }

  async resolveOwnerPreview(contentId: string): Promise<{ contentId: string; versionId: string; snapshotId: string } | null> {
    const row = await this.db
      .prepare(
        `SELECT c.id AS content_id,cv.id AS version_id,cv.public_snapshot_id
           FROM content c
           JOIN content_version cv ON cv.id = c.active_version_id AND cv.status = 'ready'
          WHERE c.id = ?`,
      )
      .bind(contentId)
      .first<Row>();
    if (!row?.public_snapshot_id) return null;
    return {
      contentId: String(row.content_id),
      versionId: String(row.version_id),
      snapshotId: String(row.public_snapshot_id),
    };
  }

  async resolveOwnerAsset(contentId: string, snapshotId: string, path: string): Promise<ResolvedAsset | null> {
    const row = await this.db
      .prepare(
        `SELECT cv.content_id,cv.id AS version_id,cv.public_snapshot_id,va.path,va.media_type,va.expected_bytes
           FROM content_version cv
           JOIN version_asset va ON va.version_id = cv.id AND va.path = ? AND va.uploaded_bytes = va.expected_bytes
          WHERE cv.content_id = ? AND cv.public_snapshot_id = ? AND cv.status = 'ready'`,
      )
      .bind(path, contentId, snapshotId)
      .first<Row>();
    return row ? this.assetFromRow(row) : null;
  }

  async updateLinkExpiry(linkId: string, expiresAt: string | null): Promise<boolean> {
    const result = await this.db.prepare("UPDATE share_link SET expires_at = ? WHERE id = ?").bind(expiresAt, linkId).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async revokeLink(linkId: string, now: Date): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE share_link SET revoked_at = COALESCE(revoked_at,?) WHERE id = ?")
      .bind(now.toISOString(), linkId)
      .run();
    return (result.meta.changes ?? 0) === 1;
  }

  private assetFromRow(row: Row): ResolvedAsset {
    return {
      linkId: row.link_id ? String(row.link_id) : undefined,
      contentId: String(row.content_id),
      versionId: String(row.version_id),
      snapshotId: String(row.public_snapshot_id),
      path: String(row.path),
      mediaType: String(row.media_type),
      bytes: Number(row.expected_bytes),
    };
  }
}
