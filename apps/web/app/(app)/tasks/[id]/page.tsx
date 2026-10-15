import Link from 'next/link';
import { redirect } from 'next/navigation';
import { failure, taskIcon } from '@outlet-ops/domain';
import { BackLink } from '@/components/back-link';
import { AllergenLine } from '@/components/food-mark';
import { Icon } from '@/components/icon';
import { ItemThumb } from '@/components/item-thumb';
import { MethodSteps } from '@/components/method-steps';
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
import { isUrgent, overdueWhenGiven } from '@/lib/tasks-view';
import { complianceTask, dayWords, type ComplianceTaskRow } from '@/lib/compliance';
import { DoneForm, RenewForm } from '../../compliance/act-forms';
import {
  AcknowledgeHandover,
  ApproveDiscard,
  AssignExpiry,
  CancelTask,
  SignOffWork,
  TaskWork,
} from './task-work';
import { AddTaskPhoto } from './task-photos';
import { MinibarTask, type MinibarTaskCheck } from './minibar-task';
import { ReassignTask, ReceiveSent, SentLines, type SentLine } from './receive-sent';
import { SendTask, type SendLine } from './send-task';
import { RequestStory } from '../../stock/transfers/[id]/request-story';

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
  let send: SendLine[];
  let forAsk: string | null;
  // what a frontline person asked for (ADR 115), or its Collect task (ADR 142): its own page,
  // where the head acts on it and whoever asked follows it (ADR 141); found through
  // ops.task_ask first, since the head's task row is hidden from whoever asked
  const askPage = await withUser(
    user.id,
    async (tx) =>
      (
        await sql<{ ask: string | null }>`
          select ops.task_ask(${id}::uuid)::text as ask`.execute(tx)
      ).rows[0]?.ask ?? null,
  ).catch(() => null);
  if (askPage) redirect(`/stock/asks/${askPage}`);
  // a send or receive task is a step of a request: it is done on the request's one screen
  // (ADR 147), the ask's page when it was made for one, else the request's own
  const requestPage = await withUser(user.id, async (tx) => {
    const r = (
      await sql<{ transfer: string; ask: string | null; readable: boolean }>`
        select t.transfer_id::text as transfer, inv.request_ask(t.transfer_id)::text as ask,
               exists (select 1 from inv.transfer_summary s where s.id = t.transfer_id) as readable
          from ops.task t
         where t.id = ${id}::uuid and t.kind in ('send', 'receive')
           and t.transfer_id is not null`.execute(tx)
    ).rows[0];
    if (!r) return null;
    return r.ask ? `/stock/asks/${r.ask}` : r.readable ? `/stock/transfers/${r.transfer}` : null;
  }).catch(() => null);
  if (requestPage) redirect(requestPage);
  // a send or receive task is one step of a request (ADR 143): its page tells the request's
  // whole story, from whoever asked first, as the request's own page does; nothing for anyone
  // who may not follow the request
  const chain = await withUser(user.id, async (tx) => {
    const t = (
      await sql<{ transfer: string | null }>`
        select transfer_id::text as transfer from ops.task
         where id = ${id}::uuid and kind in ('send', 'receive')`.execute(tx)
    ).rows[0]?.transfer;
    if (!t) return null;
    const story = (
      await sql<{ at: Date; words: string }>`
        select at, words from inv.request_story(${t}::uuid)`.execute(tx)
    ).rows;
    return { transfer: t, story };
  }).catch(() => null);
  try {
    ({ task, people, sent, about, recipe, photos, minibar, send, forAsk } = await withUser(
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
          t.status === 'reported' && (t.can_manage || t.discard?.can_approve)
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
        // stock to take to whoever asked (ADR 115): what was asked, what the store has
        const toSend =
          t.kind === 'send'
            ? (
                await sql<SendLine>`
                select item_id::text, name, base_uom, asked::text, at_store::text, sent::text
                  from ops.send_task_lines(${id}::uuid)`.execute(tx)
              ).rows
            : [];
        // stock sent for a frontline ask: who asked, and why (ADR 142)
        const ask =
          t.kind === 'send' || t.kind === 'receive'
            ? (
                await sql<{ asked_by: string; note: string | null }>`
                select asked_by, note from inv.request_for_ask(
                  (select transfer_id from ops.task where id = ${id}::uuid))`.execute(tx)
              ).rows[0]
            : undefined;
        return {
          task: t,
          people: p,
          sent: lines,
          send: toSend,
          forAsk: ask ? `For ${ask.asked_by}${ask.note ? `: ${ask.note}` : ''}` : null,
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
  const mine = task.assignee_user_id === user.id;
  const late = open && new Date(task.due_at).getTime() < Date.now();
  return (
    <div className="space-y-4">
      <BackLink fallback="/tasks" />
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold" data-testid="task-title">
          <Icon name={taskIcon(task.title, task.kind)} className="size-7 text-brand-700" />
          {task.title}
        </h1>
        {/* one line under the title: when it is due, red when late (ADR 098); who has it, from
            whom and since when are under History */}
        {open ? (
          <p
            className={`flex items-center gap-1.5 text-sm ${late ? 'font-semibold text-rose-700' : 'text-slate-600'}`}
            data-testid="task-due"
          >
            <Icon name="clock" className="size-4 shrink-0" />
            {late ? 'Late · was due ' : 'Due '}
            {formatWhen(task.due_at)}
            {isUrgent(task) && ' · urgent'}
          </p>
        ) : (
          <p className="text-sm text-slate-600" data-testid="task-status">
            {statusLine(task)}
          </p>
        )}
        {forAsk && (
          <p className="text-sm font-medium text-slate-800" data-testid="for-ask">
            {forAsk}
          </p>
        )}
        {task.description && (
          <p className="text-sm whitespace-pre-line text-slate-800">{task.description}</p>
        )}
        <SignOffLine task={task} open={open} />
        {task.done_note && (
          <section
            aria-label="Note"
            className="space-y-1 rounded-xl bg-amber-50 p-4 text-amber-900 ring-1 ring-amber-300"
            data-testid="task-note"
          >
            <h2 className="inline-flex items-center gap-2 text-sm font-semibold">
              <Icon name="clipboard" className="size-5" />
              Note
              {task.completed_by_name && ` from ${task.completed_by_name}`}
            </h2>
            <p className="text-base whitespace-pre-line">{task.done_note}</p>
          </section>
        )}
        {task.kind === 'prep' && task.item && task.target_qty !== null && (
          <p className="text-sm text-slate-800" data-testid="prep-progress">
            Made {formatQty(String(task.made_qty), task.item.unit)} of{' '}
            {formatQty(String(task.target_qty), task.item.unit)}
          </p>
        )}
      </header>
      {task.status === 'reported' && task.kind === 'discard' ? (
        task.discard?.can_approve ? (
          <ApproveDiscard task={task.id} people={people} />
        ) : (
          <p
            className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900"
            data-testid="discard-waiting"
          >
            Waiting for {task.discard?.needs_gm ? 'the GM' : 'the department head'} to approve
            throwing it away.
          </p>
        )
      ) : (
        task.status === 'reported' &&
        (task.can_manage ? (
          <AssignExpiry task={task.id} people={people} />
        ) : (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
            Reported. The department head will give it to someone to discard.
          </p>
        ))
      )}
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
      ) : task.kind === 'send' ? (
        <SendTask task={task.id} lines={send} canWork={open && task.can_work} />
      ) : task.kind === 'receive' ? (
        open && task.can_work ? (
          <ReceiveSent
            task={task.id}
            lines={sent}
            department={task.place_name.replace(/^.*\s[–-]\s/, '')}
          />
        ) : (
          <SentLines lines={sent} />
        )
      ) : (
        (task.steps.length > 0 || task.can_work) && (
          <TaskWork
            task={task}
            canWork={task.can_work}
            photos={photosEnabled()}
            photoCount={photos.length}
          />
        )
      )}
      {open && task.can_hand_on && (
        <ReassignTask task={task.id} people={people} current={task.assignee_user_id} />
      )}
      {chain && chain.story.length > 0 && (
        <>
          <RequestStory story={chain.story} />
          <Link
            href={`/stock/transfers/${chain.transfer}`}
            className="flex min-h-11 items-center text-sm font-medium text-brand-700"
            data-testid="task-request"
          >
            Open the request
          </Link>
        </>
      )}
      {/* who has it and how it got there: open for those who follow it, folded for the person
          doing it, who needs only the job (ADR 098) */}
      {(!chain || open) && (
        <details
          className="rounded-xl bg-white text-sm ring-1 ring-slate-200"
          open={!mine && (task.can_manage || task.can_hand_on)}
          data-testid="task-more"
        >
          <summary className="flex min-h-11 cursor-pointer items-center px-4 font-medium text-slate-600">
            History
          </summary>
          <div className="space-y-2 px-4 pb-3">
            {!chain && (
              <p className="text-slate-600">
                {task.place_name}
                {task.store_name && ` · ${task.store_name}`}
              </p>
            )}
            {open && (
              <p className="text-slate-600" data-testid="task-status">
                {statusLine(task)}
              </p>
            )}
            {open &&
              !mine &&
              task.assignee_name &&
              overdueWhenGiven({ due_at: task.due_at, given: task.assigned_at }) && (
                <p className="rounded-lg bg-amber-50 p-3 text-amber-900" data-testid="task-fair">
                  It was already overdue when it was given to {task.assignee_name}
                  {task.assigned_at && ` (${formatWhen(task.assigned_at)})`}.
                </p>
              )}
            {task.handovers.length > 0 && !chain && <History task={task} />}
          </div>
        </details>
      )}
      {open &&
        task.can_manage &&
        !about &&
        task.kind !== 'expiry' &&
        task.kind !== 'receive' &&
        task.kind !== 'send' && <CancelTask task={task.id} />}
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
      <AllergenLine allergens={recipe.allergens} />
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
          <div data-testid="prep-method">
            <MethodSteps
              steps={recipe.method}
              ingredients={recipe.ingredients}
              testId="prep-method-step"
            />
          </div>
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
    <section>
      <ol className="divide-y divide-slate-100" data-testid="handover-history">
        {/* newest first (ADR 142) */}
        {[...task.handovers].reverse().map((h, i) => (
          <li key={i} className="py-2">
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
