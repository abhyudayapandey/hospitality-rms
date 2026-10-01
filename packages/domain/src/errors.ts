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
  ADMIN_NOT_DATA: 'Admin access cannot include business data.',
  SELF_GRANT: "You can't change your own access. Ask another administrator.",
  ABOVE_OWN_RANK: "That's beyond your own administration rights.",
  INVALID_JOB_ROLE: "That job role isn't set up for this organisation.",
  USERNAME_TAKEN: 'That username is already in use.',
  EMAIL_TAKEN: 'That email is already used by another login.',
  RATE_LIMITED: 'Too many attempts. Wait a few minutes and try again.',
  CROSS_ORIGIN: 'That request came from another site and was refused.',
  IS_TEST_IMMUTABLE: 'Whether a customer is a test customer is set when it is created.',
  PLATFORM_AUDIT_APPEND_ONLY: 'The platform audit cannot be changed.',
  REASON_REQUIRED: 'Give a reason.',
  INVALID_CUSTOMER_CODE: 'Customer codes are 2 to 40 capital letters, digits or dashes.',
  INVALID_CUSTOMER:
    'Fill in the company name and the owner’s name, and their email (email login) or a valid username (username login, no email).',
  CUSTOMER_CODE_TAKEN: 'That customer code is already in use.',
  CUSTOMER_MISMATCH: 'These files are for a different customer (file 00 names another code).',
  CUSTOMER_SUSPENDED: 'This customer is suspended. Reactivate it first.',
  TEST_RULE_NOT_ALLOWED: 'The Test<Role>!12 password rule is only for test customers.',
  INVALID_UPLOAD: 'That upload is not stored for this customer. Upload the files again.',
  UPLOAD_EMPTY: 'Choose a zip file or the CSV files to upload.',
  UPLOAD_TOO_LARGE: 'That upload is too large (5 MB, 40 files and 25 MB unpacked at most).',
  UPLOAD_TYPE: 'Upload one zip file, or the CSV files themselves.',
  UPLOAD_UNSAFE_PATH: 'The zip has file names that point outside its folder.',
  UPLOAD_FOLDERS: 'Put all the CSV files in one folder of the zip.',
  UPLOAD_DUPLICATE: 'The same file is in the upload twice.',
  UPLOAD_NOT_UTF8: 'Save the CSV files as UTF-8 and upload them again.',
  UPLOAD_NO_CUSTOMER_FILE: 'The upload needs 00_customer.csv.',
  LAST_ACCOUNT_OWNER: 'The organisation must keep at least one active Account Owner.',
  JOB_ROLE_SCOPE: "This job role's default access doesn't fit the person's place.",
  INVALID_RECIPE: 'A recipe or procedure belongs to a prep item or a menu item.',
  INVALID_STORE: 'Pick one of the outlet’s own stores that holds stock.',
  UNIT_MISSING: 'That ingredient has no recipe unit yet. Set its unit conversion first.',
  UNIT_MISMATCH: 'Use the ingredient’s recipe unit (g, ml or each) for that line.',
  RECIPE_CYCLE: 'A prep item cannot be made from itself, even through another prep item.',
  INVALID_BASIS: 'Costs are shown at current or standard cost.',
  INVALID_DATE: 'Changes take effect today or later, and after any change already planned.',
  INVALID_PRICE: 'Enter a price of zero or more.',
  NOT_MADE_HERE: 'That prep item is not made at this store; it arrives by transfer.',
  INVALID_SOURCE: 'Sales come from daily entry or the POS import.',
  OUTLET_REQUIRED: 'Events are planned for a whole outlet. Pick the outlet.',
  INVALID_SCREEN: "That screen doesn't show places.",
  TEST_CUSTOMER_ONLY: 'This is for test customers only.',
  NOT_A_STOCK_LOCATION: "Stock isn't kept at that location. Pick one of its stores.",
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

export function isErrorCode(value: string): value is ErrorCode {
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
