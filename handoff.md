# Handoff: fix the fake "Prices updated" message and the stalled price scraper

> **Superseded (2026-11-11).** The scraping and trade-up code was rebuilt after this was written.
> The files named below (`src/lib/prices.ts`, `src/lib/scraper.ts`, `src/lib/tradeup*.ts`) no longer
> exist; their replacements live in `src/lib/steam/`, `src/lib/market/` and `src/lib/tradeup/`.
> The Steam observations in section 3 are also dated: `priceoverview` works again at times, and the
> listing page now embeds its data in a `valve-ssr-data` JSON script. Kept for history only.

Written 2026-09-10 after a read-only investigation. No code was changed. Everything
below was verified against the live database, the production site, and Steam.

## 0. TL;DR

Two separate failures produce the symptom "Updating prices... → Prices updated, but
nothing changes and the page still says 14d ago":

1. **The on-demand refresh is dead.** Steam's `market/priceoverview` endpoint now
   returns `HTTP 429` with body `null` on the *first* request from any anonymous IP.
   `refreshSinglePrice()` returns `null`, writes nothing, the API route still answers
   `200`, and `PriceRefreshButton` shows "Prices updated" without reading the response.
2. **The bulk cron scraper is crawling.** Steam's `search/render` now returns 10 items
   per page regardless of `count=100`, and from Vercel it gets rate-limited. The 429
   backoff (30+60+120+120 s) is longer than the 300 s function limit, so the function
   is killed with its lock still set and the next tick is skipped. Net throughput is
   ~2,700 rows/day for 35,506 items, i.e. a full cycle takes ~2 weeks. Median price
   age is 10.4 days. That is the "14d ago".

The fix: replace `priceoverview` with a `search/render?query=<weapon> <pattern>`
lookup (one request returns every listed variant of a skin with `sell_price` and
`sell_listings`), make the button honest, make the scraper survive 429s, stop treating
no-listing variants as permanently stale, and delete the cron that still hammers the
dead endpoint 50 times every 10 minutes.

## 1. Facts about this repo that CLAUDE.md gets wrong

- **Database is Postgres (Supabase), not SQLite.** `src/lib/db.ts` exports a
  `postgres` (porsager) tagged-template client as `sql`. `DATABASE_URL` lives in
  `.env.local`. All queries use `` sql`...` `` with `${}` interpolation (parameterized).
