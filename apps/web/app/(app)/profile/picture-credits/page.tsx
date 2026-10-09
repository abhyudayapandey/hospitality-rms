import { BackLink } from '@/components/back-link';
import { ItemThumb } from '@/components/item-thumb';
import { PICTURE_CREDITS } from '@/lib/picture-credits';

// Who took each photo in our photo library (ADR 085), with its licence and source, as
// the photos' free licences ask. Static: the same for everyone.

export default function PictureCreditsPage() {
  return (
    <div className="space-y-4">
      <BackLink fallback="/profile" />
      <h1 className="text-xl font-semibold">Picture credits</h1>
      <p className="text-sm text-slate-600">
        The item photos are from Wikimedia Commons, used under their free licences.
      </p>
      <ul
        data-testid="picture-credits"
        className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
      >
        {PICTURE_CREDITS.map((c) => (
          <li key={c.key} className="flex items-center gap-3 px-4 py-3 text-sm">
            <ItemThumb picture={c.key} size="size-10" />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{c.label}</span>
              <span className="block break-words text-xs text-slate-500">
                {c.author} ·{' '}
                {c.licenceUrl ? (
                  <a href={c.licenceUrl} className="underline" rel="noreferrer" target="_blank">
                    {c.licence}
                  </a>
                ) : (
                  c.licence
                )}{' '}
                ·{' '}
                <a href={c.source} className="underline" rel="noreferrer" target="_blank">
                  source
                </a>
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
