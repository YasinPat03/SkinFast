import type { Metadata } from 'next';
import sql from '@/lib/db';
import { isListingStale } from '@/lib/market/freshness';
import { type DataStatus, getDataStatus } from '@/lib/market/status';
import { type SkinRecord, type SkinVariantQuote, loadSkinDetail } from '@/lib/skins';
import { getTradeupEligibility } from '@/lib/tradeup';
import { notFound } from 'next/navigation';
import DataStatusNotice from '@/components/DataStatusNotice';
import SearchBar from '@/components/SearchBar';
import TradeupResults from '@/components/TradeupResults';
import PriceRefreshButton from '@/components/PriceRefreshButton';
import FallbackPrice from '@/components/FallbackPrice';
import { ScrambleText } from "@/components/unlumen-ui/scramble-text";

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

const WEAR_ORDER = ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred', 'Vanilla'];

type SkinRow = SkinRecord;
type VariantRow = SkinVariantQuote;

function formatPrice(cents: number | null): string {
  if (cents == null) return '-';
  return `$${(cents / 100).toFixed(2)}`;
}

// "Apr 23", or "Apr 23, 2025" when the sale was in an earlier year.
function formatSaleDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  });
}

function timeAgo(date: Date | string | null): string {
  if (!date) return 'Never';
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const skinRows = await sql<{ name: string; weapon_name: string; pattern_name: string; rarity_name: string; image_url: string | null }[]>`
    SELECT name, weapon_name, pattern_name, rarity_name, image_url FROM skins WHERE id = ${id}
  `;
  const skin = skinRows[0];
  if (!skin) {
    return { title: 'Skin Not Found | SkinFast' };
  }

  const title = `${skin.name} Prices — SkinFast`;
  const description = `Live Steam Community Market prices for ${skin.name} (${skin.rarity_name}). Compare all wears, StatTrak & Souvenir variants, float ranges, and tradeup contract info.`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: skin.image_url ? [{ url: skin.image_url, alt: skin.name }] : [],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: skin.image_url ? [skin.image_url] : [],
    },
  };
}

