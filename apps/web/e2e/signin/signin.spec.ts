import { expect, test, type Page } from '@playwright/test';
import { asMigrator } from '../helpers';

// The sign-in screen typed into for real, in a browser (ADR 161). Cognito is the stand-in in
// fake-cognito.mjs (the signin project's server talks to it), so every step runs the app's
// own code end to end: the form, the server action, the calls to Cognito's user API, the ID
// token check, finding the person, the session cookie and the redirect to Home. A sign-in
// that works must land on Home: the first live sign-ins read "Sign-in failed" instead.

const FAKE = `http://127.0.0.1:${process.env.FAKE_COGNITO_PORT ?? 3109}`;
// the stand-in's logins, each tied to a seeded person for these tests only
const PEOPLE = [
  { sub: '00000000-0000-4000-8000-0000000000a1', name: 'Test General Manager 1.0' }, // gm.signin
  { sub: '00000000-0000-4000-8000-0000000000a2', name: 'Test Bar Manager 3.0' }, // new.signin
  { sub: '00000000-0000-4000-8000-0000000000a3', name: 'Test General Manager 2.0' }, // code@signin.test
];

test.use({ viewport: { width: 380, height: 800 } });

test.beforeAll(async () => {
  for (const p of PEOPLE) {
    await asMigrator(
      `update core.app_user set cognito_sub = $1 where display_name = $2 and kind = 'human'`,
      [p.sub, p.name],
    );
  }
});

test.afterAll(async () => {
  await asMigrator(`update core.app_user set cognito_sub = null where cognito_sub = any($1)`, [
    PEOPLE.map((p) => p.sub),
  ]);
});

test.beforeEach(async ({ request }) => {
  expect((await request.post(`${FAKE}/__reset`)).ok()).toBe(true);
});

async function typeLogin(page: Page, login: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Login ID or email').fill(login);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function expectHome(page: Page, name: string) {
  await page.waitForURL((u) => u.pathname === '/');
  await expect(page.getByTestId('sign-in-form')).toHaveCount(0);
  await expect(page.getByText(name).first()).toBeVisible();
}

test('the right password lands on Home', async ({ page }) => {
  await typeLogin(page, 'gm.signin', 'Right-pass-123');
  await expectHome(page, 'Test General Manager 1.0');
});

test('a login takes no spaces, and the password can be shown (ADR 163)', async ({ page }) => {
  await page.goto('/login');
  const login = page.getByLabel('Login ID or email');
  await login.pressSequentially(' gm. signin ');
  await expect(login).toHaveValue('gm.signin');
  const password = page.getByLabel('Password', { exact: true });
  await password.fill('Right-pass-123');
  await expect(password).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(password).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Hide password' }).click();
  await expect(password).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expectHome(page, 'Test General Manager 1.0');
});

test('a wrong password says so and stays on sign-in', async ({ page }) => {
  await typeLogin(page, 'gm.signin', 'Wrong-pass-123');
  await expect(page.getByTestId('sign-in-form').getByRole('alert')).toHaveText(
    'That login or password is wrong. Try again.',
  );
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel('Login ID or email')).toHaveValue('gm.signin');
});

test('an emailed code signs in; a wrong code says so', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Login ID or email').fill('code@signin.test');
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.getByText('We sent a code to c***@s***')).toBeVisible();
  await page.getByLabel('Code from the email').fill('111111');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('sign-in-form').getByRole('alert')).toHaveText(
    'That code is wrong or too old. Ask for a new one.',
  );
  await page.getByLabel('Code from the email').fill('246810');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expectHome(page, 'Test General Manager 2.0');
});

test('a first sign-in chooses its own password, then lands on Home', async ({ page }) => {
  await typeLogin(page, 'new.signin', 'Temp-pass-123');
  await expect(page.getByText('Welcome, new.signin. Choose your own password.')).toBeVisible();
  await page.getByLabel('New password').fill('My-own-pass-456');
  await page.getByLabel('Type it again').fill('My-own-pass-456');
  await page.getByRole('button', { name: 'Save and sign in' }).click();
  await expectHome(page, 'Test Bar Manager 3.0');
});

test('Forgot password: the code and a new password, then sign in with it', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Login ID or email').fill('gm.signin');
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await page.getByRole('button', { name: 'Email me a reset code' }).click();
  await page.getByLabel('Code from the email').fill('135790');
  await page.getByLabel('New password').fill('Fresh-pass-789');
  await page.getByLabel('Type it again').fill('Fresh-pass-789');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByTestId('sign-in-form').getByRole('status')).toHaveText(
    'Your password is changed. Sign in with it now.',
  );
  await page.getByLabel('Password', { exact: true }).fill('Fresh-pass-789');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expectHome(page, 'Test General Manager 1.0');
});
