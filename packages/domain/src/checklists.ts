// The starter checklist library (ADR 062), taken from the SOP manuals in docs/sop/. An outlet
// made from a template gets its own copy of each checklist its departments use, recording
// which library checklist and version it came from; the outlet owns its copy, and a later
// library version reaches new outlets only. Each names the job roles that do it in the SOP
// (ADR 075): a copy goes to the first of them that works in its department at that outlet,
// so it is on their To do list every day without a roster, else to whoever is on shift
// there. The outlet's manager can change that.

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
  /**
   * The job roles that do it in the SOP, first choice first (ADR 075): an outlet's copy goes to
   * the first of them that works in its department there, else to whoever is on shift.
   */
  roles: readonly string[];
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
    roles: ['COMMIS', 'COOK', 'CHEF_DE_PARTIE', 'FOOD_SAFETY_SUPERVISOR'],
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
    roles: ['KITCHEN_STEWARD', 'COMMIS', 'COOK', 'CHEF_DE_PARTIE'],
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
    roles: ['CHEF_DE_PARTIE', 'COOK', 'FOOD_SAFETY_SUPERVISOR', 'COMMIS'],
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
    roles: ['COOK', 'CHEF_DE_PARTIE', 'FOOD_SAFETY_SUPERVISOR'],
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
    roles: ['COOK', 'CHEF_DE_PARTIE', 'COMMIS', 'FOOD_SAFETY_SUPERVISOR'],
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
    roles: ['KITCHEN_STEWARD', 'SOUS_CHEF'],
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
    roles: ['STEWARD', 'SERVER', 'CAPTAIN'],
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
    roles: ['CAPTAIN', 'STEWARD', 'SERVER'],
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
    roles: ['CAPTAIN', 'HOST'],
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
    roles: ['BARISTA', 'CREW_MEMBER'],
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
    roles: ['SHIFT_MANAGER', 'BARISTA', 'CREW_MEMBER'],
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
    roles: ['HOST', 'STEWARD', 'SERVER', 'BAR_BACK', 'CREW_MEMBER', 'BARISTA'],
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
    roles: ['BARTENDER', 'HEAD_BARTENDER', 'BAR_BACK'],
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
    roles: ['HEAD_BARTENDER', 'BARTENDER'],
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
    roles: ['BAR_BACK', 'BARTENDER'],
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
    roles: ['BREWER', 'HEAD_BREWER'],
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
    roles: ['HOUSEKEEPING_SUPERVISOR'],
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
    roles: ['PUBLIC_AREA_ATTENDANT', 'ROOM_ATTENDANT'],
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
    roles: ['FRONT_DESK_EXECUTIVE', 'FRONT_OFFICE_MANAGER'],
    schedule: 'daily 07:00 15:00 23:00',
    steps: [
      tick('Arrivals and departures read'),
      { label: 'Open guest issues', kind: 'text' },
      tick('Float counted'),
    ],
    from: 'Hotel SOP front office',
  },
  // hotel amenities (the pool, spa and gym extras)
  {
    code: 'POOL-WATER-TEST',
    version: 1,
    name: 'Pool water test',
    does: 'pH and free chlorine every 2 hours while the pool is open; close it on a failed reading.',
    department: 'ENGINEERING',
    roles: ['TECHNICIAN', 'LIFEGUARD'],
    schedule: 'every 2h 08:00-20:00',
    steps: [
      { label: 'pH', kind: 'number', min: 7.2, max: 7.8, unit: 'pH' },
      { label: 'Free chlorine', kind: 'number', min: 1, max: 3, unit: 'ppm' },
      tick('Water clear, no incident (otherwise close the pool and tell the Recreation Manager)'),
    ],
    from: 'Hotel SOP EN-08 Swimming pool plant',
  },
  {
    code: 'POOL-SAFETY',
    version: 1,
    name: 'Pool safety check',
    does: 'Before the pool opens: a certified lifeguard on duty, signs up, no glass on the deck.',
    department: 'SPA-RECREATION',
    roles: ['LIFEGUARD', 'RECREATION_MANAGER'],
    schedule: 'daily 07:00',
    steps: [
      tick('Lifeguard with a valid certification on duty'),
      tick('Depth markings and no-diving signs in place'),
      tick('No glassware on the pool deck'),
      tick("Today's first water test passed"),
    ],
    from: 'Hotel SOP SP-06 Pool and beach safety',
  },
  {
    code: 'SPA-OPENING',
    version: 1,
    name: 'Spa opening and hygiene',
    does: 'Fresh linen, sterilised tools, products in date and heat rooms at temperature.',
    department: 'SPA-RECREATION',
    roles: ['THERAPIST', 'SPA_RECEPTIONIST'],
    schedule: 'daily 09:00',
    steps: [
      tick('Fresh linen for every booking'),
      tick('Tools sterilised (autoclave or approved disinfectant)'),
      tick('Products within expiry; single-use items stocked'),
      // the SOP logs these temperatures but sets no limits; the spa adds its own
      { label: 'Steam room', kind: 'number', unit: '°C' },
      { label: 'Sauna', kind: 'number', unit: '°C' },
      { label: 'Jacuzzi', kind: 'number', unit: '°C' },
    ],
    from: 'Hotel SOP SP-02 Treatment hygiene',
  },
  {
    code: 'GYM-CHECK',
    version: 1,
    name: 'Gym check',
    does: 'Equipment checked and disinfected, the emergency number posted, the AED nearby.',
    department: 'SPA-RECREATION',
    roles: ['RECREATION_MANAGER'],
    schedule: 'daily 06:00',
    steps: [
      tick('Equipment checked; anything faulty taped off and reported in Maintenance'),
      tick('Equipment disinfected'),
      tick('Emergency number posted; AED nearby'),
    ],
    from: 'Hotel SOP SP-05 Gym',
  },
  // stores and delivery
  {
    code: 'RECEIVING-CHECK',
    version: 1,
    name: 'Receiving check',
    does: 'What every delivery is checked for before it is accepted.',
    department: 'STORES-TEAM',
    roles: ['RECEIVING_CLERK', 'STORE_KEEPER'],
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
    roles: ['PACKER', 'COMMIS', 'COOK'],
    schedule: 'every 2h 11:00-23:00',
    steps: [
      tick('Seals and tamper tape used'),
      tick('Cutlery and sauces in'),
      tick('Bag labelled'),
    ],
    from: 'Cloud kitchen SOP dispatch',
  },
  // every role's daily work (ADR 075): one checklist at least for each role that works shifts
  {
    code: 'SECTION-SETUP',
    version: 1,
    name: 'Section set-up and side work',
    does: "A server's section ready before service: tables, cutlery, condiments, side station.",
    department: 'RESTAURANT',
    roles: ['SERVER', 'STEWARD'],
    schedule: 'daily 11:00 18:00',
    steps: [
      tick('Tables wiped, level and set'),
      tick('Cutlery and glasses polished'),
      tick('Condiments filled and in date'),
      tick('Menus clean and current'),
      tick('Side station stocked (napkins, water, cutlery, bill folders)'),
    ],
    from: 'Hotel SOP FB-01 Outlet opening; Restaurant SOP front of house',
  },
  {
    code: 'CASHIER-CLOSE',
    version: 1,
    name: 'Cash and card close',
    does: 'The day closed: Z-report, cash counted, cards settled, float handed over.',
    department: 'RESTAURANT',
    roles: ['CASHIER'],
    schedule: 'daily 23:00',
    steps: [
      tick('All bills closed; Z-report run'),
      tick('Cash counted against the report'),
      tick('Card and UPI terminals settled'),
      { label: 'Difference (₹, 0 if none)', kind: 'number', unit: '₹' },
      tick('Float counted and handed over'),
    ],
    from: 'Hotel SOP FB-11 Outlet closing; QSR SOP IC-04 Cash handling',
  },
  {
    code: 'CREW-STATIONS',
    version: 1,
    name: 'Crew on their stations',
    does: 'Everyone on a station they are certified for, ready and clean, before the rush.',
    department: 'COUNTER',
    roles: ['CREW_TRAINER', 'SHIFT_MANAGER'],
    schedule: 'daily 11:30 18:30',
    steps: [
      tick('Each crew member on a station they are certified for'),
      tick('New crew paired with a trainer'),
      tick('Hands washed, caps and gloves on'),
      tick('Holding cabinets stocked to the peak chart'),
    ],
    from: 'QSR SOP CT Crew training; ST-03 Peak readiness',
  },
  {
    code: 'PLATFORMS-ONLINE',
    version: 1,
    name: 'Delivery apps open',
    does: 'Every brand online on every app, menus right and items out of stock switched off.',
    department: 'DISPATCH',
    roles: ['ONLINE_PLATFORM_MANAGER'],
    schedule: 'daily 10:30',
    steps: [
      tick('Every brand online on each app'),
      tick('Prices and menus match the POS'),
      tick('Items out of stock switched off'),
      tick("Yesterday's ratings and complaints read"),
    ],
    from: 'Cloud kitchen SOP online platforms (OL)',
  },
  {
    code: 'BELL-DESK',
    version: 1,
    name: 'Bell desk and luggage room',
    does: 'Luggage locked and logged, trolleys ready, the directory current.',
    department: 'FRONT-OFFICE',
    roles: ['BELLBOY', 'BELL_CAPTAIN'],
    schedule: 'daily 08:00 20:00',
    steps: [
      tick('Luggage room locked'),
      tick('Every stored bag tagged and in the log'),
      tick('Trolleys clean and ready'),
      tick("Today's arrivals and departures read"),
    ],
    from: 'Hotel SOP FO-09 Concierge and bell desk',
  },
  {
    code: 'ROOM-CLEANING',
    version: 1,
    name: 'Rooms cleaned',
    does: "A room attendant's rooms: departures cleaned, stayovers serviced, status updated.",
    department: 'HOUSEKEEPING',
    roles: ['ROOM_ATTENDANT'],
    schedule: 'daily 09:00',
    steps: [
      tick('Trolley stocked; master key signed out'),
      { label: 'Departures cleaned', kind: 'number', min: 0, unit: 'rooms' },
      { label: 'Stayovers serviced', kind: 'number', min: 0, unit: 'rooms' },
      tick('Each cleaned room set to "clean, awaiting inspection"'),
      tick('Lost property handed in; defects reported in Maintenance'),
    ],
    from: 'Hotel SOP HK-01 to HK-03',
  },
  {
    code: 'TURNDOWN',
    version: 1,
    name: 'Turndown service',
    does: 'Evening turndown in occupied rooms.',
    department: 'HOUSEKEEPING',
    roles: ['ROOM_ATTENDANT'],
    schedule: 'daily 18:30',
    steps: [
      tick('Curtains closed, bed turned down'),
      tick('Bedside mat and slippers placed'),
      tick('Water and towels replenished'),
      tick('Night light set'),
    ],
    from: 'Hotel SOP HK-05 Turndown service',
  },
  {
    code: 'LAUNDRY-ROUND',
    version: 1,
    name: 'Laundry round',
    does: 'Soiled linen counted, washed to the chart; guest laundry back on time.',
    department: 'HOUSEKEEPING',
    roles: ['LAUNDRY_ATTENDANT'],
    schedule: 'daily 09:00',
    steps: [
      { label: 'Soiled linen from the floors', kind: 'number', min: 0, unit: 'pieces' },
      tick('Count matches the floors (or the difference reported)'),
      tick('Sorted; stains pre-treated'),
      tick('Wash temperatures to the chemical chart'),
      tick('Guest laundry returned within 8 hours'),
    ],
    from: 'Hotel SOP HK-08 Linen control; HK-09 Laundry',
  },
  {
    code: 'IRD-TRAYS',
    version: 1,
    name: 'Tray collection',
    does: 'Corridors cleared of trays every 2 hours.',
    department: 'IN-ROOM-DINING',
    roles: ['IRD_ORDER_TAKER'],
    schedule: 'every 2h 10:00-22:00',
    steps: [
      tick('Guest floors walked'),
      tick('Trays and trolleys collected'),
      tick('Corridors clear'),
    ],
    from: 'Hotel SOP FB-07 In-room dining',
  },
  {
    code: 'PLANT-ROUND',
    version: 1,
    name: 'Daily plant round',
    does: 'Meter readings, water, hot water and the fire panel, every morning.',
    department: 'ENGINEERING',
    roles: ['TECHNICIAN'],
    schedule: 'daily 08:00',
    steps: [
      { label: 'Electricity meter', kind: 'number', min: 0, unit: 'kWh' },
      tick('Water treatment and RO output normal'),
      { label: 'Hot water at a guest outlet', kind: 'number', min: 50, max: 70, unit: '°C' },
      tick('Diesel within the licensed stock'),
      tick('Fire alarm panel normal'),
    ],
    from: 'Hotel SOP EN-04, EN-06, EN-07',
  },
  {
    code: 'SECURITY-PATROL',
    version: 1,
    name: 'Night patrol',
    does: 'Floors and back of house walked through the night.',
    department: 'SECURITY',
    roles: ['SECURITY_GUARD', 'SECURITY_SUPERVISOR'],
    schedule: 'daily 23:00 02:00 05:00',
    steps: [
      tick('Guest floors and back of house walked'),
      tick('Fire exits clear; back doors locked'),
      tick('Nothing left unattended; no smell of smoke'),
      { label: 'Anything to report', kind: 'text' },
    ],
    from: 'Hotel SOP SE-05 Patrols; Bar SOP security',
  },
  {
    code: 'BAR-RESTOCK',
    version: 1,
    name: 'Bar back restock',
    does: 'Ice, glasses, fridges and empties before and during service.',
    department: 'BAR',
    roles: ['BAR_BACK', 'BARTENDER'],
    schedule: 'daily 16:00 21:00',
    steps: [
      tick('Ice wells filled (scoop, never a glass)'),
      tick('Glasses washed and racked'),
      tick('Fridges restocked, oldest at the front'),
      tick('Empties cleared and counted'),
    ],
    from: 'Bar SOP bar operations',
  },
  {
    code: 'BANQUET-SETUP',
    version: 1,
    name: 'Banquet mise en place',
    does: "Equipment ready for the day's functions: linen, crockery, buffet and sample containers.",
    department: 'BANQUETS',
    roles: ['BANQUET_SERVER', 'BANQUET_CAPTAIN'],
    schedule: 'daily 15:00',
    steps: [
      tick('Crockery, cutlery and glasses polished and counted'),
      tick('Linen ready'),
      tick('Chafing dishes and fuel ready'),
      tick('Sample containers labelled (150 g of each dish, 72 hours)'),
    ],
    from: 'Hotel SOP BQ-05 Set-up; KT-08 Food sample retention',
  },
  {
    code: 'SPA-DESK',
    version: 1,
    name: 'Spa desk opening',
    does: "Today's bookings confirmed, health forms ready, lockers and keys checked.",
    department: 'SPA-RECREATION',
    roles: ['SPA_RECEPTIONIST'],
    schedule: 'daily 09:00',
    steps: [
      tick("Today's bookings confirmed with the therapists"),
      tick('Health and consent forms ready'),
      tick('Lockers and keys checked'),
    ],
    from: 'Hotel SOP SP-01 Spa booking and consultation',
  },
];

export const CHECKLIST_BY_CODE: ReadonlyMap<string, LibraryChecklist> = new Map(
  CHECKLISTS.map((c) => [c.code, c]),
);

/**
 * The library checklist a copy may move to (ADR 068): its library's current version, when that
 * is newer than the copy's; otherwise null (no library, an unknown code, or up to date).
 */
export function newerLibraryVersion(
  code: string | null | undefined,
  version: number | null | undefined,
  library: ReadonlyMap<string, LibraryChecklist> = CHECKLIST_BY_CODE,
): LibraryChecklist | null {
  if (!code || !version) return null;
  const lib = library.get(code);
  return lib && lib.version > version ? lib : null;
}

/** A library checklist's steps as a checklist stores them (file 29's columns, in JSON). */
export function libraryStepsJson(lib: LibraryChecklist) {
  return lib.steps.map((s) => ({
    label: s.label,
    kind: s.kind,
    ...(s.min !== undefined && { min: s.min }),
    ...(s.max !== undefined && { max: s.max }),
    ...(s.unit !== undefined && { unit: s.unit }),
    ...(s.photo && { photo_required: true }),
  }));
}
