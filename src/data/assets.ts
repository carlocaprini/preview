const CHUNK_BYTES = 512 * 1024;

export interface StoredAssetHead {
  size: number;
  etag: string;
}

export interface StoredAsset extends StoredAssetHead {
  body: ReadableStream<Uint8Array>;
}

export interface AssetStore {
  put(input: {
    versionId: string;
    path: string;
    body: ReadableStream<Uint8Array> | ArrayBuffer;
    expectedBytes: number;
    now: Date;
  }): Promise<{ etag: string }>;
  listHeads(versionId: string): Promise<Map<string, StoredAssetHead>>;
  get(versionId: string, path: string): Promise<StoredAsset | null>;
}

type PayloadRow = { total_bytes: number; chunk_count: number; etag: string };
type ChunkRow = { bytes: number[] | ArrayBuffer | ArrayBufferView };
type ChunkMetaRow = { chunk_index: number; byte_length: number };

export class D1AssetStore implements AssetStore {
  constructor(private readonly db: D1Database) {}

  async put(input: {
    versionId: string;
    path: string;
    body: ReadableStream<Uint8Array> | ArrayBuffer;
    expectedBytes: number;
    now: Date;
  }): Promise<{ etag: string }> {
    const bytes = await readExactly(input.body, input.expectedBytes);
    const etag = `"sha256-${await sha256Hex(bytes)}"`;
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
      chunks.push(bytes.slice(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength)));
    }

    const statements = [
      this.db.prepare("DELETE FROM asset_payload WHERE version_id = ? AND path = ?").bind(input.versionId, input.path),
      this.db
        .prepare(
          "INSERT INTO asset_payload (version_id,path,total_bytes,chunk_count,etag,created_at) VALUES (?,?,?,?,?,?)",
        )
        .bind(input.versionId, input.path, bytes.byteLength, chunks.length, etag, input.now.toISOString()),
      ...chunks.map((chunk, index) =>
        this.db
          .prepare("INSERT INTO asset_chunk (version_id,path,chunk_index,bytes) VALUES (?,?,?,?)")
          .bind(input.versionId, input.path, index, chunk),
      ),
    ];
    await this.db.batch(statements);
    return { etag };
  }

  async listHeads(versionId: string): Promise<Map<string, StoredAssetHead>> {
    const result = await this.db
      .prepare("SELECT path,total_bytes,etag FROM asset_payload WHERE version_id = ?")
      .bind(versionId)
      .all<{ path: string; total_bytes: number; etag: string }>();
    return new Map(
      result.results.map((row) => [
        String(row.path),
        { size: Number(row.total_bytes), etag: String(row.etag) },
      ]),
    );
  }

  async get(versionId: string, path: string): Promise<StoredAsset | null> {
    const payload = await this.db
      .prepare("SELECT total_bytes,chunk_count,etag FROM asset_payload WHERE version_id = ? AND path = ?")
      .bind(versionId, path)
      .first<PayloadRow>();
    if (!payload) return null;

    const result = await this.db
      .prepare(
        "SELECT chunk_index,length(bytes) AS byte_length FROM asset_chunk WHERE version_id = ? AND path = ? ORDER BY chunk_index",
      )
      .bind(versionId, path)
      .all<ChunkMetaRow>();
    const metadata = result.results;
    const size = metadata.reduce((total, chunk) => total + Number(chunk.byte_length), 0);
    if (
      metadata.length !== Number(payload.chunk_count) ||
      size !== Number(payload.total_bytes) ||
      metadata.some((chunk, index) => Number(chunk.chunk_index) !== index)
    ) {
      return null;
    }

    const db = this.db;
    let nextChunk = 0;

    return {
      size,
      etag: String(payload.etag),
      body: new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (nextChunk >= metadata.length) {
            controller.close();
            return;
          }
          try {
            const row = await db
              .prepare("SELECT bytes FROM asset_chunk WHERE version_id = ? AND path = ? AND chunk_index = ?")
              .bind(versionId, path, nextChunk)
              .first<ChunkRow>();
            if (!row) throw new Error("Stored asset chunk is missing");
            const chunk = bytesFromD1(row.bytes);
            if (chunk.byteLength !== Number(metadata[nextChunk]?.byte_length)) {
              throw new Error("Stored asset chunk has an invalid size");
            }
            nextChunk += 1;
            controller.enqueue(chunk);
          } catch (error) {
            controller.error(error);
          }
        },
      }),
    };
  }
}

async function readExactly(
  body: ReadableStream<Uint8Array> | ArrayBuffer,
  expectedBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) throw new Error("Invalid expected byte count");
  if (body instanceof ArrayBuffer) {
    if (body.byteLength !== expectedBytes) throw new Error(`Expected ${expectedBytes} bytes`);
    return new Uint8Array(body);
  }

  const bytes = new Uint8Array(expectedBytes);
  const reader = body.getReader();
  let offset = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > expectedBytes) throw new Error(`Expected ${expectedBytes} bytes`);
      bytes.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== expectedBytes) throw new Error(`Expected ${expectedBytes} bytes`);
  return bytes;
}

function bytesFromD1(value: ChunkRow["bytes"]): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  return Uint8Array.from(value);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = bytes.slice().buffer as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
