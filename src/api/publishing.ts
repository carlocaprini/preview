import { apiError, json } from "../http.ts";
import { normalizeAssetPath } from "../security/paths.ts";
import type { PreviewEnv } from "../types.ts";
import { D1PublishingRepository } from "../data/repository.ts";
import { PublishingService } from "../services/publishing.ts";
import type { ManifestFileInput, SourceFormat } from "../domain/manifest.ts";
import { readJson } from "./body.ts";

interface VersionBody {
  sourceFormat: SourceFormat;
  files: ManifestFileInput[];
}

function service(env: PreviewEnv): PublishingService {
  return new PublishingService(new D1PublishingRepository(env.DB), env.CONTENT, env.APP_ORIGIN, env.SHARE_SIGNING_KEY);
}

function message(error: unknown): string {
  const value = error instanceof Error ? error.message : "";
  const safeMessages = [
    /^(A |At least|Asset |Content |Duplicate |Expected |Invalid |Label |Link |Media |Missing |Package |Stored |Title |Unsupported |Upload )/u,
    /^A newer version was activated/u,
  ];
  return safeMessages.some((pattern) => pattern.test(value)) ? value : "Request could not be completed";
}

export async function routePublishingApi(request: Request, env: PreviewEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const publishing = service(env);

  if (request.method === "POST" && url.pathname === "/api/admin/contents") {
    try {
      const body = await readJson<VersionBody & { title: string }>(request);
      return json(await publishing.createContent(body), 201);
    } catch (error) {
      return apiError("invalid_upload", message(error), 400);
    }
  }

  const versionMatch = url.pathname.match(/^\/api\/admin\/contents\/([^/]+)\/versions$/u);
  if (request.method === "POST" && versionMatch?.[1]) {
    try {
      const body = await readJson<VersionBody>(request);
      return json(await publishing.startVersion(versionMatch[1], body.sourceFormat, body.files), 201);
    } catch (error) {
      return apiError("invalid_upload", message(error), 400);
    }
  }

  const fileMatch = url.pathname.match(/^\/api\/admin\/uploads\/([^/]+)\/files\/(.+)$/u);
  if (request.method === "PUT" && fileMatch?.[1] && fileMatch[2]) {
    try {
      const path = normalizeAssetPath(fileMatch[2]);
      await publishing.uploadAsset(fileMatch[1], path, request);
      return new Response(null, { status: 204 });
    } catch (error) {
      return apiError("asset_rejected", message(error), 400);
    }
  }

  const commitMatch = url.pathname.match(/^\/api\/admin\/uploads\/([^/]+)\/commit$/u);
  if (request.method === "POST" && commitMatch?.[1]) {
    try {
      return json(await publishing.commit(commitMatch[1]));
    } catch (error) {
      const detail = message(error);
      return apiError(detail.includes("newer version") ? "stale_upload" : "commit_failed", detail, 409);
    }
  }

  const linkMatch = url.pathname.match(/^\/api\/admin\/contents\/([^/]+)\/links$/u);
  if (request.method === "POST" && linkMatch?.[1]) {
    try {
      const body = await readJson<{ label: string; validForSeconds: number | null }>(request);
      return json(
        await publishing.createShareLink({
          contentId: linkMatch[1],
          label: body.label,
          validForSeconds: body.validForSeconds ?? null,
        }),
        201,
      );
    } catch (error) {
      return apiError("invalid_link", message(error), 400);
    }
  }

  return null;
}
