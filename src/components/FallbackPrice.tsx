interface FallbackPriceProps {
  priceCents: number | null;
  isLastSoldPrice?: boolean;
  normalClassName?: string;
  fallbackClassName?: string;
  nullClassName?: string;
  nullLabel?: string;
  suffix?: string;
  tooltipText?: string;
}

function formatPrice(cents: number | null): string {
  if (cents == null) return '-';
  return `$${(cents / 100).toFixed(2)}`;
}

export default function FallbackPrice({
  priceCents,
  isLastSoldPrice = false,
  normalClassName = 'text-zinc-400',
  fallbackClassName = 'text-orange-400',
  nullClassName = 'text-zinc-500',
  nullLabel = 'No price',
  suffix = '',
  tooltipText = 'No active listings. Showing the last sold price.',
}: FallbackPriceProps) {
  if (priceCents == null) {
    return <span className={nullClassName}>{nullLabel}</span>;
  }

  if (!isLastSoldPrice) {
    return <span className={normalClassName}>{formatPrice(priceCents)}{suffix}</span>;
  }

  return (
    <span
      className="group relative inline-flex items-center gap-0.5 whitespace-nowrap cursor-help outline-none"
      tabIndex={0}
      aria-label={tooltipText}
    >
      <span className={fallbackClassName}>{formatPrice(priceCents)}{suffix}</span>
      <span className={fallbackClassName}>*</span>
      <span className="pointer-events-none absolute bottom-full right-0 z-50 mb-2 hidden w-64 whitespace-normal rounded-lg border border-zinc-600 bg-zinc-900 px-3 py-2 text-left text-xs leading-snug text-zinc-200 shadow-lg group-hover:block group-focus-within:block">
        {tooltipText}
      </span>
    </span>
  );
}
