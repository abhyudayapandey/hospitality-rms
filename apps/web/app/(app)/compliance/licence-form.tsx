'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { LICENCE_KINDS } from '@outlet-ops/domain';
import { ErrorBox, inputClass, primaryButton } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { saveLicence, type LicenceInput } from './actions';
import { DocumentFiles, type DocumentFile } from './document-files';

/** A form field's text (a file input gives none). */
const field = (f: FormData, name: string) => {
  const v = f.get(name);
  return typeof v === 'string' ? v : '';
};

const OTHER = 'OTHER';

export interface Choice {
  id: string;
  name: string;
}

/**
 * Adds a licence or corrects one (ADR 069): what it is (from the library's kinds, or another),
 * its number, who issued it, its dates, who renews it and its documents. A renewal is not a
 * correction: it has its own form, which keeps the old licence as history.
 */
export function LicenceForm({
  places,
  roles,
  existing,
  photos,
}: {
  places: Choice[];
  /** the job roles at the place, by place */
  roles: Record<string, { code: string; name: string }[]>;
  existing?: LicenceInput;
  photos: boolean;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [node, setNode] = useState(existing?.node ?? places[0]?.id ?? '');
  const [kind, setKind] = useState(existing?.kind ?? LICENCE_KINDS[0]!.code);
  const known = LICENCE_KINDS.find((k) => k.code === kind);
  const [name, setName] = useState(existing?.name ?? known?.name ?? '');
  const [authority, setAuthority] = useState(existing?.authority ?? known?.authority ?? '');
  const [files, setFiles] = useState<DocumentFile[]>(
    (existing?.files ?? []).map((key, i) => ({ key, name: `Document ${i + 1}` })),
  );
  const [key] = useState(() => crypto.randomUUID());
  const here = roles[node] ?? [];

  return (
    <form
      aria-label={existing ? 'Correct the licence' : 'Add a licence'}
      className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        start(async () => {
          setError(null);
          const r = await saveLicence(
            {
              id: existing?.id ?? null,
              node,
              kind,
              name,
              number: field(f, 'number'),
              authority,
              issued_on: field(f, 'issued_on') || null,
              expires_on: field(f, 'expires_on') || null,
              renewal_role: field(f, 'renewal_role'),
              files: files.map((x) => x.key),
            },
            existing ? undefined : key,
          );
          if (!r.ok) {
            setError(r.message);
            return;
          }
          router.push(`/compliance/licences/${r.data.id}`);
          router.refresh();
        });
      }}
    >
      {places.length > 1 && (
        <label className="block text-sm font-medium">
          Outlet
          <select value={node} onChange={(e) => setNode(e.target.value)} className={inputClass}>
            {places.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="block text-sm font-medium">
        Licence
        <select
          value={kind}
          onChange={(e) => {
            const k = LICENCE_KINDS.find((x) => x.code === e.target.value);
            setKind(e.target.value);
            if (k) {
              setName(k.name);
              setAuthority(k.authority);
            }
          }}
          className={inputClass}
        >
          {LICENCE_KINDS.map((k) => (
            <option key={k.code} value={k.code}>
              {k.name}
            </option>
          ))}
          <option value={OTHER}>Another licence</option>
        </select>
      </label>
      {kind === OTHER && (
        <label className="block text-sm font-medium">
          Its name
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </label>
      )}
      <label className="block text-sm font-medium">
        Number
        <input name="number" defaultValue={existing?.number} className={inputClass} />
      </label>
      <label className="block text-sm font-medium">
        Issued by
        <input
          value={authority}
          onChange={(e) => setAuthority(e.target.value)}
          className={inputClass}
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-sm font-medium">
          Issued on
          <input
            name="issued_on"
            type="date"
            defaultValue={existing?.issued_on ?? ''}
            className={inputClass}
          />
        </label>
        <label className="block text-sm font-medium">
          Expires on
          <input
            name="expires_on"
            type="date"
            defaultValue={existing?.expires_on ?? ''}
            className={inputClass}
          />
        </label>
      </div>
      <label className="block text-sm font-medium">
        Who renews it
        <select
          name="renewal_role"
          required
          defaultValue={existing?.renewal_role}
          className={inputClass}
        >
          {here.map((r) => (
            <option key={r.code} value={r.code}>
              {r.name}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-xs font-normal text-slate-500">
          Their To do list gets the renewal 90 days before it expires.
        </span>
      </label>
      {photos ? (
        <DocumentFiles
          node={node}
          files={files}
          onChange={setFiles}
          onError={setError}
          onBusy={setBusy}
          label="The licence (photo or PDF)"
        />
      ) : (
        <p className="text-sm text-slate-600">Documents can be added once uploads are on.</p>
      )}
      <ErrorBox message={error} />
      <button type="submit" disabled={!hydrated || pending || busy} className={primaryButton}>
        {existing ? 'Save' : 'Add the licence'}
      </button>
    </form>
  );
}
