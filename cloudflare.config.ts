import { bindings, defineConfig } from "cf/config";

export default defineConfig(({ mode }) => ({
  worker: {
    name: mode === "staging" ? "preview-staging" : "preview",
    entrypoint: "./src/index.ts",
    compatibilityDate: "2026-10-26",
    compatibilityFlags: ["nodejs_compat"],
    env: {
      DB: bindings.d1({ name: mode === "staging" ? "preview-staging" : "preview" }),
      CONTENT: bindings.r2({ name: mode === "staging" ? "preview-content-staging" : "preview-content" }),
      OWNER_EMAIL: bindings.secret(),
      MCP_ACCESS_CLIENT_ID: bindings.secret(),
      SHARE_SIGNING_KEY: bindings.secret(),
      APP_ORIGIN: bindings.text(
        mode === "staging"
          ? "https://staging.preview.carlocaprini.com"
          : "https://preview.carlocaprini.com",
      ),
      CONTENT_ORIGIN: bindings.text(
        mode === "staging"
          ? "https://content.staging.preview.carlocaprini.com"
          : "https://content.preview.carlocaprini.com",
      ),
      ENVIRONMENT: bindings.text(mode === "staging" ? "staging" : "production"),
    },
    domains:
      mode === "staging"
        ? ["staging.preview.carlocaprini.com", "content.staging.preview.carlocaprini.com"]
        : ["preview.carlocaprini.com", "content.preview.carlocaprini.com"],
    workersDev: false,
    previewUrls: false,
    observability: {
      enabled: true,
      redactQueryString: true,
      logs: { enabled: true, invocationLogs: true },
      traces: { enabled: true },
    },
  },
}));
