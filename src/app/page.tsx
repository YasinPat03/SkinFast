import SearchBar from '@/components/SearchBar';
import Link from 'next/link';

export default function Home() {
  return (
    <div className="flex flex-col flex-1 items-center justify-center px-4">
      <div className="flex flex-col items-center gap-8 w-full max-w-2xl">
        <div className="text-center">
          <h1 className="text-5xl font-bold text-white tracking-tight mb-3">
            SkinFast
          </h1>
          <p className="text-zinc-400 text-lg">
            CS2 skin prices and tradeup calculator
          </p>
        </div>
        <SearchBar />
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/tradeups"
            className="rounded-lg border border-zinc-700 bg-zinc-900/70 px-4 py-2 text-sm text-zinc-200 transition-colors hover:border-zinc-500 hover:text-white"
          >
            Browse Best EV Tradeups
          </Link>
        </div>
        <div className="flex gap-6 text-xs text-zinc-600">
          <span>2000+ skins</span>
          <span>Live Steam prices</span>
          <span>Tradeup optimizer</span>
        </div>
      </div>
    </div>
  );
}
