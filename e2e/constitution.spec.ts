import { expect, test, type Page } from '@playwright/test';
import { startFresh } from './fixture';

/**
 * §25 in a browser: can a person read the terms their agent works under,
 * change them, and see whether they were kept?
 *
 * Tested through the clicks rather than the API for the same reason §22.8
 * is: a contract that exists only on the wire is the agent's private note
 * about itself. The one that matters most here is the entrenchment test —
 * the agent must refuse to let the document claim something its code does
 * not do, and it must say so in words rather than by doing nothing.
 */

test.beforeEach(async ({ page, request }) => {
  // Reset the user's half of the document; the founding charter is not
  // removable and does not need resetting.
  const doc = await request.get('http://127.0.0.1:7777/constitution', {
    headers: { authorization: 'Bearer dev-token' },
  });
  const body = (await doc.json()) as { articles: { id: string; origin: string }[] };
  for (const article of body.articles.filter((a) => a.origin === 'user')) {
    await request.delete(`http://127.0.0.1:7777/constitution/articles/${article.id}`, {
      headers: { authorization: 'Bearer dev-token' },
    });
  }
  await startFresh(page);
  await page.goto('/');
  await page.waitForTimeout(300);
});

async function openConstitution(page: Page, isMobile: boolean) {
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
  await expect(page.locator('.con-head')).toBeVisible();
}

test('the charter is visible, and every article says how it is kept', async ({ page, isMobile }) => {
  await openConstitution(page, isMobile);

  const rows = page.locator('.con-row');
  await expect(rows.filter({ hasText: 'F1' }).first()).toContainText('Enforced in code');
  await expect(rows.filter({ hasText: 'F7' }).first()).toContainText('Checked after every answer');

  // A checked article publishes its blind spots next to it. An article
  // claiming more enforcement than it has is the same lie as a confidence
  // number nobody calibrated.
  await expect(rows.filter({ hasText: 'F7' }).first()).toContainText('does not catch');
});

test('an entrenched article cannot be removed, and the refusal explains itself', async ({ page, isMobile }) => {
  await openConstitution(page, isMobile);

  const f1 = page.locator('.con-row').filter({ hasText: 'F1' }).first();
  await expect(f1).toContainText('cannot be removed');
  // No button at all, rather than a button that fails: the UI does not
  // offer an action the system will refuse.
  await expect(f1.getByRole('button', { name: 'Remove' })).toHaveCount(0);
});

test('an article you write outranks the agent’s own, visibly', async ({ page, isMobile }) => {
  await openConstitution(page, isMobile);

  const input = page.getByLabel('New article');
  await input.fill('Never answer with bullet points.');
  // Scoped to this panel's own form. The Settings sheet is one long
  // column and S2's to-do list added a second "Add" button to it —
  // an unscoped role locator was only ever right by accident.
  await page.locator('.con-add').getByRole('button', { name: 'Add', exact: true }).dispatchEvent('click');

  const mine = page.locator('.con-row').filter({ hasText: 'Never answer with bullet points.' });
  await expect(mine).toHaveCount(1);
  await expect(mine.first()).toContainText('Stated, not checked');

  // And it can be taken back out again.
  await mine.first().getByRole('button', { name: 'Remove' }).dispatchEvent('click');
  await expect(
    page.locator('.con-row').filter({ hasText: 'Never answer with bullet points.' }),
  ).toHaveCount(0);
});

test('the compliance tab counts what the checks found, including what they could not tell', async ({
  page,
  isMobile,
}) => {
  // Say something so a real model call is judged by the real gate.
  await page.locator('.conv-agent').click();
  const field = page.locator('.field textarea').first();
  await field.click();
  await field.fill('what time is it');
  await page.keyboard.press('Enter');
  await expect(page.locator('.bubble.in').first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500);

  await openConstitution(page, isMobile);
  await page.getByRole('tab', { name: 'Kept?' }).dispatchEvent('click');

  const counts = page.locator('.con-counts').first();
  await expect(counts).toBeVisible();
  await expect(counts).toContainText('kept');
  // "Couldn't tell" is its own number and is never folded into a pass.
  await expect(counts).toContainText("couldn't tell");
});

test('the change log records every amendment', async ({ page, isMobile }) => {
  await openConstitution(page, isMobile);
  await page.getByRole('tab', { name: 'Changes' }).dispatchEvent('click');
  await expect(page.locator('.con-row').filter({ hasText: 'ratified' })).toHaveCount(1);
});
