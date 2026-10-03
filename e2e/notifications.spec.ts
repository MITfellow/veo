import { expect, test, type Page } from '@playwright/test';
import { startFresh } from './fixture';

/**
 * S4 tests 67–69: a reminder that actually reaches someone.
 *
 * This is the end of the chain S3 built and left dangling: scheduler
 * fires → worker runs → agent speaks → **and the person is told**.
 * Test 67 sets a reminder in the past so the scheduler's catch-up
 * sweep fires it within a few seconds, then waits for the badge.
 *
 * Nothing here is browser state. The badge is a query against the
 * agent's event log, which is why 68 reloads.
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

const unique = (name: string) => `${name} ${Date.now().toString(36)}`;

/**
 * Clear anything a previous spec or failed run left outstanding.
 *
 * The e2e database is shared, and a stale notification makes the
 * badge appear for reasons that have nothing to do with this test —
 * which is how a green bell can hide a broken feature.
 */
async function clearNotifications(page: Page) {
  await page.evaluate(async () => {
    const response = await fetch('/agent/notifications');
    const body = (await response.json()) as { notifications: Array<{ id: string }> };
    for (const item of body.notifications) {
      await fetch(`/agent/notifications/${item.id}/seen`, { method: 'POST' });
    }
  });
}

/**
 * Wait until the agent itself reports the reminder as fired, then
 * reload so the component fetches immediately.
 *
 * The bell polls every thirty seconds, which is right for a thing
 * that happens a few times a day and wrong to race in a test. This
 * waits on the API — the real condition — and then forces the one
 * fetch we care about, instead of sleeping and hoping.
 */
async function waitForFired(page: Page, text: string) {
  await expect
    .poll(
      async () =>
        page.evaluate(async (wanted) => {
          const response = await fetch('/agent/notifications');
          const body = (await response.json()) as { notifications: Array<{ text: string }> };
          return body.notifications.some((n) => n.text === wanted);
        }, text),
      { timeout: 25_000, intervals: [500] },
    )
    .toBe(true);
  await page.reload();
  await page.waitForTimeout(800);
}

/**
 * Set a task and a reminder on it that is already overdue, straight
 * through the agent's HTTP API.
 *
 * Done over `fetch` rather than through the panel because the panel's
 * time picker cannot express "a minute ago", and what is under test
 * here is the notification, not the form.
 */
async function fireAReminder(page: Page, text: string) {
  return page.evaluate(async (reminderText) => {
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`/agent${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return response.json() as Promise<{ id: string }>;
    };
    const task = await post('/tasks', { title: reminderText });
    const reminder = await post('/reminders', {
      text: reminderText,
      remindAt: Date.now() - 60_000,
      ownerKind: 'task',
      ownerId: task.id,
    });
    return { taskId: task.id, reminderId: reminder.id };
  }, text);
}

/** The e2e database is shared between specs; leave it as found. */
async function tidy(page: Page, taskId: string) {
  await page.evaluate(
    async (id) => void (await fetch(`/agent/tasks/${id}`, { method: 'DELETE' })),
    taskId,
  );
}

test('67. a fired reminder shows a badge, and dismissing it clears it', async ({ page }) => {
  await clearNotifications(page);
  const text = unique('Put the bins out');
  const { taskId } = await fireAReminder(page, text);
  await waitForFired(page, text);

  const bell = page.locator('.ntf-bell');
  await expect(bell).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.ntf-badge')).toHaveText(/\d/);

  await bell.click();
  await expect(page.locator('.ntf-pop').getByText(text)).toBeVisible();

  await page.locator('.ntf-item', { hasText: text }).getByRole('button', { name: 'Got it' }).click();

  // Gone, and gone for good: "seen" is an event in the agent's log.
  await expect(page.locator('.ntf-item', { hasText: text })).toHaveCount(0);
  await page.reload();
  await page.waitForTimeout(1200);
  await expect(page.locator('.ntf-item', { hasText: text })).toHaveCount(0);

  await tidy(page, taskId);
});

test('68. the badge survives a reload until it is dismissed', async ({ page }) => {
  await clearNotifications(page);
  const text = unique('Move the car');
  const { taskId, reminderId } = await fireAReminder(page, text);
  await waitForFired(page, text);

  await expect(page.locator('.ntf-bell')).toBeVisible({ timeout: 15_000 });

  await page.reload();
  await page.waitForTimeout(1200);
  await expect(page.locator('.ntf-bell')).toBeVisible({ timeout: 15_000 });
  await page.locator('.ntf-bell').click();
  await expect(page.locator('.ntf-pop').getByText(text)).toBeVisible();

  // Tidy up through the API so a failure here cannot strand a badge
  // for every later spec.
  await page.evaluate(
    async (id) => void (await fetch(`/agent/notifications/${id}/seen`, { method: 'POST' })),
    reminderId,
  );
  await tidy(page, taskId);
});

test('69. a calendar event can be given a reminder from a preset', async ({ page, isMobile }) => {
  await openSettings(page, isMobile);

  // An event far enough ahead that every preset is still in the future.
  const title = unique('Dentist');
  const eventId = await page.evaluate(async (eventTitle) => {
    const response = await fetch('/agent/calendar', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: eventTitle, startsAt: Date.now() + 6 * 86_400_000 }),
    });
    return ((await response.json()) as { id: string }).id;
  }, title);

  await page.reload();
  await openSettings(page, isMobile);

  const row = page.locator('.cal-row', { hasText: title });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.getByRole('button', { name: `Set a reminder for ${title}` }).click();
  await row.getByRole('button', { name: 'An hour before' }).click();
  await page.waitForTimeout(500);

  // The row says so, and the reminder is real — it shows up in the
  // to-do panel's reminder list, which reads it back from the agent.
  await expect(row.getByRole('button', { name: `Reminder set for ${title}` })).toBeVisible();
  await expect(page.locator('.tsk-reminder', { hasText: title })).toBeVisible();

  // Cancelling the event takes the reminder with it (S3's cascade).
  await row.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(600);
  await expect(page.locator('.tsk-reminder', { hasText: title })).toHaveCount(0);

  expect(eventId).toMatch(/\S/);
});
