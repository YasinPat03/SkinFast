import { NextRequest, NextResponse } from 'next/server';
import sql from '@/lib/db';
import { getTradeupEligibility } from '@/lib/tradeup';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Fetch skin metadata
  const skinRows = await sql`SELECT * FROM skins WHERE id = ${id}`;
  const skin = skinRows[0];

  if (!skin) {
    return NextResponse.json({ error: 'Skin not found' }, { status: 404 });
  }

  // Fetch all variants with prices
  const variants = await sql`
    SELECT
      sv.id,
      sv.skin_id,
      sv.market_hash_name,
      sv.wear_name,
      sv.is_stattrak,
      sv.is_souvenir,
      p.lowest_price_cents,
      p.median_price_cents,
      p.volume,
      p.sell_listings,
      p.updated_at
    FROM skin_variants sv
    LEFT JOIN prices p ON sv.market_hash_name = p.market_hash_name
    WHERE sv.skin_id = ${id}
    ORDER BY sv.is_souvenir, sv.is_stattrak, sv.wear_name
  `;

  // Fetch collections this skin belongs to
  const collections = await sql`
    SELECT c.id, c.name, c.image_url
    FROM collections c
    JOIN collection_skins cs ON c.id = cs.collection_id
    WHERE cs.skin_id = ${id}
  `;

  // Fetch crates this skin is found in
  const crates = await sql`
    SELECT cr.id, cr.name, cr.image_url, cs.is_rare
    FROM crates cr
    JOIN crate_skins cs ON cr.id = cs.crate_id
    WHERE cs.skin_id = ${id}
  `;

  // Get tradeup eligibility info
  const tradeup = await getTradeupEligibility(id);

  return NextResponse.json({ skin, variants, collections, crates, tradeup });
}
