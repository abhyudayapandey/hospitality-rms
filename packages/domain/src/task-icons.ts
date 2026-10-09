// A picture for every task and checklist step (GM feedback item 5, ADR 079), for staff who
// read little. The pictograms are drawn in apps/web/components/icon.tsx. A step may name one
// (a library checklist, file 29's step_icon, or whoever edits the checklist); otherwise the
// app picks one from its words. The database accepts the same list (ops.task_icon_names);
// task-icons.db.test.ts keeps the two equal.

export const TASK_ICONS = [
  'bottle',
  'thermometer',
  'mop',
  'broom',
  'handwash',
  'fridge',
  'oil',
  'trash',
  'towel',
  'ice',
  'knife',
  'extinguisher',
  'spray',
  'lock',
  'bulb',
  'bed',
  'glass',
  'pot',
  'plate',
  'leaf',
  'box',
  'truck',
  'wrench',
  'fire',
  'shield',
  'clipboard',
  'camera',
  'check',
  'people',
  'bell',
  'cart',
  'bill',
  'tap',
  'pool',
  'dumbbell',
] as const;
export type TaskIcon = (typeof TASK_ICONS)[number];

export function isTaskIcon(v: string): v is TaskIcon {
  return (TASK_ICONS as readonly string[]).includes(v);
}

/** What each pictogram shows, for the picker's label. */
export const TASK_ICON_WORDS: Record<TaskIcon, string> = {
  bottle: 'Bottle on a shelf',
  thermometer: 'Thermometer',
  mop: 'Mop',
  broom: 'Broom',
  handwash: 'Hand wash',
  fridge: 'Fridge',
  oil: 'Oil',
  trash: 'Bin',
  towel: 'Towel',
  ice: 'Ice',
  knife: 'Knife',
  extinguisher: 'Fire extinguisher',
  spray: 'Spray',
  lock: 'Lock',
  bulb: 'Light',
  bed: 'Bed',
  glass: 'Glass',
  pot: 'Pot',
  plate: 'Plate',
  leaf: 'Vegetables',
  box: 'Box',
  truck: 'Delivery',
  wrench: 'Repair',
  fire: 'Gas and flame',
  shield: 'Safety',
  clipboard: 'Check list',
  camera: 'Photo',
  check: 'Tick',
  people: 'Team',
  bell: 'Bell',
  cart: 'Trolley',
  bill: 'Bill',
  tap: 'Water',
  pool: 'Pool',
  dumbbell: 'Gym',
};

// First match wins: the most particular words first.
const RULES: readonly [RegExp, TaskIcon][] = [
  [/extinguisher|fire exit|fire door|evacuat|alarm|smoke/i, 'extinguisher'],
  [/lifeguard|aed|emergency|first aid|no-diving|depth mark/i, 'shield'],
  [/temp|°c|thermo|probe|core heat|chiller|freezer reading/i, 'thermometer'],
  [/fridge|chiller|freezer|walk-in|cold room|minibar/i, 'fridge'],
  [
    /hand[- ]?wash|hands washed|wash (your )?hands|soap|sanitis(e|er) hands|sanitiz(e|er) hands/i,
    'handwash',
  ],
  [/fryer|oil/i, 'oil'],
  [/\bice\b|ice machine/i, 'ice'],
  [/knife|knives|chopping|cutting board/i, 'knife'],
  [/mop|floor/i, 'mop'],
  [/sweep|broom|dust/i, 'broom'],
  [/spray|sanitis|sanitiz|disinfect|wipe|clean/i, 'spray'],
  [/bin|garbage|waste|trash|rubbish|discard|throw/i, 'trash'],
  [/towel|linen|sheet|pillow|laundry|stain/i, 'towel'],
  [/\bbed\b|room|turndown|housekeep|slipper|bedside/i, 'bed'],
  [/bottle|liquor|spirit|wine|beer|shelf|restock|par\b/i, 'bottle'],
  [/glass|bar\b|cocktail|garnish/i, 'glass'],
  [/pool|chlorine|\bph\b/i, 'pool'],
  [/gym|equipment|treadmill/i, 'dumbbell'],
  [/water|tap|sink|drain|rinse/i, 'tap'],
  [/gas|burner|flame|stove|hood|duct/i, 'fire'],
  [/light|bulb|lamp/i, 'bulb'],
  [/lock|key|door|safe|secure/i, 'lock'],
  [/deliver|receiv|supplier|truck/i, 'truck'],
  [/repair|fix|maintenance|broken|leak/i, 'wrench'],
  [/cook|prep|batch|sauce|gravy|boil|make\b|brew|coffee/i, 'pot'],
  [/plate|serve|buffet|breakfast|food|dish/i, 'plate'],
  [/veg|produce|fruit|herb|salad/i, 'leaf'],
  [/stock|store|count|box|label|use-by|in date|packaging|condiment/i, 'box'],
  [/bill|cash|charge|invoice|pay|card|upi|float|terminal/i, 'bill'],
  [/brief|team|staff|meeting|uniform|groom|crew|trainer|therapist/i, 'people'],
  [/guest|call|bell|front desk|reception|arrival|departure|booking/i, 'bell'],
  [/corridor|clear\b/i, 'broom'],
  [/online|app\b|menus|rating|complaint|report|log\b|form/i, 'clipboard'],
  [/trolley|cart/i, 'cart'],
  [/safety|first aid|pest|hazard/i, 'shield'],
  [/photo|picture/i, 'camera'],
];

/** The picture for a step: the one it names, else one from its words, else by its kind. */
export function stepIcon(label: string, kind: string, named?: string | null): TaskIcon {
  if (named && isTaskIcon(named)) return named;
  const hit = RULES.find(([re]) => re.test(label));
  if (hit) return hit[1];
  if (kind === 'number') return 'thermometer';
  if (kind === 'photo') return 'camera';
  if (kind === 'batch') return 'pot';
  if (kind === 'discard') return 'trash';
  return 'check';
}

/** The picture for a task: by its kind, else from its title. */
export function taskIcon(title: string, kind: string): TaskIcon {
  switch (kind) {
    case 'prep':
      return 'pot';
    case 'expiry':
      return 'trash';
    case 'licence':
    case 'compliance':
      return 'shield';
    case 'receive':
      return 'truck';
    case 'minibar_refill':
      return 'fridge';
    case 'minibar_bill':
      return 'bill';
    case 'sign_off':
      return 'check';
    default: {
      const hit = RULES.find(([re]) => re.test(title));
      return hit ? hit[1] : 'clipboard';
    }
  }
}
