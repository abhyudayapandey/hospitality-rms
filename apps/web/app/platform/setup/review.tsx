import Link from 'next/link';
import type { ImportReport } from '@outlet-ops/onboarding/upload';
import {
  STEP_TITLE,
  draftBundles,
  logins,
  stepOfFile,
  warningsInWords,
  whoDoesWhat,
  type DraftProblem,
  type SetupDraft,
} from '@outlet-ops/onboarding/templates';
import { sql, withPlatformAdmin } from '@/lib/db';
import { requirePlatformAdmin } from '@/lib/platform/server';
import { ImportReportView } from '../jobs/[id]/import-report';
import { UsernameLogins } from '../customers/[id]/logins/logins-parts';
import type { DraftRow, JobState } from './draft';
import { GoLive, type Stage } from './go-live';

// Screen 7 (ADR 064): every duty at every outlet and who does it, then Go live: check
// everything (the customer is created and its files dry run), then apply and send logins.

function stageOf(row: DraftRow, jobs: Jobs, blocked: boolean): Stage {
  const { created, dryRun, applied } = jobs;
  if (applied) {
    if (applied.status === 'done') return { kind: 'live' };
    if (applied.status === 'failed') return { kind: 'failed', message: applied.error ?? '' };
    return { kind: 'busy', label: 'Loading everything…' };
  }
  if (blocked) return { kind: 'blocked' };
  if (!row.create_job) return { kind: 'ready' };
  if (!created || created.status === 'failed') {
    return { kind: 'failed', message: created?.error ?? 'The company could not be created' };
  }
  if (created.status !== 'done') return { kind: 'busy', label: 'Creating the company…' };
  if (!dryRun) return { kind: 'busy', label: 'Checking everything…', advance: true };
  if (dryRun.status === 'failed') return { kind: 'recheck', message: dryRun.error ?? '' };
  if (dryRun.status !== 'done') return { kind: 'busy', label: 'Checking everything…' };
  const report = dryRun.result as unknown as ImportReport;
  return report.ok
    ? { kind: 'checked', changes: report.changes }
    : { kind: 'recheck', message: '' };
}

interface Jobs {
  created: JobState | null;
  dryRun: JobState | null;
  applied: JobState | null;
}

