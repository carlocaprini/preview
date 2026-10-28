import { expect, test } from "@playwright/test";

test("owner login creates a session and opens the private workspace", async ({ page }) => {
  await page.route("**/api/admin/contents", (route) => route.fulfill({ json: { contents: [] } }));
  await page.goto("/login?next=%2Fadmin");
  await expect(page.locator("header.top").getByRole("link", { name: "Preview" })).toBeVisible();
  await expect(page.getByText("Area privata")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Accedi" })).toBeVisible();
  await page.getByLabel("Password").fill("test-owner-password");
  await page.getByRole("button", { name: "Accedi" }).click();
  await expect(page).toHaveURL(/\/admin$/u);
  await expect(page.getByRole("heading", { name: "Your private library is empty" })).toBeVisible();
});
