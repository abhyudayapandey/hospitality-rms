// The starter checklist library (ADR 062), taken from the SOP manuals in docs/sop/. An outlet
// made from a template gets its own copy of each checklist its departments use, recording
// which library checklist and version it came from; the outlet owns its copy, and a later
// library version reaches new outlets only. Starter checklists go to whoever is on shift
// there, so they work before anyone is set up; the outlet's manager can change that.

export interface LibraryStep {
  label: string;
  kind: 'tick' | 'number' | 'text' | 'photo';
  min?: number;
  max?: number;
  unit?: string;
  photo?: boolean;
}

export interface LibraryChecklist {
  /** Stable code; with the version, recorded on every copy. */
  code: string;
  version: number;
  name: string;
  /** One line, in plain words, for the console. */
  does: string;
  /** The catalogue department it belongs to: an outlet gets it with that department. */
  department: string;
  /** As in file 29: `daily 07:00`, `weekly Mon 15:00`, `every 2h 10:00-22:00`. */
  schedule: string;
  steps: readonly LibraryStep[];
  /** SOP sections it comes from. */
  from: string;
}

const tick = (label: string): LibraryStep => ({ label, kind: 'tick' });
const temp = (label: string, min: number, max: number): LibraryStep => ({
  label,
  kind: 'number',
  min,
  max,
  unit: '°C',
});

