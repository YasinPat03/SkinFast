// Reads and writes of market data (`prices`, `last_sold_avg`).
//
// Column meanings:
//   prices.lowest_price_cents  lowest active Steam listing in USD cents;
//                              NULL = confirmed to have no active listing
//   prices.sell_listings       number of active listings
//   prices.updated_at          when the two columns above were last confirmed
//   last_sold_avg.avg_last5_cents  average of the last 5 Steam sales, USD cents
//   last_sold_avg.sample_count     sales in that average; 0 = Steam has no sale
//                                  on record; NULL = never successfully read
//   last_sold_avg.updated_at       last successful read of the sale history
//
// Only variants present in `skin_variants` are ever written.

import sql from '../db';

export interface ListingQuote {
  marketHashName: string;
  priceCents: number;
  // Number of active listings; null when the source only says "at least one".
  listings: number | null;
}

async function trackedNames(names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const rows = await sql<{ market_hash_name: string }[]>`
    SELECT market_hash_name FROM skin_variants WHERE market_hash_name = ANY(${names})
  `;
  return new Set(rows.map((row) => row.market_hash_name));
}

// Store active listings. Names the catalog does not know (items of other types,
// or skins newer than the last metadata import) are returned, not written.
export async function saveListings(quotes: ListingQuote[]): Promise<{ written: string[]; unknown: string[] }> {
  // A multi-row upsert cannot touch the same key twice, and a paginated fetch
  // can see one item on two pages when listings shift in between.
  const byName = new Map<string, ListingQuote>();
  for (const quote of quotes) {
    if (quote.marketHashName && quote.priceCents > 0) byName.set(quote.marketHashName, quote);
  }
  const tracked = await trackedNames([...byName.keys()]);

  const rows = [...byName.values()]
    .filter((quote) => tracked.has(quote.marketHashName))
    .map((quote) => ({
      market_hash_name: quote.marketHashName,
      lowest_price_cents: Math.round(quote.priceCents),
      sell_listings: quote.listings,
    }));

  if (rows.length > 0) {
    await sql`
      INSERT INTO prices ${sql(rows, 'market_hash_name', 'lowest_price_cents', 'sell_listings')}
      ON CONFLICT (market_hash_name) DO UPDATE SET
        lowest_price_cents = EXCLUDED.lowest_price_cents,
        sell_listings = COALESCE(EXCLUDED.sell_listings, GREATEST(COALESCE(prices.sell_listings, 0), 1)),
        updated_at = NOW()
    `;
  }

  return {
    written: rows.map((row) => row.market_hash_name),
    unknown: [...byName.keys()].filter((name) => !tracked.has(name)),
  };
}

// Record that these variants currently have no active listing.
export async function markUnlisted(names: string[]): Promise<string[]> {
  const tracked = await trackedNames([...new Set(names)]);
  const rows = [...tracked].map((market_hash_name) => ({
    market_hash_name,
    lowest_price_cents: null,
    sell_listings: 0,
  }));
  if (rows.length === 0) return [];
  await sql`
    INSERT INTO prices ${sql(rows, 'market_hash_name', 'lowest_price_cents', 'sell_listings')}
    ON CONFLICT (market_hash_name) DO UPDATE SET
      lowest_price_cents = NULL,
      sell_listings = 0,
      updated_at = NOW()
  `;
  return rows.map((row) => row.market_hash_name);
}

export async function countListedVariants(): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM prices p
    WHERE p.lowest_price_cents IS NOT NULL
      AND EXISTS (SELECT 1 FROM skin_variants sv WHERE sv.market_hash_name = p.market_hash_name)
  `;
  return row.count;
}

// Tracked variants still marked as listed whose listing was last confirmed
// before `cutoff`.
export async function countListingsNotSeenSince(cutoff: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM prices p
    WHERE p.lowest_price_cents IS NOT NULL
      AND p.updated_at < ${cutoff}
      AND EXISTS (SELECT 1 FROM skin_variants sv WHERE sv.market_hash_name = p.market_hash_name)
  `;
  return row.count;
}

