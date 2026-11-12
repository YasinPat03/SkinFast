// Steam Community Market search (`search/render`): the source of listing
// prices. Works without a login and answers in USD from any country.
//
// Verified behaviour (2026-11):
//  - `pagesize` is fixed at 10 whatever `count` asks for.
//  - Only items with at least one active listing appear.
//  - `query` must not contain '|', '★' or '™' (they return zero results), and
//    matching is loose, so callers must match results by exact market name.
//  - `category_730_Type[]` narrows the listing to item types; with the weapon,
//    knife and glove types below the catalogue shrinks from ~35.5k to ~15.8k
//    entries, which is every item this site tracks and nothing else.

import { SteamFormatError, steamText } from './http';

const SEARCH_URL = 'https://steamcommunity.com/market/search/render/';

export const TRACKED_TYPE_TAGS = [
  'tag_CSGO_Type_Pistol',
  'tag_CSGO_Type_SMG',
  'tag_CSGO_Type_Rifle',
  'tag_CSGO_Type_SniperRifle',
  'tag_CSGO_Type_Shotgun',
  'tag_CSGO_Type_Machinegun',
  'tag_CSGO_Type_Equipment',
  'tag_CSGO_Type_Knife',
  'tag_Type_Hands',
] as const;

export interface SearchItem {
  marketHashName: string;
  // Lowest active listing in USD cents; always > 0 for a listed item.
  sellPriceCents: number;
  sellListings: number;
}

export interface SearchPage {
  start: number;
  totalCount: number;
  // How many results Steam returned on this page; pagination advances by this.
  resultCount: number;
  // The results that are active listings (a price above zero).
  items: SearchItem[];
}

// "★ Karambit | Doppler" -> "Karambit Doppler"; unpainted "★ Navaja Knife" -> "Navaja Knife".
export function buildSearchQuery(weaponName: string, patternName: string | null | undefined): string {
  return [weaponName, patternName]
    .filter((part): part is string => !!part && part.trim() !== '')
    .join(' ')
    .replace(/[|★™]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// "$1,629.61" or "$12.33 USD". Anything else means Steam answered in another
// currency, and the numbers must not be stored as US cents.
const USD_TEXT = /^\$\s?[\d,]+(\.\d{2})?(\s?USD)?$/;

export function parseSearchResponse(body: unknown): SearchPage {
  if (!body || typeof body !== 'object') throw new SteamFormatError('Search response is not an object');
  const data = body as Record<string, unknown>;
  if (data.success !== true) throw new SteamFormatError('Search response has success=false');
  if (typeof data.total_count !== 'number' || !Array.isArray(data.results)) {
    throw new SteamFormatError('Search response is missing total_count or results');
  }

  const items: SearchItem[] = [];
  for (const raw of data.results as Record<string, unknown>[]) {
    const marketHashName = raw?.hash_name;
    const sellPriceCents = raw?.sell_price;
    if (typeof marketHashName !== 'string' || typeof sellPriceCents !== 'number') {
      throw new SteamFormatError('Search result is missing hash_name or sell_price');
    }
    const priceText = raw.sell_price_text;
    if (typeof priceText === 'string' && priceText !== '' && !USD_TEXT.test(priceText.trim())) {
      throw new SteamFormatError(`Search prices are not in USD (got "${priceText}")`);
    }
    // A result with no price is not an active listing.
    if (sellPriceCents <= 0) continue;
    items.push({
      marketHashName,
      sellPriceCents: Math.round(sellPriceCents),
      sellListings: typeof raw.sell_listings === 'number' ? raw.sell_listings : 0,
    });
  }

  return {
    start: typeof data.start === 'number' ? data.start : 0,
    totalCount: data.total_count,
    resultCount: data.results.length,
    items,
  };
}

export interface SearchRequest {
  start: number;
  query?: string;
  typeTags?: readonly string[];
}

export function searchUrl({ start, query, typeTags }: SearchRequest): string {
  const params = new URLSearchParams({
    appid: '730',
    norender: '1',
    start: String(start),
    count: '100',
    sort_column: 'name',
    sort_dir: 'asc',
  });
  if (query) params.set('query', query);
  for (const tag of typeTags ?? []) params.append('category_730_Type[]', tag);
  return `${SEARCH_URL}?${params}`;
}

export async function fetchSearchPage(request: SearchRequest): Promise<SearchPage> {
  const { text } = await steamText(searchUrl(request), { accept: 'json', timeoutMs: 20_000 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new SteamFormatError('Search response is not JSON');
  }
  return parseSearchResponse(body);
}
