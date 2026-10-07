import Link from 'next/link';
import { everyWords, failure } from '@outlet-ops/domain';
import { ModuleGate } from '@/components/module-gate';
import { requireUser } from '@/lib/auth/server';
import {
  complianceJobs,
  dayWords,
  jobHistory,
  jobStatus,
  TONE_CLASS,
  type JobHistoryRow,
  type JobRow,
} from '@/lib/compliance';
import { withUser } from '@/lib/db';
import { photosEnabled, presignPhotoView } from '@/lib/photos';
import { DoneForm } from '../../act-forms';
import { keeps, rolesByPlace } from '../../data';
import { JobForm, RemoveButton } from '../../job-form';

// One calendar job (ADR 069): how often, when it is next due, whose it is, and every time it
// was done with its proof. Its keepers mark it done, change it, or remove it.

export default function JobPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <ModuleGate code="compliance">
      <Job params={params} />
    </ModuleGate>
  );
}

async function Job({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  let data: {
    j: JobRow | null;
    history: JobHistoryRow[];
    canKeep: boolean;
    roles: Record<string, { code: string; name: string }[]>;
  };
  try {
    data = await withUser(user.id, async (tx) => {
      const j = (await complianceJobs(tx, null)).find((x) => x.id === id) ?? null;
      if (!j) return { j, history: [], canKeep: false, roles: {} };
      const canKeep = await keeps(tx, j.org_node_id);
      return {
        j,
        history: await jobHistory(tx, id),
        canKeep,
        roles: canKeep ? await rolesByPlace(tx, [j.org_node_id]) : {},
      };
    });
  } catch (err) {
    return <p className="text-slate-700">{failure(err).message}</p>;
  }
  const { j, history, canKeep, roles } = data;
  if (!j) {
    return (
      <p className="rounded-xl bg-white p-6 text-center text-slate-600 ring-1 ring-slate-200">
        We couldn&apos;t find that job. It may have been removed.
      </p>
    );
  }
  const s = jobStatus(j);
  const proof = photosEnabled()
    ? await Promise.all(
        history.map(async (h) =>
          Promise.all(h.files.map(async (key) => ({ key, url: await presignPhotoView(key) }))),
        ),
      )
    : history.map(() => []);
  return (
    <div className="space-y-4">
      <Link href="/compliance?tab=calendar" className="text-sm text-slate-600 underline">
        Back to the calendar
      </Link>
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">{j.name}</h1>
        <p className="text-sm text-slate-600">
          {j.place_name} · {everyWords(j.every_months)} · the {j.owner_role_name}
        </p>
        <p>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${TONE_CLASS[s.tone]}`}
            data-testid="job-status"
          >
            {s.words}
          </span>{' '}
          <span className="text-sm text-slate-600">{dayWords(j.next_due)}</span>
        </p>
      </header>
      {j.open_task && (
        <Link href={`/tasks/${j.open_task}`} className="block text-sm underline">
          It is on the {j.owner_role_name}&apos;s To do list
        </Link>
      )}
      <section className="space-y-1">
        <h2 className="font-semibold">Done</h2>
        {history.length === 0 ? (
          <p className="text-sm text-slate-600">Not recorded yet.</p>
        ) : (
          <ul className="space-y-2 text-sm" data-testid="job-history">
            {history.map((h, i) => (
              <li
                key={`${h.done_on}-${i}`}
                className="rounded-lg bg-white p-3 ring-1 ring-slate-200"
              >
                {dayWords(h.done_on)} by {h.done_by}
                {h.done_on > h.due_on && (
                  <span className="text-slate-500"> (due {dayWords(h.due_on)})</span>
                )}
                {h.note && <span className="block text-slate-600">{h.note}</span>}
                {proof[i]!.map((p, n) => (
                  <a
                    key={p.key}
                    href={p.url}
                    target="_blank"
                    rel="noreferrer"
                    className="mr-3 inline-block underline"
                  >
                    Proof {n + 1}
                  </a>
                ))}
              </li>
            ))}
          </ul>
        )}
      </section>
      {canKeep && (
        <>
          <DoneForm
            job={j.id}
            node={j.org_node_id}
            needsProof={j.needs_proof}
            photos={photosEnabled()}
          />
          <details className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
            <summary className="min-h-11 cursor-pointer font-semibold">Change the job</summary>
            <div className="pt-3">
              <JobForm
                places={[{ id: j.org_node_id, name: j.place_name }]}
                roles={roles}
                existing={{
                  id: j.id,
                  node: j.org_node_id,
                  name: j.name,
                  every_months: j.every_months,
                  next_due: j.next_due,
                  owner_role: j.owner_role,
                  needs_proof: j.needs_proof,
                }}
              />
            </div>
          </details>
          <RemoveButton kind="job" id={j.id} />
        </>
      )}
    </div>
  );
}
