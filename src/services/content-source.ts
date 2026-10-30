import { D1AssetStore, type StoredAsset } from "../data/assets.ts";
import { D1ContentSourceRepository, type CurrentContentFile } from "../data/content-source.ts";
import { normalizeAssetPath } from "../security/paths.ts";

const MAX_INLINE_TEXT_BYTES = 64 * 1024;

function isText(mediaType: string): boolean {
  const normalized = mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return normalized.startsWith("text/") ||
    ["application/json", "application/xml", "application/javascript", "image/svg+xml"].includes(normalized);
}

export class ContentSourceService {
  private readonly repository: D1ContentSourceRepository;
  private readonly assets: D1AssetStore;

  constructor(db: D1Database, private readonly appOrigin: string) {
    this.repository = new D1ContentSourceRepository(db);
    this.assets = new D1AssetStore(db);
  }

  async manifest(contentId: string) {
    const manifest = await this.repository.currentManifest(contentId);
    if (manifest === null) throw new Error("Content not found");
    if (manifest === "unpublished") throw new Error("Content has no active HTML version");
    return {
      ...manifest,
      files: manifest.files.map(({ etag: _etag, ...file }) => file),
      transfer: { method: "authenticated-sideband" as const, baseOrigin: this.appOrigin },
    };
  }

  async readText(contentId: string, expectedActiveVersionId: string, rawPath: string) {
    const path = normalizeAssetPath(rawPath);
    const record = await this.repository.currentFile(contentId, expectedActiveVersionId, path);
    if (!record) throw new Error("Current file is unavailable or active version changed");
    const download = this.downloadInstruction(contentId, expectedActiveVersionId, record);
    if (!isText(record.mediaType)) return { ...download, kind: "download" as const, reason: "binary" as const };
    if (record.size > MAX_INLINE_TEXT_BYTES) return { ...download, kind: "download" as const, reason: "too_large" as const };
    const stored = await this.readStored(expectedActiveVersionId, record);
    const bytes = new Uint8Array(await new Response(stored.body).arrayBuffer());
    if (bytes.byteLength !== record.size) throw new Error("Stored file size does not match its manifest");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("Stored text file is not valid UTF-8");
    }
    return { kind: "text" as const, path, mediaType: record.mediaType, size: record.size, text, sha256: record.sha256 };
  }

  async download(contentId: string, expectedActiveVersionId: string, rawPath: string) {
    const path = normalizeAssetPath(rawPath);
    const record = await this.repository.currentFile(contentId, expectedActiveVersionId, path);
    if (!record) return null;
    return { record, stored: await this.readStored(expectedActiveVersionId, record) };
  }

  private downloadInstruction(contentId: string, versionId: string, file: CurrentContentFile) {
    return {
      path: file.path,
      mediaType: file.mediaType,
      size: file.size,
      sha256: file.sha256,
      downloadUrl: `${this.appOrigin}/api/mcp/contents/${encodeURIComponent(contentId)}/versions/${encodeURIComponent(versionId)}/files/${encodeURIComponent(file.path)}`,
    };
  }

  private async readStored(versionId: string, file: CurrentContentFile): Promise<StoredAsset> {
    const stored = await this.assets.get(versionId, file.path);
    if (!stored || stored.size !== file.size || stored.etag !== file.etag) {
      throw new Error("Stored file does not match its manifest");
    }
    return stored;
  }
}
