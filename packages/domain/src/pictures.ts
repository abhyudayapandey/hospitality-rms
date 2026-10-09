// A picture of the thing itself on every item line (ADR 084), for staff who read little and
// remember pictures: garlic looks like garlic, cloves like cloves, a vodka bottle like a vodka
// bottle. Product code, like the duties and the catalogue. The pictures are SVG files in
// apps/web/public/pictures/<key>.svg: Microsoft's Fluent Emoji (flat, MIT licence) where it
// has the thing, drawn in the same flat style where it does not (`pnpm --filter
// @outlet-ops/web pictures` fetches and draws them). An item's picture comes from its name,
// in English, Hindi or Konkani, else its category; a customer's item that matches nothing
// specific is listed in the onboarding dry run so the words here can grow.

export type PictureGroup =
  | 'vegetable'
  | 'fruit'
  | 'herb'
  | 'spice'
  | 'grain'
  | 'dairy'
  | 'meat'
  | 'seafood'
  | 'pantry'
  | 'prep'
  | 'drink'
  | 'bar'
  | 'snack'
  | 'room'
  | 'cleaning'
  | 'packaging'
  | 'general';

export interface Picture {
  key: string;
  /** what it shows, in plain English (the picture's alt text) */
  label: string;
  group: PictureGroup;
  /** the words in an item's name that mean this picture: lower case, one to three words */
  words: readonly string[];
  /** the Fluent Emoji it is, by its folder name; otherwise drawn here */
  fluent?: string;
}

const p = (
  key: string,
  label: string,
  group: PictureGroup,
  words: readonly string[],
  fluent?: string,
): Picture => ({ key, label, group, words, ...(fluent && { fluent }) });

