import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveUsdRate } from '../src/lib/market/fx';
import { isListingStale } from '../src/lib/market/freshness';
import { SteamFormatError, encodeMarketName } from '../src/lib/steam/http';
import { parseListingGroupHtml } from '../src/lib/steam/listing-page';
import { summarizeRecentSales } from '../src/lib/steam/sales';
import { TRACKED_TYPE_TAGS, buildSearchQuery, parseSearchResponse, searchUrl } from '../src/lib/steam/search';

// A real Steam listing-group page (★ Karambit | Doppler, fetched 2026-11-10
// from Canada, so prices are in CAD), trimmed to the parts the parser reads.
const groupHtml = readFileSync(join(__dirname, 'fixtures', 'listing-group.html'), 'utf8');

test('search: parses listings, skips unlisted results, counts every result for pagination', () => {
  const page = parseSearchResponse({
    success: true,
    start: 20,
    pagesize: 10,
    total_count: 15828,
    results: [
      { hash_name: 'AK-47 | Redline (Field-Tested)', sell_price: 3152, sell_price_text: '$31.52', sell_listings: 1211 },
      { hash_name: '★ Sport Gloves | Vice (Minimal Wear)', sell_price: 170368, sell_price_text: '$1,703.68', sell_listings: 3 },
      { hash_name: 'AK-47 | Sold Out (Factory New)', sell_price: 0, sell_price_text: '$0.00', sell_listings: 0 },
    ],
  });
  assert.equal(page.totalCount, 15828);
  assert.equal(page.resultCount, 3);
  assert.deepEqual(page.items, [
    { marketHashName: 'AK-47 | Redline (Field-Tested)', sellPriceCents: 3152, sellListings: 1211 },
    { marketHashName: '★ Sport Gloves | Vice (Minimal Wear)', sellPriceCents: 170368, sellListings: 3 },
  ]);
});

test('search: a response that is not what we expect is an error, never an empty page', () => {
  assert.throws(() => parseSearchResponse({ success: false }), SteamFormatError);
  assert.throws(() => parseSearchResponse(null), SteamFormatError);
  assert.throws(() => parseSearchResponse({ success: true, total_count: 5 }), SteamFormatError);
  assert.throws(
    () => parseSearchResponse({ success: true, total_count: 1, results: [{ name: 'no hash name', sell_price: 5 }] }),
    SteamFormatError,
  );
  // Prices in another currency must not be stored as US cents.
  assert.throws(
    () =>
      parseSearchResponse({
        success: true,
        total_count: 1,
        results: [{ hash_name: 'AK-47 | Redline (Field-Tested)', sell_price: 4600, sell_price_text: 'CDN$ 46.00', sell_listings: 5 }],
      }),
    /not in USD/,
  );
  // A genuinely empty result set is fine.
  assert.deepEqual(parseSearchResponse({ success: true, start: 0, total_count: 0, results: [] }).items, []);
});

test('search: queries drop the characters Steam returns nothing for, and URLs carry the type filter', () => {
  assert.equal(buildSearchQuery('AK-47', 'Redline'), 'AK-47 Redline');
  assert.equal(buildSearchQuery('★ Karambit', 'Doppler'), 'Karambit Doppler');
  assert.equal(buildSearchQuery('Stiletto Knife', ''), 'Stiletto Knife');
  assert.equal(buildSearchQuery('M4A1-S', 'Chantico\'s Fire'), "M4A1-S Chantico's Fire");

  const url = new URL(searchUrl({ start: 30, query: 'AK-47 Redline', typeTags: TRACKED_TYPE_TAGS }));
  assert.equal(url.searchParams.get('start'), '30');
  assert.equal(url.searchParams.get('query'), 'AK-47 Redline');
  assert.equal(url.searchParams.get('norender'), '1');
  assert.deepEqual(url.searchParams.getAll('category_730_Type[]'), [...TRACKED_TYPE_TAGS]);
  assert.equal(new URL(searchUrl({ start: 0 })).searchParams.has('query'), false);
});

test('market names are fully percent-encoded for listing URLs', () => {
  assert.equal(encodeMarketName('AK-47 | Redline (Field-Tested)'), 'AK-47%20%7C%20Redline%20%28Field-Tested%29');
  assert.equal(encodeMarketName("★ StatTrak™ M9 Bayonet | Doppler (Factory New)").includes('('), false);
  assert.equal(encodeMarketName("M4A1-S | Chantico's Fire (Minimal Wear)").includes("'"), false);
});

test('listing page: reads every variant, its lowest listing and its sale history', () => {
  const group = parseListingGroupHtml(groupHtml);
  assert.equal(group.hasMarketData, true);
  assert.equal(group.currencyId, 20); // CAD
  assert.deepEqual(group.buckets, [
    { marketHashName: '★ Karambit | Doppler (Factory New)', minPriceMinor: 207051 },
    { marketHashName: '★ Karambit | Doppler (Minimal Wear)', minPriceMinor: 0 },
    { marketHashName: '★ StatTrak™ Karambit | Doppler (Factory New)', minPriceMinor: 254158 },
    { marketHashName: '★ StatTrak™ Karambit | Doppler (Minimal Wear)', minPriceMinor: 0 },
  ]);
  assert.equal(group.histories.size, 4);

  const history = group.histories.get('★ Karambit | Doppler (Factory New)')!;
  assert.equal(history.length, 8);
  for (const sale of history) {
    assert.ok(sale.price > 0 && sale.count > 0 && sale.time > 1_700_000_000);
  }

  // An unlisted variant still carries its sale history on the group page.
  const recent = summarizeRecentSales(group.histories.get('★ Karambit | Doppler (Minimal Wear)')!);
  assert.ok(recent);
  assert.equal(recent.sampleCount, 5);
  assert.ok(recent.averagePrice > 1000 && recent.averagePrice < 5000);
  assert.equal(recent.lastSaleAt, '2026-11-04T13:00:00.000Z');
});

