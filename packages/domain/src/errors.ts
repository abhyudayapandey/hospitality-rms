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
  APPROVE_VIA_MODULE: 'Open this request from its own screen to confirm it.',
  IRREVERSIBLE_STEP: 'The goods are already on their way, so this can only be received now.',
  SESSION_EXPIRED: 'Your session has ended. Please sign in again.',
  UNEXPECTED: 'Something went wrong. Please try again.',
} as const;

export type ErrorCode = keyof typeof ERROR_MESSAGES;

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