export const PICTURES: readonly Picture[] = [
  // vegetables
  p(
    'onion',
    'Onion',
    'vegetable',
    ['onion', 'onions', 'pyaz', 'pyaaz', 'kanda', 'kando', 'shallot', 'shallots'],
    'Onion',
  ),
  p('spring-onion', 'Spring onion', 'vegetable', [
    'spring onion',
    'spring onions',
    'scallion',
    'scallions',
    'green onion',
    'hara pyaz',
  ]),
  p(
    'tomato',
    'Tomato',
    'vegetable',
    ['tomato', 'tomatoes', 'tamatar', 'cherry tomato', 'cherry tomatoes'],
    'Tomato',
  ),
  p('potato', 'Potato', 'vegetable', ['potato', 'potatoes', 'aloo', 'alu', 'batata'], 'Potato'),
  p(
    'sweet-potato',
    'Sweet potato',
    'vegetable',
    ['sweet potato', 'sweet potatoes', 'shakarkandi', 'kanga'],
    'Roasted sweet potato',
  ),
  p('garlic', 'Garlic', 'vegetable', ['garlic', 'lehsun', 'lahsun', 'lasun', 'losun'], 'Garlic'),
  p('ginger', 'Ginger', 'vegetable', ['ginger', 'adrak', 'aale'], 'Ginger root'),
  p('green-chilli', 'Green chilli', 'vegetable', [
    'green chilli',
    'green chillies',
    'green chili',
    'green chilies',
    'hari mirch',
    'mirchi',
    'chilli',
    'chillies',
    'chili',
    'chilies',
  ]),
  p(
    'red-chilli',
    'Fresh red chilli',
    'vegetable',
    ['red chilli', 'red chillies', 'fresh red chilli', 'lal mirch'],
    'Hot pepper',
  ),
  p('dried-red-chilli', 'Dried red chilli', 'spice', [
    'dried chilli',
    'dried chillies',
    'dry chilli',
    'dry red chilli',
    'kashmiri chilli',
    'kashmiri chillies',
    'byadgi chilli',
    'sukhi lal mirch',
    'whole red chilli',
  ]),
  p('carrot', 'Carrot', 'vegetable', ['carrot', 'carrots', 'gajar'], 'Carrot'),
  p(
    'cucumber',
    'Cucumber',
    'vegetable',
    ['cucumber', 'cucumbers', 'kheera', 'kakdi', 'tausali'],
    'Cucumber',
  ),
  p(
    'brinjal',
    'Brinjal',
    'vegetable',
    ['brinjal', 'brinjals', 'eggplant', 'aubergine', 'baingan', 'vaingim'],
    'Eggplant',
  ),
  p(
    'capsicum',
    'Capsicum',
    'vegetable',
    ['capsicum', 'bell pepper', 'bell peppers', 'shimla mirch'],
    'Bell pepper',
  ),
  p(
    'corn',
    'Sweet corn',
    'vegetable',
    ['corn', 'sweet corn', 'sweetcorn', 'maize', 'makai', 'bhutta'],
    'Ear of corn',
  ),
  p('broccoli', 'Broccoli', 'vegetable', ['broccoli'], 'Broccoli'),
  p('cauliflower', 'Cauliflower', 'vegetable', ['cauliflower', 'gobi', 'phool gobi']),
  p('cabbage', 'Cabbage', 'vegetable', ['cabbage', 'patta gobi', 'band gobi']),
  p(
    'mushroom',
    'Mushroom',
    'vegetable',
    ['mushroom', 'mushrooms', 'button mushroom', 'khumb'],
    'Brown mushroom',
  ),
  p(
    'spinach',
    'Spinach and leafy greens',
    'vegetable',
    [
      'spinach',
      'palak',
      'lettuce',
      'leafy greens',
      'greens',
      'methi leaves',
      'amaranth',
      'bhaji',
      'saag',
      'rocket',
      'arugula',
    ],
    'Leafy green',
  ),
  p('peas', 'Green peas', 'vegetable', ['peas', 'green peas', 'matar', 'mutter'], 'Pea pod'),
  p('green-beans', 'Green beans', 'vegetable', [
    'green beans',
    'french beans',
    'beans',
    'farasbi',
    'fansi',
  ]),
  p('okra', 'Okra', 'vegetable', ['okra', 'bhindi', 'lady finger', 'ladies finger', 'bhende']),
  p('pumpkin', 'Pumpkin', 'vegetable', [
    'pumpkin',
    'kaddu',
    'bhopla',
    'dudhi',
    'bottle gourd',
    'lauki',
  ]),
  p('beetroot', 'Beetroot', 'vegetable', ['beetroot', 'beet', 'chukandar']),
  p('radish', 'Radish', 'vegetable', ['radish', 'mooli', 'mula']),
  p('avocado', 'Avocado', 'vegetable', ['avocado', 'avocados'], 'Avocado'),
  p('olive', 'Olives', 'vegetable', ['olive', 'olives'], 'Olive'),
  p('lemon', 'Lemon', 'fruit', ['lemon', 'lemons', 'nimbu', 'limbu'], 'Lemon'),
  p('lime', 'Lime', 'fruit', ['lime', 'limes', 'lime wedge', 'kagzi nimbu'], 'Lime'),

  // herbs
  p('coriander-leaves', 'Coriander leaves', 'herb', [
    'coriander',
    'coriander leaves',
    'cilantro',
    'dhania',
    'hara dhania',
    'kothimbir',
    'kotmir',
  ]),
  p('mint', 'Mint leaves', 'herb', ['mint', 'mint leaves', 'pudina', 'phudino']),
  p('curry-leaves', 'Curry leaves', 'herb', [
    'curry leaves',
    'curry leaf',
    'kadi patta',
    'kadipatta',
    'karipatta',
  ]),
  p(
    'basil',
    'Basil and herbs',
    'herb',
    ['basil', 'tulsi', 'parsley', 'oregano', 'thyme', 'rosemary', 'dill', 'herbs', 'mixed herbs'],
    'Herb',
  ),
  p('lemongrass', 'Lemongrass', 'herb', ['lemongrass', 'lemon grass', 'gavati chaha']),

  // fruit
  p('pineapple', 'Pineapple', 'fruit', ['pineapple', 'pineapples', 'ananas'], 'Pineapple'),
  p(
    'mango',
    'Mango',
    'fruit',
    ['mango', 'mangoes', 'aam', 'amba', 'alphonso', 'mancurad'],
    'Mango',
  ),
  p('banana', 'Banana', 'fruit', ['banana', 'bananas', 'kela', 'kel'], 'Banana'),
  p('apple', 'Apple', 'fruit', ['apple', 'apples', 'seb', 'red apple'], 'Red apple'),
  p(
    'green-apple',
    'Green apple',
    'fruit',
    ['green apple', 'green apples', 'granny smith'],
    'Green apple',
  ),
  p('grapes', 'Grapes', 'fruit', ['grape', 'grapes', 'angoor'], 'Grapes'),
  p(
    'orange',
    'Orange',
    'fruit',
    ['orange', 'oranges', 'santra', 'mosambi', 'sweet lime', 'tangerine'],
    'Tangerine',
  ),
  p('watermelon', 'Watermelon', 'fruit', ['watermelon', 'tarbooz', 'kalingad'], 'Watermelon'),
  p('muskmelon', 'Muskmelon', 'fruit', ['muskmelon', 'melon', 'kharbooja', 'cantaloupe'], 'Melon'),
  p('strawberry', 'Strawberry', 'fruit', ['strawberry', 'strawberries'], 'Strawberry'),
  p('cherry', 'Cherries', 'fruit', ['cherry', 'cherries', 'maraschino'], 'Cherries'),
  p('peach', 'Peach', 'fruit', ['peach', 'peaches', 'apricot'], 'Peach'),
  p('pear', 'Pear', 'fruit', ['pear', 'pears', 'nashpati'], 'Pear'),
  p('kiwi', 'Kiwi', 'fruit', ['kiwi', 'kiwis'], 'Kiwi fruit'),
  p('blueberry', 'Blueberries', 'fruit', ['blueberry', 'blueberries', 'berries'], 'Blueberries'),
  p('pomegranate', 'Pomegranate', 'fruit', ['pomegranate', 'anaar', 'anar', 'dalimb']),
  p('papaya', 'Papaya', 'fruit', ['papaya', 'papita', 'popai']),
  p('guava', 'Guava', 'fruit', ['guava', 'amrood', 'peru']),
  p('jackfruit', 'Jackfruit', 'fruit', ['jackfruit', 'kathal', 'ponos']),
  p(
    'coconut',
    'Coconut',
    'fruit',
    [
      'coconut',
      'coconuts',
      'fresh coconut',
      'grated coconut',
      'nariyal',
      'naal',
      'desiccated coconut',
    ],
    'Coconut',
  ),
  p('tender-coconut', 'Tender coconut', 'fruit', [
    'tender coconut',
    'tender coconuts',
    'nariyal pani',
    'coconut water',
    'adsor',
  ]),
  p('cranberry', 'Cranberries', 'fruit', ['cranberry', 'cranberries']),
  p(
    'hibiscus',
    'Hibiscus flowers',
    'herb',
    ['hibiscus', 'gudhal', 'roselle', 'sorrel'],
    'Hibiscus',
  ),
  p('rose', 'Rose petals', 'herb', ['rose', 'rose petals', 'gulab']),

  // spices
  p('cumin', 'Cumin seeds', 'spice', ['cumin', 'cumin seeds', 'jeera', 'jira', 'zeera']),
  p('clove', 'Cloves', 'spice', ['clove', 'cloves', 'laung', 'lavang', 'lovang']),
  p('cinnamon', 'Cinnamon', 'spice', [
    'cinnamon',
    'cinnamon stick',
    'cinnamon sticks',
    'dalchini',
    'cassia',
  ]),
  p('cardamom', 'Green cardamom', 'spice', [
    'cardamom',
    'green cardamom',
    'elaichi',
    'ilaichi',
    'veldode',
  ]),
  p('black-cardamom', 'Black cardamom', 'spice', [
    'black cardamom',
    'badi elaichi',
    'moti elaichi',
  ]),
  p('black-pepper', 'Black pepper', 'spice', [
    'black pepper',
    'pepper',
    'peppercorn',
    'peppercorns',
    'kali mirch',
    'miri',
  ]),
  p('turmeric', 'Turmeric', 'spice', ['turmeric', 'turmeric powder', 'haldi', 'halad']),
  p('chilli-powder', 'Red chilli powder', 'spice', [
    'chilli powder',
    'chili powder',
    'red chilli powder',
    'red chili powder',
    'kashmiri chilli powder',
    'lal mirch powder',
    'paprika',
    'cayenne',
  ]),
  p('coriander-powder', 'Coriander powder', 'spice', [
    'coriander powder',
    'dhania powder',
    'dhaniya powder',
  ]),
  p('coriander-seeds', 'Coriander seeds', 'spice', [
    'coriander seeds',
    'coriander seed',
    'sabut dhania',
    'dhane',
  ]),
  p('garam-masala', 'Garam masala', 'spice', [
    'garam masala',
    'masala powder',
    'spice mix',
    'chaat masala',
    'kitchen king',
    'sambar powder',
    'pav bhaji masala',
    'curry powder',
  ]),
  p('mustard-seeds', 'Mustard seeds', 'spice', [
    'mustard seeds',
    'mustard seed',
    'rai',
    'sarson',
    'mohri',
  ]),
  p('fennel', 'Fennel seeds', 'spice', ['fennel', 'fennel seeds', 'saunf', 'badishep']),
  p('fenugreek', 'Fenugreek seeds', 'spice', [
    'fenugreek',
    'fenugreek seeds',
    'methi seeds',
    'methi dana',
    'kasuri methi',
  ]),
  p('bay-leaf', 'Bay leaf', 'spice', ['bay leaf', 'bay leaves', 'tej patta', 'tamal patra']),
  p('star-anise', 'Star anise', 'spice', ['star anise', 'chakri phool', 'badiyan']),
  p('nutmeg', 'Nutmeg', 'spice', ['nutmeg', 'jaiphal', 'mace', 'javitri']),
  p('saffron', 'Saffron', 'spice', ['saffron', 'kesar', 'zafran']),
  p('sesame', 'Sesame seeds', 'spice', ['sesame', 'sesame seeds', 'til', 'teel']),
  p('ajwain', 'Carom seeds', 'spice', ['ajwain', 'carom', 'carom seeds', 'owa']),
  p('asafoetida', 'Asafoetida', 'spice', ['asafoetida', 'hing', 'heeng']),
  p(
    'salt',
    'Salt',
    'pantry',
    ['salt', 'namak', 'mith', 'sea salt', 'rock salt', 'black salt', 'kala namak'],
    'Salt',
  ),
  p('tamarind', 'Tamarind', 'pantry', ['tamarind', 'imli', 'chinch', 'tamarind pulp']),
  p('kokum', 'Kokum', 'pantry', ['kokum', 'kokam', 'bhirand', 'sola', 'amsol']),

  // grains, flours, pulses
  p('rice', 'Rice', 'grain', [
    'rice',
    'basmati',
    'basmati rice',
    'chawal',
    'tandul',
    'sona masoori',
    'jeera rice',
  ]),
  p('red-rice', 'Red rice', 'grain', [
    'red rice',
    'ukde',
    'ukda',
    'goan red rice',
    'boiled rice',
    'matta rice',
  ]),
  p(
    'cooked-rice',
    'Cooked rice',
    'grain',
    ['steamed rice', 'cooked rice', 'steamed basmati rice', 'plain rice', 'bhaat'],
    'Cooked rice',
  ),
  p('wheat-flour', 'Wheat flour (atta)', 'grain', [
    'atta',
    'wheat flour',
    'whole wheat flour',
    'chakki atta',
    'gehun',
  ]),
  p('maida', 'White flour (maida)', 'grain', [
    'maida',
    'refined flour',
    'all purpose flour',
    'plain flour',
    'flour',
    'cake flour',
    'bread flour',
  ]),
  p('besan', 'Gram flour (besan)', 'grain', ['besan', 'gram flour', 'chickpea flour']),
  p('rice-flour', 'Rice flour', 'grain', ['rice flour', 'chawal ka atta', 'tandlache pith']),
  p('semolina', 'Semolina (rava)', 'grain', ['semolina', 'rava', 'rawa', 'sooji', 'suji']),
  p('cornflour', 'Cornflour', 'grain', ['cornflour', 'corn flour', 'cornstarch', 'corn starch']),
  p('poha', 'Flattened rice (poha)', 'grain', ['poha', 'pohe', 'flattened rice', 'beaten rice']),
  p('oats', 'Oats', 'grain', ['oats', 'oatmeal', 'muesli', 'cornflakes', 'cereal']),
  p('toor-dal', 'Toor dal', 'grain', [
    'toor dal',
    'tur dal',
    'arhar dal',
    'toovar dal',
    'pigeon pea',
    'dal',
    'daal',
    'lentils',
  ]),
  p('moong-dal', 'Moong dal', 'grain', [
    'moong dal',
    'mung dal',
    'moong',
    'green gram',
    'mung beans',
  ]),
  p('masoor-dal', 'Masoor dal', 'grain', ['masoor dal', 'masoor', 'red lentils', 'red lentil']),
  p('urad-dal', 'Urad dal', 'grain', ['urad dal', 'urad', 'black gram', 'udid']),
  p('chana', 'Chickpeas (chana)', 'grain', [
    'chana',
    'chickpeas',
    'chickpea',
    'kabuli chana',
    'chole',
    'chana dal',
    'garbanzo',
  ]),
  p(
    'rajma',
    'Kidney beans (rajma)',
    'grain',
    ['rajma', 'kidney beans', 'red beans', 'baked beans'],
    'Beans',
  ),
  p('pasta', 'Pasta', 'grain', [
    'pasta',
    'penne',
    'spaghetti',
    'macaroni',
    'fusilli',
    'noodles',
    'hakka noodles',
  ]),
  p(
    'bread',
    'Bread loaf',
    'grain',
    ['bread', 'sandwich bread', 'bread loaf', 'loaf', 'brown bread', 'white bread', 'toast'],
    'Bread',
  ),
  p('pao', 'Pao (bread rolls)', 'grain', [
    'pao',
    'pav',
    'pau',
    'bun',
    'buns',
    'burger bun',
    'dinner roll',
    'dinner rolls',
    'ladi pav',
  ]),
  p(
    'poi',
    'Poi and flatbread',
    'grain',
    [
      'poi',
      'pita',
      'pita bread',
      'flatbread',
      'naan',
      'roti',
      'chapati',
      'tortilla',
      'wrap',
      'wraps',
      'kulcha',
      'paratha',
    ],
    'Flatbread',
  ),
  p(
    'baguette',
    'Baguette',
    'grain',
    ['baguette', 'french bread', 'garlic bread'],
    'Baguette bread',
  ),
  p(
    'croissant',
    'Croissant',
    'grain',
    ['croissant', 'croissants', 'puff pastry', 'pastry'],
    'Croissant',
  ),
  p(
    'cake',
    'Cake',
    'grain',
    ['cake', 'sponge cake', 'cake base', 'cupcake', 'muffin', 'muffins'],
    'Cupcake',
  ),
  p(
    'cookie',
    'Biscuits and cookies',
    'snack',
    ['cookie', 'cookies', 'biscuit', 'biscuits', 'rusk'],
    'Cookie',
  ),

  // dairy and eggs
  p(
    'milk',
    'Milk',
    'dairy',
    ['milk', 'doodh', 'dudh', 'full cream milk', 'toned milk', 'skimmed milk'],
    'Glass of milk',
  ),
  p('curd', 'Curd (dahi)', 'dairy', [
    'curd',
    'dahi',
    'yogurt',
    'yoghurt',
    'greek yogurt',
    'hung curd',
    'buttermilk',
    'chaas',
  ]),
  p('paneer', 'Paneer', 'dairy', ['paneer', 'cottage cheese', 'tofu']),
  p(
    'cheese',
    'Cheese',
    'dairy',
    [
      'cheese',
      'cheddar',
      'cheddar cheese',
      'mozzarella',
      'parmesan',
      'processed cheese',
      'cheese slice',
      'cheese slices',
      'feta',
    ],
    'Cheese wedge',
  ),
  p(
    'butter',
    'Butter',
    'dairy',
    ['butter', 'makhan', 'loni', 'salted butter', 'unsalted butter', 'white butter'],
    'Butter',
  ),
  p('ghee', 'Ghee', 'dairy', ['ghee', 'clarified butter', 'desi ghee', 'toop']),
  p('cream', 'Fresh cream', 'dairy', [
    'cream',
    'fresh cream',
    'whipping cream',
    'cooking cream',
    'malai',
    'sour cream',
  ]),
  p('condensed-milk', 'Condensed milk', 'dairy', [
    'condensed milk',
    'milkmaid',
    'khoya',
    'mawa',
    'evaporated milk',
  ]),
  p('egg', 'Eggs', 'dairy', ['egg', 'eggs', 'anda', 'ande', 'tantie'], 'Egg'),
  p(
    'ice-cream',
    'Ice cream',
    'dairy',
    ['ice cream', 'ice creams', 'gelato', 'kulfi', 'sorbet'],
    'Soft ice cream',
  ),

  // meat
  p(
    'chicken',
    'Chicken',
    'meat',
    [
      'chicken',
      'chicken curry cut',
      'chicken breast',
      'chicken thigh',
      'chicken leg',
      'chicken legs',
      'drumstick',
      'drumsticks',
      'chicken wings',
      'murgh',
      'kombi',
      'broiler',
    ],
    'Poultry leg',
  ),
  p(
    'mutton',
    'Mutton',
    'meat',
    ['mutton', 'lamb', 'goat', 'goat meat', 'gosht', 'bokdo', 'keema', 'mince', 'minced meat'],
    'Meat on bone',
  ),
  p(
    'beef',
    'Beef and buffalo',
    'meat',
    ['beef', 'buff', 'buffalo', 'steak', 'tenderloin'],
    'Cut of meat',
  ),
  p(
    'pork',
    'Pork',
    'meat',
    ['pork', 'pork belly', 'bacon', 'ham', 'pork chop', 'pork ribs', 'dukor', 'pork loin'],
    'Bacon',
  ),
  p('sausage', 'Sausages (chouriço)', 'meat', [
    'sausage',
    'sausages',
    'chorizo',
    'chouriço',
    'chourico',
    'choris',
    'salami',
    'pepperoni',
    'hot dog',
  ]),

  // seafood
  p(
    'fish',
    'Fish',
    'seafood',
    [
      'fish',
      'surmai',
      'kingfish',
      'king fish',
      'pomfret',
      'mackerel',
      'bangda',
      'sardine',
      'sardines',
      'tarle',
      'seer fish',
      'basa',
      'salmon',
      'tuna',
      'snapper',
      'modso',
      'chonak',
      'rawas',
      'lepo',
    ],
    'Fish',
  ),
  p(
    'prawns',
    'Prawns',
    'seafood',
    ['prawn', 'prawns', 'shrimp', 'shrimps', 'jhinga', 'sungta', 'kolambi', 'tiger prawns'],
    'Shrimp',
  ),
  p('squid', 'Squid', 'seafood', ['squid', 'calamari', 'mankio', 'octopus'], 'Squid'),
  p('crab', 'Crab', 'seafood', ['crab', 'crabs', 'kurlio', 'khekda', 'crab meat'], 'Crab'),
  p('lobster', 'Lobster', 'seafood', ['lobster', 'lobsters'], 'Lobster'),
  p(
    'clams',
    'Clams and mussels',
    'seafood',
    ['clam', 'clams', 'tisreo', 'tisryo', 'mussel', 'mussels', 'xinaneo', 'shellfish'],
    'Oyster',
  ),
  p('dried-fish', 'Dried fish', 'seafood', [
    'dried fish',
    'dry fish',
    'sukat',
    'bombil',
    'bombay duck',
    'dried prawns',
    'galmo',
  ]),

  // pantry: oils, sauces, sugar, nuts
  p('oil', 'Cooking oil', 'pantry', [
    'oil',
    'cooking oil',
    'refined oil',
    'vegetable oil',
    'sunflower oil',
    'groundnut oil',
    'peanut oil',
    'rice bran oil',
    'soybean oil',
    'canola oil',
    'tel',
  ]),
  p('coconut-oil', 'Coconut oil', 'pantry', ['coconut oil', 'khobrel tel']),
  p('olive-oil', 'Olive oil', 'pantry', ['olive oil', 'extra virgin olive oil']),
  p('mustard-oil', 'Mustard oil', 'pantry', ['mustard oil', 'sarson ka tel']),
  p('sugar', 'Sugar', 'pantry', [
    'sugar',
    'cheeni',
    'shakkar',
    'sakhar',
    'castor sugar',
    'caster sugar',
    'icing sugar',
    'brown sugar',
    'demerara',
  ]),
  p('jaggery', 'Jaggery', 'pantry', [
    'jaggery',
    'gur',
    'gul',
    'palm jaggery',
    'goa jaggery',
    'madd gul',
    'coconut jaggery',
  ]),
  p('honey', 'Honey', 'pantry', ['honey', 'shahad', 'madh'], 'Honey pot'),
  p('vinegar', 'Vinegar', 'pantry', [
    'vinegar',
    'toddy vinegar',
    'coconut vinegar',
    'white vinegar',
    'malt vinegar',
    'sirka',
    'apple cider vinegar',
  ]),
  p('ketchup', 'Tomato ketchup', 'pantry', [
    'ketchup',
    'tomato ketchup',
    'tomato sauce',
    'tomato puree',
    'tomato paste',
  ]),
  p('soy-sauce', 'Soy sauce', 'pantry', [
    'soy sauce',
    'soya sauce',
    'dark soy',
    'light soy',
    'oyster sauce',
    'fish sauce',
    'worcestershire',
  ]),
  p('chilli-sauce', 'Chilli sauce', 'pantry', [
    'chilli sauce',
    'chili sauce',
    'hot sauce',
    'sriracha',
    'tabasco',
    'schezwan sauce',
  ]),
  p('mayonnaise', 'Mayonnaise', 'pantry', [
    'mayonnaise',
    'mayo',
    'mustard sauce',
    'mustard',
    'dressing',
  ]),
  p(
    'pickle',
    'Pickle',
    'pantry',
    ['pickle', 'pickles', 'achaar', 'achar', 'miskut', 'jam', 'preserve', 'marmalade'],
    'Jar',
  ),
  p('coconut-milk', 'Coconut milk', 'pantry', [
    'coconut milk',
    'coconut cream',
    'nariyal doodh',
    'roce',
  ]),
  p('cashew', 'Cashew nuts', 'snack', ['cashew', 'cashews', 'cashew nuts', 'kaju', 'goan cashews']),
  p('almond', 'Almonds', 'snack', ['almond', 'almonds', 'badam']),
  p(
    'peanuts',
    'Peanuts',
    'snack',
    ['peanut', 'peanuts', 'groundnut', 'groundnuts', 'moongphali', 'shengdana'],
    'Peanuts',
  ),
  p('raisins', 'Raisins', 'snack', ['raisin', 'raisins', 'kishmish', 'sultanas', 'dried fruit']),
  p('dates', 'Dates', 'snack', ['date', 'dates', 'khajur', 'khajoor']),
  p(
    'chocolate',
    'Chocolate',
    'snack',
    ['chocolate', 'chocolate bar', 'chocolates', 'cocoa', 'cocoa powder', 'dark chocolate'],
    'Chocolate bar',
  ),
  p('chips', 'Chips packet', 'snack', [
    'chips',
    'crisps',
    'potato chips',
    'banana chips',
    'wafers',
    'namkeen',
    'bhujia',
    'chakli',
    'mixture',
  ]),
  p('nachos', 'Nacho chips', 'snack', ['nachos', 'nacho', 'nacho chips', 'tortilla chips']),
  p(
    'fries',
    'French fries',
    'snack',
    ['fries', 'french fries', 'potato wedges', 'wedges', 'frozen fries'],
    'French fries',
  ),
  p('popcorn', 'Popcorn', 'snack', ['popcorn'], 'Popcorn'),
  p('frozen', 'Frozen food', 'pantry', [
    'frozen',
    'frozen peas',
    'frozen corn',
    'frozen vegetables',
    'nuggets',
    'frozen snacks',
  ]),
  p(
    'tinned',
    'Tins and cans',
    'pantry',
    ['tinned', 'canned', 'tin', 'can of', 'baked beans tin', 'olives tin'],
    'Canned food',
  ),

  // prep made in the kitchen or bar
  p('masala-paste', 'Masala paste', 'prep', [
    'masala',
    'masala paste',
    'recheado',
    'recheado masala',
    'xacuti',
    'xacuti masala',
    'cafreal',
    'vindaloo',
    'marinade',
    'paste',
    'spice paste',
    'ginger garlic paste',
    'sambhar masala',
  ]),
  p(
    'gravy',
    'Gravy and curry base',
    'prep',
    [
      'gravy',
      'curry',
      'curry base',
      'makhani',
      'makhani gravy',
      'onion tomato masala',
      'tomato gravy',
      'base gravy',
      'sauce base',
      'stock',
      'soup',
      'dal tadka',
      'sambar',
      'rassa',
      'xitt',
    ],
    'Pot of food',
  ),
  p('chutney', 'Chutney', 'prep', [
    'chutney',
    'mint chutney',
    'green chutney',
    'coconut chutney',
    'dip',
    'salsa',
    'raita',
    'thecha',
  ]),
  p('dough', 'Dough', 'prep', [
    'dough',
    'pizza dough',
    'atta dough',
    'batter',
    'idli batter',
    'dosa batter',
  ]),
  p('syrup', 'Syrup', 'prep', [
    'syrup',
    'sugar syrup',
    'simple syrup',
    'hibiscus syrup',
    'grenadine',
    'shrub',
    'cordial',
    'sour mix',
    'sweet and sour',
    'oleo',
  ]),
  p('tepache', 'Tepache (fermented pineapple)', 'prep', [
    'tepache',
    'tepache liqueur',
    'ferment',
    'fermented',
    'kombucha',
  ]),
  p('batched-cocktail', 'Batched cocktail', 'bar', [
    'pre-batched',
    'batched',
    'sangria',
    'punch',
    'negroni',
    'old fashioned',
    'manhattan',
    'house cocktail',
  ]),

  // drinks
  p('water', 'Drinking water', 'drink', [
    'water',
    'mineral water',
    'drinking water',
    'bisleri',
    'packaged water',
    'water bottle',
  ]),
  p('soda', 'Soda water', 'drink', ['soda', 'soda water', 'club soda', 'sparkling water']),
  p('tonic', 'Tonic water', 'drink', ['tonic', 'tonic water', 'indian tonic']),
  p('cola', 'Cola', 'drink', [
    'cola',
    'coke',
    'pepsi',
    'thums up',
    'soft drink',
    'soft drinks',
    'lemonade',
    'sprite',
    'ginger ale',
    'ginger beer',
  ]),
  p('orange-juice', 'Orange juice', 'drink', [
    'orange juice',
    'juice',
    'mosambi juice',
    'fruit juice',
    'pineapple juice',
    'apple juice',
    'mango juice',
  ]),
  p('cranberry-juice', 'Cranberry juice', 'drink', ['cranberry juice']),
  p('coffee', 'Coffee beans', 'drink', [
    'coffee',
    'coffee beans',
    'espresso',
    'espresso beans',
    'ground coffee',
    'instant coffee',
    'cold brew',
    'cold brew coffee',
    'filter coffee',
  ]),
  p(
    'tea',
    'Tea leaves',
    'drink',
    ['tea', 'tea leaves', 'chai', 'chai patti', 'green tea', 'tea bags', 'black tea'],
    'Teacup without handle',
  ),
  p('ice', 'Ice', 'drink', ['ice', 'ice cubes', 'crushed ice', 'ice block', 'barf'], 'Ice'),
  p('beer', 'Beer bottle', 'bar', [
    'beer',
    'lager',
    'craft beer',
    'ale',
    'ipa',
    'stout',
    'pilsner',
    'wheat beer',
    'kingfisher',
    'draught',
    'draft beer',
  ]),
  p('red-wine', 'Red wine', 'bar', [
    'red wine',
    'shiraz',
    'cabernet',
    'merlot',
    'pinot noir',
    'port',
    'port wine',
    'wine',
  ]),
  p('white-wine', 'White wine', 'bar', [
    'white wine',
    'chardonnay',
    'sauvignon blanc',
    'chenin blanc',
    'rose wine',
  ]),
  p(
    'sparkling-wine',
    'Sparkling wine',
    'bar',
    ['sparkling wine', 'champagne', 'prosecco', 'cava', 'brut'],
    'Bottle with popping cork',
  ),
  p('vodka', 'Vodka', 'bar', ['vodka']),
  p('gin', 'Gin', 'bar', ['gin', 'craft gin', 'london dry']),
  p('whisky', 'Whisky', 'bar', ['whisky', 'whiskey', 'blended whisky', 'scotch', 'blended scotch']),
  p('single-malt', 'Single malt', 'bar', ['single malt', 'malt whisky', 'malt']),
  p('bourbon', 'Bourbon', 'bar', ['bourbon', 'rye', 'rye whiskey', 'tennessee']),
  p('dark-rum', 'Dark rum', 'bar', ['dark rum', 'rum', 'old monk', 'spiced rum', 'gold rum']),
  p('white-rum', 'White rum', 'bar', ['white rum', 'light rum', 'bacardi', 'silver rum']),
  p('tequila', 'Tequila', 'bar', ['tequila', 'tequila blanco', 'mezcal', 'reposado']),
  p('brandy', 'Brandy', 'bar', ['brandy', 'cognac']),
  p('feni', 'Feni', 'bar', ['feni', 'fenny', 'cashew feni', 'coconut feni', 'urrak', 'urak']),
  p('feni-nip', 'Small bottle (nip)', 'bar', ['nip', 'nips', 'miniature', 'mini bottle']),
  p('liqueur', 'Liqueur', 'bar', [
    'liqueur',
    'liqueurs',
    'amaretto',
    'baileys',
    'irish cream',
    'schnapps',
  ]),
  p('coffee-liqueur', 'Coffee liqueur', 'bar', ['coffee liqueur', 'kahlua']),
  p('triple-sec', 'Orange liqueur', 'bar', [
    'triple sec',
    'cointreau',
    'curacao',
    'blue curacao',
    'orange liqueur',
    'grand marnier',
  ]),
  p('vermouth', 'Vermouth', 'bar', [
    'vermouth',
    'sweet vermouth',
    'dry vermouth',
    'martini rosso',
    'martini bianco',
  ]),
  p('aperitif', 'Red bitter aperitif', 'bar', [
    'campari',
    'aperol',
    'aperitif',
    'bitter aperitif',
    'aperitivo',
  ]),
  p('bitters', 'Bitters', 'bar', ['bitters', 'angostura', 'aromatic bitters', 'orange bitters']),
  p('sake', 'Sake', 'bar', ['sake', 'soju'], 'Sake'),
  p(
    'cocktail',
    'Cocktail',
    'bar',
    ['cocktail', 'cocktails', 'mocktail', 'mocktails', 'martini', 'margarita', 'mojito'],
    'Cocktail glass',
  ),
  p('cocktail-napkins', 'Cocktail napkins', 'packaging', [
    'cocktail napkins',
    'cocktail napkin',
    'bar napkins',
    'coasters',
    'coaster',
  ]),
  p(
    'straws',
    'Straws',
    'packaging',
    ['straw', 'straws', 'stirrer', 'stirrers', 'toothpicks', 'skewers'],
    'Cup with straw',
  ),

  // rooms: linen and amenities
  p('bath-towel', 'Bath towel', 'room', [
    'bath towel',
    'bath towels',
    'towel',
    'towels',
    'bath sheet',
  ]),
  p('hand-towel', 'Hand towel', 'room', [
    'hand towel',
    'hand towels',
    'face towel',
    'face towels',
    'napkin cloth',
    'kitchen towel',
    'duster',
  ]),
  p('pool-towel', 'Pool towel', 'room', [
    'pool towel',
    'pool towels',
    'beach towel',
    'beach towels',
  ]),
  p('bedsheet', 'Bedsheet', 'room', [
    'bedsheet',
    'bedsheets',
    'bed sheet',
    'bed sheets',
    'sheet',
    'sheets',
    'duvet cover',
    'bed linen',
  ]),
  p('pillow', 'Pillow and cover', 'room', [
    'pillow',
    'pillows',
    'pillow cover',
    'pillow covers',
    'pillowcase',
    'pillow case',
    'cushion',
    'cushion cover',
  ]),
  p('blanket', 'Blanket and duvet', 'room', [
    'blanket',
    'blankets',
    'duvet',
    'quilt',
    'comforter',
    'razai',
  ]),
  p('bathrobe', 'Bathrobe', 'room', ['bathrobe', 'bath robe', 'robe', 'gown']),
  p('slippers', 'Slippers', 'room', ['slipper', 'slippers', 'chappal', 'flip flops']),
  p('soap', 'Soap', 'room', ['soap', 'soap bar', 'bathing soap', 'hand soap', 'soap bars'], 'Soap'),
  p(
    'shampoo',
    'Shampoo and lotion',
    'room',
    [
      'shampoo',
      'conditioner',
      'body wash',
      'shower gel',
      'lotion',
      'body lotion',
      'moisturiser',
      'moisturizer',
    ],
    'Lotion bottle',
  ),
  p(
    'dental-kit',
    'Dental kit',
    'room',
    ['dental kit', 'dental kits', 'toothbrush', 'toothpaste', 'tooth brush'],
    'Toothbrush',
  ),
  p('shaving-kit', 'Shaving kit', 'room', ['shaving kit', 'razor', 'razors', 'shaving'], 'Razor'),
  p(
    'toilet-roll',
    'Toilet roll',
    'room',
    ['toilet roll', 'toilet rolls', 'toilet paper', 'tissue roll', 'tissue rolls'],
    'Roll of paper',
  ),
  p('tissues', 'Tissue box', 'room', [
    'tissue',
    'tissues',
    'tissue box',
    'facial tissue',
    'kleenex',
  ]),
  p('sanitary-bag', 'Sanitary bag', 'room', [
    'sanitary bag',
    'sanitary bags',
    'vanity kit',
    'cotton buds',
    'comb',
    'shower cap',
  ]),
  p('pool-chlorine', 'Pool chlorine', 'cleaning', [
    'chlorine',
    'pool chlorine',
    'chlorine granules',
    'chlorine tablets',
    'ph plus',
    'ph minus',
  ]),

  // cleaning
  p('floor-cleaner', 'Floor cleaner', 'cleaning', [
    'floor cleaner',
    'floor cleaning',
    'phenyl',
    'phenol',
    'lizol',
    'surface cleaner',
    'multi surface',
    'disinfectant',
    'cleaner',
  ]),
  p('glass-cleaner', 'Glass cleaner spray', 'cleaning', [
    'glass cleaner',
    'colin',
    'window cleaner',
    'spray cleaner',
    'sanitiser spray',
    'sanitizer spray',
  ]),
  p('toilet-cleaner', 'Toilet cleaner', 'cleaning', [
    'toilet cleaner',
    'harpic',
    'bowl cleaner',
    'acid',
  ]),
  p('dish-wash', 'Dishwash liquid', 'cleaning', [
    'dishwash',
    'dish wash',
    'dishwashing',
    'vim',
    'pril',
    'washing up liquid',
    'rinse aid',
    'dishwasher detergent',
  ]),
  p('detergent', 'Laundry detergent', 'cleaning', [
    'detergent',
    'laundry',
    'washing powder',
    'surf',
    'ariel',
    'bleach',
    'fabric softener',
    'starch',
  ]),
  p('hand-wash', 'Hand wash', 'cleaning', [
    'hand wash',
    'handwash',
    'hand sanitiser',
    'hand sanitizer',
    'sanitiser',
    'sanitizer',
  ]),
  p('garbage-bags', 'Garbage bags', 'cleaning', [
    'garbage bag',
    'garbage bags',
    'trash bag',
    'trash bags',
    'bin bag',
    'bin bags',
    'dustbin bag',
    'dustbin bags',
    'bin liner',
    'bin liners',
  ]),
  p(
    'sponge',
    'Sponge and scrubber',
    'cleaning',
    ['sponge', 'sponges', 'scrubber', 'scrub pad', 'scotch brite', 'steel wool'],
    'Sponge',
  ),
  p(
    'gloves',
    'Gloves',
    'cleaning',
    ['gloves', 'glove', 'disposable gloves', 'kitchen gloves', 'rubber gloves'],
    'Gloves',
  ),
  p(
    'broom',
    'Broom and mop',
    'cleaning',
    ['broom', 'brooms', 'jhadu', 'mop', 'mops', 'mop head', 'wiper'],
    'Broom',
  ),
  p('bucket', 'Bucket', 'cleaning', ['bucket', 'buckets', 'balti'], 'Bucket'),

  // packaging
  p('foil', 'Aluminium foil', 'packaging', [
    'foil',
    'aluminium foil',
    'aluminum foil',
    'silver foil',
    'foil roll',
    'foil container',
    'foil containers',
  ]),
  p('cling-film', 'Cling film', 'packaging', [
    'cling film',
    'cling wrap',
    'plastic wrap',
    'food wrap',
    'stretch film',
  ]),
  p('butter-paper', 'Butter paper', 'packaging', [
    'butter paper',
    'baking paper',
    'parchment',
    'wax paper',
  ]),
  p('paper-napkins', 'Paper napkins', 'packaging', [
    'napkin',
    'napkins',
    'paper napkins',
    'paper napkin',
    'serviette',
    'serviettes',
    'tissue paper',
  ]),
  p(
    'takeaway-box',
    'Takeaway container',
    'packaging',
    [
      'takeaway container',
      'takeaway containers',
      'takeaway box',
      'container',
      'containers',
      'food container',
      'meal box',
      'delivery box',
      'clamshell',
    ],
    'Takeout box',
  ),
  p('paper-bag', 'Paper bag', 'packaging', [
    'paper bag',
    'paper bags',
    'carry bag',
    'carry bags',
    'delivery bag',
  ]),
  p('paper-cup', 'Paper cup', 'packaging', [
    'paper cup',
    'paper cups',
    'disposable cup',
    'disposable cups',
    'cup lid',
    'cup lids',
    'glasses disposable',
  ]),
  p(
    'cutlery-pack',
    'Disposable cutlery',
    'packaging',
    [
      'disposable cutlery',
      'spoon',
      'spoons',
      'fork',
      'forks',
      'cutlery',
      'wooden spoon',
      'plastic spoon',
    ],
    'Spoon',
  ),
  p(
    'box',
    'Box or pack',
    'general',
    ['box', 'pack', 'packet', 'carton', 'case', 'crate'],
    'Package',
  ),
  p(
    'dish',
    'A dish',
    'general',
    ['dish', 'meal', 'thali', 'platter', 'combo'],
    'Fork and knife with plate',
  ),

  // when nothing more specific matches: the category's picture
  p('vegetables', 'Vegetables', 'vegetable', [
    'vegetable',
    'vegetables',
    'veg',
    'sabzi',
    'produce',
  ]),
  p('fruits', 'Fruit', 'fruit', ['fruit', 'fruits', 'phal']),
  p('spices', 'Spices', 'spice', ['spice', 'spices', 'masale', 'whole spices']),
  p('grocery', 'Grocery sack', 'grain', [
    'grocery',
    'dry grocery',
    'staples',
    'grains',
    'pulses',
    'sack',
  ]),
  p('meat', 'Meat', 'meat', ['meat', 'non veg', 'non-veg']),
  p('seafood', 'Seafood', 'seafood', ['seafood', 'sea food']),
  p('dairy', 'Dairy', 'dairy', ['dairy', 'dairy & eggs', 'dairy and eggs']),
  p('bakery', 'Bakery', 'grain', ['bakery', 'baked goods']),
  p('spirits', 'Spirits bottle', 'bar', ['spirit', 'spirits', 'liquor', 'alcohol', 'hard liquor']),
  p('mixers', 'Mixers', 'drink', ['mixer', 'mixers', 'beverages', 'beverage', 'drinks']),
  p('bar-supplies', 'Bar supplies', 'bar', ['bar', 'bar consumables', 'bar supplies']),
  p('amenities', 'Guest amenities', 'room', [
    'amenities',
    'guest amenities',
    'amenity',
    'toiletries',
  ]),
  p('cleaning', 'Cleaning supplies', 'cleaning', [
    'cleaning',
    'housekeeping',
    'chemicals',
    'cleaning supplies',
  ]),
  p('packaging', 'Packaging', 'packaging', ['packaging', 'disposables', 'consumables']),
  p('minibar', 'Minibar', 'snack', ['minibar', 'mini bar', 'snacks', 'snack']),
  p('linen', 'Linen', 'room', ['linen', 'linens']),
];

