import { uuid } from "../domain/ids.ts";

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
const PDF_CHUNK_BYTES = 512 * 1024;
const PDF_UPLOAD_TTL_MS = 30 * 60 * 1_000;
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1_000;
const PDF_CLEANUP_BATCH_SIZE = 20;

type Row = Record<string, string | number | null>;
type ChunkRow = { bytes: number[] | ArrayBuffer | ArrayBufferView };

export interface PdfCompanionState {
  state: "none" | "current" | "outdated";
  id?: string;
  fileName?: string;
  size?: number;
  uploadedAt?: string;
  approvedVersionId?: string | null;
}

export interface PdfUploadPlan {
  uploadId: string;
  pdfId: string;
  expiresAt: string;
  uploadUrl: string;
  commitUrl: string;
}

export interface PublicPdf {
  linkId: string;
  pdfId: string;
  fileName: string;
  size: number;
  sha256: string;
  body: ReadableStream<Uint8Array>;
}

interface UploadRecord {
  id: string;
  contentId: string;
  pdfId: string;
  state: "open" | "uploaded" | "committed" | "failed" | "expired";
  expiresAt: string;
  expectedActiveVersionId: string;
  expectedCurrentPdfId: string | null;
  activeVersionId: string | null;
  currentPdfId: string | null;
  totalBytes: number;
  status: "staging" | "ready" | "failed";
}

export class D1PdfRepository {
  constructor(private readonly db: D1Database) {}

  async startUpload(input: {
    contentId: string;
    fileName: string;
    size: number;
    expectedActiveVersionId: string;
    now: Date;
    appOrigin: string;
  }): Promise<PdfUploadPlan> {
    if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > MAX_PDF_BYTES) {
      throw new Error(`PDF size must be between 1 byte and ${MAX_PDF_BYTES} bytes`);
    }
    const fileName = safePdfFileName(input.fileName);
    const content = await this.db
      .prepare("SELECT active_version_id,current_pdf_id FROM content WHERE id = ?")
      .bind(input.contentId)
      .first<Row>();
    if (!content?.active_version_id) throw new Error("Content has no active HTML version");
    if (String(content.active_version_id) !== input.expectedActiveVersionId) throw new Error("Active HTML version changed");

