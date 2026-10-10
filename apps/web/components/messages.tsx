import { Icon, type IconName } from './icon';

export function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">
      {message}
    </p>
  );
}

export function StatusBox({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm font-medium text-emerald-800">
      {message}
    </p>
  );
}

export function Empty({ children, icon }: { children: React.ReactNode; icon?: IconName }) {
  return (
    <p className="flex flex-col items-center gap-2 rounded-xl bg-white p-6 text-center text-slate-600 ring-1 ring-slate-200">
      {icon && <Icon name={icon} className="size-10 text-slate-400" />}
      {children}
    </p>
  );
}

export const inputClass =
  'min-h-12 w-full rounded-lg border border-slate-300 bg-white px-3 text-base tabular-nums';
export const primaryButton =
  'min-h-12 w-full rounded-lg bg-brand-700 font-medium text-white disabled:opacity-50';
export const secondaryButton =
  'min-h-12 w-full rounded-lg border border-slate-300 bg-white font-medium disabled:opacity-50';
