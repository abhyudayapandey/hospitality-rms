import Link from 'next/link';
import { failure } from '@outlet-ops/domain';
import { ModuleGate } from '@/components/module-gate';
import { requireUser } from '@/lib/auth/server';
import {
  dayWords,
  licenceHistory,
  licences,
  licenceStatus,
  TONE_CLASS,
  type LicenceHistoryRow,
  type LicenceRow,
} from '@/lib/compliance';
import { withUser } from '@/lib/db';
import { photosEnabled, presignPhotoView } from '@/lib/photos';
import { RenewForm } from '../../act-forms';
import { keeps, rolesByPlace } from '../../data';
import { RemoveButton } from '../../job-form';
import { LicenceForm } from '../../licence-form';

// One licence (ADR 069): what it is, its dates and documents, and every earlier renewal. Its
// keepers renew it (the old one stays as history), correct it, or remove it.

export default function LicencePage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <ModuleGate code="compliance">
      <Licence params={params} />
    </ModuleGate>
  );
}

async function documents(keys: string[]) {
  if (!photosEnabled()) return [];
  return Promise.all(
    keys.map(async (key, i) => ({
      url: await presignPhotoView(key),
      name: key.endsWith('.pdf') ? `Document ${i + 1} (PDF)` : `Photo ${i + 1}`,
    })),
  );
}

async function Licence({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  let data: {
    l: LicenceRow | null;
    history: LicenceHistoryRow[];
    canKeep: boolean;
    roles: Record<string, { code: string; name: string }[]>;
  };
  try {
    data = await withUser(user.id, async (tx) => {
      const l = (await licences(tx, null)).find((x) => x.id === id) ?? null;
      if (!l) return { l, history: [], canKeep: false, roles: {} };
      const canKeep = await keeps(tx, l.org_node_id);
      return {
        l,
        history: await licenceHistory(tx, id),
        canKeep,
        roles: canKeep ? await rolesByPlace(tx, [l.org_node_id]) : {},
      };
    });
  } catch (err) {
    return <p className="text-slate-700">{failure(err).message}</p>;
  }
  const { l, history, canKeep, roles } = data;
  if (!l) {
    return (
      <p className="rounded-xl bg-white p-6 text-center text-slate-600 ring-1 ring-slate-200">
        We couldn&apos;t find that licence. It may have been renewed or removed.
      </p>
    );
  }
  const s = licenceStatus(l);
  const docs = await documents(l.files);
  const earlier = history.filter((h) => h.id !== l.id);
  return (
    <div className="space-y-4">
      <Link href="/compliance" className="text-sm text-slate-600 underline">
        Back to Compliance
      </Link>
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">{l.name}</h1>
        <p className="text-sm text-slate-600">{l.place_name}</p>
        <p>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${TONE_CLASS[s.tone]}`}
            data-testid="licence-status"
          >
            {s.words}
          </span>
        </p>
      </header>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-xl bg-white p-4 text-sm ring-1 ring-slate-200">
        <dt className="text-slate-500">Number</dt>
        <dd>{l.number ?? '—'}</dd>
        <dt className="text-slate-500">Issued by</dt>
        <dd>{l.authority ?? '—'}</dd>
        <dt className="text-slate-500">Issued</dt>
        <dd>{dayWords(l.issued_on) || '—'}</dd>
        <dt className="text-slate-500">Expires</dt>
        <dd>{dayWords(l.expires_on) || '—'}</dd>
        <dt className="text-slate-500">Renewed by</dt>
        <dd>The {l.renewal_role_name}</dd>
      </dl>
      {docs.length > 0 && (
        <ul className="space-y-1 text-sm" data-testid="licence-documents">
          {docs.map((d) => (
            <li key={d.url}>
              <a href={d.url} target="_blank" rel="noreferrer" className="underline">
                {d.name}
              </a>
            </li>
          ))}
        </ul>
      )}
      {l.open_task && (
        <Link href={`/tasks/${l.open_task}`} className="block text-sm underline">
          Its renewal is on the {l.renewal_role_name}&apos;s To do list
        </Link>
      )}
      {earlier.length > 0 && (
        <section className="space-y-1">
          <h2 className="font-semibold">Earlier</h2>
          <ul className="space-y-1 text-sm text-slate-700" data-testid="licence-history">
            {earlier.map((h) => (
              <li key={h.id}>
                {h.number ?? 'No number'} · {dayWords(h.issued_on) || '…'} to{' '}
                {dayWords(h.expires_on) || '…'}
              </li>
            ))}
          </ul>
        </section>
      )}
      {canKeep && (
        <>
          <RenewForm
            licence={l.id}
            node={l.org_node_id}
            number={l.number}
            photos={photosEnabled()}
            done="/compliance/licences/{id}"
          />
          <details className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
            <summary className="min-h-11 cursor-pointer font-semibold">Correct its details</summary>
            <div className="pt-3">
              <LicenceForm
                places={[{ id: l.org_node_id, name: l.place_name }]}
                roles={roles}
                photos={photosEnabled()}
                existing={{
                  id: l.id,
                  node: l.org_node_id,
                  kind: l.kind,
                  name: l.name,
                  number: l.number ?? '',
                  authority: l.authority ?? '',
                  issued_on: l.issued_on,
                  expires_on: l.expires_on,
                  renewal_role: l.renewal_role,
                  files: l.files,
                }}
              />
            </div>
          </details>
          <RemoveButton kind="licence" id={l.id} />
        </>
      )}
    </div>
  );
}
