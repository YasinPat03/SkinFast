'use client';

import { useEffect, useState } from 'react';
import { ScrambleText } from './unlumen-ui/scramble-text';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type FloatSource = 'wear_assumption' | 'exact';

interface TradeupGroupedInput {
  skin_id: string;
  skin_name: string;
  weapon_name: string;
  wear_name: string;
  price_cents: number;
  is_last_sold_price: boolean;
  is_souvenir: boolean;
  collection_id: string;
  collection_name: string;
  market_hash_name: string;
  image_url: string | null;
  quantity: number;
  cannot_produce_target: boolean;
}

interface TradeupConcreteInput {
  slot: number;
  skin_id: string;
  skin_name: string;
  weapon_name: string;
  wear_name: string;
  price_cents: number;
  is_last_sold_price: boolean;
  is_souvenir: boolean;
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
  has_active_listing: boolean;
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
  requires_specific_floats: boolean;
  all_outcomes: TradeupOutcome[];
  has_unlisted_outcomes: boolean;
  has_unpriced_outcomes: boolean;
}

interface RequestedWearInfo {
  reachable: boolean;
  output_float_range: [number, number] | null;
  avg_normalized_range: [number, number] | null;
}

interface TradeupFinderResult {
  requested_wear: RequestedWearInfo;
  target: {
    skin_id: string;
    skin_name: string;
    weapon_name: string;
    wear: string;
    is_stattrak: boolean;
    price_cents: number | null;
    has_active_listing: boolean;
    last_sold_cents: number | null;
    image_url: string | null;
  };
  tradeups: TradeupCombo[];
}

function formatPrice(cents: number | null): string {
  if (cents == null) return '-';
  return `$${(cents / 100).toFixed(2)}`;
}

const WEAR_OPTIONS = ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'];

// "StatTrak™ M4A4 | Bullet Rain (Battle-Scarred)"
function describeVariant(skinName: string, wear: string, isStatTrak: boolean): string {
  return `${isStatTrak ? 'StatTrak\u2122 ' : ''}${skinName} (${wear})`;
}

function withStatTrak(skinName: string, isStatTrak: boolean): string {
  return isStatTrak ? `StatTrak\u2122 ${skinName}` : skinName;
}

function formatFloatRange(range: [number, number]): string {
  return `${range[0].toFixed(3)}\u2013${range[1].toFixed(3)}`;
}

