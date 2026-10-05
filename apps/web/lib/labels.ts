// Words for codes that reach a screen (UX-11): an access group is "Department head", never
// DEPARTMENT_HEAD. A customer's own group has a name in its definition; where only the
// code is at hand this is the readable form of it.

import { humanizeCode } from './job-roles';

export function groupLabel(code: string | null | undefined): string {
  return code ? humanizeCode(code) : '';
}
