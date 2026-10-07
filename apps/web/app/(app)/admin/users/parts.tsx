'use client';

// Small pieces shared by the people screens.

export function AppliesBadge({ applies }: { applies: string }) {
  const [label, style] =
    applies === 'approval'
      ? ['Waiting for approval', 'bg-amber-100 text-amber-900']
      : applies === 'sole owner: now'
        ? ['Applies now (sole owner)', 'bg-emerald-100 text-emerald-900']
        : ['Applies now', 'bg-emerald-100 text-emerald-900'];
  return (
    <span
      data-testid="applies"
      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${style}`}
    >
      {label}
    </span>
  );
}

/**
 * A temporary password, shown once. The download is built in the browser from this
 * response; nothing is stored on the server or logged.
 */
export function OneTimePassword({ username, password }: { username: string; password: string }) {
  const download = () => {
    const blob = new Blob([`Username: ${username}\nTemporary password: ${password}\n`], {
      type: 'text/plain',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${username}-temporary-password.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="space-y-2 rounded-xl bg-white p-4 ring-1 ring-slate-200">
      <p className="text-sm">
        Temporary password for <strong>{username}</strong> (shown once; they choose their own at
        their first sign-in):
      </p>
      <p
        data-testid="temporary-password"
        className="rounded-lg bg-slate-100 p-3 text-center font-mono text-lg tracking-wider"
      >
        {password}
      </p>
      <button
        type="button"
        onClick={download}
        className="min-h-11 w-full rounded-lg text-sm font-medium ring-1 ring-slate-300"
      >
        Download
      </button>
    </div>
  );
}
