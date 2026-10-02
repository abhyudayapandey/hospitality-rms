// Temporary passwords for username logins (ADR 011). Generated with the crypto RNG, set
// through AdminCreateUser / AdminSetUserPassword, shown to the admin once and never stored
// or logged. They meet the customer pool's policy (at least 10 characters, a digit and a
// lower-case letter) with room to spare; the person changes it at their next sign-in.

const LOWER = 'abcdefghjkmnpqrstuvwxyz'; // no i, l, o: easy to read out
const UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const DIGITS = '23456789'; // no 0, 1
const ALL = LOWER + UPPER + DIGITS;

/** An unbiased random index below n (rejection sampling on a random byte). */
function randomIndex(n: number, rng: (buf: Uint8Array) => Uint8Array): number {
  const limit = 256 - (256 % n);
  for (;;) {
    const [b] = rng(new Uint8Array(1));
    if (b! < limit) return b! % n;
  }
}

const cryptoRng = (buf: Uint8Array) => crypto.getRandomValues(buf);

export function generateTemporaryPassword(
  length = 14,
  rng: (buf: Uint8Array) => Uint8Array = cryptoRng,
): string {
  if (length < 10) throw new Error('temporary passwords are at least 10 characters');
  const pick = (set: string) => set[randomIndex(set.length, rng)]!;
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS)];
  while (chars.length < length) chars.push(pick(ALL));
  // shuffle so the required classes are not always first (Fisher-Yates)
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1, rng);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

/**
 * The Test<Role>!12 rule (docs/onboarding/test-data): "Test", the job title without
 * spaces, "!12" (Bar Manager -> TestBarManager!12). Only for test customers; the database
 * refuses the option for anyone else (ADR 013, PRD ADM-1).
 */
export function testRulePassword(jobTitle: string): string {
  return `Test${jobTitle.replace(/\s+/g, '')}!12`;
}

/**
 * What a new password lacks under the customer pool's policy (infra: at least 10
 * characters, a digit and a lower-case letter), for the form's early feedback. Cognito
 * applies the same policy when the password is changed.
 */
export function passwordProblems(password: string): string[] {
  return [
    ...(password.length < 10 ? ['at least 10 characters'] : []),
    ...(/[0-9]/.test(password) ? [] : ['a digit']),
    ...(/[a-z]/.test(password) ? [] : ['a lower-case letter']),
  ];
}
