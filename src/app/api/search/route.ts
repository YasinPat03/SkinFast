import { NextRequest, NextResponse } from 'next/server';
import sql from '@/lib/db';

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q')?.trim();

  if (!q || q.length < 2) {
    return NextResponse.json([]);
  }

  // Split query into individual words so "ak redline" matches "AK-47 | Redline"
  const words = q.split(/\s+/).filter((w) => w.length > 0);

  if (words.length === 0) {
    return NextResponse.json([]);
  }

  // Build a WHERE clause that requires every word to appear somewhere in the name
  // Each word is wrapped in %...% for substring matching
  const conditions = words.map(
    (_, i) => `name ILIKE $${i + 1}`
  ).join(' AND ');

  const params = words.map((w) => `%${w}%`);

  const results = await sql.unsafe(
    `SELECT id, name, weapon_name, pattern_name, rarity_id, rarity_name, image_url
     FROM skins
     WHERE ${conditions}
     ORDER BY name ASC
     LIMIT 20`,
    params
  );

  return NextResponse.json(results);
}
