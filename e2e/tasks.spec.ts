import { expect, test, type Page } from '@playwright/test';
import { startFresh } from './fixture';

/**
 * S2 tests 38–40: the to-do list in a browser, against the real agent.
 *
 * Same claim as the calendar spec: this is not browser state. The task
 * goes into the agent's event log over HTTP, which is why test 39
 * reloads the page.
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
  await expect(page.locator('.tsk-list')).toBeVisible({ timeout: 10_000 });
}

/** The e2e database is shared between specs; leave it as found. */
async function removeAll(page: Page) {
  const rows = page.locator('.tsk-row');
  while ((await rows.count()) > 0) {
    await rows.first().getByRole('button', { name: 'Remove' }).dispatchEvent('click');
    await page.waitForTimeout(250);
  }
}

/**
 * A title nothing else will match.
 *
 * The e2e database is shared across specs, projects and re-runs, so a
 * fixed title collides with leftovers from an earlier failed run — four
 * copies of "Renew the lease" broke this spec once already. Unique
 * titles make each assertion about this run and nothing else.
 */
const unique = (name: string) => `${name} ${Date.now().toString(36)}`;

/** Scoped to the panel: the Settings sheet is one long column of panels. */
const addTask = (page: Page) =>
  page.locator('.tsk-add').getByRole('button', { name: 'Add', exact: true });

test('38. a task added in the UI appears on the list', async ({ page, isMobile }) => {
  await openSettings(page, isMobile);
  await removeAll(page);

  const title = unique('Buy a router');
  await page.getByLabel('Task title').fill(title);
  await addTask(page).dispatchEvent('click');

  const row = page.locator('.tsk-row', { hasText: title });
  await expect(row).toBeVisible({ timeout: 10_000 });
  // Not ticked, and no due date shown when none was given.
  await expect(row.locator('.tsk-due')).toHaveCount(0);

  await removeAll(page);
});

test('39. ticking it off sticks, and it survives a reload', async ({ page, isMobile }) => {
  await openSettings(page, isMobile);
  await removeAll(page);

  const title = unique('Renew the lease');
  await page.getByLabel('Task title').fill(title);
  await addTask(page).dispatchEvent('click');
  await expect(page.locator('.tsk-row', { hasText: title })).toBeVisible({ timeout: 10_000 });

  await page
    .locator('.tsk-row', { hasText: title })
    .getByRole('button', { name: `Mark ${title} done` })
    .dispatchEvent('click');

  // Gone from the open list — the default view is what is left to do.
  await expect(page.locator('.tsk-row', { hasText: title })).toHaveCount(0, { timeout: 10_000 });

  // Still there, and still ticked, after the page is thrown away:
  // the list lives in the agent's event log, not in this tab.
  await page.reload();
  await page.waitForTimeout(300);
  await openSettings(page, isMobile);
  await page.getByRole('button', { name: 'Show finished' }).dispatchEvent('click');

  const done = page.locator('.tsk-row', { hasText: title });
  await expect(done).toBeVisible({ timeout: 10_000 });
  await expect(done).toHaveClass(/is-done/);

  await removeAll(page);
});

test('40. a due date is shown as a deadline, and overdue is marked', async ({
  page,
  isMobile,
}) => {
  await openSettings(page, isMobile);
  await removeAll(page);

  // Yesterday, so it is unambiguously overdue.
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  const value = `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(
    yesterday.getDate(),
  )}`;

  const title = unique('File the thing');
  await page.getByLabel('Task title').fill(title);
  await page.getByLabel('Due date (optional)').fill(value);
  await addTask(page).dispatchEvent('click');

  const row = page.locator('.tsk-row', { hasText: title });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row.locator('.tsk-due')).toContainText('overdue');
  await expect(row.locator('.tsk-due')).toHaveClass(/is-overdue/);

  // The panel states plainly that a due date is not an alarm — nothing
  // is going to fire, and implying otherwise would be a broken promise.
  await expect(page.locator('.tsk-note')).toContainText('not a reminder');

  await removeAll(page);
});
