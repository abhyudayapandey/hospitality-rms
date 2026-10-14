import { describe, expect, it } from 'vitest';
import { demoRequestSchema } from './demo-request';

const form = {
  name: ' Asha Rao ',
  phone: '+91 98200 12345',
  email: '',
  business: 'Blue Bean Café',
  outletKind: 'Bar & pub',
  outlets: '2 to 5',
  website: '',
};

describe('demo request (ADR 141)', () => {
  it("turns the form's choices into the codes the database keeps", () => {
    expect(demoRequestSchema.parse(form)).toEqual({
      ...form,
      name: 'Asha Rao',
      outletKind: 'bar',
      outlets: '2-5',
    });
  });

  it.each([
    ['phone', 'call me'],
    ['phone', '98200'],
    ['email', 'asha@'],
    ['business', '  '],
    ['outletKind', 'Spa'],
    ['outlets', '7'],
  ])('refuses %s %j', (field, value) => {
    expect(demoRequestSchema.safeParse({ ...form, [field]: value }).success).toBe(false);
  });

  it('takes QSRs and franchises', () => {
    expect(demoRequestSchema.parse({ ...form, outletKind: 'QSR' }).outletKind).toBe('qsr');
    expect(
      demoRequestSchema.parse({ ...form, outletKind: 'Franchise (many outlets)' }).outletKind,
    ).toBe('franchise');
  });

  it('accepts a missing email and a missing trap field', () => {
    const { email: _e, website: _w, ...rest } = form;
    expect(demoRequestSchema.parse(rest)).toMatchObject({ email: '', website: '' });
  });
});
