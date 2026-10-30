export type LinkState = "active" | "expired" | "revoked" | "unavailable";

export interface ShareResolution {
  state: LinkState;
  linkId: string;
  contentId?: string;
  versionId?: string;
  snapshotId?: string;
  hasPdf?: boolean;
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

export interface ManagedShareLinkState {
  linkId: string;
  expiresAt: string | null;
  revokedAt: string | null;
  state: "active" | "expired" | "revoked";
}

type Row = Record<string, string | number | null>;

export class D1ViewerRepository {
  constructor(private readonly db: D1Database) {}

  async resolveShare(linkId: string, now: Date): Promise<ShareResolution | null> {
    const row = await this.db
      .prepare(
        `SELECT sl.id AS link_id,sl.content_id,sl.expires_at,sl.revoked_at,
                cv.id AS version_id,cv.public_snapshot_id,cv.status AS version_status,
                CASE WHEN c.pdf_approved_html_version_id = c.active_version_id AND p.status = 'ready' THEN 1 ELSE 0 END AS has_pdf
           FROM share_link sl
           JOIN content c ON c.id = sl.content_id
      LEFT JOIN content_version cv ON cv.id = c.active_version_id
      LEFT JOIN pdf_companion p ON p.id = c.current_pdf_id
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
      hasPdf: Number(row.has_pdf) === 1,
    };
  }

  async resolveSharedAsset(linkId: string, snapshotId: string, path: string, now: Date): Promise<ResolvedAsset | null> {
    const row = await this.db
      .prepare(
        `SELECT sl.id AS link_id,sl.content_id,sl.expires_at,sl.revoked_at,
                cv.id AS version_id,cv.public_snapshot_id,va.path,va.media_type,va.expected_bytes
           FROM share_link sl
           JOIN content c ON c.id = sl.content_id
           JOIN content_version cv ON cv.content_id = sl.content_id AND cv.public_snapshot_id = ? AND cv.status = 'ready'
           JOIN version_asset va ON va.version_id = cv.id AND va.path = ? AND va.uploaded_bytes = va.expected_bytes
          WHERE sl.id = ?
            AND (c.active_version_id = cv.id OR (cv.purge_after IS NOT NULL AND cv.purge_after > ?))`,
      )
      .bind(snapshotId, path, linkId, now.toISOString())
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
    return (await this.updateLinkExpiryState(linkId, expiresAt)) !== null;
  }

  async revokeLink(linkId: string, now: Date): Promise<boolean> {
    return (await this.revokeLinkState(linkId, now)) !== null;
  }

  async updateLinkExpiryState(linkId: string, expiresAt: string | null, now = new Date()): Promise<ManagedShareLinkState | null> {
    const result = await this.db
      .prepare("UPDATE share_link SET expires_at = ? WHERE id = ? AND revoked_at IS NULL")
      .bind(expiresAt, linkId)
      .run();
    if ((result.meta.changes ?? 0) !== 1) {
      const existing = await this.linkState(linkId, now);
      if (existing?.state === "revoked") throw new Error("Revoked links cannot be updated");
      return null;
    }
    return this.linkState(linkId, now);
  }

  async revokeLinkState(
    linkId: string,
    now = new Date(),
  ): Promise<{ linkId: string; revoked: true; revokedAt: string } | null> {
    await this.db
      .prepare("UPDATE share_link SET revoked_at = COALESCE(revoked_at,?) WHERE id = ?")
      .bind(now.toISOString(), linkId)
      .run();
    const row = await this.db.prepare("SELECT revoked_at FROM share_link WHERE id = ?").bind(linkId).first<Row>();
    if (!row?.revoked_at) return null;
    return { linkId, revoked: true, revokedAt: String(row.revoked_at) };
  }

  private async linkState(linkId: string, now: Date): Promise<ManagedShareLinkState | null> {
    const row = await this.db
      .prepare("SELECT id,expires_at,revoked_at FROM share_link WHERE id = ?")
      .bind(linkId)
      .first<Row>();
    if (!row) return null;
    return {
      linkId: String(row.id),
      expiresAt: row.expires_at === null ? null : String(row.expires_at),
      revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
      state:
        row.revoked_at !== null
          ? "revoked"
          : row.expires_at !== null && Date.parse(String(row.expires_at)) <= now.getTime()
            ? "expired"
            : "active",
    };
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
