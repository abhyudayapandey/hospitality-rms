import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { isDevAuthEnabled } from '@/lib/dev-auth';
import { processLabel } from '@/lib/format';
import { TestRequestForm } from './test-request-form';

// DEV ONLY (ADR 004): gated like /dev-login (404 in production). Remove in the
// inventory prompt, when real subject screens submit their own requests.
export default async function NewTestRequestPage() {
  if (!isDevAuthEnabled()) notFound();
  const user = await requireUser();
  const { processes, nodes } = await withUser(user.id, async (tx) => {
    const p = await sql<{ process_type: string; hierarchy_type: 'org' | 'delivery' }>`
      select process_type, hierarchy_type from wf.my_processes()
       where process_type <> 'TRANSFER'`.execute(tx); // TRANSFER needs from/to nodes
    const n = await sql<{ id: string; name: string; type: 'org' | 'delivery' }>`
      select id, name, type from core.nodes() where not derived`.execute(tx);
    return { processes: p.rows, nodes: n.rows };
  });
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">New test request</h1>
      <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
        Development only. Submits a workflow request without a real document.
      </p>
      <TestRequestForm
        processes={processes.map((p) => ({
          type: p.process_type,
          label: processLabel(p.process_type),
          hierarchy: p.hierarchy_type,
        }))}
        nodes={nodes.map((n) => ({ id: n.id, label: n.name, type: n.type }))}
        idempotencyKey={crypto.randomUUID()}
      />
    </div>
  );
}
