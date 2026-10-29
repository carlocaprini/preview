import { expect, test } from "@playwright/test";

test("homepage uses the compact Preview header and canonical website actions", async ({ page }) => {
  await page.goto("/");
  const header = page.locator("header.top");
  await expect(header.getByRole("link", { name: "Preview" })).toHaveAttribute("href", "/");
  await expect(header.getByText("Carlo Caprini")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Explore work" })).toHaveAttribute("href", "https://carlocaprini.com/work/");
  await expect(page.getByRole("link", { name: "Explore thinking" })).toHaveAttribute("href", "https://carlocaprini.com/thinking/");
  await expect(page.getByRole("link", { name: "Get in touch" })).toHaveAttribute("href", "https://carlocaprini.com/#contact");
  await page.keyboard.press("Tab");
  await expect(header.getByRole("link", { name: "Preview" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Explore work" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Explore thinking" })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("public shell keeps attribution and full-height light and dark content frames", async ({ page }, testInfo) => {
  await page.route("**/api/public/measure", (route) => route.fulfill({ json: { recorded: true } }));
  for (const { theme, pdf } of [{ theme: "light", pdf: false }, { theme: "dark", pdf: true }] as const) {
    await page.goto(`/viewer?theme=${theme}&pdf=${pdf ? "1" : "0"}`);
    const header = page.locator("header.top");
    const frame = page.locator("iframe");
    const attribution = page.locator(".viewer-attribution");
    await expect(header.getByRole("link", { name: "Preview" })).toBeVisible();
    await expect(header.getByText("Shared preview")).toHaveCount(0);
    await expect(header.getByRole("link", { name: "Download PDF" })).toHaveCount(pdf ? 1 : 0);
    await expect(attribution).toContainText(/Preview built by\s*Carlo Caprini\s*·\s*Explore work/u);
    await expect(attribution.getByText("Shared by Carlo Caprini")).toHaveCount(0);
    const builder = attribution.getByRole("link", { name: "Carlo Caprini" });
    const work = attribution.getByRole("link", { name: "Explore work" });
    await expect(builder).toHaveAttribute("href", "https://carlocaprini.com/");
    await expect(work).toHaveAttribute("href", "https://carlocaprini.com/work/");
    for (const link of [builder, work]) {
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", "noopener noreferrer");
      await link.focus();
      await expect(link).toBeFocused();
    }
    await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-modals allow-popups");
    await expect(frame).not.toHaveAttribute("sandbox", /allow-top-navigation/u);
    await expect(page.frameLocator("iframe").locator("html")).toHaveAttribute("data-theme", theme);
    const [headerBox, frameBox, attributionBox] = await Promise.all([
      header.boundingBox(),
      frame.boundingBox(),
      attribution.boundingBox(),
    ]);
    if (!headerBox || !frameBox || !attributionBox) throw new Error("Viewer regions must have measurable layout boxes");
    expect(headerBox.height).toBe(56);
    expect(frameBox.height).toBeGreaterThan(400);
    expect(frameBox.y).toBe(headerBox.y + headerBox.height);
    expect(attributionBox.y).toBe(frameBox.y + frameBox.height);
    expect(attributionBox.height).toBeGreaterThanOrEqual(44);
    for (const link of [builder, work]) {
      const box = await link.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(40);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`viewer-${theme}.png`), fullPage: true });
  }
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
