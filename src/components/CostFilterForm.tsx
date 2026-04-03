"use client";

import { useState } from "react";
import Link from "next/link";
import { Input } from "@/components/ui/input";

export default function CostFilterForm({
  defaultMinCost,
  defaultMaxCost,
}: {
  defaultMinCost?: string;
  defaultMaxCost?: string;
}) {
  const [minCost, setMinCost] = useState(defaultMinCost ?? "");
  const [maxCost, setMaxCost] = useState(defaultMaxCost ?? "");

  const minVal = minCost ? parseFloat(minCost) : undefined;
  const maxVal = maxCost ? parseFloat(maxCost) : undefined;
  const maxInvalid =
    minVal !== undefined &&
    maxVal !== undefined &&
    Number.isFinite(minVal) &&
    Number.isFinite(maxVal) &&
    maxVal < minVal;

  return (
    <form className="grid items-end gap-4 rounded-xl border border-zinc-800 bg-zinc-950/70 p-4 md:grid-cols-[1fr_1fr_auto]">
      <div className="space-y-2 text-sm">
        <label className="text-zinc-400">Minimum total contract cost</label>
        <Input
          name="minCost"
          type="number"
          min="0"
          step="0.01"
          value={minCost}
          onChange={(e) => setMinCost(e.target.value)}
          placeholder="0.00"
          className="h-9 border-zinc-700 bg-zinc-900 text-white placeholder:text-zinc-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
      </div>

      <div className="space-y-2 text-sm">
        <label className="text-zinc-400">Maximum total contract cost</label>
        <Input
          name="maxCost"
          type="number"
          min="0"
          step="0.01"
          value={maxCost}
          onChange={(e) => setMaxCost(e.target.value)}
          placeholder="Any"
          aria-invalid={maxInvalid || undefined}
          className="h-9 border-zinc-700 bg-zinc-900 text-white placeholder:text-zinc-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
      </div>

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={maxInvalid}
          className="h-9 cursor-pointer rounded-lg bg-blue-600 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Apply Filter
        </button>
        <Link
          href="/tradeups"
          className="h-9 rounded-lg border border-zinc-700 px-4 text-sm font-medium leading-[36px] text-zinc-300 transition-colors hover:border-zinc-500 hover:text-white"
        >
          Reset
        </Link>
      </div>
    </form>
  );
}
