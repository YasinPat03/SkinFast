'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

export default function PriceRefreshButton({
  marketHashNames,
  isStale,
}: {
  marketHashNames: string[];
  isStale: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const hasAutoRefreshed = useRef(false);
  const router = useRouter();

  async function handleRefresh() {
    setLoading(true);
    try {
      await fetch('/api/refresh-price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ market_hash_names: marketHashNames }),
      });
      setDone(true);
      router.refresh();
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }

  // Auto-refresh stale prices on page load
  useEffect(() => {
    if (isStale && marketHashNames.length > 0 && !hasAutoRefreshed.current) {
      hasAutoRefreshed.current = true;
      handleRefresh();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isStale || marketHashNames.length === 0) return null;

  return (
    <div className="flex items-center gap-2 text-xs">
      {!done ? (
        <>
          <span className="text-yellow-500">
            {loading ? 'Updating prices...' : 'Prices may be outdated'}
          </span>
          {!loading && (
            <button
              onClick={handleRefresh}
              className="text-blue-400 hover:text-blue-300 underline"
            >
              Refresh now
            </button>
          )}
        </>
      ) : (
        <span className="text-green-400">Prices updated</span>
      )}
    </div>
  );
}
