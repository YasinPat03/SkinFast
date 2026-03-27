import sql from './db';

const PRICE_OVERVIEW_URL = 'https://steamcommunity.com/market/priceoverview/';
const MARKET_LISTING_URL = 'https://steamcommunity.com/market/listings/730/';
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

type PriceHistoryEntry = [string, number, string];

function parseLatestSaleFromHistoryHtml(html: string): number | null {
  const match = html.match(/var line1=(\[[\s\S]*?\]);/);
  if (!match) return null;

  try {
    const history = JSON.parse(match[1]) as PriceHistoryEntry[];
    const latest = history[history.length - 1];
    if (!latest || typeof latest[1] !== 'number' || !Number.isFinite(latest[1])) {
      return null;
    }
    return Math.round(latest[1] * 100);
  } catch {
    return null;
  }
}

async function fetchLatestSaleFromListingPage(marketHashName: string): Promise<number | null> {
  const encodedName = encodeURIComponent(marketHashName);
  const res = await fetch(`${MARKET_LISTING_URL}${encodedName}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!res.ok) {
    console.warn(`HTTP ${res.status} fetching listing page for ${marketHashName}`);
    return null;
  }

  const html = await res.text();
  return parseLatestSaleFromHistoryHtml(html);
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

  const res = await fetch(`${PRICE_OVERVIEW_URL}?${params}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (res.status === 429) {
    console.warn(`Rate limited fetching price for ${marketHashName}`);
    return null;
  }

  if (!res.ok) {
    console.warn(`HTTP ${res.status} fetching price for ${marketHashName}`);
    return null;
  }

  const text = await res.text();
  let data: PriceOverviewResponse;
  try {
    data = JSON.parse(text);
  } catch {
    console.warn(`Invalid JSON for ${marketHashName}: ${text.slice(0, 200)}`);
    return null;
  }

  if (!data.success) {
    console.warn(`Steam returned success=false for ${marketHashName}`);
    return null;
  }

  const lowest = data.lowest_price ? parsePriceString(data.lowest_price) : null;
  let median = data.median_price ? parsePriceString(data.median_price) : null;
  const volume = data.volume ? parseInt(data.volume.replace(',', ''), 10) : null;

  // Some rare/unlisted items return success=true with no price fields from priceoverview,
  // but the market listing page still embeds recent sale history in `line1`.
  if (lowest == null && median == null) {
    median = await fetchLatestSaleFromListingPage(marketHashName);
  }

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

// Treat variants with no listing and no last-sold price as stale so they can be retried immediately.
export function isPriceStale(
  updatedAt: string | null,
  maxAgeHours: number = 6,
  lowestPriceCents: number | null = null,
  medianPriceCents: number | null = null
): boolean {
  if (lowestPriceCents == null && medianPriceCents == null) return true;
  if (!updatedAt) return true;
  const updated = new Date(updatedAt).getTime();
  const now = Date.now();
  return now - updated > maxAgeHours * 60 * 60 * 1000;
}
