import Link from 'next/link';
import { failure } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { formatQty } from '@/lib/inventory';
import { photosEnabled } from '@/lib/photos';
import { assignablePeople, taskDetail, type Person, type TaskDetail } from '@/lib/tasks';
import { complianceTask, dayWords, type ComplianceTaskRow } from '@/lib/compliance';
import { DoneForm, RenewForm } from '../../compliance/act-forms';
import { AssignExpiry, CancelTask, TaskWork } from './task-work';
import { ReassignTask, ReceiveSent, SentLines, type SentLine } from './receive-sent';

// One task (ADR 020): its steps for whoever works on it, and for task managers there who
// it is with. A reported expired batch shows the lead whom to give the discard to.
export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  let task: TaskDetail;
  let people: Person[];
  let sent: SentLine[];
  let about: ComplianceTaskRow | null;
  try {
    ({ task, people, sent, about } = await withUser(user.id, async (tx) => {
      const t = await taskDetail(tx, id);
      const toDo = t.status === 'reported' || t.status === 'open' || t.status === 'in_progress';
      const p =
        toDo && t.can_manage && (t.status === 'reported' || t.kind === 'receive')
          ? await assignablePeople(tx, t.org_node_id)
          : [];
      // a delivery from the Main Store (ADR 051): what was sent
      const lines =
        t.kind === 'receive'
          ? (
              await sql<SentLine>`
                select item_id::text, name, base_uom, sent::text, received::text
                  from ops.sent_lines(${id}::uuid)`.execute(tx)
            ).rows
          : [];
      // a licence's renewal or a compliance job (ADR 069): what it is about
      const c =
        t.kind === 'licence' || t.kind === 'compliance' ? await complianceTask(tx, id) : null;
      return { task: t, people: p, sent: lines, about: c };
    }));
  } catch (err) {
    return (
      <p className="rounded-xl bg-white p-6 text-center text-slate-600 ring-1 ring-slate-200">
        {failure(err).message}
      </p>
    );
  }
  const open = task.status === 'open' || task.status === 'in_progress';
  return (
    <div className="space-y-4">
      <Link href="/tasks" className="text-sm text-slate-600 underline">
        Back to tasks
      </Link>
      <header className="space-y-1">
        <h1 className="text-xl font-semibold" data-testid="task-title">
          {task.title}
        </h1>
        <p className="text-sm text-slate-600">
          {task.place_name}
          {task.store_name && ` · ${task.store_name}`} · due {formatWhen(task.due_at)}
          {task.priority === 'high' && ' · high priority'}
        </p>
        <p className="text-sm text-slate-600" data-testid="task-status">
          {statusLine(task)}
        </p>
        {task.description && (
          <p className="text-sm whitespace-pre-line text-slate-800">{task.description}</p>
        )}
        {task.kind === 'prep' && task.item && task.target_qty !== null && (
          <p className="text-sm text-slate-800" data-testid="prep-progress">
            Made {formatQty(String(task.made_qty), task.item.unit)} of{' '}
            {formatQty(String(task.target_qty), task.item.unit)}
          </p>
        )}
      </header>
      {task.status === 'reported' &&
        (task.can_manage ? (
          <AssignExpiry task={task.id} people={people} />
        ) : (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
            Reported. The department head will give it to someone to discard.
          </p>
        ))}
      {about ? (
        <ComplianceWork task={task} about={about} />
      ) : task.kind === 'receive' ? (
        <>
          {open && task.can_work ? (
            <ReceiveSent task={task.id} lines={sent} />
          ) : (
            <SentLines lines={sent} />
          )}
          {open && task.can_manage && (
            <ReassignTask task={task.id} people={people} current={task.assignee_user_id} />
          )}
        </>
      ) : (
        (task.steps.length > 0 || task.can_work) && (
          <TaskWork task={task} canWork={task.can_work} photos={photosEnabled()} />
        )
      )}
      {open && task.can_manage && !about && task.kind !== 'expiry' && task.kind !== 'receive' && (
        <CancelTask task={task.id} />
      )}
    </div>
  );
}

/** A licence's renewal or a compliance job on the To do list (ADR 069): what it is about, and
 * the renew or mark-done form for whoever it is with. Done only by doing it. */
function ComplianceWork({ task, about }: { task: TaskDetail; about: ComplianceTaskRow }) {
  return (
    <div className="space-y-3">
      <p className="rounded-xl bg-white p-4 text-sm ring-1 ring-slate-200" data-testid="about">
        {about.licence_id ? (
          <>
            {about.name} at {about.place_name}
            {about.number && ` · ${about.number}`}
            {about.authority && ` · issued by ${about.authority}`}
            {about.expires_on && ` · expires ${dayWords(about.expires_on)}`}
          </>
        ) : (
          <>
            {about.name} at {about.place_name}
            {about.next_due && ` · due ${dayWords(about.next_due)}`}
            {about.needs_proof && ' · keep the report or certificate'}
          </>
        )}
      </p>
      {about.can_act &&
        (about.licence_id ? (
          <RenewForm
            licence={about.licence_id}
            node={task.org_node_id}
            number={about.number}
            photos={photosEnabled()}
            done={`/tasks/${task.id}`}
          />
        ) : (
          about.item_id && (
            <DoneForm
              job={about.item_id}
              node={task.org_node_id}
              needsProof={about.needs_proof}
              photos={photosEnabled()}
            />
          )
        ))}
    </div>
  );
}

function statusLine(t: TaskDetail): string {
  switch (t.status) {
    case 'reported':
      return `Reported by ${t.reported_by_name ?? 'someone'}, not assigned yet`;
    case 'done':
      return `Done${t.completed_at ? ` ${formatWhen(t.completed_at)}` : ''}`;
    case 'cancelled':
      return `Cancelled${t.cancel_reason ? `: ${t.cancel_reason}` : ''}`;
    default: {
      const who = t.assignee_name
        ? `With ${t.assignee_name}`
        : t.assign_mode === 'on_shift'
          ? 'For whoever is on shift'
          : 'For the job role: the first to start takes it';
      return `${t.status === 'in_progress' ? 'Started' : 'To do'} · ${who}${
        t.assigned_by_name ? ` · from ${t.assigned_by_name}` : ''
      }`;
    }
  }
}
