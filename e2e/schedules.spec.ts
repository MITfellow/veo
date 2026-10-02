import { expect, test, type Page } from '@playwright/test';
import { startFresh } from './fixture';

/**
 * Standing instructions, in a browser, against the real agent.
 *
 * §28 hands the agent the right to speak without being spoken to, which
 * makes "can the user see and revoke it" the part worth testing end to
 * end. The three things asserted here are the three things a person
 * actually needs: that creating one works and shows a *local* next time,
 * that pausing and deleting work, and that the agent says out loud when it
 * is degraded rather than quietly answering worse.
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
  await expect(page.locator('.sch-list')).toBeVisible({ timeout: 10_000 });
}

/** Clean up, so the shared e2e database does not accumulate schedules. */
async function removeAll(page: Page) {
  const rows = page.locator('.sch-row');
  while ((await rows.count()) > 0) {
    await rows.first().getByRole('button', { name: 'Delete' }).dispatchEvent('click');
    await page.waitForTimeout(250);
  }
}

test('a standing instruction can be created, paused and deleted', async ({ page, isMobile }) => {
  await openSettings(page, isMobile);
  await removeAll(page);

  await page.getByRole('button', { name: 'Add a standing instruction' }).dispatchEvent('click');
  await page.locator('.sch-input').first().fill('Morning briefing');
  await page.locator('.sch-input').nth(1).fill('What is on today?');
  await page.getByRole('button', { name: 'Schedule it' }).dispatchEvent('click');

  const row = page.locator('.sch-row', { hasText: 'Morning briefing' });
  await expect(row).toBeVisible({ timeout: 10_000 });

  // The next fire is a wall-clock time with the zone written next to it,
  // never "in 14 hours" — an offset is the thing people get wrong.
  await expect(row.locator('.sch-when')).toContainText('Next');
  await expect(row.locator('.sch-when')).toContainText(
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );

  await row.getByRole('button', { name: 'Pause' }).dispatchEvent('click');
  await expect(page.locator('.sch-row.is-off')).toBeVisible();
  await expect(page.locator('.sch-row', { hasText: 'Morning briefing' })).toContainText(
    'Paused',
  );

  await page
    .locator('.sch-row', { hasText: 'Morning briefing' })
    .getByRole('button', { name: 'Delete' })
    .dispatchEvent('click');
  await expect(page.locator('.sch-row', { hasText: 'Morning briefing' })).toHaveCount(0);
});

test('a schedule survives a reload, because the agent owns it', async ({ page, isMobile }) => {
  await openSettings(page, isMobile);
  await removeAll(page);

  await page.getByRole('button', { name: 'Add a standing instruction' }).dispatchEvent('click');
  await page.locator('.sch-input').first().fill('Evening wrap');
  await page.locator('.sch-input').nth(1).fill('What did I not finish?');
  await page.getByRole('button', { name: 'Schedule it' }).dispatchEvent('click');
  await expect(page.locator('.sch-row', { hasText: 'Evening wrap' })).toBeVisible({
    timeout: 10_000,
  });

  await page.reload();
  await page.waitForTimeout(400);
  await openSettings(page, isMobile);
  // Not in IndexedDB, not in React state: in the agent's SQLite file.
  await expect(page.locator('.sch-row', { hasText: 'Evening wrap' })).toBeVisible();

  await removeAll(page);
});

test('the agent says when it is degraded instead of answering worse quietly', async ({
  page,
  isMobile,
}) => {
  await openSettings(page, isMobile);

  // No API key in e2e, so the agent is on its offline fallback — and §27
  // says it must admit that rather than look fully capable.
  const banner = page.locator('.sch-degraded');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('L2');
  await expect(banner).toContainText('fallback');
});
