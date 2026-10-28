export type MeasurementKind = "view" | "visible";

export class D1AnalyticsRepository {
  constructor(private readonly db: D1Database) {}

  async record(input: {
    receiptId: string;
    linkId: string;
    kind: MeasurementKind;
    visibleMs: number;
    now: Date;
  }): Promise<boolean> {
    const now = input.now.toISOString();
    const expiresAt = new Date(input.now.getTime() + 24 * 60 * 60 * 1_000).toISOString();
    await this.db.prepare("DELETE FROM measurement_receipt WHERE expires_at <= ?").bind(now).run();
    const receipt = await this.db
      .prepare("INSERT OR IGNORE INTO measurement_receipt (id,share_link_id,expires_at) VALUES (?,?,?)")
      .bind(input.receiptId, input.linkId, expiresAt)
      .run();
    if ((receipt.meta.changes ?? 0) !== 1) return false;

    const day = now.slice(0, 10);
    const views = input.kind === "view" ? 1 : 0;
    const visibleMs = input.kind === "visible" ? input.visibleMs : 0;
    await this.db
      .prepare(
        `INSERT INTO daily_aggregate (share_link_id,day,meaningful_views,active_visible_ms,last_view_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT (share_link_id,day) DO UPDATE SET
           meaningful_views = meaningful_views + excluded.meaningful_views,
           active_visible_ms = active_visible_ms + excluded.active_visible_ms,
           last_view_at = CASE WHEN excluded.meaningful_views > 0 THEN excluded.last_view_at ELSE last_view_at END`,
      )
      .bind(input.linkId, day, views, visibleMs, views ? now : null)
      .run();
    return true;
  }

  async recordPdfDownload(linkId: string, now = new Date()): Promise<void> {
    const timestamp = now.toISOString();
    const day = timestamp.slice(0, 10);
    await this.db
      .prepare(
        `INSERT INTO daily_aggregate
          (share_link_id,day,meaningful_views,active_visible_ms,last_view_at,pdf_downloads_served,last_pdf_download_at)
         VALUES (?,?,0,0,NULL,1,?)
         ON CONFLICT (share_link_id,day) DO UPDATE SET
           pdf_downloads_served = pdf_downloads_served + 1,
           last_pdf_download_at = excluded.last_pdf_download_at`,
      )
      .bind(linkId, day, timestamp)
      .run();
  }
}
