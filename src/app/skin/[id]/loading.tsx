export default function Loading() {
  return (
    <div className="flex flex-col flex-1 items-center px-4 py-8 gap-8 animate-pulse">
      {/* Search bar placeholder */}
      <div className="w-full max-w-2xl h-12 bg-zinc-800 rounded-lg" />

      <div className="w-full max-w-4xl">
        {/* Header skeleton */}
        <div className="flex flex-col sm:flex-row items-center gap-6 mb-8">
          <div className="w-48 h-36 bg-zinc-800 rounded" />
          <div className="space-y-3">
            <div className="h-7 w-64 bg-zinc-800 rounded" />
            <div className="h-4 w-32 bg-zinc-800 rounded" />
            <div className="h-4 w-40 bg-zinc-800 rounded" />
          </div>
        </div>

        {/* Price table skeleton */}
        <div className="space-y-2">
          <div className="h-10 bg-zinc-800 rounded" />
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-12 bg-zinc-800/50 rounded" />
          ))}
        </div>

        {/* Collections skeleton */}
        <div className="mt-8 space-y-3">
          <div className="h-6 w-32 bg-zinc-800 rounded" />
          <div className="flex gap-3">
            <div className="h-10 w-48 bg-zinc-800 rounded-lg" />
            <div className="h-10 w-40 bg-zinc-800 rounded-lg" />
          </div>
        </div>
      </div>
    </div>
  );
}
