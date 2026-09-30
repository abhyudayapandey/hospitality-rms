import { z } from 'zod';

// Process definitions live in code and are synced into wf.process_def (LLD section 4).
// The SQL engine reads the synced JSON, so this schema is the contract for both sides.

export const scopeSchema = z.enum(['subject_node', 'nearest_ancestor', 'from_node', 'to_node']);

export const stepSchema = z.strictObject({
  step: z.string().regex(/^[a-z][a-z0-9_]*$/),
  group: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  scope: scopeSchema,
  when: z
    .strictObject({
      amount_gt: z.number().optional(),
      amount_gte: z.number().optional(),
      // a customer setting (core.tenant.settings) that turns the step on; unset means on
      setting: z
        .string()
        .regex(/^[a-z][a-z0-9_]*$/)
        .optional(),
    })
    .optional(),
  escalateTo: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .optional(),
  // groups tried after group / escalateTo / group above, nearest holder first; the engine
  // always ends every chain with FINAL_APPROVER (ADR 009)
  fallback: z
    .array(z.string().regex(/^[A-Z][A-Z0-9_]*$/))
    .min(1)
    .optional(),
  // Approve only through the module RPC that performs the step's business action in the
  // same transaction (wf.act checks wf.module_approval). Reject stays generic.
  approveVia: z.literal('module').optional(),
  // Once approved, the request can no longer be rejected or cancelled (IRREVERSIBLE_STEP).
  irreversible: z.literal(true).optional(),
});

export const processDefSchema = z
  .strictObject({
    type: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    subject: z.string().regex(/^[a-z]+\.[a-z_]+$/),
    domain: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    hierarchy: z.enum(['org', 'delivery']),
    steps: z.array(stepSchema).min(1),
    onApproved: z.string().min(1),
    onRejected: z.string().min(1).optional(),
    slaHours: z.number().int().positive(),
  })
  .refine((d) => new Set(d.steps.map((s) => s.step)).size === d.steps.length, {
    message: 'step names must be unique',
  })
  .refine(
    (d) =>
      d.steps.every(
        (s) => (s.scope === 'from_node' || s.scope === 'to_node') === (d.type === 'TRANSFER'),
      ),
    { message: 'from_node/to_node scopes are only for two-sided processes (TRANSFER)' },
  );

export type StepDef = z.infer<typeof stepSchema>;

/** The last approver of every step of every process (ADR 009). */
export const FINAL_APPROVER = 'ACCOUNT_OWNER';

/** A step's approver groups in routing order (matches wf.chain_groups). */
export function chainGroups(step: StepDef): string[] {
  return [
    ...new Set([step.group, step.escalateTo, ...(step.fallback ?? []), FINAL_APPROVER]),
  ].filter((g): g is string => g !== undefined);
}
export type ProcessDef = z.infer<typeof processDefSchema>;

/** A request as handed to an execution handler by the executor. */
export interface ClaimedRequest {
  outboxId: string;
  requestId: string;
  handler: string;
  attempts: number;
  processType: string;
  subjectType: string;
  subjectId: string;
  payload: Record<string, unknown>;
  amount: string | null;
  currency: string | null;
  orgNodeId: string | null;
  deliveryNodeId: string | null;
  initiatorId: string;
  tenantId: string;
}
