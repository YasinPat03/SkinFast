import { NextRequest, NextResponse } from 'next/server';
import sql from '@/lib/db';

// Map common shorthand/aliases to actual weapon_name values in the DB
const WEAPON_ALIASES: Record<string, string[]> = {
  'ak': ['AK-47'],
  'ak47': ['AK-47'],
  'ak-47': ['AK-47'],
  'awp': ['AWP'],
  'm4': ['M4A4', 'M4A1-S'],
  'm4a4': ['M4A4'],
  'm4a1': ['M4A1-S'],
  'm4a1-s': ['M4A1-S'],
  'deag': ['Desert Eagle'],
  'deagle': ['Desert Eagle'],
  'desert': ['Desert Eagle'],
  'usp': ['USP-S'],
  'usp-s': ['USP-S'],
  'glock': ['Glock-18'],
  'p250': ['P250'],
  'five-seven': ['Five-SeveN'],
  'fiveseven': ['Five-SeveN'],
  '57': ['Five-SeveN'],
  'cz': ['CZ75-Auto'],
  'cz75': ['CZ75-Auto'],
  'tec': ['Tec-9'],
  'tec9': ['Tec-9'],
  'tec-9': ['Tec-9'],
  'mac': ['MAC-10'],
  'mac10': ['MAC-10'],
  'mac-10': ['MAC-10'],
  'mp9': ['MP9'],
  'mp7': ['MP7'],
  'mp5': ['MP5-SD'],
  'mp5-sd': ['MP5-SD'],
  'ump': ['UMP-45'],
  'ump45': ['UMP-45'],
  'ump-45': ['UMP-45'],
  'p90': ['P90'],
  'pp': ['PP-Bizon'],
  'bizon': ['PP-Bizon'],
  'famas': ['FAMAS'],
  'galil': ['Galil AR'],
  'aug': ['AUG'],
  'sg': ['SG 553'],
  'sg553': ['SG 553'],
  'ssg': ['SSG 08'],
  'ssg08': ['SSG 08'],
  'scout': ['SSG 08'],
  'scar': ['SCAR-20'],
  'scar20': ['SCAR-20'],
  'scar-20': ['SCAR-20'],
  'g3': ['G3SG1'],
  'g3sg1': ['G3SG1'],
  'nova': ['Nova'],
  'xm': ['XM1014'],
  'xm1014': ['XM1014'],
  'mag7': ['MAG-7'],
  'mag-7': ['MAG-7'],
  'sawedoff': ['Sawed-Off'],
  'sawed': ['Sawed-Off'],
  'sawed-off': ['Sawed-Off'],
  'negev': ['Negev'],
  'm249': ['M249'],
  'p2000': ['P2000'],
  'r8': ['R8 Revolver'],
  'revolver': ['R8 Revolver'],
  'dualies': ['Dual Berettas'],
  'dual': ['Dual Berettas'],
  'berettas': ['Dual Berettas'],
  'knife': ['Knife'],
  'karambit': ['Karambit'],
  'butterfly': ['Butterfly Knife'],
  'bayo': ['Bayonet'],
  'bayonet': ['Bayonet'],
  'flip': ['Flip Knife'],
  'gut': ['Gut Knife'],
  'falchion': ['Falchion Knife'],
  'shadow': ['Shadow Daggers'],
  'daggers': ['Shadow Daggers'],
  'huntsman': ['Huntsman Knife'],
  'bowie': ['Bowie Knife'],
  'navaja': ['Navaja Knife'],
  'stiletto': ['Stiletto Knife'],
  'talon': ['Talon Knife'],
  'ursus': ['Ursus Knife'],
  'classic': ['Classic Knife'],
  'nomad': ['Nomad Knife'],
  'skeleton': ['Skeleton Knife'],
  'survival': ['Survival Knife'],
  'paracord': ['Paracord Knife'],
  'kukri': ['Kukri Knife'],
  'gloves': ['Gloves'],
  'glove': ['Gloves'],
};

/**
 * Parse a search query into weapon filter + pattern search terms.
 * Tries to identify weapon keywords and separates them from pattern words.
 *
 * Examples:
 *   "ak" → weapon: AK-47, pattern: []
 *   "redline ak" → weapon: AK-47, pattern: ["redline"]
 *   "red awp" → weapon: AWP, pattern: ["red"]
 *   "asiimov" → weapon: null, pattern: ["asiimov"]
 */
function parseQuery(query: string): { weapons: string[] | null; patternWords: string[] } {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return { weapons: null, patternWords: [] };

  // Try to find a weapon keyword in the query
  let weaponMatch: string[] | null = null;
  let weaponIndex = -1;

  // Check multi-word weapon names first (e.g. "desert eagle")
  for (let i = 0; i < words.length - 1; i++) {
    const twoWord = `${words[i]} ${words[i + 1]}`;
    if (WEAPON_ALIASES[twoWord]) {
      weaponMatch = WEAPON_ALIASES[twoWord];
      // Remove both words
      const remaining = [...words];
      remaining.splice(i, 2);
      return { weapons: weaponMatch, patternWords: remaining };
    }
  }

  // Check single-word weapon aliases
  for (let i = 0; i < words.length; i++) {
    const alias = WEAPON_ALIASES[words[i]];
    if (alias) {
      weaponMatch = alias;
      weaponIndex = i;
      break;
    }
  }

  if (weaponMatch !== null && weaponIndex !== -1) {
    const patternWords = words.filter((_, i) => i !== weaponIndex);
    return { weapons: weaponMatch, patternWords };
  }

  // No weapon keyword found — all words are pattern/name search terms
  return { weapons: null, patternWords: words };
}

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q')?.trim();

  if (!q || q.length < 2) {
    return NextResponse.json([]);
  }

  const { weapons, patternWords } = parseQuery(q);

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
}
