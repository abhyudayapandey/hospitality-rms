import { pictureFor, pictureOf } from '@outlet-ops/domain';

// A picture on every item line (UX-6, ADR 034, ADR 084): the item's own photo when it has
// one, else a picture of the thing itself from its name (garlic looks like garlic, cloves like
// cloves), else its category's. Staff who read little find an item by its picture, so it is
// big, on a light tile in both themes, and the name is always next to it.

export function ItemThumb({
  name,
  category,
  src = null,
  size = 'size-12',
  fallback,
}: {
  /** the item's (or dish's) name: what the picture is matched from */
  name?: string | null | undefined;
  category?: string | null | undefined;
  /** the item's own photo (a short-lived URL), when it has one */
  src?: string | null | undefined;
  size?: string;
  /** the picture when nothing in the name or category matches; a box otherwise */
  fallback?: string | undefined;
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
  let key = pictureFor(name ?? '', category);
  if (key === 'box' && fallback && pictureOf(fallback)) key = fallback;
  return (
    <span
      aria-hidden
      data-testid="item-picture"
      data-picture={key}
      className={`${size} flex shrink-0 items-center justify-center rounded-lg bg-tile p-1 ring-1 ring-tile-edge`}
    >
      {/* a static file from public/pictures: the browser keeps it for a day */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/pictures/${key}.svg`} alt="" className="size-full" draggable={false} />
    </span>
  );
}
