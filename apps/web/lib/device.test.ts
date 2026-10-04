import { describe, expect, it } from 'vitest';
import { phoneModel } from './device';

describe('phoneModel', () => {
  it('reads the model of an Android phone', () => {
    expect(
      phoneModel(
        'Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UP1A.231005.007) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      ),
    ).toBe('Pixel 7');
    expect(
      phoneModel(
        'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Mobile Safari/537.36',
      ),
    ).toBe('SM-S918B');
  });

  it('names iPhones and iPads, which hide the model', () => {
    expect(
      phoneModel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15'),
    ).toBe('iPhone');
    expect(phoneModel('Mozilla/5.0 (iPad; CPU OS 17_1 like Mac OS X) AppleWebKit/605.1.15')).toBe(
      'iPad',
    );
  });

  it('gives nothing for a reduced Android user agent or a desktop', () => {
    expect(
      phoneModel(
        'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      ),
    ).toBeNull();
    expect(phoneModel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0')).toBeNull();
  });
});
