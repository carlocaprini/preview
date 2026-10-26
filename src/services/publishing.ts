import { assetKey } from "../security/paths.ts";
import { createShareToken, resolveExpiry } from "../domain/links.ts";
import { validateManifest, type ManifestFileInput, type SourceFormat } from "../domain/manifest.ts";
import type { PublishingRepository, StartVersionResult } from "../data/repository.ts";

export interface ObjectStore {
  put(key: string, body: ReadableStream | ArrayBuffer, options: { httpMetadata: { contentType: string } }): Promise<{ etag: string } | null>;
  head(key: string): Promise<{ size: number; etag: string } | null>;
}

export interface TransferPlan extends StartVersionResult {
  contentId: string;
  files: Array<{ path: string; size: number; mediaType: string; uploadUrl: string }>;
  commitUrl: string;
}

export class PublishingService {
  constructor(
    private readonly repository: PublishingRepository,
    private readonly objects: ObjectStore,
    private readonly appOrigin: string,
    private readonly signingKey: string,
  ) {}

  async createContent(input: {
    title: string;
    sourceFormat: SourceFormat;
    files: ManifestFileInput[];
  }): Promise<TransferPlan> {
    const title = input.title.trim();
    if (title.length < 1 || title.length > 160) throw new Error("Title must be between 1 and 160 characters");
    const now = new Date();
    const content = await this.repository.createContent(title, now);
    try {
      return await this.startVersion(content.id, input.sourceFormat, input.files, now);
    } catch (error) {
      await this.repository.deleteContentIfEmpty(content.id);
      throw error;
    }
  }

  async startVersion(
    contentId: string,
    sourceFormat: SourceFormat,
    files: ManifestFileInput[],
    now = new Date(),
  ): Promise<TransferPlan> {
    const manifest = validateManifest(files);
    const started = await this.repository.startVersion(contentId, sourceFormat, manifest, now);
    const base = `${this.appOrigin}/api/admin/uploads/${started.uploadId}`;
    return {
      ...started,
      contentId,
      files: manifest.files.map((file) => ({
        ...file,
        uploadUrl: `${base}/files/${file.path.split("/").map(encodeURIComponent).join("/")}`,
      })),
      commitUrl: `${base}/commit`,
    };
  }

  async uploadAsset(uploadId: string, path: string, request: Request, now = new Date()): Promise<void> {
    const upload = await this.repository.getUpload(uploadId);
    if (!upload || upload.state !== "open") throw new Error("Upload session is not open");
    if (Date.parse(upload.expiresAt) <= now.getTime()) {
      await this.repository.markUploadExpired(uploadId);
      throw new Error("Upload session has expired");
    }

    const asset = await this.repository.getAsset(upload.versionId, path);
    if (!asset) throw new Error("Asset is not declared in the manifest");
    const contentLength = Number(request.headers.get("content-length"));
    if (!Number.isSafeInteger(contentLength) || contentLength !== asset.expectedBytes) {
      throw new Error(`Expected ${asset.expectedBytes} bytes for ${path}`);
    }
    if (!request.body) throw new Error("Asset body is required");

    const result = await this.objects.put(assetKey(upload.contentId, upload.versionId, path), request.body, {
      httpMetadata: { contentType: asset.mediaType },
    });
    if (!result) throw new Error("Asset storage failed");
    await this.repository.markAssetUploaded(upload.versionId, path, contentLength, result.etag, now);
  }

  async commit(uploadId: string, now = new Date()): Promise<{ versionId: string; status: "activated" | "already_active" }> {
    const upload = await this.repository.getUpload(uploadId);
    if (!upload) throw new Error("Upload session not found");
    if (upload.state === "committed" || upload.activeVersionId === upload.versionId) {
      await this.repository.activateUpload(upload, now);
      return { versionId: upload.versionId, status: "already_active" };
    }
    if (upload.state !== "open") throw new Error("Upload session cannot be committed");
    if (Date.parse(upload.expiresAt) <= now.getTime()) {
      await this.repository.markUploadExpired(uploadId);
      throw new Error("Upload session has expired");
    }

    const assets = await this.repository.listAssets(upload.versionId);
    for (const asset of assets) {
      if (asset.uploadedBytes !== asset.expectedBytes || !asset.etag) throw new Error(`Missing asset: ${asset.path}`);
      const stored = await this.objects.head(assetKey(upload.contentId, upload.versionId, asset.path));
      if (!stored || stored.size !== asset.expectedBytes || stored.etag !== asset.etag) {
        throw new Error(`Stored asset does not match manifest: ${asset.path}`);
      }
    }

    const outcome = await this.repository.activateUpload(upload, now);
    if (outcome === "stale") throw new Error("A newer version was activated while this upload was in progress");
    return { versionId: upload.versionId, status: outcome };
  }

  async createShareLink(input: {
    contentId: string;
    label: string;
    validForSeconds: number | null;
  }): Promise<{ linkId: string; url: string; expiresAt: string | null }> {
    const content = await this.repository.getContent(input.contentId);
    if (!content?.activeVersionId) throw new Error("Content has no active version");
    const label = input.label.trim();
    if (label.length < 1 || label.length > 120) throw new Error("Label must be between 1 and 120 characters");
    const now = new Date();
    const { id, token } = await createShareToken(this.signingKey);
    const expiresAt = resolveExpiry(now, input.validForSeconds);
    await this.repository.createShareLink({ id, contentId: input.contentId, label, createdAt: now.toISOString(), expiresAt });
    return { linkId: id, url: `${this.appOrigin}/s/${token}`, expiresAt };
  }
}
