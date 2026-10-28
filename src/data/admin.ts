import { shareTokenForId } from "../domain/links.ts";
import { D1PdfRepository } from "./pdf.ts";

type Row = Record<string, string | number | null>;

export interface ContentSummary {
  id: string;
  title: string;
  updatedAt: string;
  activeVersion: number | null;
  sourceFormat: string | null;
  linkCount: number;
  activeLinkCount: number;
  meaningfulViews: number;
  activeVisibleMs: number;
  pdfDownloadsServed: number;
}

export class D1AdminRepository {
  constructor(
    private readonly db: D1Database,
    private readonly appOrigin: string,
    private readonly signingKey: string,
  ) {}

  async listContents(now = new Date()): Promise<ContentSummary[]> {
    const result = await this.db
      .prepare(
        `SELECT c.id,c.title,c.updated_at,cv.sequence,cv.source_format,
                COUNT(DISTINCT sl.id) AS link_count,
                COUNT(DISTINCT CASE WHEN sl.revoked_at IS NULL AND (sl.expires_at IS NULL OR sl.expires_at > ?) THEN sl.id END) AS active_link_count,
                COALESCE(SUM(da.meaningful_views),0) AS meaningful_views,
                COALESCE(SUM(da.active_visible_ms),0) AS active_visible_ms,
                COALESCE(SUM(da.pdf_downloads_served),0) AS pdf_downloads_served
           FROM content c
      LEFT JOIN content_version cv ON cv.id = c.active_version_id
      LEFT JOIN share_link sl ON sl.content_id = c.id
      LEFT JOIN daily_aggregate da ON da.share_link_id = sl.id
       GROUP BY c.id,c.title,c.updated_at,cv.sequence,cv.source_format
       ORDER BY c.updated_at DESC`,
      )
      .bind(now.toISOString())
      .all<Row>();
    return result.results.map((row) => this.summary(row));
  }

  async contentDetail(contentId: string, now = new Date()) {
    const content = await this.db
      .prepare("SELECT id,title,active_version_id,created_at,updated_at FROM content WHERE id = ?")
      .bind(contentId)
      .first<Row>();
    if (!content) return null;

    const [currentVersion, links, aggregates, pdfCompanion] = await Promise.all([
      this.db
        .prepare(
          `SELECT id,sequence,status,source_format,total_bytes,created_at,activated_at
             FROM content_version WHERE id = ?`,
        )
        .bind(content.active_version_id)
        .all<Row>(),
      this.db
        .prepare(
          `SELECT sl.id,sl.label,sl.created_at,sl.expires_at,sl.revoked_at,
                  COALESCE(SUM(da.meaningful_views),0) AS meaningful_views,
                  COALESCE(SUM(da.active_visible_ms),0) AS active_visible_ms,
                  MAX(da.last_view_at) AS last_view_at,
                  COALESCE(SUM(da.pdf_downloads_served),0) AS pdf_downloads_served,
                  MAX(da.last_pdf_download_at) AS last_pdf_download_at
             FROM share_link sl
        LEFT JOIN daily_aggregate da ON da.share_link_id = sl.id
            WHERE sl.content_id = ?
         GROUP BY sl.id,sl.label,sl.created_at,sl.expires_at,sl.revoked_at
         ORDER BY sl.created_at DESC`,
        )
        .bind(contentId)
        .all<Row>(),
      this.db
        .prepare(
          `SELECT da.day,SUM(da.meaningful_views) AS meaningful_views,SUM(da.active_visible_ms) AS active_visible_ms,
                  SUM(da.pdf_downloads_served) AS pdf_downloads_served
             FROM daily_aggregate da JOIN share_link sl ON sl.id = da.share_link_id
            WHERE sl.content_id = ? GROUP BY da.day ORDER BY da.day DESC LIMIT 30`,
        )
        .bind(contentId)
        .all<Row>(),
      new D1PdfRepository(this.db).stateForContent(contentId),
    ]);

    return {
      id: String(content.id),
      title: String(content.title),
      createdAt: String(content.created_at),
      updatedAt: String(content.updated_at),
      activeVersionId: content.active_version_id === null ? null : String(content.active_version_id),
      versions: currentVersion.results.map((row) => ({
        id: String(row.id),
        sequence: Number(row.sequence),
        status: String(row.status),
        sourceFormat: String(row.source_format),
        totalBytes: Number(row.total_bytes),
        createdAt: String(row.created_at),
        activatedAt: row.activated_at === null ? null : String(row.activated_at),
      })),
      links: await Promise.all(
        links.results.map(async (row) => ({
          id: String(row.id),
          label: String(row.label),
          url: `${this.appOrigin}/s/${await shareTokenForId(String(row.id), this.signingKey)}`,
          createdAt: String(row.created_at),
          expiresAt: row.expires_at === null ? null : String(row.expires_at),
          revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
          state:
            row.revoked_at !== null
              ? "revoked"
              : row.expires_at !== null && Date.parse(String(row.expires_at)) <= now.getTime()
                ? "expired"
                : "active",
          meaningfulViews: Number(row.meaningful_views),
          activeVisibleMs: Number(row.active_visible_ms),
          lastViewAt: row.last_view_at === null ? null : String(row.last_view_at),
          pdfDownloadsServed: Number(row.pdf_downloads_served),
          lastPdfDownloadAt: row.last_pdf_download_at === null ? null : String(row.last_pdf_download_at),
        })),
      ),
      aggregates: aggregates.results.map((row) => ({
        day: String(row.day),
        meaningfulViews: Number(row.meaningful_views),
        activeVisibleMs: Number(row.active_visible_ms),
        pdfDownloadsServed: Number(row.pdf_downloads_served),
      })),
      pdfCompanion,
    };
  }

  private summary(row: Row): ContentSummary {
    return {
      id: String(row.id),
      title: String(row.title),
      updatedAt: String(row.updated_at),
      activeVersion: row.sequence === null ? null : Number(row.sequence),
      sourceFormat: row.source_format === null ? null : String(row.source_format),
      linkCount: Number(row.link_count),
      activeLinkCount: Number(row.active_link_count),
      meaningfulViews: Number(row.meaningful_views),
      activeVisibleMs: Number(row.active_visible_ms),
      pdfDownloadsServed: Number(row.pdf_downloads_served),
    };
  }
}
