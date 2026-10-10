'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from './icon';

/**
 * "Start N min timer" on a recipe step (ADR 100): counts down on the phone itself, so it works
 * offline; at the end it shows "Time's up", vibrates and beeps where the phone lets it.
 */
export function StepTimer({ minutes }: { minutes: number }) {
  const [endAt, setEndAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const rang = useRef(false);

  useEffect(() => {
    if (endAt === null) return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [endAt]);

  const left = endAt === null ? null : Math.max(0, Math.round((endAt - now) / 1000));
  useEffect(() => {
    if (left !== 0 || rang.current) return;
    rang.current = true;
    try {
      navigator.vibrate?.([400, 200, 400, 200, 400]);
    } catch {
      /* no vibration here */
    }
    try {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctx) {
        const ctx = new Ctx();
        for (let i = 0; i < 3; i++) {
          const o = ctx.createOscillator();
          o.frequency.value = 880;
          o.connect(ctx.destination);
          o.start(ctx.currentTime + i * 0.5);
          o.stop(ctx.currentTime + i * 0.5 + 0.25);
        }
      }
    } catch {
      /* no sound here */
    }
  }, [left]);

  if (endAt === null || left === null) {
    return (
      <button
        type="button"
        data-testid="step-timer"
        onClick={() => {
          rang.current = false;
          setNow(Date.now());
          setEndAt(Date.now() + minutes * 60_000);
        }}
        className="flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-brand-700 px-4 text-lg font-semibold text-white"
      >
        <Icon name="clock" className="size-6" />
        Start {minutes} min timer
      </button>
    );
  }
  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, '0');
  return (
    <div
      role="timer"
      aria-live="polite"
      data-testid="step-timer-running"
      className={`flex min-h-14 items-center justify-between gap-3 rounded-xl px-4 ring-1 ${
        left === 0
          ? 'bg-amber-50 text-amber-900 ring-amber-200'
          : 'bg-brand-50 text-brand-800 ring-brand-100'
      }`}
    >
      <span className="flex items-center gap-2 text-2xl font-semibold tabular-nums">
        <Icon name={left === 0 ? 'bell' : 'clock'} className="size-6" />
        {left === 0 ? "Time's up" : `${mm}:${ss}`}
      </span>
      <button
        type="button"
        onClick={() => setEndAt(null)}
        className="min-h-11 rounded-lg px-3 text-sm font-medium underline"
      >
        {left === 0 ? 'Done' : 'Stop'}
      </button>
    </div>
  );
}
