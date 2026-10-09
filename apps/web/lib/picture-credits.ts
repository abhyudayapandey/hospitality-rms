// Written by `pnpm --filter @outlet-ops/web photos`: do not edit.
// Who took each photo in the library and under which licence (all from Wikimedia Commons).
export interface PictureCredit {
  key: string;
  label: string;
  title: string;
  author: string;
  licence: string;
  licenceUrl: string;
  source: string;
}

export const PICTURE_CREDITS: readonly PictureCredit[] = [];
