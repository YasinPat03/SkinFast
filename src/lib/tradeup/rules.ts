// The trade-up contract rules, in one place. Everything else in src/lib/tradeup
// derives from these; nothing here touches the database or the network.
//
// Sources: Valve's release notes for 2025-10-22 (5 Covert -> knife/gloves,
// normalized float formula) and 2026-05-21 (souvenir items accepted as inputs).

export const RARITY_LADDER = [
  'rarity_common_weapon', // Consumer Grade
  'rarity_uncommon_weapon', // Industrial Grade
  'rarity_rare_weapon', // Mil-Spec Grade
  'rarity_mythical_weapon', // Restricted
  'rarity_legendary_weapon', // Classified
  'rarity_ancient_weapon', // Covert
] as const;

export const COVERT_RARITY_ID = 'rarity_ancient_weapon';

export const RARITY_NAMES: Record<string, string> = {
  rarity_common_weapon: 'Consumer Grade',
  rarity_uncommon_weapon: 'Industrial Grade',
  rarity_rare_weapon: 'Mil-Spec Grade',
  rarity_mythical_weapon: 'Restricted',
  rarity_legendary_weapon: 'Classified',
  rarity_ancient_weapon: 'Covert',
};

export function rarityBelow(rarityId: string): string | null {
  const index = RARITY_LADDER.indexOf(rarityId as (typeof RARITY_LADDER)[number]);
  return index > 0 ? RARITY_LADDER[index - 1] : null;
}

export function rarityAbove(rarityId: string): string | null {
  const index = RARITY_LADDER.indexOf(rarityId as (typeof RARITY_LADDER)[number]);
  return index >= 0 && index < RARITY_LADDER.length - 1 ? RARITY_LADDER[index + 1] : null;
}

// A standard contract takes 10 skins of one rarity and returns one skin of the
// next rarity. A gold contract takes 5 Covert skins and returns a knife or gloves.
export type ContractKind = 'standard' | 'gold';

export const CONTRACT_SIZE: Record<ContractKind, number> = { standard: 10, gold: 5 };

export type ItemKind = 'weapon' | 'knife' | 'glove';

// Knives and gloves carry a star in their name on Steam and in the item
// metadata; that is the one marker present everywhere, so use it rather than a
// list of weapon names that has to be kept up to date.
export function itemKindOf(skinName: string, weaponName: string): ItemKind {
  if (!skinName.startsWith('★')) return 'weapon';
  const weapon = weaponName.toLowerCase();
  return weapon.includes('gloves') || weapon.includes('wraps') ? 'glove' : 'knife';
}

// Items from this "collection" (the Armory's limited edition item) cannot enter
// or come out of a contract.
export const EXCLUDED_COLLECTION_IDS: readonly string[] = ['collection-set-xpshop-wpn-01'];

export const EXCLUDED_COLLECTION_REASON =
  'Skins from the Limited Edition Item collection are not eligible for tradeups';

export function isExcludedCollection(collectionId: string): boolean {
  return EXCLUDED_COLLECTION_IDS.includes(collectionId);
}

// StatTrak contracts are all-or-nothing. Souvenir items can be mixed with
// normal items (their souvenir attributes are stripped and the result is always
// a normal item), but a souvenir is never StatTrak, so it cannot enter a
// StatTrak contract.
export function souvenirInputsAllowed(statTrak: boolean): boolean {
  return !statTrak;
}

// A StatTrak gold contract can only produce a StatTrak knife: gloves have no
// StatTrak version, so they drop out of the pool.
export function goldOutcomeAllowed(kind: ItemKind, statTrak: boolean): boolean {
  if (kind === 'weapon') return false;
  return statTrak ? kind === 'knife' : true;
}
