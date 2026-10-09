import { pictureFor, pictureOf, type PictureGroup } from '@outlet-ops/domain';
import { PICTURE_PHOTOS } from '@/lib/picture-photos';
import { Icon, type IconName } from './icon';

// A picture on every item line (UX-6, ADR 034, ADR 084): the item's own photo when it has
// one, else a real photo of the thing itself from the library, matched from its name (garlic
// looks like garlic, cloves like cloves), else a line icon for its kind. Staff who read little
// find an item by its picture, so it is big and the name is always next to it.

const KIND_ICON: Partial<Record<PictureGroup, IconName>> = {
  vegetable: 'leaf',
  fruit: 'leaf',
  herb: 'leaf',
  drink: 'glass',
  bar: 'glass',
  room: 'bed',
  prep: 'pot',
  meat: 'plate',
  seafood: 'plate',
  dairy: 'plate',
};

export function ItemThumb({
  name,
  category,
  src = null,
  size = 'size-12',
  fallback,
  picture,
}: {
  /** the item's (or dish's) name: what the picture is matched from */
  name?: string | null | undefined;
  category?: string | null | undefined;
  /** the item's own photo (a short-lived URL), when it has one */
  src?: string | null | undefined;
  size?: string;
  /** the picture when nothing in the name or category matches; a box otherwise */
  fallback?: string | undefined;
  /** this picture, whatever the name */
  picture?: string | undefined;
}) {
  if (src) {
    return (
      // a presigned S3 URL that changes on every page: next/image would cache it for nothing
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        className={`${size} shrink-0 rounded-lg object-cover ring-1 ring-slate-200`}
      />
    );
  }
  let key = picture && pictureOf(picture) ? picture : pictureFor(name ?? '', category);
  if (key === 'box' && fallback && pictureOf(fallback)) key = fallback;
  // a brand with no photo yet shows its kind's: Old Monk shows a dark rum
  const kind = pictureOf(key)?.kind;
  const photo = PICTURE_PHOTOS.get(key) ?? (kind ? PICTURE_PHOTOS.get(kind) : undefined);
  if (photo) {
    return (
      <span
        aria-hidden
        data-testid="item-picture"
        data-picture={key}
        className={`${size} flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-tile ring-1 ring-tile-edge`}
      >
        {/* a static file from public/pictures: the browser keeps it for a day */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/pictures/${photo}`}
          alt=""
          className="size-full object-contain"
          draggable={false}
        />
      </span>
    );
  }
  const group = pictureOf(key)?.group;
  return (
    <span
      aria-hidden
      data-testid="item-picture"
      data-picture={key}
      className={`${size} flex shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700 ring-1 ring-brand-100`}
    >
      <Icon name={(group && KIND_ICON[group]) ?? 'box'} className="size-6" />
    </span>
  );
}
