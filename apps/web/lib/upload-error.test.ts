import { describe, expect, it } from 'vitest';
import { UploadFailed, uploadMessage } from './upload-error';

describe('uploadMessage', () => {
  it('shows our own words, and the fallback for anything else', () => {
    const fallback = 'The photo did not upload. Try again.';
    expect(uploadMessage(new UploadFailed('Uploads are off here.'), fallback)).toBe(
      'Uploads are off here.',
    );
    expect(uploadMessage(new TypeError('Failed to fetch'), fallback)).toBe(fallback);
    expect(uploadMessage('boom', fallback)).toBe(fallback);
  });
});
