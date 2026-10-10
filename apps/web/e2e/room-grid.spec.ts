import { expect, test, type Page } from '@playwright/test';
import { asMigrator, signInAs } from './helpers';

// A round for each room, and each room's status (ADR 088), at 380 px on Test Hotel 1.0. The
// front desk marks a room arriving on the Rooms screen; the room attendant's room check is a
// grid, a row per room, where she also sets the room's status. Who may is proved in
// packages/db/src/room-grid.db.test.ts.

test.use({ viewport: { width: 380, height: 900 } });

const main = (page: Page) => page.locator('main');

async function roomCheck(): Promise<string> {
  const [t] = await asMigrator<{ id: string }>(
    `insert into ops.task (tenant_id, org_node_id, kind, title, due_at, assign_mode,
                           job_role_code, template_id)
     select c.tenant_id, c.org_node_id, 'checklist', c.name,
            date_trunc('second', now()) + interval '1 hour' + random() * interval '1000 seconds',
            'job_role', 'ROOM_ATTENDANT', c.id
       from ops.checklist_template c where c.code = 'HOTEL-1.0-HK-ROOM-CHECK'
     returning id`,
    [],
  );
  await asMigrator(
    `select ops.add_round_steps(t, c.steps, c.for_each) from ops.task t, ops.checklist_template c
      where t.id = $1 and c.id = t.template_id`,
    [t!.id],
  );
  return t!.id;
}

test('the front desk marks a room arriving; the attendant checks it on the grid', async ({
  page,
}) => {
  const task = await roomCheck();
  try {
    await signInAs(page, 'Test Front Desk Executive 1.0');
    await page.goto('/rooms');
    // a tile per room, its colour and picture the status; tap it, tap the new one (ADR 104)
    const room = main(page).locator('[data-testid="room"][data-room="101"]');
    await expect(room).not.toContainText('VC');
    await room.click();
    const sheet = page.getByTestId('room-sheet');
    await expect(sheet).not.toContainText(/VC|VD|OCC|ARR/);
    await sheet.getByRole('button', { name: 'Arriving' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(main(page).locator('[data-testid="room"][data-room="101"]')).toHaveAttribute(
      'data-status',
      'ARR',
    );
    await expect(page.getByTestId('room-counts')).toContainText('1 arriving');

    await signInAs(page, 'Test Room Attendant 1.0');
    await page.goto(`/tasks/${task}`);
    const row = main(page).locator('[data-testid="grid-row"][data-row="101"]');
    await expect(row.locator('summary').first()).toContainText('Arriving · 0 of 3');
    await row.getByTestId('room-status').locator('summary').click();
    await row.getByRole('button', { name: 'Dirty' }).click();
    await expect(row.locator('summary').first()).toContainText('Dirty');
    await expect(row.locator('summary').first()).not.toContainText('VD');
    await row
      .getByTestId('step')
      .filter({ hasText: 'Bed made' })
      .getByRole('button', { name: 'Done' })
      .click();
    await row.getByLabel('101: Bath towels').fill('2');
    await row.getByRole('button', { name: 'Save' }).click();
    await row
      .getByTestId('step')
      .filter({ hasText: 'Toiletries topped up' })
      .getByRole('button', { name: 'Done' })
      .click();
    await expect(row.locator('summary').first()).toContainText('✓ done');
    // the next room is open now
    await expect(main(page).locator('[data-testid="grid-row"][data-row="102"]')).toHaveAttribute(
      'open',
      '',
    );
  } finally {
    await asMigrator(`delete from ops.task_step where task_id = $1`, [task]);
    await asMigrator(`delete from ops.task where id = $1`, [task]);
    await asMigrator(
      `delete from ops.room_status where room_id in (
         select id from ops.room where number = '101'
            and org_node_id = (select id from core.hierarchy_node where code = 'TEST-HOTEL-1.0'))`,
      [],
    );
  }
});
