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

function parseHistoryFromHtml(html: string): PriceHistoryEntry[] | null {
  const match = html.match(/var line1=(\[[\s\S]*?\]);/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as PriceHistoryEntry[];
  } catch {
    return null;
  }
}

function parseLatestSaleFromHistoryHtml(html: string): number | null {
  const history = parseHistoryFromHtml(html);
  if (!history) return null;
  const latest = history[history.length - 1];
  if (!latest || typeof latest[1] !== 'number' || !Number.isFinite(latest[1])) {
    return null;
  }
  return Math.round(latest[1] * 100);
}

// Walks the history backward, accumulating sales weighted by their bucket volume,
// until we have at least 5 sales (or run out). Returns the weighted average in cents.
function computeLastFiveAvg(
  history: PriceHistoryEntry[]
): { avg_cents: number; sample_count: number; last_sale_at: string | null } | null {
  let totalSales = 0;
  let weightedSum = 0;
  let lastSaleAt: string | null = null;

  for (let i = history.length - 1; i >= 0 && totalSales < 5; i--) {
    const [date, price, volStr] = history[i];
    const vol = typeof volStr === 'string' ? parseInt(volStr, 10) : Number(volStr);
    if (!Number.isFinite(price) || !Number.isFinite(vol) || vol <= 0) continue;
    if (lastSaleAt === null) lastSaleAt = date;
    const take = Math.min(vol, 5 - totalSales);
    weightedSum += price * take;
    totalSales += take;
  }

  if (totalSales === 0) return null;
  return {
    avg_cents: Math.round((weightedSum / totalSales) * 100),
    sample_count: totalSales,
    last_sale_at: lastSaleAt,
  };
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

// Fetches the market listing page, parses the embedded sales history (`line1`),
// and upserts the volume-weighted average of the last 5 individual sales into `last_sold_avg`.
export async function refreshLastSoldAvg(marketHashName: string): Promise<{
  avg_last5_cents: number;
  sample_count: number;
  last_sale_at: string | null;
} | null> {
  await throttle();

  const encodedName = encodeURIComponent(marketHashName);
  const res = await fetch(`${MARKET_LISTING_URL}${encodedName}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (res.status === 429) {
    console.warn(`Rate limited fetching listing page for ${marketHashName}`);
    return null;
  }

  // Write a sentinel row even on no-data so the cron doesn't retry this variant
  // every minute. The `updated_at` filter on the query will skip it until it goes stale.
  let avg: number | null = null;
  let sampleCount: number | null = null;
  let lastSaleAt: string | null = null;

  if (res.ok) {
    const html = await res.text();
    const history = parseHistoryFromHtml(html);
    const result = history ? computeLastFiveAvg(history) : null;
    if (result) {
      avg = result.avg_cents;
      sampleCount = result.sample_count;
      lastSaleAt = result.last_sale_at;
    }
  } else {
    console.warn(`HTTP ${res.status} fetching listing page for ${marketHashName}`);
  }

  await sql`
    INSERT INTO last_sold_avg (market_hash_name, avg_last5_cents, sample_count, last_sale_at, updated_at)
    VALUES (${marketHashName}, ${avg}, ${sampleCount}, ${lastSaleAt}, NOW())
    ON CONFLICT (market_hash_name) DO UPDATE SET
      avg_last5_cents = EXCLUDED.avg_last5_cents,
      sample_count = EXCLUDED.sample_count,
      last_sale_at = EXCLUDED.last_sale_at,
      updated_at = NOW()
  `;

  if (avg === null) return null;
  return { avg_last5_cents: avg, sample_count: sampleCount!, last_sale_at: lastSaleAt };
}

// Process one chunk of variants needing a last-sold-avg refresh. Shared by the
// CLI script and the Vercel cron route so both follow the same incremental pattern.
export async function runLastSoldAvgChunk(opts: {
  batchSize: number;
  staleHours: number;
}): Promise<{ attempted: number; withData: number; noData: number }> {
  const { batchSize, staleHours } = opts;

  const targets = await sql<{ market_hash_name: string }[]>`
    SELECT sv.market_hash_name
    FROM skin_variants sv
    LEFT JOIN last_sold_avg l ON sv.market_hash_name = l.market_hash_name
    WHERE l.market_hash_name IS NULL
       OR l.updated_at < NOW() - (${staleHours} || ' hours')::INTERVAL
    ORDER BY l.updated_at NULLS FIRST, sv.market_hash_name
    LIMIT ${batchSize}
  `;

  let withData = 0;
  let noData = 0;

  for (const { market_hash_name } of targets) {
    try {
      const result = await refreshLastSoldAvg(market_hash_name);
      if (result) withData++;
      else noData++;
    } catch (err) {
      noData++;
      console.warn(`error on ${market_hash_name}: ${err}`);
    }
  }

  return { attempted: targets.length, withData, noData };
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
