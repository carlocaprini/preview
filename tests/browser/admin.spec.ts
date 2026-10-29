import { expect, test, type Page } from "@playwright/test";
import { strToU8, zipSync } from "fflate";

const content = {
  id: "content-1",
  title: "Spatial product narrative",
  updatedAt: "2026-10-26T18:00:00.000Z",
  activeVersion: 3,
  sourceFormat: "zip",
  linkCount: 2,
  activeLinkCount: 1,
  meaningfulViews: 14,
  activeVisibleMs: 196_000,
};

const history = Array.from({ length: 30 }, (_, index) => ({
  day: new Date(Date.UTC(2026, 8, 27 + index)).toISOString().slice(0, 10),
  meaningfulViews: index === 0 ? 1 : index === 15 ? 7 : index === 29 ? 3 : 0,
  activeVisibleMs: index === 15 ? 42_000 : 0,
  pdfDownloadsServed: index === 29 ? 1 : 0,
}));

const detail = {
  ...content,
  createdAt: "2026-10-20T18:00:00.000Z",
  activeVersionId: "version-3",
  versions: [
    { id: "version-3", sequence: 3, status: "ready", sourceFormat: "zip", totalBytes: 481_234, createdAt: content.updatedAt, activatedAt: content.updatedAt },
  ],
  links: [
    { id: "link-1", label: "Client review", url: "https://preview.example/s/token", createdAt: content.updatedAt, expiresAt: "2026-11-02T18:00:00.000Z", revokedAt: null, state: "active", meaningfulViews: 14, activeVisibleMs: 196_000, lastViewAt: content.updatedAt, pdfDownloadsServed: 0, lastPdfDownloadAt: null },
    { id: "link-2", label: "Old review", url: "https://preview.example/s/old", createdAt: content.updatedAt, expiresAt: null, revokedAt: content.updatedAt, state: "revoked", meaningfulViews: 0, activeVisibleMs: 0, lastViewAt: null, pdfDownloadsServed: 0, lastPdfDownloadAt: null },
  ],
  aggregates: history,
  aggregateRange: { startDay: "2026-09-27", endDay: "2026-10-26", timezone: "UTC" },
  pdfCompanion: { state: "none" },
};

async function mockAdmin(page: Page) {
  await page.route("**/api/admin/contents", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { contents: [content] } });
    return route.fallback();
  });
  await page.route("**/api/admin/contents/content-1", (route) => route.fulfill({ json: detail }));
}

test("library presents private content and aggregate signals", async ({ page }, testInfo) => {
  await mockAdmin(page);
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Spatial product narrative/ })).toBeVisible();
  await expect(page.getByText("14")).toBeVisible();
  await expect(page.locator(".content-row")).toHaveCount(1);
  await expect(page.getByText("Owner workspace")).toHaveCount(0);
  await expect(page.locator("header.top").getByRole("button", { name: "Log out" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("library.png"), fullPage: true });
});

