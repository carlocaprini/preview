type Row = Record<string, string | number | null>;

export interface CurrentContentFile {
  path: string;
  mediaType: string;
  size: number;
  etag: string;
  sha256: string;
}

export interface CurrentContentManifest {
  contentId: string;
  activeVersionId: string;
  sourceFormat: "html" | "zip";
  files: CurrentContentFile[];
}

function digestFromEtag(value: string): string {
  const match = value.match(/^"sha256-([0-9a-f]{64})"$/u);
  if (!match?.[1]) throw new Error("Stored file digest is invalid");
  return match[1];
}

export class D1ContentSourceRepository {
  constructor(private readonly db: D1Database) {}

  async currentManifest(contentId: string): Promise<CurrentContentManifest | "unpublished" | null> {
    const version = await this.db
      .prepare(
        `SELECT c.active_version_id,cv.source_format,cv.total_bytes
           FROM content c LEFT JOIN content_version cv ON cv.id = c.active_version_id AND cv.status = 'ready'
          WHERE c.id = ?`,
      )
      .bind(contentId)
      .first<Row>();
    if (!version) return null;
    if (!version.active_version_id || !version.source_format) return "unpublished";
    const result = await this.db
      .prepare(
        `SELECT va.path,va.media_type,va.expected_bytes,va.uploaded_bytes,va.etag
           FROM version_asset va
          WHERE va.version_id = ?
       ORDER BY va.path ASC`,
      )
      .bind(version.active_version_id)
      .all<Row>();
    if (
      result.results.length === 0 ||
      result.results.length > 50 ||
      result.results.some((row) => row.uploaded_bytes !== row.expected_bytes || row.etag === null) ||
      result.results.reduce((sum, row) => sum + Number(row.expected_bytes), 0) !== Number(version.total_bytes)
    ) {
      throw new Error("Current content manifest is incomplete");
    }
    return {
      contentId,
      activeVersionId: String(version.active_version_id),
      sourceFormat: String(version.source_format) as "html" | "zip",
      files: result.results.map((row) => ({
        path: String(row.path),
        mediaType: String(row.media_type),
        size: Number(row.expected_bytes),
        etag: String(row.etag),
        sha256: digestFromEtag(String(row.etag)),
      })),
    };
  }

  async currentFile(contentId: string, expectedActiveVersionId: string, path: string): Promise<CurrentContentFile | null> {
    const row = await this.db
      .prepare(
        `SELECT va.path,va.media_type,va.expected_bytes,va.etag
           FROM content c
           JOIN content_version cv ON cv.id = c.active_version_id AND cv.status = 'ready'
           JOIN version_asset va ON va.version_id = cv.id AND va.uploaded_bytes = va.expected_bytes
          WHERE c.id = ? AND c.active_version_id = ? AND va.path = ?`,
      )
      .bind(contentId, expectedActiveVersionId, path)
      .first<Row>();
    if (!row?.etag) return null;
    return {
      path: String(row.path),
      mediaType: String(row.media_type),
      size: Number(row.expected_bytes),
      etag: String(row.etag),
      sha256: digestFromEtag(String(row.etag)),
    };
  }
}
