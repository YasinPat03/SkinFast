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
