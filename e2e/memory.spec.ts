import { expect, test, type Page } from '@playwright/test';
import { startFresh } from './fixture';

/**
 * §22.8 in a browser: can a person actually see what the agent knows about
 * them, and actually destroy it?
 *
 * The spec's argument for this screen is a claim about trust — "a person
 * only lets an agent this deep into their life if they can see and rip out
 * what it knows" — and a claim about trust is worth testing through the
 * same clicks a person would make, not through the HTTP layer underneath.
 */
/**
 * The agent's database is shared across the whole e2e run, so each test
 * starts by destroying everything it knows. Done through the same endpoint
 * the "Forget everything" button calls, which means the cleanup is itself a
 * continuous test of the most consequential control in the panel.
 */
test.beforeEach(async ({ page, request }) => {
  await request.delete('http://127.0.0.1:7777/memory?subject=self', {
    headers: { authorization: 'Bearer dev-token' },
  });
  await startFresh(page);
  await page.goto('/');
  await page.waitForTimeout(300);
});

async function tell(page: Page, text: string) {
  await page.locator('.conv-row', { hasText: 'Agent' }).click();
  const field = page.locator('.field textarea').first();
  await field.click();
  await field.fill(text);
  await page.keyboard.press('Enter');
  // The reply means the run finished; learning happens just after it.
  await expect(page.locator('.bubble.in').first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(600);
}

/**
 * On mobile the thread fills the screen and the settings button lives in
 * the list pane, so step back out of the conversation first.
 */
async function openMemory(page: Page, isMobile: boolean) {
  if (isMobile) {
    await page.evaluate(async () => {
      const env = await window.__store.read();
      if (env === null) return;
      env.state.activeChatId = null;
      await window.__store.write(env);
    });
    await page.reload();
  }
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('.mem-tabs')).toBeVisible();
}

test('what you tell the agent shows up in the memory panel, with its provenance', async ({ page, isMobile }) => {
  await tell(page, 'My name is Ara and I work at Anthropic');
  await openMemory(page, isMobile);

  const rows = page.locator('.mem-row');
  await expect(rows.filter({ hasText: 'Anthropic' })).toHaveCount(1);

  // Never a bare sentence: the row says where it came from and how sure it
  // is, because a 42% guess must not look like something you said.
  const row = rows.filter({ hasText: 'Anthropic' }).first();
  await expect(row).toContainText('you told me');
  await expect(row).toContainText('% sure');
  await expect(row).toContainText('1 source');
});

test('"Why?" shows the exact words a belief came from', async ({ page, isMobile }) => {
  await tell(page, 'I am allergic to peanuts');
  await openMemory(page, isMobile);

  const row = page.locator('.mem-row').filter({ hasText: 'peanuts' }).first();
  await row.locator('.mem-btn', { hasText: 'Why?' }).dispatchEvent('click');

  const why = page.locator('.mem-why').first();
  await expect(why).toBeVisible();
  await expect(why).toContainText('You told me this on');
  await expect(why).toContainText('I am allergic to peanuts');
  await expect(why).toContainText('% sure');
});

test('a memory can be corrected, and the mistake stays on the record', async ({ page, isMobile }) => {
  await tell(page, 'I work at Anthropic');
  await openMemory(page, isMobile);

  const row = page.locator('.mem-row').filter({ hasText: 'Anthropic' }).first();
  await row.locator('.mem-btn', { hasText: 'Correct' }).dispatchEvent('click');
  await page.locator('.mem-correct input').fill('Globex');
  await page.locator('.mem-correct button').dispatchEvent('click');

  await expect(page.locator('.mem-row').filter({ hasText: 'Globex' })).toHaveCount(1);

  // The old belief is not erased — switch to Everything and it is there,
  // marked. An agent that quietly rewrites its own history is worse than
  // one that was wrong.
  await page.locator('.mem-tab', { hasText: 'Everything' }).click();
  await expect(page.locator('.mem-list')).toContainText('Anthropic');
});

test('forgetting a memory removes it from what the agent knows', async ({ page, isMobile }) => {
  await tell(page, 'I am allergic to peanuts');
  await openMemory(page, isMobile);

  await page
    .locator('.mem-row')
    .filter({ hasText: 'peanuts' })
    .first()
    .locator('.mem-btn', { hasText: 'Forget' })
    .dispatchEvent('click');

  await expect(page.locator('.mem-row').filter({ hasText: 'peanuts' })).toHaveCount(0);
});

test('pinning a memory marks it as always in context', async ({ page, isMobile }) => {
  await tell(page, 'My name is Ara');
  await openMemory(page, isMobile);

  const row = page.locator('.mem-row').filter({ hasText: 'Ara' }).first();
  await row.locator('.mem-btn', { hasText: 'Pin' }).dispatchEvent('click');
  await expect(page.locator('.mem-row').filter({ hasText: 'Ara' }).first()).toContainText('PINNED');

  await page.locator('.mem-tab', { hasText: 'Pinned' }).click();
  await expect(page.locator('.mem-row')).toHaveCount(1);
});

test('the panel is honest when the agent knows nothing yet', async ({ page, isMobile }) => {
  await openMemory(page, isMobile);
  await expect(page.locator('.mem-empty')).toContainText('Nothing here yet');
});
