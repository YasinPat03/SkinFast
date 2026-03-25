import { NextRequest, NextResponse } from 'next/server';
import { getDb, initDb } from '@/lib/db';

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q')?.trim();

  if (!q || q.length < 2) {
    return NextResponse.json([]);
  }

  initDb();
  const db = getDb();

  const results = db.prepare(`
    SELECT id, name, weapon_name, pattern_name, rarity_id, rarity_name, image_url
    FROM skins
    WHERE name LIKE ?
    ORDER BY name ASC
    LIMIT 20
  `).all(`%${q}%`);

  return NextResponse.json(results);
}
