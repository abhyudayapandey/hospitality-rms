// Job roles are shown by their title ("Chef de Partie"), never their code (UX review U-3).
// Everyone signed in reads their own customer's job roles (RLS on hr.job_role).

/** Names a job role code; null when there is none. */
export type TitleOf = (code: string | null | undefined) => string;

/** "CHEF_DE_PARTIE" → "Chef de partie", for a code the customer has no title for. */
export function humanizeCode(code: string): string {
  const words = code.toLowerCase().split('_').filter(Boolean).join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function titleOf(titles: ReadonlyMap<string, string>): TitleOf {
  return (code) => (code ? (titles.get(code.toUpperCase()) ?? humanizeCode(code)) : '');
}
