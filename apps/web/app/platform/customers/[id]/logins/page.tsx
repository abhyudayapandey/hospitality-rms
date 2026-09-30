import Link from 'next/link';
import { notFound } from 'next/navigation';
import { sql, withPlatformAdmin } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { requirePlatformAdmin } from '@/lib/platform/server';
import type { PlatformCustomer } from '../../../parts';
import { InvitePoller, SendInvites, UsernameLogins } from './logins-parts';

interface Candidate {
  user_id: string;
  username: string;
  display_name: string;
  login_type: 'username' | 'email';
  email: string | null;
  job_title: string | null;
  has_login: boolean;
  invited_at: Date | null;
}

interface InviteStatus {
  waiting: number;
  invited: number;
  sent_last_day: number;
  daily_limit: number;
  next_batch_at: Date | null;
  job_id: string | null;
}

// Logins for a customer's imported people (ADR 013, PRD ADM-3). Username logins are made
// here, their passwords shown once; email logins are Cognito invitations, which the worker
// sends within the pool's daily email allowance.
export default async function LoginsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const admin = await requirePlatformAdmin();
  const data = await withPlatformAdmin(admin, async (tx) => ({
    customer: (
      await sql<PlatformCustomer>`select * from platform.customer(${id}::uuid)`.execute(tx)
    ).rows[0],
    people: (await sql<Candidate>`select * from platform.login_candidates(${id}::uuid)`.execute(tx))
      .rows,
    invites: (
      await sql<InviteStatus>`select * from platform.invite_status(${id}::uuid)`.execute(tx)
    ).rows[0]!,
  }));
  const { customer, people, invites } = data;
  if (!customer) notFound();
  const byUsername = people.filter((p) => p.login_type === 'username');
  const usernameWaiting = byUsername.filter((p) => !p.has_login).length;
  const inviteBusy = invites.job_id !== null;
  return (
    <>
      <Link href={`/platform/customers/${id}`} className="text-sm text-slate-600">
        ← {customer.name}
      </Link>
      <h1 className="text-xl font-semibold">Logins · {customer.code}</h1>

      <section className="space-y-2 rounded-xl bg-white p-3 ring-1 ring-slate-200">
        <h2 className="font-semibold">Username logins</h2>
        <p className="text-sm text-slate-600" data-testid="username-summary">
          {byUsername.length - usernameWaiting} of {byUsername.length} have a login;{' '}
          {usernameWaiting} waiting. These are not limited: they send no email.
        </p>
        <UsernameLogins
          tenantId={id}
          isTest={customer.is_test}
          waiting={usernameWaiting}
          suspended={customer.status !== 'active'}
        />
      </section>

      <section className="space-y-2 rounded-xl bg-white p-3 ring-1 ring-slate-200">
        <h2 className="font-semibold">Email invitations</h2>
        <p className="text-sm text-slate-600">
          Cognito sends the customer pool’s email with its default sender, which allows about 50
          messages a day for all customers together, sign-in codes included. Invitations use at most{' '}
          {invites.daily_limit} of them a day and go out in batches; the rest wait and go
          automatically when the allowance frees up, so a large customer takes more than one day.
          Username logins aren’t limited.
        </p>
        <p className="text-sm" data-testid="invite-summary">
          {invites.invited} invited, {invites.waiting} waiting · {invites.sent_last_day} of{' '}
          {invites.daily_limit} sent in the last 24 hours
          {invites.next_batch_at ? ` · next batch after ${formatWhen(invites.next_batch_at)}` : ''}
        </p>
        {inviteBusy && <InvitePoller />}
        <SendInvites
          tenantId={id}
          waiting={invites.waiting}
          jobId={invites.job_id}
          suspended={customer.status !== 'active'}
        />
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">People</h2>
        <ul className="divide-y divide-slate-200 rounded-xl bg-white text-sm ring-1 ring-slate-200">
          {people.map((p) => (
            <li
              key={p.user_id}
              className="flex justify-between gap-2 p-3"
              data-username={p.username}
            >
              <span>
                {p.display_name} <span className="text-slate-500">{p.username}</span>
              </span>
              <span className="text-right text-slate-600">
                {p.login_type === 'email' ? 'email' : 'username'} ·{' '}
                {p.has_login
                  ? p.invited_at
                    ? `invited ${formatWhen(p.invited_at)}`
                    : 'has a login'
                  : 'no login yet'}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
