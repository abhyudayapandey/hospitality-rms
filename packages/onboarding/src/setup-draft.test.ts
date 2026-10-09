import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv';
import { readBundle } from './files';
import {
  coverLines,
  customerCodeFrom,
  draftBundles,
  draftProblems,
  emptyDraft,
  filesFromDraft,
  logins,
  outletCodes,
  peopleFromPaste,
  planFromDraft,
  readDraft,
  roleQuestions,
  stepOfFile,
  warningsInWords,
  whoDoesWhat,
  type SetupDraft,
} from './setup-draft';

// The set-up wizard's draft (ADR 064): choices in plain words become the customer's complete
// onboarding files, which then go through the usual dry run.

function cafe(): SetupDraft {
  const d = emptyDraft();
  d.company = {
    ...d.company,
    name: 'Blue Bean Cafés',
    ownerName: 'Asha Rao',
    ownerEmail: 'asha@bluebean.test',
  };
  d.outlets.push({
    ...readDraft({ outlets: [{ key: 'a', tile: 'cafe' }] }).outlets[0]!,
    name: 'Bandra Café',
    location: '19.0596, 72.8295',
  });
  return d;
}

/** A hotel with a pool, its company code GH, the outlet One (GH-ONE). */
function hotel(): SetupDraft {
  const d = emptyDraft();
  d.company = {
    ...d.company,
    name: 'Grand Hotels',
    code: 'GH',
    ownerName: 'Asha Rao',
    ownerEmail: 'asha@grand.test',
  };
  d.outlets.push({
    ...readDraft({ outlets: [{ key: 'h', tile: 'hotel', extras: ['pool'] }] }).outlets[0]!,
    name: 'One',
    location: '19.0596, 72.8295',
  });
  return d;
}

const rows = (files: Record<string, string>, prefix: string) => {
  const f = Object.keys(files).find((n) => n.startsWith(prefix));
  return f ? parseCsv(files[f]!).rows.map((r) => r.values) : [];
};

