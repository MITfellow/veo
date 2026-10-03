import { expect, test } from '@playwright/test';
import { startFresh } from './fixture';

test.beforeEach(async ({ page }) => {
  await startFresh(page);
  await page.goto('/');
  await page.waitForTimeout(300);
});

test('a fresh install has no conversations and no messages', async ({ page }) => {
  // The agent is pinned and waiting; nothing else exists. "Empty" means no
  // invented history, not an app with nothing in it.
  await expect(page.locator('.pinned-item')).toHaveCount(0);
  await expect(page.locator('.conv-row')).toHaveCount(1);
  // The agent's row by its role, not by its name: the name is settable
  // (decision 043) and this assertion is about the row existing on a
  // fresh install, not about what it happens to be called.
  await expect(page.locator('.conv-row.conv-agent')).toHaveCount(1);
  await expect(page.locator('.bubble')).toHaveCount(0);
  await expect(page.getByText('No Conversations')).toBeVisible();
  // Read the persisted envelope, not React state — but wait for the
  // write rather than assuming the 300ms above covered it. The save is
  // debounced, so on a loaded machine the assertion could run against
  // an envelope that had not been flushed yet and see an empty store.
  // Polling keeps the claim identical and stops it depending on timing.
  await expect
    .poll(
      async () => {
        const stored = await page.evaluate(
          async () => (await window.__store.read())?.state ?? null,
        );
        return (stored?.chats ?? []).map((c: { id: string }) => c.id);
      },
      { timeout: 10_000 },
    )
    .toEqual(['c-agent']);

  const stored = await page.evaluate(async () => (await window.__store.read())?.state ?? null);
  expect(stored?.messages ?? []).toEqual([]);
});

test('the contact directory is still there to write to', async ({ page }) => {
  await page.locator('.efr-cta').click();
  await expect(page.getByPlaceholder('To: name or number')).toBeVisible();
  expect(await page.locator('.contact-pick').count()).toBeGreaterThan(3);
});

test('starting the first conversation works end to end', async ({ page }) => {
  await page.locator('.efr-cta').click();
  await page.locator('.contact-pick', { hasText: 'Maya Fernandez' }).click();
  await page.getByRole('button', { name: 'Start Chat' }).click();

  const field = page.locator('.field textarea').first();
  await field.click();
  await field.fill('first message on a fresh install');
  await page.keyboard.press('Enter');

  await expect(page.locator('.bubble.out')).toHaveCount(1);
  // the new thread, plus the agent's own
  await expect(page.locator('.conv-row')).toHaveCount(2);
  // the persona engine answers a brand-new thread too
  await expect(page.locator('.bubble.in').first()).toBeVisible({ timeout: 20_000 });
});

test('Reset Data empties the app again', async ({ page, isMobile }) => {
  await page.locator('.efr-cta').click();
  // The agent's own card is in this list too; pick a person.
  await page.locator('.contact-pick', { hasText: 'Maya Fernandez' }).click();
  await page.getByRole('button', { name: 'Start Chat' }).click();
  await expect(page.locator('.conv-row')).toHaveCount(2);

  page.once('dialog', (d) => d.accept());
  // the phone layout is on the thread pane after starting a chat
  if (isMobile) {
    await page.locator('.back-btn').click();
    await page.waitForTimeout(300);
  }
  // Named, not positional. `.icon-btn').first()` was right only by
  // accident: S4 added a notification bell to the same row, and when
  // one is outstanding the first icon button is no longer Settings.
  // Fourth time this exact shape has broken a test here.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Reset Data' }).click();
  await expect(page.getByText('No Conversations')).toBeVisible();
  await expect(page.locator('.conv-row')).toHaveCount(1);
});
