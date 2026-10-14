import { Icon, type IconName } from '@/components/icon';
import { formatWhen } from '@/lib/format';

// Where a stock request is now and what happened to it (ADR 115): one line in colour, first on
// its page, then its story, oldest first, the requests and orders it waited on included.

const STAGE: Record<string, { icon: IconName; style: string }> = {
  received: { icon: 'check', style: 'bg-emerald-50 text-emerald-900 ring-emerald-200' },
  given: { icon: 'check', style: 'bg-emerald-50 text-emerald-900 ring-emerald-200' },
  arrived: { icon: 'check', style: 'bg-emerald-50 text-emerald-900 ring-emerald-200' },
  on_the_way: { icon: 'truck', style: 'bg-sky-50 text-sky-900 ring-sky-200' },
  waiting_approval: { icon: 'clock', style: 'bg-violet-50 text-violet-900 ring-violet-200' },
  closed: { icon: 'x', style: 'bg-rose-50 text-rose-900 ring-rose-200' },
  stuck: { icon: 'alert', style: 'bg-rose-50 text-rose-900 ring-rose-200' },
};
const WAITING = { icon: 'clock' as IconName, style: 'bg-amber-50 text-amber-900 ring-amber-200' };

export function RequestNow({ stage, words }: { stage: string; words: string }) {
  const s = STAGE[stage] ?? WAITING;
  return (
    <p
      className={`flex items-start gap-2 rounded-xl p-3 text-sm font-medium ring-1 ${s.style}`}
      data-testid="request-now"
      data-stage={stage}
    >
      <Icon name={s.icon} className="mt-0.5 size-5 shrink-0" />
      {words}
    </p>
  );
}

export function RequestStory({ story }: { story: { at: Date; words: string }[] }) {
  if (story.length === 0) return null;
  return (
    <details className="rounded-xl bg-white text-sm ring-1 ring-slate-200" open>
      <summary className="flex min-h-11 cursor-pointer items-center px-4 font-medium text-slate-600">
        What happened
      </summary>
      <ol className="space-y-2 px-4 pb-3" data-testid="request-story">
        {/* newest first (ADR 142) */}
        {[...story].reverse().map((s, i) => (
          <li key={i} className="flex gap-3">
            <span className="mt-1.5 size-2 shrink-0 rounded-full bg-slate-400" aria-hidden />
            <span>
              <span className="block text-slate-800">{s.words}</span>
              <span className="text-xs text-slate-500">{formatWhen(s.at)}</span>
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}
