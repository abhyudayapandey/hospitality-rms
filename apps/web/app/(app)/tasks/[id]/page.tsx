import Link from 'next/link';
import { failure, taskIcon } from '@outlet-ops/domain';
import { Icon } from '@/components/icon';
import { ItemThumb } from '@/components/item-thumb';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatWhen, portionsText } from '@/lib/format';
import { formatQty } from '@/lib/inventory';
import { itemPhotoUrls, photosEnabled } from '@/lib/photos';
import { prepTaskRecipe, type PrepRecipe } from '@/lib/production';
import {
  assignablePeople,
  handOnPeople,
  taskDetail,
  taskPhotos,
  type Person,
  type TaskDetail,
  type TaskPhoto,
} from '@/lib/tasks';
import { overdueWhenGiven } from '@/lib/tasks-view';
import { complianceTask, dayWords, type ComplianceTaskRow } from '@/lib/compliance';
import { DoneForm, RenewForm } from '../../compliance/act-forms';
import { AcknowledgeHandover, AssignExpiry, CancelTask, SignOffWork, TaskWork } from './task-work';
import { AddTaskPhoto } from './task-photos';
import { MinibarTask, type MinibarTaskCheck } from './minibar-task';
import { ReassignTask, ReceiveSent, SentLines, type SentLine } from './receive-sent';

