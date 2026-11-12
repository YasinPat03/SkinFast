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

// Recognize full weapon names before their one-word aliases. Otherwise, for
// example, "desert eagle" becomes weapon=Desert Eagle, pattern=eagle.
const weaponAliases = new Map(Object.entries(WEAPON_ALIASES));
for (const weapons of Object.values(WEAPON_ALIASES)) {
  for (const weapon of weapons) weaponAliases.set(weapon.toLowerCase(), [weapon]);
}

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
export function parseSkinQuery(query: string): { weapons: string[] | null; patternWords: string[] } {
  const words = query.toLowerCase().replace(/[|★™]/g, ' ').split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return { weapons: null, patternWords: [] };

  // Try to find a weapon keyword in the query
  let weaponMatch: string[] | null = null;
  let weaponIndex = -1;

  // Check multi-word weapon names first (e.g. "desert eagle")
  for (let i = 0; i < words.length - 1; i++) {
    const twoWord = `${words[i]} ${words[i + 1]}`;
    const alias = weaponAliases.get(twoWord);
    if (alias) {
      weaponMatch = alias;
      // Remove both words
      const remaining = [...words];
      remaining.splice(i, 2);
      return { weapons: weaponMatch, patternWords: remaining };
    }
  }

  // Check single-word weapon aliases
  for (let i = 0; i < words.length; i++) {
    const alias = weaponAliases.get(words[i]);
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
