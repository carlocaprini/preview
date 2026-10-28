import { expect, test } from "@playwright/test";

test("homepage uses the compact Preview header and canonical website actions", async ({ page }) => {
  await page.goto("/");
  const header = page.locator("header.top");
  await expect(header.getByRole("link", { name: "Preview" })).toHaveAttribute("href", "/");
  await expect(header.getByText("Carlo Caprini")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Explore work" })).toHaveAttribute("href", "https://carlocaprini.com/work/");
  await expect(page.getByRole("link", { name: "Explore thinking" })).toHaveAttribute("href", "https://carlocaprini.com/thinking/");
  await expect(page.getByRole("link", { name: "Get in touch" })).toHaveAttribute("href", "https://carlocaprini.com/#contact");
});

test("public shell is generic, branded, and contains a constrained content frame", async ({ page }) => {
  await page.route("**/api/public/measure", (route) => route.fulfill({ json: { recorded: true } }));
  await page.goto("/viewer");
  const header = page.locator("header.top");
  await expect(header.getByRole("link", { name: "Preview" })).toBeVisible();
  await expect(header.getByText("Shared preview")).toHaveCount(0);
  const frame = page.locator("iframe");
  await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-modals allow-popups");
  await expect(frame).not.toHaveAttribute("sandbox", /allow-top-navigation/u);
  await expect(page).toHaveTitle("Shared preview — Carlo Caprini");
});

test("an already-open shared link follows real owner login and logout for view and visible-time analytics", async ({
  page,
  context,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const fixtureResponse = await context.request.post("/test/analytics-fixtures");
  expect(fixtureResponse.status()).toBe(201);
  const fixture = (await fixtureResponse.json()) as { linkUrl: string; linkId: string };
  const external = new URL(baseURL);
  external.hostname = "localhost";
  external.port = String(Number(external.port) + 1);

  let releaseContent: (() => void) | undefined;
  const contentGate = new Promise<void>((resolve) => {
    releaseContent = resolve;
  });
  await context.route(`${external.origin}/s/**`, async (route) => {
    await contentGate;
    await route.continue();
  });

  await page.goto(`${external.origin}/launch?target=${encodeURIComponent(fixture.linkUrl)}`);
  await page.getByRole("link", { name: "Open shared preview" }).evaluate((element) =>
    (element as HTMLAnchorElement).click(),
  );
  await page.waitForURL(fixture.linkUrl, { waitUntil: "domcontentloaded" });

  const admin = await context.newPage();
  await admin.goto(`${baseURL}/login?next=%2Fadmin`);
  await admin.getByLabel("Password").fill("test-owner-password");
  await admin.getByRole("button", { name: "Accedi" }).click();
  await admin.waitForURL(`${baseURL}/admin`);
  const ownerCookie = (await context.cookies(baseURL)).find((cookie) => cookie.name === "__Host-preview_owner");
  expect(ownerCookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict" });

  const measurement = (kind: "view" | "visible") =>
    page.waitForResponse((response) => {
      if (!response.url().endsWith("/api/public/measure")) return false;
      const body = response.request().postDataJSON() as { kind?: string } | null;
      return body?.kind === kind;
    });
  const state = async () => {
    const response = await context.request.get(`/test/analytics-fixtures/${encodeURIComponent(fixture.linkId)}`);
    return (await response.json()) as {
      receiptCount: number;
      meaningfulViews: number;
      activeVisibleMs: number;
      lastViewAt: string | null;
    };
  };

  const ownerView = measurement("view");
  releaseContent?.();
  expect((await ownerView).status()).toBe(200);
  await page.waitForTimeout(1_100);
  const ownerVisible = measurement("visible");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect((await ownerVisible).status()).toBe(200);
  expect(await state()).toEqual({ receiptCount: 0, meaningfulViews: 0, activeVisibleMs: 0, lastViewAt: null });

  await admin.getByRole("button", { name: "Log out" }).click();
  await admin.waitForURL(`${baseURL}/login`);
  expect((await context.cookies(baseURL)).some((cookie) => cookie.name === "__Host-preview_owner")).toBe(false);

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(1_100);
  await page.goto(`${external.origin}/launch?target=${encodeURIComponent(fixture.linkUrl)}`);
  await expect.poll(async () => (await state()).receiptCount).toBe(1);
  const afterPageHide = await state();
  expect(afterPageHide.receiptCount).toBe(1);
  expect(afterPageHide.meaningfulViews).toBe(0);
  expect(afterPageHide.activeVisibleMs).toBeGreaterThanOrEqual(1_000);
  expect(afterPageHide.lastViewAt).toBeNull();

  const loggedOutView = measurement("view");
  await page.goto(fixture.linkUrl);
  expect((await loggedOutView).status()).toBe(200);
  const afterLogout = await state();
  expect(afterLogout.receiptCount).toBe(2);
  expect(afterLogout.meaningfulViews).toBe(1);
  expect(afterLogout.activeVisibleMs).toBeGreaterThanOrEqual(1_000);
  expect(afterLogout.lastViewAt).toBeTruthy();
});

test("unavailable state never distinguishes expiry from revocation", async ({ page }) => {
  const response = await page.goto("/unavailable");
  expect(response?.status()).toBe(410);
  await expect(page.locator("header.top").getByRole("link", { name: "Preview" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "This preview is no longer available." })).toBeVisible();
  await expect(page.getByText("expired or the content may no longer be shared")).toBeVisible();
});