// One task (ADR 020): its steps for whoever works on it, and for task managers there who
// it is with. A reported expired batch shows the lead whom to give the discard to. Who has
// it, since when and how it got there; whoever may (its managers, the head of its people's
// department, whoever handed it on) gives it to someone else here (ADR 073, 074).
export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  let task: TaskDetail;
  let people: Person[];
  let sent: SentLine[];
  let about: ComplianceTaskRow | null;
  let recipe: PrepRecipe | null;
  let photos: (TaskPhoto & { url: string | null })[];
  let minibar: MinibarTaskCheck | null;
  try {
    ({ task, people, sent, about, recipe, photos, minibar } = await withUser(
      user.id,
      async (tx) => {
        const t = await taskDetail(tx, id);
        // the task's own photos, kept 30 days (ADR 079)
        const ph = await taskPhotos(tx, id);
        const urls = await itemPhotoUrls(
          ph.filter((x) => x.photo_key).map((x) => ({ item_id: x.id, photo_key: x.photo_key })),
        );
        // a reported expired batch: the lead gives the discard to someone there
        const p =
          t.status === 'reported' && t.can_manage
            ? await assignablePeople(tx, t.org_node_id)
            : t.can_hand_on
              ? await handOnPeople(tx, id)
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
        // something to make (ADR 076): its ingredients for this quantity, method and batches
        const r = t.kind === 'prep' ? await prepTaskRecipe(tx, id) : null;
        // a minibar's refill or bill (ADR 081): the room and what was used
        const m =
          t.kind === 'minibar_refill' || t.kind === 'minibar_bill'
            ? ((
                await sql<MinibarTaskCheck>`
                select check_id, room, store, used, charge, charged_at::text, short
                  from ops.minibar_task_check(${id}::uuid)`.execute(tx)
              ).rows[0] ?? null)
            : null;
        return {
          task: t,
          people: p,
          sent: lines,
          about: c,
          recipe: r,
          minibar: m,
          photos: ph.map((x) => ({ ...x, url: urls.get(x.id) ?? null })),
        };
      },
    ));
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
        <h1 className="flex items-center gap-2 text-xl font-semibold" data-testid="task-title">
          <Icon name={taskIcon(task.title, task.kind)} className="size-7 text-brand-700" />
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
        {open &&
          task.assignee_name &&
          overdueWhenGiven({ due_at: task.due_at, given: task.assigned_at }) && (
            <p
              className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900"
              data-testid="task-fair"
            >
              It was already overdue when it was given to {task.assignee_name}
              {task.assigned_at && ` (${formatWhen(task.assigned_at)})`}.
            </p>
          )}
        {task.description && (
          <p className="text-sm whitespace-pre-line text-slate-800">{task.description}</p>
        )}
        <SignOffLine task={task} open={open} />
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
      {recipe && <MakeIt recipe={recipe} unit={task.item?.unit ?? ''} open={open} />}
      {/* photos come before the button that finishes the task: they are part of doing it */}
      {(photos.length > 0 || (open && task.can_work && photosEnabled())) && (
        <section className="space-y-2" data-testid="task-photos">
          <h2 className="text-sm font-semibold text-slate-500">Photos</h2>
          {photos.length > 0 && (
            <ul className="grid grid-cols-3 gap-2">
              {photos.map((p) => (
                <li
                  key={p.id}
                  className="space-y-1 text-xs text-slate-500"
                  data-testid="task-photo"
                >
                  {p.url ? (
                    // a presigned S3 URL that changes on every page: next/image would cache it
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.url}
                      alt={`Photo by ${p.taken_by_name}`}
                      className="aspect-square w-full rounded-lg object-cover ring-1 ring-slate-200"
                    />
                  ) : (
                    <p className="flex aspect-square items-center justify-center rounded-lg bg-slate-100 p-2 text-center">
                      {p.photo_key ? 'Photo' : 'Photo removed'}
                    </p>
                  )}
                  <span className="block truncate">{p.taken_by_name}</span>
                </li>
              ))}
            </ul>
          )}
          {open && task.can_work && photosEnabled() && photos.length < 3 && (
            <AddTaskPhoto task={task.id} node={task.org_node_id} />
          )}
        </section>
      )}
      {minibar && (task.kind === 'minibar_refill' || task.kind === 'minibar_bill') ? (
        <MinibarTask
          task={task.id}
          kind={task.kind}
          check={minibar}
          canWork={task.can_work}
          open={open}
        />
      ) : about ? (
        <ComplianceWork task={task} about={about} />
      ) : task.kind === 'handover' ? (
        <>
          {task.handover_from && (
            <p className="text-sm text-slate-600" data-testid="handover-from">
              From {task.handover_from.by} at {task.handover_from.place},{' '}
              {formatWhen(task.handover_from.at)}
            </p>
          )}
          {open && task.can_work && <AcknowledgeHandover task={task.id} />}
        </>
      ) : task.kind === 'sign_off' ? (
        <>
          <TaskWork task={task} canWork={false} photos={false} />
          {open && task.can_work && <SignOffWork task={task} />}
        </>
      ) : task.kind === 'receive' ? (
        open && task.can_work ? (
          <ReceiveSent task={task.id} lines={sent} />
        ) : (
          <SentLines lines={sent} />
        )
      ) : (
        (task.steps.length > 0 || task.can_work) && (
          <TaskWork task={task} canWork={task.can_work} photos={photosEnabled()} />
        )
      )}
      {open && task.can_hand_on && (
        <ReassignTask task={task.id} people={people} current={task.assignee_user_id} />
      )}
      {task.handovers.length > 0 && <History task={task} />}
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
            {about.owner_role_name && ` · the ${about.owner_role_name} answers for it`}
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

/** What to make it from (ADR 076): the ingredients for the task's quantity and the method,
 * then a label for each batch made for it. */
