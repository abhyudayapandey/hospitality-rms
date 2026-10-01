// Photos are shrunk on the phone before upload (Prompt 10): long side at most 1280 px,
// JPEG quality 0.7, so a wastage photo is a few hundred KB on a slow network instead of
// the camera's several MB (the e2e photo test measures it).

export const PHOTO_MAX_SIDE = 1280;
export const PHOTO_QUALITY = 0.7;

/** The size an image is drawn at: its long side at most `maxSide`, never enlarged. */
export function fitWithin(
  width: number,
  height: number,
  maxSide: number = PHOTO_MAX_SIDE,
): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/**
 * Resizes and re-encodes a photo in the browser. Self-contained (no imports, no outer
 * names) so the e2e test can run this exact function in Chromium.
 */
export async function resizePhoto(file: Blob, maxSide: number, quality: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('resize failed'))),
      'image/jpeg',
      quality,
    ),
  );
}
