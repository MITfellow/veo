import { expect, test } from '@playwright/test';
import { startFresh } from './fixture';

/**
 * The product, end to end: a browser, the Veo UI, and the real agent
 * process on a real SQLite file. Nothing here is stubbed. If the proxy, the
 * SSE parser, the run loop, the capability gate or the event log is broken,
 * this is the test that notices.
 *
 * The agent runs offline (no API key in CI), which is deliberate: the
 * assertions are about the machinery, not about a model's prose.
 */
test.beforeEach(async ({ page }) => {
  await startFresh(page);
  await page.goto('/');
  await page.waitForTimeout(300);
});

async function openAgent(page: import('@playwright/test').Page) {
  await page.locator('.conv-row', { hasText: 'Agent' }).click();
  await expect(page.locator('.field textarea').first()).toBeVisible();
}

async function say(page: import('@playwright/test').Page, text: string) {
  const field = page.locator('.field textarea').first();
  await field.click();
  await field.fill(text);
  await page.keyboard.press('Enter');
}

test('the agent is there on a fresh install and answers a real turn', async ({ page }) => {
  await openAgent(page);
  await say(page, 'hello');

  const reply = page.locator('.bubble.in').first();
  await expect(reply).toBeVisible({ timeout: 20_000 });
  // It has no model, and it says so instead of improvising.
  await expect(reply).toContainText('without a language model');
});

test('asking the time really calls a tool and comes back with today', async ({ page }) => {
  await openAgent(page);
  await say(page, 'what time is it?');

  const reply = page.locator('.bubble.in').first();
  await expect(reply).toBeVisible({ timeout: 20_000 });
  // The clock tool, through the capability gate, on the real system clock.
  await expect(reply).toContainText(new Date().getUTCFullYear().toString());
});

test('the conversation survives a reload, because the agent owns the history', async ({ page }) => {
  await openAgent(page);
  await say(page, 'remember me');
  await expect(page.locator('.bubble.in').first()).toBeVisible({ timeout: 20_000 });

  await page.reload();
  await page.waitForTimeout(500);
  await openAgent(page);
  await expect(page.locator('.bubble.out').first()).toContainText('remember me');
});

test('a dead agent is reported, not swallowed', async ({ page }) => {
  // Break the route the client uses. The UI must say what happened and how
  // to fix it rather than leaving a message stuck on "sending".
  await page.route('**/agent/**', (route) => route.abort());
  await openAgent(page);
  await say(page, 'anyone home?');

  await expect(page.locator('.system-note').first()).toContainText('npm run agent', {
    timeout: 15_000,
  });
});
