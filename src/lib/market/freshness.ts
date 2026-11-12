// When stored listing data for a variant is old enough to refresh on view.

const PRICED_MAX_AGE_HOURS = 6;
// A variant recorded as having no listing is re-checked less eagerly, so a
// skin with a permanently unlisted souvenir wear does not refresh on every visit.
const UNLISTED_RECHECK_HOURS = 24;

export function isListingStale(updatedAt: string | Date | null, lowestPriceCents: number | null): boolean {
  if (!updatedAt) return true; // never checked
  const maxAgeHours = lowestPriceCents != null ? PRICED_MAX_AGE_HOURS : UNLISTED_RECHECK_HOURS;
  return Date.now() - new Date(updatedAt).getTime() > maxAgeHours * 3_600_000;
}
