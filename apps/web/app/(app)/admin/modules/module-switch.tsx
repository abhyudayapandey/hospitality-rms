'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox } from '@/components/messages';
import { setModule } from '../actions';

/** On / off for one module; turning one off asks first, since it hides it for everyone. */
export function ModuleSwitch({ code, name, on }: { code: string; name: string; on: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = (next: boolean) =>
    start(async () => {
      const r = await setModule(code, next);
      setConfirm(false);
      if (!r.ok) setError(r.message);
      else {
        setError(null);
        router.refresh();
      }
    });
  const button = 'min-h-11 shrink-0 rounded-lg px-3 text-sm font-medium disabled:opacity-50';
  if (confirm) {
    return (
      <div role="group" aria-label={`Turn off ${name}`} className="flex shrink-0 gap-2">
        <button
          type="button"
          className={`${button} ring-1 ring-slate-300`}
          onClick={() => setConfirm(false)}
        >
          Keep on
        </button>
        <button
          type="button"
          disabled={pending}
          className={`${button} bg-rose-700 text-white`}
          onClick={() => save(false)}
        >
          Turn off
        </button>
      </div>
    );
  }
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={name}
        disabled={pending}
        onClick={() => (on ? setConfirm(true) : save(true))}
        className={`${button} ${on ? 'bg-emerald-700 text-white' : 'ring-1 ring-slate-300'}`}
      >
        {on ? 'On' : 'Off'}
      </button>
      <ErrorBox message={error} />
    </div>
  );
}
