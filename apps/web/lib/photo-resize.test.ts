import { describe, expect, it } from 'vitest';
import { fitWithin, PHOTO_MAX_SIDE, PHOTO_QUALITY } from './photo-resize';
import { MAX_PHOTO_BYTES } from './photo-policy';

describe('photo resizing before upload', () => {
  it('fits the long side to 1280 px and keeps the shape', () => {
    expect(PHOTO_MAX_SIDE).toBe(1280);
    expect(PHOTO_QUALITY).toBe(0.7);
    expect(fitWithin(4000, 3000)).toEqual({ width: 1280, height: 960 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 960, height: 1280 });
    expect(fitWithin(1920, 1080)).toEqual({ width: 1280, height: 720 });
  });

  it('never enlarges a small photo', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(1280, 1280)).toEqual({ width: 1280, height: 1280 });
  });

  it('stays far inside the upload limit even uncompressed at 4 bytes a pixel', () => {
    const { width, height } = fitWithin(4000, 3000);
    expect(width * height * 4).toBeLessThan(MAX_PHOTO_BYTES);
  });
});