export async function clearListingsNotSeenSince(cutoff: string): Promise<number> {
  const rows = await sql`
    UPDATE prices p
    SET lowest_price_cents = NULL, sell_listings = 0, updated_at = NOW()
    WHERE p.lowest_price_cents IS NOT NULL
      AND p.updated_at < ${cutoff}
      AND EXISTS (SELECT 1 FROM skin_variants sv WHERE sv.market_hash_name = p.market_hash_name)
    RETURNING p.market_hash_name
  `;
  return rows.length;
}

export interface SaleQuote {
  marketHashName: string;
  // Null together with sampleCount 0 means "Steam has no sale on record".
  avgCents: number | null;
  sampleCount: number;
  lastSaleAt: string | null;
}

export async function saveSales(quotes: SaleQuote[]): Promise<string[]> {
  const byName = new Map<string, SaleQuote>();
  for (const quote of quotes) byName.set(quote.marketHashName, quote);
  const tracked = await trackedNames([...byName.keys()]);

  const rows = [...byName.values()]
    .filter((quote) => tracked.has(quote.marketHashName))
    .map((quote) => ({
      market_hash_name: quote.marketHashName,
      avg_last5_cents: quote.avgCents,
      sample_count: quote.sampleCount,
      last_sale_at: quote.lastSaleAt,
    }));
  if (rows.length === 0) return [];

  await sql`
    INSERT INTO last_sold_avg ${sql(rows, 'market_hash_name', 'avg_last5_cents', 'sample_count', 'last_sale_at')}
    ON CONFLICT (market_hash_name) DO UPDATE SET
      avg_last5_cents = EXCLUDED.avg_last5_cents,
      sample_count = EXCLUDED.sample_count,
      last_sale_at = EXCLUDED.last_sale_at,
      updated_at = NOW()
  `;
  return rows.map((row) => row.market_hash_name);
}

export async function loadListingPrices(names: string[]): Promise<Map<string, number>> {
  if (names.length === 0) return new Map();
  const rows = await sql<{ market_hash_name: string; lowest_price_cents: number }[]>`
    SELECT market_hash_name, lowest_price_cents FROM prices
    WHERE market_hash_name = ANY(${names}) AND lowest_price_cents > 0
  `;
  return new Map(rows.map((row) => [row.market_hash_name, row.lowest_price_cents]));
}

// ── Items ───────────────────────────────────────────────────────────

export interface MarketVariant {
  marketHashName: string;
  isStatTrak: boolean;
  isSouvenir: boolean;
  listed: boolean;
  // Null when the sale history has never been read successfully.
  salesCheckedAt: Date | null;
}

// A skin as the market sees it: finish phases share one name and one set of
// market listings, so every skin id with that name is part of the same item.
export interface MarketItem {
  name: string;
  weaponName: string;
  patternName: string;
  skinIds: string[];
  variants: MarketVariant[];
}

interface MarketVariantRow {
  market_hash_name: string;
  is_stattrak: boolean;
  is_souvenir: boolean;
  lowest_price_cents: number | null;
  sample_count: number | null;
  sales_updated_at: Date | null;
}

function toMarketVariant(row: MarketVariantRow): MarketVariant {
  return {
    marketHashName: row.market_hash_name,
    isStatTrak: row.is_stattrak,
    isSouvenir: row.is_souvenir,
    listed: row.lowest_price_cents != null && row.lowest_price_cents > 0,
    salesCheckedAt: row.sample_count != null ? row.sales_updated_at : null,
  };
}

