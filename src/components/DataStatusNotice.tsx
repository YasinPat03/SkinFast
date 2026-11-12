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
  const fresh = Math.round(status.listings_fresh_share * 100);

  return (
    <div className={`rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-400 space-y-1 ${className}`}>
      {status.listings_stale && (
        <p>
          <span className="font-medium">Many listing prices are out of date.</span>{' '}
          Only {fresh}% of listing prices were confirmed against Steam in the last 24 hours, so input costs shown may
          no longer match what is listed.
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
