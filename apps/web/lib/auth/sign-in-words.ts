// The sign-in screen's states and words (ADR 161), shared by the screen and its action.

export type SignInState =
  | { step: 'password'; login?: string; error?: string; notice?: string }
  | { step: 'code'; login: string; session: string; to: string | null; error?: string }
  | { step: 'new_password'; login: string; session: string; error?: string }
  | { step: 'forgot'; login?: string; error?: string }
  | { step: 'reset'; login: string; to: string | null; error?: string };

export const signInWords = {
  notSetUp: 'Sign-in is not set up here yet.',
  needLogin: 'Type your login ID or email.',
  needPassword: 'Type your password.',
  needCode: 'Type the code from the email.',
  notSame: 'The two passwords are not the same.',
  wrongPassword: 'That login or password is wrong. Try again.',
  wrongCode: 'That code is wrong or too old. Ask for a new one.',
  expired: 'That took too long. Please start again.',
  resetRequired: 'Your password must be changed first. We emailed you a code.',
  noEmail: 'This login has no email. Use your password, or ask your manager.',
  weakPassword: 'Use at least 10 characters, with small letters and a number.',
  tooMany: 'Too many tries. Wait a few minutes, then try again.',
  noAnswer: 'We could not reach sign-in. Check your network and try again.',
  failed: 'Sign-in failed. Please try again.',
  unknownUser: "That login isn't set up for Hey Senior yet. Ask your manager.",
  resetDone: 'Your password is changed. Sign in with it now.',
} as const;
