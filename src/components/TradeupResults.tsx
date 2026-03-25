'use client';

import { useState } from 'react';

interface TradeupCombo {
  rank: number;
  inputs: {
    skin_id: string;
    skin_name: string;
    weapon_name: string;
    wear_name: string;
    price_cents: number;
    collection_name: string;
    market_hash_name: string;
    image_url: string | null;
    quantity: number;
  }[];
  total_cost_cents: number;
  probability: number;
  cost_per_attempt_cents: number;
  ev_cents: number;
  all_outcomes: {
    skin_id: string;
    skin_name: string;
    weapon_name: string;
    probability: number;
    price_cents: number | null;
    image_url: string | null;
    is_target: boolean;
  }[];
}

interface TradeupFinderResult {
  target: {
    skin_id: string;
    skin_name: string;
    weapon_name: string;
    wear: string;
    price_cents: number | null;
    image_url: string | null;
  };
  tradeups: TradeupCombo[];
}

function formatPrice(cents: number | null): string {
  if (cents == null) return '-';
  return `$${(cents / 100).toFixed(2)}`;
}

const WEAR_OPTIONS = ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'];

export default function TradeupResults({
  skinId,
  skinName,
  hasStatTrak,
  availableWears,
}: {
  skinId: string;
  skinName: string;
  hasStatTrak: boolean;
  availableWears: string[];
}) {
  const [wear, setWear] = useState(() => {
    // Default to Field-Tested if available, otherwise first available
    return availableWears.includes('Field-Tested') ? 'Field-Tested' : availableWears[0] ?? 'Field-Tested';
  });
  const [isStatTrak, setIsStatTrak] = useState(false);
  const [result, setResult] = useState<TradeupFinderResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function fetchTradeups() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const params = new URLSearchParams({
        skin_id: skinId,
        wear,
        stattrak: isStatTrak.toString(),
      });
      const res = await fetch(`/api/tradeup/best?${params}`);
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setResult(data);
      }
    } catch {
      setError('Failed to fetch tradeup data');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-4 mb-4">
        <div className="flex items-center gap-2">
          <label className="text-sm text-zinc-400">Target wear:</label>
          <select
            value={wear}
            onChange={(e) => setWear(e.target.value)}
            className="bg-zinc-800 border border-zinc-700 text-white text-sm rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
          >
            {WEAR_OPTIONS.filter((w) => availableWears.includes(w)).map((w) => (
              <option key={w} value={w}>{w}</option>
            ))}
          </select>
        </div>

        {hasStatTrak && (
          <button
            onClick={() => setIsStatTrak(!isStatTrak)}
            className={`px-3 py-1.5 text-sm rounded border transition-colors ${
              isStatTrak
                ? 'bg-orange-500/20 border-orange-500 text-orange-400'
                : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-zinc-500'
            }`}
          >
            StatTrak{isStatTrak ? ' ON' : ''}
          </button>
        )}

        <button
          onClick={fetchTradeups}
          disabled={loading}
          className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm rounded transition-colors"
        >
          {loading ? 'Finding...' : 'Find Best Tradeup'}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded px-3 py-2 mb-4">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center gap-2 text-zinc-400 text-sm py-4">
          <div className="w-4 h-4 border-2 border-zinc-600 border-t-blue-500 rounded-full animate-spin" />
          Calculating best tradeups...
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="space-y-4">
          {result.tradeups.length === 0 ? (
            <p className="text-zinc-400 text-sm py-4">
              No tradeup combinations found. This may be because input skins don&apos;t have price data yet.
              Run the price scraper to populate prices.
            </p>
          ) : (
            result.tradeups.map((combo) => (
              <TradeupCard key={combo.rank} combo={combo} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function TradeupCard({ combo }: { combo: TradeupCombo }) {
  const [expanded, setExpanded] = useState(combo.rank === 1);
  const evPositive = combo.ev_cents >= 0;

  return (
    <div className="bg-zinc-800/50 border border-zinc-700 rounded-lg overflow-hidden">
      {/* Header — always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-zinc-800 transition-colors text-left"
      >
        <div className="flex items-center gap-4">
          <span className="text-zinc-500 text-sm font-mono">#{combo.rank}</span>
          <div>
            <span className="text-white font-medium">
              {formatPrice(combo.cost_per_attempt_cents)} per attempt
            </span>
            <span className="text-zinc-400 text-sm ml-2">
              ({(combo.probability * 100).toFixed(1)}% chance)
            </span>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <span className={`text-sm font-medium ${evPositive ? 'text-green-400' : 'text-red-400'}`}>
            EV: {evPositive ? '+' : ''}{formatPrice(combo.ev_cents)}
          </span>
          <span className="text-zinc-500 text-sm">
            {expanded ? '\u25B2' : '\u25BC'}
          </span>
        </div>
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-zinc-700/50">
          {/* Inputs */}
          <div className="mt-3">
            <h4 className="text-xs uppercase tracking-wider text-zinc-500 mb-2">
              Inputs — {formatPrice(combo.total_cost_cents)} total
            </h4>
            <div className="space-y-1.5">
              {combo.inputs.map((input, i) => (
                <div key={i} className="flex items-center gap-3 text-sm">
                  {input.image_url && (
                    <img src={input.image_url} alt={input.skin_name} className="w-10 h-7 object-contain flex-shrink-0" />
                  )}
                  <span className="text-zinc-300">
                    {input.quantity}x {input.skin_name}
                  </span>
                  <span className="text-zinc-500 text-xs">({input.wear_name})</span>
                  <span className="text-zinc-400 ml-auto">
                    {formatPrice(input.price_cents)} ea
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Outcomes */}
          <div className="mt-4">
            <h4 className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Possible Outcomes</h4>
            <div className="space-y-1.5">
              {combo.all_outcomes.map((outcome, i) => (
                <div key={i} className="flex items-center gap-3 text-sm">
                  {outcome.image_url && (
                    <img src={outcome.image_url} alt={outcome.skin_name} className="w-10 h-7 object-contain flex-shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={outcome.is_target ? 'text-green-400 font-medium' : 'text-zinc-300'}>
                        {outcome.skin_name}
                      </span>
                      {outcome.is_target && (
                        <span className="text-[10px] uppercase bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded">
                          target
                        </span>
                      )}
                    </div>
                    {/* Probability bar */}
                    <div className="flex items-center gap-2 mt-0.5">
                      <div className="flex-1 h-1.5 bg-zinc-700 rounded-full overflow-hidden max-w-32">
                        <div
                          className={`h-full rounded-full ${outcome.is_target ? 'bg-green-500' : 'bg-zinc-500'}`}
                          style={{ width: `${outcome.probability * 100}%` }}
                        />
                      </div>
                      <span className="text-xs text-zinc-500 w-12 text-right">
                        {(outcome.probability * 100).toFixed(1)}%
                      </span>
                    </div>
                  </div>
                  <span className="text-zinc-400 ml-auto flex-shrink-0">
                    {formatPrice(outcome.price_cents)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
