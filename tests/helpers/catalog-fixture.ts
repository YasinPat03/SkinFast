// A small hand-built catalog for exercising the trade-up engine without a
// database. Prices are in cents; every figure is chosen so results can be
// checked by hand.

import {
  type CatalogRows,
  type SkinRow,
  type VariantRow,
  buildCatalog,
} from '../../src/lib/tradeup/catalog';

type Quote = [listing: number | null, sale: number | null];
type WearQuotes = Partial<Record<'FN' | 'MW' | 'FT' | 'WW' | 'BS' | 'Vanilla', Quote>>;

const WEAR_NAME = {
  FN: 'Factory New',
  MW: 'Minimal Wear',
  FT: 'Field-Tested',
  WW: 'Well-Worn',
  BS: 'Battle-Scarred',
  Vanilla: 'Vanilla',
} as const;

const RARITY_NAME: Record<string, string> = {
  rarity_common_weapon: 'Consumer Grade',
  rarity_uncommon_weapon: 'Industrial Grade',
  rarity_rare_weapon: 'Mil-Spec Grade',
  rarity_mythical_weapon: 'Restricted',
  rarity_legendary_weapon: 'Classified',
  rarity_ancient_weapon: 'Covert',
};

export function skin(id: string, name: string, rarityId: string, minFloat = 0, maxFloat = 1): SkinRow {
  const weapon = name.replace('★ ', '').split(' | ')[0];
  return {
    id,
    name,
    weapon_name: weapon,
    rarity_id: rarityId,
    rarity_name: RARITY_NAME[rarityId] ?? rarityId,
    min_float: minFloat,
    max_float: maxFloat,
    image_url: null,
  };
}

export function variants(
  skinId: string,
  name: string,
  quotes: WearQuotes,
  flavor: 'normal' | 'stattrak' | 'souvenir' = 'normal',
): VariantRow[] {
  return Object.entries(quotes).map(([wear, quote]) => {
    const [listing, sale] = quote as Quote;
    const wearName = WEAR_NAME[wear as keyof typeof WEAR_NAME];
    const star = name.startsWith('★ ') ? '★ ' : '';
    const bare = name.replace('★ ', '');
    const prefix = flavor === 'stattrak' ? 'StatTrak™ ' : flavor === 'souvenir' ? 'Souvenir ' : '';
    const suffix = wearName === 'Vanilla' ? '' : ` (${wearName})`;
    return {
      skin_id: skinId,
      market_hash_name: `${star}${prefix}${bare}${suffix}`,
      wear_name: wearName,
      is_stattrak: flavor === 'stattrak',
      is_souvenir: flavor === 'souvenir',
      lowest_price_cents: listing,
      sell_listings: listing == null ? 0 : 10,
      avg_last5_cents: sale,
      sample_count: sale == null ? 0 : 5,
      last_sale_at: sale == null ? null : '2026-11-01T00:00:00.000Z',
    };
  });
}

// Every wear listed and sold at the same price.
const flat = (cents: number): WearQuotes => ({
  FN: [cents, cents],
  MW: [cents, cents],
  FT: [cents, cents],
  WW: [cents, cents],
  BS: [cents, cents],
});

