import { expect, test } from "@playwright/test";

test("public shell is generic, branded, and contains a constrained content frame", async ({ page }) => {
  await page.route("**/api/public/measure", (route) => route.fulfill({ json: { recorded: true } }));
  await page.goto("/viewer");
  await expect(page.getByRole("link", { name: "Carlo Caprini" })).toBeVisible();
  const frame = page.locator("iframe");
  await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-modals allow-popups");
  await expect(frame).not.toHaveAttribute("sandbox", /allow-top-navigation/u);
  await expect(page).toHaveTitle("Shared preview — Carlo Caprini");
});

test("public measurement sends same-origin cookies from the trusted shell", async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "preview_probe", value: "present", url: baseURL }]);
  await page.route("**/api/public/measure", (route) => route.fulfill({ json: { recorded: false } }));
  const measurement = page.waitForRequest((request) => request.url().endsWith("/api/public/measure"));

  await page.goto("/viewer");
  const request = await measurement;
  expect(request.method()).toBe("POST");
  expect(new URL(request.url()).origin).toBe(new URL(baseURL).origin);
  expect(request.headers().cookie).toContain("preview_probe=present");
});

test("unavailable state never distinguishes expiry from revocation", async ({ page }) => {
  const response = await page.goto("/unavailable");
  expect(response?.status()).toBe(410);
  await expect(page.getByRole("heading", { name: "This preview is no longer available." })).toBeVisible();
  await expect(page.getByText("expired or the content may no longer be shared")).toBeVisible();
});
