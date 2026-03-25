'use client';

import { useState } from 'react';
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
  const router = useRouter();

  if (!isStale || marketHashNames.length === 0) return null;

  async function handleRefresh() {
    setLoading(true);
    try {
      await fetch('/api/refresh-price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ market_hash_names: marketHashNames }),
      });
      setDone(true);
      // Refresh the page to show updated prices
      router.refresh();
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-yellow-500">Prices may be outdated</span>
      {!done ? (
        <button
          onClick={handleRefresh}
          disabled={loading}
          className="text-blue-400 hover:text-blue-300 underline disabled:text-zinc-500 disabled:no-underline"
        >
          {loading ? 'Refreshing...' : 'Refresh now'}
        </button>
      ) : (
        <span className="text-green-400">Updated</span>
      )}
    </div>
  );
}
