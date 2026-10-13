// The starter SOP library (ADR 140): short, plain-words SOPs taken from the SOP manuals in
// docs/sop/ (and the Passport Hotel demo's own), product code like the checklist library. An
// outlet made from a template gets a copy of each SOP its departments use, in file 46
// (Training & SOPs, ADR 095); the customer owns the copy and may change or drop it. An SOP is
// for the roles it names that the outlet has, or, naming none of them, everyone at its place.

export interface LibrarySop {
  /** Stable code; an outlet's copy is `<OUTLET>-<code>`. */
  code: string;
  title: string;
  /** The catalogue department it belongs to: an outlet gets it with that department. */
  department: string;
  /** The job roles it is for; none (or none of them at the outlet): everyone at its place. */
  roles: readonly string[];
  /** Asks each person for "I've read this". */
  needsAck: boolean;
  /** What to do, in plain words. */
  body: string;
  /** SOP sections it comes from. */
  from: string;
}

export const SOPS: readonly LibrarySop[] = [
  // kitchen
  {
    code: 'SOP-HANDWASH',
    title: 'Handwashing',
    department: 'KITCHEN',
    roles: [],
    needsAck: true,
    body: 'Wash your hands for 20 seconds with soap and warm water. Do it before you start and after the toilet. Do it after raw meat or fish, your phone, your face and the bins. Dry them on a paper towel.',
    from: 'Restaurant SOP BOH-04; Passport Hotel',
  },
  {
    code: 'SOP-ALLERGY-COOKING',
    title: 'Cooking for a guest with an allergy',
    department: 'KITCHEN',
    roles: [],
    needsAck: true,
    body: 'An ALLERGY ticket is cooked by one cook. Check the dish and its prep items for the allergen. Use a clean board, knife and pan. Plate it apart from the rest. The chef checks it at the pass before it goes.',
    from: 'Restaurant SOP BOH-06; Passport Hotel',
  },
  {
    code: 'SOP-LABEL-STORE',
    title: 'Labelling and storing food',
    department: 'KITCHEN',
    roles: [],
    needsAck: true,
    body: 'Label everything you prep or open: name, date, time, use-by and your initials. Use the oldest first. Keep raw food below cooked food. Keep veg and non-veg apart. Nothing goes on the floor.',
    from: 'Restaurant SOP BOH-03',
  },
  {
    code: 'SOP-RECEIVING',
    title: 'Receiving a delivery',
    department: 'KITCHEN',
    roles: [],
    needsAck: false,
    body: 'Check the van is clean and the packs are not damaged. Check the FSSAI label and the expiry date. Check the cold goods with a probe: chilled at 5 °C or below, frozen at -18 °C or below. Weigh against the order. Send back what is wrong. Put cold goods away within 15 minutes.',
    from: 'Restaurant SOP BOH-02',
  },
  {
    code: 'SOP-FRYER-WASTE',
    title: 'Fryer oil and waste',
    department: 'KITCHEN',
    roles: [],
    needsAck: false,
    body: 'Test the frying oil every day. Change it when the tester says 25% or more. Give used oil only to the registered collector. Keep wet and dry waste in their own bins. Clean the grease trap every week.',
    from: 'Restaurant SOP BOH-10',
  },
  {
    code: 'SOP-FIRE-GAS',
    title: 'Kitchen fire or gas leak',
    department: 'KITCHEN',
    roles: [],
    needsAck: true,
    body: 'Fire: shut the gas at the main valve. Use the hood system or the wet-chemical extinguisher. Never put water on oil. Gas smell: no switches, no flames. Shut the gas, open the doors and get everyone out. Then call the manager.',
    from: 'Restaurant SOP EM-01, EM-02',
  },
  // dining room
  {
    code: 'SOP-TAKING-ORDER',
    title: 'Taking an order',
    department: 'RESTAURANT',
    roles: [],
    needsAck: true,
    body: 'Offer water within 2 minutes. Ask about allergies and food needs (veg, Jain, vegan) before the order. Tell the guest the specials with their price. Punch the order at once. Mark an allergy order "ALLERGY" and tell the pass. Repeat the order back.',
    from: 'Restaurant SOP FOH-04',
  },
  {
    code: 'SOP-BILL',
    title: 'The bill',
    department: 'RESTAURANT',
    roles: [],
    needsAck: false,
    body: 'Bring the bill only when the guest asks. A service charge is optional and left blank for the guest. Take card, UPI or cash. Never take a card out of the guest’s sight. A void or a discount needs the manager’s PIN and a reason.',
    from: 'Restaurant SOP FOH-07, AC-03',
  },
  {
    code: 'SOP-COMPLAINT',
    title: 'A guest complains',
    department: 'RESTAURANT',
    roles: [],
    needsAck: true,
    body: 'Listen. Say sorry. Fix it. Call the shift manager, who comes within 2 minutes. A server can replace a dish. A captain can take one item off the bill. Only the manager can take off the food bill. Write every complaint in the log.',
    from: 'Restaurant SOP FOH-08',
  },
  {
    code: 'SOP-ALLERGIC-REACTION',
    title: 'A guest has an allergic reaction',
    department: 'RESTAURANT',
    roles: [],
    needsAck: true,
    body: 'Call 108 or 112 at once. Help the guest use their own pen if they have one. Call the manager. Keep the dish and the ticket. Write down what they ate and when.',
    from: 'Restaurant SOP EM-04',
  },
  // bar
  {
    code: 'SOP-RESPONSIBLE-ALCOHOL',
    title: 'Serving alcohol responsibly',
    department: 'BAR',
    roles: [],
    needsAck: true,
    body: 'No alcohol to anyone under the legal age or who is drunk. Ask for ID when in doubt. Offer water and food. Tell the manager when you refuse someone, and write it in the logbook.',
    from: 'Bar SOP; Passport Hotel',
  },
  {
    code: 'SOP-MEASURED-POUR',
    title: 'Pouring with a measure',
    department: 'BAR',
    roles: [],
    needsAck: true,
    body: 'Pour every spirit with the measure: 30 ml or 60 ml, never free-hand. A bottle is opened only when the last one is empty. Every bottle that is broken or spilt is written down and shown to the bar manager.',
    from: 'Bar SOP: pouring and stock control',
  },
  // stores
  {
    code: 'SOP-ISSUES',
    title: 'Giving out stock',
    department: 'STORES-TEAM',
    roles: [],
    needsAck: false,
    body: 'Stock leaves the store only against a request in the app. Nobody helps themselves. Give the oldest first. Count what you give and what you get back.',
    from: 'Restaurant SOP PS-04',
  },
  // engineering
  {
    code: 'SOP-FRIDGE-FAILS',
    title: 'When a fridge or freezer fails',
    department: 'ENGINEERING',
    roles: [],
    needsAck: true,
    body: 'Move the food to a working fridge at once. Write down the temperature and the time. Tell the chef. Food that was above 5 °C (or above -18 °C frozen) for too long is thrown away. Report the repair in the app.',
    from: 'Restaurant SOP FA-04',
  },
];

export const SOP_BY_CODE: ReadonlyMap<string, LibrarySop> = new Map(SOPS.map((s) => [s.code, s]));
