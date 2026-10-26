export interface PreviewEnv {
  DB: D1Database;
  CONTENT: R2Bucket;
  OWNER_EMAIL: string;
  MCP_ACCESS_CLIENT_ID: string;
  SHARE_SIGNING_KEY: string;
  APP_ORIGIN: string;
  CONTENT_ORIGIN: string;
  ENVIRONMENT: "production" | "staging" | "test";
}

export type PreviewExecutionContext = ExecutionContext;

export type HostKind = "app" | "content" | "unknown";
