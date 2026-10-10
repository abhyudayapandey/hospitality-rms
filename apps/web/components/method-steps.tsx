import { stepIcon } from '@outlet-ops/domain';
import { ingredientsInStep, stepMinutes } from '@/lib/method';
import { Icon } from './icon';
import { ItemThumb } from './item-thumb';
import { StepTimer } from './step-timer';

export interface MethodStep {
  step: number;
  instruction: string;
  minutes: number | null;
}

/**
 * A recipe's method with pictures (ADR 100), for cooks who read little: each step's number and
 * a picture of what to do, its words, the photos of the ingredients it names, and a timer when
 * it takes minutes. The recipe page's Recipe tab and a prep task's Method.
 */
export function MethodSteps({
  steps,
  ingredients,
  testId = 'step',
}: {
  steps: MethodStep[];
  ingredients: { name: string; category?: string | null }[];
  testId?: string;
}) {
  return (
    <ol className="space-y-2">
      {steps.map((s) => {
        const named = ingredientsInStep(s.instruction, ingredients);
        const minutes = stepMinutes(s.instruction, s.minutes);
        return (
          <li
            key={s.step}
            data-testid={testId}
            className="space-y-3 rounded-xl bg-white p-3 ring-1 ring-slate-200"
          >
            <div className="flex gap-3">
              <span className="flex shrink-0 flex-col items-center gap-1">
                <span className="flex size-8 items-center justify-center rounded-full bg-brand-700 text-sm font-semibold text-white">
                  {s.step}
                </span>
                <span
                  aria-hidden
                  data-testid="step-picture"
                  data-icon={stepIcon(s.instruction, 'tick')}
                  className="flex size-12 items-center justify-center rounded-lg bg-brand-50 text-brand-700 ring-1 ring-brand-100"
                >
                  <Icon name={stepIcon(s.instruction, 'tick')} className="size-7" />
                </span>
              </span>
              <span className="min-w-0 flex-1 space-y-2">
                <span className="block text-base">{s.instruction}</span>
                {named.length > 0 && (
                  <span className="flex flex-wrap gap-2" data-testid="step-ingredients">
                    {named.map((i) => (
                      <span key={i.name} className="flex items-center gap-1 text-xs text-slate-600">
                        <ItemThumb name={i.name} category={i.category} size="size-10" />
                        <span className="max-w-20 truncate">{i.name}</span>
                      </span>
                    ))}
                  </span>
                )}
              </span>
            </div>
            {minutes !== null && <StepTimer minutes={minutes} />}
          </li>
        );
      })}
    </ol>
  );
}