async function loadVariantsByName(skinName: string): Promise<MarketVariant[]> {
  const rows = await sql<MarketVariantRow[]>`
    SELECT sv.market_hash_name, sv.is_stattrak, sv.is_souvenir, p.lowest_price_cents,
           l.sample_count, l.updated_at AS sales_updated_at
    FROM skin_variants sv
    JOIN skins s ON s.id = sv.skin_id
    LEFT JOIN prices p ON p.market_hash_name = sv.market_hash_name
    LEFT JOIN last_sold_avg l ON l.market_hash_name = sv.market_hash_name
    WHERE s.name = ${skinName}
    ORDER BY sv.market_hash_name
  `;
  return rows.map(toMarketVariant);
}

export async function loadMarketItem(skinId: string): Promise<MarketItem | null> {
  const skins = await sql<{ name: string; weapon_name: string; pattern_name: string }[]>`
    SELECT name, weapon_name, pattern_name FROM skins WHERE id = ${skinId}
  `;
  const skin = skins[0];
  if (!skin) return null;
  return loadMarketItemByName(skin.name);
}

export async function loadMarketItemByName(skinName: string): Promise<MarketItem | null> {
  const skins = await sql<{ id: string; name: string; weapon_name: string; pattern_name: string }[]>`
    SELECT id, name, weapon_name, pattern_name FROM skins WHERE name = ${skinName} ORDER BY id
  `;
  if (skins.length === 0) return null;
  return {
    name: skins[0].name,
    weaponName: skins[0].weapon_name,
    patternName: skins[0].pattern_name,
    skinIds: skins.map((skin) => skin.id),
    variants: await loadVariantsByName(skinName),
  };
}

// The variant to request Steam's listing page through. Only a listed variant
// redirects to the group page that carries every variant's data.
export function pickGroupEntryVariant(item: MarketItem): MarketVariant | null {
  const listed = item.variants.filter((variant) => variant.listed);
  return (
    listed.find((variant) => !variant.isSouvenir && !variant.isStatTrak) ??
    listed.find((variant) => !variant.isSouvenir) ??
    listed[0] ??
    null
  );
}

// Item names ordered by how badly their sale history needs a refresh: never
// read first, then oldest. `olderThanHours` skips anything read more recently.
// Items with no listed variant are left out: Steam serves their sale history
// only through a listed variant, so there is nothing to fetch until one lists.
export async function nextItemsForSales(options: {
  limit: number;
  olderThanHours: number;
  exclude: string[];
}): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    SELECT s.name
    FROM skins s
    JOIN skin_variants sv ON sv.skin_id = s.id
    LEFT JOIN prices p ON p.market_hash_name = sv.market_hash_name
    LEFT JOIN last_sold_avg l ON l.market_hash_name = sv.market_hash_name
    WHERE NOT (s.name = ANY(${options.exclude}::text[]))
    GROUP BY s.name
    HAVING bool_or(p.lowest_price_cents > 0)
       AND (bool_or(l.sample_count IS NULL)
            OR MIN(l.updated_at) < NOW() - (${options.olderThanHours} || ' hours')::INTERVAL)
    ORDER BY bool_or(l.sample_count IS NULL) DESC, MIN(l.updated_at) ASC NULLS FIRST, s.name
    LIMIT ${options.limit}
  `;
  return rows.map((row) => row.name);
}

// A skin whose listings are good for reading Steam's exchange rate off: several
// variants priced high enough that cent rounding does not matter, and with
// enough listings that the lowest one rarely changes between two readings.
export async function pickCalibrationItem(): Promise<string | null> {
  const rows = await sql<{ name: string }[]>`
    SELECT s.name
    FROM skins s
    JOIN skin_variants sv ON sv.skin_id = s.id
    JOIN prices p ON p.market_hash_name = sv.market_hash_name
    WHERE p.lowest_price_cents BETWEEN 2000 AND 100000 AND p.sell_listings >= 20
    GROUP BY s.name
    HAVING COUNT(*) >= 4
    ORDER BY COUNT(*) DESC, SUM(p.sell_listings) DESC
    LIMIT 1
  `;
  return rows[0]?.name ?? null;
}