// Why no candidate lands the requested wear, in terms the float editor can act on.
function describeUnreachableWear(info: RequestedWearInfo, wear: string): string {
  if (!info.output_float_range || !info.avg_normalized_range) {
    return `${wear} is outside this skin's float range, so no contract can produce it.`;
  }
  const [tLo, tHi] = info.avg_normalized_range;
  const hint = tLo >= 0.5
    ? ' (every input near the top of its own float range)'
    : tHi <= 0.5
      ? ' (every input near the bottom of its own float range)'
      : '';
  return `${wear} for this skin means an output float of ${formatFloatRange(info.output_float_range)}, which needs an average normalized input float of ${formatFloatRange(info.avg_normalized_range)}${hint}.`;
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

// "2 outcomes have no active listing and 1 outcome has no recorded sales (counted as $0)"
function describeSkew(unlisted: number, unpriced: number): string {
  const parts: string[] = [];
  if (unlisted > 0) parts.push(`${pluralize(unlisted, 'outcome')} ${unlisted === 1 ? 'has' : 'have'} no active listing`);
  if (unpriced > 0) parts.push(`${pluralize(unpriced, 'outcome')} ${unpriced === 1 ? 'has' : 'have'} no recorded sales (counted as $0)`);
  return parts.join(' and ');
}

export default function TradeupResults({
  skinId,
  skinName,
  hasStatTrak,
  availableWears,
  listedWears,
}: {
  skinId: string;
  skinName: string;
  hasStatTrak: boolean;
  availableWears: string[];
  listedWears: { normal: string[]; stattrak: string[] };
}) {
  const [wear, setWear] = useState(() => {
    return WEAR_OPTIONS.find((w) => availableWears.includes(w)) ?? availableWears[0] ?? 'Factory New';
  });
  const [isStatTrak, setIsStatTrak] = useState(false);
  const [result, setResult] = useState<TradeupFinderResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Does the requested target variant have an active listing? The API answer is fresher, so
  // prefer it whenever it was computed for the current wear/StatTrak selection.
  const selectionMatchesResult = result != null && result.target.wear === wear && result.target.is_stattrak === isStatTrak;
  const targetWearListed = selectionMatchesResult
    ? result.target.has_active_listing
    : (isStatTrak ? listedWears.stattrak : listedWears.normal).includes(wear);

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
          <Select value={wear} onValueChange={setWear}>
            <SelectTrigger className="border-zinc-700 bg-zinc-800 text-white hover:bg-zinc-700">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="item-aligned">
              {WEAR_OPTIONS.filter((option) => availableWears.includes(option)).map((option) => (
                <SelectItem key={option} value={option}>{option}</SelectItem>
              ))}
            </SelectContent>
          </Select>
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

      <div className="mb-4 rounded border border-zinc-700 bg-zinc-800/40 px-3 py-2 text-xs leading-5 text-zinc-400">
        <span className="font-medium text-zinc-300">Pricing disclaimer:</span> input prices are the lowest active Steam Community
        Market listing, and only skins with an active listing are ever used as inputs. Outcome prices are the average of the
        last 5 recorded Steam sales for the exact wear the contract is expected to produce, not a live listing. EV and
        cost-per-hit figures are estimates; Steam fees, float rolls, and price movement will change what you actually pay and receive.
      </div>

      {!targetWearListed && (
        <div className="mb-4 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          <span className="font-medium">
            No active Steam listing for {skinName} ({isStatTrak ? 'StatTrak ' : ''}{wear}).
          </span>{' '}
          There is no live listed price for this target, so its outcome value relies on past sales only and the prices,
          EV, and cost-per-hit shown may be skewed.
        </div>
      )}

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
          <div className="text-sm text-zinc-300">
            Results for <span className="font-medium text-white">{describeVariant(result.target.skin_name, result.target.wear, result.target.is_stattrak)}</span>
            {!selectionMatchesResult && (
              <span className="ml-2 text-amber-400">
                Selection changed. Click Find Best Tradeup to search {describeVariant(skinName, wear, isStatTrak)}.
              </span>
            )}
          </div>

          {result.tradeups.length > 0 && !result.requested_wear.reachable && (
            <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-400">
              <div className="font-medium">These results do not match your request.</div>
              <p className="mt-1">
                No realistic input combination is expected to land {describeVariant(result.target.skin_name, result.target.wear, result.target.is_stattrak)}.{' '}
                {describeUnreachableWear(result.requested_wear, result.target.wear)}
              </p>
              <p className="mt-1">
                Each option below is labelled with the wear it actually lands. They are ranked by how close they get
                to {result.target.wear}, not by value; open an option&apos;s exact float editor to test specific items.
              </p>
            </div>
          )}

          {result.tradeups.length > 0 && result.tradeups.every((combo) => combo.has_unlisted_outcomes) && (
            <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              <span className="font-medium">Every option includes a possible outcome with no active Steam listing</span>{' '}
              (marked in red below), so the EV figures may be skewed.
            </div>
          )}

          {result.tradeups.length === 0 ? (
            <p className="text-zinc-400 text-sm py-4">
              No tradeup combinations found. This may be because input skins do not have price data yet.
            </p>
          ) : (
            result.tradeups.map((combo) => (
              <TradeupCard
                key={combo.rank}
                combo={combo}
                skinId={skinId}
                targetWear={result.target.wear}
                isStatTrak={result.target.is_stattrak}
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
  const [floatEditorOpen, setFloatEditorOpen] = useState(
    !combo.target_matches_requested_wear || combo.requires_specific_floats
  );
  const evPositive = workingCombo.ev_cents >= 0;
  const targetExpectedWear = workingCombo.all_outcomes.find((o) => o.is_target)?.expected_wear ?? 'a different wear';
  const unlistedOutcomeCount = workingCombo.all_outcomes.filter((o) => !o.has_active_listing).length;
  const unpricedOutcomeCount = workingCombo.all_outcomes.filter((o) => o.price_cents == null).length;
  const evSkewed = unlistedOutcomeCount > 0 || unpricedOutcomeCount > 0;

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
          <span className="text-zinc-400 text-sm font-mono">#{combo.rank}</span>
          <div>
            {workingCombo.target_matches_requested_wear ? (
              <>
                <span className="text-white font-medium">
                  <ScrambleText text={`${formatPrice(workingCombo.cost_per_attempt_cents)} for each hit`} scrambleSpeed={20} delay={400}/>
                </span>
                <span className="text-zinc-400 text-sm ml-2">
                  (<ScrambleText text={`${(workingCombo.probability * 100).toFixed(1)}%`} scrambleSpeed={20} delay={400}/> chance of {targetWear})
                </span>
              </>
            ) : (
              <>
                <span className="text-amber-400 font-medium">
                  <ScrambleText text={`Lands ${targetExpectedWear}, not ${targetWear}`} scrambleSpeed={20} delay={400}/>
                </span>
                <span className="text-zinc-400 text-sm ml-2">
                  (<ScrambleText text={`${(workingCombo.target_skin_probability * 100).toFixed(1)}%`} scrambleSpeed={20} delay={400}/> chance of the skin, 0% of {targetWear})
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-4">
          <span
            className={`text-sm font-medium relative ${evPositive ? 'text-green-400' : 'text-red-400'}`}
            onMouseEnter={() => evSkewed && setShowEvTooltip(true)}
            onMouseLeave={() => setShowEvTooltip(false)}
          >
            EV: <ScrambleText text={`${evPositive ? '+' : ''}${formatPrice(workingCombo.ev_cents)}`} scrambleSpeed={20} delay={400}/>
            {evSkewed && <span className="text-red-400">*</span>}
            {showEvTooltip && (
              <span className="absolute top-full right-0 mt-2 w-max max-w-xs px-3 py-2 text-xs text-zinc-200 bg-zinc-900 border border-zinc-600 rounded-lg shadow-lg z-50 font-normal text-left pointer-events-none">
                EV may be skewed: {describeSkew(unlistedOutcomeCount, unpricedOutcomeCount)}.
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
          {!workingCombo.target_matches_requested_wear && (
            <div className="mt-3 text-sm text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2">
              <span className="font-medium">This option does not land {targetWear}.</span>{' '}
              With {workingCombo.float_source === 'exact' ? 'these exact' : 'estimated'} floats the target comes out {targetExpectedWear}.
              Use the float editor below to enter the exact floats of specific items and see whether they reach {targetWear}.
            </div>
          )}
          {workingCombo.requires_specific_floats && (
            <div className="mt-3 text-sm text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2">
              <span className="font-medium">Needs specific floats, not just any listing.</span>{' '}
              This option lands {targetWear} only if each input&apos;s float is close to the value in the exact float editor
              below (average normalized float {workingCombo.avg_normalized_float.toFixed(3)}). A typical listing of the
              wears shown will land a different wear, so check each item&apos;s float before buying.
            </div>
          )}
          <div className="mt-3">
            <h4 className="text-xs uppercase tracking-wider text-zinc-400 mb-2">
              Inputs - <ScrambleText text={formatPrice(workingCombo.total_cost_cents)} scrambleSpeed={20} delay={400}/> total
            </h4>
            <div className="space-y-1.5">
              {workingCombo.inputs.map((input, index) => (
                <div key={`${input.skin_id}:${input.collection_id}:${index}`} className="flex items-center gap-3 text-sm">
                  {input.image_url && (
                    <img src={input.image_url} alt={input.skin_name} className="w-10 h-7 object-contain flex-shrink-0" />
                  )}
                  <span className="text-zinc-300">
                    <ScrambleText text={`${input.quantity}x ${withStatTrak(input.skin_name, isStatTrak)}`} scrambleSpeed={20} delay={400}/>
                  </span>
                  <span className="text-zinc-400 text-xs">(<ScrambleText text={input.wear_name} scrambleSpeed={20} delay={400}/>)</span>
                  {input.is_souvenir && (
                    <span className="text-[10px] uppercase bg-yellow-500/20 text-yellow-400 px-1.5 py-0.5 rounded">
                      souvenir
                    </span>
                  )}
                  <span className="hidden sm:inline text-zinc-500 text-xs truncate min-w-0">{input.collection_name}</span>
                  {input.cannot_produce_target && (
                    <span
                      className="text-[10px] uppercase bg-amber-500/15 text-amber-400 px-1.5 py-0.5 rounded flex-shrink-0"
                      title="This input's collection cannot produce the target. It is cheaper, but it lowers the target chance and adds its own collection's outcomes to the pool."
                    >
                      cannot roll target
                    </span>
                  )}
                  <span className="ml-auto text-zinc-400">
                    <ScrambleText text={`${formatPrice(input.price_cents)} ea`} scrambleSpeed={20} delay={400}/>
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-4 bg-zinc-900/40 border border-zinc-700 rounded-lg">
            <button
              onClick={() => setFloatEditorOpen((o) => !o)}
              className="w-full flex items-center justify-between gap-3 p-3 text-left"
            >
              <div>
                <h4 className="text-xs uppercase tracking-wider text-zinc-400">Exact Float Inputs</h4>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-zinc-400">
                  {workingCombo.float_source === 'exact' ? 'exact floats' : 'wear assumptions'}
                </span>
                <svg
                  className={`w-4 h-4 text-zinc-500 transition-transform ${floatEditorOpen ? 'rotate-180' : ''}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </button>

            {floatEditorOpen && (
            <div className="px-3 pb-3">
            <p className="text-xs text-zinc-400 mb-3">
              Edit the exact float for each slot and recalculate the contract with true float-level math.
            </p>

            <div className="grid gap-2 md:grid-cols-2">
              {workingCombo.concrete_inputs.map((input, index) => (
                <label
                  key={`${input.slot}:${input.market_hash_name}`}
                  className="flex items-center gap-3 rounded border border-zinc-700 bg-zinc-800/50 px-3 py-2"
                >
                  <span className="text-xs text-zinc-400 w-6">#{input.slot}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-zinc-300 truncate">{withStatTrak(input.skin_name, isStatTrak)}</div>
                    <div className="text-xs text-zinc-400">
                      {input.is_souvenir ? 'Souvenir · ' : ''}{input.wear_name} · range {input.min_float.toFixed(2)}-{input.max_float.toFixed(2)}
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
            )}
          </div>

          <div className="mt-4">
            <h4 className="text-xs uppercase tracking-wider text-zinc-400 mb-2">
              Possible Outcomes
              <span className="ml-2 normal-case tracking-normal text-zinc-400">
                (avg normalized float: {workingCombo.avg_normalized_float.toFixed(4)})
              </span>
            </h4>
            <p className="text-xs text-zinc-500 mb-2">
              Prices are the average of the last 5 Steam sales at the estimated wear, not current listings.
            </p>
            {evSkewed && (
              <p className="text-xs text-red-400 mb-2">
                {describeSkew(unlistedOutcomeCount, unpricedOutcomeCount)}, so the EV may be skewed.
              </p>
            )}
            <div className="space-y-1.5">
              {workingCombo.all_outcomes.map((outcome, index) => (
                <div key={`${outcome.skin_id}:${index}`} className="flex items-center gap-3 text-sm">
                  {outcome.image_url && (
                    <img src={outcome.image_url} alt={outcome.skin_name} className="w-10 h-7 object-contain flex-shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={outcome.is_target ? 'text-green-400 font-medium' : 'text-zinc-300'}>
                        <ScrambleText text={withStatTrak(outcome.skin_name, isStatTrak)} scrambleSpeed={20} delay={400}/>
                      </span>
                      <span className="text-[10px] text-zinc-300 px-1.5 py-0.5 rounded bg-zinc-700/50">
                        <ScrambleText text={outcome.expected_wear} scrambleSpeed={20} delay={400}/>
                      </span>
                      {outcome.is_target && (
                        <span className="text-[10px] uppercase bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded">
                          target
                        </span>
                      )}
                      {!outcome.has_active_listing && (
                        <span className="text-[10px] uppercase bg-red-500/15 text-red-400 px-1.5 py-0.5 rounded">
                          no listing
                        </span>
                      )}
                      {outcome.price_cents == null && (
                        <span className="text-[10px] uppercase bg-red-500/15 text-red-400 px-1.5 py-0.5 rounded">
                          no sales data
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
                      <span className="text-xs text-zinc-400 w-12 text-right">
                        <ScrambleText text={`${(outcome.probability * 100).toFixed(1)}%`} scrambleSpeed={20} delay={400}/>
                      </span>
                      <span className="text-xs text-zinc-400 w-16 text-right">
                        {outcome.expected_float.toFixed(4)}
                      </span>
                    </div>
                  </div>
                  <span className="ml-auto flex-shrink-0 text-zinc-400">
                    <ScrambleText text={formatPrice(outcome.price_cents)} scrambleSpeed={20} delay={400}/>
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