export default async function SkinDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const detail = await loadSkinDetail(id);
  if (!detail) notFound();
  const { skin, variants, collections, crates } = detail;

  // Group variants by type: normal, stattrak, souvenir
  const variantTypes = {
    normal: variants.filter((v) => !v.is_stattrak && !v.is_souvenir),
    stattrak: variants.filter((v) => v.is_stattrak),
    souvenir: variants.filter((v) => v.is_souvenir),
  };

  // Determine which columns to show
  const hasStatTrak = skin.has_stattrak;
  const hasSouvenir = skin.has_souvenir;

  // Build a lookup: wear -> variant for each type
  function getVariantByWear(list: VariantRow[], wear: string): VariantRow | undefined {
    return list.find((v) => v.wear_name === wear);
  }

  // The oldest listing check among the variants, for the "last updated" display
  const updateTimes = variants.filter((v) => v.updated_at != null).map((v) => new Date(v.updated_at!).getTime());
  const oldestUpdate = updateTimes.length > 0 ? new Date(Math.min(...updateTimes)) : null;

  const rarityColor = RARITY_COLORS[skin.rarity_id] ?? '#888';

  // Refresh on view when any variant's listing state is old (6h when listed, 24h when not)
  const hasStalePrice = variants.some((v) => isListingStale(v.updated_at, v.lowest_price_cents));

  const [tradeup, dataStatus] = await Promise.all([
    getTradeupEligibility(id),
    // The page must still render if the status query fails; the notice then says so.
    getDataStatus().catch((error): DataStatus | null => {
      console.error('[skin page] data status unavailable', error);
      return null;
    }),
  ]);

  // Get available wears for the non-stattrak, non-souvenir variants
  const availableWears = [...new Set(
    variants
      .filter((v) => !v.is_stattrak && !v.is_souvenir)
      .map((v) => v.wear_name)
  )];

  // Wears that currently have an active listing, so the tradeup finder can warn when the
  // requested target wear has no live listed price.
  const listedWears = {
    normal: variants
      .filter((v) => !v.is_stattrak && !v.is_souvenir && (v.lowest_price_cents ?? 0) > 0)
      .map((v) => v.wear_name),
    stattrak: variants
      .filter((v) => v.is_stattrak && (v.lowest_price_cents ?? 0) > 0)
      .map((v) => v.wear_name),
  };

  const lowestPriceVariant = variants
    .filter(v => v.lowest_price_cents != null)
    .sort((a, b) => a.lowest_price_cents! - b.lowest_price_cents!)[0];

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: skin.name,
    description: `${skin.name} — ${skin.rarity_name} CS2 skin. Float range ${skin.min_float.toFixed(2)}–${skin.max_float.toFixed(2)}.`,
    image: skin.image_url ?? undefined,
    brand: {
      '@type': 'Brand',
      name: skin.weapon_name,
    },
    ...(lowestPriceVariant && {
      offers: {
        '@type': 'Offer',
        price: (lowestPriceVariant.lowest_price_cents! / 100).toFixed(2),
        priceCurrency: 'USD',
        availability: 'https://schema.org/InStock',
        seller: {
          '@type': 'Organization',
          name: 'Steam Community Market',
        },
      },
    }),
  };

  return (
    <div className="flex flex-col flex-1 items-center px-4 py-8 gap-8">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <SearchBar />

      <div className="w-full max-w-4xl rounded-xl border border-zinc-700/50 bg-zinc-900/60 backdrop-blur-sm p-6 sm:p-8">
        {/* Skin header */}
        <div className="flex flex-col sm:flex-row items-center gap-6 mb-8">
          {skin.image_url && (
            <img
              src={skin.image_url}
              alt={skin.name}
              className="w-48 h-36 object-contain"
            />
          )}
          <div>
            <h1 className="text-2xl font-bold text-white"><ScrambleText text={skin.name}/></h1>
            <p className="text-sm mt-1" style={{ color: rarityColor }}>
              {skin.rarity_name}
            </p>
            <p className="text-zinc-400 text-sm mt-1">
              Float range: {skin.min_float.toFixed(2)} - {skin.max_float.toFixed(2)}
            </p>
            {oldestUpdate && (
              <p className="text-zinc-400 text-xs mt-2">
                Prices updated: {timeAgo(oldestUpdate)}
              </p>
            )}
            <PriceRefreshButton key={id} skinId={id} isStale={hasStalePrice} />
          </div>
        </div>

        {/* Price table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-700">
                <th className="text-left py-2 px-3 text-zinc-400 font-medium">Wear</th>
                <th className="text-right py-2 px-3 text-zinc-400 font-medium">Normal</th>
                {hasStatTrak && (
                  <th className="text-right py-2 px-3 text-orange-400 font-medium">StatTrak</th>
                )}
                {hasSouvenir && (
                  <th className="text-right py-2 px-3 text-yellow-400 font-medium">Souvenir</th>
                )}
              </tr>
            </thead>
            <tbody>
              {WEAR_ORDER
                .map((wear) => ({
                  wear,
                  normal: getVariantByWear(variantTypes.normal, wear),
                  stattrak: getVariantByWear(variantTypes.stattrak, wear),
                  souvenir: getVariantByWear(variantTypes.souvenir, wear),
                }))
                .filter(({ normal, stattrak, souvenir }) => normal || stattrak || souvenir)
                .map(({ wear, normal, stattrak, souvenir }, index, visibleRows) => {
                  const tooltipPlacement = index === visibleRows.length - 1 ? 'top' : 'bottom';

                  return (
                    <tr key={wear} className="border-b border-zinc-800 hover:bg-zinc-800/50">
                      <td className="py-3 px-3 text-zinc-300">{wear}</td>
                      <td className="py-3 px-3 text-right">
                        {normal ? (
                          <PriceCell variant={normal} tooltipPlacement={tooltipPlacement} />
                        ) : (
                          <span className="text-zinc-500">-</span>
                        )}
                      </td>
                      {hasStatTrak && (
                        <td className="py-3 px-3 text-right">
                          {stattrak ? (
                            <PriceCell variant={stattrak} tooltipPlacement={tooltipPlacement} />
                          ) : (
                            <span className="text-zinc-500">-</span>
                          )}
                        </td>
                      )}
                      {hasSouvenir && (
                        <td className="py-3 px-3 text-right">
                          {souvenir ? (
                            <PriceCell variant={souvenir} tooltipPlacement={tooltipPlacement} />
                          ) : (
                            <span className="text-zinc-500">-</span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>

        {/* Collections */}
        {collections.length > 0 && (
          <div className="mt-8">
            <h2 className="text-lg font-semibold text-white mb-3">Collections</h2>
            <div className="flex flex-wrap gap-3">
              {collections.map((col) => (
                <div
                  key={col.id}
                  className="flex items-center gap-2 px-3 py-2 bg-zinc-800 rounded-lg border border-zinc-700"
                >
                  {col.image_url && (
                    <img src={col.image_url} alt={col.name} className="w-8 h-8 object-contain" />
                  )}
                  <span className="text-sm text-zinc-300">{col.name}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Cases */}
        {crates.length > 0 && (
          <div className="mt-6">
            <h2 className="text-lg font-semibold text-white mb-3">Found in {crates.length} case{crates.length !== 1 ? 's' : ''}</h2>
            <div className="flex flex-wrap gap-3">
              {crates.map((crate) => (
                <div
                  key={crate.id}
                  className="flex items-center gap-2 px-3 py-2 bg-zinc-800 rounded-lg border border-zinc-700"
                >
                  {crate.image_url && (
                    <img src={crate.image_url} alt={crate.name} className="w-8 h-8 object-contain" />
                  )}
                  <span className="text-sm text-zinc-300">{crate.name}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tradeup Section */}
        <TradeupSection
          skinId={id}
          skin={skin}
          tradeup={tradeup}
          availableWears={availableWears}
          listedWears={listedWears}
          dataStatus={dataStatus}
        />
      </div>
    </div>
  );
}

function PriceCell({
  variant,
  tooltipPlacement = 'bottom',
}: {
  variant: VariantRow;
  tooltipPlacement?: 'top' | 'bottom';
}) {
  const hasListing = variant.lowest_price_cents != null;
  const lastSoldCents = variant.last_sold_avg_cents;
  const hasLastSold = lastSoldCents != null;
  const sampleCount = variant.last_sold_sample_count ?? 0;
  const lastSoldLabel = sampleCount > 1 ? `Avg of last ${sampleCount} sales` : 'Last sold';
  const saleDate = formatSaleDate(variant.last_sale_at);

  return (
    <div>
      {hasListing ? (
        <div className="text-white font-medium">
          <ScrambleText text={formatPrice(variant.lowest_price_cents)} scrambleSpeed={20}delay={400} />
        </div>
      ) : hasLastSold ? (
        <div className="font-medium">
          <FallbackPrice
            priceCents={lastSoldCents}
            isLastSoldPrice
            normalClassName="text-white"
            fallbackClassName="text-orange-400"
            nullClassName="text-zinc-400"
            nullLabel="-"
            tooltipText={`No active listings. Showing the ${sampleCount > 1 ? `average of the last ${sampleCount} sales` : 'last sold price'}.`}
            tooltipPlacement={tooltipPlacement}
          />
        </div>
      ) : (
        <div className="text-zinc-500">-</div>
      )}
      <div className="text-xs mt-0.5 space-x-1">
        {hasLastSold && !hasListing && (
          <span className="text-zinc-400">
            {lastSoldLabel}{saleDate ? ` · ${saleDate}` : ''}
          </span>
        )}
        {hasLastSold && hasListing && (
          <span className="text-zinc-400" title={saleDate ? `${lastSoldLabel}, most recent ${saleDate}` : lastSoldLabel}>
            Last sold: <ScrambleText text={formatPrice(lastSoldCents)} scrambleSpeed={20}delay={400}/>
          </span>
        )}
        {hasListing && variant.sell_listings != null && variant.sell_listings > 0 && (
          <span className="text-zinc-400">
            {hasLastSold ? '/ ' : ''}{variant.sell_listings} listed
          </span>
        )}
        {!hasListing && !hasLastSold && variant.updated_at != null && (
          <span className="text-zinc-500">No listings</span>
        )}
      </div>
    </div>
  );
}

function TradeupSection({ skinId, skin, tradeup, availableWears, listedWears, dataStatus }: {
  skinId: string;
  skin: SkinRow;
  tradeup: Awaited<ReturnType<typeof getTradeupEligibility>>;
  availableWears: string[];
  listedWears: { normal: string[]; stattrak: string[] };
  dataStatus: DataStatus | null;
}) {
  return (
    <div className="mt-8 border-t border-zinc-700 pt-8">
      <h2 className="text-lg font-semibold text-white mb-4">Tradeup Contract</h2>

      {!tradeup.eligible ? (
        <div className="text-zinc-400 text-sm bg-zinc-800/50 rounded-lg px-4 py-3 border border-zinc-700">
          {tradeup.reason}
        </div>
      ) : (
        <div>
          {/* Eligibility info */}
          <div className="flex flex-wrap gap-4 text-sm mb-4">
            <div className="bg-zinc-800/50 rounded px-3 py-2 border border-zinc-700">
              <span className="text-zinc-400">Input rarity: </span>
              <span className="text-white">{tradeup.input_rarity_name}</span>
            </div>
            <div className="bg-zinc-800/50 rounded px-3 py-2 border border-zinc-700">
              <span className="text-zinc-400">Inputs required: </span>
              <span className="text-white">{tradeup.num_inputs_required}</span>
            </div>
            <div className="bg-zinc-800/50 rounded px-3 py-2 border border-zinc-700">
              <span className="text-zinc-400">{tradeup.input_type === 'gold' ? 'Cases' : 'Collections'}: </span>
              <span className="text-white">{tradeup.collections?.length ?? 0}</span>
            </div>
          </div>

          {/* Input skins per collection (collapsed summary) */}
          {tradeup.collections && tradeup.collections.length > 0 && (
            <div className="mb-6 space-y-3">
              {tradeup.collections.map((col) => (
                <details key={col.id} className="bg-zinc-800/30 rounded-lg border border-zinc-700">
                  <summary className="px-4 py-2.5 cursor-pointer text-sm text-zinc-300 hover:text-white transition-colors">
                    {col.name}
                    <span className="text-zinc-400 ml-2">
                      ({col.input_skins.length} listed input{col.input_skins.length === 1 ? '' : 's'}, {col.output_skins.length} output{col.output_skins.length === 1 ? '' : 's'})
                    </span>
                  </summary>
                  <div className="px-4 pb-3 border-t border-zinc-700/50">
                    <div className="mt-2">
                      <span className="text-xs uppercase tracking-wider text-zinc-400">Input skins ({tradeup.input_rarity_name})</span>
                      <div className="mt-1.5 space-y-1">
                        {col.input_skins.map((s) => (
                          <div key={s.id} className="flex items-center gap-2 text-sm">
                            {s.image_url && <img src={s.image_url} alt={s.name} className="w-10 h-7 object-contain" />}
                            <span className="text-zinc-300">{s.name}</span>
                          </div>
                        ))}
                        {col.input_skins.length === 0 && (
                          <div className="text-sm text-zinc-500">
                            No {tradeup.input_rarity_name} skin from this {tradeup.input_type === 'gold' ? 'case' : 'collection'} has an active Steam listing right now.
                          </div>
                        )}
                        {col.unlisted_input_count > 0 && (
                          <div className="text-xs text-zinc-500">
                            {col.unlisted_input_count} skin{col.unlisted_input_count === 1 ? '' : 's'} without an active listing hidden (never used as inputs).
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="mt-3">
                      <span className="text-xs uppercase tracking-wider text-zinc-400">Possible outputs ({skin.rarity_name})</span>
                      <div className="mt-1.5 space-y-1">
                        {col.output_skins.map((s) => {
                          const isTarget = s.id === skinId || s.alias_ids.includes(skinId);
                          return (
                            <div key={s.id} className="flex items-center gap-2 text-sm">
                              {s.image_url && <img src={s.image_url} alt={s.name} className="w-10 h-7 object-contain" />}
                              <span className={isTarget ? 'text-green-400 font-medium' : 'text-zinc-300'}>
                                {s.name}
                                {s.alias_ids.length > 1 && ' (any phase)'}
                                {isTarget && ' (target)'}
                              </span>
                              {!s.has_active_listing && (
                                <span className="text-[10px] uppercase bg-red-500/15 text-red-400 px-1.5 py-0.5 rounded">
                                  no active listing
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </details>
              ))}
            </div>
          )}

          <DataStatusNotice status={dataStatus} className="mb-4" />

          {/* Best tradeup finder */}
          <TradeupResults
            skinId={skinId}
            skinName={skin.name}
            hasStatTrak={skin.has_stattrak}
            availableWears={availableWears}
            listedWears={listedWears}
          />
        </div>
      )}
    </div>
  );
}
