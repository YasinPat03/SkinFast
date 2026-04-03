import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="flex flex-col flex-1 items-center px-4 py-8 gap-8">
      {/* SearchBar placeholder */}
      <Skeleton className="w-full max-w-2xl h-12 rounded-lg" />

      <div className="w-full max-w-4xl rounded-xl border border-zinc-700/50 bg-zinc-900/60 backdrop-blur-sm p-6 sm:p-8">

        {/* Skin header */}
        <div className="flex flex-col sm:flex-row items-center gap-6 mb-8">
          <Skeleton className="w-48 h-36 flex-shrink-0 rounded" />
          <div className="space-y-3 w-full">
            <Skeleton className="h-7 w-64" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-3 w-32 mt-1" />
            <Skeleton className="h-8 w-36 mt-1" />
          </div>
        </div>

        {/* Price table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-700">
                <th className="text-left py-2 px-3">
                  <Skeleton className="h-4 w-10" />
                </th>
                <th className="text-right py-2 px-3">
                  <Skeleton className="h-4 w-14 ml-auto" />
                </th>
                <th className="text-right py-2 px-3">
                  <Skeleton className="h-4 w-16 ml-auto" />
                </th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="border-b border-zinc-800">
                  <td className="py-3 px-3">
                    <Skeleton className="h-4 w-24" />
                  </td>
                  <td className="py-3 px-3">
                    <div className="flex flex-col items-end gap-1.5">
                      <Skeleton className="h-4 w-16" />
                      <Skeleton className="h-3 w-24" />
                    </div>
                  </td>
                  <td className="py-3 px-3">
                    <div className="flex flex-col items-end gap-1.5">
                      <Skeleton className="h-4 w-16" />
                      <Skeleton className="h-3 w-24" />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Collections */}
        <div className="mt-8">
          <Skeleton className="h-6 w-28 mb-3" />
          <div className="flex flex-wrap gap-3">
            <Skeleton className="h-10 w-48 rounded-lg" />
            <Skeleton className="h-10 w-40 rounded-lg" />
          </div>
        </div>

        {/* Cases */}
        <div className="mt-6">
          <Skeleton className="h-6 w-40 mb-3" />
          <div className="flex flex-wrap gap-3">
            <Skeleton className="h-10 w-44 rounded-lg" />
            <Skeleton className="h-10 w-36 rounded-lg" />
          </div>
        </div>

        {/* Tradeup section */}
        <div className="mt-8 border-t border-zinc-700 pt-8">
          <Skeleton className="h-6 w-44 mb-4" />
          <div className="flex flex-wrap gap-4 mb-4">
            <Skeleton className="h-9 w-36 rounded" />
            <Skeleton className="h-9 w-32 rounded" />
            <Skeleton className="h-9 w-28 rounded" />
          </div>
          <div className="space-y-3">
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-10 w-full rounded-lg" />
          </div>
        </div>

      </div>
    </div>
  );
}