export function fixtureRows(): CatalogRows {
  const MIL = 'rarity_rare_weapon';
  const RES = 'rarity_mythical_weapon';
  const CLA = 'rarity_legendary_weapon';
  const COV = 'rarity_ancient_weapon';
  const CON = 'rarity_common_weapon';

  const skins: SkinRow[] = [
    // Alpha collection
    skin('a-con', 'Nova | Dust', CON),
    skin('a-in1', 'P250 | Wide', MIL, 0, 1),
    skin('a-in2', 'MP7 | Half', MIL, 0, 0.5),
    skin('a-in3', 'MAC-10 | Ghost', MIL, 0, 1),
    skin('a-out1', 'AK-47 | Full', RES, 0, 1),
    skin('a-out2', 'M4A4 | Narrow', RES, 0.1, 0.6),
    skin('a-cla', 'USP-S | Class', CLA, 0, 1),
    skin('a-cov', 'AWP | Red', COV, 0, 1),
    // Beta collection (fillers)
    skin('b-in1', 'Nova | Filler', MIL, 0, 1),
    skin('b-out1', 'Glock-18 | One', RES, 0, 1),
    skin('b-out2', 'Glock-18 | Two', RES, 0, 1),
    skin('b-out3', 'Glock-18 | Three', RES, 0, 1),
    // Gamma collection: gloves-only case
    skin('c-cov', 'M4A1-S | Gamma', COV, 0, 1),
    // Knives and gloves of the Alpha case
    skin('k-fade', '★ Karambit | Fade', COV, 0, 0.08),
    skin('k-dop-1', '★ Karambit | Doppler', COV, 0, 0.08),
    skin('k-dop-2', '★ Karambit | Doppler', COV, 0, 0.08),
    skin('k-dop-3', '★ Karambit | Doppler', COV, 0, 0.08),
    skin('k-van', '★ Karambit', COV, 0, 1),
    skin('g-alpha', '★ Sport Gloves | Alpha', COV, 0.06, 0.8),
    // Gloves of the Gamma case
    skin('g-gamma', '★ Sport Gloves | Gamma', COV, 0.06, 0.8),
  ];

  const variantRows: VariantRow[] = [
    ...variants('a-con', 'Nova | Dust', flat(5)),
    ...variants('a-in1', 'P250 | Wide', {
      FN: [500, 480],
      MW: [300, 290],
      FT: [100, 95],
      WW: [80, 75],
      BS: [60, 55],
    }),
    ...variants('a-in1', 'P250 | Wide', { FT: [250, 240], BS: [150, 140] }, 'stattrak'),
    ...variants('a-in1', 'P250 | Wide', { FT: [70, 65] }, 'souvenir'),
    ...variants('a-in2', 'MP7 | Half', {
      FN: [400, 390],
      MW: [90, 85],
      FT: [50, 45],
      BS: [40, 35],
    }),
    // Has no active listing in any wear: must never be used as an input.
    ...variants('a-in3', 'MAC-10 | Ghost', { FT: [null, 10], BS: [null, 8] }),
    ...variants('a-out1', 'AK-47 | Full', {
      FN: [9000, 8800],
      MW: [5000, 4900],
      FT: [3000, 2900],
      WW: [2500, 2400],
      BS: [2000, 1900],
    }),
    ...variants('a-out1', 'AK-47 | Full', { FT: [7000, 6800], BS: [5000, 4800] }, 'stattrak'),
    ...variants('a-out2', 'M4A4 | Narrow', {
      MW: [4000, 3900],
      FT: [1500, 1400],
      WW: [1200, 1100],
      BS: [1000, 900],
    }),
    ...variants('a-out2', 'M4A4 | Narrow', { FT: [3500, 3300], WW: [3000, 2800], BS: [2600, 2400] }, 'stattrak'),
    ...variants('a-cla', 'USP-S | Class', flat(20000)),
    ...variants('a-cov', 'AWP | Red', flat(60000)),
    ...variants('a-cov', 'AWP | Red', flat(90000), 'stattrak'),
    ...variants('b-in1', 'Nova | Filler', {
      FN: [20, 18],
      MW: [15, 14],
      FT: [10, 9],
      WW: [9, 8],
      BS: [8, 7],
    }),
    ...variants('b-out1', 'Glock-18 | One', flat(300)),
    ...variants('b-out2', 'Glock-18 | Two', flat(200)),
    ...variants('b-out3', 'Glock-18 | Three', flat(100)),
    ...variants('c-cov', 'M4A1-S | Gamma', flat(50000)),
    ...variants('c-cov', 'M4A1-S | Gamma', flat(70000), 'stattrak'),
    ...variants('k-fade', '★ Karambit | Fade', { FN: [200000, 190000], MW: [180000, 170000] }),
    ...variants('k-fade', '★ Karambit | Fade', { FN: [260000, 250000], MW: [240000, 230000] }, 'stattrak'),
    // Phases share one set of market names, stored under a single skin id.
    ...variants('k-dop-2', '★ Karambit | Doppler', { FN: [150000, 140000], MW: [130000, 120000] }),
    ...variants('k-dop-2', '★ Karambit | Doppler', { FN: [190000, 180000], MW: [170000, 160000] }, 'stattrak'),
    ...variants('k-van', '★ Karambit', { Vanilla: [100000, 95000] }),
    ...variants('k-van', '★ Karambit', { Vanilla: [120000, 110000] }, 'stattrak'),
    ...variants('g-alpha', '★ Sport Gloves | Alpha', {
      FN: [300000, 290000],
      MW: [90000, 88000],
      FT: [40000, 39000],
      WW: [35000, 34000],
      BS: [30000, 29000],
    }),
    ...variants('g-gamma', '★ Sport Gloves | Gamma', flat(45000)),
  ];

  return {
    skins,
    collections: [
      { id: 'col-a', name: 'The Alpha Collection', image_url: null },
      { id: 'col-b', name: 'The Beta Collection', image_url: null },
      { id: 'col-c', name: 'The Gamma Collection', image_url: null },
    ],
    collectionSkins: [
      { collection_id: 'col-a', skin_id: 'a-con', rarity_id: CON },
      { collection_id: 'col-a', skin_id: 'a-in1', rarity_id: MIL },
      { collection_id: 'col-a', skin_id: 'a-in2', rarity_id: MIL },
      { collection_id: 'col-a', skin_id: 'a-in3', rarity_id: MIL },
      { collection_id: 'col-a', skin_id: 'a-out1', rarity_id: RES },
      { collection_id: 'col-a', skin_id: 'a-out2', rarity_id: RES },
      { collection_id: 'col-a', skin_id: 'a-cla', rarity_id: CLA },
      { collection_id: 'col-a', skin_id: 'a-cov', rarity_id: COV },
      { collection_id: 'col-b', skin_id: 'b-in1', rarity_id: MIL },
      { collection_id: 'col-b', skin_id: 'b-out1', rarity_id: RES },
      { collection_id: 'col-b', skin_id: 'b-out2', rarity_id: RES },
      { collection_id: 'col-b', skin_id: 'b-out3', rarity_id: RES },
      { collection_id: 'col-c', skin_id: 'c-cov', rarity_id: COV },
    ],
    crates: [
      { id: 'crate-a', name: 'Alpha Case', image_url: null },
      { id: 'crate-c', name: 'Gamma Glove Case', image_url: null },
    ],
    crateSkins: [
      { crate_id: 'crate-a', skin_id: 'a-in1', is_rare: false },
      { crate_id: 'crate-a', skin_id: 'a-cov', is_rare: false },
      { crate_id: 'crate-a', skin_id: 'k-fade', is_rare: true },
      { crate_id: 'crate-a', skin_id: 'k-dop-1', is_rare: true },
      { crate_id: 'crate-a', skin_id: 'k-dop-2', is_rare: true },
      { crate_id: 'crate-a', skin_id: 'k-dop-3', is_rare: true },
      { crate_id: 'crate-a', skin_id: 'k-van', is_rare: true },
      { crate_id: 'crate-a', skin_id: 'g-alpha', is_rare: true },
      { crate_id: 'crate-c', skin_id: 'c-cov', is_rare: false },
      { crate_id: 'crate-c', skin_id: 'g-gamma', is_rare: true },
    ],
    variants: variantRows,
  };
}

export function fixtureCatalog(mutate?: (rows: CatalogRows) => void) {
  const rows = fixtureRows();
  mutate?.(rows);
  return buildCatalog(rows);
}

// Change the quote of one variant in a set of rows.
export function setQuote(rows: CatalogRows, marketHashName: string, listing: number | null, sale: number | null): void {
  const row = rows.variants.find((variant) => variant.market_hash_name === marketHashName);
  if (!row) throw new Error(`fixture has no variant ${marketHashName}`);
  row.lowest_price_cents = listing;
  row.avg_last5_cents = sale;
}
