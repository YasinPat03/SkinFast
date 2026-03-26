import { NextRequest, NextResponse } from 'next/server';
import sql from '@/lib/db';

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q')?.trim();

  if (!q || q.length < 2) {
    return NextResponse.json([]);
  }

  const results = await sql`
    SELECT id, name, weapon_name, pattern_name, rarity_id, rarity_name, image_url
    FROM skins
    WHERE name ILIKE ${'%' + q + '%'}
    ORDER BY name ASC
    LIMIT 20
  `;

  return NextResponse.json(results);
}
