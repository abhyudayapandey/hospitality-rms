import { getSelfieUploadUrl } from '@/app/(app)/roster/actions';
import { resizePhoto } from './photo-resize';

// A clock-in selfie is small (ATT-7): long side 640 px, JPEG 0.6, about 50 to 80 KB.
export const SELFIE_MAX_SIDE = 640;
export const SELFIE_QUALITY = 0.6;

/** Shrinks a photo taken for a clock-in selfie. */
export function shrinkSelfie(file: Blob): Promise<Blob> {
  return resizePhoto(file, SELFIE_MAX_SIDE, SELFIE_QUALITY);
}

/**
 * Uploads a (shrunk) selfie with a presigned POST and returns its key, or null when selfies
 * cannot be kept here (photo storage is off): the clock-in then goes without one, flagged.
 * Throws when the request did not get through or storage refused it, so the caller can queue
 * the punch with the selfie and try again later.
 */
export async function uploadSelfie(blob: Blob): Promise<string | null> {
  const target = await getSelfieUploadUrl('image/jpeg', blob.size);
  if (!target.ok) {
    if (target.code === 'INVALID_PHOTO') return null; // will not change on retry
    throw new Error(target.message);
  }
  const form = new FormData();
  for (const [k, v] of Object.entries(target.data.fields)) form.append(k, v);
  form.append('file', blob);
  const res = await fetch(target.data.url, { method: 'POST', body: form });
  if (!res.ok) throw new Error('The selfie did not upload.');
  return target.data.key;
}
