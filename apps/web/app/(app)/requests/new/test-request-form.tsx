'use client';

import { useActionState, useState } from 'react';
import { submitTestRequest, type TestRequestState } from './actions';

export interface ProcessOption {
  type: string;
  label: string;
  hierarchy: 'org' | 'delivery';
}

export interface NodeOption {
  id: string;
  label: string;
  type: 'org' | 'delivery';
}

export function TestRequestForm({
  processes,
  nodes,
  idempotencyKey,
}: {
  processes: ProcessOption[];
  nodes: NodeOption[];
  idempotencyKey: string;
}) {
  const [state, action, pending] = useActionState<TestRequestState, FormData>(
    submitTestRequest,
    {},
  );
  const [process, setProcess] = useState(processes[0]?.type ?? '');
  const hierarchy = processes.find((p) => p.type === process)?.hierarchy;
  const nodeOptions = nodes.filter((n) => n.type === hierarchy);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <label className="block">
        <span className="text-sm font-medium">Request type</span>
        <select
          name="process"
          value={process}
          onChange={(e) => setProcess(e.target.value)}
          className="mt-1 block min-h-12 w-full rounded-lg border border-slate-300 bg-white px-3"
        >
          {processes.map((p) => (
            <option key={p.type} value={p.type}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-sm font-medium">Location</span>
        <select
          name="node"
          key={hierarchy}
          className="mt-1 block min-h-12 w-full rounded-lg border border-slate-300 bg-white px-3"
        >
          {nodeOptions.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-sm font-medium">Amount (INR)</span>
        <input
          name="amount"
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          defaultValue="1000"
          className="mt-1 block min-h-12 w-full rounded-lg border border-slate-300 px-3"
        />
      </label>
      {state.error && (
        <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending || nodeOptions.length === 0}
        className="min-h-12 w-full rounded-lg bg-slate-900 font-medium text-white disabled:opacity-50"
      >
        {pending ? 'Submitting…' : 'Submit request'}
      </button>
    </form>
  );
}
