'use client';

import { useEffect, useState } from 'react';
import FallbackPrice from './FallbackPrice';

type FloatSource = 'wear_assumption' | 'exact';

interface TradeupGroupedInput {
  skin_id: string;
  skin_name: string;
  weapon_name: string;
  wear_name: string;
  price_cents: number;
  collection_id: string;
  collection_name: string;
  market_hash_name: string;
  image_url: string | null;
  quantity: number;
}

interface TradeupConcreteInput {
  slot: number;
  skin_id: string;
  skin_name: string;
  weapon_name: string;
  wear_name: string;
  price_cents: number;
  collection_id: string;
  collection_name: string;
  market_hash_name: string;
  image_url: string | null;
  min_float: number;
  max_float: number;
  input_float: number;
  normalized_float: number;
  float_source: FloatSource;
}

interface TradeupOutcome {
  skin_id: string;
  skin_name: string;
  weapon_name: string;
  probability: number;
  price_cents: number | null;
  image_url: string | null;
  is_target: boolean;
  is_last_sold_price: boolean;
  expected_float: number;
  expected_wear: string;
}

interface TradeupCombo {
  rank: number;
  inputs: TradeupGroupedInput[];
  concrete_inputs: TradeupConcreteInput[];
  total_cost_cents: number;
  probability: number;
  target_skin_probability: number;
  target_matches_requested_wear: boolean;
  cost_per_attempt_cents: number | null;
  ev_cents: number;
  avg_normalized_float: number;
  float_source: FloatSource;
  all_outcomes: TradeupOutcome[];
  has_last_sold_prices: boolean;
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
  hasStatTrak,
  availableWears,
}: {
  skinId: string;
  hasStatTrak: boolean;
  availableWears: string[];
}) {
  const [wear, setWear] = useState(() => {
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
      <div className="flex flex-wrap items-center gap-4 mb-4">
        <div className="flex items-center gap-2">
          <label className="text-sm text-zinc-400">Target wear:</label>
          <select
            value={wear}
            onChange={(e) => setWear(e.target.value)}
            className="bg-zinc-800 border border-zinc-700 text-white text-sm rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
          >
            {WEAR_OPTIONS.filter((option) => availableWears.includes(option)).map((option) => (
              <option key={option} value={option}>{option}</option>
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

      {error && (
        <div className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded px-3 py-2 mb-4">
          {error}
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-zinc-400 text-sm py-4">
          <div className="w-4 h-4 border-2 border-zinc-600 border-t-blue-500 rounded-full animate-spin" />
          Calculating best tradeups...
        </div>
      )}

      {result && (
        <div className="space-y-4">
          {result.tradeups.length === 0 ? (
            <p className="text-zinc-400 text-sm py-4">
              No tradeup combinations found. This may be because input skins do not have price data yet.
              Run the price scraper to populate prices.
            </p>
          ) : (
            result.tradeups.map((combo) => (
              <TradeupCard
                key={combo.rank}
                combo={combo}
                skinId={skinId}
                targetWear={wear}
                isStatTrak={isStatTrak}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function TradeupCard({
  combo,
  skinId,
  targetWear,
  isStatTrak,
}: {
  combo: TradeupCombo;
  skinId: string;
  targetWear: string;
  isStatTrak: boolean;
}) {
  const [expanded, setExpanded] = useState(combo.rank === 1);
  const [showEvTooltip, setShowEvTooltip] = useState(false);
  const [workingCombo, setWorkingCombo] = useState(combo);
  const [floatInputs, setFloatInputs] = useState(() => combo.concrete_inputs.map((input) => input.input_float.toFixed(5)));
  const [evaluationError, setEvaluationError] = useState<string | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const evPositive = workingCombo.ev_cents >= 0;

  useEffect(() => {
    setWorkingCombo(combo);
    setFloatInputs(combo.concrete_inputs.map((input) => input.input_float.toFixed(5)));
    setEvaluationError(null);
  }, [combo]);

  function updateFloatValue(index: number, value: string) {
    setFloatInputs((current) => current.map((entry, entryIndex) => (entryIndex === index ? value : entry)));
  }

  async function recalculateWithExactFloats() {
    const parsedFloats = floatInputs.map((value) => Number.parseFloat(value));
    if (parsedFloats.some((value) => !Number.isFinite(value))) {
      setEvaluationError('Enter a valid float for every input slot.');
      return;
    }

    setEvaluating(true);
    setEvaluationError(null);

    try {
      const res = await fetch('/api/tradeup/evaluate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          skin_id: skinId,
          wear: targetWear,
          stattrak: isStatTrak,
          inputs: workingCombo.concrete_inputs.map((input, index) => ({
            skin_id: input.skin_id,
            collection_id: input.collection_id,
            market_hash_name: input.market_hash_name,
            wear_name: input.wear_name,
            price_cents: input.price_cents,
            input_float: parsedFloats[index],
          })),
        }),
      });
      const data = await res.json();
      if (data.error) {
        setEvaluationError(data.error);
        return;
      }

      setWorkingCombo({ ...data, rank: combo.rank });
      setFloatInputs(data.concrete_inputs.map((input: TradeupConcreteInput) => input.input_float.toFixed(5)));
    } catch {
      setEvaluationError('Failed to evaluate exact floats.');
    } finally {
      setEvaluating(false);
    }
  }

  function resetFloatEditor() {
    setWorkingCombo(combo);
    setFloatInputs(combo.concrete_inputs.map((input) => input.input_float.toFixed(5)));
    setEvaluationError(null);
  }

  return (
    <div className="bg-zinc-800/50 border border-zinc-700 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-zinc-800 transition-colors text-left"
      >
        <div className="flex items-center gap-4">
          <span className="text-zinc-500 text-sm font-mono">#{combo.rank}</span>
          <div>
            <span className="text-white font-medium">
              {formatPrice(workingCombo.cost_per_attempt_cents)}
              {workingCombo.cost_per_attempt_cents != null ? ' per attempt' : ' requested target not hit'}
            </span>
            <span className="text-zinc-400 text-sm ml-2">
              ({(workingCombo.probability * 100).toFixed(1)}% requested wear chance)
            </span>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <span
            className={`text-sm font-medium relative ${evPositive ? 'text-green-400' : 'text-red-400'}`}
            onMouseEnter={() => workingCombo.has_last_sold_prices && setShowEvTooltip(true)}
            onMouseLeave={() => setShowEvTooltip(false)}
          >
            EV: {evPositive ? '+' : ''}{formatPrice(workingCombo.ev_cents)}
            {workingCombo.has_last_sold_prices && <span className="text-orange-400">*</span>}
            {showEvTooltip && (
              <span className="absolute bottom-full right-0 mb-2 w-64 px-3 py-2 text-xs text-zinc-200 bg-zinc-900 border border-zinc-600 rounded-lg shadow-lg z-50 font-normal text-left pointer-events-none">
                EV may be skewed because one or more outcomes only had last-sold fallback pricing.
              </span>
            )}
          </span>
          <span className="text-zinc-500 text-sm">
            {expanded ? '\u25B2' : '\u25BC'}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-zinc-700/50">
          <div className="mt-3">
            <h4 className="text-xs uppercase tracking-wider text-zinc-500 mb-2">
              Inputs - {formatPrice(workingCombo.total_cost_cents)} total
            </h4>
            <div className="space-y-1.5">
              {workingCombo.inputs.map((input, index) => (
                <div key={`${input.skin_id}:${input.collection_id}:${index}`} className="flex items-center gap-3 text-sm">
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

          <div className="mt-4 bg-zinc-900/40 border border-zinc-700 rounded-lg p-3">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <div>
                <h4 className="text-xs uppercase tracking-wider text-zinc-500">Exact Float Inputs</h4>
                <p className="text-xs text-zinc-500 mt-1">
                  Edit the exact float for each slot and recalculate the contract with true float-level math.
                </p>
              </div>
              <div className="text-xs text-zinc-500">
                Current source: {workingCombo.float_source === 'exact' ? 'exact floats' : 'wear assumptions'}
              </div>
            </div>

            <div className="grid gap-2 md:grid-cols-2">
              {workingCombo.concrete_inputs.map((input, index) => (
                <label
                  key={`${input.slot}:${input.market_hash_name}`}
                  className="flex items-center gap-3 rounded border border-zinc-700 bg-zinc-800/50 px-3 py-2"
                >
                  <span className="text-xs text-zinc-500 w-6">#{input.slot}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-zinc-300 truncate">{input.skin_name}</div>
                    <div className="text-xs text-zinc-500">
                      {input.wear_name} · range {input.min_float.toFixed(2)}-{input.max_float.toFixed(2)}
                    </div>
                  </div>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step="0.00001"
                    value={floatInputs[index] ?? ''}
                    onChange={(e) => updateFloatValue(index, e.target.value)}
                    className="w-24 rounded border border-zinc-600 bg-zinc-900 px-2 py-1 text-sm text-white focus:outline-none focus:border-blue-500"
                  />
                </label>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2 mt-3">
              <button
                onClick={recalculateWithExactFloats}
                disabled={evaluating}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm rounded transition-colors"
              >
                {evaluating ? 'Recalculating...' : 'Recalculate Exact Contract'}
              </button>
              <button
                onClick={resetFloatEditor}
                disabled={evaluating}
                className="px-3 py-1.5 bg-zinc-800 border border-zinc-700 hover:border-zinc-500 disabled:text-zinc-600 text-zinc-300 text-sm rounded transition-colors"
              >
                Reset
              </button>
            </div>

            {evaluationError && (
              <div className="mt-3 text-sm text-red-400">
                {evaluationError}
              </div>
            )}

            {!workingCombo.target_matches_requested_wear && (
              <div className="mt-3 text-sm text-amber-400">
                These exact floats do not land the target skin in {targetWear}. Target skin chance remains {(workingCombo.target_skin_probability * 100).toFixed(1)}%, but requested wear chance is 0%.
              </div>
            )}
          </div>

          <div className="mt-4">
            <h4 className="text-xs uppercase tracking-wider text-zinc-500 mb-2">
              Possible Outcomes
              <span className="ml-2 normal-case tracking-normal text-zinc-600">
                (avg normalized float: {workingCombo.avg_normalized_float.toFixed(4)})
              </span>
            </h4>
            <div className="space-y-1.5">
              {workingCombo.all_outcomes.map((outcome, index) => (
                <div key={`${outcome.skin_id}:${index}`} className="flex items-center gap-3 text-sm">
                  {outcome.image_url && (
                    <img src={outcome.image_url} alt={outcome.skin_name} className="w-10 h-7 object-contain flex-shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={outcome.is_target ? 'text-green-400 font-medium' : 'text-zinc-300'}>
                        {outcome.skin_name}
                      </span>
                      <span className="text-[10px] text-zinc-500 px-1.5 py-0.5 rounded bg-zinc-700/50">
                        {outcome.expected_wear}
                      </span>
                      {outcome.is_target && (
                        <span className="text-[10px] uppercase bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded">
                          target
                        </span>
                      )}
                    </div>
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
                      <span className="text-xs text-zinc-600 w-16 text-right">
                        {outcome.expected_float.toFixed(4)}
                      </span>
                    </div>
                  </div>
                  <span className="ml-auto flex-shrink-0">
                    <FallbackPrice
                      priceCents={outcome.price_cents}
                      isLastSoldPrice={outcome.is_last_sold_price}
                      normalClassName="text-zinc-400"
                      fallbackClassName="text-orange-400"
                      nullLabel="-"
                    />
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
