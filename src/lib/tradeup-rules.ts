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

// ── Souvenir inputs ─────────────────────────────────────────────────
// Since the May 22, 2026 update, Souvenir items are valid trade-up inputs alongside normal
// items. Souvenir attributes are stripped and the result is always a normal item, so souvenir
// variants only ever appear on the input side. StatTrak contracts are still all-or-nothing and
// souvenir items are never StatTrak, so they cannot enter a StatTrak contract.

export function souvenirInputsAllowed(isStatTrak: boolean): boolean {
  return !isStatTrak;
}

// ── Gold outcome pools ──────────────────────────────────────────────
// Doppler / Gamma Doppler phases are separate paint kits (and separate skin ids in the item
// metadata) but a single entry in a case's rare special item pool: the contract rolls
// "knife + finish" and the phase is a sub-roll. Phase rows therefore have to be merged into
// one outcome when computing gold-tradeup probabilities, otherwise a 7-phase Doppler would
// be weighted 7x against every other finish.

export function goldOutcomeKey(crateId: string, skinName: string): string {
  return `${crateId}|${skinName}`;
}

export function groupRows<T>(rows: T[], key: (row: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const groupKey = key(row);
    const group = groups.get(groupKey);
    if (group) {
      group.push(row);
    } else {
      groups.set(groupKey, [row]);
    }
  }
  return [...groups.values()];
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
