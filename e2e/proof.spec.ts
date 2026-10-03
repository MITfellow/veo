import { expect, test, type Page } from '@playwright/test';
import { startFresh } from './fixture';

/**
 * M9 in a browser: the voice is editable, the numbers are real, and the
 * backup check actually checks something.
 */
test.beforeEach(async ({ page }) => {
  await startFresh(page);
  await page.goto('/');
  await page.waitForTimeout(300);
});

async function openSettings(page: Page, isMobile: boolean) {
  if (isMobile) {
    await page.evaluate(async () => {
      const env = await window.__store.read();
      if (env === null) return;
      env.state.activeChatId = null;
      await window.__store.write(env);
    });
    await page.reload();
    await page.waitForTimeout(300);
  }
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('.prf-form')).toBeVisible({ timeout: 10_000 });
}

test('the agent\'s voice is editable and the model is shown what you set', async ({
  page,
  isMobile,
}) => {
  await openSettings(page, isMobile);

  const name = page.locator('.prf-input').first();
  await name.fill('Ada');
  await page.waitForTimeout(500);

  await page.locator('.prf-details > summary').dispatchEvent('click');
  // Not a JSON blob: the agent is told in sentences, and the person can
  // read exactly what it was told.
  await expect(page.locator('.prf-pre')).toContainText('You are called Ada.');

  // It survives a reload, because the agent owns it, not the browser.
  await page.reload();
  await page.waitForTimeout(400);
  await openSettings(page, isMobile);
  await expect(page.locator('.prf-input').first()).toHaveValue('Ada');
});

test('naming the agent renames the conversation it is having with you', async ({
  page,
  isMobile,
}) => {
  // S6. The complaint that started this was that naming the thing
  // appeared to do nothing — so the name has to show up where a person
  // actually looks, not only in the field they typed it into.
  await openSettings(page, isMobile);
  await page.locator('.prf-input').first().fill('Jacky');
  await page.waitForTimeout(600);
  await page.keyboard.press('Escape');

  const row = page.locator('.conv-agent');
  await expect(row).toContainText('Jacky', { timeout: 10_000 });

  // And it is still the agent's row, not a new contact: the identity is
  // the `agent` flag, which is why the locator above is not a name.
  await expect(page.locator('.conv-agent')).toHaveCount(1);

  // Put it back, because the database is shared across specs and a
  // leftover name is how the next spec fails for an unrelated reason.
  await openSettings(page, isMobile);
  await page.locator('.prf-input').first().fill('Ada');
  await page.waitForTimeout(600);
});

test('the numbers come from the log and carry their budgets', async ({ page, isMobile }) => {
  await openSettings(page, isMobile);

  const tiles = page.locator('.prf-stat');
  await expect(tiles.first()).toBeVisible();
  // The budget travels with the latency, in words.
  await expect(page.locator('.prf-grid')).toContainText('context assembly p95');
  await expect(page.locator('.prf-grid')).toContainText('budget 100ms');
  // Refusals are counted as refusals, not as failures.
  await expect(page.locator('.prf-grid')).toContainText('refused on purpose');
});

test('verifying a backup rebuilds it and says what it found', async ({ page, isMobile }) => {
  await openSettings(page, isMobile);

  await page.getByRole('button', { name: 'Verify a backup now' }).dispatchEvent('click');
  const report = page.locator('.prf-report');
  await expect(report).toBeVisible({ timeout: 20_000 });
  await expect(report).toContainText('This backup is good.');
  // The three things that distinguish a backup from a file of the right
  // size, each stated.
  await expect(report).toContainText('hash chain verifies');
  await expect(report).toContainText('byte-identically');
  await expect(report).toContainText('read back from the copy');
});