describe('the set-up draft', () => {
  it('reads any saved draft, filling defaults; nonsense starts again', () => {
    expect(readDraft({}).company.timezone).toBe('Asia/Kolkata');
    expect(readDraft({ outlets: 'x' }).outlets).toEqual([]);
    expect(readDraft(null).people).toEqual([]);
  });

  it('makes codes from names; nobody types one', () => {
    expect(customerCodeFrom('Blue Bean Cafés')).toBe('BLUE-BEAN');
    expect(customerCodeFrom('Ö')).toBe('OCO');
    const d = cafe();
    d.outlets.push({ ...d.outlets[0]!, key: 'b' });
    expect([...outletCodes(d).values()]).toEqual([
      'BLUE-BEAN-BANDRA-CAFE',
      'BLUE-BEAN-BANDRA-CAFE-2',
    ]);
    // an outlet named like its company is not BLUE-BEAN-BLUE-BEAN
    d.outlets[0]!.name = 'Blue Bean';
    d.outlets[1]!.name = 'Blue Bean Bandra';
    expect([...outletCodes(d).values()]).toEqual(['BLUE-BEAN-MAIN', 'BLUE-BEAN-BANDRA']);
  });

  it("says the dry run's warnings with names, never codes", () => {
    const d = cafe();
    d.people.push({ name: 'Ravi Kumar', email: '', role: 'BARISTA', outlet: 'a' });
    const outlet = outletCodes(d).get('a')!;
    const ravi = logins(d)[0]!.username;
    const said = warningsInWords(d, [
      `nobody at ${outlet} is a HEAD_COOK yet, so nobody does KITCHEN_STEWARD's work`,
      `nobody at ${outlet} is a HEAD_COOK yet, so nobody does KITCHEN_STEWARD's work`,
      `${ravi}: LEAVE (manager_approval) at ${outlet} has no approver but them: their request would fail (NO_APPROVER)`,
      `blue-bean.owner: LEAVE (hr_approval, manager_approval) at BLUE-BEAN has no approver but them: approved at the top of the chain (account owner)`,
      `blue-bean.owner: SHIFT_SWAP (manager_approval) at BLUE-BEAN has no approver but them: approved at the top of the chain (account owner)`,
      `blue-bean.owner: STORE_KEEPER at ${outlet} also reaches 1 other stock location through the places below it: X. Add "(this store only)" if they work at ${outlet} only`,
    ]);
    expect(said).toEqual([
      "nobody at Bandra Café is a Head Cook yet, so nobody does Kitchen Steward's work",
      'Asha Rao: Store Keeper at Bandra Café also reaches 1 other stock location through the places below it: X',
      "Ravi Kumar's own leave requests have nobody above them to approve: they will be refused until someone above them is set up",
      "Asha Rao's own leave and shift swap requests have nobody above them to approve: they go through at once, as the account owner",
    ]);
    expect(said.join(' ')).not.toMatch(/[A-Z]+_[A-Z]+|BLUE-BEAN|blue-bean/);
  });

  it('says what is missing, at the screen to fix it on', () => {
    const d = emptyDraft();
    const steps = draftProblems(d).map((p) => p.step);
    expect(steps).toEqual(expect.arrayContaining(['company', 'outlets']));
    const c = cafe();
    c.people.push({ name: 'Ravi', email: 'not-an-email', role: 'BARISTA', outlet: 'a' });
    c.people.push({ name: 'Meena', email: '', role: '', outlet: 'a' });
    expect(draftProblems(c)).toEqual([
      { step: 'people', row: 1, message: 'Row 1: not-an-email is not an email' },
      { step: 'people', row: 2, message: 'Row 2: pick a role for Meena' },
    ]);
  });

  it('a café becomes files the loader reads, with its location, people and par', () => {
    const d = cafe();
    const role = roleQuestions(d, d.outlets[0]!).find((q) => q.code === 'BARISTA');
    expect(role?.title).toBe('Barista');
    d.people.push(
      { name: 'Ravi Kumar', email: '', role: 'BARISTA', outlet: 'a' },
      { name: 'Ravi K', email: 'ravi@bluebean.test', role: 'BARISTA', outlet: 'a' },
    );
    d.outlets[0]!.stock['KITCHEN:MILK'] = { off: false, par: '12' };
    d.outlets[0]!.stock['KITCHEN:SALT'] = { off: true, par: '' };
    d.outlets[0]!.ownItems.push({ department: 'KITCHEN', name: 'Oat milk', unit: 'l', par: '6' });
    const files = filesFromDraft(d);
    const { issues } = readBundle(files);
    expect(issues).toEqual([]);
    expect(rows(files, '04_')).toEqual([
      {
        org_node_code: 'BLUE-BEAN-BANDRA-CAFE',
        latitude: '19.0596',
        longitude: '72.8295',
        geofence_radius_m: '150',
      },
    ]);
    const users = rows(files, '07_');
    expect(users.map((u) => [u['username'], u['login_type'], u['home_node_code']])).toEqual([
      ['blue-bean.owner', 'email', 'BLUE-BEAN'],
      ['blue-bean.ravi.kumar', 'username', 'BLUE-BEAN-BANDRA-CAFE-COUNTER'],
      ['blue-bean.ravi.k', 'email', 'BLUE-BEAN-BANDRA-CAFE-COUNTER'],
    ]);
    const placed = rows(files, '11_');
    expect(placed.find((r) => r['item_code'] === 'MILK')?.['par_level']).toBe('12');
    expect(placed.some((r) => r['item_code'] === 'SALT')).toBe(false);
    expect(rows(files, '10_').some((r) => r['item_code'] === 'SALT')).toBe(false);
    expect(placed.find((r) => r['item_code'] === 'OAT-MILK')?.['par_level']).toBe('6');
  });

  it('cover answers become file 37, and the lines say what moves', () => {
    const d = cafe();
    d.outlets[0]!.tile = 'restaurant';
    const qs = roleQuestions(d, d.outlets[0]!);
    const sk = qs.find((q) => q.level === 'leads_shift' || q.code === 'STORE_KEEPER');
    const manager = qs.find((q) => q.level === 'runs_outlet')!;
    expect(manager).toBeDefined();
    const covered = qs.find((q) => q.code !== manager.code && q.level === 'runs_department')!;
    d.outlets[0]!.roles[covered.code] = { mode: 'covered_by', by: manager.code };
    if (sk) d.outlets[0]!.roles[sk.code] = { mode: 'not_done' };
    const lines = coverLines(d, d.outlets[0]!);
    expect(lines.find((l) => l.role === covered.code)?.line).toMatch(
      new RegExp(`^The ${manager.title} also does the ${covered.title}'s work: `),
    );
    const files = filesFromDraft(d);
    expect(rows(files, '37_')).toEqual(
      expect.arrayContaining([
        {
          outlet_code: 'BLUE-BEAN-BANDRA-CAFE',
          job_role_code: covered.code,
          mode: 'covered_by',
          covered_by_role: manager.code,
        },
      ]),
    );
    // covered by a role that is itself not here: refused
    d.outlets[0]!.roles[manager.code] = { mode: 'not_done' };
    expect(draftProblems(d).map((p) => p.step)).toContain('roles');
  });

  it('a junior covering a department head is flagged', () => {
    const d = cafe();
    d.outlets[0]!.tile = 'restaurant';
    const qs = roleQuestions(d, d.outlets[0]!);
    const head = qs.find((q) => q.level === 'runs_department')!;
    const junior = qs.find((q) => q.level === 'works')!;
    d.outlets[0]!.roles[head.code] = { mode: 'covered_by', by: junior.code };
    expect(coverLines(d, d.outlets[0]!).find((l) => l.role === head.code)?.warning).toMatch(
      /check that is meant/,
    );
  });

  it('every login ID is unique; people with an email sign in with it', () => {
    const d = cafe();
    d.people.push(
      { name: 'Ravi', email: '', role: 'BARISTA', outlet: 'a' },
      { name: 'Ravi', email: '', role: 'BARISTA', outlet: 'a' },
    );
    expect(logins(d).map((l) => l.username)).toEqual(['blue-bean.ravi', 'blue-bean.ravi.2']);
  });

  it('who does what names each role, its people or who covers it', () => {
    const d = cafe();
    d.people.push({ name: 'Ravi', email: '', role: 'BARISTA', outlet: 'a' });
    const [outlet] = whoDoesWhat(d);
    const barista = outlet!.roles.find((r) => r.code === 'BARISTA')!;
    expect(barista).toMatchObject({ who: 'Ravi', nobody: false });
    expect(outlet!.roles.some((r) => r.nobody)).toBe(true);
  });

  it('maps a loader issue to the screen it is fixed on', () => {
    expect(stepOfFile('00_customer.csv')).toBe('company');
    expect(stepOfFile('02_delivery_nodes.csv')).toBe('outlets');
    expect(stepOfFile('37_role_cover.csv')).toBe('roles');
    expect(stepOfFile('07_users.csv')).toBe('people');
    expect(stepOfFile('11_item_locations.csv')).toBe('stock');
    expect(stepOfFile('29_checklist_templates.csv')).toBe('review');
  });
});

