'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

interface SearchResult {
  id: string;
  name: string;
  weapon_name: string;
  pattern_name: string;
  rarity_id: string;
  rarity_name: string;
  image_url: string;
}

const RARITY_COLORS: Record<string, string> = {
  rarity_common_weapon: '#b0c3d9',
  rarity_uncommon_weapon: '#5e98d9',
  rarity_rare_weapon: '#4b69ff',
  rarity_mythical_weapon: '#8847ff',
  rarity_legendary_weapon: '#d32ce6',
  rarity_ancient_weapon: '#eb4b4b',
  rarity_ancient: '#eb4b4b',
  rarity_contraband: '#e4ae39',
};

export default function SearchBar() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (query.trim().length < 2) {
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('Search request failed');
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error('Invalid search response');
        if (controller.signal.aborted) return;
        setResults(data);
      } catch {
        if (controller.signal.aborted) return;
        setResults([]);
        setError('Search is temporarily unavailable. Please try again.');
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }, 300);

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [query, retryCount]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function handleQueryChange(value: string) {
    setQuery(value);
    setResults([]);
    setError(null);
    setIsLoading(value.trim().length >= 2);
    setIsOpen(value.trim().length >= 2);
  }

  function retrySearch() {
    setError(null);
    setIsLoading(true);
    setRetryCount((count) => count + 1);
  }

  function handleSelect(skin: SearchResult) {
    handleQueryChange('');
    router.push(`/skin/${skin.id}`);
  }

  return (
    <div ref={containerRef} className="relative z-50 w-full max-w-2xl">
      <input
        type="text"
        value={query}
        onChange={(e) => handleQueryChange(e.target.value)}
        onFocus={() => query.trim().length >= 2 && setIsOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setIsOpen(false);
          if (e.key === 'Enter' && isOpen && !isLoading && results[0]) {
            e.preventDefault();
            handleSelect(results[0]);
          }
        }}
        aria-label="Search skins"
        placeholder="Search for a skin... (e.g. AK-47 Redline)"
        className="w-full px-4 py-3 rounded-lg bg-zinc-800 border border-zinc-700 text-white placeholder-zinc-400 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
      />
      {isLoading && (
        <div role="status" className="absolute right-3 top-3.5 text-zinc-400 text-sm">Searching...</div>
      )}

      {isOpen && !isLoading && results.length === 0 && (
        <div role="status" className="absolute w-full mt-1 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-3 text-sm text-zinc-300 shadow-xl">
          {error ?? 'No skins found. Try a different name.'}
          {error && (
            <button type="button" onClick={retrySearch} className="ml-2 text-blue-300 hover:text-blue-200 underline">
              Retry
            </button>
          )}
        </div>
      )}

      {isOpen && results.length > 0 && (
        <ul className="absolute z-50 w-full mt-1 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl max-h-96 overflow-y-auto">
          {results.map((skin) => (
            <li key={skin.id}>
              <button
                onClick={() => handleSelect(skin)}
                className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-zinc-700 transition-colors text-left"
              >
                {skin.image_url && (
                  <img
                    src={skin.image_url}
                    alt={skin.name}
                    className="w-12 h-9 object-contain flex-shrink-0"
                  />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white truncate">{skin.name}</div>
                  <div
                    className="text-xs"
                    style={{ color: RARITY_COLORS[skin.rarity_id] ?? '#888' }}
                  >
                    {skin.rarity_name}
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
