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
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (query.trim().length < 2) {
      setResults([]);
      setIsOpen(false);
      return;
    }

    setIsLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        setResults(data);
        setIsOpen(data.length > 0);
      } catch {
        setResults([]);
      } finally {
        setIsLoading(false);
      }
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

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

  function handleSelect(skin: SearchResult) {
    setIsOpen(false);
    setQuery('');
    router.push(`/skin/${skin.id}`);
  }

  return (
    <div ref={containerRef} className="relative w-full max-w-2xl">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length > 0 && setIsOpen(true)}
        placeholder="Search for a skin... (e.g. AK-47 Redline)"
        className="w-full px-4 py-3 rounded-lg bg-zinc-800 border border-zinc-700 text-white placeholder-zinc-400 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
      />
      {isLoading && (
        <div className="absolute right-3 top-3.5 text-zinc-400 text-sm">...</div>
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
