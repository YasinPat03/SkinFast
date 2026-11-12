import { NextRequest, NextResponse } from 'next/server';
import sql from '@/lib/db';

import { parseSkinQuery } from '@/lib/skin-search';

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q')?.trim();

  if (!q || q.length < 2) {
    return NextResponse.json([]);
  }

  const { weapons, patternWords } = parseSkinQuery(q);

  const conditions: string[] = [];
  const params: (string | string[])[] = [];
  let paramIdx = 1;

  // If a weapon was identified, filter by weapon_name
  if (weapons && weapons.length > 0) {
    if (weapons.length === 1) {
      conditions.push(`weapon_name ILIKE $${paramIdx}`);
      params.push(`%${weapons[0]}%`);
      paramIdx++;
    } else {
      // Multiple possible weapons (e.g. m4 → M4A4 or M4A1-S)
      const orClauses = weapons.map(() => {
        const clause = `weapon_name ILIKE $${paramIdx}`;
        paramIdx++;
        return clause;
      });
      conditions.push(`(${orClauses.join(' OR ')})`);
      weapons.forEach((w) => params.push(`%${w}%`));
    }
  }

  // Pattern words search against pattern_name (skin name part after the |)
  // If no weapon was found, also search against the full name for flexibility
  if (patternWords.length > 0) {
    for (const word of patternWords) {
      if (weapons) {
        // Weapon identified — search pattern_name only
        conditions.push(`pattern_name ILIKE $${paramIdx}`);
      } else {
        // No weapon — search the full name
        conditions.push(`name ILIKE $${paramIdx}`);
      }
      params.push(`%${word}%`);
      paramIdx++;
    }
  }

  if (conditions.length === 0) {
    return NextResponse.json([]);
  }

  const whereClause = conditions.join(' AND ');

  // Order by relevance: prefer exact pattern_name start matches, then alphabetical
  try {
    const results = await sql.unsafe(
      `SELECT id, name, weapon_name, pattern_name, rarity_id, rarity_name, image_url
       FROM skins
       WHERE ${whereClause}
       ORDER BY
         CASE WHEN pattern_name ILIKE $${paramIdx} THEN 0 ELSE 1 END,
         name ASC
       LIMIT 20`,
      [...params, patternWords.length > 0 ? `${patternWords[0]}%` : '%']
    );

    return NextResponse.json(results);
  } catch (error) {
    console.error('[search] Database query failed', error);
    return NextResponse.json(
      { error: 'Search is temporarily unavailable. Please try again.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
