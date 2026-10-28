import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig(({ mode }) => ({
  worker: {
    name: mode === "staging" ? "preview-staging" : "preview",
    entrypoint: "./src/index.ts",
    compatibilityDate: "2026-10-27",
    compatibilityFlags: ["nodejs_compat"],
    env: {
      DB: bindings.d1({ name: mode === "staging" ? "preview-site-staging" : "preview-site" }),
      OWNER_PASSWORD: bindings.secret(),
      MCP_BEARER_TOKEN: bindings.secret(),
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
    triggers: [triggers.scheduled({ schedule: "17 * * * *" })],
    observability: {
      enabled: true,
      redactQueryString: true,
      logs: { enabled: true, invocationLogs: false },
      traces: { enabled: true },
    },
  },
}));
