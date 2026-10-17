// What an upload shows when it fails (ADR 169): our own plain words, never the browser's
// ("Failed to fetch") or a resize library's message.

/** A failure whose message is written for the person. */
export class UploadFailed extends Error {
  override name = 'UploadFailed';
}

export function uploadMessage(err: unknown, fallback: string): string {
  return err instanceof UploadFailed ? err.message : fallback;
}
