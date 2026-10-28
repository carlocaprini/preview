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
  aggregates: [],
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
  await expect(page.getByText("ZIP content", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Current HTML" })).toHaveCount(0);
  await expect(page.getByText("Version 3", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Version 2", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Update HTML" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit expiry" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Revoke" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Upload PDF" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("content-detail.png"), fullPage: true });
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