test("content detail exposes only the current update and reversible share controls", async ({ page }, testInfo) => {
  await mockAdmin(page);
  await page.goto("/admin/contents/content-1");
  await expect(page.getByRole("heading", { name: "Spatial product narrative" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Share links" })).toBeVisible();
  await expect(page.getByText("Client review")).toBeVisible();
  await expect(page.getByText(/ZIP · Updated/u)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Current HTML" })).toHaveCount(0);
  await expect(page.getByText("Version 3", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Version 2", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Update HTML" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit expiry" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Revoke" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Upload PDF" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Views over time" })).toBeVisible();
  await expect(page.getByText("Last 30 days · UTC")).toBeVisible();
  await expect(page.locator(".history-bar")).toHaveCount(30);
  await expect(page.locator('[data-day="2026-10-12"] title')).toHaveText("2026-10-12: 7 meaningful views");
  await expect(page.locator('.history-chart[role="img"]')).toHaveAttribute("aria-label", /30-day total 11; peak 7/u);
  await expect(page.locator(".history-chart [tabindex]")).toHaveCount(0);
  const historyBox = await page.locator(".history-panel").boundingBox();
  const linksBox = await page.getByRole("heading", { name: "Share links" }).boundingBox();
  expect(historyBox?.y).toBeLessThan(linksBox?.y ?? 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("content-detail.png"), fullPage: true });
});

test("content detail gives an honest empty state when all 30 UTC days are zero", async ({ page }) => {
  await page.route("**/api/admin/contents/content-1", (route) => route.fulfill({
    json: {
      ...detail,
      aggregates: history.map((entry) => ({ ...entry, meaningfulViews: 0, activeVisibleMs: 0, pdfDownloadsServed: 0 })),
    },
  }));

  await page.goto("/admin/contents/content-1");
  await expect(page.getByRole("heading", { name: "Views over time" })).toBeVisible();
  await expect(page.getByText("No views in the last 30 days")).toBeVisible();
  await expect(page.locator(".history-bar")).toHaveCount(0);
});

test("PDF companion upload stages bytes and commits before becoming current", async ({ page }) => {
  const requests: string[] = [];
  await mockAdmin(page);
  await page.route("**/api/admin/contents/content-1/pdf/uploads", async (route) => {
    requests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    expect(route.request().postDataJSON()).toMatchObject({ fileName: "brief.pdf", expectedActiveVersionId: "version-3" });
    return route.fulfill({ status: 201, json: { uploadUrl: "/api/admin/pdf/uploads/pdf-upload/data", commitUrl: "/api/admin/pdf/uploads/pdf-upload/commit" } });
  });
  await page.route("**/api/admin/pdf/uploads/**", (route) => {
    requests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: route.request().method() === "PUT" ? 204 : 200, json: route.request().method() === "PUT" ? undefined : { pdfCompanion: { state: "current" } } });
  });

  await page.goto("/admin/contents/content-1");
  await page.getByRole("button", { name: "Upload PDF" }).click();
  await page.getByLabel("PDF file").setInputFiles({
    name: "brief.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.7\nbrief"),
  });
  await page.getByRole("button", { name: "Upload PDF", exact: true }).last().click();
  await expect(page.getByText("PDF companion uploaded.")).toBeVisible();
  expect(requests).toEqual([
    "POST /api/admin/contents/content-1/pdf/uploads",
    "PUT /api/admin/pdf/uploads/pdf-upload/data",
    "POST /api/admin/pdf/uploads/pdf-upload/commit",
  ]);
});

