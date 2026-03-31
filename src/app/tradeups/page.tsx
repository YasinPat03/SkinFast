import Link from 'next/link';
import SearchBar from '@/components/SearchBar';
import FallbackPrice from '@/components/FallbackPrice';
import { getTradeupLeaderboard, type TradeupLeaderboardEntry } from '@/lib/tradeup-leaderboard';

export const metadata = {
  title: 'Best Tradeups | SkinFast',
  description: 'Browse the best expected-value CS2 tradeup contracts using Steam Community Market price data.',
};

function formatPrice(cents: number | null): string {
  if (cents == null) return '-';
  return `$${(cents / 100).toFixed(2)}`;
}

function parseCostParam(value: string | string[] | undefined): number | undefined {
  if (Array.isArray(value)) return parseCostParam(value[0]);
  if (!value) return undefined;

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;

  return Math.round(parsed * 100);
}

export default async function TradeupsPage({
  searchParams,
}: {
  searchParams: Promise<{ minCost?: string; maxCost?: string }>;
}) {
  const params = await searchParams;
  const minCostCents = parseCostParam(params.minCost);
  const maxCostCents = parseCostParam(params.maxCost);

  const leaderboard = await getTradeupLeaderboard({
    minCostCents,
    maxCostCents,
    limit: 40,
  });

  return (
    <div className="flex flex-1 flex-col items-center gap-8 px-4 py-8">
      <SearchBar />

      <div className="w-full max-w-6xl space-y-6">
        <section className="flex flex-col gap-4 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
          <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-[0.24em] text-zinc-500">
                Steam Marketplace
              </p>
              <h1 className="text-3xl font-semibold text-white">
                Best Tradeup Contracts
              </h1>
              <p className="max-w-3xl text-sm leading-6 text-zinc-400">
                Ranked by expected value using cached Steam Community Market prices. This leaderboard evaluates
                identical-input contracts: 10x of the same skin for standard tradeups, or 5x for knife and glove
                tradeups. Output estimates use the selected input wear.
              </p>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-sm text-zinc-400">
              <div>{leaderboard.total_matches.toLocaleString()} contracts match the current filter.</div>
              <div className="text-zinc-500">Showing the top {leaderboard.entries.length} by Expected Value.</div>
            </div>
          </div>

          <form className="grid gap-4 rounded-xl border border-zinc-800 bg-zinc-950/70 p-4 md:grid-cols-[1fr_1fr_auto]">
            <label className="space-y-2 text-sm">
              <span className="text-zinc-400">Minimum total contract cost</span>
              <input
                name="minCost"
                type="number"
                min="0"
                step="0.01"
                defaultValue={params.minCost ?? ''}
                placeholder="0.00"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-white placeholder:text-zinc-500 focus:border-blue-500 focus:outline-none"
              />
            </label>

            <label className="space-y-2 text-sm">
              <span className="text-zinc-400">Maximum total contract cost</span>
              <input
                name="maxCost"
                type="number"
                min="0"
                step="0.01"
                defaultValue={params.maxCost ?? ''}
                placeholder="Any"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-white placeholder:text-zinc-500 focus:border-blue-500 focus:outline-none"
              />
            </label>

            <div className="flex items-end gap-3">
              <button
                type="submit"
                className="h-11 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-700"
              >
                Apply Filter
              </button>
              <Link
                href="/tradeups"
                className="h-11 rounded-lg border border-zinc-700 px-4 text-sm font-medium leading-[42px] text-zinc-300 transition-colors hover:border-zinc-500 hover:text-white"
              >
                Reset
              </Link>
            </div>
          </form>
        </section>

        {leaderboard.entries.length === 0 ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-8 text-sm text-zinc-400">
            No tradeups matched this contract-cost range.
          </div>
        ) : (
          <div className="space-y-4">
            {leaderboard.entries.map((entry, index) => (
              <TradeupCard key={entry.id} entry={entry} rank={index + 1} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TradeupCard({ entry, rank }: { entry: TradeupLeaderboardEntry; rank: number }) {
  const evPositive = entry.ev_cents >= 0;
  const topOutcomes = entry.outcomes.slice(0, 3);

  return (
    <article className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/30">
      <div className="flex flex-col gap-5 p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="rounded-full border border-zinc-700 bg-zinc-950 px-2.5 py-1 text-xs font-medium text-zinc-400">
                #{rank}
              </span>
              <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                entry.contract_type === 'gold'
                  ? 'bg-amber-500/10 text-amber-300'
                  : 'bg-blue-500/10 text-blue-300'
              }`}>
                {entry.contract_type === 'gold' ? 'Case Tradeup' : 'Collection Tradeup'}
              </span>
              <span className="text-sm text-zinc-500">
                {entry.collection_name}
              </span>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              {entry.input.image_url && (
                <img
                  src={entry.input.image_url}
                  alt={entry.input.skin_name}
                  className="h-20 w-28 flex-shrink-0 object-contain"
                />
              )}
              <div className="space-y-1">
                <div className="text-xs uppercase tracking-[0.24em] text-zinc-500">
                  Input Contract
                </div>
                <Link
                  href={`/skin/${entry.input.skin_id}`}
                  className="block text-xl font-semibold text-white transition-colors hover:text-blue-300"
                >
                  {entry.num_inputs}x {entry.input.skin_name}
                </Link>
                <div className="text-sm text-zinc-400">
                  {entry.input.weapon_name} / {entry.input.wear_name}
                </div>
                <div className="text-sm text-zinc-500">
                  {entry.outcome_count} possible outcomes
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:min-w-[360px]">
            <Metric label="Total cost">
              <FallbackPrice
                priceCents={entry.total_cost_cents}
                normalClassName="text-white"
                fallbackClassName="text-white"
                nullClassName="text-white"
              />
            </Metric>
            <Metric label="Estimated return">
              <span className="text-white">{formatPrice(entry.expected_return_cents)}</span>
            </Metric>
            <Metric label="Estimated value">
              <span className={evPositive ? 'text-green-400' : 'text-red-400'}>
                {evPositive ? '+' : ''}{formatPrice(entry.ev_cents)}
              </span>
            </Metric>
            <Metric label="Estimated ROI">
              <span className={evPositive ? 'text-green-400' : 'text-red-400'}>
                {entry.roi_percent > 0 ? '+' : ''}{entry.roi_percent.toFixed(2)}%
              </span>
            </Metric>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <div className="text-xs uppercase tracking-[0.24em] text-zinc-500">Top outcomes</div>
                <div className="text-sm text-zinc-400">
                  Estimated from input wear.
                </div>
              </div>
              {entry.has_last_sold_prices && (
                <div className="text-xs text-orange-400">
                  Includes last-sold fallback pricing
                </div>
              )}
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              {topOutcomes.map((outcome) => (
                <Link
                  key={`${entry.id}:${outcome.skin_id}`}
                  href={`/skin/${outcome.skin_id}`}
                  className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-3 transition-colors hover:border-zinc-600"
                >
                  <div className="flex items-start gap-3">
                    {outcome.image_url && (
                      <img
                        src={outcome.image_url}
                        alt={outcome.skin_name}
                        className="h-14 w-20 flex-shrink-0 object-contain"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-white">
                        {outcome.skin_name}
                      </div>
                      <div className="text-xs text-zinc-500">
                        Est. {outcome.expected_wear} / {(outcome.probability * 100).toFixed(1)}%
                      </div>
                      <div className="mt-2 text-sm">
                        <FallbackPrice
                          priceCents={outcome.price_cents}
                          isLastSoldPrice={outcome.is_last_sold_price}
                          normalClassName="text-zinc-300"
                          fallbackClassName="text-orange-400"
                          nullClassName="text-zinc-500"
                          nullLabel="-"
                        />
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
            <div className="text-xs uppercase tracking-[0.24em] text-zinc-500">Input pricing</div>
            <div className="mt-3 text-sm text-zinc-400">
              <div className="flex items-center justify-between gap-3">
                <span>Per input</span>
                <FallbackPrice
                  priceCents={entry.input.price_cents}
                  isLastSoldPrice={entry.input.is_last_sold_price}
                  normalClassName="text-zinc-300"
                  fallbackClassName="text-orange-400"
                  nullClassName="text-zinc-500"
                />
              </div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <span>Wear</span>
                <span className="text-zinc-300">{entry.input.wear_name}</span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <span>Estimated avg float</span>
                <span className="text-zinc-300">{entry.input.expected_float.toFixed(5)}</span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <span>Contract size</span>
                <span className="text-zinc-300">{entry.num_inputs} inputs</span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <span>Best priced outcome</span>
                <span className="text-zinc-300">{formatPrice(entry.best_outcome_price_cents)}</span>
              </div>
            </div>
          </div>
        </div>

        <details className="rounded-xl border border-zinc-800 bg-zinc-950/50">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-zinc-300 hover:text-white">
            Show all outcomes
          </summary>
          <div className="border-t border-zinc-800 px-4 py-3">
            <div className="space-y-2">
              {entry.outcomes.map((outcome) => (
                <div
                  key={`${entry.id}:${outcome.skin_id}:${outcome.expected_wear}`}
                  className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm"
                >
                  {outcome.image_url && (
                    <img
                      src={outcome.image_url}
                      alt={outcome.skin_name}
                      className="h-12 w-16 flex-shrink-0 object-contain"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/skin/${outcome.skin_id}`}
                      className="block truncate text-zinc-200 transition-colors hover:text-blue-300"
                    >
                      {outcome.skin_name}
                    </Link>
                    <div className="text-xs text-zinc-500">
                      Est. {outcome.expected_wear} / avg float {outcome.expected_float.toFixed(5)} / {(outcome.probability * 100).toFixed(1)}% chance
                    </div>
                  </div>
                  <FallbackPrice
                    priceCents={outcome.price_cents}
                    isLastSoldPrice={outcome.is_last_sold_price}
                    normalClassName="text-zinc-300"
                    fallbackClassName="text-orange-400"
                    nullClassName="text-zinc-500"
                    nullLabel="-"
                  />
                </div>
              ))}
            </div>
          </div>
        </details>
      </div>
    </article>
  );
}

function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
      <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">{label}</div>
      <div className="mt-1 text-lg font-semibold">{children}</div>
    </div>
  );
}
