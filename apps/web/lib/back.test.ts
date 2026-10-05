import { describe, expect, it } from 'vitest';
import { backHref, withBack } from './back';

describe('back links keep the list (ADR 053)', () => {
  it('carries the list with its tab and All stores', () => {
    const list = '/stock/orders?all=1&tab=receive';
    const href = withBack('/stock/orders/p1?node=n1', list);
    expect(href).toBe('/stock/orders/p1?node=n1&back=%2Fstock%2Forders%3Fall%3D1%26tab%3Dreceive');
    const back = new URL(href, 'http://x').searchParams.get('back');
    expect(backHref(back, '/stock/orders')).toBe(list);
    expect(withBack('/stock/transfers/t1', '/stock/transfers')).toBe(
      '/stock/transfers/t1?back=%2Fstock%2Ftransfers',
    );
  });
  it('never leaves the app', () => {
    for (const bad of [
      'https://evil.example',
      '//evil.example',
      '/\\evil',
      'javascript:alert(1)',
    ]) {
      expect(backHref(bad, '/stock/orders')).toBe('/stock/orders');
    }
    expect(backHref(null, '/stock/orders')).toBe('/stock/orders');
  });
});
