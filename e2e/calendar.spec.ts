import { expect, test, type Page } from '@playwright/test';
import { startFresh } from './fixture';

/**
 * S1 tests 40–42: the calendar in a browser, against the real agent.
 *
 * The claim being tested is the one that distinguishes this from every
 * other calendar widget: it is not browser state. The event goes into
 * the agent's event log over HTTP, which is why test 41 reloads the page
 * — and why it would still be there after clearing the browser.
 */
test.beforeEach(async ({ page }) => {
  await startFresh(page);
  await page.goto('/');
  await page.waitForTimeout(300);
});

async function openSettings(page: Page, isMobile: boolean) {
  if (isMobile) {
    // On mobile the chat covers the whole screen and Settings is not
    // reachable until nothing is open.
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
  await expect(page.locator('.cal-list')).toBeVisible({ timeout: 10_000 });
}

/** The shared e2e database persists between specs; leave it as found. */
async function removeAll(page: Page) {
  const rows = page.locator('.cal-row');
  while ((await rows.count()) > 0) {
    await rows.first().getByRole('button', { name: 'Cancel' }).dispatchEvent('click');
    await page.waitForTimeout(250);
  }
}

/**
 * Scoped to the panel's own form. An unscoped `name: 'Add'` also matches
 * the constitution panel's button further down the same Settings sheet —
 * the sheet is one long column, so every locator here has to say which
 * panel it means.
 */
const addButton = (page: Page) =>
  page.locator('.cal-add').getByRole('button', { name: 'Add', exact: true });

/** `2027-05-11T14:30`, a datetime-local value a few days out. */
function soon(dayOffset: number, hour: number): string {
  const when = new Date();
  when.setDate(when.getDate() + dayOffset);
  when.setHours(hour, 30, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(hour)}:30`;
}

test('40. an event added in the UI appears in the agenda', async ({ page, isMobile }) => {
  await openSettings(page, isMobile);
  await removeAll(page);

  await page.getByRole('button', { name: 'Add an event' }).dispatchEvent('click');
  await page.getByLabel('Event title').fill('Dentist');
  await page.getByLabel('When').fill(soon(2, 9));
  await page.getByLabel('Where').fill('Rua Garrett 12');
  await addButton(page).dispatchEvent('click');

  const row = page.locator('.cal-row', { hasText: 'Dentist' });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row.locator('.cal-where')).toHaveText('Rua Garrett 12');
  // A time, not "in 2 days" — an offset is the thing people get wrong.
  await expect(row.locator('.cal-time')).toContainText('9');

  await removeAll(page);
});

test('41. it survives a reload, because the agent owns it', async ({ page, isMobile }) => {
  await openSettings(page, isMobile);
  await removeAll(page);

  await page.getByRole('button', { name: 'Add an event' }).dispatchEvent('click');
  await page.getByLabel('Event title').fill('Flight to Lisbon');
  await page.getByLabel('When').fill(soon(3, 7));
  await addButton(page).dispatchEvent('click');
  await expect(page.locator('.cal-row', { hasText: 'Flight to Lisbon' })).toBeVisible({
    timeout: 10_000,
  });

  // The whole point: this is not component state and not IndexedDB. The
  // page is thrown away and the event is still there, because it lives
  // in the agent's event log.
  await page.reload();
  await page.waitForTimeout(300);
  await openSettings(page, isMobile);
  await expect(page.locator('.cal-row', { hasText: 'Flight to Lisbon' })).toBeVisible({
    timeout: 10_000,
  });

  // And cancelling it is the user's, not the agent's.
  await page
    .locator('.cal-row', { hasText: 'Flight to Lisbon' })
    .getByRole('button', { name: 'Cancel' })
    .dispatchEvent('click');
  await expect(page.locator('.cal-row', { hasText: 'Flight to Lisbon' })).toHaveCount(0, {
    timeout: 10_000,
  });

  await removeAll(page);
});

test('42. search finds an event by a word in its title', async ({ page, isMobile }) => {
  await openSettings(page, isMobile);
  await removeAll(page);

  for (const [title, day] of [
    ['Standup', 1],
    ['Lunch with Rui', 2],
  ] as const) {
    await page.getByRole('button', { name: 'Add an event' }).dispatchEvent('click');
    await page.getByLabel('Event title').fill(title);
    await page.getByLabel('When').fill(soon(day, 12));
    await addButton(page).dispatchEvent('click');
    await expect(page.locator('.cal-row', { hasText: title })).toBeVisible({ timeout: 10_000 });
  }

  await page.getByLabel('Search your calendar').fill('rui');
  await expect(page.locator('.cal-row')).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator('.cal-row')).toContainText('Lunch with Rui');

  // A search with no hits says so, rather than showing an empty box
  // that looks like a loading state.
  await page.getByLabel('Search your calendar').fill('nothing matches this');
  await expect(page.locator('.cal-empty')).toContainText('Nothing matches', { timeout: 10_000 });

  await page.getByLabel('Search your calendar').fill('');
  await removeAll(page);
});
