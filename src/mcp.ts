import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { D1PublishingRepository } from "./data/repository.ts";
import { D1AssetStore } from "./data/assets.ts";
import { PublishingService } from "./services/publishing.ts";
import type { PreviewEnv, PreviewExecutionContext } from "./types.ts";

const sourceFormat = z.enum(["html", "zip"]);
const manifest = z.array(
  z.object({
    path: z.string().min(1).max(512),
    size: z.number().int().nonnegative(),
    mediaType: z.string().optional(),
  }),
);

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function createServer(env: PreviewEnv): McpServer {
  const server = new McpServer({ name: "preview", version: "1.0.0" });
  const publishing = new PublishingService(
    new D1PublishingRepository(env.DB),
    new D1AssetStore(env.DB),
    env.APP_ORIGIN,
    env.SHARE_SIGNING_KEY,
  );

  server.registerTool(
    "preview_create_content",
    {
      description: "Create private Preview content and return authenticated per-file transfer instructions.",
      inputSchema: z.object({ title: z.string(), sourceFormat, files: manifest }),
      annotations: { destructiveHint: false },
    },
    async ({ title, sourceFormat: format, files }) => result(await publishing.createContent({ title, sourceFormat: format, files })),
  );

  server.registerTool(
    "preview_upload_version",
    {
      description: "Stage a complete new version and return authenticated per-file transfer instructions.",
      inputSchema: z.object({ contentId: z.string().uuid(), sourceFormat, files: manifest }),
      annotations: { destructiveHint: false },
    },
    async ({ contentId, sourceFormat: format, files }) => result(await publishing.startVersion(contentId, format, files)),
  );

  server.registerTool(
    "preview_create_share_link",
    {
      description: "Create a labeled bearer link for the latest active version. The label identifies intent, not a verified reader.",
      inputSchema: z.object({
        contentId: z.string().uuid(),
        label: z.string().min(1).max(120),
        validForSeconds: z.number().int().nullable(),
      }),
      annotations: { destructiveHint: false },
    },
    async ({ contentId, label, validForSeconds }) =>
      result(await publishing.createShareLink({ contentId, label, validForSeconds })),
  );

  return server;
}

export function handleMcp(request: Request, env: PreviewEnv, ctx: PreviewExecutionContext): Promise<Response> {
  const appHost = new URL(env.APP_ORIGIN).hostname;
  const handler = createMcpHandler(() => createServer(env), {
    route: "/mcp",
    corsOptions: false,
    allowedHostnames: [appHost],
    allowedOriginHostnames: [appHost],
    responseMode: "json",
  });
  return handler(request, env, ctx);
}
