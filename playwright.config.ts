import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 43917);

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "npm run test:e2e:server",
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
