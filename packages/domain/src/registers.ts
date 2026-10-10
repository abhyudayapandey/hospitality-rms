// Registers (ADR 090): one engine, a register per kind, the same for every customer. Each
// entry's fields come from its register; the required ones the database checks too
// (ops.register_required, kept equal by a test). A customer switches each register on or off
// and may say which job roles keep it (file 45, core.tenant.settings.registers); by default
// lost and found and incidents are on everywhere, the rest at hotels.

export interface RegisterField {
  key: string;
  label: string;
  required?: true;
  /** a choice from these; otherwise free text */
  options?: readonly string[];
}

export interface RegisterDef {
  code: string;
  name: string;
  what: string;
  fields: readonly RegisterField[];
  /** how an open entry is closed (the button's words and its outcomes); none: closed at once */
  close?: { label: string; outcomes?: readonly string[]; noteLabel?: string };
  /** on by default at every outlet; otherwise only at hotels */
  everywhere?: true;
}

export const REGISTERS = [
  {
    code: 'lost_found',
    name: 'Lost and found',
    what: 'What was found, where and by whom, where it is kept, and how it went back.',
    everywhere: true,
    fields: [
      { key: 'item', label: 'What was found', required: true },
      { key: 'found_where', label: 'Where it was found' },
      { key: 'found_by', label: 'Found by' },
      { key: 'kept_where', label: 'Kept where' },
    ],
    close: {
      label: 'Close it',
      outcomes: ['Returned to the owner', 'Handed to the police', 'Disposed of'],
      noteLabel: 'To whom, and their ID',
    },
  },
  {
    code: 'incidents',
    name: 'Incidents',
    what: 'What happened, where, who was involved, what was done and who saw it.',
    everywhere: true,
    fields: [
      { key: 'what_happened', label: 'What happened', required: true },
      { key: 'where', label: 'Where' },
      { key: 'who', label: 'Who was involved' },
      { key: 'action', label: 'What was done' },
      { key: 'witnesses', label: 'Witnesses' },
    ],
    close: { label: 'Close it', noteLabel: 'How it ended' },
  },
  {
    code: 'visitors',
    name: 'Visitors',
    what: 'Who came in, whom they saw, their ID, and when they left.',
    fields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'company', label: 'Company' },
      { key: 'visiting', label: 'Visiting' },
      { key: 'phone', label: 'Phone' },
      { key: 'id_proof', label: 'ID seen' },
    ],
    close: { label: 'Left' },
  },
  {
    code: 'vehicles',
    name: 'Vehicles',
    what: 'Vehicles in and out: number, driver, why, and when they left.',
    fields: [
      { key: 'number', label: 'Vehicle number', required: true },
      { key: 'driver', label: 'Driver' },
      { key: 'purpose', label: 'Why' },
    ],
    close: { label: 'Left' },
  },
  {
    code: 'staff_movement',
    name: 'Staff in and out',
    what: 'Staff leaving during the shift, with the gate pass, and when they came back.',
    fields: [
      { key: 'person', label: 'Who', required: true },
      { key: 'reason', label: 'Why' },
      { key: 'gate_pass', label: 'Gate pass number' },
    ],
    close: { label: 'Back in' },
  },
  {
    code: 'keys',
    name: 'Keys',
    what: 'Keys given out and to whom, and when they came back.',
    fields: [
      { key: 'key', label: 'Key', required: true },
      { key: 'issued_to', label: 'Given to', required: true },
    ],
    close: { label: 'Returned' },
  },
  {
    code: 'fire_equipment',
    name: 'Fire equipment',
    what: 'Each extinguisher, hose and alarm checked: where, its state, when it is next due.',
    fields: [
      { key: 'equipment', label: 'Equipment', required: true },
      { key: 'location', label: 'Where' },
      {
        key: 'condition',
        label: 'Condition',
        required: true,
        options: ['In order', 'Needs attention'],
      },
      { key: 'next_due', label: 'Next check due' },
    ],
  },
] as const satisfies readonly RegisterDef[];

export type RegisterCode = (typeof REGISTERS)[number]['code'];
export const REGISTER_CODES: readonly RegisterCode[] = REGISTERS.map((r) => r.code);

export function registerDef(code: string): RegisterDef | undefined {
  return (REGISTERS as readonly RegisterDef[]).find((r) => r.code === code);
}
