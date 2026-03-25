'use client';

import Link from 'next/link';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col flex-1 items-center justify-center px-4 gap-4">
      <h1 className="text-2xl font-bold text-white">Something went wrong</h1>
      <p className="text-zinc-400 text-sm max-w-md text-center">
        {error.message || 'An unexpected error occurred.'}
      </p>
      <div className="flex gap-3 mt-2">
        <button
          onClick={reset}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors text-sm"
        >
          Try again
        </button>
        <Link
          href="/"
          className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg border border-zinc-700 transition-colors text-sm"
        >
          Back to Search
        </Link>
      </div>
    </div>
  );
}
