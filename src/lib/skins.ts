// Read model for a skin's own page and API route.

import sql from './db';

export interface SkinRecord {
  id: string;
  name: string;
  weapon_name: string;
  pattern_name: string;
  rarity_id: string;
  rarity_name: string;
  min_float: number;
  max_float: number;
  has_stattrak: boolean;
  has_souvenir: boolean;
  image_url: string | null;
}

export interface SkinVariantQuote {
  market_hash_name: string;
  wear_name: string;
  is_stattrak: boolean;
  is_souvenir: boolean;
  // Lowest active Steam listing (USD cents); null when nothing is listed.
  lowest_price_cents: number | null;
  sell_listings: number | null;
  // When the listing state was last confirmed.
  updated_at: Date | null;
  // Average of the last 5 Steam sales (USD cents); null when unknown.
  last_sold_avg_cents: number | null;
  // Sales in that average; 0 = none on record; null = never read.
  last_sold_sample_count: number | null;
  last_sale_at: string | null;
  last_sold_updated_at: Date | null;
}

export interface NamedEntity {
  id: string;
  name: string;
  image_url: string | null;
}

export interface SkinDetail {
  skin: SkinRecord;
  variants: SkinVariantQuote[];
  collections: NamedEntity[];
  crates: (NamedEntity & { is_rare: boolean })[];
}

export async function loadSkinDetail(id: string): Promise<SkinDetail | null> {
  const skins = await sql<SkinRecord[]>`
    SELECT id, name, weapon_name, pattern_name, rarity_id, rarity_name, min_float, max_float,
           has_stattrak, has_souvenir, image_url
    FROM skins WHERE id = ${id}
  `;
  const skin = skins[0];
  if (!skin) return null;

  const [variants, collections, crates] = await Promise.all([
    // Finish phases (Doppler etc.) are separate skins sharing one name and one
    // set of market listings, which the metadata stores under a single phase.
    // Matching on the name gives every phase's page the same price table.
    sql<SkinVariantQuote[]>`
      SELECT sv.market_hash_name, sv.wear_name, sv.is_stattrak, sv.is_souvenir,
             CASE WHEN p.lowest_price_cents > 0 THEN p.lowest_price_cents END AS lowest_price_cents,
             p.sell_listings, p.updated_at,
             CASE WHEN l.avg_last5_cents > 0 THEN l.avg_last5_cents END AS last_sold_avg_cents,
             l.sample_count AS last_sold_sample_count, l.last_sale_at,
             l.updated_at AS last_sold_updated_at
      FROM skin_variants sv
      JOIN skins s ON s.id = sv.skin_id
      LEFT JOIN prices p ON p.market_hash_name = sv.market_hash_name
      LEFT JOIN last_sold_avg l ON l.market_hash_name = sv.market_hash_name
      WHERE s.name = ${skin.name}
      ORDER BY sv.is_souvenir, sv.is_stattrak, sv.market_hash_name
    `,
    sql<NamedEntity[]>`
      SELECT c.id, c.name, c.image_url
      FROM collections c
      JOIN collection_skins cs ON c.id = cs.collection_id
      WHERE cs.skin_id = ${id}
      ORDER BY c.name
    `,
    sql<(NamedEntity & { is_rare: boolean })[]>`
      SELECT cr.id, cr.name, cr.image_url, cs.is_rare
      FROM crates cr
      JOIN crate_skins cs ON cr.id = cs.crate_id
      WHERE cs.skin_id = ${id}
      ORDER BY cr.name
    `,
  ]);

  return { skin: { ...skin, min_float: Number(skin.min_float), max_float: Number(skin.max_float) }, variants, collections, crates };
}
