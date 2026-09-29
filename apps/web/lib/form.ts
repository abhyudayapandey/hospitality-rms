/** A text field from FormData ('' when missing or a file). */
export function field(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}
