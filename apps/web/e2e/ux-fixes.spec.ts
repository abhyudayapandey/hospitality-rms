import { expect, test } from '@playwright/test';
import { asMigrator, placeId, signInAs } from './helpers';

// The audit's first fixes (ADR 098), at 380 px: a banquet server, who holds no stock access,
// reads an event's supplies by name and unit; the header puts the job under the name, whole.

test.use({ viewport: { width: 380, height: 900 } });

test("a banquet server reads the event's supplies by name", async ({ page }) => {
  const hotel = await placeId('TEST-HOTEL-1.0');
  const [ev] = await asMigrator<{ id: string }>(
    `insert into ops.event (tenant_id, org_node_id, name, starts_at, ends_at, covers, status)
     select n.tenant_id, n.id, 'Audit gala', now() + interval '2 days',
            now() + interval '2 days 3 hours', 40, 'confirmed'
       from core.hierarchy_node n where n.id = $1
     returning id`,
    [hotel],
  );
  await asMigrator(
    `insert into ops.event_requirement (tenant_id, event_id, org_node_id, kind, item_id, qty)
     select e.tenant_id, e.id, e.org_node_id, 'item', i.id, 12
       from ops.event e
       join inv.item i on i.tenant_id = e.tenant_id and i.name = 'Test Milk'
      where e.id = $1`,
    [ev!.id],
  );
  try {
    await signInAs(page, 'Test Banquet Server 1.0');
    await page.goto(`/events/${ev!.id}`);
    const lines = page.getByTestId('event-requirements');
    await expect(lines).toContainText('Test Milk');
    await expect(lines).not.toContainText('Item ·');
    // the header: the name on its own line, the job under it, both whole
    const name = page.getByTestId('current-user');
    const role = page.getByTestId('current-role');
    await expect(role).toHaveText('Banquet Server');
    const [n, r] = [(await name.boundingBox())!, (await role.boundingBox())!];
    expect(r.y).toBeGreaterThan(n.y);
    // the job is never cut short; a long place name gives way first
    expect(await role.evaluate((x) => x.scrollWidth <= x.clientWidth + 1)).toBe(true);
  } finally {
    await asMigrator(`delete from ops.event_requirement where event_id = $1`, [ev!.id]);
    await asMigrator(`delete from ops.event where id = $1`, [ev!.id]);
  }
});
