import sql from './db';

const PRICE_OVERVIEW_URL = 'https://steamcommunity.com/market/priceoverview/';
const MAX_REQUESTS_PER_MINUTE = 20;
const MIN_INTERVAL_MS = (60 / MAX_REQUESTS_PER_MINUTE) * 1000; // 3s between requests

let lastRequestTime = 0;

function parsePriceString(priceStr: string): number | null {
  // Handles "$13.07", "€12.50", "£10.00", etc.
  const cleaned = priceStr.replace(/[^0-9.,]/g, '').replace(',', '.');
  const value = parseFloat(cleaned);
  if (isNaN(value)) return null;
  return Math.round(value * 100); // Convert to cents
}

async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_INTERVAL_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

interface PriceOverviewResponse {
  success: boolean;
  lowest_price?: string;
  median_price?: string;
  volume?: string;
}

export async function refreshSinglePrice(marketHashName: string): Promise<{
  lowest_price_cents: number | null;
  median_price_cents: number | null;
  volume: number | null;
} | null> {
  await throttle();

  const params = new URLSearchParams({
    appid: '730',
    currency: '1', // USD
    market_hash_name: marketHashName,
  });

  const res = await fetch(`${PRICE_OVERVIEW_URL}?${params}`);

  if (res.status === 429) {
    console.warn(`Rate limited fetching price for ${marketHashName}`);
    return null;
  }

  if (!res.ok) {
    console.warn(`HTTP ${res.status} fetching price for ${marketHashName}`);
    return null;
  }

  const data = (await res.json()) as PriceOverviewResponse;

  if (!data.success) return null;

  const lowest = data.lowest_price ? parsePriceString(data.lowest_price) : null;
  const median = data.median_price ? parsePriceString(data.median_price) : null;
  const volume = data.volume ? parseInt(data.volume.replace(',', ''), 10) : null;

  // Upsert into database
  await sql`
    INSERT INTO prices (market_hash_name, lowest_price_cents, median_price_cents, volume, sell_listings, updated_at)
    VALUES (${marketHashName}, ${lowest}, ${median}, ${volume}, NULL, NOW())
    ON CONFLICT (market_hash_name) DO UPDATE SET
      lowest_price_cents = EXCLUDED.lowest_price_cents,
      median_price_cents = EXCLUDED.median_price_cents,
      volume = EXCLUDED.volume,
      updated_at = NOW()
  `;

  return { lowest_price_cents: lowest, median_price_cents: median, volume };
}

// Check if a price is stale (older than given hours)
export function isPriceStale(updatedAt: string | null, maxAgeHours: number = 6): boolean {
  if (!updatedAt) return true;
  const updated = new Date(updatedAt).getTime();
  const now = Date.now();
  return now - updated > maxAgeHours * 60 * 60 * 1000;
}
