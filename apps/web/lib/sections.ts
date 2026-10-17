import { sql, type Tx } from './db';

// Floor sections (ADR 133): a restaurant's or bar's sections, given to its serving staff per
// day as rooms are given to attendants. The database decides who may give them and to whom.

export interface SectionPlace {
  department_id: string;
  name: string;
  outlet_name: string | null;
}

/** The departments whose sections I give out. */
export async function sectionPlaces(tx: Tx): Promise<SectionPlace[]> {
  return (
    await sql<SectionPlace>`
      select department_id::text, name, outlet_name from ops.section_places()`.execute(tx)
  ).rows;
}

export async function sectionPeople(
  tx: Tx,
  department: string,
): Promise<{ user_id: string; name: string; role_name: string }[]> {
  return (
    await sql<{ user_id: string; name: string; role_name: string }>`
      select user_id::text, name, role_name from ops.section_people(${department}::uuid)
       order by name`.execute(tx)
  ).rows;
}

/** A section on a day and everyone who has it: one person or several (ADR 170). */
export interface SectionOn {
  section_id: string;
  name: string;
  user_ids: string[];
  /** "Asha, Ravi", or null when nobody has it */
  user_names: string | null;
}

export async function sectionsOn(tx: Tx, department: string, day: string): Promise<SectionOn[]> {
  return (
    await sql<SectionOn>`
      select section_id::text, name, user_ids::text[], user_names
        from ops.sections(${department}::uuid, ${day}::date)`.execute(tx)
  ).rows;
}

/**
 * Today's sections at each place I give them out, and who has each (ADR 164): what was given
 * shows on Home, not only on the screen that gives it.
 */
export async function sectionsToday(tx: Tx): Promise<(SectionPlace & { sections: SectionOn[] })[]> {
  const out: (SectionPlace & { sections: SectionOn[] })[] = [];
  // one transaction answers one query at a time: one place after another
  for (const p of await sectionPlaces(tx)) {
    const today = (
      await sql<{ d: string }>`select rpt.today(${p.department_id}::uuid)::text as d`.execute(tx)
    ).rows[0]!.d;
    out.push({ ...p, sections: await sectionsOn(tx, p.department_id, today) });
  }
  return out;
}

/** My sections today, one line per department ("Restaurant: Section 2"). */
export async function mySections(tx: Tx): Promise<{ department_name: string; sections: string }[]> {
  return (
    await sql<{ department_name: string; sections: string }>`
      select department_name, sections from ops.my_sections()`.execute(tx)
  ).rows;
}
