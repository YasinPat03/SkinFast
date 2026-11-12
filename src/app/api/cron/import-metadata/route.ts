import { NextRequest, NextResponse } from 'next/server';
import { rejectUnauthorizedCron } from '@/lib/cron-auth';
import { runMetadataJob } from '@/lib/market/jobs';

// Pulls new skins, collections and cases from ByMykel's CSGO-API so new drops
// appear without a manual import, and prunes links the source no longer has.
// The four JSON files total ~45 MB, so allow the full window.
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const rejected = rejectUnauthorizedCron(request);
  if (rejected) return rejected;

  const outcome = await runMetadataJob((message) => console.log(`[import-metadata] ${message}`));
  return NextResponse.json(outcome, { status: outcome.status === 'crashed' ? 500 : 200 });
}
