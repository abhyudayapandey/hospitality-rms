// Stable error codes raised by the database (CLAUDE.md conventions) and the messages
// the UI shows for them. Raw SQL errors are never shown to users.

export const ERROR_MESSAGES = {
  NOT_AUTHORISED: "You don't have access to do that.",
  SEGREGATION_OF_DUTIES: "You can't approve a request you raised yourself.",
  NO_APPROVER: 'Nobody is set up to approve this yet. Ask your manager or admin.',
  INVALID_STATE: 'This request has already been actioned. Refresh to see the latest.',
  INVALID_ACTION: "That action isn't available.",
  REQUEST_NOT_FOUND: "We couldn't find that request.",
  UNKNOWN_PROCESS: "That request type isn't available.",
  INVALID_SUBJECT: 'Some details are missing or invalid. Check the form and try again.',
  INVALID_PROCESS_DEF: 'This request type is misconfigured. Tell your admin.',
  TENANT_MISMATCH: 'That item belongs to a different organisation.',
  INSUFFICIENT_STOCK:
    'There is not enough stock on record for that. If the goods are here, record the receipt or do a stock count first.',
  INVALID_LINES: 'Check the items: each needs a quantity, and an item can only appear once.',
  INVALID_ITEM: "That item isn't set up for this location.",
  INVALID_QUANTITY: 'Check the quantities and try again.',
  INVALID_SUPPLIER: "That supplier isn't available.",
  PHOTO_REQUIRED: 'This wastage is worth enough to need a photo. Add one and submit again.',
  INVALID_PHOTO: "The photo didn't upload for this location. Take it again.",
  LEDGER_APPEND_ONLY: 'Stock history cannot be changed. Record a correcting movement instead.',
  APPROVE_VIA_MODULE: 'Open this request from its own screen to confirm it.',
  IRREVERSIBLE_STEP: 'The goods are already on their way, so this can only be received now.',
  NOT_FOUND: "We couldn't find that. Refresh to see the latest.",
  INVALID_WORKER: "That person isn't an active worker here.",
  INVALID_WEEK: 'Pick a week starting on a Monday.',
  SHIFT_STARTED: 'That shift has already started, so it can no longer be changed.',
  SHIFT_OVERLAP: 'They are already on a shift at that time.',
  REST_RULE: 'That leaves too little rest between their shifts.',
  WEEKLY_HOURS_CAP: 'That would take them over the weekly hours limit.',
  LEAVE_CONFLICT: 'They are on approved leave that day.',
  ROLE_MISMATCH: "Their role doesn't match this shift.",
  SHIFT_FULL: 'This shift already has everyone it needs.',
  WORKER_NOT_AT_NODE: 'They work at another location.',
  INVALID_LEAVE_TYPE: "That leave type isn't available.",
  INVALID_DATES: 'Check the dates and try again.',
  LEAVE_SPANS_YEAR: 'Leave cannot cross the year end. Make two requests instead.',
  LEAVE_OVERLAP: 'You already have leave on some of those days.',
  INSUFFICIENT_LEAVE_BALANCE: "You don't have enough leave left for that.",
  INVALID_GROUP: "That role isn't available.",
  ALREADY_CLOCKED_IN: "You're already clocked in. Clock out first.",
  NOT_CLOCKED_IN: "You're not clocked in.",
  INVALID_TIMESTAMP:
    "That punch time isn't valid. Punches older than a day can't be synced; tell your manager.",
  INVALID_LOCATION: "Your location couldn't be read. Try again.",
  SESSION_EXPIRED: 'Your session has ended. Please sign in again.',
  UNEXPECTED: 'Something went wrong. Please try again.',
} as const;

export type ErrorCode = keyof typeof ERROR_MESSAGES;

/** Rostering rules (hr.assignment_violation and hr.assign). */
export const ROSTER_RULE_CODES = [
  'SHIFT_OVERLAP',
  'REST_RULE',
  'WEEKLY_HOURS_CAP',
  'LEAVE_CONFLICT',
  'ROLE_MISMATCH',
  'SHIFT_FULL',
  'WORKER_NOT_AT_NODE',
  'SHIFT_STARTED',
  'INVALID_WORKER',
] as const satisfies readonly ErrorCode[];

/**
 * Codes an execution handler raises when a business rule fails. Retrying cannot help, so
 * the executor fails the request at once and records the code (ADR 008). Anything else
 * (connection loss, deadlock, a bug) is retried up to 3 attempts.
 */
export const BUSINESS_RULE_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  ...ROSTER_RULE_CODES,
  'INSUFFICIENT_STOCK',
  'INSUFFICIENT_LEAVE_BALANCE',
  'TENANT_MISMATCH',
  'INVALID_STATE',
]);

const INSUFFICIENT_PRIVILEGE = '42501'; // Postgres: RLS or grant refused

function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(ERROR_MESSAGES, value);
}

/** Extracts our stable code from a thrown DB error; anything else is UNEXPECTED. */
export function errorCodeOf(err: unknown): ErrorCode {
  if (typeof err === 'object' && err !== null) {
    const { message, code } = err as { message?: unknown; code?: unknown };
    if (typeof message === 'string' && isErrorCode(message)) return message;
    if (code === INSUFFICIENT_PRIVILEGE) return 'NOT_AUTHORISED';
  }
  return 'UNEXPECTED';
}

export function messageFor(code: ErrorCode): string {
  return ERROR_MESSAGES[code];
}

/** The result shape server actions return to the UI. */
export type ActionResult<T = void> =
  { ok: true; data: T } | { ok: false; code: ErrorCode; message: string };

export function failure(err: unknown): { ok: false; code: ErrorCode; message: string } {
  const code = errorCodeOf(err);
  return { ok: false, code, message: messageFor(code) };
}
