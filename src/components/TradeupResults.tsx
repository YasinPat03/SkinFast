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
import type {
  RequestedWearInfo,
  TradeupCombo,
  TradeupConcreteInput,
  TradeupFinderResult,
  TradeupOutcomeEvaluation,
  TradeupSort,
} from '@/lib/tradeup/types';

function formatPrice(cents: number | null): string {
  if (cents == null) return '-';
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function formatSigned(cents: number): string {
  return `${cents >= 0 ? '+' : ''}${formatPrice(cents)}`;
}

const WEAR_OPTIONS = ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred', 'Vanilla'];

const SORT_LABEL: Record<TradeupSort, string> = {
  cost_per_hit: 'Cheapest per hit',
  ev: 'Best EV',
};

// "StatTrak™ M4A4 | Bullet Rain (Battle-Scarred)"
function describeVariant(skinName: string, wear: string, isStatTrak: boolean): string {
  const name = isStatTrak ? skinName.replace(/^(★ )?/, '$1StatTrak™ ') : skinName;
  return wear === 'Vanilla' ? name : `${name} (${wear})`;
}

function withStatTrak(skinName: string, isStatTrak: boolean): string {
  return isStatTrak ? skinName.replace(/^(★ )?/, '$1StatTrak™ ') : skinName;
}

function formatRange(range: [number, number], digits = 3): string {
  return `${range[0].toFixed(digits)}–${range[1].toFixed(digits)}`;
}

// What the requested wear demands of the inputs, in terms the float editor can act on.
function describeRequirement(info: RequestedWearInfo, wear: string): string {
  if (!info.avg_normalized_range) {
    return `${wear} is outside this skin's float range, so no contract can produce it.`;
  }
  if (!info.output_float_range) return '';
  const [lo, hi] = info.avg_normalized_range;
  const hint =
    lo >= 0.5
      ? ' (every input near the top of its own float range)'
      : hi <= 0.5
        ? ' (every input near the bottom of its own float range)'
        : '';
  return `${wear} for this skin means an output float of ${formatRange(info.output_float_range)}, which needs an average normalized input float of ${formatRange(info.avg_normalized_range)}${hint}.`;
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

// A last sale this old means the "last 5 sold" figure may not reflect today's market.
const OLD_SALE_DAYS = 30;

function saleAge(iso: string | null): { days: number; label: string } | null {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return null;
  const days = Math.floor((Date.now() - time) / 86_400_000);
  const label = new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return { days, label };
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
  const [sort, setSort] = useState<TradeupSort>('cost_per_hit');
  const [result, setResult] = useState<TradeupFinderResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Does the requested target variant have an active listing? The API answer is fresher, so
  // prefer it whenever it was computed for the current wear/StatTrak selection.
  const selectionMatchesResult =
    result != null && result.target.wear === wear && result.target.is_stattrak === isStatTrak && result.sort === sort;
  const targetWearListed =
    result != null && result.target.wear === wear && result.target.is_stattrak === isStatTrak
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
        sort,
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

  const anyFloat = result?.tradeups.filter((combo) => combo.float_fit === 'any') ?? [];
  const specific = result?.tradeups.filter((combo) => combo.float_fit === 'specific') ?? [];
  const misses = result?.tradeups.filter((combo) => combo.float_fit === 'miss') ?? [];

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
                <SelectItem key={option} value={option}>{option === 'Vanilla' ? 'Vanilla (no exterior)' : option}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-sm text-zinc-400">Rank by:</label>
          <Select value={sort} onValueChange={(value) => setSort(value as TradeupSort)}>
            <SelectTrigger className="border-zinc-700 bg-zinc-800 text-white hover:bg-zinc-700">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="item-aligned">
              <SelectItem value="cost_per_hit">{SORT_LABEL.cost_per_hit}</SelectItem>
              <SelectItem value="ev">{SORT_LABEL.ev}</SelectItem>
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
        last 5 recorded Steam sales for the exact wear the contract is expected to produce, not a live listing. A listing
        shows a wear, not a float, so each option says whether it works with any float or only with specific ones; the lowest
        listing may not have a float that qualifies. EV and cost-per-hit figures are estimates before Steam fees.
      </div>

      {!targetWearListed && (
        <div className="mb-4 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          <span className="font-medium">
            No active Steam listing for {describeVariant(skinName, wear, isStatTrak)}.
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
            <span className="text-zinc-400">
              , ranked by {result.requested_wear.reachable ? SORT_LABEL[result.sort].toLowerCase() : `how close they get to ${result.target.wear}`}
              {' '}({result.combinations_checked.toLocaleString()} input combinations checked)
            </span>
            {!selectionMatchesResult && (
              <span className="ml-2 text-amber-400">
                Selection changed. Click Find Best Tradeup to search {describeVariant(skinName, wear, isStatTrak)} by {SORT_LABEL[sort].toLowerCase()}.
              </span>
            )}
          </div>

          {result.tradeups.length > 0 && !result.requested_wear.reachable && (
            <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-400">
              <div className="font-medium">These results do not match your request.</div>
              <p className="mt-1">
                No combination of currently listed inputs can land {describeVariant(result.target.skin_name, result.target.wear, result.target.is_stattrak)},
                whatever their floats. {describeRequirement(result.requested_wear, result.target.wear)}
              </p>
              <p className="mt-1">
                Each option below is labelled with the wear it actually lands. They are ranked by how close they get
                to {result.target.wear}, not by value.
              </p>
            </div>
          )}

          {result.requested_wear.reachable && !result.requested_wear.any_float_option && (
            <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-400">
              <div className="font-medium">Every option below needs specific input floats.</div>
              <p className="mt-1">
                No combination of currently listed wears lands {result.target.wear} with just any float.{' '}
                {describeRequirement(result.requested_wear, result.target.wear)} Each option states the floats it
                needs; the lowest listing may not qualify, and items that do can cost more than the price shown.
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
              No tradeup combinations found for this request.
            </p>
          ) : (
            <>
              {anyFloat.length > 0 && (
                <ComboSection
                  title="Works with any float"
                  note={`Every float these input wears can have lands ${result.target.wear}, so any listing of the wears shown will do.`}
                  combos={anyFloat}
                  result={result}
                  skinId={skinId}
                />
              )}
              {specific.length > 0 && (
                <ComboSection
                  title={anyFloat.length > 0 ? `${result.sort === 'ev' ? 'Higher EV' : 'Cheaper per hit'}, but needs specific floats` : 'Needs specific floats'}
                  note={`These land ${result.target.wear} only when the inputs' floats fall in the range each option states. Check floats before buying. Combinations that work for only a sliver of the floats their wears can have are left out as impractical.`}
                  combos={specific}
                  result={result}
                  skinId={skinId}
                />
              )}
              {misses.length > 0 && (
                <ComboSection
                  title={`Closest available (does not land ${result.target.wear})`}
                  note={null}
                  combos={misses}
                  result={result}
                  skinId={skinId}
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ComboSection({
  title,
  note,
  combos,
  result,
  skinId,
}: {
  title: string;
  note: string | null;
  combos: TradeupCombo[];
  result: TradeupFinderResult;
  skinId: string;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        {note && <p className="text-xs text-zinc-400 mt-0.5">{note}</p>}
      </div>
      {combos.map((combo) => (
        <TradeupCard
          key={combo.rank}
          combo={combo}
          skinId={skinId}
          targetWear={result.target.wear}
          isStatTrak={result.target.is_stattrak}
        />
      ))}
    </section>
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
  const [floatEditorOpen, setFloatEditorOpen] = useState(combo.float_fit !== 'any');
  const evPositive = workingCombo.ev_cents >= 0;
  const targetExpectedWear = workingCombo.all_outcomes.find((o) => o.is_target)?.expected_wear ?? 'a different wear';
  const unlistedOutcomeCount = workingCombo.all_outcomes.filter((o) => o.unlisted_wears.length > 0).length;
  const unpricedOutcomeCount = workingCombo.all_outcomes.filter((o) => o.unpriced_wears.length > 0).length;
  const evSkewed = unlistedOutcomeCount > 0 || unpricedOutcomeCount > 0;
  const evVaries = workingCombo.ev_range_cents[0] !== workingCombo.ev_range_cents[1];
  const lands = workingCombo.target_matches_requested_wear;
  const exact = workingCombo.float_source === 'exact';

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
            {lands ? (
              <>
                <span className="text-white font-medium">
                  <ScrambleText text={`${formatPrice(workingCombo.cost_per_attempt_cents)} for each hit`} scrambleSpeed={20} delay={400}/>
                </span>
                <span className="text-zinc-400 text-sm ml-2">
                  (<ScrambleText text={`${(workingCombo.probability * 100).toFixed(1)}%`} scrambleSpeed={20} delay={400}/> chance of {targetWear === 'Vanilla' ? 'the knife' : targetWear})
                </span>
                {workingCombo.requires_specific_floats && (
                  <span className="ml-2 text-[10px] uppercase bg-amber-500/15 text-amber-400 px-1.5 py-0.5 rounded align-middle">
                    needs specific floats
                  </span>
                )}
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
            onMouseEnter={() => (evSkewed || evVaries) && setShowEvTooltip(true)}
            onMouseLeave={() => setShowEvTooltip(false)}
          >
            EV: <ScrambleText text={formatSigned(workingCombo.ev_cents)} scrambleSpeed={20} delay={400}/>
            {evSkewed && <span className="text-red-400">*</span>}
            {showEvTooltip && (
              <span className="absolute top-full right-0 mt-2 w-max max-w-xs px-3 py-2 text-xs text-zinc-200 bg-zinc-900 border border-zinc-600 rounded-lg shadow-lg z-50 font-normal text-left pointer-events-none">
                {evVaries && (
                  <span className="block">
                    Depends on the input floats: between {formatSigned(workingCombo.ev_range_cents[0])} and {formatSigned(workingCombo.ev_range_cents[1])}.
                  </span>
                )}
                {evSkewed && <span className="block">EV may be skewed: {describeSkew(unlistedOutcomeCount, unpricedOutcomeCount)}.</span>}
              </span>
            )}
          </span>
          <span className="text-zinc-500 text-sm">
            {expanded ? '▲' : '▼'}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-zinc-700/50">
          {!lands && (
            <div className="mt-3 text-sm text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2">
              <span className="font-medium">This option does not land {targetWear}.</span>{' '}
              {exact
                ? `With these exact floats the target comes out ${targetExpectedWear}.`
                : `The input wears shown can only produce an average normalized float of ${formatRange(workingCombo.possible_avg_normalized)}, which makes the target ${targetExpectedWear} at best.`}
            </div>
          )}
          {lands && workingCombo.requires_specific_floats && workingCombo.required_avg_normalized && (
            <div className="mt-3 text-sm text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2">
              <span className="font-medium">Needs specific floats, not just any listing.</span>{' '}
              This lands {targetWear} only when the inputs&apos; average normalized float is between{' '}
              {formatRange(workingCombo.required_avg_normalized)}. The wears shown can produce {formatRange(workingCombo.possible_avg_normalized)},
              so about {Math.round(workingCombo.float_tolerance * 100)}% of the floats they can have work. The float editor below is
              filled with one set of floats that does; the lowest listing may not have such a float, and items that do can cost more.
            </div>
          )}
          {lands && !exact && workingCombo.float_fit === 'any' && (
            <div className="mt-3 text-sm text-green-400/90 bg-green-500/10 border border-green-500/20 rounded px-3 py-2">
              Any listing of the wears below works: every float they can have lands {targetWear}.
            </div>
          )}
          <div className="mt-3">
            <h4 className="text-xs uppercase tracking-wider text-zinc-400 mb-2">
              Inputs - <ScrambleText text={formatPrice(workingCombo.total_cost_cents)} scrambleSpeed={20} delay={400}/> total
            </h4>
            <div className="space-y-1.5">
              {workingCombo.inputs.map((input, index) => (
                <div key={`${input.market_hash_name}:${input.collection_id}:${index}`} className="flex items-center gap-3 text-sm">
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
                  {exact ? 'exact floats' : workingCombo.float_fit === 'any' ? 'any float works' : 'suggested floats'}
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
              Enter the real float of each item you plan to use and recalculate. The float decides the wear, so an item
              is priced at the lowest listing of the wear its float falls in.
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
                      {input.is_souvenir ? 'Souvenir · ' : ''}{input.wear_name} · floats {input.wear_float_range[0].toFixed(2)}-{input.wear_float_range[1].toFixed(2)}
                    </div>
                  </div>
                  <input
                    type="number"
                    min={input.min_float}
                    max={input.max_float}
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

            {exact && !lands && (
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
                (at avg normalized float {workingCombo.avg_normalized_float.toFixed(4)})
              </span>
            </h4>
            <p className="text-xs text-zinc-500 mb-2">
              Prices are the average of the last 5 Steam sales at the wear shown, not current listings.
              {evVaries && ` EV runs from ${formatSigned(workingCombo.ev_range_cents[0])} to ${formatSigned(workingCombo.ev_range_cents[1])} depending on the input floats, because some outcomes change wear.`}
            </p>
            {evSkewed && (
              <p className="text-xs text-red-400 mb-2">
                {describeSkew(unlistedOutcomeCount, unpricedOutcomeCount)}, so the EV may be skewed.
              </p>
            )}
            <div className="space-y-1.5">
              {workingCombo.all_outcomes.map((outcome, index) => (
                <OutcomeRow key={`${outcome.skin_id}:${index}`} outcome={outcome} isStatTrak={isStatTrak} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function OutcomeRow({ outcome, isStatTrak }: { outcome: TradeupOutcomeEvaluation; isStatTrak: boolean }) {
  const otherWears = outcome.possible_wears.filter((wear) => wear !== outcome.expected_wear);
  const otherUnlisted = outcome.unlisted_wears.filter((wear) => wear !== outcome.expected_wear);
  const sale = outcome.price_cents != null ? saleAge(outcome.last_sale_at) : null;

  return (
    <div className="flex items-center gap-3 text-sm">
      {outcome.image_url && (
        <img src={outcome.image_url} alt={outcome.skin_name} className="w-10 h-7 object-contain flex-shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={outcome.is_target ? 'text-green-400 font-medium' : 'text-zinc-300'}>
            <ScrambleText text={withStatTrak(outcome.skin_name, isStatTrak)} scrambleSpeed={20} delay={400}/>
          </span>
          <span className="text-[10px] text-zinc-300 px-1.5 py-0.5 rounded bg-zinc-700/50">
            <ScrambleText text={outcome.expected_wear} scrambleSpeed={20} delay={400}/>
          </span>
          {otherWears.length > 0 && (
            <span
              className="text-[10px] text-amber-300 px-1.5 py-0.5 rounded bg-amber-500/10"
              title="This outcome changes wear within the floats that still land your request, so its price depends on the input floats."
            >
              or {otherWears.join(' / ')} depending on floats
            </span>
          )}
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
          {otherUnlisted.length > 0 && (
            <span className="text-[10px] uppercase bg-red-500/15 text-red-400 px-1.5 py-0.5 rounded">
              no listing in {otherUnlisted.join(' / ')}
            </span>
          )}
          {outcome.price_cents == null && (
            <span className="text-[10px] uppercase bg-red-500/15 text-red-400 px-1.5 py-0.5 rounded">
              no sales data
            </span>
          )}
          {sale && sale.days > OLD_SALE_DAYS && (
            <span
              className="text-[10px] uppercase bg-amber-500/10 text-amber-300 px-1.5 py-0.5 rounded"
              title="The most recent recorded sale is old, so this price may not reflect today's market."
            >
              last sold {sale.label}
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
            {outcome.expected_wear === 'Vanilla' ? '' : outcome.expected_float.toFixed(4)}
          </span>
        </div>
      </div>
      <span className="ml-auto flex-shrink-0 text-zinc-400">
        <ScrambleText text={formatPrice(outcome.price_cents)} scrambleSpeed={20} delay={400}/>
      </span>
    </div>
  );
}
