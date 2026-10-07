import { BackLink } from '@/components/back-link';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { PeopleList, type ShowAsPerson } from './people-list';

// Show as someone else, for demos (ADR 071): a demo presenter of a test customer picks a
// person of their company and sees the app exactly as they would.
export default async function ShowAsPage() {
  const user = await requireUser();
  const presenter = user.presentedBy?.id ?? user.id;
  if (!user.canShowAs) {
    return (
      <div className="space-y-4">
        <BackLink />
        <h1 className="text-xl font-semibold">Show as someone</h1>
        <Empty>Only a demo presenter of a test company can show the app as someone else.</Empty>
      </div>
    );
  }
  // read as the presenter: who they may show as
  const people = await withUser(presenter, async (tx) => {
    const r = await sql<ShowAsPerson>`select * from core.show_as_people()`.execute(tx);
    return r.rows;
  });
  return (
    <div className="space-y-4">
      <BackLink />
      <div>
        <h1 className="text-xl font-semibold">Show as someone</h1>
        <p className="text-sm text-slate-600">
          See the app exactly as they would: their Home, their screens, their To do list. Anything
          you do is recorded as theirs, with you named as the presenter.
        </p>
      </div>
      <PeopleList
        people={people}
        current={user.presentedBy ? user.id : null}
        presenterName={user.presentedBy?.name ?? user.name}
      />
    </div>
  );
}
