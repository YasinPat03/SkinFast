import type { DataStatus } from '@/lib/market/status';

// Says so on the page when figures rest on old or incomplete market data.
// Renders nothing when the data is in good shape.
export default function DataStatusNotice({ status, className = '' }: { status: DataStatus | null; className?: string }) {
  if (!status) {
    return (
      <div className={`rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-400 ${className}`}>
        The freshness of the market data could not be checked right now, so prices on this page may be out of date.
      </div>
    );
  }
  if (!status.listings_stale && !status.sales_incomplete) return null;

  const coverage = Math.round(status.sales_coverage * 100);
  // Floor, so a handful of old prices never reads as "100% were confirmed".
  const fresh = Math.floor(status.listings_fresh_share * 100);
  const stale = status.listings.listed_older_than_24h;

  return (
    <div className={`rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-400 space-y-1 ${className}`}>
      {status.listings_stale && (
        <p>
          <span className="font-medium">
            {fresh < 80 ? 'Many listing prices are out of date.' : 'Some listing prices are more than a day old.'}
          </span>{' '}
          {stale.toLocaleString('en-US')} listing {stale === 1 ? 'price was' : 'prices were'} not confirmed against
          Steam in the last 24 hours ({fresh}% of listed items were), so input costs shown may no longer match what is
          listed.
        </p>
      )}
      {status.sales_incomplete && (
        <p>
          <span className="font-medium">Sale prices are still being collected.</span>{' '}
          Only {coverage}% of listed items have a recorded last-5-sold price so far, so outcome values and EV are
          missing or incomplete for many contracts.
        </p>
      )}
    </div>
  );
}