test("long titles and share labels remain usable without viewport overflow", async ({ page }, testInfo) => {
  const longTitle = "A deliberately long product narrative title with InternationalisationAndUnbrokenContextForNarrowScreens";
  const longLabel = "Executive stakeholder review — InternationalisationAndUnbrokenRecipientContext";
  const longContent = { ...content, title: longTitle };
  const longDetail = { ...detail, title: longTitle, links: [{ ...detail.links[0], label: longLabel }] };
  await page.route("**/api/admin/contents", (route) => route.fulfill({ json: { contents: [longContent] } }));
  await page.route("**/api/admin/contents/content-1", (route) => route.fulfill({ json: longDetail }));

  await page.goto("/admin");
  await expect(page.getByRole("link", { name: new RegExp(longTitle, "u") })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.goto("/admin/contents/content-1");
  await expect(page.getByRole("heading", { name: longTitle })).toBeVisible();
  await expect(page.getByText(longLabel)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.keyboard.press("Tab");
  await expect(page.locator("header.top").getByRole("link", { name: "Preview" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("header.top").getByRole("button", { name: "Log out" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Library" })).toBeFocused();

  if (testInfo.project.name === "mobile-chromium") {
    for (const control of await page.locator(".button,.text-button").all()) {
      const box = await control.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(40);
    }
  }
  await page.screenshot({ path: testInfo.outputPath("long-content.png"), fullPage: true });
});

test("single HTML upload stages bytes and commits before navigation", async ({ page }) => {
  const requests: string[] = [];
  await page.route("**/api/admin/contents", async (route) => {
    requests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    if (route.request().method() === "GET") return route.fulfill({ json: { contents: [] } });
    return route.fulfill({
      status: 201,
      json: {
        contentId: "created-content",
        uploadId: "upload-1",
        versionId: "version-1",
        expiresAt: "2026-10-27T00:00:00.000Z",
        files: [{ path: "index.html", size: 31, mediaType: "text/html; charset=utf-8", uploadUrl: "/api/admin/uploads/upload-1/files/index.html" }],
        commitUrl: "/api/admin/uploads/upload-1/commit",
      },
    });
  });
  await page.route("**/api/admin/uploads/**", async (route) => {
    requests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: route.request().method() === "PUT" ? 204 : 200, json: route.request().method() === "PUT" ? undefined : { status: "activated" } });
  });
  await page.route("**/api/admin/contents/created-content", (route) => route.fulfill({ json: { ...detail, id: "created-content", title: "Uploaded demo" } }));

  await page.goto("/admin");
  await page.getByRole("button", { name: "Add your first item" }).click();
  await page.getByLabel("Title").fill("Uploaded demo");
  await page.getByLabel("HTML or ZIP package").setInputFiles({
    name: "index.html",
    mimeType: "text/html",
    buffer: Buffer.from("<!doctype html><h1>Demo</h1>"),
  });
  await page.getByRole("button", { name: "Upload and activate" }).click();
  await expect(page).toHaveURL(/\/admin\/contents\/created-content$/u);
  expect(requests).toEqual([
    "GET /api/admin/contents",
    "POST /api/admin/contents",
    "PUT /api/admin/uploads/upload-1/files/index.html",
    "POST /api/admin/uploads/upload-1/commit",
  ]);
});

test("ZIP upload expands a root package and transfers each declared asset", async ({ page }) => {
  type UploadedFile = { path: string; size: number };
  const uploaded: string[] = [];
  await page.route("**/api/admin/contents", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { contents: [] } });
    const body = route.request().postDataJSON() as { sourceFormat: string; files: UploadedFile[] };
    expect(body.sourceFormat).toBe("zip");
    expect(body.files.map((file) => file.path).sort()).toEqual(["assets/app.js", "index.html"]);
    return route.fulfill({
      status: 201,
      json: {
        contentId: "zip-content",
        uploadId: "zip-upload",
        versionId: "zip-version",
        expiresAt: "2026-10-27T00:00:00.000Z",
        files: body.files.sort((left, right) => left.path.localeCompare(right.path)).map((file) => ({ ...file, mediaType: file.path.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8", uploadUrl: `/api/admin/uploads/zip-upload/files/${file.path}` })),
        commitUrl: "/api/admin/uploads/zip-upload/commit",
      },
    });
  });
  await page.route("**/api/admin/uploads/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "PUT") uploaded.push(path);
    return route.fulfill({ status: route.request().method() === "PUT" ? 204 : 200, body: route.request().method() === "PUT" ? undefined : JSON.stringify({ status: "activated" }), contentType: "application/json" });
  });
  await page.route("**/api/admin/contents/zip-content", (route) => route.fulfill({ json: { ...detail, id: "zip-content", title: "ZIP demo" } }));

  const archive = zipSync({
    "demo/index.html": strToU8("<!doctype html><script src='assets/app.js'></script>"),
    "demo/assets/app.js": strToU8("document.body.dataset.ready = 'true';"),
  });
  await page.goto("/admin");
  await page.getByRole("button", { name: "Add your first item" }).click();
  await page.getByLabel("Title").fill("ZIP demo");
  await page.getByLabel("HTML or ZIP package").setInputFiles({
    name: "demo.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(archive),
  });
  await page.getByRole("button", { name: "Upload and activate" }).click();
  await expect(page).toHaveURL(/\/admin\/contents\/zip-content$/u);
  expect(uploaded).toEqual([
    "/api/admin/uploads/zip-upload/files/assets/app.js",
    "/api/admin/uploads/zip-upload/files/index.html",
  ]);
});

test("empty library explains that publishing is private by default", async ({ page }) => {
  await page.route("**/api/admin/contents", (route) => route.fulfill({ json: { contents: [] } }));
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Your private library is empty" })).toBeVisible();
  await expect(page.getByText("Nothing becomes public until you create a share link.")).toBeVisible();
});
