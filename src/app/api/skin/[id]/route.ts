import { NextRequest, NextResponse } from 'next/server';
import { getDb, initDb } from '@/lib/db';
import { getTradeupEligibility } from '@/lib/tradeup';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  initDb();
  const db = getDb();

  // Fetch skin metadata
  const skin = db.prepare('SELECT * FROM skins WHERE id = ?').get(id);

  if (!skin) {
    return NextResponse.json({ error: 'Skin not found' }, { status: 404 });
  }

  // Fetch all variants with prices
  const variants = db.prepare(`
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
    WHERE sv.skin_id = ?
    ORDER BY sv.is_souvenir, sv.is_stattrak, sv.wear_name
  `).all(id);

  // Fetch collections this skin belongs to
  const collections = db.prepare(`
    SELECT c.id, c.name, c.image_url
    FROM collections c
    JOIN collection_skins cs ON c.id = cs.collection_id
    WHERE cs.skin_id = ?
  `).all(id);

  // Fetch crates this skin is found in
  const crates = db.prepare(`
    SELECT cr.id, cr.name, cr.image_url, cs.is_rare
    FROM crates cr
    JOIN crate_skins cs ON cr.id = cs.crate_id
    WHERE cs.skin_id = ?
  `).all(id);

  // Get tradeup eligibility info
  const tradeup = getTradeupEligibility(id);

  return NextResponse.json({ skin, variants, collections, crates, tradeup });
}