function MakeIt({ recipe, unit, open }: { recipe: PrepRecipe; unit: string; open: boolean }) {
  return (
    <div className="space-y-3">
      {recipe.portions !== null && (
        <p className="text-sm text-slate-800" data-testid="prep-portions">
          Makes about <strong>{portionsText(recipe.portions)}</strong>
        </p>
      )}
      {open && recipe.ingredients.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-500">Ingredients for this batch</h2>
          <ul
            className="divide-y divide-slate-100 rounded-xl bg-white text-sm ring-1 ring-slate-200"
            data-testid="prep-ingredients"
          >
            {recipe.ingredients.map((l, i) => (
              <li
                key={i}
                className="flex items-center gap-3 px-4 py-2"
                data-testid="prep-ingredient"
              >
                <ItemThumb name={l.name} category={l.category} />
                <span className="min-w-0 flex-1 text-base">{l.name}</span>
                <span className="text-base font-semibold tabular-nums">
                  {formatQty(String(l.qty), l.unit)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {open && recipe.method.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-500">Method</h2>
          <ol
            className="space-y-2 rounded-xl bg-white p-4 text-sm ring-1 ring-slate-200"
            data-testid="prep-method"
          >
            {recipe.method.map((m) => (
              <li key={m.step} className="flex gap-3">
                <span className="font-semibold tabular-nums">{m.step}.</span>
                <span>
                  {m.instruction}
                  {m.minutes ? (
                    <span className="block text-xs text-slate-500">about {m.minutes} min</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
      {recipe.batches.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-500">Made for this task</h2>
          <ul className="divide-y divide-slate-100 rounded-xl bg-white text-sm ring-1 ring-slate-200">
            {recipe.batches.map((b) => (
              <li
                key={b.production_id}
                className="flex items-center justify-between gap-2 px-4 py-2"
              >
                <span>
                  batch {b.batch_no ?? '–'} · {formatQty(String(b.qty), unit)}
                </span>
                <Link
                  href={`/stock/production/label/${b.production_id}`}
                  className="flex min-h-11 items-center underline"
                  data-testid="task-label-link"
                >
                  Print its label
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * A checklist round's second signature (ADR 087): what it is waiting for, who signed it off,
 * or what it was sent back for; a sign-off says whose round it checks.
 */
function SignOffLine({ task, open }: { task: TaskDetail; open: boolean }) {
  if (task.kind === 'sign_off') {
    return (
      <p className="text-sm text-slate-800" data-testid="sign-off-about">
        {task.signs_off_done_by ?? 'Someone'} finished{' '}
        {task.signs_off && (
          <Link href={`/tasks/${task.signs_off}`} className="underline">
            {task.signs_off_title}
          </Link>
        )}
        . Check each step, then sign it off or send it back.
      </p>
    );
  }
  if (open && task.sent_back_note) {
    return (
      <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" data-testid="sent-back">
        Sent back to redo: {task.sent_back_note}
      </p>
    );
  }
  if (task.status !== 'done' || !task.sign_off_rule || task.sign_off_rule === 'none') return null;
  return (
    <p className="text-sm text-slate-800" data-testid="sign-off-status">
      {task.signed_off_by_name
        ? `Signed off by ${task.signed_off_by_name}${task.signed_off_at ? ` ${formatWhen(task.signed_off_at)}` : ''}`
        : task.sign_off_task?.status === 'open' || task.sign_off_task?.status === 'in_progress'
          ? `Waiting for sign-off by ${task.sign_off_task.assignee_name ?? 'someone'}`
          : 'Nobody was there to sign it off'}
    </p>
  );
}

/** Each time the task reached someone, oldest first (ADR 074). */
function History({ task }: { task: TaskDetail }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-slate-500">Who it has been with</h2>
      <ol
        className="divide-y divide-slate-100 rounded-xl bg-white text-sm ring-1 ring-slate-200"
        data-testid="handover-history"
      >
        {task.handovers.map((h, i) => (
          <li key={i} className="px-4 py-2">
            <span className="block">
              {h.took
                ? `${h.to_name} took it`
                : h.by_name
                  ? `${h.by_name} gave it to ${h.to_name}`
                  : `Given to ${h.to_name} (covering)`}
            </span>
            <span className="block text-xs text-slate-500">{formatWhen(h.at)}</span>
          </li>
        ))}
      </ol>
    </section>
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
          : `For the ${t.job_role_name ?? 'job role'}: the first to start takes it`;
      const since = t.assigned_at ? ` since ${formatWhen(t.assigned_at)}` : '';
      return `${t.status === 'in_progress' ? 'Started' : 'To do'} · ${who}${since}${
        t.assigned_by_name && t.assignee_name ? ` · from ${t.assigned_by_name}` : ''
      }`;
    }
  }
}
