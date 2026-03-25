import SearchBar from '@/components/SearchBar';

export default function Home() {
  return (
    <div className="flex flex-col flex-1 items-center justify-center px-4">
      <div className="flex flex-col items-center gap-6 w-full max-w-2xl">
        <h1 className="text-4xl font-bold text-white tracking-tight">
          SkinFast
        </h1>
        <p className="text-zinc-400 text-center">
          CS2 skin prices and tradeup calculator
        </p>
        <SearchBar />
      </div>
    </div>
  );
}