/** Pictures that only ever stand in for a category: never "specific". */
const CATEGORY_KEYS = new Set([
  'vegetables',
  'fruits',
  'spices',
  'grocery',
  'meat',
  'seafood',
  'dairy',
  'bakery',
  'spirits',
  'mixers',
  'bar-supplies',
  'amenities',
  'cleaning',
  'packaging',
  'minibar',
  'linen',
  'box',
  'dish',
]);

export const PICTURE_KEYS: readonly string[] = PICTURES.map((x) => x.key);
const BY_KEY = new Map(PICTURES.map((x) => [x.key, x]));

export function pictureOf(key: string): Picture | undefined {
  return BY_KEY.get(key);
}

/** 'Test Kashmiri Chilli, dried 750ml (Pack of 30)' -> words, sizes and "test" left out */
function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\b\d+(\.\d+)?\s*(ml|l|ltr|cl|g|gm|gms|kg|kgs|pcs|pc|nos|no)\b/g, ' ')
    .replace(/\bpack of \d+\b/g, ' ')
    .replace(/[^a-z\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((w) => w && w !== 'test' && !/^\d+$/.test(w));
}

// every phrase, its picture and its length in words; longer phrases are tried first
const PHRASES: readonly { words: readonly string[]; key: string }[] = PICTURES.flatMap((x) =>
  x.words.map((w) => ({ words: tokens(w), key: x.key })),
).sort((a, b) => b.words.length - a.words.length);

/** a word or its plural: "box" is in "Delivery boxes", "berry" in "berries" */
const same = (t: string, w: string) =>
  t === w || t === `${w}s` || t === `${w}es` || (w.endsWith('y') && t === `${w.slice(0, -1)}ies`);

/**
 * The best picture in some words: the longest phrase wins; between phrases as long, the one
 * further right (the thing itself usually comes last: "coconut curry base" is a curry base).
 */
function bestIn(text: string): string | null {
  const t = tokens(text);
  if (t.length === 0) return null;
  let best: { key: string; len: number; end: number } | null = null;
  for (const ph of PHRASES) {
    if (best && ph.words.length < best.len) break;
    for (let i = 0; i + ph.words.length <= t.length; i++) {
      if (ph.words.every((w, j) => same(t[i + j]!, w))) {
        const end = i + ph.words.length;
        if (!best || ph.words.length > best.len || end > best.end) {
          best = { key: ph.key, len: ph.words.length, end };
        }
      }
    }
  }
  return best?.key ?? null;
}

export interface PictureMatch {
  key: string;
  /** false when only the category (or nothing at all) gave the picture */
  specific: boolean;
}

/**
 * An item's picture from its name, then its category. The name's head (before a comma or a
 * bracket) decides first, so "Chicken, curry cut" is chicken and "Refined Flour (Maida)" is
 * maida; then what is in brackets, then after the comma; then the category.
 */
export function matchPicture(name: string, category?: string | null): PictureMatch {
  const head = name.split(/[,(]/)[0] ?? name;
  const bracket = /\(([^)]*)\)/.exec(name)?.[1] ?? '';
  const tail = name.includes(',') ? name.slice(name.indexOf(',') + 1) : '';
  for (const part of [head, bracket, tail]) {
    const key = bestIn(part);
    if (key && !CATEGORY_KEYS.has(key)) return { key, specific: true };
  }
  const fromCategory = category ? bestIn(category) : null;
  const fromName = bestIn(name);
  return { key: fromCategory ?? fromName ?? 'box', specific: false };
}

/** The picture's key for an item: its own when set, else matched from its name and category. */
export function pictureFor(name: string, category?: string | null): string {
  return matchPicture(name, category).key;
}
