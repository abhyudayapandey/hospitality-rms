import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { draftProblems, STEP_TITLE, STEPS, type Step } from '@outlet-ops/onboarding/templates';
import { ErrorBox } from '@/components/messages';
import { withPlatformAdmin } from '@/lib/db';
import { requirePlatformAdmin } from '@/lib/platform/server';
import { jobState, loadDraft } from '../../draft';
import { isStep } from '../../form';
import {
  CompanyStep,
  DepartmentsStep,
  OutletsStep,
  PeopleStep,
  RolesStep,
  StockStep,
} from '../../steps';
import { ReviewStep } from '../../review';
import { ThrowAway } from '../../throw-away';

type Search = Record<string, string | string[] | undefined>;
const list = (v: string | string[] | undefined) => [v ?? []].flat();

// The set-up wizard (ADR 064): seven screens in plain words, one after the other, each saved
// at Next. People who onboard never see a code or a file.
export default async function SetupStepPage({
  params,
  searchParams,
}: {
  params: Promise<{ draft: string; step: string }>;
  searchParams: Promise<Search>;
}) {
  const { draft: id, step } = await params;
  const q = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(id) || !isStep(step)) notFound();
  const admin = await requirePlatformAdmin();
  const data = await withPlatformAdmin(admin, async (tx) => {
    const found = await loadDraft(tx, id);
    if (!found) return null;
    const [created, dryRun, applied] = await Promise.all([
      jobState(tx, found.row.create_job),
      jobState(tx, found.row.dry_run_job),
      jobState(tx, found.row.apply_job),
    ]);
    return { ...found, jobs: { created, dryRun, applied } };
  });
  if (!data) notFound();
  const { row, draft, jobs } = data;
  // a set-up that has gone live is changed by an import, not here
  if (row.apply_job && step !== 'review') redirect(`/platform/setup/${id}/review`);
  const problems = draftProblems(draft);
  // a screen's problems show once the person has moved past it (not on a first visit)
  const reached = STEPS.indexOf(row.step);
  const here = (s: Step) =>
    STEPS.indexOf(s) < reached ? problems.filter((p) => p.step === s) : [];
  const notes = list(q.note);
  const error = list(q.error)[0] ?? null;

  return (
    <>
      <Link href="/platform" className="text-sm text-slate-600">
        ← Customers
      </Link>
      <h1 className="text-xl font-semibold">Set up {draft.company.name || 'a new customer'}</h1>
      <nav aria-label="Set-up steps">
        <ol className="flex flex-wrap gap-1 text-sm">
          {STEPS.map((s, n) => (
            <li key={s}>
              <Link
                href={`/platform/setup/${id}/${s}`}
                aria-current={s === step ? 'step' : undefined}
                className={`inline-flex min-h-10 items-center rounded-full px-3 ring-1 ${
                  s === step
                    ? 'bg-brand-700 font-medium text-white ring-brand-700'
                    : here(s).length
                      ? 'bg-amber-50 ring-amber-300'
                      : 'bg-white ring-slate-200'
                }`}
              >
                {n + 1}. {STEP_TITLE[s]}
              </Link>
            </li>
          ))}
        </ol>
      </nav>
      <ErrorBox message={error} />
      {notes.length > 0 && (
        <ul
          className="space-y-1 rounded-lg bg-amber-50 p-3 text-sm text-amber-900"
          data-testid="notes"
        >
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {step !== 'review' && here(step).length > 0 && (
        <ul
          className="space-y-1 rounded-lg bg-amber-50 p-3 text-sm text-amber-900"
          data-testid="step-problems"
        >
          {here(step).map((p, n) => (
            <li key={n}>{p.message}</li>
          ))}
        </ul>
      )}
      {step === 'company' && <CompanyStep id={id} draft={draft} />}
      {step === 'outlets' && (
        <OutletsStep
          id={id}
          draft={draft}
          tile={q.tile === undefined ? undefined : (list(q.tile)[0] ?? '')}
          edit={list(q.edit)[0] ?? ''}
          saved={list(q.saved)[0] ?? ''}
        />
      )}
      {step === 'departments' && <DepartmentsStep id={id} draft={draft} />}
      {step === 'roles' && <RolesStep id={id} draft={draft} />}
      {step === 'people' && <PeopleStep id={id} draft={draft} />}
      {step === 'stock' && <StockStep id={id} draft={draft} />}
      {step === 'review' && (
        <ReviewStep id={id} draft={draft} row={row} jobs={jobs} problems={problems} />
      )}
      {!row.apply_job && (
        <ThrowAway
          id={id}
          name={draft.company.name || 'a new customer'}
          created={!!row.create_job}
        />
      )}
    </>
  );
}
