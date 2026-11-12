// The one place that talks HTTP to Steam: shared headers, a per-process
// request spacer, timeouts, and errors that say what actually went wrong.
//
// Callers rely on the error type to decide what to do, so nothing here ever
// turns a failure into an empty result.

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Steam rate-limits by request count per IP. Roughly one request every 3-4
// seconds has been sustainable; faster triggers HTTP 429 and, if it keeps up,
// an IP ban lasting hours.
const MIN_INTERVAL_MS = 3500;

export class SteamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

// HTTP 429: stop sending requests for now.
export class SteamRateLimitError extends SteamError {}

// Any other non-success HTTP status, or a network failure / timeout.
export class SteamHttpError extends SteamError {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

// The response arrived but is not shaped the way this code expects. Usually
// means Steam changed something and a parser needs updating.
export class SteamFormatError extends SteamError {}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Requests from this process are queued so that consecutive ones start at
// least MIN_INTERVAL_MS apart, even when callers run concurrently.
let nextSlot = 0;

async function waitForSlot(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + MIN_INTERVAL_MS + Math.random() * 1000;
  if (slot > now) await sleep(slot - now);
}

// Steam accepts a market name in a URL path only with RFC 3986 encoding;
// encodeURIComponent leaves ! ' ( ) * as they are.
export function encodeMarketName(name: string): string {
  return encodeURIComponent(name).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface SteamRequest {
  accept: 'json' | 'html';
  timeoutMs?: number;
}

export async function steamFetch(url: string, { accept, timeoutMs = 30_000 }: SteamRequest): Promise<Response> {
  await waitForSlot();

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept:
          accept === 'json'
            ? 'application/json, text/plain, */*'
            : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new SteamHttpError(`Request to Steam failed: ${error instanceof Error ? error.message : String(error)}`, null);
  }

  if (response.status === 429) throw new SteamRateLimitError('Steam returned HTTP 429 (rate limited)');
  if (!response.ok) throw new SteamHttpError(`Steam returned HTTP ${response.status}`, response.status);
  return response;
}

export async function steamText(url: string, request: SteamRequest): Promise<{ text: string; url: string }> {
  const response = await steamFetch(url, request);
  try {
    return { text: await response.text(), url: response.url };
  } catch (error) {
    // The body is streamed; a stalled download surfaces here, not in fetch().
    throw new SteamHttpError(
      `Reading Steam's response failed: ${error instanceof Error ? error.message : String(error)}`,
      null,
    );
  }
}
