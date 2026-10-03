import { expect, test } from '@playwright/test';
import { seedDemoWorld } from './fixture';

test.beforeEach(async ({ page }) => {
  await seedDemoWorld(page);
});

test('boots with the stored conversations', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByPlaceholder('Search')).toBeVisible();
  await expect(page.locator('.conv-row, .pinned-item').first()).toBeVisible();
  await expect(page).toHaveTitle(/Veo/);
});

test('sends a message, gets a reply and a delivery receipt', async ({ page, isMobile }) => {
  await page.goto('/');
  if (isMobile) await page.locator('.conv-row, .pinned-item').first().click();
  const field = page.locator('.field textarea').first();
  await field.click();
  await field.fill('e2e says hello');
  await page.keyboard.press('Enter');

  const sent = page.locator('.bubble.out', { hasText: 'e2e says hello' });
  await expect(sent).toBeVisible();
  await expect(page.locator('.receipt').last()).toContainText(/Sending|Delivered|Read/);
  // the persona engine answers within a few seconds
  await expect(page.locator('.bubble.in').last()).toBeVisible({ timeout: 15_000 });
});

test('searching finds a message and jumps to it', async ({ page }) => {
  await page.goto('/');
  await page.locator('#sidebar-search').fill('laundry');
  const hit = page.locator('.hit-row').first();
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(page.locator('.bubble', { hasText: 'laundry' }).first()).toBeInViewport();
});

test('a tapback can be added from the hover menu', async ({ page, isMobile }) => {
  test.skip(isMobile, 'hover affordances are pointer-only');
  await page.goto('/');
  const row = page.locator('.row.in').filter({ has: page.locator('.bubble') }).last();
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await row.getByLabel('Add a tapback').click();
  await page.getByRole('button', { name: 'Love', exact: true }).click();
  await expect(row.locator('.tapback')).toBeVisible();
});

test('settings persist across a reload', async ({ page }) => {
  await page.goto('/');
  // Named, not positional. `.icon-btn').first()` was right only by
  // accident: S4 added a notification bell to the same row, and when
  // one is outstanding the first icon button is no longer Settings.
  // Fourth time this exact shape has broken a test here.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByText('Dark', { exact: true }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.waitForTimeout(500); // debounced write to the database
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('the service worker registers and the app boots offline', async ({ page, context }) => {
  await page.goto('/');
  await page.waitForTimeout(2500);
  const registered = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    return !!r?.active;
  });
  expect(registered).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.conv-row, .pinned-item').first()).toBeVisible();
  await expect(page.getByText(/You're offline/)).toBeVisible();
  await context.setOffline(false);
});

test('mobile drills into a thread and back', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'single-pane navigation only exists on narrow screens');
  await page.goto('/');
  await expect(page.locator('.composer-wrap')).toBeHidden();
  await page.locator('.conv-row').first().click();
  await expect(page.locator('.composer-wrap')).toBeVisible();
  await page.locator('.back-btn').click();
  await expect(page.locator('.conv-row').first()).toBeVisible();
});