test('listing page: a layout the parser does not know is an error, not "no sales"', () => {
  assert.throws(() => parseListingGroupHtml('<html><body>Market Item</body></html>'), SteamFormatError);
  assert.throws(
    () => parseListingGroupHtml('<script type="application/json" id="valve-ssr-data">{not json</script>'),
    SteamFormatError,
  );
  assert.throws(
    () => parseListingGroupHtml('<script type="application/json" id="valve-ssr-data">{"loaderData":[]}</script>'),
    /queryData is missing/,
  );
  // A sale history in an unexpected shape is rejected rather than read as empty.
  const broken = groupHtml.replace(/price_median/g, 'median_price');
  assert.throws(() => parseListingGroupHtml(broken), /unexpected shape/);
});

test('listing page: a page with no market data says so (what Steam serves for an unlisted variant)', () => {
  const empty = `<script type="application/json" id="valve-ssr-data">${JSON.stringify({
    loaderData: ['{"steamid":"0"}', 'null'],
    renderContext: { queryData: JSON.stringify({ queries: [{ queryKey: ['CookiePreferences'], state: { data: {} } }] }) },
  })}</script>`;
  const group = parseListingGroupHtml(empty);
  assert.equal(group.hasMarketData, false);
  assert.equal(group.currencyId, null);
  assert.equal(group.buckets.length, 0);
});

test('listing page: the layout Steam used until late 2026 still parses', () => {
  const queryData = JSON.stringify({
    queries: [
      {
        queryKey: ['market', 'pricehistory', 730, 'AK-47 | Redline (Field-Tested)'],
        state: { data: { ecurrency: 1, prices: [{ time: 1794315600, price_median: 31.5, purchases: 7 }] } },
      },
    ],
  });
  const renderContext = JSON.stringify({ queryData });
  const html = `<script>window.SSR.renderContext = JSON.parse(${JSON.stringify(renderContext)});</script>`;
  const group = parseListingGroupHtml(html);
  assert.equal(group.currencyId, 1);
  assert.deepEqual(group.histories.get('AK-47 | Redline (Field-Tested)'), [{ time: 1794315600, price: 31.5, count: 7 }]);
});

test('recent sales: the last 5 individual sales, newest first, weighted by purchases', () => {
  const history = [
    { time: 100, price: 10, count: 50 },
    { time: 200, price: 20, count: 2 },
    { time: 300, price: 30, count: 1 },
    { time: 400, price: 40, count: 1 },
  ];
  // 1 x 40 + 1 x 30 + 2 x 20 + 1 x 10 = 120 over 5 sales.
  assert.deepEqual(summarizeRecentSales(history), {
    averagePrice: 24,
    sampleCount: 5,
    lastSaleAt: new Date(400_000).toISOString(),
  });
  // Order of the input does not matter.
  assert.equal(summarizeRecentSales([...history].reverse())!.averagePrice, 24);
  // Fewer than 5 sales on record: average what there is and say how many.
  assert.deepEqual(summarizeRecentSales([{ time: 300, price: 30, count: 2 }]), {
    averagePrice: 30,
    sampleCount: 2,
    lastSaleAt: new Date(300_000).toISOString(),
  });
  assert.equal(summarizeRecentSales([]), null);
  assert.equal(summarizeRecentSales([{ time: 1, price: 0, count: 3 }]), null);
});

test('currency: the rate is the tight cluster of ratios, and scattered ratios give none', () => {
  // Real readings (USD cents from search, CAD cents from the listing page).
  // The first five listings had not changed between the two readings.
  const unchanged = [
    { usdCents: 28750, localMinor: 40595 },
    { usdCents: 35037, localMinor: 49474 },
    { usdCents: 16118, localMinor: 22760 },
    { usdCents: 29000, localMinor: 40949 },
    { usdCents: 19360, localMinor: 27337 },
  ];
  const moved = [
    { usdCents: 8599, localMinor: 12651 },
    { usdCents: 12670, localMinor: 17797 },
    { usdCents: 22465, localMinor: 32501 },
    { usdCents: 14134, localMinor: 20474 },
  ];
  const rate = deriveUsdRate([...moved, ...unchanged]);
  assert.ok(rate != null && Math.abs(rate - 0.7082) < 0.0002, `rate ${rate}`);

  // Nothing agrees: refuse rather than guess.
  assert.equal(deriveUsdRate(moved), null);
  assert.equal(deriveUsdRate([unchanged[0]]), null);
  assert.equal(deriveUsdRate([]), null);
  // Two agreeing readings are enough only when they are most of the evidence.
  assert.ok(deriveUsdRate(unchanged.slice(0, 2)) != null);
  assert.equal(deriveUsdRate([...unchanged.slice(0, 2), ...moved]), null);
  // Cheap items are ignored: half a cent is too large a share of their ratio.
  assert.equal(
    deriveUsdRate([
      { usdCents: 708, localMinor: 1000 },
      { usdCents: 1062, localMinor: 1500 },
      { usdCents: 1275, localMinor: 1800 },
    ]),
    null,
  );
});

test('a listed price goes stale after 6 hours, a recorded "no listing" after 24', () => {
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);
  assert.equal(isListingStale(null, null), true);
  assert.equal(isListingStale(hoursAgo(5), 1200), false);
  assert.equal(isListingStale(hoursAgo(7), 1200), true);
  assert.equal(isListingStale(hoursAgo(7), null), false);
  assert.equal(isListingStale(hoursAgo(25), null), true);
});
