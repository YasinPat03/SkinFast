'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';

type Status = 'idle' | 'loading' | 'updated' | 'no_listings' | 'rate_limited' | 'failed';

// Don't auto-fire again for the same skin within this window (per browser tab).
// The API route has its own 60 s per-instance guard; this one stops a reload
// loop on a rate-limited skin from queueing a Steam request per reload.
const AUTO_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

interface RefreshResponse {
  status?: string;
  updated?: unknown;
  missing?: unknown;
  last_sold_updated?: unknown;
}

function storageKey(skinId: string): string {
  return `price-refresh:${skinId}`;
}

function recentlyAttempted(skinId: string): boolean {
  try {
    const raw = sessionStorage.getItem(storageKey(skinId));
    if (!raw) return false;
    const at = Number(raw);
    return Number.isFinite(at) && Date.now() - at < AUTO_REFRESH_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function markAttempted(skinId: string): void {
  try {
    sessionStorage.setItem(storageKey(skinId), String(Date.now()));
  } catch {
    // Storage unavailable (private mode, disabled); the server-side guard still applies.
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export default function PriceRefreshButton({
  skinId,
  isStale,
}: {
  skinId: string;
  isStale: boolean;
}) {
  const [status, setStatus] = useState<Status>('idle');
  const hasAutoRefreshed = useRef(false);
  const router = useRouter();

  const handleRefresh = useCallback(async () => {
    setStatus('loading');
    markAttempted(skinId);
    try {
      const res = await fetch('/api/refresh-price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skin_id: skinId }),
      });

      let json: RefreshResponse | null = null;
      try {
        json = (await res.json()) as RefreshResponse;
      } catch {
        json = null;
      }
      const updated = asStringArray(json?.updated);
      const missing = asStringArray(json?.missing);
      const lastSoldUpdated = asStringArray(json?.last_sold_updated);

      // Any rows written → re-render the server component so the price table
      // and the "Prices updated: …" label reflect the DB, whatever the status.
      if (updated.length > 0 || missing.length > 0 || lastSoldUpdated.length > 0) router.refresh();

      // "Prices updated" is only ever shown when at least one price was written.
      if (res.ok && json?.status === 'ok' && updated.length > 0) {
        setStatus('updated');
      } else if (json?.status === 'rate_limited') {
        setStatus('rate_limited');
      } else if (res.ok && (json?.status === 'no_results' || json?.status === 'ok')) {
        setStatus('no_listings');
      } else {
        setStatus('failed');
      }
    } catch {
      setStatus('failed');
    }
  }, [skinId, router]);

  // Auto-refresh stale prices once per mount, unless this tab tried recently.
  // The call is deferred a tick so the effect body itself sets no state.
  // The ref is set when the timer fires (not when it is scheduled) so React's
  // strict-mode double effect run, whose cleanup cancels the first timer, still
  // ends up firing exactly once.
  useEffect(() => {
    if (!isStale || hasAutoRefreshed.current) return;
    if (recentlyAttempted(skinId)) {
      hasAutoRefreshed.current = true;
      return;
    }
    const timer = setTimeout(() => {
      hasAutoRefreshed.current = true;
      void handleRefresh();
    }, 0);
    return () => clearTimeout(timer);
  }, [isStale, skinId, handleRefresh]);

  // Once a refresh has run, keep its outcome visible even after the re-rendered
  // page no longer considers the prices stale.
  if (!isStale && status === 'idle') return null;

  const tryAgain = (
    <button
      type="button"
      onClick={handleRefresh}
      className="text-blue-400 hover:text-blue-300 underline"
    >
      Try again
    </button>
  );

  return (
    <div className="flex items-center gap-2 text-xs">
      {status === 'idle' && (
        <>
          <span className="text-yellow-500">Prices may be outdated</span>
          <button
            type="button"
            onClick={handleRefresh}
            className="text-blue-400 hover:text-blue-300 underline"
          >
            Refresh now
          </button>
        </>
      )}
      {status === 'loading' && <span className="text-yellow-500">Updating prices...</span>}
      {status === 'updated' && <span className="text-green-400">Prices updated</span>}
      {status === 'no_listings' && (
        <span className="text-zinc-400">No active Steam listings found right now</span>
      )}
      {status === 'rate_limited' && (
        <>
          <span className="text-yellow-500">
            Steam is rate-limiting price refreshes. Showing cached prices.
          </span>
          {tryAgain}
        </>
      )}
      {status === 'failed' && (
        <>
          <span className="text-red-400">Couldn&apos;t refresh prices.</span>
          {tryAgain}
        </>
      )}
    </div>
  );
}
