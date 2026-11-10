import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("homepage separates the live product journey from external referrals", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Preview — Interactive work, shared simply");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "index,follow");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/$/u);
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", /\/assets\/preview-social\.png$/u);
  const header = page.locator("header.top");
  await expect(header.getByRole("link", { name: "Preview" })).toHaveAttribute("href", "/");
  await expect(header.getByRole("link", { name: "About" })).toHaveAttribute("href", "/about/");
  await expect(header.getByRole("link", { name: "About" })).not.toHaveAttribute("aria-current", "page");
  await expect(header.getByText("Carlo Caprini")).toHaveCount(0);
  const homeUtm = "utm_source=preview&utm_medium=referral&utm_campaign=public_pages&utm_content=home";
  await expect(page.getByRole("link", { name: "Explore work" })).toHaveAttribute("href", `https://carlocaprini.com/work/?${homeUtm}`);
  await expect(page.getByRole("link", { name: "Explore thinking" })).toHaveAttribute("href", `https://carlocaprini.com/thinking/?${homeUtm}`);
  await expect(page.getByRole("link", { name: "Get in touch" })).toHaveAttribute("href", `https://carlocaprini.com/?${homeUtm}#contact`);
  const demo = page.getByRole("link", { name: "See Preview in action" });
  await expect(demo).toHaveAttribute("href", "https://preview.carlocaprini.com/s/ELERLxWr81LqDeprOoh0eg.zSWIATN3U7rks3G_nmJkEw");
  const source = page.getByRole("link", { name: "View on GitHub" });
  await expect(source).toHaveAttribute("href", "https://github.com/carlocaprini/preview");
  await expect(source).toHaveAttribute("target", "_blank");
  await expect(source).toHaveAttribute("rel", "noopener noreferrer");
  await expect(page.getByText("Fork the code and try your own copy. The setup guide is in the repository.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Privacy" })).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(header.getByRole("link", { name: "Preview" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(header.getByRole("link", { name: "About" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(demo).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(source).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Explore work" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Explore thinking" })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("About Preview explains the project and its independent deployment boundary", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "About" }).click();
  await expect(page).toHaveURL(/\/about\/$/u);
  await expect(page).toHaveTitle("About Preview — How it works and why it exists");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "index,follow");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/about\/$/u);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("A small tool for sharing work without flattening it.");
  for (const name of ["Why I built Preview", "From HTML to a shareable link", "A few useful signals", "A small, inspectable project", "Built for one owner"]) {
    await expect(page.getByRole("heading", { name })).toBeVisible();
  }
  await expect(page.locator("header.top").getByRole("link", { name: "About" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "See Preview in action" })).toHaveAttribute(
    "href",
    "https://preview.carlocaprini.com/s/ELERLxWr81LqDeprOoh0eg.zSWIATN3U7rks3G_nmJkEw",
  );
  await expect(page.getByRole("link", { name: "Explore Carlo’s work" })).toHaveCount(0);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/favicon.svg");
  const source = page.getByRole("link", { name: "Explore the source on GitHub" });
  await expect(source).toHaveAttribute("href", "https://github.com/carlocaprini/preview");
  await expect(source).toHaveAttribute("target", "_blank");
  await expect(source).toHaveAttribute("rel", "noopener noreferrer");
  const guide = page.getByRole("link", { name: "self-hosting guide" });
  await expect(guide).toHaveAttribute("href", "https://github.com/carlocaprini/preview/blob/main/docs/self-hosting.md");
  await expect(guide).toHaveAttribute("target", "_blank");
  await expect(guide).toHaveAttribute("rel", "noopener noreferrer");
  await expect(page.getByRole("link", { name: "Privacy", exact: true })).toHaveAttribute("href", "/privacy/");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("the published example source remains interactive inside the viewer sandbox", async ({ page }) => {
  const source = await readFile(new URL("../../examples/live-preview/index.html", import.meta.url), "utf8");
  await page.setContent('<iframe title="Shared interactive content" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"></iframe>');
  const element = await page.locator("iframe").elementHandle();
  const frame = await element?.contentFrame();
  if (!frame) throw new Error("The example iframe must be available");
  await frame.setContent(source);
  const owner = frame.getByRole("button", { name: "For the owner" });
  await expect(owner).toHaveAttribute("aria-pressed", "false");
  await owner.click();
  await expect(owner).toHaveAttribute("aria-pressed", "true");
  await expect(frame.getByText("Publish authored HTML")).toBeVisible();
  await expect(frame.getByText("Open one clear link")).toBeHidden();
  expect(await frame.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("privacy notice states aggregate measurement and retention boundaries", async ({ page }) => {
  await page.goto("/privacy/");
  await expect(page).toHaveTitle("Privacy — Preview");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Small, aggregate signals—not reader profiles.");
  await expect(page.getByText("for up to 24 hours", { exact: false })).toBeVisible();
  await expect(page.getByText("no automatic time-based deletion", { exact: false })).toBeVisible();
  await expect(page.getByText("Readers do not receive an identity cookie", { exact: false })).toBeVisible();
  await expect(page.getByText("Last updated: 6 November 2026")).toBeVisible();
  await expect(page.locator("header.top").getByRole("link", { name: "About" })).toHaveAttribute("href", "/about/");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex,nofollow,noarchive");
  await expect(page.getByRole("link", { name: "contact route on Carlo’s site" })).toHaveAttribute(
    "href",
    "https://carlocaprini.com/?utm_source=preview&utm_medium=referral&utm_campaign=public_pages&utm_content=privacy#contact",
  );
  await expect(page.getByRole("link", { name: /source|github/u })).toHaveCount(0);
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
    await expect(header.getByRole("link", { name: "About" })).toHaveCount(0);
    await expect(header.getByText("Shared preview")).toHaveCount(0);
    await expect(header.getByRole("link", { name: "Download PDF" })).toHaveCount(pdf ? 1 : 0);
    if (pdf) await expect(header.getByRole("link", { name: "Download PDF" })).not.toHaveAttribute("href", /utm_/u);
    await expect(attribution).toContainText(/Preview built by\s*Carlo Caprini\s*·\s*Explore work/u);
    await expect(attribution.getByText("Shared by Carlo Caprini")).toHaveCount(0);
    const builder = attribution.getByRole("link", { name: "Carlo Caprini" });
    const work = attribution.getByRole("link", { name: "Explore work" });
    const privacy = attribution.getByRole("link", { name: "Privacy" });
    await expect(attribution.getByRole("link", { name: /source|github/u })).toHaveCount(0);
    const documentUtm = "utm_source=preview&utm_medium=referral&utm_campaign=shared_content&utm_content=doc_550e8400e29b41d4a716446655440000";
    await expect(builder).toHaveAttribute("href", `https://carlocaprini.com/?${documentUtm}`);
    await expect(work).toHaveAttribute("href", `https://carlocaprini.com/work/?${documentUtm}`);
    for (const link of [builder, work]) {
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    await expect(privacy).toHaveAttribute("href", "/privacy/");
    await expect(privacy).toHaveAttribute("target", "_blank");
    await expect(privacy).toHaveAttribute("rel", "noopener noreferrer");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex,nofollow,noarchive");
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
    const assertContainedInsetFocus = async (link: typeof builder) => {
      const focus = await link.evaluate((element) => {
        const linkBox = element.getBoundingClientRect();
        const footerBox = element.closest(".viewer-attribution")?.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          boxShadow: style.boxShadow,
          link: { left: linkBox.left, right: linkBox.right, top: linkBox.top, bottom: linkBox.bottom, height: linkBox.height },
          footer: footerBox ? { left: footerBox.left, right: footerBox.right, top: footerBox.top, bottom: footerBox.bottom } : null,
          viewport: { width: innerWidth, height: innerHeight },
        };
      });
      expect(focus.boxShadow).toContain("inset");
      expect(focus.link.height).toBeGreaterThanOrEqual(40);
      expect(focus.footer).not.toBeNull();
      if (!focus.footer) throw new Error("Focused footer link must belong to the viewer footer");
      expect(focus.link.left).toBeGreaterThanOrEqual(focus.footer.left);
      expect(focus.link.right).toBeLessThanOrEqual(focus.footer.right);
      expect(focus.link.top).toBeGreaterThanOrEqual(focus.footer.top);
      expect(focus.link.bottom).toBeLessThanOrEqual(focus.footer.bottom);
      expect(focus.link.left).toBeGreaterThanOrEqual(0);
      expect(focus.link.right).toBeLessThanOrEqual(focus.viewport.width);
      expect(focus.link.top).toBeGreaterThanOrEqual(0);
      expect(focus.link.bottom).toBeLessThanOrEqual(focus.viewport.height);
    };
    await work.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(builder).toBeFocused();
    await assertContainedInsetFocus(builder);
    await page.screenshot({ path: testInfo.outputPath(`viewer-${theme}-builder-focus.png`), fullPage: true });
    await page.keyboard.press("Tab");
    await expect(work).toBeFocused();
    await assertContainedInsetFocus(work);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`viewer-${theme}-work-focus.png`), fullPage: true });
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
  await expect(page.locator("header.top").getByRole("link", { name: "About" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "This preview is no longer available." })).toBeVisible();
  await expect(page.getByText("expired or the content may no longer be shared")).toBeVisible();
  await expect(page.getByRole("link", { name: "Explore work" })).toHaveAttribute(
    "href",
    "https://carlocaprini.com/work/?utm_source=preview&utm_medium=referral&utm_campaign=public_pages&utm_content=unavailable",
  );
  await expect(page.getByRole("link", { name: /source|github/u })).toHaveCount(0);
});
