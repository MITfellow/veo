import { expect, test, type Page } from '@playwright/test';
import { startFresh } from './fixture';

/**
 * The surfaces the runtime had and the UI did not.
 *
 * Every assertion here is on something that worked on the server for
 * milestones before a person could reach it: the vault, the log, the
 * trace behind an answer, and the ability to stop a run. The point of
 * testing them in a browser rather than against the API is that the API
 * was already green the whole time it was unreachable.
 */
test.beforeEach(async ({ page }) => {
  await startFresh(page);
  await page.goto('/');
  await page.waitForTimeout(300);
});

async function openSettings(page: Page, isMobile: boolean) {
  if (isMobile) {
    // On mobile the Settings button lives only in the list pane.
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
  // Wait for the vault to have *answered*, not merely rendered: before
  // the first response it reports nothing, on purpose.
  await expect(page.locator('.vlt-state[data-loaded="true"]')).toBeVisible({ timeout: 10_000 });
}

/* ───────────────────────────── §13 the vault ──────────────────────────── */

/**
 * One agent process and one database serve every test in the file, so a
 * keyring created by an earlier test is still there for a later one.
 * These tests are written to be true whatever order they run in: they
 * drive the vault to the state they need rather than assuming it.
 */
const PASSPHRASE = 'correct horse battery staple';

async function unlocked(page: Page) {
  const state = page.getByTestId('vault-state');
  if ((await state.innerText()).includes('Unlocked')) return;

  const creating = (await state.innerText()).includes('No vault yet');
  await page.getByLabel('Vault passphrase').fill(PASSPHRASE);
  await page
    .getByRole('button', { name: creating ? 'Create the vault' : 'Unlock' })
    .click();
  await expect(state).toContainText('Unlocked', { timeout: 10_000 });

  // A first unlock shows the recovery code once; dismiss it so it does
  // not sit over the rest of the panel.
  const written = page.getByRole('button', { name: 'I have written it down' });
  if (await written.isVisible()) await written.click();
}

test('the vault reports its state and offers the action that matches it', async ({
  page,
  isMobile,
}) => {
  await openSettings(page, isMobile);

  const state = page.getByTestId('vault-state');
  const text = await state.innerText();
  // Exactly one of three states, and never a status code.
  expect(['No vault yet', 'Locked', 'Unlocked'].filter((s) => text.includes(s))).toHaveLength(1);

  if (text.includes('Unlocked')) {
    await expect(page.getByRole('button', { name: 'Lock it' })).toBeVisible();
  } else {
    // Sealed: nothing to add a secret to, and no list pretending otherwise.
    await expect(page.getByLabel('Vault passphrase')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add a secret' })).toHaveCount(0);
    await expect(page.locator('.vlt-row')).toHaveCount(0);
  }
});

test('a secret can be stored, and its value never comes back out', async ({ page, isMobile }) => {
  await openSettings(page, isMobile);
  await unlocked(page);

  const name = `probe_${Date.now()}`;
  await page.getByRole('button', { name: 'Add a secret' }).click();
  await page.getByLabel('Secret name').fill(name);
  await page.getByLabel('Secret value').fill('sk-live-do-not-leak');
  await page.getByRole('button', { name: 'Store it' }).click();

  const row = page.locator('.vlt-row').filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 10_000 });

  // The whole point: the name is listed, the value is nowhere on the
  // page — not in text, not in an input, not in an attribute.
  await expect(page.locator('body')).not.toContainText('sk-live-do-not-leak');
  expect(await page.content()).not.toContain('sk-live-do-not-leak');

  // Put the database back the way it was found.
  await row.getByRole('button', { name: 'Destroy' }).click();
  await expect(row).toHaveCount(0, { timeout: 10_000 });
});

