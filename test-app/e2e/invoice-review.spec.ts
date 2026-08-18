import { expect, test } from "@playwright/test";

test("approves an invoice whose total matches its purchase order", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /INV-1048/ }).click();
  await expect(page.getByTestId("comparison-result")).toContainText("Totals match");
  await page.getByRole("button", { name: "Approve invoice" }).click();
  await expect(page.getByTestId("review-state")).toHaveText("Approved");
});

test("flags an invoice whose total differs from its purchase order", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /INV-1049/ }).click();
  await expect(page.getByTestId("comparison-result")).toContainText("Difference: $47.15");
  await page.getByRole("button", { name: "Flag difference" }).click();
  await expect(page.getByTestId("review-state")).toHaveText("Needs attention");
});
