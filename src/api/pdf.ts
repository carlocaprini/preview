import { readJson } from "./body.ts";
import { apiError, json } from "../http.ts";
import { D1PdfRepository } from "../data/pdf.ts";
import { D1AnalyticsRepository } from "../data/analytics.ts";
import { parseShareToken } from "../domain/links.ts";
import { authenticateOwner } from "../security/auth.ts";
import type { PreviewEnv, PreviewExecutionContext } from "../types.ts";

export async function routePdfAdminApi(request: Request, env: PreviewEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const repository = new D1PdfRepository(env.DB);
  const start = url.pathname.match(/^\/api\/admin\/contents\/([^/]+)\/pdf\/uploads$/u);
  if (request.method === "POST" && start?.[1]) {
    try {
      const body = await readJson<{ fileName: string; size: number; expectedActiveVersionId: string }>(request);
      return json(await repository.startUpload({
        contentId: start[1],
        fileName: body.fileName,
        size: Number(body.size),
        expectedActiveVersionId: body.expectedActiveVersionId,
        now: new Date(),
        appOrigin: env.APP_ORIGIN,
      }), 201);
    } catch (error) {
      return apiError("invalid_pdf_upload", safeMessage(error), 400);
    }
  }

  const data = url.pathname.match(/^\/api\/admin\/pdf\/uploads\/([^/]+)\/data$/u);
  if (request.method === "PUT" && data?.[1]) {
    try {
      await repository.uploadData(data[1], request.body);
      return new Response(null, { status: 204 });
    } catch (error) {
      return apiError("pdf_rejected", safeMessage(error), 400);
    }
  }

  const commit = url.pathname.match(/^\/api\/admin\/pdf\/uploads\/([^/]+)\/commit$/u);
  if (request.method === "POST" && commit?.[1]) {
    try {
      return json({ pdfCompanion: await repository.commit(commit[1]) });
    } catch (error) {
      return apiError("pdf_commit_conflict", safeMessage(error), 409);
    }
  }

  const confirm = url.pathname.match(/^\/api\/admin\/contents\/([^/]+)\/pdf\/confirm$/u);
  if (request.method === "POST" && confirm?.[1]) {
    try {
      const body = await readJson<{ pdfId: string; expectedActiveVersionId: string }>(request);
      return json({ pdfCompanion: await repository.confirmReuse(confirm[1], body.pdfId, body.expectedActiveVersionId) });
    } catch (error) {
      return apiError("pdf_confirmation_conflict", safeMessage(error), 409);
    }
  }

  const remove = url.pathname.match(/^\/api\/admin\/contents\/([^/]+)\/pdf$/u);
  if (request.method === "DELETE" && remove?.[1]) {
    const removed = await repository.remove(remove[1]);
    return removed ? json({ pdfCompanion: { state: "none" } }) : apiError("not_found", "PDF companion not found", 404);
  }
  return null;
}

export async function publicPdfResponse(
  request: Request,
  env: PreviewEnv,
  ctx: PreviewExecutionContext,
  token: string,
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const linkId = await parseShareToken(token, env.SHARE_SIGNING_KEY);
  if (!linkId) return null;
  const repository = new D1PdfRepository(env.DB);
  const pdf = await repository.resolvePublic(linkId);
  if (!pdf) return null;

  const headers = new Headers({
    "Content-Type": "application/pdf",
    "Content-Disposition": contentDisposition(pdf.fileName),
    "Content-Length": String(pdf.size),
    "Cache-Control": "no-store, private",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "ETag": `"sha256-${pdf.sha256}"`,
  });
  if (request.method === "HEAD") return new Response(null, { headers });

  const { stream, completed } = completionStream(pdf.body);
  const owner = await authenticateOwner(request, env);
  if (!owner.authorized) {
    ctx.waitUntil(
      completed.then(async (served) => {
        if (served) await new D1AnalyticsRepository(env.DB).recordPdfDownload(pdf.linkId);
      }).catch(() => undefined),
    );
  }
  return new Response(stream, { headers });
}

function completionStream(source: ReadableStream<Uint8Array>): { stream: ReadableStream<Uint8Array>; completed: Promise<boolean> } {
  const reader = source.getReader();
  let settle: (completed: boolean) => void = () => undefined;
  let settled = false;
  const completed = new Promise<boolean>((resolve) => { settle = resolve; });
  const finish = (value: boolean) => {
    if (!settled) {
      settled = true;
      settle(value);
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await reader.read();
        if (item.done) {
          finish(true);
          controller.close();
        } else {
          controller.enqueue(item.value);
        }
      } catch (error) {
        finish(false);
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish(false);
      await reader.cancel(reason);
    },
  });
  return { stream, completed };
}

function contentDisposition(fileName: string): string {
  const fallback = fileName.normalize("NFKD").replace(/[^A-Za-z0-9._ -]+/gu, "_").replaceAll('"', "_") || "companion.pdf";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "PDF request could not be completed";
  return /^(PDF|File|Choose|Content|Active)/u.test(message) ? message : "PDF request could not be completed";
}
