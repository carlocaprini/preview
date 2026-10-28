import { parseShareToken } from "../domain/links.ts";
import { normalizeAssetPath } from "../security/paths.ts";
import { D1ViewerRepository, type LinkState, type ResolvedAsset } from "../data/viewer.ts";
import type { AssetStore } from "../data/assets.ts";

export interface SharedView {
  state: LinkState | "invalid";
  token: string;
  snapshotId?: string;
  hasPdf?: boolean;
}

export interface AssetResponse {
  linkId?: string;
  body: ReadableStream;
  mediaType: string;
  size: number;
  etag?: string;
}

export class ViewerService {
  constructor(
    private readonly repository: D1ViewerRepository,
    private readonly assets: AssetStore,
    private readonly signingKey: string,
  ) {}

  async resolveSharedView(token: string, now = new Date()): Promise<SharedView> {
    const linkId = await parseShareToken(token, this.signingKey);
    if (!linkId) return { state: "invalid", token };
    const resolved = await this.repository.resolveShare(linkId, now);
    if (!resolved) return { state: "invalid", token };
    return { state: resolved.state, token, snapshotId: resolved.snapshotId, hasPdf: resolved.hasPdf };
  }

  async getSharedAsset(token: string, snapshotId: string, rawPath: string, now = new Date()): Promise<AssetResponse | null> {
    const linkId = await parseShareToken(token, this.signingKey);
    if (!linkId) return null;
    const path = normalizeAssetPath(rawPath);
    const asset = await this.repository.resolveSharedAsset(linkId, snapshotId, path, now);
    return asset ? this.readAsset(asset) : null;
  }

  async resolveSharedAsset(token: string, snapshotId: string, rawPath: string, now = new Date()): Promise<ResolvedAsset | null> {
    const linkId = await parseShareToken(token, this.signingKey);
    if (!linkId) return null;
    return this.repository.resolveSharedAsset(linkId, snapshotId, normalizeAssetPath(rawPath), now);
  }

  async getOwnerPreview(contentId: string) {
    return this.repository.resolveOwnerPreview(contentId);
  }

  async getOwnerAsset(contentId: string, snapshotId: string, rawPath: string): Promise<AssetResponse | null> {
    const path = normalizeAssetPath(rawPath);
    const asset = await this.repository.resolveOwnerAsset(contentId, snapshotId, path);
    return asset ? this.readAsset(asset) : null;
  }

  private async readAsset(asset: ResolvedAsset): Promise<AssetResponse | null> {
    const object = await this.assets.get(asset.versionId, asset.path);
    if (!object || object.size !== asset.bytes) return null;
    return { body: object.body, mediaType: asset.mediaType, size: object.size, etag: object.etag, linkId: asset.linkId };
  }
}
