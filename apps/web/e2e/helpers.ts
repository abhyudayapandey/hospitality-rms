import { expect, type Page } from '@playwright/test';

export async function devLogin(page: Page, name: string): Promise<void> {
  await page.goto('/dev-login');
  await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
  await expect(page.getByTestId('current-user')).toHaveText(name);
}
