// A back-off shared by every server invocation that calls Steam (the scrape
// cron and on-demand skin refreshes). After a 429, nobody on this deployment
// sends another request until the cooldown ends; hammering a rate limit only
// turns it into a ban lasting hours.
//
// Stored in `scrape_state`:
//   steam:cooldown_until  ISO time the back-off ends ('' when none)
//   steam:strikes         429s in a row without a clean slice in between

import { cooldownMs } from './scheduler';
import { getStates, setStates } from './state';

const KEY = { until: 'steam:cooldown_until', strikes: 'steam:strikes' } as const;

export const STEAM_GUARD_KEYS = KEY;

export interface SteamCooldown {
  until: Date | null;
  strikes: number;
}

export async function getSteamCooldown(): Promise<SteamCooldown> {
  const state = await getStates(Object.values(KEY));
  const until = state[KEY.until] ? new Date(state[KEY.until]) : null;
  return {
    until: until && Number.isFinite(until.getTime()) ? until : null,
    strikes: Number.parseInt(state[KEY.strikes] ?? '0', 10) || 0,
  };
}

// Whether a request may be sent now.
export async function steamCoolingDown(): Promise<Date | null> {
  const { until } = await getSteamCooldown();
  return until && until.getTime() > Date.now() ? until : null;
}

export async function noteRateLimited(): Promise<Date> {
  const { strikes } = await getSteamCooldown();
  const next = strikes + 1;
  const until = new Date(Date.now() + cooldownMs(next));
  await setStates({ [KEY.until]: until.toISOString(), [KEY.strikes]: String(next) });
  return until;
}

// A slice that reached Steam without a 429: the next one starts from the
// shortest back-off again.
export async function noteSteamOk(): Promise<void> {
  const { strikes, until } = await getSteamCooldown();
  if (strikes === 0 && !until) return;
  await setStates({ [KEY.until]: '', [KEY.strikes]: '0' });
}
