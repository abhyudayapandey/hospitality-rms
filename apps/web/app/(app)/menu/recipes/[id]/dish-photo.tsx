'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, primaryButton, secondaryButton } from '@/components/messages';
import { PhotoField } from '@/components/photo-field';
import { useHydrated } from '@/lib/use-hydrated';
import { getDishUploadUrl, setDishPhoto } from '../../actions';

/** Take or change the dish's photo (ADR 078); menu.set_dish_photo checks who. */
export function DishPhoto({ dish, has }: { dish: string; has: boolean }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = (photo: string | null) =>
    start(async () => {
      setError(null);
      const r = await setDishPhoto(dish, photo);
      if (!r.ok) return setError(r.message);
      setOpen(false);
      setKey(null);
      router.refresh();
    });
  if (!open) {
    return (
      <button
        type="button"
        className={secondaryButton}
        disabled={!hydrated}
        onClick={() => setOpen(true)}
      >
        {has ? 'Change the photo' : 'Add a photo'}
      </button>
    );
  }
  return (
    <div className="space-y-2" data-testid="dish-photo-form">
      <PhotoField
        node={dish}
        photoKey={key}
        onChange={setKey}
        getUploadUrl={getDishUploadUrl}
        label="Dish photo"
      />
      <ErrorBox message={error} />
      <button
        type="button"
        className={primaryButton}
        disabled={!hydrated || pending || !key}
        onClick={() => save(key)}
      >
        Save the photo
      </button>
      {has && (
        <button
          type="button"
          className={secondaryButton}
          disabled={!hydrated || pending}
          onClick={() => save(null)}
        >
          Remove the photo
        </button>
      )}
    </div>
  );
}
