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

export async function sectionsOn(
  tx: Tx,
  department: string,
  day: string,
): Promise<{ section_id: string; name: string; user_id: string | null }[]> {
  return (
    await sql<{ section_id: string; name: string; user_id: string | null }>`
      select section_id::text, name, user_id::text
        from ops.sections(${department}::uuid, ${day}::date)`.execute(tx)
  ).rows;
}

/** My sections today, one line per department ("Restaurant: Section 2"). */
export async function mySections(tx: Tx): Promise<{ department_name: string; sections: string }[]> {
  return (
    await sql<{ department_name: string; sections: string }>`
      select department_name, sections from ops.my_sections()`.execute(tx)
  ).rows;
}