export async function ReviewStep({
  id,
  draft,
  row,
  jobs,
  problems,
}: {
  id: string;
  draft: SetupDraft;
  row: DraftRow;
  jobs: Jobs;
  problems: DraftProblem[];
}) {
  const stage = stageOf(row, jobs, problems.length > 0);
  const report =
    jobs.dryRun?.status === 'done' ? (jobs.dryRun.result as unknown as ImportReport) : null;
  const people = logins(draft);
  const byEmail = people.filter((p) => p.email).length;
  let waitingIds = 0;
  let isTest = draft.company.isTest;
  if (stage.kind === 'live' && row.tenant_id) {
    const admin = await requirePlatformAdmin();
    const r = await withPlatformAdmin(admin, async (tx) => ({
      people: (
        await sql<{ login_type: string; has_login: boolean }>`
          select login_type, has_login from platform.login_candidates(${row.tenant_id}::uuid)`.execute(
          tx,
        )
      ).rows,
      test: (
        await sql<{
          is_test: boolean;
        }>`select is_test from platform.customer(${row.tenant_id}::uuid)`.execute(tx)
      ).rows[0]?.is_test,
    }));
    waitingIds = r.people.filter((p) => p.login_type === 'username' && !p.has_login).length;
    isTest = r.test ?? isTest;
  }

  return (
    <>
      {problems.length > 0 && (
        <section
          className="space-y-1 rounded-lg bg-amber-50 p-3 text-sm text-amber-900"
          data-testid="problems"
        >
          <p className="font-medium">Before going live</p>
          <ul className="space-y-1">
            {problems.map((p, n) => (
              <li key={n}>
                {p.message}{' '}
                <Link href={`/platform/setup/${id}/${p.step}`} className="underline">
                  Fix on {STEP_TITLE[p.step]}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {whoDoesWhat(draft).map((o) => (
        <section key={o.key} className="space-y-2" data-testid={`who-${o.name}`}>
          <h2 className="font-semibold">{o.name}</h2>
          <ul className="divide-y divide-slate-100 rounded-xl bg-white text-sm ring-1 ring-slate-200">
            {o.roles.map((r) => (
              <li key={r.code} className="space-y-1 p-3" data-role={r.title}>
                <div className="flex justify-between gap-2">
                  <span className="font-medium">{r.title}</span>
                  <span className={r.nobody ? 'text-amber-800' : 'text-slate-700'}>{r.who}</span>
                </div>
                <p className="text-xs text-slate-600">{r.does.join(' · ')}</p>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <p className="text-sm" data-testid="logins-plan">
        Sign-ins: the owner and {byEmail} {byEmail === 1 ? 'person' : 'people'} by email
        {people.length - byEmail > 0 &&
          `; ${people.length - byEmail} with a login ID on a printed sheet`}
        .
      </p>

      <Bundles id={id} draft={draft} />

      <section
        className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200"
        aria-label="Go live"
      >
        <h2 className="text-lg font-semibold">Go live</h2>
        {report && stage.kind !== 'live' && (
          <>
            {report.issues.length > 0 && (
              <ul
                className="space-y-1 rounded-lg bg-rose-50 p-3 text-sm text-rose-900"
                data-testid="check-problems"
              >
                {report.issues.map((i, n) => (
                  <li key={n}>
                    {i.message}{' '}
                    <Link
                      href={`/platform/setup/${id}/${stepOfFile(i.file)}`}
                      className="underline"
                    >
                      Fix on {STEP_TITLE[stepOfFile(i.file)]}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {report.warnings.length > 0 && (
              <section
                className="space-y-1 rounded-lg bg-amber-50 p-3 text-sm text-amber-900"
                data-testid="check-warnings"
              >
                <p className="font-medium">Worth a look (these don't stop you going live)</p>
                <ul className="list-disc space-y-1 pl-5">
                  {warningsInWords(
                    draft,
                    report.warnings.map((w) => w.message),
                  ).map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </section>
            )}
            <details className="text-sm">
              <summary className="min-h-10 cursor-pointer">The full check</summary>
              <ImportReportView report={report} />
            </details>
          </>
        )}
        <GoLive id={id} stage={stage} />
        {stage.kind === 'live' && row.tenant_id && (
          <>
            {people.length - byEmail > 0 && (
              <div className="space-y-2" data-testid="login-ids">
                <h3 className="font-semibold">Login IDs for the printed sheet</h3>
                <UsernameLogins
                  tenantId={row.tenant_id}
                  isTest={isTest}
                  waiting={waitingIds}
                  suspended={false}
                  company={draft.company.name}
                  testOption={false}
                />
              </div>
            )}
            <Link href={`/platform/customers/${row.tenant_id}`} className="block text-sm underline">
              Open {draft.company.name} in the console
            </Link>
          </>
        )}
      </section>
    </>
  );
}

/** What the customer buys (ADR 067, 069), chosen on screen 3; Go live puts it in the plan. */
function Bundles({ id, draft }: { id: string; draft: SetupDraft }) {
  const bundles = draftBundles(draft);
  const on = bundles.filter((b) => b.ticked);
  return (
    <section className="space-y-1 text-sm" aria-label="What they buy" data-testid="bundles">
      <h2 className="font-semibold">What they buy</h2>
      <p>
        {on.length ? on.map((b) => b.name).join(', ') : 'Nothing beyond what every plan has'}.{' '}
        <Link href={`/platform/setup/${id}/bundles`} className="underline">
          Change
        </Link>
      </p>
    </section>
  );
}
