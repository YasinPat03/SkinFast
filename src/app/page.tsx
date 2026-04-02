import SearchBar from '@/components/SearchBar';

export default function Home() {
  return (
    <div className="relative min-h-full">
      <div className="flex flex-col flex-1 items-center justify-center min-h-[calc(100vh-120px)] px-4">
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
          <div className="flex gap-6 text-xs text-zinc-600">
            <span>2000+ skins</span>
            <span>Live Steam prices</span>
            <span>Tradeup optimizer</span>
          </div>
        </div>
      </div>
    </div>
  );
}