- **Next.js 16.2.1, React 19.2.** `AGENTS.md` says to read
  `node_modules/next/dist/docs/` before writing route code. Route segment config
  `export const maxDuration = N` is still supported
  (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/maxDuration.md`).
- **Deployed on Vercel Pro** at `https://skinfast.app`. Crons in `vercel.json`,
  protected by `CRON_SECRET`. `/skin/[id]` is rendered dynamically per request
  (verified: `x-vercel-cache: MISS`, `cache-control: no-store`), so `router.refresh()`
  does re-read the DB. No `force-dynamic` needed.
- **Sizes today:** 2,126 skins, 20,775 skin_variants, 38,382 prices rows,
  Steam `total_count` for appid 730 = 35,506.
- `prices.updated_at` is `TIMESTAMPTZ`; postgres.js returns it as a JS `Date`
  (the `VariantRow.updated_at: string` type in page.tsx is a lie but harmless).
- Scripts load env via `scripts/env.ts` (`dotenv.config({ path: '.env.local' })`).
  Run them with `npx tsx scripts/<name>.ts`.
- Doppler / Gamma Doppler phases are separate `skins` rows sharing one name
  (7 "★ Karambit | Doppler" rows). `skin_variants.market_hash_name` is UNIQUE and
  belongs to exactly one of those ids. Upsert prices by `market_hash_name`, never by
  `skin_id`, so every phase page benefits.
- 20 vanilla knives have `pattern_name = ''` (e.g. `skin-vanilla-weapon_knife_stiletto`,
  name "★ Stiletto Knife", variants "★ Stiletto Knife" / "★ StatTrak™ Stiletto Knife").

## 2. Files involved

| File | Role today | Change |
|---|---|---|
| `src/lib/prices.ts` | `refreshSinglePrice` (dead priceoverview path), listing-page history parsing for `last_sold_avg` (works), `isPriceStale` | Add search-based refresh, fix `isPriceStale`, delete priceoverview code |
| `src/app/api/refresh-price/route.ts` | `POST {market_hash_names[]}` → loops `refreshSinglePrice` | Rewrite to `POST {skin_id}` |
| `src/components/PriceRefreshButton.tsx` | Auto-fires on mount, shows "Prices updated" unconditionally | Read the response, honest states |
| `src/app/skin/[id]/page.tsx` | Computes `hasStalePrice`, `staleMarketHashNames`, renders label + button | Pass `skinId`, drop stale-name list |
| `src/lib/scraper.ts` | `fetchPage` (429 backoff 30/60/120), `upsertPriceBatch`, `scrapeChunk`, scrape_state helpers | Time budget, short 429 handling, rate-limited return |
| `src/app/api/cron/scrape-prices/route.ts` | Cron every 5 min, 60 pages, 10-min lock, `maxDuration = 300` | Clear lock in `finally`, shorter lock timeout, report rate-limit |
| `scripts/scrape-prices.ts` | CLI wrapper for `scrapeChunk` | Handle new `rateLimited` return |
| `src/app/api/cron/scrape-last-sold/route.ts` + `scripts/scrape-last-sold.ts` | 50 `priceoverview` calls per 10-min cron, all fail | Delete, remove cron entry |
| `vercel.json` | 4 crons | Remove `scrape-last-sold` |

Untouched and working: `refreshLastSoldAvgGroup` / `runLastSoldAvgChunk` (listing-page
history → `last_sold_avg`; wrote 15,635 rows in the last 24 h), `scrape-last-sold-avg`
cron, `import-metadata` cron, `src/app/api/skin/[id]/route.ts` (no staleness logic).

## 3. Verified Steam behavior (2026-09-10)

### `priceoverview` — dead
```
GET https://steamcommunity.com/market/priceoverview/?appid=730&currency=1&market_hash_name=AK-47%20%7C%20Redline%20(Field-Tested)
→ HTTP 429, body: null      (first request, residential IP, browser UA + Referer; identical on retry)
```
Production reproduces it:
```
POST https://skinfast.app/api/refresh-price {"market_hash_names":["AK-47 | Redline (Field-Tested)"]}
→ 200 {"results":{"AK-47 | Redline (Field-Tested)":null}}   in 0.29 s
```

### `search/render` — works, with new rules
```
GET https://steamcommunity.com/market/search/render/?appid=730&norender=1&query=AK-47%20Redline&start=0&count=100&sort_column=name&sort_dir=asc
→ {"success":true,"total_count":10,"pagesize":10,"results":[
     {"hash_name":"AK-47 | Redline (Battle-Scarred)","sell_price":3088,"sell_listings":69, ...},
     {"hash_name":"AK-47 | Redline (Field-Tested)","sell_price":3833,"sell_listings":1200, ...},
     ... Souvenir and StatTrak™ variants included ...]}
```
- `pagesize` is forced to **10** whatever `count` says. `start=10` returns the next
  10 (verified with `query=Redline`: total 17, second page returned 7).
- `sell_price` is **USD cents** even from a Canadian IP with no cookies
  (`sell_price_text` was `$…`). Do not send cookies.
- **Never put `|`, `★`, or `™` in `query`.** `query=AK-47 | Redline` and
  `query=★ Karambit | Doppler` both return `total_count: 0`. `query=AK-47 Redline`,
  `Sport Gloves Vice`, `M9 Bayonet Doppler`, `Karambit Lore` all work.
- Matching is loose (extra words are tolerated, e.g. `Karambit Doppler Factory New`
  returned Glock-18 Gamma Doppler). **Always filter results to names that exist in
  `skin_variants`.**
- Only items with **≥1 active listing** appear. `Karambit Doppler` returned 0 today
  because the single listing the bulk scraper saw on 2026-09-09 has sold. Absence
  from a complete result set means "no listings right now", which the bulk scraper
  already treats the same way.
- From this residential IP, 4 requests at 4 s spacing all returned 200. The 429s
  the cron sees come from Vercel's shared egress IPs (all crons run from `iad1`).

### Listing page — works from Vercel, but not a per-wear price source
`GET /market/listings/730/<market_hash_name>` 302-redirects to a bucket-group URL
(`/market/listings/730/G1807209A023004`). The SSR state embeds `pricehistory` for
**every** sibling variant (this is what `last_sold_avg` uses) but an `orderbook`
(`amtMinSellOrder`, `cSellOrders`) for **only one default wear**, regardless of which
variant was requested. Not usable for lowest-price-per-wear. Leave it alone.

## 4. Evidence for the scraper stall (from the DB, 2026-09-10 19:20–19:31 UTC)

| Metric | Value |
|---|---|
| `prices` rows updated in last 60 min | 0 |
| `prices` rows updated in last 24 h | 2,696 of 38,382 |
| `last_full_scrape` | 2026-09-10T09:22:40Z |
| `last_offset` 10 h later (19:24) and 7 min after that (19:31) | 680, 680 |
| `scrape_in_progress` lock | set 19:20:05, still set at 19:31 (past the 10-min timeout, never cleared) |
| Tracked variants with a price: median age | 10.4 days |
| Tracked variants fresher than 6 h | 0.0 % |
| Tracked variants older than 7 days | 71.9 % |

Mechanics: `fetchPage` on 429 sleeps `BACKOFF_DELAYS = [30_000, 60_000, 120_000]`
across `MAX_RETRIES = 3` (4 attempts → 330 s of sleep) inside a 300 s function. Vercel
kills the function; the `catch` that clears the lock never runs; the next `*/5` tick
sees a lock younger than 10 min and returns `skipped`; the tick after that proceeds.
So at best one attempt per 10 min, each scraping 0–10 items before the next 429.

## 5. Implementation plan

Do the changes in this order; each is independently deployable but 5.1–5.3 belong
together.

### 5.1 `src/lib/prices.ts` — add a search-based skin refresh

Add (keep `throttle()`, it is the per-instance 3 s spacer):

```ts
export class SteamRateLimitError extends Error {}

export interface SkinRefreshResult {
  status: 'ok' | 'no_results' | 'rate_limited' | 'error';
  query: string;
  requested: string[];   // market_hash_names of this skin_id's variants
  updated: string[];     // names actually upserted with a price (any tracked variant)
  missing: string[];     // requested names absent from a COMPLETE result set, marked as no listings
  complete: boolean;     // true if every page was fetched (offset >= total_count)
  results: Record<string, { lowest_price_cents: number; sell_listings: number } | null>;
}

// "★ Karambit | Doppler" -> "Karambit Doppler"; vanilla "★ Navaja Knife" -> "Navaja Knife"
export function buildSearchQuery(weaponName: string, patternName: string | null): string {
  return [weaponName, patternName]
    .filter((s): s is string => !!s && s.trim() !== '')
    .join(' ')
    .replace(/[|★™]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function refreshSkinPrices(skinId: string): Promise<SkinRefreshResult>
```

Algorithm for `refreshSkinPrices`:

1. `SELECT weapon_name, pattern_name FROM skins WHERE id = ${skinId}` → if none,
   return `status: 'error'` (route maps to 404).
2. `SELECT market_hash_name FROM skin_variants WHERE skin_id = ${skinId}` → `requested`.
3. `query = buildSearchQuery(...)`.
4. Paginate with a new helper in `src/lib/scraper.ts`:
   ```ts
   export async function fetchSearchPage(query: string, start: number): Promise<SteamSearchResponse>
   ```
   Same URL/headers as `fetchPage` plus `query=` (use `URLSearchParams`, it encodes
   spaces and parentheses correctly). **No long backoff:** on 429 throw
   `SteamRateLimitError` immediately; on `!res.ok` throw `Error`; on `success:false`
   retry once after `randomDelay()` then throw. `fetchSearchPage` itself never
   sleeps; the loop in `refreshSkinPrices` (prices.ts) calls the existing
   module-private `throttle()` before every page.
   Loop: `start = 0; pages = 0; while (pages < MAX_QUERY_PAGES /* 6 */)`:
   fetch, append `results`, `start += results.length`, `pages++`, break if
   `results.length === 0 || start >= total_count`. `complete = start >= total_count`.
   Six pages covers 60 listed variants; the largest skin has 15 variants. Vanilla
   knives (query = weapon only) can exceed 60 matches; that is fine, they just get
   `complete = false`.
5. Filter: `SELECT market_hash_name FROM skin_variants WHERE market_hash_name = ANY(${names})`.
   Keep only tracked names. Reuse `upsertPriceBatch(tracked)` from `scraper.ts`; it
   already skips `sell_price` 0/undefined and its `ON CONFLICT` touches only
   `lowest_price_cents`, `sell_listings`, `updated_at` (median/volume preserved).
   `updated` = names it wrote. Upsert **all** tracked results, not just `requested`
   (this is how sibling Doppler phases and "Redline" cousins get free refreshes).
6. `missing` = `requested` minus names present in results. Only when `complete`
   **and** at least one tracked result came back, mark them as no-listings so they
   stop being flagged stale (see 5.4):
   ```sql
   INSERT INTO prices (market_hash_name, lowest_price_cents, median_price_cents, volume, sell_listings, updated_at)
   VALUES (${name}, NULL, NULL, NULL, 0, NOW())
   ON CONFLICT (market_hash_name) DO UPDATE SET
     lowest_price_cents = NULL, sell_listings = 0, updated_at = NOW()
   ```
   (`median_price_cents` / `volume` deliberately not in the SET list.) If the search
   returned zero tracked results, do **not** null anything; return `status: 'no_results'`.
7. Catch `SteamRateLimitError` → `status: 'rate_limited'` (still report whatever pages
   were written before the 429). Catch anything else → `status: 'error'`, `console.warn`.

Delete once nothing references them: `refreshSinglePrice`, `PRICE_OVERVIEW_URL`,
`PriceOverviewResponse`, `parsePriceString`, `fetchLatestSaleFromListingPage`,
`parseLatestSaleFromHistoryHtml`, `parseHistoryFromHtml`. Grep first:
`grep -rn "refreshSinglePrice\|parsePriceString\|parseHistoryFromHtml" src scripts`.
Keep `parseAllHistoriesFromHtml`, `computeLastFiveAvg`, `refreshLastSoldAvgGroup`,
`refreshLastSoldAvg`, `runLastSoldAvgChunk`, `upsertLastSoldAvg`, `STEAM_USD_CURRENCY_ID`,
`MARKET_LISTING_URL`.

### 5.2 `src/app/api/refresh-price/route.ts` — one request per skin

```ts
export const maxDuration = 60;   // 6 pages × ~3 s throttle + latency

POST body: { skin_id: string }
400 if skin_id missing/not a string
404 if refreshSkinPrices reports the skin does not exist
200 otherwise, body = SkinRefreshResult (status field carries ok / no_results / rate_limited / error)
```

Add a per-instance attempt guard so a reload loop on a rate-limited skin does not
stack requests: `const lastAttempt = new Map<string, number>()`; if the same
`skin_id` was attempted < 60 s ago, return the cached last result with
`status` unchanged instead of hitting Steam. Serverless instances are recycled, so
this is best-effort; the client-side guard in 5.3 covers the rest.

### 5.3 `src/components/PriceRefreshButton.tsx` + `page.tsx` wiring

Props become `{ skinId: string; isStale: boolean }`. In `page.tsx` delete
`staleMarketHashNames` (lines ~166-168) and render
`<PriceRefreshButton skinId={id} isStale={hasStalePrice} />`. Keep `hasStalePrice`
and the "Prices updated: X ago" label (it is server-rendered from the oldest
`updated_at`, so it corrects itself after `router.refresh()`).

State machine: `idle | loading | updated | no_listings | rate_limited | failed`.

- On mount, if `isStale`: auto-fire once, but skip if
  `sessionStorage['price-refresh:' + skinId]` is < 5 min old (wrap storage in
  try/catch). Always write the timestamp when firing.
- `fetch('/api/refresh-price', { method: 'POST', body: JSON.stringify({ skin_id }) })`.
  Parse JSON. Decide:
  - `res.ok && json.status === 'ok' && json.updated.length > 0` → `updated`,
    text "Prices updated", then `router.refresh()`.
  - `res.ok && (json.status === 'no_results' || json.updated.length === 0)` →
    `no_listings`, text "No active Steam listings found right now". Call
    `router.refresh()` only if `json.missing.length > 0` (rows were touched).
  - `json.status === 'rate_limited'` → `rate_limited`, text
    "Steam is rate-limiting price refreshes. Showing cached prices." + "Try again" link.
  - anything else / network error → `failed`, text "Couldn't refresh prices." +
    "Try again".
- **"Prices updated" must never render unless `updated.length > 0`.** That is the
  bug the user reported.
- While `loading`: "Updating prices..." (keep). While `idle` and stale: "Prices may
  be outdated" + "Refresh now" (keep).

### 5.4 `isPriceStale` — stop flagging no-listing rows forever

Current code returns `true` whenever both prices are null, regardless of
`updated_at`. Every skin with a Souvenir variant that has no listings (AK-47 |
Redline has two) is therefore stale on every visit and fires a refresh that can
never succeed. New semantics:

```ts
const NO_LISTING_RECHECK_HOURS = 24;

export function isPriceStale(
  updatedAt: string | Date | null,
  maxAgeHours = 6,
  lowestPriceCents: number | null = null,
  medianPriceCents: number | null = null,
): boolean {
  if (!updatedAt) return true;                       // never fetched
  const hasPrice = lowestPriceCents != null || medianPriceCents != null;
  const windowHours = hasPrice ? maxAgeHours : Math.max(maxAgeHours, NO_LISTING_RECHECK_HOURS);
  return Date.now() - new Date(updatedAt).getTime() > windowHours * 3_600_000;
}
```

Only caller today is `page.tsx` (lines 163-168). With 5.1 step 6 writing
`updated_at = NOW()` for missing variants, a skin stops being stale after one
successful refresh.

### 5.5 `src/lib/scraper.ts` + `src/app/api/cron/scrape-prices/route.ts` — survive 429s

`scraper.ts`:
- Replace `BACKOFF_DELAYS = [30_000, 60_000, 120_000]` with a single
  `RATE_LIMIT_RETRY_MS = 15_000`. In `fetchPage`, on the first 429 sleep 15 s and
  retry once; on the second 429 `throw new SteamRateLimitError(...)` (import from
  prices.ts or define it in scraper.ts and re-export; avoid a circular import —
  scraper.ts must not import prices.ts if prices.ts imports scraper.ts, so define
  the class in scraper.ts and import it into prices.ts).
- `scrapeChunk(maxPages, opts?: { budgetMs?: number })`. Default `budgetMs = 240_000`
  for the cron; the CLI passes `Infinity`. Compute `deadline = Date.now() + budgetMs`
  and break the loop when `Date.now() + MAX_DELAY_MS > deadline`. Wrap each page in
  try/catch for `SteamRateLimitError`: on catch, stop the loop and return with a new
  field `rateLimited: true`. Progress is already saved per page via
  `saveScrapeState('last_offset', …)`, so nothing is lost. If the *first* page is
  rate-limited, return `pagesScraped: 0, rateLimited: true` instead of throwing.
- Keep `PAGE_SIZE = 100` in the request (harmless if Steam ever raises the cap) but
  update the comments: Steam currently returns 10, so 60 pages ≈ 600 items ≈ 250 s.
  A clean full cycle is ~59 runs ≈ 5 h at the `*/5` cadence.

Cron route:
- Move the lock clear into `finally` so every exit path clears it.
- `LOCK_TIMEOUT_MS` from 10 min to 6 min (a killed run then wastes one tick, not two).
- Include `rate_limited: result.rateLimited` in the JSON; return 200 either way.
- Keep `maxDuration = 300`.

`scripts/scrape-prices.ts`: loop `scrapeChunk(maxPages, { budgetMs: Infinity })`
until `completed`; when `rateLimited`, `sleep(60_000)` and continue (fine from a
residential IP). Print progress each iteration.

### 5.6 Remove the dead `scrape-last-sold` cron

It runs every 10 min, calls `refreshSinglePrice` up to 50 times, and every call
returns `null` in ~0.3 s. That is up to 7,200 rejected requests/day from the same
Vercel IPs the bulk scraper depends on. Remove:
- the `"/api/cron/scrape-last-sold"` entry in `vercel.json` (keep `scrape-last-sold-avg`,
  it is a different, working job),
- `src/app/api/cron/scrape-last-sold/route.ts`,
- `scripts/scrape-last-sold.ts`.
`LAST_SOLD_BATCH_SIZE` env var becomes unused; leave it or remove from Vercel, either is fine.

### 5.7 Optional doc touch-up

Add a short "as of Sep 2026" note to `CLAUDE.md` under Data Sources: priceoverview
returns 429 for anonymous callers; search/render pagesize is 10; the DB is Postgres.

## 6. Verification

Local (from `/Users/yasin/SkinFast`, `.env.local` has `DATABASE_URL`):

```bash
npx tsc --noEmit
npm run lint
npm run build          # db.ts throws without DATABASE_URL; sitemap.ts queries the DB
npm run dev
```

API, expect `status: "ok"`, `updated` with ≥ 8 names, `missing` = the two Souvenir
WW/BS names, `complete: true`:
```bash
curl -s -X POST localhost:3000/api/refresh-price -H 'Content-Type: application/json' \
  -d '{"skin_id":"skin-91a429af4a60"}'          # AK-47 | Redline
```
Also try: `skin-vanilla-weapon_knife_stiletto` (vanilla, query = "Stiletto Knife",
expect `complete` possibly false and no nulling), a glove (find id:
`SELECT id FROM skins WHERE name = '★ Sport Gloves | Vice'`), and a Doppler phase
`skin-525ac56c082c` (expect `no_results` today, UI must NOT say "Prices updated").

UI: open `http://localhost:3000/skin/skin-91a429af4a60`. Expect "Updating prices..."
→ "Prices updated" → label flips to "Just now" without a manual reload. Reload: no
button (not stale). To exercise the failure branches, temporarily make
`fetchSearchPage` throw `SteamRateLimitError` and confirm the yellow
"Steam is rate-limiting…" text appears and no "Prices updated" is shown.

DB spot checks (run via a tsx snippet or the Supabase SQL editor):
```sql
SELECT market_hash_name, lowest_price_cents, sell_listings, updated_at
FROM prices WHERE market_hash_name LIKE 'AK-47 | Redline%' ORDER BY 1;
-- all rows updated_at within the last minute; Souvenir WW/BS have lowest NULL, sell_listings 0

SELECT key, value FROM scrape_state;   -- after deploy: scrape_in_progress = '' between runs
```

Production, after deploy:
```bash
curl -s -X POST https://skinfast.app/api/refresh-price -H 'Content-Type: application/json' \
  -d '{"skin_id":"skin-91a429af4a60"}'
```
If this returns `rate_limited` repeatedly while the same query succeeds from a
laptop, Vercel's egress IPs are being limited on `search/render` and the fallback in
§7 applies. Then watch the scraper for 20 minutes: `last_offset` should advance by up
to 600 per run and `scrape_in_progress` should be empty between runs.

## 7. If Vercel stays rate-limited on `search/render`

Nothing in code can fix a per-IP limit on shared egress. The working fallback is to
run `scripts/scrape-prices.ts` from a non-Vercel host (a small VPS, or a GitHub
Actions schedule with `DATABASE_URL` as a secret, though GitHub runners may also be
limited). The on-demand refresh could later be routed through the same host. Out of
scope for this handoff; just make the code fail honestly and recover.

## 8. Handy references

- Production skin page used for testing: `https://skinfast.app/skin/skin-91a429af4a60`
- Query the DB ad hoc from the repo root:
  ```bash
  node -e "require('dotenv').config({path:'.env.local',quiet:true});
  const p=require('postgres')(process.env.DATABASE_URL,{max:1});
  p\`SELECT key,value FROM scrape_state\`.then(r=>{console.log(r);return p.end()})"
  ```
- Steam request headers that work (copy from `scraper.ts`): Chrome 131 UA,
  `Accept: application/json, text/plain, */*`, `Accept-Language: en-US,en;q=0.9`.
  Space requests ≥ 3 s apart from a single IP.
- Last "Steam changed something" commit for context: `449b626` (2026-05-20,
  listing-page SSR format change) and `9990da2` (2026-05-29, one listing fetch fills
  all sibling variants).
