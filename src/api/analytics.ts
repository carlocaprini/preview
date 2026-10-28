import { readJson } from "./body.ts";
import { apiError, json } from "../http.ts";
import { D1AnalyticsRepository, type MeasurementKind } from "../data/analytics.ts";
import { D1ViewerRepository } from "../data/viewer.ts";
import { D1AssetStore } from "../data/assets.ts";
import { ViewerService } from "../services/viewer.ts";
import { authenticateOwner } from "../security/auth.ts";
import type { PreviewEnv } from "../types.ts";

interface MeasurementBody {
  token: string;
  snapshotId: string;
  receiptId: string;
  kind: MeasurementKind;
  visibleMs?: number;
}

export async function routeAnalyticsApi(request: Request, env: PreviewEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/api/public/measure") return null;

  try {
    const body = await readJson<MeasurementBody>(request);
    if (!/^[A-Za-z0-9_-]{16,80}$/u.test(body.receiptId)) throw new Error("Invalid receipt");
    if (body.kind !== "view" && body.kind !== "visible") throw new Error("Invalid measurement");
    const visibleMs = body.kind === "visible" ? Number(body.visibleMs) : 0;
    if (!Number.isSafeInteger(visibleMs) || visibleMs < 0 || visibleMs > 30_000) throw new Error("Invalid duration");

    const viewer = new ViewerService(new D1ViewerRepository(env.DB), new D1AssetStore(env.DB), env.SHARE_SIGNING_KEY);
    const asset = await viewer.resolveSharedAsset(body.token, body.snapshotId, "index.html");
    if (!asset?.linkId) return apiError("link_unavailable", "Preview unavailable", 404);
    const owner = await authenticateOwner(request, env);
    if (owner.authorized) return json({ recorded: false });
    const recorded = await new D1AnalyticsRepository(env.DB).record({
      receiptId: body.receiptId,
      linkId: asset.linkId,
      kind: body.kind,
      visibleMs,
      now: new Date(),
    });
    return json({ recorded });
  } catch {
    return apiError("invalid_measurement", "Invalid measurement", 400);
  }
}
