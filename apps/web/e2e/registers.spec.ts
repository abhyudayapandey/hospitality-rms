import { expect, test, type Page } from '@playwright/test';
import { asMigrator, signInAs } from './helpers';

// Registers (ADR 090) at 380 px on Test Hotel 1.0. The security guard signs a visitor in and
// out; the front desk logs a wallet found in a room and returns it. Who keeps which register
// is proved in packages/db/src/registers.db.test.ts.

test.use({ viewport: { width: 380, height: 900 } });

const main = (page: Page) => page.locator('main');

test('a visitor in and out at the gate; a wallet found and returned at the desk', async ({
  page,
}) => {
  const visitor = `R. Mehta ${Date.now()}`;
  const wallet = `Black wallet ${Date.now()}`;
  try {
    await signInAs(page, 'Test Security Guard 1.0');
    await page.goto('/registers');
    await main(page).getByTestId('register-tabs').getByRole('link', { name: 'Visitors' }).click();
    await main(page).getByLabel('Name').fill(visitor);
    await main(page).getByLabel('Visiting (optional)').fill('Chief engineer');
    await main(page).getByRole('button', { name: 'Add to the register' }).click();
    const entry = main(page).getByTestId('register-entry').filter({ hasText: visitor });
    await expect(entry).toHaveAttribute('data-status', 'open');
    await entry.getByRole('button', { name: 'Left' }).click();
    await expect(
      main(page).getByTestId('register-entry').filter({ hasText: visitor }),
    ).toHaveAttribute('data-status', 'closed');

    await signInAs(page, 'Test Front Desk Executive 1.0');
    await page.goto('/registers');
    await main(page).getByLabel('What was found').fill(wallet);
    await main(page).getByLabel('Where it was found (optional)').fill('Room 102');
    await main(page).getByRole('button', { name: 'Add to the register' }).click();
    const found = main(page).getByTestId('register-entry').filter({ hasText: wallet });
    await found.getByLabel('To whom, and their ID').fill('Guest of 102, passport seen');
    await found.getByRole('button', { name: 'Close it' }).click();
    await expect(
      main(page).getByTestId('register-entry').filter({ hasText: wallet }),
    ).toContainText('Returned to the owner (Guest of 102, passport seen)');
  } finally {
    await asMigrator(
      `delete from ops.register_entry where fields ->> 'name' = $1 or fields ->> 'item' = $2`,
      [visitor, wallet],
    );
  }
});