export const CHECKLISTS: readonly LibraryChecklist[] = [
  // kitchen
  {
    code: 'KITCHEN-OPENING',
    version: 1,
    name: 'Kitchen opening',
    does: 'Fridges cold, hand-wash stocked, surfaces clean before prep starts.',
    department: 'KITCHEN',
    schedule: 'daily 07:00',
    steps: [
      temp('Walk-in chiller', 0, 5),
      temp('Freezer', -25, -18),
      tick('Hand-wash station stocked (soap, towels)'),
      tick('Work surfaces sanitised'),
      tick('Gas and exhaust checked'),
    ],
    from: 'Restaurant SOP kitchen opening; Hotel SOP F&B production',
  },
  {
    code: 'KITCHEN-CLOSING',
    version: 1,
    name: 'Kitchen closing',
    does: 'Food covered and labelled, gas off, floor and drains clean.',
    department: 'KITCHEN',
    schedule: 'daily 23:00',
    steps: [
      tick('Food covered, labelled and dated'),
      tick('Gas valves off'),
      tick('Floor and drains cleaned'),
      tick('Waste out'),
      temp('Walk-in chiller at close', 0, 5),
    ],
    from: 'Restaurant SOP kitchen closing',
  },
  {
    code: 'CHILLER-LOG',
    version: 1,
    name: 'Chiller and freezer log',
    does: 'Temperatures twice a day, for food safety records.',
    department: 'KITCHEN',
    schedule: 'daily 10:00 16:00',
    steps: [temp('Chiller', 0, 5), temp('Freezer', -25, -18)],
    from: 'All SOPs: food safety, temperature control',
  },
  {
    code: 'HOT-HOLDING',
    version: 1,
    name: 'Hot holding',
    does: 'Food kept hot stays at 63 °C or above during service.',
    department: 'KITCHEN',
    schedule: 'every 2h 12:00-22:00',
    steps: [temp('Hot-held food', 63, 100)],
    from: 'Restaurant and QSR SOPs: food safety',
  },
  {
    code: 'FRYER-OIL',
    version: 1,
    name: 'Fryer oil',
    does: 'Oil quality checked; changed when it fails.',
    department: 'KITCHEN',
    schedule: 'daily 11:00',
    steps: [
      tick('Oil colour and smell OK'),
      tick('Changed if not OK'),
      { label: 'Photo of the oil', kind: 'photo' },
    ],
    from: 'QSR SOP kitchen; Restaurant SOP kitchen',
  },
  {
    code: 'CLEANING-SCHEDULE',
    version: 1,
    name: 'Weekly deep clean',
    does: 'The weekly clean: hoods, fridges inside, behind equipment.',
    department: 'KITCHEN',
    schedule: 'weekly Mon 15:00',
    steps: [
      tick('Exhaust hood and filters'),
      tick('Inside fridges and freezers'),
      tick('Behind and under equipment'),
      tick('Dry store shelves'),
    ],
    from: 'All SOPs: cleaning schedule',
  },
  // dining room and counter
  {
    code: 'RESTAURANT-OPENING',
    version: 1,
    name: 'Restaurant opening',
    does: 'Tables set, menus clean, the dining room ready for guests.',
    department: 'RESTAURANT',
    schedule: 'daily 11:30',
    steps: [
      tick('Tables set and clean'),
      tick('Menus clean, specials updated'),
      tick('Lights, music and air-con on'),
      tick('Entrance and washroom checked'),
    ],
    from: 'Restaurant SOP day plan 11:30',
  },
  {
    code: 'RESTAURANT-CLOSING',
    version: 1,
    name: 'Restaurant closing',
    does: 'Dining room cleared and clean, cash and doors done.',
    department: 'RESTAURANT',
    schedule: 'daily 23:30',
    steps: [
      tick('Tables cleared and wiped'),
      tick('Side stations restocked'),
      tick('Cash counted and handed over'),
      tick('Doors and windows locked'),
    ],
    from: 'Restaurant SOP closing',
  },
  {
    code: 'PRE-SHIFT-BRIEFING',
    version: 1,
    name: 'Pre-shift briefing',
    does: 'Specials, dishes out of stock, VIPs and allergies told to the team.',
    department: 'RESTAURANT',
    schedule: 'daily 11:45 18:30',
    steps: [
      tick('Specials and dishes out of stock told'),
      tick('Bookings, VIPs and allergies told'),
      tick('Grooming checked'),
    ],
    from: 'Restaurant SOP day plan 11:30 and 18:30; Hotel SOP F&B',
  },
  {
    code: 'COUNTER-OPENING',
    version: 1,
    name: 'Counter opening',
    does: 'Coffee machine on, display filled, the counter ready.',
    department: 'COUNTER',
    schedule: 'daily 07:30',
    steps: [
      tick('Coffee machine on and flushed'),
      temp('Milk fridge', 0, 5),
      tick('Display filled and labelled'),
      tick('Card machine and float ready'),
    ],
    from: 'Restaurant SOP (café service); QSR SOP store opening',
  },
  {
    code: 'COUNTER-CLOSING',
    version: 1,
    name: 'Counter closing',
    does: 'Coffee machine cleaned, display emptied, cash done.',
    department: 'COUNTER',
    schedule: 'daily 21:30',
    steps: [
      tick('Coffee machine back-flushed and cleaned'),
      tick('Display emptied; leftovers logged'),
      tick('Cash counted and handed over'),
    ],
    from: 'Restaurant SOP (café service); QSR SOP store closing',
  },
  {
    code: 'WASHROOM-ROUND',
    version: 1,
    name: 'Washroom round',
    does: 'Guest washrooms checked every two hours while open.',
    department: 'RESTAURANT',
    schedule: 'every 2h 12:00-22:00',
    steps: [tick('Clean and dry'), tick('Soap, paper and towels stocked'), tick('Bin emptied')],
    from: 'Restaurant and QSR SOPs: hygiene rounds',
  },
  // bar
  {
    code: 'BAR-SETUP',
    version: 1,
    name: 'Bar setup',
    does: 'Ice, garnish, glasses and the speed rail ready for service.',
    department: 'BAR',
    schedule: 'daily 17:00',
    steps: [
      tick('Ice bins filled'),
      tick('Garnish cut and covered'),
      tick('Glasses polished'),
      temp('Beer and wine fridge', 1, 6),
    ],
    from: 'Bar SOP opening',
  },
  {
    code: 'BAR-CLOSING',
    version: 1,
    name: 'Bar closing',
    does: 'Bottles capped, bar clean, cash and pours checked.',
    department: 'BAR',
    schedule: 'daily 01:00',
    steps: [
      tick('Bottles capped and wiped'),
      tick('Bar top, sinks and mats cleaned'),
      tick('Cash counted and handed over'),
      { label: 'Anything poured but not billed?', kind: 'text' },
    ],
    from: 'Bar SOP closing; cash and pour control',
  },
  {
    code: 'BEER-LINE-CLEAN',
    version: 1,
    name: 'Beer line clean',
    does: 'Draught lines cleaned every week.',
    department: 'BAR',
    schedule: 'weekly Tue 14:00',
    steps: [
      tick('Lines flushed with cleaner'),
      tick('Rinsed until clear'),
      tick('Taps and nozzles soaked'),
    ],
    from: 'Bar and Microbrewery SOP: draught quality',
  },
  {
    code: 'BREW-DAY',
    version: 1,
    name: 'Brewhouse check',
    does: 'Fermenter temperatures and cleaning, every day.',
    department: 'BREWHOUSE',
    schedule: 'daily 09:00',
    steps: [temp('Fermenter', 0, 24), tick('Cleaning (CIP) done'), tick('Brew log updated')],
    from: 'Microbrewery SOP brewhouse',
  },
  // hotel
  {
    code: 'ROOM-CHECK',
    version: 1,
    name: 'Room check',
    does: 'A supervisor checks rooms cleaned today before they are sold.',
    department: 'HOUSEKEEPING',
    schedule: 'daily 14:00',
    steps: [
      tick('Bed made, linen clean'),
      tick('Bathroom clean, amenities placed'),
      tick('Minibar checked'),
      tick('Nothing left behind by the last guest'),
    ],
    from: 'Hotel SOP housekeeping',
  },
  {
    code: 'LOBBY-WASHROOM',
    version: 1,
    name: 'Lobby washroom',
    does: 'Public washrooms checked every two hours.',
    department: 'HOUSEKEEPING',
    schedule: 'every 2h 08:00-22:00',
    steps: [tick('Clean and dry'), tick('Soap, paper and towels stocked')],
    from: 'Hotel SOP public areas',
  },
  {
    code: 'FRONT-OFFICE-HANDOVER',
    version: 1,
    name: 'Front office handover',
    does: 'What the next shift must know: arrivals, issues, cash.',
    department: 'FRONT-OFFICE',
    schedule: 'daily 07:00 15:00 23:00',
    steps: [
      tick('Arrivals and departures read'),
      { label: 'Open guest issues', kind: 'text' },
      tick('Float counted'),
    ],
    from: 'Hotel SOP front office',
  },
  // stores and delivery
  {
    code: 'RECEIVING-CHECK',
    version: 1,
    name: 'Receiving check',
    does: 'What every delivery is checked for before it is accepted.',
    department: 'STORES-TEAM',
    schedule: 'daily 09:00',
    steps: [
      temp('Chilled goods on arrival', 0, 5),
      tick('Use-by dates checked'),
      tick('Packaging intact'),
    ],
    from: 'All SOPs: receiving',
  },
  {
    code: 'DELIVERY-PACKING',
    version: 1,
    name: 'Delivery packing',
    does: 'Orders packed sealed, labelled and complete.',
    department: 'DISPATCH',
    schedule: 'every 2h 11:00-23:00',
    steps: [
      tick('Seals and tamper tape used'),
      tick('Cutlery and sauces in'),
      tick('Bag labelled'),
    ],
    from: 'Cloud kitchen SOP dispatch',
  },
];

export const CHECKLIST_BY_CODE: ReadonlyMap<string, LibraryChecklist> = new Map(
  CHECKLISTS.map((c) => [c.code, c]),
);