test('locking hides the secrets from the UI as well as from the agent', async ({
  page,
  isMobile,
}) => {
  await openSettings(page, isMobile);
  await unlocked(page);

  await page.getByRole('button', { name: 'Lock it' }).click();
  const state = page.getByTestId('vault-state');
  await expect(state).toContainText('Locked', { timeout: 10_000 });
  // 423 from the list route is a state the user can fix, not an error.
  await expect(page.locator('.vlt-empty')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add a secret' })).toHaveCount(0);

  await page.getByLabel('Vault passphrase').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(state).toContainText('Unlocked', { timeout: 10_000 });
});

test('destroying the keyring needs the sentence typed, not a click', async ({ page, isMobile }) => {
  await openSettings(page, isMobile);
  await unlocked(page);

  await page.getByRole('button', { name: 'Destroy the keyring' }).click();
  const go = page.getByRole('button', { name: 'Destroy everything' });
  await expect(go).toBeDisabled();

  await page.getByLabel('Type the confirmation').fill('destroy my secret');
  await expect(go, 'one character short is still short').toBeDisabled();

  await page.getByLabel('Type the confirmation').fill('destroy my secrets');
  await expect(go).toBeEnabled();
  // Deliberately not clicked: the assertion is about the gate, and the
  // other tests in this file need a keyring that still exists.
});

/* ───────────────────────────── §30 the log ────────────────────────────── */

test('the log is readable and filters to the kind of thing being asked about', async ({
  page,
  isMobile,
}) => {
  await openSettings(page, isMobile);

  const rows = page.locator('.evt-row');
  await expect(rows.first()).toBeVisible({ timeout: 10_000 });
  // A fresh install has already ratified its constitution, so there is
  // something in the log before anyone has said a word.
  await expect(page.locator('.evt-count')).toContainText('event');

  await page.getByRole('button', { name: 'Safety', exact: true }).click();
  await page.waitForTimeout(400);
  const types = await page.locator('.evt-type').allInnerTexts();
  for (const type of types) {
    expect(
      ['approval.', 'policy.', 'run.degraded'].some((prefix) => type.startsWith(prefix)),
      `${type} is not a safety event`,
    ).toBe(true);
  }

  // Opening a row shows the payload the projections were built from.
  await page.getByRole('button', { name: 'Everything', exact: true }).click();
  await page.waitForTimeout(400);
  await rows.first().locator('.evt-head').click();
  await expect(page.locator('.evt-payload').first()).toBeVisible();
});

test('the log follows along as the agent does something', async ({ page, isMobile }) => {
  await openSettings(page, isMobile);
  await expect(page.locator('.evt-row').first()).toBeVisible({ timeout: 10_000 });

  // Start following, then make something happen. The cursor is what
  // makes this cheap: each tick asks only for what came after the last
  // row, so watching an idle agent costs a query that matches nothing.
  await page.getByTestId('follow-log').click();
  await expect(page.locator('.evt-live')).toContainText('live');

  const before = Number(
    /of (\d+) event/.exec(await page.getByTestId('event-count').innerText())?.[1] ?? '0',
  );

  // A real turn through the real agent, posted from the page so it goes
  // through the same proxy the UI uses.
  await page.evaluate(async () => {
    const session = await fetch('/agent/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'tail' }),
    });
    const { id } = (await session.json()) as { id: string };
    await fetch(`/agent/sessions/${id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'what time is it?' }),
    });
  });

  // No reload, no refresh click: the rows arrive on their own.
  await expect(page.locator('.evt-live')).toContainText('new', { timeout: 20_000 });
  await expect
    .poll(
      async () =>
        Number(
          /of (\d+) event/.exec(await page.getByTestId('event-count').innerText())?.[1] ?? '0',
        ),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(before);

  // And it stops when told to.
  await page.getByTestId('follow-log').click();
  await expect(page.locator('.evt-live')).toHaveCount(0);
});

/* ─────────────────── §30 the trace, §29 stopping a run ────────────────── */

test('an answer can explain itself from the bubble that gave it', async ({ page }) => {
  await page.locator('.conv-row', { hasText: 'Agent' }).click();
  const field = page.locator('.field textarea').first();
  await expect(field).toBeVisible();
  await field.click();
  await field.fill('what time is it?');
  await page.keyboard.press('Enter');

  const why = page.getByRole('button', { name: 'Why did it say that?' }).first();
  await expect(why).toBeVisible({ timeout: 30_000 });
  await why.click();

  const sheet = page.getByRole('dialog', { name: 'Why it said that' });
  await expect(sheet).toBeVisible();
  // The context it was given, block by block, is the answer to "why".
  await expect(sheet).toContainText('What it was told');
  await expect(sheet.locator('.trc-block-name').first()).toBeVisible();
  // And the constitution gate ran before any model call (decision 032).
  await expect(sheet).toContainText('kernel');

  await sheet.getByRole('button', { name: 'Show the full text' }).click();
  await expect(sheet.locator('.trc-pre')).toContainText('run');
});
