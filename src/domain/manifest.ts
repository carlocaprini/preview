import { MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_BYTES } from "./limits.ts";
import { normalizeAssetPath } from "../security/paths.ts";

export type SourceFormat = "html" | "zip";

export interface ManifestFileInput {
  path: string;
  size: number;
  mediaType?: string;
}

export interface ManifestFile {
  path: string;
  size: number;
  mediaType: string;
}

export interface VersionManifest {
  files: ManifestFile[];
  totalBytes: number;
}

const MEDIA_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  gif: "image/gif",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  xml: "application/xml; charset=utf-8",
};

export function mediaTypeForPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const mediaType = MEDIA_TYPES[extension];
  if (!mediaType) throw new Error(`Unsupported file type: ${path}`);
  return mediaType;
}

export function validateManifest(input: ManifestFileInput[]): VersionManifest {
  if (!Array.isArray(input) || input.length === 0) throw new Error("At least one file is required");
  if (input.length > MAX_FILES) throw new Error(`A package can contain at most ${MAX_FILES} files`);

  const paths = new Set<string>();
  let totalBytes = 0;
  const files = input.map((candidate) => {
    const path = normalizeAssetPath(candidate.path);
    const collisionKey = path.normalize("NFC").toLowerCase();
    if (paths.has(collisionKey)) throw new Error(`Duplicate asset path: ${path}`);
    paths.add(collisionKey);

    if (!Number.isSafeInteger(candidate.size) || candidate.size < 0 || candidate.size > MAX_FILE_BYTES) {
      throw new Error(`Invalid size for ${path}`);
    }

    const mediaType = mediaTypeForPath(path);
    if (candidate.mediaType && candidate.mediaType.toLowerCase() !== mediaType.toLowerCase()) {
      throw new Error(`Media type does not match ${path}`);
    }

    totalBytes += candidate.size;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Package exceeds the 20 MiB expanded limit");
    return { path, size: candidate.size, mediaType };
  });

  if (!files.some((file) => file.path === "index.html")) throw new Error("A root index.html file is required");
  return { files, totalBytes };
}
