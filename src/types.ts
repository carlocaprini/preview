export interface PreviewEnv {
  DB: D1Database;
  OWNER_PASSWORD: string;
  MCP_BEARER_TOKEN: string;
  SHARE_SIGNING_KEY: string;
  APP_ORIGIN: string;
  CONTENT_ORIGIN: string;
  ENVIRONMENT: "production" | "staging" | "test";
}

export type PreviewExecutionContext = ExecutionContext;

export type HostKind = "app" | "content" | "unknown";