    const createdAt = input.now.toISOString();
    const expiresAt = new Date(input.now.getTime() + PDF_UPLOAD_TTL_MS).toISOString();
    const pdfId = uuid();
    const uploadId = uuid();
    await this.cleanup(input.now);
    await this.db.batch([
      this.db.prepare(
        "INSERT INTO pdf_companion (id,content_id,safe_filename,total_bytes,status,created_at) VALUES (?,?,?,?,'staging',?)",
      ).bind(pdfId, input.contentId, fileName, input.size, createdAt),
      this.db.prepare(
        `INSERT INTO pdf_upload_session
          (id,content_id,pdf_id,expected_active_version_id,expected_current_pdf_id,state,expires_at,created_at)
          VALUES (?,?,?,?,?,'open',?,?)`,
      ).bind(
        uploadId,
        input.contentId,
        pdfId,
        input.expectedActiveVersionId,
        content.current_pdf_id,
        expiresAt,
        createdAt,
      ),
    ]);
    return {
      uploadId,
      pdfId,
      expiresAt,
      uploadUrl: `${input.appOrigin}/api/admin/pdf/uploads/${uploadId}/data`,
      commitUrl: `${input.appOrigin}/api/admin/pdf/uploads/${uploadId}/commit`,
    };
  }

  async uploadData(uploadId: string, body: ReadableStream<Uint8Array> | null, now = new Date()): Promise<void> {
    const upload = await this.getUpload(uploadId);
    if (!upload || upload.state !== "open" || upload.status !== "staging") throw new Error("PDF upload is not open");
    if (Date.parse(upload.expiresAt) <= now.getTime()) {
      await this.db.prepare("UPDATE pdf_upload_session SET state = 'expired' WHERE id = ?").bind(uploadId).run();
      throw new Error("PDF upload expired");
    }
    if (!body) throw new Error("PDF body is required");
    const bytes = await readExactly(body, upload.totalBytes);
    if (!hasPdfSignature(bytes)) throw new Error("File is not a PDF");
    const sha256 = await sha256Hex(bytes);
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += PDF_CHUNK_BYTES) {
      chunks.push(bytes.slice(offset, Math.min(offset + PDF_CHUNK_BYTES, bytes.byteLength)));
    }
    const chunkHashes = await Promise.all(chunks.map((chunk) => sha256Hex(chunk)));
    await this.db.batch([
      this.db.prepare("DELETE FROM pdf_companion_chunk WHERE pdf_id = ?").bind(upload.pdfId),
      ...chunks.map((chunk, index) =>
        this.db.prepare("INSERT INTO pdf_companion_chunk (pdf_id,chunk_index,bytes,sha256) VALUES (?,?,?,?)")
          .bind(upload.pdfId, index, chunk, chunkHashes[index]),
      ),
      this.db.prepare("UPDATE pdf_companion SET chunk_count = ?,sha256 = ? WHERE id = ? AND status = 'staging'").bind(chunks.length, sha256, upload.pdfId),
      this.db.prepare("UPDATE pdf_upload_session SET state = 'uploaded' WHERE id = ? AND state = 'open'").bind(uploadId),
    ]);
  }

  async commit(uploadId: string, now = new Date()): Promise<PdfCompanionState> {
    const upload = await this.getUpload(uploadId);
    if (!upload) throw new Error("PDF upload not found");
    if (upload.state === "committed") return this.stateForContent(upload.contentId);
    if (
      upload.state === "uploaded" &&
      upload.status === "ready" &&
      upload.currentPdfId === upload.pdfId &&
      upload.activeVersionId === upload.expectedActiveVersionId
    ) {
      await this.db.prepare(
        "UPDATE pdf_upload_session SET state = 'committed',committed_at = COALESCE(committed_at,?) WHERE id = ? AND state = 'uploaded'",
      ).bind(now.toISOString(), uploadId).run();
      return this.stateForContent(upload.contentId);
    }
    if (upload.state !== "uploaded" || upload.status !== "staging") throw new Error("PDF upload is not ready");
    if (Date.parse(upload.expiresAt) <= now.getTime()) throw new Error("PDF upload expired");
    if (upload.activeVersionId !== upload.expectedActiveVersionId) {
      await this.markFailedIfOrphan(upload, now);
      throw new Error("Active HTML version changed");
    }
    if (upload.currentPdfId !== upload.expectedCurrentPdfId) {
      await this.markFailedIfOrphan(upload, now);
      throw new Error("PDF companion changed");
    }

    const timestamp = now.toISOString();
    const currentClause = upload.expectedCurrentPdfId === null ? "current_pdf_id IS NULL" : "current_pdf_id = ?";
    const currentBindings = upload.expectedCurrentPdfId === null ? [] : [upload.expectedCurrentPdfId];
    const results = await this.db.batch([
      this.db.prepare("UPDATE pdf_companion SET status = 'ready',ready_at = ? WHERE id = ? AND status = 'staging' AND sha256 IS NOT NULL").bind(timestamp, upload.pdfId),
      this.db.prepare(
        `UPDATE content SET current_pdf_id = ?,pdf_approved_html_version_id = ?,updated_at = ?
          WHERE id = ? AND active_version_id = ? AND ${currentClause}`,
      ).bind(upload.pdfId, upload.expectedActiveVersionId, timestamp, upload.contentId, upload.expectedActiveVersionId, ...currentBindings),
      this.db.prepare(
        `UPDATE pdf_companion SET orphaned_at = COALESCE(orphaned_at,?)
          WHERE id = ? AND NOT EXISTS (SELECT 1 FROM content c WHERE c.current_pdf_id = pdf_companion.id)`,
      ).bind(timestamp, upload.expectedCurrentPdfId),
      this.db.prepare(
        `UPDATE pdf_upload_session SET state = 'committed',committed_at = ?
          WHERE id = ? AND state = 'uploaded'
            AND EXISTS (
              SELECT 1 FROM content c
               WHERE c.id = pdf_upload_session.content_id
                 AND c.current_pdf_id = pdf_upload_session.pdf_id
                 AND c.active_version_id = pdf_upload_session.expected_active_version_id
            )`,
      ).bind(timestamp, uploadId),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1 || (results[3]?.meta.changes ?? 0) !== 1) {
      const current = await this.getUpload(uploadId);
      if (
        current?.state === "committed" &&
        current.status === "ready" &&
        current.currentPdfId === current.pdfId &&
        current.activeVersionId === current.expectedActiveVersionId
      ) {
        return this.stateForContent(current.contentId);
      }
      await this.markFailedIfOrphan(current ?? upload, now);
      const afterCleanup = await this.getUpload(uploadId);
      if (
        afterCleanup?.state === "committed" &&
        afterCleanup.status === "ready" &&
        afterCleanup.currentPdfId === afterCleanup.pdfId
      ) {
        return this.stateForContent(afterCleanup.contentId);
      }
      throw new Error("PDF commit conflicted with a newer change");
    }
    return this.stateForContent(upload.contentId);
  }

  async confirmReuse(contentId: string, pdfId: string, expectedActiveVersionId: string, now = new Date()): Promise<PdfCompanionState> {
    const result = await this.db.prepare(
      `UPDATE content SET pdf_approved_html_version_id = ?,updated_at = ?
        WHERE id = ? AND active_version_id = ? AND current_pdf_id = ?
          AND EXISTS (SELECT 1 FROM pdf_companion p WHERE p.id = ? AND p.content_id = content.id AND p.status = 'ready')`,
    ).bind(expectedActiveVersionId, now.toISOString(), contentId, expectedActiveVersionId, pdfId, pdfId).run();
    if ((result.meta.changes ?? 0) !== 1) throw new Error("PDF confirmation is stale");
    return this.stateForContent(contentId);
  }

  async remove(contentId: string, now = new Date()): Promise<boolean> {
    const content = await this.db.prepare("SELECT current_pdf_id FROM content WHERE id = ?").bind(contentId).first<Row>();
    if (!content?.current_pdf_id) return false;
    const pdfId = String(content.current_pdf_id);
    const timestamp = now.toISOString();
    const results = await this.db.batch([
      this.db.prepare(
        "UPDATE content SET current_pdf_id = NULL,pdf_approved_html_version_id = NULL,updated_at = ? WHERE id = ? AND current_pdf_id = ?",
      ).bind(timestamp, contentId, pdfId),
      this.db.prepare(
        `UPDATE pdf_companion SET orphaned_at = COALESCE(orphaned_at,?)
          WHERE id = ? AND NOT EXISTS (SELECT 1 FROM content c WHERE c.current_pdf_id = pdf_companion.id)`,
      ).bind(timestamp, pdfId),
    ]);
    return (results[0]?.meta.changes ?? 0) === 1;
  }

  async stateForContent(contentId: string): Promise<PdfCompanionState> {
    const row = await this.db.prepare(
      `SELECT c.active_version_id,c.current_pdf_id,c.pdf_approved_html_version_id,
              p.safe_filename,p.total_bytes,p.ready_at,p.status
         FROM content c LEFT JOIN pdf_companion p ON p.id = c.current_pdf_id
        WHERE c.id = ?`,
    ).bind(contentId).first<Row>();
    if (!row || !row.current_pdf_id || row.status !== "ready") return { state: "none" };
    return {
      state: row.active_version_id === row.pdf_approved_html_version_id ? "current" : "outdated",
      id: String(row.current_pdf_id),
      fileName: String(row.safe_filename),
      size: Number(row.total_bytes),
      uploadedAt: row.ready_at === null ? undefined : String(row.ready_at),
      approvedVersionId: row.pdf_approved_html_version_id === null ? null : String(row.pdf_approved_html_version_id),
    };
  }

  async resolvePublic(linkId: string, now = new Date()): Promise<PublicPdf | null> {
    const row = await this.db.prepare(
      `SELECT sl.id AS link_id,sl.expires_at,sl.revoked_at,c.active_version_id,c.pdf_approved_html_version_id,
              p.id AS pdf_id,p.safe_filename,p.total_bytes,p.chunk_count,p.sha256
         FROM share_link sl
         JOIN content c ON c.id = sl.content_id
         JOIN content_version cv ON cv.id = c.active_version_id AND cv.status = 'ready'
         JOIN pdf_companion p ON p.id = c.current_pdf_id AND p.content_id = c.id AND p.status = 'ready'
        WHERE sl.id = ? AND c.active_version_id = c.pdf_approved_html_version_id`,
    ).bind(linkId).first<Row>();
    if (!row || row.revoked_at !== null || !row.sha256) return null;
    if (row.expires_at !== null && Date.parse(String(row.expires_at)) <= now.getTime()) return null;
    const pdfId = String(row.pdf_id);
    const size = Number(row.total_bytes);
    const chunkCount = Number(row.chunk_count);
    const metadata = await this.db.prepare(
      "SELECT chunk_index,length(bytes) AS byte_length,sha256 FROM pdf_companion_chunk WHERE pdf_id = ? ORDER BY chunk_index",
    ).bind(pdfId).all<{ chunk_index: number; byte_length: number; sha256: string }>();
    if (
      metadata.results.length !== chunkCount ||
      metadata.results.reduce((sum, item) => sum + Number(item.byte_length), 0) !== size ||
      metadata.results.some((item, index) => Number(item.chunk_index) !== index)
    ) return null;
    const db = this.db;
    let next = 0;
    return {
      linkId: String(row.link_id),
      pdfId,
      fileName: String(row.safe_filename),
      size,
      sha256: String(row.sha256),
      body: new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (next >= metadata.results.length) return controller.close();
          try {
            const chunk = await db.prepare("SELECT bytes FROM pdf_companion_chunk WHERE pdf_id = ? AND chunk_index = ?")
              .bind(pdfId, next).first<ChunkRow>();
            if (!chunk) throw new Error("PDF chunk is missing");
            const bytes = bytesFromD1(chunk.bytes);
            if (bytes.byteLength !== Number(metadata.results[next]?.byte_length)) throw new Error("PDF chunk is corrupt");
            if (await sha256Hex(bytes) !== metadata.results[next]?.sha256) throw new Error("PDF chunk is corrupt");
            next += 1;
            controller.enqueue(bytes);
          } catch (error) {
            controller.error(error);
          }
        },
      }),
    };
  }

  async cleanup(now = new Date(), batchSize = PDF_CLEANUP_BATCH_SIZE): Promise<number> {
    const limit = Math.max(1, Math.min(PDF_CLEANUP_BATCH_SIZE, Math.trunc(batchSize)));
    const timestamp = now.toISOString();
    const orphanBefore = new Date(now.getTime() - ORPHAN_GRACE_MS).toISOString();
    await this.db
      .prepare("UPDATE pdf_upload_session SET state = 'expired' WHERE state IN ('open','uploaded') AND expires_at <= ?")
      .bind(timestamp)
      .run();
    await this.db
      .prepare(
        `UPDATE pdf_companion SET orphaned_at = COALESCE(orphaned_at,?)
          WHERE orphaned_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM content c WHERE c.current_pdf_id = pdf_companion.id)
            AND EXISTS (
              SELECT 1 FROM pdf_upload_session u
               WHERE u.pdf_id = pdf_companion.id AND u.state IN ('expired','failed')
            )`,
      )
      .bind(timestamp)
      .run();
    const candidates = await this.db
      .prepare(
        `SELECT p.id
           FROM pdf_companion p
          WHERE p.orphaned_at < ?
            AND NOT EXISTS (SELECT 1 FROM content c WHERE c.current_pdf_id = p.id)
            AND NOT EXISTS (
              SELECT 1 FROM pdf_upload_session u
               WHERE u.pdf_id = p.id AND u.state IN ('open','uploaded')
            )
          ORDER BY p.orphaned_at,p.id
          LIMIT ?`,
      )
      .bind(orphanBefore, limit)
      .all<{ id: string }>();
    if (candidates.results.length === 0) return 0;
    const results = await this.db.batch(
      candidates.results.map((row) =>
        this.db
          .prepare(
            `DELETE FROM pdf_companion
              WHERE id = ?
                AND orphaned_at < ?
                AND NOT EXISTS (SELECT 1 FROM content c WHERE c.current_pdf_id = pdf_companion.id)
                AND NOT EXISTS (
                  SELECT 1 FROM pdf_upload_session u
                   WHERE u.pdf_id = pdf_companion.id AND u.state IN ('open','uploaded')
                )`,
          )
          .bind(String(row.id), orphanBefore),
      ),
    );
    return results.reduce((total, result) => total + Number(result.meta.changes ?? 0), 0);
  }

  private async getUpload(uploadId: string): Promise<UploadRecord | null> {
    const row = await this.db.prepare(
      `SELECT u.id,u.content_id,u.pdf_id,u.state,u.expires_at,u.expected_active_version_id,u.expected_current_pdf_id,
              c.active_version_id,c.current_pdf_id,p.total_bytes,p.status
         FROM pdf_upload_session u JOIN content c ON c.id = u.content_id JOIN pdf_companion p ON p.id = u.pdf_id
        WHERE u.id = ?`,
    ).bind(uploadId).first<Row>();
    if (!row) return null;
    return {
      id: String(row.id), contentId: String(row.content_id), pdfId: String(row.pdf_id), state: String(row.state) as UploadRecord["state"],
      expiresAt: String(row.expires_at), expectedActiveVersionId: String(row.expected_active_version_id),
      expectedCurrentPdfId: row.expected_current_pdf_id === null ? null : String(row.expected_current_pdf_id),
      activeVersionId: row.active_version_id === null ? null : String(row.active_version_id),
      currentPdfId: row.current_pdf_id === null ? null : String(row.current_pdf_id), totalBytes: Number(row.total_bytes),
      status: String(row.status) as UploadRecord["status"],
    };
  }

  private async markFailedIfOrphan(upload: UploadRecord, now: Date): Promise<void> {
    const timestamp = now.toISOString();
    await this.db.batch([
      this.db.prepare(
        `UPDATE pdf_companion
            SET status = CASE WHEN status = 'staging' THEN 'failed' ELSE status END,
                orphaned_at = COALESCE(orphaned_at,?)
          WHERE id = ? AND NOT EXISTS (SELECT 1 FROM content c WHERE c.current_pdf_id = pdf_companion.id)`,
      ).bind(timestamp, upload.pdfId),
      this.db.prepare("UPDATE pdf_upload_session SET state = 'failed' WHERE id = ? AND state != 'committed'").bind(upload.id),
    ]);
  }
}

export function safePdfFileName(value: string): string {
  if (typeof value !== "string" || !value.toLowerCase().endsWith(".pdf") || value.includes("/") || value.includes("\\")) {
    throw new Error("Choose a .pdf file");
  }
  const normalized = value.normalize("NFC").replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  const stem = normalized.slice(0, -4).replace(/[^\p{L}\p{N}._ -]+/gu, "_").replace(/^[. ]+|[. ]+$/gu, "");
  if (!stem) throw new Error("PDF filename is invalid");
  return `${stem.slice(0, 160)}.pdf`;
}

async function readExactly(body: ReadableStream<Uint8Array>, expectedBytes: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(expectedBytes);
  const reader = body.getReader();
  let offset = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > expectedBytes) throw new Error(`Expected ${expectedBytes} PDF bytes`);
      bytes.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== expectedBytes) throw new Error(`Expected ${expectedBytes} PDF bytes`);
  return bytes;
}

function hasPdfSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

function bytesFromD1(value: ChunkRow["bytes"]): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  return Uint8Array.from(value);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
