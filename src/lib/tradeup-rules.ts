export const TRADEUP_EXCLUDED_COLLECTION_IDS = ['collection-set-xpshop-wpn-01'] as const;

export const TRADEUP_EXCLUDED_COLLECTION_REASON =
  'Skins from the Limited Edition Item collection are not eligible for tradeups';

export function isTradeupExcludedCollectionId(collectionId: string): boolean {
  return (TRADEUP_EXCLUDED_COLLECTION_IDS as readonly string[]).includes(collectionId);
}

export function hasTradeupExcludedCollection(collectionIds: Iterable<string>): boolean {
  for (const collectionId of collectionIds) {
    if (isTradeupExcludedCollectionId(collectionId)) {
      return true;
    }
  }
  return false;
}

// ── Knife / glove detection ─────────────────────────────────────────
// Rare special items are identified by weapon name because `skins.weapon_name` is
// available everywhere; `crate_skins.is_rare` is the authoritative flag when a crate
// row is at hand.

const KNIFE_OR_GLOVE_NAME_FRAGMENTS = [
  'knife', 'bayonet', 'karambit', 'gloves', 'wraps', 'daggers', 'navaja', 'stiletto',
  'talon', 'ursus', 'nomad', 'skeleton', 'paracord', 'survival', 'classic', 'kukri',
  'falchion', 'bowie', 'huntsman', 'butterfly', 'flip', 'gut', 'm9', 'shadow',
];

export function isKnifeOrGloveWeapon(weaponName: string): boolean {
  const lower = weaponName.toLowerCase();
  return KNIFE_OR_GLOVE_NAME_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

export function isGloveWeapon(weaponName: string): boolean {
  const lower = weaponName.toLowerCase();
  return lower.includes('gloves') || lower.includes('wraps');
}

export function isKnifeWeapon(weaponName: string): boolean {
  return isKnifeOrGloveWeapon(weaponName) && !isGloveWeapon(weaponName);
}
