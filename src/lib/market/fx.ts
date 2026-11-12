// Steam's listing page reports prices in the currency of the caller's country
// (USD from Vercel's US region, CAD from a Canadian laptop, ...), while search
// results are always USD. Everything stored is USD, so a non-USD page has to be
// converted with Steam's own exchange rate.
//
// That rate is recovered from Steam itself: the same lowest listing is known in
// USD (from search) and in the page's currency, and Steam converts every price
// with one rate. Listings that have not changed between the two readings give
// the same ratio to four digits; listings that have changed scatter. So the
// rate is the tightest large cluster of ratios, and when there is no such
// cluster the page is skipped rather than converted with a guess.

export interface FxPair {
  usdCents: number;
  // The same item's lowest listing in the page currency's minor units.
  localMinor: number;
}

// Ratios within this relative distance of each other count as agreeing.
const CLUSTER_WIDTH = 0.001;
// Prices are whole cents, so a cheap item's ratio is off by a visible fraction
// (half a cent on $3 is 0.17%). Only items at or above this price are compared;
// at $20 the rounding error is under 0.03%.
const MIN_PRICE_MINOR = 2000;

// USD cents per one minor unit of the page currency, or null when the pairs do
// not agree well enough to trust.
export function deriveUsdRate(pairs: FxPair[]): number | null {
  const ratios = pairs
    .filter((pair) => pair.usdCents >= MIN_PRICE_MINOR && pair.localMinor >= MIN_PRICE_MINOR)
    .map((pair) => pair.usdCents / pair.localMinor)
    .sort((a, b) => a - b);
  if (ratios.length < 2) return null;

  // Largest run of sorted ratios that fits inside the cluster width.
  let best: number[] = [];
  let start = 0;
  for (let end = 0; end < ratios.length; end++) {
    while (ratios[end] / ratios[start] > 1 + CLUSTER_WIDTH) start++;
    if (end - start + 1 > best.length) best = ratios.slice(start, end + 1);
  }

  // Three agreeing listings are convincing on their own; two only when they
  // are at least half of what was compared.
  const convincing = best.length >= 3 || (best.length === 2 && best.length * 2 >= ratios.length);
  if (!convincing) return null;
  return best[Math.floor(best.length / 2)];
}
