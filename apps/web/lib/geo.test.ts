import { describe, expect, it } from 'vitest';
import { mapLink } from './geo';

describe('mapLink', () => {
  it('opens OpenStreetMap with a pin at the point', () => {
    expect(mapLink(19.0596, 72.8295)).toBe(
      'https://www.openstreetmap.org/?mlat=19.0596&mlon=72.8295#map=18/19.0596/72.8295',
    );
  });
});