describe('people pasted from a sheet', () => {
  it('matches roles by title or another name, and says what it could not match', () => {
    const d = cafe();
    const { people, notes } = peopleFromPaste(
      d,
      [
        'Name\tEmail\tRole\tOutlet',
        'Ravi Kumar\t\tbarista\tBandra Café',
        'Meena\tmeena@x.test\tBaristta\t',
        'Hema, HR Admin',
        'Sunil, Cheff, Juhu',
      ].join('\n'),
    );
    expect(people.map((p) => ({ ...p, role: p.name === 'Sunil' ? '?' : p.role }))).toEqual([
      { name: 'Ravi Kumar', email: '', role: 'BARISTA', outlet: 'a' },
      { name: 'Meena', email: 'meena@x.test', role: '', outlet: 'a' },
      { name: 'Hema', email: '', role: 'HR_ADMIN', outlet: '' },
      { name: 'Sunil', email: '', role: '?', outlet: 'a' },
    ]);
    expect(notes[0]).toBe('Row 2: no role called Baristta: did you mean Barista?');
    expect(notes).toContain('Row 4: no outlet called Juhu');
  });
});

describe('what the customer buys (ADR 067)', () => {
  it("lists every bundle: its outlets' usual ones ticked, the rest (Hotel, Events & compliance) not; Go live's plan follows", () => {
    const d = cafe();
    expect(emptyDraft().bundlesOff).toEqual([]);
    expect(emptyDraft().bundlesOn).toEqual([]);
    const b = draftBundles(d);
    expect(b.map((x) => [x.name, x.usual, x.ticked])).toEqual([
      ['Stock & buying', true, true],
      ['Kitchen & bar', true, true],
      ['People', true, true],
      ['Daily work', true, true],
      ['Hotel', false, false],
      ['Events & compliance', false, false],
    ]);
    expect(b[3]!.uses).toEqual(['Checklists', 'Maintenance', "Today's briefing"]);
    expect(planFromDraft(d)).toEqual({
      stock_buying: true,
      kitchen_bar: true,
      people: true,
      daily_work: true,
      hotel: false,
      events_compliance: false,
    });
    d.bundlesOff = ['people'];
    d.bundlesOn = ['events_compliance'];
    expect(planFromDraft(d)).toMatchObject({
      people: false,
      stock_buying: true,
      events_compliance: true,
    });
  });

  it("with Events & compliance: the outlet's licences to fill in and its calendar jobs, each with an owner", () => {
    const d = hotel();
    d.bundlesOn = ['events_compliance'];
    const files = filesFromDraft(d, '2026-10-07');
    const lic = rows(files, '38_');
    expect(lic.map((r) => r['kind'])).toEqual(
      expect.arrayContaining(['FSSAI', 'FIRE_NOC', 'LIFT', 'SPCB_CONSENT', 'SWIMMING_POOL']),
    );
    expect(new Set(lic.map((r) => r['renewal_role']))).toEqual(new Set(['GENERAL_MANAGER']));
    expect(lic.every((r) => r['number'] === '' && r['expires_on'] === '')).toBe(true);
    const cal = new Map(rows(files, '39_').map((r) => [r['from_library'], r]));
    // the GM answers for every job (ADR 073); the kitchen head does the kitchen's, at the
    // kitchen, the chief engineer engineering's, the GM the rest
    expect(cal.get('DUCT-CLEANING@1')).toMatchObject({
      owner_role: 'GENERAL_MANAGER',
      doer_role: 'EXECUTIVE_CHEF',
      place_code: 'GH-ONE-KITCHEN',
      next_due: '2026-11-06',
      needs_proof: 'yes',
    });
    expect(cal.get('LIFT-RESCUE-DRILL@1')).toMatchObject({
      owner_role: 'GENERAL_MANAGER',
      doer_role: 'CHIEF_ENGINEER',
      place_code: 'GH-ONE-ENGINEERING',
    });
    expect(cal.get('PEST-CONTROL@1')).toMatchObject({
      owner_role: 'GENERAL_MANAGER',
      doer_role: '',
      place_code: 'GH-ONE',
    });
    expect(cal.get('FSSAI-ANNUAL-RETURN@1')).toMatchObject({ next_due: '2027-05-31' });
    // the loader reads them
    const { issues } = readBundle(files);
    expect(issues).toEqual([]);
    // without it, neither file
    d.bundlesOn = [];
    const none = filesFromDraft(d, '2026-10-07');
    expect(Object.keys(none).some((f) => /^3[89]_/.test(f))).toBe(false);
  });

  it('without Daily work, no checklist rounds are set up', () => {
    const d = cafe();
    expect(Object.keys(filesFromDraft(d)).some((f) => f.startsWith('29_'))).toBe(true);
    d.bundlesOff = ['daily_work'];
    expect(Object.keys(filesFromDraft(d)).some((f) => f.startsWith('29_'))).toBe(false);
  });

  it('the files switch no module on or off: the plan does', () => {
    const files = filesFromDraft(cafe());
    const customer = rows(files, '00_')[0]!;
    for (const m of ['checklists', 'events', 'production', 'leave']) {
      expect(customer[m] ?? '', m).toBe('');
    }
  });
});
