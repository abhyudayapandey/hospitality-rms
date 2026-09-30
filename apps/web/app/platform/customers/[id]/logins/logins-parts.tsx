'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, primaryButton, secondaryButton, StatusBox } from '@/components/messages';
import { usePolling } from '@/components/use-polling';
import { useHydrated } from '@/lib/use-hydrated';
import { createUsernameLogins, requestInvites, type LoginBatch } from '../../../actions';

export function InvitePoller() {
  usePolling(2000);
  return null;
}

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);

/**
 * Creates the waiting username logins. Their passwords are in this response only: shown
 * once and downloadable once, never stored. The Test<Role>!12 option is for test
 * customers; the server refuses it for anyone else.
 */
export function UsernameLogins({
  tenantId,
  isTest,
  waiting,
  suspended,
}: {
  tenantId: string;
  isTest: boolean;
  waiting: number;
  suspended: boolean;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [testRule, setTestRule] = useState(false);
  const [batch, setBatch] = useState<LoginBatch | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = () => {
    if (!batch || downloaded) return;
    const rows = [
      'username,display_name,password,change_at_first_sign_in',
      ...batch.created.map((c) =>
        [c.username, c.displayName, c.password, c.permanent ? 'no' : 'yes'].map(csvCell).join(','),
      ),
    ];
    const url = URL.createObjectURL(new Blob([rows.join('\n') + '\n'], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'logins.csv';
    a.click();
    URL.revokeObjectURL(url);
    setDownloaded(true);
  };

  return (
    <form
      aria-label="Create username logins"
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          setError(null);
          setBatch(null);
          setDownloaded(false);
          const r = await createUsernameLogins(tenantId, testRule);
          if (!r.ok) {
            setError(r.message);
            return;
          }
          setBatch(r.data);
          if (r.data.error) setError(r.data.error);
          router.refresh();
        });
      }}
    >
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="testRule"
          checked={testRule}
          disabled={!isTest}
          onChange={(e) => setTestRule(e.target.checked)}
          className="mt-1 h-5 w-5"
        />
        <span>
          Set passwords by the Test&lt;Role&gt;!12 rule (e.g. TestBarManager!12), kept at sign-in.{' '}
          {isTest ? (
            <span className="text-slate-500">Test customers only.</span>
          ) : (
            <span className="text-slate-500">Only for test customers; this one isn’t.</span>
          )}
        </span>
      </label>
      <button
        type="submit"
        disabled={!hydrated || pending || waiting === 0 || suspended}
        className={primaryButton}
      >
        Create {waiting} username login{waiting === 1 ? '' : 's'}
      </button>
      <ErrorBox message={error} />
      {batch && batch.created.length > 0 && (
        <div className="space-y-2 rounded-lg bg-amber-50 p-3 text-sm" data-testid="created-logins">
          <p className="font-medium">
            {batch.created.length} login{batch.created.length === 1 ? '' : 's'} created. Copy or
            download the passwords now: they are not shown again.
          </p>
          <table className="w-full">
            <tbody>
              {batch.created.map((c) => (
                <tr key={c.username} data-username={c.username}>
                  <td className="py-1 pr-2">{c.username}</td>
                  <td className="py-1 font-mono" data-testid="password">
                    {c.password}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            type="button"
            className={secondaryButton}
            disabled={downloaded}
            onClick={download}
          >
            {downloaded ? 'Downloaded' : 'Download as CSV (once)'}
          </button>
        </div>
      )}
      {batch && batch.skipped.length > 0 && (
        <ul className="text-sm text-slate-600">
          {batch.skipped.map((s) => (
            <li key={s.username}>
              {s.username}: skipped, {s.reason}
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

export function SendInvites({
  tenantId,
  waiting,
  jobId,
  suspended,
}: {
  tenantId: string;
  waiting: number;
  jobId: string | null;
  suspended: boolean;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (jobId) {
    return (
      <p className="text-sm">
        Invitations are queued.{' '}
        <a href={`/platform/jobs/${jobId}`} className="underline">
          Follow the job
        </a>
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={!hydrated || pending || waiting === 0 || suspended}
        className={primaryButton}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await requestInvites(tenantId);
            if (!r.ok) setError(r.message);
            else {
              setStatus(r.data ? 'Invitations queued.' : 'Nobody is waiting for an invitation.');
              router.refresh();
            }
          })
        }
      >
        Send {waiting} invitation{waiting === 1 ? '' : 's'}
      </button>
      <StatusBox message={status} />
      <ErrorBox message={error} />
    </div>
  );
}
